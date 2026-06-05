import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { theme } from '../../constants/theme';
import { TicEvent } from '../../types/tic-event';
import { GlassCard } from '../ui/GlassCard';
import { Ionicons } from '@expo/vector-icons';
import { StatusBadge } from '../ui/StatusBadge';

interface TicEventCardProps {
  event: TicEvent;
  onPress?: (event: TicEvent) => void;
}

export const TicEventCard = ({ event, onPress }: TicEventCardProps) => {
  const getSeverityBadge = () => {
    if (!event.aiAnalysis) return null;
    switch (event.aiAnalysis.severity) {
      case 'high': return <StatusBadge status="error" label="높음" />;
      case 'medium': return <StatusBadge status="warning" label="보통" />;
      case 'low': return <StatusBadge status="success" label="낮음" />;
      default: return null;
    }
  };

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={() => onPress && onPress(event)}>
      <GlassCard style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.timeBadge}>
            <Text style={styles.timeText}>
              {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          {getSeverityBadge()}
        </View>

        <View style={styles.contentRow}>
          <View style={styles.thumbnailContainer}>
            {event.videoPath ? (
              <Ionicons name="videocam-outline" size={32} color={theme.colors.primaryDark} />
            ) : (
              <Ionicons name="image-outline" size={32} color={theme.colors.textSecondary} />
            )}
          </View>

          <View style={styles.infoContainer}>
            {event.transferStatus === 'receiving' ? (
              <View style={styles.analyzingContainer}>
                <ActivityIndicator size="small" color={theme.colors.primaryDark} />
                <Text style={styles.analyzingText}>
                  데이터 수신 중... (V:{event.transferProgress?.video || 0}%, A:{event.transferProgress?.audio || 0}%)
                </Text>
              </View>
            ) : event.analysisStatus === 'analyzing' ? (
              <View style={styles.analyzingContainer}>
                <ActivityIndicator size="small" color={theme.colors.primaryDark} />
                <Text style={styles.analyzingText}>AI 분석 중...</Text>
              </View>
            ) : event.aiAnalysis ? (
              <>
                <Text style={styles.contextText} numberOfLines={2}>
                  {event.aiAnalysis.situation}
                </Text>
                <Text style={styles.detailText} numberOfLines={1}>
                  {event.aiAnalysis.ticDetail}
                </Text>
                {event.aiAnalysis.triggers.length > 0 && (
                  <View style={styles.tagContainer}>
                    {event.aiAnalysis.triggers.map((trigger, idx) => (
                      <View key={idx} style={styles.tag}>
                        <Text style={styles.tagText}>#{trigger}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <>
                <Text style={styles.contextText}>"{event.context || '대기 중...'}"</Text>
                <View style={styles.metaRow}>
                  <Text style={styles.typeText}>
                    틱 유형: {event.type === 'vocal' ? '음성' : event.type === 'motor' ? '운동' : '복합'}
                  </Text>
                  <Text style={styles.intensityText}>강도: {event.intensity}</Text>
                </View>
              </>
            )}
          </View>
        </View>
        
        <View style={styles.actionRow}>
          <Text style={styles.actionText}>상세 보기 ▶</Text>
        </View>
      </GlassCard>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    padding: theme.spacing.m,
    marginBottom: theme.spacing.m,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.s,
  },
  timeBadge: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: theme.borderRadius.s,
  },
  timeText: {
    ...theme.typography.caption,
    color: theme.colors.primaryDark,
    fontWeight: '600',
  },
  contentRow: {
    flexDirection: 'row',
  },
  thumbnailContainer: {
    width: 80,
    height: 80,
    borderRadius: theme.borderRadius.s,
    backgroundColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.m,
  },
  infoContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  analyzingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  analyzingText: {
    ...theme.typography.body2,
    color: theme.colors.primaryDark,
    marginLeft: theme.spacing.s,
  },
  contextText: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
    fontWeight: '600',
    marginBottom: 4,
  },
  detailText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    marginBottom: 6,
  },
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  tag: {
    backgroundColor: 'rgba(155, 89, 208, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  tagText: {
    ...theme.typography.caption,
    color: theme.colors.primaryDark,
    fontSize: 10,
  },
  metaRow: {
    flexDirection: 'row',
    marginTop: theme.spacing.xs,
  },
  typeText: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    marginRight: theme.spacing.m,
  },
  intensityText: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
  },
  actionRow: {
    alignItems: 'flex-end',
    marginTop: theme.spacing.s,
  },
  actionText: {
    ...theme.typography.body2,
    color: theme.colors.primaryDark,
    fontWeight: '600',
  },
});
