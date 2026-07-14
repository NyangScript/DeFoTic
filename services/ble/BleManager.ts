import { BleManager as PlxBleManager, Device, State, BleError, Characteristic } from 'react-native-ble-plx';
import { BLE_CONFIG } from '../../constants/ble-config';
import { BleDevice } from '../../types/ble';
import { Platform, PermissionsAndroid, AppState, AppStateStatus } from 'react-native';
import { Buffer } from 'buffer';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { EventRepository } from '../data/EventRepository';

export type ScanDeviceCallback = (devices: BleDevice[]) => void;
export type ScanErrorCallback = (error: BleError | string) => void;

const SCAN_RESTART_INTERVAL_MS = 12_000;
const STALE_DEVICE_TIMEOUT_MS  = 15_000;
const STALE_CHECK_INTERVAL_MS  =  3_000;

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

    const state = await this.manager.state();
    if (state !== State.PoweredOn) {
      this.manager.onStateChange((newState) => {
        if (newState === State.PoweredOn && this.isContinuousScanActive) {
          this.beginScanCycle();
        }
      }, true);
      if (this.scanErrorCallback) this.scanErrorCallback('블루투스가 꺼져있습니다. 기기의 블루투스를 켜주세요.');
      return;
    }

    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
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

    const devices = Array.from(this.discoveredDevices.values())
      // DeFoTic Service UUID 보유 기기를 최상단으로, 나머지는 RSSI 순
      .sort((a, b) => {
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

  public async startScan(onDeviceFound: (device: BleDevice) => void, onScanError?: (error: BleError | string) => void) {
    await this.startContinuousScan(
      (devices) => {
        devices.forEach(d => onDeviceFound(d));
      },
      onScanError
    );
  }

  public stopScan() {
    this.stopContinuousScan();
  }

  public getIsScanning(): boolean {
    return this.isScanning;
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

    this.stopContinuousScan();

    let lastError: any = null;
    for (let attempt = 1; attempt <= BleManagerService.CONNECT_MAX_ATTEMPTS; attempt++) {
      try {
        await this.attemptConnection(deviceId);
        return;
      } catch (error: any) {
        lastError = error;
        console.warn(`[BLE] Connect attempt ${attempt} failed:`, error?.message || error);

        // 연결 잔재 정리
        if (this.connectedDevice) {
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
  }

  private async attemptConnection(deviceId: string): Promise<void> {
    if (!this.manager) throw new Error('BleManager가 초기화되지 않았습니다.');

    // requestMTU를 연결 옵션에 포함하면 연결 수립 단계에서 함께 협상되어
    // 별도 requestMTU 호출보다 초기 끊김에 강하다.
    const device = await this.manager.connectToDevice(deviceId, {
      timeout: BLE_CONFIG.CONNECTION.CONNECTION_TIMEOUT_MS,
      requestMTU: 512,
    });

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

    // ── 4. 연결 해제 감지 → 상태 스토어 반영 ──
    device.onDisconnected(() => {
      console.warn('[BLE] Device disconnected');
      this.connectedDevice = null;
      useDeviceStore.getState().setDisconnected();
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

    device.monitorCharacteristicForService(
      BLE_CONFIG.SERVICES.TIC_DATA,
      BLE_CONFIG.CHARACTERISTICS.TIC_EVENT_STREAM,
      (error, characteristic) => this.handleCharacteristicUpdate(error, characteristic)
    );
  }

  private handleCharacteristicUpdate(error: BleError | null, characteristic: Characteristic | null) {
    if (error) {
      console.error('Characteristic monitoring error:', error);
      useDeviceStore.getState().setDisconnected();
      return;
    }

    if (characteristic?.value) {
      try {
        const decoded = Buffer.from(characteristic.value, 'base64').toString('utf8');
        const payload = JSON.parse(decoded);
        
        if (payload) {
          // BLE Payload 처리 (투트랙: 상태 텔레메트리 + 틱 이벤트 메타데이터)
          if (payload.type === 'status') {
            useDeviceStore.getState().updateFromBle(payload);
          } else if (payload.type === 'tic_event') {
            // 미디어 없이 메타데이터만 즉시 기록 → 대시보드 실시간 반영
            console.log(`[BLE] tic_event received: ${payload.eventId}`);

            // RTC 미동기 기기의 타임스탬프 방어:
            // epoch≈0 값이 KST로 변환되면 1970-01-01 09:0X처럼 표시되므로,
            // 2001년(1e9초) 이전 값은 신뢰하지 않고 수신 시각으로 대체한다.
            const rawTs = Number(payload.timestamp);
            const timestampSec = rawTs > 1e9 ? rawTs : Math.floor(Date.now() / 1000);

            EventRepository.createFromTicEvent(
              payload.eventId,
              timestampSec,
              typeof payload.confidence === 'number' ? payload.confidence : 0,
            );
          } else {
            console.warn(`[BLE] Unknown payload type: ${payload.type}`);
          }
        }
      } catch (e) {
        // JSON이 아닌 raw 문자열일 수도 있음 (예: 이전 프로토콜 잔여)
        const decodedStr = Buffer.from(characteristic.value, 'base64').toString('utf8');
        console.warn('Non-JSON BLE data received. Raw decoded:', decodedStr);
      }
    }
  }

  public async disconnectDevice() {
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

