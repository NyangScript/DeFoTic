export const GEMINI_CONFIG = {
  // TODO: 프로덕션 배포 시 서버를 경유하도록 변경해야 합니다.
  // 현재는 프로토타입 단계이므로 클라이언트에서 직접 호출합니다.
  API_KEY: 'AIzaSyATizadBNZUFZ8HhkCXcYdQhsQGNnerdpo', 
  MODEL: 'gemini-2.5-flash',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',
  
  PROMPT_TEMPLATE: `당신은 틱장애(투렛 증후군) 전문 분석 AI입니다.
첨부된 영상/음성(틱 발생 직전 상황 포함)을 최우선 근거로 분석하세요.
틱의 유형, 강도, 트리거, 상황 맥락에 대한 임상적 판단은 모두 당신의 몫입니다.
다음 항목을 JSON 형식으로 응답하세요:
- ticType: 'vocal'(음성) 또는 'motor'(운동) 또는 'complex'(복합)
- situation: 상황 맥락 (환자의 활동, 시간대, 장소 추정)
- environment: 환경 분석 (소음, 사람 수, 스트레스 요인)
- ticDetail: 틱 증상 상세 설명 (양상, 반복성, 지속성 포함)
- triggers: 추정 트리거 요인 배열
- recommendation: CBIT 치료 관점의 대응 권장사항
- severity: 틱 강도 판단 — 'low' 또는 'medium' 또는 'high'
- confidence: 분석 신뢰도 (0.0~1.0 숫자)

[틱 이벤트 메타데이터]
- 발생 시간: {timestamp}
- 온디바이스 AI 감지 신뢰도: {confidence}
- 상황 메모: {context}

결과는 반드시 마크다운 코드 블록 없는 순수 JSON 문자열로 반환하세요.`,
};
