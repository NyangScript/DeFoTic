// =====================================================
// task.cpp (안정성 가드 포함 / 시리얼 로그 전면 제거 버전)
// =====================================================

#include "task.h"
#include "config.h"
#include "telemetry.h"
#include "mbedtls/base64.h"

#define MAX_SEGMENT_FRAMES    1900   
#define SEGMENT_DURATION_MS   60000  
#define SD_FREE_SPACE_LIMIT   (200 * 1024 * 1024) 

int current_slot = 0;
unsigned long segment_start_ms = 0;
volatile bool segment_changing = false;

uint32_t *segment_offsets = NULL;
uint32_t *segment_sizes = NULL;
int segment_frame_count = 0;
uint32_t segment_total_video_size = 0;
uint32_t segment_audio_bytes = 0;

File current_avi_file;
File current_wav_file;

#define AUDIO_STREAM_BUF_SIZE 4096
uint8_t audioStreamBuf[AUDIO_STREAM_BUF_SIZE];
size_t audioStreamBufIdx = 0;

// =====================================================
// LOW-LEVEL HELPERS
// =====================================================
void write4Bytes(File &file, uint32_t value) {
    file.write((uint8_t)(value & 0xFF));
    file.write((uint8_t)((value >> 8) & 0xFF));
    file.write((uint8_t)((value >> 16) & 0xFF));
    file.write((uint8_t)((value >> 24) & 0xFF));
}

void write2Bytes(File &file, uint16_t value) {
    file.write((uint8_t)(value & 0xFF));
    file.write((uint8_t)((value >> 8) & 0xFF));
}

void writeWavHeader(File &file, uint32_t dataSize) {
    uint32_t sampleRate = SAMPLE_RATE;
    uint16_t numChannels = 1;
    file.write((const uint8_t*)"RIFF", 4);
    uint32_t fileSize = dataSize + 36;
    file.write((const uint8_t*)&fileSize, 4);
    file.write((const uint8_t*)"WAVEfmt ", 8);
    uint32_t fmtSize = 16;
    file.write((const uint8_t*)&fmtSize, 4);
    uint16_t fmt = 1;
    file.write((const uint8_t*)&fmt, 2);
    file.write((const uint8_t*)&numChannels, 2);
    file.write((const uint8_t*)&sampleRate, 4);
    uint32_t byteRate = sampleRate * 2;
    file.write((const uint8_t*)&byteRate, 4);
    uint16_t align = 2;
    file.write((const uint8_t*)&align, 2);
    uint16_t bps = 16;
    file.write((const uint8_t*)&bps, 2);
    file.write((const uint8_t*)"data", 4);
    file.write((const uint8_t*)&dataSize, 4);
}

// =====================================================
// RECURSIVE DIRECTORY DELETER
// =====================================================
void deleteFolderRecursive(String path) {
    File dir = SD.open(path);
    if (!dir || !dir.isDirectory()) return;

    File file = dir.openNextFile();
    while (file) {
        String filePath = String(path) + "/" + file.name();
        if (file.isDirectory()) {
            file.close();
            deleteFolderRecursive(filePath);
        } else {
            file.close();
            SD.remove(filePath);
        }
        file = dir.openNextFile();
    }
    dir.close();
    SD.rmdir(path);
}

// =====================================================
// STORAGE MANAGER
// =====================================================
void manageStorage() {
    uint64_t totalBytes = SD.totalBytes();
    uint64_t usedBytes = SD.usedBytes();
    uint64_t freeBytes = totalBytes - usedBytes;

    if (freeBytes > SD_FREE_SPACE_LIMIT) return;

    File root = SD.open("/");
    if (!root) return;

    String oldestFolder = "";
    String oldestFolderName = "99999999_999999"; 

    File entry = root.openNextFile();
    while (entry) {
        if (entry.isDirectory()) {
            String name = String(entry.name());
            if (name.startsWith("event_")) {
                if (name < oldestFolderName) {
                    oldestFolderName = name;
                    oldestFolder = "/" + name;
                }
            }
        }
        entry.close();
        entry = root.openNextFile();
    }
    root.close();

    if (oldestFolder != "") {
        deleteFolderRecursive(oldestFolder);
    }
}

// =====================================================
// SEGMENT CONTROL
// =====================================================
void startNewSegment() {
    if (!segment_offsets) segment_offsets = (uint32_t*)ps_malloc(MAX_SEGMENT_FRAMES * sizeof(uint32_t));
    if (!segment_sizes) segment_sizes = (uint32_t*)ps_malloc(MAX_SEGMENT_FRAMES * sizeof(uint32_t));

    segment_frame_count = 0;
    segment_total_video_size = 0;
    segment_audio_bytes = 0;
    audioStreamBufIdx = 0;

    if (!SD.exists("/loop")) SD.mkdir("/loop");
    if (!SD.exists("/buffer")) SD.mkdir("/buffer");

    char v_path[32], a_path[32];
    sprintf(v_path, "/loop/v_%d.avi", current_slot);
    sprintf(a_path, "/loop/a_%d.wav", current_slot);

    current_avi_file = SD.open(v_path, FILE_WRITE);
    current_wav_file = SD.open(a_path, FILE_WRITE);
    Serial.printf(
    "AVI OPEN=%d WAV OPEN=%d\n",
    current_avi_file ? 1 : 0,
    current_wav_file ? 1 : 0
    );

    if (current_avi_file && current_wav_file) {
        uint8_t dummyHeader[2048] = {0};
        current_avi_file.write(dummyHeader, sizeof(dummyHeader));
        current_avi_file.print("LIST");
        write4Bytes(current_avi_file, 0); 
        current_avi_file.print("movi");

        uint8_t dummyWav[44] = {0};
        current_wav_file.write(dummyWav, sizeof(dummyWav));

        segment_start_ms = millis();
    }
}

void finalizeCurrentSegment() {
    if (!current_avi_file || !current_wav_file) return;

    uint32_t idx_start_pos = current_avi_file.position();
    current_avi_file.print("idx1");
    uint32_t idx_size = segment_frame_count * 16;
    current_avi_file.write((const uint8_t*)&idx_size, 4);

    for (int i = 0; i < segment_frame_count; i++) {
        current_avi_file.print("00dc");
        uint32_t flags = 0x10;
        current_avi_file.write((const uint8_t*)&flags, 4);
        current_avi_file.write((const uint8_t*)&segment_offsets[i], 4);
        current_avi_file.write((const uint8_t*)&segment_sizes[i], 4);
    }
    uint32_t file_end_pos = current_avi_file.position();

    current_avi_file.seek(0);
    current_avi_file.print("RIFF"); write4Bytes(current_avi_file, file_end_pos - 8); current_avi_file.print("AVI ");
    current_avi_file.print("LIST"); write4Bytes(current_avi_file, 216); current_avi_file.print("hdrl");
    current_avi_file.print("avih"); write4Bytes(current_avi_file, 56);
    write4Bytes(current_avi_file, 33333); write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 0);
    write4Bytes(current_avi_file, 0x10); write4Bytes(current_avi_file, segment_frame_count);
    write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 1); write4Bytes(current_avi_file, 16384);
    write4Bytes(current_avi_file, 160); write4Bytes(current_avi_file, 120);
    for(int i=0; i<4; i++) write4Bytes(current_avi_file, 0);

    current_avi_file.print("LIST"); write4Bytes(current_avi_file, 116); current_avi_file.print("strl");
    current_avi_file.print("strh"); write4Bytes(current_avi_file, 56); current_avi_file.print("vids"); current_avi_file.print("MJPG");
    write4Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 0);
    write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 1); write4Bytes(current_avi_file, 5);
    write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, segment_frame_count); write4Bytes(current_avi_file, 16384);
    write4Bytes(current_avi_file, 10000); write4Bytes(current_avi_file, 0);
    write2Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 160); write2Bytes(current_avi_file, 120);

    current_avi_file.print("strf");
    write4Bytes(current_avi_file, 40);

    // BITMAPINFOHEADER

    write4Bytes(current_avi_file, 40);     // biSize
    write4Bytes(current_avi_file, 160);    // biWidth
    write4Bytes(current_avi_file, 120);    // biHeight

    write2Bytes(current_avi_file, 1);      // biPlanes
    write2Bytes(current_avi_file, 24);     // biBitCount

    current_avi_file.print("MJPG");        // biCompression

    write4Bytes(
        current_avi_file,
        segment_total_video_size
    );                                      // biSizeImage

    write4Bytes(current_avi_file, 0);      // biXPelsPerMeter
    write4Bytes(current_avi_file, 0);      // biYPelsPerMeter
    write4Bytes(current_avi_file, 0);      // biClrUsed
    write4Bytes(current_avi_file, 0);      // biClrImportant
    write4Bytes(current_avi_file, segment_total_video_size);
    for(int i=0; i<4; i++) write4Bytes(current_avi_file, 0);

    uint32_t current_pos = current_avi_file.position();
    uint32_t junk_size = 2048 - current_pos - 8;
    current_avi_file.print("JUNK"); write4Bytes(current_avi_file, junk_size);
    while (current_avi_file.position() < 2048) { uint8_t zero = 0; current_avi_file.write(&zero, 1); }

    current_avi_file.seek(2052);
    
    uint32_t real_movi_size = idx_start_pos - (2056);
    write4Bytes(current_avi_file, real_movi_size);

    current_avi_file.flush(); current_avi_file.close();

    current_wav_file.seek(0);
    writeWavHeader(current_wav_file, segment_audio_bytes);
    current_wav_file.flush(); current_wav_file.close();
}

// =====================================================
// EVENT TASK
// =====================================================
void eventTask(void *pv) {
    if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
        startNewSegment();
        xSemaphoreGive(sdMutex);
    }

    while(true) {
        if (!eventSaving && (millis() - segment_start_ms >= SEGMENT_DURATION_MS)) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
                segment_changing = true;
                Serial.printf(
                    "FINAL FRAME=%d\n",
                    segment_frame_count
                );
                finalizeCurrentSegment();
                current_slot = (current_slot + 1) % 3; 
                startNewSegment();
                segment_changing = false;
                xSemaphoreGive(sdMutex);
            }
        }

        if(ticDetected) {
            eventSaving = true;

            if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(30000)) == pdTRUE) {
                Serial.println("EVENT LOCK OK");
                ticDetected = false;
                segment_changing = true;
                
                finalizeCurrentSegment();
                manageStorage();

                // ── Update telemetry counters ──
                telemetry_incrementTick();

                struct tm timeinfo;
                char folderName[64];
                if(getLocalTime(&timeinfo, 10)) {
                    strftime(folderName, sizeof(folderName), "/event_%Y%m%d_%H%M%S", &timeinfo);
                } else {
                    sprintf(folderName, "/event_%lu", millis());
                }

                String folder = String(folderName);
                SD.mkdir(folder);

                for(int i = 0; i < 3; i++) {
                    char src_v[32], dst_v[64];
                    char src_a[32], dst_a[64];
                    sprintf(src_v, "/loop/v_%d.avi", i);
                    sprintf(dst_v, "%s/video_part_%d.avi", folder.c_str(), i);
                    sprintf(src_a, "/loop/a_%d.wav", i);
                    sprintf(dst_a, "%s/audio_part_%d.wav", folder.c_str(), i);

                    if (SD.exists(src_v)) SD.rename(src_v, dst_v);
                    if (SD.exists(src_a)) SD.rename(src_a, dst_a);
                }

                if(lastImagePath != "" && SD.exists(lastImagePath)) {
                    SD.rename(lastImagePath, folder + "/thumb.jpg");
                }

                current_slot = 0;
                startNewSegment();
                
                segment_changing = false;
                eventSaving = false;
                xSemaphoreGive(sdMutex);

                // (outside mutex — BLE send doesn't need SD lock)
                if (deviceConnected && pCharacteristic) {
                    unsigned long ts = millis() / 1000;
                    char eventId[64];
                    snprintf(eventId, sizeof(eventId), "evt_%lu", ts);

                    // ── Transfer event files via BLE ──
                    // sendEventBLE will stream all video and audio chunks as a single event
                    sendEventBLE(folder.c_str(), eventId, ts);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// =====================================================
// AUDIO TASK
// =====================================================

void audioTask(void *pv) {

    int16_t samples[256];

    static unsigned long lastAudio = 0;

    while(true) {

        size_t bytesRead = 0;

        i2s_read(
            I2S_NUM_0,
            samples,
            sizeof(samples),
            &bytesRead,
            portMAX_DELAY
        );

        // =====================================
        // AI RING BUFFER UPDATE
        // =====================================

        size_t sampleCount =
            bytesRead /
            sizeof(int16_t);

        for(
            size_t i = 0;
            i < sampleCount;
            i++
        ) {

            audioBuffer[
                audioWriteIndex
            ] =
                samples[i];

            audioWriteIndex =
                (
                    audioWriteIndex + 1
                )
                %
                AUDIO_BUFFER_SIZE;
        }

        // =====================================
        // DEBUG
        // =====================================

        if(
            millis() - lastAudio >
            5000
        ) {

            lastAudio = millis();

            Serial.printf(
                "WRITE IDX=%u SAMPLE0=%d SAMPLE1=%d SAMPLE2=%d\n",
                (unsigned)audioWriteIndex,
                samples[0],
                samples[1],
                samples[2]
            );
        }

        // =====================================
        // EVENT SAVE LOCK
        // =====================================

        if(
            eventSaving ||
            segment_changing
        ) {

            vTaskDelay(
                pdMS_TO_TICKS(1)
            );

            continue;
        }

        // =====================================
        // WAV STREAM BUFFER
        // =====================================

        if(bytesRead > 0) {

            if(
                audioStreamBufIdx +
                bytesRead
                <
                AUDIO_STREAM_BUF_SIZE
            ) {

                memcpy(
                    audioStreamBuf +
                    audioStreamBufIdx,

                    samples,

                    bytesRead
                );

                audioStreamBufIdx +=
                    bytesRead;

            } else {

                if(
                    xSemaphoreTake(
                        sdMutex,
                        pdMS_TO_TICKS(20)
                    ) == pdTRUE
                ) {

                    if(
                        current_wav_file
                        &&
                        !segment_changing
                        &&
                        !eventSaving
                    ) {

                        current_wav_file.write(
                            audioStreamBuf,
                            audioStreamBufIdx
                        );

                        segment_audio_bytes +=
                            audioStreamBufIdx;
                    }

                    audioStreamBufIdx = 0;

                    xSemaphoreGive(
                        sdMutex
                    );
                }
            }
        }
    }
}


// =====================================================
// CAMERA TASK
// =====================================================
void cameraTask(void *pv) {
    while(true) {
        camera_fb_t *fb =
        esp_camera_fb_get();

        if(fb) {

            static uint32_t cnt = 0;

            cnt++;

            if(cnt % 100 == 0) {

                Serial.printf(
                    "FB=%u\n",
                    fb->len
                );
            }
        }
        if(!fb) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if(eventSaving || segment_changing) {
            esp_camera_fb_return(fb);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                Serial.printf(
                    "AVI=%d CHANGE=%d EVENT=%d FRAME=%d\n",
                    current_avi_file ? 1 : 0,
                    segment_changing,
                    eventSaving,
                    segment_frame_count
                );
            if(current_avi_file && !segment_changing && !eventSaving && segment_frame_count < MAX_SEGMENT_FRAMES) {
                uint32_t img_size = fb->len;
                
                segment_offsets[segment_frame_count] = current_avi_file.position() - 2060; 
                segment_sizes[segment_frame_count] = img_size;
                segment_total_video_size += img_size;

                current_avi_file.print("00dc");
                current_avi_file.write((const uint8_t*)&img_size, 4);
                current_avi_file.write(fb->buf, fb->len);
                
                if(img_size % 2 != 0) {
                    uint8_t zero = 0;
                    current_avi_file.write(&zero, 1);
                }
                segment_frame_count++;
                if(
                    segment_frame_count % 50 == 0
                ) {
                    Serial.printf(
                        "SEGMENT AGE=%lu ms FRAME=%d\n",
                        millis() - segment_start_ms,
                        segment_frame_count
                    );

                    Serial.printf(
                        "FRAME=%d\n",
                        segment_frame_count
                    );
                }
            }
            xSemaphoreGive(sdMutex);
        }

        static unsigned long lastSnap = 0;
        if(millis() - lastSnap > 2000) {
            lastSnap = millis();
            if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                File snapFile = SD.open("/buffer/live.jpg", FILE_WRITE);
                if(snapFile) {
                    snapFile.write(fb->buf, fb->len);
                    snapFile.close();
                    lastImagePath = "/buffer/live.jpg";
                }
                xSemaphoreGive(sdMutex);
            }
        }

        esp_camera_fb_return(fb);
        vTaskDelay(pdMS_TO_TICKS(FRAME_INTERVAL_MS));
    }
}

// =====================================================
// SEND IMAGE BLE
// =====================================================
void sendImageBLE(String path) {
    if(!deviceConnected) return;
    File file = SD.open(path, FILE_READ);
    if(!file) return;

    size_t fileSize = file.size();
    uint8_t *imgBuf = (uint8_t*)malloc(fileSize);
    if(!imgBuf) { file.close(); return; }

    file.read(imgBuf, fileSize);
    file.close();

    size_t encodedSize = ((fileSize + 2) / 3) * 4 + 1;
    unsigned char *encoded = (unsigned char*)malloc(encodedSize);
    if(!encoded) { free(imgBuf); return; }

    size_t outLen = 0;
    mbedtls_base64_encode(encoded, encodedSize, &outLen, imgBuf, fileSize);
    free(imgBuf);

    pCharacteristic->setValue("IMG_BEGIN");
    pCharacteristic->notify();
    delay(50);

    size_t offset = 0;
    while(offset < outLen) {
        size_t chunkSize = min((size_t)500, outLen - offset);
        char temp[501];
        memcpy(temp, encoded + offset, chunkSize);
        temp[chunkSize] = '\0';
        pCharacteristic->setValue(temp);
        pCharacteristic->notify();
        offset += chunkSize;
        yield();
        delay(20);
    }

    pCharacteristic->setValue("IMG_END");
    pCharacteristic->notify();
    free(encoded);
}