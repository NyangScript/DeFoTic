import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../../constants/theme';

export type BadgeStatus = 'success' | 'warning' | 'error' | 'info';

interface StatusBadgeProps {
  status: BadgeStatus;
  label: string;
}

export const StatusBadge = ({ status, label }: StatusBadgeProps) => {
  const getColors = () => {
    switch (status) {
      case 'success':
        return { bg: 'rgba(0, 230, 118, 0.15)', text: theme.colors.success };
      case 'warning':
        return { bg: 'rgba(255, 179, 0, 0.15)', text: theme.colors.warning };
      case 'error':
        return { bg: 'rgba(255, 82, 82, 0.15)', text: theme.colors.error };
      case 'info':
      default:
        return { bg: 'rgba(255,255,255,0.5)', text: theme.colors.primaryDark };
    }
  };

  const colors = getColors();

  return (
    <View style={[styles.badge, { backgroundColor: colors.bg }]}>
      <View style={[styles.dot, { backgroundColor: colors.text }]} />
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: theme.borderRadius.round,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  text: {
    ...theme.typography.caption,
    fontWeight: '600',
  },
});
