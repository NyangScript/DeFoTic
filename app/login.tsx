import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { GradientButton } from '../components/ui/GradientButton';
import { theme } from '../constants/theme';
import { GradientBackground } from '../components/ui/GradientBackground';
import { Ionicons } from '@expo/vector-icons';
import { bleManager } from '../services/ble/BleManager';
import { useDeviceStore } from '../stores/useDeviceStore';

export default function LoginScreen() {
  const router = useRouter();
  const { deviceName } = useDeviceStore();
  const [name, setName] = useState('');
  const [patientId, setPatientId] = useState(''); // 환자 식별 코드 (의사용)
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({ name: '', patientId: '' });

  const validate = () => {
    let isValid = true;
    const newErrors = { name: '', patientId: '' };

    if (!name.trim()) {
      newErrors.name = '이름을 입력해주세요.';
      isValid = false;
    }

    if (!/^\d{6}$/.test(patientId.trim())) {
      newErrors.patientId = '식별 코드는 6자리 숫자여야 합니다.';
      isValid = false;
    }

    setErrors(newErrors);
    return isValid;
  };

  const handleLogin = () => {
    if (!validate()) return;

    setLoading(true);
    // 모의 로그인 처리
    setTimeout(() => {
      setLoading(false);
      router.replace('/(tabs)');
    }, 1000);
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
                <Text style={s.label}>환자 식별 코드</Text>
              </View>
              <TextInput
                style={[s.input, errors.patientId ? s.inputError : null]}
                placeholder="6자리 숫자 (예: 123456)"
                placeholderTextColor={theme.colors.textSecondary}
                keyboardType="numeric"
                maxLength={6}
                value={patientId}
                onChangeText={(text) => { setPatientId(text); setErrors(prev => ({ ...prev, patientId: '' })); }}
              />
              {errors.patientId ? <Text style={s.errorText}>{errors.patientId}</Text> : null}
            </View>
          </View>

          {/* ── 안내 ── */}
          <View style={s.infoCard}>
            <View style={s.infoIconWrap}>
              <Ionicons name="information-circle-outline" size={16} color={theme.colors.primary} />
            </View>
            <Text style={s.infoText}>
              식별 코드를 담당 의사에게 전달하면 의사가 웹 대시보드를 통해 환자의 틱 데이터를 확인할 수 있습니다.
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
