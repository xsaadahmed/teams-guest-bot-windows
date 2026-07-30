import * as fs from 'fs';
import * as path from 'path';
import type { CaptionsSidecar, NamedSidecar, PreprocessInput } from './transcriptPreprocess';

/**
 * File-system side of preprocessing. Kept out of transcriptPreprocess.ts so that module stays
 * pure and unit-testable; this is the only place that knows how sidecars are named on disk.
 *
 * Layout written by the rest of the app:
 *   <base>.wav
 *   <base>.captions.json           (bot.ts finalizeTranscript)
 *   <base>.transcript.txt          (bot.ts formatTranscript)
 *   <base>.named_transcript.txt    (transcribe_with_names.py)
 *   <base>.named_transcript.json   (transcribe_with_names.py)
 */

/** Strip the transcript suffix to get the shared `<base>`. */
export function transcriptBase(transcriptPath: string): string {
  return transcriptPath
    .replace(/\.named_transcript\.txt$/i, '')
    .replace(/\.transcript\.txt$/i, '');
}

/** `X.transcript.txt` -> `X.transcript.clean.txt` (deliberately NOT `*.transcript.txt`, which
 *  would make the debug artifact show up in GET /transcripts and be summarizable itself). */
export function cleanArtifactPath(transcriptPath: string): string {
  return transcriptPath.replace(/\.txt$/i, '.clean.txt');
}

function readJsonIfPresent<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    console.warn(`[preprocess] Ignoring unreadable sidecar ${path.basename(filePath)}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build the preprocessor input for a transcript file. Only the sidecar matching the transcript
 * kind is loaded: a `.transcript.txt` must not be re-timed from Whisper segments, and vice versa.
 * Uploaded transcripts have neither and fall through to text-only parsing.
 */
export function loadPreprocessInput(transcriptPath: string): PreprocessInput {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const base = transcriptBase(transcriptPath);
  const isNamed = /\.named_transcript\.txt$/i.test(transcriptPath);

  return {
    raw,
    captionsSidecar: isNamed ? null : readJsonIfPresent<CaptionsSidecar>(`${base}.captions.json`),
    namedSidecar: isNamed ? readJsonIfPresent<NamedSidecar>(`${base}.named_transcript.json`) : null,
  };
}
