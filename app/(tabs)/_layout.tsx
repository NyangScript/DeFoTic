import { Tabs, useRouter } from 'expo-router';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { BackHandler, Platform, ToastAndroid } from 'react-native';

export default function TabLayout() {
  const router = useRouter();
  const lastBackPress = useRef(0);

  // 온보딩 플로우가 전부 replace로 전환되어 탭 도달 시 백스택이 비어 있다.
  // 하드웨어 뒤로가기 → "한 번 더 누르면 종료" 패턴으로 처리 (GO_BACK 미처리 오류 방지)
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 탭 위에 다른 화면(페어링 모달 등)이 떠 있으면 기본 뒤로가기에 맡긴다
      if (router.canGoBack()) return false;

      const now = Date.now();
      if (now - lastBackPress.current < 2000) {
        BackHandler.exitApp();
        return true;
      }
      lastBackPress.current = now;
      ToastAndroid.show('한 번 더 뒤로가기를 누르면 종료됩니다', ToastAndroid.SHORT);
      return true;
    });

    return () => sub.remove();
  }, [router]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        headerStyle: {
          backgroundColor: 'transparent',
          borderBottomWidth: 0,
        },
        headerTransparent: true,
        headerTintColor: theme.colors.textPrimary,
        tabBarStyle: {
          backgroundColor: 'rgba(255, 255, 255, 0.85)',
          borderTopWidth: 0.5,
          borderTopColor: theme.colors.glassBorder,
          height: 65,
          paddingBottom: 10,
          paddingTop: 8,
          position: 'absolute', // 탭바를 띄워서 뒤에 그래디언트가 보이도록
          elevation: 0,
        },
        tabBarActiveTintColor: theme.colors.primaryDark,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        sceneStyle: {
          backgroundColor: 'transparent',
        }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '홈',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="device"
        options={{
          title: '기기 상태',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="hardware-chip-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="record"
        options={{
          title: '데이터 기록',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="stats-chart-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="analysis"
        options={{
          title: '데이터 분석',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="analytics-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
