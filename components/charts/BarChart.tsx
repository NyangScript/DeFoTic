import React from 'react';
import { View, Dimensions } from 'react-native';
import { BarChart as KitBarChart } from 'react-native-chart-kit';
import { theme } from '../../constants/theme';

interface BarChartProps {
  data: number[];
  labels: string[];
}

export const BarChart = ({ data, labels }: BarChartProps) => {
  const chartData = {
    labels,
    datasets: [
      {
        data,
      },
    ],
  };

  const chartConfig = {
    backgroundGradientFrom: theme.colors.background,
    backgroundGradientFromOpacity: 0,
    backgroundGradientTo: theme.colors.background,
    backgroundGradientToOpacity: 0,
    color: (opacity = 1) => `rgba(155, 89, 208, ${opacity})`, // primary (9B59D0)
    strokeWidth: 2, // optional, default 3
    barPercentage: 0.5,
    useShadowColorFromDataset: false, // optional
    propsForLabels: {
      fill: theme.colors.textPrimary,
      fontSize: 10,
    },
    fillShadowGradientFrom: theme.colors.primary,
    fillShadowGradientFromOpacity: 0.8,
    fillShadowGradientTo: theme.colors.primaryLight,
    fillShadowGradientToOpacity: 0.8,
  };

  return (
    <View style={{ alignItems: 'center' }}>
      <KitBarChart
        data={chartData}
        width={Dimensions.get('window').width - 64} // padding 고려
        height={220}
        yAxisLabel=""
        yAxisSuffix=""
        chartConfig={chartConfig}
        verticalLabelRotation={0}
        showValuesOnTopOfBars
        fromZero
        style={{
          marginVertical: 8,
          borderRadius: 16,
        }}
      />
    </View>
  );
};
