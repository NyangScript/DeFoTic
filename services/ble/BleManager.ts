import { BleManager as PlxBleManager, Device, State, BleError, Characteristic } from 'react-native-ble-plx';
import { BLE_CONFIG } from '../../constants/ble-config';
import { BleDevice } from '../../types/ble';
import { Platform, PermissionsAndroid, AppState, AppStateStatus } from 'react-native';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { EventRepository } from '../data/EventRepository';

export type ScanDeviceCallback = (devices: BleDevice[]) => void;
export type ScanErrorCallback = (error: BleError | string) => void;

const SCAN_RESTART_INTERVAL_MS = 12_000;
const STALE_DEVICE_TIMEOUT_MS  = 15_000;
const STALE_CHECK_INTERVAL_MS  =  3_000;

// 마지막으로 검증(UUID)까지 통과한 기기 주소 — 온보딩 완료 사용자의
// 자동 재연결(silent reconnect) 대상. 페어링 화면을 다시 거치지 않고
// 홈 진입 시 백그라운드로 1회 연결을 시도한다.
const LAST_DEVICE_KEY = '@defotic_last_device';

class BleManagerService {
  private manager: PlxBleManager | null = null;
  private connectedDevice: Device | null = null;
  private isScanning: boolean = false;

  private discoveredDevices: Map<string, BleDevice> = new Map();
  private scanDeviceCallback: ScanDeviceCallback | null = null;
  private scanErrorCallback: ScanErrorCallback | null = null;
  private scanRestartTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: any = null;
  private stateChangeSubscription: any = null;
  private isContinuousScanActive: boolean = false;

  constructor() {
    if (Platform.OS !== 'web') {
      this.manager = new PlxBleManager();
    }
  }

  public async requestPermissions(): Promise<boolean> {
    if (Platform.OS === 'android') {
      if (Platform.Version >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return (
          result['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
          result['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    }
    return true;
  }

  public async startContinuousScan(
    onDevicesUpdate: ScanDeviceCallback,
    onError?: ScanErrorCallback
  ) {
    if (!this.manager) return;

    this.scanDeviceCallback = onDevicesUpdate;
    this.scanErrorCallback = onError || null;
    this.isContinuousScanActive = true;

    const hasPermission = await this.requestPermissions();
    if (!hasPermission) {
      if (this.scanErrorCallback) this.scanErrorCallback('블루투스 권한이 거부되었습니다. 설정에서 권한을 허용해주세요.');
      return;
    }

    // AppState 리스너는 상태 분기 '이전'에 등록한다: 블루투스 OFF →
    // onStateChange 경유로 스캔이 재기동되는 경로에서도 리스너가 있어야
    // 앱이 백그라운드로 갈 때 12초 주기 스캔이 멈춘다 — 없으면 백그라운드
    // 스캔이 영구 지속되는 배터리 누수가 된다. (중복 등록 방지 가드 포함)
    if (!this.appStateSubscription) {
      this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
    }

    const state = await this.manager.state();
    if (state !== State.PoweredOn) {
      // onStateChange 구독 핸들을 보관해 stop 시 해제한다 (구독 누수 방지)
      if (this.stateChangeSubscription) this.stateChangeSubscription.remove();
      this.stateChangeSubscription = this.manager.onStateChange((newState) => {
        if (newState === State.PoweredOn && this.isContinuousScanActive) {
          if (this.stateChangeSubscription) {
            this.stateChangeSubscription.remove();
            this.stateChangeSubscription = null;
          }
          this.beginScanCycle();
        }
      }, true);
      if (this.scanErrorCallback) this.scanErrorCallback('블루투스가 꺼져있습니다. 기기의 블루투스를 켜주세요.');
      return;
    }

    this.beginScanCycle();
  }

  public stopContinuousScan() {
    this.isContinuousScanActive = false;
    this.stopScanInternal();

    if (this.scanRestartTimer) {
      clearInterval(this.scanRestartTimer);
      this.scanRestartTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    if (this.stateChangeSubscription) {
      this.stateChangeSubscription.remove();
      this.stateChangeSubscription = null;
    }

    this.discoveredDevices.clear();
    this.scanDeviceCallback = null;
    this.scanErrorCallback = null;
  }

  private handleAppStateChange = (nextAppState: AppStateStatus) => {
    if (nextAppState === 'active' && this.isContinuousScanActive) {
      this.beginScanCycle();
    } else if (nextAppState === 'background') {
      this.stopScanInternal();
      if (this.scanRestartTimer) {
        clearInterval(this.scanRestartTimer);
        this.scanRestartTimer = null;
      }
      if (this.staleCheckTimer) {
        clearInterval(this.staleCheckTimer);
        this.staleCheckTimer = null;
      }
    }
  };

  private beginScanCycle() {
    if (this.isScanning) return;

    this.startScanRound();

    if (this.scanRestartTimer) clearInterval(this.scanRestartTimer);
    this.scanRestartTimer = setInterval(() => {
      this.stopScanInternal();
      setTimeout(() => {
        if (this.isContinuousScanActive) {
          this.startScanRound();
        }
      }, 200);
    }, SCAN_RESTART_INTERVAL_MS);

    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    this.staleCheckTimer = setInterval(() => {
      this.evictStaleDevices();
    }, STALE_CHECK_INTERVAL_MS);
  }

  private startScanRound() {
    if (!this.manager || this.isScanning) return;

    this.isScanning = true;

    // serviceUUIDs: null → 모든 기기 수신 (필터링은 handleDeviceDiscovery에서)
    // scanMode: 2 = LOW_LATENCY (가장 빠른 스캔)
    this.manager.startDeviceScan(
      null,
      { allowDuplicates: true, scanMode: 2 },
      (error, device) => {
        if (error) {
          console.error('BLE Scan Error:', error);
          this.isScanning = false;
          if (this.isContinuousScanActive) {
            setTimeout(() => this.startScanRound(), 1000);
          }
          return;
        }

        if (device) {
          this.handleDeviceDiscovery(device);
        }
      }
    );
  }

  private handleDeviceDiscovery(device: Device) {
    // ── 이름이 없는 기기는 완전히 무시 ──
    // 실제 advertising packet에 name이 없으면 표시하지 않음 (mock/fallback 생성 금지)
    const advertisedName = device.localName || device.name;
    if (!advertisedName) return;

    const now = Date.now();

    const bleDevice: BleDevice = {
      id: device.id,
      name: advertisedName,
      localName: device.localName || null,
      rssi: device.rssi,
      lastSeen: now,
      isConnectable: device.isConnectable ?? true,
      serviceUUIDs: device.serviceUUIDs || null,
    };

    // MAC address 기준 중복 제거: 동일 ID면 RSSI만 갱신
    this.discoveredDevices.set(device.id, bleDevice);
    this.scheduleEmit();
  }

  // ── UI 업데이트 스로틀 (300ms 디바운스) ──
  // allowDuplicates:true 시 매 패킷마다 콜백이 와서 setState 폭주 방지
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleEmit() {
    if (this.emitTimer) return; // 이미 예약됨
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitDeviceList();
    }, 300);
  }

  private evictStaleDevices() {
    const now = Date.now();
    let changed = false;

    this.discoveredDevices.forEach((device, id) => {
      if (now - device.lastSeen > STALE_DEVICE_TIMEOUT_MS) {
        this.discoveredDevices.delete(id);
        changed = true;
      }
    });

    if (changed) {
      this.emitDeviceList();
    }
  }

  private emitDeviceList() {
    if (!this.scanDeviceCallback) return;

    let devices = Array.from(this.discoveredDevices.values());

    // DeFoTic 타깃 장치는 물리적으로 1대 — 서비스 UUID 보유 항목이
    // 복수로 잡히면(펌웨어 재부팅 잔상, 광고 주소 변경 등) 가장
    // 최근에 수신된 항목만 남겨 유령 중복 표시를 방지한다.
    const targets = devices.filter(d => this.hasTargetService(d));
    if (targets.length > 1) {
      const latest = targets.reduce((a, b) => (a.lastSeen >= b.lastSeen ? a : b));
      devices = devices.filter(d => !this.hasTargetService(d) || d.id === latest.id);
    }

    // DeFoTic Service UUID 보유 기기를 최상단으로, 나머지는 RSSI 순
    devices.sort((a, b) => {
      const aHasService = this.hasTargetService(a);
      const bHasService = this.hasTargetService(b);
      if (aHasService && !bHasService) return -1;
      if (!aHasService && bHasService) return 1;
      return (b.rssi ?? -999) - (a.rssi ?? -999);
    });

    this.scanDeviceCallback(devices);
  }

  /** advertising 데이터에서 DeFoTic Service UUID 포함 여부 확인 */
  private hasTargetService(device: BleDevice): boolean {
    if (!device.serviceUUIDs) return false;
    const target = BLE_CONFIG.SERVICES.TIC_DATA.toLowerCase();
    return device.serviceUUIDs.some(uuid => uuid.toLowerCase() === target);
  }

  private stopScanInternal() {
    if (this.manager && this.isScanning) {
      this.manager.stopDeviceScan();
      this.isScanning = false;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
  }

  /**
   * BLE 연결은 직후 수 초간 불안정해 첫 시도에서 끊기는 경우가 흔하다.
   * (예: "Device was disconnected" during MTU/discovery)
   * → 일시적 오류는 짧은 대기 후 자동 재시도하고,
   *   UUID 검증 실패(다른 기기)는 재시도 없이 즉시 실패 처리한다.
   */
  private static readonly CONNECT_MAX_ATTEMPTS = 3;
  private static readonly CONNECT_RETRY_DELAY_MS = 800;

  public async connectToDevice(deviceId: string): Promise<void> {
    if (!this.manager) throw new Error('BleManager가 초기화되지 않았습니다.');

    // 사용자가 명시적으로 연결을 시작했다 — 자동 재연결 사다리 재무장 +
    // 대기 중이던 사다리 타이머 취소 (수동 연결과 사다리 재연결이 같은
    // 기기에 동시 진입하는 경로 차단)
    this.manualDisconnect = false;
    this.cancelReconnect();
    // 진행 중 플래그: cancelReconnect는 '미래 타이머'만 제거한다 —
    // 이미 발화해 await 중인 콜백은 못 막는다. 그 콜백이 이 수동 연결과
    // 같은 기기에 병행 진입해, 실패한 쪽의 정리가 성립된 연결을 절단하는
    // 레이스를 이 플래그로 차단한다.
    this.manualConnectInProgress = true;

    this.stopContinuousScan();

    try {
      let lastError: any = null;
      for (let attempt = 1; attempt <= BleManagerService.CONNECT_MAX_ATTEMPTS; attempt++) {
        try {
          await this.attemptConnection(deviceId);
          return;
        } catch (error: any) {
          lastError = error;
          console.warn(`[BLE] Connect attempt ${attempt} failed:`, error?.message || error);

          // 연결 잔재 정리 — 소유권 검사: 이 시도(deviceId)가
          // 만든 잔재일 때만 취소한다. 무조건 this.connectedDevice를 끊으면,
          // 병행 경로(silent 재연결 등)가 성립시킨 '다른 기기'의 라이브 연결을
          // 실패한 이 시도가 파괴한다.
          if (this.connectedDevice && this.connectedDevice.id === deviceId) {
            await this.manager.cancelDeviceConnection(this.connectedDevice.id).catch(() => {});
            this.connectedDevice = null;
          }

          // 검증 실패(다른 BLE 장치)는 재시도해도 결과가 같으므로 즉시 중단
          if (error?.isVerificationError) break;

          if (attempt < BleManagerService.CONNECT_MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, BleManagerService.CONNECT_RETRY_DELAY_MS));
          }
        }
      }

      console.error('Connection/Verification error:', lastError);
      throw lastError;
    } finally {
      this.manualConnectInProgress = false;
    }
  }

  private async attemptConnection(deviceId: string): Promise<void> {
    if (!this.manager) throw new Error('BleManager가 초기화되지 않았습니다.');

    // requestMTU를 연결 옵션에 포함하면 연결 수립 단계에서 함께 협상되어
    // 별도 requestMTU 호출보다 초기 끊김에 강하다.
    const device = await this.manager.connectToDevice(deviceId, {
      timeout: BLE_CONFIG.CONNECTION.CONNECTION_TIMEOUT_MS,
      requestMTU: 512,
    });

    // 협상 MTU 계측: requestMTU 512는 '요청'일 뿐이다. 협상이
    // 기본 23(payload 20B)으로 떨어지면 펌웨어 JSON(~110-200B)이 전부
    // 잘려 JSON.parse가 실패 → 모든 텔레메트리/틱 이벤트가 무음
    // 폐기되는 전량 블랙아웃이 된다. 재협상 API는 없으므로 최소한
    // 진단 가능하도록 명시적으로 남긴다.
    const mtu = (device as any).mtu;
    if (typeof mtu === 'number' && mtu > 0 && mtu < 247) {
      console.warn(
        `[BLE] Negotiated MTU is only ${mtu} — firmware packets (~200B) may be truncated and dropped`,
      );
    } else {
      console.log(`[BLE] Negotiated MTU: ${mtu}`);
    }

    this.connectedDevice = device;

    await device.discoverAllServicesAndCharacteristics();

    // ── 1. Service UUID 검증 ──
    const services = await device.services();
    const targetServiceUuid = BLE_CONFIG.SERVICES.TIC_DATA.toLowerCase();
    const hasService = services.some(s => s.uuid.toLowerCase() === targetServiceUuid);

    if (!hasService) {
      const err: any = new Error('DeFoTic 장치가 아닙니다. (Service UUID 없음)');
      err.isVerificationError = true;
      throw err;
    }

    // ── 2. Characteristic UUID 검증 ──
    const characteristics = await device.characteristicsForService(BLE_CONFIG.SERVICES.TIC_DATA);
    const targetCharUuid = BLE_CONFIG.CHARACTERISTICS.TIC_EVENT_STREAM.toLowerCase();
    const hasChar = characteristics.some(c => c.uuid.toLowerCase() === targetCharUuid);

    if (!hasChar) {
      const err: any = new Error('지원되지 않는 BLE 장치입니다. (Characteristic UUID 없음)');
      err.isVerificationError = true;
      throw err;
    }

    // ── 3. 검증 성공 시에만 모니터링 시작 ──
    useDeviceStore.getState().setConnected(device.name || device.localName || 'DeFoTic Device');
    this.startMonitoring(device);
    this.cancelReconnect();   // 연결 성립 — 대기 중이던 재연결 사다리 해제
    // 재무장: silent 재연결로 성립한 세션도 '연결이 성립됐다'는 사실
    // 자체가 자동 복구 의사의 갱신이다 — 이 갱신이 없으면 이전 수동
    // 해제의 manualDisconnect=true가 남아, 이 세션의 링크 사망 시
    // 재연결 사다리가 영구 무장해제 상태가 된다.
    this.manualDisconnect = false;
    this.nonJsonStreak = 0;

    // 검증까지 통과한 진짜 DeFoTic 기기만 자동 재연결 대상으로 기억한다
    AsyncStorage.setItem(LAST_DEVICE_KEY, device.id).catch(() => {});

    // ── 4. 연결 해제 감지 → 상태 스토어 반영 + 자동 재연결 ──
    // 기기 리셋/일시 이탈을 방치하면 사용자가 수동 페어링을 다시 하기
    // 전까지 모든 tic_event가 유실된다. 명시적 해제(disconnectDevice)가
    // 아니면 백오프 사다리로 조용히 복구를 시도한다.
    device.onDisconnected(() => {
      console.warn('[BLE] Device disconnected');
      this.connectedDevice = null;
      useDeviceStore.getState().setDisconnected();
      this.scheduleReconnect('link lost');
    });

    // ── 5. TIME 동기화 전송 (하드웨어 태스크 기동 트리거) ──
    await this.sendTimeSync(device);
  }

  /**
   * 하드웨어의 timeSynced 플래그를 true로 만들어 FreeRTOS 태스크를 기동시킵니다.
   * 하드웨어의 TimeCallback은 "TIME:" 접두사가 있는 값을 수신하면 timeSynced = true 처리합니다.
   */
  private async sendTimeSync(device: Device) {
    try {
      const timeStr = `TIME:${Math.floor(Date.now() / 1000)}`;
      const base64Value = Buffer.from(timeStr, 'utf8').toString('base64');
      await device.writeCharacteristicWithResponseForService(
        BLE_CONFIG.SERVICES.TIC_DATA,
        BLE_CONFIG.CHARACTERISTICS.TIC_EVENT_STREAM,
        base64Value,
      );
      console.log('[BLE] Time sync sent:', timeStr);
    } catch (e) {
      console.warn('[BLE] Time sync write failed (non-critical):', e);
    }
  }


  private startMonitoring(device: Device) {
    if (!this.manager) return;

    // 모니터 콜백에 소속 기기 id를 캡처한다 — 에러 처리에서 '이 모니터가
    // 속했던 연결'과 '현재 연결'을 구분하기 위함
    const monitoredId = device.id;
    device.monitorCharacteristicForService(
      BLE_CONFIG.SERVICES.TIC_DATA,
      BLE_CONFIG.CHARACTERISTICS.TIC_EVENT_STREAM,
      (error, characteristic) => this.handleCharacteristicUpdate(error, characteristic, monitoredId)
    );
  }

  private handleCharacteristicUpdate(
    error: BleError | null,
    characteristic: Characteristic | null,
    monitoredId?: string,
  ) {
    if (error) {
      // 스테일 모니터 에러 가드: 재연결이 이미 새 연결을 성립시킨 뒤
      // 구 연결의 에러가 늦게 도착하면, 아래 정리가 살아 있는 새 연결을
      // 절단한다 — 소속 기기가 현재 연결과 다르면 무시한다.
      // (connectedDevice가 null이면 기존 정리 경로 유지)
      if (
        monitoredId &&
        this.connectedDevice &&
        this.connectedDevice.id !== monitoredId
      ) {
        console.warn('[BLE] Stale monitor error for previous connection ignored');
        return;
      }
      // 모니터 에러 = 실질적 링크 사망 신호. 상태만 바꾸고
      // this.connectedDevice를 남겨두면, 유일한 자동 복구 경로
      // (tryReconnectLastDevice)가 첫 가드(this.connectedDevice 존재)에
      // 걸려 영구 무음 차단된다 — UI는 "연결 안 됨"인데 재연결은
      // 불가능한 좀비 상태. 따라서 잔재를 정리하고 재연결 사다리를
      // 태운다. (명시적 disconnectDevice가 유발한 'Operation was
      // cancelled'는 manualDisconnect 플래그가 사다리를 무장해제해 무해)
      console.error('Characteristic monitoring error:', error);
      const dead = this.connectedDevice;
      this.connectedDevice = null;
      if (dead && this.manager) {
        this.manager.cancelDeviceConnection(dead.id).catch(() => {});
      }
      useDeviceStore.getState().setDisconnected();
      this.scheduleReconnect('monitor error');
      return;
    }

    if (characteristic?.value) {
      try {
        const decoded = Buffer.from(characteristic.value, 'base64').toString('utf8');
        const payload = JSON.parse(decoded);
        this.nonJsonStreak = 0;

        if (payload) {
          // BLE Payload 처리 (상태 + 진단 + 틱 이벤트 메타데이터).
          // status/diag는 펌웨어가 MTU 잘림 방지를 위해 2패킷으로 분할
          // 전송하는 같은 텔레메트리의 두 조각 — 동일 병합 경로로 처리한다.
          if (payload.type === 'status' || payload.type === 'diag') {
            useDeviceStore.getState().updateFromBle(payload);
          } else if (payload.type === 'tic_event') {
            // 미디어 없이 메타데이터만 즉시 기록 → 대시보드 실시간 반영
            console.log(`[BLE] tic_event received: ${payload.eventId}`);

            // RTC 미동기 기기의 타임스탬프 방어:
            // epoch≈0 값이 KST로 변환되면 1970-01-01 09:0X처럼 표시되므로,
            // 2001년(1e9초) 이전 값은 신뢰하지 않고 수신 시각으로 대체한다.
            const rawTs = Number(payload.timestamp);
            const timestampSec = rawTs > 1e9 ? rawTs : Math.floor(Date.now() / 1000);

            // eventId 검증: undefined가 그대로 통과하면 id:undefined
            // 레코드가 1건 생기고, 이후 eventId 누락 패킷 전부가
            // undefined===undefined dedupe로 무음 소실된다 (재시작 시
            // sanitizeStored가 그 1건마저 지워 무흔적). 수신 시각 기반
            // 폴백 id로 최소한 이벤트 자체는 보존한다.
            const eventId =
              typeof payload.eventId === 'string' && payload.eventId.length > 0
                ? payload.eventId
                : `evt_rx_${Date.now()}`;
            if (eventId !== payload.eventId) {
              console.warn('[BLE] tic_event without valid eventId — fallback id used:', eventId);
            }

            // media:false = 기기 SD에 미디어가 없는 메타 전용 이벤트
            // (MSC 세션 중 감지, SD 부재 등). 필드가 없는 구펌웨어
            // 패킷은 true로 간주해 하위 호환한다.
            EventRepository.createFromTicEvent(
              eventId,
              timestampSec,
              typeof payload.confidence === 'number' ? payload.confidence : 0,
              payload.media !== false,
            ).catch(e => console.error('[BLE] tic_event 저장 실패:', e));
          } else {
            console.warn(`[BLE] Unknown payload type: ${payload.type}`);
          }
        }
      } catch (e) {
        // JSON이 아닌 raw 문자열일 수도 있음 (예: 이전 프로토콜 잔여)
        const decodedStr = Buffer.from(characteristic.value, 'base64').toString('utf8');
        console.warn('Non-JSON BLE data received. Raw decoded:', decodedStr);
        // 저MTU 잘림 감지: MTU 협상이 기본값(23)으로 떨어지면 모든
        // 패킷이 잘려 여기로만 흘러든다 — 경고만 하면 텔레메트리/틱
        // 이벤트 전량이 무음 폐기되는 블랙아웃이다. 연속 5회면 링크
        // 이상으로 간주하고 연결을 재수립한다
        // (cancel → onDisconnected → 재연결 사다리, MTU 재협상 포함).
        this.nonJsonStreak++;
        if (this.nonJsonStreak >= 5 && this.connectedDevice && this.manager) {
          console.error('[BLE] 5 consecutive unparseable packets — forcing reconnect (low MTU?)');
          this.nonJsonStreak = 0;
          this.manager.cancelDeviceConnection(this.connectedDevice.id).catch(() => {});
        }
      }
    }
  }

  /**
   * 온보딩 완료 사용자의 백그라운드 자동 재연결 (자동 로그인 동선).
   * 마지막 검증 기기 주소로 1회만 조용히 시도한다 — 실패해도 UI에
   * 아무 영향이 없고, 사용자는 홈의 연결 카드로 언제든 수동 연결한다.
   * 가드: 웹/이미 연결됨/페어링 화면 스캔 중(사용자 의도 우선)/BT 꺼짐.
   */
  private reconnectInFlight = false;

  // ── 자동 재연결 사다리 ──
  // 링크 사망(onDisconnected/모니터 에러) 시 백오프로 silent 재연결을
  // 시도한다. 초반 5단은 점증 백오프, 이후에는 마지막 단(60s)을 무기한
  // 반복한다 — 유한 횟수 후 영구 포기하면 기기 배터리 교체/일시 이탈
  // 이후의 모든 tic_event BLE 메타가 조용히 유실된다(펌웨어에는 재전송
  // 큐가 없다). 60s 간격 직접 연결 시도는 스캔이 아니라서 전력 비용이
  // 미미하다. 성공/명시적 해제/사용자 스캔이 사다리를 해제·연기한다.
  private static readonly RECONNECT_DELAYS_MS = [3_000, 8_000, 15_000, 30_000, 60_000];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private manualConnectInProgress = false;
  private nonJsonStreak = 0;

  private cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private scheduleReconnect(reason: string) {
    if (this.manualDisconnect || this.reconnectTimer) return;
    const ladder = BleManagerService.RECONNECT_DELAYS_MS;
    const delay = ladder[Math.min(this.reconnectAttempt, ladder.length - 1)];
    console.log(`[BLE] Auto-reconnect in ${delay}ms (${reason}, attempt ${this.reconnectAttempt + 1})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.connectedDevice || this.manualDisconnect) {
        this.reconnectAttempt = 0;
        return;
      }
      // 사용자가 페어링 화면에서 스캔 중이거나 수동 연결이 진행 중 —
      // '실패'가 아니라 '보류'다. 시도로 계상하면 백오프 단이 조용히
      // 소진되고, 수동 연결과의 병행 진입은 성립된 연결을 실패측 정리가
      // 절단하는 레이스가 된다 — 카운트 없이 연기만 한다.
      if (this.isContinuousScanActive || this.manualConnectInProgress) {
        this.scheduleReconnect('deferred: user action in progress');
        return;
      }
      this.reconnectAttempt++;
      const ok = await this.tryReconnectLastDevice().catch(() => false);
      if (ok) {
        this.reconnectAttempt = 0;
      } else if (!this.connectedDevice && !this.manualDisconnect) {
        this.scheduleReconnect('retry');
      }
    }, delay);
  }

  public async tryReconnectLastDevice(): Promise<boolean> {
    if (!this.manager || this.connectedDevice || this.reconnectInFlight) return false;
    if (this.isContinuousScanActive) return false; // 사용자가 페어링 화면에서 스캔 중
    this.reconnectInFlight = true;
    try {
      const lastId = await AsyncStorage.getItem(LAST_DEVICE_KEY);
      if (!lastId) return false;

      const hasPermission = await this.requestPermissions();
      if (!hasPermission) return false;

      const state = await this.manager.state();
      if (state !== State.PoweredOn) return false;

      // 단일 시도 — 기기가 꺼져 있거나 범위 밖이면 타임아웃으로 조용히 실패
      await this.attemptConnection(lastId);
      console.log('[BLE] Silent reconnect succeeded');
      return true;
    } catch (e: any) {
      console.log('[BLE] Silent reconnect skipped:', e?.message || e);
      // 연결 잔재 정리 (attemptConnection 실패 중간 상태 방어).
      // 소유권 검사: 이 재연결 시도의 대상(lastId)일 때만 취소한다 —
      // 그 사이 사용자가 페어링 화면에서 성립시킨 '다른 기기' 연결을
      // 실패한 백그라운드 시도가 절단하는 경로 차단.
      // (함수 상단의 null 내로잉을 attemptConnection이 무효화하므로 재판독)
      const dangling = this.connectedDevice as Device | null;
      const lastId = await AsyncStorage.getItem(LAST_DEVICE_KEY).catch(() => null);
      if (dangling && dangling.id === lastId) {
        await this.manager?.cancelDeviceConnection(dangling.id).catch(() => {});
        this.connectedDevice = null;
      }
      return false;
    } finally {
      this.reconnectInFlight = false;
    }
  }

  public async disconnectDevice() {
    // 사용자 의도에 의한 해제 — 자동 재연결 사다리 무장해제
    this.manualDisconnect = true;
    this.cancelReconnect();
    if (this.manager && this.connectedDevice) {
      await this.manager.cancelDeviceConnection(this.connectedDevice.id);
      this.connectedDevice = null;
    }
    useDeviceStore.getState().setDisconnected();
  }

  public getConnectedDevice() {
    return this.connectedDevice;
  }
}

export const bleManager = new BleManagerService();

