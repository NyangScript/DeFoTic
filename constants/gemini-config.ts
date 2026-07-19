/**
 * Gemini API 키 해석 — 우선순위:
 *  1. .env의 EXPO_PUBLIC_GEMINI_API_KEY 환경변수 (표준 설정 위치 — 커밋되지 않음)
 *  2. 아래 GEMINI_CONFIG.API_KEY (기본은 빈 값 — 로컬 실험 시에만 임시 사용)
 * 둘 다 비어 있으면 null — 분석 파이프라인이 "키 미설정" 사유로 명확히
 * 실패 처리하고 사용자에게 설정 위치를 안내한다.
 */
export function resolveGeminiApiKey(): string | null {
  const envKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  if (typeof envKey === 'string' && envKey.trim().length > 0) return envKey.trim();
  const configKey = GEMINI_CONFIG.API_KEY;
  if (typeof configKey === 'string' && configKey.trim().length > 0) return configKey.trim();
  return null;
}

/**
 * 프롬프트 템플릿 버전 — 템플릿을 수정할 때마다 반드시 +1 할 것.
 * TrainingDataStore가 샘플마다 이 값을 기록해, LoRA 데이터셋에서
 * 신·구 프롬프트 샘플이 구분 없이 혼재되는 것을 막는다.
 * 현행 v2: 한국어 출력 강제 + CBIT 기능평가(ABC) 필드 4종
 * (premonitorySigns/antecedent/consequences/competingResponse).
 * 버전별 변경 내역과 확장 계획: docs/LLM_MIGRATION.md '프롬프트 버전' 절 참조.
 */
export const GEMINI_PROMPT_VERSION = 2;

/**
 * 프롬프트를 학습용 system(상수 지시부)/user(가변 메타데이터부)로 분해하는
 * 마커 — 이 줄 앞까지가 system, 이 줄부터 끝까지가 user가 된다.
 * 내보내기 시점 소급 분해에 쓰이므로 템플릿에서 이 문자열을 바꾸면
 * 이 상수도 함께 바꿔야 한다.
 */
export const PROMPT_SPLIT_MARKER = '[틱 이벤트 메타데이터]';

/**
 * ── LLM 프로바이더 선택 (vLLM 마이그레이션 지점) ──
 *
 * 'gemini'       : Google Gemini API (현행 기본값)
 * 'openai-compat': OpenAI 호환 서버 — vLLM(OpenAI 호환 모드), llama.cpp
 *                  server, Ollama(/v1) 등. LoRA 파인튜닝된 커스텀 모델을
 *                  띄운 뒤 아래 OPENAI_COMPAT의 ENDPOINT/MODEL만 채우면
 *                  분석 파이프라인 전체가 그대로 동작한다 (응답은 동일하게
 *                  normalizeGeminiAnalysis를 통과 — 이 함수가 계약 지점).
 *
 * 전환 절차 상세: docs/LLM_MIGRATION.md
 */
export const LLM_PROVIDER: 'gemini' | 'openai-compat' = 'gemini';

export const OPENAI_COMPAT = {
  // 예: 'http://192.168.0.10:8000/v1' (vLLM OpenAI 호환 서버)
  ENDPOINT: '',
  // vLLM --lora-modules에서 지정한 모델/어댑터 이름
  MODEL: 'defotic',
  // 로컬 서버는 보통 불필요 — 필요 시 Bearer 토큰
  API_KEY: '',
};

export const GEMINI_CONFIG = {
  // TODO: 프로덕션 배포 시 서버(Firebase Functions 프록시)를 경유하도록
  // 변경해야 합니다. 현재는 프로토타입 단계이므로 클라이언트에서 직접
  // 호출합니다. 키 설정: .env의 EXPO_PUBLIC_GEMINI_API_KEY에 키를 설정
  // (아래 API_KEY보다 우선 적용됩니다)
  API_KEY: '',
  // MODEL: 'gemini-2.5-flash',
  MODEL: 'gemini-3.1-flash-lite',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',

  // ── 프롬프트 v2 (CBIT 기능 평가 구조) ──
  // 설계 근거: 작품설명서(TAA 가이드라인) — CBIT 성공의 핵심은 "빈도·강도·
  // 상황적 선행 요인(전구감각 포함)의 체계적 기록". 이에 맞춰 출력 스키마를
  // 기능 평가(ABC: Antecedent-Behavior-Consequence) + 전구 신호 + 경쟁 반응
  // 제안으로 확장했다. 필드 변경 시 반드시 함께 갱신:
  //  ① GEMINI_PROMPT_VERSION(위) ② GeminiAnalyzer의 GeminiTicAnalysis/
  //  normalizeGeminiAnalysis/RESPONSE_SCHEMA ③ types/tic-event.ts aiAnalysis
  PROMPT_TEMPLATE: `당신은 틱장애(투렛 증후군) 행동치료(CBIT) 전문 분석 AI입니다.
첨부된 영상/음성(틱 발생 직전 상황 포함)을 최우선 근거로 분석하세요.
틱의 유형, 강도, 트리거, 상황 맥락에 대한 임상적 판단은 모두 당신의 몫입니다.

★ 출력 언어 규칙 (절대 준수):
모든 문자열 값은 반드시 자연스러운 한국어로 작성하세요. 영어 단어·문장을
섞지 마세요 (단, ticType/severity의 지정된 영문 코드값은 예외).
의학 용어는 한국어 표준 용어를 사용하되 환자·보호자가 이해할 수 있게 풀어 쓰세요.

다음 항목을 JSON 형식으로 응답하세요:
- ticType: 'vocal'(음성) 또는 'motor'(운동) 또는 'complex'(복합) 중 코드값 하나
- situation: 상황 맥락 (환자의 활동, 시간대, 장소 추정 — 한 문장 요약 후 상세)
- environment: 환경 분석 (소음 수준, 주변 인원, 스트레스 요인)
- ticDetail: 틱 증상 상세 (양상, 반복 횟수, 지속성, 음성틱이면 발성 내용 특성)
- premonitorySigns: 전구 신호 관찰 — 틱 발생 '직전' 영상/음성에서 보이는 조짐
  (호흡 변화, 자세 변화, 목 가다듬기, 말 멈춤 등). 관찰되지 않으면 "관찰되지 않음"
- antecedent: 선행 사건(A) — 틱 직전에 무슨 일이 있었는지 구체적으로
- consequences: 후속 결과(C) — 틱 이후 환자의 행동과 주변 반응
  (틱을 강화할 수 있는 반응인지 포함). 판단 불가 시 "판단 불가"
- triggers: 추정 트리거 요인 배열 (각 2~6글자의 한국어 명사구, 예: "소음", "사회적 긴장")
- recommendation: CBIT 치료 관점의 종합 대응 권장사항
- competingResponse: 이 틱의 양상에 맞춘 경쟁 반응(Competing Response) 훈련 제안 —
  틱과 물리적으로 양립 불가능한 구체적 행동 1~2가지 (CBIT의 핵심 기법)
- severity: 틱 강도 — 'low' 또는 'medium' 또는 'high' 중 코드값 하나
- confidence: 분석 신뢰도 (0.0~1.0 숫자)

[틱 이벤트 메타데이터]
- 발생 시간: {timestamp}
- 온디바이스 AI 감지 신뢰도: {confidence}
- 상황 메모: {context}

결과는 반드시 마크다운 코드 블록 없는 순수 JSON 문자열로 반환하세요.`,
};
