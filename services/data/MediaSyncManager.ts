import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { useEventStore } from '../../stores/useEventStore';
import { MediaRepository } from './MediaRepository';
import { EventRepository } from './EventRepository';
import { dataRouter } from './DataRouter';

/**
 * C-to-C(USB) 미디어 동기화 관리자.
 *
 * 펌웨어가 USB MSC로 SD 카드를 USB 드라이브로 노출하면(usb_msc.cpp),
 * 안드로이드가 이를 외장 저장소로 마운트한다. 최초 1회 SAF(Storage Access
 * Framework)로 드라이브 루트 권한을 받아두면, 이후 연결 시 자동으로
 * evt_* 이벤트 미디어를 스캔·복사해 분석 파이프라인으로 넘긴다.
 */

// 하드웨어 파일명 규칙: <eventId>_<video|audio>_<part>.<avi|wav>
const MEDIA_FILE_PATTERN = /^(evt_\d+(?:_\d+)?)_(video|audio)_(\d+)\.(avi|wav)$/i;

// 이벤트 폴더명 규칙: evt_YYYYMMDD_HHMMSS 또는 evt_<millis>
const EVENT_DIR_PATTERN = /^evt_\d+(?:_\d+)?$/i;

// evt_YYYYMMDD_HHMMSS → Date 복원용
const EVENT_ID_TIME_PATTERN = /^evt_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;

const SAF_DIR_KEY = '@defotic_saf_directory';

export interface MediaSyncResult {
  canceled: boolean;
  importedFiles: number;      // 복사에 성공한 파일 수
  matchedEventIds: string[];  // 미디어가 매핑되어 분석이 시작된 이벤트
  unmatchedFiles: string[];   // 파일명 형식이 달라 매핑하지 못한 파일
  needsSetup?: boolean;       // SAF 폴더 권한 미부여 (silent 모드)
  deviceUnavailable?: boolean; // 기기 미연결 등으로 폴더 접근 실패
}

interface ParsedMediaFile {
  eventId: string;
  fileType: 'video' | 'audio';
  partIndex: number;
  sourceUri: string;
  name: string;
}

function emptyResult(): MediaSyncResult {
  return { canceled: false, importedFiles: 0, matchedEventIds: [], unmatchedFiles: [] };
}

/** SAF content:// URI에서 표시 파일명 추출 */
function nameFromSafUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const segments = decoded.split('/');
  return segments[segments.length - 1] || '';
}

class MediaSyncManagerService {
  private isSyncing = false;

  // ═══════════════════════════════════════════
  // 자동 동기화 (USB MSC + SAF)
  // ═══════════════════════════════════════════

  /**
   * DeFoTic USB 드라이브(SD)를 스캔해 evt_* 미디어를 자동 Import합니다.
   * @param interactive true면 폴더 권한이 없을 때 시스템 폴더 선택창을 띄웁니다.
   *                    false(화면 진입 시 silent 스캔)면 조용히 건너뜁니다.
   */
  public async autoSyncFromDevice(options: { interactive: boolean }): Promise<MediaSyncResult> {
    const result = emptyResult();
    if (this.isSyncing || Platform.OS !== 'android') return result;
    this.isSyncing = true;

    try {
      const { StorageAccessFramework } = require('expo-file-system/legacy');

      // ── 1. SAF 디렉토리 권한 확보 ──
      let dirUri = await AsyncStorage.getItem(SAF_DIR_KEY);

      if (!dirUri) {
        if (!options.interactive) {
          result.needsSetup = true;
          return result;
        }
        const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!perm.granted) {
          result.canceled = true;
          return result;
        }
        dirUri = perm.directoryUri;
        await AsyncStorage.setItem(SAF_DIR_KEY, dirUri!);
      }

      // ── 2. 루트 + evt_* 폴더 스캔 ──
      let rootEntries: string[];
      try {
        rootEntries = await StorageAccessFramework.readDirectoryAsync(dirUri);
      } catch (e) {
        // 기기 미연결/드라이브 언마운트 → 접근 불가
        console.log('[MediaSync] SAF directory unavailable (device not connected?)');
        result.deviceUnavailable = true;
        return result;
      }

      const mediaFiles: ParsedMediaFile[] = [];

      const collectFrom = (uris: string[]) => {
        for (const uri of uris) {
          const parsed = this.parseFileName(nameFromSafUri(uri), uri);
          if (parsed) mediaFiles.push(parsed);
        }
      };

      // 선택된 폴더 안의 evt_* 폴더들을 스캔
      const scanEventDirs = async (entries: string[]) => {
        collectFrom(entries);
        for (const entry of entries) {
          const name = nameFromSafUri(entry);
          if (EVENT_DIR_PATTERN.test(name)) {
            try {
              const children = await StorageAccessFramework.readDirectoryAsync(entry);
              collectFrom(children);
            } catch {
              // 개별 폴더 접근 실패는 건너뛴다
            }
          }
        }
      };

      await scanEventDirs(rootEntries);

      // 사용자가 DEFOTIC 폴더가 아닌 드라이브 루트를 선택한 경우:
      // 하위의 DEFOTIC 폴더로 한 단계 내려가 동일하게 스캔한다.
      for (const entry of rootEntries) {
        if (nameFromSafUri(entry).toUpperCase() === 'DEFOTIC') {
          try {
            const children = await StorageAccessFramework.readDirectoryAsync(entry);
            await scanEventDirs(children);
          } catch {
            // 접근 실패 시 무시
          }
        }
      }

      if (mediaFiles.length === 0) {
        console.log('[MediaSync] No evt_* media found on device');
        return result;
      }

      // ── 3. 공용 Import 파이프라인 ──
      await this.importParsedFiles(mediaFiles, result);
      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  /** 동기화 폴더가 이미 지정되어 있는지 확인합니다 */
  public async hasSyncDirectory(): Promise<boolean> {
    return (await AsyncStorage.getItem(SAF_DIR_KEY)) !== null;
  }

  /** 저장된 SAF 폴더 권한을 초기화합니다 (다른 기기/폴더 재지정용) */
  public async resetSyncDirectory() {
    await AsyncStorage.removeItem(SAF_DIR_KEY);
  }

  // ═══════════════════════════════════════════
  // 수동 파일 선택 (fallback)
  // ═══════════════════════════════════════════

  public async pickAndImportMedia(): Promise<MediaSyncResult> {
    const result = emptyResult();
    if (this.isSyncing) return result;
    this.isSyncing = true;

    try {
      // 네이티브 모듈이 없는 (구버전 dev client) 환경에서 앱 전체가
      // 죽지 않도록 module-scope import 대신 lazy require 사용
      let DocumentPicker: typeof import('expo-document-picker');
      try {
        DocumentPicker = require('expo-document-picker');
      } catch (e) {
        throw new Error(
          '파일 선택 모듈이 설치되지 않았습니다. 앱을 다시 빌드해주세요. (npm run android)',
        );
      }

      const picked = await DocumentPicker.getDocumentAsync({
        type: ['video/*', 'audio/*', 'application/octet-stream', '*/*'],
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (picked.canceled) {
        result.canceled = true;
        return result;
      }

      const mediaFiles: ParsedMediaFile[] = [];
      for (const asset of picked.assets) {
        const parsed = this.parseFileName(asset.name, asset.uri);
        if (parsed) mediaFiles.push(parsed);
        else result.unmatchedFiles.push(asset.name);
      }

      await this.importParsedFiles(mediaFiles, result);
      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  // ═══════════════════════════════════════════
  // 공용 Import 파이프라인
  // ═══════════════════════════════════════════

  private async importParsedFiles(files: ParsedMediaFile[], result: MediaSyncResult) {
    // 이벤트별 그룹핑
    const grouped = new Map<string, ParsedMediaFile[]>();
    for (const file of files) {
      const list = grouped.get(file.eventId) || [];
      list.push(file);
      grouped.set(file.eventId, list);
    }

    for (const [eventId, group] of grouped) {
      const existing = useEventStore.getState().events.find(e => e.id === eventId);

      // 이미 동기화 완료된 이벤트는 중복 Import 방지
      if (existing && existing.transferStatus === 'synced') continue;

      // BLE 메타데이터를 놓친 이벤트는 파일명 타임스탬프로 레코드 복원
      if (!existing) {
        const restoredTime = this.timestampFromEventId(eventId);
        console.log(`[MediaSync] No BLE record for ${eventId} — restoring from filename`);
        await EventRepository.createFromImport(eventId, restoredTime);
      }

      const media: { videoPath?: string; audioPath?: string } = {};

      // 마지막 파트(틱 발생 시점이 담긴 최신 세그먼트)를 대표 경로로 사용
      const latestPartOf = (type: 'video' | 'audio') =>
        group
          .filter(f => f.fileType === type)
          .sort((a, b) => b.partIndex - a.partIndex)[0];

      for (const file of group) {
        try {
          const localPath = await MediaRepository.importMediaFile(
            eventId,
            file.fileType,
            file.partIndex,
            file.sourceUri,
          );
          result.importedFiles++;

          const latest = latestPartOf(file.fileType);
          if (latest && latest.partIndex === file.partIndex) {
            if (file.fileType === 'video') media.videoPath = localPath;
            else media.audioPath = localPath;
          }
        } catch (e) {
          console.error(`[MediaSync] Failed to import ${file.name}:`, e);
          result.unmatchedFiles.push(file.name);
        }
      }

      if (media.videoPath || media.audioPath) {
        await EventRepository.attachMedia(eventId, media);
        result.matchedEventIds.push(eventId);

        // AI 분석 파이프라인 자동 트리거
        dataRouter.triggerAnalysis(eventId);
      }
    }

    console.log(
      `[MediaSync] Imported ${result.importedFiles} files, ` +
      `matched ${result.matchedEventIds.length} events, ` +
      `unmatched ${result.unmatchedFiles.length} files`,
    );
  }

  private parseFileName(name: string, uri: string): ParsedMediaFile | null {
    const match = name.match(MEDIA_FILE_PATTERN);
    if (!match) return null;

    return {
      eventId: match[1],
      fileType: match[2].toLowerCase() as 'video' | 'audio',
      partIndex: parseInt(match[3], 10),
      sourceUri: uri,
      name,
    };
  }

  /** evt_YYYYMMDD_HHMMSS → epoch(ms). 복원 불가 시 현재 시각 사용 */
  private timestampFromEventId(eventId: string): number {
    const m = eventId.match(EVENT_ID_TIME_PATTERN);
    if (!m) return Date.now();

    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(s),
    );
    return isNaN(date.getTime()) ? Date.now() : date.getTime();
  }
}

export const mediaSyncManager = new MediaSyncManagerService();
