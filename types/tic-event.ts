export type TicEventType = 'vocal' | 'motor' | 'complex';

export interface TicEvent {
  id: string;
  timestamp: string; // ISO 8601
  type: TicEventType;
  intensity: number; // 1-10
  context?: string; // e.g., "점심 식사시간", "수업 시간"
  videoPath?: string; // 파일 시스템 절대 경로 (로컬)
  audioPath?: string; // 파일 시스템 절대 경로 (로컬)

  // 하드웨어 AI 감지 confidence (BLE tic_event 메타데이터)
  // 강도·트리거·상황 맥락 등 임상적 판단은 LLM 분석(aiAnalysis)이 전담한다.
  detectionConfidence?: number; // 0.0 ~ 1.0

  // 투트랙 동기화 상태:
  //  - pending_media: BLE 메타데이터만 수신, 미디어는 기기 SD에 있음 (C-to-C 동기화 대기)
  //  - synced: C-to-C Import로 미디어 매핑 완료
  //  - no_media: 기기가 미디어 없이 감지만 기록한 이벤트 (MSC 세션 중 감지,
  //    SD 부재 등 — 펌웨어 tic_event의 media:false). 동기화 대기를 걸지 않는다.
  transferStatus?: 'pending_media' | 'synced' | 'no_media';

  // 틱 발생 직전 실사 스냅샷 (펌웨어 <eventId>_thumb.jpg, QQVGA) —
  // C-to-C Import로 로컬 복사된 절대 경로. 카드/상세 뷰어의 즉시 확인용.
  thumbPath?: string;

  // ── Gemini LLM 분석 결과 ──
  // CBIT(포괄적 행동 중재)의 기능 평가(ABC) 구조에 맞춘 스키마:
  //   A(선행 요인) = situation/environment/triggers/antecedent
  //   B(행동)      = ticDetail + premonitorySigns(전구 신호)
  //   C(후속 결과) = consequences (주변 반응 — 틱을 강화하는 요인 추적)
  // premonitorySigns~consequences는 프롬프트 v2에서 추가된 필드로,
  // 이전 버전 분석 레코드에는 없을 수 있어 전부 optional이다.
  aiAnalysis?: {
    situation: string;           // "점심 식사 중, 학교 급식실에서..."
    environment: string;         // "소음이 많은 환경, 또래 친구들과 함께..."
    ticDetail: string;           // "좌측 어깨를 반복적으로 으쓱하는 운동 틱..."
    triggers: string[];          // ["사회적 긴장", "소음"]
    recommendation: string;      // "CBIT 경쟁반응 훈련: 양손을 무릎 위에..."
    severity: 'low' | 'medium' | 'high';
    confidence: number;          // 0.0 ~ 1.0
    premonitorySigns?: string;   // 전구 신호 관찰 (틱 직전 행동/호흡/자세 변화)
    antecedent?: string;         // 선행 사건 (틱 직전 무슨 일이 있었나 — ABC의 A)
    consequences?: string;       // 후속 결과 (틱 이후 주변 반응/본인 행동 — ABC의 C)
    competingResponse?: string;  // 이 틱에 맞춘 경쟁 반응(CR) 훈련 제안 — CBIT 핵심
  };
  analysisStatus?: 'pending' | 'analyzing' | 'completed' | 'failed';

  // 분석 실패 시 사용자에게 보여줄 사유 — API 키 미설정/네트워크/응답
  // 형식 문제를 구분해 안내하기 위한 필드. completed로 전환되면 비워진다.
  analysisError?: string;

  // 오탐/미탐 사용자 피드백 라벨 (기능명세서 1.3.2) —
  // Edge Impulse 재학습과 LoRA 파인튜닝 데이터셋의 지도 라벨로 쓰인다.
  //  - confirmed: 실제 틱이 맞음 (true positive)
  //  - false_positive: 틱이 아님 (오탐)
  userFeedback?: 'confirmed' | 'false_positive';

  // Firestore 업로드 성공 시각 (로컬 북키핑 — 클라우드 문서에는 미포함).
  // 오프라인에서 분석이 완료된 이벤트를 네트워크 복구 후 재동기화하는
  // 판별 기준: completed인데 이 값이 없으면 업로드 대기 상태다.
  cloudSyncedAt?: string;
}

export interface TicSession {
  id: string;
  startTime: string;
  endTime?: string;
  events: TicEvent[];
}
