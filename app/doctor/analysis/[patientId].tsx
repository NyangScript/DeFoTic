import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Platform, TextInput, TouchableOpacity } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { theme } from '../../../constants/theme';
import { TicEventCard } from '../../../components/analysis/TicEventCard';
import { VideoPlayer } from '../../../components/analysis/VideoPlayer';
import { GlassCard } from '../../../components/ui/GlassCard';
import { GradientButton } from '../../../components/ui/GradientButton';
import { TicEvent } from '../../../types/tic-event';
import { GradientBackground } from '../../../components/ui/GradientBackground';
import { ticEventStore } from '../../../services/data/TicEventStore';
import { Ionicons } from '@expo/vector-icons';

// 웹 전용 로그인 및 대시보드 화면
export default function DoctorAnalysisScreen() {
  const { patientId } = useLocalSearchParams();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [codeInput, setCodeInput] = useState(patientId ? String(patientId) : '');
  const [selectedEvent, setSelectedEvent] = useState<TicEvent | null>(null);
  const [events, setEvents] = useState<TicEvent[]>([]);

  useEffect(() => {
    if (isAuthenticated) {
      const unsubscribe = ticEventStore.subscribe((newEvents) => {
        setEvents(newEvents);
        if (newEvents.length > 0 && !selectedEvent) {
          setSelectedEvent(newEvents[0]);
        }
      });
      return () => unsubscribe();
    }
  }, [isAuthenticated, selectedEvent]);

  const handleAuth = () => {
    if (codeInput.length > 0) {
      setIsAuthenticated(true);
    }
  };

  if (!isAuthenticated) {
    return (
      <GradientBackground style={styles.authContainer}>
        <GlassCard style={styles.authCard}>
          <Text style={styles.authTitle}>의료진 대시보드 로그인</Text>
          <Text style={styles.authSubtitle}>환자 앱에 표시된 식별 코드를 입력해주세요</Text>
          
          <TextInput
            style={styles.input}
            placeholder="환자 식별 코드 (예: 123456)"
            placeholderTextColor={theme.colors.textSecondary}
            value={codeInput}
            onChangeText={setCodeInput}
            keyboardType="numeric"
          />
          
          <GradientButton title="인증 및 데이터 열람" onPress={handleAuth} />
        </GlassCard>
      </GradientBackground>
    );
  }

  return (
    <GradientBackground style={styles.webContainer}>
      <View style={styles.sidebar}>
        <Text style={styles.sidebarTitle}>환자 {codeInput} 데이터</Text>
        <ScrollView style={styles.eventList}>
          {events.length === 0 ? (
            <Text style={{color: theme.colors.textSecondary}}>데이터가 없습니다.</Text>
          ) : (
            events.map(event => (
              <TouchableOpacity 
                key={event.id}
                style={[styles.eventItem, selectedEvent?.id === event.id && styles.eventItemActive]}
                onPress={() => setSelectedEvent(event)}
              >
                <Text style={styles.eventTime}>
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <View style={styles.thumbnailContainer}>
                  {event.videoPath ? (
                    <Ionicons name="videocam-outline" size={24} color={theme.colors.primaryDark} />
                  ) : null}
                </View>
                <Text style={styles.eventContext}>
                  {event.aiAnalysis ? event.aiAnalysis.situation : event.context || '분석 중...'}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </View>
      
      <View style={styles.mainContent}>
        {selectedEvent ? (
          <ScrollView>
            <Text style={styles.mainTitle}>
              {selectedEvent.aiAnalysis ? selectedEvent.aiAnalysis.situation : selectedEvent.context} (상세 분석)
            </Text>
            
            {/* 영상 클립 영역 */}
            <VideoPlayer url={selectedEvent.videoPath} />
            
            <View style={styles.detailsGrid}>
              <GlassCard style={styles.detailCard}>
                <Text style={styles.detailLabel}>틱 유형</Text>
                <Text style={styles.detailValue}>
                  {selectedEvent.type === 'vocal' ? '음성 틱' : selectedEvent.type === 'motor' ? '운동 틱' : '복합 틱'}
                </Text>
              </GlassCard>
              <GlassCard style={styles.detailCard}>
                <Text style={styles.detailLabel}>감지 강도</Text>
                <Text style={styles.detailValue}>{selectedEvent.intensity} / 10</Text>
              </GlassCard>
            </View>

            {selectedEvent.aiAnalysis && (
              <GlassCard style={[styles.planCard, { marginBottom: theme.spacing.m }]}>
                <Text style={styles.detailLabel}>AI 분석 트리거 요인</Text>
                <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8}}>
                  {selectedEvent.aiAnalysis.triggers.map((trigger, i) => (
                    <View key={i} style={{backgroundColor: 'rgba(155, 89, 208, 0.2)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4}}>
                      <Text style={{color: theme.colors.primaryDark}}>#{trigger}</Text>
                    </View>
                  ))}
                </View>
                <Text style={[styles.detailLabel, {marginTop: 16}]}>AI 권장 대응(CBIT)</Text>
                <Text style={{color: theme.colors.textPrimary, marginTop: 4}}>{selectedEvent.aiAnalysis.recommendation}</Text>
              </GlassCard>
            )}
            
            <GlassCard style={styles.planCard}>
              <Text style={styles.detailLabel}>의료진 소견 및 CBIT 치료 계획</Text>
              <TextInput
                style={styles.textArea}
                multiline
                numberOfLines={4}
                placeholder="전구감각(Premonitory Urge) 및 경쟁 반응(Competing Response) 계획 작성..."
                placeholderTextColor={theme.colors.textSecondary}
              />
              <GradientButton title="저장하기" style={{ alignSelf: 'flex-end', marginTop: theme.spacing.m }} />
            </GlassCard>
          </ScrollView>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>좌측에서 이벤트를 선택해주세요</Text>
          </View>
        )}
      </View>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  authContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.m,
  },
  authCard: {
    width: '100%',
    maxWidth: 400,
    padding: theme.spacing.xl,
  },
  authTitle: {
    ...theme.typography.h2,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.s,
    textAlign: 'center',
  },
  authSubtitle: {
    ...theme.typography.body2,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.l,
    textAlign: 'center',
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: theme.colors.glassBorder,
    borderRadius: theme.borderRadius.s,
    padding: theme.spacing.m,
    color: theme.colors.textPrimary,
    ...theme.typography.body1,
    marginBottom: theme.spacing.l,
  },
  webContainer: {
    flex: 1,
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
  },
  sidebar: {
    width: Platform.OS === 'web' ? 300 : '100%',
    borderRightWidth: 1,
    borderRightColor: theme.colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.4)',
    padding: theme.spacing.m,
  },
  sidebarTitle: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.m,
  },
  eventList: {
    flex: 1,
  },
  eventItem: {
    padding: theme.spacing.m,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.glassBorder,
  },
  eventItemActive: {
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderRadius: theme.borderRadius.s,
    borderBottomWidth: 0,
  },
  eventTime: {
    ...theme.typography.caption,
    color: theme.colors.primaryDark,
    marginBottom: 4,
  },
  thumbnailContainer: {
    width: 60,
    height: 60,
    borderRadius: theme.borderRadius.s,
    backgroundColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: theme.spacing.s,
  },
  eventContext: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
  },
  mainContent: {
    flex: 1,
    padding: theme.spacing.xl,
  },
  mainTitle: {
    ...theme.typography.h1,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.l,
  },
  detailsGrid: {
    flexDirection: 'row',
    gap: theme.spacing.m,
    marginBottom: theme.spacing.m,
  },
  detailCard: {
    flex: 1,
  },
  detailLabel: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    marginBottom: 4,
  },
  detailValue: {
    ...theme.typography.h3,
    color: theme.colors.textPrimary,
  },
  planCard: {
    marginTop: theme.spacing.m,
  },
  textArea: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: theme.colors.glassBorder,
    borderRadius: theme.borderRadius.s,
    padding: theme.spacing.m,
    color: theme.colors.textPrimary,
    ...theme.typography.body1,
    minHeight: 120,
    textAlignVertical: 'top',
    marginTop: theme.spacing.s,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateText: {
    ...theme.typography.h3,
    color: theme.colors.textSecondary,
  },
});
