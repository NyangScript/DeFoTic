import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { theme } from '../../constants/theme';
import { TicEvent } from '../../types/tic-event';
import { Ionicons } from '@expo/vector-icons';

interface TicEventCardProps {
  event: TicEvent;
  onPress?: (event: TicEvent) => void;
}

type CardState = {
  icon: keyof typeof Ionicons.glyphMap;
  iconBg: string;
  iconColor: string;
  badge: string;
  badgeBg: string;
  badgeColor: string;
  spinner?: boolean;
};

function resolveState(event: TicEvent): CardState {
  if (event.transferStatus === 'pending_media') {
    return {
      icon: 'cloud-offline-outline',
      iconBg: 'rgba(255, 150, 0, 0.10)',
      iconColor: '#E58A00',
      badge: '동기화 대기',
      badgeBg: 'rgba(255, 150, 0, 0.12)',
      badgeColor: '#B96F00',
    };
  }
  if (event.analysisStatus === 'analyzing') {
    return {
      icon: 'sparkles-outline',
      iconBg: 'rgba(155, 89, 208, 0.10)',
      iconColor: theme.colors.primary,
      badge: 'AI 분석 중',
      badgeBg: 'rgba(155, 89, 208, 0.12)',
      badgeColor: theme.colors.primaryDark,
      spinner: true,
    };
  }
  if (event.analysisStatus === 'failed') {
    return {
      icon: 'alert-circle-outline',
      iconBg: 'rgba(255, 82, 82, 0.10)',
      iconColor: theme.colors.error,
      badge: '분석 실패',
      badgeBg: 'rgba(255, 82, 82, 0.12)',
      badgeColor: theme.colors.error,
    };
  }
  if (event.aiAnalysis) {
    const sev = event.aiAnalysis.severity;
    return {
      icon: 'sparkles',
      iconBg: 'rgba(155, 89, 208, 0.10)',
      iconColor: theme.colors.primary,
      badge: sev === 'high' ? '강도 높음' : sev === 'medium' ? '강도 보통' : '강도 낮음',
      badgeBg:
        sev === 'high' ? 'rgba(255, 82, 82, 0.12)'
        : sev === 'medium' ? 'rgba(255, 150, 0, 0.12)'
        : 'rgba(0, 200, 120, 0.12)',
      badgeColor:
        sev === 'high' ? theme.colors.error
        : sev === 'medium' ? '#B96F00'
        : '#00A862',
    };
  }
  return {
    icon: 'checkmark-circle-outline',
    iconBg: 'rgba(0, 200, 120, 0.10)',
    iconColor: '#00A862',
    badge: '분석 대기',
    badgeBg: 'rgba(0, 200, 120, 0.12)',
    badgeColor: '#00A862',
  };
}

export const TicEventCard = ({ event, onPress }: TicEventCardProps) => {
  const state = resolveState(event);

  const time = new Date(event.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const title = event.aiAnalysis
    ? event.aiAnalysis.situation
    : event.transferStatus === 'pending_media'
      ? '틱 기록됨'
      : event.analysisStatus === 'analyzing'
        ? 'AI 상황 분석 중'
        : event.analysisStatus === 'failed'
          ? '분석에 실패했습니다'
          : '미디어 동기화 완료';

  const desc = event.aiAnalysis
    ? event.aiAnalysis.ticDetail
    : event.transferStatus === 'pending_media'
      ? 'C-to-C 연결 시 자동으로 동기화됩니다'
      : event.analysisStatus === 'analyzing'
        ? '영상·음성을 바탕으로 상황을 분석하고 있어요'
        : event.analysisStatus === 'failed'
          ? '카드를 눌러 상세 정보를 확인하세요'
          : 'AI 분석이 곧 시작됩니다';

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => onPress && onPress(event)}>
      <View style={s.card}>
        {/* 좌측 상태 아이콘 */}
        <View style={[s.iconWrap, { backgroundColor: state.iconBg }]}>
          {state.spinner ? (
            <ActivityIndicator size="small" color={state.iconColor} />
          ) : (
            <Ionicons name={state.icon} size={19} color={state.iconColor} />
          )}
        </View>

        {/* 본문 */}
        <View style={s.info}>
          <View style={s.topRow}>
            <Text style={s.time}>{time}</Text>
            <View style={[s.badge, { backgroundColor: state.badgeBg }]}>
              <Text style={[s.badgeText, { color: state.badgeColor }]}>{state.badge}</Text>
            </View>
            {typeof event.detectionConfidence === 'number' && !event.aiAnalysis && (
              <Text style={s.confidence}>
                신뢰도 {Math.round(event.detectionConfidence * 100)}%
              </Text>
            )}
          </View>

          <Text style={s.title} numberOfLines={2}>{title}</Text>
          <Text style={s.desc} numberOfLines={1}>{desc}</Text>

          {event.aiAnalysis && event.aiAnalysis.triggers.length > 0 && (
            <View style={s.tagRow}>
              {event.aiAnalysis.triggers.slice(0, 3).map((trigger, idx) => (
                <View key={idx} style={s.tag}>
                  <Text style={s.tagText}>#{trigger}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
      </View>
    </TouchableOpacity>
  );
};

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  info: {
    flex: 1,
    marginRight: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 6,
  },
  time: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  confidence: {
    fontSize: 10,
    color: theme.colors.textSecondary,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    lineHeight: 19,
    marginBottom: 2,
  },
  desc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  tag: {
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 10,
    color: theme.colors.primaryDark,
  },
});
