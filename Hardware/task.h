// ============================
// task.h
// ============================

#ifndef TASK_H
#define TASK_H

#include "config.h"

void audioTask(void *pv);

void cameraTask(void *pv);

void aiTask(void *pv);

void eventTask(void *pv);

void saveFramesToAVI(
    String folder,
    int startFrameIdx
);

void saveAudioToWav(
    String folder
);

#endif