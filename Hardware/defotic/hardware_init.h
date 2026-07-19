#ifndef HARDWARE_INIT_H
#define HARDWARE_INIT_H

#include "config.h"



// ==========================================
// GLOBALS
// ==========================================

extern BLEServer *server;

extern BLECharacteristic *pCharacteristic;


extern bool deviceConnected;

extern volatile bool timeSynced;

extern SemaphoreHandle_t sdMutex;
void initHardware();


// ==========================================
// INIT
// ==========================================

// (선언의 단일 기준과 호출 코어 제약은 config.h 참조)
bool initI2S();

void initCamera();

void initBLE();

void initSD();

// ==========================================
// TASK
// ==========================================

void audioTask(void *pv);

void cameraTask(void *pv);


#endif