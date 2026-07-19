#include "hardware_init.h"

#include "esp_camera.h"
#include <sys/time.h>

// ==========================================
// GLOBALS
// ==========================================

BLEServer *server = nullptr;
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;
// volatile: BLE 콜백(core 0)이 쓰고 loop()(core 1)가 폴링 — config.h 참조
volatile bool timeSynced = false;
SemaphoreHandle_t sdMutex;
SemaphoreHandle_t bleMutex;
SemaphoreHandle_t snapMutex;

// ==========================================
// BLE CALLBACK
// ==========================================

class ServerCallbacks
    : public BLEServerCallbacks {

    void onConnect(
        BLEServer *pServer
    ) override {

        deviceConnected = true;

        Serial.println(
            "BLE Connected"
        );
    }

    void onDisconnect(
        BLEServer *pServer
    ) override {

        deviceConnected = false;

        Serial.println(
            "BLE Disconnected"
        );

        BLEDevice::startAdvertising();
    }
};



// ==========================================
// TIME CALLBACK
// ==========================================

class TimeCallback
    : public BLECharacteristicCallbacks {

    void onWrite(
        BLECharacteristic *pChar
    ) override {

        std::string rxValue =
            pChar->getValue().c_str();

        String value =
            String(
                rxValue.c_str()
            );

        Serial.print(
            "RX: "
        );

        Serial.println(
            value
        );

        if(
            value.startsWith(
                "TIME:"
            )
        ) {

            // "TIME:<epoch초>" 파싱 후 RTC 설정 → 이벤트 폴더/파일명이 실제 시각 기준이 된다
            unsigned long epoch =
                strtoul(
                    value.c_str() + 5,
                    NULL,
                    10
                );

            if(epoch > 0) {
                struct timeval tv;
                tv.tv_sec = (time_t)epoch;
                tv.tv_usec = 0;
                settimeofday(&tv, NULL);

                // 타임존을 KST로 고정한다. 앱은 UTC epoch를 보내므로
                // TZ 미설정 시 getLocalTime이 UTC를 반환해 이벤트 폴더명이
                // 전부 한국시간 -9시간으로 기록된다.
                // 앱의 파일명 타임스탬프 복원(timestampFromEventId)도
                // 로컬 시간 가정이므로 KST 명명과 정합된다.
                setenv("TZ", "KST-9", 1);
                tzset();
            }

            timeSynced = true;

            Serial.println(
                "TIME SYNCED"
            );
        }
    }
};



// ==========================================
// CAMERA INIT
// ==========================================

void initCamera() {

    camera_config_t config;

    config.ledc_channel =
        LEDC_CHANNEL_0;

    config.ledc_timer =
        LEDC_TIMER_0;



    config.pin_d0 = 15;
    config.pin_d1 = 17;
    config.pin_d2 = 18;
    config.pin_d3 = 16;

    config.pin_d4 = 14;
    config.pin_d5 = 12;
    config.pin_d6 = 11;
    config.pin_d7 = 48;



    config.pin_xclk  = 10;

    config.pin_pclk  = 13;

    config.pin_vsync = 38;

    config.pin_href  = 47;



    config.pin_sccb_sda = 40;

    config.pin_sccb_scl = 39;



    config.pin_pwdn  = -1;

    config.pin_reset = -1;



    // OV3660(XIAO ESP32S3 Sense 탑재) JPEG 모드 표준 클럭.
    // OV3660의 XCLK 허용 범위는 6~27MHz이며 20MHz가 권장값.
    // 4MHz에서는 센서 파이프라인이 ~5fps로 제한되므로 20MHz로
    // QQVGA JPEG 30fps 캡처를 가능하게 한다.
    // (실효 fps는 SD 쓰기 속도에 따라 자연 조절되며, AVI 헤더에는
    //  finalize 시점의 실측 fps가 기록된다.)
    // NOTE: OV3660은 흰 피사체가 핑크빛으로 왜곡되는 AWB 특성이 있음
    //       → 작품설명서 로드맵의 AWB 레지스터 교정 과제(P3) 대상.
    config.xclk_freq_hz =
        20000000;



    config.pixel_format =
        PIXFORMAT_JPEG;



    config.frame_size =
        FRAMESIZE_QQVGA;



    config.jpeg_quality =
        12;



    config.fb_count = 2;



    config.fb_location =
        CAMERA_FB_IN_PSRAM;



    config.grab_mode =
        CAMERA_GRAB_LATEST;



    esp_err_t err =
        esp_camera_init(
            &config
        );



    if(err != ESP_OK) {

        Serial.printf(
            "Camera Fail: 0x%x\n",
            err
        );

        return;
    }



    sensor_t *s =
        esp_camera_sensor_get();



    s->set_hmirror(
        s,
        1
    );



    s->set_vflip(
        s,
        0
    );



    Serial.println(
        "Camera OK"
    );
}



// ==========================================
// I2S INIT — 신형 PDM RX 드라이버 (driver/i2s_pdm.h)
// ==========================================
// 신형 드라이버를 쓰는 이유: 레거시 driver/i2s.h 경로는 설치가 ESP_OK를
//   반환하면서도 부팅 첫 샘플부터 i2s_read가 영구 타임아웃한다(소프트
//   재기동·재설치 무효 — '런타임 오버런 스톨'이 아니라 클럭/DMA가
//   처음부터 돌지 않는 구성 결함). 이 초기화는 코어 번들 ESP_I2S 래퍼
//   (이 보드의 검증 경로)가 사용하는 신형 드라이버 호출 순서를 그대로
//   따른다:
//   i2s_new_channel → i2s_channel_init_pdm_rx_mode → i2s_channel_enable.
//
//   S3 전용 이점: PDM2PCM 하드웨어 필터(PCM 포맷 직수신) + RX 오버플로우
//   시 스트림이 정지하지 않고 오래된 데이터만 드롭된다.
//   (주의: 이 코어의 S3 캐퍼빌리티에는 PDM RX HP 필터가 없다 —
//    SOC_I2S_SUPPORTS_PDM_RX_HP_FILTER 미정의. PDM 마이크의 DC 오프셋이
//    잔존할 수 있으며, 무음 시 micPeak 바닥값이 0이 아닐 수 있다.)
//
// 호출 코어 규약 (config.h 선언부 참조):
//   initI2S/i2sSoftRestart/i2sReinstall/i2sRead는 반드시 audioTask(core 0)
//   컨텍스트에서만 호출한다. 인터럽트는 채널 생성 코어에 할당되며
//   esp_intr_free는 그 코어에서만 해제 가능(IDF 제약) — 크로스 코어
//   삭제/재생성은 영구 실패한다.

// I2S RX 채널 핸들 — 이 파일이 단독 소유. 외부 접근은 i2sRead 등
// 래퍼 함수로만 한다 (audioTask 단일 소비자 규약).
static i2s_chan_handle_t s_i2sRxChan = NULL;

bool initI2S() {

    if (s_i2sRxChan) return true;   // 이미 설치됨 (멱등)

    // DMA 버짓: 8디스크립터 × 512프레임(mono 16bit=2B) = 4096샘플 ≈ 256ms
    // 백로그 흡수량.
    i2s_chan_config_t chanCfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chanCfg.dma_desc_num = 8;
    chanCfg.dma_frame_num = 512;

    esp_err_t err = i2s_new_channel(&chanCfg, NULL, &s_i2sRxChan);
    if (err != ESP_OK) {
        Serial.printf("I2S CHAN FAIL: %d\n", err);
        s_i2sRxChan = NULL;
        return false;
    }

    // 기본값 = ESP_I2S 래퍼와 동일: PCM 포맷(PDM2PCM 필터), MONO=LEFT 슬롯,
    // DSR_8S, MCLK×256 (이 코어의 S3에는 PDM RX HP 필터 캐퍼빌리티가 없어
    // non-HP 슬롯 변형으로 확장된다). 핀은 XIAO ESP32S3 Sense 내장
    // PDM 마이크 — CLK=GPIO42, DATA=GPIO41.
    i2s_pdm_rx_config_t pdmCfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT,
            I2S_SLOT_MODE_MONO
        ),
        .gpio_cfg = {
            .clk = (gpio_num_t)42,
            .din = (gpio_num_t)41,
            .invert_flags = {
                .clk_inv = false,
            },
        },
    };

    err = i2s_channel_init_pdm_rx_mode(s_i2sRxChan, &pdmCfg);
    if (err != ESP_OK) {
        Serial.printf("I2S PDM INIT FAIL: %d\n", err);
        i2s_del_channel(s_i2sRxChan);
        s_i2sRxChan = NULL;
        return false;
    }

    err = i2s_channel_enable(s_i2sRxChan);
    if (err != ESP_OK) {
        Serial.printf("I2S ENABLE FAIL: %d\n", err);
        i2s_del_channel(s_i2sRxChan);
        s_i2sRxChan = NULL;
        return false;
    }

    Serial.println("I2S READY (pdm-rx v2)");
    return true;
}

// 복구 사다리 1단 — 채널 재기동 (DMA/드라이버 메모리 유지, 실패 지점 최소)
bool i2sSoftRestart() {
    if (!s_i2sRxChan) return false;
    i2s_channel_disable(s_i2sRxChan);   // 이미 정지 상태면 무해
    return i2s_channel_enable(s_i2sRxChan) == ESP_OK;
}

// 복구 사다리 2단 — 완전 재설치 (채널 삭제 → 재생성)
bool i2sReinstall() {
    if (s_i2sRxChan) {
        i2s_channel_disable(s_i2sRxChan);   // del 전 정지 필수 (READY 상태 요구)
        i2s_del_channel(s_i2sRxChan);
        s_i2sRxChan = NULL;
    }
    return initI2S();
}

esp_err_t i2sRead(void *dest, size_t size, size_t *bytesRead, uint32_t timeoutMs) {
    *bytesRead = 0;
    if (!s_i2sRxChan) return ESP_ERR_INVALID_STATE;
    return i2s_channel_read(s_i2sRxChan, dest, size, bytesRead, timeoutMs);
}



// ==========================================
// SD INIT
// ==========================================

void initSD() {

    SPI.begin(
        SD_SCK,
        SD_MISO,
        SD_MOSI,
        SD_CS
    );

    // 클럭 사다리 20MHz → 10MHz → 4MHz — 20MHz를 거부하는 카드가
    // 4MHz로 직행하지 않도록 10MHz 중간 단을 둔다 (근거는 config.h 참조)
    if(!SD.begin(SD_CS, SPI, SD_SPI_HZ)) {

        Serial.println(
            "SD 20MHz FAIL — fallback 10MHz"
        );

        if(!SD.begin(SD_CS, SPI, SD_SPI_HZ_MID)) {

            Serial.println(
                "SD 10MHz FAIL — fallback 4MHz"
            );

            if(!SD.begin(SD_CS)) {

                Serial.println(
                    "SD FAIL"
                );

                return;
            }
        }
    }

    uint64_t size =
        SD.cardSize()
        /
        (
            1024ULL *
            1024ULL
        );

    Serial.printf(
        "SD OK: %lluMB\n",
        size
    );

    // 이벤트 저장 루트 — 앱 SAF 동기화의 선택 대상 폴더
    if(!SD.exists("/DEFOTIC")) {
        SD.mkdir("/DEFOTIC");
    }

    Serial.println(
        "SD Folder Ready"
    );
}





// ==========================================
// BLE INIT
// ==========================================

void initBLE() {

    BLEDevice::init(
        "DeFoTic"
    );



    server =
        BLEDevice::createServer();



    server->setCallbacks(
        new ServerCallbacks()
    );



    BLEService *service =
        server->createService(
            SERVICE_UUID
        );



    pCharacteristic =
        service->createCharacteristic(

            CHARACTERISTIC_UUID,

            BLECharacteristic::
                PROPERTY_NOTIFY
            |

            BLECharacteristic::
                PROPERTY_READ
            |

            BLECharacteristic::
                PROPERTY_WRITE
            |

            BLECharacteristic::
                PROPERTY_WRITE_NR
        );

pCharacteristic->setCallbacks(
    new TimeCallback()
);



    pCharacteristic
        ->addDescriptor(
            new BLE2902()
        );



    service->start();



    BLEAdvertising *advertising =
        BLEDevice::getAdvertising();



    advertising->addServiceUUID(
        SERVICE_UUID
    );



    // 스캔 응답 활성 필수:
    //   메인 광고 패킷(31B)은 플래그(3B)+128bit 서비스 UUID(18B)가 차지해
    //   이름이 "De"로 잘려 나간다. 스캔 응답(추가 31B)에 이름을 실어
    //   앱에 "DeFoTic" 전체 이름이 표시되게 한다.
    advertising->setScanResponse(
        true
    );



    advertising->setMinPreferred(
        0x06
    );



    advertising->setMinPreferred(
        0x12
    );



    BLEDevice::startAdvertising();



    Serial.println(
        "BLE OK"
    );
}



// ==========================================
// HARDWARE INIT
// ==========================================

void initHardware() {

    Serial.begin(115200);

    delay(3000);

    Serial.println();
    Serial.println(
        "======================"
    );

    Serial.println(
        "DEFOTIC START"
    );

    Serial.println(
        "======================"
    );



    sdMutex =
        xSemaphoreCreateMutex();

    bleMutex =
        xSemaphoreCreateMutex();

    snapMutex =
        xSemaphoreCreateMutex();



    if(sdMutex == NULL || bleMutex == NULL || snapMutex == NULL) {

        Serial.println(
            "Mutex Fail"
        );

        while(true) {

            delay(1000);
        }
    }



    initSD();
    initCamera();
    // NOTE: initI2S()는 여기서 호출하지 않는다 — I2S 수명주기(설치/복구/
    // 재설치)는 audioTask가 전담한다. setup(core 1)에서 설치하면 core 0의
    // 자가복구가 인터럽트를 해제하지 못해 영구 고착된다 (initI2S 주석 참조).
    initBLE();
    // 실제 시간 동기는 BLE TimeCallback("TIME:" 수신)이 수행한다 —
    // 동기 완료 전에는 loop()가 태스크 기동을 보류한다 (defotic.ino).


    Serial.println(
        "Hardware Init Complete"
    );
}