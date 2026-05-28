import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { BarChart } from '../../components/charts/BarChart';
import { GradientBackground } from '../../components/ui/GradientBackground';

export default function RecordScreen() {
  const mockWeeklyData = [5, 8, 12, 7, 4, 9, 6];
  const labels = ['월', '화', '수', '목', '금', '토', '일'];

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <GlassCard style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>주간 총 발생 횟수</Text>
          <Text style={styles.summaryValue}>51회</Text>
          <View style={styles.trendContainer}>
            <Text style={styles.trendDown}>▼ 12% 감소</Text>
            <Text style={styles.trendDesc}>지난주 대비</Text>
          </View>
        </GlassCard>

        <Text style={styles.sectionTitle}>── 시간대별 발생 빈도 ──</Text>
        
        <GlassCard style={styles.chartCard}>
          <BarChart data={mockWeeklyData} labels={labels} />
        </GlassCard>

        <Text style={styles.sectionTitle}>── 주요 증상 통계 ──</Text>
        <GlassCard style={styles.statsCard}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>음성 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: '45%', backgroundColor: theme.colors.primaryLight }]} />
            </View>
            <Text style={styles.statValue}>45%</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>운동 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: '35%', backgroundColor: theme.colors.accent }]} />
            </View>
            <Text style={styles.statValue}>35%</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>복합 틱</Text>
            <View style={styles.barContainer}>
              <View style={[styles.bar, { width: '20%', backgroundColor: theme.colors.warning }]} />
            </View>
            <Text style={styles.statValue}>20%</Text>
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
