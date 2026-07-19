import { Alert, Platform } from 'react-native';

/**
 * 플랫폼 공용 알림 헬퍼.
 *
 * react-native-web의 Alert.alert는 no-op이라 웹(의료진 대시보드)에서
 * 저장 성공/실패 안내가 조용히 사라진다 — 웹에서는 window.alert로,
 * 네이티브에서는 기존 Alert.alert로 동일한 문구를 전달한다.
 */
export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
