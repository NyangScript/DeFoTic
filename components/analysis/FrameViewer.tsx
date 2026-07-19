import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator, PanResponder, LayoutChangeEvent } from 'react-native';
import { Buffer } from 'buffer';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../constants/theme';
import {
  AviIndex,
  ByteSource,
  fileByteSource,
  frameIndexAt,
  parseAviIndex,
  readFrameJpeg,
} from '../../services/media/AviIndex';
import { decodeDeviceWav, buildPcmWav } from '../../services/media/ImaAdpcm';

/**
 * 상황 맥락 뷰어 — MJPEG AVI를 "순수 JS"로 파싱해 표시하고, 음성(IMA
 * ADPCM WAV)을 JS 디코드 → 표준 PCM WAV → expo-audio로 동기 재생한다.
 *
 * 구조 판단 (앱 안정성 최우선):
 *  - MJPEG AVI는 Android 표준 디코더(ExoPlayer/MediaCodec)가 지원하지 않아
 *    네이티브 영상 재생은 불가/고위험. 프레임은 JS가 idx1 인덱스로 부분
 *    읽기해 data URI Image로 렌더한다 — 네이티브 코덱 의존 0.
 *  - 음성은 유일하게 네이티브 엔진이 필요한 축이다. 단, 기기 원본
 *    (IMA ADPCM)을 절대 네이티브에 주지 않고 JS에서 표준 PCM16 WAV로
 *    변환한 뒤에만 expo-audio에 전달한다 — 원본 포맷을 네이티브 코덱에
 *    직접 투입할 때의 크래시 위험과 구조적으로 분리된다.
 *  - expo-audio 미설치/리빌드 전에는 자동으로 무음 플립북 폴백.
 *
 * 타임라인: 60초 고정 가정으로 라벨을 계산하면 3~45초 실길이 파트도 끝이
 * "60s"로 표기된다 — avih의 실측 usPerFrame × 프레임 수로 계산한
 * 실길이(AviIndex.durationSec)를 사용한다.
 */

const MAX_SAMPLED_FRAMES = 36;   // 스크럽 격자 프레임 수 (I/O·캐시 churn 억제)
const CACHE_LIMIT = 48;          // 프레임 data URI LRU 상한 (~1MB 이하)
const SYNC_TICK_MS = 150;        // 오디오 마스터 클록 폴링 주기

function fs() {
  return require('expo-file-system/legacy');
}

/** expo-audio 동적 로드 — 미설치/리빌드 전이면 null (플립북 폴백) */
function loadAudioModule(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-audio');
    return mod && typeof mod.createAudioPlayer === 'function' ? mod : null;
  } catch {
    return null;
  }
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface FrameViewerProps {
  videoPath: string;
  /** 같은 파트의 음성 WAV — 있으면 영상과 동기 통합 재생 */
  audioPath?: string;
}

export function FrameViewer({ videoPath, audioPath }: FrameViewerProps) {
  const [index, setIndex] = useState<AviIndex | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [frameNo, setFrameNo] = useState(0);      // 현재 프레임 번호 (0..totalFrames-1)
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioReady, setAudioReady] = useState<'idle' | 'preparing' | 'ready' | 'unavailable'>('idle');

  const sourceRef = useRef<ByteSource | null>(null);

  // data URI LRU 캐시 — Map은 삽입 순서를 유지하므로 첫 키가 최고령
  const cacheRef = useRef<Map<number, string>>(new Map());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 요청 시퀀스 가드: 빠른 스크럽/재생 중 캐시 미스가 병렬 읽기를 만들면
  // '마지막에 해소된' 응답이 화면을 이기는 구조가 된다 — 커서와 표시
  // 프레임 영구 불일치. 각 로드에 단조 증가 번호를 부여하고, 자신이
  // 최신 요청일 때만 화면을 갱신한다.
  const reqSeqRef = useRef(0);

  // ── 오디오 플레이어 (expo-audio, 지연 준비) ──
  const audioModRef = useRef<any | null>(null);
  const playerRef = useRef<any | null>(null);
  const releasePlayer = useCallback(() => {
    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      try {
        p.pause?.();
        // SDK 54 expo-audio: 명령형 플레이어 정리는 remove() (release 별칭 방어)
        (p.remove ?? p.release)?.call(p);
      } catch {}
    }
  }, []);

  // ── 1. 인덱스 파싱 (마운트/경로 변경 시) ──
  useEffect(() => {
    let active = true;
    setIndex(null);
    setParseError(null);
    setFrameUri(null);
    setPlaying(false);
    setAudioReady('idle');
    cacheRef.current.clear();
    releasePlayer();

    const source = fileByteSource(videoPath);
    sourceRef.current = source;

    parseAviIndex(source)
      .then(parsed => {
        if (!active) return;
        setIndex(parsed);
        // 틱 발생 순간은 파트의 '끝'에 있다 — 마지막 프레임에서 시작
        setFrameNo(parsed.totalFrames - 1);
      })
      .catch(e => {
        if (!active) return;
        console.warn('[FrameViewer] parse failed:', e?.message || e);
        setParseError(e?.message || '프레임을 읽지 못했습니다');
      });
    return () => {
      active = false;
      releasePlayer();
    };
  }, [videoPath, releasePlayer]);

  // ── 2. 스크럽 격자: 유효 엔트리 중 균등 샘플 ──
  const sampledFrames = useMemo(() => {
    if (!index) return [] as number[];
    const valid: number[] = [];
    for (let i = 0; i < index.totalFrames; i++) {
      if (index.entries[i].dataSize > 0) valid.push(i);
    }
    if (valid.length === 0) return [];
    const n = Math.min(MAX_SAMPLED_FRAMES, valid.length);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(valid[n === 1 ? 0 : Math.round((i * (valid.length - 1)) / (n - 1))]);
    }
    return out;
  }, [index]);

  // ── 3. 프레임 로드 (LRU 캐시 경유 + 최신 요청 승리) ──
  const loadFrame = useCallback(async (parsed: AviIndex, at: number) => {
    const seq = ++reqSeqRef.current;
    const cache = cacheRef.current;
    const hit = cache.get(at);
    if (hit) {
      cache.delete(at);
      cache.set(at, hit);
      setFrameUri(hit);
      // 히트도 최신 요청이다: seq를 올려둔 채 스피너를 안 끄면, 진행
      // 중이던 미스 로드의 finally(seq 불일치)가 스피너를 내리지 못해
      // 로딩 오버레이가 무기한 잔류한다.
      setLoadingFrame(false);
      return;
    }
    const source = sourceRef.current;
    if (!source || source.id !== parsed.sourceId) return; // 스테일 조합 차단
    setLoadingFrame(true);
    try {
      const entry = parsed.entries[at];
      const buf = await readFrameJpeg(source, entry);
      const uri = `data:image/jpeg;base64,${buf.toString('base64')}`;
      if (!mountedRef.current) return;
      cache.set(at, uri);
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      if (seq === reqSeqRef.current) setFrameUri(uri);
    } catch (e) {
      // 해당 프레임만 실패 — 마지막 성공 프레임을 유지한다
      console.warn(`[FrameViewer] frame ${at} load failed:`, e);
    } finally {
      if (mountedRef.current && seq === reqSeqRef.current) setLoadingFrame(false);
    }
  }, []);

  useEffect(() => {
    // 인덱스가 '현재 경로'에서 파싱된 것일 때만 로드 (key 리마운트 1차,
    // sourceId 태그 2차 방어)
    if (index && index.sourceId === videoPath) loadFrame(index, frameNo);
  }, [index, frameNo, loadFrame, videoPath]);

  // ── 4. 오디오 준비 (첫 재생 탭에서 지연 수행) ──
  // 기기 WAV(IMA ADPCM)를 JS 디코드 → 표준 PCM WAV로 캐시에 기록 →
  // expo-audio 플레이어 생성. 어떤 실패도 '무음 플립북'으로만 강등된다.
  // in-flight 단일 비행: playerRef는 디코드+파일쓰기의 긴 await '이후'에야
  // 세팅되므로, 가드가 이것뿐이면 준비 중 이중 탭이 풀 디코드 2회 +
  // 플레이어 2개(첫 번째는 회수 불능 누수·이중 재생)를 만든다 —
  // 동시 호출은 같은 Promise를 공유한다.
  const prepPromiseRef = useRef<Promise<any | null> | null>(null);

  const prepareAudio = useCallback((): Promise<any | null> => {
    if (!audioPath) return Promise.resolve(null);
    if (playerRef.current) return Promise.resolve(playerRef.current);
    if (prepPromiseRef.current) return prepPromiseRef.current;

    const flight = (async (): Promise<any | null> => {
      const mod = audioModRef.current ?? loadAudioModule();
      audioModRef.current = mod;
      if (!mod) {
        setAudioReady('unavailable');
        return null;
      }

      setAudioReady('preparing');
      try {
        const FileSystem = fs();
        // 캐시 파일명은 원본 경로 해시 — 같은 파트 재열람 시 재사용된다
        let h = 0;
        for (let i = 0; i < audioPath.length; i++) h = ((h << 5) - h + audioPath.charCodeAt(i)) | 0;
        const cachePath = `${FileSystem.cacheDirectory}defotic_pcm_${(h >>> 0).toString(16)}.wav`;

        // 캐시 히트 시 디코드 생략: 60초 파트는 96만 샘플 디코드 + 2.5MB
        // base64 인코딩이 JS 스레드에서 동기 실행돼 첫 탭에 수백 ms
        // 프리즈를 만든다 — 재열람은 파일 존재 확인만 수행한다.
        const cached = await FileSystem.getInfoAsync(cachePath);
        if (!cached.exists || !cached.size) {
          const b64 = await FileSystem.readAsStringAsync(audioPath, { encoding: 'base64' });
          const decoded = decodeDeviceWav(Buffer.from(b64, 'base64'));
          const pcmWav = buildPcmWav(decoded.samples, decoded.sampleRate);
          // 원자적 캐시 쓰기: 쓰기 도중 앱이 죽으면 부분 파일이
          // exists && size>0 검사를 통과해 잘린 오디오가 영구 재사용된다 —
          // 임시 파일에 쓴 뒤 rename으로 커밋한다.
          // tmp 이름은 비행별 고유 — 리마운트를 경유한 동시 준비 비행이
          // 같은 tmp를 인터리브해 손상 파일이 커밋되는 경로를 차단한다.
          // move(rename)는 목적지 대체가 원자적이라 마지막 승자만 남는다.
          const tmpPath = `${cachePath}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}.tmp`;
          await FileSystem.writeAsStringAsync(tmpPath, pcmWav.toString('base64'), {
            encoding: 'base64',
          });
          try {
            await FileSystem.moveAsync({ from: tmpPath, to: cachePath });
          } catch (e) {
            await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
            throw e;
          }
        }

        // 무음 스위치 상태에서도 들리도록 (iOS 전용 옵션 — 실패 무해)
        try { await mod.setAudioModeAsync?.({ playsInSilentMode: true }); } catch {}

        const player = mod.createAudioPlayer({ uri: cachePath });
        if (!mountedRef.current) {
          try { (player.remove ?? player.release)?.call(player); } catch {}
          return null;
        }
        playerRef.current = player;
        setAudioReady('ready');
        return player;
      } catch (e) {
        // 네이티브 모듈 미링크(리빌드 전)·디코드 실패 등 — 플립북 폴백
        console.warn('[FrameViewer] audio prepare failed:', e);
        setAudioReady('unavailable');
        return null;
      }
    })().finally(() => {
      prepPromiseRef.current = null;
    });

    prepPromiseRef.current = flight;
    return flight;
  }, [audioPath]);

  // ── 5. 재생 루프 ──
  // 오디오가 있으면 player.currentTime이 마스터 클록: 실측 usPerFrame으로
  // 시각→프레임을 유도해 영상이 음성을 추종한다(완전 동기). 오디오가
  // 영상보다 짧게 끝나면(펌웨어 백로그 폐기) 남은 구간은 무음 벽시계
  // 페이싱으로 이어 재생한다 — 오디오 종점에서 정지해 버리면 영상 후반을
  // 볼 수 없기 때문이다. 오디오가 없으면 무음 플립북.
  const frameNoRef = useRef(0);
  frameNoRef.current = frameNo;
  // 재생 시작 위치가 오디오 범위 밖일 때 무음 이어재생 시작 시각(초)
  const syntheticStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing || !index) return;

    const player = playerRef.current;
    if (player) {
      // 로딩 유예: 파일 소스 플레이어는 play() 직후 잠깐 playing=false일 수
      // 있다 — 그 순간을 '재생 종료'로 오판해 즉시 멈추지 않도록, 재생이
      // 실제로 굴러가기 전(t≈0)에는 최대 ~6초까지 기다린다.
      let warmupTicks = 0;
      let lastGoodT = 0;
      let syntheticFrom = syntheticStartRef.current ?? -1;   // >=0: 무음 이어재생
      let syntheticTicks = 0;
      syntheticStartRef.current = null;

      const timer = setInterval(() => {
        const endSec = Math.max(index.durationSec, 0.001);

        // 무음 이어재생 모드 — 벽시계 페이싱으로 남은 프레임 소화
        if (syntheticFrom >= 0) {
          syntheticTicks++;
          const t = syntheticFrom + (syntheticTicks * SYNC_TICK_MS) / 1000;
          if (t >= endSec) {
            setPlaying(false);
            return;
          }
          setFrameNo(frameIndexAt(index, t));
          return;
        }

        let t = 0;
        let stillPlaying = true;
        try {
          t = Number(player.currentTime) || 0;
          stillPlaying = player.playing !== false;
        } catch {
          stillPlaying = false;
        }
        if (t > lastGoodT) lastGoodT = t;
        const started = lastGoodT > 0.25;

        if (!started && !stillPlaying) {
          if (++warmupTicks < 40) return;   // 아직 로딩 중 — 대기
          // 오디오가 끝내 시동 걸리지 않음 — 현 위치부터 무음 이어재생.
          // 실패 가시화 + 죽은 플레이어 해제: 플레이어를 유지하면 이후
          // 모든 재생 탭이 이 6초 워밍업을 반복하고, 뒤늦게 시동 걸린
          // 소리가 합성 클록 밑에서 병주한다. 해제하면 다음 탭에서
          // 캐시로부터 재준비(디코드 생략)된다.
          console.warn('[FrameViewer] audio never started (corrupt cache?) — silent fallback');
          setAudioReady('unavailable');
          try { player.pause?.(); } catch {}
          releasePlayer();
          syntheticFrom = (frameNoRef.current * index.usPerFrame) / 1e6;
          syntheticTicks = 0;
          return;
        }
        if (!stillPlaying) {
          if (lastGoodT < endSec - 0.75) {
            // 오디오가 영상보다 짧게 끝남 — 남은 구간 무음 이어재생
            syntheticFrom = lastGoodT;
            syntheticTicks = 0;
            return;
          }
          setPlaying(false);
          return;
        }
        if (t >= endSec + 2) {
          // 오디오 파트가 영상보다 최대 ~2초 길 수 있다(writer 랙 상한)
          setPlaying(false);
          return;
        }
        if (started) setFrameNo(frameIndexAt(index, Math.min(t, index.durationSec)));
      }, SYNC_TICK_MS);
      return () => clearInterval(timer);
    }

    // 무음 플립북 — 실길이/샘플 수로 간격을 계산해 실제 시간감을 재현
    if (sampledFrames.length === 0) return;
    const stepMs = Math.min(600, Math.max(100, (index.durationSec * 1000) / sampledFrames.length));
    const timer = setInterval(() => {
      setFrameNo(prev => {
        const pos = sampledFrames.findIndex(f => f >= prev);
        const next = pos < 0 ? 0 : pos + 1;
        if (next >= sampledFrames.length) {
          setPlaying(false);
          return prev;
        }
        return sampledFrames[next];
      });
    }, stepMs);
    return () => clearInterval(timer);
  }, [playing, index, sampledFrames]);

  const handlePlayPause = useCallback(async () => {
    if (!index) return;
    if (playing) {
      setPlaying(false);
      try { playerRef.current?.pause?.(); } catch {}
      return;
    }
    const player = await prepareAudio();
    if (!mountedRef.current) return;
    // await 이후에는 탭 시점 클로저의 frameNo가 낡았을 수 있다(준비 중
    // 사용자가 스크럽) — ref로 최신 위치를 재판독한다
    const curFrame = frameNoRef.current;
    const atEnd = curFrame >= index.totalFrames - 1;
    const startFrame = atEnd ? 0 : curFrame;
    const startSec = (startFrame * index.usPerFrame) / 1e6;
    if (atEnd) setFrameNo(0);
    syntheticStartRef.current = null;
    if (player) {
      let audioDur = 0;
      try { audioDur = Number(player.duration) || 0; } catch {}
      if (audioDur > 0 && startSec >= audioDur - 0.05) {
        // 시작 위치가 오디오 범위 밖(영상이 더 긴 파트) — 무음 이어재생
        syntheticStartRef.current = startSec;
      } else {
        try {
          // seekTo는 Promise다 — await 없이 play()하면 시킹 전 0초부터
          // 재생돼 스크럽 위치가 무시될 수 있다
          await player.seekTo?.(startSec);
          player.play?.();
        } catch (e) {
          console.warn('[FrameViewer] audio play failed:', e);
          setAudioReady('unavailable');
          releasePlayer();
        }
      }
    }
    setPlaying(true);
  }, [index, playing, prepareAudio, releasePlayer]);

  // ── 6. 스크럽 바 (PanResponder — 외부 슬라이더 의존성 없음) ──
  const barWidthRef = useRef(1);
  const indexRef = useRef<AviIndex | null>(null);
  indexRef.current = index;
  const sampledRef = useRef<number[]>([]);
  sampledRef.current = sampledFrames;

  const scrubTo = useCallback((x: number) => {
    const parsed = indexRef.current;
    const grid = sampledRef.current;
    if (!parsed || grid.length === 0) return;
    const ratio = Math.max(0, Math.min(1, x / barWidthRef.current));
    setPlaying(false);
    const target = grid[Math.round(ratio * (grid.length - 1))];
    setFrameNo(target);
    // 오디오가 준비돼 있으면 같은 시각으로 시킹 — 재개 시 이어서 재생
    const p = playerRef.current;
    if (p) {
      try {
        p.pause?.();
        p.seekTo?.((target * parsed.usPerFrame) / 1e6);
      } catch {}
    }
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 모달 본문 ScrollView가 수직 제스처로 응답권을 뺏어가며 스크럽이
        // 끊기는 것을 방지 — 바를 잡은 동안에는 스크럽이 우선한다.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: evt => scrubTo(evt.nativeEvent.locationX),
        onPanResponderMove: evt => scrubTo(evt.nativeEvent.locationX),
      }),
    [scrubTo],
  );

  const onBarLayout = (e: LayoutChangeEvent) => {
    barWidthRef.current = Math.max(1, e.nativeEvent.layout.width);
  };

  if (parseError) {
    // 원시 예외 메시지는 사용자에게 보여주지 않는다 — 원인은 위의
    // console.warn(parse failed)으로만 남긴다
    return (
      <View style={s.errorBox}>
        <Ionicons name="film-outline" size={18} color={theme.colors.textSecondary} />
        <Text style={s.errorText}>
          미리보기를 만들 수 없습니다. 아래 재생 버튼으로 영상을 확인할 수 있습니다.
        </Text>
      </View>
    );
  }

  if (!index) {
    return (
      <View style={s.loadingBox}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
        <Text style={s.loadingText}>영상을 불러오는 중...</Text>
      </View>
    );
  }

  const ratio = index.totalFrames > 1 ? frameNo / (index.totalFrames - 1) : 1;
  const curSec = (frameNo * index.usPerFrame) / 1e6;

  return (
    <View style={s.wrap}>
      <View style={s.frameBox}>
        {frameUri ? (
          <Image source={{ uri: frameUri }} style={s.frame} resizeMode="contain" fadeDuration={0} />
        ) : (
          <ActivityIndicator size="small" color="#fff" />
        )}
        {loadingFrame && frameUri && (
          <View style={s.frameLoadingDot}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
      </View>

      {/* 스크럽 바 */}
      <View style={s.scrubRow}>
        <TouchableOpacity
          onPress={handlePlayPause}
          hitSlop={8}
          style={s.playBtn}
          disabled={audioReady === 'preparing'}
        >
          {audioReady === 'preparing' ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name={playing ? 'pause' : 'play'} size={16} color="#fff" />
          )}
        </TouchableOpacity>
        <View style={s.barTouch} onLayout={onBarLayout} {...panResponder.panHandlers}>
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: `${ratio * 100}%` }]} />
          </View>
          <View style={[s.barKnob, { left: `${ratio * 100}%` }]} pointerEvents="none" />
        </View>
        <Text style={s.timeLabel}>
          {formatTime(curSec)}/{formatTime(index.durationSec)}
        </Text>
      </View>

      {/* 개발 명령(npm ...)은 사용자 화면에 노출하지 않는다 —
          음성 재생 불가 사유는 콘솔 로그로만 구분한다 */}
      <Text style={s.hint}>
        {audioPath
          ? audioReady === 'unavailable'
            ? '틱 발생 순간은 구간의 끝부분입니다 · 이 영상은 소리 없이 재생됩니다'
            : '틱 발생 순간은 구간의 끝부분입니다 · 재생하면 음성과 함께 나옵니다'
          : '틱 발생 순간은 구간의 끝부분입니다 · 이 구간은 저장된 음성이 없습니다'}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginTop: 8,
  },
  frameBox: {
    width: '100%',
    aspectRatio: 4 / 3,
    backgroundColor: '#1D1230',
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: '100%',
    height: '100%',
  },
  frameLoadingDot: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  scrubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
  },
  playBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTouch: {
    flex: 1,
    height: 28,
    justifyContent: 'center',
  },
  barTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(155, 89, 208, 0.18)',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
  },
  barKnob: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.primaryDark,
    marginLeft: -7,
    borderWidth: 2,
    borderColor: '#fff',
  },
  timeLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    width: 64,
    textAlign: 'right',
  },
  hint: {
    fontSize: 10,
    color: theme.colors.textSecondary,
    marginTop: 6,
  },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(155, 89, 208, 0.06)',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
});
