/**
 * Contract both platform-specific recorders satisfy (LinuxAudioRecorder = PulseAudio +
 * ffmpeg under Docker/Xvfb, WindowsAudioRecorder = WASAPI loopback via the bundled .NET
 * helper). `AudioRecorder` in audioRecorder.ts picks one of these based on process.platform,
 * so bot.ts never has to know or care which platform it's running on.
 */
export interface IAudioRecorder {
  /** Starts recording to filePath. Synchronous/fire-and-forget, matching the original
   *  ffmpeg-spawning implementation - callers don't await a "recording has definitely
   *  started" signal, they just start it and move on. */
  start(filePath: string): void;

  /** Stops recording and waits for the underlying process to exit cleanly so the WAV file
   *  is fully finalized (correct RIFF header, no truncation) before this resolves. */
  stop(): Promise<void>;

  /** Windows mute-gated mic only: open/close hardware mic contribution to the mix. */
  setMicGate?(enabled: boolean): void;

  readonly isRecording: boolean;
}
