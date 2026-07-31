import * as fs from 'fs';

interface WavPcmLayout {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
  fileSize: number;
}

function readAscii(buf: Buffer, start: number, len: number): string {
  return buf.toString('ascii', start, start + len);
}

/** Parse PCM WAV layout (finds fmt + data chunks; supports extra chunks before data). */
function parseWavPcmLayout(wavPath: string): WavPcmLayout | null {
  const fileSize = fs.statSync(wavPath).size;
  if (fileSize < 44) return null;

  const probeLen = Math.min(fileSize, 64 * 1024);
  const probe = Buffer.alloc(probeLen);
  const fd = fs.openSync(wavPath, 'r');
  try {
    const read = fs.readSync(fd, probe, 0, probeLen, 0);
    if (read < 44) return null;
    if (readAscii(probe, 0, 4) !== 'RIFF' || readAscii(probe, 8, 4) !== 'WAVE') return null;

    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let blockAlign = 0;
    let dataOffset = -1;
    let dataSize = 0;

    let offset = 12;
    while (offset + 8 <= read) {
      const chunkId = readAscii(probe, offset, 4);
      const chunkSize = probe.readUInt32LE(offset + 4);
      const chunkDataStart = offset + 8;
      if (chunkDataStart + chunkSize > fileSize) break;

      if (chunkId === 'fmt ' && chunkSize >= 16) {
        channels = probe.readUInt16LE(chunkDataStart + 2);
        sampleRate = probe.readUInt32LE(chunkDataStart + 4);
        blockAlign = probe.readUInt16LE(chunkDataStart + 12);
        bitsPerSample = probe.readUInt16LE(chunkDataStart + 14);
      } else if (chunkId === 'data') {
        dataOffset = chunkDataStart;
        dataSize = chunkSize;
        break;
      }

      offset = chunkDataStart + chunkSize + (chunkSize % 2);
    }

    if (dataOffset < 0 || !sampleRate || !channels || !bitsPerSample) return null;
    if (!blockAlign) blockAlign = (channels * bitsPerSample) / 8;

    const bytesOnDisk = Math.max(0, fileSize - dataOffset);
    dataSize = Math.min(dataSize, bytesOnDisk);

    return {
      sampleRate,
      channels,
      bitsPerSample,
      blockAlign,
      dataOffset,
      dataSize,
      fileSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Duration in milliseconds from a PCM WAV on disk. */
export function getWavDurationMs(wavPath: string): number | null {
  const layout = parseWavPcmLayout(wavPath);
  if (!layout || layout.dataSize <= 0) return null;
  const bytesPerSecond = layout.sampleRate * layout.blockAlign;
  if (!bytesPerSecond) return null;
  return (layout.dataSize / bytesPerSecond) * 1000;
}

/** Returns false if the file does not look like a playable PCM WAV. */
export function isValidWavFile(wavPath: string): boolean {
  const layout = parseWavPcmLayout(wavPath);
  if (!layout || layout.dataSize < layout.blockAlign) return false;
  const riffPayload = layout.fileSize - 8;
  if (riffPayload < 0) return false;
  return layout.dataOffset + layout.dataSize <= layout.fileSize;
}

/**
 * Truncate a PCM WAV so only the first `keepDurationMs` of audio remain.
 * Returns true if bytes were removed.
 */
export function trimWavKeepHeadMs(wavPath: string, keepDurationMs: number): boolean {
  if (!Number.isFinite(keepDurationMs) || keepDurationMs <= 0) return false;

  const layout = parseWavPcmLayout(wavPath);
  if (!layout || layout.dataSize <= layout.blockAlign) return false;

  const bytesPerMs = (layout.sampleRate * layout.blockAlign) / 1000;
  if (!bytesPerMs) return false;

  const fileDurationMs = (layout.dataSize / bytesPerMs);
  const cappedKeepMs = Math.min(keepDurationMs, fileDurationMs);
  if (cappedKeepMs <= 0) return false;

  let keepDataBytes = Math.floor(cappedKeepMs * bytesPerMs);
  if (layout.blockAlign > 1) {
    keepDataBytes -= keepDataBytes % layout.blockAlign;
  }

  if (keepDataBytes < layout.blockAlign) return false;
  if (keepDataBytes >= layout.dataSize) return false;

  const newFileSize = layout.dataOffset + keepDataBytes;
  const dataSizeOffset = layout.dataOffset - 4;

  const backupPath = `${wavPath}.trim-bak`;
  fs.copyFileSync(wavPath, backupPath);

  const fd = fs.openSync(wavPath, 'r+');
  try {
    fs.ftruncateSync(fd, newFileSize);

    const chunkSizeBuf = Buffer.alloc(4);
    chunkSizeBuf.writeUInt32LE(newFileSize - 8, 0);
    fs.writeSync(fd, chunkSizeBuf, 0, 4, 4);

    chunkSizeBuf.writeUInt32LE(keepDataBytes, 0);
    fs.writeSync(fd, chunkSizeBuf, 0, 4, dataSizeOffset);
  } finally {
    fs.closeSync(fd);
  }

  if (!isValidWavFile(wavPath)) {
    fs.copyFileSync(backupPath, wavPath);
    fs.unlinkSync(backupPath);
    return false;
  }

  fs.unlinkSync(backupPath);
  return true;
}
