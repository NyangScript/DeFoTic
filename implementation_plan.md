# DeFoTic — 라이트 퍼플 테마 + BLE→영상→Gemini LLM 분석 파이프라인 구현

## 개요

두 가지 핵심 작업을 진행합니다:
1. **Part A**: Figma 디자인에 맞춰 **라이트 퍼플 그래디언트** 테마로 전환
2. **Part B**: BLE 하드웨어 연동 → 영상 수신 → **Gemini API로 상황 분석** → 데이터 분석 화면에 실시간 반영

---

## User Review Required

> [!IMPORTANT]
> **Gemini API 키 보안**: 제공해주신 API 키(`AIzaSyATiz...`)를 앱 코드에 직접 내장합니다. 프로토타입 단계에서는 이렇게 진행하되, **프로덕션 배포 시에는 반드시 서버 프록시(Firebase Cloud Functions 등)를 통해 키를 숨겨야** 합니다. 현재는 개발 편의를 위해 직접 REST API를 호출하는 구조로 설계합니다.

> [!WARNING]
> **BLE 영상 전송 방식**: ESP32-S3에서 촬영된 영상(±6분 클립)은 BLE의 MTU 제한(~512바이트) 때문에 대용량 영상 파일을 직접 BLE로 전송하기 어렵습니다. 현실적인 구현 방안:
> - **방안 1 (권장)**: ESP32-S3가 틱 감지 시 **메타데이터(타임스탬프, 유형, 강도)**만 BLE Notify로 전송 → 앱이 수신하면 해당 이벤트를 기록하고, 영상 파일은 **Wi-Fi 또는 SD카드 동기화**로 별도 전송
> - **방안 2**: BLE를 통한 청크 단위 바이너리 전송 (느리지만 가능)
> 
> 본 계획에서는 **방안 1**을 기본으로, ESP32-S3에서 BLE Characteristic Notify로 틱 이벤트 메타데이터(JSON)를 수신하고, 영상은 로컬 파일시스템/클라우드에서 가져오는 구조로 설계합니다. 실제 영상이 없을 경우 Gemini에게 텍스트 기반 상황 분석을 요청합니다.

> [!IMPORTANT]
> **ESP32-S3 데이터 프로토콜 확인 필요**: 현재 ESP32-S3 펌웨어가 BLE Characteristic(`beb5483e-36e1-4688-b7f5-ea07361b26a8`)으로 어떤 형식의 데이터를 전송하는지 확인이 필요합니다. 본 계획에서는 아래 JSON 형식을 가정합니다:
> ```json
> {
>   "type": "tic_event",
>   "tic_type": "vocal",
>   "intensity": 7,
>   "timestamp": 1716883200,
>   "has_video": true,
>   "video_size": 2048000
> }
> ```
> 실제 펌웨어 프로토콜이 다를 경우, 파서 부분만 수정하면 됩니다.

---

## Part A: 라이트 퍼플 그래디언트 테마 전환

### 디자인 방향 (Figma 와이어프레임 기반)

Figma 디자인을 분석한 결과:
- **배경**: 짙은 남색(#0D0B1A) ❌ → **라이트 퍼플 그래디언트** ✅ (연보라~라벤더)
- **카드**: 불투명 글래스 → **반투명 화이트 글래스모피즘** (연보라 틴트)
- **버튼**: 단색 퍼플 → **퍼플~핑크 그래디언트**
- **텍스트**: 순백색 → **다크 퍼플 / 화이트 혼합**
- **전체 톤**: Dark Mode 느낌 제거 → **밝고 부드러운 라벤더 톤**

### 신규 컬러 팔레트

| 용도 | 현재 | 변경 후 |
|---|---|---|
| **Background** | `#0D0B1A` (Dark Navy) | 그래디언트: `#E8D5F5` → `#C4A6E0` → `#A78BCA` |
| **Surface** | `rgba(123,47,190,0.15)` | `rgba(255,255,255,0.45)` (밝은 글래스) |
| **Surface Solid** | `#1C1530` | `#D8C2EC` (라이트 라벤더) |
| **Primary** | `#7B2FBE` | `#9B59D0` (소프트 퍼플) |
| **Primary Light** | `#B47AEA` | `#C084F5` (브라이트 라벤더) |
| **Primary Dark** | `#4A1A72` | `#6B3FA0` (미디엄 퍼플) |
| **Accent** | `#E91E8C` | `#D946A8` (소프트 매젠타) |
| **Glass Border** | `rgba(255,255,255,0.1)` | `rgba(255,255,255,0.5)` |
| **Text Primary** | `#FFFFFF` | `#2D1B4E` (다크 퍼플) |
| **Text Secondary** | `#B0B0CC` | `#7B6B8D` (뮤트 퍼플) |
| **Tab Bar BG** | `#1C1530` | `rgba(255,255,255,0.7)` |
| **Header BG** | `#0D0B1A` | 투명 (그래디언트 통합) |

---

### Phase A-1: 테마 및 UI 컴포넌트 업데이트

#### [MODIFY] [theme.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/constants/theme.ts)
- 모든 색상값을 라이트 퍼플 팔레트로 변경
- `gradient` 배열 추가 (배경 그래디언트용)
- `glassSurface` 스타일 추가

#### [NEW] [GradientBackground.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/components/ui/GradientBackground.tsx)
- `expo-linear-gradient` 사용하여 배경 그래디언트 컴포넌트 생성
- 모든 화면에서 `backgroundColor` 대신 이 컴포넌트를 배경으로 사용

#### [MODIFY] [GlassCard.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/components/ui/GlassCard.tsx)
- `surface` 색상 → 밝은 반투명 화이트로 변경

#### [MODIFY] [GradientButton.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/components/ui/GradientButton.tsx)
- 단색 버튼 → `LinearGradient` 기반 퍼플~핑크 그래디언트 버튼

---

### Phase A-2: 모든 화면 배경 및 텍스트 색상 전환

#### [MODIFY] [app/_layout.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/app/_layout.tsx)
- `headerStyle.backgroundColor` → 투명 처리
- `contentStyle.backgroundColor` → 그래디언트 호환 색상

#### [MODIFY] [app/(tabs)/_layout.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/app/%28tabs%29/_layout.tsx)
- Tab bar 배경 → 반투명 화이트
- Active/Inactive 색상 → 다크 퍼플 계열
- `StatusBar` → dark content (밝은 배경이므로)

#### [MODIFY] 모든 화면 파일들
- `app/index.tsx` — 인트로 배경을 그래디언트로 변경
- `app/pairing.tsx` — 그래디언트 배경 적용
- `app/login.tsx` — 입력 필드 스타일을 라이트 테마에 맞게 조정
- `app/(tabs)/index.tsx` — 메인화면 카드 색상 조정
- `app/(tabs)/device.tsx` — 기기 상태 화면 라이트화
- `app/(tabs)/record.tsx` — 차트 색상 라이트 테마 적용
- `app/(tabs)/analysis.tsx` — 분석 화면 라이트화
- `app/doctor/analysis/[patientId].tsx` — 의료진 대시보드 라이트화

#### [MODIFY] [BarChart.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/components/charts/BarChart.tsx)
- 차트 라벨 색상을 라이트 테마에 맞게 조정

---

## Part B: BLE → 영상 → Gemini LLM 분석 파이프라인

### 아키텍처

```
ESP32-S3 (BLE Notify)
    │
    │  Characteristic: beb5483e-36e1-4688-b7f5-ea07361b26a8
    │  데이터: JSON 메타데이터 (틱 유형, 강도, 타임스탬프, 영상 존재 여부)
    ▼
📱 앱 (BleManager → Characteristic 구독)
    │
    │  1. 이벤트 메타데이터 수신 & 파싱
    │  2. 영상 파일이 있으면 로컬 캐시에서 로드 (또는 BLE 청크 수신)
    ▼
🤖 Gemini API (REST — gemini-2.5-flash)
    │
    │  프롬프트: "틱 이벤트 상황 분석" + 메타데이터 (+ 영상 base64, if available)
    │  응답: 상황 맥락, 환경 분석, 틱 유형 상세, 추천 사항
    ▼
📊 데이터 분석 화면 (analysis.tsx)
    │
    │  TicEventCard에 AI 분석 결과 표시
    │  실시간 카드 추가 (새 이벤트 수신 시 자동 갱신)
    ▼
💾 AsyncStorage (로컬 영구 저장)
```

---

### Phase B-1: 타입 시스템 확장

#### [MODIFY] [tic-event.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/types/tic-event.ts)
```typescript
export interface TicEvent {
  id: string;
  timestamp: string;
  type: TicEventType;
  intensity: number;
  context?: string;
  videoClipUrl?: string;
  videoBase64?: string;          // BLE로 수신된 영상 base64 (임시 저장용)
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
```

---

### Phase B-2: Gemini LLM 분석 서비스

#### [NEW] [GeminiAnalyzer.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/services/ai/GeminiAnalyzer.ts)
- Gemini REST API 직접 호출 (React Native에서 `fetch` 사용)
- 모델: `gemini-2.5-flash` (빠른 응답)
- 입력: 틱 이벤트 메타데이터 + (옵션) 영상 base64
- 출력: 구조화된 `aiAnalysis` 객체
- 한국어 프롬프트 설계:
  ```
  당신은 틱장애(투렛 증후군) 전문 분석 AI입니다.
  아래 틱 이벤트 데이터를 분석하고, 다음 항목을 JSON 형식으로 응답하세요:
  - situation: 상황 맥락 (환자의 활동, 시간대, 장소 추정)
  - environment: 환경 분석 (소음, 사람 수, 스트레스 요인)
  - ticDetail: 틱 증상 상세 설명
  - triggers: 추정 트리거 요인 배열
  - recommendation: CBIT 치료 관점의 대응 권장사항
  - severity: low/medium/high
  - confidence: 분석 신뢰도 0.0~1.0
  ```

#### [NEW] [gemini-config.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/constants/gemini-config.ts)
- API 키 및 모델 설정 분리
- 엔드포인트 URL, 모델명, 프롬프트 템플릿

---

### Phase B-3: BLE 실시간 데이터 수신 파이프라인

#### [MODIFY] [BleManager.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/services/ble/BleManager.ts)
- `monitorCharacteristic()` 메서드 추가: 메인 Characteristic(`beb5483e...`)을 구독하여 틱 이벤트 Notify 수신
- Base64 → JSON 디코딩 로직 추가
- 콜백 기반 이벤트 발행: `onTicEventReceived(callback)`

#### [MODIFY] [DeviceSync.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/services/ble/DeviceSync.ts)
- 모의 데이터 제거
- 실제 BLE Notify 이벤트를 받아 → Gemini 분석 요청 → 결과와 함께 TicEventStore에 저장
- 영상 청크 수신 로직 (BLE 바이너리 → base64 조립)

#### [MODIFY] [TicEventStore.ts](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/services/data/TicEventStore.ts)
- `addEvent(event)` 단건 추가 메서드 (기존은 배열)
- `updateEventAnalysis(id, analysis)` — Gemini 분석 완료 시 업데이트
- 이벤트 변경 시 리스너 콜백 지원 (`subscribe/unsubscribe`)

---

### Phase B-4: 분석 화면 실시간 업데이트

#### [MODIFY] [analysis.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/app/%28tabs%29/analysis.tsx)
- 모의 데이터 제거
- `TicEventStore.subscribe()`로 실시간 이벤트 목록 업데이트
- 새 이벤트 수신 시 "AI 분석 중..." 로딩 상태 표시 → 분석 완료 시 카드 업데이트
- 빈 상태 UI: "BLE 기기 연결 후 틱 이벤트가 수신되면 여기에 표시됩니다"

#### [MODIFY] [TicEventCard.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/components/analysis/TicEventCard.tsx)
- `aiAnalysis` 필드 렌더링 추가:
  - 상황 맥락 (situation) 메인 텍스트
  - 환경/트리거 태그 뱃지
  - 심각도 표시 (color-coded)
  - "AI 분석 중..." 스켈레톤 로딩 상태
- 모의 썸네일 → 실제 영상 썸네일 (있을 경우)

#### [MODIFY] [doctor/analysis/[patientId].tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/app/doctor/analysis/%5BpatientId%5D.tsx)
- 모의 데이터 → `TicEventStore`에서 읽기
- AI 분석 결과 상세 표시 (CBIT 치료 권장사항 포함)

---

### Phase B-5: 페어링 화면 → 실제 BLE 연동

#### [MODIFY] [pairing.tsx](file:///c:/Users/user/Desktop/DeFoTic%20React%20Application/app/pairing.tsx)
- 모의 디바이스 목록 → 실제 `bleManager.startScan()` 호출
- 연결 성공 시 → Characteristic 구독 자동 시작
- 연결 실패/타임아웃 시 에러 UI 표시

---

## 의존성 추가

```bash
npx expo install expo-linear-gradient
# @google/genai은 node 전용이므로 직접 REST API fetch를 사용합니다. 별도 패키지 불필요.
```

---

## Proposed Changes Summary

### 수정 파일 (총 16개)

| 파일 | 변경 내용 |
|---|---|
| `constants/theme.ts` | 라이트 퍼플 팔레트 + gradient 정의 |
| `components/ui/GlassCard.tsx` | 밝은 글래스 스타일 |
| `components/ui/GradientButton.tsx` | LinearGradient 버튼 |
| `components/ui/AnimatedProgress.tsx` | 라이트 테마 트랙 색상 |
| `components/ui/StatusBadge.tsx` | 라이트 테마 뱃지 배경 |
| `components/charts/BarChart.tsx` | 라이트 테마 차트 색상 |
| `components/analysis/TicEventCard.tsx` | AI 분석 결과 렌더링 |
| `app/_layout.tsx` | 헤더 투명화 |
| `app/index.tsx` | 그래디언트 배경 인트로 |
| `app/pairing.tsx` | 실제 BLE 스캔 + 그래디언트 |
| `app/login.tsx` | 라이트 테마 입력 폼 |
| `app/(tabs)/_layout.tsx` | 라이트 탭바 |
| `app/(tabs)/index.tsx`, `device.tsx`, `record.tsx`, `analysis.tsx` | 그래디언트 배경 + 실시간 데이터 |
| `app/doctor/analysis/[patientId].tsx` | 실시간 데이터 + AI 분석 |
| `services/ble/BleManager.ts` | Characteristic 모니터링 |
| `services/ble/DeviceSync.ts` | 실데이터 동기화 |
| `services/data/TicEventStore.ts` | subscribe 패턴 |
| `types/tic-event.ts` | AI 분석 필드 확장 |

### 신규 파일 (3개)

| 파일 | 내용 |
|---|---|
| `components/ui/GradientBackground.tsx` | 배경 그래디언트 컴포넌트 |
| `services/ai/GeminiAnalyzer.ts` | Gemini REST API 분석 서비스 |
| `constants/gemini-config.ts` | Gemini API 설정 |

---

## Verification Plan

### Automated Tests
```bash
# TypeScript 타입 검증
npx tsc --noEmit

# 웹 빌드 확인 (의료진 대시보드)
npx expo start --web
```

### Manual Verification
1. **테마 검증**: `npx expo start --web`으로 라이트 퍼플 그래디언트 적용 확인
2. **BLE 연동**: 실제 ESP32-S3 기기 전원 ON → 앱에서 스캔 → 페어링 → 틱 이벤트 Notify 수신 확인
3. **Gemini 분석**: 틱 이벤트 수신 시 → "AI 분석 중..." → 분석 결과 카드 업데이트 확인
4. **데이터 영속성**: 앱 종료 후 재시작 → 이전 분석 결과 유지 확인
