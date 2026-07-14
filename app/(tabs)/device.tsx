import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { AnimatedProgress } from '../../components/ui/AnimatedProgress';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { useEventStore } from '../../stores/useEventStore';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';

const TINT = {
  battery: { bg: 'rgba(0, 200, 120, 0.10)', fg: '#00A862' },
  storage: { bg: 'rgba(155, 89, 208, 0.10)', fg: theme.colors.primary },
  mic:     { bg: 'rgba(217, 70, 168, 0.10)', fg: theme.colors.accent },
  camera:  { bg: 'rgba(107, 63, 160, 0.10)', fg: theme.colors.primaryDark },
  temp:    { bg: 'rgba(255, 150, 0, 0.12)',  fg: '#E58A00' },
  pulse:   { bg: 'rgba(217, 70, 168, 0.10)', fg: theme.colors.accent },
  time:    { bg: 'rgba(155, 89, 208, 0.10)', fg: theme.colors.primary },
} as const;

export default function DeviceScreen() {
  const {
    isConnected,
    deviceName,
    battery,
    sdUsedPercent,
    temperature,
    camera,
    microphone,
    lastUpdated
  } = useDeviceStore();

  const events = useEventStore((state) => state.events);

  const today = new Date().toDateString();
  const tickCountToday = events.filter(
    (e) => new Date(e.timestamp).toDateString() === today,
  ).length;
  const lastEventTime = events.length > 0 ? events[0].timestamp : null;

  const formatLastUpdated = () => {
    if (!lastUpdated) return '기록 없음';
    const seconds = Math.floor((Date.now() - lastUpdated) / 1000);
    if (seconds < 60) return '방금 전';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
    return '1시간 초과';
  };

  const formatLastEventTime = () => {
    if (!lastEventTime) return '--';
    return new Date(lastEventTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  };

  const bannerBody = (
    <>
      <View style={s.bannerRow}>
        <View style={[s.deviceIconWrap, isConnected && s.deviceIconWrapOn]}>
          <Ionicons
            name="hardware-chip-outline"
            size={22}
            color={isConnected ? '#fff' : theme.colors.textSecondary}
          />
        </View>
        <View style={s.deviceInfo}>
          <Text style={[s.deviceName, isConnected && s.textOnGradient]}>
            {deviceName || 'DeFoTic Device'}
          </Text>
          <View style={s.statusRow}>
            <View style={[s.dot, !isConnected && s.dotOff]} />
            <Text style={[s.statusText, isConnected ? s.statusTextOn : s.statusTextOff]}>
              {isConnected ? '연결됨 · 실시간 감지 중' : '연결 안 됨'}
            </Text>
          </View>
        </View>
      </View>
      <Text style={[s.bannerDesc, isConnected && s.textOnGradientMuted]}>
        상태 업데이트: {formatLastUpdated()} · 자동으로 동기화됩니다
      </Text>
    </>
  );

  return (
    <GradientBackground>
      <ScrollView style={s.root} contentContainerStyle={s.content}>
        {/* ── 타이틀 ── */}
        <Text style={s.title}>기기 상태</Text>

        {/* ── 기기 배너 ── */}
        {isConnected ? (
          <LinearGradient
            colors={theme.gradients.button}
            start={{ x: 0, y: 0 }}
            end={{ x: 1.2, y: 1.2 }}
            style={[s.banner, s.bannerOn]}
          >
            {bannerBody}
          </LinearGradient>
        ) : (
          <View style={s.banner}>{bannerBody}</View>
        )}

        {/* ── 전원 및 저장 공간 ── */}
        <Text style={s.section}>전원 및 저장 공간</Text>
        <View style={[s.card, !isConnected && s.cardDisabled]}>
          <View style={s.metricHeader}>
            <View style={s.metricLeft}>
              <IconChip icon="battery-half-outline" tint={TINT.battery} />
              <Text style={s.metricLabel}>배터리</Text>
            </View>
            <Text style={s.metricValue}>{battery !== null ? `${battery}%` : '--'}</Text>
          </View>
          <AnimatedProgress progress={(battery || 0) / 100} color={(battery || 0) > 20 ? TINT.battery.fg : theme.colors.error} />

          <View style={[s.metricHeader, { marginTop: 20 }]}>
            <View style={s.metricLeft}>
              <IconChip icon="save-outline" tint={TINT.storage} />
              <Text style={s.metricLabel}>SD카드 사용량</Text>
            </View>
            <Text style={s.metricValue}>{sdUsedPercent !== null ? `${sdUsedPercent}%` : '--'}</Text>
          </View>
          <AnimatedProgress progress={(sdUsedPercent || 0) / 100} color={(sdUsedPercent || 0) < 90 ? theme.colors.primary : theme.colors.error} />
        </View>

        {/* ── 센서 상태 ── */}
        <Text style={s.section}>센서 상태</Text>
        <View style={[s.card, !isConnected && s.cardDisabled]}>
          <SensorRow icon="mic-outline" tint={TINT.mic} label="마이크" active={microphone} />
          <SensorRow icon="camera-outline" tint={TINT.camera} label="카메라" active={camera} />
          <View style={[s.row, s.rowLast]}>
            <View style={s.metricLeft}>
              <IconChip icon="thermometer-outline" tint={TINT.temp} />
              <Text style={s.metricLabel}>온도</Text>
            </View>
            <Text style={s.rowValue}>{temperature !== null ? `${temperature}°C` : '--'}</Text>
          </View>
        </View>

        {/* ── 이벤트 현황 ── */}
        <Text style={s.section}>이벤트 현황</Text>
        <View style={[s.card, !isConnected && s.cardDisabled]}>
          <View style={s.row}>
            <View style={s.metricLeft}>
              <IconChip icon="pulse-outline" tint={TINT.pulse} />
              <Text style={s.metricLabel}>오늘 감지 횟수</Text>
            </View>
            <Text style={s.metricValue}>{tickCountToday > 0 ? `${tickCountToday}회` : '--'}</Text>
          </View>
          <View style={[s.row, s.rowLast]}>
            <View style={s.metricLeft}>
              <IconChip icon="time-outline" tint={TINT.time} />
              <Text style={s.metricLabel}>마지막 이벤트</Text>
            </View>
            <Text style={s.rowValue}>{formatLastEventTime()}</Text>
          </View>
        </View>
      </ScrollView>
    </GradientBackground>
  );
}

function IconChip({
  icon,
  tint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: { bg: string; fg: string };
}) {
  return (
    <View style={[s.iconWrap, { backgroundColor: tint.bg }]}>
      <Ionicons name={icon} size={17} color={tint.fg} />
    </View>
  );
}

function SensorRow({
  icon,
  tint,
  label,
  active,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: { bg: string; fg: string };
  label: string;
  active: boolean | null;
}) {
  return (
    <View style={s.row}>
      <View style={s.metricLeft}>
        <IconChip icon={icon} tint={tint} />
        <Text style={s.metricLabel}>{label}</Text>
      </View>
      <View style={s.sensorState}>
        <View style={[s.dot, !active && s.dotOff]} />
        <Text style={[s.sensorText, !active && s.sensorTextOff]}>
          {active ? '활성' : '비활성'}
        </Text>
      </View>
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

  // ── 기기 배너 ──
  banner: {
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  bannerOn: {
    borderWidth: 0,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  deviceIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  deviceIconWrapOn: {
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 17,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 3,
  },
  textOnGradient: {
    color: '#fff',
  },
  textOnGradientMuted: {
    color: 'rgba(255,255,255,0.75)',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusText: {
    fontSize: 13,
    marginLeft: 5,
  },
  statusTextOn: {
    color: 'rgba(255,255,255,0.9)',
    fontWeight: '600',
  },
  statusTextOff: {
    color: theme.colors.textSecondary,
  },
  bannerDesc: {
    fontSize: 12,
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

  // ── 카드 ──
  card: {
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  cardDisabled: {
    opacity: 0.5,
  },

  // ── 메트릭 (프로그레스 포함) ──
  metricHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  metricLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  metricLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.textPrimary,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },

  // ── 일반 행 ──
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.6)',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowValue: {
    fontSize: 14,
    color: theme.colors.textSecondary,
  },

  // ── 센서 상태 ──
  sensorState: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sensorText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.primary,
    marginLeft: 5,
  },
  sensorTextOff: {
    color: theme.colors.textSecondary,
    fontWeight: '400',
  },

  // ── 상태 점 ──
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.success,
  },
  dotOff: {
    backgroundColor: theme.colors.textSecondary,
  },
});
