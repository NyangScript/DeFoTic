import { Buffer } from 'buffer';

/**
 * MJPEG AVI 인덱스 공용 파서.
 *
 * 제공 기능:
 *  1. avih의 usPerFrame(절대 오프셋 32, LE u32)을 파싱해 실측 재생 길이
 *     (durationSec = totalFrames × usPerFrame / 1e6)를 제공한다. 펌웨어
 *     finalizeCurrentSegment가 세그먼트 실경과시간으로 이 값을 기록하므로
 *     (task.cpp), 타임라인이 고정 60초가 아니라 실측 길이로 표기된다.
 *  2. idx1 전체 엔트리를 보존해 임의 프레임 접근(오디오 동기 재생의
 *     currentTime → frameIdx → 오프셋 조회)을 지원한다. 60초 파트 기준
 *     엔트리 수천 개 × 8B = 수십 KB — 메모리 부담 없음.
 *  3. I/O를 ByteSource 인터페이스로 추상화 — 네이티브(expo-file-system
 *     부분 읽기)와 웹(Blob.slice)이 같은 파서를 공유한다.
 *
 * 파일 포맷 계약 (Hardware/defotic/task.cpp):
 *  - 헤더 2048B 예약, avih 본문 시작 = 절대 오프셋 32 (usPerFrame),
 *    dwTotalFrames = 절대 오프셋 48 (LE u32)
 *  - 2048: 'LIST' + size + 'movi' → movi 데이터 시작 = 2060
 *  - 프레임: '00dc' + size(LE) + JPEG 데이터 (홀수 크기는 1B 패딩)
 *  - 종단: 'idx1' + size + 엔트리 16B×N ('00dc', flags, offset, size)
 *    offset은 movi 데이터 시작(2060) 기준 청크 헤더 위치
 */

export const MOVI_DATA_START = 2060;

/** 플랫폼 중립 부분 읽기 소스 */
export interface ByteSource {
  size(): Promise<number>;
  read(position: number, length: number): Promise<Buffer>;
  /** 스테일 인덱스 방지용 식별자 (파일 경로/이름) */
  id: string;
}

/** expo-file-system 기반 네이티브 ByteSource */
export function fileByteSource(path: string): ByteSource {
  const FileSystem = require('expo-file-system/legacy');
  return {
    id: path,
    async size() {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists || typeof info.size !== 'number') {
        throw new Error('파일이 존재하지 않습니다');
      }
      return info.size;
    },
    async read(position: number, length: number) {
      const b64 = await FileSystem.readAsStringAsync(path, {
        encoding: 'base64',
        position,
        length,
      });
      return Buffer.from(b64, 'base64');
    },
  };
}

/** 브라우저 Blob 기반 ByteSource (의사 웹 뷰어용) */
export function blobByteSource(blob: { size: number; slice: (s: number, e: number) => any }, id: string): ByteSource {
  return {
    id,
    async size() {
      return blob.size;
    },
    async read(position: number, length: number) {
      const ab = await blob.slice(position, position + length).arrayBuffer();
      return Buffer.from(new Uint8Array(ab));
    },
  };
}

export interface FrameIndexEntry {
  /** JPEG 데이터의 파일 내 절대 위치 */
  dataPos: number;
  dataSize: number;
}

export interface AviIndex {
  /** idx1 전체 프레임 엔트리 (시간순, 손상 엔트리는 dataSize 0) */
  entries: FrameIndexEntry[];
  totalFrames: number;
  /** avih 실측 프레임 간격(us). 펌웨어가 실경과시간으로 기록 */
  usPerFrame: number;
  /** 실측 재생 길이(초) — totalFrames × usPerFrame / 1e6 */
  durationSec: number;
  /** 파싱된 소스 식별자 — 스테일 인덱스 조합 차단 태그 */
  sourceId: string;
}

/**
 * AVI 인덱스 파싱 — idx1 정공법. 어떤 실패도 throw로 끝난다
 * (호출자가 폴백 UI 처리).
 */
export async function parseAviIndex(source: ByteSource): Promise<AviIndex> {
  const fileSize = await source.size();
  if (fileSize < MOVI_DATA_START + 24) {
    throw new Error('파일이 비어 있거나 너무 작습니다');
  }

  // 1. 헤더 (RIFF 검증 + usPerFrame + 프레임 수)
  const head = await source.read(0, 64);
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'AVI ') {
    throw new Error('AVI 형식이 아닙니다');
  }
  const totalFrames = head.readUInt32LE(48);
  if (totalFrames === 0) throw new Error('프레임이 없는 세그먼트입니다');
  if (totalFrames > 100_000) throw new Error('프레임 수가 비정상적입니다');

  // 실측 프레임 간격 — 0/비정상값이면 5fps(펌웨어 폴백값과 동일)로 방어
  let usPerFrame = head.readUInt32LE(32);
  if (usPerFrame < 10_000 || usPerFrame > 1_000_000) usPerFrame = 200_000;
  const durationSec = (totalFrames * usPerFrame) / 1e6;

  // 2. idx1 위치 역산 → 검증 (펌웨어는 idx1을 파일 마지막에 기록)
  const idxBodySize = totalFrames * 16;
  const idxHeaderPos = fileSize - idxBodySize - 8;
  let entriesBuf: Buffer | null = null;
  if (idxHeaderPos > MOVI_DATA_START) {
    const idxHead = await source.read(idxHeaderPos, 8);
    if (
      idxHead.toString('latin1', 0, 4) === 'idx1' &&
      idxHead.readUInt32LE(4) === idxBodySize
    ) {
      entriesBuf = await source.read(idxHeaderPos + 8, idxBodySize);
    }
  }
  if (!entriesBuf) {
    throw new Error('프레임 인덱스(idx1)를 찾지 못했습니다 (손상/미완성 세그먼트)');
  }

  // 3. 전체 엔트리 보존 — 손상 엔트리는 dataSize 0으로 마킹해 자리 유지
  //    (프레임 번호 ↔ 시간축 매핑이 어긋나지 않게 한다)
  const entries: FrameIndexEntry[] = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const off = i * 16;
    let dataPos = 0;
    let dataSize = 0;
    if (entriesBuf.toString('latin1', off, off + 4) === '00dc') {
      const chunkOffset = entriesBuf.readUInt32LE(off + 8);
      const size = entriesBuf.readUInt32LE(off + 12);
      const pos = MOVI_DATA_START + chunkOffset + 8; // '00dc'+size 헤더 8B 건너뜀
      // 파일 경계·크기 위생 검사 — 손상 인덱스가 거대 읽기를 유발하지 않게
      if (size > 0 && size <= 512 * 1024 && pos + size <= fileSize) {
        dataPos = pos;
        dataSize = size;
      }
    }
    entries[i] = { dataPos, dataSize };
  }

  if (!entries.some(e => e.dataSize > 0)) {
    throw new Error('표시할 수 있는 프레임이 없습니다');
  }
  return { entries, totalFrames, usPerFrame, durationSec, sourceId: source.id };
}

/**
 * 프레임 JPEG 읽기 — SOI 매직 검증 포함. 손상 프레임이면 throw.
 */
export async function readFrameJpeg(
  source: ByteSource,
  entry: FrameIndexEntry,
): Promise<Buffer> {
  if (entry.dataSize === 0) throw new Error('손상된 프레임입니다');
  const buf = await source.read(entry.dataPos, entry.dataSize);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('JPEG 아님');
  }
  return buf;
}

/**
 * 재생 시각(초) → 가장 가까운 유효 프레임 인덱스.
 * 해당 인덱스가 손상 엔트리면 앞쪽으로 최대 5칸 되짚어 유효 프레임을 찾는다.
 */
export function frameIndexAt(index: AviIndex, timeSec: number): number {
  let idx = Math.floor((timeSec * 1e6) / index.usPerFrame);
  if (idx < 0) idx = 0;
  if (idx >= index.totalFrames) idx = index.totalFrames - 1;
  for (let back = 0; back < 6 && idx - back >= 0; back++) {
    if (index.entries[idx - back].dataSize > 0) return idx - back;
  }
  return idx;
}
