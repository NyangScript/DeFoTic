import { documentDirectory, getInfoAsync, makeDirectoryAsync, writeAsStringAsync, deleteAsync, EncodingType } from 'expo-file-system/legacy';

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
   * Saves a base64 encoded media file to the event directory
   */
  static async saveMedia(eventId: string, fileType: 'video' | 'audio', base64Data: string): Promise<string> {
    const dirPath = await this.prepareEventDirectory(eventId);
    const ext = fileType === 'video' ? 'avi' : 'wav';
    const filePath = `${dirPath}${fileType}.${ext}`;
    
    await writeAsStringAsync(filePath, base64Data, {
      encoding: EncodingType.Base64,
    });
    
    return filePath;
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
