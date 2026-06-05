import { useEventStore } from '../../stores/useEventStore';
import { TicEvent } from '../../types/tic-event';

export class EventRepository {
  /**
   * Initializes a new Event Record in the store when an event metadata is received.
   */
  static async createEventRecord(
    eventId: string,
    timestampMs: number,
    videoSize: number,
    audioSize: number
  ) {
    const timestamp = new Date(timestampMs > 1e12 ? timestampMs : timestampMs * 1000).toISOString();
    
    const newEvent: TicEvent = {
      id: eventId,
      timestamp,
      type: 'vocal', // This could be updated later by LLM
      intensity: 1, // Default intensity
      analysisStatus: 'pending',
      transferStatus: 'receiving',
      transferProgress: {
        video: 0,
        audio: 0,
      },
    };

    await useEventStore.getState().addEvent(newEvent);
  }

  /**
   * Updates transfer progress for an event
   */
  static async updateTransferProgress(eventId: string, type: 'video' | 'audio', progress: number) {
    const currentEvents = useEventStore.getState().events;
    const ev = currentEvents.find(e => e.id === eventId);
    if (!ev) return;

    const transferProgress = {
      video: ev.transferProgress?.video || 0,
      audio: ev.transferProgress?.audio || 0,
      [type]: progress,
    };

    // If both are 100%, we wait for event_end to mark 'completed'
    await useEventStore.getState().updateEvent(eventId, { transferProgress });
  }

  /**
   * Updates file paths and marks transfer as complete
   */
  static async completeTransfer(eventId: string, videoPath: string, audioPath: string) {
    await useEventStore.getState().updateEvent(eventId, {
      videoPath,
      audioPath,
      transferStatus: 'completed',
    });
  }

  /**
   * Marks a transfer as failed
   */
  static async failTransfer(eventId: string) {
    await useEventStore.getState().updateEvent(eventId, {
      transferStatus: 'failed',
    });
  }
}
