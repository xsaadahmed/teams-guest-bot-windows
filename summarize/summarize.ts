/**
 * Dev/test CLI for meeting summarization.
 * Production code should import summarizeTranscript from ./llmClient instead.
 *
 * Usage (from repo root, with .env configured):
 *   npx tsx summarize/summarize.ts <transcript.txt>
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { LlmConfigError, LlmRequestError, summarizeTranscript } from './llmClient';

const fileName = process.argv[2];

if (!fileName) {
  console.error('Usage: npx tsx summarize/summarize.ts <transcript.txt>');
  process.exit(1);
}

const filePath = path.resolve(fileName);

if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const transcript = fs.readFileSync(filePath, 'utf-8');

summarizeTranscript(transcript)
  .then((summary) => {
    console.log('\n' + summary + '\n');
  })
  .catch((err: unknown) => {
    if (err instanceof LlmConfigError) {
      console.error(`Configuration error: ${err.message}`);
    } else if (err instanceof LlmRequestError) {
      console.error(`Request error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Error:', err);
    }
    process.exit(1);
  });
