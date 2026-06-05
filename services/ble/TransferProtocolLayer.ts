import { ChunkManager } from './ChunkManager';

export interface EventStartPayload {
  type: 'event_start';
  eventId: string;
  timestamp: number;
  videoSize: number;
  audioSize: number;
  videoChunks: number;
  audioChunks: number;
  protocolVersion: string;
}

export interface VideoChunkPayload {
  type: 'video_chunk';
  eventId: string;
  index: number;
  total: number;
  crc32: string; // Hex string e.g. "AB12CD34"
  payload: string; // Base64
}

export interface AudioChunkPayload {
  type: 'audio_chunk';
  eventId: string;
  index: number;
  total: number;
  crc32: string;
  payload: string;
}

export interface EventEndPayload {
  type: 'event_end';
  eventId: string;
}

export type TransferMessage = 
  | EventStartPayload 
  | VideoChunkPayload 
  | AudioChunkPayload 
  | EventEndPayload;

class TransferProtocolLayer {
  public handleMessage(message: any) {
    try {
      switch (message.type) {
        case 'event_start':
          console.log(`[Protocol] event_start received: ${message.eventId}`);
          ChunkManager.handleEventStart(message as EventStartPayload);
          break;
        case 'video_chunk':
        case 'audio_chunk':
          ChunkManager.handleChunk(message as VideoChunkPayload | AudioChunkPayload);
          break;
        case 'event_end':
          console.log(`[Protocol] event_end received: ${message.eventId}`);
          ChunkManager.handleEventEnd(message as EventEndPayload);
          break;
        default:
          console.warn(`[Protocol] Unknown message type: ${message.type}`);
      }
    } catch (e) {
      console.error('[Protocol] Error handling message', e);
    }
  }
}

export const transferProtocolLayer = new TransferProtocolLayer();
