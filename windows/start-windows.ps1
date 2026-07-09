<#
.SYNOPSIS
  Runs teams-guest-bot natively on Windows - no Docker, no WSL2, no admin rights. This is
  the entry point for the AVD-restricted-laptop deployment.

.DESCRIPTION
  start.sh's job on Linux was: bring up Xvfb, bring up PulseAudio + the virtual sink, bring
  up x11vnc, then start the bot. None of the first three exist here - Windows already has a
  real desktop and real audio devices, so this script's job is much smaller:

    1. Confirm Node.js is on PATH.
    2. Confirm the compiled WASAPI capture helper exists (point at build-helper.ps1 if not -
       recording won't work without it, but captions/transcript still will).
    3. Make sure the Recordings directory exists.
    4. Build the TypeScript if build/ looks stale (or -Force is passed).
    5. Start the bot's HTTP API (default port 3000).

.PARAMETER Force
  Rebuild TypeScript even if build/ looks up to date.

.EXAMPLE
  .\windows\start-windows.ps1
.EXAMPLE
  .\windows\start-windows.ps1 -Force
#>
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # windows\.. == repo root
Set-Location $root

Write-Host "== teams-guest-bot (Windows-native) ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found on PATH. Install it from https://nodejs.org (the per-user/no-admin install option works fine) and re-open this shell."
    exit 1
}
Write-Host "Node: $(node -v)"

$helperPath = Join-Path $root "windows\WasapiLoopbackRecorder\publish\WasapiLoopbackRecorder.exe"
if (-not (Test-Path $helperPath)) {
    Write-Warning "WASAPI capture helper not found at:"
    Write-Warning "  $helperPath"
    Write-Warning "Build it first:  .\windows\build-helper.ps1"
    Write-Warning "(Recording will fail to start until that exists. Joining, captions, and the text transcript all work fine without it.)"
} else {
    Write-Host "WASAPI helper: $helperPath"
}

$recordingsDir = $env:RECORDINGS_DIR
if (-not $recordingsDir) { $recordingsDir = Join-Path $root "Recordings" }
New-Item -ItemType Directory -Force -Path $recordingsDir | Out-Null
Write-Host "Recordings directory: $recordingsDir"

if (-not $env:LOCAL_PARTICIPANT_NAME) {
    Write-Warning "LOCAL_PARTICIPANT_NAME is not set — mic records always-on (ignores Teams mute)."
    Write-Warning "Set it to your Teams display name for mute-gated capture, e.g.: `$env:LOCAL_PARTICIPANT_NAME='Saad Ahmed'"
} else {
    Write-Host "Local participant (mute-gated mic): $($env:LOCAL_PARTICIPANT_NAME)"
}

$builtServer = Join-Path $root "build\server.js"
$needsBuild = $Force -or (-not (Test-Path $builtServer))
if (-not $needsBuild) {
    $newestSrc = Get-ChildItem (Join-Path $root "src") -Recurse -Filter *.ts |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newestSrc -and $newestSrc.LastWriteTime -gt (Get-Item $builtServer).LastWriteTime) {
        $needsBuild = $true
    }
}

if ($needsBuild) {
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed."; exit 1 }
    }
    Write-Host "Building TypeScript..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed."; exit 1 }
}

Write-Host "Starting bot server on port $(if ($env:PORT) { $env:PORT } else { 3000 })..." -ForegroundColor Green
node (Join-Path $root "build\server.js")
