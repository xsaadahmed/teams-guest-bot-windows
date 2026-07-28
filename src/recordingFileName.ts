import * as fs from 'fs';
import * as path from 'path';

/** Strip characters illegal in Windows file names and collapse whitespace. */
export function sanitizeRecordingBaseName(raw: string): string {
  return (
    raw
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.+$/g, '')
      .slice(0, 120) || ''
  );
}

export function timestampRecordingBaseName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Picks a unique base name for a new `.wav` in `dir`.
 * Uses `preferred` when free; otherwise `preferred_1`, `preferred_2`, …
 * Pass `excludeWavPath` when renaming an existing recording so it does not collide with itself.
 */
export function allocateUniqueRecordingBaseName(
  dir: string,
  preferred: string,
  excludeWavPath?: string,
): string {
  const base = sanitizeRecordingBaseName(preferred) || timestampRecordingBaseName();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const excludeResolved = excludeWavPath ? path.resolve(excludeWavPath) : null;
  const wavExists = (name: string) => {
    const candidate = path.join(dir, `${name}.wav`);
    if (excludeResolved && path.resolve(candidate) === excludeResolved) return false;
    return fs.existsSync(candidate);
  };

  if (!wavExists(base)) return base;

  for (let n = 1; n < 10_000; n++) {
    const candidate = `${base}_${n}`;
    if (!wavExists(candidate)) return candidate;
  }

  return `${base}_${timestampRecordingBaseName()}`;
}

const RECORDING_SIDEcar_SUFFIXES = ['.transcript.txt', '.captions.json'] as const;

/**
 * Renames a finished recording and any sidecar files to a meeting-title base name.
 * Returns the new `.wav` path (unchanged if rename is skipped or fails).
 */
export function renameRecordingArtifacts(
  currentWavPath: string,
  title: string,
  dir: string,
): string {
  const newBase = allocateUniqueRecordingBaseName(dir, title, currentWavPath);
  const oldBase = currentWavPath.replace(/\.wav$/i, '');
  const newWavPath = path.join(dir, `${newBase}.wav`);

  if (path.resolve(currentWavPath) === path.resolve(newWavPath)) {
    return currentWavPath;
  }

  const renames: Array<{ from: string; to: string }> = [
    { from: currentWavPath, to: newWavPath },
    ...RECORDING_SIDEcar_SUFFIXES.map((suffix) => ({
      from: `${oldBase}${suffix}`,
      to: `${newBase}${suffix}`,
    })),
  ];

  for (const { from, to } of renames) {
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, to);
  }

  const captionsPath = `${newBase}.captions.json`;
  if (fs.existsSync(captionsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(captionsPath, 'utf8')) as { recordingFile?: string };
      data.recordingFile = path.basename(newWavPath);
      fs.writeFileSync(captionsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // best-effort
    }
  }

  return newWavPath;
}
