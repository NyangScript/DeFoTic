import AsyncStorage from '@react-native-async-storage/async-storage';
import { TicEvent } from '../../types/tic-event';

type Listener = (events: TicEvent[]) => void;

class TicEventStoreService {
  private events: TicEvent[] = [];
  private listeners: Listener[] = [];
  private readonly STORAGE_KEY = '@tic_events';

  constructor() {
    this.loadEvents();
  }

  private async loadEvents() {
    try {
      const stored = await AsyncStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        this.events = JSON.parse(stored);
        this.notifyListeners();
      }
    } catch (e) {
      console.error('Failed to load events:', e);
    }
  }

  private async saveEvents() {
    try {
      await AsyncStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.events));
    } catch (e) {
      console.error('Failed to save events:', e);
    }
  }

  public getEvents(): TicEvent[] {
    return [...this.events];
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    listener([...this.events]); // Initial call
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener([...this.events]));
  }

  public async addEvent(event: TicEvent) {
    if (!this.events.find(e => e.id === event.id)) {
      this.events.unshift(event);
      // 최신순 정렬
      this.events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      this.notifyListeners();
      await this.saveEvents();
    }
  }

  public async updateEventAnalysis(id: string, analysisEvent: TicEvent) {
    const index = this.events.findIndex(e => e.id === id);
    if (index !== -1) {
      this.events[index] = analysisEvent;
      this.notifyListeners();
      await this.saveEvents();
    }
  }

  public async clearEvents(): Promise<void> {
    try {
      this.events = [];
      this.notifyListeners();
      await AsyncStorage.removeItem(this.STORAGE_KEY);
    } catch (e) {
      console.error('Failed to clear events', e);
    }
  }
}

export const ticEventStore = new TicEventStoreService();
