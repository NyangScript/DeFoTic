// ============================
// config.h
// ============================

#ifndef CONFIG_H
#define CONFIG_H

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Arduino.h>
#include "esp_camera.h"


#include <driver/i2s.h>

#include "FS.h"
#include "SD.h"
#include "SPI.h"

#include <time.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

// NOTE: USB 시리얼 정책 (usb_msc.h 참조)
//  - 폰 인식을 위해 배포 빌드는 CDC 없는 "순수 MSC 단독 장치"여야 한다.
//    (Android는 CDC가 섞인 복합 장치의 저장소를 마운트하지 않음)
//  - 따라서 CDC On Boot=Disabled 빌드에서 Serial은 UART0으로 빠지며(무해),
//    시리얼 모니터가 필요한 개발 빌드는 CDC On Boot=Enabled로 전환한다.

#define SERVICE_UUID \
"4fafc201-1fb5-459e-8fcc-c5c9c331914b"

#define CHARACTERISTIC_UUID \
"beb5483e-36e1-4688-b7f5-ea07361b26a8"

// ==========================================
// SD SPI
// ==========================================

#define SD_CS   21
#define SD_SCK  7
#define SD_MISO 8
#define SD_MOSI 9

// ==========================================
// AUDIO
// ==========================================

#define SAMPLE_RATE 16000

#define AUDIO_PRE_SECONDS 180

#define AUDIO_BUFFER_SIZE \
(SAMPLE_RATE * AUDIO_PRE_SECONDS)

#define ADPCM_BLOCK_SIZE 256
#define ADPCM_SAMPLES_PER_BLOCK 505

// ==========================================
// VIDEO
// ==========================================

#define VIDEO_RING_FRAMES 5400

#define FRAME_INTERVAL_MS 33

#define EVENT_SAVE_SECONDS 180

// ==========================================
// AI
// ==========================================

#define AI_THRESHOLD 0.4

// 이벤트 트리거 후 동일 잔여 오디오로 인한 중복 감지 방지 (빈도 지표 보호)
#define TIC_COOLDOWN_MS 10000

// ==========================================
// STORAGE
// ==========================================

#define STORAGE_LIMIT_MB 512

// ==========================================
// GLOBALS
// ==========================================

extern bool timeSynced;
extern int16_t *audioBuffer;
extern bool ticDetected;

// AI 추론에서 마지막으로 감지된 confidence (tic_event 메타데이터에 포함)
// 틱의 강도/요인/상황 맥락 판단은 앱의 LLM 분석 파이프라인이 전담한다.
extern volatile float lastConfidence;

// AI 오디오 링 버퍼 동기화용 (ai_task.cpp에 정의, audioTask 쓰기 시 공유)
extern portMUX_TYPE aiMux;

extern volatile size_t audioWriteIndex;

extern int frameIndex;

extern SemaphoreHandle_t sdMutex;

extern String lastImagePath;

extern unsigned long lastCaptureTime;

// ==========================================
// BLE
// ==========================================

class BLECharacteristic;

extern BLECharacteristic *pCharacteristic;

extern bool deviceConnected;

// ==========================================
// TASKS
// ==========================================

void audioTask(void *pv);

void cameraTask(void *pv);

void aiTask(void *pv);

void eventTask(void *pv);

// ==========================================
// INIT
// ==========================================

bool initSDCard();

void initCamera();

void initI2S();

void initBLE();

void manageStorage();

extern volatile bool eventSaving;
#endif