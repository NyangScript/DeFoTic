import { bleManager } from './BleManager';
import { ticEventStore } from '../data/TicEventStore';
import { geminiAnalyzer } from '../ai/GeminiAnalyzer';
import { TicEvent, TicEventType } from '../../types/tic-event';
import { Platform } from 'react-native';

class DeviceSyncService {
  public setupSyncListener() {
    if (Platform.OS === 'web') return;

    // BLE에서 틱 이벤트 알림이 오면 처리
    bleManager.onTicEventReceived(async (payload) => {
      console.log('Received Tic Event from BLE:', payload);
      
      // 1. 이벤트 객체 생성
      const newEvent: TicEvent = {
        id: `evt_${payload.timestamp}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date(payload.timestamp * 1000).toISOString(),
        type: payload.tic_type as TicEventType,
        intensity: payload.intensity,
        analysisStatus: 'pending',
      };

      // 2. 먼저 스토어에 추가 (화면에 "AI 분석 중..." 상태로 표시됨)
      await ticEventStore.addEvent({ ...newEvent, analysisStatus: 'analyzing' });

      // 3. (옵션) 청크로 나누어진 비디오를 받아 조립하는 로직은 향후 구현 (현재는 임시 패스)
      if (payload.has_video) {
        console.log('Video data exists, need to fetch chunks...');
        // TODO: BLE 청크 수신 또는 WiFi 동기화 로직
      }

      // 4. Gemini API로 상황 분석 요청
      const analyzedEvent = await geminiAnalyzer.analyzeTicEvent(newEvent);

      // 5. 스토어에 분석 완료된 이벤트 업데이트 (화면 갱신됨)
      await ticEventStore.updateEventAnalysis(newEvent.id, analyzedEvent);
    });
  }

  // 사용자가 수동으로 동기화를 누를 때 (기존 저장된 데이터 동기화 등)
  public async syncData(): Promise<void> {
    if (Platform.OS === 'web') return;

    const device = bleManager.getConnectedDevice();
    if (!device) throw new Error('Device not connected');

    console.log('Starting manual data sync...');
    
    // TODO: ESP32-S3에 누적된 데이터를 달라고 요청하는 BLE Command 전송
    // 현재는 이벤트 기반 Notify로 처리하므로 이 함수는 단순 핑 용도로 사용 가능
  }
}

export const deviceSync = new DeviceSyncService();
