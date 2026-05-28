import React from 'react';
import { TouchableOpacity, Text, StyleSheet, TouchableOpacityProps, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';

interface GradientButtonProps extends TouchableOpacityProps {
  title: string;
  loading?: boolean;
}

export const GradientButton = ({ title, loading, style, ...props }: GradientButtonProps) => {
  return (
    <TouchableOpacity activeOpacity={0.8} disabled={loading || props.disabled} style={style} {...props}>
      <LinearGradient
        colors={theme.gradients.button}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.gradient}
      >
        {loading ? (
          <ActivityIndicator color={theme.colors.textPrimary} />
        ) : (
          <Text style={styles.text}>{title}</Text>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  gradient: {
    borderRadius: theme.borderRadius.s,
    paddingVertical: theme.spacing.m,
    paddingHorizontal: theme.spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: theme.colors.textPrimary,
    ...theme.typography.body1,
    fontWeight: '600',
  },
});
