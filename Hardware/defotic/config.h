// ============================
// config.h
// ============================

#ifndef CONFIG_H
#define CONFIG_H

#include "esp_camera.h"
#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// 신형 I2S PDM 드라이버(driver/i2s_pdm.h)만 사용한다:
//   레거시 driver/i2s.h(IDF 5.x deprecated 호환 셰임)는 esp32 core 3.3.10에서
//   S3 PDM RX 설치가 ESP_OK를 반환하면서도 부팅 첫 샘플부터 데이터가 0인
//   상태를 만든다(I2S READY 후 i2s_read 영구 타임아웃, 소프트 재기동/
//   드라이버 재설치 무효). 이 보드(XIAO ESP32S3 Sense)의 코어 검증 경로는
//   신형 드라이버 기반 ESP_I2S 래퍼이며, 이 펌웨어의 초기화는 그 경로를
//   그대로 따른다. 레거시 API(i2s_read/i2s_driver_install 등) 혼용 금지 —
//   신구 드라이버는 공존 시 런타임 CONFLICT로 abort된다.
#include <driver/i2s_pdm.h>

#include "FS.h"
#include "SD.h"
#include "SPI.h"

#include <time.h>

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

// NOTE: USB 시리얼 정책 (usb_msc.h 참조)
//  - 폰 인식을 위해 배포 빌드는 CDC 없는 "순수 MSC 단독 장치"여야 한다.
//    (Android는 CDC가 섞인 복합 장치의 저장소를 마운트하지 않음)
//  - 따라서 CDC On Boot=Disabled 빌드에서 Serial은 UART0으로 빠지며(무해),
//    시리얼 모니터가 필요한 개발 빌드는 CDC On Boot=Enabled로 전환한다.

#define SERVICE_UUID "4fafc201-1fb5-459e-8fcc-c5c9c331914b"

#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// ==========================================
// SD SPI
// ==========================================

#define SD_CS 21
#define SD_SCK 7
#define SD_MISO 8
#define SD_MOSI 9

// SD SPI 클럭 사다리: 20MHz → 10MHz → 4MHz.
//   SD.begin 기본값(4MHz, ≈250KB/s)은 폰이 마운트 전 fsck로 FAT 테이블
//   (수 MB)을 읽는 데 40~50초가 걸리는 병목이고, QQVGA 30fps 영상
//   (~150-400KB/s)의 처리량 하한에도 걸린다. 20MHz(XIAO 온보드 SD,
//   짧은 배선이라 안정)가 1차 목표. 다만 20MHz 마운트를 거부하는
//   카드가 실재하므로, 대부분의 카드가 수용하는 10MHz를 중간 폴백으로
//   두어 4MHz 직행을 피한다.
#define SD_SPI_HZ 20000000
#define SD_SPI_HZ_MID 10000000

// 이벤트 승격 최소 파일 크기 — AVI 더미 헤더(2048B+α)/WAV 헤더(60B)만
// 있는 '0초 세그먼트'를 이벤트 폴더로 옮기지 않기 위한 문턱값
#define MIN_EVENT_MEDIA_BYTES 4096

// ==========================================
// AUDIO
// ==========================================

#define SAMPLE_RATE 16000

// ── 오디오 프런트엔드 컨디셔닝 (DC-블록 → 게인) ──
//
// 요지: S3 PDM RX의 원시 PCM 진폭은 낮고(소프트웨어 게인이 통상 관행),
// PDM RX HP 필터 캐퍼빌리티가 없어 마이크 DC 오프셋이 잔존한다.
// DC는 게인 적용 시 헤드룸을 잡아먹고 조기 클리핑을 유발하므로
// 게인 '이전'에 제거해야 한다. 배경·근거: docs/FIRMWARE_NOTES.md 참조.
//
// 적용 지점: audioTask의 인입 단일 지점 — 링 버퍼(AI 추론)·WAV 기록·
// micPeak(기기 화면 입력%)이 전부 같은 컨디셔닝을 거친 값을 보게 되어
// "학습 데이터 분포 정합 + 관측 일관성"이 동시에 확보된다.
//
// 튜닝 가이드 (시리얼 [AUDIO] 진단 로그 기준):
//  · clip%가 1%를 넘게 상시 찍히면 GAIN_SHIFT를 1로 낮출 것
//  · 발화 시 기기 화면 "입력 %"가 30%도 못 넘으면 3으로 올릴 것
//  · 0 = 게인 없음 (원시 진폭 그대로)
#define AUDIO_DC_BLOCK 1     // 1: 1차 IIR DC-블록 필터(fc≈10Hz) 활성
#define AUDIO_GAIN_SHIFT 2   // 좌시프트 게인 (2 = ×4, Seeed 예제 관행), 포화 클램프 적용

#define AUDIO_PRE_SECONDS 180

#define AUDIO_BUFFER_SIZE (SAMPLE_RATE * AUDIO_PRE_SECONDS)

#define ADPCM_BLOCK_SIZE 256
#define ADPCM_SAMPLES_PER_BLOCK 505

// 오디오 writer(SD 기록) 태스크가 생산자(audioTask)로부터 뒤처질 수 있는
// 최대 샘플 수(2초). SD 카드 내부 GC 등으로 쓰기가 수백 ms 멈춰도 링
// 버퍼(180초)가 흡수하지만, 랙이 이 상한을 넘으면 오래된 백로그를 버리고
// 최신 지점으로 건너뛴다 — 세그먼트 파일 간 오디오 시간축이 밀리는 것을
// 방지한다 (영상과의 동기 오차 상한 = 2초).
#define AUDIO_WRITER_MAX_LAG (SAMPLE_RATE * 2)

// ==========================================
// VIDEO
// ==========================================

#define VIDEO_RING_FRAMES 5400

#define FRAME_INTERVAL_MS 33

#define EVENT_SAVE_SECONDS 180

// ==========================================
// AI
// ==========================================

// AI 트리거 문턱 — 모델 confidence(abnormal) 단독 판정.
//   현재 모델은 조용한 창에서도 abnormal이 0.35~0.46을 상시 오가므로,
//   문턱을 그 바닥 소음 위(0.5)에 두어 쿨다운(10초)마다 오탐 이벤트가
//   양산되는 것을 막는다. 단 조용한 창에서도 0.5 초과가 간헐 관측되고
//   abnormal과 창 에너지의 상관이 약해, 오탐의 완전한 해법은 임계값이
//   아니라 EI 재학습이다(DeFoTic_EI_모델_조치사항.md §2 — noise 클래스에
//   '실기기로 녹음한 조용한 방 배경음' 추가가 1순위).
//   앱 표시 상수(app/(tabs)/device.tsx AI_THRESHOLD)와 동일 값 유지 필수.
// 에너지 게이트(RMS 문턱)는 두지 않는다 — 모델 발화 창과 창 에너지가
//   반상관을 이루면 이벤트가 구조적으로 0건이 된다. 무음 오탐은 게이트가
//   아니라 EI 재학습으로 해결한다 (근거: ai_task.cpp 주석,
//   docs/FIRMWARE_NOTES.md).
#define AI_THRESHOLD 0.5

// 이벤트 트리거 후 동일 잔여 오디오로 인한 중복 감지 방지 (빈도 지표 보호)
#define TIC_COOLDOWN_MS 10000

// ==========================================
// STORAGE
// ==========================================

#define STORAGE_LIMIT_MB 512

// ==========================================
// GLOBALS
// ==========================================

// volatile 필수: BLE 콜백(BLE 호스트 태스크, core 0)이 쓰고
// loop()(core 1)가 폴링한다 — 코어 간 공유 플래그.
extern volatile bool timeSynced;
extern int16_t *audioBuffer;
// volatile 필수: aiTask가 set, eventTask가 clear하는 태스크 간 플래그.
extern volatile bool ticDetected;

// AI 추론에서 마지막으로 감지된 confidence (tic_event 메타데이터에 포함)
// 틱의 강도/요인/상황 맥락 판단은 앱의 LLM 분석 파이프라인이 전담한다.
extern volatile float lastConfidence;

// 매 추론 사이클의 실시간 abnormal 레벨 (감지 여부와 무관하게 항상 갱신).
// 텔레메트리로 앱에 전송되어, 시리얼 모니터가 없는 배포 빌드에서도
// 모델 생사(항상 0.00 = 입력/모델 문제)와 문턱 적정성을 진단할 수 있다.
extern volatile float lastAiLevel;

// 마이크 입력 피크(|int16| 최대값, 텔레메트리 주기마다 리셋) —
// AI 레벨 0.00 고정이 '입력 없음(I2S/하드웨어)'인지 '모델 문제'인지
// 가르는 교차 검증 채널. 텔레메트리 → 앱 기기 화면으로 노출된다.
extern volatile int32_t lastAudioPeak;

// 마지막 추론 창(1초)의 컨디셔닝 후 RMS — 순수 진단 채널.
// 판정에는 일절 관여하지 않고 diag 텔레메트리/시리얼 로그로만 노출해,
// abnormal 출력이 창 에너지와 비례하는지(모델 정상성)를 실측 대조한다.
extern volatile uint32_t lastAiWindowRms;

// NOTE: AI 추론 윈도우 복사에는 락/크리티컬 섹션을 쓰지 않는다 —
// 생산자(audioTask)가 락을 쓰지 않는 이상 소비자(aiTask)만 크리티컬
// 섹션을 잡아도 동기화 효과가 전혀 없고, 추론 윈도우 복사 내내 core 1
// 인터럽트를 끄는 순수 비용만 발생한다. 링 버퍼 복사 중 극소수 샘플의
// tearing은 추론에 무해하다는 것이 확정 설계다.

// SD 파일시스템 사용 허가 플래그. 동시 접근 구조에서는 호스트 세션과
// 무관하며, false가 되는 구간은 '재마운트 진행/실패 중'뿐이다 — 그 동안
// 펌웨어의 FS 접근(세그먼트 쓰기, telemetry의 totalBytes 등)이 금지된다.
// sdRemountFresh() 성공 시 true로 복귀한다.
extern volatile bool sdFsReady;

extern volatile size_t audioWriteIndex;

// 부팅 이후 누적 수신 샘플 수 (32bit, unsigned 래핑 산술로 안전).
// writer 태스크의 소비 커서 기준점이자 텔레메트리의 스트림 생사 판정
// 채널 — audioWriteIndex와 달리 링 크기로 접히지 않아 모호성이 없다.
extern volatile uint32_t audioTotalSamples;

extern SemaphoreHandle_t sdMutex;

// BLE notify 직렬화 — telemetryTask(core 0)와 eventTask(core 1,
// telemetry_sendTicEvent)가 같은 pCharacteristic에 setValue+notify를
// 무락으로 겹쳐 부르면 패킷 내용이 뒤바뀌거나 유실된다.
extern SemaphoreHandle_t bleMutex;

// ── 라이브 스냅샷: PSRAM 보관 ──
// 스냅샷의 유일한 소비처는 이벤트 썸네일이므로 SD에 주기 기록하지 않고
// PSRAM에 최신 1장만 유지한다(동일 파일 반복 쓰기로 인한 SD 마모와
// 주기적 sdMutex 점유 제거) — cameraTask가 snapMutex 하에 최신 JPEG를
// 갱신하고, eventTask가 이벤트 시 스테이징 복사 후 폴더에 직접 기록한다.
// 락 순서 불변식: sdMutex → snapMutex 단방향만 허용 (역순 획득 금지 —
// cameraTask는 snapMutex만 잡고, eventTask는 sdMutex 보유 중 snapMutex를
// 잠깐 잡는다. 데드락 조건이 구조적으로 성립하지 않는다.)
#define SNAPSHOT_MAX_BYTES (48 * 1024)   // QQVGA JPEG 실측 ~5-15KB, 3배 여유
extern uint8_t *snapshotBuf;             // 최신 JPEG (PSRAM, snapMutex 보호)
extern uint8_t *snapshotStaging;         // eventTask 전용 스테이징 (PSRAM)
extern volatile size_t snapshotLen;      // snapshotBuf 유효 길이 (0 = 아직 없음)
extern SemaphoreHandle_t snapMutex;

// ==========================================
// BLE
// ==========================================

class BLECharacteristic;

extern BLECharacteristic *pCharacteristic;

extern bool deviceConnected;

// ==========================================
// TASKS
// ==========================================

void audioTask(void *pv);

// I2S 소비와 SD 기록을 분리한 writer 태스크 — SD 쓰기 스톨이
// audioTask(생산자)의 i2s_read 주기를 막아 I2S DMA 오버런으로
// 번지지 않게 하는 구조적 분리
void audioWriterTask(void *pv);

void cameraTask(void *pv);

void aiTask(void *pv);

void eventTask(void *pv);

// ==========================================
// INIT
// ==========================================

bool initSDCard();

void initCamera();

// 설치 성공 여부를 반환한다. 호출 코어 주의: 아래 4개 함수는 전부
// 반드시 audioTask 안에서만 호출할 것 — esp_intr_free는 인터럽트를
// 할당한 코어에서만 해제할 수 있어(IDF 제약), 다른 코어에서 채널을
// 만들고 audioTask에서 삭제/재생성하면 해제가 실패한다.
bool initI2S();

// 복구 사다리 1단: 채널 disable → enable (드라이버/DMA 메모리 유지)
bool i2sSoftRestart();

// 복구 사다리 2단: 채널 삭제 후 재생성 (완전 재설치)
bool i2sReinstall();

// i2s_channel_read 래퍼 — 채널 핸들은 hardware_init.cpp 내부 소유.
// 반환: ESP_OK(요청량 충족) / ESP_ERR_TIMEOUT(부분 수신 — *bytesRead 확인)
esp_err_t i2sRead(void *dest, size_t size, size_t *bytesRead, uint32_t timeoutMs);

void initBLE();

void manageStorage();

extern volatile bool eventSaving;
#endif