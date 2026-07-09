@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo == teams-guest-bot: unpack portable runtime bundle ==

set "ARCHIVE=deployment\TeamsGuestBot-Windows.zip"
set "MANIFEST=deployment\TeamsGuestBot-Windows.zip.manifest"
set "PART_PREFIX=deployment\TeamsGuestBot-Windows.zip."

if exist "node\node.exe" if exist "build\server.js" if exist "node_modules\@playwright\test" (
  echo Portable runtime already extracted.
  echo Delete node\ build\ node_modules\ and re-run to force a fresh unpack.
  goto :done
)

REM --- Monolithic archive (dev fallback only; not committed to git) ---
if exist "%ARCHIVE%" (
  echo Found monolithic archive - extracting...
  goto :extract
)

REM --- Split archive parts (normal git-clone path) ---
if not exist "%PART_PREFIX%001" (
  echo ERROR: No deployment bundle found.
  echo.
  echo Expected split parts like:
  echo   %PART_PREFIX%001
  echo   %PART_PREFIX%002
  echo   ...
  echo.
  echo If you cloned from GitHub, all parts should arrive with plain git clone.
  echo If parts are missing, re-clone or fetch the latest commit from origin.
  exit /b 1
)

set "EXPECTED_PARTS="
if exist "%MANIFEST%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%MANIFEST%") do (
    if /i "%%A"=="parts" set "EXPECTED_PARTS=%%B"
  )
)

if not defined EXPECTED_PARTS (
  echo ERROR: Missing or invalid manifest: %MANIFEST%
  echo The manifest must contain a line like: parts=5
  exit /b 1
)

echo Manifest expects %EXPECTED_PARTS% part(s).

set "MERGE="
set "FOUND=0"
for /L %%N in (1,1,%EXPECTED_PARTS%) do (
  set "IDX=00%%N"
  set "IDX=!IDX:~-3!"
  set "PART=!PART_PREFIX!!IDX!"
  if not exist "!PART!" (
    echo ERROR: Missing archive part: !PART!
    echo Clone may be incomplete - expected %EXPECTED_PARTS% parts, missing part %%N.
    exit /b 1
  )
  set /a FOUND+=1
  set "MERGE=!MERGE!+!PART!"
)

if not "!FOUND!"=="%EXPECTED_PARTS%" (
  echo ERROR: Part count mismatch.
  exit /b 1
)

echo Merging !FOUND! part(s) into %ARCHIVE% ...
copy /b !MERGE:~1! "%ARCHIVE%" >nul
if errorlevel 1 (
  echo ERROR: Failed to merge archive parts.
  exit /b 1
)
if not exist "%ARCHIVE%" (
  echo ERROR: Merge completed but %ARCHIVE% was not created.
  exit /b 1
)

:extract
echo Extracting %ARCHIVE% into project root...
tar -xf "%ARCHIVE%"
if errorlevel 1 (
  echo ERROR: tar extraction failed.
  if exist "%PART_PREFIX%001" del /f /q "%ARCHIVE%" 2>nul
  exit /b 1
)

if exist "%PART_PREFIX%001" (
  echo Removing temporary merged archive...
  del /f /q "%ARCHIVE%"
)

if not exist "node\node.exe" (
  echo ERROR: node\node.exe missing after extraction - bundle may be corrupt or incomplete.
  exit /b 1
)
if not exist "build\server.js" (
  echo ERROR: build\server.js missing after extraction.
  exit /b 1
)
if not exist "node_modules\@playwright\test" (
  echo ERROR: node_modules\@playwright\test missing after extraction.
  exit /b 1
)

:done
echo.
echo Portable bundle ready.
echo Next: set LOCAL_PARTICIPANT_NAME if needed, then run Start-Bot.cmd
