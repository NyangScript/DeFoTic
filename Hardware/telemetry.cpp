// =====================================================
// telemetry.cpp — BLE Telemetry & Tic Event Metadata
// =====================================================
// Sends periodic status JSON and, on tic detection, a
// single tic_event metadata packet via BLE Notification.
// Media files stay on the SD card and are imported by
// the app later through C-to-C (USB Mass Storage).
// =====================================================

#include "config.h"
#include "telemetry.h"

// =====================================================
// INTERNAL STATE
// =====================================================

static int tickCountToday = 0;
static unsigned long lastEventTimeMs = 0;

// Call this from eventTask when a tic is detected
void telemetry_incrementTick() {
    tickCountToday++;
    lastEventTimeMs = millis();
}

// =====================================================
// HELPER: send a string via BLE notify (with guard)
// =====================================================
static void bleSend(const char *msg) {
    if (!deviceConnected || !pCharacteristic) return;
    pCharacteristic->setValue(msg);
    pCharacteristic->notify();
    delay(30);  // give BLE stack time to flush
}

// =====================================================
// TIC EVENT METADATA
// Single lightweight packet — no media payload.
// =====================================================
void telemetry_sendTicEvent(const char *eventId, unsigned long timestamp, float confidence) {
    char json[192];
    snprintf(json, sizeof(json),
        "{\"type\":\"tic_event\","
        "\"eventId\":\"%s\","
        "\"timestamp\":%lu,"
        "\"confidence\":%.2f}",
        eventId,
        timestamp,
        confidence
    );
    bleSend(json);
}

// =====================================================
// TELEMETRY TASK
// Sends device status JSON every 3 seconds
// =====================================================
void telemetryTask(void *pv) {
    // Allow hardware to finish initializing
    vTaskDelay(pdMS_TO_TICKS(5000));

    while (true) {
        if (deviceConnected) {
            // ── Gather metrics ──
            int batteryPercent = 100;  // ESP32-S3 has no built-in battery ADC; stub
            int sdUsedPercent  = 0;

            // Calculate SD usage if SD is available
            uint64_t totalBytes = SD.totalBytes();
            uint64_t usedBytes  = SD.usedBytes();
            if (totalBytes > 0) {
                sdUsedPercent = (int)((usedBytes * 100ULL) / totalBytes);
            }

            // Temperature from internal sensor
            float temperature = temperatureRead();

            // Camera / microphone are always on after init
            bool cameraOk = true;
            bool micOk     = true;

            // ── Build JSON ──
            char json[256];
            snprintf(json, sizeof(json),
                "{\"type\":\"status\","
                "\"battery\":%d,"
                "\"sdUsed\":%d,"
                "\"temperature\":%.1f,"
                "\"camera\":%s,"
                "\"microphone\":%s,"
                "\"connected\":true,"
                "\"tickCountToday\":%d,"
                "\"lastEventTime\":%lu}",
                batteryPercent,
                sdUsedPercent,
                temperature,
                cameraOk ? "true" : "false",
                micOk ? "true" : "false",
                tickCountToday,
                lastEventTimeMs
            );

            bleSend(json);
        }

        // Send every 3 seconds
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
