@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo == teams-guest-bot: extract portable runtime bundle ==

if not exist "deployment\TeamsGuestBot-Windows.zip" (
  echo ERROR: deployment\TeamsGuestBot-Windows.zip not found.
  echo.
  echo If you cloned from GitHub, run first:
  echo   git lfs pull
  exit /b 1
)

echo Extracting deployment\TeamsGuestBot-Windows.zip into project root...
tar -xf "deployment\TeamsGuestBot-Windows.zip"
if errorlevel 1 (
  echo ERROR: tar extraction failed.
  exit /b 1
)

if not exist "node\node.exe" (
  echo ERROR: node\node.exe missing after extraction — bundle may be corrupt.
  exit /b 1
)

echo.
echo Portable bundle ready.
echo Next: set LOCAL_PARTICIPANT_NAME if needed, then run Start-Bot.cmd
