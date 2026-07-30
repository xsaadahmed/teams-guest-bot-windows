import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  preprocessTranscript,
  formatStatsLine,
  EmptyTranscriptError,
  resolveOptions,
  type PreprocessOptions,
} from './transcriptPreprocess';
import { loadPreprocessInput, cleanArtifactPath } from './transcriptSidecars';
import 'dotenv/config';
import { summarizeTranscript } from './llmClient';
import { getEffectiveLlmConfig } from './userConfig';

export interface SummaryRecord {
  id: string;
  title: string;
  text: string;
  lastModified: string;
  /** Source transcript file name — stable key for "already summarized?" checks. */
  transcriptFileName: string;
  /** sha256 of the exact preprocessed string sent to the LLM. Cache key. */
  inputHash: string;
  /** Model that produced this summary — a model change invalidates it. */
  model: string;
  /** Preprocess options in effect — an options change invalidates it. */
  options: PreprocessOptions;
  /** Stats line from preprocessing, for debugging. */
  preprocessStats: string;
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');

/** Bot display name — filtered from the participants block. Approximate: bot.ts accepts a
 *  per-meeting displayName override, so a renamed bot won't be caught. Fix properly by writing
 *  the display name into .captions.json at finalizeTranscript() time. */
const BOT_DISPLAY_NAME = process.env.DEFAULT_DISPLAY_NAME || 'e& Assistant';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function ensureRecordingsDir(): void {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
}

function isSafeTranscriptName(fileName: string): boolean {
  return (
    path.basename(fileName) === fileName &&
    !fileName.includes('..') &&
    (fileName.endsWith('.transcript.txt') || fileName.endsWith('.named_transcript.txt'))
  );
}

/** Map a transcript file to its companion summary JSON file. */
export function summaryFileNameForTranscript(transcriptFileName: string): string {
  if (transcriptFileName.endsWith('.named_transcript.txt')) {
    return `${transcriptFileName.slice(0, -'.named_transcript.txt'.length)}.named_summary.json`;
  }
  if (transcriptFileName.endsWith('.transcript.txt')) {
    return `${transcriptFileName.slice(0, -'.transcript.txt'.length)}.summary.json`;
  }
  throw new Error('Unsupported transcript file name.');
}

function summaryIdFromFile(fileName: string): string {
  return fileName;
}

function readSummaryFile(filePath: string, fileName: string): SummaryRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SummaryRecord>;
    if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
    const transcriptFileName =
      typeof raw.transcriptFileName === 'string' && raw.transcriptFileName
        ? raw.transcriptFileName
        : '';
    const title =
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : fileName.replace(/\.summary\.json$/i, '').replace(/\.named_summary\.json$/i, '');
    const stat = fs.statSync(filePath);
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : summaryIdFromFile(fileName),
      title,
      text: raw.text,
      lastModified:
        typeof raw.lastModified === 'string' && raw.lastModified
          ? raw.lastModified
          : stat.mtime.toISOString(),
      transcriptFileName,
      inputHash: typeof raw.inputHash === 'string' ? raw.inputHash : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      options: (raw.options ?? {}) as PreprocessOptions,
      preprocessStats: typeof raw.preprocessStats === 'string' ? raw.preprocessStats : '',
    };
  } catch {
    return null;
  }
}

/** All saved summaries, newest first. */
export function listSummaries(): SummaryRecord[] {
  ensureRecordingsDir();
  const items: SummaryRecord[] = [];
  for (const entry of fs.readdirSync(RECORDINGS_DIR)) {
    if (!entry.endsWith('.summary.json') && !entry.endsWith('.named_summary.json')) continue;
    const record = readSummaryFile(path.join(RECORDINGS_DIR, entry), entry);
    if (record) items.push(record);
  }
  items.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
  return items;
}

export function findSummaryByTranscript(transcriptFileName: string): SummaryRecord | null {
  const fileName = summaryFileNameForTranscript(transcriptFileName);
  const filePath = path.join(RECORDINGS_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return readSummaryFile(filePath, fileName);
}

export function getSummaryById(id: string): SummaryRecord | null {
  if (path.basename(id) !== id || id.includes('..')) return null;
  const filePath = path.join(RECORDINGS_DIR, id);
  if (!fs.existsSync(filePath)) {
    // Also allow lookup by transcript file name.
    try {
      return findSummaryByTranscript(id);
    } catch {
      return null;
    }
  }
  return readSummaryFile(filePath, id);
}

/**
 * Generate (or refuse duplicate) a summary for a transcript file in Recordings/.
 * Manual / user-initiated only — callers must not auto-trigger this.
 */
export async function generateSummaryForTranscript(
  transcriptFileName: string,
  model?: string,
  force = false,
): Promise<SummaryRecord> {
  if (!isSafeTranscriptName(transcriptFileName)) {
    throw new Error('Invalid transcript file name.');
  }

  const transcriptPath = path.join(RECORDINGS_DIR, transcriptFileName);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error('Transcript not found.');
  }

  const title = transcriptFileName
    .replace(/\.named_transcript\.txt$/i, '')
    .replace(/\.transcript\.txt$/i, '');

  // Preprocess first: the cleaned text is the cache key, so we cannot decide staleness
  // without it. This is local CPU only — no LLM call happens here.
  const options = resolveOptions({ excludeSpeakers: [BOT_DISPLAY_NAME] });
  let clean: string;
  let statsLine: string;
  try {
    const result = preprocessTranscript(loadPreprocessInput(transcriptPath), options);
    clean = result.text;
    statsLine = formatStatsLine(result.stats);
    console.log(`[summaries] ${transcriptFileName}: ${statsLine}`);
    fs.writeFileSync(cleanArtifactPath(transcriptPath), clean, 'utf8');
  } catch (err) {
    if (err instanceof EmptyTranscriptError) throw new Error(err.message);
    throw err;
  }

  const resolvedModel = model?.trim() || getEffectiveLlmConfig().model || '';
  const inputHash = sha256(clean);

  const existing = findSummaryByTranscript(transcriptFileName);
  if (
    !force &&
    existing &&
    existing.inputHash === inputHash &&
    existing.model === resolvedModel
  ) {
    console.log(`[summaries] Reusing cached summary for ${transcriptFileName} (input unchanged).`);
    return existing;
  }

  const text = await summarizeTranscript(clean, title, model);
  const outName = summaryFileNameForTranscript(transcriptFileName);
  const record: SummaryRecord = {
    id: outName,
    title,
    text,
    lastModified: new Date().toISOString(),
    transcriptFileName,
    inputHash,
    model: resolvedModel,
    options,
    preprocessStats: statsLine,
  };

  ensureRecordingsDir();
  fs.writeFileSync(path.join(RECORDINGS_DIR, outName), JSON.stringify(record, null, 2), 'utf8');
  return record;
}