@echo off
REM Sync watchdog (called by the "YouTube Playlist Sync Watchdog" scheduled task).
REM
REM Emails ERROR_ALERT_TO ONLY when state\last-run.json shows no successful sync in the
REM last 36 hours. A quiet nightly stays quiet; this fires on the absence of runs,
REM which is the failure the sync itself cannot report (a skipped task writes no log).
REM
REM Runs on its own trigger deliberately: if it shared the sync's schedule it would be
REM silent in exactly the case it exists to catch.

cd /d "%~dp0"
if not exist logs mkdir logs

set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=C:\Program Files\nodejs\node.exe"

echo [watchdog] %date% %time% >> "logs\watchdog.log"
"%NODE_EXE%" src\watchdog.js >> "logs\watchdog.log" 2>&1
echo [watchdog] finished (exit %ERRORLEVEL%) >> "logs\watchdog.log"
