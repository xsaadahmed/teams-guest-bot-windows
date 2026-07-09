import { chromium, BrowserContext, Page, Route } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

/** Stable profile dir so we can persist "block msteams://" across runs. */
const BROWSER_PROFILE_DIR =
  process.env.TEAMS_BOT_BROWSER_PROFILE ||
  path.join(process.cwd(), '.teams-bot-browser-profile');

const CHROMIUM_POLICY_FILE = path.join(process.cwd(), 'windows', 'chromium-policy.json');
const DISMISS_DIALOG_EXE = path.join(process.cwd(), 'windows', 'DismissTeamsDialog', 'publish', 'DismissTeamsDialog.exe');

const EXTERNAL_PROTOCOL_SCHEMES = ['msteams', 'ms-teams', 'ms.team', 'com.microsoft.teams'];

const TEAMS_ORIGINS = ['https://teams.live.com:443,*', 'https://teams.microsoft.com:443,*'];

/**
 * Seed Chromium Preferences so teams.live.com / teams.microsoft.com cannot launch
 * ms-teams.exe. The "Open ms-teams.exe?" bubble is a native browser prompt — not a DOM
 * dialog — so page.click('Cancel') and page.on('dialog') cannot reach it.
 */
function ensureBrowserProfileBlocksTeamsApp(): void {
  const defaultDir = path.join(BROWSER_PROFILE_DIR, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });

  const prefsPath = path.join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  }

  const protocolHandler = (prefs.protocol_handler as Record<string, unknown> | undefined) ?? {};
  const excluded = (protocolHandler.excluded_schemes as Record<string, boolean> | undefined) ?? {};
  for (const scheme of EXTERNAL_PROTOCOL_SCHEMES) {
    excluded[scheme] = true;
  }
  protocolHandler.excluded_schemes = excluded;
  prefs.protocol_handler = protocolHandler;

  // Block camera for Teams origins (bot is audio-only). setting=2 is "block" in Chromium.
  const profile = (prefs.profile as Record<string, unknown> | undefined) ?? {};
  const contentSettings = (profile.content_settings as Record<string, unknown> | undefined) ?? {};
  const exceptions = (contentSettings.exceptions as Record<string, unknown> | undefined) ?? {};
  const cameraExceptions = (exceptions.media_stream_camera as Record<string, { setting: number }> | undefined) ?? {};
  // Block camera globally so Teams never activates the hardware (setting=2 is "block").
  cameraExceptions['*,*'] = { setting: 2 };
  for (const origin of TEAMS_ORIGINS) {
    cameraExceptions[origin] = { setting: 2 };
  }
  exceptions.media_stream_camera = cameraExceptions;
  contentSettings.exceptions = exceptions;
  profile.content_settings = contentSettings;
  prefs.profile = profile;

  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

function ensureChromiumPolicyFile(): string {
  if (!fs.existsSync(CHROMIUM_POLICY_FILE)) {
    fs.mkdirSync(path.dirname(CHROMIUM_POLICY_FILE), { recursive: true });
    fs.writeFileSync(
      CHROMIUM_POLICY_FILE,
      JSON.stringify({ URLBlocklist: ['msteams:*', 'ms-teams:*', 'com.microsoft.teams:*'] }),
    );
  }
  return CHROMIUM_POLICY_FILE.replace(/\\/g, '/');
}

/**
 * Best-effort dismiss of Chromium's native "Open ms-teams.exe?" bubble via Win32 + SendKeys.
 * Playwright keyboard events only reach the page, not browser-chrome dialogs.
 */
export async function dismissNativeProtocolDialogBestEffort(page?: Page): Promise<void> {
  if (!IS_WINDOWS) return;
  try {
    if (page) await page.bringToFront();
  } catch {
    // page may be navigating
  }
  if (!fs.existsSync(DISMISS_DIALOG_EXE)) return;
  try {
    await execFileAsync(DISMISS_DIALOG_EXE, [], { windowsHide: true, timeout: 15_000 });
  } catch {
    // dialog may not be present
  }
}

/** Poll briefly after join — Teams can show the protocol prompt several seconds late. */
export function startProtocolDialogWatcher(page: Page): () => void {
  if (!IS_WINDOWS) return () => undefined;
  const delaysMs = [500, 2500, 6000, 12000, 20000, 35000, 50000];
  const timers: NodeJS.Timeout[] = [];
  for (const delay of delaysMs) {
    timers.push(
      setTimeout(() => {
        dismissNativeProtocolDialogBestEffort(page).catch(() => undefined);
      }, delay),
    );
  }
  return () => {
    for (const t of timers) clearTimeout(t);
  };
}

/** Strip video from getUserMedia and hide cameras before Teams JS runs. */
async function blockCameraInBrowser(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;

    const stripVideo = (constraints?: MediaStreamConstraints): MediaStreamConstraints | undefined => {
      if (!constraints || typeof constraints !== 'object') return constraints;
      if (!('video' in constraints) || !constraints.video) return constraints;
      const next = { ...constraints };
      delete next.video;
      return next;
    };

    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      origGetUserMedia(stripVideo(constraints) ?? { audio: false });

    const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = () =>
      origEnum().then((devices) => devices.filter((d) => d.kind !== 'videoinput'));
  });
}

async function denyCameraViaCdp(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    const cdp = await context.newCDPSession(page);
    for (const origin of ['https://teams.live.com', 'https://teams.microsoft.com']) {
      try {
        await cdp.send('Browser.setPermission', {
          permission: { name: 'videoCapture' },
          setting: 'denied',
          origin,
        });
      } catch {
        // CDP permission API varies by Chromium build
      }
    }
  } catch (err) {
    console.warn('[browserLaunch] Could not deny camera via CDP (continuing):', err);
  }
}

/** Abort custom-scheme navigations (msteams:// etc.) before Chromium shows the native prompt. */
async function blockExternalProtocolHandlers(context: BrowserContext): Promise<void> {
  const handler = async (route: Route) => {
    const url = route.request().url();
    if (/^(msteams|ms-teams):/i.test(url)) {
      await route.abort();
      return;
    }
    await route.continue();
  };

  await context.route('**/*', handler);
  context.on('page', (page) => {
    page.route('**/*', handler).catch(() => undefined);
  });
}

/**
 * Chromium flags. Split into flags needed on every platform vs. Linux-only ones tied to
 * running headed-under-Xvfb with PulseAudio (the Docker path):
 *
 *  - `--use-pulseaudio` is meaningless outside that setup.
 *  - `--no-sandbox` / `--disable-setuid-sandbox` exist on Linux because Chromium's sandbox
 *    needs setuid helper binaries or user namespaces that typically aren't available (or
 *    worth fighting for) inside a container. On a normal Windows user session there's no
 *    equivalent problem, and it's worth NOT shipping `--no-sandbox` on a managed corporate
 *    laptop specifically: it's a real security-relevant flag there (not just a container
 *    workaround), and "chrome.exe --no-sandbox" spawned by an unfamiliar parent process is a
 *    pattern some corporate EDR/antivirus tools flag on sight.
 *
 * Trimmed down from a production Teams/Meet recording bot's verified flag set to just what
 * Teams needs (dropped Meet-specific anti-bot/stealth flags, proxy/timezone spoofing, and
 * resource-tuning flags that aren't load-bearing for a single personal-use bot).
 */
function buildLaunchArgs(width: number, height: number): string[] {
  const policyFile = ensureChromiumPolicyFile();
  const args = [
    `--window-size=${width},${height}`,
    '--window-position=0,0',
    '--lang=en-US',

    // Audio: make sure autoplay isn't blocked (Teams plays remote audio via an actual
    // <audio>/<video> element; if autoplay is blocked, you get a perfectly normal-looking
    // meeting with silent audio) and keep Chromium's own audio pipeline out of its stricter
    // sandbox, which matters more under virtualization/remote-session audio stacks.
    '--enable-audio-service-sandbox=false',
    '--audio-buffer-size=2048',
    '--disable-features=AudioServiceSandbox,ExternalProtocolPrompt',
    // Prevent "Open ms-teams.exe?" native protocol prompts (chrome-launcher tools flag).
    '--disable-external-intent-requests',
    '--autoplay-policy=no-user-gesture-required',

    // WebRTC: force software codec paths for consistency across whatever GPU/driver
    // situation the host has (real hardware, Xvfb, or a locked-down corporate image) - the
    // bot doesn't need hardware-accelerated video quality, just reliable audio.
    '--disable-webrtc-hw-decoding',
    '--disable-webrtc-hw-encoding',
    '--enable-webrtc-capture-audio',
    '--force-webrtc-ip-handling-policy=default',

    '--no-first-run',
    '--no-default-browser-check',
    // Hides navigator.webdriver from Teams' own page JS - about the page's automation
    // fingerprint, unrelated to the OS sandbox flags below, so this applies everywhere.
    '--disable-blink-features=AutomationControlled',
    `--policy-file=${policyFile}`,
  ];

  if (!IS_WINDOWS) {
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--use-pulseaudio');
  }

  return args;
}

export interface LaunchedBrowser {
  context: BrowserContext;
}

/**
 * Launches a persistent Chromium context configured to join Teams as a guest.
 *
 * headless: false is intentional on BOTH platforms - Teams' WebRTC join flow is far less
 * reliable in Chromium's native headless mode. On Linux that's the whole reason Xvfb exists
 * (a display for a headed browser nobody actually looks at); on Windows there's already a
 * real desktop session to render into, so no virtual-display step is needed at all - this
 * just opens a normal window on it.
 */
export async function launchTeamsBrowser(): Promise<LaunchedBrowser> {
  const width = Number(process.env.X11_WIDTH ?? 1280);
  const height = Number(process.env.X11_HEIGHT ?? 720);
  const executablePath = process.env.CHROME_PATH || undefined;

  ensureBrowserProfileBlocksTeamsApp();

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    viewport: { width, height },
    executablePath,
    locale: 'en-US',
    args: buildLaunchArgs(width, height),
    permissions: [],
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  });

  await blockCameraInBrowser(context);
  await denyCameraViaCdp(context);
  await context.grantPermissions(['microphone'], { origin: 'https://teams.live.com' });
  await context.grantPermissions(['microphone'], { origin: 'https://teams.microsoft.com' });
  await blockExternalProtocolHandlers(context);

  return { context };
}

/**
 * Best-effort, Windows-only, OFF BY DEFAULT: minimizes the Chromium window via CDP so it
 * doesn't sit on top of whatever the person is actually doing on their laptop. There's no
 * Xvfb-style "invisible display" option on Windows - the bot's window is a real window on
 * the real desktop unless something like this hides it.
 *
 * Left disabled until it's been verified on real hardware: Chrome can throttle timers in
 * minimized/hidden *windows* for power saving, and while it deliberately does NOT do this
 * for background *tabs* carrying an active WebRTC call, it isn't confirmed here whether a
 * minimized window gets the same exemption. Enable with MINIMIZE_BROWSER_WINDOW=true once
 * you've confirmed captions keep updating and the recording stays gap-free with it on.
 */
export async function minimizeWindowBestEffort(context: BrowserContext, page: Page): Promise<void> {
  if (!IS_WINDOWS || process.env.MINIMIZE_BROWSER_WINDOW !== 'true') return;
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    console.log('[browserLaunch] Minimized the browser window.');
  } catch (err) {
    console.warn('[browserLaunch] Could not minimize window (continuing with it visible):', err);
  }
}
