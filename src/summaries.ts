import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { summarizeTranscript } from './llmClient';

export interface SummaryRecord {
  id: string;
  title: string;
  text: string;
  lastModified: string;
  /** Source transcript file name — stable key for "already summarized?" checks. */
  transcriptFileName: string;
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');

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
): Promise<SummaryRecord> {
  if (!isSafeTranscriptName(transcriptFileName)) {
    throw new Error('Invalid transcript file name.');
  }

  const existing = findSummaryByTranscript(transcriptFileName);
  if (existing) {
    return existing;
  }

  const transcriptPath = path.join(RECORDINGS_DIR, transcriptFileName);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error('Transcript not found.');
  }

  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  const title = transcriptFileName
    .replace(/\.named_transcript\.txt$/i, '')
    .replace(/\.transcript\.txt$/i, '');

  const text = await summarizeTranscript(transcript, title, model);
  const outName = summaryFileNameForTranscript(transcriptFileName);
  const now = new Date().toISOString();
  const record: SummaryRecord = {
    id: outName,
    title,
    text,
    lastModified: now,
    transcriptFileName,
  };

  ensureRecordingsDir();
  fs.writeFileSync(path.join(RECORDINGS_DIR, outName), JSON.stringify(record, null, 2), 'utf8');
  return record;
}
