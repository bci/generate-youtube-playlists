@echo off
REM Nightly YouTube playlist sync (called by the "YouTube Playlist Sync" scheduled task).
REM Emails REPORT_TO (via Microsoft Graph) only on runs that changed something.
REM
REM Watched videos (liked, or saved to the "Watched" playlist) are DELETED from the channel
REM playlists by default. The seen-ledger in state/ keeps them from being re-added later.
REM For detect-and-report-only, add --report-watched. To skip the watched signals entirely,
REM add --ignore-watched. Neither one ever re-adds a video already pruned.

cd /d "%~dp0"
if not exist logs mkdir logs

REM Prefer node from PATH; fall back to the default Windows install location, since a
REM scheduled task can be started before the installer's PATH entry is visible to it.
set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=C:\Program Files\nodejs\node.exe"

echo ================================================================ >> "logs\sync.log"
echo Run started %date% %time% >> "logs\sync.log"

"%NODE_EXE%" src\index.js --email-on-change >> "logs\sync.log" 2>&1

echo Run finished %date% %time% (exit %ERRORLEVEL%) >> "logs\sync.log"
