import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TicEvent } from '../types/tic-event';

interface EventState {
  events: TicEvent[];
  isLoading: boolean;
  loadEvents: () => Promise<void>;
  addEvent: (event: TicEvent) => Promise<void>;
  updateEventAnalysis: (id: string, analyzedEvent: TicEvent) => Promise<void>;
  updateEvent: (id: string, updates: Partial<TicEvent>) => Promise<void>;
  clearEvents: () => Promise<void>;
}

const STORAGE_KEY = '@tic_events_store';

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  isLoading: true,

  loadEvents: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        set({ events: JSON.parse(stored), isLoading: false });
      } else {
        set({ isLoading: false });
      }
    } catch (e) {
      console.error('Failed to load events:', e);
      set({ isLoading: false });
    }
  },

  addEvent: async (event) => {
    const currentEvents = get().events;
    if (!currentEvents.find(e => e.id === event.id)) {
      const newEvents = [event, ...currentEvents].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      set({ events: newEvents });
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newEvents));
    }
  },

  updateEventAnalysis: async (id, analyzedEvent) => {
    const currentEvents = get().events;
    const newEvents = currentEvents.map(e => (e.id === id ? analyzedEvent : e));
    set({ events: newEvents });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newEvents));
  },

  updateEvent: async (id, updates) => {
    const currentEvents = get().events;
    const newEvents = currentEvents.map(e => (e.id === id ? { ...e, ...updates } : e));
    set({ events: newEvents });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newEvents));
  },

  clearEvents: async () => {
    set({ events: [] });
    await AsyncStorage.removeItem(STORAGE_KEY);
  },
}));
