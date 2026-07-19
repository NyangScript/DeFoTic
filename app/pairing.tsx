import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { GradientButton } from '../components/ui/GradientButton';
import { theme } from '../constants/theme';
import { BLE_CONFIG } from '../constants/ble-config';
import { BleDevice } from '../types/ble';
import { GradientBackground } from '../components/ui/GradientBackground';
import { bleManager } from '../services/ble/BleManager';
import { useDeviceStore } from '../stores/useDeviceStore';
import { Ionicons } from '@expo/vector-icons';

// ═══════════════════════════════════════════
// 유틸리티 — 하드코딩 / mock 없음
// ═══════════════════════════════════════════

/** RSSI → 0~3 레벨 */
function signalLevel(rssi: number | null): number {
  if (rssi == null) return 0;
  if (rssi >= -55) return 3;
  if (rssi >= -70) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

/** 레벨 → 바 색상 */
function signalColor(level: number): string {
  if (level >= 3) return '#4CAF50';
  if (level >= 2) return '#8BC34A';
  if (level >= 1) return theme.colors.warning;
  return theme.colors.textSecondary;
}

/** advertising serviceUUIDs에 DeFoTic 서비스가 있는지 */
function isDeFoTicDevice(device: BleDevice): boolean {
  const target = BLE_CONFIG.SERVICES.TIC_DATA.toLowerCase();
  if (device.serviceUUIDs?.some(u => u.toLowerCase() === target)) return true;
  // fallback: 이름 기반 (서비스 UUID가 advertising에 포함 안 될 수도 있어서)
  const n = (device.name || '').toLowerCase();
  return n.includes(BLE_CONFIG.DEVICE_NAME_PREFIX.toLowerCase());
}

/** 기기 이름에서 Ionicons 아이콘 추정 */
function deviceIcon(name: string | null): keyof typeof Ionicons.glyphMap {
  if (!name) return 'bluetooth';
  const l = name.toLowerCase();
  if (l.includes('defotic'))                                      return 'hardware-chip-outline';
  if (l.includes('galaxy') || l.includes('phone') || l.includes('pixel') || l.includes('iphone')) return 'phone-portrait-outline';
  if (l.includes('book') || l.includes('laptop'))                 return 'laptop-outline';
  if (l.includes('watch') || l.includes('band') || l.includes('fit'))   return 'watch-outline';
  if (l.includes('buds') || l.includes('airpod') || l.includes('ear') || l.includes('headphone')) return 'headset-outline';
  if (l.includes('speaker') || l.includes('sound') || l.includes('anker') || l.includes('jbl') || l.includes('bose')) return 'volume-medium-outline';
  if (l.includes('tv') || l.includes('display'))                  return 'tv-outline';
  if (l.includes('purifier') || l.includes('air'))                return 'leaf-outline';
  return 'bluetooth';
}

// ═══════════════════════════════════════════
// 컴포넌트
// ═══════════════════════════════════════════

export default function PairingScreen() {
  // 웹 = 의료진 전용: BLE 페어링은 모바일 전용 동선이다. 직접 URL로
  // 진입해도 의료진 랜딩으로 보낸다 (Platform.OS는 런타임 불변이라
  // 훅 이전 조기 반환이 안전).
  if (Platform.OS === 'web') {
    return <Redirect href="/doctor" />;
  }

  const router = useRouter();
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const mounted = useRef(true);

  // ── 스캔 시작 ──
  const startScanning = useCallback(async () => {
    setScanError(null);
    setIsScanning(true);

    await bleManager.startContinuousScan(
      (updated) => {
        if (mounted.current) setDevices(updated);
      },
      (error) => {
        if (!mounted.current) return;
        setIsScanning(false);
        const msg = typeof error === 'string' ? error : '기기 검색 중 오류가 발생했습니다.';
        setScanError(msg);
        Alert.alert('블루투스 오류', msg);
      },
    );
  }, []);

  // ── 라이프사이클 ──
  useEffect(() => {
    mounted.current = true;
    startScanning();
    return () => {
      mounted.current = false;
      bleManager.stopContinuousScan();
    };
  }, [startScanning]);

  // ── 백그라운드 자동 재연결과의 경합 해소 ──
  // 홈의 silent 재연결이 이 화면과 병행할 수 있다: 재연결이 이기면 기기가
  // 광고를 멈춰(연결 중 광고 정지) 스캔 목록에 영영 안 뜨고, 사용자는
  // '검색된 기기 없음' 막다른 길에서 연결 실패로 오인한다. 이 화면에
  // 있는 동안 '새로' 성립된 연결을 감지하면 수동 연결과 동일한 성공
  // 동선을 태운다. (마운트 시점에 이미 연결돼 있던 경우는 제외 —
  // 연결 중에도 기기 교체를 위해 이 화면에 들어올 수 있다)
  const isConnected = useDeviceStore((state) => state.isConnected);
  const connectedAtMount = useRef<boolean | null>(null);
  useEffect(() => {
    if (connectedAtMount.current === null) {
      connectedAtMount.current = isConnected;
      if (isConnected) return;   // 마운트 시 이미 연결됨 — 자동 이탈 금지
    }
    if (!isConnected) {
      connectedAtMount.current = false;  // 이후의 신규 연결은 성공 동선 대상
      return;
    }
    if (connectedAtMount.current) return; // 마운트 시 연결 상태가 유지 중
    if (connectingId) return;  // 수동 연결 진행 중이면 그 경로가 내비게이션 처리
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/login');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // ── 기기 연결 ──
  const handleConnect = useCallback(async (device: BleDevice) => {
    setConnectingId(device.id);
    
    try {
      await bleManager.connectToDevice(device.id);
      if (!mounted.current) return;
      // 메인 화면에서 재연결하러 들어온 경우(스택 위에 떠 있음)에는 원래 화면으로 복귀,
      // 최초 온보딩 플로우에서는 환자 정보 등록으로 진행
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/login');
      }
    } catch (error: any) {
      if (!mounted.current) return;
      setConnectingId(null);
      const msg = error.message || '기기 연결에 실패했습니다. 페어링 모드를 확인해주세요.';
      Alert.alert('연결 실패', msg);
      // 연결 실패 → 스캔 재개
      startScanning();
    }
  }, [router, startScanning]);

  // ═══════════════════════════════════════════
  // 렌더 서브 컴포넌트
  // ═══════════════════════════════════════════

  /** 신호 바 (4단) */
  const SignalBars = React.memo(({ rssi }: { rssi: number | null }) => {
    const lv = signalLevel(rssi);
    const c  = signalColor(lv);
    return (
      <View style={s.signalWrap}>
        {[0, 1, 2, 3].map(i => (
          <View
            key={i}
            style={[
              s.signalBar,
              { height: 5 + i * 3 },
              { backgroundColor: i <= lv ? c : 'rgba(0,0,0,0.08)' },
            ]}
          />
        ))}
      </View>
    );
  });

  /** 기기 카드 */
  const renderDevice = useCallback(({ item }: { item: BleDevice }) => {
    const target   = isDeFoTicDevice(item);
    const loading  = connectingId === item.id;
    const icon     = deviceIcon(item.name);

    return (
      <TouchableOpacity
        activeOpacity={0.65}
        onPress={() => handleConnect(item)}
        disabled={!!connectingId}
      >
        <View style={[s.card, target && s.cardTarget]}>
          {/* 아이콘 */}
          <View style={[s.iconWrap, target && s.iconWrapTarget]}>
            <Ionicons
              name={icon}
              size={20}
              color={target ? '#fff' : theme.colors.primaryDark}
            />
          </View>

          {/* 기기 정보 — 이름은 advertising 원본 그대로 */}
          <View style={s.info}>
            <Text style={[s.name, target && s.nameTarget]} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={s.meta}>
              <SignalBars rssi={item.rssi} />
              {/* 신호 강도 수치 — 아이콘만으로는 미세한 세기 차이를 비교할 수
                  없어 dBm 텍스트를 병기한다 */}
              <Text style={s.rssi}>
                {item.rssi != null ? `${item.rssi} dBm` : ''}
              </Text>
            </View>
          </View>

          {/* 우측 */}
          <View style={s.trail}>
            {loading ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : target ? (
              <GradientButton
                title="연결"
                style={s.btn}
                onPress={() => handleConnect(item)}
              />
            ) : (
              <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [connectingId, handleConnect]);

  // ── 헤더 ──
  const Header = useCallback(() => (
    <View>
      {/* 타이틀 */}
      <Text style={s.title}>기기 연결</Text>

      {/* 상태 배너 */}
      <View style={s.banner}>
        <View style={s.bannerRow}>
          <View style={s.bannerLeft}>
            <Ionicons name="bluetooth" size={16} color={theme.colors.primary} />
            <Text style={s.bannerStatus}>
              {scanError ? '오류' : isScanning ? '검색 중' : '대기 중'}
            </Text>
          </View>
          {isScanning && <ActivityIndicator size="small" color={theme.colors.primary} />}
        </View>
        <Text style={s.bannerDesc}>
          DeFoTic 기기의 전원이 켜져 있는지 확인해주세요.{'\n'}주변 기기를 자동으로 검색하고 있습니다.
        </Text>
      </View>

      {/* 섹션 타이틀 */}
      <Text style={s.section}>연결 가능한 기기</Text>
    </View>
  ), [isScanning, scanError]);

  // ── 빈 상태 ──
  const Empty = useCallback(() => (
    <View style={s.empty}>
      {isScanning ? (
        <>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={s.emptyText}>주변 기기를 검색하고 있습니다…</Text>
        </>
      ) : scanError ? (
        <>
          <Ionicons name="alert-circle-outline" size={44} color={theme.colors.error} />
          <Text style={s.emptyText}>{scanError}</Text>
          <GradientButton title="다시 시도" style={{ marginTop: 16 }} onPress={startScanning} />
        </>
      ) : (
        <>
          <Ionicons name="bluetooth-outline" size={44} color={theme.colors.textSecondary} />
          <Text style={s.emptyText}>검색된 기기가 없습니다.</Text>
        </>
      )}
    </View>
  ), [isScanning, scanError, startScanning]);

  return (
    <GradientBackground style={s.root}>
      <FlatList
        data={devices}
        keyExtractor={d => d.id}
        renderItem={renderDevice}
        ListHeaderComponent={Header}
        ListEmptyComponent={Empty}
        contentContainerStyle={s.list}
        removeClippedSubviews={false}
        initialNumToRender={15}
        maxToRenderPerBatch={8}
        windowSize={11}
      />
    </GradientBackground>
  );
}

// ═══════════════════════════════════════════
// 스타일 — Figma 톤앤매너 + OneUI 참고
// ═══════════════════════════════════════════
const s = StyleSheet.create({
  root: { flex: 1 },

  list: {
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 32,
  },

  // ── 타이틀 ──
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 16,
  },

  // ── 상태 배너 ──
  banner: {
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  bannerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  bannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerStatus: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.colors.primary,
  },
  bannerDesc: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    lineHeight: 19,
  },

  // ── 섹션 ──
  section: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
    marginBottom: 10,
    marginLeft: 2,
  },

  // ── 기기 카드 ──
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.50)',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  cardTarget: {
    backgroundColor: 'rgba(155, 89, 208, 0.10)',
    borderColor: 'rgba(155, 89, 208, 0.30)',
    borderWidth: 1,
  },

  // ── 아이콘 ──
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(155, 89, 208, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  iconWrapTarget: {
    backgroundColor: theme.colors.primary,
  },

  // ── 기기 정보 ──
  info: {
    flex: 1,
    marginRight: 8,
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
    color: theme.colors.textPrimary,
    marginBottom: 2,
  },
  nameTarget: {
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rssi: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    marginLeft: 5,
  },
  // ── 신호 바 ──
  signalWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 14,
    gap: 1.5,
  },
  signalBar: {
    width: 3.5,
    borderRadius: 1,
  },

  // ── 우측 ──
  trail: {
    minWidth: 52,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  btn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
  },

  // ── 빈 상태 ──
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: 14,
    maxWidth: 240,
    lineHeight: 20,
  },
});
