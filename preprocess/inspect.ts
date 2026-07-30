#!/usr/bin/env node
/**
 * Preprocessing inspection harness. Runs src/transcriptPreprocess.ts against a real transcript
 * and prints per-step stats plus a before/after view - no server, no LLM call, no cost.
 *
 * This is where preprocessing tuning happens. The step counts it reports are the evidence for
 * whether an off-by-default step (discourse fillers, single-token turns) is worth enabling, and
 * whether an on-by-default step ever actually fires on your data.
 *
 * Usage:
 *   npx ts-node preprocess/inspect.ts Recordings/2026-07-23T09-43-43-043Z.transcript.txt
 *   npx ts-node preprocess/inspect.ts Recordings/*.transcript.txt --stats-only
 *   npx ts-node preprocess/inspect.ts <file> --set stripDiscourseFillers=true --set mergeGapMs=3000
 *   npx ts-node preprocess/inspect.ts <file> --write     # also write the .clean.txt artifact
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  preprocessTranscript,
  formatStatsLine,
  DEFAULT_OPTIONS,
  EmptyTranscriptError,
  type PreprocessOptions,
} from '../src/transcriptPreprocess';
import { loadPreprocessInput, cleanArtifactPath } from '../src/transcriptSidecars';

interface Args {
  files: string[];
  overrides: Partial<PreprocessOptions>;
  statsOnly: boolean;
  write: boolean;
  head: number;
}

function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  const overrides: Record<string, unknown> = {};
  let statsOnly = false;
  let write = false;
  let head = 25;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stats-only') statsOnly = true;
    else if (a === '--write') write = true;
    else if (a === '--head') head = Number.parseInt(argv[++i], 10) || 25;
    else if (a === '--set') {
      const [key, rawValue] = (argv[++i] ?? '').split('=');
      if (!key || rawValue === undefined) {
        console.error(`--set expects key=value, got "${argv[i]}"`);
        process.exit(2);
      }
      if (!(key in DEFAULT_OPTIONS)) {
        console.error(`Unknown option "${key}". Valid: ${Object.keys(DEFAULT_OPTIONS).join(', ')}`);
        process.exit(2);
      }
      const defaults = DEFAULT_OPTIONS as unknown as Record<string, unknown>;
      overrides[key] = coerce(rawValue, defaults[key]);
    } else if (a.startsWith('--')) {
      console.error(`Unknown flag ${a}`);
      process.exit(2);
    } else {
      files.push(a);
    }
  }

  if (files.length === 0) {
    console.error('Usage: inspect.ts <transcript.txt ...> [--stats-only] [--write] [--set key=value]');
    process.exit(2);
  }

  return { files, overrides: overrides as Partial<PreprocessOptions>, statsOnly, write, head };
}

/** Coerce by the DEFAULT_OPTIONS value's type, so a one-element array stays an array. */
function coerce(value: string, defaultValue: unknown): unknown {
  if (Array.isArray(defaultValue)) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof defaultValue === 'boolean') return /^(1|true|yes|on)$/i.test(value);
  if (typeof defaultValue === 'number') {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) {
      console.error(`Expected a number for this option, got "${value}"`);
      process.exit(2);
    }
    return n;
  }
  return value;
}

function pct(from: number, to: number): string {
  if (from === 0) return '  0.0%';
  const delta = ((to - from) / from) * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

function inspectFile(filePath: string, args: Args): void {
  console.log('='.repeat(78));
  console.log(path.basename(filePath));
  console.log('='.repeat(78));

  let input;
  try {
    input = loadPreprocessInput(filePath);
  } catch (err) {
    console.error(`  cannot read: ${(err as Error).message}\n`);
    return;
  }

  let result;
  try {
    result = preprocessTranscript(input, args.overrides);
  } catch (err) {
    if (err instanceof EmptyTranscriptError) {
      console.log(`  SKIPPED: ${err.message}\n`);
      return;
    }
    throw err;
  }

  const { stats } = result;
  console.log(`  source=${stats.source}  sidecar=${stats.usedSidecar ? 'yes' : 'no'}`);
  console.log(
    `  turns ${stats.turnsIn} -> ${stats.turnsOut}   chars ${stats.charsIn} -> ${stats.charsOut} (${pct(stats.charsIn, stats.charsOut)})`,
  );
  console.log(`  participants ${stats.participantsIn} -> ${stats.participantsOut}`);
  console.log('');
  console.log('  step                          turns        chars           hits');
  console.log('  ' + '-'.repeat(66));
  for (const s of stats.steps) {
    const turnsCol = `${s.turnsIn}->${s.turnsOut}`.padEnd(12);
    const charsCol = `${s.charsIn}->${s.charsOut}`.padEnd(16);
    const flag = s.hits === 0 ? '  (never fired)' : '';
    console.log(`  ${s.step.padEnd(28)}${turnsCol}${charsCol}${String(s.hits).padStart(5)}${flag}`);
  }
  console.log('');

  if (!args.statsOnly) {
    console.log(`  --- OUTPUT (first ${args.head} lines) ---`);
    for (const line of result.text.split('\n').slice(0, args.head)) {
      console.log(`  | ${line}`);
    }
    console.log('');
  }

  if (args.write) {
    const out = cleanArtifactPath(filePath);
    fs.writeFileSync(out, result.text, 'utf8');
    console.log(`  wrote ${path.basename(out)}`);
    console.log('');
  }

  console.log(`  ${formatStatsLine(stats)}`);
  console.log('');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (Object.keys(args.overrides).length > 0) {
    console.log(`Overrides: ${JSON.stringify(args.overrides)}\n`);
  }
  for (const file of args.files) {
    inspectFile(file, args);
  }
}

main();
