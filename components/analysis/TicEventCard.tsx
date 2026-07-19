import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Image } from 'react-native';
import { theme } from '../../constants/theme';
import { TicEvent } from '../../types/tic-event';
import { Ionicons } from '@expo/vector-icons';

interface TicEventCardProps {
  event: TicEvent;
  onPress?: (event: TicEvent) => void;
  // 컴팩트 1줄 행 — 미디어 없는 '횟수만 기록' 이벤트처럼 정보량이 적은
  // 항목이 풀사이즈 카드로 도배되는 것을 막는 밀도 옵션.
  // 시간·상태 뱃지만 한 줄로 보여주고, 상세는 동일하게 탭으로 연다.
  compact?: boolean;
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
  // 미디어 없이 감지만 기록된 이벤트 (기기 전송 중 감지 등) —
  // 동기화 대기도 분석도 없는 완결 상태다.
  if (event.transferStatus === 'no_media') {
    return {
      icon: 'pulse-outline',
      iconBg: 'rgba(155, 89, 208, 0.10)',
      iconColor: theme.colors.primary,
      badge: '기록됨',
      badgeBg: 'rgba(155, 89, 208, 0.12)',
      badgeColor: theme.colors.primaryDark,
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

// React.memo: 이벤트 1건 유입마다 목록 전체(수백 카드 가능)가 리렌더되지
// 않도록 — event 참조가 바뀐 카드만 다시 그린다.
export const TicEventCard = React.memo(({ event, onPress, compact }: TicEventCardProps) => {
  const state = resolveState(event);

  const time = new Date(event.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (compact) {
    return (
      <TouchableOpacity activeOpacity={0.7} onPress={() => onPress && onPress(event)}>
        <View style={s.compactRow}>
          <View style={[s.compactIcon, { backgroundColor: state.iconBg }]}>
            <Ionicons name={state.icon} size={13} color={state.iconColor} />
          </View>
          <Text style={s.compactTime}>{time}</Text>
          <Text style={s.compactTitle} numberOfLines={1}>
            {event.transferStatus === 'no_media' ? '틱 기록됨' : '틱 이벤트'}
          </Text>
          <View style={[s.badge, { backgroundColor: state.badgeBg }]}>
            <Text style={[s.badgeText, { color: state.badgeColor }]}>{state.badge}</Text>
          </View>
          <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
        </View>
      </TouchableOpacity>
    );
  }

  const title = event.aiAnalysis
    ? event.aiAnalysis.situation
    : event.transferStatus === 'pending_media' || event.transferStatus === 'no_media'
      ? '틱 기록됨'
      : event.analysisStatus === 'analyzing'
        ? 'AI 상황 분석 중'
        : event.analysisStatus === 'failed'
          ? '분석에 실패했습니다'
          : '미디어 동기화 완료';

  const desc = event.aiAnalysis
    ? event.aiAnalysis.ticDetail
    : event.transferStatus === 'pending_media'
      ? 'USB 케이블로 연결하면 자동으로 동기화됩니다'
      : event.transferStatus === 'no_media'
        ? '기기 사용 중 감지되어 횟수만 기록되었습니다'
        : event.analysisStatus === 'analyzing'
          ? '영상·음성을 바탕으로 상황을 분석하고 있어요'
          : event.analysisStatus === 'failed'
            ? '카드를 눌러 상세 정보를 확인하세요'
            : 'AI 분석이 곧 시작됩니다';

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => onPress && onPress(event)}>
      <View style={s.card}>
        {/* 좌측: 틱 직전 실사 스냅샷 (있으면) — 없거나 분석 중이면 상태 아이콘.
            스냅샷은 상황 맥락을 리스트에서 즉시 인지시키는 1차 뷰어다. */}
        {event.thumbPath && !state.spinner ? (
          <View style={s.thumbWrap}>
            <Image source={{ uri: event.thumbPath }} style={s.thumb} resizeMode="cover" />
            <View style={[s.thumbBadge, { backgroundColor: state.iconColor }]}>
              <Ionicons name={state.icon} size={9} color="#fff" />
            </View>
          </View>
        ) : (
          <View style={[s.iconWrap, { backgroundColor: state.iconBg }]}>
            {state.spinner ? (
              <ActivityIndicator size="small" color={state.iconColor} />
            ) : (
              <Ionicons name={state.icon} size={19} color={state.iconColor} />
            )}
          </View>
        )}

        {/* 본문 */}
        <View style={s.info}>
          <View style={s.topRow}>
            <Text style={s.time}>{time}</Text>
            <View style={[s.badge, { backgroundColor: state.badgeBg }]}>
              <Text style={[s.badgeText, { color: state.badgeColor }]}>{state.badge}</Text>
            </View>
            {/* 원시 감지 신뢰도 수치는 목록에 노출하지 않는다:
                환자가 증상 수치를 반복 의식하지 않게 하는 기획 의도 —
                상세 모달의 감지 정보에서만 확인할 수 있다. */}
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
});
TicEventCard.displayName = 'TicEventCard';

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
  thumbWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    marginRight: 12,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  thumb: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
    backgroundColor: '#1D1230',
  },
  thumbBadge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
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

  // ── 컴팩트 1줄 행 ──
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.42)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 6,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
    gap: 8,
  },
  compactIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactTime: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  compactTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: theme.colors.textPrimary,
  },
});
