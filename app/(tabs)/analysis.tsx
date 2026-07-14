import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Modal } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { TicEventCard } from '../../components/analysis/TicEventCard';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useEventStore } from '../../stores/useEventStore';
import { mediaSyncManager, MediaSyncResult } from '../../services/data/MediaSyncManager';
import { dataRouter } from '../../services/data/DataRouter';
import { TicEvent } from '../../types/tic-event';
import { Ionicons } from '@expo/vector-icons';

export default function AnalysisScreen() {
  const events = useEventStore((state) => state.events);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<TicEvent | null>(null);

  const pendingCount = events.filter(e => e.transferStatus === 'pending_media').length;

  // ── 화면 진입 시 silent 자동 동기화 ──
  // DeFoTic 기기(USB 드라이브)가 연결되어 있고 SAF 권한이 있으면
  // 사용자 조작 없이 evt_* 미디어를 자동으로 가져온다.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const result = await mediaSyncManager.autoSyncFromDevice({ interactive: false });
        if (!active) return;
        if (result.matchedEventIds.length > 0) {
          console.log(`[Analysis] Auto-sync imported ${result.matchedEventIds.length} events`);
        }

        // 동기화는 완료됐지만 분석 트리거가 유실된 이벤트 복구
        // (예: 분석 도중 앱 종료 — failed는 상세 보기의 수동 재시도로 처리)
        useEventStore.getState().events
          .filter(e =>
            e.transferStatus === 'synced' &&
            (e.analysisStatus === 'pending' || !e.analysisStatus),
          )
          .forEach(e => dataRouter.triggerAnalysis(e.id));
      })();
      return () => { active = false; };
    }, []),
  );

  const showSyncOutcome = (result: MediaSyncResult) => {
    if (result.canceled) return;

    if (result.deviceUnavailable) {
      Alert.alert(
        '기기를 찾을 수 없습니다',
        'DeFoTic 기기가 C-to-C로 연결되어 있는지 확인해주세요.\n\n' +
          '기기가 USB 드라이브("DeFoTic TicRecorder")로 표시되어야 하며, ' +
          '폴더 선택창에서는 드라이브 안의 DEFOTIC 폴더를 선택해주세요. ' +
          '(내장 메모리 최상위 폴더는 Android 정책상 선택할 수 없습니다)',
      );
      return;
    }

    if (result.matchedEventIds.length > 0) {
      Alert.alert(
        '동기화 완료',
        `${result.matchedEventIds.length}건의 이벤트 미디어를 가져왔습니다.\nAI 분석이 자동으로 시작됩니다.` +
          (result.unmatchedFiles.length > 0
            ? `\n\n매핑되지 않은 파일 ${result.unmatchedFiles.length}개는 건너뛰었습니다.`
            : ''),
      );
    } else {
      Alert.alert(
        '가져올 미디어 없음',
        '기기 저장소에서 새로운 틱 이벤트 미디어(evt_*)를 찾지 못했습니다.',
      );
    }
  };

  const handleAutoSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const hasDir = await mediaSyncManager.hasSyncDirectory();
      if (!hasDir) {
        // 최초 1회: 폴더 선택창이 뜨기 전에 무엇을 선택해야 하는지 안내
        await new Promise<void>((resolve) =>
          Alert.alert(
            '동기화 폴더 지정 (최초 1회)',
            '다음 화면에서 DeFoTic USB 드라이브 안의 "DEFOTIC" 폴더를 찾아 선택해주세요.\n\n' +
              '※ 내장 메모리 최상위 폴더는 Android 정책상 선택이 거부됩니다.',
            [{ text: '확인', onPress: () => resolve() }],
          ),
        );
      }
      const result = await mediaSyncManager.autoSyncFromDevice({ interactive: true });
      showSyncOutcome(result);
    } catch (e) {
      console.error('[Analysis] Auto sync failed:', e);
      Alert.alert('동기화 실패', '미디어를 가져오는 중 오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleManualPick = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await mediaSyncManager.pickAndImportMedia();
      showSyncOutcome(result);
    } catch (e: any) {
      console.error('[Analysis] Manual pick failed:', e);
      Alert.alert('동기화 실패', e?.message || '파일을 가져오는 중 오류가 발생했습니다.');
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <GradientBackground>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>데이터 분석</Text>

        {/* C-to-C 자동 동기화 */}
        <TouchableOpacity activeOpacity={0.8} onPress={handleAutoSync} disabled={isSyncing}>
          <View style={styles.syncCard}>
            <LinearGradient
              colors={theme.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.syncIconWrap}
            >
              {isSyncing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="hardware-chip-outline" size={20} color="#fff" />
              )}
            </LinearGradient>
            <View style={styles.syncTextWrap}>
              <Text style={styles.syncTitle}>
                {isSyncing ? '미디어 가져오는 중...' : 'C-to-C 미디어 동기화'}
              </Text>
              <Text style={styles.syncDesc}>
                {pendingCount > 0
                  ? `동기화 대기 ${pendingCount}건 — 기기를 USB로 연결하면 자동으로 가져옵니다`
                  : '기기를 USB로 연결하면 SD 카드 미디어를 자동으로 가져옵니다'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
          </View>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleManualPick} disabled={isSyncing}>
          <Text style={styles.manualLink}>파일 직접 선택하기</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>상황 맥락 분석</Text>

        {events
          .slice()
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .map((event) => (
            <TicEventCard key={event.id} event={event} onPress={setSelectedEvent} />
          ))}

        {events.length === 0 && (
          <Text style={styles.emptyText}>수집된 데이터가 없습니다.</Text>
        )}
      </ScrollView>

      {/* ── 상세 보기 모달 ── */}
      <Modal
        visible={!!selectedEvent}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedEvent(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            {selectedEvent && (
              <EventDetail event={selectedEvent} onClose={() => setSelectedEvent(null)} />
            )}
          </View>
        </View>
      </Modal>
    </GradientBackground>
  );
}

// ═══════════════════════════════════════════
// 상세 보기
// ═══════════════════════════════════════════

function EventDetail({ event, onClose }: { event: TicEvent; onClose: () => void }) {
  const a = event.aiAnalysis;
  const dateStr = new Date(event.timestamp).toLocaleString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const statusText =
    event.transferStatus === 'pending_media' ? '미디어 동기화 대기'
    : event.analysisStatus === 'analyzing' ? 'AI 분석 중'
    : event.analysisStatus === 'failed' ? '분석 실패'
    : a ? '분석 완료' : '분석 대기';

  return (
    <>
      <View style={styles.modalHeader}>
        <View>
          <Text style={styles.modalTitle}>틱 이벤트 상세</Text>
          <Text style={styles.modalSubtitle}>{dateStr}</Text>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Ionicons name="close-circle" size={30} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
        {/* 상태/메타 칩 */}
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{statusText}</Text>
          </View>
          {typeof event.detectionConfidence === 'number' && (
            <View style={styles.chip}>
              <Text style={styles.chipText}>
                감지 신뢰도 {Math.round(event.detectionConfidence * 100)}%
              </Text>
            </View>
          )}
          <View style={styles.chip}>
            <Ionicons name="videocam-outline" size={11} color={theme.colors.primaryDark} />
            <Text style={styles.chipText}>{event.videoPath ? '영상 있음' : '영상 없음'}</Text>
          </View>
          <View style={styles.chip}>
            <Ionicons name="mic-outline" size={11} color={theme.colors.primaryDark} />
            <Text style={styles.chipText}>{event.audioPath ? '음성 있음' : '음성 없음'}</Text>
          </View>
        </View>

        {a ? (
          <>
            <DetailSection icon="pin-outline" label="상황 맥락" body={a.situation} />
            <DetailSection icon="earth-outline" label="환경 분석" body={a.environment} />
            <DetailSection icon="pulse-outline" label="틱 증상 상세" body={a.ticDetail} />

            {a.triggers.length > 0 && (
              <View style={styles.detailSection}>
                <View style={styles.detailLabelRow}>
                  <Ionicons name="flash-outline" size={14} color={theme.colors.primaryDark} />
                  <Text style={styles.detailLabel}>추정 트리거</Text>
                </View>
                <View style={styles.triggerRow}>
                  {a.triggers.map((t, i) => (
                    <View key={i} style={styles.triggerTag}>
                      <Text style={styles.triggerText}>#{t}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.recommendCard}>
              <View style={styles.detailLabelRow}>
                <Ionicons name="medkit-outline" size={14} color={theme.colors.primaryDark} />
                <Text style={styles.detailLabel}>CBIT 대응 권장사항</Text>
              </View>
              <Text style={styles.recommendText}>{a.recommendation}</Text>
            </View>

            <Text style={styles.analysisMeta}>
              틱 강도 {a.severity === 'high' ? '높음' : a.severity === 'medium' ? '보통' : '낮음'}
              {' · '}분석 신뢰도 {Math.round(a.confidence * 100)}%
              {' · '}유형 {event.type === 'vocal' ? '음성' : event.type === 'motor' ? '운동' : '복합'} 틱
            </Text>
          </>
        ) : (
          <View style={styles.pendingBox}>
            <Ionicons
              name={event.transferStatus === 'pending_media' ? 'cloud-offline-outline' : 'hourglass-outline'}
              size={36}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.pendingText}>
              {event.transferStatus === 'pending_media'
                ? '기기를 C-to-C로 연결하면 영상/음성이 자동으로 동기화되고 AI 분석이 시작됩니다.'
                : event.analysisStatus === 'failed'
                  ? '분석에 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.'
                  : 'AI가 영상과 음성을 분석하고 있습니다. 잠시만 기다려주세요.'}
            </Text>

            {event.transferStatus === 'synced' && event.analysisStatus === 'failed' && (
              <TouchableOpacity
                style={styles.retryBtn}
                activeOpacity={0.8}
                onPress={() => {
                  dataRouter.triggerAnalysis(event.id);
                  onClose();
                }}
              >
                <Ionicons name="refresh" size={15} color="#fff" />
                <Text style={styles.retryBtnText}>다시 분석하기</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

function DetailSection({
  icon,
  label,
  body,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  body: string;
}) {
  return (
    <View style={styles.detailSection}>
      <View style={styles.detailLabelRow}>
        <Ionicons name={icon} size={14} color={theme.colors.primaryDark} />
        <Text style={styles.detailLabel}>{label}</Text>
      </View>
      <Text style={styles.detailBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 100, // 탭바 영역 확보
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    marginBottom: 10,
    marginLeft: 2,
  },
  syncCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 8,
  },
  syncIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.m,
  },
  syncTextWrap: {
    flex: 1,
  },
  syncTitle: {
    ...theme.typography.body1,
    color: theme.colors.textPrimary,
    fontWeight: '600',
    marginBottom: 2,
  },
  syncDesc: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    lineHeight: 16,
  },
  manualLink: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.primaryDark,
    textAlign: 'center',
    paddingVertical: 6,
    marginBottom: 14,
  },
  emptyText: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },

  // ── 상세 보기 모달 ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(45, 27, 78, 0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#F4EBFB',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
    maxHeight: '82%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  modalSubtitle: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  modalBody: {
    flexGrow: 0,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 16,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.primaryDark,
  },
  detailSection: {
    marginBottom: 14,
  },
  detailLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 5,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  detailBody: {
    fontSize: 14,
    color: theme.colors.textPrimary,
    lineHeight: 21,
  },
  triggerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  triggerTag: {
    backgroundColor: 'rgba(155, 89, 208, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  triggerText: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.primaryDark,
  },
  recommendCard: {
    backgroundColor: 'rgba(155, 89, 208, 0.08)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  recommendText: {
    fontSize: 13,
    color: theme.colors.textPrimary,
    lineHeight: 20,
  },
  analysisMeta: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 8,
  },
  pendingBox: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
  },
  pendingText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 280,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginTop: 16,
  },
  retryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
});
