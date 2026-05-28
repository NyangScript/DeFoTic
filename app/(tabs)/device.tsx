import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { GradientButton } from '../../components/ui/GradientButton';
import { AnimatedProgress } from '../../components/ui/AnimatedProgress';
import { deviceMonitor } from '../../services/ble/DeviceMonitor';
import { deviceSync } from '../../services/ble/DeviceSync';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';

export default function DeviceScreen() {
  const [batteryLevel, setBatteryLevel] = useState(78);
  const [storageUsage, setStorageUsage] = useState(62);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('5분 전');

  useEffect(() => {
    deviceMonitor.subscribeToStatus((status) => {
      if (status.batteryLevel !== undefined) setBatteryLevel(status.batteryLevel);
      if (status.storageUsage !== undefined) setStorageUsage(status.storageUsage);
    });

    return () => {
      deviceMonitor.unsubscribe();
    };
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await deviceSync.syncData();
      setLastSync('방금 전');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <GlassCard style={styles.statusCard}>
          <View style={styles.deviceHeader}>
            <Ionicons name="hardware-chip" size={40} color={theme.colors.primaryDark} />
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceName}>Device-01</Text>
              <View style={styles.connectionStatus}>
                <View style={styles.dotConnected} />
                <Text style={styles.connectedText}>연결됨</Text>
              </View>
            </View>
          </View>
        </GlassCard>

        <GlassCard style={styles.metricsCard}>
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>🔋 배터리</Text>
            <Text style={styles.metricValue}>{batteryLevel}%</Text>
          </View>
          <AnimatedProgress progress={batteryLevel / 100} color={batteryLevel > 20 ? theme.colors.success : theme.colors.error} />

          <View style={[styles.metricRow, { marginTop: theme.spacing.l }]}>
            <Text style={styles.metricLabel}>💾 SD카드</Text>
            <Text style={styles.metricValue}>{storageUsage}%</Text>
          </View>
          <AnimatedProgress progress={storageUsage / 100} color={storageUsage < 90 ? theme.colors.accent : theme.colors.error} />
        </GlassCard>

        <GlassCard style={styles.sensorCard}>
          <Text style={styles.sectionTitle}>── 센서 상태 ──</Text>
          
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>🎤 마이크</Text>
            <Text style={styles.sensorActive}>● 활성</Text>
          </View>
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>📷 카메라</Text>
            <Text style={styles.sensorActive}>● 활성</Text>
          </View>
          <View style={styles.sensorRow}>
            <Text style={styles.sensorName}>🌡 온도</Text>
            <Text style={styles.sensorValue}>32.5°C</Text>
          </View>
        </GlassCard>

        <View style={styles.syncContainer}>
          <Text style={styles.syncText}>마지막 동기화: {lastSync}</Text>
          <GradientButton 
            title="동기화 시작 ▶" 
            onPress={handleSync} 
            loading={isSyncing}
          />
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
  connectedText: {
    ...theme.typography.caption,
    color: theme.colors.success,
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
  sensorValue: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
  },
  syncContainer: {
    marginTop: theme.spacing.m,
    marginBottom: theme.spacing.xxl,
    alignItems: 'center',
  },
  syncText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.m,
  },
});
