// =====================================================
// usb_msc.cpp — SD 카드 USB Mass Storage 노출
// =====================================================
// ESP32-S3의 네이티브 USB-OTG(TinyUSB)로 SD 카드를 섹터 단위
// USB 드라이브로 서비스한다. 스마트폰(C-to-C)이 호스트가 되면
// SD가 외장 저장소로 마운트되어 앱이 DEFOTIC/evt_* 미디어를
// 자동으로 가져갈 수 있다.
//
// ★ 핵심 설계: 폰 대상 빌드는 "순수 MSC 단독 장치"여야 한다.
//   PC(Windows)는 CDC+MSC 복합 장치의 인터페이스를 각각 인식하지만
//   (→ COM포트 + 드라이브 동시 표시), Android는 CDC가 포함된 복합
//   장치를 시리얼 계열로 취급해 저장소를 마운트하지 않는다.
//   따라서 이 모듈은 CDC를 일절 등록하지 않으며, 시리얼 디버깅이
//   필요한 개발 빌드는 CDC On Boot=Enabled로 전환해 사용한다.
//   (프로파일 설명은 usb_msc.h 상단 참조)
//
// 동시 접근 방지: USB 호스트 연결(STARTED) 동안 mscActive=true로
// 만들어 녹화/저장 태스크가 SD 접근을 멈추게 한다. (task.cpp 참조)
// =====================================================

#include "config.h"
#include "usb_msc.h"

// ── 빌드 설정 검증: 잘못된 Tools 설정은 컴파일 단계에서 알린다 ──
#if ARDUINO_USB_MODE
#error "DeFoTic: Tools > USB Mode를 'USB-OTG (TinyUSB)'로 변경한 뒤 다시 컴파일하세요. (현재: Hardware CDC and JTAG)"
#endif

#if ARDUINO_USB_CDC_ON_BOOT
#warning "DeFoTic [개발 빌드]: 시리얼 모니터 사용 가능. 단, 복합 장치 제한으로 '폰'에서는 USB 드라이브가 표시되지 않습니다. 실사용 테스트 전 USB CDC On Boot를 'Disabled'로 바꿔 재업로드하세요."
#endif

#include "USB.h"
#include "USBMSC.h"

static USBMSC msc;
volatile bool mscActive = false;

// ── 섹터 단위 read/write 콜백 ──
static int32_t onMscWrite(uint32_t lba, uint32_t offset, uint8_t *buffer, uint32_t bufsize) {
    const uint32_t secSize = SD.sectorSize();
    if (secSize == 0) return -1;
    for (uint32_t i = 0; i < bufsize / secSize; i++) {
        if (!SD.writeRAW(buffer + i * secSize, lba + i)) {
            return -1;
        }
    }
    return (int32_t)bufsize;
}

static int32_t onMscRead(uint32_t lba, uint32_t offset, void *buffer, uint32_t bufsize) {
    const uint32_t secSize = SD.sectorSize();
    if (secSize == 0) return -1;
    for (uint32_t i = 0; i < bufsize / secSize; i++) {
        if (!SD.readRAW((uint8_t *)buffer + i * secSize, lba + i)) {
            return -1;
        }
    }
    return (int32_t)bufsize;
}

static bool onMscStartStop(uint8_t power_condition, bool start, bool load_eject) {
    // 호스트가 미디어를 eject하면 세션 종료로 간주
    if (load_eject && !start) {
        mscActive = false;
    }
    return true;
}

// ── USB 이벤트: 호스트 연결/해제 감지 ──
// 단순 전원(VBUS) 감지가 아니라 호스트가 실제로 장치를
// 인식(enumeration)한 시점을 잡는다.
static void usbEventCallback(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    if (event_base != ARDUINO_USB_EVENTS) return;

    switch (event_id) {
        case ARDUINO_USB_STARTED_EVENT:
        case ARDUINO_USB_RESUME_EVENT:
            mscActive = true;
            Serial.println("[USB] Host connected — MSC active, recording paused");
            break;
        case ARDUINO_USB_STOPPED_EVENT:
        case ARDUINO_USB_SUSPEND_EVENT:
            mscActive = false;
            Serial.println("[USB] Host disconnected — recording resumed");
            break;
        default:
            break;
    }
}

void initUsbMsc() {
    if (SD.cardSize() == 0) {
        Serial.println("[USB] SD not ready — MSC disabled");
        return;
    }

    // ★ 순서 중요: 인터페이스 등록(msc.begin)을 마친 뒤 USB.begin()을
    //   호출해야 TinyUSB 디스크립터에 포함되어 호스트에 열거된다.
    msc.vendorID("DeFoTic");
    msc.productID("TicRecorder");
    msc.productRevision("1.0");
    msc.onRead(onMscRead);
    msc.onWrite(onMscWrite);
    msc.onStartStop(onMscStartStop);
    msc.mediaPresent(true);

    bool mscOk = msc.begin(SD.numSectors(), SD.sectorSize());

    USB.onEvent(usbEventCallback);
    USB.begin();

    Serial.printf("[USB] MSC %s (sectors=%u, sectorSize=%u)\n",
                  mscOk ? "ready — SD exposed as USB drive" : "REGISTER FAILED",
                  (unsigned)SD.numSectors(), (unsigned)SD.sectorSize());
}
