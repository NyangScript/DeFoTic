import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Platform, TextInput, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { notify } from '../../../utils/notify';
import { theme } from '../../../constants/theme';
import { GlassCard } from '../../../components/ui/GlassCard';
import { GradientButton } from '../../../components/ui/GradientButton';
import { GradientBackground } from '../../../components/ui/GradientBackground';
import { useEventStore } from '../../../stores/useEventStore';
import { firebaseSync, CloudTicEvent } from '../../../services/cloud/FirebaseSync';
import { WebMediaViewer } from '../../../components/doctor/WebMediaViewer';
import { Ionicons } from '@expo/vector-icons';

/**
 * 의료진 대시보드 (웹/앱 공용 — 단일 코드베이스).
 *
 * 데이터 소스 이원화:
 *  - Firebase 설정됨 → Firestore patients/{환자코드}/events 실시간 구독.
 *    의사 PC 브라우저 등 "다른 기기"에서의 원격 열람이 가능해진다.
 *  - 미설정 → 같은 기기의 로컬 이벤트 스토어 폴백 (미리보기 모드).
 */

/** 화면 표시용 통합 모델 — 로컬 TicEvent와 CloudTicEvent의 교집합 */
interface DoctorViewEvent {
  id: string;
  timestamp: string;
  type: 'vocal' | 'motor' | 'complex';
  aiAnalysis: CloudTicEvent['aiAnalysis'];
  hasVideo: boolean;
  doctorNote?: string;
  userFeedback?: 'confirmed' | 'false_positive' | null;
}

/**
 * 트리거 태그 정규화: 출력 언어를 지정하지 않던 프롬프트로 분석된
 * 레코드에는 영어 트리거가 실재한다 — 완전 일치 집계는 같은 요인을
 * 별개 항목으로 쪼개 상위 순위를 왜곡하므로, 알려진 영어 표현을 한국어
 * 표준값으로 흡수한 뒤 집계한다.
 */
const TRIGGER_SYNONYMS: Record<string, string> = {
  'noise': '소음',
  'loud noise': '소음',
  'social tension': '사회적 긴장',
  'social anxiety': '사회적 긴장',
  'stress': '스트레스',
  'fatigue': '피로',
  'tiredness': '피로',
  'anxiety': '불안',
  'excitement': '흥분',
  'crowd': '인파',
  'crowded': '인파',
  'conversation': '대화',
  'attention': '주목',
};

function normalizeTrigger(raw: string): string {
  const key = raw.trim().toLowerCase();
  return TRIGGER_SYNONYMS[key] ?? raw.trim();
}

export default function DoctorAnalysisScreen() {
  const { patientId } = useLocalSearchParams();
  const router = useRouter();

  // URL 직접 열람 플로우: `/doctor/analysis/{6자리 코드}`로 진입하면
  // (의료진 랜딩의 코드 입력 또는 북마크) 코드가 이미 제시된 것이므로
  // 재입력 게이트 없이 바로 열람한다 — "브라우저 URL로 열람" 기획의
  // 핵심 동선. 유효하지 않은 파라미터면 기존 입력 게이트로 폴백.
  const paramCode =
    typeof patientId === 'string' && /^\d{6}$/.test(patientId) ? patientId : null;

  const [isAuthenticated, setIsAuthenticated] = useState(paramCode !== null);
  const [codeInput, setCodeInput] = useState(paramCode ?? (patientId ? String(patientId) : ''));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<DoctorViewEvent[]>([]);
  const [sourceBanner, setSourceBanner] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [patientName, setPatientName] = useState<string | null>(null);

  const localEvents = useEventStore((state) => state.events);
  const cloudEnabled = firebaseSync.isEnabled();

  // ── 환자 프로필(이름) 1회 조회 — 온보딩 때 등록된 값 ──
  useEffect(() => {
    if (!isAuthenticated || !cloudEnabled) return;
    let active = true;
    firebaseSync.getPatientProfile(codeInput).then(p => {
      if (active) setPatientName(p?.patientName ?? null);
    });
    return () => { active = false; };
  }, [isAuthenticated, cloudEnabled, codeInput]);

  // ── 데이터 구독 (클라우드) ──
  // 로컬 이벤트 갱신이 Firestore 구독을 재생성하지 않도록 폴백 이펙트와 분리
  useEffect(() => {
    if (!isAuthenticated || !cloudEnabled) return;

    setSourceBanner(null);
    const unsubscribe = firebaseSync.subscribePatientEvents(
      codeInput,
      (cloud) => {
        setEvents(
          cloud.map(c => ({
            id: c.id,
            timestamp: c.timestamp,
            type: c.type,
            aiAnalysis: c.aiAnalysis,
            hasVideo: c.hasVideo,
            doctorNote: c.doctorNote,
            userFeedback: c.userFeedback,
          })),
        );
      },
      (message) => setSourceBanner(message),
    );
    return () => unsubscribe();
  }, [isAuthenticated, cloudEnabled, codeInput]);

  // ── 데이터 구독 (로컬 폴백 — 같은 기기 미리보기) ──
  useEffect(() => {
    if (!isAuthenticated || cloudEnabled) return;

    setSourceBanner(
      '로컬 미리보기 모드 — Firebase(constants/firebase-config.ts)를 설정하면 의사 PC 브라우저에서 원격 열람이 가능합니다.',
    );
    setEvents(
      localEvents.map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        type: e.type,
        aiAnalysis: e.aiAnalysis ?? null,
        hasVideo: !!e.videoPath,
        userFeedback: e.userFeedback ?? null,
      })),
    );
  }, [isAuthenticated, cloudEnabled, localEvents]);

  // 선택은 id로 '고정'한다: events[0] 라이브 폴백을 쓰면 새 이벤트가
  // 도착할 때마다 선택이 몰래 바뀌어, 작성 중이던 의료진 소견 초안이
  // 다른 이벤트의 것으로 리셋(소실)된다.
  const selectedEvent = events.find(e => e.id === selectedId) ?? null;

  // 최초 데이터 도착 시에만 첫 이벤트를 자동 선택
  useEffect(() => {
    if (!selectedId && events.length > 0) {
      setSelectedId(events[0].id);
    }
  }, [selectedId, events]);

  // 선택 이벤트가 바뀔 때만 소견 초안 로드
  useEffect(() => {
    setNoteDraft(selectedEvent?.doctorNote ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEvent?.id]);

  const handleAuth = () => {
    // 의료진 랜딩/환자 앱 코드 발급과 동일한 형식 규칙(6자리 숫자)으로 통일
    const trimmed = codeInput.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      notify('코드 형식 오류', '환자 식별 코드는 6자리 숫자입니다.');
      return;
    }
    // URL 정규화: 상태만 바꾸면 주소창이 잘못된 파라미터(오타 링크)
    // 그대로 남아 새로고침 시 게이트로 회귀하고 북마크가 영구히
    // 오염된다 — replace로 URL 자체를 교체하면 새 인스턴스의
    // paramCode 초기화가 자동 인증까지 처리한다.
    router.replace(`/doctor/analysis/${trimmed}`);
  };

  // Alert.alert 금지: react-native-web에서 no-op이라 의료진(웹)이
  // 저장 성공/실패를 알 수 없다 — 플랫폼 공용 notify로 통일.
  const handleSaveNote = async () => {
    if (savingNote) return;   // 더블 클릭 재진입 가드 — 중복 setDoc 방지
    if (!selectedEvent) return;
    if (!cloudEnabled) {
      notify(
        '저장할 수 없습니다',
        '의료진 소견 저장은 Firebase 연동이 필요합니다. constants/firebase-config.ts를 설정해주세요.',
      );
      return;
    }
    setSavingNote(true);
    try {
      await firebaseSync.saveDoctorNote(codeInput, selectedEvent.id, noteDraft.trim());
      notify('저장 완료', 'CBIT 치료 계획이 저장되었습니다.');
    } catch (e: any) {
      notify('저장 실패', e?.message || '네트워크 상태를 확인해주세요.');
    } finally {
      setSavingNote(false);
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

  // ── CBIT 요약 통계 (의사 열람용 핵심 지표: 빈도·강도 분포·주요 트리거) ──
  // 환자가 '틱 아님(오탐)'으로 라벨한 이벤트는 임상 지표에서 제외한다 —
  // 오탐이 빈도/강도/트리거 통계에 실제 틱으로 섞이면 치료 판단을 왜곡한다.
  const clinicalEvents = events.filter(e => e.userFeedback !== 'false_positive');
  const now = Date.now();
  const week7 = clinicalEvents.filter(e => now - new Date(e.timestamp).getTime() < 7 * 86400_000).length;
  const highCount = clinicalEvents.filter(e => e.aiAnalysis?.severity === 'high').length;
  const triggerFreq = new Map<string, number>();
  clinicalEvents.forEach(e =>
    e.aiAnalysis?.triggers?.forEach(t => {
      const norm = normalizeTrigger(t);
      triggerFreq.set(norm, (triggerFreq.get(norm) ?? 0) + 1);
    }),
  );
  const topTriggers = [...triggerFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <GradientBackground style={styles.webContainer}>
      <View style={styles.sidebar}>
        <Text style={styles.sidebarTitle}>
          {patientName ? `${patientName} 환자` : '환자'} · {codeInput}
        </Text>

        {/* 요약 통계 스트립 — 목록 훑기 전에 전체 경향 파악 (오탐 라벨 제외) */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{clinicalEvents.length}</Text>
            <Text style={styles.statLabel}>총 이벤트</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{week7}</Text>
            <Text style={styles.statLabel}>최근 7일</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{highCount}</Text>
            <Text style={styles.statLabel}>강도 높음</Text>
          </View>
        </View>
        {topTriggers.length > 0 && (
          <View style={styles.topTriggerRow}>
            {topTriggers.map(([t, n]) => (
              <View key={t} style={styles.triggerTag}>
                <Text style={{ color: theme.colors.primaryDark, fontSize: 11 }}>
                  #{t} ×{n}
                </Text>
              </View>
            ))}
          </View>
        )}
        {sourceBanner && (
          <View style={styles.sourceBanner}>
            <Ionicons name="information-circle-outline" size={14} color={theme.colors.primaryDark} />
            <Text style={styles.sourceBannerText}>{sourceBanner}</Text>
          </View>
        )}
        <ScrollView style={styles.eventList}>
          {events.length === 0 ? (
            <Text style={{ color: theme.colors.textSecondary }}>데이터가 없습니다.</Text>
          ) : (
            events.map(event => (
              <TouchableOpacity
                key={event.id}
                style={[styles.eventItem, selectedEvent?.id === event.id && styles.eventItemActive]}
                onPress={() => setSelectedId(event.id)}
              >
                <Text style={styles.eventTime}>
                  {new Date(event.timestamp).toLocaleString('ko-KR', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </Text>
                <View style={styles.eventMetaRow}>
                  {event.hasVideo && (
                    <Ionicons name="videocam-outline" size={16} color={theme.colors.primaryDark} />
                  )}
                  {event.doctorNote ? (
                    <Ionicons name="document-text-outline" size={16} color={theme.colors.primaryDark} />
                  ) : null}
                </View>
                <Text style={styles.eventContext} numberOfLines={2}>
                  {event.aiAnalysis ? event.aiAnalysis.situation : '분석 대기 중'}
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
              {selectedEvent.aiAnalysis ? selectedEvent.aiAnalysis.situation : '분석 대기 중'} (상세 분석)
            </Text>

            <View style={styles.detailsGrid}>
              <GlassCard style={styles.detailCard}>
                <Text style={styles.detailLabel}>틱 유형</Text>
                <Text style={styles.detailValue}>
                  {selectedEvent.type === 'vocal' ? '음성 틱' : selectedEvent.type === 'motor' ? '운동 틱' : '복합 틱'}
                </Text>
              </GlassCard>
              <GlassCard style={styles.detailCard}>
                <Text style={styles.detailLabel}>틱 강도 (AI 분석)</Text>
                <Text style={styles.detailValue}>
                  {selectedEvent.aiAnalysis
                    ? selectedEvent.aiAnalysis.severity === 'high' ? '높음'
                      : selectedEvent.aiAnalysis.severity === 'medium' ? '보통' : '낮음'
                    : '분석 대기'}
                </Text>
              </GlassCard>
            </View>

            {selectedEvent.aiAnalysis && (
              <GlassCard style={[styles.planCard, { marginBottom: theme.spacing.m }]}>
                <Text style={styles.detailLabel}>상황/환경 분석</Text>
                <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.situation}</Text>
                <Text style={[styles.bodyText, { marginTop: 4 }]}>{selectedEvent.aiAnalysis.environment}</Text>

                <Text style={[styles.detailLabel, { marginTop: 16 }]}>증상 상세</Text>
                <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.ticDetail}</Text>

                {/* ── CBIT 기능 평가 (프롬프트 v2 — 구 레코드에는 없을 수 있음) ── */}
                {selectedEvent.aiAnalysis.premonitorySigns && (
                  <>
                    <Text style={[styles.detailLabel, { marginTop: 16 }]}>전구 신호 (Premonitory Signs)</Text>
                    <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.premonitorySigns}</Text>
                  </>
                )}
                {selectedEvent.aiAnalysis.antecedent && (
                  <>
                    <Text style={[styles.detailLabel, { marginTop: 16 }]}>선행 사건 (A)</Text>
                    <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.antecedent}</Text>
                  </>
                )}
                {selectedEvent.aiAnalysis.consequences && (
                  <>
                    <Text style={[styles.detailLabel, { marginTop: 16 }]}>후속 결과 (C)</Text>
                    <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.consequences}</Text>
                  </>
                )}

                <Text style={[styles.detailLabel, { marginTop: 16 }]}>AI 분석 트리거 요인</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {selectedEvent.aiAnalysis.triggers.map((trigger, i) => (
                    <View key={i} style={styles.triggerTag}>
                      <Text style={{ color: theme.colors.primaryDark }}>#{trigger}</Text>
                    </View>
                  ))}
                </View>
                <Text style={[styles.detailLabel, { marginTop: 16 }]}>AI 권장 대응(CBIT)</Text>
                <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.recommendation}</Text>
                {selectedEvent.aiAnalysis.competingResponse && (
                  <>
                    <Text style={[styles.detailLabel, { marginTop: 16 }]}>경쟁 반응(CR) 훈련 제안</Text>
                    <Text style={styles.bodyText}>{selectedEvent.aiAnalysis.competingResponse}</Text>
                  </>
                )}
              </GlassCard>
            )}

            {/* ── 웹 미디어 뷰어: 업로드 없는 로컬 파일 재생 ──
                미디어는 Firestore에 올라가지 않는다(프라이버시 약속). SD
                카드/전달 파일을 브라우저 File API로 열어 MJPEG 프레임 스크럽
                + ADPCM→WebAudio 동기 재생. 파일은 PC 밖으로 전송되지 않는다. */}
            {Platform.OS === 'web' && (
              <GlassCard style={styles.planCard}>
                <Text style={styles.detailLabel}>상황 맥락 미디어 뷰어 (로컬 파일)</Text>
                <WebMediaViewer />
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
                value={noteDraft}
                onChangeText={setNoteDraft}
              />
              <GradientButton
                title={savingNote ? '저장 중...' : '저장하기'}
                onPress={handleSaveNote}
                style={{ alignSelf: 'flex-end', marginTop: theme.spacing.m }}
              />
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

  // ── 요약 통계 스트립 ──
  statsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: theme.spacing.s,
  },
  statBox: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: theme.borderRadius.s,
    paddingVertical: 8,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  statLabel: {
    fontSize: 10,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  topTriggerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: theme.spacing.m,
  },
  sourceBanner: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    borderRadius: theme.borderRadius.s,
    padding: theme.spacing.s,
    marginBottom: theme.spacing.m,
  },
  sourceBannerText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.primaryDark,
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
  eventMetaRow: {
    flexDirection: 'row',
    gap: 6,
    marginVertical: 4,
  },
  eventContext: {
    ...theme.typography.body2,
    color: theme.colors.textPrimary,
  },
  mainContent: {
    flex: 1,
    padding: theme.spacing.xl,
  },
  mainTitle: {
    ...theme.typography.h2,
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
  bodyText: {
    ...theme.typography.body2,
    color: theme.colors.textPrimary,
    marginTop: 4,
  },
  triggerTag: {
    backgroundColor: 'rgba(155, 89, 208, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
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
