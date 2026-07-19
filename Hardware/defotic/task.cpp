// =====================================================
// task.cpp — 녹화·저장·오디오 파이프라인 태스크
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
            
            // 예측기는 int32로 계산 후 클램프한다:
            //   int16_t에 직접 ±delta 하면 대입 순간 랩(wrap)되어 뒤의
            //   클램프가 도달 불능이 된다. 마이크 포화급 큰 소리(틱의
            //   핵심 순간!)에서 인코더 예측기가 랩되면 표준 디코더는
            //   32767로 클램프해 서로 분기 → 해당 블록 잔여 구간이
            //   풀스케일 잡음으로 파손된다.
            int predictor = prev_val;
            if (code & 8) {
                predictor -= delta;
            } else {
                predictor += delta;
            }

            if (predictor > 32767) predictor = 32767;
            else if (predictor < -32768) predictor = -32768;
            prev_val = (int16_t)predictor;
            
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
// 붕괴점 2개를 함께 방어한다:
//  [A] 호출당 최고령 1폴더만 삭제하는 방식은 '소형 폴더 다수 축적 후
//      대형(3슬롯 승격 ~17MB) 이벤트' 패턴에서 유입>삭제 적자가 누적되어
//      SD가 0바이트까지 소진된다. → 임계 해소까지 루프 삭제(회당 상한).
//  [B] FAT32 디렉토리 엔트리 상한(65,536 ≈ evt 폴더 21,800개)이 대용량
//      카드에서 여유 공간 임계보다 먼저 걸려 mkdir이 침묵 실패한다.
//      → 폴더 수 상한을 별도 임계로 관리(최근 것 보존, 최고령부터 삭제).
//  주의: 이 함수는 '정리'만 한다 — 새 이벤트의 저장/감지를 막는
//  게이트가 아니다(감지 차단 금지 원칙, ai_task.cpp 참조).
#define MAX_EVENT_FOLDERS     2000   // FAT32 엔트리 상한의 ~1/10, 여유 확보
#define MAX_DELETES_PER_CALL  16     // sdMutex 점유 시간 상한 (이벤트 저장 지연 방지)

void manageStorage() {
    uint64_t totalBytes = SD.totalBytes();
    uint64_t usedBytes = SD.usedBytes();
    uint64_t freeBytes = totalBytes - usedBytes;

    // 이벤트 폴더는 /DEFOTIC 아래 "evt_YYYYMMDD_HHMMSS" 형식 —
    // 문자열 오름차순 = 시간순. 단일 순회로 폴더 수와 최고령 K개를
    // 동시 수집한다: 삭제 1건마다 디렉토리 전체를 재스캔하면 최악
    // 16회 순회로 sdMutex 점유가 수 초로 늘어나 audioWriter 랙
    // 상한(2s)을 넘긴다. 임계 미달이면 삭제 없이 즉시 반환 =
    // 평시 비용은 순회 1회 그대로다.
    File root = SD.open("/DEFOTIC");
    if (!root) return;

    String oldest[MAX_DELETES_PER_CALL];
    int oldestCount = 0;
    int folderCount = 0;

    File entry = root.openNextFile();
    while (entry) {
        if (entry.isDirectory()) {
            String name = String(entry.name());
            if (name.startsWith("evt_")) {
                folderCount++;
                // 최고령 K개 유지 (삽입 정렬 — K=16이라 비용 미미)
                int pos = oldestCount;
                while (pos > 0 && name < oldest[pos - 1]) pos--;
                if (pos < MAX_DELETES_PER_CALL) {
                    int last = (oldestCount < MAX_DELETES_PER_CALL)
                                   ? oldestCount
                                   : MAX_DELETES_PER_CALL - 1;
                    for (int m = last; m > pos; m--) oldest[m] = oldest[m - 1];
                    oldest[pos] = name;
                    if (oldestCount < MAX_DELETES_PER_CALL) oldestCount++;
                }
            }
        }
        entry.close();
        entry = root.openNextFile();
    }
    root.close();

    for (int i = 0; i < oldestCount; i++) {
        bool overSpace = freeBytes <= SD_FREE_SPACE_LIMIT;
        bool overCount = (folderCount - i) > MAX_EVENT_FOLDERS;
        if (!overSpace && !overCount) return;

        deleteFolderRecursive("/DEFOTIC/" + oldest[i]);

        // 여유 공간 재판독 — f_getfree 결과는 FATFS가 캐시하므로
        // 최초 호출 이후에는 저렴하다 (삭제분이 증분 반영됨)
        totalBytes = SD.totalBytes();
        usedBytes = SD.usedBytes();
        freeBytes = totalBytes - usedBytes;
    }
}

// =====================================================
// SEGMENT CONTROL
// =====================================================
void startNewSegment() {
    if (!segment_offsets) segment_offsets = (uint32_t*)ps_malloc(MAX_SEGMENT_FRAMES * sizeof(uint32_t));
    if (!segment_sizes) segment_sizes = (uint32_t*)ps_malloc(MAX_SEGMENT_FRAMES * sizeof(uint32_t));

    // PSRAM 할당 실패 시 세그먼트를 열지 않는다 — cameraTask가 NULL
    // 인덱스 배열에 기록하며 크래시하는 경로 차단. current_avi_file이
    // 열리지 않으므로 모든 기록 경로의 기존 가드가 자연히 쓰기를 막는다.
    if (!segment_offsets || !segment_sizes) {
        Serial.println("[SEG] index alloc FAIL — segment skipped");
        return;
    }

    segment_frame_count = 0;
    segment_total_video_size = 0;
    segment_audio_bytes = 0;
    audioStreamBufIdx = 0;

    if (!SD.exists("/loop")) SD.mkdir("/loop");

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

    // 한쪽만 열렸으면 닫는다 — 반쪽 세그먼트(영상만/음성만)를 만들지
    // 않고, 다음 순회(eventTask 루프)에서 통째로 재시도한다.
    if (current_avi_file && !current_wav_file) {
        current_avi_file.close();
    } else if (!current_avi_file && current_wav_file) {
        current_wav_file.close();
    }

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
// SD OWNERSHIP — REMOUNT AFTER HOST SESSION
// =====================================================
// 호스트(폰/PC)는 세션 중 FAT를 수정한다 (Windows: dirty bit,
// System Volume Information / Android: 미디어 스캐너 등).
// 펌웨어가 세션 전의 스테일 FatFS 캐시로 다시 쓰면 클러스터
// 크로스링크로 FAT가 손상되므로, 소유권 복귀 시 반드시 FS를
// 통째로 재마운트해 디스크에서 재판독한다.
// 호출자는 sdMutex를 잡은 상태여야 한다.
bool sdRemountFresh() {
    SD.end();

    for (int attempt = 1; attempt <= 3; attempt++) {
        // 시도 1: 20MHz / 시도 2: 10MHz / 시도 3: 기본 4MHz 폴백
        // (클럭 사다리 근거는 config.h 참조)
        bool mounted = (attempt == 1)
            ? SD.begin(SD_CS, SPI, SD_SPI_HZ)
            : (attempt == 2)
                ? SD.begin(SD_CS, SPI, SD_SPI_HZ_MID)
                : SD.begin(SD_CS);
        if (mounted) {
            sdFsReady = true;
            Serial.printf("[SD] Remounted fresh (attempt %d)\n", attempt);
            return true;
        }
        Serial.printf("[SD] Remount failed (attempt %d)\n", attempt);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    // 실패: sdFsReady=false 유지 → 모든 FS 쓰기 경로 차단.
    // 외곽 루프(eventTask 200ms 주기)가 계속 재시도하므로 무한 루프 없음.
    sdFsReady = false;
    return false;
}

// =====================================================
// EVENT TASK
// =====================================================
void eventTask(void *pv) {
    while(true) {
        // ── USB MSC 처리 (동시 접근 구조 — 마운트 중에도 녹화 지속) ──
        // 호스트가 드라이브를 마운트한 동안에도 녹화·이벤트 저장은 계속된다.
        // USB 세션(mscActive)은 순수 관측값이며 여기서 하는 일은 2가지뿐:
        //  ① 세션 종료(실분리) 에지에서 1회 재마운트 — 호스트가 마운트 중
        //     남긴 쓰기(fsck/dirty bit/LOST.DIR)를 재판독해 FAT 캐시 갱신
        //     (녹화 공백은 1~2초).
        //  ② 부팅/재마운트 실패 구간(notRecording)의 감지는 메타 전용 소비.
        //
        // notRecording=true로 시작하는 이유: 최초 세그먼트 시작도 아래
        // 기동 경로(재마운트 → startNewSegment)로 통일한다 — 부팅 전
        // 호스트(PC 등)가 썼더라도 항상 fresh한 FAT 뷰에서 시작한다.
        static bool notRecording = true;

        usbMscTick();   // SUSPEND 유예 만료(실분리) 판정

        // ① 세션 종료 에지 → 안전 재마운트 (녹화 중일 때만 — 기동 전이면
        //    아래 기동 경로가 어차피 fresh 마운트로 시작한다)
        // 에지는 두 겹으로 보존한다:
        //  · 종료 시점에 usb_msc가 래치를 세우고 여기서 소비한다 — 상태를
        //    주기 샘플링하면 두 관측 사이에 시작·종료된 짧은 세션을 통째로
        //    놓친다.
        //  · 소비한 에지는 재마운트가 실제로 수행될 때까지 유지한다 — 에지
        //    발생 순간 writer/camera가 sdMutex를 쥔 채 SD 내부 GC로 수 초
        //    스톨하면 5s take가 실패할 수 있고, 그 자리에서 버리면 동시 접근
        //    구조의 핵심 안전장치가 침묵 스킵된다 (50ms 주기로 재시도).
        static bool pendingSessionEndRemount = false;
        if (usbMscConsumeSessionEnd()) pendingSessionEndRemount = true;
        if (pendingSessionEndRemount && !notRecording) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
                segment_changing = true;
                finalizeCurrentSegment();
                sdFsReady = false;
                if (sdRemountFresh()) {
                    // 슬롯은 세션 중에도 계속 기록되어 신선하다 —
                    // 삭제하지 않고 정상 회전만 한다.
                    current_slot = (current_slot + 1) % 3;
                    startNewSegment();
                    Serial.println("[USB] FAT view refreshed after host session");
                } else {
                    // 재마운트 실패 → 기동 경로가 200ms 주기로 재시도
                    // (기동 경로 자체가 fresh 마운트이므로 래치 목적 달성)
                    notRecording = true;
                }
                pendingSessionEndRemount = false;
                segment_changing = false;
                xSemaphoreGive(sdMutex);
            }
            // take 실패 시 래치 유지 → 다음 루프에서 재시도
        }

        // ② 기동/재마운트 실패 복구 경로 — fresh FAT 뷰에서 녹화 시작.
        //    호스트 세션 여부와 무관하게 즉시 시작한다 (동시 접근 구조).
        if (notRecording) {
            if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(5000)) == pdTRUE) {
                if (sdRemountFresh()) {
                    // 잔존 슬롯 무효화 — 이전 부팅의 낡은 세그먼트가 현재
                    // 시각 이벤트의 맥락으로 승격되는 것을 차단.
                    // startNewSegment '이전'에 0..2 전부 삭제(무가정).
                    for (int k = 0; k < 3; k++) {
                        char stale[32];
                        sprintf(stale, "/loop/v_%d.avi", k);
                        if (SD.exists(stale)) SD.remove(stale);
                        sprintf(stale, "/loop/a_%d.wav", k);
                        if (SD.exists(stale)) SD.remove(stale);
                    }
                    current_slot = 0;
                    startNewSegment();
                    notRecording = false;
                    // 기동 자체가 fresh 마운트이므로 세션 종료 래치의 목적
                    // (호스트 잔여 쓰기 재판독)은 이미 달성됐다 — 소비하지
                    // 않으면 다음 순회에서 방금 연 세그먼트를 불필요하게
                    // finalize+재마운트해 1~2초 녹화 공백이 생긴다.
                    pendingSessionEndRemount = false;
                    Serial.println("[USB] Recording started (v5 concurrent)");
                }
                // 실패 시 notRecording 유지 → 200ms 후 재시도
                xSemaphoreGive(sdMutex);
            }
        }
        if (notRecording) {
            // ── 스테일 틱 래치 방지 ──
            // SD를 쓸 수 없는 구간(재마운트 실패 반복)에 감지된 틱을
            // 방치하면 ticDetected=true가 영구 잔류해 aiTask의 !ticDetected
            // 가드가 이후 모든 감지를 봉쇄한다. 미디어는 저장할 수 없어도
            // 감지 자체는 여기서 소비한다 — 카운트를 올리고 BLE 메타
            // (media:false)만 전송해 앱이 빈도(CBIT 핵심 지표)를 놓치지
            // 않게 한다. 앱은 이를 완결 상태('기록됨', no_media)로 표시한다.
            if (ticDetected) {
                ticDetected = false;
                telemetry_incrementTick();

                struct tm timeinfo;
                char eventId[32];
                if (getLocalTime(&timeinfo, 10)) {
                    strftime(eventId, sizeof(eventId), "evt_%Y%m%d_%H%M%S", &timeinfo);
                } else {
                    sprintf(eventId, "evt_%lu_%03u", millis(),
                            (unsigned)(esp_random() % 1000));
                }
                telemetry_sendTicEvent(eventId, (unsigned long)time(NULL), lastConfidence, false);
            }
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
                    // 폴백 id에 난수 접미사 — millis()는 재부팅마다 0부터
                    // 재시작해 세션 간 동일 id가 재생성될 수 있고, 앱은
                    // 동일 id 이벤트를 dedupe로 무시한다(레코드 병합/미디어
                    // 상호 덮어쓰기 경로). 앱 파싱 패턴 evt_\d+(_\d+)? 호환.
                    sprintf(eventId, "evt_%lu_%03u", millis(),
                            (unsigned)(esp_random() % 1000));
                }
                unsigned long eventEpoch = (unsigned long)time(NULL);

                // Android SAF는 드라이브 루트 선택을 막을 수 있으므로
                // 이벤트는 항상 선택 가능한 /DEFOTIC 폴더 아래에 저장한다.
                // mkdir 반환값 검사: FAT32 디렉토리 엔트리 상한 등으로
                // mkdir이 실패하면 정리(manageStorage) 후 1회 재시도하고,
                // 그래도 실패하면 미디어 승격을 포기하되 BLE 메타(media:false)는
                // 전송한다 — 감지 사실 자체는 절대 침묵 소실시키지 않는다.
                if (!SD.exists("/DEFOTIC")) SD.mkdir("/DEFOTIC");
                String folder = "/DEFOTIC/" + String(eventId);
                bool folderOk = SD.mkdir(folder);
                if (!folderOk) {
                    Serial.println("[EVT] mkdir failed — forcing storage cleanup");
                    manageStorage();
                    folderOk = SD.mkdir(folder);
                }

                bool mediaSaved = false;
                if (folderOk) {
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

                        // ── 빈 세그먼트는 이벤트로 승격하지 않는다 ──
                        // SD 쓰기 실패기에는 헤더만 있는 0초 AVI/무음 WAV가
                        // 생길 수 있고, 이를 이벤트 폴더로 옮기면 앱 가져오기·
                        // Gemini 분석까지 실패한다. 헤더보다 큰 실데이터가
                        // 있는 파트만 옮기고, 빈 파트는 버린다.
                        // rename 실패 시에도 소스를 지운다:
                        // 실패 잔존 파일은 다음 이벤트의 승격 루프에서 '이전
                        // 이벤트 창의 미디어'가 잘못된 part 순서로 편입되는
                        // 링 나이 불변식 파괴를 만든다 — 유실이 오염보다 낫다.
                        if (SD.exists(src_v)) {
                            File chk = SD.open(src_v);
                            size_t sz = chk ? chk.size() : 0;
                            if (chk) chk.close();
                            if (sz > MIN_EVENT_MEDIA_BYTES) {
                                if (SD.rename(src_v, dst_v)) mediaSaved = true;
                                else SD.remove(src_v);
                            } else SD.remove(src_v);
                        }
                        if (SD.exists(src_a)) {
                            File chk = SD.open(src_a);
                            size_t sz = chk ? chk.size() : 0;
                            if (chk) chk.close();
                            if (sz > MIN_EVENT_MEDIA_BYTES) {
                                if (SD.rename(src_a, dst_a)) mediaSaved = true;
                                else SD.remove(src_a);
                            } else SD.remove(src_a);
                        }
                    }

                    // ── 썸네일: PSRAM 최신 스냅샷을 이벤트 폴더에 직접 기록 ──
                    // (구조는 cameraTask 스냅샷 주석 참조)
                    // 락 순서: sdMutex(보유 중) → snapMutex 단방향 고정.
                    // 스테이징에 복사한 뒤 즉시 snapMutex를 놓아, SD 쓰기
                    // 수십 ms 동안 cameraTask의 스냅샷 갱신을 막지 않는다.
                    // mediaSaved일 때만 기록한다: 파트 승격이
                    //   전부 실패한 이벤트에 썸네일만 남기면 BLE media:false
                    //   (앱은 동기화 안 함)와 SD 실상태가 어긋나고, 빈 폴더가
                    //   FAT 엔트리 예산을 잠식한다 — 실패 시 폴더째 회수.
                    if (mediaSaved && snapshotBuf && snapshotStaging) {
                        size_t thumbLen = 0;
                        if (xSemaphoreTake(snapMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                            if (snapshotLen > 0) {
                                memcpy(snapshotStaging, snapshotBuf, snapshotLen);
                                thumbLen = snapshotLen;
                            }
                            xSemaphoreGive(snapMutex);
                        }
                        if (thumbLen > 0) {
                            String thumbPath = folder + "/" + String(eventId) + "_thumb.jpg";
                            File tf = SD.open(thumbPath, FILE_WRITE);
                            if (tf) {
                                size_t written = tf.write(snapshotStaging, thumbLen);
                                tf.close();
                                // 부분 쓰기(SD 만석 등)로 잘린 JPEG는 앱
                                // 렌더 실패만 만든다 — 남기지 않는다
                                if (written < thumbLen) SD.remove(thumbPath);
                            }
                        }
                    }
                    if (!mediaSaved) {
                        SD.rmdir(folder);   // 빈 폴더 회수 (파트 0건 승격)
                    }
                } else {
                    Serial.println("[EVT] folder create failed — meta-only event");
                }

                current_slot = 0;
                startNewSegment();

                segment_changing = false;
                eventSaving = false;
                xSemaphoreGive(sdMutex);

                // (outside mutex — BLE send doesn't need SD lock)
                // 미디어는 SD에만 저장하고, 메타데이터 패킷 1개만 실시간 전송한다.
                // media 플래그로 앱이 '미디어 대기'와 '메타 전용'을 구분한다.
                telemetry_sendTicEvent(eventId, eventEpoch, lastConfidence, mediaSaved);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// =====================================================
// AUDIO TASK (생산자) — I2S 소유자
// =====================================================
// 설계 원칙:
//
// [1] 이 태스크는 I2S 소비만 한다 — SD/인코딩 없음.
//     i2s_read와 같은 루프에서 ADPCM 인코딩 + sdMutex 대기 + SD 쓰기를
//     하면, SD 카드가 내부 GC로 수백 ms를 예고 없이 멈추는 동안 DMA
//     백로그(8×512샘플 ≈ 256ms)가 넘쳐 ESP32-S3 I2S RX가 오버런
//     상태에서 수신을 멈춘다. SD 기록은 audioWriterTask로 분리해
//     어떤 파일시스템 스톨도 i2s_read 주기에 영향을 못 주게 한다.
//
// [2] I2S 수명주기(최초 설치·복구·재설치)를 이 태스크가 전담한다.
//     esp_intr_free는 인터럽트를 할당한 코어에서만 해제 가능(IDF 제약) —
//     setup()(core 1)에서 설치한 드라이버를 이 태스크(core 0)가
//     uninstall하면 해제가 실패해 재설치가 영구 불능이 된다.
//
// [3] 복구는 2단 사다리: 소프트(stop → zero → start)를 먼저 시도한다.
//     S3의 RX 오버런 스톨은 대부분 재기동만으로 회복되며, 드라이버
//     재설치(메모리 해제/재할당)보다 실패 지점이 훨씬 적다.
void audioTask(void *pv) {
    int16_t samples[256];

    // I2S 무데이터 연속 카운터 — DMA/드라이버가 죽었을 때 자가 복구용
    int emptyReads = 0;
    // 소프트 복구 연속 실패 횟수 — 2회 실패 시 드라이버 재설치로 격상
    int softRecoveries = 0;
    // 설치/복구 직후 첫 정상 수신 1회 로그 — 복구 성공 여부 판독용
    bool firstDataLogged = false;

    // ── 오디오 컨디셔닝 상태 (config.h AUDIO_DC_BLOCK/AUDIO_GAIN_SHIFT) ──
    // DC-블록: y[n] = x[n] - x[n-1] + a·y[n-1], a=255/256 (fc≈10Hz@16kHz).
    // 필터 상태는 Q8(×256) 고정소수점으로 유지한다:
    //   정수 상태에서 a·y를 y-(y>>8)로 근사하면 y∈[1,255] 구간에서 감쇠항이
    //   정확히 0이 되어(극점=1.0) 양(+)의 잔류 DC가 영구 동결 — 상수 입력
    //   (PDM 라인 사망)에서 출력이 0으로 수렴하지 않아 micState 'silent'
    //   판정(peak==0)이 불능이 된다. Q8 상태는 잔류를 1 LSB 미만까지
    //   감쇠시켜 출력이 정확히 0에 도달한다. (최대 |yQ8| ≈ 256×65,791
    //   ≈ 1.7e7 — int32 여유 충분)
    int32_t dcPrevIn = 0;
    int32_t dcPrevOutQ8 = 0;

    // ── 5초 주기 진단 통계 ──
    // dc(평균)·rms·peak·clip%를 시리얼로 노출해 게인/DC 상태를 실측한다.
    int64_t statSum = 0;      // 컨디셔닝 '전' 원시 합 (DC 추정)
    uint64_t statSqSum = 0;   // 컨디셔닝 '후' 제곱합 (RMS)
    int32_t statPeakRaw = 0;  // 원시 피크
    uint32_t statCount = 0;
    uint32_t statClipped = 0; // 게인 포화 샘플 수
    unsigned long lastStatLog = 0;

    bool installed = initI2S();

    while(true) {
        if (!installed) {
            // 설치 실패 상태 — 1초 간격 재시도 (busy-spin 금지)
            vTaskDelay(pdMS_TO_TICKS(1000));
            installed = i2sReinstall();
            continue;
        }

        size_t bytesRead = 0;

        // 무한 대기 금지: 채널이 죽으면 태스크가 영구 블록되어
        //   micPeak/micState 계측까지 얼어붙는다(고장 은폐).
        //   i2s_channel_read는 요청량을 채우면 ESP_OK, 타임아웃이면
        //   ESP_ERR_TIMEOUT을 반환하며 부분 수신량은 bytesRead에 담긴다.
        esp_err_t rdErr = i2sRead(
            samples,
            sizeof(samples),
            &bytesRead,
            200
        );

        if (bytesRead == 0) {
            (void)rdErr;   // 타임아웃/상태 오류 공히 무데이터로 취급
            // 즉시 에러 반환(드라이버 이상) 시 busy-spin으로 core 0을
            // 태우지 않도록 최소 지연 보장
            vTaskDelay(pdMS_TO_TICKS(20));
            if (++emptyReads >= 25) {   // 최소 5초 연속 무데이터
                emptyReads = 0;
                firstDataLogged = false;
                if (softRecoveries < 2) {
                    softRecoveries++;
                    Serial.printf("[I2S] 5s no data — soft restart (%d/2)\n", softRecoveries);
                    i2sSoftRestart();
                } else {
                    softRecoveries = 0;
                    Serial.println("[I2S] soft restart failed — reinstalling driver");
                    installed = i2sReinstall();
                }
            }
            continue;
        }
        emptyReads = 0;
        softRecoveries = 0;
        if (!firstDataLogged) {
            firstDataLogged = true;
            Serial.printf("[I2S] first data OK (%u bytes)\n", (unsigned)bytesRead);
        }

        size_t sampleCount = bytesRead / sizeof(int16_t);

        // ── 오디오 컨디셔닝: DC-블록 → 게인(포화) — 인입 단일 지점 ──
        // 링 버퍼(AI)·WAV(writer)·micPeak(텔레메트리)가 전부 이 값을 본다.
        // 근거·튜닝 가이드는 config.h AUDIO_GAIN_SHIFT 주석 참조.
        //
        // Update Ring Buffer for pre-recording AI
        // ⚠️ 링 버퍼 쓰기에 락/크리티컬 섹션 금지 (확정 설계):
        //   복사 중 극소수 샘플의 tearing은 추론에 영향이 없다.
        // 마이크 입력 피크 계측 — MSC 세션 중에도 항상 실행되어
        // 입력 생사를 관측한다. 텔레메트리가 3초 주기로 읽고 리셋.
        int32_t batchPeak = 0;
        for(size_t i = 0; i < sampleCount; i++) {
            int32_t raw = samples[i];

            // 진단 통계 (컨디셔닝 전 원시값)
            statSum += raw;
            int32_t rawAbs = raw < 0 ? -raw : raw;
            if (rawAbs > statPeakRaw) statPeakRaw = rawAbs;

            int32_t v = raw;

#if AUDIO_DC_BLOCK
            // 1차 IIR DC-블록 (Q8 상태): yQ8 = 256·(x - x[-1]) + (255/256)·yQ8[-1]
            int32_t yQ8 = ((v - dcPrevIn) << 8) + dcPrevOutQ8 - (dcPrevOutQ8 >> 8);
            dcPrevIn = v;
            dcPrevOutQ8 = yQ8;
            v = yQ8 >> 8;
#endif

#if AUDIO_GAIN_SHIFT > 0
            v <<= AUDIO_GAIN_SHIFT;
#endif
            // 포화 클램프는 게인과 무관하게 int16 캐스트 직전에 무조건
            //   건다: DC-블록 자체의 최악 이득이 2배라(전달함수 |H| 상한)
            //   게인 0 설정에서도 ±65,535급 값이 나올 수 있는데, 클램프가
            //   #if AUDIO_GAIN_SHIFT 안에 있으면 그 조합에서 (int16_t)
            //   캐스트가 랩되어 피크 파형이 부호 반전 잡음으로 파손된다
            //   (틱의 핵심 순간!).
            if (v > 32767) { v = 32767; statClipped++; }
            else if (v < -32768) { v = -32768; statClipped++; }

            int16_t s = (int16_t)v;
            audioBuffer[audioWriteIndex] = s;
            audioWriteIndex = (audioWriteIndex + 1) % AUDIO_BUFFER_SIZE;

            statSqSum += (uint64_t)((int64_t)v * v);
            int32_t vAbs = v < 0 ? -v : v;
            if (vAbs > batchPeak) batchPeak = vAbs;
        }
        statCount += sampleCount;
        if (batchPeak > lastAudioPeak) lastAudioPeak = batchPeak;

        // 누적 샘플 카운터(단일 쓰기자, 32bit 정렬 = 원자적) —
        // writer의 소비 커서와 텔레메트리 stall 판정의 기준점
        audioTotalSamples += sampleCount;

        // ── [AUDIO] 진단 로그 (5초 주기) ──
        // dcRaw: 원시 DC 오프셋(HW HP필터 부재 확인 채널)
        // rms/peak: 컨디셔닝 후 값 — EI 학습 분포와의 정합 판단 근거
        // clip%: 게인 포화 비율 — 1% 상회 지속 시 AUDIO_GAIN_SHIFT 하향
        if (millis() - lastStatLog > 5000 && statCount > 0) {
            lastStatLog = millis();
            int32_t dcRaw = (int32_t)(statSum / (int64_t)statCount);
            uint32_t rms = (uint32_t)sqrt((double)(statSqSum / statCount));
            Serial.printf(
                "[AUDIO] dcRaw=%ld rms=%lu peakRaw=%ld clip=%.2f%% (gain x%d, dcblk %d)\n",
                (long)dcRaw, (unsigned long)rms, (long)statPeakRaw,
                statCount ? (100.0 * statClipped / statCount) : 0.0,
                1 << AUDIO_GAIN_SHIFT, AUDIO_DC_BLOCK
            );
            statSum = 0; statSqSum = 0; statPeakRaw = 0;
            statCount = 0; statClipped = 0;
        }
    }
}

// =====================================================
// AUDIO WRITER TASK (소비자) — ADPCM 인코딩 + WAV 기록
// =====================================================
// audioTask가 채우는 링 버퍼를 자체 커서(readTotal)로 뒤따라가며
// 505샘플(1 ADPCM 블록) 단위로 인코딩해 SD에 흘린다.
//
//  - 링 버퍼는 180초 분량이라 SD가 수 초 멈춰도 유실이 없다.
//    단, 랙이 AUDIO_WRITER_MAX_LAG(2초)를 넘으면 백로그를 버리고
//    최신 지점으로 점프한다 — 오디오 시간축이 영상 대비 무한정
//    밀리는 것을 방지 (동기 오차 상한 2초).
//  - audioStreamBuf/audioStreamBufIdx 접근은 전부 sdMutex 아래에서만
//    한다 — 무락 append는 finalize의 flush와 레이스해 버퍼 오버플로우/
//    이중 계상을 만들 수 있다.
//  - 녹화 불가 구간(이벤트 저장/세그먼트 교체/재마운트 진행 중)에는
//    커서를 무효화해 과거 백로그가 새 세그먼트로 흘러들지 않게 한다
//    (해당 구간의 오디오는 버린다).
void audioWriterTask(void *pv) {
    int16_t pcmBlockBuffer[ADPCM_SAMPLES_PER_BLOCK];
    uint8_t adpcmBlock[ADPCM_BLOCK_SIZE];

    int16_t adpcmPrevVal = 0;
    int adpcmPrevIdx = 0;

    uint32_t readTotal = 0;
    // 링 인덱스는 누적 카운터에서 유도하지 않고 증분 추적한다:
    //   audioTotalSamples(uint32)는 74.5시간 연속 가동 시 랩되는데,
    //   2^32는 AUDIO_BUFFER_SIZE(2,880,000)의 배수가 아니라 랩 이후
    //   (total % N)이 생산자의 실제 링 위치(audioWriteIndex)와 어긋난다.
    //   재동기화 시에만 audioWriteIndex 스냅샷으로 위치를 잡고, 이후
    //   소비량만큼 증분한다. avail 계산(unsigned 뺄셈)은 랩에 안전.
    size_t ringIdx = 0;
    bool cursorValid = false;

    while(true) {
        // mscActive는 가드에 넣지 않는다 — USB 세션 중에도 녹화는
        // 계속된다(동시 접근 구조)
        if (eventSaving || segment_changing || !sdFsReady) {
            cursorValid = false;
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        uint32_t writeTotal = audioTotalSamples;

        if (!cursorValid) {
            // 재개 지점 = 현재 스트림 헤드. ADPCM 예측기 상태는 블록
            // 헤더가 매 블록 재시드하므로 인덱스만 초기화하면 충분하다.
            // (writeTotal/audioWriteIndex 스냅샷 간 최대 1배치(256샘플)의
            //  어긋남은 재동기화 시점 오차 16ms 이내 — 무해)
            readTotal = writeTotal;
            ringIdx = audioWriteIndex;
            adpcmPrevIdx = 0;
            cursorValid = true;
        }

        uint32_t avail = writeTotal - readTotal;   // unsigned 래핑 산술 — 랩어라운드에 안전

        if (avail > (uint32_t)AUDIO_WRITER_MAX_LAG) {
            // SD 장기 스톨로 밀린 백로그 폐기 — 최신 2초부터 재개
            uint32_t skip = avail - (uint32_t)AUDIO_WRITER_MAX_LAG;
            readTotal += skip;
            ringIdx = (ringIdx + (size_t)(skip % (uint32_t)AUDIO_BUFFER_SIZE)) % AUDIO_BUFFER_SIZE;
            adpcmPrevIdx = 0;
            avail = AUDIO_WRITER_MAX_LAG;
        }

        if (avail < (uint32_t)ADPCM_SAMPLES_PER_BLOCK) {
            // 1블록(≈31.5ms)이 쌓일 때까지 대기
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }

        // 링에서 1블록 복사 — 무락. 소비 지점은 생산자 헤드보다 최소
        // (링 크기 180초 - 랙 상한 2초) 뒤에 있어 덮어쓰기 경합이 없다.
        for (int i = 0; i < ADPCM_SAMPLES_PER_BLOCK; i++) {
            pcmBlockBuffer[i] = audioBuffer[(ringIdx + i) % AUDIO_BUFFER_SIZE];
        }

        encode_ima_adpcm_block(pcmBlockBuffer, adpcmBlock, ADPCM_SAMPLES_PER_BLOCK, adpcmPrevVal, adpcmPrevIdx);

        bool consumed = false;
        if (xSemaphoreTake(sdMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            // 뮤텍스 획득 후 가드 재확인 — 대기 중 상태가 바뀌었을 수 있다
            if (current_wav_file && !segment_changing && !eventSaving && sdFsReady) {
                memcpy(audioStreamBuf + audioStreamBufIdx, adpcmBlock, ADPCM_BLOCK_SIZE);
                audioStreamBufIdx += ADPCM_BLOCK_SIZE;

                if (audioStreamBufIdx + ADPCM_BLOCK_SIZE > AUDIO_STREAM_BUF_SIZE) {
                    current_wav_file.write(audioStreamBuf, audioStreamBufIdx);
                    segment_audio_bytes += audioStreamBufIdx;
                    audioStreamBufIdx = 0;
                }
                readTotal += ADPCM_SAMPLES_PER_BLOCK;   // 소비 확정
                ringIdx = (ringIdx + ADPCM_SAMPLES_PER_BLOCK) % AUDIO_BUFFER_SIZE;
                consumed = true;
            }
            // 가드에 걸렸으면 커서를 전진시키지 않는다 — 다음 순회의
            // 바깥 가드가 cursorValid를 리셋해 백로그를 정리한다.
            xSemaphoreGive(sdMutex);
        }
        // 뮤텍스 타임아웃/가드 거절 시 커서 유지 → 같은 블록 재시도.
        // 지연 필수: 가드 거절이 지속되는 상태(예: WAV open 실패)에서
        //   지연 없이 돌면 core 0을 태우는 busy-loop이 된다.
        if (!consumed) {
            vTaskDelay(pdMS_TO_TICKS(20));
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

        // ── 라이브 스냅샷: PSRAM 보관 (SD 쓰기 없음) ──
        // 스냅샷의 유일한 소비처는 이벤트 썸네일이므로 최신 JPEG 1장을
        // PSRAM에 유지하고, eventTask가 이벤트 시 폴더에 직접 기록한다.
        // SD에 주기적으로 덮어쓰는 방식은 동일 파일 반복 쓰기(2초 주기면
        // 43,200회/일)와 FAT 갱신으로 카드를 마모시키고 sdMutex를 주기
        // 점유하므로 쓰지 않는다.
        // FS 접근이 없으므로 MSC 세션/재마운트 실패 중에도 계속 갱신되어
        // 세션 직후 이벤트의 썸네일 신선도가 유지된다.
        // (경합 주의: cameraTask와 eventTask는 같은 코어·같은 우선순위의
        //  라운드로빈이라 무보호 공유는 torn JPEG를 실제로 만든다 —
        //  snapMutex 보호 + eventTask 측은 스테이징 복사 후 즉시 해제.)
        static unsigned long lastSnap = 0;
        if(snapshotBuf && millis() - lastSnap > 2000) {
            lastSnap = millis();
            if (fb->len <= SNAPSHOT_MAX_BYTES &&
                xSemaphoreTake(snapMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
                memcpy(snapshotBuf, fb->buf, fb->len);
                snapshotLen = fb->len;
                xSemaphoreGive(snapMutex);
            }
            // 초과 크기 프레임은 이번 주기 스킵 (직전 스냅샷 유지)
        }

        // !sdFsReady 포함: 재마운트 실패 중에는 FS 접근을 하지 않는다
        // (스냅샷은 위에서 PSRAM으로만 처리됨). mscActive는 가드에 넣지
        // 않는다 — USB 세션 중에도 프레임 기록은 계속된다(동시 접근 구조).
        if(eventSaving || segment_changing || !sdFsReady) {
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

        esp_camera_fb_return(fb);

        unsigned long spent = millis() - loopStart;
        unsigned long waitMs = (spent < FRAME_INTERVAL_MS) ? (FRAME_INTERVAL_MS - spent) : 1;
        vTaskDelay(pdMS_TO_TICKS(waitMs));
    }
}

