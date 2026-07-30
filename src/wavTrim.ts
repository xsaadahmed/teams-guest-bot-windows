import * as fs from 'fs';

/** Matches WasapiLoopbackRecorder output (16 kHz, 16-bit mono PCM). */
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

/**
 * Truncate a PCM WAV so only the first `keepDurationMs` of audio remain.
 * Returns true if bytes were removed.
 */
export function trimWavKeepHeadMs(wavPath: string, keepDurationMs: number): boolean {
  if (!Number.isFinite(keepDurationMs) || keepDurationMs <= 0) return false;

  const stat = fs.statSync(wavPath);
  if (stat.size <= WAV_HEADER_BYTES) return false;

  const bytesPerMs = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
  let keepDataBytes = Math.floor(keepDurationMs * bytesPerMs);
  keepDataBytes -= keepDataBytes % BYTES_PER_SAMPLE;

  const newSize = WAV_HEADER_BYTES + keepDataBytes;
  if (newSize >= stat.size) return false;

  const fd = fs.openSync(wavPath, 'r+');
  try {
    fs.ftruncateSync(fd, newSize);
    const chunkSizeBuf = Buffer.alloc(4);
    chunkSizeBuf.writeUInt32LE(newSize - 8, 0);
    fs.writeSync(fd, chunkSizeBuf, 0, 4, 4);
    chunkSizeBuf.writeUInt32LE(keepDataBytes, 0);
    fs.writeSync(fd, chunkSizeBuf, 0, 4, 40);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}
