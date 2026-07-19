import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../constants/theme';
import { GlassCard } from '../../components/ui/GlassCard';
import { GradientButton } from '../../components/ui/GradientButton';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { Ionicons } from '@expo/vector-icons';

/**
 * 의료진 랜딩 — 웹 진입점의 기본 화면.
 *
 * 주치의가 브라우저에서 환자 식별 코드(6자리, 환자 앱 홈의 "의료진 공유
 * 코드" 카드에 표시)를 입력하면 상세 분석 화면으로 이동한다. URL
 * `/doctor/analysis/{코드}`를 직접 열면 이 화면을 거치지 않고 바로
 * 열람된다(북마크/공유 플로우).
 *
 * 모바일 앱에서도 라우트 자체는 유효하다(로컬 미리보기 모드) — 웹 전용
 * 강제는 진입점(index.web.tsx)과 환자용 화면들의 웹 가드가 담당하고,
 * 이 화면은 플랫폼 중립으로 둔다.
 */
export default function DoctorLandingScreen() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = () => {
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError('환자 식별 코드는 6자리 숫자입니다.');
      return;
    }
    setError('');
    router.push(`/doctor/analysis/${trimmed}`);
  };

  return (
    <GradientBackground style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardArea}
      >
        <View style={styles.brandRow}>
          <Image source={require('../../assets/logo.png')} style={styles.logoIcon} />
          <View>
            <Text style={styles.brandTitle}>DeFoTic</Text>
            <Text style={styles.brandSubtitle}>의료진 대시보드</Text>
          </View>
        </View>

        <GlassCard style={styles.card}>
          <Text style={styles.title}>환자 데이터 열람</Text>
          <Text style={styles.subtitle}>
            환자 앱 홈 화면의 "의료진 공유 코드" 6자리를 입력해주세요.
          </Text>

          <TextInput
            style={styles.input}
            placeholder="환자 식별 코드 (예: 123456)"
            placeholderTextColor={theme.colors.textSecondary}
            value={code}
            onChangeText={setCode}
            keyboardType="numeric"
            maxLength={6}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <GradientButton title="데이터 열람" onPress={handleSubmit} />

          <View style={styles.hintRow}>
            <Ionicons
              name="shield-checkmark-outline"
              size={14}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.hintText}>
              열람 데이터는 이벤트 메타데이터와 AI 분석 결과입니다. 영상/음성
              원본은 환자 기기 밖으로 업로드되지 않습니다.
            </Text>
          </View>
        </GlassCard>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.m,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.m,
    marginBottom: theme.spacing.xl,
  },
  logoIcon: {
    // 실제 앱 로고 (assets/logo.png — 라운드 코너가 이미지에 포함됨)
    width: 56,
    height: 56,
    borderRadius: 13,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  brandTitle: {
    ...theme.typography.h2,
    color: theme.colors.textPrimary,
  },
  brandSubtitle: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: theme.spacing.xl,
  },
  title: {
    ...theme.typography.h2,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.s,
    textAlign: 'center',
  },
  subtitle: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.l,
    textAlign: 'center',
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: theme.colors.glassBorder,
    borderRadius: theme.borderRadius.s,
    padding: theme.spacing.m,
    color: theme.colors.textPrimary,
    ...theme.typography.body1,
    marginBottom: theme.spacing.s,
    textAlign: 'center',
    letterSpacing: 4,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    marginBottom: theme.spacing.s,
    textAlign: 'center',
  },
  hintRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: theme.spacing.l,
    alignItems: 'flex-start',
  },
  hintText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textSecondary,
  },
});
