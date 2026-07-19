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
// mediaSaved=false: SD에 미디어가 없는 메타 전용 이벤트(MSC 세션 중 감지,
// SD 부재/폴더 생성 실패 등) — 앱은 이 플래그로 '동기화 대기'를 걸지 않는다.
void telemetry_sendTicEvent(const char *eventId, unsigned long timestamp, float confidence, bool mediaSaved);

#endif
