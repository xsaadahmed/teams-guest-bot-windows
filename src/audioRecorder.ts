import { IAudioRecorder } from './audioRecorderTypes';
import { LinuxAudioRecorder } from './audioRecorder.linux';
import { WindowsAudioRecorder } from './audioRecorder.windows';

export type { IAudioRecorder } from './audioRecorderTypes';

/**
 * Platform-dispatching facade. bot.ts just does `new AudioRecorder()` and calls
 * start()/stop() - it never has to know or care whether that's actually PulseAudio+ffmpeg
 * under Docker/Xvfb (Linux) or WASAPI loopback via the bundled .NET helper (Windows). Same
 * public surface either way, chosen once at construction time based on process.platform.
 */
export class AudioRecorder implements IAudioRecorder {
  private readonly impl: IAudioRecorder;

  constructor() {
    this.impl = process.platform === 'win32' ? new WindowsAudioRecorder() : new LinuxAudioRecorder();
  }

  public start(filePath: string): void {
    this.impl.start(filePath);
  }

  public async stop(): Promise<void> {
    return this.impl.stop();
  }

  public setMicGate(enabled: boolean): void {
    this.impl.setMicGate?.(enabled);
  }

  public get isRecording(): boolean {
    return this.impl.isRecording;
  }
}
