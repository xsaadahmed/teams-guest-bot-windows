# Running teams-guest-bot natively on Windows (no Docker/WSL2)

This is the AVD-laptop path: no admin rights, no reboot, no nested virtualization, so
Docker Desktop/WSL2 can never run there. This runs the exact same bot as a normal Windows
process on the physical laptop instead, which has none of those restrictions.

## What actually changed

Only the two pieces that were genuinely Linux-specific:

| Piece | Linux/Docker | Windows |
|---|---|---|
| Display for the headed browser | Xvfb (virtual framebuffer) | Nothing needed - a normal Windows desktop session already has a real one |
| "Record what the browser is playing" | PulseAudio virtual sink + `ffmpeg -f pulse` | WASAPI loopback capture via a small bundled `.exe` (`windows/WasapiLoopbackRecorder`) |

That's it. Everything else - joining the meeting, the lobby/name-entry flow, reading Teams'
live captions, the HTTP API, the transcript file format - is plain Playwright browser
automation and plain Node.js. None of it touches the OS. `server.ts`, `teamsJoin.ts`,
`captionTracker.ts`, and `teamsUrl.ts` are **unmodified**.

`browserLaunch.ts` changed only to: drop `--use-pulseaudio` and the Linux sandbox flags on
Windows (see comments in that file for why `--no-sandbox` specifically is worth NOT carrying
over to a managed corporate laptop), and add an optional window-minimizing helper (off by
default - see "Window visibility" below). `headless: false` is unchanged and deliberate on
both platforms - Teams' WebRTC join flow is unreliable in Chromium's true headless mode,
which is the whole reason Xvfb existed in the first place, not something specific to Linux.

## Why WASAPI loopback via a small `.exe`, and not ffmpeg directly

Worth spelling out since it's the one place the "just swap the Linux tool for the Windows
tool" instinct doesn't quite work: ffmpeg on Windows only has `dshow` for audio capture,
which enumerates recording-side devices (mics, line-in, "Stereo Mix" if your hardware
happens to expose it) - not WASAPI's render-side loopback endpoints, which is where
"whatever the browser is playing" actually lives. There's no built-in ffmpeg flag that
reaches it.

Getting ffmpeg to see that audio at all means installing something that bridges the two -
historically a virtual audio cable or the "screen-capture-recorder" project's
`virtual-audio-capturer` DirectShow filter. Both are drivers that need to be installed and
registered, which needs admin rights - which defeats the entire reason for moving to Windows
in the first place.

WASAPI loopback capture itself doesn't have that problem: it's a plain user-mode Win32 API,
usable by any process, on any Windows 10/11 machine, with no driver and no special
permissions. `windows/WasapiLoopbackRecorder` is a ~150-line self-contained .NET console app
(via [NAudio](https://github.com/naudio/NAudio), MIT-licensed) that opens exactly that API on
the default output device and writes what it hears to a WAV file. Built as a self-contained
single-file exe, the target laptop needs nothing installed at all - not even the .NET
runtime - just that one file.

## How audio capture works

The bot is a **separate guest participant** in Chromium, and records two things, mixed
together into one WAV:

1. **What that browser plays from the meeting** (WASAPI loopback = Linux's
   `virtual_speaker.monitor`) - everyone else's voice, arriving as normal remote WebRTC audio.
2. **Your actual microphone**, captured directly - because no conferencing system ever plays
   your own voice back to you (that's just echo suppression working correctly), the loopback
   side can *never* contain your voice no matter how you joined or how loud you are. The
   original version of this doc assumed your voice would arrive at the bot as ordinary
   forwarded-remote-participant audio if you joined separately and unmuted - that turned out
   not to hold up in real testing, which is exactly why the direct mic capture was added
   rather than continuing to debug why the forwarding path wasn't producing it.

Set `WASAPI_NO_MIC=true` to go back to remote-audio-only (e.g. a fully passive/unattended
recording with nobody local to capture), or `WASAPI_MIC_DEVICE=<id>` to point at a specific
input device if the default Communications/Multimedia one isn't the right one.

On Windows, Teams/WebRTC often plays to the **Communications** default render device rather
than the **Multimedia** one shown in Settings. The helper loopbacks both when they differ,
and prefers the Communications-role input for the mic side for the same reason.

## One-time setup

```powershell
# 1. Install deps
npm install

# 2. Build the WASAPI helper (needs the .NET 8 SDK on THIS machine only -
#    https://dotnet.microsoft.com/download, per-user install is fine)
.\windows\build-helper.ps1

# 3. Run it
npm run start:windows
# (equivalent to: powershell -File windows/start-windows.ps1)
```

`POST /join`, `POST /leave`, `GET /status`, `GET /recordings` all work exactly as documented
in the main README - the HTTP API didn't change.

## Config

Same env vars as the Docker path (`RECORDINGS_DIR`, `DEFAULT_DISPLAY_NAME`, `CHROME_PATH`,
`X11_WIDTH`/`X11_HEIGHT` - yes, still called that; see the comment in `browserLaunch.ts` for
why they weren't renamed), plus two new, both **opt-in and off by default**:

- `WASAPI_HELPER_PATH` - point at the compiled helper if it's not at the default
  `windows/WasapiLoopbackRecorder/publish/WasapiLoopbackRecorder.exe` (e.g. once this is
  eventually packaged into a single distributable `.exe`).
- `WASAPI_RENDER_DEVICE` - override loopback endpoint if Chromium plays to a non-default device.
  By default the helper loopbacks **both** Communications and Multimedia render endpoints
  when they differ (Teams/WebRTC often uses Communications on Windows).
- `MINIMIZE_BROWSER_WINDOW=true` - see below.
- `AUTO_TRANSCRIBE=true` + `WHISPER_MODEL` - see below.

## Window visibility

There's no Xvfb equivalent on Windows - a headed browser here means a real, visible window
on the person's actual desktop, which wasn't a concern before. Two options, in increasing
order of effort:

1. **Leave it visible (default).** Simple, and it's the configuration the join flow has
   actually been exercised in. You'll see a Chromium window pop up.
2. **`MINIMIZE_BROWSER_WINDOW=true`** - minimizes the window via CDP right after a successful
   join. Implemented, but **not yet verified on real hardware**: Chrome deliberately does
   *not* throttle a backgrounded *tab* that's carrying an active WebRTC call, but it's not
   confirmed here whether a minimized *window* gets that same exemption. Test explicitly -
   start a meeting with this on, and check that captions keep arriving and the recording has
   no gaps - before relying on it.

A "run with no visible window at all" option (a separate hidden Windows session/service)
would be the next step up if minimizing isn't good enough, but that's real added complexity
and deliberately out of scope here.

## Whisper / faster-whisper: you already have this, and it already works

`transcribe/transcribe_with_names.py` + `transcribe.ps1` already exist in this repo, already
run natively on Windows (that's what the `KMP_DUPLICATE_LIB_OK` / isolated-venv handling in
there is specifically for - it's dodging a real Windows/Anaconda OpenMP DLL conflict), and
already produce a **better** result than a new live Node.js Whisper pipeline would: verbatim
Whisper text, but labeled with real speaker names, by time-aligning Whisper's segments
against the same `.captions.json` the bot always writes. A fresh `nodejs-whisper`/WASAPI
pipeline would give you verbatim text with no speaker names at all, which is strictly worse
for a project whose whole point is "transcript **with speaker names**" - so rebuilding it
was deliberately skipped. See the main writeup in chat for the fuller reasoning.

The only thing added here is a **fully optional** hook to run that existing script
automatically instead of by hand: set `AUTO_TRANSCRIBE=true` (Windows-only) and the bot will
fire `transcribe_with_names.py` in the background right after a recording finishes, using
whatever venv already exists at `transcribe/.venv` (create it once, per the header of
`transcribe.ps1`). It doesn't block `/leave` - a real transcription pass can take minutes on
CPU - it just runs and logs when it's done. Leave `AUTO_TRANSCRIBE` unset to keep doing this
by hand exactly as before.

## Known things worth testing early on real hardware

- **Start/stop cycles back-to-back** (join, leave, join again quickly) - the WASAPI helper
  spawn/stdin-stop/exit handshake is the newest piece of this whole change and the one thing
  that couldn't be exercised against a live Windows machine while building it.
- **A long meeting** (an hour+) - confirms the resample-on-stop step (native format -> 16kHz
  mono) handles a large file fine, and that timing stays reasonably close to the caption
  timestamps over that length.
- **Multiple audio output devices** (e.g. laptop speakers vs. a USB headset) - loopback
  capture follows whichever device is the Windows *default* output. If Chromium ever ends up
  playing to a non-default device, pass `--device <endpoint-id>` through
  `WASAPI_HELPER_PATH`'s invocation (`WindowsAudioRecorder` doesn't currently expose this as
  its own env var - trivial to add if you hit this).
- **Corporate EDR/antivirus reaction** - worth a quick check with IT before wide rollout.
  Nothing here is unusual for browser automation, but automated Chromium plus a background
  audio-capture helper is a pattern security tooling sometimes inspects more closely than a
  normal app install.

## What deliberately did NOT change

`Dockerfile`, `docker-compose.yml`, and `start.sh` are untouched - the Docker/Linux path
still works as-is for any machine that *can* run it (your own dev box, a server, CI, etc.).
This adds a second, parallel way to run the same bot; it doesn't replace the first.
