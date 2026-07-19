import { Buffer } from 'buffer';
import { useEventStore } from '../../stores/useEventStore';
import { parseWavHeader, decodeImaAdpcm, buildPcmWav } from '../media/ImaAdpcm';

/**
 * Edge Impulse 온디바이스 모델 재학습 데이터셋 내보내기.
 *
 * 목적: 현재 탑재된 EI 모델은 실기기 마이크 분포로 검증/학습된 적이
 * 없다. 사용자가 라벨링한 실기기 오디오(확정=abnormal / 오탐=normal)를
 * EI 스튜디오가 바로 읽는 형태로 내보내, 실사용 분포로 재학습하는 루프의
 * 데이터 공급 계층이다.
 *
 * 구조:
 *  - 대상: userFeedback이 있는 이벤트의 대표 오디오(audioPath — 마지막
 *    파트, 틱 순간 포함). confirmed → abnormal/, false_positive → normal/
 *  - 변환: 기기 WAV는 IMA ADPCM(fmt 0x0011, 블록 256B/505샘플)인데 EI
 *    스튜디오 업로더는 PCM WAV만 안정 수용 → JS에서 표준 IMA ADPCM
 *    디코드 후 PCM16 WAV로 재포장한다 (인코더 역함수 — 펌웨어
 *    task.cpp encode_ima_adpcm_block과 동일 테이블).
 *  - 출력: SAF 폴더에 ei_dataset_<시각>/abnormal|normal/<eventId>.wav
 *    → EI 웹 업로더에서 폴더 라벨로 업로드 → 재학습 → 라이브러리 재발급.
 */

function fs() {
  return require('expo-file-system/legacy');
}

export interface EIExportResult {
  abnormal: number;   // confirmed 라벨 내보내기 성공 수
  normal: number;     // false_positive 라벨 내보내기 성공 수
  failed: string[];   // 변환/저장 실패 이벤트 id
}

class EIDatasetExporterService {
  /**
   * 라벨된 이벤트의 대표 오디오를 PCM WAV로 변환해 SAF 폴더에 내보낸다.
   * @returns null = 사용자가 폴더 선택 취소 / 그 외 결과 통계
   */
  public async exportToSaf(): Promise<EIExportResult | null> {
    const FileSystem = fs();
    const { StorageAccessFramework } = FileSystem;

    const events = useEventStore.getState().events.filter(
      e => e.userFeedback && e.audioPath,
    );
    const result: EIExportResult = { abnormal: 0, normal: 0, failed: [] };
    if (events.length === 0) return result;

    const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rootUri = await StorageAccessFramework.makeDirectoryAsync(
      perm.directoryUri,
      `ei_dataset_${stamp}`,
    );
    const abnormalUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'abnormal');
    const normalUri = await StorageAccessFramework.makeDirectoryAsync(rootUri, 'normal');

    // 직렬 처리 — 60초 파트 하나가 PCM 2MB 수준이라 병렬 변환은 힙 압박만 키운다
    for (const event of events) {
      try {
        const b64 = await FileSystem.readAsStringAsync(event.audioPath!, { encoding: 'base64' });
        const src = Buffer.from(b64, 'base64');
        const info = parseWavHeader(src);

        let pcmWav: Buffer;
        if (info.format === 0x0011) {
          // 기기 표준 경로 — IMA ADPCM 디코드
          if (info.channels !== 1) throw new Error('모노 오디오가 아닙니다');
          const samples = decodeImaAdpcm(
            src.subarray(info.dataOffset, info.dataOffset + info.dataSize),
            info.blockAlign,
          );
          if (samples.length === 0) throw new Error('디코드된 샘플이 없습니다');
          pcmWav = buildPcmWav(samples, info.sampleRate);
        } else if (info.format === 0x0001) {
          // 이미 PCM(향후 펌웨어 회귀 옵션 대비) — 원본 그대로
          pcmWav = src;
        } else {
          throw new Error(`지원하지 않는 WAV 포맷 0x${info.format.toString(16)}`);
        }

        const isAbnormal = event.userFeedback === 'confirmed';
        const fileUri = await StorageAccessFramework.createFileAsync(
          isAbnormal ? abnormalUri : normalUri,
          `${event.id}.wav`,
          'audio/wav',
        );
        await FileSystem.writeAsStringAsync(fileUri, pcmWav.toString('base64'), {
          encoding: 'base64',
        });

        if (isAbnormal) result.abnormal++;
        else result.normal++;
      } catch (e: any) {
        console.warn(`[EIDataset] export failed for ${event.id}:`, e?.message || e);
        result.failed.push(event.id);
      }
    }

    return result;
  }

  /** 내보내기 가능한 라벨 이벤트 수 (버튼 상태 표시용) */
  public labeledCount(): { abnormal: number; normal: number } {
    const events = useEventStore.getState().events;
    return {
      abnormal: events.filter(e => e.userFeedback === 'confirmed' && e.audioPath).length,
      normal: events.filter(e => e.userFeedback === 'false_positive' && e.audioPath).length,
    };
  }
}

export const eiDatasetExporter = new EIDatasetExporterService();
