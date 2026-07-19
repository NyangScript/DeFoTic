// ============================
// usb_msc.h — USB Mass Storage (동시 접근 구조)
// ============================
// C-to-C 연결 시 SD 카드를 USB 드라이브로 노출한다.
// 스마트폰이 파일 탐색기/앱에서 DEFOTIC/evt_* 이벤트 폴더에 직접 접근 가능.
// 호스트가 드라이브를 마운트한 동안에도 펌웨어 녹화·이벤트 저장은
// 계속된다 — USB는 관측자일 뿐 녹화를 멈추지 않는다.
// 상세 원칙·트레이드오프는 usb_msc.cpp 상단 참조.
//
// ─── 빌드 프로파일 (Tools > USB CDC On Boot) ───
//
// ① 배포/실사용 빌드: USB CDC On Boot = "Disabled"  (폰 연결용)
//    → 순수 MSC 단독 장치로 열거된다. Android는 CDC가 섞인
//      복합(Composite) 장치의 저장소를 마운트하지 않으므로,
//      폰에서 USB 드라이브로 인식되려면 반드시 이 프로파일이어야 한다.
//    → 시리얼 모니터는 사용 불가 (로그는 UART0 핀으로만 출력됨).
//
// ② 개발/디버깅 빌드: USB CDC On Boot = "Enabled"
//    → 시리얼 모니터 정상 동작. PC에서는 COM포트+드라이브가 함께 뜨지만
//      폰에서는 드라이브가 표시되지 않는다 (복합 장치 제한).
//
// 공통: Tools > USB Mode = "USB-OTG (TinyUSB)" 필수.
#ifndef USB_MSC_H
#define USB_MSC_H

#include <stdint.h>

// SD 초기화(initSD) 이후에 호출할 것
void initUsbMsc();

// 주기 판정 훅 — eventTask 루프와 loop()(태스크 기동 전 구간)에서 호출.
// SUSPEND 유예(10s) 만료를 실분리로 판정해 세션(관측 상태)을 종료한다.
// eventTask는 세션 종료 에지에서 1회 재마운트로 FAT 뷰를 갱신한다.
void usbMscTick();

// USB 호스트(스마트폰/PC)가 연결되어 MSC 세션이 활성인 동안 true.
// 순수 관측값 — 녹화는 이 값과 무관하게 계속된다. 용도는 앱
// 텔레메트리(usbState)와 세션 종료 에지의 재마운트 트리거뿐이다.
extern volatile bool mscActive;

// 호스트 세션이 종료됐음을 1회 알린다(읽으면 해제). eventTask가 이 신호로
// FAT 뷰 재판독(sdRemountFresh)을 수행한다 — mscActive를 주기 샘플링하는
// 방식과 달리, 두 관측 사이에 시작·종료된 짧은 세션도 놓치지 않는다.
bool usbMscConsumeSessionEnd();

// 진단 계측 — 현재(또는 직전) 호스트 세션이 실제로 읽고/쓴 섹터 수.
// BLE 텔레메트리로 노출되어 시리얼 없이 실패 계층을 판별한다:
//   mscActive=false 고정 → 열거 실패 / active인데 rd=0 → SCSI 실패 /
//   rd>0인데 폰에 드라이브 없음 → vold 정책 거부
extern volatile uint32_t mscReadSectors;
extern volatile uint32_t mscWriteSectors;

// SD의 FAT 볼륨 시리얼 "XXXX-XXXX" (빈 문자열 = 판독 실패).
// Android SAF의 외장 볼륨 ID와 동일 — 앱이 폴더 선택창을 DeFoTic
// 드라이브에서 바로 열도록 BLE 텔레메트리로 전달한다.
extern char sdVolumeUuid[12];

// TinyUSB 장치가 호스트에 의해 구성(SET_CONFIGURATION)됐고 버스가 활성
// (미절전)인지 — 세션(mscActive)과 별개의 원시 관측값. diag "usbHost"용.
bool usbMscHostMounted();

#endif
