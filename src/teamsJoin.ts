import { Page, type Frame } from '@playwright/test';
import { dismissNativeProtocolDialogBestEffort } from './browserLaunch';

const NAME_INPUT_SELECTORS = [
  'input[placeholder="Type your name"]',
  'input[placeholder*="name" i]',
  'input[aria-label*="name" i]',
  'input[data-tid*="name-input" i]',
];

const DENIAL_TEXTS = [
  'Sorry, but you were denied access to the meeting.',
  'We need to verify your info before you can join',
];

// At least this many of these need to be visible for us to consider ourselves "in the meeting".
// A single match is too unreliable (Teams reuses generic button labels in a few different
// screens) - several at once is a much stronger signal.
const IN_MEETING_SELECTORS = [
  'button:has-text("React")',
  'button#raisehands-button:has-text("Raise")',
  'button[aria-label*="chat"]',
  'button[title*="chat"]',
  '[data-tid="roster-button"]',
  'button[id*="hangup"]',
];
const IN_MEETING_THRESHOLD = 2;

const ROSTER_BUTTON_SELECTORS = [
  '[data-tid="roster-button"]',
  '[data-inp="roster-button"]',
  '#roster-button',
  'button[aria-label*="People" i]',
  'button[aria-label*="participant" i]',
];

const ROSTER_ITEM_SELECTORS = [
  'li[data-cid="roster-participant"]',
  '[data-tid="roster-participant"]',
  '[data-tid="participant-item"]',
  '[data-tid="call-roster-list-item"]',
  '[data-tid="member-list-item"]',
  '.participant-title',
  '#roster-content-list [role="listitem"]',
  '#people-pane-list [role="listitem"]',
  '[data-tid="people-pane"] [role="listitem"]',
  '[data-tid="calling-roster"] [role="listitem"]',
];

type DomCountResult = { count: number | null; via: string; hints?: string[] };

async function clickRosterButton(page: Page): Promise<boolean> {
  for (const selector of ROSTER_BUTTON_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if ((await button.count()) > 0) {
        await button.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // try next selector
    }
  }
  // Teams sometimes renders meeting controls inside an iframe.
  for (const frame of page.frames()) {
    for (const selector of ROSTER_BUTTON_SELECTORS) {
      try {
        const button = frame.locator(selector).first();
        if ((await button.count()) > 0) {
          await button.click({ timeout: 2000 });
          return true;
        }
      } catch {
        // try next
      }
    }
  }
  return false;
}

/** Count participants in one frame. Runs inside the browser. */
function countParticipantsEvaluate(itemSelectors: string[]): DomCountResult {
  // IMPORTANT: To avoid false-positive auto-leaves, only trust EXPLICIT numeric
  // counts from Teams text (heading/button/body), not inferred counts from avatar
  // elements or generic list item totals. In some enterprise layouts those can
  // undercount and cause premature leaving.
  const headingPattern = /participant|people|in this meeting|present|attendee|in the meeting/i;
  const headings = Array.from(
    document.querySelectorAll(
      'h2, h3, h4, [role="heading"], [data-tid="people-pane"] span, [data-tid="roster-header"]',
    ),
  );
  for (const el of headings) {
    const text = (el.textContent || '').trim();
    if (!headingPattern.test(text)) continue;
    const match = text.match(/\((\d+)\)/) || text.match(/(\d+)/);
    if (match) return { count: parseInt(match[1], 10), via: `heading:${text.slice(0, 50)}` };
  }

  // Fallback: parse the common "In this meeting (N)" text anywhere in the page.
  const bodyText = document.body?.innerText || '';
  const bodyMatch = bodyText.match(/in this meeting\s*\((\d+)\)/i);
  if (bodyMatch) {
    return { count: parseInt(bodyMatch[1], 10), via: 'body:in this meeting' };
  }

  const hints: string[] = [];
  // Keep listing potential roster-related nodes for debugging selector drift.
  document
    .querySelectorAll('[data-tid*="roster" i], [data-tid*="participant" i], [data-tid*="people" i]')
    .forEach((el) => {
      hints.push(
        `${el.tagName}[data-tid=${el.getAttribute('data-tid')}] listitems=${el.querySelectorAll('[role="listitem"], li').length}`,
      );
    });

  return { count: null, via: 'none', hints: hints.slice(0, 12) };
}

async function countParticipantsFromDom(page: Page): Promise<DomCountResult & { frame?: string }> {
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(countParticipantsEvaluate, ROSTER_ITEM_SELECTORS);
      if (result.count !== null) {
        return { ...result, frame: frame.url() };
      }
    } catch {
      // frame may be detached
    }
  }
  // Return last frame's hints for debugging (main frame first).
  try {
    const debug = await page.mainFrame().evaluate(countParticipantsEvaluate, ROSTER_ITEM_SELECTORS);
    return debug;
  } catch {
    return { count: null, via: 'none' };
  }
}

function parseCountFromRosterLabel(label: string): number | null {
  const match = label.match(/\((\d+)\)|(\d+)\s*participant/i);
  if (match) return parseInt(match[1] ?? match[2], 10);
  return null;
}

async function readRosterButtonLabel(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    try {
      const label = await frame.evaluate((selectors) => {
        for (const selector of selectors) {
          const btn = document.querySelector(selector) as HTMLElement | null;
          if (btn) return (btn.getAttribute('aria-label') || btn.textContent || '').trim();
        }
        return null;
      }, ROSTER_BUTTON_SELECTORS);
      if (label) return label;
    } catch {
      // try next frame
    }
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Teams shows a full-screen modal when mic/camera are blocked at the browser level:
 * "Are you sure you don't want audio or video?" with a "Continue without audio or video" button.
 * Until dismissed it blocks roster, mute icons, and most meeting controls.
 */
export async function dismissAvPermissionModalIfPresent(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;

  const tryContext = async (ctx: Page | Frame): Promise<boolean> => {
    try {
      const byRole = ctx.getByRole('button', { name: /continue without audio or video/i });
      if ((await byRole.count()) > 0) {
        await byRole.first().click({ timeout: 2000 });
        return true;
      }
    } catch {
      // not visible / not clickable
    }

    try {
      return await ctx.evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        const looksLikeAvModal =
          body.includes("don't want audio") || body.includes('continue without audio or video');
        if (!looksLikeAvModal) return false;

        for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (text.includes('continue without audio')) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  if (await tryContext(page)) {
    console.log('[teamsJoin] Dismissed "Continue without audio or video" modal');
    await sleep(600);
    return true;
  }

  for (const frame of page.frames()) {
    if (await tryContext(frame)) {
      console.log('[teamsJoin] Dismissed "Continue without audio or video" modal (iframe)');
      await sleep(600);
      return true;
    }
  }

  return false;
}

/** Poll while in-meeting — the AV modal can appear late and block roster/mute scraping. */
export function startAvPermissionModalWatcher(page: Page): () => void {
  const interval = setInterval(() => {
    if (page.isClosed()) return;
    void dismissAvPermissionModalIfPresent(page);
  }, 2000);
  return () => clearInterval(interval);
}

/** When false, the bot never clicks the People/roster button (manual UI debugging). */
export function isRosterAutomationEnabled(): boolean {
  const raw = (process.env.DISABLE_ROSTER_AUTOMATION ?? '').trim().toLowerCase();
  return raw !== '1' && raw !== 'true' && raw !== 'yes';
}

/**
 * Idempotent: does nothing if the roster panel is already open. Both getParticipantCount()
 * and roster-side readers call this before reading from the panel — the one place that
 * decides whether to click the roster button. Once opened, nothing closes it again.
 *
 * Set DISABLE_ROSTER_AUTOMATION=1 to skip opening the roster (e.g. while inspecting
 * Meeting info or other side panels manually).
 */
export async function ensureRosterPanelOpen(page: Page): Promise<void> {
  await dismissAvPermissionModalIfPresent(page);
  if (!isRosterAutomationEnabled()) return;

  const alreadyOpen = (await countParticipantsFromDom(page)).count !== null;
  if (!alreadyOpen) {
    await clickRosterButton(page);
    await sleep(2000); // give Teams time to render the panel content
  }
}

/**
 * Clicks a button matched by its exact visible text. Loops a few times since Teams'
 * UI renders progressively and the button you want often isn't there yet on the first check.
 */
async function clickButtonWithText(
  page: Page,
  text: string,
  attempts = 3,
  click = true,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const found = await page.evaluate(
        ({ text, click }) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const el of buttons) {
            if (el.textContent?.trim() === text) {
              if (click) (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        },
        { text, click },
      );
      if (found) return true;
    } catch {
      // page may be navigating - just retry
    }
    await sleep(300);
  }
  return false;
}

/** Click an exact button label in the main page or any iframe (Teams embeds vary). */
async function clickButtonWithTextAnywhere(
  page: Page,
  text: string,
  click = true,
): Promise<boolean> {
  if (await clickButtonWithText(page, text, 1, click)) return true;
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(
        ({ text, click }) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const el of buttons) {
            if (el.textContent?.trim() === text) {
              if (click) (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        },
        { text, click },
      );
      if (found) return true;
    } catch {
      // frame not ready
    }
  }
  return false;
}

/** Pre-join launcher controls may be buttons, links, or live inside iframes. */
async function clickPreJoinControl(page: Page, text: string): Promise<boolean> {
  if (await clickButtonWithTextAnywhere(page, text)) return true;

  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate((label) => {
        const candidates = Array.from(
          document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
        );
        for (const el of candidates) {
          // Don't require offsetParent — off-screen / opacity tricks can make that null.
          const content = (el.textContent || (el as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim();
          if (content === label || content.includes(label)) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, text);
      if (clicked) return true;
    } catch {
      // frame not ready
    }
  }

  try {
    const byRole = page.getByRole('button', { name: text });
    if ((await byRole.count()) > 0) {
      await byRole.first().evaluate((el) => (el as HTMLElement).click());
      return true;
    }
    const byLink = page.getByRole('link', { name: text });
    if ((await byLink.count()) > 0) {
      await byLink.first().evaluate((el) => (el as HTMLElement).click());
      return true;
    }
  } catch {
    // not on this layout
  }

  return false;
}

/**
 * Dismisses in-page "Get the desktop app" promos (HTML modals). Does NOT affect the native
 * Chromium "Open ms-teams.exe?" protocol bubble — see browserLaunch.ts for that.
 * Avoids clicking "Cancel" on the pre-join screen (that aborts the join).
 */
async function dismissNativeAppPromptIfPresent(page: Page): Promise<boolean> {
  const onPreJoinScreen = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some((b) => b.textContent?.trim() === 'Join now');
  });
  if (onPreJoinScreen) return false;

  for (const label of ['Cancel', 'No thanks', 'Not now']) {
    if (await clickButtonWithTextAnywhere(page, label)) {
      console.log(`[teamsJoin] Dismissed in-page app promo via "${label}"`);
      return true;
    }
  }
  return false;
}

async function typeDisplayName(page: Page, name: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    for (const frame of page.frames()) {
      for (const selector of NAME_INPUT_SELECTORS) {
        try {
          const input = frame.locator(selector).first();
          if ((await input.count()) === 0) continue;
          await input.focus();
          await input.fill(name);
          if ((await input.inputValue()) === name) {
            console.log(`[teamsJoin] Filled display name via ${selector}`);
            return;
          }
        } catch {
          // input not ready yet
        }
      }
    }
    await sleep(500);
  }
  throw new Error('Could not find/fill the "Type your name" field - Teams join UI may have changed.');
}

async function isMicMuted(page: Page): Promise<boolean | undefined> {
  if ((await page.locator('button[title="Unmute mic"]').count()) > 0) return true;
  if ((await page.locator('button[title="Mute mic"]').count()) > 0) return false;
  return undefined; // couldn't tell - Teams may be on the "continue without audio" path
}

async function muteMicIfNeeded(page: Page): Promise<void> {
  try {
    const muted = await isMicMuted(page);
    if (muted === false) {
      // Ctrl+Shift+M is Teams' mic-toggle shortcut.
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyM');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await sleep(500);
    }
  } catch (err) {
    console.warn('[teamsJoin] Could not confirm/mute microphone, continuing anyway:', err);
  }
}

async function isCameraOn(page: Page): Promise<boolean | undefined> {
  for (const frame of page.frames()) {
    try {
      const state = await frame.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('[role="switch"], button[aria-pressed], input[type="checkbox"]'));
        for (const el of toggles) {
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
          if (!label.includes('camera') && !label.includes('video')) continue;
          if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true') return true;
          if ((el as HTMLInputElement).checked) return true;
          if (el.getAttribute('aria-checked') === 'false' || el.getAttribute('aria-pressed') === 'false') return false;
        }
        for (const sel of [
          'button[title="Turn on camera"]',
          'button[title="Turn camera on"]',
          'button[aria-label*="Turn on camera" i]',
        ]) {
          if (document.querySelector(sel)) return false;
        }
        for (const sel of [
          'button[title="Turn off camera"]',
          'button[title="Turn camera off"]',
          'button[aria-label*="Turn off camera" i]',
        ]) {
          if (document.querySelector(sel)) return true;
        }
        return undefined;
      });
      if (state !== undefined) return state;
    } catch {
      // frame not ready
    }
  }
  return undefined;
}

async function clickCameraOffInFrame(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('[role="switch"], button[aria-pressed], input[type="checkbox"]'));
        for (const el of toggles) {
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
          if (!label.includes('camera') && !label.includes('video')) continue;
          const on =
            el.getAttribute('aria-checked') === 'true' ||
            el.getAttribute('aria-pressed') === 'true' ||
            (el as HTMLInputElement).checked;
          if (on) {
            (el as HTMLElement).click();
            return true;
          }
        }
        for (const btn of Array.from(document.querySelectorAll('button'))) {
          const t = (btn.getAttribute('title') || btn.getAttribute('aria-label') || '').toLowerCase();
          if (t.includes('turn off camera') || t.includes('turn camera off')) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) return true;
    } catch {
      // frame not ready
    }
  }
  return false;
}

async function turnOffCameraIfNeeded(page: Page): Promise<void> {
  try {
    // Do not bringToFront() here — that steals OS focus from the user's meeting client.
    if (await clickCameraOffInFrame(page)) {
      await sleep(500);
      const stillOn = await isCameraOn(page);
      if (stillOn === false || stillOn === undefined) {
        console.log('[teamsJoin] Turned off camera via toggle/switch');
        return;
      }
    }

    const on = await isCameraOn(page);
    if (on === false) return;

    if (on === true) {
      const toggle = page.locator(
        'button[title="Turn off camera"], button[title="Turn camera off"], ' +
          'button[aria-label*="Turn off camera" i], button[aria-label*="Turn camera off" i]',
      );
      if ((await toggle.count()) > 0) {
        await toggle.first().click({ timeout: 2000 });
        await sleep(500);
        console.log('[teamsJoin] Turned off camera via toggle button');
        return;
      }
    }

    // Fallback: Ctrl+Shift+O is Teams' camera-toggle shortcut on the pre-join screen.
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyO');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await sleep(500);
    console.log('[teamsJoin] Sent camera-off shortcut (Ctrl+Shift+O)');
  } catch (err) {
    console.warn('[teamsJoin] Could not confirm/turn off camera, continuing anyway:', err);
  }
}

async function checkDenied(page: Page): Promise<string | null> {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const text of DENIAL_TEXTS) {
      if (bodyText.includes(text)) return text;
    }
  } catch {
    // ignore - page may be navigating
  }
  return null;
}

async function countInMeetingSignals(page: Page): Promise<number> {
  let count = 0;
  for (const selector of IN_MEETING_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) count++;
    } catch {
      // selector errors shouldn't abort the whole check
    }
  }
  return count;
}

export type JoinOutcome =
  | { status: 'joined'; page?: Page }
  | { status: 'denied'; reason: string; page?: Page }
  | { status: 'timeout'; page?: Page };

function isTeamsMarketingPage(url: string): boolean {
  return /teams\.live\.com\/free(?:\/|$|\?)/i.test(url);
}

function isLauncherPage(url: string): boolean {
  return /\/dl\/launcher\//i.test(url) || /launcher\.html/i.test(url);
}

/** Re-navigate only if Chromium landed on the Teams Free marketing home, not intermediate launcher pages. */
async function ensureNotOnMarketingPage(page: Page, joinUrl: string): Promise<void> {
  const url = page.url();
  if (!isTeamsMarketingPage(url)) return;
  console.log(`[teamsJoin] On marketing page (${url}), navigating to ${joinUrl}`);
  await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(1000);
}

/** Prefer a tab that has join UI if Teams opened a second tab (common with dl/launcher). */
async function pickActiveJoinPage(seed: Page): Promise<Page> {
  const context = seed.context();
  const pages = context.pages().filter((p) => !p.isClosed());
  for (const p of pages) {
    try {
      const url = p.url();
      if (isLauncherPage(url) || /\/meet\//i.test(url) || /light-meetings/i.test(url) || /meetingjoin/i.test(url)) {
        return p;
      }
    } catch {
      // ignore
    }
  }
  return seed;
}

/**
 * Drives the actual Teams join flow: clicks through the pre-join screens, types the guest
 * display name, joins muted/camera-off, then polls until either we're clearly in the meeting
 * or clearly denied/stuck. `joinUrl` should already be the transformed direct-join URL.
 */
export async function joinTeamsMeeting(
  page: Page,
  joinUrl: string,
  displayName: string,
  maxWaitMs = 5 * 60_000,
): Promise<JoinOutcome> {
  console.log(`[teamsJoin] Opening ${joinUrl}`);
  try {
    await page.goto(joinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    console.warn('[teamsJoin] Initial navigation warning (continuing):', (err as Error).message);
  }
  await dismissNativeProtocolDialogBestEffort(page);
  await ensureNotOnMarketingPage(page, joinUrl);
  page = await pickActiveJoinPage(page);
  console.log(`[teamsJoin] Active page: ${page.url()}`);

  // Click through whichever pre-join variant Teams shows us. These appear in different orders/
  // combinations depending on Teams' current experiment bucket, so we just keep checking for a
  // while rather than assuming a fixed sequence.
  for (let i = 0; i < 40; i++) {
    page = await pickActiveJoinPage(page);
    await ensureNotOnMarketingPage(page, joinUrl);
    await dismissNativeProtocolDialogBestEffort(page);
    await dismissNativeAppPromptIfPresent(page);

    // Scan every open tab — launcher often lands on a different page than the one we navigated.
    let continued = false;
    for (const p of page.context().pages()) {
      if (p.isClosed()) continue;
      if (await clickPreJoinControl(p, 'Continue on this browser')) {
        console.log(`[teamsJoin] Clicked "Continue on this browser" (${p.url()})`);
        page = p;
        continued = true;
        await dismissNativeProtocolDialogBestEffort(page);
        await sleep(800);
        break;
      }
    }
    if (!continued && isLauncherPage(page.url()) && i % 5 === 4) {
      console.log(`[teamsJoin] Still on launcher (${page.url()}) — retrying Continue…`);
    }

    if (await dismissAvPermissionModalIfPresent(page)) {
      await sleep(500);
    }
    if (await clickPreJoinControl(page, 'Continue without audio or video')) {
      console.log('[teamsJoin] Clicked "Continue without audio or video"');
      await sleep(1000);
    }
    if (await clickButtonWithTextAnywhere(page, 'Join now', false)) {
      // It's present - move on to the name-entry step below rather than clicking it yet
      // (we need to type the display name into the field on this same screen first).
      break;
    }
    await sleep(500);
  }

  page = await pickActiveJoinPage(page);

  try {
    await typeDisplayName(page, displayName);
  } catch (err) {
    console.warn('[teamsJoin]', (err as Error).message);
    // Some join variants skip the name field entirely (e.g. already-authenticated org accounts) -
    // not necessarily fatal, so we continue rather than aborting here.
  }

  await muteMicIfNeeded(page);
  await turnOffCameraIfNeeded(page);
  await sleep(500);
  await turnOffCameraIfNeeded(page);

  await dismissNativeProtocolDialogBestEffort(page);
  console.log(`[teamsJoin] Pre-join page: ${page.url()}`);
  if (await clickButtonWithText(page, 'Join now', 20)) {
    console.log('[teamsJoin] Clicked "Join now"');
  } else if (await clickButtonWithTextAnywhere(page, 'Join now')) {
    console.log('[teamsJoin] Clicked "Join now" (iframe)');
  } else {
    console.warn('[teamsJoin] Could not find "Join now" button');
  }
  await dismissNativeProtocolDialogBestEffort(page);

  // Now wait (this is the lobby/waiting-room period if the organizer has one enabled) until
  // either we're clearly in, clearly denied, or we time out.
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    page = await pickActiveJoinPage(page);
    await ensureNotOnMarketingPage(page, joinUrl);
    await dismissAvPermissionModalIfPresent(page);

    // Keep dismissing the launcher if Teams bounced us back.
    for (const p of page.context().pages()) {
      if (p.isClosed()) continue;
      if (await clickPreJoinControl(p, 'Continue on this browser')) {
        console.log('[teamsJoin] Clicked "Continue on this browser" (post-join wait)');
        page = p;
        await sleep(800);
      }
    }

    const denialReason = await checkDenied(page);
    if (denialReason) {
      return { status: 'denied', reason: denialReason, page };
    }

    const signals = await countInMeetingSignals(page);
    if (signals >= IN_MEETING_THRESHOLD) {
      return { status: 'joined', page };
    }

    await sleep(2000);
  }

  return { status: 'timeout', page };
}

const RECORDING_NOTICE = 'This meeting is being recorded';

const CHAT_BUTTON_SELECTORS = [
  // Toolbar Chat next to People — prefer exact matches only (fuzzy "*Chat*" hits overflow/menus).
  '#chat-button',
  'button#chat-button',
  'button[aria-label="Chat"]',
  'button[data-tid="chat-button"]',
  'button[id="chat-button"]',
];

/** Overflow ("…") only if the toolbar Chat button is hidden on this layout. */
const MORE_BUTTON_SELECTORS = [
  'button[aria-label="More"]',
  'button[aria-label="More actions"]',
  'button[aria-label*="More" i]',
  '#callingButtons-showMoreBtn',
  'button[data-tid="callingButtons-showMoreBtn"]',
  'button[id*="showMore" i]',
];

/**
 * Opens Meeting info if needed and reads `[data-tid="call-title"]`.
 * Closes the panel afterward (Escape) so chat/roster side panels are not blocked.
 */
export async function readMeetingTitle(page: Page): Promise<string | null> {
  const contexts: Array<Page | Frame> = [page, ...page.frames()];

  const readTitle = async (ctx: Page | Frame): Promise<string | null> => {
    try {
      const loc = ctx.locator('[data-tid="call-title"]');
      if (!(await loc.isVisible().catch(() => false))) return null;
      const text = (await loc.textContent())?.trim();
      return text || null;
    } catch {
      return null;
    }
  };

  const openMeetingInfo = async (ctx: Page | Frame): Promise<boolean> => {
    try {
      for (const sel of MORE_BUTTON_SELECTORS) {
        const more = ctx.locator(sel).first();
        if (!(await more.isVisible().catch(() => false))) continue;
        await more.click();
        await sleep(600);
        const item = ctx.getByRole('menuitem', { name: /meeting info/i });
        if (await item.isVisible().catch(() => false)) {
          await item.click();
          await ctx.locator('[data-tid="call-title"]').waitFor({ timeout: 5000 }).catch(() => null);
          return true;
        }
        await page.keyboard.press('Escape').catch(() => undefined);
      }
      return false;
    } catch (err) {
      console.warn('[teamsJoin] Could not open Meeting info:', err);
      return false;
    }
  };

  const closePanel = async (): Promise<void> => {
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(200);
  };

  for (const ctx of contexts) {
    const existing = await readTitle(ctx);
    if (existing) {
      await closePanel();
      console.log(`[teamsJoin] Meeting title: "${existing}"`);
      return existing;
    }
  }

  for (const ctx of contexts) {
    if (!(await openMeetingInfo(ctx))) continue;
    const title = (await readTitle(ctx)) || (await readTitle(page));
    await closePanel();
    if (title) {
      console.log(`[teamsJoin] Meeting title: "${title}"`);
      return title;
    }
  }

  console.warn('[teamsJoin] Could not read meeting title from Meeting info panel.');
  return null;
}

const CHAT_EDITOR_SELECTORS = [
  'div[data-tid="ckeditor"]',
  '[data-tid="ckeditor"]',
  '[aria-label="Type a message"]',
  '[aria-label*="Type a message" i]',
  '[data-tid="ckeditor"] [contenteditable="true"]',
  '[contenteditable="true"][aria-label*="message" i]',
];

const CHAT_SEND_SELECTORS = [
  'button[data-tid="send-message-button"]',
  'button[data-tid="newMessageCommands-send"]',
  'button[aria-label="Send"]',
  'button[aria-label*="Send" i]',
  'button[title="Send"]',
  '[data-tid="sendMessage"]',
  '[data-tid="chat-pane-compose-message-footer"] button[type="submit"]',
  '[data-tid="chat-pane-compose-message-footer"] button[aria-label*="Send" i]',
];

/**
 * Opens the Meeting chat panel and posts a short notice. Best-effort — failures must never
 * abort an otherwise successful join (chat UI varies across Teams light vs classic).
 *
 * Retries for a while: the toolbar (and #chat-button) often appears several seconds after
 * we consider ourselves "in meeting".
 */
export async function postRecordingNoticeInChat(page: Page, message = RECORDING_NOTICE): Promise<boolean> {
  // Keep this short — we deliberately run before roster/mute tracking starts, and Teams only
  // shows one side panel at a time.
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (page.isClosed()) return false;

      const opened = await ensureChatPanelOpen(page);
      if (!opened) {
        if (attempt === 1 || attempt % 2 === 0) {
          console.log(`[teamsJoin] Chat button not ready (attempt ${attempt}/${maxAttempts})…`);
        }
        await sleep(700);
        continue;
      }

      await sleep(500);
      const typed = await typeAndSendChatMessage(page, message);
      if (typed) {
        console.log(`[teamsJoin] Posted chat notice: "${message}"`);
        // Brief pause so Teams commits the send before anything else opens People.
        await sleep(800);
        return true;
      }

      console.log(`[teamsJoin] Chat compose box not ready (attempt ${attempt}/${maxAttempts})…`);
      await sleep(700);
    } catch (err) {
      console.warn(`[teamsJoin] Chat notice attempt ${attempt} failed:`, err);
      await sleep(700);
    }
  }

  console.warn('[teamsJoin] Could not post recording notice in chat after retries.');
  return false;
}

async function ensureChatPanelOpen(page: Page): Promise<boolean> {
  // Only treat compose as open if it's a real on-screen Type-a-message box (not a hidden node).
  if (await findChatEditorLocator(page)) {
    console.log('[teamsJoin] Chat compose already open');
    return true;
  }

  // 1) Toolbar Chat next to People
  for (const frame of page.frames()) {
    for (const selector of CHAT_BUTTON_SELECTORS) {
      try {
        const btn = frame.locator(selector).first();
        if ((await btn.count()) === 0) continue;
        const usable = await btn.evaluate((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        });
        if (!usable) continue;
        await btn.evaluate((el) => (el as HTMLElement).click());
        console.log(`[teamsJoin] Clicked toolbar Chat via ${selector}`);
        await sleep(1200);
        if (await findChatEditorLocator(page)) return true;
      } catch {
        // try next
      }
    }
  }

  // 2) Fallback: open … More, then Chat (only if toolbar Chat isn't present)
  console.log('[teamsJoin] Toolbar Chat not found — trying More (⋯) menu…');
  for (const frame of page.frames()) {
    for (const selector of MORE_BUTTON_SELECTORS) {
      try {
        const more = frame.locator(selector).first();
        if ((await more.count()) === 0) continue;
        await more.evaluate((el) => (el as HTMLElement).click());
        console.log(`[teamsJoin] Opened More menu via ${selector}`);
        await sleep(600);
        const chatItem = frame
          .locator(
            '[role="menuitem"]:has-text("Chat"), [role="menuitem"][aria-label="Chat"], button:has-text("Chat"), [aria-label="Chat"]',
          )
          .first();
        if ((await chatItem.count()) > 0) {
          await chatItem.evaluate((el) => (el as HTMLElement).click());
          console.log('[teamsJoin] Clicked Chat inside More menu');
          await sleep(1200);
          if (await findChatEditorLocator(page)) return true;
        }
      } catch {
        // try next
      }
    }
  }

  return false;
}

async function findChatEditorLocator(page: Page) {
  for (const frame of page.frames()) {
    for (const selector of CHAT_EDITOR_SELECTORS) {
      try {
        const editor = frame.locator(selector).first();
        if ((await editor.count()) === 0) continue;
        // Prefer an actually editable node when nested.
        const candidate = (await editor.locator('[contenteditable="true"]').count()) > 0
          ? editor.locator('[contenteditable="true"]').first()
          : editor;
        // Reject hidden / zero-size nodes (false positives when chat isn't open).
        const usable = await candidate.evaluate((el) => {
          const node = el as HTMLElement;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const r = node.getBoundingClientRect();
          if (r.width < 40 || r.height < 16) return false;
          const label = (node.getAttribute('aria-label') || '').toLowerCase();
          const tid = (node.getAttribute('data-tid') || '').toLowerCase();
          // Must look like meeting chat compose, not some other contenteditable.
          return (
            tid.includes('ckeditor') ||
            label.includes('type a message') ||
            !!node.closest('[data-tid*="chat"], [data-tid*="compose"], #chat-pane-list, [aria-label*="Meeting chat"]')
          );
        });
        if (!usable) continue;
        return candidate;
      } catch {
        // frame gone
      }
    }
  }
  return null;
}

async function typeAndSendChatMessage(page: Page, message: string): Promise<boolean> {
  const editor = await findChatEditorLocator(page);
  if (!editor) return false;

  try {
    // Focus via DOM (works off-screen). Prefer CDP Input.insertText — it types into the
    // focused element without bringing Chromium to the foreground (unlike page.keyboard).
    await editor.evaluate((el) => {
      const node = el as HTMLElement;
      node.focus();
    });
    await sleep(150);

    const cdp = await page.context().newCDPSession(page);
    try {
      // Select-all + delete any leftover draft.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers: 2, // Ctrl
        windowsVirtualKeyCode: 65,
        code: 'KeyA',
        key: 'a',
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: 2,
        windowsVirtualKeyCode: 65,
        code: 'KeyA',
        key: 'a',
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 8,
        code: 'Backspace',
        key: 'Backspace',
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 8,
        code: 'Backspace',
        key: 'Backspace',
      });
      await cdp.send('Input.insertText', { text: message });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    await sleep(400);

    let draft = ((await editor.innerText().catch(() => '')) || '').trim();
    if (!draft.includes(message.slice(0, 12))) {
      // Last resort: keyboard (may briefly focus Chromium).
      console.warn(`[teamsJoin] CDP insertText missed (saw: "${draft.slice(0, 40)}"), trying keyboard…`);
      await editor.evaluate((el) => (el as HTMLElement).focus());
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(message, { delay: 20 });
      await sleep(400);
      draft = ((await editor.innerText().catch(() => '')) || '').trim();
    }

    if (!draft.includes(message.slice(0, 12))) {
      console.warn(`[teamsJoin] Compose box did not accept text (saw: "${draft.slice(0, 40)}")`);
      return false;
    }
    console.log('[teamsJoin] Typed recording notice into compose box');

    let sent = false;
    for (const frame of page.frames()) {
      for (const selector of CHAT_SEND_SELECTORS) {
        try {
          const send = frame.locator(selector).first();
          if ((await send.count()) === 0) continue;
          await send.evaluate((el) => (el as HTMLElement).click());
          sent = true;
          console.log(`[teamsJoin] Sent chat via ${selector}`);
          break;
        } catch {
          // try next
        }
      }
      if (sent) break;
    }

    if (!sent) {
      const cdpEnter = await page.context().newCDPSession(page);
      try {
        await cdpEnter.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          windowsVirtualKeyCode: 13,
          code: 'Enter',
          key: 'Enter',
        });
        await cdpEnter.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: 13,
          code: 'Enter',
          key: 'Enter',
        });
        console.log('[teamsJoin] Sent chat via Enter (CDP)');
      } finally {
        await cdpEnter.detach().catch(() => undefined);
      }
    }

    await sleep(900);

    const after = ((await editor.innerText().catch(() => '')) || '').trim();
    if (!after.includes(message.slice(0, 12))) {
      console.log('[teamsJoin] Compose cleared after send — treating as success');
      return true;
    }

    for (const frame of page.frames()) {
      try {
        const hit = await frame.evaluate((msg) => (document.body?.innerText || '').includes(msg), message);
        if (hit) {
          console.log('[teamsJoin] Found notice text in chat pane');
          return true;
        }
      } catch {
        // ignore
      }
    }

    console.warn('[teamsJoin] Send attempted but message still in compose / not found in pane');
    return false;
  } catch (err) {
    console.warn('[teamsJoin] typeAndSendChatMessage failed:', err);
    return false;
  }
}

/**
 * Best-effort leave: click the "Leave" button if we can find it, otherwise the caller should
 * just close the browser context.
 */
export async function leaveTeamsMeeting(page: Page): Promise<boolean> {
  try {
    if (await clickButtonWithText(page, 'Leave', 5)) return true;
    const byRole = page.getByRole('button', { name: 'Leave' });
    if ((await byRole.count()) > 0) {
      await byRole.click();
      return true;
    }
  } catch (err) {
    console.warn('[teamsJoin] Error while trying to click Leave:', err);
  }
  return false;
}

/**
 * True once the in-meeting signals disappear (the organizer ended the meeting, or we were
 * removed) - used to auto-stop recording even if nobody calls /leave.
 */
export async function hasMeetingEnded(page: Page): Promise<boolean> {
  try {
    if (page.isClosed()) return true;
    const signals = await countInMeetingSignals(page);
    return signals < IN_MEETING_THRESHOLD;
  } catch {
    // If we can't even evaluate on the page anymore, treat that as "ended".
    return true;
  }
}

/**
 * Returns the number of participants currently in the meeting, or null if it
 * can't be determined. Used to detect "bot is alone" so it can auto-leave.
 *
 * Tries three sources in order:
 *   1. The aria-label on the roster button (fast, no UI interaction).
 *   2. Heading/body text in the DOM if the panel is already open.
 *   3. ensureRosterPanelOpen(), then read again (panel stays open for subsequent polls).
 */
export async function getParticipantCount(page: Page): Promise<number | null> {
  try {
    await dismissAvPermissionModalIfPresent(page);
    const label = await readRosterButtonLabel(page);
    if (label) {
      const fromLabel = parseCountFromRosterLabel(label);
      if (fromLabel !== null) return fromLabel;
    }

    let result = await countParticipantsFromDom(page);
    if (result.count !== null) return result.count;

    await ensureRosterPanelOpen(page);
    result = await countParticipantsFromDom(page);

    if (result.count !== null) {
      console.log(
        `[teamsJoin] Participant count from roster panel: ${result.count} (via ${result.via}${result.frame ? `, frame=${result.frame}` : ''})`,
      );
      return result.count;
    }
    console.log(`[teamsJoin] Roster panel opened but no participant count found (via ${result.via})`);
    if (result.hints?.length) {
      console.log(`[teamsJoin] Roster DOM hints: ${result.hints.join('; ')}`);
    }

    if (label) {
      console.log(`[teamsJoin] Could not parse participant count; roster label was: "${label}"`);
    }

    return null;
  } catch (err) {
    console.warn('[teamsJoin] getParticipantCount error:', (err as Error).message);
    return null;
  }
}
