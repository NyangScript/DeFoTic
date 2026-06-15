// =====================================================
// ai_task.cpp
// =====================================================

#include "config.h"

#include <DEFOTIC_inferencing.h>

// =====================================================
// AI CRITICAL SECTION
// =====================================================

portMUX_TYPE aiMux =
    portMUX_INITIALIZER_UNLOCKED;

// =====================================================
// AI BUFFER
// =====================================================

static int16_t inferenceBuffer[
    EI_CLASSIFIER_RAW_SAMPLE_COUNT
];

// =====================================================
// CALLBACK
// =====================================================

static int get_signal_data(
    size_t offset,
    size_t length,
    float *out_ptr
) {

    for(
        size_t i = 0;
        i < length;
        i++
    ) {

        out_ptr[i] =
            inferenceBuffer[offset + i];
    }

    return 0;
}

// =====================================================
// AI TASK
// =====================================================
void aiTask(void *pv) {

    while(true) {

        size_t startIdx;

        if(
            audioWriteIndex >=
            EI_CLASSIFIER_RAW_SAMPLE_COUNT
        ) {

            startIdx =
                audioWriteIndex -
                EI_CLASSIFIER_RAW_SAMPLE_COUNT;

        } else {

            startIdx =
                AUDIO_BUFFER_SIZE +
                audioWriteIndex -
                EI_CLASSIFIER_RAW_SAMPLE_COUNT;
        }

        // =============================================
        // AUDIO BUFFER COPY
        // =============================================

        portENTER_CRITICAL(&aiMux);

        for(
            size_t i = 0;
            i < EI_CLASSIFIER_RAW_SAMPLE_COUNT;
            i++
        ) {

            size_t idx =
                (
                    startIdx + i
                )
                % AUDIO_BUFFER_SIZE;

            inferenceBuffer[i] =
                audioBuffer[idx];
        }

        portEXIT_CRITICAL(&aiMux);

        // =============================================
        // EDGE IMPULSE SIGNAL
        // =============================================

        signal_t signal;

        signal.total_length =
            EI_CLASSIFIER_RAW_SAMPLE_COUNT;

        signal.get_data =
            &get_signal_data;

        ei_impulse_result_t result =
            {0};

        // =============================================
        // RUN INFERENCE
        // =============================================

        EI_IMPULSE_ERROR err =
            run_classifier(
                &signal,
                &result,
                false
            );

        if(err != EI_IMPULSE_OK) {

            Serial.printf(
                "AI FAIL: %d\n",
                err
            );

            vTaskDelay(
                pdMS_TO_TICKS(1000)
            );

            continue;
        }

        // =============================================
        // FIND CONFIDENCE
        // =============================================

        float confidence = 0.0;

        for(
            size_t ix = 0;
            ix < EI_CLASSIFIER_LABEL_COUNT;
            ix++
        ) {

            const char* label =
                result.classification[ix]
                .label;

            float value =
                result.classification[ix]
                .value;


            if(
                strcmp(
                    label,
                    "abnormal"
                ) == 0
            ) {

                confidence = value;
            }
        }

        // =============================================
        // RESULT
        // =============================================

        if(
            confidence >
            AI_THRESHOLD
        ) {

            if(!ticDetected) {

                ticDetected = true;

                Serial.println(
                    "TIC DETECTED"
                );
            }
        }

        vTaskDelay(
            pdMS_TO_TICKS(100)
        );
    }
}