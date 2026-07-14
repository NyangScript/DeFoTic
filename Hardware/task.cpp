// =====================================================
// task.cpp (안정성 가드 포함 / 시리얼 로그 전면 제거 버전)
// =====================================================

#include "task.h"
#include "config.h"
#include "telemetry.h"
#include "usb_msc.h"

// 30fps × 60초 = 1800프레임 + 여유분
#define MAX_SEGMENT_FRAMES    2200
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

static const int8_t ima_index_table[16] = {
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
};

static const int16_t ima_step_table[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
    12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
};

void encode_ima_adpcm_block(int16_t *pcm, uint8_t *adpcm, int num_samples, int16_t &prev_val, int &prev_idx) {
    if (num_samples <= 0) return;
    
    // Header (4 bytes)
    prev_val = pcm[0]; // first sample is stored as raw 16-bit
    adpcm[0] = prev_val & 0xFF;
    adpcm[1] = (prev_val >> 8) & 0xFF;
    adpcm[2] = prev_idx;
    adpcm[3] = 0;
    
    int out_idx = 4;
    int pcm_idx = 1; 
    
    while (pcm_idx < num_samples) {
        uint8_t byte = 0;
        for (int nibble = 0; nibble < 2; nibble++) {
            if (pcm_idx >= num_samples) break;
            
            int16_t sample = pcm[pcm_idx++];
            int diff = sample - prev_val;
            int step = ima_step_table[prev_idx];
            int code = 0;
            
            if (diff < 0) {
                code = 8;
                diff = -diff;
            }
            
            int delta = step >> 3;
            if (diff >= step) {
                code |= 4;
                diff -= step;
                delta += step;
            }
            step >>= 1;
            if (diff >= step) {
                code |= 2;
                diff -= step;
                delta += step;
            }
            step >>= 1;
            if (diff >= step) {
                code |= 1;
                delta += step;
            }
            
            if (code & 8) {
                prev_val -= delta;
            } else {
                prev_val += delta;
            }
            
            if (prev_val > 32767) prev_val = 32767;
            else if (prev_val < -32768) prev_val = -32768;
            
            prev_idx += ima_index_table[code];
            if (prev_idx < 0) prev_idx = 0;
            else if (prev_idx > 88) prev_idx = 88;
            
            if (nibble == 0) byte = code;
            else byte |= (code << 4);
        }
        adpcm[out_idx++] = byte;
    }
}

void writeWavHeader(File &file, uint32_t dataSize) {
    uint32_t sampleRate = SAMPLE_RATE;
    uint16_t numChannels = 1;
    uint16_t blockAlign = ADPCM_BLOCK_SIZE;
    uint32_t byteRate = sampleRate * blockAlign / ADPCM_SAMPLES_PER_BLOCK;
    uint16_t bps = 4;
    
    file.write((const uint8_t*)"RIFF", 4);
    uint32_t fileSize = dataSize + 52; 
    file.write((const uint8_t*)&fileSize, 4);
    file.write((const uint8_t*)"WAVE", 4);
    
    file.write((const uint8_t*)"fmt ", 4);
    uint32_t fmtSize = 20; 
    file.write((const uint8_t*)&fmtSize, 4);
    uint16_t fmt = 0x0011; // IMA ADPCM
    file.write((const uint8_t*)&fmt, 2);
    file.write((const uint8_t*)&numChannels, 2);
    file.write((const uint8_t*)&sampleRate, 4);
    file.write((const uint8_t*)&byteRate, 4);
    file.write((const uint8_t*)&blockAlign, 2);
    file.write((const uint8_t*)&bps, 2);
    
    uint16_t cbSize = 2;
    file.write((const uint8_t*)&cbSize, 2);
    uint16_t samplesPerBlock = ADPCM_SAMPLES_PER_BLOCK;
    file.write((const uint8_t*)&samplesPerBlock, 2);
    
    file.write((const uint8_t*)"fact", 4);
    uint32_t factSize = 4;
    file.write((const uint8_t*)&factSize, 4);
    uint32_t numSamples = (dataSize / blockAlign) * samplesPerBlock;
    file.write((const uint8_t*)&numSamples, 4);
    
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

    // 이벤트 폴더는 /DEFOTIC 아래 "evt_YYYYMMDD_HHMMSS" 형식 —
    // 문자열 오름차순 = 시간순. 첫 번째로 찾은 폴더를 초기값으로 삼아
    // 가장 오래된 폴더를 선정한다.
    File root = SD.open("/DEFOTIC");
    if (!root) return;

    String oldestFolder = "";
    String oldestFolderName = "";

    File entry = root.openNextFile();
    while (entry) {
        if (entry.isDirectory()) {
            String name = String(entry.name());
            if (name.startsWith("evt_")) {
                if (oldestFolderName == "" || name < oldestFolderName) {
                    oldestFolderName = name;
                    oldestFolder = "/DEFOTIC/" + name;
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

        uint8_t dummyWav[60] = {0};
        current_wav_file.write(dummyWav, sizeof(dummyWav));

        segment_start_ms = millis();
    }
}

void finalizeCurrentSegment() {
    if (!current_avi_file || !current_wav_file) return;

    // 아직 SD에 쓰지 못한 오디오 스트림 버퍼를 플러시
    // (세그먼트 말미 최대 ~0.5초 오디오 손실 방지)
    if (audioStreamBufIdx > 0) {
        current_wav_file.write(audioStreamBuf, audioStreamBufIdx);
        segment_audio_bytes += audioStreamBufIdx;
        audioStreamBufIdx = 0;
    }

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

    // ── 실측 프레임레이트 계산 ──
    // XCLK/SD 상태에 따라 실효 fps가 변하므로, 세그먼트의 실제 경과 시간과
    // 프레임 수로 재생 속도를 계산해 avih/strh에 동일하게 기록한다.
    unsigned long elapsedMs = millis() - segment_start_ms;
    uint32_t usPerFrame = 200000;  // fallback: 5fps
    uint32_t fpsRate = 5;
    if (segment_frame_count > 0 && elapsedMs > 0) {
        usPerFrame = (uint32_t)(((uint64_t)elapsedMs * 1000ULL) / (uint32_t)segment_frame_count);
        if (usPerFrame < 10000) usPerFrame = 10000;  // 100fps 상한 방어
        fpsRate = (uint32_t)(((uint64_t)segment_frame_count * 1000ULL + elapsedMs / 2) / elapsedMs);
        if (fpsRate == 0) fpsRate = 1;
    }

    current_avi_file.seek(0);
    current_avi_file.print("RIFF"); write4Bytes(current_avi_file, file_end_pos - 8); current_avi_file.print("AVI ");
    // hdrl LIST 크기 = 'hdrl'(4) + avih 청크(64) + strl LIST(124) = 192
    current_avi_file.print("LIST"); write4Bytes(current_avi_file, 192); current_avi_file.print("hdrl");
    current_avi_file.print("avih"); write4Bytes(current_avi_file, 56);
    write4Bytes(current_avi_file, usPerFrame); write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 0);
    write4Bytes(current_avi_file, 0x10); write4Bytes(current_avi_file, segment_frame_count);
    write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 1); write4Bytes(current_avi_file, 16384);
    write4Bytes(current_avi_file, 160); write4Bytes(current_avi_file, 120);
    for(int i=0; i<4; i++) write4Bytes(current_avi_file, 0);

    current_avi_file.print("LIST"); write4Bytes(current_avi_file, 116); current_avi_file.print("strl");
    current_avi_file.print("strh"); write4Bytes(current_avi_file, 56); current_avi_file.print("vids"); current_avi_file.print("MJPG");
    write4Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 0); write2Bytes(current_avi_file, 0);
    // dwScale=1, dwRate=실측 fps (avih의 usPerFrame과 일치)
    write4Bytes(current_avi_file, 0); write4Bytes(current_avi_file, 1); write4Bytes(current_avi_file, fpsRate);
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
    // strf 선언 크기(40바이트)까지만 기록 — 청크 경계를 넘는 잉여 데이터 금지
    // (RIFF 구조를 깨뜨려 엄격한 파서/디코더에서 재생 실패 원인이 됨)

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
        // ── USB MSC 세션 처리 ──
        // 스마트폰이 C-to-C로 연결되면 SD를 USB 드라이브로 서비스해야 하므로,
        // 열린 세그먼트 파일을 안전하게 닫고 녹화를 일시정지한다.
        static bool mscPaused = false;
        if (mscActive && !mscPaused) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
                segment_changing = true;
                finalizeCurrentSegment();
                segment_changing = false;
                mscPaused = true;
                xSemaphoreGive(sdMutex);
                Serial.println("[USB] Recording paused for MSC session");
            }
        } else if (!mscActive && mscPaused) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
                current_slot = 0;
                startNewSegment();
                mscPaused = false;
                xSemaphoreGive(sdMutex);
                Serial.println("[USB] Recording resumed");
            }
        }
        if (mscPaused) {
            vTaskDelay(pdMS_TO_TICKS(200));
            continue;
        }

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

                // eventId는 SD 파일명과 BLE 메타데이터에 공통 사용된다.
                // 앱은 C-to-C Import 시 파일명에서 이 eventId를 파싱해 매핑한다.
                struct tm timeinfo;
                char eventId[32];
                if(getLocalTime(&timeinfo, 10)) {
                    strftime(eventId, sizeof(eventId), "evt_%Y%m%d_%H%M%S", &timeinfo);
                } else {
                    sprintf(eventId, "evt_%lu", millis());
                }
                unsigned long eventEpoch = (unsigned long)time(NULL);

                // Android SAF는 드라이브 루트 선택을 막을 수 있으므로
                // 이벤트는 항상 선택 가능한 /DEFOTIC 폴더 아래에 저장한다.
                if (!SD.exists("/DEFOTIC")) SD.mkdir("/DEFOTIC");
                String folder = "/DEFOTIC/" + String(eventId);
                SD.mkdir(folder);

                // 순환 슬롯을 시간순으로 재배열해 저장:
                // part_0 = 가장 오래된 세그먼트, part_2 = 최신(틱 발생 순간 포함).
                // 앱은 최고 파트 번호를 대표 미디어로 사용하므로 이 순서가 필수.
                for(int k = 0; k < 3; k++) {
                    int src = (current_slot + 1 + k) % 3;
                    char src_v[32], dst_v[80];
                    char src_a[32], dst_a[80];
                    sprintf(src_v, "/loop/v_%d.avi", src);
                    sprintf(dst_v, "%s/%s_video_%d.avi", folder.c_str(), eventId, k);
                    sprintf(src_a, "/loop/a_%d.wav", src);
                    sprintf(dst_a, "%s/%s_audio_%d.wav", folder.c_str(), eventId, k);

                    if (SD.exists(src_v)) SD.rename(src_v, dst_v);
                    if (SD.exists(src_a)) SD.rename(src_a, dst_a);
                }

                if(lastImagePath != "" && SD.exists(lastImagePath)) {
                    SD.rename(lastImagePath, folder + "/" + String(eventId) + "_thumb.jpg");
                }

                current_slot = 0;
                startNewSegment();

                segment_changing = false;
                eventSaving = false;
                xSemaphoreGive(sdMutex);

                // (outside mutex — BLE send doesn't need SD lock)
                // 미디어는 SD에만 저장하고, 메타데이터 패킷 1개만 실시간 전송한다.
                telemetry_sendTicEvent(eventId, eventEpoch, lastConfidence);
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
    int16_t pcmBlockBuffer[ADPCM_SAMPLES_PER_BLOCK];
    int pcmBlockIdx = 0;
    
    int16_t adpcmPrevVal = 0;
    int adpcmPrevIdx = 0;
    
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

        size_t sampleCount = bytesRead / sizeof(int16_t);

        // Update Ring Buffer for pre-recording AI
        // ⚠️ 여기서 aiMux 크리티컬 섹션을 잡으면 안 된다:
        //   aiTask가 추론 윈도우 전체를 긴 크리티컬 섹션으로 복사하는 동안
        //   audioTask가 스핀 대기 → i2s_read 지연 → I2S DMA 오버런 →
        //   오디오 스트림 갭 → AI 입력 손상으로 틱 인식이 실패한다.
        //   복사 중 극소수 샘플의 tearing은 추론에 영향이 없으므로 무락으로 쓴다.
        for(size_t i = 0; i < sampleCount; i++) {
            audioBuffer[audioWriteIndex] = samples[i];
            audioWriteIndex = (audioWriteIndex + 1) % AUDIO_BUFFER_SIZE;
        }

        if(millis() - lastAudio > 5000) {
            lastAudio = millis();
            Serial.printf("WRITE IDX=%u SAMPLE0=%d SAMPLE1=%d\n", (unsigned)audioWriteIndex, samples[0], samples[1]);
        }

        if(eventSaving || segment_changing || mscActive) {
            vTaskDelay(pdMS_TO_TICKS(1));
            continue;
        }

        if(bytesRead > 0) {
            for(size_t i = 0; i < sampleCount; i++) {
                pcmBlockBuffer[pcmBlockIdx++] = samples[i];
                
                if (pcmBlockIdx >= ADPCM_SAMPLES_PER_BLOCK) {
                    uint8_t adpcmBlock[ADPCM_BLOCK_SIZE];
                    encode_ima_adpcm_block(pcmBlockBuffer, adpcmBlock, ADPCM_SAMPLES_PER_BLOCK, adpcmPrevVal, adpcmPrevIdx);
                    
                    if(audioStreamBufIdx + ADPCM_BLOCK_SIZE <= AUDIO_STREAM_BUF_SIZE) {
                        memcpy(audioStreamBuf + audioStreamBufIdx, adpcmBlock, ADPCM_BLOCK_SIZE);
                        audioStreamBufIdx += ADPCM_BLOCK_SIZE;
                    }
                    
                    if (audioStreamBufIdx + ADPCM_BLOCK_SIZE > AUDIO_STREAM_BUF_SIZE) {
                        if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
                            if(current_wav_file && !segment_changing && !eventSaving && !mscActive) {
                                current_wav_file.write(audioStreamBuf, audioStreamBufIdx);
                                segment_audio_bytes += audioStreamBufIdx;
                            }
                            audioStreamBufIdx = 0;
                            xSemaphoreGive(sdMutex);
                        }
                    }
                    pcmBlockIdx = 0;
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
        // 프레임 간격을 정확히 유지하기 위해 루프 소요 시간을 측정해 보상한다.
        // (고정 delay 방식은 캡처+SD 쓰기 시간만큼 실효 fps가 깎임)
        unsigned long loopStart = millis();

        camera_fb_t *fb =
        esp_camera_fb_get();

        if(!fb) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if(eventSaving || segment_changing || mscActive) {
            esp_camera_fb_return(fb);
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        // NOTE: SD 쓰기 크리티컬 섹션 내부에는 시리얼 출력을 두지 않는다.
        // (매 프레임 UART 출력은 카메라/SD 기록 성능을 직접 저하시킴)
        if(xSemaphoreTake(sdMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
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
                    segment_frame_count % 100 == 0
                ) {
                    Serial.printf(
                        "SEGMENT AGE=%lu ms FRAME=%d\n",
                        millis() - segment_start_ms,
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

        unsigned long spent = millis() - loopStart;
        unsigned long waitMs = (spent < FRAME_INTERVAL_MS) ? (FRAME_INTERVAL_MS - spent) : 1;
        vTaskDelay(pdMS_TO_TICKS(waitMs));
    }
}

