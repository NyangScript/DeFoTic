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
        .replace('{type}', event.type)
        .replace('{intensity}', event.intensity.toString())
        .replace('{context}', event.context || '정보 없음');

      const parts: any[] = [{ text: prompt }];

      let base64Data = null;
      
      if (event.videoPath) {
        try {
          const FileSystem = require('expo-file-system/legacy');
          base64Data = await FileSystem.readAsStringAsync(event.videoPath, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } catch (e) {
          console.error('[Gemini] Failed to read video file for analysis:', e);
        }
      }

      // 영상이 base64로 제공된 경우 멀티모달 분석 추가
      if (base64Data) {
        parts.unshift({
          inlineData: {
            mimeType: 'video/avi', // ESP32-S3 uses AVI (MJPEG)
            data: base64Data,
          },
        });
      }

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
