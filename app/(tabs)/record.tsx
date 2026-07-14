import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { BarChart } from '../../components/charts/BarChart';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useEventStore } from '../../stores/useEventStore';
import { Ionicons } from '@expo/vector-icons';

export default function RecordScreen() {
  const events = useEventStore((state) => state.events);

  const { total, todayCount, weeklyData, labels, typeStats, vulnerableWindow, recentEvents } = useMemo(() => {
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

    // ── 취약 시간대: 시간별 히스토그램에서 발생이 가장 잦은 2시간 구간 ──
    const hourly = new Array(24).fill(0);
    events.forEach((e) => {
      hourly[new Date(e.timestamp).getHours()]++;
    });
    let bestStart = -1;
    let bestSum = 0;
    for (let h = 0; h <= 22; h++) {
      const sum = hourly[h] + hourly[h + 1];
      if (sum > bestSum) {
        bestSum = sum;
        bestStart = h;
      }
    }
    const window =
      bestSum > 0
        ? `${String(bestStart).padStart(2, '0')}:00 ~ ${String(bestStart + 2).padStart(2, '0')}:00`
        : null;

    // ── 최근 기록: 실제 수신 타임스탬프 기준 최신 5건 ──
    const recent = events
      .slice()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 5);

    return {
      total: totalCount,
      todayCount: weeklyCounts[6],
      weeklyData: weeklyCounts,
      labels: displayLabels,
      typeStats: { vocalPct, motorPct, complexPct },
      vulnerableWindow: window,
      recentEvents: recent,
    };
  }, [events]);

  return (
    <GradientBackground>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        {/* ── 타이틀 ── */}
        <Text style={s.title}>데이터 기록</Text>

        {/* ── 요약 배너 ── */}
        <LinearGradient
          colors={theme.gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1.2, y: 1.2 }}
          style={s.banner}
        >
          <View style={s.bannerRow}>
            <View style={s.bannerHalf}>
              <View style={s.bannerIconWrap}>
                <Ionicons name="pulse" size={18} color="#fff" />
              </View>
              <View>
                <Text style={s.bannerValue}>{todayCount}회</Text>
                <Text style={s.bannerLabel}>오늘 발생</Text>
              </View>
            </View>
            <View style={s.bannerDivider} />
            <View style={s.bannerHalf}>
              <View style={s.bannerIconWrap}>
                <Ionicons name="albums" size={18} color="#fff" />
              </View>
              <View>
                <Text style={s.bannerValue}>{total}회</Text>
                <Text style={s.bannerLabel}>누적 발생</Text>
              </View>
            </View>
          </View>

          <View style={s.bannerFooter}>
            <Ionicons name="alarm-outline" size={13} color="rgba(255,255,255,0.9)" />
            <Text style={s.bannerFooterText}>
              {vulnerableWindow
                ? `취약 시간대 ${vulnerableWindow}`
                : '취약 시간대 분석을 위한 데이터가 아직 부족합니다'}
            </Text>
          </View>
        </LinearGradient>

        {/* ── 최근 7일 발생 빈도 ── */}
        <Text style={s.section}>최근 7일 발생 빈도</Text>
        <View style={s.card}>
          <BarChart data={weeklyData} labels={labels} />
        </View>

        {/* ── 주요 증상 통계 ── */}
        <Text style={s.section}>주요 증상 통계</Text>
        <View style={s.card}>
          <StatRow label="음성 틱" pct={typeStats.vocalPct} color={theme.colors.primary} />
          <StatRow label="운동 틱" pct={typeStats.motorPct} color={theme.colors.accent} />
          <StatRow label="복합 틱" pct={typeStats.complexPct} color={theme.colors.warning} last />
        </View>

        {/* ── 최근 기록 ── */}
        <Text style={s.section}>최근 기록</Text>
        <View style={s.card}>
          {recentEvents.length === 0 ? (
            <Text style={s.emptyText}>아직 기록된 이벤트가 없습니다.</Text>
          ) : (
            recentEvents.map((e, idx) => (
              <View
                key={e.id}
                style={[s.recentRow, idx === recentEvents.length - 1 && s.recentRowLast]}
              >
                <View style={s.recentIconWrap}>
                  <Ionicons name="pulse-outline" size={16} color={theme.colors.primaryDark} />
                </View>
                <View style={s.recentInfo}>
                  <Text style={s.recentTime}>{formatEventTime(e.timestamp)}</Text>
                  <Text style={s.recentDesc}>{eventStatusLabel(e)}</Text>
                </View>
                <Ionicons
                  name={e.analysisStatus === 'completed' ? 'checkmark-circle' : 'time-outline'}
                  size={16}
                  color={e.analysisStatus === 'completed' ? theme.colors.primary : theme.colors.textSecondary}
                />
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </GradientBackground>
  );
}

function formatEventTime(timestamp: string) {
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function eventStatusLabel(e: { transferStatus?: string; analysisStatus?: string; type: string }) {
  const typeLabel = e.type === 'vocal' ? '음성 틱' : e.type === 'motor' ? '운동 틱' : '복합 틱';
  if (e.transferStatus === 'pending_media') return `${typeLabel} · 미디어 동기화 대기`;
  if (e.analysisStatus === 'analyzing') return `${typeLabel} · AI 분석 중`;
  if (e.analysisStatus === 'completed') return `${typeLabel} · 분석 완료`;
  if (e.analysisStatus === 'failed') return `${typeLabel} · 분석 실패`;
  return `${typeLabel} · 동기화됨`;
}

function StatRow({
  label,
  pct,
  color,
  last,
}: {
  label: string;
  pct: number;
  color: string;
  last?: boolean;
}) {
  return (
    <View style={[s.statRow, last && { marginBottom: 0 }]}>
      <Text style={s.statLabel}>{label}</Text>
      <View style={s.barContainer}>
        <View style={[s.bar, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={s.statValue}>{pct}%</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 100,
  },

  title: {
    fontSize: 26,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 16,
  },

  // ── 요약 배너 ──
  banner: {
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255,255,255,0.35)',
  },
  bannerFooterText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.92)',
  },
  bannerHalf: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.20)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  bannerValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
  },
  bannerLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 1,
  },
  bannerDivider: {
    width: 0.5,
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.35)',
    marginHorizontal: 12,
  },

  // ── 섹션 ──
  section: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    marginBottom: 10,
    marginLeft: 2,
  },

  // ── 카드 ──
  card: {
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },

  // ── 증상 통계 행 ──
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  statLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.textPrimary,
    width: 60,
  },
  barContainer: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 4,
    marginHorizontal: 12,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 4,
  },
  statValue: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    width: 40,
    textAlign: 'right',
  },

  // ── 최근 기록 ──
  emptyText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    paddingVertical: 8,
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.6)',
  },
  recentRowLast: {
    borderBottomWidth: 0,
  },
  recentIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  recentInfo: {
    flex: 1,
    marginRight: 8,
  },
  recentTime: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 1,
  },
  recentDesc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
});
