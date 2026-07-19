import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 환자 온보딩 프로필 영속 스토어.
 *
 * 역할: "이 폰에서 최초 온보딩(BLE 페어링 → 환자 정보 등록)이 완료됐는가"의
 * 단일 기준. 인트로(app/index.tsx)가 이 값을 읽어, 완료된 사용자는
 * 페어링/등록 화면을 건너뛰고 바로 메인 탭으로 진입한다 (자동 로그인).
 *
 * 환자 식별 코드는 여기 저장하지 않는다 — 코드의 단일 소유자는
 * FirebaseSync.getPatientCode()(@defotic_patient_code)이며, 이 스토어는
 * 이름/완료 시각만 관리해 코드 이원화를 원천 차단한다.
 */

const PROFILE_KEY = '@defotic_profile';

export interface PatientProfile {
  name: string;
  onboardedAt: string; // ISO 8601
}

// 세션 캐시 — 인트로 게이트가 3초 타이머 안에 동기적으로 판정할 수 있게
// 마운트 즉시 로드를 시작하고 결과를 붙잡아 둔다.
let cached: PatientProfile | null | undefined; // undefined = 미로드

function sanitize(raw: unknown): PatientProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as PatientProfile;
  if (typeof p.name !== 'string' || p.name.trim().length === 0) return null;
  if (typeof p.onboardedAt !== 'string') return null;
  return { name: p.name, onboardedAt: p.onboardedAt };
}

export const profileStore = {
  /** 저장된 프로필. 없으면 null — 온보딩 미완료. */
  async get(): Promise<PatientProfile | null> {
    if (cached !== undefined) return cached;
    try {
      const raw = await AsyncStorage.getItem(PROFILE_KEY);
      cached = raw ? sanitize(JSON.parse(raw)) : null;
    } catch (e) {
      console.warn('[Profile] load failed:', e);
      cached = null;
    }
    return cached;
  },

  /** 온보딩 완료 시 저장 — 이후 앱 실행은 메인 탭으로 직행한다. */
  async save(name: string): Promise<PatientProfile> {
    const profile: PatientProfile = {
      name: name.trim(),
      onboardedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    cached = profile;
    return profile;
  },

  /** 온보딩 상태 초기화 (기기 재설정/테스트용) */
  async clear(): Promise<void> {
    await AsyncStorage.removeItem(PROFILE_KEY);
    cached = null;
  },
};
