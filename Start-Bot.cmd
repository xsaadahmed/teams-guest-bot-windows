@echo off
setlocal EnableExtensions

REM Entry point for dev machines AND locked-down corporate laptops.
REM Portable mode: after Unpack-Bundle.cmd (or tar -xf deployment\TeamsGuestBot-Windows.zip)
REM uses bundled node.exe - no global Node, npm, or internet required.

cd /d "%~dp0"

echo == teams-guest-bot (Windows-native) ==

set "PORTABLE=0"
if exist "node\node.exe" if exist "build\server.js" if exist "node_modules\@playwright\test" (
  set "PORTABLE=1"
)

if "%PORTABLE%"=="1" (
  set "NODE_EXE=%~dp0node\node.exe"
  set "PLAYWRIGHT_BROWSERS_PATH=0"
  goto :runtime_ready
)

REM Dev fallback: global Node + optional npm build
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Portable bundle not extracted and Node.js not on PATH.
  echo.
  echo Corporate laptop: run Unpack-Bundle.cmd first ^(or: tar -xf deployment\TeamsGuestBot-Windows.zip^)
  echo Dev machine: install Node from https://nodejs.org or extract the portable bundle.
  exit /b 1
)
set "NODE_EXE=node"

if /i "%~1"=="/force" set "NEEDS_BUILD=1"
if not exist "build\server.js" set "NEEDS_BUILD=1"
if defined NEEDS_BUILD (
  if not exist "node_modules\" (
    echo Installing npm dependencies...
    call npm install
    if errorlevel 1 exit /b 1
  )
  echo Building TypeScript...
  call npm run build
  if errorlevel 1 exit /b 1
)

:runtime_ready
for /f "delims=" %%v in ('"%NODE_EXE%" -v') do echo Node: %%v
if "%PORTABLE%"=="1" echo Mode: portable bundle ^(no npm/internet required^)

set "HELPER=windows\WasapiLoopbackRecorder\publish\WasapiLoopbackRecorder.exe"
set "DISMISS=windows\DismissTeamsDialog\publish\DismissTeamsDialog.exe"
if exist "%HELPER%" (
  echo WASAPI helper: %HELPER%
) else (
  echo WARNING: WASAPI helper not found at %HELPER% - recording will fail.
)
if exist "%DISMISS%" (
  echo Dialog dismiss helper: %DISMISS%
) else (
  echo WARNING: Dismiss helper not found at %DISMISS% - ms-teams protocol prompt may appear.
)

if not defined RECORDINGS_DIR set "RECORDINGS_DIR=%CD%\Recordings"
if not exist "%RECORDINGS_DIR%" mkdir "%RECORDINGS_DIR%"
echo Recordings directory: %RECORDINGS_DIR%

if defined LOCAL_PARTICIPANT_NAME (
  echo Local participant [mute-gated mic]: %LOCAL_PARTICIPANT_NAME%
) else (
  echo Local participant name: not set in env — Web UI will ask on first open ^(saved to .teams-bot-config.json^)
)

if not defined PORT set "PORT=3000"
echo Starting bot server on port %PORT%...
echo Web UI: http://localhost:%PORT%/
"%NODE_EXE%" build\server.js
