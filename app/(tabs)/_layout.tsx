import { Tabs } from 'expo-router';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
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
