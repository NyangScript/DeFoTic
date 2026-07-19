import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TicEvent } from '../types/tic-event';
import { MediaRepository } from '../services/data/MediaRepository';

interface EventState {
  events: TicEvent[];
  isLoading: boolean;
  hasLoaded: boolean;
  loadEvents: () => Promise<void>;
  addEvent: (event: TicEvent) => Promise<void>;
  updateEvent: (id: string, updates: Partial<TicEvent>) => Promise<void>;
  setUserFeedback: (id: string, feedback: TicEvent['userFeedback']) => Promise<void>;
  clearEvents: () => Promise<void>;
}

// ── 영속 레이아웃 (v2: 청크 분할) ──
// v1은 전체 배열을 단일 키에 저장했다. aiAnalysis(한국어 장문 11필드)가
// 붙으면 건당 1~3KB로, 보존 상한(2,000건) 근처에서 단일 값이 수 MB에
// 달해 Android AsyncStorage(SQLite)의 행 읽기 한도인 CursorWindow(~2MB)를
// 초과한다 — getItem이 throw하면 전 기록을 읽지 못하고, 이후 첫 쓰기가
// 빈 배열로 덮어써 영구 소실되는 경로였다.
// v2는 이벤트를 월(YYYY-MM) × 최대 300건 파트로 분할 저장한다:
//   메타 키:  @tic_events_store:meta  = { v: 2, parts: string[] }
//   파트 키:  @tic_events_store:p:2026-07#0  (월 내 오래된 것부터 파트 0,1,…)
// 파트당 최대 ~0.9MB(300×3KB)로 행 한도에 구조적으로 닿지 않고, 쓰기는
// 내용이 실제로 바뀐 파트만 수행한다(신규 이벤트는 해당 월 마지막 파트만).
const LEGACY_KEY = '@tic_events_store';
const META_KEY = '@tic_events_store:meta';
const PART_KEY_PREFIX = '@tic_events_store:p:';
const PART_MAX_EVENTS = 300;

// 보존 상한: 이벤트 레코드는 최근 것부터 이 개수까지만 유지한다.
// 2,000건 ≈ 정상 사용 수개월 분량이며, 초과분은 최고령부터 버린다.
const MAX_EVENTS = 2000;

const byNewest = (a: TicEvent, b: TicEvent) =>
  new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

/**
 * 보존 상한 적용 + 퇴출 레코드의 로컬 미디어 정리.
 * 레코드만 잘라내면 documentDirectory/events/<id>/의 영상·음성 파일이
 * 참조 없는 고아로 영구 축적된다 — 퇴출과 동시에 fire-and-forget으로
 * 정리한다 (실패 무해: 다음 퇴출 주기의 대상일 뿐).
 */
const trimToLimit = (sorted: TicEvent[]): TicEvent[] => {
  if (sorted.length <= MAX_EVENTS) return sorted;
  for (const dropped of sorted.slice(MAX_EVENTS)) {
    MediaRepository.deleteEvent(dropped.id).catch(() => {});
  }
  return sorted.slice(0, MAX_EVENTS);
};

/**
 * 영속 레코드 위생 검사:
 * AsyncStorage가 과거 버전/부분 쓰기로 오염됐어도 앱이 생존해야 한다.
 * id/timestamp가 유효하지 않은 레코드는 버린다.
 */
function sanitizeStored(raw: unknown): TicEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is TicEvent => {
    if (!e || typeof e !== 'object') return false;
    if (typeof (e as TicEvent).id !== 'string' || (e as TicEvent).id.length === 0) return false;
    const t = new Date((e as TicEvent).timestamp as string).getTime();
    return Number.isFinite(t);
  });
}

/** 이벤트가 속하는 월 버킷 ("2026-07"). timestamp는 sanitize로 파싱 보장됨 */
function monthOf(e: TicEvent): string {
  return new Date(e.timestamp).toISOString().slice(0, 7);
}

/**
 * 전체 이벤트를 파트(월 × 최대 300건)로 결정론적으로 분할한다.
 * 월 내부는 오래된 것부터 순서대로 파트에 채운다 — 신규 이벤트(최신)는
 * 항상 마지막 파트에 붙으므로 앞선 파트들의 JSON이 변하지 않아
 * 변경분만 쓰는 최적화가 성립한다.
 */
function partitionEvents(events: TicEvent[], suffix: string | null = null): Map<string, TicEvent[]> {
  const byMonth = new Map<string, TicEvent[]>();
  for (const e of events) {
    const m = monthOf(e);
    const list = byMonth.get(m) || [];
    list.push(e);
    byMonth.set(m, list);
  }
  const parts = new Map<string, TicEvent[]>();
  for (const [month, list] of byMonth) {
    list.sort((a, b) => byNewest(b, a)); // 오래된 것부터
    for (let i = 0; i * PART_MAX_EVENTS < list.length; i++) {
      parts.set(
        suffix ? `${month}#${i}~${suffix}` : `${month}#${i}`,
        list.slice(i * PART_MAX_EVENTS, (i + 1) * PART_MAX_EVENTS),
      );
    }
  }
  return parts;
}

// 마지막으로 디스크에 쓴 파트별 JSON — 내용이 같은 파트는 다시 쓰지 않는다
let lastWrittenParts = new Map<string, string>();

// loadEvents 단일 비행(in-flight) 보장 — 여러 화면이 동시에 호출해도 1회만 읽는다
let loadPromise: Promise<void> | null = null;

// ── 저하(degraded) 모드 ──
// 로드가 실패한 세션에서는 메모리 상태가 디스크의 부분집합이라는 보장이 없다.
// 이때 평소처럼 저장하면 ①메타가 신규 파트만으로 재작성되어 기존 파트 전체가
// 인덱스에서 사라지고 ②같은 이름의 파트를 소수 이벤트로 덮어써 파괴한다.
// 저하 모드에서는 파트 이름에 세션 고유 접미사를 붙여 기존 파트와 절대
// 충돌하지 않게 쓰고, 메타는 디스크의 기존 목록과 합집합으로 갱신한다 —
// 다음 정상 로드에서 양쪽이 id 기준으로 병합된다.
let degradedSuffix: string | null = null;

export const useEventStore = create<EventState>((set, get) => {
  /** 성공 시 true. 마이그레이션처럼 성공 여부가 안전 조건인 호출자를 위해 반환한다. */
  const persist = async (): Promise<boolean> => {
    try {
      const parts = partitionEvents(get().events, degradedSuffix);
      const partNames = Array.from(parts.keys()).sort();

      const toWrite: [string, string][] = [];
      for (const [name, list] of parts) {
        const json = JSON.stringify(list);
        if (lastWrittenParts.get(name) !== json) {
          toWrite.push([PART_KEY_PREFIX + name, json]);
        }
      }
      const toRemove = Array.from(lastWrittenParts.keys())
        .filter(name => !parts.has(name))
        .map(name => PART_KEY_PREFIX + name);

      // 메타를 항상 함께 쓴다 (파트 목록이 곧 로드 인덱스).
      // 저하 모드에서는 읽지 못한 기존 파트를 인덱스에서 잃지 않도록 합집합.
      let indexNames = partNames;
      if (degradedSuffix) {
        const existing = await AsyncStorage.getItem(META_KEY);
        const prior: string[] = existing ? (JSON.parse(existing)?.parts ?? []) : [];
        indexNames = Array.from(new Set([...prior, ...partNames])).sort();
      }
      toWrite.push([META_KEY, JSON.stringify({ v: 2, parts: indexNames })]);
      await AsyncStorage.multiSet(toWrite);
      if (toRemove.length > 0) await AsyncStorage.multiRemove(toRemove);

      lastWrittenParts = new Map(
        Array.from(parts.entries()).map(([name, list]) => [name, JSON.stringify(list)]),
      );
      return true;
    } catch (e) {
      console.error('[EventStore] Failed to persist events:', e);
      return false;
    }
  };

  /**
   * 모든 쓰기 전에 반드시 저장소 로드를 완료시킨다.
   * 이 보장이 없으면 "앱 시작 직후 BLE 이벤트 수신 → 빈 메모리 상태로
   * 저장 → 과거 이벤트 전체가 덮어써져 소실"되는 클로버가 발생한다.
   * (루트 레이아웃의 명시 로드와 이중 안전망)
   */
  const ensureLoaded = async () => {
    if (get().hasLoaded) return;
    await get().loadEvents();
  };

  /** v2 파트 로드. 메타가 없으면 null (v1 레거시/최초 실행) */
  const loadFromParts = async (): Promise<TicEvent[] | null> => {
    const metaRaw = await AsyncStorage.getItem(META_KEY);
    if (!metaRaw) return null;
    let partNames: string[] = [];
    try {
      const meta = JSON.parse(metaRaw);
      if (Array.isArray(meta?.parts)) partNames = meta.parts.filter((p: unknown) => typeof p === 'string');
    } catch {
      return null;
    }
    const keyed = await AsyncStorage.multiGet(partNames.map(n => PART_KEY_PREFIX + n));
    const all: TicEvent[] = [];
    lastWrittenParts = new Map();
    for (const [key, value] of keyed) {
      if (!value) continue;
      try {
        const list = sanitizeStored(JSON.parse(value));
        all.push(...list);
        lastWrittenParts.set(key.slice(PART_KEY_PREFIX.length), JSON.stringify(list));
      } catch {
        // 오염된 파트는 그 파트만 버린다 — 나머지 기록은 생존
        console.warn(`[EventStore] Corrupted part dropped: ${key}`);
      }
    }
    return all;
  };

  /**
   * v1 단일 키 읽기 (마이그레이션 소스). 레거시 키는 여기서 삭제하지
   * 않는다 — v2 파트가 디스크에 안착한 뒤에만 지워야 크래시 창에서
   * 기록이 소실되지 않는다 (호출자가 persist 성공 후 삭제).
   */
  const loadLegacy = async (): Promise<{ events: TicEvent[]; migrated: boolean }> => {
    try {
      const stored = await AsyncStorage.getItem(LEGACY_KEY);
      if (!stored) return { events: [], migrated: false };
      const events = sanitizeStored(JSON.parse(stored));
      console.log(`[EventStore] Migrating ${events.length} events from legacy storage`);
      return { events, migrated: true };
    } catch (e) {
      // CursorWindow 초과 등으로 읽지 못하는 레거시 값 — 삭제하지 않고
      // 남겨둔다 (v2 키에만 쓰므로 더는 덮어쓸 위험이 없다).
      console.error('[EventStore] Legacy storage unreadable — starting fresh:', e);
      return { events: [], migrated: false };
    }
  };

  return {
    events: [],
    isLoading: true,
    hasLoaded: false,

    loadEvents: async () => {
      if (get().hasLoaded) return;
      if (!loadPromise) {
        loadPromise = (async () => {
          try {
            const fromParts = await loadFromParts();
            const legacy = fromParts === null ? await loadLegacy() : null;
            const fromDisk = fromParts ?? legacy!.events;

            // ── 병합 원칙: 메모리 우선 ──
            // 로드가 끝나기 전에 이미 도착한 이벤트(BLE 등)가 있다면 그것이
            // 최신이다. 디스크 레코드는 메모리에 없는 id만 편입한다.
            const inMemory = get().events;
            const memIds = new Set(inMemory.map(e => e.id));
            const merged = [
              ...inMemory,
              ...fromDisk
                .filter(e => !memIds.has(e.id))
                .map(e =>
                  // 재시작 전 '분석 중'에서 죽은 이벤트는 재개할 주체가
                  // 없으므로 pending으로 되돌린다 → 화면 진입 시 자동
                  // 재트리거 대상이 된다 ('분석 중' 영구 고착 방지).
                  e.analysisStatus === 'analyzing'
                    ? { ...e, analysisStatus: 'pending' as const }
                    : e,
                ),
            ].sort(byNewest);

            set({ events: trimToLimit(merged), isLoading: false, hasLoaded: true });

            // 레거시 → v2 이행: 파트 기록이 디스크에 '실제로' 안착한 뒤에만
            // 구 키를 제거한다. persist가 실패하면(저장 공간 부족/IO 오류)
            // 레거시 키가 유일본이므로 절대 지워서는 안 된다.
            if (legacy?.migrated) {
              const saved = await persist();
              if (saved) {
                await AsyncStorage.removeItem(LEGACY_KEY);
              } else {
                console.warn('[EventStore] Migration write failed — keeping legacy key');
              }
            }
          } catch (e) {
            console.error('[EventStore] Failed to load events:', e);
            // 로드 실패여도 앱은 계속 동작해야 한다 — 메모리 상태 그대로
            // 진행하되 로드는 완료로 마킹해 쓰기 경로가 영구 대기하지 않게 한다.
            // 이 세션의 쓰기는 저하 모드로 격리한다: 읽지 못한 기존 파트를
            // 덮어쓰거나 인덱스에서 누락시키지 않기 위함이다.
            degradedSuffix = `r${Date.now().toString(36)}`;
            lastWrittenParts = new Map();
            set({ isLoading: false, hasLoaded: true });
          } finally {
            loadPromise = null;
          }
        })();
      }
      await loadPromise;
    },

    addEvent: async (event) => {
      await ensureLoaded();
      const currentEvents = get().events;
      const existing = currentEvents.find(e => e.id === event.id);
      if (!existing) {
        const newEvents = trimToLimit([event, ...currentEvents].sort(byNewest));
        set({ events: newEvents });
        await persist();
        return;
      }

      // ── dedupe upsert ──
      // 같은 id의 재수신은 정상 방어 대상이지만, 파일명 복원 레코드
      // (C-to-C 임포트 선행 — detectionConfidence 없음)에 뒤늦게 BLE
      // 메타가 도착한 경우는 결손 필드만 병합한다. 무엇이든 조용히
      // 버리면 "이벤트가 앱에 안 뜬다"의 원인 규명이 불가능하므로
      // 로그를 남긴다 (펌웨어 폴백 id 재사용 감지 채널이기도 하다).
      if (
        existing.detectionConfidence === undefined &&
        event.detectionConfidence !== undefined
      ) {
        console.log(`[EventStore] Merging BLE metadata into imported record: ${event.id}`);
        await get().updateEvent(event.id, {
          detectionConfidence: event.detectionConfidence,
          intensity: event.intensity,
        });
        return;
      }
      console.warn(
        `[EventStore] Duplicate event id dropped: ${event.id} ` +
          `(existing ts=${existing.timestamp}, incoming ts=${event.timestamp})`,
      );
    },

    updateEvent: async (id, updates) => {
      await ensureLoaded();
      const newEvents = get().events.map(e => (e.id === id ? { ...e, ...updates } : e));
      set({ events: newEvents });
      await persist();
    },

    setUserFeedback: async (id, feedback) => {
      // cloudSyncedAt을 함께 무효화한다: 분석 완료 후 붙는 피드백 라벨이
      // 이미 업로드된 문서에 반영되도록, 북키핑을 지워 다음 동기화 주기에
      // 라벨 포함 재업로드되게 한다. (JSON 직렬화가 undefined 키를
      // 탈락시키므로 영속 레코드에서도 깨끗이 사라진다)
      await get().updateEvent(id, { userFeedback: feedback, cloudSyncedAt: undefined });
    },

    clearEvents: async () => {
      set({ events: [], hasLoaded: true });
      // 인덱스(메타)에 실린 파트를 기준으로 지운다 — 이 세션이 쓰지 않은
      // 파트(이전 실행분·저하 모드 잔재)까지 남김없이 회수하기 위함이다.
      const names = new Set(Array.from(lastWrittenParts.keys()));
      try {
        const metaRaw = await AsyncStorage.getItem(META_KEY);
        for (const n of (metaRaw ? JSON.parse(metaRaw)?.parts ?? [] : [])) {
          if (typeof n === 'string') names.add(n);
        }
      } catch {
        // 메타를 못 읽으면 이 세션이 쓴 파트만 회수한다
      }
      lastWrittenParts = new Map();
      await AsyncStorage.multiRemove([
        LEGACY_KEY,
        META_KEY,
        ...Array.from(names).map(n => PART_KEY_PREFIX + n),
      ]);
    },
  };
});
