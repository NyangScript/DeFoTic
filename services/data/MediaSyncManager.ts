import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { useEventStore } from '../../stores/useEventStore';
import { useDeviceStore } from '../../stores/useDeviceStore';
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

// 틱 직전 실사 스냅샷: <eventId>_thumb.jpg (펌웨어 task.cpp가 이벤트 확정
// 시 /buffer/live.jpg를 rename). 카드/상세 뷰어의 즉시 확인용으로 Import한다.
const THUMB_FILE_PATTERN = /^(evt_\d+(?:_\d+)?)_thumb\.jpg$/i;

// 이벤트 폴더명 규칙: evt_YYYYMMDD_HHMMSS 또는 evt_<millis>
const EVENT_DIR_PATTERN = /^evt_\d+(?:_\d+)?$/i;

// evt_YYYYMMDD_HHMMSS → Date 복원용
const EVENT_ID_TIME_PATTERN = /^evt_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/;

const SAF_DIR_KEY = '@defotic_saf_directory';

// 기기 SD의 FAT 볼륨 시리얼("XXXX-XXXX") 캐시 — BLE 텔레메트리로 수신.
// Android SAF는 외장 볼륨을 이 시리얼로 식별하므로, 폴더 선택창을
// DeFoTic 드라이브의 DEFOTIC 폴더에서 바로 열게 하는 힌트로 쓴다.
const SD_UUID_KEY = '@defotic_sd_uuid';

// 기기에 썸네일 파일이 존재하지 않는 것으로 확인된 이벤트 id 목록 —
// 그 폴더의 반복 열람을 생략하기 위한 메모 (복사 실패와는 구분된다).
const THUMB_ABSENT_KEY = '@defotic_thumb_absent';

// Android 기본 문서 프로바이더(외장 저장소) authority
const EXTERNAL_STORAGE_AUTHORITY = 'com.android.externalstorage.documents';

export interface MediaSyncResult {
  canceled: boolean;
  importedFiles: number;      // 복사에 성공한 파일 수
  matchedEventIds: string[];  // 미디어가 매핑되어 분석이 시작된 이벤트
  // 스냅샷(thumb)만 들어온 이벤트 — 본 미디어(영상/음성)는 기기에 없음.
  // 별도 계상하지 않으면 "가져올 미디어 없음"으로 오표시되므로 안내 분기에 쓴다.
  thumbOnlyEventIds: string[];
  unmatchedFiles: string[];   // 파일명 형식이 달라 매핑하지 못한 파일
  // 파일명은 유효했으나 복사(I/O)에 실패한 파일 — 케이블 분리/MSC 스톨 등.
  // unmatchedFiles와 분리 계상해야 "기기 파일이 아닙니다" 오도 안내 대신
  // "연결을 확인하고 다시 시도" 안내를 띄울 수 있다.
  copyFailedFiles: string[];
  skippedSynced: number;      // 이미 동기화 완료라 건너뛴 이벤트 수
  // 회당 임포트 상한(MAX_EVENTS_PER_SYNC) 초과로 다음 동기화로 이월된
  // 이벤트 수 — 오탐 폭주기(10초당 1폴더)에 수백 폴더가 쌓였을 때 최초
  // 동기화가 수 시간 + Gemini 쿼터 소진으로 이어지는 것을 막는다.
  deferredEvents: number;
  needsSetup?: boolean;       // SAF 폴더 권한 미부여 (silent 모드)
  deviceUnavailable?: boolean; // 기기 미연결 등으로 폴더 접근 실패
  // 동기화가 아예 실행되지 않고 반환됨 (이미 동기화 진행 중 / 미지원 OS).
  // 호출자는 이 결과로 드라이브 도달성(driveLinked)을 판정해서는 안 된다.
  skipped?: boolean;
}

interface ParsedMediaFile {
  eventId: string;
  fileType: 'video' | 'audio' | 'thumb';
  partIndex: number;   // thumb는 항상 0
  sourceUri: string;
  name: string;
}

function emptyResult(): MediaSyncResult {
  return {
    canceled: false,
    importedFiles: 0,
    matchedEventIds: [],
    thumbOnlyEventIds: [],
    unmatchedFiles: [],
    copyFailedFiles: [],
    skippedSynced: 0,
    deferredEvents: 0,
  };
}

// 1회 동기화에서 실제 임포트(신규/보완)를 수행할 최대 이벤트 수.
// 초과분은 이월(deferredEvents)되어 다음 스캔에서 이어서 가져온다 —
// 최신 이벤트부터 처리하므로 사용자가 기다리는 것은 항상 최근 기록이다.
const MAX_EVENTS_PER_SYNC = 25;

/**
 * SAF content:// URI에서 표시 파일명 추출.
 *
 * docId 구조가 깊이에 따라 다르다는 점이 함정이다:
 *   하위 항목: "볼륨ID:DEFOTIC/evt_x/evt_x_video_0.avi" → '/' 분할 마지막 ✓
 *   최상위 항목: "볼륨ID:DeFoTic_Data" ('/' 없음!) → '/' 분할만 하면
 *   "DDA4-17F6:DeFoTic_Data"가 나와 모든 이름 매칭이 깨진다
 *   (드라이브 루트를 동기화 폴더로 지정하면 evt_*를 하나도 찾지 못하게 된다).
 * FAT 파일명에 ':'는 올 수 없으므로 ':' 분할 마지막을 취하면 안전하다.
 * 손상된 %인코딩(decodeURIComponent throw)은 빈 문자열로 방어한다.
 */
function nameFromSafUri(uri: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return '';
  }
  const lastSlash = decoded.split('/').pop() || '';
  return lastSlash.split(':').pop() || '';
}

class MediaSyncManagerService {
  private isSyncing = false;
  // isSyncing 워치독: SAF/copy 호출에는 타임아웃이 없어 MSC 스톨 시
  // promise가 영구 pending으로 남을 수 있다 — 그 경우 래치가 앱 재시작
  // 전까지 모든 동기화를 skipped로 무력화한다. 시작 시각을 기록해 상한
  // 초과 시 래치를 강제 해제한다.
  // 세대 토큰: 강제 해제 후 고아 비행의 finally가 무조건 isSyncing=false를
  // 실행하면 '그 사이 시작된 새 비행'의 래치를 풀어버린다 — 각 비행은
  // 자기 세대일 때만 래치를 해제한다.
  private syncStartedAt = 0;
  private syncGeneration = 0;
  // 사용자 다이얼로그(폴더 선택창 등) 대기 중에는 워치독을 멈춘다 —
  // 사용자가 창을 오래 열어두는 것은 스톨이 아니다.
  private dialogOpen = false;
  private static readonly SYNC_STUCK_MS = 5 * 60 * 1000;

  /**
   * 진행 중 래치 획득 — 성공 시 세대 토큰 반환, 실패 시 null.
   * 워치독은 '진전이 없는 시간'을 본다(touchSync가 갱신): 대용량 백로그
   * 배치는 수 분이 정상이므로 시작 시각 기준으로 판정하면 정상 배치를
   * 스톨로 오판해 같은 이벤트를 두 비행이 동시에 임포트하게 된다.
   */
  private acquireSyncLatch(): number | null {
    if (this.isSyncing) {
      const stalled = Date.now() - this.syncStartedAt;
      if (this.dialogOpen || stalled < MediaSyncManagerService.SYNC_STUCK_MS) {
        return null;
      }
      console.warn('[MediaSync] Stuck sync latch force-released (watchdog)');
    }
    this.isSyncing = true;
    this.syncStartedAt = Date.now();
    return ++this.syncGeneration;
  }

  /** 워치독 하트비트 — 실제 진전(디렉토리 열람/파일 복사)마다 호출한다 */
  private touchSync() {
    this.syncStartedAt = Date.now();
  }

  // ── 썸네일 부재 메모 ──
  // "기기에 썸네일이 아예 없는 이벤트"를 기억해 그 폴더의 재열람을 없앤다.
  // 복사 실패와 구분되므로, 실패한 썸네일은 기억되지 않고 계속 재시도된다.
  private thumbAbsent = new Set<string>();
  private thumbAbsentLoaded = false;
  private thumbAbsentDirty = false;

  private async loadThumbAbsent() {
    if (this.thumbAbsentLoaded) return;
    this.thumbAbsentLoaded = true;
    try {
      const raw = await AsyncStorage.getItem(THUMB_ABSENT_KEY);
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) this.thumbAbsent = new Set(ids.filter(i => typeof i === 'string'));
      }
    } catch {
      // 메모를 못 읽으면 최적화만 포기한다 (동작에는 영향 없음)
    }
  }

  private markThumbAbsent(eventId: string) {
    if (this.thumbAbsent.has(eventId)) return;
    this.thumbAbsent.add(eventId);
    this.thumbAbsentDirty = true;
  }

  private async flushThumbAbsent() {
    if (!this.thumbAbsentDirty) return;
    this.thumbAbsentDirty = false;
    try {
      // 이벤트 보존 상한과 같은 규모로 잘라 무한 증식을 막는다
      const ids = Array.from(this.thumbAbsent).slice(-4000);
      this.thumbAbsent = new Set(ids);
      await AsyncStorage.setItem(THUMB_ABSENT_KEY, JSON.stringify(ids));
    } catch {
      // 저장 실패는 다음 스캔에서 다시 기록된다
    }
  }

  /** 자기 세대일 때만 래치 해제 — 고아 비행이 새 비행을 방해하지 않게 */
  private releaseSyncLatch(token: number) {
    if (token === this.syncGeneration) {
      this.isSyncing = false;
    }
  }

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
    const latch = Platform.OS === 'android' ? this.acquireSyncLatch() : null;
    if (latch === null) {
      result.skipped = true;
      return result;
    }

    try {
      const { StorageAccessFramework } = require('expo-file-system/legacy');

      // ── 1. SAF 디렉토리 권한 확보 ──
      let dirUri = await AsyncStorage.getItem(SAF_DIR_KEY);

      if (!dirUri) {
        if (!options.interactive) {
          result.needsSetup = true;
          return result;
        }
        // EXTRA_INITIAL_URI 힌트: 볼륨 UUID를 알면 선택창이 DeFoTic
        // 드라이브의 DEFOTIC 폴더에서 바로 열린다. 잘못된 URI(기기 미연결
        // 등)는 Android가 무시하고 기본 위치로 폴백한다 (Expo v54 문서 명시).
        const initialUri = await this.resolveInitialUri();
        this.dialogOpen = true;
        let perm;
        try {
          perm = await StorageAccessFramework.requestDirectoryPermissionsAsync(initialUri ?? undefined);
        } finally {
          this.dialogOpen = false;
          this.touchSync();
        }
        if (!perm.granted) {
          result.canceled = true;
          return result;
        }
        dirUri = perm.directoryUri;
        await AsyncStorage.setItem(SAF_DIR_KEY, dirUri!);
      }

      // ── 2. 루트 + evt_* 폴더 재귀 스캔 (공용) ──
      let scan;
      try {
        // dirUri는 이 시점에 항상 존재 (저장값이거나 방금 권한 획득)
        scan = await this.collectMediaFromTree(StorageAccessFramework, dirUri!);
      } catch (e) {
        // 기기 미연결/드라이브 언마운트 → 접근 불가
        console.log('[MediaSync] SAF directory unavailable (device not connected?)');
        result.deviceUnavailable = true;
        return result;
      }

      // 이미 완전 동기화되어 열람 자체를 생략한 폴더도 '건너뜀'으로 계상한다 —
      // 계상하지 않으면 정상 상태(모두 동기화 완료)에서 "가져올 미디어 없음"이
      // 표시되어 사용자가 실패로 오해한다.
      result.skippedSynced += scan.skippedFullySynced;

      const mediaFiles = scan.files;
      if (mediaFiles.length === 0) {
        console.log('[MediaSync] No new evt_* media found on device');
        return result;
      }

      // ── 3. 공용 Import 파이프라인 ──
      await this.importParsedFiles(mediaFiles, result);
      return result;
    } finally {
      this.releaseSyncLatch(latch);
    }
  }

  /**
   * SAF 트리(dirUri)에서 evt_* 미디어 파일을 재귀 수집합니다.
   * 선택 폴더가 무엇이든 동일하게 동작합니다:
   *   드라이브 루트 → DEFOTIC으로 내려가 evt_* 폴더들 스캔
   *   DEFOTIC 폴더 → evt_* 폴더들 스캔
   *   개별 evt_* 폴더 → 그 안의 파일들 직접 수집
   * 접근 실패(기기 미연결 등) 시 throw — 호출자가 deviceUnavailable 처리.
   */
  private async collectMediaFromTree(
    StorageAccessFramework: any,
    dirUri: string,
  ): Promise<{ files: ParsedMediaFile[]; skippedFullySynced: number }> {
    const rootEntries: string[] = await StorageAccessFramework.readDirectoryAsync(dirUri);
    const mediaFiles: ParsedMediaFile[] = [];
    let skippedFullySynced = 0;

    const collectFrom = (uris: string[]) => {
      for (const uri of uris) {
        const parsed = this.parseFileName(nameFromSafUri(uri), uri);
        if (parsed) mediaFiles.push(parsed);
      }
    };

    // listing 생략 최적화: 폴더명이 곧 eventId이므로, 스토어에 이미 완전
    // 동기화된 이벤트의 폴더는 readDirectoryAsync 자체를 생략한다. SAF IPC는
    // MSC(USB FS) 경유라 회당 수십~수백 ms — 폴더 수백 개 누적 시 listing
    // 만으로 수 분이 걸리는 병목을 막는다.
    // (부분 동기화 이벤트는 여전히 열어 보완 임포트한다)
    await useEventStore.getState().loadEvents();
    await this.loadThumbAbsent();
    const eventsById = new Map(
      useEventStore.getState().events.map(e => [e.id, e] as const),
    );
    // 썸네일은 '기기에 아예 없는 경우'(구세대 펌웨어·rename 실패)와 '복사가
    // 실패한 경우'를 구분해야 한다. 전자를 thumbAbsent로 기억해 두면 그
    // 폴더는 이후 영구히 생략할 수 있고(비용 1회), 후자는 기억되지 않으므로
    // 썸네일이 들어올 때까지 계속 재시도된다 — 자동 동기화만 쓰는 사용자도
    // 일시적 복사 실패로 썸네일을 영구히 잃지 않는다.
    const fullySynced = (id: string) => {
      const e = eventsById.get(id);
      if (!e || e.transferStatus !== 'synced' || !e.videoPath || !e.audioPath) return false;
      return !!e.thumbPath || this.thumbAbsent.has(id);
    };

    // 전달된 엔트리들 자체 + evt_* 하위 폴더 내부를 스캔
    const scanEventDirs = async (entries: string[]) => {
      collectFrom(entries);
      for (const entry of entries) {
        const name = nameFromSafUri(entry);
        if (EVENT_DIR_PATTERN.test(name)) {
          if (fullySynced(name)) {
            skippedFullySynced++;
            continue;
          }
          try {
            const children = await StorageAccessFramework.readDirectoryAsync(entry);
            this.touchSync();
            collectFrom(children);
            // 이 폴더에 썸네일이 실재하지 않음을 기억한다 (재열람 비용 제거)
            const hasThumb = (children as string[]).some(c =>
              THUMB_FILE_PATTERN.test(nameFromSafUri(c)),
            );
            if (!hasThumb) this.markThumbAbsent(name);
          } catch {
            // 개별 폴더 접근 실패는 건너뛴다
          }
        }
      }
    };

    await scanEventDirs(rootEntries);

    // 드라이브 루트를 선택한 경우: 이벤트 컨테이너 폴더들로 한 단계
    // 내려가 재스캔한다. SD에는 펌웨어 세대별 저장 위치가 공존한다:
    //   /DEFOTIC       — 현행 저장 위치
    //   /DeFoTic_Data  — 구세대 펌웨어 저장 위치 (기존 미디어가 남아 있음)
    //   루트 직속 evt_* — 더 오래된 세대 (위 scanEventDirs가 이미 커버)
    const CONTAINER_DIRS = new Set(['DEFOTIC', 'DEFOTIC_DATA']);
    for (const entry of rootEntries) {
      if (CONTAINER_DIRS.has(nameFromSafUri(entry).toUpperCase())) {
        try {
          const children = await StorageAccessFramework.readDirectoryAsync(entry);
          await scanEventDirs(children);
        } catch {
          // 접근 실패 시 무시
        }
      }
    }

    await this.flushThumbAbsent();
    return { files: mediaFiles, skippedFullySynced };
  }

  /**
   * 폴더 단위 수동 가져오기 (일회성).
   * 이벤트가 evt_* '폴더'(영상 파트 + 음성 파트 세트)로 저장되므로,
   * 파일 단위 선택으로는 세트를 온전히 복원하기 어렵다 — 폴더를 통째로
   * 선택하면 내부를 재귀 스캔해 video/audio 쌍이 유실 없이 묶인다.
   * 자동 동기화 폴더(SAF_DIR_KEY)로는 저장하지 않는다.
   */
  public async pickFolderAndImport(): Promise<MediaSyncResult> {
    const result = emptyResult();
    const latch = Platform.OS === 'android' ? this.acquireSyncLatch() : null;
    if (latch === null) {
      result.skipped = true;
      return result;
    }

    try {
      const { StorageAccessFramework } = require('expo-file-system/legacy');

      const initialUri = await this.resolveInitialUri();
      this.dialogOpen = true;
      let perm;
      try {
        perm = await StorageAccessFramework.requestDirectoryPermissionsAsync(initialUri ?? undefined);
      } finally {
        this.dialogOpen = false;
        this.touchSync();
      }
      if (!perm.granted) {
        result.canceled = true;
        return result;
      }

      let scan;
      try {
        scan = await this.collectMediaFromTree(StorageAccessFramework, perm.directoryUri);
      } catch {
        result.deviceUnavailable = true;
        return result;
      }
      result.skippedSynced += scan.skippedFullySynced;

      await this.importParsedFiles(scan.files, result);
      return result;
    } finally {
      this.releaseSyncLatch(latch);
    }
  }

  /**
   * SAF 폴더 선택창의 초기 위치 힌트(EXTRA_INITIAL_URI)를 만듭니다.
   * BLE 텔레메트리의 볼륨 UUID를 우선 사용하고, 없으면(앱 재시작 등)
   * 마지막으로 수신했던 캐시값을 사용합니다. 둘 다 없으면 null —
   * 선택창은 기본 위치에서 열리고 사용자가 수동으로 이동해야 합니다.
   */
  private async resolveInitialUri(): Promise<string | null> {
    let uuid = useDeviceStore.getState().sdVolumeUuid;
    if (uuid) {
      await AsyncStorage.setItem(SD_UUID_KEY, uuid);
    } else {
      uuid = await AsyncStorage.getItem(SD_UUID_KEY);
    }
    if (!uuid) return null;

    // 문서 ID "<volumeUuid>:" = DeFoTic 드라이브의 루트.
    // 루트를 선택하면 스캔이 루트 직속 evt_*(구버전 펌웨어 잔재 포함)와
    // /DEFOTIC 하위까지 전부 커버하므로 가장 누락이 없다.
    // (외장 드라이브 루트는 내장 저장소와 달리 Android가 선택을 허용함)
    const docId = encodeURIComponent(`${uuid}:`);
    return `content://${EXTERNAL_STORAGE_AUTHORITY}/document/${docId}`;
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
    const latch = this.acquireSyncLatch();
    if (latch === null) {
      result.skipped = true;
      return result;
    }

    try {
      // 네이티브 모듈이 없는 (구버전 dev client) 환경에서 앱 전체가
      // 죽지 않도록 module-scope import 대신 lazy require 사용
      let DocumentPicker: typeof import('expo-document-picker');
      try {
        DocumentPicker = require('expo-document-picker');
      } catch (e) {
        // 개발자용 안내(리빌드 필요)는 콘솔로만 — 사용자 문구에는 넣지 않는다
        console.warn('[MediaSync] expo-document-picker native module missing — rebuild required');
        throw new Error(
          '이 버전에서는 파일 선택을 사용할 수 없습니다. 앱 업데이트 후 다시 시도해주세요.',
        );
      }

      this.dialogOpen = true;
      let picked;
      try {
        picked = await DocumentPicker.getDocumentAsync({
          type: ['video/*', 'audio/*', 'application/octet-stream', '*/*'],
          multiple: true,
          copyToCacheDirectory: true,
        });
      } finally {
        this.dialogOpen = false;
        this.touchSync();
      }

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
      this.releaseSyncLatch(latch);
    }
  }

  // ═══════════════════════════════════════════
  // 공용 Import 파이프라인
  // ═══════════════════════════════════════════

  private async importParsedFiles(files: ParsedMediaFile[], result: MediaSyncResult) {
    // 스토어 하이드레이션 보장: 로드 전에 events를 조회하면 synced
    // 이벤트를 미기록으로 오인해 전체 재복사 + Gemini 재분석을 유발한다.
    // loadEvents는 hasLoaded면 즉시 반환이라 비용이 없다.
    await useEventStore.getState().loadEvents();

    // 이벤트별 그룹핑
    const grouped = new Map<string, ParsedMediaFile[]>();
    for (const file of files) {
      const list = grouped.get(file.eventId) || [];
      list.push(file);
      grouped.set(file.eventId, list);
    }

    // 최신 이벤트 우선 (evt_YYYYMMDD_HHMMSS는 사전순=시간순) — 임포트
    // 상한에 걸려 이월되는 것은 항상 가장 오래된 백로그가 되게 한다.
    const orderedIds = Array.from(grouped.keys()).sort().reverse();

    let importedEventCount = 0;
    for (const eventId of orderedIds) {
      const group = grouped.get(eventId)!;
      const existing = useEventStore.getState().events.find(e => e.id === eventId);

      // ── 파트 단위 잔여 작업 산출 ──
      // 타입('video'/'audio') 단위로 판단하면 두 가지가 깨진다:
      //  · 기기가 파트를 쓰는 도중 스캔이 돌면 video_0만 임포트한 채 완료로
      //    간주되어 뒤늦게 완성된 video_1·video_2(틱 순간이 담긴 최신
      //    세그먼트)가 영영 들어오지 않는다.
      //  · 한 파트가 영구 실패하면 이미 성공한 형제 파트까지 매 스캔
      //    delete+recopy되어 유휴 재스캔마다 같은 용량을 다시 복사한다.
      // 로컬에 온전한 파일이 있는 파트는 건너뛰고, 없는 것만 가져온다.
      const effectiveGroup: ParsedMediaFile[] = [];
      for (const f of group) {
        const localPath =
          f.fileType === 'thumb'
            ? MediaRepository.localThumbPath(eventId)
            : MediaRepository.localPartPath(eventId, f.fileType, f.partIndex);
        if (f.fileType === 'thumb' && existing?.thumbPath) continue;
        if (await MediaRepository.hasLocalFile(localPath)) continue;
        effectiveGroup.push(f);
      }

      // 가져올 것이 없으면 상한 슬롯을 소비하지 않는다 — 소비하면
      // 이월(deferredEvents)이 '실제 남은 작업'과 어긋나 드레인 루프가
      // 아무 진전 없이 계속 이월만 보고하는 기아 상태가 된다.
      if (effectiveGroup.length === 0) {
        result.skippedSynced++;
        continue;
      }
      if (effectiveGroup.length < group.length) {
        console.log(
          `[MediaSync] Completing partial import for ${eventId}: ${effectiveGroup.map(f => f.name).join(', ')}`,
        );
      }

      // 회당 임포트 상한 — 실제 복사 작업이 필요한 이벤트에만 적용
      if (importedEventCount >= MAX_EVENTS_PER_SYNC) {
        result.deferredEvents++;
        continue;
      }
      importedEventCount++;

      // BLE 메타데이터를 놓친 이벤트는 파일명 타임스탬프로 레코드 복원
      if (!existing) {
        const restoredTime = this.timestampFromEventId(eventId);
        console.log(`[MediaSync] No BLE record for ${eventId} — restoring from filename`);
        await EventRepository.createFromImport(eventId, restoredTime);
        // 생존 확인: 스토어가 보존 상한(MAX_EVENTS) 만석이면 addEvent가
        // 최고령인 이 복원 레코드를 즉시 퇴출한다 — 그대로 진행하면
        // 미디어를 복사해도 attachMedia가 no-op이 되고, 다음 스캔마다
        // 같은 폴더를 영구 재복사하는 루프가 된다. 레코드가 남지 못했으면
        // 이 이벤트는 건너뛴다(상한 정책상 이미 보존 대상이 아닌 오래된
        // 이벤트다).
        const survived = useEventStore.getState().events.some(e => e.id === eventId);
        if (!survived) {
          console.log(`[MediaSync] ${eventId} evicted by retention cap — skipping import`);
          importedEventCount--;
          result.skippedSynced++;
          continue;
        }
      }

      const media: { videoPath?: string; audioPath?: string } = {};
      let thumbPath: string | undefined;
      // 복사에 실패한 파트 — 대표 경로 승격 판정에 쓴다. 대표(최신) 파트가
      // 실패했는데 승격하면 그 이벤트가 완비된 것으로 간주되어(listing 생략
      // 포함) 틱 순간이 담긴 세그먼트를 영구히 잃는다.
      const failedParts = new Set<string>();

      for (const file of effectiveGroup) {
        try {
          if (file.fileType === 'thumb') {
            thumbPath = await MediaRepository.importThumbFile(eventId, file.sourceUri);
            result.importedFiles++;
            this.touchSync();
            continue;
          }

          await MediaRepository.importMediaFile(
            eventId,
            file.fileType,
            file.partIndex,
            file.sourceUri,
          );
          result.importedFiles++;
          this.touchSync();
        } catch (e) {
          console.error(`[MediaSync] Failed to import ${file.name}:`, e);
          result.copyFailedFiles.push(file.name);
          failedParts.add(`${file.fileType}_${file.partIndex}`);
        }
      }

      // ── 대표 경로 승격 ──
      // 기기에 존재하는 파트 전체(group) 중 마지막 파트를 대표로 삼는다 —
      // 틱 발생 시점이 담긴 최신 세그먼트다. 이번 라운드에 복사하지 않은
      // 파트도 이미 로컬에 있으면 유효한 대표가 되므로, 이전 라운드에
      // 부분 임포트된 이벤트가 다음 라운드에 자연히 완성된다.
      for (const type of ['video', 'audio'] as const) {
        const parts = group
          .filter(f => f.fileType === type)
          .sort((a, b) => b.partIndex - a.partIndex);
        const latest = parts[0];
        if (!latest) continue;
        if (failedParts.has(`${type}_${latest.partIndex}`)) continue;
        const path = MediaRepository.localPartPath(eventId, type, latest.partIndex);
        if (!(await MediaRepository.hasLocalFile(path))) continue;
        if (type === 'video') media.videoPath = path;
        else media.audioPath = path;
      }

      if (media.videoPath || media.audioPath) {
        // thumbPath가 undefined면 키 자체를 빼야 한다 — updateEvent의
        // {...e, ...updates} 병합에서 명시적 undefined는 기존 썸네일을
        // 지워버린다 (부분 보완 임포트 시 소실 경로).
        await EventRepository.attachMedia(
          eventId,
          thumbPath ? { ...media, thumbPath } : media,
        );
        result.matchedEventIds.push(eventId);

        // AI 분석 파이프라인 자동 트리거
        dataRouter.triggerAnalysis(eventId);
      } else if (thumbPath) {
        // 썸네일만 들어온 경우 — 분석 가능한 미디어가 아니므로 synced로
        // 승격하지 않고 경로만 기록한다 (분석 트리거도 없음).
        await useEventStore.getState().updateEvent(eventId, { thumbPath });
        if (existing && existing.transferStatus === 'synced') {
          // 이미 완전 동기화된 이벤트의 thumb '소급 보완'은 thumbOnly가
          // 아니다: 여기에 계상하면 "영상/음성 파일은 기기에 없거나
          // 저장이 중단된 이벤트"라는 오도성 알림이 뜬다 — 실제로는 정상
          // 이벤트. 조용한 보완으로만 처리한다.
          result.skippedSynced++;
        } else {
          // 결과 통계에 계상해 "가져올 미디어 없음" 오표시를 막는다.
          result.thumbOnlyEventIds.push(eventId);
        }
      }
    }

    console.log(
      `[MediaSync] Imported ${result.importedFiles} files, ` +
      `matched ${result.matchedEventIds.length} events, ` +
      `unmatched ${result.unmatchedFiles.length} files` +
      (result.copyFailedFiles.length > 0 ? `, copy-failed ${result.copyFailedFiles.length}` : '') +
      (result.deferredEvents > 0 ? `, deferred ${result.deferredEvents} events` : ''),
    );
  }

  private parseFileName(name: string, uri: string): ParsedMediaFile | null {
    const match = name.match(MEDIA_FILE_PATTERN);
    if (match) {
      return {
        eventId: match[1],
        fileType: match[2].toLowerCase() as 'video' | 'audio',
        partIndex: parseInt(match[3], 10),
        sourceUri: uri,
        name,
      };
    }

    const thumbMatch = name.match(THUMB_FILE_PATTERN);
    if (thumbMatch) {
      return {
        eventId: thumbMatch[1],
        fileType: 'thumb',
        partIndex: 0,
        sourceUri: uri,
        name,
      };
    }

    return null;
  }

  /**
   * evt_YYYYMMDD_HHMMSS → epoch(ms). 복원 불가 시 현재 시각 사용.
   * 펌웨어는 폴더명을 KST(TZ=KST-9) 고정으로 기록하므로 폰의 로컬
   * 타임존이 아니라 +09:00 고정 오프셋으로 해석한다 — 해외 체류 등
   * 타임존이 다른 환경에서 복원 시각이 시차만큼 어긋나는 것을 방지.
   */
  private timestampFromEventId(eventId: string): number {
    const m = eventId.match(EVENT_ID_TIME_PATTERN);
    if (!m) return Date.now();

    const [, y, mo, d, h, mi, s] = m;
    const utcMs = Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(s),
    );
    if (!Number.isFinite(utcMs)) return Date.now();
    return utcMs - 9 * 60 * 60 * 1000; // KST(+09:00) → UTC epoch
  }
}

export const mediaSyncManager = new MediaSyncManagerService();
