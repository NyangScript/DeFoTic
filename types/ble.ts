export interface BleDevice {
  id: string;                       // MAC address (Android) or UUID (iOS)
  name: string | null;              // advertising name (localName || name)
  localName: string | null;         // BLE advertising packet localName
  rssi: number | null;
  lastSeen: number;                 // Date.now() — 범위 이탈 감지용
  isConnectable: boolean;
  serviceUUIDs: string[] | null;    // advertising에서 감지된 서비스 UUID
}

export interface BleConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  device: BleDevice | null;
  error: string | null;
}
