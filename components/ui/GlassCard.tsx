import React from 'react';
import { View, StyleSheet, ViewProps } from 'react-native';
import { theme } from '../../constants/theme';

interface GlassCardProps extends ViewProps {
  children: React.ReactNode;
}

export const GlassCard = ({ children, style, ...props }: GlassCardProps) => {
  return (
    <View style={[styles.card, style]} {...props}>
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: theme.spacing.m,
    borderWidth: 0.5,
    borderColor: theme.colors.glassBorder,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
});
