import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, FlatList, TouchableOpacity, Alert, ActivityIndicator, Modal, Image } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../../constants/theme';
import { TicEventCard } from '../../components/analysis/TicEventCard';
import { FrameViewer } from '../../components/analysis/FrameViewer';
import { GradientBackground } from '../../components/ui/GradientBackground';
import { useEventStore } from '../../stores/useEventStore';
import { useAnalysisStore } from '../../stores/useAnalysisStore';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { mediaSyncManager, MediaSyncResult } from '../../services/data/MediaSyncManager';
import { autoSyncController } from '../../services/data/AutoSyncController';
import { MediaRepository } from '../../services/data/MediaRepository';
import { dataRouter } from '../../services/data/DataRouter';
import { firebaseSync } from '../../services/cloud/FirebaseSync';
import { playMediaExternally } from '../../services/media/MediaPlayer';
import { TicEvent } from '../../types/tic-event';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ── 리스트 행 모델 ──
type ListRow =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'group'; key: string; events: TicEvent[]; expanded: boolean }
  | { kind: 'event'; key: string; event: TicEvent; compact: boolean };

// 같은 날짜에 연속된 no_media 이벤트가 이 수 이상이면 그룹 카드로 축약
const NO_MEDIA_GROUP_MIN = 3;

// 연속 '횟수만 기록' 감지를 1장으로 요약하는 접이식 그룹 카드
function NoMediaGroupCard({
  events,
  expanded,
  onToggle,
}: {
  events: TicEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  // events는 최신순 — [0]이 마지막 감지, 끝이 첫 감지
  const first = fmt(events[events.length - 1].timestamp);
  const last = fmt(events[0].timestamp);
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onToggle}>
      <View style={[styles.groupCard, expanded && styles.groupCardExpanded]}>
        <View style={styles.groupIcon}>
          <Ionicons name="pulse-outline" size={17} color={theme.colors.primary} />
        </View>
        <View style={styles.groupTextWrap}>
          <Text style={styles.groupTitle}>틱 기록됨 {events.length}회</Text>
          <Text style={styles.groupDesc}>
            {first} ~ {last} · 횟수만 기록된 감지
          </Text>
        </View>
        <View style={styles.groupCountPill}>
          <Text style={styles.groupCountText}>{events.length}</Text>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={theme.colors.textSecondary}
        />
      </View>
    </TouchableOpacity>
  );
}

export default function AnalysisScreen() {
  const events = useEventStore((state) => state.events);
  // 자동 동기화(카드)와 수동 가져오기(링크)의 busy 상태를 분리한다 —
  // 하나의 isSyncing으로 묶으면 폴더 가져오기 중에 상단 카드까지
  // "가져오는 중"으로 바뀌는 상태 커플링이 생긴다.
  const [isAutoSyncing, setIsAutoSyncing] = useState(false);
  const [isManualBusy, setIsManualBusy] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<TicEvent | null>(null);

  // ── "이 폰이 실제로 드라이브에 닿는가" (도달성 프로브) ──
  // usbState(BLE 텔레메트리)는 "어떤 호스트든 세션 중"이라는 뜻일 뿐이다 —
  // 기기를 PC에 꽂아도 ready가 되므로, 그것만으로 "연결됨" 배너를 띄우면
  // 폰과 무관한 세션까지 연결된 것처럼 보인다. 배너는 silent 스캔이
  // 실제로 폴더를 읽는 데 성공했을 때(driveLinked)만 띄운다.
  const usbState = useDeviceStore((state) => state.usbState);
  const [driveLinked, setDriveLinked] = useState(false);

  const pendingCount = events.filter(e => e.transferStatus === 'pending_media').length;

  // 정렬은 events가 실제로 바뀔 때만 — 텔레메트리성 리렌더마다 전체
  // slice+sort가 반복되는 것을 방지 (이벤트 다건 누적 대비)
  const sortedEvents = useMemo(
    () =>
      events
        .slice()
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [events],
  );

  // ── 리스트 행 구성 ──
  // 동질 카드 도배(특히 '횟수만 기록' no_media 홍수)의 가독성 해법 3중주:
  //  ① 날짜 섹션 헤더(오늘/어제/M월 D일 + 하루 감지 횟수) — 시간축 구획
  //  ② no_media는 컴팩트 1줄 행 — 정보량에 밀도를 맞춤
  //  ③ 같은 날짜의 연속 no_media 3건 이상은 접이식 그룹 카드 1장으로 축약
  //     (탭으로 펼치면 개별 행 — 상세 모달 접근성 유지)
  // FlatList 가상화로 보존 상한(2,000건)까지도 스크롤 성능을 유지한다.
  // 날짜 헤더 '오늘/어제' 라벨의 기준 시각 — 화면 재진입 시 날짜가 바뀌었을
  // 때만 갱신한다(자정 경과 후 스테일 라벨 교정).
  // 표시 도중 자정을 넘는 사례는 다음 진입에서 교정된다 — 리스트는 focus
  // 상태에서만 보이므로 상시 타이머보다 이 편이 낫다.
  const [dayStamp, setDayStamp] = useState<number>(() => Date.now());

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const listRows = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    const now = new Date(dayStamp);
    const todayKey = now.toDateString();
    const yesterdayKey = new Date(now.getTime() - 86400000).toDateString();

    // 날짜별 총 감지 횟수 선계산 (헤더 우측 표기)
    const dayCounts = new Map<string, number>();
    for (const e of sortedEvents) {
      const k = new Date(e.timestamp).toDateString();
      dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1);
    }

    let i = 0;
    let currentDateKey: string | null = null;
    while (i < sortedEvents.length) {
      const ev = sortedEvents[i];
      const d = new Date(ev.timestamp);
      const dateKey = d.toDateString();
      if (dateKey !== currentDateKey) {
        currentDateKey = dateKey;
        const label =
          dateKey === todayKey ? '오늘'
          : dateKey === yesterdayKey ? '어제'
          : `${d.getMonth() + 1}월 ${d.getDate()}일`;
        rows.push({
          kind: 'header',
          key: `hdr_${dateKey}`,
          label,
          count: dayCounts.get(dateKey) ?? 0,
        });
      }
      if (ev.transferStatus === 'no_media') {
        // 같은 날짜의 연속 no_media 런 수집
        const run: TicEvent[] = [];
        let j = i;
        while (
          j < sortedEvents.length &&
          sortedEvents[j].transferStatus === 'no_media' &&
          new Date(sortedEvents[j].timestamp).toDateString() === dateKey
        ) {
          run.push(sortedEvents[j]);
          j++;
        }
        if (run.length >= NO_MEDIA_GROUP_MIN) {
          // 그룹 키 = 런의 최고령 이벤트 id — 새 감지가 최신 쪽에 붙어도
          // 키가 유지되어 펼침 상태가 튕기지 않는다
          const key = `grp_${run[run.length - 1].id}`;
          const expanded = expandedGroups.has(key);
          rows.push({ kind: 'group', key, events: run, expanded });
          if (expanded) {
            for (const e of run) rows.push({ kind: 'event', key: e.id, event: e, compact: true });
          }
        } else {
          for (const e of run) rows.push({ kind: 'event', key: e.id, event: e, compact: true });
        }
        i = j;
      } else {
        rows.push({ kind: 'event', key: ev.id, event: ev, compact: false });
        i++;
      }
    }
    return rows;
  }, [sortedEvents, expandedGroups, dayStamp]);

  // 절대 위치 탭바(65 + 시스템 인셋)에 콘텐츠 하단이 가려지지 않도록
  const insets = useSafeAreaInsets();
  const scrollPadBottom = 65 + insets.bottom + 24;

  // SAF 권한 미부여 상태에서 드라이브가 열렸을 때 1회성 안내 — silent
  // 자동 동기화 경로는 권한 요청창을 띄우지 못하므로(interactive:false)
  // 최초 사용자는 "케이블을 꽂았는데 아무 일도 없는" 무음 실패에 갇힌다.
  // 배너 대신 명시적 안내로 수동 동기화 카드를 유도한다.
  const needsSetupNoticeShownRef = useRef(false);

  const runSilentSync = useCallback(async () => {
    const result = await mediaSyncManager.autoSyncFromDevice({ interactive: false });
    // skipped(이미 동기화 진행 중 등)는 도달성 판정 근거가 아니다 —
    // 이 결과로 driveLinked를 갱신하면 스캔 없이 '연결됨' 오판이 된다.
    if (!result.skipped) {
      setDriveLinked(!result.deviceUnavailable && !result.needsSetup);
    }
    if (result.needsSetup && !needsSetupNoticeShownRef.current) {
      needsSetupNoticeShownRef.current = true;
      Alert.alert(
        '동기화 폴더 지정 필요',
        '기기 미디어를 자동으로 가져오려면 동기화 폴더를 한 번만 지정해야 합니다.\n\n' +
          '위의 "기기 미디어 동기화" 카드를 눌러 지정을 완료해주세요.',
      );
    }
    if (result.matchedEventIds.length > 0) {
      console.log(`[Analysis] Silent sync imported ${result.matchedEventIds.length} events`);
    }
    // 회당 상한 초과 이월분은 루트 컨트롤러가 배치를 연쇄 실행해 완주한다
    // (BLE 미연결이라 usbState 트리거가 없는 경로까지 커버).
    if (result.deferredEvents > 0) {
      autoSyncController.requestDrain();
    }
    return result;
  }, []);

  // 드라이브 노출(ready) 감지 → 자동 동기화 + 도달성 판정.
  // 세션 종료 시에는 배너를 내린다.
  // 'ready'는 USB 열거 시점(STARTED)에 오므로 Android의 실제 볼륨
  // 마운트(fsck 포함, 수 초~수십 초)보다 먼저 도착한다 — 1회성 시도는
  // 확정 실패 후 침묵하게 되므로, 마운트가 끝날 때까지 백오프
  // 재시도한다(케이블 연결 → 자동 동기화의 실질 구현).
  useEffect(() => {
    if (usbState !== 'ready') {
      setDriveLinked(false);
      return;
    }
    let active = true;
    (async () => {
      let skips = 0;
      for (let attempt = 0; active && attempt < 10; attempt++) {
        const result = await runSilentSync();
        if (!active || !result) return;
        // 재시도가 의미 있는 결과만 계속: 마운트 전(deviceUnavailable) 또는
        // 동시 실행으로 건너뜀(skipped). 성공/권한 미설정 등은 종결.
        if (!result.deviceUnavailable && !result.skipped) return;
        // 연속 skipped는 '루트 컨트롤러가 이 드라이브를 실제로 읽고 있다'는
        // 뜻이다 — 이때 배너를 미연결로 두면 동기화가 도는 중에도 화면이
        // '수동 동기화 필요'로 보인다. 도달성이 입증된 것으로 취급한다.
        if (result.skipped && ++skips >= 3) setDriveLinked(true);
        await new Promise((r) => setTimeout(r, 4000));
        if (!active || useDeviceStore.getState().usbState !== 'ready') return;
      }
    })();
    return () => { active = false; };
  }, [usbState, runSilentSync]);

  // NOTE: 틱 감지 시점의 자동 동기화는 의도적으로 두지 않는다 —
  // 동기화는 ①C-to-C 연결 감지 ②화면 진입 ③수동 가져오기로만 돈다.

  // ── 화면 진입 시 silent 자동 동기화 ──
  // DeFoTic 기기(USB 드라이브)가 연결되어 있고 SAF 권한이 있으면
  // 사용자 조작 없이 evt_* 미디어를 자동으로 가져온다.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      // 자정 경과 후 재진입 시 날짜 헤더 기준일 교정 (동일 날짜면 no-op —
      // 이전 값 유지로 불필요한 리렌더 없음)
      setDayStamp(prev =>
        new Date(prev).toDateString() === new Date().toDateString() ? prev : Date.now(),
      );
      (async () => {
        const result = await runSilentSync();
        if (!active || !result) return;

        // 동기화는 완료됐지만 분석 트리거가 유실된 이벤트 복구.
        // (failed는 상세 보기의 수동 재시도로 처리)
        //  - pending/미기록: 정상 재트리거 대상
        //  - 'analyzing'인데 실제 진행 중(isAnalyzing)이 아님: 앱이 분석
        //    도중 종료돼 상태만 남은 고착 — 여기서 되살리지 않으면
        //    "AI 분석 중"에 영구히 머문다 (스토어 로드 시 pending 변환과
        //    이중 안전망)
        const analysisStore = useAnalysisStore.getState();
        useEventStore.getState().events
          .filter(e =>
            e.transferStatus === 'synced' &&
            (e.analysisStatus === 'pending' || !e.analysisStatus ||
              (e.analysisStatus === 'analyzing' && !analysisStore.isAnalyzing(e.id))),
          )
          .forEach(e => dataRouter.triggerAnalysis(e.id));

        // 오프라인 중 분석 완료된 이벤트의 클라우드 재동기화
        // (Firebase 미설정 시 즉시 no-op, 실패 무해)
        firebaseSync
          .syncPendingUploads()
          .catch(e => console.warn('[Analysis] pending cloud sync failed:', e));
      })();
      return () => { active = false; };
    }, [runSilentSync]),
  );

  const showSyncOutcome = (result: MediaSyncResult) => {
    if (result.canceled) {
      // 선택창을 여는 동안 자동 드레인이 양보하고 물러났을 수 있다 —
      // 취소로 돌아왔으면 남은 백로그를 이어받도록 재시동한다.
      autoSyncController.requestDrain();
      return;
    }
    if (result.skipped) {
      // silent 스캔(화면 진입/케이블 감지)이 도는 중에 카드를 탭한 경우 —
      // 무반응이면 버튼이 죽은 것처럼 보이므로 진행 사실을 알린다.
      Alert.alert(
        '동기화 진행 중',
        '이미 자동 동기화가 진행되고 있습니다. 잠시 후 결과가 반영됩니다.',
      );
      return;
    }

    if (result.deviceUnavailable) {
      // 지정된 폴더 접근 실패 = ①기기 미연결(가장 흔함) 또는 ②잘못된
      // 폴더 지정/권한 소실. ②는 재지정으로만 복구되므로 선택지를 준다.
      Alert.alert(
        '기기를 찾을 수 없습니다',
        'DeFoTic 기기가 USB 케이블로 연결되어 있는지 확인해주세요.\n\n' +
          '연결되어 있는데도 계속 실패하면 동기화 폴더를 다시 지정해주세요.',
        [
          { text: '확인', style: 'cancel' },
          {
            text: '폴더 다시 지정',
            onPress: async () => {
              await mediaSyncManager.resetSyncDirectory();
              handleAutoSync();
            },
          },
        ],
      );
      return;
    }

    // 복사(I/O) 실패는 어느 분기에서든 사용자가 알아야 한다 — 부분 성공
    // 라운드에서 가려지면 "가져왔다"는 안내만 보고 누락을 눈치채지 못한다.
    // 실패한 파트는 승격이 보류되어 다음 동기화가 이어서 재시도한다.
    const copyFailNote =
      result.copyFailedFiles.length > 0
        ? `\n\n파일 ${result.copyFailedFiles.length}개는 전송 중 오류로 가져오지 못했습니다. ` +
          '케이블 연결을 확인한 뒤 다시 동기화하면 이어서 가져옵니다.'
        : '';
    if (result.copyFailedFiles.length > 0) {
      console.warn('[Analysis] Copy-failed media files:', result.copyFailedFiles);
    }

    if (result.matchedEventIds.length > 0) {
      Alert.alert(
        '동기화 완료',
        `${result.matchedEventIds.length}건의 이벤트 미디어를 가져왔습니다.\nAI 분석이 자동으로 시작됩니다.` +
          (result.unmatchedFiles.length > 0
            ? `\n\n매핑되지 않은 파일 ${result.unmatchedFiles.length}개는 건너뛰었습니다.`
            : '') +
          (result.deferredEvents > 0
            ? `\n\n오래된 이벤트 ${result.deferredEvents}건은 잠시 후 자동으로 이어서 가져옵니다.`
            : '') +
          copyFailNote,
      );
      if (result.deferredEvents > 0) autoSyncController.requestDrain();
    } else if (result.copyFailedFiles.length > 0) {
      // 가져온 것이 하나도 없고 복사 실패만 있는 경우 — 케이블/드라이브 문제
      Alert.alert(
        '전송 중 오류가 발생했습니다',
        `${result.copyFailedFiles.length}개 파일을 가져오지 못했습니다.\n\n` +
          'USB 케이블 연결을 확인한 뒤 다시 동기화하면 이어서 가져옵니다.',
      );
    } else if (result.thumbOnlyEventIds.length > 0) {
      // 스냅샷만 발견 — 본 미디어(영상/음성)는 아직 기기에 없다.
      // "가져올 미디어 없음"으로 표시하면 실제로 카드가 추가된 화면과
      // 모순되므로 정확히 안내한다.
      Alert.alert(
        '스냅샷만 가져왔습니다',
        `${result.thumbOnlyEventIds.length}건의 이벤트에서 틱 직전 스냅샷만 발견했습니다.\n` +
          '영상/음성 파일은 기기에 없거나 저장이 중단된 이벤트입니다.',
      );
    } else if (result.skippedSynced > 0) {
      // 새로 가져온 건 없지만 이미 동기화된 이벤트가 있었던 경우 —
      // "미디어 없음"으로 오해하지 않도록 구분해서 알린다
      Alert.alert(
        '새 미디어 없음',
        `이미 동기화된 이벤트 ${result.skippedSynced}건은 건너뛰었습니다.\n` +
          '재분석이 필요하면 이벤트 상세 보기에서 다시 시도할 수 있습니다.',
      );
    } else if (result.unmatchedFiles.length > 0) {
      // 파일명 규칙 불일치 상세(원시 파일명 목록)는 콘솔 로그로만 남긴다 —
      // 사용자 화면에는 행동 지향 안내만 표시
      console.warn('[Analysis] Unmatched media files:', result.unmatchedFiles);
      Alert.alert(
        '가져올 수 없는 파일입니다',
        'DeFoTic 기기에서 저장한 파일이 아니거나 폴더 구조가 다릅니다.\n\n' +
          '"폴더에서 가져오기"로 기기 폴더 전체를 선택하면 자동으로 가져올 수 있습니다.',
      );
    } else {
      Alert.alert(
        '가져올 미디어 없음',
        '기기 저장소에서 새로운 틱 이벤트 미디어를 찾지 못했습니다.',
      );
    }
  };

  const handleAutoSync = async () => {
    if (isAutoSyncing) return;
    setIsAutoSyncing(true);
    try {
      const hasDir = await mediaSyncManager.hasSyncDirectory();
      if (!hasDir) {
        // 최초 1회: 폴더 선택창이 뜨기 전에 무엇을 선택해야 하는지 안내.
        // 기기 UUID(BLE 수신)가 있으면 선택창이 DeFoTic 드라이브 루트에서
        // 바로 열리므로 "이 폴더 사용"만 누르면 된다. 힌트가 무시되는
        // 환경(기기 미연결 등)을 위한 수동 경로도 함께 안내.
        await new Promise<void>((resolve) =>
          Alert.alert(
            '동기화 폴더 지정 (최초 1회)',
            '곧 열리는 폴더 선택 창에서 하단의 "이 폴더 사용" 버튼을 눌러주세요.\n\n' +
              '만약 휴대폰 내부 폴더가 열리면: 좌측 상단 메뉴(☰)에서 ' +
              '"DeFoTic TicRecorder"(USB 드라이브)를 선택해주세요.\n\n' +
              '한 번만 지정하면 다음부터는 자동으로 동기화됩니다.',
            [{ text: '확인', onPress: () => resolve() }],
          ),
        );
      }
      const result = await mediaSyncManager.autoSyncFromDevice({ interactive: true });
      if (!result.skipped) {
        setDriveLinked(!result.deviceUnavailable && !result.needsSetup && !result.canceled);
      }
      showSyncOutcome(result);
    } catch (e) {
      console.error('[Analysis] Auto sync failed:', e);
      Alert.alert('동기화 실패', '미디어를 가져오는 중 오류가 발생했습니다. 다시 시도해주세요.');
    } finally {
      setIsAutoSyncing(false);
    }
  };

  // 폴더 단위 수동 가져오기 — 이벤트가 evt_* '폴더'(영상+음성 파트 세트)로
  // 저장되므로 파일 단위 선택보다 이 경로가 기본이다.
  const handleFolderPick = async () => {
    if (isManualBusy) return;
    setIsManualBusy(true);
    try {
      const result = await mediaSyncManager.pickFolderAndImport();
      showSyncOutcome(result);
    } catch (e: any) {
      console.error('[Analysis] Folder pick failed:', e);
      Alert.alert('동기화 실패', e?.message || '폴더를 가져오는 중 오류가 발생했습니다.');
    } finally {
      setIsManualBusy(false);
    }
  };

  const handleManualPick = async () => {
    if (isManualBusy) return;
    setIsManualBusy(true);
    try {
      const result = await mediaSyncManager.pickAndImportMedia();
      showSyncOutcome(result);
    } catch (e: any) {
      console.error('[Analysis] Manual pick failed:', e);
      Alert.alert('동기화 실패', e?.message || '파일을 가져오는 중 오류가 발생했습니다.');
    } finally {
      setIsManualBusy(false);
    }
  };

  // FlatList 행 렌더 — 헤더/그룹/이벤트 3종 (모델은 listRows useMemo 참조)
  const renderRow = useCallback(
    ({ item }: { item: ListRow }) => {
      switch (item.kind) {
        case 'header':
          return (
            <View style={styles.dateHeader}>
              <Text style={styles.dateHeaderLabel}>{item.label}</Text>
              <Text style={styles.dateHeaderCount}>감지 {item.count}회</Text>
            </View>
          );
        case 'group':
          return (
            <NoMediaGroupCard
              events={item.events}
              expanded={item.expanded}
              onToggle={() => toggleGroup(item.key)}
            />
          );
        case 'event':
          return <TicEventCard event={item.event} compact={item.compact} onPress={setSelectedEvent} />;
      }
    },
    [toggleGroup],
  );

  const listHeader = (
    <>
      <Text style={styles.title}>데이터 분석</Text>

        {/* C-to-C 동기화 카드: "이 폰이 실제로 드라이브를 읽을 수 있을 때"만
            상태 배너로 전환 — usbState만 보면 PC 세션도 연결로 오인한다 */}
        {usbState === 'ready' && driveLinked ? (
          <View style={[styles.syncCard, styles.syncCardActive]}>
            <LinearGradient
              colors={theme.gradients.button}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.syncIconWrap}
            >
              {isAutoSyncing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="swap-horizontal" size={20} color="#fff" />
              )}
            </LinearGradient>
            <View style={styles.syncTextWrap}>
              <Text style={styles.syncTitle} numberOfLines={1}>
                {isAutoSyncing ? '미디어 가져오는 중...' : '기기 연결됨 · 자동 동기화 중'}
              </Text>
              <Text style={styles.syncDesc}>
                기기 드라이브가 열려 있어 새 이벤트를 자동으로 가져옵니다
              </Text>
            </View>
            <View style={styles.syncLiveDot} />
          </View>
        ) : (
          <TouchableOpacity activeOpacity={0.8} onPress={handleAutoSync} disabled={isAutoSyncing}>
            <View style={styles.syncCard}>
              <LinearGradient
                colors={theme.gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.syncIconWrap}
              >
                {isAutoSyncing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="hardware-chip-outline" size={20} color="#fff" />
                )}
              </LinearGradient>
              <View style={styles.syncTextWrap}>
                <Text style={styles.syncTitle}>
                  {isAutoSyncing ? '미디어 가져오는 중...' : '기기 미디어 동기화'}
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
        )}

        {/* 수동 가져오기: 이벤트는 evt_* '폴더' 단위로 저장되므로 폴더
            가져오기가 기본, 파일 선택은 보조 경로(여러 개는 길게 눌러 선택).
            경로 재설정은 항상 노출 — 실패 팝업 후 재시도할 방법이 없던
            막다른 UX를 제거한다 */}
        <View style={styles.manualRow}>
          <TouchableOpacity onPress={handleFolderPick} disabled={isManualBusy}>
            <Text style={styles.manualLink}>
              {isManualBusy ? '가져오는 중...' : '폴더에서 가져오기'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.manualDivider}>·</Text>
          <TouchableOpacity onPress={handleManualPick} disabled={isManualBusy}>
            <Text style={styles.manualLink}>파일 직접 선택</Text>
          </TouchableOpacity>
          <Text style={styles.manualDivider}>·</Text>
          <TouchableOpacity
            onPress={async () => {
              if (isAutoSyncing) return;
              await mediaSyncManager.resetSyncDirectory();
              handleAutoSync();
            }}
            disabled={isAutoSyncing}
          >
            <Text style={styles.manualLink}>경로 재설정</Text>
          </TouchableOpacity>
        </View>

      <Text style={styles.sectionTitle}>상황 맥락 분석</Text>
    </>
  );

  return (
    <GradientBackground>
      <FlatList
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingBottom: scrollPadBottom }]}
        data={listRows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={<Text style={styles.emptyText}>수집된 데이터가 없습니다.</Text>}
        initialNumToRender={16}
        windowSize={11}
        removeClippedSubviews
      />

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

interface MediaPart {
  fileType: 'video' | 'audio';
  partIndex: number;
  path: string;
}

function EventDetail({ event: initialEvent, onClose }: { event: TicEvent; onClose: () => void }) {
  // 스냅샷 금지: 모달이 열린 동안 분석 완료/피드백 저장이 일어나면
  // 화면도 따라 바뀌어야 한다 — 스토어의 라이브 이벤트를 구독한다.
  const liveEvent = useEventStore(
    (state) => state.events.find(e => e.id === initialEvent.id),
  );
  const event = liveEvent ?? initialEvent;

  const a = event.aiAnalysis;

  // 이 이벤트로 실제 Import된 미디어 파트 목록 (분석과 무관하게 재생 가능)
  const [mediaParts, setMediaParts] = useState<MediaPart[]>([]);
  const [playingPath, setPlayingPath] = useState<string | null>(null);

  // 인앱 프레임 뷰어가 표시 중인 영상 파트 — 기본값은 마지막(최신) 파트:
  // 순환 세그먼트 재배열 규칙상 마지막 파트에 틱 발생 순간이 담긴다.
  const [viewerPath, setViewerPath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    MediaRepository.listEventMedia(event.id).then(parts => {
      if (!active) return;
      setMediaParts(parts);
      const videos = parts.filter(p => p.fileType === 'video');
      setViewerPath(videos.length > 0 ? videos[videos.length - 1].path : null);
    });
    return () => { active = false; };
  }, [event.id, event.videoPath, event.audioPath]);

  const videoParts = mediaParts.filter(p => p.fileType === 'video');
  const audioParts = mediaParts.filter(p => p.fileType === 'audio');

  const handlePlay = async (part: MediaPart) => {
    if (playingPath) return;
    setPlayingPath(part.path);
    try {
      const result = await playMediaExternally(part.path, part.fileType);
      if (!result.ok) {
        Alert.alert('재생할 수 없습니다', result.error ?? '알 수 없는 오류가 발생했습니다.');
      }
    } finally {
      setPlayingPath(null);
    }
  };

  const handleFeedback = (feedback: 'confirmed' | 'false_positive') => {
    // 같은 버튼을 다시 누르면 라벨 해제 (실수 방지)
    const next = event.userFeedback === feedback ? undefined : feedback;
    useEventStore.getState().setUserFeedback(event.id, next).then(() => {
      // 라벨 변경을 클라우드에 즉시 반영 시도 (오프라인이면 무해 실패 —
      // setUserFeedback이 cloudSyncedAt을 지워 두므로 다음 focus 때 재시도)
      firebaseSync.syncPendingUploads().catch(() => {});
    });
  };

  const dateStr = new Date(event.timestamp).toLocaleString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const statusText =
    event.transferStatus === 'pending_media' ? '미디어 동기화 대기'
    : event.transferStatus === 'no_media' ? '감지 기록됨'
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

        {/* ── 상황 맥락 뷰어 (분석과 독립 — 수동 파일 선택 없이 즉시 확인) ──
            영상: 순수 JS 프레임 뷰어(FrameViewer)가 AVI에서 JPEG 프레임을
            직접 추출해 인앱 표시한다 — 네이티브 코덱 의존 0 = 크래시 불가.
            음성: 같은 파트의 WAV를 JS에서 PCM으로 디코드해 expo-audio로
            영상과 동기 재생한다 — 기기 원본(IMA ADPCM)을 네이티브 코덱에
            직접 주지 않으므로 코덱 크래시 경로와 분리된다. 리빌드 전에는
            자동으로 무음 플립북 폴백. 외부 플레이어 링크는 보조 경로 유지. */}
        {/* 게이트에 thumbPath 포함: 미디어 파트 없이 스냅샷만
            임포트된 이벤트도 아래 thumbHero 폴백이 도달 가능해야 한다 */}
        {(mediaParts.length > 0 || !!event.thumbPath) && (
          <View style={styles.detailSection}>
            <View style={styles.detailLabelRow}>
              <Ionicons name="film-outline" size={14} color={theme.colors.primaryDark} />
              <Text style={styles.detailLabel}>상황 맥락 뷰어</Text>
            </View>

            {/* 영상 파트 선택 + 인앱 프레임 뷰어 */}
            {videoParts.length > 0 && (
              <>
                {videoParts.length > 1 && (
                  <View style={styles.mediaRow}>
                    {videoParts.map(part => (
                      <TouchableOpacity
                        key={part.path}
                        style={[
                          styles.mediaChip,
                          viewerPath === part.path && styles.mediaChipActive,
                        ]}
                        activeOpacity={0.7}
                        onPress={() => setViewerPath(part.path)}
                      >
                        <Ionicons
                          name="videocam"
                          size={13}
                          color={viewerPath === part.path ? '#fff' : theme.colors.primaryDark}
                        />
                        <Text
                          style={[
                            styles.mediaChipText,
                            viewerPath === part.path && { color: '#fff' },
                          ]}
                        >
                          구간 {part.partIndex + 1}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                {/* key=경로: 파트 전환 시 강제 리마운트 — in-flight 프레임
                    로드가 새 파트의 캐시/화면을 오염시키는 경로 차단.
                    audioPath: 같은 파트 번호의 음성 — 영상과 동기 통합 재생 */}
                {viewerPath && (
                  <FrameViewer
                    key={viewerPath}
                    videoPath={viewerPath}
                    audioPath={
                      audioParts.find(
                        ap =>
                          ap.partIndex ===
                          videoParts.find(vp => vp.path === viewerPath)?.partIndex,
                      )?.path
                    }
                  />
                )}
              </>
            )}

            {/* 영상이 없고 썸네일만 있는 이벤트 — 스냅샷으로 대체 표시 */}
            {videoParts.length === 0 && event.thumbPath && (
              <Image
                source={{ uri: event.thumbPath }}
                style={styles.thumbHero}
                resizeMode="cover"
              />
            )}

            {/* 음성 재생 + 영상 외부 재생 (외부 플레이어 위임) */}
            <View style={[styles.mediaRow, { marginTop: 10 }]}>
              {audioParts.map(part => (
                <TouchableOpacity
                  key={part.path}
                  style={styles.mediaChip}
                  activeOpacity={0.7}
                  disabled={playingPath !== null}
                  onPress={() => handlePlay(part)}
                >
                  {playingPath === part.path ? (
                    <ActivityIndicator size="small" color={theme.colors.primaryDark} />
                  ) : (
                    <Ionicons name="musical-notes" size={13} color={theme.colors.primaryDark} />
                  )}
                  <Text style={styles.mediaChipText}>음성 {part.partIndex + 1}</Text>
                </TouchableOpacity>
              ))}
              {videoParts.map(part => (
                <TouchableOpacity
                  key={part.path}
                  style={styles.mediaChip}
                  activeOpacity={0.7}
                  disabled={playingPath !== null}
                  onPress={() => handlePlay(part)}
                >
                  {playingPath === part.path ? (
                    <ActivityIndicator size="small" color={theme.colors.primaryDark} />
                  ) : (
                    <Ionicons name="open-outline" size={13} color={theme.colors.primaryDark} />
                  )}
                  <Text style={styles.mediaChipText}>영상 {part.partIndex + 1} 외부 재생</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.mediaHint}>
              구간 순서는 시간순이며 마지막 구간에 틱 발생 순간이 담겨 있습니다.
            </Text>
          </View>
        )}

        {a ? (
          <>
            <DetailSection icon="pin-outline" label="상황 맥락" body={a.situation} />
            <DetailSection icon="earth-outline" label="환경 분석" body={a.environment} />
            <DetailSection icon="pulse-outline" label="틱 증상 상세" body={a.ticDetail} />

            {/* ── CBIT 기능 평가 (프롬프트 v2 신규 필드 — 구 레코드는 미표시) ── */}
            {a.premonitorySigns && (
              <DetailSection icon="eye-outline" label="전구 신호 관찰" body={a.premonitorySigns} />
            )}
            {a.antecedent && (
              <DetailSection icon="arrow-back-circle-outline" label="선행 사건 (직전 상황)" body={a.antecedent} />
            )}
            {a.consequences && (
              <DetailSection icon="arrow-forward-circle-outline" label="후속 결과 (주변 반응)" body={a.consequences} />
            )}

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
              {a.competingResponse && (
                <>
                  <View style={[styles.detailLabelRow, { marginTop: 10 }]}>
                    <Ionicons name="swap-horizontal-outline" size={14} color={theme.colors.primaryDark} />
                    <Text style={styles.detailLabel}>경쟁 반응(CR) 훈련 제안</Text>
                  </View>
                  <Text style={styles.recommendText}>{a.competingResponse}</Text>
                </>
              )}
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
              name={
                event.transferStatus === 'pending_media' ? 'cloud-offline-outline'
                : event.transferStatus === 'no_media' ? 'pulse-outline'
                : 'hourglass-outline'
              }
              size={36}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.pendingText}>
              {event.transferStatus === 'pending_media'
                ? '기기를 USB 케이블로 연결하면 영상/음성이 자동으로 동기화되고 AI 분석이 시작됩니다.'
                : event.transferStatus === 'no_media'
                  ? '기기 사용 중 감지되어 횟수만 기록된 이벤트입니다. 영상/음성과 AI 분석은 제공되지 않습니다.'
                  : event.analysisStatus === 'failed'
                    ? // 실패 '사유'를 그대로 보여준다 — API 키 미설정/네트워크/
                      // 형식 거부는 각각 사용자의 다음 행동이 다르다
                      event.analysisError ||
                      '분석에 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.'
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

        {/* ── 오탐/미탐 피드백 라벨 (기능명세서 1.3.2) ──
            감지 정확도를 사용자가 직접 라벨링 — Edge Impulse 재학습과
            LoRA 파인튜닝 데이터셋의 지도 신호가 된다. 같은 버튼을 다시
            누르면 라벨이 해제된다. */}
        {event.transferStatus !== 'pending_media' && (
          <View style={styles.feedbackCard}>
            <Text style={styles.feedbackLabel}>이 감지가 정확했나요?</Text>
            <View style={styles.feedbackRow}>
              <TouchableOpacity
                style={[
                  styles.feedbackBtn,
                  event.userFeedback === 'confirmed' && styles.feedbackBtnActive,
                ]}
                activeOpacity={0.7}
                onPress={() => handleFeedback('confirmed')}
              >
                <Ionicons
                  name="checkmark-circle"
                  size={15}
                  color={event.userFeedback === 'confirmed' ? '#fff' : '#00A862'}
                />
                <Text
                  style={[
                    styles.feedbackBtnText,
                    { color: event.userFeedback === 'confirmed' ? '#fff' : '#00A862' },
                  ]}
                >
                  실제 틱 맞음
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.feedbackBtn,
                  event.userFeedback === 'false_positive' && styles.feedbackBtnActiveError,
                ]}
                activeOpacity={0.7}
                onPress={() => handleFeedback('false_positive')}
              >
                <Ionicons
                  name="close-circle"
                  size={15}
                  color={event.userFeedback === 'false_positive' ? '#fff' : theme.colors.error}
                />
                <Text
                  style={[
                    styles.feedbackBtnText,
                    { color: event.userFeedback === 'false_positive' ? '#fff' : theme.colors.error },
                  ]}
                >
                  틱 아님 (오탐)
                </Text>
              </TouchableOpacity>
            </View>
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
  // 세션 중 상태 배너 모드 — 버튼이 아님을 시각적으로 구분
  syncCardActive: {
    borderWidth: 1,
    borderColor: 'rgba(124, 77, 255, 0.35)',
    backgroundColor: 'rgba(124, 77, 255, 0.08)',
  },
  syncLiveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34C759',
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
  },
  manualRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  manualDivider: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  emptyText: {
    ...theme.typography.body1,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  },

  // ── 날짜 섹션 헤더 ──
  dateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  dateHeaderLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  dateHeaderCount: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },

  // ── no_media 그룹 카드 ──
  groupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.48)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.55)',
    gap: 10,
  },
  groupCardExpanded: {
    borderColor: 'rgba(155, 89, 208, 0.30)',
    backgroundColor: 'rgba(155, 89, 208, 0.06)',
    marginBottom: 6,
  },
  groupIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupTextWrap: {
    flex: 1,
  },
  groupTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  groupDesc: {
    fontSize: 11,
    color: theme.colors.textSecondary,
  },
  groupCountPill: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 7,
    backgroundColor: 'rgba(155, 89, 208, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.primaryDark,
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

  // ── 미디어 재생 ──
  mediaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mediaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(155, 89, 208, 0.25)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  mediaChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  mediaChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  thumbHero: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 12,
    marginTop: 8,
    backgroundColor: '#1D1230',
  },
  mediaHint: {
    fontSize: 10,
    color: theme.colors.textSecondary,
    marginTop: 6,
  },

  // ── 오탐/미탐 피드백 ──
  feedbackCard: {
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderRadius: 14,
    padding: 14,
    marginTop: 4,
    marginBottom: 8,
  },
  feedbackLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 10,
  },
  feedbackRow: {
    flexDirection: 'row',
    gap: 8,
  },
  feedbackBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 10,
    paddingVertical: 9,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(155, 89, 208, 0.18)',
  },
  feedbackBtnActive: {
    backgroundColor: '#00A862',
    borderColor: '#00A862',
  },
  feedbackBtnActiveError: {
    backgroundColor: theme.colors.error,
    borderColor: theme.colors.error,
  },
  feedbackBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
