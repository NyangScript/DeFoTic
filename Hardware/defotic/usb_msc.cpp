// =====================================================
// usb_msc.cpp — SD 카드 USB Mass Storage 노출
// =====================================================
// ESP32-S3의 네이티브 USB-OTG(TinyUSB)로 SD 카드를 섹터 단위
// USB 드라이브로 서비스한다. 스마트폰(C-to-C)이 호스트가 되면
// SD가 외장 저장소로 마운트되어 앱이 DEFOTIC/evt_* 미디어를
// 자동으로 가져갈 수 있다.
//
// 설계 원칙 — "동시 접근 허용, USB는 관측자"
//
// [원칙 1] 미디어는 항상 존재한다 (mediaPresent 토글 금지)
//   Android vold는 디스크 등록 시점에 1회만 평가하고 미디어 없는 LUN을
//   재폴링하지 않는다 → 미디어 부재/플래핑은 '충전만' 표시·폰 커널
//   wedge를 만든다. 미디어는 상시 존재, 데이터는 상시 서비스.
//
// [원칙 2] 녹화는 USB 때문에 멈추지 않는다
//   호스트 세션 중 녹화를 정지해 FAT 단일 쓰기자를 보장하는 대안은
//   "꽂혀 있는 동안 감지 미디어가 저장되지 않는" 부작용으로 실사용
//   가치를 해친다. 호스트가 드라이브를 마운트한 동안에도 펌웨어는 계속
//   세그먼트/이벤트를 기록한다. 호스트 캐시와 펌웨어 기록의 불일치로
//   인한 경고(드라이브 오류 검사 등)는 수용된 트레이드오프다.
//   내부에 유지하는 최소 안전장치 2개(둘 다 사용자에게 비가시적):
//   ① 호스트 raw 섹터 I/O와 펌웨어 FS 쓰기의 sdMutex 직렬화 — 같은 SPI
//      버스에 두 컨텍스트가 동시에 명령을 내리는 전기적 충돌 방지.
//   ② 세션 종료(실분리) 시 1회 재마운트(sdRemountFresh) — 호스트가
//      마운트 중 남긴 쓰기(fsck/dirty bit/LOST.DIR)를 재판독해 펌웨어의
//      FAT 캐시를 갱신한다. (녹화 공백은 1~2초뿐이다.)
//
// [원칙 3] SUSPEND는 세션 종료가 아니다 (Grace 타이머)
//   배터리 구동 특성상 케이블 분리도, 호스트 절전도 SUSPEND로 온다.
//   10초 유예 후에만 분리로 판정한다. 세션(mscActive)은 녹화를
//   막지 않는 순수 '관측값'이며, 용도는 ①앱 텔레메트리(usbState —
//   동기화 카드/자동 동기화 트리거) ②세션 종료 에지에서의 재마운트
//   (원칙 2-②) 뿐이다.
//
// 폰 대상 빌드는 "순수 MSC 단독 장치"여야 한다 (CDC 금지):
//   Android는 CDC가 포함된 복합 장치를 시리얼 계열로 취급해 저장소를
//   마운트하지 않는다. 시리얼 디버깅은 CDC On Boot=Enabled 개발 빌드로.
//   (프로파일 설명은 usb_msc.h 상단 참조)
//
// 대비책: 동시 접근에서 FAT 손상이 재발할 경우, 호스트 세션 중 녹화를
// 정지해 FAT 단일 쓰기자를 보장하는 소유권 게이팅 설계로 복귀할 수 있다
// (상세는 DeFoTic_Development_Guide.md 참조).
// =====================================================

#include "config.h"
#include "usb_msc.h"

// tud_mounted()/tud_suspended() — TinyUSB 장치 상태 조회. 코어 include
// 경로에 포함되어 있고 libarduino_tinyusb.a에 항상 링크된다.
#include "tusb.h"

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

// SUSPEND 수신 시각 (0 = 유예 타이머 비활성). usbMscTick()이 판정.
static volatile unsigned long suspendedAtMs = 0;

// 세션 종료 에지 래치. eventTask가 mscActive를 주기적으로 '샘플링'해 에지를
// 잡으면, 두 관측 사이에 시작하고 끝난 짧은 세션(호스트가 즉시 eject 등)을
// 통째로 놓쳐 재마운트 안전장치가 조용히 건너뛰어진다 — 종료 시점에
// 래치를 세우고 소비하는 방식이라야 에지가 유실되지 않는다.
static volatile bool sessionEndPending = false;

// ── 판정 파라미터 ──
// SUSPEND_GRACE_MS: 오판 비용이 비대칭이다.
//   · 분리를 절전으로 오판 → 세션 종료 판정(재마운트)이 10초 늦을 뿐
//   · 절전을 분리로 오판 → 호스트가 붙어 있는데 세션 종료/재개가 반복
//     되는 플래핑 (폰 커널 wedge까지 유발)
#define SUSPEND_GRACE_MS   10000

// 호스트 raw I/O가 sdMutex를 기다리는 상한. 이벤트 저장(finalize+
// manageStorage 폴더 전수 순회+rename+썸네일)이 단일 크리티컬 섹션이라
// 4MHz 폴백 카드 + evt 폴더 수백 개 조건에서 15s를 넘길 수 있다
// — SCSI 타임아웃(30s) 안쪽 최대치로 상향해 호스트
// 복사가 이벤트 저장과 겹칠 때 I/O 오류로 끊기는 창을 줄인다
// (대기는 버스상 NAK = 합법 흐름제어).
#define MSC_RAW_MUTEX_WAIT_MS 25000

// ── 진단 계측 (BLE 텔레메트리로 노출) ──
// 시리얼 없는 배포 빌드에서 실패 '계층'을 판별하는 창구:
//   mscActive=false 고정      → 열거(SET_CONFIGURATION) 자체가 실패
//   mscActive=true, rd=0      → 열거 성공, SCSI 데이터 단계 실패
//   rd>0인데 폰에 드라이브 없음 → 데이터까지 성공, vold 정책 거부
volatile uint32_t mscReadSectors = 0;
volatile uint32_t mscWriteSectors = 0;

// ── SD 볼륨 UUID (FAT 볼륨 시리얼, "XXXX-XXXX") ──
// Android는 외장 저장소 볼륨의 SAF 문서 URI에 이 시리얼을 볼륨 ID로 쓴다.
// BLE 텔레메트리로 앱에 넘기면, 폴더 선택창(EXTRA_INITIAL_URI)을 DeFoTic
// 드라이브의 DEFOTIC 폴더에서 바로 열 수 있다 (최초 1회 선택 UX 단축).
// 빈 문자열 = 판독 실패(앱은 힌트 없이 기본 선택창으로 폴백).
char sdVolumeUuid[12] = "";

static void readVolumeUuid() {
    uint8_t sec[512];
    if (!SD.readRAW(sec, 0)) return;
    if (sec[510] != 0x55 || sec[511] != 0xAA) return;

    // LBA 0이 부트섹터(슈퍼플로피)인지 MBR인지 판별:
    // exFAT 서명 또는 유효한 BPB(섹터 크기 필드)가 있으면 부트섹터다.
    bool isExfat = memcmp(sec + 3, "EXFAT   ", 8) == 0;
    uint16_t bps = (uint16_t)sec[11] | ((uint16_t)sec[12] << 8);
    bool looksBoot = isExfat || bps == 512 || bps == 1024 || bps == 2048 || bps == 4096;

    if (!looksBoot) {
        // MBR → 첫 파티션 시작 LBA의 실제 부트섹터를 읽는다
        uint32_t lba = (uint32_t)sec[454] | ((uint32_t)sec[455] << 8) |
                       ((uint32_t)sec[456] << 16) | ((uint32_t)sec[457] << 24);
        if (lba == 0 || !SD.readRAW(sec, lba)) return;
        isExfat = memcmp(sec + 3, "EXFAT   ", 8) == 0;
    }

    uint32_t serial;
    if (isExfat) {
        serial = (uint32_t)sec[100] | ((uint32_t)sec[101] << 8) |
                 ((uint32_t)sec[102] << 16) | ((uint32_t)sec[103] << 24);
    } else if (memcmp(sec + 82, "FAT32", 5) == 0) {
        serial = (uint32_t)sec[67] | ((uint32_t)sec[68] << 8) |
                 ((uint32_t)sec[69] << 16) | ((uint32_t)sec[70] << 24);
    } else if (memcmp(sec + 54, "FAT", 3) == 0) {   // FAT12/16
        serial = (uint32_t)sec[39] | ((uint32_t)sec[40] << 8) |
                 ((uint32_t)sec[41] << 16) | ((uint32_t)sec[42] << 24);
    } else {
        return;
    }

    snprintf(sdVolumeUuid, sizeof(sdVolumeUuid), "%04X-%04X",
             (unsigned)((serial >> 16) & 0xFFFF), (unsigned)(serial & 0xFFFF));
    Serial.printf("[USB] SD volume UUID: %s\n", sdVolumeUuid);
}

// 세션 시작 공통 처리 (순수 관측 — 녹화에 영향 없음).
// 계측 카운터는 여기서만 리셋한다 — 분리 후에도 직전 세션의 rd/wr 값이
// BLE 텔레메트리에 남아 사후 진단(폰을 뺀 뒤 앱에서 확인)이 가능하다.
static void beginHostSession() {
    if (!mscActive) {
        mscActive = true;
        mscReadSectors = 0;
        mscWriteSectors = 0;
        Serial.println("[USB] Host session started (recording continues — v5)");
    }
    suspendedAtMs = 0;   // 데이터가 흐른다 = 절전/분리 아님
}

// ── 섹터 단위 read/write 콜백 (usbd 태스크 컨텍스트) ──
// 게이트 대기 없이 즉시 서비스한다. 단 sdMutex로 펌웨어 FS 쓰기와
// 직렬화한다 — 동일 SPI 버스에 두 컨텍스트가 동시에 SD 명령을 내리는
// 전기적/드라이버 충돌 방지 (뮤텍스 대기는 버스상 NAK라 호스트는 그냥
// 기다린다). 파일시스템 '논리' 정합성은 동시 접근 구조(원칙 2)에
// 따라 세션 종료 시 재마운트가 담당한다.
static int32_t onMscWrite(uint32_t lba, uint32_t offset, uint8_t *buffer, uint32_t bufsize) {
    beginHostSession();
    if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(MSC_RAW_MUTEX_WAIT_MS)) != pdTRUE) return -1;
    const uint32_t secSize = SD.sectorSize();
    if (secSize == 0) { xSemaphoreGive(sdMutex); return -1; }
    for (uint32_t i = 0; i < bufsize / secSize; i++) {
        if (!SD.writeRAW(buffer + i * secSize, lba + i)) {
            xSemaphoreGive(sdMutex);
            return -1;
        }
        mscWriteSectors++;
    }
    xSemaphoreGive(sdMutex);
    return (int32_t)bufsize;
}

static int32_t onMscRead(uint32_t lba, uint32_t offset, void *buffer, uint32_t bufsize) {
    beginHostSession();
    if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(MSC_RAW_MUTEX_WAIT_MS)) != pdTRUE) return -1;
    const uint32_t secSize = SD.sectorSize();
    if (secSize == 0) { xSemaphoreGive(sdMutex); return -1; }
    for (uint32_t i = 0; i < bufsize / secSize; i++) {
        if (!SD.readRAW((uint8_t *)buffer + i * secSize, lba + i)) {
            xSemaphoreGive(sdMutex);
            return -1;
        }
        mscReadSectors++;
    }
    xSemaphoreGive(sdMutex);
    return (int32_t)bufsize;
}

// 세션 종료 공통 처리 — eventTask가 이 에지(true→false)를 보고 1회
// 재마운트(원칙 2-②)를 수행한다.
// mediaPresent는 건드리지 않는다 (원칙 1: 플래핑 금지).
static void endHostSession(const char *reason) {
    if (mscActive) sessionEndPending = true;   // 에지를 래치 (아래 소비 함수 참조)
    mscActive = false;
    suspendedAtMs = 0;
    Serial.printf("[USB] Host session ended (%s) — refreshing FAT view\n", reason);
}

static bool onMscStartStop(uint8_t power_condition, bool start, bool load_eject) {
    // 호스트가 명시적으로 eject → 호스트가 스스로 flush를 마친 가장
    // 깨끗한 종료 경로.
    if (load_eject && !start) {
        endHostSession("eject");
    }
    return true;
}

// ── USB 이벤트 (관측 전용) ──
static void usbEventCallback(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    if (event_base != ARDUINO_USB_EVENTS) return;

    switch (event_id) {
        case ARDUINO_USB_STARTED_EVENT:
            beginHostSession();
            break;

        case ARDUINO_USB_RESUME_EVENT:
            // 절전 복귀 — 유예 타이머만 해제. 세션 시작은 STARTED/데이터
            // 접근이 담당(노이즈성 RESUME이 상태를 흔들지 않게).
            suspendedAtMs = 0;
            break;

        case ARDUINO_USB_STOPPED_EVENT:
            endHostSession("stopped");
            break;

        case ARDUINO_USB_SUSPEND_EVENT:
            // 즉시 종료 금지: 호스트 절전(화면 꺼짐)일 수 있다.
            // 유예 판정은 usbMscTick()이 수행한다.
            if (suspendedAtMs == 0) {
                suspendedAtMs = millis();
            }
            break;

        default:
            break;
    }
}

// ── 주기 판정 (eventTask 루프/loop()에서 호출) ──
// SUSPEND 유예 만료 → 실분리로 판정하고 세션을 종료한다(관측 상태 갱신).
// 세션 종료 에지를 1회 소비한다 (읽으면 래치 해제).
bool usbMscConsumeSessionEnd() {
    if (!sessionEndPending) return false;
    sessionEndPending = false;
    return true;
}

void usbMscTick() {
    if (mscActive && suspendedAtMs != 0 &&
        (millis() - suspendedAtMs) >= SUSPEND_GRACE_MS) {
        endHostSession("suspend-timeout/unplug");
    }
}

// 호스트가 이 장치를 '구성'까지 마쳤고(SET_CONFIGURATION) 버스가 현재
// 활성인지 — TinyUSB 원시 상태 조회. diag 텔레메트리의 "usbHost".
// !tud_suspended() 결합 필수: 이 보드는 VBUS 감지가 없어 케이블 분리가
//   SUSPEND로만 관측되고 BUS_RESET이 오지 않는다 — tud_mounted()의 구성
//   상태만 보면 분리 후에도 영구 true로 남는다.
bool usbMscHostMounted() {
    return tud_mounted() && !tud_suspended();
}

void initUsbMsc() {
    if (SD.cardSize() == 0) {
        Serial.println("[USB] SD not ready — MSC disabled");
        return;
    }

    // 볼륨 UUID 판독 — 호스트 세션 시작 전(setup 단계)의 raw 읽기라 안전
    readVolumeUuid();

    // ── USB 장치 위생: 안드로이드/OS 식별 품질 ──
    // (열거 자체는 기본값으로도 통과함이 실증됐지만, 고유 시리얼은
    //  vold의 볼륨 식별을, bMaxPower=500mA는 전력 회계를 명확히 한다)
    USB.manufacturerName("DeFoTic");
    USB.productName("DeFoTic TicRecorder");
    USB.serialNumber("DEFOTIC-0001");
    USB.usbPower(500);

    // 순서 중요: 인터페이스 등록(msc.begin)을 마친 뒤 USB.begin()을
    //   호출해야 TinyUSB 디스크립터에 포함되어 호스트에 열거된다.
    msc.vendorID("DeFoTic");
    msc.productID("TicRecorder");
    msc.productRevision("2.0");
    msc.onRead(onMscRead);
    msc.onWrite(onMscWrite);
    msc.onStartStop(onMscStartStop);
    msc.mediaPresent(true);   // 원칙 1: 미디어는 항상 존재

    bool mscOk = msc.begin(SD.numSectors(), SD.sectorSize());

    USB.onEvent(usbEventCallback);
    USB.begin();

    Serial.printf("[USB] MSC %s (sectors=%u, sectorSize=%u, v5 concurrent)\n",
                  mscOk ? "ready" : "REGISTER FAILED",
                  (unsigned)SD.numSectors(), (unsigned)SD.sectorSize());
}
