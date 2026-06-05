export type TicEventType = 'vocal' | 'motor' | 'complex';

export interface TicEvent {
  id: string;
  timestamp: string; // ISO 8601
  type: TicEventType;
  intensity: number; // 1-10
  context?: string; // e.g., "점심 식사시간", "수업 시간"
  videoPath?: string; // 파일 시스템 절대 경로 (로컬)
  audioPath?: string; // 파일 시스템 절대 경로 (로컬)
  
  transferStatus?: 'pending' | 'receiving' | 'completed' | 'failed';
  transferProgress?: {
    video: number; // 0~100
    audio: number; // 0~100
  };
  // ── Gemini LLM 분석 결과 ──
  aiAnalysis?: {
    situation: string;           // "점심 식사 중, 학교 급식실에서..."
    environment: string;         // "소음이 많은 환경, 또래 친구들과 함께..."
    ticDetail: string;           // "좌측 어깨를 반복적으로 으쓱하는 운동 틱..."
    triggers: string[];          // ["사회적 긴장", "소음"]
    recommendation: string;      // "CBIT 경쟁반응 훈련: 양손을 무릎 위에..."
    severity: 'low' | 'medium' | 'high';
    confidence: number;          // 0.0 ~ 1.0
  };
  analysisStatus?: 'pending' | 'analyzing' | 'completed' | 'failed';
}

export interface TicSession {
  id: string;
  startTime: string;
  endTime?: string;
  events: TicEvent[];
}
