import { AppState, AppStateStatus } from 'react-native';
import { useDeviceStore } from '../../stores/useDeviceStore';
import { mediaSyncManager } from './MediaSyncManager';

/**
 * C-to-C 자동 동기화 컨트롤러 (앱 루트 수준).
 *
 * 확정 사용자 시나리오는 "기기를 하루 종일 착용 → 귀가 후 케이블 연결 →
 * 전체 백로그 자동 가져오기"다. 동기화 트리거를 특정 화면(분석 탭)에만
 * 두면 두 가지 구멍이 생긴다:
 *  ① 탭이 lazy 마운트라 분석 탭을 열지 않은 세션에서는 케이블을 꽂아도
 *     아무 일도 일어나지 않는다.
 *  ② 회당 임포트 상한(MAX_EVENTS_PER_SYNC) 초과분이 이월된 채, 다음
 *     화면 진입까지 방치된다 — 대량 백로그는 수동 반복이 필요했다.
 *
 * 이 컨트롤러는 루트 레이아웃에서 시작되어 화면과 무관하게 동작한다:
 *  - usbState 'ready' 전이 감지 → silent 동기화 시작
 *    ('ready'는 USB 열거 시점에 오므로 Android 볼륨 마운트(fsck, 수 초~
 *     수십 초)보다 먼저 도착한다 — deviceUnavailable 동안 백오프 재시도)
 *  - 이월분(deferredEvents)이 남아 있으면 배치를 연쇄 실행해 완주한다
 *  - 세션이 유지되는 동안 저빈도(60s) 재스캔 — v5 동시 접근 구조에서는
 *    케이블이 꽂힌 중에도 새 틱이 SD에 적재되기 때문
 *
 * 화면 쪽 silent 스캔(분석 탭 focus)과 동시에 돌아도 안전하다 —
 * MediaSyncManager의 진행 중 래치가 중복 실행을 skipped로 직렬화한다.
 *
 * 주의: 배치 사이의 대기는 JS 타이머라 앱이 백그라운드로 내려가면 멈춘다.
 * 진행 중이던 네이티브 파일 복사는 끝나지만 다음 배치는 시작되지 않으므로,
 * 포그라운드 복귀 시점에 남은 백로그를 이어받도록 재시동한다.
 */
class AutoSyncControllerService {
  private unsubscribe: (() => void) | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private draining = false;
  // 마지막 드레인이 백로그를 남긴 채 끝났는지 — 포그라운드 복귀·화면 진입
  // 시 재시동 여부의 판단 근거.
  private backlogPending = false;

  // 안전 상한: 한 드레인 세션에서 실행할 최대 배치 수.
  // 25건/배치 × 40 = 이벤트 1,000건 — 보존 상한(2,000건)의 절반으로,
  // 병리적 무한 루프(임포트가 계속 실패하며 이월만 반복)의 백스톱이다.
  private static readonly MAX_ROUNDS = 40;
  private static readonly MOUNT_RETRY_MAX = 10;
  private static readonly MOUNT_RETRY_DELAY_MS = 4000;
  private static readonly BATCH_DELAY_MS = 2000;
  private static readonly SESSION_RESCAN_MS = 60000;

  /** 루트 레이아웃 mount 시 1회 호출 */
  start() {
    if (this.unsubscribe) return;
    let prevUsb = useDeviceStore.getState().usbState;
    this.unsubscribe = useDeviceStore.subscribe(state => {
      const now = state.usbState;
      if (now === 'ready' && prevUsb !== 'ready') this.requestDrain();
      prevUsb = now;
    });
    // 백그라운드에서 멈춘 드레인을 포그라운드 복귀 시 이어받는다
    this.appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active' && this.backlogPending) this.requestDrain();
    });

    // 이미 세션 중인 상태로 앱이 시작된 경우
    if (prevUsb === 'ready') this.requestDrain();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
  }

  /**
   * 드레인 루프 기동 (이미 도는 중이면 no-op).
   * 화면 경로(분석 탭)의 스캔 결과에 이월분이 있을 때도 호출된다 —
   * BLE 미연결(usbState 텔레메트리 부재) 상태의 백로그도 완주시키기 위함.
   */
  requestDrain() {
    if (this.draining) return;
    this.draining = true;
    this.backlogPending = false;
    this.drainLoop()
      .catch(e => console.warn('[AutoSync] drain loop error:', e))
      .finally(() => {
        this.draining = false;
      });
  }

  private async drainLoop() {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const usbReady = () => useDeviceStore.getState().usbState === 'ready';

    let mountRetries = 0;
    let skipRetries = 0;

    for (let round = 0; round < AutoSyncControllerService.MAX_ROUNDS; round++) {
      const result = await mediaSyncManager.autoSyncFromDevice({ interactive: false });

      // SAF 권한 미부여 — 권한 요청창은 화면(분석 탭)만 띄울 수 있다
      if (result.needsSetup || result.canceled) return;

      // 다른 동기화 비행(화면 스캔·수동 가져오기)이 진행 중 — 잠시 양보 후
      // 재확인한다. 사용자가 선택창을 오래 열어두는 등 양보가 길어지면
      // 루프를 놓아주되, 백로그가 남아 있음을 기록해 다음 기회(포그라운드
      // 복귀·화면 진입)에 이어받게 한다.
      if (result.skipped) {
        if (++skipRetries > 15) {
          this.backlogPending = true;
          return;
        }
        round--;
        await sleep(AutoSyncControllerService.MOUNT_RETRY_DELAY_MS);
        continue;
      }
      skipRetries = 0;

      // 폴더 접근 실패 — 세션 중이면 마운트 대기(백오프), 아니면 종료
      if (result.deviceUnavailable) {
        if (!usbReady() || ++mountRetries >= AutoSyncControllerService.MOUNT_RETRY_MAX) return;
        await sleep(AutoSyncControllerService.MOUNT_RETRY_DELAY_MS);
        continue;
      }
      mountRetries = 0;

      // 이월분 잔존 → 연쇄 배치. 단 이번 라운드에 진전이 없었다면
      // (복사 실패 반복 등) 짧은 간격의 헛돌기를 피해 저빈도로 후퇴한다.
      if (result.deferredEvents > 0) {
        const progressed = result.importedFiles > 0;
        if (!progressed && !usbReady()) {
          this.backlogPending = true;
          return;
        }
        await sleep(
          progressed
            ? AutoSyncControllerService.BATCH_DELAY_MS
            : AutoSyncControllerService.SESSION_RESCAN_MS,
        );
        continue;
      }

      // 백로그 완주 — 세션이 유지되는 동안만 저빈도 재스캔으로 대기
      if (!usbReady()) return;
      await sleep(AutoSyncControllerService.SESSION_RESCAN_MS);
      if (!usbReady()) return;
      round--; // 유휴 재스캔은 배치 상한에 계상하지 않는다
    }
    // 배치 상한 소진 — 남은 백로그는 다음 기회에 이어받는다
    this.backlogPending = true;
  }
}

export const autoSyncController = new AutoSyncControllerService();
