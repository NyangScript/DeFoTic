import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { theme } from '../../constants/theme';
import { TicEventCard } from '../../components/analysis/TicEventCard';
import { TicEvent } from '../../types/tic-event';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { ticEventStore } from '../../services/data/TicEventStore';

export default function AnalysisScreen() {
  const [events, setEvents] = useState<TicEvent[]>([]);

  useEffect(() => {
    // ticEventStore 구독
    const unsubscribe = ticEventStore.subscribe((newEvents) => {
      setEvents(newEvents);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>── 상황 맥락 분석 ──</Text>
        
        {events.map((event) => (
          <TicEventCard key={event.id} event={event} />
        ))}
        
        {events.length === 0 && (
          <Text style={styles.emptyText}>분석된 데이터가 없습니다.</Text>
        )}
      </ScrollView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: theme.spacing.m,
    paddingTop: theme.spacing.xxl,
    paddingBottom: 100, // 탭바 영역 확보
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.l,
  },
  emptyText: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
});
