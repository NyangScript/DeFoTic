import { BleManager as PlxBleManager, Device, State, BleError, Characteristic } from 'react-native-ble-plx';
import { BLE_CONFIG } from '../../constants/ble-config';
import { BleDevice } from '../../types/ble';
import { Platform, PermissionsAndroid, AppState, AppStateStatus } from 'react-native';
import { Buffer } from 'buffer';

export interface TicEventPayload {
  timestamp: number;
  tic_type: string;
  intensity: number;
  has_video: boolean;
}

type TicEventCallback = (payload: TicEventPayload) => void;

export type ScanDeviceCallback = (devices: BleDevice[]) => void;
export type ScanErrorCallback = (error: BleError | string) => void;

const SCAN_RESTART_INTERVAL_MS = 12_000;
const STALE_DEVICE_TIMEOUT_MS  = 15_000;
const STALE_CHECK_INTERVAL_MS  =  3_000;

class BleManagerService {
  private manager: PlxBleManager | null = null;
  private connectedDevice: Device | null = null;
  private isScanning: boolean = false;
  private ticEventCallbacks: TicEventCallback[] = [];

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

  public async connectToDevice(deviceId: string): Promise<void> {
    if (!this.manager) throw new Error('BleManager가 초기화되지 않았습니다.');

    this.stopContinuousScan();
    try {
      const device = await this.manager.connectToDevice(deviceId, {
        timeout: BLE_CONFIG.CONNECTION.CONNECTION_TIMEOUT_MS,
      });
      
      this.connectedDevice = device;
      await device.discoverAllServicesAndCharacteristics();

      // ── 1. Service UUID 검증 ──
      const services = await device.services();
      const targetServiceUuid = BLE_CONFIG.SERVICES.TIC_DATA.toLowerCase();
      const hasService = services.some(s => s.uuid.toLowerCase() === targetServiceUuid);
      
      if (!hasService) {
        throw new Error('DeFoTic 장치가 아닙니다. (Service UUID 없음)');
      }

      // ── 2. Characteristic UUID 검증 ──
      const characteristics = await device.characteristicsForService(BLE_CONFIG.SERVICES.TIC_DATA);
      const targetCharUuid = BLE_CONFIG.CHARACTERISTICS.TIC_EVENT_STREAM.toLowerCase();
      const hasChar = characteristics.some(c => c.uuid.toLowerCase() === targetCharUuid);

      if (!hasChar) {
        throw new Error('지원되지 않는 BLE 장치입니다. (Characteristic UUID 없음)');
      }

      // ── 3. 검증 성공 시에만 모니터링 시작 ──
      this.startMonitoring(device);
    } catch (error: any) {
      console.error('Connection/Verification error:', error);
      // 에러 발생 시 즉시 연결 해제 및 초기화
      if (this.connectedDevice) {
        await this.manager.cancelDeviceConnection(this.connectedDevice.id).catch(() => {});
        this.connectedDevice = null;
      }
      throw error;
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
      return;
    }

    if (characteristic?.value) {
      try {
        const decoded = Buffer.from(characteristic.value, 'base64').toString('utf8');
        const payload: TicEventPayload = JSON.parse(decoded);
        this.ticEventCallbacks.forEach(cb => cb(payload));
      } catch (e) {
        console.error('Failed to parse BLE payload', e);
      }
    }
  }

  public onTicEventReceived(callback: TicEventCallback) {
    this.ticEventCallbacks.push(callback);
  }

  public async disconnectDevice() {
    if (this.manager && this.connectedDevice) {
      await this.manager.cancelDeviceConnection(this.connectedDevice.id);
      this.connectedDevice = null;
      this.ticEventCallbacks = [];
    }
  }

  public getConnectedDevice() {
    return this.connectedDevice;
  }
}

export const bleManager = new BleManagerService();
