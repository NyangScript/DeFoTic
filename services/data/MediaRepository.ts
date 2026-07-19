import { documentDirectory, getInfoAsync, makeDirectoryAsync, copyAsync, deleteAsync } from 'expo-file-system/legacy';

const STORAGE_ROOT = `${documentDirectory}events/`;

export class MediaRepository {
  /**
   * Ensure the root storage directory exists
   */
  static async init() {
    const dirInfo = await getInfoAsync(STORAGE_ROOT);
    if (!dirInfo.exists) {
      await makeDirectoryAsync(STORAGE_ROOT, { intermediates: true });
    }
  }

  /**
   * Gets the directory path for a specific event
   */
  static getEventDirectory(eventId: string) {
    return `${STORAGE_ROOT}${eventId}/`;
  }

  /**
   * Prepares the directory for an event
   */
  static async prepareEventDirectory(eventId: string) {
    await this.init();
    const dirPath = this.getEventDirectory(eventId);
    const dirInfo = await getInfoAsync(dirPath);
    if (!dirInfo.exists) {
      await makeDirectoryAsync(dirPath, { intermediates: true });
    }
    return dirPath;
  }

  /**
   * C-to-C Import: 외부 저장소(SD 카드)에서 선택된 미디어 파일을
   * 이벤트 디렉토리로 복사하고 로컬 경로를 반환합니다.
   */
  static async importMediaFile(
    eventId: string,
    fileType: 'video' | 'audio',
    partIndex: number,
    sourceUri: string,
  ): Promise<string> {
    const dirPath = await this.prepareEventDirectory(eventId);
    const ext = fileType === 'video' ? 'avi' : 'wav';
    const destPath = `${dirPath}${fileType}_${partIndex}.${ext}`;

    // 멱등 복사: 이전 시도(케이블 분리로 중단 등)의 잔여/부분 파일이
    // 남아 있으면 지우고 다시 받는다 — 부분 파일이 '있음'으로 오인되어
    // 분석에 깨진 미디어가 첨부되는 것을 방지.
    const destInfo = await getInfoAsync(destPath);
    if (destInfo.exists) {
      await deleteAsync(destPath, { idempotent: true });
    }

    await copyAsync({ from: sourceUri, to: destPath });
    return destPath;
  }

  /** 이벤트 디렉토리 내 미디어 파트의 로컬 경로 (존재 여부와 무관한 규칙상 경로) */
  static localPartPath(eventId: string, fileType: 'video' | 'audio', partIndex: number): string {
    const ext = fileType === 'video' ? 'avi' : 'wav';
    return `${this.getEventDirectory(eventId)}${fileType}_${partIndex}.${ext}`;
  }

  /** 이벤트 디렉토리 내 썸네일의 로컬 경로 */
  static localThumbPath(eventId: string): string {
    return `${this.getEventDirectory(eventId)}thumb.jpg`;
  }

  /**
   * 로컬 파일이 이미 온전히 존재하는지 — 파트 단위 멱등 임포트의 판정자.
   * 크기 0은 중단된 복사의 잔재로 보고 '없음'으로 취급한다.
   */
  static async hasLocalFile(path: string): Promise<boolean> {
    try {
      const info = await getInfoAsync(path);
      return info.exists && (info as { size?: number }).size !== 0;
    } catch {
      return false;
    }
  }

  /**
   * 틱 직전 실사 스냅샷(<eventId>_thumb.jpg)을 이벤트 디렉토리로 복사합니다.
   * 카드/상세 뷰어의 즉시 확인용 — 미디어 파트와 달리 단일 파일이다.
   */
  static async importThumbFile(eventId: string, sourceUri: string): Promise<string> {
    const dirPath = await this.prepareEventDirectory(eventId);
    const destPath = `${dirPath}thumb.jpg`;

    const destInfo = await getInfoAsync(destPath);
    if (destInfo.exists) {
      await deleteAsync(destPath, { idempotent: true });
    }

    await copyAsync({ from: sourceUri, to: destPath });
    return destPath;
  }

  /**
   * 이벤트 디렉토리에 실제로 존재하는 미디어 파트 목록을 반환합니다.
   * (재생 UI용 — 대표 경로 외의 파트도 사용자에게 노출)
   */
  static async listEventMedia(
    eventId: string,
  ): Promise<{ fileType: 'video' | 'audio'; partIndex: number; path: string }[]> {
    const dirPath = this.getEventDirectory(eventId);
    try {
      const dirInfo = await getInfoAsync(dirPath);
      if (!dirInfo.exists) return [];
      const { readDirectoryAsync } = require('expo-file-system/legacy');
      const names: string[] = await readDirectoryAsync(dirPath);
      const parts: { fileType: 'video' | 'audio'; partIndex: number; path: string }[] = [];
      for (const name of names) {
        const m = name.match(/^(video|audio)_(\d+)\.(avi|wav)$/i);
        if (!m) continue;
        parts.push({
          fileType: m[1].toLowerCase() as 'video' | 'audio',
          partIndex: parseInt(m[2], 10),
          path: `${dirPath}${name}`,
        });
      }
      // 영상 먼저, 각 타입 내에서는 파트 순
      return parts.sort((a, b) =>
        a.fileType === b.fileType ? a.partIndex - b.partIndex : a.fileType === 'video' ? -1 : 1,
      );
    } catch (e) {
      console.warn(`[MediaRepository] Failed to list media for ${eventId}:`, e);
      return [];
    }
  }

  /**
   * Deletes an event directory and all its contents
   */
  static async deleteEvent(eventId: string) {
    const dirPath = this.getEventDirectory(eventId);
    const dirInfo = await getInfoAsync(dirPath);
    if (dirInfo.exists) {
      await deleteAsync(dirPath, { idempotent: true });
    }
  }
}
