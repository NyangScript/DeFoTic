import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { useEventStore } from '../../stores/useEventStore';

export default function MainHubScreen() {
  const router = useRouter();
  const { isConnected, deviceName } = useDeviceStore();
  const events = useEventStore((state) => state.events);

  const today = new Date().toDateString();
  const todayEventsCount = events.filter(
    (e) => new Date(e.timestamp).toDateString() === today,
  ).length;
  const pendingCount = events.filter(e => e.transferStatus === 'pending_media').length;
  const analyzedCount = events.filter(e => e.analysisStatus === 'completed').length;

  return (
    <GradientBackground>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        {/* ── 타이틀 ── */}
        <Text style={s.title}>DeFoTic</Text>

        {/* ── 연결 상태 카드 (탭 → 기기 연결 화면) ── */}
        <TouchableOpacity activeOpacity={0.7} onPress={() => router.push('/pairing')}>
          <View style={s.connectCard}>
            <View style={[s.connectIconWrap, isConnected && s.connectIconWrapOn]}>
              <Ionicons
                name="bluetooth"
                size={20}
                color={isConnected ? '#fff' : theme.colors.textSecondary}
              />
            </View>
            <View style={s.connectInfo}>
              <View style={s.connectTitleRow}>
                <Text style={[s.connectTitle, !isConnected && s.connectTitleOff]}>
                  {isConnected ? '연결됨' : '연결 안 됨'}
                </Text>
                <View style={[s.dot, !isConnected && s.dotOff]} />
              </View>
              <Text style={s.connectDesc} numberOfLines={1}>
                {isConnected
                  ? `${deviceName || 'DeFoTic Device'} · 실시간 감지 중`
                  : '탭하여 DeFoTic 기기 연결하기'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
          </View>
        </TouchableOpacity>

        {/* ── 히어로: 오늘의 감지 ── */}
        <LinearGradient
          colors={theme.gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1.2, y: 1.2 }}
          style={s.hero}
        >
          <View style={s.heroTop}>
            <Text style={s.heroLabel}>오늘 감지된 틱</Text>
            <View style={s.heroIconWrap}>
              <Ionicons name="pulse" size={18} color="#fff" />
            </View>
          </View>
          <View style={s.heroValueRow}>
            <Text style={s.heroValue}>{todayEventsCount}</Text>
            <Text style={s.heroUnit}>회</Text>
          </View>
          <View style={s.heroFooter}>
            <View style={s.heroChip}>
              <Ionicons name="cloud-upload-outline" size={12} color="#fff" />
              <Text style={s.heroChipText}>동기화 대기 {pendingCount}건</Text>
            </View>
            <View style={s.heroChip}>
              <Ionicons name="sparkles-outline" size={12} color="#fff" />
              <Text style={s.heroChipText}>분석 완료 {analyzedCount}건</Text>
            </View>
          </View>
        </LinearGradient>

        {/* ── 요약 ── */}
        <View style={s.summaryRow}>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(217, 70, 168, 0.10)' }]}>
              <Ionicons name="albums-outline" size={16} color={theme.colors.accent} />
            </View>
            <Text style={s.summaryValue}>{events.length}</Text>
            <Text style={s.summaryLabel}>누적 기록</Text>
          </View>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(155, 89, 208, 0.10)' }]}>
              <Ionicons name="cloud-upload-outline" size={16} color={theme.colors.primary} />
            </View>
            <Text style={s.summaryValue}>{pendingCount}</Text>
            <Text style={s.summaryLabel}>동기화 대기</Text>
          </View>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(0, 200, 120, 0.10)' }]}>
              <Ionicons name="sparkles-outline" size={16} color="#00A862" />
            </View>
            <Text style={s.summaryValue}>{analyzedCount}</Text>
            <Text style={s.summaryLabel}>분석 완료</Text>
          </View>
        </View>

        {/* ── 바로가기 ── */}
        <Text style={s.section}>바로가기</Text>

        <NavRow
          icon="hardware-chip-outline"
          tint="rgba(155, 89, 208, 0.10)"
          color={theme.colors.primaryDark}
          title="기기 상태"
          desc={isConnected ? '배터리 · 저장 공간 · 센서 모니터링' : '기기를 연결하면 상태가 표시됩니다'}
          onPress={() => router.push('/(tabs)/device')}
        />
        <NavRow
          icon="stats-chart-outline"
          tint="rgba(217, 70, 168, 0.10)"
          color={theme.colors.accent}
          title="데이터 기록"
          desc="주간 발생 빈도와 증상 통계"
          onPress={() => router.push('/(tabs)/record')}
        />
        <NavRow
          icon="analytics-outline"
          tint="rgba(0, 200, 120, 0.10)"
          color="#00A862"
          title="데이터 분석"
          desc={pendingCount > 0 ? `동기화 대기 ${pendingCount}건 · AI 상황 분석` : 'AI 상황 분석 결과 보기'}
          onPress={() => router.push('/(tabs)/analysis')}
        />
      </ScrollView>
    </GradientBackground>
  );
}

function NavRow({
  icon,
  tint,
  color,
  title,
  desc,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  color: string;
  title: string;
  desc: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity activeOpacity={0.65} onPress={onPress}>
      <View style={s.card}>
        <View style={[s.iconWrap, { backgroundColor: tint }]}>
          <Ionicons name={icon} size={20} color={color} />
        </View>
        <View style={s.cardInfo}>
          <Text style={s.cardTitle}>{title}</Text>
          <Text style={s.cardDesc} numberOfLines={1}>{desc}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
      </View>
    </TouchableOpacity>
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

  // ── 연결 상태 카드 ──
  connectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  connectIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  connectIconWrapOn: {
    backgroundColor: theme.colors.primary,
  },
  connectInfo: {
    flex: 1,
    marginRight: 8,
  },
  connectTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  connectTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    marginRight: 6,
  },
  connectTitleOff: {
    color: theme.colors.textPrimary,
  },
  connectDesc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.success,
  },
  dotOff: {
    backgroundColor: theme.colors.error,
  },

  // ── 히어로 ──
  hero: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 12,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
  },
  heroIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 6,
    marginBottom: 14,
  },
  heroValue: {
    fontSize: 44,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 48,
  },
  heroUnit: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    marginLeft: 4,
    marginBottom: 6,
  },
  heroFooter: {
    flexDirection: 'row',
    gap: 8,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 4,
  },
  heroChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },

  // ── 요약 카드 ──
  summaryRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  summaryIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  summaryLabel: {
    fontSize: 11,
    color: theme.colors.textSecondary,
  },

  // ── 섹션 ──
  section: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    marginBottom: 10,
    marginLeft: 2,
  },

  // ── 바로가기 카드 ──
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardInfo: {
    flex: 1,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  cardDesc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
});
