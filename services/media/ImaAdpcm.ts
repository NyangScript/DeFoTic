import { Buffer } from 'buffer';

/**
 * IMA ADPCM WAV 공용 코덱 계층.
 *
 * 기기 오디오는 IMA ADPCM(fmt 0x0011, 블록 256B/505샘플) WAV다. Android
 * 기본 플레이어·브라우저 <audio>·expo-audio 모두 이 포맷을 신뢰성 있게
 * 디코드하지 못하므로, 재생/내보내기 전 JS에서 표준 PCM16으로 변환한다.
 * (디코더는 펌웨어 task.cpp encode_ima_adpcm_block의 정확한 역함수 —
 *  동일한 표준 IMA 테이블 사용)
 *
 * 소비자:
 *  - EIDatasetExporter: EI 스튜디오 업로드용 PCM WAV 변환
 *  - FrameViewer(인앱 동기 재생): ADPCM → PCM WAV 캐시 → expo-audio
 *  - 의사 웹 뷰어: ADPCM → Float32 → WebAudio AudioBuffer
 *
 * Buffer 외 의존성이 없어 네이티브/웹 양쪽에서 동일하게 동작한다.
 */

// ── IMA ADPCM 표준 테이블 (펌웨어 인코더와 동일) ──
const IMA_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
}

/** RIFF 청크를 순회해 fmt/data를 찾는다 (펌웨어 fact 청크 포함 임의 배치 허용) */
export function parseWavHeader(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('WAV 형식이 아닙니다');
  }
  let pos = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataSize'> | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        blockAlign: buf.readUInt16LE(pos + 20),
      };
    } else if (id === 'data') {
      dataOffset = pos + 8;
      dataSize = Math.min(size, buf.length - dataOffset);
      break;
    }
    pos += 8 + size + (size % 2); // 홀수 크기 청크는 1B 패딩
  }
  if (!fmt || dataOffset < 0) throw new Error('WAV 청크 구조가 손상되었습니다');
  return { ...fmt, dataOffset, dataSize };
}

/** IMA ADPCM 모노 블록 스트림 → PCM16 샘플 배열 */
export function decodeImaAdpcm(data: Buffer, blockAlign: number): Int16Array {
  const samplesPerBlock = (blockAlign - 4) * 2 + 1;
  const blockCount = Math.floor(data.length / blockAlign);
  const out = new Int16Array(blockCount * samplesPerBlock);
  let outIdx = 0;

  for (let b = 0; b < blockCount; b++) {
    const base = b * blockAlign;
    let predictor = data.readInt16LE(base);
    let index = data[base + 2];
    if (index > 88) index = 88;
    out[outIdx++] = predictor;

    for (let i = 4; i < blockAlign; i++) {
      const byte = data[base + i];
      for (let nib = 0; nib < 2; nib++) {
        const code = nib === 0 ? byte & 0x0f : byte >> 4;
        const step = IMA_STEP_TABLE[index];

        // 표준 IMA 복원: diff = step/8 + (code의 각 비트에 따라 step/1,2,4 합산)
        let diff = step >> 3;
        if (code & 4) diff += step;
        if (code & 2) diff += step >> 1;
        if (code & 1) diff += step >> 2;
        if (code & 8) predictor -= diff;
        else predictor += diff;

        if (predictor > 32767) predictor = 32767;
        else if (predictor < -32768) predictor = -32768;

        index += IMA_INDEX_TABLE[code];
        if (index < 0) index = 0;
        else if (index > 88) index = 88;

        out[outIdx++] = predictor;
      }
    }
  }
  return out.subarray(0, outIdx) as Int16Array;
}

/** PCM16 모노 샘플 → 표준 44바이트 헤더 WAV */
export function buildPcmWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

export interface DecodedAudio {
  sampleRate: number;
  samples: Int16Array;
  /** 초 단위 실제 길이 */
  durationSec: number;
}

/**
 * 기기 WAV(IMA ADPCM 또는 PCM) 버퍼 → PCM16 샘플로 통합 디코드.
 * 재생 계층(인앱/웹)의 단일 진입점.
 */
export function decodeDeviceWav(src: Buffer): DecodedAudio {
  const info = parseWavHeader(src);
  let samples: Int16Array;
  if (info.format === 0x0011) {
    if (info.channels !== 1) throw new Error('모노 오디오가 아닙니다');
    samples = decodeImaAdpcm(
      src.subarray(info.dataOffset, info.dataOffset + info.dataSize),
      info.blockAlign,
    );
  } else if (info.format === 0x0001) {
    const bytes = src.subarray(info.dataOffset, info.dataOffset + info.dataSize);
    samples = new Int16Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
  } else {
    throw new Error(`지원하지 않는 WAV 포맷 0x${info.format.toString(16)}`);
  }
  if (samples.length === 0) throw new Error('디코드된 샘플이 없습니다');
  return {
    sampleRate: info.sampleRate,
    samples,
    durationSec: samples.length / info.sampleRate,
  };
}
