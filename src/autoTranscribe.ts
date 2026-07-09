import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Optional: fires off the EXISTING transcribe/transcribe_with_names.py (faster-whisper +
 * Teams caption speaker-alignment - already written, already working on Windows via its own
 * isolated venv) against a just-finished recording, in the background.
 *
 * Deliberately NOT a new pipeline: transcribe_with_names.py already does the specific thing
 * a "port Whisper to Windows" effort would otherwise rebuild, and does it better than a
 * plain Whisper-on-raw-audio pipeline would - it aligns Whisper's verbatim (but anonymous)
 * segments against the same captions.json the bot already writes, so the output keeps real
 * speaker names instead of generic "Speaker 1/2/3" labels. See transcribe/README or the
 * header of transcribe_with_names.py for how the alignment works.
 *
 * Off by default (AUTO_TRANSCRIBE=true to enable) and Windows-only for now, since the venv
 * setup this depends on exists specifically to dodge a Windows-Python/Anaconda OpenMP DLL
 * conflict (see transcribe/transcribe.ps1) - there's no equivalent need or setup on the
 * Docker/Linux path, where this is left as the manual post-hoc step it always was.
 *
 * Deliberately NOT awaited by callers: transcribing a real meeting can take minutes on CPU,
 * and nothing about /leave responding promptly should depend on it finishing.
 */
export function autoTranscribeInBackground(wavPath: string): void {
  if (process.env.AUTO_TRANSCRIBE !== 'true') return;

  if (process.platform !== 'win32') {
    console.warn('[autoTranscribe] AUTO_TRANSCRIBE is only wired up for the Windows path right now - skipping.');
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const transcribeDir = path.join(repoRoot, 'transcribe');
  const venvPython = path.join(transcribeDir, '.venv', 'Scripts', 'python.exe');
  const script = path.join(transcribeDir, 'transcribe_with_names.py');

  if (!fs.existsSync(venvPython)) {
    console.warn(
      `[autoTranscribe] AUTO_TRANSCRIBE is on but no venv found at ${venvPython}.\n` +
        '[autoTranscribe] One-time setup (run from the transcribe/ folder):\n' +
        '[autoTranscribe]   python -m venv .venv\n' +
        '[autoTranscribe]   .\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt\n' +
        '[autoTranscribe] Skipping this recording - captions-based transcript is unaffected.',
    );
    return;
  }

  if (!fs.existsSync(script)) {
    console.warn(`[autoTranscribe] AUTO_TRANSCRIBE is on but ${script} doesn't exist - skipping.`);
    return;
  }

  const model = process.env.WHISPER_MODEL || 'small';
  console.log(`[autoTranscribe] Starting background Whisper pass (model="${model}") on ${path.basename(wavPath)}...`);

  const proc = spawn(venvPython, [script, wavPath, '--model', model], {
    cwd: transcribeDir,
    stdio: 'pipe',
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
