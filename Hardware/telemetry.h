// ============================
// telemetry.h
// ============================
#ifndef TELEMETRY_H
#define TELEMETRY_H

// Task entry — create with xTaskCreatePinnedToCore
void telemetryTask(void *pv);

// Call when a tic is detected to update telemetry counters
void telemetry_incrementTick();

// Send a single tic_event metadata packet over BLE.
// Media stays on the SD card; the app imports it later via C-to-C.
// 강도/요인/상황 맥락 판단은 앱의 LLM 분석이 미디어를 근거로 수행한다.
void telemetry_sendTicEvent(const char *eventId, unsigned long timestamp, float confidence);

#endif
