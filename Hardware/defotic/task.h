// ============================
// task.h
// ============================

#ifndef TASK_H
#define TASK_H

#include "config.h"

void audioTask(void *pv);

// I2S 소비(audioTask)와 SD 기록을 분리한 오디오 writer — config.h 참조
void audioWriterTask(void *pv);

void cameraTask(void *pv);

void aiTask(void *pv);

void eventTask(void *pv);

// 호스트 세션 후 FatFS 캐시를 통째로 폐기하고 디스크에서 재판독.
// (스테일 FAT 뷰 위에 쓰는 교차 손상을 차단하는 소유권 복귀 절차)
// 성공 시 sdFsReady=true. 호출자는 sdMutex를 잡은 상태여야 한다.
bool sdRemountFresh();

#endif