import { create } from 'zustand';

interface AnalysisState {
  analyzingEventIds: Set<string>;
  
  startAnalyzing: (eventId: string) => void;
  finishAnalyzing: (eventId: string) => void;
  isAnalyzing: (eventId: string) => boolean;
}

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  analyzingEventIds: new Set(),

  startAnalyzing: (eventId) => set((state) => {
    const newSet = new Set(state.analyzingEventIds);
    newSet.add(eventId);
    return { analyzingEventIds: newSet };
  }),

  finishAnalyzing: (eventId) => set((state) => {
    const newSet = new Set(state.analyzingEventIds);
    newSet.delete(eventId);
    return { analyzingEventIds: newSet };
  }),

  isAnalyzing: (eventId) => get().analyzingEventIds.has(eventId),
}));
