import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IAudioRecorder } from './audioRecorderTypes';

/**
 * Windows equivalent of LinuxAudioRecorder: WASAPI loopback on the render device(s) Chromium
 * uses for Teams WebRTC playback, optionally mixed with a hardware microphone.
 *
 * When LOCAL_PARTICIPANT_NAME is set, mic capture is mute-gated: the helper records silence
 * from the mic while that participant shows as muted in the Teams roster, and real mic audio
 * only while unmuted — matching Linux/Docker behavior on same-machine setups.
 *
 * Set WASAPI_NO_MIC=true for loopback-only. WASAPI_MIC_DEVICE overrides the input device.
 */
export class WindowsAudioRecorder implements IAudioRecorder {
  private helper: ChildProcessWithoutNullStreams | null = null;
  private readonly helperPath: string;
  private readonly micGated: boolean;
  private level = 0;

  constructor(helperPath?: string) {
    this.helperPath =
      helperPath ||
      process.env.WASAPI_HELPER_PATH ||
      path.join(__dirname, '..', 'windows', 'WasapiLoopbackRecorder', 'publish', 'WasapiLoopbackRecorder.exe');
    this.micGated = Boolean(process.env.LOCAL_PARTICIPANT_NAME?.trim()) && process.env.WASAPI_NO_MIC !== 'true';
  }

  public get audioLevel(): number {
    return this.level;
  }

  public start(filePath: string): void {
    if (this.helper) {
      throw new Error('AudioRecorder is already recording.');
    }

    if (!fs.existsSync(this.helperPath)) {
      throw new Error(
        `WASAPI capture helper not found at ${this.helperPath}. Build it first: ` +
          `.\\windows\\build-helper.ps1  (or set WASAPI_HELPER_PATH to point at an already-built .exe).`,
      );
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const helperArgs = [filePath];
    if (process.env.WASAPI_RENDER_DEVICE) {
      helperArgs.push('--device', process.env.WASAPI_RENDER_DEVICE);
    }
    if (process.env.WASAPI_MIC_DEVICE) {
      helperArgs.push('--mic-device', process.env.WASAPI_MIC_DEVICE);
    }
    if (process.env.WASAPI_NO_MIC === 'true') {
      helperArgs.push('--no-mic');
    } else if (this.micGated) {
      helperArgs.push('--mic-gated');
    }

    this.level = 0;
    console.log(`[audioRecorder] Starting: ${this.helperPath} ${helperArgs.map((a) => `"${a}"`).join(' ')}`);
    this.helper = spawn(this.helperPath, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    this.helper.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const levelMatch = /^LEVEL\s+([0-9.]+)$/i.exec(trimmed);
        if (levelMatch) {
          const value = Number(levelMatch[1]);
          if (Number.isFinite(value)) this.level = Math.min(1, Math.max(0, value));
          continue;
        }
        console.log('[audioRecorder][wasapi]', trimmed);
        if (this.micGated && trimmed.includes('READY')) {
          this.setMicGate(true);
        }
      }
    });
    this.helper.stderr.on('data', (chunk: Buffer) => {
      console.log('[audioRecorder][wasapi]', chunk.toString().trim());
    });

    this.helper.on('exit', (code, signal) => {
      console.log(`[audioRecorder] WASAPI helper exited (code=${code}, signal=${signal})`);
      this.helper = null;
      this.level = 0;
    });

    this.helper.on('error', (err) => {
      console.error('[audioRecorder] Failed to start WASAPI helper:', err);
      this.helper = null;
      this.level = 0;
    });
  }

  public setMicGate(enabled: boolean): void {
    if (!this.micGated) return;
    const proc = this.helper;
    if (!proc?.stdin.writable) return;
    try {
      proc.stdin.write(`MIC ${enabled ? 1 : 0}\n`);
    } catch (err) {
      console.warn('[audioRecorder] Could not write mic gate command:', err);
    }
  }

  public setPaused(paused: boolean): void {
    const proc = this.helper;
    if (!proc?.stdin.writable) return;
    try {
      proc.stdin.write(`PAUSE ${paused ? 1 : 0}\n`);
      if (paused) this.level = 0;
    } catch (err) {
      console.warn('[audioRecorder] Could not write pause command:', err);
    }
  }

  public async stop(): Promise<void> {
    const proc = this.helper;
    if (!proc) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[audioRecorder] WASAPI helper did not exit in time, forcing termination.');
        proc.kill();
      }, 20_000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        proc.stdin.write('STOP\n');
        proc.stdin.end();
      } catch (err) {
        console.warn('[audioRecorder] Could not write STOP to WASAPI helper stdin, killing instead:', err);
        clearTimeout(timeout);
        proc.kill();
        resolve();
      }
    });
  }

  public get isRecording(): boolean {
    return this.helper !== null;
  }
}
