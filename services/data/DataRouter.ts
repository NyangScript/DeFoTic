import { useEventStore } from '../../stores/useEventStore';
import { useAnalysisStore } from '../../stores/useAnalysisStore';
import { geminiAnalyzer } from '../ai/GeminiAnalyzer';

class DataRouterService {
  public async triggerAnalysis(eventId: string): Promise<void> {
    const analysisStore = useAnalysisStore.getState();
    const eventStore = useEventStore.getState();
    
    if (analysisStore.isAnalyzing(eventId)) return;

    const event = eventStore.events.find(e => e.id === eventId);
    if (!event) return;

    analysisStore.startAnalyzing(eventId);

    try {
      // 진행 상태 표시 위해 상태 업데이트
      await eventStore.updateEventAnalysis(eventId, { ...event, analysisStatus: 'analyzing' });

      // Gemini 분석 수행
      const analyzedEvent = await geminiAnalyzer.analyzeTicEvent(event);
      
      // 결과 저장
      await eventStore.updateEventAnalysis(eventId, analyzedEvent);
      console.log(`Analysis completed for event: ${eventId}`);
    } catch (error) {
      console.error(`Analysis failed for event ${eventId}:`, error);
      await eventStore.updateEventAnalysis(eventId, { ...event, analysisStatus: 'failed' });
    } finally {
      analysisStore.finishAnalyzing(eventId);
    }
  }
}

export const dataRouter = new DataRouterService();
