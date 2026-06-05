import { create } from 'zustand';

export interface DeviceStatusPayload {
  battery: number | null;
  sdUsed: number | null; // Note: Payload schema might have different keys, mapping required
  temperature: number | null;
  camera: boolean;
  microphone: boolean;
  tickCountToday: number;
  lastEventTime: string | null;
}

interface DeviceState {
  isConnected: boolean;
  deviceName: string | null;
  battery: number | null;
  sdUsedPercent: number | null;
  temperature: number | null;
  camera: boolean;
  microphone: boolean;
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
  lastUpdated: null,

  updateFromBle: (payload) => set((state) => ({
    battery: payload.battery ?? state.battery,
    sdUsedPercent: payload.sdUsed ?? state.sdUsedPercent,
    temperature: payload.temperature ?? state.temperature,
    camera: payload.camera ?? state.camera,
    microphone: payload.microphone ?? state.microphone,
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
    lastUpdated: null,
  }),
}));
