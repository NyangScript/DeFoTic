import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { AnimatedProgress } from '../../components/ui/AnimatedProgress';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { useEventStore } from '../../stores/useEventStore';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';

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

  const todayEvents = events.filter((e) => {
    const eventDate = new Date(e.timestamp);
    const today = new Date();
    return eventDate.toDateString() === today.toDateString();
  });
  const tickCountToday = todayEvents.length;
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
    // lastEventTime from HW is millis() timestamp (seconds via payload)
    if (typeof lastEventTime === 'number' || /^\d+$/.test(lastEventTime)) {
      const ms = Number(lastEventTime);
      if (ms === 0) return '--';
      const d = new Date(ms > 1e12 ? ms : ms * 1000);
      return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    }
    // ISO string format
    return new Date(lastEventTime).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <GlassCard style={styles.statusCard}>
          <View style={styles.deviceHeader}>
            <Ionicons name="hardware-chip" size={40} color={isConnected ? theme.colors.primaryDark : theme.colors.textSecondary} />
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceName}>{deviceName || 'DeFoTic Device'}</Text>
              <View style={styles.connectionStatus}>
                <View style={[styles.dotConnected, !isConnected && styles.dotDisconnected]} />
                <Text style={[styles.connectedText, !isConnected && styles.disconnectedText]}>
                  {isConnected ? '연결됨' : '연결 안 됨'}
                </Text>
              </View>
            </View>
          </View>
        </GlassCard>

        <GlassCard style={[styles.metricsCard, !isConnected && styles.cardDisabled]}>
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>🔋 배터리</Text>
            <Text style={styles.metricValue}>{battery !== null ? `${battery}%` : '--'}</Text>
          </View>
          <AnimatedProgress progress={(battery || 0) / 100} color={(battery || 0) > 20 ? theme.colors.success : theme.colors.error} />

          <View style={[styles.metricRow, { marginTop: theme.spacing.l }]}>
            <Text style={styles.metricLabel}>💾 SD카드 사용량</Text>
            <Text style={styles.metricValue}>{sdUsedPercent !== null ? `${sdUsedPercent}%` : '--'}</Text>
          </View>
          <AnimatedProgress progress={(sdUsedPercent || 0) / 100} color={(sdUsedPercent || 0) < 90 ? theme.colors.accent : theme.colors.error} />
        </GlassCard>

        <GlassCard style={[styles.sensorCard, !isConnected && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>── 센서 상태 ──</Text>
          
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>🎤 마이크</Text>
            <Text style={[styles.sensorActive, !microphone && styles.sensorInactive]}>
              {microphone ? '● 활성' : '○ 비활성'}
            </Text>
          </View>
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>📷 카메라</Text>
            <Text style={[styles.sensorActive, !camera && styles.sensorInactive]}>
              {camera ? '● 활성' : '○ 비활성'}
            </Text>
          </View>
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>🌡 온도</Text>
            <Text style={styles.sensorValue}>{temperature !== null ? `${temperature}°C` : '--'}</Text>
          </View>
        </GlassCard>

        <GlassCard style={[styles.eventStatsCard, !isConnected && styles.cardDisabled]}>
          <Text style={styles.sectionTitle}>── 이벤트 현황 ──</Text>
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>📊 오늘 감지 횟수</Text>
            <Text style={styles.metricValue}>{tickCountToday > 0 ? `${tickCountToday}회` : '--'}</Text>
          </View>
          <View style={[styles.sensorRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.sensorName}>🕐 마지막 이벤트</Text>
            <Text style={styles.sensorValue}>{formatLastEventTime()}</Text>
          </View>
        </GlassCard>

        <View style={styles.syncContainer}>
          <Text style={styles.syncText}>상태 업데이트: {formatLastUpdated()}</Text>
          <Text style={styles.syncDesc}>자동으로 데이터가 동기화됩니다.</Text>
        </View>
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
    paddingBottom: 100, // 탭바 영역
  },
  statusCard: {
    marginBottom: theme.spacing.m,
  },
  deviceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  deviceInfo: {
    marginLeft: theme.spacing.m,
  },
  deviceName: {
    ...theme.typography.h2,
    color: theme.colors.textPrimary,
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  dotConnected: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.success,
    marginRight: 6,
  },
  dotDisconnected: {
    backgroundColor: theme.colors.error,
  },
  connectedText: {
    ...theme.typography.caption,
    color: theme.colors.success,
  },
  disconnectedText: {
    color: theme.colors.error,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  metricsCard: {
    marginBottom: theme.spacing.m,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.s,
  },
  metricLabel: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
  },
  metricValue: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
    fontWeight: 'bold',
  },
  sensorCard: {
    marginBottom: theme.spacing.m,
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.m,
  },
  sensorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing.s,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.glassBorder,
  },
  sensorName: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
  },
  sensorActive: {
    ...theme.typography.body1,
    color: theme.colors.success,
    fontWeight: 'bold',
  },
  sensorInactive: {
    color: theme.colors.textSecondary,
    fontWeight: 'normal',
  },
  sensorValue: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
  },
  eventStatsCard: {
    marginBottom: theme.spacing.m,
  },
  syncContainer: {
    marginTop: theme.spacing.m,
    marginBottom: theme.spacing.xxl,
    alignItems: 'center',
  },
  syncText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    marginBottom: 4,
  },
  syncDesc: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    opacity: 0.7,
  },
});
