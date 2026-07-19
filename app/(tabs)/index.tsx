import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { useEventStore } from '../../stores/useEventStore';
import { firebaseSync } from '../../services/cloud/FirebaseSync';
import { bleManager } from '../../services/ble/BleManager';
import { profileStore } from '../../services/data/ProfileStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function MainHubScreen() {
  const router = useRouter();
  // 필요한 필드만 개별 구독 — 전체 스토어 구독은 3초 주기 BLE 텔레메트리
  // 패킷(lastUpdated 갱신)마다 홈 화면 전체를 리렌더시킨다
  const isConnected = useDeviceStore((state) => state.isConnected);
  const deviceName = useDeviceStore((state) => state.deviceName);
  const events = useEventStore((state) => state.events);

  // 환자 식별 코드 — 의료진이 대시보드에서 이 코드로 데이터를 열람한다
  const [patientCode, setPatientCode] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string | null>(null);
  useEffect(() => {
    firebaseSync.getPatientCode().then(setPatientCode).catch(() => {});
    profileStore.get().then(p => setPatientName(p?.name ?? null)).catch(() => {});

    // 코드 변경 구독: 클라우드 클레임 중 충돌로 코드가 재생성되면
    // 이미 표시된 코드가 스테일이 된다 — 즉시 갱신하고 명시 알림으로
    // "의사에게 새 코드를 알려야 함"을 전달한다.
    const unsubscribe = firebaseSync.onPatientCodeChanged(code => {
      setPatientCode(code);
      Alert.alert(
        '공유 코드가 변경되었습니다',
        `드물게 다른 환자와 코드가 겹쳐 새 코드(${code})가 발급되었습니다.\n의료진에게는 반드시 새 코드를 알려주세요.`,
      );
    });
    return unsubscribe;
  }, []);

  // ── BLE 자동 재연결 (자동 로그인 동선의 후반부) ──
  // 온보딩 게이트로 페어링 화면을 건너뛴 사용자를 위해, 홈 최초 진입 시
  // 마지막 검증 기기로 조용히 연결을 시도한다. 실패해도 무해 —
  // 연결 카드가 '연결 안 됨'을 유지하고 수동 경로가 그대로 동작한다.
  // 외출로 하루 종일 끊겨 있다 귀가한 시나리오를 위해, 앱이 포그라운드로
  // 복귀할 때마다(30초 스로틀) 미연결이면 재시도한다 — mount 1회 실패가
  // 세션 내내 미연결로 고착되는 것을 방지 (usbState 자동 동기화 트리거의
  // 전제이기도 하다).
  useEffect(() => {
    let lastAttempt = 0;
    const attempt = () => {
      if (useDeviceStore.getState().isConnected) return;
      const now = Date.now();
      if (now - lastAttempt < 30_000) return;
      lastAttempt = now;
      bleManager.tryReconnectLastDevice().catch(() => {});
    };
    attempt();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') attempt();
    });
    return () => sub.remove();
  }, []);

  // 절대 위치 탭바(65 + 시스템 인셋)에 콘텐츠 하단이 가려지지 않도록
  // 스크롤 하단 여백을 유동 확보한다 (전 탭 화면 공통 패턴)
  const insets = useSafeAreaInsets();
  const scrollPadBottom = 65 + insets.bottom + 24;

  // '오늘' 기준일 — 화면에 머문 채 자정을 넘겨도 카운트가 스테일이 되지
  // 않도록, 포그라운드 복귀 시 날짜가 바뀌었으면 갱신한다.
  const [dayStamp, setDayStamp] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () =>
      setDayStamp(prev =>
        new Date(prev).toDateString() === new Date().toDateString() ? prev : Date.now(),
      );
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, []);

  // 파생 카운트는 events·기준일이 실제로 바뀔 때만 재계산 — 동기화/분석
  // 파이프라인이 도는 동안 updateEvent마다 최대 2,000건 × 3회 필터(Date
  // 파싱 포함)가 매 렌더 반복되는 것을 방지한다.
  const { todayEventsCount, pendingCount, analyzedCount } = useMemo(() => {
    const today = new Date(dayStamp).toDateString();
    let todayCnt = 0, pendingCnt = 0, analyzedCnt = 0;
    for (const e of events) {
      if (new Date(e.timestamp).toDateString() === today) todayCnt++;
      if (e.transferStatus === 'pending_media') pendingCnt++;
      if (e.analysisStatus === 'completed') analyzedCnt++;
    }
    return { todayEventsCount: todayCnt, pendingCount: pendingCnt, analyzedCount: analyzedCnt };
  }, [events, dayStamp]);

  return (
    <GradientBackground>
      <ScrollView style={s.root} contentContainerStyle={[s.content, { paddingBottom: scrollPadBottom }]}>
        {/* ── 타이틀 ── */}
        <Text style={s.title}>DeFoTic</Text>
        {patientName && (
          <Text style={s.greeting}>{patientName}님, 오늘도 함께할게요</Text>
        )}

        {/* ── 연결 상태 카드 (탭 → 기기 연결 화면) ── */}
        <TouchableOpacity activeOpacity={0.7} onPress={() => router.push('/pairing')}>
          <View style={s.connectCard}>
            <View style={[s.connectIconWrap, isConnected && s.connectIconWrapOn]}>
              <Ionicons
                name="bluetooth"
                size={20}
                color={isConnected ? '#fff' : theme.colors.textSecondary}
              />
            </View>
            <View style={s.connectInfo}>
              <View style={s.connectTitleRow}>
                <Text style={[s.connectTitle, !isConnected && s.connectTitleOff]}>
                  {isConnected ? '연결됨' : '연결 안 됨'}
                </Text>
                <View style={[s.dot, !isConnected && s.dotOff]} />
              </View>
              <Text style={s.connectDesc} numberOfLines={1}>
                {isConnected
                  ? `${deviceName || 'DeFoTic Device'} · 실시간 감지 중`
                  : '탭하여 DeFoTic 기기 연결하기'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
          </View>
        </TouchableOpacity>

        {/* ── 히어로: 오늘의 감지 ── */}
        <LinearGradient
          colors={theme.gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1.2, y: 1.2 }}
          style={s.hero}
        >
          <View style={s.heroTop}>
            <Text style={s.heroLabel}>오늘 감지된 틱</Text>
            <View style={s.heroIconWrap}>
              <Ionicons name="pulse" size={18} color="#fff" />
            </View>
          </View>
          <View style={s.heroValueRow}>
            <Text style={s.heroValue}>{todayEventsCount}</Text>
            <Text style={s.heroUnit}>회</Text>
          </View>
          <View style={s.heroFooter}>
            <View style={s.heroChip}>
              <Ionicons name="cloud-upload-outline" size={12} color="#fff" />
              <Text style={s.heroChipText}>동기화 대기 {pendingCount}건</Text>
            </View>
            <View style={s.heroChip}>
              <Ionicons name="sparkles-outline" size={12} color="#fff" />
              <Text style={s.heroChipText}>분석 완료 {analyzedCount}건</Text>
            </View>
          </View>
        </LinearGradient>

        {/* ── 요약 ── */}
        <View style={s.summaryRow}>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(217, 70, 168, 0.10)' }]}>
              <Ionicons name="albums-outline" size={16} color={theme.colors.accent} />
            </View>
            <Text style={s.summaryValue}>{events.length}</Text>
            <Text style={s.summaryLabel}>누적 기록</Text>
          </View>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(155, 89, 208, 0.10)' }]}>
              <Ionicons name="cloud-upload-outline" size={16} color={theme.colors.primary} />
            </View>
            <Text style={s.summaryValue}>{pendingCount}</Text>
            <Text style={s.summaryLabel}>동기화 대기</Text>
          </View>
          <View style={s.summaryCard}>
            <View style={[s.summaryIconWrap, { backgroundColor: 'rgba(0, 200, 120, 0.10)' }]}>
              <Ionicons name="sparkles-outline" size={16} color="#00A862" />
            </View>
            <Text style={s.summaryValue}>{analyzedCount}</Text>
            <Text style={s.summaryLabel}>분석 완료</Text>
          </View>
        </View>

        {/* ── 바로가기 ── */}
        <Text style={s.section}>바로가기</Text>

        <NavRow
          icon="hardware-chip-outline"
          tint="rgba(155, 89, 208, 0.10)"
          color={theme.colors.primaryDark}
          title="기기 상태"
          desc={isConnected ? '배터리 · 저장 공간 · 센서 모니터링' : '기기를 연결하면 상태가 표시됩니다'}
          onPress={() => router.push('/(tabs)/device')}
        />
        <NavRow
          icon="stats-chart-outline"
          tint="rgba(217, 70, 168, 0.10)"
          color={theme.colors.accent}
          title="데이터 기록"
          desc="주간 발생 빈도와 증상 통계"
          onPress={() => router.push('/(tabs)/record')}
        />
        <NavRow
          icon="analytics-outline"
          tint="rgba(0, 200, 120, 0.10)"
          color="#00A862"
          title="데이터 분석"
          desc={pendingCount > 0 ? `동기화 대기 ${pendingCount}건 · AI 상황 분석` : 'AI 상황 분석 결과 보기'}
          onPress={() => router.push('/(tabs)/analysis')}
        />

        {/* ── 의료진 공유 코드 ──
            의사는 이 코드로 의료진 대시보드에서 데이터를 열람한다.
            (원격 열람은 Firebase 설정 후 활성 — 미설정 시에도 코드는
            미리 발급되어 안내가 가능하다) */}
        {patientCode && (
          <View style={s.codeCard}>
            <View style={[s.iconWrap, { backgroundColor: 'rgba(155, 89, 208, 0.10)' }]}>
              <Ionicons name="medkit-outline" size={20} color={theme.colors.primary} />
            </View>
            <View style={s.cardInfo}>
              <Text style={s.cardTitle}>의료진 공유 코드</Text>
              <Text style={s.cardDesc}>진료 시 의료진에게 알려주세요</Text>
            </View>
            <Text style={s.codeValue}>{patientCode}</Text>
          </View>
        )}
      </ScrollView>
    </GradientBackground>
  );
}

function NavRow({
  icon,
  tint,
  color,
  title,
  desc,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  color: string;
  title: string;
  desc: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity activeOpacity={0.65} onPress={onPress}>
      <View style={s.card}>
        <View style={[s.iconWrap, { backgroundColor: tint }]}>
          <Ionicons name={icon} size={20} color={color} />
        </View>
        <View style={s.cardInfo}>
          <Text style={s.cardTitle}>{title}</Text>
          <Text style={s.cardDesc} numberOfLines={1}>{desc}</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 100,
  },

  // ── 의료진 공유 코드 카드 ──
  codeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  codeValue: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
    color: theme.colors.primaryDark,
  },

  title: {
    fontSize: 26,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 16,
  },
  greeting: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: -12,
    marginBottom: 16,
  },

  // ── 연결 상태 카드 ──
  connectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  connectIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  connectIconWrapOn: {
    backgroundColor: theme.colors.primary,
  },
  connectInfo: {
    flex: 1,
    marginRight: 8,
  },
  connectTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  connectTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    marginRight: 6,
  },
  connectTitleOff: {
    color: theme.colors.textPrimary,
  },
  connectDesc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.success,
  },
  dotOff: {
    backgroundColor: theme.colors.error,
  },

  // ── 히어로 ──
  hero: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 12,
    shadowColor: theme.colors.primaryDark,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heroLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
  },
  heroIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroValueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 6,
    marginBottom: 14,
  },
  heroValue: {
    fontSize: 44,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 48,
  },
  heroUnit: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    marginLeft: 4,
    marginBottom: 6,
  },
  heroFooter: {
    flexDirection: 'row',
    gap: 8,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
    gap: 4,
  },
  heroChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },

  // ── 요약 카드 ──
  summaryRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  summaryIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  summaryLabel: {
    fontSize: 11,
    color: theme.colors.textSecondary,
  },

  // ── 섹션 ──
  section: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    marginBottom: 10,
    marginLeft: 2,
  },

  // ── 바로가기 카드 ──
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardInfo: {
    flex: 1,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  cardDesc: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
});
