import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';

export default function MainHubScreen() {
  const router = useRouter();

  return (
    <GradientBackground style={styles.container}>
      <Text style={styles.title}>DeFoTic</Text>
      <Text style={styles.subtitle}>오늘의 요약</Text>

      <View style={styles.cardsContainer}>
        <TouchableOpacity activeOpacity={0.8} onPress={() => router.push('/(tabs)/device')}>
          <GlassCard style={styles.navCard}>
            <View style={styles.cardHeader}>
              <Ionicons name="hardware-chip" size={24} color={theme.colors.primaryDark} />
              <Text style={styles.cardDirection}>▲ 상단</Text>
            </View>
            <Text style={styles.cardTitle}>기기 상태</Text>
            <Text style={styles.cardValue}>Device-01 연결됨</Text>
          </GlassCard>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} onPress={() => router.push('/(tabs)/record')}>
          <GlassCard style={styles.navCard}>
            <View style={styles.cardHeader}>
              <Ionicons name="stats-chart" size={24} color={theme.colors.accent} />
              <Text style={styles.cardDirection}>▼ 하단</Text>
            </View>
            <Text style={styles.cardTitle}>데이터 기록</Text>
            <Text style={styles.cardValue}>오늘 12건 감지</Text>
          </GlassCard>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} onPress={() => router.push('/(tabs)/analysis')}>
          <GlassCard style={styles.navCard}>
            <View style={styles.cardHeader}>
              <Ionicons name="analytics" size={24} color={theme.colors.success} />
              <Text style={styles.cardDirection}>▶ 우측</Text>
            </View>
            <Text style={styles.cardTitle}>데이터 분석</Text>
            <Text style={styles.cardValue}>AI 상황분석 보기</Text>
          </GlassCard>
        </TouchableOpacity>
      </View>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: theme.spacing.l,
    paddingTop: theme.spacing.xxl,
  },
  title: {
    ...theme.typography.h1,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },
  subtitle: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  cardsContainer: {
    flex: 1,
    gap: theme.spacing.l,
  },
  navCard: {
    padding: theme.spacing.l,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.s,
  },
  cardDirection: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  cardTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    marginBottom: 4,
  },
  cardValue: {
    ...theme.typography.body2,
    color: theme.colors.primaryDark,
    fontWeight: '600',
  },
});
