export interface DeviceStatus {
  batteryLevel: number; // 0-100
  storageUsage: number; // 0-100 (percentage)
  temperature: number; // in Celsius
  isMicActive: boolean;
  isCameraActive: boolean;
  lastSyncTime: string; // ISO 8601 string
}
