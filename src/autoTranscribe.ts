import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getEffectiveTranscriptionConfig } from './userConfig';

/**
 * Optional: fires off transcribe/transcribe_with_names.py against a just-finished recording,
 * in the background, using the user's configured Python interpreter and STT engine.
 *
 * Detect-only: the app never installs packages — transcription runs only when the user has
 * enabled it and a supported engine was found on their machine at configuration time.
 *
 * Deliberately NOT awaited by callers: transcribing a real meeting can take minutes on CPU.
 */
export function autoTranscribeInBackground(wavPath: string): void {
  if (process.platform !== 'win32') {
    return;
  }

  const cfg = getEffectiveTranscriptionConfig();
  if (!cfg.enabled) return;

  if (!cfg.engine || !cfg.model || !cfg.pythonPath) {
    console.warn(
      '[autoTranscribe] Accurate transcription is enabled but engine/model/python path is not configured — skipping.',
    );
    return;
  }

  if (!fs.existsSync(cfg.pythonPath)) {
    console.warn(
      `[autoTranscribe] Python interpreter not found at ${cfg.pythonPath} — skipping transcription.`,
    );
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const transcribeDir = path.join(repoRoot, 'transcribe');
  const script = path.join(transcribeDir, 'transcribe_with_names.py');

  if (!fs.existsSync(script)) {
    console.warn(`[autoTranscribe] ${script} doesn't exist — skipping.`);
    return;
  }

  const args = [
    script,
    wavPath,
    '--engine',
    cfg.engine,
    '--model',
    cfg.model,
    '--device',
    cfg.device,
  ];

  if (cfg.engine === 'faster_whisper') {
    args.push('--compute-type', cfg.device === 'cuda' ? 'float16' : 'int8');
  }

  console.log(
    `[autoTranscribe] Starting background transcription (engine="${cfg.engine}", model="${cfg.model}") on ${path.basename(wavPath)}...`,
  );

  const proc = spawn(cfg.pythonPath, args, {
    cwd: transcribeDir,
    stdio: 'pipe',
    windowsHide: true,
  });

  proc.stdout.on('data', (d: Buffer) => console.log('[autoTranscribe]', d.toString().trim()));
  proc.stderr.on('data', (d: Buffer) => console.log('[autoTranscribe]', d.toString().trim()));

  proc.on('exit', (code) => {
    if (code === 0) {
      console.log(`[autoTranscribe] Done: ${path.basename(wavPath, '.wav')}.named_transcript.txt`);
    } else {
      console.warn(`[autoTranscribe] transcribe_with_names.py exited with code ${code}`);
    }
  });

  proc.on('error', (err) => {
    console.warn('[autoTranscribe] Failed to start background transcription:', err);
  });
}
