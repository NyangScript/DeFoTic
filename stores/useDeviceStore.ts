import { create } from 'zustand';

export interface DeviceStatusPayload {
  battery: number | null;
  sdUsed: number | null; // Note: Payload schema might have different keys, mapping required
  temperature: number | null;
  camera: boolean;
  microphone: boolean;
  tickCountToday: number;
  // 펌웨어는 millis() 기준 '부팅 후 경과 ms'(숫자)를 보낸다 — 벽시계
  // 시각이 아니므로 UI 표시는 이벤트 스토어 타임스탬프를 쓴다 (미사용)
  lastEventTime: number | null;
  // 실시간 AI abnormal 레벨 (0.0~1.0) — 시리얼 없는 배포 펌웨어에서
  // 모델 생사/문턱 적정성을 진단하는 관측 채널
  aiLevel?: number;
  // C-to-C(USB MSC) 세션 진단 — 시리얼 없이 실패 계층을 판별하는 창구.
  // none: 호스트 미감지(폰에 꽂았는데 none이면 USB 열거 실패)
  // ready: 세션 활성(열거 직후부터 데이터 상시 서비스). 주의:
  //   Android의 실제 볼륨 마운트는 이보다 수 초~수십 초 늦을 수 있어
  //   SAF 접근은 재시도로 감싸야 한다 ('host'는 핸드오프 단계를 두던
  //   구펌웨어의 중간 상태 값 — 하위 호환용으로만 유지)
  usbState?: 'none' | 'host' | 'ready';
  // USB 호스트가 장치를 '구성'까지 마친 상태인지(TinyUSB tud_mounted 원시값).
  // usbState=none인데 usbHost=true면 "전원만 공급하는 호스트(PC/노트북/충전
  // 전용 모드 폰)에 물려 있음" — 세션(녹화 정지)과 구분되는 관측 채널
  usbHost?: boolean;
  // 이번(또는 직전) 세션에 호스트가 실제 읽고/쓴 섹터 수
  usbRd?: number;
  usbWr?: number;
  // SD의 FAT 볼륨 시리얼("XXXX-XXXX") — Android SAF 외장 볼륨 ID와 동일.
  // MediaSyncManager가 폴더 선택창을 DeFoTic 드라이브에서 바로 열 때 사용
  sdUuid?: string;
  // 최근 3초 구간의 마이크 입력 피크(|int16| 최대, 0~32767).
  // 0 지속 = I2S 입력 죽음(하드웨어/드라이버), >0인데 aiLevel 0 = 모델 문제
  micPeak?: number;
  // 마이크 스트림 생사: stall=I2S 드라이버/DMA 정지(코드 문제),
  // silent=스트림은 흐르는데 무음(마이크 하드웨어/데이터 라인), ok=정상
  micState?: 'stall' | 'silent' | 'ok';
  // 마지막 AI 추론 창(1초)의 RMS — 순수 진단 채널로, 판정 게이트로는
  // 쓰지 않는다. abnormal 출력이 창 에너지와 비례하는지 개발 시 대조하는
  // 용도로만 수신·보관하며, 제품 화면에는 표시하지 않는다.
  aiRms?: number;
}

interface DeviceState {
  isConnected: boolean;
  deviceName: string | null;
  battery: number | null;
  sdUsedPercent: number | null;
  temperature: number | null;
  camera: boolean;
  microphone: boolean;
  aiLevel: number | null;
  usbState: 'none' | 'host' | 'ready' | null;
  usbHost: boolean | null;
  usbReadSectors: number | null;
  // BLE 끊김/재연결과 무관하게 유지 — SAF 선택창은 보통 USB 연결 중
  // (BLE는 살아있음)에 열리지만, 혹시 끊겨도 마지막 값을 쓴다
  sdVolumeUuid: string | null;
  micPeak: number | null;
  micState: 'stall' | 'silent' | 'ok' | null;
  aiRms: number | null;
  lastUpdated: number | null;

  updateFromBle: (payload: DeviceStatusPayload) => void;
  setConnected: (name: string) => void;
  setDisconnected: () => void;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  isConnected: false,
  deviceName: null,
  battery: null,
  sdUsedPercent: null,
  temperature: null,
  camera: false,
  microphone: false,
  aiLevel: null,
  usbState: null,
  usbHost: null,
  usbReadSectors: null,
  sdVolumeUuid: null,
  micPeak: null,
  micState: null,
  aiRms: null,
  lastUpdated: null,

  updateFromBle: (payload) => set((state) => ({
    battery: payload.battery ?? state.battery,
    sdUsedPercent: payload.sdUsed ?? state.sdUsedPercent,
    temperature: payload.temperature ?? state.temperature,
    camera: payload.camera ?? state.camera,
    microphone: payload.microphone ?? state.microphone,
    aiLevel: typeof payload.aiLevel === 'number' ? payload.aiLevel : state.aiLevel,
    usbState: payload.usbState ?? state.usbState,
    usbHost: typeof payload.usbHost === 'boolean' ? payload.usbHost : state.usbHost,
    usbReadSectors: typeof payload.usbRd === 'number' ? payload.usbRd : state.usbReadSectors,
    // 빈 문자열(펌웨어 판독 실패)은 무시하고 마지막 유효값 유지
    sdVolumeUuid: payload.sdUuid || state.sdVolumeUuid,
    micPeak: typeof payload.micPeak === 'number' ? payload.micPeak : state.micPeak,
    micState: payload.micState ?? state.micState,
    aiRms: typeof payload.aiRms === 'number' ? payload.aiRms : state.aiRms,
    lastUpdated: Date.now(),
  })),

  setConnected: (name) => set({
    isConnected: true,
    deviceName: name,
  }),

  setDisconnected: () => set({
    isConnected: false,
    deviceName: null,
    battery: null,
    sdUsedPercent: null,
    temperature: null,
    camera: false,
    microphone: false,
    aiLevel: null,
    usbState: null,
    usbHost: null,
    usbReadSectors: null,
    micPeak: null,
    micState: null,
    aiRms: null,
    lastUpdated: null,
  }),
}));
