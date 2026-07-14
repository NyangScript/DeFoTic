import { File } from 'expo-file-system';
import { GEMINI_CONFIG } from '../../constants/gemini-config';
import { TicEvent } from '../../types/tic-event';

export class GeminiAnalyzerService {
  /**
   * 틱 이벤트를 Gemini API로 전송하여 상황을 분석합니다.
   * @param event 분석할 틱 이벤트 객체
   * @returns 분석 결과가 포함된 업데이트된 틱 이벤트 객체
   */
  public async analyzeTicEvent(event: TicEvent): Promise<TicEvent> {
    try {
      const prompt = GEMINI_CONFIG.PROMPT_TEMPLATE
        .replace('{timestamp}', new Date(event.timestamp).toLocaleString('ko-KR'))
        .replace('{confidence}', typeof event.detectionConfidence === 'number' ? `${Math.round(event.detectionConfidence * 100)}%` : '정보 없음')
        .replace('{context}', event.context || '정보 없음');

      const parts: any[] = [{ text: prompt }];

      // 합본(muxing) 없이 영상과 음성을 별도 파트로 첨부한다.
      // Gemini inline 요청은 총 ~20MB 제한이므로 base64 팽창(×4/3)을 감안해
      // 원본 합산 14MB 예산 내에서만 첨부한다. 예산 초과 파일은 건너뛰어
      // 요청 전체가 400으로 실패하는 것을 방지한다.
      // (음성 틱이 핵심 근거이므로 용량이 작은 오디오를 우선 첨부)
      const FileSystem = require('expo-file-system/legacy');
      const INLINE_BUDGET_BYTES = 14 * 1024 * 1024;
      let usedBytes = 0;

      const attachMedia = async (path: string, mimeType: string) => {
        try {
          const info = await FileSystem.getInfoAsync(path);
          const size = info.exists && typeof info.size === 'number' ? info.size : 0;
          if (size === 0) {
            console.warn(`[Gemini] Skipping ${mimeType} — file missing or empty: ${path}`);
            return;
          }
          if (usedBytes + size > INLINE_BUDGET_BYTES) {
            console.warn(`[Gemini] Skipping ${mimeType} (${(size / 1e6).toFixed(1)}MB) — inline budget exceeded`);
            return;
          }
          const data = await FileSystem.readAsStringAsync(path, {
            encoding: FileSystem.EncodingType.Base64,
          });
          parts.unshift({ inlineData: { mimeType, data } });
          usedBytes += size;
        } catch (e) {
          console.error(`[Gemini] Failed to attach ${mimeType}:`, e);
        }
      };

      if (event.audioPath) await attachMedia(event.audioPath, 'audio/wav');   // IMA ADPCM WAV
      if (event.videoPath) await attachMedia(event.videoPath, 'video/avi');   // MJPEG AVI

      const requestBody = {
        contents: [
          {
            parts: parts,
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        }
      };

      const url = `${GEMINI_CONFIG.ENDPOINT}/${GEMINI_CONFIG.MODEL}:generateContent?key=${GEMINI_CONFIG.API_KEY}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Gemini API Error: ${errorData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textResponse) {
        throw new Error('응답을 파싱할 수 없습니다.');
      }

      // JSON 파싱 (마크다운 백틱 제거 시도)
      let cleanJson = textResponse;
      if (cleanJson.startsWith('```json')) {
        cleanJson = cleanJson.replace(/```json\n?/, '').replace(/```\n?$/, '');
      } else if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/```\n?/, '').replace(/```\n?$/, '');
      }

      const parsedAnalysis = JSON.parse(cleanJson);

      return {
        ...event,
        // 틱 유형 분류도 LLM 판단을 채택 (미분류 시 기존값 유지)
        type: ['vocal', 'motor', 'complex'].includes(parsedAnalysis.ticType)
          ? parsedAnalysis.ticType
          : event.type,
        aiAnalysis: {
          situation: parsedAnalysis.situation || '상황 추정 불가',
          environment: parsedAnalysis.environment || '환경 분석 불가',
          ticDetail: parsedAnalysis.ticDetail || '증상 상세 정보 없음',
          triggers: Array.isArray(parsedAnalysis.triggers) ? parsedAnalysis.triggers : [],
          recommendation: parsedAnalysis.recommendation || '권장사항 없음',
          severity: ['low', 'medium', 'high'].includes(parsedAnalysis.severity) ? parsedAnalysis.severity : 'medium',
          confidence: typeof parsedAnalysis.confidence === 'number' ? parsedAnalysis.confidence : 0.5,
        },
        analysisStatus: 'completed',
      };
    } catch (error) {
      console.error('Gemini Analysis Failed:', error);
      return {
        ...event,
        analysisStatus: 'failed',
      };
    }
  }
}

export const geminiAnalyzer = new GeminiAnalyzerService();
