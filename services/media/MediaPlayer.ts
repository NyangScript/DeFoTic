import { Platform, Linking } from 'react-native';

/**
 * 분석 전/실패 시에도 사용자가 이벤트 미디어를 직접 확인할 수 있는
 * 독립 재생 경로.
 *
 * 구조 선택의 근거 (앱 안정성 우선):
 *  - 기기 미디어는 MJPEG AVI + IMA ADPCM WAV — Android 표준 디코더
 *    (ExoPlayer/MediaCodec)가 MJPEG를 지원하지 않아 expo-video 계열
 *    인앱 재생은 코덱 차원에서 실패한다.
 *  - 따라서 파일을 FileProvider content:// URI로 승격해 "외부 플레이어"
 *    (삼성 비디오/VLC/MX 등)에 위임한다. 앱 프로세스와 완전히 분리되어
 *    어떤 코덱 문제도 앱을 죽일 수 없다.
 *  - expo-intent-launcher가 있으면 읽기 권한 플래그와 함께 정식 VIEW
 *    인텐트를 쏘고, 없으면(리빌드 전) Linking 폴백을 시도한다.
 */

// android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export interface PlayResult {
  ok: boolean;
  /** 실패 시 사용자에게 보여줄 안내 */
  error?: string;
}

export async function playMediaExternally(
  localPath: string,
  fileType: 'video' | 'audio',
): Promise<PlayResult> {
  if (Platform.OS !== 'android') {
    return { ok: false, error: '미디어 재생은 Android에서 지원됩니다.' };
  }

  // 앱 전용 저장소(file://)는 외부 앱이 읽을 수 없다 —
  // FileProvider 경유 content:// URI로 변환해 공유 가능하게 만든다.
  let contentUri: string;
  try {
    const { getContentUriAsync } = require('expo-file-system/legacy');
    contentUri = await getContentUriAsync(localPath);
  } catch (e) {
    console.warn('[MediaPlayer] content URI 변환 실패:', e);
    return { ok: false, error: '파일 경로를 변환하지 못했습니다. 파일이 삭제되었을 수 있습니다.' };
  }

  // MIME은 와일드카드로 — video/avi 같은 특정 타입은 매칭되는 플레이어가
  // 없는 기기가 있다. 와일드카드가 후보 앱 풀을 최대화한다.
  const mimeType = fileType === 'video' ? 'video/*' : 'audio/*';

  // 1순위: expo-intent-launcher (읽기 권한 부여 플래그 포함 정식 경로)
  let IntentLauncher: any = null;
  try {
    IntentLauncher = require('expo-intent-launcher');
  } catch {
    // 모듈 미설치(리빌드 전 dev client) — 폴백으로 진행
  }

  if (IntentLauncher) {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: mimeType,
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      return { ok: true };
    } catch (e: any) {
      // ActivityNotFound 등 — 재생 가능한 앱이 없는 경우
      console.warn('[MediaPlayer] VIEW intent 실패:', e);
      return {
        ok: false,
        error:
          fileType === 'video'
            ? '이 형식(MJPEG AVI)을 재생할 앱이 없습니다. VLC 또는 MX Player 설치를 권장합니다.'
            : '이 형식을 재생할 앱이 없습니다. VLC 설치를 권장합니다.',
      };
    }
  }

  // 2순위 폴백: Linking (일부 기기에서는 권한 플래그 없이도 열림)
  try {
    await Linking.openURL(contentUri);
    return { ok: true };
  } catch (e) {
    console.warn('[MediaPlayer] Linking 폴백 실패:', e);
    return {
      ok: false,
      // 사용자 문구에는 개발용 명령을 넣지 않는다 — 원인 상세는 위 console.warn으로 남긴다
      error: '이 버전에서는 외부 재생을 사용할 수 없습니다. 앱 업데이트 후 다시 시도해주세요.',
    };
  }
}
