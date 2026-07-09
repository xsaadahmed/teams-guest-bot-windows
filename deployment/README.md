# Portable Windows deployment bundle

The file `TeamsGuestBot-Windows.zip` in this folder is tracked by **Git LFS**.

It contains the full offline runtime for locked-down corporate laptops:

- Portable `node.exe`
- Compiled `build/` JavaScript
- Production `node_modules/` (including Playwright-managed Chromium)
- Self-contained `WasapiLoopbackRecorder.exe` and `DismissTeamsDialog.exe`

## Build (dev machine only)

```powershell
.\scripts\build-deployment.ps1
```

## Corporate laptop

```cmd
git clone https://github.com/xsaadahmed/teams-guest-bot-windows
cd teams-guest-bot-windows
git lfs pull
Unpack-Bundle.cmd
set LOCAL_PARTICIPANT_NAME=Your Teams Name
Start-Bot.cmd
```

No Node.js install, no npm, no Playwright download, no .NET runtime required after clone + LFS pull + unzip.
