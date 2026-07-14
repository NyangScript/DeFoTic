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

    await copyAsync({ from: sourceUri, to: destPath });
    return destPath;
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
