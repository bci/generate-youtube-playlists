@echo off
REM First-time setup from a release kit, for a machine with no development tooling.
REM
REM Double-click this file. It exists because every other entry point assumes something a
REM fresh Windows box does not have: `make` is not installed on Windows at all, and
REM `.\build.ps1` fails with "running scripts is disabled on this system" under the default
REM execution policy. A .cmd has neither problem and runs on a double-click.
REM
REM What it cannot do is install Node.js -- that needs an administrator and an installer --
REM so a missing Node is reported as an instruction rather than as
REM "'node' is not recognized as an internal or external command".

setlocal
cd /d "%~dp0"

echo.
echo   YouTube playlist sync -- setting up from a release kit
echo   ======================================================
echo.

REM Prefer node from PATH; fall back to the default install location, exactly as
REM run-sync.cmd does -- a freshly installed Node is often not on PATH in an already-open
REM window, and reporting "not installed" to someone who just installed it is worse than
REM looking in the one place it always lands.
set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=C:\Program Files\nodejs\node.exe"

"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 goto nonode

for /f "delims=" %%v in ('"%NODE_EXE%" --version') do set "NODE_VER=%%v"
echo   Node.js %NODE_VER% found.
echo.

REM -ExecutionPolicy Bypass so a locked-down box does not refuse the shim on its first run.
REM This applies to this one invocation only; nothing on the machine is changed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" from-release
if errorlevel 1 goto failed

echo.
pause
exit /b 0

:nonode
echo   Node.js is NOT installed.
echo.
echo   It is the one thing this kit cannot install for you: it needs an
echo   administrator, and this window may not have one.
echo.
echo     1. Go to   https://nodejs.org/en/download
echo     2. Download the Windows Installer (.msi), LTS, 64-bit.
echo        Any version 20.12 or newer will do.
echo     3. Run it, accept the defaults.
echo     4. Double-click this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   Setup did not finish. The message above says why.
echo.
pause
exit /b 1
