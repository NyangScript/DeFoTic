import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { GradientButton } from '../components/ui/GradientButton';
import { theme } from '../constants/theme';
import { GlassCard } from '../components/ui/GlassCard';
import { GradientBackground } from '../components/ui/GradientBackground';
import { Ionicons } from '@expo/vector-icons';
import { bleManager } from '../services/ble/BleManager';

export default function LoginScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [patientId, setPatientId] = useState(''); // 환자 식별 코드 (의사용)
  const [loading, setLoading] = useState(false);

  const handleLogin = () => {
    setLoading(true);
    // 모의 로그인 처리
    setTimeout(() => {
      setLoading(false);
      router.replace('/(tabs)');
    }, 1000);
  };

  const handleBack = async () => {
    await bleManager.disconnectDevice();
    router.back();
  };

  return (
    <GradientBackground>
      <KeyboardAvoidingView 
        style={styles.container} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
              <Ionicons name="arrow-back" size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
            <Text style={styles.title}>환자 정보 등록</Text>
            <Text style={styles.subtitle}>데이터를 관리하고 의사와 공유하세요</Text>
          </View>

          <GlassCard style={styles.formCard}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>이름</Text>
              <TextInput
                style={styles.input}
                placeholder="환자 이름"
                placeholderTextColor={theme.colors.textSecondary}
                value={name}
                onChangeText={setName}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>환자 식별 코드 (의사 공유용)</Text>
              <TextInput
                style={styles.input}
                placeholder="예: 123456"
                placeholderTextColor={theme.colors.textSecondary}
                keyboardType="numeric"
                value={patientId}
                onChangeText={setPatientId}
              />
              <Text style={styles.helperText}>
                이 코드를 담당 의사에게 전달하면 의사가 웹 대시보드를 통해 데이터를 확인할 수 있습니다.
              </Text>
            </View>

            <GradientButton 
              title="시작하기" 
              onPress={handleLogin} 
              loading={loading}
              style={styles.submitBtn}
            />
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: theme.spacing.l,
    justifyContent: 'center',
  },
  header: {
    marginBottom: theme.spacing.xl,
    paddingTop: theme.spacing.xxl,
  },
  backBtn: {
    marginBottom: theme.spacing.m,
    alignSelf: 'flex-start',
    padding: theme.spacing.xs,
    marginLeft: -theme.spacing.xs, // offset padding
  },
  title: {
    ...theme.typography.h1,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.xs,
  },
  subtitle: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
  },
  formCard: {
    padding: theme.spacing.l,
  },
  inputGroup: {
    marginBottom: theme.spacing.l,
  },
  label: {
    ...theme.typography.body2,
    color: theme.colors.primaryDark,
    marginBottom: theme.spacing.s,
    fontWeight: '600',
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: theme.colors.glassBorder,
    borderRadius: theme.borderRadius.s,
    padding: theme.spacing.m,
    color: theme.colors.textPrimary,
    ...theme.typography.body1,
  },
  helperText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.s,
    lineHeight: 18,
  },
  submitBtn: {
    marginTop: theme.spacing.m,
  },
});
