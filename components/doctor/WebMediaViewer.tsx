import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Platform, PanResponder, LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../constants/theme';
import {
  AviIndex,
  ByteSource,
  blobByteSource,
  frameIndexAt,
  parseAviIndex,
  readFrameJpeg,
} from '../../services/media/AviIndex';
import { decodeDeviceWav } from '../../services/media/ImaAdpcm';
import { Buffer } from 'buffer';

/**
 * 의료진 웹 미디어 뷰어 — "업로드 없는 재생".
 *
 * 아키텍처 판단:
 *  - Firestore에는 미디어가 올라가지 않는다(프라이버시 결정 + 의료진 랜딩의
 *    사용자 대면 약속: "영상/음성 원본은 환자 기기 밖으로 업로드되지 않습니다").
 *    이 결정을 유지한 채 웹 재생을 성립시키는 방법은 브라우저 File API다 —
 *    환자/보호자가 SD 카드(USB 리더) 또는 전달받은 evt_* 파일을 의사 PC에서
 *    "로컬로" 여는 것. 파일은 브라우저 밖으로 전송되지 않는다.
 *  - 코덱: 브라우저 <video>는 AVI 컨테이너 자체를 지원하지 않고 <audio>는
 *    IMA ADPCM을 신뢰성 있게 디코드하지 못한다. 따라서 앱과 동일한 순수 JS
 *    파서(AviIndex — Blob ByteSource)로 JPEG 프레임을 추출해 <img>로 그리고,
 *    음성은 ImaAdpcm 디코더로 PCM 변환 후 WebAudio로 재생한다. 서버 0,
 *    트랜스코딩 0, 네이티브 의존 0.
 *  - 동기화: WebAudio AudioContext 클록을 마스터로, AVI 헤더의 실측
 *    usPerFrame으로 시각→프레임을 유도한다 (인앱 FrameViewer와 동일 원리).
 *
 * 웹 전용 컴포넌트 — DOM API는 전부 핸들러 내부에서만 사용하고 호출부가
 * Platform.OS === 'web'을 가드하므로 네이티브 번들에 실려도 무해하다.
 */

const FRAME_CACHE_LIMIT = 24;
const SYNC_TICK_MS = 150;

export function WebMediaViewer() {
  const [videoIndex, setVideoIndex] = useState<AviIndex | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [audioDurationSec, setAudioDurationSec] = useState(0);
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [cursorSec, setCursorSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoSourceRef = useRef<ByteSource | null>(null);
  const frameCacheRef = useRef<Map<number, string>>(new Map());
  const reqSeqRef = useRef(0);

  // ── WebAudio 상태 (핸들러 안에서만 생성 — SSR/네이티브 안전) ──
  const audioCtxRef = useRef<any>(null);
  const audioBufferRef = useRef<any>(null);
  const srcNodeRef = useRef<any>(null);
  const playBaseRef = useRef({ ctxTime: 0, offsetSec: 0 });

  const totalSec = Math.max(videoIndex?.durationSec ?? 0, audioDurationSec);

  const stopAudio = useCallback(() => {
    const node = srcNodeRef.current;
    srcNodeRef.current = null;
    if (node) {
      try { node.onended = null; node.stop(); } catch {}
    }
  }, []);

  useEffect(() => () => {
    stopAudio();
    try { audioCtxRef.current?.close?.(); } catch {}
  }, [stopAudio]);

  // ── 프레임 표시 (LRU + 최신 요청 승리) ──
  const showFrameAt = useCallback(async (timeSec: number) => {
    const index = videoIndex;
    const source = videoSourceRef.current;
    if (!index || !source || source.id !== index.sourceId) return;
    const at = frameIndexAt(index, Math.min(timeSec, index.durationSec));
    const seq = ++reqSeqRef.current;
    const cache = frameCacheRef.current;
    const hit = cache.get(at);
    if (hit) {
      cache.delete(at);
      cache.set(at, hit);
      setFrameUri(hit);
      return;
    }
    try {
      const buf = await readFrameJpeg(source, index.entries[at]);
      // 캐시 오염 방지: await 사이에 파일이 교체됐으면 이전 영상의
      // 프레임을 새 영상 캐시에 넣지 않는다 — seq 가드는 setFrameUri만
      // 보호하고 cache.set은 보호하지 못한다
      if (videoSourceRef.current !== source) return;
      const uri = `data:image/jpeg;base64,${buf.toString('base64')}`;
      cache.set(at, uri);
      while (cache.size > FRAME_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      if (seq === reqSeqRef.current) setFrameUri(uri);
    } catch {
      // 손상 프레임 — 마지막 성공 프레임 유지
    }
  }, [videoIndex]);

  useEffect(() => {
    if (videoIndex) {
      // 틱 순간은 구간 끝 — 마지막 프레임에서 시작
      const endSec = videoIndex.durationSec;
      setCursorSec(endSec);
      showFrameAt(endSec);
    }
  }, [videoIndex, showFrameAt]);

  // ── 재생 클록: WebAudio currentTime → 프레임/커서 ──
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const ctx = audioCtxRef.current;
      if (ctx && srcNodeRef.current) {
        const t = playBaseRef.current.offsetSec + (ctx.currentTime - playBaseRef.current.ctxTime);
        if (t >= totalSec) {
          stopAudio();
          setPlaying(false);
          setCursorSec(totalSec);
          return;
        }
        setCursorSec(t);
        showFrameAt(t);
      } else if (videoIndex) {
        // 오디오 없는 무음 재생 — 실시간 페이싱
        setCursorSec(prev => {
          const next = prev + SYNC_TICK_MS / 1000;
          if (next >= videoIndex.durationSec) {
            setPlaying(false);
            return videoIndex.durationSec;
          }
          showFrameAt(next);
          return next;
        });
      }
    }, SYNC_TICK_MS);
    return () => clearInterval(timer);
  }, [playing, totalSec, videoIndex, showFrameAt, stopAudio]);

  const startAudioAt = useCallback((offsetSec: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return false;
    // 시작 위치가 오디오 범위 밖(영상이 더 긴 경우) — 클램프로 되감지 말고
    // 무음 재생 경로에 맡긴다
    if (offsetSec >= buffer.duration - 0.05) return false;
    try {
      const w = globalThis as any;
      if (!audioCtxRef.current) {
        const Ctx = w.AudioContext || w.webkitAudioContext;
        if (!Ctx) return false;
        audioCtxRef.current = new Ctx();
      }
      const ctx = audioCtxRef.current;
      ctx.resume?.();
      stopAudio();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const clamped = Math.max(0, Math.min(offsetSec, buffer.duration - 0.01));
      node.start(0, clamped);
      srcNodeRef.current = node;
      playBaseRef.current = { ctxTime: ctx.currentTime, offsetSec: clamped };
      return true;
    } catch (e) {
      console.warn('[WebMediaViewer] WebAudio start failed:', e);
      return false;
    }
  }, [stopAudio]);

  const handlePlayPause = useCallback(() => {
    if (playing) {
      // 일시정지 — 현재 위치 보존
      const ctx = audioCtxRef.current;
      if (ctx && srcNodeRef.current) {
        const t = playBaseRef.current.offsetSec + (ctx.currentTime - playBaseRef.current.ctxTime);
        setCursorSec(Math.min(t, totalSec));
      }
      stopAudio();
      setPlaying(false);
      return;
    }
    const startAt = cursorSec >= totalSec - 0.2 ? 0 : cursorSec;
    setCursorSec(startAt);
    startAudioAt(startAt);   // 오디오 없으면 false — 무음 재생으로 진행
    setPlaying(true);
  }, [playing, cursorSec, totalSec, startAudioAt, stopAudio]);

  // ── 파일 열기 (DOM input — 웹 전용) ──
  const openFiles = useCallback(() => {
    if (Platform.OS !== 'web') return;
    const doc = (globalThis as any).document;
    if (!doc) return;
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.avi,.wav';
    input.multiple = true;
    input.onchange = async () => {
      // 새 파일 로드는 항상 정지 상태에서 — 이전 오디오가 계속 흘러나오는
      // 라벨-소리 불일치를 방지한다
      stopAudio();
      setPlaying(false);
      setError(null);
      const files: any[] = Array.from(input.files ?? []);
      for (const f of files) {
        const name: string = f.name || '';
        try {
          if (/\.avi$/i.test(name)) {
            // id에 크기·수정시각 포함 — 동명 파일 교체 시 스테일 인덱스 차단
            const source = blobByteSource(f, `${name}:${f.size}:${f.lastModified ?? ''}`);
            const index = await parseAviIndex(source);
            videoSourceRef.current = source;
            frameCacheRef.current.clear();
            setVideoIndex(index);
            setVideoName(name);
          } else if (/\.wav$/i.test(name)) {
            const ab = await f.arrayBuffer();
            const decoded = decodeDeviceWav(Buffer.from(new Uint8Array(ab)));
            // Int16 → Float32 → AudioBuffer (WebAudio 표준 도메인)
            const w = globalThis as any;
            const Ctx = w.AudioContext || w.webkitAudioContext;
            if (!Ctx) throw new Error('이 브라우저는 WebAudio를 지원하지 않습니다');
            if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
            const ctx = audioCtxRef.current;
            const audioBuffer = ctx.createBuffer(1, decoded.samples.length, decoded.sampleRate);
            const ch = audioBuffer.getChannelData(0);
            for (let i = 0; i < decoded.samples.length; i++) ch[i] = decoded.samples[i] / 32768;
            audioBufferRef.current = audioBuffer;
            setAudioDurationSec(decoded.durationSec);
            setAudioName(name);
          }
        } catch (e: any) {
          console.warn('[WebMediaViewer] open failed:', name, e);
          setError(`${name}: ${e?.message || '파일을 읽지 못했습니다'}`);
        }
      }
    };
    input.click();
  }, []);

  // ── 스크럽 바 ──
  const barWidthRef = useRef(1);
  const scrubTo = useCallback((x: number) => {
    if (totalSec <= 0) return;
    const ratio = Math.max(0, Math.min(1, x / barWidthRef.current));
    const t = ratio * totalSec;
    stopAudio();
    setPlaying(false);
    setCursorSec(t);
    showFrameAt(t);
  }, [totalSec, stopAudio, showFrameAt]);

  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: evt => scrubTo(evt.nativeEvent.locationX),
        onPanResponderMove: evt => scrubTo(evt.nativeEvent.locationX),
      }),
    [scrubTo],
  );
  const onBarLayout = (e: LayoutChangeEvent) => {
    barWidthRef.current = Math.max(1, e.nativeEvent.layout.width);
  };

  const fmt = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const ratio = totalSec > 0 ? Math.min(1, cursorSec / totalSec) : 0;

  return (
    <View>
      <View style={s.headRow}>
        <TouchableOpacity style={s.openBtn} onPress={openFiles} activeOpacity={0.8}>
          <Ionicons name="folder-open-outline" size={15} color="#fff" />
          <Text style={s.openBtnText}>영상/음성 파일 열기 (.avi / .wav)</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.privacyNote}>
        파일은 이 브라우저에서만 열리며 어디로도 전송되지 않습니다. 환자 기기의
        SD 카드(evt_* 폴더) 또는 전달받은 파일을 선택하세요 — 영상과 음성을 함께
        선택하면 동기 재생됩니다.
      </Text>
      {error && <Text style={s.errorText}>{error}</Text>}
      {(videoName || audioName) && (
        <Text style={s.fileLabel}>
          {videoName ? `영상: ${videoName}` : ''}
          {videoName && audioName ? '  ·  ' : ''}
          {audioName ? `음성: ${audioName}` : ''}
        </Text>
      )}

      {videoIndex && (
        <View style={s.frameBox}>
          {frameUri ? (
            <Image source={{ uri: frameUri }} style={s.frame} resizeMode="contain" />
          ) : (
            <Text style={{ color: '#fff', fontSize: 12 }}>프레임 로딩 중...</Text>
          )}
        </View>
      )}

      {(videoIndex || audioBufferRef.current) && (
        <View style={s.scrubRow}>
          <TouchableOpacity onPress={handlePlayPause} hitSlop={8} style={s.playBtn}>
            <Ionicons name={playing ? 'pause' : 'play'} size={16} color="#fff" />
          </TouchableOpacity>
          <View style={s.barTouch} onLayout={onBarLayout} {...panResponder.panHandlers}>
            <View style={s.barTrack}>
              <View style={[s.barFill, { width: `${ratio * 100}%` }]} />
            </View>
          </View>
          <Text style={s.timeLabel}>
            {fmt(cursorSec)}/{fmt(totalSec)}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  openBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  openBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  privacyNote: {
    fontSize: 11,
    lineHeight: 16,
    color: theme.colors.textSecondary,
    marginTop: 8,
  },
  errorText: {
    fontSize: 11,
    color: theme.colors.error,
    marginTop: 6,
  },
  fileLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.primaryDark,
    marginTop: 8,
  },
  frameBox: {
    width: '100%',
    maxWidth: 480,
    aspectRatio: 4 / 3,
    backgroundColor: '#1D1230',
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  frame: {
    width: '100%',
    height: '100%',
  },
  scrubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
    maxWidth: 480,
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
    // @ts-ignore — 웹 전용 커서 힌트 (네이티브에서는 무시됨)
    cursor: 'pointer',
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
  timeLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    width: 70,
    textAlign: 'right',
  },
});
