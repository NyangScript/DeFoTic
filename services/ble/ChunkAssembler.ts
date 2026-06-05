import { File, Paths } from 'expo-file-system';
import { useEventStore } from '../../stores/useEventStore';
import { dataRouter } from '../data/DataRouter';

// ─── Types matching the hardware BLE protocol ───

/** Sent by HW before chunk stream begins */
export interface EventStartPayload {
  type: 'event_start';
  fileType: string;   // "video" | "audio"
  size: number;       // total raw bytes
  chunks: number;     // expected chunk count
}

/** Individual base64 chunk sent by HW */
export interface ChunkPayload {
  type: 'chunk';
  index: number;
  payload: string;    // base64 fragment
}

/** Sent by HW after all chunks for a file */
export interface EventEndPayload {
  type: 'event_end';
  chunks: number;     // actual chunks sent
}

// ─── Internal buffer for an in-progress transfer ───

interface TransferBuffer {
  fileType: string;
  expectedChunks: number;
  expectedSize: number;
  chunks: (string | null)[];
  receivedCount: number;
  lastUpdated: number;
  eventId: string;    // assigned by the app when tic_event arrives
}

class ChunkAssemblerService {
  private currentTransfer: TransferBuffer | null = null;
  private pendingEventId: string | null = null;
  private readonly TIMEOUT_MS = 60_000; // 1 minute timeout per transfer

  constructor() {
    setInterval(() => this.cleanupStaleTransfer(), 10_000);
  }

  /**
   * Called by BleManager when a tic_event is received.
   * Stores the event ID so subsequent file transfers can be linked.
   */
  public setPendingEventId(eventId: string) {
    this.pendingEventId = eventId;
  }

  /**
   * Handle event_start — prepare buffer for incoming chunks
   */
  public handleEventStart(payload: EventStartPayload) {
    const eventId = this.pendingEventId || `evt_${Date.now()}`;

    this.currentTransfer = {
      fileType: payload.fileType,
      expectedChunks: payload.chunks,
      expectedSize: payload.size,
      chunks: new Array(payload.chunks).fill(null),
      receivedCount: 0,
      lastUpdated: Date.now(),
      eventId,
    };

    console.log(`[ChunkAssembler] Transfer started: ${payload.fileType}, ` +
      `${payload.chunks} chunks, ${payload.size} bytes, event=${eventId}`);
  }

  /**
   * Handle individual chunk
   */
  public handleChunk(payload: ChunkPayload) {
    if (!this.currentTransfer) {
      console.warn('[ChunkAssembler] Chunk received but no transfer in progress');
      return;
    }

    const { index } = payload;
    if (index < 0 || index >= this.currentTransfer.expectedChunks) {
      console.warn(`[ChunkAssembler] Chunk index ${index} out of range`);
      return;
    }

    if (this.currentTransfer.chunks[index] === null) {
      this.currentTransfer.receivedCount++;
    }
    this.currentTransfer.chunks[index] = payload.payload;
    this.currentTransfer.lastUpdated = Date.now();
  }

  /**
   * Handle event_end — assemble all chunks and save to file
   */
  public async handleEventEnd(_payload: EventEndPayload) {
    if (!this.currentTransfer) {
      console.warn('[ChunkAssembler] event_end but no transfer in progress');
      return;
    }

    const transfer = this.currentTransfer;
    this.currentTransfer = null; // release for next file

    // Check completeness
    const missingChunks = transfer.chunks
      .map((c, i) => (c === null ? i : -1))
      .filter(i => i >= 0);

    if (missingChunks.length > 0) {
      console.warn(`[ChunkAssembler] Missing ${missingChunks.length} chunks: ${missingChunks.slice(0, 5)}`);
      // Still attempt to save what we have
    }

    await this.assembleAndSave(transfer);
  }

  // ─── Internal ───

  private async assembleAndSave(transfer: TransferBuffer) {
    try {
      const validChunks = transfer.chunks.filter((c): c is string => c !== null);
      const fullBase64 = validChunks.join('');

      const ext = transfer.fileType === 'video' ? 'avi' : 'wav';
      const fileName = `${transfer.eventId}_${transfer.fileType}.${ext}`;

      const file = new File(Paths.document, fileName);
      file.write(fullBase64, { encoding: 'base64' });
      const uri = file.uri;

      console.log(`[ChunkAssembler] File saved: ${uri} (${validChunks.length}/${transfer.expectedChunks} chunks)`);

      // Update the event in the store with the local file path
      const events = useEventStore.getState().events;
      const targetEvent = events.find((e) => e.id === transfer.eventId);

      if (targetEvent) {
        const updateField = transfer.fileType === 'video' ? 'videoClipUrl' : 'audioClipUrl';
        await useEventStore.getState().updateEventAnalysis(transfer.eventId, {
          ...targetEvent,
          [updateField]: uri,
        });

        // If this is the video file, trigger Gemini analysis
        if (transfer.fileType === 'video') {
          dataRouter.triggerAnalysis(transfer.eventId);
        }
      }
    } catch (e) {
      console.error(`[ChunkAssembler] Failed to assemble: ${transfer.eventId}`, e);
    }
  }

  private cleanupStaleTransfer() {
    if (!this.currentTransfer) return;
    if (Date.now() - this.currentTransfer.lastUpdated > this.TIMEOUT_MS) {
      console.warn(`[ChunkAssembler] Transfer timeout: ${this.currentTransfer.eventId}`);
      this.currentTransfer = null;
    }
  }
}

export const chunkAssembler = new ChunkAssemblerService();
