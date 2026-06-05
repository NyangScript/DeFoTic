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

// ==========================================
// BLE
// ==========================================

#define BLE_IMAGE_CHUNK 180

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

void sendImageBLE(String path);
extern volatile bool eventSaving;
#endif