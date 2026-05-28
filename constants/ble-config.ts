export const BLE_CONFIG = {
  // ESP32-S3 DeFoTic 디바이스 필터
  DEVICE_NAME_PREFIX: 'DeFoTic',
  
  // BLE Service UUIDs
  SERVICES: {
    TIC_DATA:       '4fafc201-1fb5-459e-8fcc-c5c9c331914b',  // 메인 서비스 UUID
    DEVICE_INFO:    '0000180a-0000-1000-8000-00805f9b34fb',  // Device Information
    BATTERY:        '0000180f-0000-1000-8000-00805f9b34fb',  // Battery Service
  },
  
  // Characteristic UUIDs
  CHARACTERISTICS: {
    TIC_EVENT_STREAM: 'beb5483e-36e1-4688-b7f5-ea07361b26a8', // 메인 캐릭터리스틱 UUID
    BATTERY_LEVEL:    '00002a19-0000-1000-8000-00805f9b34fb',
  },
  
  // 연결 설정
  CONNECTION: {
    SCAN_TIMEOUT_MS: 10000,
    CONNECTION_TIMEOUT_MS: 5000,
    AUTO_RECONNECT: true,
    MAX_RECONNECT_ATTEMPTS: 3,
  }
} as const;
