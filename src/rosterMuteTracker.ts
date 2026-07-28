import { Page } from '@playwright/test';
import { isLocalParticipantMuted } from './localParticipantMute';

/**
 * Polls the Teams roster for a named participant's mute state and drives the WASAPI
 * mic gate (MIC 0/1 on the helper stdin). Loopback always records; hardware mic is
 * mixed in only while that participant shows as unmuted in the meeting.
 *
 * Fail-open until the named participant first appears on the roster (join / name match).
 * After that, disappearing from the roster is treated as having left — mic gate closes.
 */
export class RosterMuteTracker {
  private handle: ReturnType<typeof setInterval> | null = null;
  private lastMicEnabled: boolean | null = null;
  /** Log throttle while waiting for first roster match. */
  private nullPollStreak = 0;
  /** True once we've successfully read mute state for this participant. */
  private seenOnRoster = false;
  /** Consecutive polls with no roster row after seenOnRoster (DOM flicker guard). */
  private absentStreak = 0;
  /** ~0.9s at 300ms poll — brief roster glitches should not close the mic. */
  private static readonly ABSENT_CLOSE_POLLS = 3;

  constructor(
    private readonly page: Page,
    private readonly participantName: string,
    private readonly onMicGateChange: (micEnabled: boolean) => void,
    private readonly pollMs = 300,
  ) {}

  public start(): void {
    if (this.handle) return;
    console.log(
      `[muteTracker] Watching roster mute state for "${this.participantName}" (mic open until muted or left)`,
    );
    this.lastMicEnabled = true;
    this.seenOnRoster = false;
    this.absentStreak = 0;
    this.nullPollStreak = 0;
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
      if (!this.seenOnRoster) {
        this.nullPollStreak++;
        if (this.nullPollStreak === 1 || this.nullPollStreak % 17 === 0) {
          console.log(
            `[muteTracker] Could not find "${this.participantName}" in roster yet — mic stays open`,
          );
        }
        return;
      }

      this.absentStreak++;
      if (this.absentStreak >= RosterMuteTracker.ABSENT_CLOSE_POLLS && this.lastMicEnabled !== false) {
        this.lastMicEnabled = false;
        this.onMicGateChange(false);
        console.log(
          `[muteTracker] "${this.participantName}" no longer on roster — mic gate closed (left meeting)`,
        );
      }
      return;
    }

    if (!this.seenOnRoster) {
      this.seenOnRoster = true;
      console.log(`[muteTracker] Found "${this.participantName}" on roster`);
    }
    this.absentStreak = 0;
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
