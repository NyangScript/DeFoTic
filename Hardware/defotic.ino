// =====================================================
// defotic.ino
// =====================================================
#include "config.h"
#include "hardware_init.h"
#include "task.h"
#include "telemetry.h"

int16_t *audioBuffer = nullptr;
volatile size_t audioWriteIndex = 0;
bool ticDetected = false;
volatile bool eventSaving = false;
int frameIndex = 0;
String lastImagePath = "";
unsigned long lastCaptureTime = 0;
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

    Serial.printf("PSRAM SIZE: %d MB\n", ESP.getPsramSize() / 1024 / 1024);

    // 3. 오디오 링 버퍼 할당
    audioBuffer = (int16_t *)ps_malloc(AUDIO_BUFFER_SIZE * sizeof(int16_t));
    if(audioBuffer == nullptr) {
        Serial.println("AUDIO BUFFER MALLOC FAIL");
        while(true) { delay(1000); }
    }
    memset(audioBuffer, 0, AUDIO_BUFFER_SIZE * sizeof(int16_t));

    Serial.println("=========================================");
    Serial.println("CRITICAL: BLE TIME SYNC REQUIRED TO START");
    Serial.println("=========================================");
}

// =====================================================
// LOOP
// =====================================================
void loop() {
    // [★핵심 변경] 시간 동기화(timeSynced)가 안 되었으면 아예 아무것도 하지 않고 대기합니다.
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
        xTaskCreatePinnedToCore(audioTask, "audioTask", 8192, NULL, 1, NULL, 0);
        xTaskCreatePinnedToCore(cameraTask, "cameraTask", 8192, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(aiTask, "aiTask", 16384, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(eventTask, "eventTask", 16384, NULL, 1, NULL, 1);
        xTaskCreatePinnedToCore(telemetryTask, "telemetryTask", 8192, NULL, 1, NULL, 0);

        Serial.println("SYSTEM RUNNING");
    }
    
    delay(100);
}