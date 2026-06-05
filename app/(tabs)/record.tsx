import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { BarChart } from '../../components/charts/BarChart';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useEventStore } from '../../stores/useEventStore';

export default function RecordScreen() {
  const events = useEventStore((state) => state.events);

  const { total, weeklyData, labels, typeStats } = useMemo(() => {
    const now = new Date();
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(now.getDate() - (6 - i));
      return d.toDateString();
    });

    const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];
    const displayLabels = last7Days.map(dStr => dayLabels[new Date(dStr).getDay()]);

    const weeklyCounts = new Array(7).fill(0);
    const types = { vocal: 0, motor: 0, complex: 0 };

    events.forEach((e) => {
      const eventDateStr = new Date(e.timestamp).toDateString();
      const idx = last7Days.indexOf(eventDateStr);
      if (idx !== -1) weeklyCounts[idx]++;
      if (e.type === 'vocal') types.vocal++;
      else if (e.type === 'motor') types.motor++;
      else if (e.type === 'complex') types.complex++;
    });

    const totalCount = events.length;
    const vocalPct = totalCount ? Math.round((types.vocal / totalCount) * 100) : 0;
    const motorPct = totalCount ? Math.round((types.motor / totalCount) * 100) : 0;
    const complexPct = totalCount ? Math.round((types.complex / totalCount) * 100) : 0;

    return {
      total: totalCount,
      weeklyData: weeklyCounts,
      labels: displayLabels,
      typeStats: { vocalPct, motorPct, complexPct },
    };
  }, [events]);

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <GlassCard style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>총 발생 횟수 (누적)</Text>
          <Text style={styles.summaryValue}>{total}회</Text>
        </GlassCard>

        <Text style={styles.sectionTitle}>── 최근 7일 발생 빈도 ──</Text>
        
        <GlassCard style={styles.chartCard}>
          <BarChart data={weeklyData} labels={labels} />
        </GlassCard>

        <Text style={styles.sectionTitle}>── 주요 증상 통계 ──</Text>
        <GlassCard style={styles.statsCard}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>음성 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: `${typeStats.vocalPct}%`, backgroundColor: theme.colors.primaryLight }]} />
            </View>
            <Text style={styles.statValue}>{typeStats.vocalPct}%</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>운동 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: `${typeStats.motorPct}%`, backgroundColor: theme.colors.accent }]} />
            </View>
            <Text style={styles.statValue}>{typeStats.motorPct}%</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>복합 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: `${typeStats.complexPct}%`, backgroundColor: theme.colors.warning }]} />
            </View>
            <Text style={styles.statValue}>{typeStats.complexPct}%</Text>
          </View>
        </GlassCard>
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
    paddingBottom: 100,
  },
  summaryCard: {
    alignItems: 'center',
    marginBottom: theme.spacing.l,
    paddingVertical: theme.spacing.xl,
  },
  summaryTitle: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.s,
  },
  summaryValue: {
    ...theme.typography.h1,
    fontSize: 48,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.m,
  },
  trendContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.3)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.borderRadius.round,
  },
  trendDown: {
    ...theme.typography.body2,
    color: theme.colors.success,
    fontWeight: 'bold',
    marginRight: 6,
  },
  trendDesc: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.m,
    marginTop: theme.spacing.s,
  },
  chartCard: {
    marginBottom: theme.spacing.l,
    padding: theme.spacing.xs,
  },
  statsCard: {
    marginBottom: theme.spacing.xxl,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.m,
  },
  statLabel: {
    ...theme.typography.body2,
    color: theme.colors.textPrimary,
    width: 60,
  },
  barContainer: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderRadius: 4,
    marginHorizontal: theme.spacing.m,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 4,
  },
  statValue: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    width: 40,
    textAlign: 'right',
  },
});
