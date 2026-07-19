// =====================================================
// defotic.ino
// =====================================================
#include "config.h"
#include "hardware_init.h"
#include "task.h"
#include "telemetry.h"
#include "usb_msc.h"

int16_t *audioBuffer = nullptr;
volatile size_t audioWriteIndex = 0;
volatile uint32_t audioTotalSamples = 0;
volatile bool ticDetected = false;
volatile float lastConfidence = 0.0f;
volatile float lastAiLevel = 0.0f;
volatile int32_t lastAudioPeak = 0;
volatile uint32_t lastAiWindowRms = 0;
volatile bool sdFsReady = true;
volatile bool eventSaving = false;
uint8_t *snapshotBuf = nullptr;
uint8_t *snapshotStaging = nullptr;
volatile size_t snapshotLen = 0;
bool started = false;

// =====================================================
// SETUP
// =====================================================
void setup() {
    // 1. 카메라 버퍼 할당을 위해 PSRAM 최우선 초기화
    if(!psramInit()) {
        Serial.begin(115200);
        Serial.println("PSRAM INIT FAIL");
        while(true) { delay(1000); }
    }

    // 2. 하드웨어 종합 초기화 (Serial, SD, Camera, I2S, BLE)
    initHardware();

    // 3. USB MSC — C-to-C 연결 시 SD를 USB 드라이브로 노출
    initUsbMsc();

    Serial.printf("PSRAM SIZE: %d MB\n", ESP.getPsramSize() / 1024 / 1024);

    // 3. 오디오 링 버퍼 할당
    audioBuffer = (int16_t *)ps_malloc(AUDIO_BUFFER_SIZE * sizeof(int16_t));
    if(audioBuffer == nullptr) {
        Serial.println("AUDIO BUFFER MALLOC FAIL");
        while(true) { delay(1000); }
    }
    memset(audioBuffer, 0, AUDIO_BUFFER_SIZE * sizeof(int16_t));

    // 4. 라이브 스냅샷 버퍼 (PSRAM 2×48KB) — 실패 시 썸네일만 비활성(치명 아님)
    snapshotBuf = (uint8_t *)ps_malloc(SNAPSHOT_MAX_BYTES);
    snapshotStaging = (uint8_t *)ps_malloc(SNAPSHOT_MAX_BYTES);
    if (snapshotBuf == nullptr || snapshotStaging == nullptr) {
        // 반쪽 할당이면 성공한 블록을 반납하고 기능 전체 비활성 —
        // free 없이 null 대입만 하면 성공한 48KB 블록이 도달 불능 누수가 된다.
        free(snapshotBuf);
        free(snapshotStaging);
        snapshotBuf = nullptr;
        snapshotStaging = nullptr;
        Serial.println("SNAPSHOT BUFFER MALLOC FAIL — thumbnails disabled");
    }

    Serial.println("=========================================");
    Serial.println("CRITICAL: BLE TIME SYNC REQUIRED TO START");
    Serial.println("=========================================");
}

// =====================================================
// LOOP
// =====================================================
void loop() {
    // ── 녹화 태스크 기동 전 구간 ──
    // 게이트가 없으므로(데이터 상시 서비스) 호스트는 이 구간에도 자유롭게
    // 드라이브를 읽는다. 세션 관측(SUSPEND 유예 판정)만 유지 — 호스트가
    // 이 구간에 쓴 내용은 eventTask 기동 경로의 fresh 재마운트가 재판독한다.
    if (!started) {
        usbMscTick();
    }

    // 시간 동기화(timeSynced)가 완료될 때까지는 아무것도 하지 않고 대기한다.
    if (!timeSynced) {
        static unsigned long lastNotify = 0;
        if (millis() - lastNotify > 5000) { // 5초마다 경고 출력
            lastNotify = millis();
            Serial.println("[WAIT] 시스템 대기 중: BLE 시간 동기화(TIME:...)가 필요합니다.");
        }
        delay(100);
        return; // 아래의 태스크 생성 및 어떤 로직도 실행하지 않고 루프를 빠져나감
    }

    // 시간 동기화가 완료된 후, 최초 1회만 태스크들을 실행합니다.
    if(!started) {
        started = true;
        Serial.println("=========================================");
        Serial.println("TIME SYNCED SUCCESS -> STARTING ALL TASKS");
        Serial.println("=========================================");

        // 시간 동기화 확인 후에만 각 태스크 코어 할당 및 구동 시작
        //
        // 코어/우선순위 배치:
        //  - audioTask(core 0, prio 2): I2S 소비 전담 생산자. I2S 드라이버의
        //    설치/복구도 이 태스크가 수행한다(코어 간 인터럽트 해제 불가
        //    제약). 같은 코어의 다른 태스크보다 높은 우선순위로 i2s_read
        //    주기를 보장 — DMA 오버런(→ S3 RX 스톨)의 마지막 방어선.
        //  - audioWriterTask(core 0, prio 1): ADPCM 인코딩 + WAV 기록.
        //    SD가 수백 ms 멈춰도 링 버퍼(180s)가 흡수하므로 낮은 우선순위.
        xTaskCreatePinnedToCore(audioTask, "audioTask", 8192, NULL, 2, NULL, 0);
        xTaskCreatePinnedToCore(audioWriterTask, "audioWriter", 8192, NULL, 1, NULL, 0);
        xTaskCreatePinnedToCore(cameraTask, "cameraTask", 8192, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(aiTask, "aiTask", 16384, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(eventTask, "eventTask", 16384, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(telemetryTask, "telemetryTask", 8192, NULL, 1, NULL, 0);

        Serial.println("SYSTEM RUNNING");
    }
    
    delay(100);
}