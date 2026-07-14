// ============================
// usb_msc.h — USB Mass Storage
// ============================
// C-to-C 연결 시 SD 카드를 USB 드라이브로 노출한다.
// 스마트폰이 파일 탐색기/앱에서 DEFOTIC/evt_* 이벤트 폴더에 직접 접근 가능.
//
// ─── 빌드 프로파일 (Tools > USB CDC On Boot) ───
//
// ① 배포/실사용 빌드: USB CDC On Boot = "Disabled"  ★폰 연결용
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

// SD 초기화(initSD) 이후에 호출할 것
void initUsbMsc();

// USB 호스트(스마트폰/PC)가 연결되어 MSC 세션이 활성인 동안 true.
// 이 동안 녹화 태스크는 SD 접근을 중단해 파일시스템 충돌을 방지한다.
extern volatile bool mscActive;

#endif
