// ============================
// telemetry.h
// ============================
#ifndef TELEMETRY_H
#define TELEMETRY_H

// Task entry — create with xTaskCreatePinnedToCore
void telemetryTask(void *pv);

// Call when a tic is detected to update telemetry counters
void telemetry_incrementTick();

// Send a file over BLE using the chunk protocol
// fileType: "video" or "audio"
void sendEventBLE(const char *folder, const char *eventId, unsigned long timestamp);

#endif
