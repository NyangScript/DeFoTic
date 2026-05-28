import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';

export const VideoPlayer = ({ url }: { url?: string }) => {
  return (
    <View style={styles.container}>
      {/* 실제 구현에서는 expo-av의 Video 컴포넌트 사용 */}
      <View style={styles.mockPlayer}>
        <Ionicons name="play-circle" size={64} color={theme.colors.textPrimary} />
        <Text style={styles.text}>영상 재생 영역</Text>
        <Text style={styles.subtext}>전후 ±6분 클립</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    borderRadius: theme.borderRadius.m,
    overflow: 'hidden',
    marginBottom: theme.spacing.l,
  },
  mockPlayer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  text: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    marginTop: theme.spacing.s,
  },
  subtext: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    marginTop: 4,
  },
});
