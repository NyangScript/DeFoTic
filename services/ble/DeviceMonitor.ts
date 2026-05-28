import { bleManager } from './BleManager';
import { BLE_CONFIG } from '../../constants/ble-config';
import { DeviceStatus } from '../../types/device';
import { Platform } from 'react-native';

type StatusUpdateCallback = (status: Partial<DeviceStatus>) => void;

class DeviceMonitorService {
  private subscription: any = null;

  public subscribeToStatus(onUpdate: StatusUpdateCallback) {
    if (Platform.OS === 'web') return; // Not supported on web

    const device = bleManager.getConnectedDevice();
    if (!device) return;

    this.subscription = device.monitorCharacteristicForService(
      BLE_CONFIG.SERVICES.BATTERY,
      BLE_CONFIG.CHARACTERISTICS.BATTERY_LEVEL,
      (error, characteristic) => {
        if (error) {
          console.error('Status monitoring error:', error);
          return;
        }
        
        if (characteristic?.value) {
          // Decode Base64 to number (simplified for mockup)
          // 실제로는 Base64를 Uint8Array로 디코딩 후 파싱해야 함
          const batteryLevel = 85; // Mock decoding
          onUpdate({ batteryLevel });
        }
      }
    );
  }

  public unsubscribe() {
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
  }
}

export const deviceMonitor = new DeviceMonitorService();
