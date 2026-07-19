import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { GradientButton } from '../components/ui/GradientButton';
import { theme } from '../constants/theme';
import { GradientBackground } from '../components/ui/GradientBackground';
import { Ionicons } from '@expo/vector-icons';
import { bleManager } from '../services/ble/BleManager';
import { useDeviceStore } from '../stores/useDeviceStore';
import { profileStore } from '../services/data/ProfileStore';
import { firebaseSync } from '../services/cloud/FirebaseSync';

export default function LoginScreen() {
  // 웹 = 의료진 전용: 환자용 온보딩(로그인)은 모바일 전용 동선이다.
  if (Platform.OS === 'web') {
    return <Redirect href="/doctor" />;
  }

  const router = useRouter();
  const { deviceName } = useDeviceStore();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({ name: '' });

  // ── 환자 식별 코드: 수동 입력이 아니라 '자동 발급 + 표시'다 ──
  // 코드의 단일 소유자는 FirebaseSync.getPatientCode() — 온보딩 시점에
  // 발급해 보여주고, "시작하기"에서 DB 클레임(전역 유일성 확정)까지 건다.
  // 사용자 임의 입력을 받으면 실제 공유 코드(홈 카드)와 무관한 코드를
  // 의사에게 알려주게 되는 오해가 생기므로 입력 UI를 두지 않는다.
  const [patientCode, setPatientCode] = useState<string | null>(null);
  useEffect(() => {
    firebaseSync.getPatientCode().then(setPatientCode).catch(() => {});
    // 클레임 충돌로 코드가 재생성되면 화면 표시를 즉시 갱신 (스테일 코드 안내 방지)
    return firebaseSync.onPatientCodeChanged(setPatientCode);
  }, []);

  const validate = () => {
    if (!name.trim()) {
      setErrors({ name: '이름을 입력해주세요.' });
      return false;
    }
    setErrors({ name: '' });
    return true;
  };

  const handleLogin = async () => {
    if (!validate() || loading) return;

    setLoading(true);
    try {
      // 1. 로컬 온보딩 확정 — 다음 실행부터 이 화면을 건너뛴다 (자동 로그인)
      await profileStore.save(name);

      // 2. 클라우드 프로필 등록 + 코드 유일성 클레임 (오프라인이면 무해 실패 —
      //    첫 이벤트 업로드 때 ensureClaimedCode가 재시도한다)
      firebaseSync
        .registerPatientProfile(name.trim())
        .catch(e => console.warn('[Login] cloud profile registration deferred:', e?.message || e));

      router.replace('/(tabs)');
    } catch (e) {
      console.error('[Login] onboarding save failed:', e);
      setErrors({ name: '저장에 실패했습니다. 다시 시도해주세요.' });
    } finally {
      setLoading(false);
    }
  };

  const handleBack = async () => {
    await bleManager.disconnectDevice();
    // 온보딩 플로우는 replace로 진입해 백스택이 없다 → 페어링 화면으로 replace 복귀
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/pairing');
    }
  };

  return (
    <GradientBackground>
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={s.scrollContent}>
          {/* ── 헤더 ── */}
          <TouchableOpacity style={s.backBtn} onPress={handleBack}>
            <Ionicons name="arrow-back" size={22} color={theme.colors.textPrimary} />
          </TouchableOpacity>

          <Text style={s.title}>환자 정보 등록</Text>
          <Text style={s.subtitle}>데이터를 관리하고 의료진과 공유하세요</Text>

          {/* ── 연결된 기기 표시 ── */}
          <View style={s.deviceChip}>
            <View style={s.deviceChipIcon}>
              <Ionicons name="bluetooth" size={13} color="#fff" />
            </View>
            <Text style={s.deviceChipText}>{deviceName || 'DeFoTic Device'} 연결됨</Text>
            <View style={s.deviceChipDot} />
          </View>

          {/* ── 입력 폼 ── */}
          <View style={s.formCard}>
            <View style={s.inputGroup}>
              <View style={s.labelRow}>
                <Ionicons name="person-outline" size={14} color={theme.colors.primaryDark} />
                <Text style={s.label}>이름</Text>
              </View>
              <TextInput
                style={[s.input, errors.name ? s.inputError : null]}
                placeholder="환자 이름"
                placeholderTextColor={theme.colors.textSecondary}
                value={name}
                onChangeText={(text) => { setName(text); setErrors(prev => ({ ...prev, name: '' })); }}
              />
              {errors.name ? <Text style={s.errorText}>{errors.name}</Text> : null}
            </View>

            <View style={[s.inputGroup, { marginBottom: 0 }]}>
              <View style={s.labelRow}>
                <Ionicons name="key-outline" size={14} color={theme.colors.primaryDark} />
                <Text style={s.label}>환자 식별 코드 (자동 발급)</Text>
              </View>
              <View style={s.codeBox}>
                <Text style={s.codeText}>{patientCode ?? '발급 중...'}</Text>
                <View style={s.codeBadge}>
                  <Ionicons name="shield-checkmark" size={11} color={theme.colors.primaryDark} />
                  <Text style={s.codeBadgeText}>중복 없는 고유 코드</Text>
                </View>
              </View>
            </View>
          </View>

          {/* ── 안내 ── */}
          <View style={s.infoCard}>
            <View style={s.infoIconWrap}>
              <Ionicons name="information-circle-outline" size={16} color={theme.colors.primary} />
            </View>
            <Text style={s.infoText}>
              위 식별 코드를 담당 의사에게 알려주면, 의사가 웹 대시보드(브라우저)에서 이 코드로 틱 분석 데이터를 열람할 수 있습니다. 코드는 앱 홈 화면에서 언제든 다시 확인할 수 있습니다.
            </Text>
          </View>

          <GradientButton
            title="시작하기"
            onPress={handleLogin}
            loading={loading}
            style={s.submitBtn}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 32,
  },

  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },

  title: {
    fontSize: 26,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginBottom: 16,
  },

  // ── 연결 기기 칩 ──
  deviceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 999,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 12,
    marginBottom: 24,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  deviceChipIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
  },
  deviceChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.primaryDark,
    marginRight: 6,
  },
  deviceChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.success,
  },

  // ── 입력 폼 ──
  formCard: {
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    padding: 18,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  inputGroup: {
    marginBottom: 18,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.primaryDark,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  inputError: {
    borderColor: theme.colors.error,
  },
  errorText: {
    fontSize: 12,
    color: theme.colors.error,
    marginTop: 6,
  },

  // ── 자동 발급 코드 표시 ──
  codeBox: {
    backgroundColor: 'rgba(155, 89, 208, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(155, 89, 208, 0.25)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  codeText: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 6,
    color: theme.colors.primaryDark,
    marginBottom: 6,
  },
  codeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  codeBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.colors.primaryDark,
  },

  // ── 안내 카드 ──
  infoCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(155, 89, 208, 0.08)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 24,
  },
  infoIconWrap: {
    marginRight: 8,
    marginTop: 1,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: theme.colors.textSecondary,
    lineHeight: 18,
  },

  submitBtn: {
    marginTop: 'auto',
  },
});
