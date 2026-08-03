# Teams Guest Bot (Windows)

Joins a Microsoft Teams meeting the same way a human guest would — by opening the meeting
link in a real browser, typing a display name, and clicking "Join now" — and records whatever
audio plays through that browser to a `.wav` file. This is the same general approach used by
most commercial "notetaker" bots (Otter, Fireflies, Read.ai, etc.) and several open-source
projects, rather than Microsoft's official Graph Calling SDK.

This repository is **Windows-native**: WASAPI loopback capture, Playwright Chromium, and a
local Web UI. No Docker, no WSL2, no virtual display stack.

## Quick start — corporate laptop (portable bundle)

For locked-down laptops that **can** `git clone` from GitHub but **cannot** reach npm,
Playwright CDNs, or GitHub Releases:

```cmd
git clone https://github.com/xsaadahmed/teams-guest-bot-windows
cd teams-guest-bot-windows
Unpack-Bundle.cmd
set LOCAL_PARTICIPANT_NAME=Your Teams Display Name
Start-Bot.cmd
```

The Web UI opens automatically at `http://localhost:3000` (or the next free port: 3001, 3847).

**No Node.js install, no npm install, no `npx playwright install`, and no .NET runtime** are
required on the corporate laptop. The portable bundle lives in
`deployment/TeamsGuestBot-Windows.zip.*` (split parts under 95 MB each) and includes:

- Portable `node.exe`
- Compiled JavaScript (`build/`)
- Production `node_modules/` with Playwright-managed Chromium (`PLAYWRIGHT_BROWSERS_PATH=0`)
- Self-contained `WasapiLoopbackRecorder.exe` and `DismissTeamsDialog.exe`

To rebuild the bundle on a dev machine: `npm run build:deployment` (needs internet, Node,
npm, .NET 8 SDK). See [`deployment/README.md`](deployment/README.md).

## Quick start — development machine

```powershell
npm install
.\windows\build-helper.ps1
npm run build:all
Start-Bot.cmd
```

Or: `npm run start:windows` / `powershell -File windows\start-windows.ps1`

See [`windows/README.md`](windows/README.md) for WASAPI capture details, env vars, and
testing notes.

## Web UI

`Start-Bot.cmd` opens the Meeting Assistant in an Edge/Chrome app window. Use **Record** to
paste a meeting link and join; browse **Transcripts**, **Recordings**, and **AI Summaries**
from the sidebar. Set your Teams display name and API keys under **Settings**.

## How this differs from the Graph Calling SDK

| | Graph Calling SDK | This (guest browser join) |
|---|---|---|
| Needs Azure AD app + admin-consented permissions? | Yes | No |
| Needs a Windows VM with public IP/cert/DNS? | Yes | No — runs on a normal Windows PC |
| Subject to the Media Access API's "no persisting media" restriction? | Yes | No |
| How it joins | Authenticated bot via Graph | As an anonymous/guest participant |
| Robustness | Stable (official API) | Depends on Teams' web UI not changing |
| Visible to other participants | Registered bot name | Guest name you choose |

**Microsoft can change the join screen at any time** — if `/join` breaks, fix selectors in
`src/teamsJoin.ts`.

Recording still has consent and legal implications. The bot appears by name in the participant
list.

## How it gets the audio (Windows)

1. A real (visible, not headless) Chromium browser joins the meeting via Playwright.
2. **WASAPI loopback** (`windows/WasapiLoopbackRecorder`) records what the browser plays
   (remote participants).
3. Your **local microphone** is mixed in separately (your voice is not played back to you, so
   loopback alone would miss it).

Set `WASAPI_NO_MIC=true` for remote-audio-only capture.

## Project layout

```
src/
  server.ts              HTTP API + Web UI static files
  bot.ts                 Browser/recording lifecycle
  browserLaunch.ts       Chromium launch flags
  teamsJoin.ts           Guest join flow
  captionTracker.ts      Live captions → speaker names
  audioRecorder.ts       Platform dispatch (Windows WASAPI vs Linux Pulse — see below)
  audioRecorder.windows.ts
  transcriptionEngines.ts  Detect installed STT packages (Settings)
windows/
  WasapiLoopbackRecorder/  .NET WASAPI loopback helper
  DismissTeamsDialog/      Dismiss Teams protocol prompt
  README.md                Windows-specific details
web/                       React Web UI (build → public/)
deployment/                Portable corporate bundle (split zip parts)
transcribe/                Optional post-meeting STT scripts
```

## HTTP API

| Endpoint | Method | Purpose |
|---|---|---|
| `/join` | POST | Join meeting (`meetingUrl`, optional `displayName`) |
| `/leave` | POST | Leave and finalize recording |
| `/status` | GET | `idle` / `joining` / `in_meeting` / `error` |
| `/recordings` | GET | List `.wav` files |
| `/transcripts` | GET | List transcript files |
| `/summaries` | POST | Generate AI summary from a transcript |
| `/config` | GET/PUT | Local settings (name, LLM, transcription) |

**Join example (PowerShell):**

```powershell
Invoke-RestMethod -Uri http://localhost:3000/join -Method POST -ContentType "application/json" -Body '{"meetingUrl": "https://teams.live.com/meet/...", "displayName": "Meeting Recorder"}'
```

**Status:**

```powershell
Invoke-RestMethod http://localhost:3000/status
```

**Leave:**

```powershell
Invoke-RestMethod -Uri http://localhost:3000/leave -Method POST
```

Recordings land in `Recordings\` next to the project.

## Speaker-attributed transcripts

The bot turns on Teams live captions and writes, next to each `.wav`:

- `<name>.transcript.txt` — readable lines with **real speaker names**
- `<name>.captions.json` — structured timeline for merge scripts

### Optional: accurate post-meeting transcription

In **Settings → Transcription**, pick an STT engine already installed in Python on this PC
(faster-whisper or NVIDIA NeMo/Parakeet). The app **does not install** packages — it only
detects what is importable.

On the **Record** page, enable **More Accurate Transcription** before joining. After the
meeting ends, the bot runs `transcribe/transcribe_with_names.py` in the background and writes
`<name>.named_transcript.txt` (verbatim STT text + Teams speaker names).

Manual run (same script):

```powershell
python transcribe\transcribe_with_names.py Recordings\<name>.wav --engine faster_whisper --model small
```

## Troubleshooting

| Problem | What to try |
|---|---|
| Bot never appears in Teams | Admit from lobby; check meeting link (strip `.rproxy.goskope.com` if present) |
| Join fails: Chromium missing | Run `npx playwright install chromium` with `PLAYWRIGHT_BROWSERS_PATH=0` (dev) or re-unpack deployment bundle |
| `EPERM` on `playwright-artifacts` in Temp | Fixed automatically — `Start-Bot.cmd` uses `.bot-temp/` in the project folder |
| Port 3000 in use | Bot auto-tries 3001, then 3847 — check console for `listening on :...` |
| No `.transcript.txt` | Captions may not have turned on — see `src/captionTracker.ts` |
| Accurate transcription disabled | No STT package detected — install faster-whisper in Python, refresh Settings |
| Recording is silent | Rebuild WASAPI helper: `.\windows\build-helper.ps1` |

## Further reading

- [`windows/README.md`](windows/README.md) — WASAPI helper, env vars, window visibility
- [`deployment/README.md`](deployment/README.md) — corporate bundle build and unpack
