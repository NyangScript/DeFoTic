// =====================================================
// ai_task.cpp
// =====================================================

#include "config.h"

// 추론 라이브러리 — 실기기 오디오 분포로 재학습한 Edge Impulse 모델
//   defotic_-esc-50(deploy v6, MFE implementationVersion 4).
//   실기기 분포로 검증되지 않은 모델은 결정 경계가 절대 에너지 축에
//   얇게 학습되어 상수·역상관 출력을 낼 수 있으므로, 모델 교체는 반드시
//   실기기 시리얼 로그([AI] abnormal/noise/rms)로 재검증한다.
//   ⚠️ 라이브러리 폴더에 다른 EI 라이브러리가 남아 있어도 include하지
//   않으면 컴파일에 포함되지 않는다 — 이 include가 실사용 모델을
//   결정하는 유일 지점.
#include <defotic_-esc-50_inferencing.h>

// =====================================================
// AI BUFFER
// =====================================================

static int16_t inferenceBuffer[
    EI_CLASSIFIER_RAW_SAMPLE_COUNT
];

// =====================================================
// CALLBACK
// =====================================================

// 추론 입력 스케일 계약: int16 원시 스케일을 공급한다.
//
// [공급 계약 — 라이브러리 소스 체인 근거]
//   이 모델(MFE implementationVersion 4)의 실행 경로는 get_signal_data가
//   반환한 값을 SDK의 preemphasis 래퍼가 감싸며, 그 래퍼가 rescale=true로
//   하드코딩되어 무조건 1/32768을 곱한다:
//     · ei_run_dsp.h:794-796 — v3+ 경로: new preemphasis(signal, 1, 0.98f, true)
//     · processing.hpp:123-125 — if (_rescale) numpy::scale(&m, 1.0f/32768.0f)
//   즉 "int16 원시 스케일을 공급하면 SDK가 ±1로 정규화"가 올바른 계약이며,
//   공급자가 추가로 1/32768을 곱하면 이중 스케일링(유효 진폭 ±3e-5,
//   밴드 에너지 -90dB)으로 특징 행렬이 전부 0 근처로 붕괴해 abnormal이
//   0.00 상수에 고착된다.
//   ※ int16_to_float(numpy.hpp:1479, 단순 캐스트)는 자체 get_data를
//     공급하는 이 실행 경로에 없다 — 스케일 판단의 근거로 쓰지 말 것.
//
// [에너지 게이트(RMS 문턱)를 두지 않는 이유 — 요약]
//   틱은 순간 버스트라 1초 창의 평균 RMS 문턱과 본질적으로 궁합이 나쁘고
//   (창 샘플링 타이밍에 따라 실제 틱도 무작위로 차단된다), 모델 발화 창과
//   창 에너지가 반상관을 이루면 이벤트가 구조적으로 0건이 된다. 게이트가
//   aiLevel을 0.00으로 덮어쓰면 앱에서는 "추론이 아예 안 도는 것"처럼
//   보이는 관측성 문제도 생긴다.
//   → 감지는 모델 confidence 단독으로 판정한다. 무음 오탐은 게이트가
//   아니라 모델 재학습(앱 기록 탭 "EI 재학습 오디오 내보내기" →
//   EI 스튜디오 → 라이브러리 재발급)으로 해결한다.
//   windowRms 계산은 판정과 무관한 순수 진단 채널(시리얼 로그 + diag
//   텔레메트리)로만 남긴다. 심층 진단이 필요하면 run_classifier 3번째
//   인자(debug)를 true로 바꿔 특징 행렬을 직접 관측할 수 있다(개발 전용).
//   배경·근거 상세: docs/FIRMWARE_NOTES.md 참조.

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
        // 무락 복사 (확정 설계):
        //   생산자(audioTask)가 락을 쓰지 않는 이상 소비자만 크리티컬
        //   섹션을 잡는 것은 동기화 효과가 0인 채로, 추론 윈도우 전체를
        //   복사하는 동안 core 1 인터럽트를 끄는 순수 비용이다.
        //   복사 경계의 극소수 샘플 tearing은 추론에 무해하다.

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

        // =============================================
        // WINDOW ENERGY (순수 진단 — 판정에 관여하지 않음)
        // =============================================
        // 추론 창의 RMS를 계산해 시리얼 [AI] 로그와 diag 텔레메트리로만
        // 노출한다. 트리거/aiLevel 판정에는 일절 사용하지 않는다 —
        // 에너지 게이트를 두지 않는 이유는 파일 상단 주석 참조.
        uint64_t windowSqSum = 0;
        for (size_t i = 0; i < EI_CLASSIFIER_RAW_SAMPLE_COUNT; i++) {
            int32_t s = inferenceBuffer[i];
            windowSqSum += (uint64_t)((int64_t)s * s);
        }
        uint32_t windowRms = (uint32_t)sqrt(
            (double)(windowSqSum / EI_CLASSIFIER_RAW_SAMPLE_COUNT));
        lastAiWindowRms = windowRms;

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
        float noiseProb = 0.0;   // 진단용 — abnormal과 합이 ~1이면 모델 정상 동작

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
            } else if(
                strcmp(
                    label,
                    "noise"
                ) == 0
            ) {

                noiseProb = value;
            }
        }

        // =============================================
        // RESULT
        // =============================================

        // 실시간 abnormal 레벨 게시 → 텔레메트리가 앱으로 전송.
        // 원시 confidence를 그대로 게시한다(마스킹·가공 금지):
        //   화면 값 = 모델의 실제 출력 = 이벤트 발화 판정값. 세 값이
        //   항상 일치해야 배포 빌드에서 모델 상태를 그대로 관측할 수 있다.
        lastAiLevel = confidence;

        // ── 진단 로그 (개발 빌드에서 모델 생사 확인용) ──
        // 값이 항상 0.00이면 입력/모델 문제, 값이 뛰는데 문턱을
        // 못 넘으면 AI_THRESHOLD 조정 대상으로 구분할 수 있다.
        // noise를 함께 찍는 이유: abnormal+noise≈1.00이면 추론 자체는
        // 정상(분포가 noise로 쏠린 것 = 학습 분포/입력 스케일 문제),
        // 합이 이상하면 모델/양자화 오류로 판독이 갈린다.
        // 모델 배포 버전(deploy v)을 병기해 라이브러리 교체와
        // 회귀를 추적한다.
        static bool aiBannerPrinted = false;
        if(!aiBannerPrinted) {
            aiBannerPrinted = true;
            Serial.printf(
                "[AI] model=%s deploy v%d, window=%dms, thr=%.2f, gain x%d, raw-input, no-gate\n",
                EI_CLASSIFIER_PROJECT_NAME,
                EI_CLASSIFIER_PROJECT_DEPLOY_VERSION,
                (int)(EI_CLASSIFIER_RAW_SAMPLE_COUNT * 1000 / EI_CLASSIFIER_FREQUENCY),
                (float)AI_THRESHOLD,
                1 << AUDIO_GAIN_SHIFT
            );
        }
        // rms 병기(순수 진단) — "abnormal이 소리 내용에 따라
        // 오르내리는가"(모델 정상성)를 창 에너지와 대조 판독한다.
        static unsigned long lastAiLog = 0;
        if(millis() - lastAiLog > 5000) {
            lastAiLog = millis();
            Serial.printf(
                "[AI] abnormal=%.2f noise=%.2f rms=%lu (thr=%.2f)\n",
                confidence,
                noiseProb,
                (unsigned long)windowRms,
                (float)AI_THRESHOLD
            );
        }

        // ── 이벤트 트리거: 모델 confidence 단독 판정 ──
        if(confidence > AI_THRESHOLD) {

            unsigned long now = millis();

            // ── 이벤트 트리거 (cooldown으로 중복 감지 방지) ──
            // 이벤트 저장 후에도 링 버퍼에 같은 소리가 남아 재감지되는 것을 차단
            static unsigned long lastTriggerMs = 0;

            if(!ticDetected &&
               (lastTriggerMs == 0 || now - lastTriggerMs >= TIC_COOLDOWN_MS)) {

                lastTriggerMs = now;

                lastConfidence = confidence;

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