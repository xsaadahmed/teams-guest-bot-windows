/**
 * Transcript preprocessing: turns a raw transcript file (Teams live captions, Whisper+names,
 * or a user-uploaded .txt) into a cleaner string for LLM summarization.
 *
 * Deliberately PURE: no fs, no network, no prompts, no model knowledge. Callers read files and
 * decide what to do with the result. That keeps every step unit-testable and keeps the cache-key
 * / prompting concerns in summaries.ts where they belong.
 *
 * Three input shapes are supported:
 *   1. `X.transcript.txt`        - bot.ts formatTranscript() output; sidecar `X.captions.json`
 *   2. `X.named_transcript.txt`  - transcribe_with_names.py output; sidecar `X.named_transcript.json`
 *   3. an uploaded .txt          - arbitrary prose, no structure, no sidecar
 *
 * When a sidecar is available we build turns from IT rather than from the rendered text, because
 * the rendered text drops tEndMs and gap-based turn merging needs real end times.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Turn {
  /** Milliseconds from recording start. null when the source had no timestamp. */
  tStartMs: number | null;
  tEndMs: number | null;
  speaker: string;
  text: string;
}

export type TranscriptSource = 'captions' | 'named' | 'unstructured';

export interface PreprocessOptions {
  /** NFKC + zero-width strip + smart-quote fold + whitespace collapse. */
  normalizeText: boolean;
  /** Replace speaker 'Unknown' with the previous turn's speaker. */
  carryForwardUnknownSpeaker: boolean;
  /** Drop turns whose text duplicates (or is a strict prefix of) an adjacent turn. */
  dedupeAdjacent: boolean;
  /** Strip a repeated token run where turn A's tail == turn B's head. */
  stripBoundaryOverlap: boolean;
  /** Minimum repeated tokens before an overlap is treated as real. */
  minOverlapTokens: number;
  /** Merge consecutive same-speaker turns separated by a short gap. */
  mergeTurns: boolean;
  /** Max silence (ms) between turns that still counts as one utterance. */
  mergeGapMs: number;
  /** Never let a merged turn exceed this many characters. */
  maxMergedChars: number;
  /** Remove um / uh / er / mm / hmm. Pure vocalizations only. */
  stripVocalizations: boolean;
  /** OFF by default: like / you know / so / well / right. Ambiguous, needs evidence. */
  stripDiscourseFillers: boolean;
  /** Drop turns that are empty or punctuation-only after cleaning. */
  dropEmptyTurns: boolean;
  /** OFF by default: drop single-token turns ("1.", "Dot com."). A bare "Yeah" can be a decision. */
  dropSingleTokenTurns: boolean;
  /** Speakers removed from the participants block (e.g. the bot's own display name). */
  excludeSpeakers: string[];
  /** Where the roster goes. 'top' anchors names before the model reads garbled ASR. */
  participantsPosition: 'top' | 'bottom' | 'omit';
  /** Emit [MM:SS] before each merged turn. */
  includeTimestamps: boolean;
}

export interface StepStat {
  step: string;
  turnsIn: number;
  turnsOut: number;
  charsIn: number;
  charsOut: number;
  /** Step-specific detail, e.g. how many overlaps were stripped. */
  hits: number;
}

export interface PreprocessStats {
  source: TranscriptSource;
  usedSidecar: boolean;
  turnsIn: number;
  turnsOut: number;
  charsIn: number;
  charsOut: number;
  participantsIn: number;
  participantsOut: number;
  steps: StepStat[];
}

export interface PreprocessResult {
  text: string;
  turns: Turn[];
  participants: string[];
  stats: PreprocessStats;
}

/** Shape of `X.captions.json` written by bot.ts finalizeTranscript(). */
export interface CaptionsSidecar {
  recordingFile?: string;
  participants?: string[];
  captions?: Array<{
    speaker?: string;
    text?: string;
    tStartMs?: number;
    tEndMs?: number;
  }>;
}

/** Shape of `X.named_transcript.json` written by transcribe_with_names.py (seconds, not ms). */
export interface NamedSidecar {
  language?: string;
  segments?: Array<{
    speaker?: string;
    text?: string;
    start?: number;
    end?: number;
  }>;
}

export class EmptyTranscriptError extends Error {
  readonly code = 'EMPTY_TRANSCRIPT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'EmptyTranscriptError';
  }
}

// ---------------------------------------------------------------------------
// Defaults (env-overridable; see DEFAULT_OPTIONS note in summaries.ts)
// ---------------------------------------------------------------------------

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEFAULT_OPTIONS: PreprocessOptions = {
  normalizeText: true,
  carryForwardUnknownSpeaker: true,
  dedupeAdjacent: true,
  stripBoundaryOverlap: true,
  minOverlapTokens: envInt('PREPROCESS_MIN_OVERLAP_TOKENS', 3),
  mergeTurns: envBool('PREPROCESS_MERGE_TURNS', true),
  mergeGapMs: envInt('PREPROCESS_MERGE_GAP_MS', 2000),
  maxMergedChars: envInt('PREPROCESS_MAX_MERGED_CHARS', 1200),
  stripVocalizations: envBool('PREPROCESS_STRIP_VOCALIZATIONS', true),
  stripDiscourseFillers: envBool('PREPROCESS_STRIP_DISCOURSE_FILLERS', false),
  dropEmptyTurns: true,
  dropSingleTokenTurns: envBool('PREPROCESS_DROP_SINGLE_TOKEN_TURNS', false),
  excludeSpeakers: [],
  participantsPosition: 'top',
  includeTimestamps: envBool('PREPROCESS_INCLUDE_TIMESTAMPS', true),
};

export function resolveOptions(overrides?: Partial<PreprocessOptions>): PreprocessOptions {
  return { ...DEFAULT_OPTIONS, ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------
// Text normalization primitives
// ---------------------------------------------------------------------------

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u00AD]/g;

export function normalizeString(input: string): string {
  let s = input.normalize('NFKC');
  s = s.replace(ZERO_WIDTH, '');
  s = s.replace(/[\u2018\u2019\u02BC]/g, "'");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/[\u2013\u2014]/g, '-');
  s = s.replace(/\u2026/g, '...');
  s = s.replace(/[\t\f\v\u00A0]/g, ' ');
  s = s.replace(/ {2,}/g, ' ');
  return s.trim();
}

/** Lowercased, punctuation-stripped token list used only for comparison, never for output. */
function compareTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Raw tokens preserving punctuation, so we can rebuild text after slicing. */
function rawTokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function isPunctuationOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `[MM:SS] Speaker Name: text` or `[HH:MM:SS] Speaker Name: text`. */
const TURN_LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,80}?):\s*(.*)$/;
/** Section markers written by bot.ts / transcribe_with_names.py. */
const SECTION_MARKER = /^-{2,}\s*.*?\s*-{2,}$/;
const PARTICIPANTS_MARKER = /^-{2,}\s*participants\b.*-{2,}$/i;
const LANGUAGE_LINE = /^detected language:/i;

function parseClock(clock: string): number {
  const parts = clock.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  return (parts[0] * 60 + parts[1]) * 1000;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

interface ParsedText {
  turns: Turn[];
  participants: string[];
  /** Fraction of candidate content lines that matched the turn pattern. */
  structureRatio: number;
}

/**
 * Parse a rendered transcript. Tolerates both header variants and both participants-marker
 * spellings. Lines that look like content but do not match the turn pattern are counted so the
 * caller can decide the file is unstructured (an uploaded .txt) and bail out of turn-level work.
 */
export function parseTranscriptText(raw: string): ParsedText {
  const lines = raw.split(/\r?\n/);
  const turns: Turn[] = [];
  const participants: string[] = [];

  let inParticipants = false;
  let contentLines = 0;
  let matchedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (PARTICIPANTS_MARKER.test(trimmed)) {
      inParticipants = true;
      continue;
    }
    if (SECTION_MARKER.test(trimmed)) {
      inParticipants = false;
      continue;
    }
    if (LANGUAGE_LINE.test(trimmed)) continue;

    if (inParticipants) {
      if (!/^not captured\.?$/i.test(trimmed)) participants.push(trimmed);
      continue;
    }

    // bot.ts writes this literal when nothing was captured - it is not meeting content.
    if (/^no captions were captured\.?$/i.test(trimmed)) continue;

    contentLines++;
    const m = TURN_LINE.exec(trimmed);
    if (m) {
      matchedLines++;
      turns.push({
        tStartMs: parseClock(m[1]),
        tEndMs: null,
        speaker: m[2].trim(),
        text: m[3].trim(),
      });
    } else {
      // Keep it as a speakerless turn so unstructured input survives intact.
      turns.push({ tStartMs: null, tEndMs: null, speaker: '', text: trimmed });
    }
  }

  return {
    turns,
    participants,
    structureRatio: contentLines === 0 ? 0 : matchedLines / contentLines,
  };
}

export function turnsFromCaptionsSidecar(sidecar: CaptionsSidecar): Turn[] {
  return (sidecar.captions ?? [])
    .map((c) => ({
      tStartMs: typeof c.tStartMs === 'number' ? c.tStartMs : null,
      tEndMs: typeof c.tEndMs === 'number' ? c.tEndMs : null,
      speaker: (c.speaker ?? '').trim() || 'Unknown',
      text: (c.text ?? '').trim(),
    }))
    .sort((a, b) => (a.tStartMs ?? 0) - (b.tStartMs ?? 0));
}

export function turnsFromNamedSidecar(sidecar: NamedSidecar): Turn[] {
  return (sidecar.segments ?? [])
    .map((s) => ({
      tStartMs: typeof s.start === 'number' ? Math.round(s.start * 1000) : null,
      tEndMs: typeof s.end === 'number' ? Math.round(s.end * 1000) : null,
      speaker: (s.speaker ?? '').trim() || 'Unknown',
      text: (s.text ?? '').trim(),
    }))
    .sort((a, b) => (a.tStartMs ?? 0) - (b.tStartMs ?? 0));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StepOutcome {
  turns: Turn[];
  hits: number;
}

function stepNormalize(turns: Turn[]): StepOutcome {
  let hits = 0;
  const out = turns.map((t) => {
    const text = normalizeString(t.text);
    const speaker = normalizeString(t.speaker);
    if (text !== t.text || speaker !== t.speaker) hits++;
    return { ...t, text, speaker };
  });
  return { turns: out, hits };
}

/**
 * captionTracker.ts emits the literal 'Unknown' when [data-tid="author"] is missing, and its
 * update path (`ev.speaker || existing.speaker`) lets that truthy string clobber a real name.
 * This is a mitigation, not the fix - the fix belongs in captionTracker.ts.
 */
function stepCarryForwardUnknown(turns: Turn[]): StepOutcome {
  let hits = 0;
  let last = '';
  const out = turns.map((t) => {
    if (t.speaker && t.speaker !== 'Unknown') {
      last = t.speaker;
      return t;
    }
    if (last) {
      hits++;
      return { ...t, speaker: last };
    }
    return t;
  });
  return { turns: out, hits };
}

/**
 * Teams can re-render a caption line into a fresh DOM element, which defeats captionTracker's
 * identity-based dedup and produces two entries where one is a prefix of the other.
 */
function stepDedupeAdjacent(turns: Turn[]): StepOutcome {
  const out: Turn[] = [];
  let hits = 0;

  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (!prev || prev.speaker !== turn.speaker) {
      out.push(turn);
      continue;
    }

    const a = compareTokens(prev.text).join(' ');
    const b = compareTokens(turn.text).join(' ');
    if (!a || !b) {
      out.push(turn);
      continue;
    }

    if (a === b || b.startsWith(a)) {
      // turn is the fuller version - keep it, but keep the earlier start time.
      hits++;
      out[out.length - 1] = {
        ...turn,
        tStartMs: prev.tStartMs ?? turn.tStartMs,
        tEndMs: turn.tEndMs ?? prev.tEndMs,
      };
      continue;
    }
    if (a.startsWith(b)) {
      hits++;
      out[out.length - 1] = { ...prev, tEndMs: turn.tEndMs ?? prev.tEndMs };
      continue;
    }

    out.push(turn);
  }

  return { turns: out, hits };
}

/**
 * ASR flush points re-emit the tail of the previous line as context. Compare on token sequences,
 * not characters: character matching produces garbage, and a 2-token minimum false-positives on
 * common phrases ("we should", "the thing").
 */
function stepStripBoundaryOverlap(turns: Turn[], minTokens: number): StepOutcome {
  const out: Turn[] = [];
  let hits = 0;

  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (!prev || prev.speaker !== turn.speaker) {
      out.push({ ...turn });
      continue;
    }

    const prevCmp = compareTokens(prev.text);
    const curCmp = compareTokens(turn.text);
    const curRaw = rawTokens(turn.text);

    // Comparison and raw token counts can diverge if punctuation forms its own token; only trust
    // the alignment when they agree.
    if (curCmp.length !== curRaw.length || prevCmp.length < minTokens || curCmp.length < minTokens) {
      out.push({ ...turn });
      continue;
    }

    const maxK = Math.min(prevCmp.length, curCmp.length - 1);
    let k = 0;
    for (let n = maxK; n >= minTokens; n--) {
      const tail = prevCmp.slice(prevCmp.length - n).join(' ');
      const head = curCmp.slice(0, n).join(' ');
      if (tail === head) {
        k = n;
        break;
      }
    }

    if (k > 0) {
      hits++;
      out.push({ ...turn, text: curRaw.slice(k).join(' ') });
    } else {
      out.push({ ...turn });
    }
  }

  return { turns: out, hits };
}

const VOCALIZATIONS = /\b(?:u+m+|u+h+|e+r+m*|a+h+|m+h+m+|h+m+|mm+)\b[,.]?/gi;
const DISCOURSE_FILLERS = /\b(?:like|you know|i mean|sort of|kind of|basically|actually|so|well|right)\b[,]?/gi;

function stepStripPattern(turns: Turn[], pattern: RegExp): StepOutcome {
  let hits = 0;
  const out = turns.map((t) => {
    const stripped = t.text.replace(pattern, ' ').replace(/ {2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
    if (stripped !== t.text) hits++;
    return { ...t, text: stripped };
  });
  return { turns: out, hits };
}

function stepDropEmpty(turns: Turn[]): StepOutcome {
  const out = turns.filter((t) => t.text.length > 0 && !isPunctuationOnly(t.text));
  return { turns: out, hits: turns.length - out.length };
}

function stepDropSingleToken(turns: Turn[]): StepOutcome {
  const out = turns.filter((t) => compareTokens(t.text).length > 1);
  return { turns: out, hits: turns.length - out.length };
}

/**
 * Merge strictly consecutive same-speaker turns. Deliberately does NOT merge across another
 * speaker's interjection - that would glue together statements a third party separated.
 */
function stepMergeTurns(turns: Turn[], gapMs: number, maxChars: number): StepOutcome {
  const out: Turn[] = [];
  let hits = 0;

  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (!prev || prev.speaker !== turn.speaker) {
      out.push({ ...turn });
      continue;
    }

    const gapOk =
      prev.tEndMs == null || turn.tStartMs == null
        ? true // no timing available (text-only source): consecutive same-speaker is enough
        : turn.tStartMs - prev.tEndMs <= gapMs;
    const lengthOk = prev.text.length + 1 + turn.text.length <= maxChars;

    if (gapOk && lengthOk) {
      hits++;
      out[out.length - 1] = {
        ...prev,
        text: `${prev.text} ${turn.text}`.replace(/ {2,}/g, ' ').trim(),
        tEndMs: turn.tEndMs ?? prev.tEndMs,
      };
    } else {
      out.push({ ...turn });
    }
  }

  return { turns: out, hits };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTurns(turns: Turn[], includeTimestamps: boolean): string {
  return turns
    .map((t) => {
      const ts = includeTimestamps && t.tStartMs != null ? `[${formatClock(t.tStartMs)}] ` : '';
      const who = t.speaker ? `${t.speaker}: ` : '';
      return `${ts}${who}${t.text}`;
    })
    .join('\n');
}

function normalizeParticipantName(name: string): string {
  return normalizeString(name)
    .replace(/\((?:me|guest|external|organizer|presenter|unverified)\)/gi, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function buildParticipants(raw: string[], exclude: string[]): string[] {
  const excludeSet = new Set(exclude.map((e) => normalizeParticipantName(e).toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    const clean = normalizeParticipantName(name);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (excludeSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PreprocessInput {
  /** Contents of the rendered .txt transcript. */
  raw: string;
  /** Parsed `X.captions.json`, when it exists next to the transcript. */
  captionsSidecar?: CaptionsSidecar | null;
  /** Parsed `X.named_transcript.json`, when it exists next to the transcript. */
  namedSidecar?: NamedSidecar | null;
}

/** Below this share of matching lines we treat the file as prose, not a structured transcript. */
const STRUCTURE_THRESHOLD = 0.6;

export function preprocessTranscript(
  input: PreprocessInput,
  overrides?: Partial<PreprocessOptions>,
): PreprocessResult {
  const opts = resolveOptions(overrides);
  const parsed = parseTranscriptText(input.raw);

  // --- choose the turn source -------------------------------------------------
  let source: TranscriptSource;
  let usedSidecar = false;
  let turns: Turn[];
  let participantsRaw: string[] = parsed.participants;

  const namedTurns = input.namedSidecar ? turnsFromNamedSidecar(input.namedSidecar) : [];
  const captionTurns = input.captionsSidecar ? turnsFromCaptionsSidecar(input.captionsSidecar) : [];

  if (namedTurns.length > 0) {
    source = 'named';
    usedSidecar = true;
    turns = namedTurns;
  } else if (captionTurns.length > 0) {
    source = 'captions';
    usedSidecar = true;
    turns = captionTurns;
    if (participantsRaw.length === 0 && input.captionsSidecar?.participants) {
      participantsRaw = input.captionsSidecar.participants;
    }
  } else if (parsed.structureRatio >= STRUCTURE_THRESHOLD && parsed.turns.length > 0) {
    source = input.raw.toLowerCase().includes('verbatim transcript') ? 'named' : 'captions';
    turns = parsed.turns;
  } else {
    source = 'unstructured';
    turns = parsed.turns;
  }

  const charsIn = turns.reduce((n, t) => n + t.text.length, 0);
  const turnsIn = turns.length;

  if (turnsIn === 0) {
    throw new EmptyTranscriptError(
      'Transcript contains no usable content (no captions were captured, or the file is empty).',
    );
  }

  // --- unstructured: normalization only ---------------------------------------
  if (source === 'unstructured') {
    const normalized = opts.normalizeText ? stepNormalize(turns).turns : turns;
    const text = normalized.map((t) => t.text).join('\n');
    return {
      text,
      turns: normalized,
      participants: [],
      stats: {
        source,
        usedSidecar: false,
        turnsIn,
        turnsOut: normalized.length,
        charsIn,
        charsOut: text.length,
        participantsIn: 0,
        participantsOut: 0,
        steps: [
          {
            step: 'normalize (unstructured passthrough)',
            turnsIn,
            turnsOut: normalized.length,
            charsIn,
            charsOut: text.length,
            hits: 0,
          },
        ],
      },
    };
  }

  // --- structured pipeline -----------------------------------------------------
  const steps: Array<{ name: string; enabled: boolean; run: (t: Turn[]) => StepOutcome }> = [
    { name: 'normalize', enabled: opts.normalizeText, run: stepNormalize },
    { name: 'carryForwardUnknownSpeaker', enabled: opts.carryForwardUnknownSpeaker, run: stepCarryForwardUnknown },
    { name: 'dedupeAdjacent', enabled: opts.dedupeAdjacent, run: stepDedupeAdjacent },
    {
      name: 'stripBoundaryOverlap',
      enabled: opts.stripBoundaryOverlap,
      run: (t) => stepStripBoundaryOverlap(t, opts.minOverlapTokens),
    },
    {
      name: 'stripVocalizations',
      enabled: opts.stripVocalizations,
      run: (t) => stepStripPattern(t, VOCALIZATIONS),
    },
    {
      name: 'stripDiscourseFillers',
      enabled: opts.stripDiscourseFillers,
      run: (t) => stepStripPattern(t, DISCOURSE_FILLERS),
    },
    { name: 'dropEmptyTurns', enabled: opts.dropEmptyTurns, run: stepDropEmpty },
    { name: 'dropSingleTokenTurns', enabled: opts.dropSingleTokenTurns, run: stepDropSingleToken },
    {
      name: 'mergeTurns',
      enabled: opts.mergeTurns,
      run: (t) => stepMergeTurns(t, opts.mergeGapMs, opts.maxMergedChars),
    },
  ];

  const stepStats: StepStat[] = [];
  let current = turns;

  for (const step of steps) {
    if (!step.enabled) continue;
    const before = current;
    const beforeChars = before.reduce((n, t) => n + t.text.length, 0);
    const outcome = step.run(before);
    current = outcome.turns;
    stepStats.push({
      step: step.name,
      turnsIn: before.length,
      turnsOut: current.length,
      charsIn: beforeChars,
      charsOut: current.reduce((n, t) => n + t.text.length, 0),
      hits: outcome.hits,
    });
  }

  if (current.length === 0) {
    throw new EmptyTranscriptError('Preprocessing removed every turn - refusing to summarize an empty transcript.');
  }

  const participants = buildParticipants(participantsRaw, opts.excludeSpeakers);
  const body = renderTurns(current, opts.includeTimestamps);

  const blocks: string[] = [];
  if (opts.participantsPosition === 'top' && participants.length > 0) {
    blocks.push(`Participants:\n${participants.join('\n')}`);
  }
  blocks.push(`Transcript:\n${body}`);
  if (opts.participantsPosition === 'bottom' && participants.length > 0) {
    blocks.push(`Participants:\n${participants.join('\n')}`);
  }
  const text = blocks.join('\n\n');

  return {
    text,
    turns: current,
    participants,
    stats: {
      source,
      usedSidecar,
      turnsIn,
      turnsOut: current.length,
      charsIn,
      charsOut: current.reduce((n, t) => n + t.text.length, 0),
      participantsIn: participantsRaw.length,
      participantsOut: participants.length,
      steps: stepStats,
    },
  };
}

/** One-line log summary for summaries.ts. */
export function formatStatsLine(stats: PreprocessStats): string {
  const fired = stats.steps
    .filter((s) => s.hits > 0)
    .map((s) => `${s.step}=${s.hits}`)
    .join(' ');
  return (
    `source=${stats.source} sidecar=${stats.usedSidecar} ` +
    `turns ${stats.turnsIn}->${stats.turnsOut} chars ${stats.charsIn}->${stats.charsOut}` +
    (fired ? ` | ${fired}` : ' | no steps fired')
  );
}
