# Portable Windows deployment bundle (split archive)

The runtime is shipped as **split zip parts** committed as normal Git files (no Git LFS):

```
TeamsGuestBot-Windows.zip.001
TeamsGuestBot-Windows.zip.002
...
TeamsGuestBot-Windows.zip.manifest
```

Each part is under **95 MB** so a plain `git clone` downloads everything.

## Build (dev machine only)

```powershell
npm run build:deployment
```

## Corporate laptop

```cmd
git clone https://github.com/xsaadahmed/teams-guest-bot-windows
cd teams-guest-bot-windows
Unpack-Bundle.cmd
set LOCAL_PARTICIPANT_NAME=Your Teams Name
Start-Bot.cmd
```

No Git LFS, no npm, no Node install, no Playwright download, no .NET runtime required.
