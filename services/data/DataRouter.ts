import { TicEvent } from '../../types/tic-event';
import { ticEventStore } from './TicEventStore';
// import { collection, addDoc } from 'firebase/firestore'; // Firebase 모듈은 사용자가 연동을 원할 때 활성화
// import { db } from '../firebase/config';

class DataRouterService {
  private isUploading = false;

  public async uploadPendingData(): Promise<void> {
    if (this.isUploading) return;
    this.isUploading = true;

    try {
      const events = await ticEventStore.getEvents();
      const pendingEvents = events.filter(e => !e.videoClipUrl); // 아직 업로드 안 된 이벤트(모의 기준)
      
      if (pendingEvents.length === 0) {
        console.log('No pending data to upload.');
        return;
      }

      console.log(`Uploading ${pendingEvents.length} events to Cloud...`);
      
      // Firebase 연동이 결정되면 아래 로직으로 대체
      /*
      for (const event of pendingEvents) {
        await addDoc(collection(db, 'tic_events'), event);
      }
      */

      // 모의 업로드 딜레이
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Upload complete.');

    } catch (error) {
      console.error('Data routing error:', error);
    } finally {
      this.isUploading = false;
    }
  }
}

export const dataRouter = new DataRouterService();
