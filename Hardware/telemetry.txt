// =====================================================
// telemetry.cpp — BLE Telemetry & Event Transfer
// =====================================================
// Sends periodic status JSON and event data chunks
// to the companion app via BLE Notification.
// =====================================================

#include "config.h"
#include "mbedtls/base64.h"

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

// Simple CRC32 for C++
static uint32_t calculate_crc32(const uint8_t *data, size_t length) {
    uint32_t crc = 0xFFFFFFFF;
    for (size_t i = 0; i < length; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            crc = (crc >> 1) ^ (0xEDB88320 & (-(crc & 1)));
        }
    }
    return ~crc;
}

// Helper to count chunks for a file
static void getFileStats(const String& path, size_t rawChunk, size_t& outSize, size_t& outChunks) {
    if (!SD.exists(path)) return;
    File f = SD.open(path, FILE_READ);
    if (!f) return;
    size_t size = f.size();
    f.close();
    if (size > 0) {
        outSize += size;
        outChunks += (size + rawChunk - 1) / rawChunk;
    }
}

// Sends a specific file as chunks
static void sendFileChunks(const String& path, const char* typeStr, const char* eventId, size_t totalChunks, size_t& currentIndex, const size_t RAW_CHUNK) {
    if (!SD.exists(path)) return;
    File file = SD.open(path, FILE_READ);
    if (!file) return;

    uint8_t rawBuf[RAW_CHUNK];
    while (file.available()) {
        size_t bytesRead = file.read(rawBuf, RAW_CHUNK);
        if (bytesRead == 0) break;

        // Base64 encode
        size_t encLen = ((bytesRead + 2) / 3) * 4 + 1;
        unsigned char *encoded = (unsigned char *)malloc(encLen);
        if (!encoded) break;

        size_t outLen = 0;
        mbedtls_base64_encode(encoded, encLen, &outLen, rawBuf, bytesRead);
        
        // Calculate CRC32 of the BASE64 string
        uint32_t crc = calculate_crc32((const uint8_t*)encoded, outLen);

        size_t jsonLen = outLen + 128;
        char *chunkJson = (char *)malloc(jsonLen);
        if (chunkJson) {
            snprintf(chunkJson, jsonLen,
                "{\"type\":\"%s_chunk\","
                "\"eventId\":\"%s\","
                "\"index\":%u,"
                "\"total\":%u,"
                "\"crc32\":\"%08X\","
                "\"payload\":\"%.*s\"}",
                typeStr,
                eventId,
                (unsigned)currentIndex,
                (unsigned)totalChunks,
                (unsigned int)crc,
                (int)outLen,
                encoded
            );
            bleSend(chunkJson);
            free(chunkJson);
        }

        free(encoded);
        currentIndex++;
        delay(20); // BLE pacing
    }
    file.close();
}

// =====================================================
// EVENT TRANSFER
// Called after tic event is saved to SD.
// Sends: event_start meta → video/audio chunks → event_end
// =====================================================
void sendEventBLE(const char *folder, const char *eventId, unsigned long timestamp) {
    if (!deviceConnected || !pCharacteristic) return;

    const size_t RAW_CHUNK = 240;
    size_t videoSize = 0, videoChunks = 0;
    size_t audioSize = 0, audioChunks = 0;

    // Calculate totals across all 3 parts
    for (int i = 0; i < 3; i++) {
        String vPath = String(folder) + "/video_part_" + String(i) + ".avi";
        String aPath = String(folder) + "/audio_part_" + String(i) + ".wav";
        getFileStats(vPath, RAW_CHUNK, videoSize, videoChunks);
        getFileStats(aPath, RAW_CHUNK, audioSize, audioChunks);
    }

    if (videoSize == 0 && audioSize == 0) return;

    // ── Step 1: Send event_start metadata ──
    char meta[256];
    snprintf(meta, sizeof(meta),
        "{\"type\":\"event_start\","
        "\"eventId\":\"%s\","
        "\"timestamp\":%lu,"
        "\"videoSize\":%u,"
        "\"audioSize\":%u,"
        "\"videoChunks\":%u,"
        "\"audioChunks\":%u,"
        "\"protocolVersion\":\"1.0\"}",
        eventId,
        timestamp,
        (unsigned)videoSize,
        (unsigned)audioSize,
        (unsigned)videoChunks,
        (unsigned)audioChunks
    );
    bleSend(meta);
    delay(100);

    // ── Step 2: Send chunks ──
    size_t currentVideoIndex = 0;
    size_t currentAudioIndex = 0;

    for (int i = 0; i < 3; i++) {
        String vPath = String(folder) + "/video_part_" + String(i) + ".avi";
        sendFileChunks(vPath, "video", eventId, videoChunks, currentVideoIndex, RAW_CHUNK);
    }

    for (int i = 0; i < 3; i++) {
        String aPath = String(folder) + "/audio_part_" + String(i) + ".wav";
        sendFileChunks(aPath, "audio", eventId, audioChunks, currentAudioIndex, RAW_CHUNK);
    }

    // ── Step 3: Send event_end ──
    char endMsg[128];
    snprintf(endMsg, sizeof(endMsg),
        "{\"type\":\"event_end\","
        "\"eventId\":\"%s\"}",
        eventId
    );
    bleSend(endMsg);
}
