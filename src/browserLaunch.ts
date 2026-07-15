import { chromium, BrowserContext, Page, Route } from '@playwright/test';
import { execFile, execFileSync } from 'child_process';
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
 * Best-effort dismiss of Chromium's native "Open ms-teams.exe?" bubble via DismissTeamsDialog.exe.
 * Playwright keyboard events only reach the page, not browser-chrome dialogs.
 */
async function getChromiumPid(page?: Page): Promise<number | undefined> {
  if (!page) return undefined;
  try {
    const cdp = await page.context().newCDPSession(page);
    const { processId } = (await cdp.send('Browser.getBrowserPID' as never)) as { processId: number };
    return processId;
  } catch {
    return undefined;
  }
}

export { getChromiumPid };

export async function dismissNativeProtocolDialogBestEffort(page?: Page): Promise<boolean> {
  if (!IS_WINDOWS) return false;
  if (!fs.existsSync(DISMISS_DIALOG_EXE)) {
    console.warn('[browserLaunch] DismissTeamsDialog.exe not found — protocol prompt must be dismissed manually.');
    return false;
  }

  const pid = await getChromiumPid(page);
  const attempts: string[][] = pid ? [[String(pid)], []] : [[]];

  for (const args of attempts) {
    try {
      await execFileAsync(DISMISS_DIALOG_EXE, args, { windowsHide: true, timeout: 20_000 });
      console.log(`[browserLaunch] Dismissed native protocol dialog${pid ? ` (chrome pid ${pid})` : ''}.`);
      return true;
    } catch (err) {
      const exitCode = (err as { code?: number | string }).code;
      if (exitCode === 1 || exitCode === '1') continue;
      console.warn('[browserLaunch] DismissTeamsDialog failed:', err);
    }
  }

  return false;
}

/** Park Chromium far off-screen (normal window state — NOT minimized). */
const OFFSCREEN_X = -32000;
const OFFSCREEN_Y = 0;

/**
 * Silent join guard: shove Chromium off-screen and return OS focus to the user's window.
 *
 * Uses off-screen + windowState=normal (not minimize). Minimized windows set document.hidden
 * and break Teams roster/mute scraping; an off-screen "normal" window stays invisible to the
 * user but keeps the page "visible" for WebRTC + UI automation + protocol dismiss.
 */
export function startBackgroundFocusGuard(): {
  setChromePid: (pid: number | undefined) => void;
  poke: () => void;
  stop: () => void;
} {
  if (!IS_WINDOWS) {
    return { setChromePid: () => undefined, poke: () => undefined, stop: () => undefined };
  }

  let savedHwnd = '0';
  let chromePid = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  try {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FgCap {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
[string][FgCap]::GetForegroundWindow().ToInt64()
`;
    savedHwnd = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    }).trim();
  } catch (err) {
    console.warn('[browserLaunch] Could not capture foreground window:', err);
  }

  const demote = () => {
    if (!chromePid) return;
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SilentChrome {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  static uint TargetPid;
  static int OffX, OffY;
  static bool EnumCb(IntPtr hWnd, IntPtr lParam) {
    uint pid = 0;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid != TargetPid || !IsWindowVisible(hWnd)) return true;
    RECT r;
    if (!GetWindowRect(hWnd, out r)) return true;
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    if (w < 80 || h < 80) return true;
    if (r.Left > -10000) {
      ShowWindow(hWnd, 4); // SW_SHOWNOACTIVATE — keep normal, never minimize
      SetWindowPos(hWnd, (IntPtr)1, OffX, OffY, 0, 0, 0x0001 | 0x0010); // NOSIZE|NOACTIVATE, HWND_BOTTOM
    }
    return true;
  }
  public static void Park(uint pid, int x, int y) {
    TargetPid = pid; OffX = x; OffY = y;
    EnumWindows(EnumCb, IntPtr.Zero);
  }
  public static void RestoreFocus(IntPtr target, uint chromePid) {
    if (target == IntPtr.Zero || !IsWindow(target) || IsIconic(target)) return;
    IntPtr fg = GetForegroundWindow();
    uint fgPid = 0;
    GetWindowThreadProcessId(fg, out fgPid);
    if (fgPid != chromePid) return;
    uint ignored = 0;
    uint foreThread = GetWindowThreadProcessId(fg, out ignored);
    uint appThread = GetCurrentThreadId();
    if (foreThread != appThread) AttachThreadInput(appThread, foreThread, true);
    SetForegroundWindow(target);
    if (foreThread != appThread) AttachThreadInput(appThread, foreThread, false);
  }
}
"@
[SilentChrome]::Park([uint32]${chromePid}, ${OFFSCREEN_X}, ${OFFSCREEN_Y})
[SilentChrome]::RestoreFocus([IntPtr]${savedHwnd}, [uint32]${chromePid})
`;
    try {
      execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 4000 },
        () => undefined,
      );
    } catch {
      // best-effort
    }
  };

  return {
    setChromePid: (pid) => {
      chromePid = pid && pid > 0 ? pid : 0;
      if (!chromePid) return;
      demote();
      if (!timer) timer = setInterval(demote, 250);
      setTimeout(demote, 50);
      setTimeout(demote, 150);
      setTimeout(demote, 400);
      setTimeout(demote, 900);
      setTimeout(demote, 1800);
      setTimeout(demote, 3500);
    },
    poke: demote,
    stop: () => {
      // Final shove before letting go — then stop fighting the user if they open it from the taskbar.
      demote();
      chromePid = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** @deprecated Alias for startBackgroundFocusGuard. */
export function startChromiumFocusSuppressor(): {
  setChromePid: (pid: number | undefined) => void;
  poke: () => void;
  stop: () => void;
} {
  return startBackgroundFocusGuard();
}

/** Poll briefly after join — Teams can show the protocol prompt several seconds late. */
export function startProtocolDialogWatcher(page: Page): () => void {
  if (!IS_WINDOWS) return () => undefined;
  const delaysMs = [0, 200, 500, 1000, 2000, 3500, 5000, 8000, 12000, 18000, 25000, 35000, 50000];
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
    // Start already off-screen so the first paint doesn't flash over the user's UI.
    `--window-position=${OFFSCREEN_X},${OFFSCREEN_Y}`,
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
  // Off-screen (not minimized): silent for the user, but page stays "visible" for Teams.

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
 * Park Chromium off-screen (normal state). Always on for Windows so join stays silent.
 * Set KEEP_BROWSER_VISIBLE=true to leave the window on-screen for debugging.
 * (True minimize sets document.hidden and breaks roster/mute — we never use that.)
 */
export async function minimizeWindowBestEffort(context: BrowserContext, page: Page): Promise<void> {
  if (!IS_WINDOWS) return;
  if (process.env.KEEP_BROWSER_VISIBLE === 'true' || process.env.KEEP_BROWSER_VISIBLE === '1') return;
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: OFFSCREEN_X,
        top: OFFSCREEN_Y,
        width: Number(process.env.X11_WIDTH ?? 1280),
        height: Number(process.env.X11_HEIGHT ?? 720),
        windowState: 'normal',
      },
    });
    console.log('[browserLaunch] Parked Chromium off-screen (silent join).');
  } catch (err) {
    console.warn('[browserLaunch] Could not park Chromium off-screen:', err);
  }
}
