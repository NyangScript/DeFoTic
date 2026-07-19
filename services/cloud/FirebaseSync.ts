import AsyncStorage from '@react-native-async-storage/async-storage';
import { FIREBASE_CONFIG, isFirebaseConfigured } from '../../constants/firebase-config';
import { TicEvent } from '../../types/tic-event';
import { useEventStore } from '../../stores/useEventStore';

/**
 * Firestore 동기화 서비스 — 의료진 웹뷰의 데이터 중계 계층.
 *
 * 아키텍처:
 *  - 환자 폰(RN)과 의사 PC 브라우저(Expo Web)는 다른 기기 — 로컬
 *    AsyncStorage만으로는 원격 열람이 불가능하므로 Firestore가 중계한다.
 *  - 업로드는 "이벤트 메타데이터 + LLM 분석 JSON"만 — 미디어(영상/음성)는
 *    프라이버시(초상권)·용량 문제로 제외한다.
 *  - 스키마: patients/{환자코드} 문서 + patients/{환자코드}/events/{eventId}
 *  - Firebase 미설정(constants/firebase-config.ts) 시 모든 메서드는
 *    조용히 no-op — 앱의 로컬 기능은 클라우드와 완전히 독립이다.
 *
 * NOTE: Firebase JS SDK는 순수 JS라 네이티브 리빌드가 필요 없다.
 */

const PATIENT_CODE_KEY = '@defotic_patient_code';
const CLAIM_SECRET_KEY = '@defotic_patient_claim_secret';

// 오프라인 방어: Firestore JS SDK의 setDoc은 오프라인에서
//   서버 ack까지 프라미스를 영원히 보류한다 — 타임아웃 없이 await하면
//   저장 버튼이 무기한 '저장 중'으로 고착되고 실패 알림도 뜨지 않는다.
const WRITE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} 시간 초과 — 네트워크 연결을 확인해주세요.`)),
      WRITE_TIMEOUT_MS,
    );
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

/** Firestore에 올라가는 이벤트 레코드 (로컬 전용 필드 제거형) */
export interface CloudTicEvent {
  id: string;
  timestamp: string;
  type: TicEvent['type'];
  intensity: number;
  detectionConfidence: number | null;
  aiAnalysis: NonNullable<TicEvent['aiAnalysis']> | null;
  analysisStatus: TicEvent['analysisStatus'] | null;
  userFeedback: TicEvent['userFeedback'] | null;
  hasVideo: boolean;
  hasAudio: boolean;
  syncedAt: string;
  // 의료진 대시보드가 병합 저장하는 필드 (환자 앱은 쓰지 않음)
  doctorNote?: string;
  doctorNoteAt?: string;
}

class FirebaseSyncService {
  private db: any = null;
  private initFailed = false;

  // getPatientCode 단일 비행 — 최초 실행 시 동시 호출이 서로 다른 코드를
  // 만들어 클라우드 데이터가 두 코드로 갈라지는 race 방지
  private codePromise: Promise<string> | null = null;

  // 코드 유일성 클레임은 앱 세션당 1회만 검증
  private claimVerified = false;

  // 클레임 단일 비행: registerPatientProfile(온보딩)과
  //   분석 완료 직후 upsertEvent가 ensureClaimedCode를 '동시에' 실행하면,
  //   충돌 시 각자 다른 코드를 재생성해 프로필과 이벤트가 서로 다른 코드
  //   아래로 분열될 수 있다 — 진행 중인 클레임 프라미스를 공유해 차단.
  private claimPromise: Promise<string> | null = null;

  // 코드 변경 통지: 충돌 재생성이 코드를 조용히 바꾸면
  //   이미 화면에 표시된(그리고 의사에게 알려주라고 안내한) 코드가 스테일이
  //   된다 — 구독자(홈/온보딩 카드)에게 즉시 전파해 표시·안내를 갱신한다.
  private codeListeners = new Set<(code: string) => void>();

  /** 환자 코드가 (충돌 재생성 등으로) 변경될 때 알림을 받는다. 반환값 = 해제 함수 */
  public onPatientCodeChanged(listener: (code: string) => void): () => void {
    this.codeListeners.add(listener);
    return () => this.codeListeners.delete(listener);
  }

  private emitCodeChanged(code: string) {
    this.codeListeners.forEach(l => {
      try { l(code); } catch (e) { console.warn('[Firebase] code listener error:', e); }
    });
  }

  /** Firestore 인스턴스 lazy 초기화 — 미설정이면 null */
  private getDb(): any {
    if (!isFirebaseConfigured() || this.initFailed) return null;
    if (this.db) return this.db;
    try {
      const { initializeApp, getApps } = require('firebase/app');
      const { initializeFirestore, getFirestore } = require('firebase/firestore');
      const app = getApps().length > 0 ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
      try {
        // RN 전송계층 보강: RN(Android)에서 Firestore의 기본
        //   WebChannel 스트리밍이 막히는 환경(일부 통신사/프록시)이 알려져
        //   있다 — 이 경우 모든 쓰기가 15s 타임아웃으로 조용히 실패해
        //   의사 웹이 영구 빈 화면이 된다. 자동 감지 long-polling은 정상
        //   환경에서는 스트리밍을 유지하고 문제 환경에서만 폴백한다.
        //   (웹 브라우저에서도 무해 — 자동 감지가 no-op에 수렴)
        this.db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
      } catch {
        // 이미 다른 경로로 초기화된 경우(HMR 등) 기존 인스턴스 재사용
        this.db = getFirestore(app);
      }
      return this.db;
    } catch (e) {
      console.warn('[Firebase] init failed — cloud sync disabled:', e);
      this.initFailed = true;
      return null;
    }
  }

  public isEnabled(): boolean {
    return isFirebaseConfigured() && !this.initFailed;
  }

  /**
   * 이 환자(폰)의 공유 코드. 최초 접근 시 6자리 코드를 생성해 영속화 —
   * 의사는 이 코드로 대시보드에서 데이터를 열람한다.
   */
  public getPatientCode(): Promise<string> {
    if (!this.codePromise) {
      this.codePromise = (async () => {
        let code = await AsyncStorage.getItem(PATIENT_CODE_KEY);
        if (!code) {
          code = String(Math.floor(100000 + Math.random() * 900000));
          await AsyncStorage.setItem(PATIENT_CODE_KEY, code);
        }
        return code;
      })();
      // 실패 시 다음 호출이 재시도할 수 있게 리셋
      this.codePromise.catch(() => { this.codePromise = null; });
    }
    return this.codePromise;
  }

  /**
   * 환자 코드 유일성 클레임:
   * 6자리 랜덤 코드는 전역 유일성이 보장되지 않는다 — 다른 환자와
   * 충돌하면 서로 다른 환자의 의료 데이터가 같은 문서 트리에 병합된다.
   * 최초 업로드 전에 patients/{code} 문서의 claimSecret을 검사해:
   *  - 문서 없음 → 내 secret으로 클레임
   *  - 내 secret과 일치 → 통과 (내 코드)
   *  - 불일치(타 환자 선점) → 새 코드 재생성 후 재시도 (최대 5회)
   * 완전한 보장은 향후 Firebase Auth 결합에서 — 이것은 그 전까지의
   * 충돌 확률을 사실상 0으로 만드는 클레임 계층이다.
   */
  private async ensureClaimedCode(db: any): Promise<string> {
    if (this.claimVerified) return this.getPatientCode();

    // 단일 비행: 진행 중인 클레임이 있으면 그 결과를 공유한다 (동시 재생성 분열 차단)
    if (!this.claimPromise) {
      this.claimPromise = this.doClaim(db);
      this.claimPromise.catch(() => { this.claimPromise = null; });
    }
    return this.claimPromise;
  }

  private async doClaim(db: any): Promise<string> {
    let code = await this.getPatientCode();

    const { doc, getDoc, setDoc } = require('firebase/firestore');

    let secret = await AsyncStorage.getItem(CLAIM_SECRET_KEY);
    if (!secret) {
      secret = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await AsyncStorage.setItem(CLAIM_SECRET_KEY, secret);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = doc(db, 'patients', code);
      const snap: any = await withTimeout(getDoc(ref), '환자 코드 확인');
      const existing = snap.exists() ? snap.data() : null;

      if (!existing || !existing.claimSecret || existing.claimSecret === secret) {
        await withTimeout(
          setDoc(ref, { claimSecret: secret, claimedAt: new Date().toISOString() }, { merge: true }),
          '환자 코드 등록',
        );
        this.claimVerified = true;
        return code;
      }

      // 충돌 — 새 코드로 재시도 + 구독 화면(홈/온보딩 카드)에 즉시 전파.
      // 전파 없이는 사용자가 이미 표시된 구 코드를 의사에게 알려주게 되어
      // 타 환자(선점자)의 데이터가 열람되는 교차 노출 경로가 된다.
      console.warn(`[Firebase] Patient code collision on ${code} — regenerating`);
      code = String(Math.floor(100000 + Math.random() * 900000));
      await AsyncStorage.setItem(PATIENT_CODE_KEY, code);
      this.codePromise = Promise.resolve(code);
      this.emitCodeChanged(code);
    }
    throw new Error('환자 코드 등록에 실패했습니다 (충돌 반복).');
  }

  /**
   * 온보딩 완료 시 환자 프로필(이름)을 patients/{code} 문서에 등록한다.
   * 이때 ensureClaimedCode가 함께 돌아 코드의 전역 유일성(중복 없는 6자리
   * 자동 할당)이 "첫 업로드 시점"이 아니라 "온보딩 시점"에 확정된다.
   * 오프라인이면 throw — 호출자(login)는 실패를 무해하게 삼키고,
   * 다음 이벤트 업로드 때 ensureClaimedCode가 재시도한다.
   */
  public async registerPatientProfile(name: string): Promise<void> {
    const db = this.getDb();
    if (!db) return;   // 미설정 — 조용히 스킵 (로컬 온보딩은 그대로 진행)

    const { doc, setDoc } = require('firebase/firestore');
    const code = await this.ensureClaimedCode(db);
    await withTimeout(
      setDoc(
        doc(db, 'patients', code),
        { patientName: name, registeredAt: new Date().toISOString() },
        { merge: true },
      ),
      '환자 프로필 등록',
    );
  }

  /**
   * 의료진 대시보드용 환자 프로필 1회 조회 (이름/등록일/최종 동기화).
   * 실패/미설정 시 null — 화면은 코드만으로 폴백 표시한다.
   */
  public async getPatientProfile(
    patientCode: string,
  ): Promise<{ patientName?: string; registeredAt?: string; lastSyncedAt?: string } | null> {
    const db = this.getDb();
    if (!db) return null;
    try {
      const { doc, getDoc } = require('firebase/firestore');
      const snap: any = await withTimeout(getDoc(doc(db, 'patients', patientCode)), '환자 정보 조회');
      return snap.exists() ? snap.data() : null;
    } catch (e) {
      console.warn('[Firebase] patient profile fetch failed:', e);
      return null;
    }
  }

  /** 이벤트 메타+분석 결과를 Firestore에 upsert (미디어 제외) */
  public async upsertEvent(event: TicEvent): Promise<void> {
    const db = this.getDb();
    if (!db) return;   // 미설정 — 조용히 스킵

    const { doc, setDoc } = require('firebase/firestore');
    const code = await this.ensureClaimedCode(db);

    const record: CloudTicEvent = {
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      intensity: event.intensity,
      detectionConfidence: event.detectionConfidence ?? null,
      aiAnalysis: event.aiAnalysis ?? null,
      analysisStatus: event.analysisStatus ?? null,
      userFeedback: event.userFeedback ?? null,
      hasVideo: !!event.videoPath,
      hasAudio: !!event.audioPath,
      syncedAt: new Date().toISOString(),
    };

    await withTimeout(
      setDoc(doc(db, 'patients', code, 'events', event.id), record, { merge: true }),
      '이벤트 업로드',
    );
    await withTimeout(
      setDoc(doc(db, 'patients', code), { lastSyncedAt: record.syncedAt }, { merge: true }),
      '환자 문서 갱신',
    );

    // 업로드 성공 북키핑 — 재동기화(syncPendingUploads) 판별 기준
    await useEventStore.getState().updateEvent(event.id, {
      cloudSyncedAt: record.syncedAt,
    });
  }

  /**
   * 업로드되지 못한 분석 완료 이벤트 일괄 재동기화.
   * (오프라인에서 분석이 완료된 이벤트는 완료 시점의 upsert가 실패하므로,
   *  네트워크 복구 후 이 경로가 없으면 의사 대시보드에 영구 누락된다 —
   *  분석 화면 focus마다 fire-and-forget으로 호출된다)
   */
  public async syncPendingUploads(): Promise<number> {
    if (!this.getDb()) return 0;

    await useEventStore.getState().loadEvents();
    const pending = useEventStore.getState().events.filter(
      e => e.analysisStatus === 'completed' && !e.cloudSyncedAt,
    );

    let count = 0;
    for (const e of pending) {
      try {
        await this.upsertEvent(e);
        count++;
      } catch (err) {
        console.warn(`[Firebase] pending upload failed for ${e.id}:`, err);
        break;   // 네트워크 문제면 나머지도 실패 — 다음 기회에 재시도
      }
    }
    if (count > 0) console.log(`[Firebase] Synced ${count} pending events to cloud`);
    return count;
  }

  /**
   * 의료진 소견(CBIT 치료 계획)을 이벤트 문서에 병합 저장.
   * 의료진 대시보드(웹)에서 호출 — 환자 앱은 이 필드를 쓰지 않는다.
   */
  public async saveDoctorNote(
    patientCode: string,
    eventId: string,
    note: string,
  ): Promise<void> {
    const db = this.getDb();
    if (!db) {
      throw new Error('Firebase가 설정되지 않아 소견을 저장할 수 없습니다.');
    }
    const { doc, setDoc } = require('firebase/firestore');
    await withTimeout(
      setDoc(
        doc(db, 'patients', patientCode, 'events', eventId),
        { doctorNote: note, doctorNoteAt: new Date().toISOString() },
        { merge: true },
      ),
      '소견 저장',
    );
  }

  /**
   * 의료진 대시보드용 실시간 구독. 반환값은 구독 해제 함수.
   * Firebase 미설정 시 즉시 onError를 호출하고 no-op 해제 함수를 반환한다.
   */
  public subscribePatientEvents(
    patientCode: string,
    onEvents: (events: CloudTicEvent[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    const db = this.getDb();
    if (!db) {
      onError?.(
        'Firebase가 설정되지 않았습니다. constants/firebase-config.ts를 채우면 원격 열람이 활성화됩니다.',
      );
      return () => {};
    }

    try {
      const { collection, onSnapshot, query, orderBy } = require('firebase/firestore');
      const q = query(
        collection(db, 'patients', patientCode, 'events'),
        orderBy('timestamp', 'desc'),
      );
      return onSnapshot(
        q,
        (snap: any) => {
          const events: CloudTicEvent[] = [];
          snap.forEach((d: any) => events.push(d.data() as CloudTicEvent));
          onEvents(events);
        },
        (err: any) => {
          console.warn('[Firebase] subscription error:', err);
          onError?.('데이터 구독 중 오류가 발생했습니다. 네트워크와 보안 규칙을 확인해주세요.');
        },
      );
    } catch (e) {
      console.warn('[Firebase] subscribe failed:', e);
      onError?.('Firestore 구독을 시작하지 못했습니다.');
      return () => {};
    }
  }
}

export const firebaseSync = new FirebaseSyncService();
