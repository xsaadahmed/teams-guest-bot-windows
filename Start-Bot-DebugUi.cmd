@echo off
REM UI debugging: stop the bot from opening the People roster (manual DOM inspection).
REM Chromium stays off-screen like normal — use /debug/page-html while in a meeting if needed.
set DISABLE_ROSTER_AUTOMATION=1
call "%~dp0Start-Bot.cmd" %*
