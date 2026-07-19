import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { theme } from '../constants/theme';
import { useEventStore } from '../stores/useEventStore';
import { autoSyncController } from '../services/data/AutoSyncController';

export default function RootLayout() {
  // 영속 이벤트 로드 — 루트에서 1회 보장 (스토어 내부 ensureLoaded가
  // 이중 안전망으로 모든 쓰기 전에도 보장한다).
  useEffect(() => {
    useEventStore.getState().loadEvents();
  }, []);

  // C-to-C 자동 동기화 — 케이블 연결(usbState 'ready') 감지와 대량 백로그
  // 연쇄 배치를 화면과 무관하게 루트에서 담당한다. 탭은 lazy 마운트라
  // 분석 탭을 열지 않은 세션에서도 "꽂으면 자동 가져오기"가 성립해야 한다.
  useEffect(() => {
    autoSyncController.start();
    return () => autoSyncController.stop();
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: 'transparent',
          },
          headerTransparent: true,
          headerTintColor: theme.colors.textPrimary,
          headerShadowVisible: false,
          contentStyle: {
            backgroundColor: theme.colors.background,
          },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pairing" options={{ title: '', presentation: 'modal' }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* 의료진 인터페이스 — 웹 진입 시 기본 동선 (index.web.tsx 참조) */}
        <Stack.Screen name="doctor/index" options={{ headerShown: false, title: 'DeFoTic 의료진' }} />
        {/* 이 화면만 불투명 헤더: 전역 headerTransparent는 콘텐츠를
            헤더 밑으로 깔고 인셋을 주지 않는데, 이 화면의 사이드바/본문은
            상단 여백이 없어 플로팅 헤더가 타이틀·배너를 덮고 클릭까지
            가로채기 때문이다. */}
        <Stack.Screen
          name="doctor/analysis/[patientId]"
          options={{
            title: '데이터 분석 (의료진)',
            headerTransparent: false,
            headerStyle: { backgroundColor: theme.colors.background },
          }}
        />
      </Stack>
    </>
  );
}
