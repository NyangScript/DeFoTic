import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';

interface BarChartProps {
  data: number[];
  labels: string[];
  height?: number;
}

/**
 * 디자인 시스템(라벤더 글래스 + 퍼플 그라디언트)에 맞춘 커스텀 막대 차트.
 * react-native-chart-kit 의존 없이 실데이터를 그대로 렌더링한다.
 */
export const BarChart = ({ data, labels, height = 140 }: BarChartProps) => {
  const max = Math.max(...data, 1);

  return (
    <View style={styles.row}>
      {data.map((value, i) => {
        const barHeight = value > 0 ? Math.max((value / max) * height, 8) : 3;
        return (
          <View key={i} style={styles.col}>
            <View style={[styles.track, { height: height + 18 }]}>
              <Text style={styles.value}>{value > 0 ? value : ''}</Text>
              {value > 0 ? (
                <LinearGradient
                  colors={[theme.colors.primaryLight, theme.colors.primary]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                  style={[styles.bar, { height: barHeight }]}
                />
              ) : (
                <View style={[styles.bar, styles.barEmpty, { height: barHeight }]} />
              )}
            </View>
            <Text style={styles.label}>{labels[i]}</Text>
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingTop: 8,
    paddingBottom: 4,
  },
  col: {
    flex: 1,
    alignItems: 'center',
  },
  track: {
    justifyContent: 'flex-end',
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  value: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    marginBottom: 4,
  },
  bar: {
    width: 18,
    borderRadius: 6,
  },
  barEmpty: {
    backgroundColor: 'rgba(155, 89, 208, 0.15)',
  },
  label: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginTop: 8,
  },
});
