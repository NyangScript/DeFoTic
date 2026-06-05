import { EventStartPayload, VideoChunkPayload, AudioChunkPayload, EventEndPayload } from './TransferProtocolLayer';
import { MediaRepository } from '../data/MediaRepository';
import { EventRepository } from '../data/EventRepository';

// Simple CRC32 implementation for chunk verification
function calculateCRC32(str: string): string {
  let crc = 0 ^ (-1);
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
  }
  return ((crc ^ (-1)) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

const crcTable = (function() {
  let c;
  const table = [];
  for(let n =0; n < 256; n++){
    c = n;
    for(let k =0; k < 8; k++){
      c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c;
  }
  return table;
})();

interface TransferSession {
  eventId: string;
  meta: EventStartPayload;
  videoChunks: string[];
  audioChunks: string[];
  receivedVideo: number;
  receivedAudio: number;
}

class ChunkManagerImpl {
  private activeSessions = new Map<string, TransferSession>();

  public async handleEventStart(payload: EventStartPayload) {
    this.activeSessions.set(payload.eventId, {
      eventId: payload.eventId,
      meta: payload,
      videoChunks: new Array(payload.videoChunks).fill(''),
      audioChunks: new Array(payload.audioChunks).fill(''),
      receivedVideo: 0,
      receivedAudio: 0,
    });

    await EventRepository.createEventRecord(
      payload.eventId, 
      payload.timestamp, 
      payload.videoSize, 
      payload.audioSize
    );
  }

  public async handleChunk(payload: VideoChunkPayload | AudioChunkPayload) {
    const session = this.activeSessions.get(payload.eventId);
    if (!session) {
      console.warn(`[ChunkManager] Chunk received for unknown session ${payload.eventId}`);
      return;
    }

    // CRC32 Verification
    const computedCrc = calculateCRC32(payload.payload);
    if (computedCrc !== payload.crc32) {
      console.warn(`[ChunkManager] CRC mismatch for ${payload.type} index ${payload.index}. Expected ${payload.crc32}, got ${computedCrc}`);
      // Drop chunk. (We can implement resend logic later)
      return;
    }

    if (payload.type === 'video_chunk') {
      if (!session.videoChunks[payload.index]) {
        session.videoChunks[payload.index] = payload.payload;
        session.receivedVideo++;
        
        // Progress update
        const progress = Math.round((session.receivedVideo / session.meta.videoChunks) * 100);
        EventRepository.updateTransferProgress(payload.eventId, 'video', progress);
      }
    } else if (payload.type === 'audio_chunk') {
      if (!session.audioChunks[payload.index]) {
        session.audioChunks[payload.index] = payload.payload;
        session.receivedAudio++;
        
        const progress = Math.round((session.receivedAudio / session.meta.audioChunks) * 100);
        EventRepository.updateTransferProgress(payload.eventId, 'audio', progress);
      }
    }
  }

  public async handleEventEnd(payload: EventEndPayload) {
    const session = this.activeSessions.get(payload.eventId);
    if (!session) return;

    // 2nd Validation: Check if all chunks received
    if (session.receivedVideo < session.meta.videoChunks || session.receivedAudio < session.meta.audioChunks) {
      console.error(`[ChunkManager] Incomplete transfer for ${payload.eventId}. V:${session.receivedVideo}/${session.meta.videoChunks}, A:${session.receivedAudio}/${session.meta.audioChunks}`);
      await EventRepository.failTransfer(payload.eventId);
      this.activeSessions.delete(payload.eventId);
      return;
    }

    try {
      console.log(`[ChunkManager] Assembling files for ${payload.eventId}`);
      
      const videoBase64 = session.videoChunks.join('');
      const audioBase64 = session.audioChunks.join('');

      // Save files
      const videoPath = await MediaRepository.saveMedia(payload.eventId, 'video', videoBase64);
      const audioPath = await MediaRepository.saveMedia(payload.eventId, 'audio', audioBase64);

      // Complete transfer
      await EventRepository.completeTransfer(payload.eventId, videoPath, audioPath);
      
      // Clean up session
      this.activeSessions.delete(payload.eventId);
      
      // Trigger AI Analysis here via DataRouter
      const { dataRouter } = require('../data/DataRouter');
      dataRouter.triggerAnalysis(payload.eventId);
      
    } catch (e) {
      console.error(`[ChunkManager] Assemble error:`, e);
      await EventRepository.failTransfer(payload.eventId);
    }
  }
}

export const ChunkManager = new ChunkManagerImpl();
