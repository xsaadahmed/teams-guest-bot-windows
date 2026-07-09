import { Page } from '@playwright/test';
import { isLocalParticipantMuted } from './localParticipantMute';

/**
 * Polls the Teams roster for a named participant's mute state and drives the WASAPI
 * mic gate (MIC 0/1 on the helper stdin). Loopback always records; hardware mic is
 * mixed in only while that participant shows as unmuted in the meeting.
 *
 * Fail-open: mic starts open and stays open until we successfully read a muted state
 * from the roster — avoids silent recordings when name matching hasn't found the row yet.
 */
export class RosterMuteTracker {
  private handle: ReturnType<typeof setInterval> | null = null;
  private lastMicEnabled: boolean | null = null;
  private nullPollStreak = 0;

  constructor(
    private readonly page: Page,
    private readonly participantName: string,
    private readonly onMicGateChange: (micEnabled: boolean) => void,
    private readonly pollMs = 300,
  ) {}

  public start(): void {
    if (this.handle) return;
    console.log(`[muteTracker] Watching roster mute state for "${this.participantName}" (mic open until muted confirmed)`);
    this.lastMicEnabled = true;
    this.onMicGateChange(true);
    this.handle = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  public stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.page.isClosed()) return;

    const muted = await isLocalParticipantMuted(this.page, this.participantName);
    if (muted === null) {
      this.nullPollStreak++;
      if (this.nullPollStreak === 1 || this.nullPollStreak % 17 === 0) {
        console.log(
          `[muteTracker] Could not find "${this.participantName}" in roster yet — mic stays open`,
        );
      }
      return;
    }

    this.nullPollStreak = 0;
    const micEnabled = !muted;
    if (micEnabled === this.lastMicEnabled) return;

    this.lastMicEnabled = micEnabled;
    this.onMicGateChange(micEnabled);
    console.log(
      `[muteTracker] ${this.participantName} ${muted ? 'muted' : 'unmuted'} -> mic gate ${micEnabled ? 'open' : 'closed'}`,
    );
  }
}
