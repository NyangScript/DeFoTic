/**
 * Firebase 프로젝트 설정 — 여기만 채우면 의료진 웹뷰 동기화가 켜집니다.
 *
 * 발급 방법:
 *  1. https://console.firebase.google.com 에서 프로젝트 생성
 *  2. 프로젝트 설정 > 일반 > 내 앱 > "웹 앱 추가" → 아래 값 복사
 *  3. Firestore Database 생성 (프로덕션 모드 권장, 리전 asia-northeast3)
 *  4. (권장) Firestore 보안 규칙은 DeFoTic_Development_Guide.md 참조
 *
 * 값이 비어 있는 동안 앱은 클라우드 동기화를 조용히 건너뛰며(로컬 전용),
 * 의료진 대시보드는 같은 기기 내 로컬 데이터 폴백으로 동작합니다.
 * .env를 쓰려면 EXPO_PUBLIC_FIREBASE_* 환경변수가 아래 값보다 우선합니다.
 */
export const FIREBASE_CONFIG = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyBR8igbPmPTrEsb7XTvnkytnpvUfJG0lc0',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'defotic-a9c07.firebaseapp.com',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ?? 'defotic-a9c07',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? 'defotic-a9c07.firebasestorage.app',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '257739295387',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? '1:257739295387:web:2fffe63373a2d70828143e',
};

/** 필수 키가 채워졌는지 — 미설정이면 모든 클라우드 경로가 no-op */
export function isFirebaseConfigured(): boolean {
  return FIREBASE_CONFIG.apiKey.trim().length > 0 && FIREBASE_CONFIG.projectId.trim().length > 0;
}
