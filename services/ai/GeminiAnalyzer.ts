import {
  GEMINI_CONFIG,
  GEMINI_PROMPT_VERSION,
  LLM_PROVIDER,
  OPENAI_COMPAT,
  PROMPT_SPLIT_MARKER,
  resolveGeminiApiKey,
} from '../../constants/gemini-config';
import { TicEvent } from '../../types/tic-event';
import { trainingDataStore } from '../data/TrainingDataStore';

/**
 * Gemini 응답의 엄격한 스키마 (Narrowing).
 * 분석 파이프라인과 LoRA 학습 데이터 추출이 공유하는 단일 기준 타입 —
 * 프롬프트(v2)가 요구하는 JSON 형식과 1:1로 대응한다.
 *
 * CBIT 기능 평가(ABC) 필드 4종을 포함해 모든 필드가 필수다(정규화가
 * 기본값을 채움) — 학습 타깃 스키마의 균일성을 지킨다.
 * (TicEvent.aiAnalysis 쪽은 구버전 레코드 호환을 위해 optional)
 */
export interface GeminiTicAnalysis {
  // '틱 아님' 판정 채널. 현행(v2) 프롬프트는 이 값을 내지 않으므로
  // 정규화가 항상 true를 채운다 — 런타임 거동에 영향 없음. 이후 프롬프트
  // 버전(또는 파인튜닝된 로컬 모델)이 false를 반환할 수 있게 스키마를
  // 선행 확보하고, LoRA 내보내기의 부정 예시({"isTic": false}) 타깃과
  // 스키마를 공유한다.
  isTic: boolean;
  ticType: 'vocal' | 'motor' | 'complex';
  situation: string;
  environment: string;
  ticDetail: string;
  premonitorySigns: string;    // 전구 신호 관찰 (B 직전 조짐)
  antecedent: string;          // 선행 사건 (A)
  consequences: string;        // 후속 결과 (C)
  triggers: string[];
  recommendation: string;
  competingResponse: string;   // 경쟁 반응(CR) 훈련 제안 — CBIT 핵심 기법
  severity: 'low' | 'medium' | 'high';
  confidence: number; // 0.0 ~ 1.0
}

/**
 * 코드값 필드의 동의어 정규화:
 * 프롬프트가 "모든 문자열은 한국어"를 강제하므로 모델이 코드값 필드까지
 * '운동'/'높음'/'Motor'처럼 반환할 위험이 있다 — 대소문자와
 * 한국어 동의어를 표준 코드값으로 흡수한 뒤에만 폴백을 적용한다.
 */
function normalizeTicType(
  v: unknown,
  fallback: 'vocal' | 'motor' | 'complex',
  onFallback?: () => void,
): 'vocal' | 'motor' | 'complex' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'vocal' || s.includes('음성')) return 'vocal';
  if (s === 'motor' || s.includes('운동')) return 'motor';
  if (s === 'complex' || s.includes('복합')) return 'complex';
  onFallback?.();
  return fallback;
}

function normalizeSeverity(v: unknown, onFallback?: () => void): 'low' | 'medium' | 'high' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'low' || s.includes('낮')) return 'low';
  if (s === 'high' || s.includes('높')) return 'high';
  if (s === 'medium' || s.includes('보통') || s.includes('중간')) return 'medium';
  onFallback?.();
  return 'medium';
}

/**
 * 임의의 파싱 결과를 GeminiTicAnalysis로 정규화한다.
 * 필드 누락/형식 이탈은 보수적 기본값으로 흡수 — LLM 응답 변동성에 대한
 * 단일 방어 지점이며, 학습 데이터셋의 출력 스키마도 이 함수를 통과한 값만 쓴다.
 *
 * @param ticTypeFallback 형식 이탈 시 채택할 유형 — 재분석 시 기존 확정
 *   판정(event.type)을 넘겨 '운동 틱이 조용히 vocal로 뒤집히는' 회귀를
 *   방지한다. 미지정 시 'vocal' (신규 이벤트 기본값).
 */
export function normalizeGeminiAnalysis(
  parsed: any,
  ticTypeFallback: 'vocal' | 'motor' | 'complex' = 'vocal',
  // 폴백이 채워진 필드 수를 수집 — 교사 응답이 크게 이탈한 샘플
  // (placeholder 위주 '합성 정답')이 학습 데이터셋에 유입되는 것을
  // 내보내기 게이트가 걸러낼 수 있게 한다. 미전달 시 거동 동일.
  outStats?: { fallbackFieldCount: number },
): GeminiTicAnalysis {
  let fallbacks = 0;
  const str = (v: unknown, fallback: string) => {
    if (typeof v === 'string' && v.trim().length > 0) return v;
    fallbacks++;
    return fallback;
  };
  const result: GeminiTicAnalysis = {
    // 현행(v2) 프롬프트는 isTic을 반환하지 않는다 → true 기본값.
    // 명시적 false만 존중 — 이후 프롬프트 버전/로컬 모델의 '틱 아님' 채널.
    isTic: parsed?.isTic !== false,
    ticType: normalizeTicType(parsed?.ticType, ticTypeFallback, () => { fallbacks++; }),
    situation: str(parsed?.situation, '상황 추정 불가'),
    environment: str(parsed?.environment, '환경 분석 불가'),
    ticDetail: str(parsed?.ticDetail, '증상 상세 정보 없음'),
    premonitorySigns: str(parsed?.premonitorySigns, '관찰되지 않음'),
    antecedent: str(parsed?.antecedent, '판단 불가'),
    consequences: str(parsed?.consequences, '판단 불가'),
    triggers: Array.isArray(parsed?.triggers)
      ? parsed.triggers.filter((t: unknown): t is string => typeof t === 'string')
      : [],
    recommendation: str(parsed?.recommendation, '권장사항 없음'),
    competingResponse: str(parsed?.competingResponse, '제안 없음'),
    severity: normalizeSeverity(parsed?.severity, () => { fallbacks++; }),
    confidence:
      typeof parsed?.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : (fallbacks++, 0.5),
  };
  if (!Array.isArray(parsed?.triggers)) fallbacks++;
  if (outStats) outStats.fallbackFieldCount = fallbacks;
  return result;
}

/** 마크다운 코드 블록으로 감싸져 온 JSON을 벗겨낸다 */
function stripCodeFence(text: string): string {
  let clean = text.trim();
  if (clean.startsWith('```json')) {
    clean = clean.replace(/```json\n?/, '').replace(/```\n?$/, '');
  } else if (clean.startsWith('```')) {
    clean = clean.replace(/```\n?/, '').replace(/```\n?$/, '');
  }
  return clean;
}

/**
 * 프롬프트를 system(상수 지시부)/user(가변 메타데이터부)로 분해한다.
 * 마커가 없으면(비표준 템플릿) 전체를 user로 취급 — 안전 폴백.
 * LoRA 학습 데이터(exportDatasetToSaf)와 openai-compat 서빙이 같은 분해를
 * 공유해야 학습/추론 메시지 구조가 일치한다.
 */
export function splitPromptForChat(fullPrompt: string): { system: string; user: string } {
  const idx = fullPrompt.indexOf(PROMPT_SPLIT_MARKER);
  if (idx <= 0) return { system: '', user: fullPrompt };
  return {
    system: fullPrompt.slice(0, idx).trim(),
    user: fullPrompt.slice(idx).trim(),
  };
}

/** 프로바이더 중립 미디어 파트 (첨부 순서 = 오디오 → 비디오) */
interface LlmMediaPart {
  mimeType: string;
  dataB64: string;
}

export class GeminiAnalyzerService {
  /**
   * ── LLM 전송 어댑터 — vLLM 마이그레이션의 단일 교체 지점 ──
   * 프로바이더 전용 요청/응답 형식은 이 함수 밖으로 새지 않는다.
   * 반환값은 항상 "모델의 텍스트 응답" — 호출자는 프로바이더를 모른다.
   * 전환 방법: constants/gemini-config.ts의 LLM_PROVIDER/OPENAI_COMPAT 참조.
   */
  private async callLlm(
    prompt: string,
    mediaParts: LlmMediaPart[],
    apiKey: string,
  ): Promise<string> {
    let url: string;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: any;

    if (LLM_PROVIDER === 'gemini') {
      // Gemini 형식: parts = [비디오, 오디오, 텍스트] (미디어가 텍스트 앞 —
      // 기존 동작 그대로. mediaParts는 [오디오, 비디오] 첨부 순서이므로
      // 역순 배치가 종전 unshift 결과와 동일하다)
      const parts: any[] = [
        ...[...mediaParts].reverse().map(m => ({
          inlineData: { mimeType: m.mimeType, data: m.dataB64 },
        })),
        { text: prompt },
      ];
      body = {
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json' },
      };
      url = `${GEMINI_CONFIG.ENDPOINT}/${GEMINI_CONFIG.MODEL}:generateContent?key=${apiKey}`;
    } else {
      // OpenAI 호환(vLLM 등) 형식: 학습 데이터(exportDatasetToSaf)와 동일한
      // system/user 분해를 사용해 학습·추론 메시지 구조를 일치시킨다.
      const { system, user } = splitPromptForChat(prompt);
      const content: any[] = [];
      let skippedVideo = false;
      for (const m of mediaParts) {
        if (m.mimeType.startsWith('audio/')) {
          // 수동 조정 지점: OpenAI 호환 오디오 파트 형식은 서버/모델에
          //   따라 다르다 (vLLM 멀티모달은 모델별 프로세서 요구가 상이).
          //   기본은 OpenAI input_audio 규격 — 기기 WAV는 IMA ADPCM이므로
          //   모델이 거부하면 services/media/ImaAdpcm.decodeDeviceWav로
          //   PCM 변환 후 첨부하도록 바꿀 것.
          content.push({
            type: 'input_audio',
            input_audio: { data: m.dataB64, format: 'wav' },
          });
        } else {
          // MJPEG AVI는 오픈 모델이 직접 소화하지 못한다 — 프레임 추출
          // (services/media/AviIndex.ts → JPEG → image_url data URI) 전처리를
          // 붙이기 전까지는 생략하고, 생략 사실을 프롬프트에 명시해 모델이
          // 없는 근거를 날조하지 않게 한다.
          skippedVideo = true;
        }
      }
      content.push({
        type: 'text',
        text: skippedVideo
          ? `${user}\n\n[참고] 영상 첨부는 이 모델 구성에서 생략되었습니다 — 음성만 근거로 분석하세요.`
          : user,
      });
      body = {
        model: OPENAI_COMPAT.MODEL,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content },
        ],
        response_format: { type: 'json_object' },
      };
      url = `${OPENAI_COMPAT.ENDPOINT.replace(/\/$/, '')}/chat/completions`;
      if (OPENAI_COMPAT.API_KEY) headers.Authorization = `Bearer ${OPENAI_COMPAT.API_KEY}`;
    }

    // 타임아웃 필수: fetch는 기본 타임아웃이 없어 네트워크가 걸리면
    //   analysisStatus가 '분석 중'에 영구 고정되고, isAnalyzing 가드가
    //   재시도까지 막는다. 대용량 미디어 업로드를 감안해 120초 상한.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // 본문이 JSON이 아닐 수도 있다(게이트웨이 오류 등) — 파싱 실패가
      // 원래의 HTTP 오류를 가리지 않게 방어한다.
      let apiMessage = response.statusText;
      try {
        const errorData = await response.json();
        apiMessage = errorData.error?.message || apiMessage;
      } catch { /* 본문 무시 */ }
      throw new Error(`LLM API 오류 (HTTP ${response.status}): ${apiMessage}`);
    }

    const data = await response.json();
    const textResponse =
      LLM_PROVIDER === 'gemini'
        ? data.candidates?.[0]?.content?.parts?.[0]?.text
        : data.choices?.[0]?.message?.content;

    if (!textResponse) {
      throw new Error('LLM 응답에 분석 텍스트가 없습니다. (미디어 형식 거부 가능성)');
    }
    return textResponse;
  }

  /**
   * 틱 이벤트를 LLM으로 전송하여 상황을 분석합니다.
   * throw하지 않습니다 — 실패 시 analysisStatus='failed'와 사람이 읽을 수
   * 있는 analysisError(원인 분류)를 담아 반환합니다.
   */
  public async analyzeTicEvent(event: TicEvent): Promise<TicEvent> {
    const startedAt = Date.now();
    let prompt = '';

    try {
      // ── 0. API 키 확인 ──
      // 키 미설정은 네트워크 오류와 전혀 다른 조치(사용자 설정)가 필요하므로
      // 요청 전에 구분해서 실패시킨다. (openai-compat 로컬 서버는 키가
      // 선택 사항 — ENDPOINT 미설정만 검사한다)
      const apiKey = LLM_PROVIDER === 'gemini' ? resolveGeminiApiKey() : OPENAI_COMPAT.API_KEY;
      if (LLM_PROVIDER === 'gemini' && !apiKey) {
        return {
          ...event,
          analysisStatus: 'failed',
          analysisError:
            'Gemini API 키가 설정되지 않았습니다. constants/gemini-config.ts의 API_KEY를 채우거나 EXPO_PUBLIC_GEMINI_API_KEY 환경변수를 설정해주세요.',
        };
      }
      if (LLM_PROVIDER === 'openai-compat' && !OPENAI_COMPAT.ENDPOINT) {
        return {
          ...event,
          analysisStatus: 'failed',
          analysisError:
            '로컬 LLM 엔드포인트가 설정되지 않았습니다. constants/gemini-config.ts의 OPENAI_COMPAT.ENDPOINT를 채워주세요.',
        };
      }

      prompt = GEMINI_CONFIG.PROMPT_TEMPLATE
        .replace('{timestamp}', new Date(event.timestamp).toLocaleString('ko-KR'))
        .replace('{confidence}', typeof event.detectionConfidence === 'number' ? `${Math.round(event.detectionConfidence * 100)}%` : '정보 없음')
        .replace('{context}', event.context || '정보 없음');

      const mediaParts: LlmMediaPart[] = [];
      const attachedMedia: { mimeType: string; sizeBytes: number }[] = [];

      // 합본(muxing) 없이 영상과 음성을 별도 파트로 첨부한다.
      // Gemini inline 요청은 총 ~20MB 제한이므로 base64 팽창(×4/3)을 감안해
      // 원본 합산 14MB 예산 내에서만 첨부한다. 예산 초과 파일은 건너뛰어
      // 요청 전체가 400으로 실패하는 것을 방지한다.
      // (음성 틱이 핵심 근거이므로 용량이 작은 오디오를 우선 첨부)
      const FileSystem = require('expo-file-system/legacy');
      const INLINE_BUDGET_BYTES = 14 * 1024 * 1024;
      let usedBytes = 0;

      const attachMedia = async (path: string, mimeType: string) => {
        try {
          const info = await FileSystem.getInfoAsync(path);
          const size = info.exists && typeof info.size === 'number' ? info.size : 0;
          if (size === 0) {
            console.warn(`[Gemini] Skipping ${mimeType} — file missing or empty: ${path}`);
            return;
          }
          if (usedBytes + size > INLINE_BUDGET_BYTES) {
            console.warn(`[Gemini] Skipping ${mimeType} (${(size / 1e6).toFixed(1)}MB) — inline budget exceeded`);
            return;
          }
          const data = await FileSystem.readAsStringAsync(path, {
            encoding: 'base64',
          });
          mediaParts.push({ mimeType, dataB64: data });
          attachedMedia.push({ mimeType, sizeBytes: size });
          usedBytes += size;
        } catch (e) {
          console.error(`[Gemini] Failed to attach ${mimeType}:`, e);
        }
      };

      if (event.audioPath) await attachMedia(event.audioPath, 'audio/wav');   // IMA ADPCM WAV
      if (event.videoPath) await attachMedia(event.videoPath, 'video/avi');   // MJPEG AVI

      // 미디어 0건이면 분석하지 않는다:
      //   첨부가 전부 실패(파일 소실/0바이트/예산 초과)한 채 텍스트
      //   프롬프트만 보내면 모델이 근거 없이 그럴듯한 분석을 '날조'하고,
      //   그 결과가 completed로 확정되어 LoRA 학습 데이터까지 오염된다.
      //   근거 미디어 없는 분석은 임상적으로도 무가치 — 명확히 실패시킨다.
      if (attachedMedia.length === 0) {
        return {
          ...event,
          analysisStatus: 'failed',
          analysisError:
            '분석에 첨부할 수 있는 미디어가 없습니다. 파일이 비어 있거나 삭제되었을 수 있습니다 — C-to-C 동기화를 다시 실행해주세요.',
        };
      }

      // ── LLM 호출 (프로바이더 어댑터 — vLLM 마이그레이션 지점) ──
      // 요청/응답의 프로바이더 전용 형식은 callLlm 안에 완전히 격리된다.
      // 응답 텍스트 → stripCodeFence → JSON.parse → normalize 계약은
      // 프로바이더와 무관하게 동일하다.
      const textResponse = await this.callLlm(prompt, mediaParts, apiKey ?? '');

      const parsedAnalysis = JSON.parse(stripCodeFence(textResponse));
      // ticType 폴백 = 기존 판정: 형식 이탈 응답이 확정된 운동/복합 틱을
      // 'vocal'로 조용히 뒤집어 LoRA 라벨까지 오염시키는 회귀 방지
      const normStats = { fallbackFieldCount: 0 };
      const analysis = normalizeGeminiAnalysis(parsedAnalysis, event.type, normStats);

      // ── LoRA 파인튜닝 학습 데이터 수집 훅 (실패해도 분석 결과에 무영향) ──
      const chatSplit = splitPromptForChat(prompt);
      trainingDataStore
        .recordAnalysis({
          eventId: event.id,
          eventTimestamp: event.timestamp,
          detectionConfidence: event.detectionConfidence,
          prompt,
          // system/user 분해를 함께 기록 — 내보내기의 소급 분해 의존 제거
          promptStatic: chatSplit.system,
          promptDynamic: chatSplit.user,
          promptVersion: GEMINI_PROMPT_VERSION,
          attachedMedia,
          model: LLM_PROVIDER === 'gemini' ? GEMINI_CONFIG.MODEL : OPENAI_COMPAT.MODEL,
          rawResponse: textResponse,
          normalizedOutput: analysis,
          // 폴백 주입 필드 수 — placeholder 위주 '합성 정답' 샘플을
          // 내보내기 게이트가 걸러내는 기준
          fallbackFieldCount: normStats.fallbackFieldCount,
          latencyMs: Date.now() - startedAt,
        })
        .catch(e => console.warn('[Training] Failed to record sample:', e));

      return {
        ...event,
        // 틱 유형 분류도 LLM 판단을 채택
        type: analysis.ticType,
        aiAnalysis: {
          situation: analysis.situation,
          environment: analysis.environment,
          ticDetail: analysis.ticDetail,
          triggers: analysis.triggers,
          recommendation: analysis.recommendation,
          severity: analysis.severity,
          confidence: analysis.confidence,
          premonitorySigns: analysis.premonitorySigns,
          antecedent: analysis.antecedent,
          consequences: analysis.consequences,
          competingResponse: analysis.competingResponse,
        },
        analysisStatus: 'completed',
        analysisError: undefined,
      };
    } catch (error: any) {
      console.error('Gemini Analysis Failed:', error);

      // 실패 원인 분류 — 사용자가 다음 행동(재시도/키 설정/네트워크 점검)을
      // 판단할 수 있는 문구로 변환한다.
      let reason: string;
      if (error?.name === 'AbortError') {
        reason = '분석 요청이 120초를 초과했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.';
      } else if (error instanceof SyntaxError) {
        reason = 'AI 응답을 해석하지 못했습니다. 다시 시도해주세요.';
      } else if (typeof error?.message === 'string' && error.message.length > 0) {
        reason = error.message;
      } else {
        reason = '알 수 없는 오류로 분석에 실패했습니다.';
      }

      return {
        ...event,
        analysisStatus: 'failed',
        analysisError: reason,
      };
    }
  }
}

export const geminiAnalyzer = new GeminiAnalyzerService();
