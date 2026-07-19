import { Redirect } from 'expo-router';

/**
 * 웹 전용 진입점 (Expo Router 플랫폼 확장자 라우트).
 *
 * DeFoTic의 웹 빌드는 "주치의가 브라우저로 접속하는 의료진 인터페이스"
 * 전용이다 — 환자용 온보딩(인트로 → BLE 페어링 → 탭)은 모바일에서만
 * 의미가 있고, 틱 환자가 자기 기록을 웹에서 재차 의식하게 만들 이유도
 * 없다. 웹 진입 즉시 의료진 랜딩(/doctor, 환자 코드 입력)으로 보낸다.
 *
 * 라우팅 규칙(Expo Router): 같은 경로에 비플랫폼 베이스 파일(index.tsx)이
 * 존재해야 플랫폼 확장자가 유효하다 — 모바일은 index.tsx(인트로),
 * 웹은 이 파일이 선택된다. 빌드 타임 분기라 웹 번들에 환자용 인트로/
 * 애니메이션 코드가 실리지 않는다.
 */
export default function WebEntry() {
  return <Redirect href="/doctor" />;
}
