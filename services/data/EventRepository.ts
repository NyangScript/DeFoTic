import { useEventStore } from '../../stores/useEventStore';
import { TicEvent } from '../../types/tic-event';

export class EventRepository {
  /**
   * BLE tic_event 메타데이터 수신 시 이벤트 레코드를 생성합니다.
   * 미디어는 아직 기기 SD 카드에 있으므로 'pending_media' 상태로 시작합니다.
   */
  static async createFromTicEvent(
    eventId: string,
    timestampSec: number,
    confidence: number
  ) {
    const timestamp = new Date(
      timestampSec > 1e12 ? timestampSec : timestampSec * 1000
    ).toISOString();

    const newEvent: TicEvent = {
      id: eventId,
      timestamp,
      type: 'vocal', // 추후 LLM 분석으로 갱신
      intensity: Math.max(1, Math.min(10, Math.round(confidence * 10))),
      detectionConfidence: confidence,
      transferStatus: 'pending_media',
      analysisStatus: 'pending',
    };

    await useEventStore.getState().addEvent(newEvent);
  }

  /**
   * BLE 메타데이터를 놓친 이벤트를 C-to-C Import 시 파일명 타임스탬프로 복원합니다.
   */
  static async createFromImport(eventId: string, timestampMs: number) {
    const newEvent: TicEvent = {
      id: eventId,
      timestamp: new Date(timestampMs).toISOString(),
      type: 'vocal', // 추후 LLM 분석으로 갱신
      intensity: 5,
      transferStatus: 'pending_media',
      analysisStatus: 'pending',
    };

    await useEventStore.getState().addEvent(newEvent);
  }

  /**
   * C-to-C Import로 미디어 파일이 매핑되면 경로를 기록하고 'synced' 처리합니다.
   */
  static async attachMedia(
    eventId: string,
    media: { videoPath?: string; audioPath?: string }
  ) {
    await useEventStore.getState().updateEvent(eventId, {
      ...media,
      transferStatus: 'synced',
    });
  }
}
