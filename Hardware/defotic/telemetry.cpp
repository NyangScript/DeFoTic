// =====================================================
// telemetry.cpp — BLE Telemetry & Tic Event Metadata
// =====================================================
// Sends periodic status JSON and, on tic detection, a
// single tic_event metadata packet via BLE Notification.
// Media files stay on the SD card and are imported by
// the app later through C-to-C (USB Mass Storage).
// =====================================================

#include "config.h"
#include "telemetry.h"
#include "usb_msc.h"  // mscActive/usbMscHostMounted — usbState·usbHost 진단 텔레메트리용

// =====================================================
// INTERNAL STATE
// =====================================================

static int tickCountToday = 0;
static unsigned long lastEventTimeMs = 0;

// Call this from eventTask when a tic is detected
void telemetry_incrementTick() {
    tickCountToday++;
    lastEventTimeMs = millis();
}

// =====================================================
// HELPER: send a string via BLE notify (with guard)
// =====================================================
// bleMutex 직렬화: telemetryTask(core 0)와 eventTask(core 1의
// telemetry_sendTicEvent)가 동시에 호출하면 setValue/notify가 겹쳐
// 패킷 내용이 뒤섞이거나(스왑) 유실된다.
static void bleSend(const char *msg) {
    if (!deviceConnected || !pCharacteristic) return;
    if (xSemaphoreTake(bleMutex, pdMS_TO_TICKS(500)) != pdTRUE) return;
    pCharacteristic->setValue(msg);
    pCharacteristic->notify();
    delay(30);  // give BLE stack time to flush
    xSemaphoreGive(bleMutex);
}

// =====================================================
// TIC EVENT METADATA
// Single lightweight packet — no media payload.
// =====================================================
void telemetry_sendTicEvent(const char *eventId, unsigned long timestamp, float confidence, bool mediaSaved) {
    // media 필드: false면 SD에 미디어가 없는 메타 전용 이벤트 —
    // 앱이 C-to-C 동기화 대기를 걸지 않도록 구분한다. (+13B, 192B 내 여유.
    // 필드가 없는 구펌웨어 패킷은 앱이 media:true로 간주 — 하위 호환)
    char json[192];
    snprintf(json, sizeof(json),
        "{\"type\":\"tic_event\","
        "\"eventId\":\"%s\","
        "\"timestamp\":%lu,"
        "\"confidence\":%.2f,"
        "\"media\":%s}",
        eventId,
        timestamp,
        confidence,
        mediaSaved ? "true" : "false"
    );
    bleSend(json);
}

// =====================================================
// TELEMETRY TASK
// Sends device status JSON every 3 seconds
// =====================================================
void telemetryTask(void *pv) {
    // Allow hardware to finish initializing
    vTaskDelay(pdMS_TO_TICKS(5000));

    while (true) {
        if (deviceConnected) {
            // ── Gather metrics ──
            int batteryPercent = 100;  // ESP32-S3 has no built-in battery ADC; stub

            // SD 사용량은 sdFsReady일 때만 FS에 질의한다 — 재마운트
            //   진행/실패 구간에는 FS 접근을 금지하고 마지막 정상값을
            //   재사용한다.
            // sdMutex 필수: totalBytes/usedBytes는 FAT를 순회하는 FS
            //   접근이다 — 녹화 태스크의 쓰기와 무락으로 겹치면 SPI 버스/
            //   FatFS 상태가 충돌한다. 경합 중이면 이번 주기는 캐시로 대체
            //   (텔레메트리가 녹화를 기다리게 하지 않는다 — 50ms 상한).
            // 소수 1자리 해상도: 30GB급 카드에서 /loop+이벤트 수백 MB는
            // 정수 %로는 0에 갇혀 녹화 진행이 보이지 않는다 — 0.1% 단위면
            // 수 분 내에 눈에 보인다. (계산은 정수 산술 ×1000 후 /10 —
            // 부동소수 제거)
            // 호스트 MSC 세션 중에도 FS는 펌웨어 소유이므로(동시 접근
            // 구조) sdMutex 직렬화만으로 안전하게 질의한다.
            static float sdUsedPercentCache = 0.0f;
            if (sdFsReady &&
                xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                if (sdFsReady) {   // 획득 후 재확인
                    uint64_t totalBytes = SD.totalBytes();
                    uint64_t usedBytes  = SD.usedBytes();
                    if (totalBytes > 0) {
                        sdUsedPercentCache =
                            (float)((usedBytes * 1000ULL) / totalBytes) / 10.0f;
                    }
                }
                xSemaphoreGive(sdMutex);
            }
            float sdUsedPercent = sdUsedPercentCache;

            // Temperature from internal sensor
            float temperature = temperatureRead();

            // Camera / microphone are always on after init
            bool cameraOk = true;
            bool micOk     = true;

            // ── USB 세션 상태 (진단 계측) ──
            // 시리얼 없는 배포 빌드에서 C-to-C 실패 '계층'을 판별하는 창구.
            //   none  : 호스트 미감지 → 폰에 꽂았는데도 none이면 열거 실패
            //   ready : 호스트 세션 활성 — 드라이브 서비스 중 (녹화도
            //           계속된다). 앱은 이 값을 자동 동기화 트리거로 쓴다.
            // usbRd/usbWr: 이번(또는 직전) 세션에 호스트가 실제 읽고/쓴 섹터 수.
            // ready인데 usbRd=0이면 SCSI 데이터 단계 실패, usbRd>0인데 폰에
            // 드라이브가 안 뜨면 Android vold 정책 거부로 좁혀진다.
            const char *usbState = mscActive ? "ready" : "none";

            // ── Build JSON ──
            // aiLevel: 실시간 abnormal 레벨 — 시리얼 없는 배포 빌드에서
            // 앱 기기 상태 화면으로 모델 생사/문턱 적정성을 진단하는 채널
            // ── 마이크 스트림 생사 판별 (aiLevel 0.00 원인 분기) ──
            // 누적 샘플 카운터가 3초(텔레메트리 주기) 동안 멈춰 있으면
            // I2S 드라이버/DMA 정지(stall) — 코드/드라이버 문제.
            // 카운터는 흐르는데 피크가 0이면 무음(silent) — PDM 데이터
            // 라인/마이크 하드웨어 문제. 피크가 있으면 정상(ok) — 이때도
            // aiLevel이 0이면 모델(트레이닝) 측 문제로 확정된다.
            // (audioWriteIndex 대신 audioTotalSamples를 쓴다 — 링 크기로
            //  접히는 인덱스와 달리 누적 카운터는 우연한 일치가 없다)
            static uint32_t lastSampleSnapshot = 0;
            uint32_t samplesNow = audioTotalSamples;
            bool micStalled = (samplesNow == lastSampleSnapshot);
            lastSampleSnapshot = samplesNow;
            const char *micState = micStalled ? "stall"
                                 : (lastAudioPeak == 0 ? "silent" : "ok");

            // 상태/진단을 2개 패킷으로 분할 전송한다 (합치기 금지):
            //   BLE notify 페이로드는 협상 MTU-3까지만 실리는데 폰 스택이
            //   흔히 247(=244B)로 캡한다. 진단 필드를 한 패킷에 합치면
            //   ~280B로 잘려 앱 JSON.parse가 실패 → 모든 센서 값이
            //   동결된다. 각 패킷을 ~200B 이하로 유지할 것.
            char json[288];
            snprintf(json, sizeof(json),
                "{\"type\":\"status\","
                "\"battery\":%d,"
                "\"sdUsed\":%.1f,"
                "\"temperature\":%.1f,"
                "\"camera\":%s,"
                "\"microphone\":%s,"
                "\"connected\":true,"
                "\"tickCountToday\":%d,"
                "\"lastEventTime\":%lu,"
                "\"aiLevel\":%.2f}",
                batteryPercent,
                sdUsedPercent,
                temperature,
                cameraOk ? "true" : "false",
                micOk ? "true" : "false",
                tickCountToday,
                lastEventTimeMs,
                lastAiLevel
            );
            bleSend(json);

            // 패킷 2: 진단(diag) — USB 세션 계층/마이크 생사/볼륨 UUID.
            // 앱은 type=diag도 같은 스토어 병합 경로로 처리한다.
            // aiRms: 추론 창 RMS — 순수 진단 채널(판정에는 쓰지 않는다).
            // abnormal이 창 에너지와 비례하는지(모델 정상성) 대조용이며
            // 앱 화면에는 표시하지 않는다. (~200B 상한 규칙 준수)
            // usbHost: TinyUSB 구성 여부 원시값 — usbState=none인데
            // usbHost=true면 "호스트에 물려 있으나 디스크 미사용(전원 공급/
            // 유휴 재개 후)"로 판독된다. 앱 기기 화면의 USB 배너 판정에 사용.
            char diag[224];
            snprintf(diag, sizeof(diag),
                "{\"type\":\"diag\","
                "\"usbState\":\"%s\","
                "\"usbHost\":%s,"
                "\"usbRd\":%lu,"
                "\"usbWr\":%lu,"
                "\"micPeak\":%ld,"
                "\"micState\":\"%s\","
                "\"aiRms\":%lu,"
                "\"sdUuid\":\"%s\"}",
                usbState,
                usbMscHostMounted() ? "true" : "false",
                (unsigned long)mscReadSectors,
                (unsigned long)mscWriteSectors,
                (long)lastAudioPeak,
                micState,
                (unsigned long)lastAiWindowRms,
                sdVolumeUuid
            );
            bleSend(diag);

            // 전송한 구간의 피크는 소진 — 다음 3초 창을 새로 측정한다
            lastAudioPeak = 0;
        }

        // Send every 3 seconds
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
