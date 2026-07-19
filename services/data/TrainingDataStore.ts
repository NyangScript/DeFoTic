// import type 필수: GeminiAnalyzer가 이 모듈(trainingDataStore)을 런타임
// 임포트하므로, 여기서 값 임포트를 하면 순환 참조가 된다. 타입 전용
// 임포트는 번들에서 완전히 지워져 사이클이 생기지 않는다.
// (gemini-config는 상수 전용 모듈이라 값 임포트해도 사이클이 없다)
import type { GeminiTicAnalysis } from '../ai/GeminiAnalyzer';
import { GEMINI_PROMPT_VERSION, PROMPT_SPLIT_MARKER } from '../../constants/gemini-config';
import { useEventStore } from '../../stores/useEventStore';

/**
 * LoRA 파인튜닝 학습 데이터 수집 스토어.
 *
 * 목적: Gemini API의 (프롬프트+미디어) → (분석 JSON) 쌍은 향후 vLLM 기반
 * DeFoTic 커스텀 모델을 LoRA로 파인튜닝할 때의 1급 학습 데이터다.
 * 분석이 성공할 때마다 아래의 "좁고 명확한" 스키마 한 줄(JSONL)을
 * 앱 내부 저장소에 누적하고, 필요 시 SAF로 폰 공용 저장소에 내보낸다.
 *
 * 설계 원칙 (Narrowing):
 *  - 출력은 반드시 normalizeGeminiAnalysis를 통과한 정규화 값만 기록 —
 *    스키마 이탈 샘플이 학습 데이터셋을 오염시키지 않는다.
 *  - 미디어 바이너리는 중복 저장하지 않는다. events/{eventId}/에 이미
 *    있는 파일을 mimeType/size 메타로만 참조한다 (조인 키 = eventId).
 *  - 오탐/미탐 사용자 피드백(userFeedback)은 이벤트에 늦게 붙으므로
 *    기록 시점이 아니라 "내보내기 시점"에 이벤트 스토어에서 병합한다.
 */

export interface TrainingSample {
  // 스키마 세대별 의미 (하위 호환 판독에 필요):
  // v1: promptVersion 없음 — 읽기 시 1로 간주.
  // v2: promptVersion 필드 추가 (프롬프트 템플릿 세대 식별 —
  //     신·구 프롬프트 샘플이 데이터셋에 구분 없이 혼재되는 것을 막는다).
  // v3: promptStatic/promptDynamic(system·user 분해 기록),
  //     fallbackFieldCount(정규화 폴백 주입 수 — 합성 정답 게이트) 추가.
  schemaVersion: 1 | 2 | 3;
  recordedAt: string;       // ISO 8601 — 기록 시각
  eventId: string;
  eventTimestamp: string;   // ISO 8601 — 틱 발생 시각
  detectionConfidence?: number;   // 온디바이스(Edge Impulse) 감지 신뢰도
  model: string;            // 응답을 생성한 모델 (예: gemini-3.1-flash-lite)
  promptVersion?: number;   // constants/gemini-config.ts GEMINI_PROMPT_VERSION
  latencyMs: number;
  prompt: string;           // 실제 전송된 텍스트 프롬프트 (메타데이터 치환 후)
  // system/user 분해 (v3+): promptStatic = 상수 지시부(system 역할),
  // promptDynamic = 이벤트별 가변부(user 역할). 구 샘플은 내보내기가
  // PROMPT_SPLIT_MARKER로 소급 분해한다.
  promptStatic?: string;
  promptDynamic?: string;
  attachedMedia: { mimeType: string; sizeBytes: number }[];
  rawResponse: string;      // 모델 원문 응답 (파싱 전)
  normalizedOutput: GeminiTicAnalysis;  // 정규화 통과 출력 — 학습 타깃
  // 정규화가 폴백('상황 추정 불가' 등)으로 채운 필드 수 (v3+) —
  // 임계 초과 샘플은 내보내기에서 제외된다 (교사 실패의 합성 정답 차단)
  fallbackFieldCount?: number;
}

const TRAINING_DIR = 'training/';
const SAMPLES_SUBDIR = 'samples/';

function fs() {
  // lazy require — 웹 번들 등 네이티브 FS가 없는 환경에서 모듈 로드만으로
  // 죽지 않게 한다 (MediaSyncManager와 동일 패턴)
  return require('expo-file-system/legacy');
}

class TrainingDataStoreService {
  // 파일명 유일성 보장용 (같은 ms에 두 샘플이 와도 충돌하지 않게)
  private seq = 0;

  /**
   * 저장 구조: 샘플 1건 = 파일 1개 (training/samples/*.json)
   * 단일 JSONL에 "전체 읽기 + 전체 재쓰기"로 append하는 방식은 기록 중
   * 강제종료 시 과거 샘플까지 통째로 소실되는 비원자 truncate-write다.
   * 파일 분리는 새 샘플 기록이 기존 데이터를 절대 건드리지 않아
   * 구조적으로 안전하고, 손상은 해당 1건으로 격리된다.
   */
  private async samplesDir(): Promise<string> {
    const FileSystem = fs();
    const dir = `${FileSystem.documentDirectory}${TRAINING_DIR}${SAMPLES_SUBDIR}`;
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return dir;
  }

  /** 분석 1건의 학습 샘플을 기록합니다 (실패는 호출자에 무해). */
  public async recordAnalysis(input: Omit<TrainingSample, 'schemaVersion' | 'recordedAt'>): Promise<void> {
    const sample: TrainingSample = {
      schemaVersion: 3,
      recordedAt: new Date().toISOString(),
      ...input,
    };

    const FileSystem = fs();
    const dir = await this.samplesDir();
    // 파일명: 이벤트ID_기록시각_순번 — FAT/콘텐츠 프로바이더 안전 문자만
    const safeId = sample.eventId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `${safeId}_${Date.now()}_${this.seq++}.json`;
    await FileSystem.writeAsStringAsync(`${dir}${name}`, JSON.stringify(sample));
  }

  /** 누적 샘플을 모두 읽습니다 (손상 파일은 해당 건만 건너뜁니다). */
  public async readAllSamples(): Promise<TrainingSample[]> {
    try {
      const FileSystem = fs();
      const dir = await this.samplesDir();
      const names: string[] = await FileSystem.readDirectoryAsync(dir);
      const out: TrainingSample[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(await FileSystem.readAsStringAsync(`${dir}${name}`));
          if (parsed && typeof parsed.eventId === 'string' && parsed.normalizedOutput) {
            out.push(parsed as TrainingSample);
          }
        } catch {
          // 부분 쓰기 등으로 깨진 샘플은 해당 1건만 제외
        }
      }
      // 기록 시각 순 정렬 (파일 시스템 열거 순서는 보장되지 않음)
      return out.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    } catch (e) {
      console.warn('[Training] Failed to read samples:', e);
      return [];
    }
  }

  /**
   * ── LoRA 파인튜닝용 데이터셋 내보내기 (Narrowing) ──
   *
   * 포맷: OpenAI messages 스키마 (system/user/assistant) JSONL.
   *  ※ sharegpt 포맷이 아니다 — sharegpt는 conversations/from/value
   *    구조라 axolotl `type: sharegpt`로는 파싱되지 않는다. 이 포맷은
   *    HF TRL SFTTrainer(messages 컬럼 자동 인식), axolotl chat_template
   *    계열, LLaMA-Factory에서 그대로 소화된다.
   *
   * 품질 게이트:
   *  1. 라벨된 이벤트만 내보낸다 — 미검증(unlabeled) 샘플을 포함하면
   *     오탐 폭주기 데이터의 대부분이 '환각 정답'으로 데이터셋을 오염시킨다.
   *  2. false_positive는 제외가 아니라 **부정 예시**로 전환:
   *     타깃 = {"isTic": false}. 오탐 억제가 제품 핵심 문제이므로
   *     "이건 틱이 아니다"를 배울 데이터가 반드시 필요하다.
   *  3. eventId별 최신 1건 dedupe — 재분석 누적 중복 제거.
   *  4. 현행 promptVersion만 포함 — 세대별로 출력 필드 구성이 다른
   *     타깃의 혼재 차단.
   *  5. fallbackFieldCount > 3 샘플 제외 — 교사 실패의 placeholder 정답 차단.
   *  6. system(상수 지시)/user(가변 메타데이터) 분해 — boilerplate 반복
   *     학습 낭비 제거 + 파인튜닝 후 지시 축약의 전제 조건.
   *  7. 시간순 train/val 분할(최신 20% = val) — 10초 쿨다운으로 세션 내
   *     샘플 상관이 극도로 높아 랜덤 분할은 누수 확정이다.
   *  8. 매니페스트 JSON 동봉 — 건수/라벨 분포/버전/교사 모델 분포 기록.
   *
   * 학습 절차 상세: docs/LORA_TRAINING.md
   *
   * @returns 통계 객체, null = 사용자가 폴더 선택 취소
   */
  public async exportDatasetToSaf(): Promise<{
    exported: number;
    positives: number;
    negatives: number;
    skippedUnlabeled: number;
    skippedLegacyPrompt: number;
    skippedFallbackHeavy: number;
    trainCount: number;
    valCount: number;
  } | null> {
    const samplesAll = await this.readAllSamples();
    const stats = {
      exported: 0,
      positives: 0,
      negatives: 0,
      skippedUnlabeled: 0,
      skippedLegacyPrompt: 0,
      skippedFallbackHeavy: 0,
      trainCount: 0,
      valCount: 0,
    };
    if (samplesAll.length === 0) return stats;

    const events = useEventStore.getState().events;
    const feedbackOf = (eventId: string) => events.find(e => e.id === eventId)?.userFeedback;

    // 게이트 3: eventId별 최신 recordedAt 1건만 (재분석 중복 제거)
    const latestByEvent = new Map<string, TrainingSample>();
    for (const s of samplesAll) {
      const prev = latestByEvent.get(s.eventId);
      if (!prev || s.recordedAt.localeCompare(prev.recordedAt) > 0) {
        latestByEvent.set(s.eventId, s);
      }
    }

    const MAX_FALLBACK_FIELDS = 3;

    // 구 샘플(v3 이전 — fallbackFieldCount 부재)의 소급 폴백 계수:
    // `?? 0`으로 전부 통과시키면 placeholder 오염 샘플이 걸러지지 않아
    // 게이트가 무력해진다. 정규화 전용 폴백 상수(프롬프트가 모델에게
    // 지시한 적 없는 문구만 — '관찰되지 않음'/'판단 불가'는 프롬프트
    // 지시 응답이라 제외)를 대조해 소급 산출한다.
    const NORMALIZE_ONLY_PLACEHOLDERS = new Set([
      '상황 추정 불가', '환경 분석 불가', '증상 상세 정보 없음',
      '권장사항 없음', '제안 없음',
    ]);
    const retroFallbackCount = (o: GeminiTicAnalysis): number => {
      const fields = [
        o.situation, o.environment, o.ticDetail,
        o.recommendation, o.competingResponse,
      ];
      let n = fields.filter(v => NORMALIZE_ONLY_PLACEHOLDERS.has(v)).length;
      if (!Array.isArray(o.triggers) || o.triggers.length === 0) n++;
      return n;
    };
    const fallbackCountOf = (s: TrainingSample): number =>
      typeof s.fallbackFieldCount === 'number'
        ? s.fallbackFieldCount
        : retroFallbackCount(s.normalizedOutput);

    interface ExportRow {
      eventTimestamp: string;
      line: string;
    }
    const rows: ExportRow[] = [];

    for (const s of latestByEvent.values()) {
      // 게이트 4: 현행 프롬프트 세대만
      if ((s.promptVersion ?? 1) !== GEMINI_PROMPT_VERSION) {
        stats.skippedLegacyPrompt++;
        continue;
      }

      const feedback = feedbackOf(s.eventId);
      // 게이트 1: 라벨 없는 샘플은 내보내지 않는다
      if (!feedback) {
        stats.skippedUnlabeled++;
        continue;
      }

      const isNegative = feedback === 'false_positive';

      // 게이트 5: 폴백 과다 샘플 제외 (positive만 — negative 타깃은
      // 어차피 {"isTic": false}라 교사 응답 품질과 무관)
      if (!isNegative && fallbackCountOf(s) > MAX_FALLBACK_FIELDS) {
        stats.skippedFallbackHeavy++;
        continue;
      }

      // 게이트 6: system/user 분해 (v3 기록값 우선, 구 샘플은 소급 분해)
      let system = s.promptStatic ?? '';
      let user = s.promptDynamic ?? '';
      if (!user) {
        const idx = s.prompt.indexOf(PROMPT_SPLIT_MARKER);
        if (idx > 0) {
          system = s.prompt.slice(0, idx).trim();
          user = s.prompt.slice(idx).trim();
        } else {
          system = '';
          user = s.prompt;
        }
      }

      // 타깃 구성 — 키 순서 고정(isTic 선두): 스키마 균일성(Narrowing)
      let target: string;
      if (isNegative) {
        // 게이트 2: 부정 예시 — "틱 아님"의 유일한 정답 형태
        target = JSON.stringify({ isTic: false });
        stats.negatives++;
      } else {
        const { isTic: _drop, ...rest } = s.normalizedOutput as GeminiTicAnalysis & {
          isTic?: boolean;
        };
        target = JSON.stringify({ isTic: true, ...rest });
        stats.positives++;
      }

      rows.push({
        eventTimestamp: s.eventTimestamp,
        line: JSON.stringify({
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
            { role: 'assistant', content: target },
          ],
          meta: {
            eventId: s.eventId,
            eventTimestamp: s.eventTimestamp,
            detectionConfidence: s.detectionConfidence ?? null,
            teacherModel: s.model,
            promptVersion: s.promptVersion ?? 1,
            media: s.attachedMedia,
            label: feedback,   // 'confirmed' | 'false_positive'
          },
        }),
      });
    }

    stats.exported = rows.length;
    if (rows.length === 0) return stats;

    // 게이트 7: 시간순 정렬 후 최신 20%를 val로 (최소 1건, 5건 미만이면 분할 없음)
    rows.sort((a, b) => a.eventTimestamp.localeCompare(b.eventTimestamp));
    const valCount = rows.length >= 5 ? Math.max(1, Math.floor(rows.length * 0.2)) : 0;
    const trainRows = rows.slice(0, rows.length - valCount);
    const valRows = rows.slice(rows.length - valCount);
    stats.trainCount = trainRows.length;
    stats.valCount = valRows.length;

    const FileSystem = fs();
    const { StorageAccessFramework } = FileSystem;
    const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const writeJsonl = async (name: string, list: ExportRow[]) => {
      if (list.length === 0) return;
      const uri = await StorageAccessFramework.createFileAsync(
        perm.directoryUri,
        name,
        'application/x-ndjson',
      );
      await FileSystem.writeAsStringAsync(uri, list.map(r => r.line).join('\n') + '\n');
    };
    await writeJsonl(`defotic_lora_train_${stamp}.jsonl`, trainRows);
    await writeJsonl(`defotic_lora_val_${stamp}.jsonl`, valRows);

    // 게이트 8: 매니페스트 — 데이터셋 감사 가능성
    const manifestUri = await StorageAccessFramework.createFileAsync(
      perm.directoryUri,
      `defotic_lora_manifest_${stamp}.json`,
      'application/json',
    );
    await FileSystem.writeAsStringAsync(
      manifestUri,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          format: 'openai-messages-jsonl',
          promptVersion: GEMINI_PROMPT_VERSION,
          split: 'time-ordered (newest 20% = val)',
          ...stats,
          note:
            'user 턴 loss 마스킹 권장. 멀티모달 학습 시 meta.eventId로 원본 미디어 조인. ' +
            'negative 타깃은 {"isTic": false} 단일 형태.',
        },
        null,
        2,
      ),
    );

    return stats;
  }

  /** 누적 샘플 수 (설정 화면 등 표시용) */
  public async sampleCount(): Promise<number> {
    return (await this.readAllSamples()).length;
  }
}

export const trainingDataStore = new TrainingDataStoreService();
