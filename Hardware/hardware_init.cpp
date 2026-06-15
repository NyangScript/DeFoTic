#include "hardware_init.h"

#include "esp_camera.h"

// ==========================================
// GLOBALS
// ==========================================

BLEServer *server = nullptr;
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;
bool timeSynced = false;
SemaphoreHandle_t sdMutex;

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
            pChar->getValue();

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



    config.xclk_freq_hz =
        4000000;



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
// I2S INIT
// ==========================================
void initI2S() {

    i2s_config_t config = {

        .mode =
            (i2s_mode_t)(
                I2S_MODE_MASTER |
                I2S_MODE_RX |
                I2S_MODE_PDM
            ),

        .sample_rate =
            SAMPLE_RATE,

        .bits_per_sample =
            I2S_BITS_PER_SAMPLE_16BIT,

        .channel_format =
            I2S_CHANNEL_FMT_ONLY_LEFT,

        .communication_format =
            I2S_COMM_FORMAT_I2S,

        .intr_alloc_flags =
            ESP_INTR_FLAG_LEVEL1,

        .dma_buf_count = 8,

        .dma_buf_len = 512,

        .use_apll = false,

        .tx_desc_auto_clear = false,

        .fixed_mclk = 0
    };



    i2s_pin_config_t pin_config = {

        .bck_io_num =
            I2S_PIN_NO_CHANGE,

        .ws_io_num =
            42,

        .data_out_num =
            I2S_PIN_NO_CHANGE,

        .data_in_num =
            41
    };



    esp_err_t err =
        i2s_driver_install(
            I2S_NUM_0,
            &config,
            0,
            NULL
        );

    if(err != ESP_OK) {

        Serial.printf(
            "I2S INSTALL FAIL: %d\n",
            err
        );

        return;
    }



    err =
        i2s_set_pin(
            I2S_NUM_0,
            &pin_config
        );

    if(err != ESP_OK) {

        Serial.printf(
            "I2S PIN FAIL: %d\n",
            err
        );

        return;
    }



    i2s_zero_dma_buffer(
        I2S_NUM_0
    );



    Serial.println(
        "I2S READY"
    );
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

    if(
        !SD.begin(SD_CS)
    ) {

        Serial.println(
            "SD FAIL"
        );

        return;
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

    if(!SD.exists("/buffer")) {
        SD.mkdir("/buffer");
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
        "Defotic"
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



    advertising->setScanResponse(
        false
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
// TIME INIT
// ==========================================

void initTimeSync() {

    Serial.println(
        "Time Sync OK"
    );
}



// ==========================================
// HARDWARE INIT
// ==========================================

void initHardware() {

    Serial.begin(115200);

    delay(3000);

    // =========================
    // PSRAM AUDIO BUFFER
    // =========================

    Serial.println(
        "PSRAM AUDIO BUFFER OK"
    );

    Serial.println();
    Serial.println(
        "======================"
    );


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



    if(sdMutex == NULL) {

        Serial.println(
            "Mutex Fail"
        );

        while(true) {

            delay(1000);
        }
    }



    initSD();
    initCamera();
    initI2S();
    initBLE();
    initTimeSync();


    Serial.println(
        "Hardware Init Complete"
    );
}