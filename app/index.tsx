import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Image } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  Easing,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { theme } from '../constants/theme';
import { GradientBackground } from '../components/ui/GradientBackground';
import { profileStore } from '../services/data/ProfileStore';

// ── 스플래시 애니메이션 구조 ──
//  · 애니메이션은 로고 아이콘 영역(pulseArea) 안에만 앵커한다 — 텍스트는
//    그 아래 별도 흐름이라 어떤 프레임에서도 가려지지 않는다.
//  · 원은 면(fill)이 아니라 테두리 링(radar ping)으로, 커질수록 투명해져
//    "감지 중" 모티프(음성 틱을 듣고 있는 기기)를 은유한다.
//  · 아이콘·타이틀·부제·로딩 도트가 계단식으로 등장해 단조로움을 줄인다.

// 확산 링 1회 주기(ms) — 두 링이 반주기 간격으로 이어져 끊김 없는 파동
const RING_CYCLE_MS = 2400;

function usePingRing(delayMs: number) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: RING_CYCLE_MS, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 0 })
        ),
        -1,
        false
      )
    );
    // progress는 이 훅이 단독 소유 — 마운트 1회 시동이면 충분
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.75 }],
    opacity: 0.45 * (1 - progress.value),
  }));
}

function useLoadingDot(delayMs: number) {
  const phase = useSharedValue(0.3);

  useEffect(() => {
    phase.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 420, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.3, { duration: 420, easing: Easing.inOut(Easing.quad) })
        ),
        -1,
        false
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useAnimatedStyle(() => ({
    opacity: phase.value,
    transform: [{ scale: 0.85 + phase.value * 0.3 }],
  }));
}

export default function IntroScreen() {
  const router = useRouter();

  const ring1Style = usePingRing(0);
  const ring2Style = usePingRing(RING_CYCLE_MS / 2);
  const dot1 = useLoadingDot(0);
  const dot2 = useLoadingDot(180);
  const dot3 = useLoadingDot(360);

  useEffect(() => {
    // ── 온보딩 게이트 (자동 로그인) ──
    // 최초 온보딩(BLE 페어링 → 환자 등록)을 마친 사용자는 매 실행마다
    // 그 동선을 반복하지 않는다 — 프로필이 있으면 메인 탭으로 직행.
    // BLE 재연결은 홈 화면이 백그라운드에서 자동 시도한다 (BleManager).
    // 프로필 로드 실패는 신규 사용자와 동일하게 취급 (안전한 쪽으로 폴백).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    profileStore
      .get()
      .catch(() => null)
      .then(profile => {
        if (cancelled) return;
        // 재방문자는 짧게(1.5s), 신규는 브랜드 인트로 유지(3s)
        timer = setTimeout(() => {
          router.replace(profile ? '/(tabs)' : '/pairing');
        }, profile ? 1500 : 3000);
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <GradientBackground style={styles.container}>
      <View style={styles.logoContainer}>
        {/* 확산 링은 pulseArea(200px) 내부에 앵커 — 텍스트 위로 못 나온다 */}
        <Animated.View entering={FadeInDown.duration(800)} style={styles.pulseArea}>
          <Animated.View style={[styles.ring, ring1Style]} />
          <Animated.View style={[styles.ring, ring2Style]} />
          <View style={styles.halo} />
          <Image source={require('../assets/logo.png')} style={styles.logoIcon} />
        </Animated.View>

        <Animated.Text
          entering={FadeInDown.delay(250).duration(800)}
          style={styles.title}
        >
          DeFoTic
        </Animated.Text>
        <Animated.Text
          entering={FadeInDown.delay(450).duration(800)}
          style={styles.subtitle}
        >
          틱장애 관리의 새로운 시작
        </Animated.Text>
      </View>

      {/* 하단 로딩 도트 — 대기 시간(1.5~3s)이 '멈춤'으로 느껴지지 않게 */}
      <Animated.View entering={FadeInDown.delay(650).duration(800)} style={styles.footer}>
        <View style={styles.dotsRow}>
          <Animated.View style={[styles.loadingDot, dot1]} />
          <Animated.View style={[styles.loadingDot, dot2]} />
          <Animated.View style={[styles.loadingDot, dot3]} />
        </View>
      </Animated.View>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    alignItems: 'center',
  },

  // ── 로고 + 확산 링 영역 ──
  pulseArea: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  ring: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  halo: {
    position: 'absolute',
    width: 116,
    height: 116,
    borderRadius: 58,
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  logoIcon: {
    // 실제 앱 로고 (assets/logo.png — 라운드 코너가 이미지에 포함됨)
    width: 88,
    height: 88,
    borderRadius: 20,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 10,
  },

  title: {
    ...theme.typography.h1,
    color: theme.colors.textPrimary,
    letterSpacing: 1,
    marginBottom: theme.spacing.s,
  },
  subtitle: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
  },

  // ── 하단 로딩 도트 ──
  footer: {
    position: 'absolute',
    bottom: 72,
    alignItems: 'center',
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  loadingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: theme.colors.primary,
    marginHorizontal: 5,
  },
});
