import { useEventStore } from '../../stores/useEventStore';
import { useAnalysisStore } from '../../stores/useAnalysisStore';
import { geminiAnalyzer } from '../ai/GeminiAnalyzer';
import { firebaseSync } from '../cloud/FirebaseSync';

class DataRouterService {
  /**
   * 분석 동시성 제한:
   * focus 재트리거/일괄 임포트가 대기 이벤트 전부를 '동시에' 분석하면
   * 이벤트당 최대 14MB 미디어의 base64(×4/3) 문자열 + JSON.stringify
   * 사본이 N개 병렬로 힙에 적재되어 OOM, API 측은 429 폭주로 일괄
   * 'failed' 고착된다. 트리거는 큐에 쌓고 한 번에 1건만 실행한다.
   * (enqueue의 중복 검사는 await 이전의 동기 구간이라 race도 없다)
   */
  private queue: string[] = [];
  private queued = new Set<string>();
  private active = 0;
  private static readonly MAX_CONCURRENT = 1;

  // 분석 진행 중 도착한 재트리거 기억: 진행 중이라는 이유로 무음
  // 드롭하면, 그 사이 보완 임포트된 미디어가 영구 미분석으로 남을 수
  // 있다(완료 후 재큐잉 주체가 없음 — focus 필터는 completed를 안
  // 잡는다). 드롭 대신 dirty로 표시하고 완료 시점에 1회 재큐잉한다.
  private dirtyWhileAnalyzing = new Set<string>();

  public async triggerAnalysis(eventId: string): Promise<void> {
    // 검사 순서 중요: 실행 중인 이벤트는 queued에도 남아 있으므로
    // (제거는 finally에서) queued 검사를 먼저 하면 isAnalyzing 분기가
    // 도달 불능이 되어 dirty 마킹이 죽은 코드가 된다.
    // 실행 중 → dirty 마킹, 큐 대기 중(미실행) → 기존 dedupe.
    if (useAnalysisStore.getState().isAnalyzing(eventId)) {
      this.dirtyWhileAnalyzing.add(eventId);
      return;
    }
    if (this.queued.has(eventId)) return;

    this.queued.add(eventId);
    this.queue.push(eventId);
    this.pump();
  }

  private pump(): void {
    while (this.active < DataRouterService.MAX_CONCURRENT && this.queue.length > 0) {
      const eventId = this.queue.shift()!;
      this.active++;
      this.runAnalysis(eventId)
        .catch(e => console.error(`[DataRouter] Unexpected pipeline error for ${eventId}:`, e))
        .finally(() => {
          this.active--;
          this.queued.delete(eventId);
          if (this.dirtyWhileAnalyzing.delete(eventId)) {
            console.log(`[DataRouter] Re-queueing ${eventId} (media updated during analysis)`);
            this.triggerAnalysis(eventId).catch(() => {});
          }
          this.pump();
        });
    }
  }

  private async runAnalysis(eventId: string): Promise<void> {
    const analysisStore = useAnalysisStore.getState();
    const eventStore = useEventStore.getState();

    if (analysisStore.isAnalyzing(eventId)) return;

    // 영속 이벤트가 아직 로드되지 않은 극초기 호출 방어 —
    // 로드 전에 찾으면 "이벤트 없음"으로 조용히 증발한다.
    await eventStore.loadEvents();

    analysisStore.startAnalyzing(eventId);

    try {
      // 전체 교체(스냅샷 스프레드) 금지:
      // 분석이 도는 동안 다른 경로(추가 파트 import 등)가 갱신한 필드를
      // 분석 시작 시점의 낡은 스냅샷으로 되돌리는 유실 경로가 된다.
      // 항상 부분 갱신(updateEvent)으로 필요한 필드만 만진다.
      await useEventStore.getState().updateEvent(eventId, { analysisStatus: 'analyzing' });

      // 상태 갱신 이후의 최신 스냅샷으로 분석한다 — 트리거 시점과 실행
      // 시점 사이에 미디어 경로가 추가/교체되는 경우를 놓치지 않는다.
      const event = useEventStore.getState().events.find(e => e.id === eventId);
      if (!event) {
        console.warn(`[DataRouter] Event not found, skipping analysis: ${eventId}`);
        return;
      }

      // Gemini 분석 수행 (analyzeTicEvent는 내부 catch로 throw하지 않고
      // 실패 시 analysisStatus='failed' + analysisError를 담아 반환한다)
      const analyzedEvent = await geminiAnalyzer.analyzeTicEvent(event);

      await useEventStore.getState().updateEvent(eventId, {
        type: analyzedEvent.type,
        aiAnalysis: analyzedEvent.aiAnalysis,
        analysisStatus: analyzedEvent.analysisStatus,
        analysisError: analyzedEvent.analysisError,
      });
      console.log(`[DataRouter] Analysis ${analyzedEvent.analysisStatus} for event: ${eventId}`);

      // ── 의료진 웹뷰용 Firestore 동기화 (설정된 경우에만, 실패 무해) ──
      if (analyzedEvent.analysisStatus === 'completed') {
        const latest = useEventStore.getState().events.find(e => e.id === eventId);
        if (latest) {
          firebaseSync
            .upsertEvent(latest)
            .catch(e => console.warn('[DataRouter] Firestore sync failed (non-critical):', e));
        }
      }
    } catch (error) {
      console.error(`Analysis failed for event ${eventId}:`, error);
      await useEventStore.getState().updateEvent(eventId, {
        analysisStatus: 'failed',
        analysisError: '분석 파이프라인 내부 오류가 발생했습니다. 다시 시도해주세요.',
      });
    } finally {
      analysisStore.finishAnalyzing(eventId);
    }
  }
}

export const dataRouter = new DataRouterService();
