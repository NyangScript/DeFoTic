#ifndef HARDWARE_INIT_H
#define HARDWARE_INIT_H

#include "config.h"



// ==========================================
// GLOBALS
// ==========================================

extern BLEServer *server;

extern BLECharacteristic *pCharacteristic;


extern bool deviceConnected;

extern bool timeSynced;

extern SemaphoreHandle_t sdMutex;
void initHardware();


// ==========================================
// INIT
// ==========================================

  

void initI2S();

void initCamera();

void initBLE();

void initSD();

void initTimeSync();

// ==========================================
// TASK
// ==========================================

void audioTask(void *pv);

void cameraTask(void *pv);


#endif