import React from 'react';
import { StyleSheet, ViewProps } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';

interface GradientBackgroundProps extends ViewProps {
  children?: React.ReactNode;
}

export const GradientBackground = ({ children, style, ...props }: GradientBackgroundProps) => {
  return (
    <LinearGradient
      colors={theme.gradients.background}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.container, style]}
      {...props}
    >
      {children}
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
