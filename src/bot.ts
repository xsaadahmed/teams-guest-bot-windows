import { BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchTeamsBrowser, minimizeWindowBestEffort, startProtocolDialogWatcher, dismissNativeProtocolDialogBestEffort } from './browserLaunch';
import { toDirectJoinUrl } from './teamsUrl';
import { joinTeamsMeeting, leaveTeamsMeeting, hasMeetingEnded, getParticipantCount, ensureRosterPanelOpen } from './teamsJoin';
import { AudioRecorder } from './audioRecorder';
import { CaptionTracker, CaptionEntry } from './captionTracker';
import { autoTranscribeInBackground } from './autoTranscribe';
import { RosterMuteTracker } from './rosterMuteTracker';

export type BotState = 'idle' | 'joining' | 'in_meeting' | 'leaving' | 'error';

export interface JoinRequest {
  meetingUrl: string;
  displayName?: string;
}

export interface BotStatus {
  state: BotState;
  meetingUrl?: string;
  displayName?: string;
  recordingFile?: string;
  joinedAt?: string;
  lastError?: string;
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');
const DEFAULT_DISPLAY_NAME = process.env.DEFAULT_DISPLAY_NAME || 'Meeting Recorder';
const LOCAL_PARTICIPANT_NAME = process.env.LOCAL_PARTICIPANT_NAME?.trim() || '';

/**
 * Owns a single guest "session" in a Teams meeting: one browser context, one page,
 * one audio recording. Supporting more than one concurrent meeting would mean running
 * one of these per meeting (each needs its own Xvfb display / Pulse sink) - straightforward
 * to add later, intentionally left out here to keep this readable.
 */
export class TeamsGuestBot {
  private state: BotState = 'idle';
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private recorder = new AudioRecorder();
  private captions = new CaptionTracker();
  private pollHandle: NodeJS.Timeout | null = null;
  private status: BotStatus = { state: 'idle' };
  private recordingFilePath: string | null = null;
  private captionsActive = false;
  private stopProtocolDialogWatcher: (() => void) | null = null;
  private muteTracker: RosterMuteTracker | null = null;

  public getStatus(): BotStatus {
    return { ...this.status, state: this.state };
  }

  public async join(req: JoinRequest): Promise<BotStatus> {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Bot is already busy (state=${this.state}). Call /leave first.`);
    }

    const displayName = req.displayName?.trim() || DEFAULT_DISPLAY_NAME;
    this.state = 'joining';
    this.status = { state: 'joining', meetingUrl: req.meetingUrl, displayName };

    try {
      const { context } = await launchTeamsBrowser();
      this.context = context;
      this.page = await context.newPage();

      const directUrl = toDirectJoinUrl(req.meetingUrl);
      const outcome = await joinTeamsMeeting(this.page, directUrl, displayName);

      if (outcome.status === 'denied') {
        throw new Error(`Teams denied entry: ${outcome.reason}`);
      }
      if (outcome.status === 'timeout') {
        throw new Error(
          'Timed out waiting to be let into the meeting (organizer may not have admitted the bot from the lobby).',
        );
      }

      // Placed after (not before) a confirmed join: the join flow itself (clicking through
      // the lobby, name field, etc.) is the fragile part, so it runs with a normal visible
      // window first. Only once we're safely in the meeting do we try to get it out of the
      // way - and only if MINIMIZE_BROWSER_WINDOW=true, see browserLaunch.ts.
      await minimizeWindowBestEffort(context, this.page);

      const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      const filePath = path.join(RECORDINGS_DIR, fileName);
      this.recordingFilePath = filePath;
      this.recorder.start(filePath);

      // Timestamps for captions align with when recording started (before the settle delay below).
      const recordingStartEpoch = Date.now();
      this.captionsActive = false;

      if (this.page) {
        this.stopProtocolDialogWatcher?.();
        this.stopProtocolDialogWatcher = startProtocolDialogWatcher(this.page);
      }

      // Let the in-meeting UI finish loading before opening the captions menu.
      await new Promise((r) => setTimeout(r, 3000));

      if (this.page) {
        try {
          await this.captions.start(this.page, recordingStartEpoch);
          this.captionsActive = true;
        } catch (err) {
          console.warn('[bot] caption tracker failed to start (recording continues):', err);
        }
      }

      this.state = 'in_meeting';
      this.status = {
        state: 'in_meeting',
        meetingUrl: req.meetingUrl,
        displayName,
        recordingFile: fileName,
        joinedAt: new Date().toISOString(),
      };

      this.startEndOfMeetingWatcher();
      this.startMuteTracker();

      return this.getStatus();
    } catch (err) {
      const message = (err as Error).message;
      console.error('[bot] join failed:', message);
      this.status = { ...this.status, state: 'error', lastError: message };
      this.state = 'error';
      await this.cleanupBrowser();
      throw err;
    }
  }

  public async leave(): Promise<BotStatus> {
    if (this.state === 'idle') {
      return this.getStatus();
    }

    this.state = 'leaving';
    this.stopEndOfMeetingWatcher();
    this.stopMuteTracker();

    // Finalize the captions transcript while the page is still alive (the speaker names live in
    // the page DOM - once we close the browser they're gone).
    await this.finalizeTranscript().catch((err) =>
      console.warn('[bot] error writing transcript (continuing anyway):', err),
    );

    if (this.page) {
      await leaveTeamsMeeting(this.page).catch((err) =>
        console.warn('[bot] error while clicking Leave (continuing anyway):', err),
      );
    }

    await this.recorder.stop();

    // Only safe to hand off once recorder.stop() above has resolved - that's the point at
    // which the WAV is guaranteed complete and finalized. (This is also why it's not inside
    // finalizeTranscript(): that runs earlier, while the page is still open to read captions
    // from, well before the recording itself has actually stopped.)
    if (this.recordingFilePath) {
      autoTranscribeInBackground(this.recordingFilePath);
    }

    await this.cleanupBrowser();

    this.recordingFilePath = null;
    this.state = 'idle';
    this.status = { state: 'idle' };
    return this.getStatus();
  }

  /**
   * Pulls the captured caption lines (with real speaker names) and writes two sidecar files next
   * to the recording: a machine-readable `.captions.json` (used by the transcription/merge script)
   * and a human-readable `.transcript.txt`.
   */
  private async finalizeTranscript(): Promise<void> {
    if (!this.captionsActive || !this.recordingFilePath) return;

    const entries = await this.captions.stop();
    const participants = this.page ? await this.captions.getParticipants(this.page) : [];
    this.captionsActive = false;

    const base = this.recordingFilePath.replace(/\.wav$/i, '');
    const jsonPath = `${base}.captions.json`;
    const txtPath = `${base}.transcript.txt`;

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ recordingFile: path.basename(this.recordingFilePath), participants, captions: entries }, null, 2),
    );
    fs.writeFileSync(txtPath, this.formatTranscript(entries, participants));

    console.log(
      `[bot] Wrote transcript: ${entries.length} caption line(s) from ${participants.length} known participant(s) -> ${path.basename(txtPath)}`,
    );
    if (entries.length === 0) {
      console.warn(
        '[bot] No captions were captured. Live captions may not have turned on - watch the next ' +
          'run over VNC, or enable captions manually.',
      );
    }
  }

  private formatTranscript(entries: CaptionEntry[], participants: string[]): string {
    const fmt = (ms: number): string => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    let out = '--- Meeting Transcript (Teams live captions) ---\n\n';
    out +=
      entries.length > 0
        ? entries.map((e) => `[${fmt(e.tStartMs)}] ${e.speaker}: ${e.text}`).join('\n')
        : 'No captions were captured.';
    out += '\n\n--- Participants ---\n\n';
    out += participants.length > 0 ? participants.join('\n') : 'Not captured.';
    out += '\n';
    return out;
  }

  private async cleanupBrowser(): Promise<void> {
    this.stopProtocolDialogWatcher?.();
    this.stopProtocolDialogWatcher = null;
    try {
      await this.context?.close();
    } catch (err) {
      console.warn('[bot] error closing browser context:', err);
    }
    this.context = null;
    this.page = null;
  }

  /** Auto-stops the recording if the meeting ends without anyone calling /leave. */
  private startEndOfMeetingWatcher(): void {
    let aloneStreak = 0; // consecutive 10s ticks where bot appears to be alone

    this.pollHandle = setInterval(async () => {
      if (!this.page || this.state !== 'in_meeting') return;

      // Existing check: did the organiser end the meeting / bot was navigated away?
      const ended = await hasMeetingEnded(this.page);
      if (ended) {
        console.log('[bot] Meeting has ended - auto-stopping recording');
        this.stopEndOfMeetingWatcher();
        await this.leave().catch((err) => console.error('[bot] error during auto-leave:', err));
        return;
      }

      // New check: is the bot the only participant left?
      await dismissNativeProtocolDialogBestEffort(this.page);
      const count = await getParticipantCount(this.page);
      if (count !== null) {
        console.log(`[bot] Participant count: ${count}`);
      }
      if (count !== null && count <= 1) {
        aloneStreak++;
        console.log(`[bot] Bot appears to be alone in meeting (${aloneStreak * 10}s elapsed)`);
        // Wait 30 seconds before leaving — gives time for a participant who briefly
        // dropped connection to rejoin before the bot abandons the meeting.
        if (aloneStreak >= 3) {
          console.log('[bot] Bot has been alone for 30s - leaving meeting');
          this.stopEndOfMeetingWatcher();
          await this.leave().catch((err) => console.error('[bot] error during alone-leave:', err));
        }
      } else {
        aloneStreak = 0; // someone rejoined, reset the counter
      }
    }, 10_000);
  }

  private stopEndOfMeetingWatcher(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Gates hardware mic capture to match Teams roster mute for LOCAL_PARTICIPANT_NAME. */
  private startMuteTracker(): void {
    if (process.platform !== 'win32' || !LOCAL_PARTICIPANT_NAME || !this.page) return;

    this.muteTracker = new RosterMuteTracker(this.page, LOCAL_PARTICIPANT_NAME, (micEnabled) => {
      this.recorder.setMicGate(micEnabled);
    });
    this.muteTracker.start();
  }

  private stopMuteTracker(): void {
    this.muteTracker?.stop();
    this.muteTracker = null;
  }

  public async debugRosterHtml(): Promise<string> {
    if (!this.page) return 'No active meeting page.';
    await ensureRosterPanelOpen(this.page);
    return this.page.evaluate(() => {
      const candidates = [
        '#roster-content-list',
        '#people-pane-list',
        '[data-tid="people-pane"]',
        '[data-tid="calling-roster"]',
        '[role="list"]',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) return el.outerHTML;
      }
      return document.body.innerHTML;
    });
  }
}
