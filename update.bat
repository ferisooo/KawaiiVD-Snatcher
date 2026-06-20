@echo off
setlocal EnableExtensions

REM ============================================================
REM  KawaiiVD-Snatcher updater
REM
REM  Force-pulls the latest "main" branch, overwriting EVERYTHING
REM  in the folder this script lives in. Any local changes are
REM  discarded. If no git repo exists here yet, one is created
REM  automatically and pointed at the GitHub remote.
REM ============================================================

set "REPO_URL=https://github.com/ferisooo/KawaiiVD-Snatcher.git"
set "BRANCH=main"

REM Always operate in the folder where this script lives.
cd /d "%~dp0"

REM --- Make sure git is available ---------------------------------
where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is not installed or not on your PATH.
    echo         Install it from https://git-scm.com/download/win
    echo         then run this script again.
    goto :fail
)

REM --- Bootstrap a repo if .git is missing ------------------------
if not exist ".git" (
    echo [INFO] No git repository found here. Initializing one...
    git init || goto :fail
    git remote add origin "%REPO_URL%" || goto :fail
)

REM --- Make sure "origin" exists and points at the right URL ------
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%" || goto :fail
) else (
    git remote set-url origin "%REPO_URL%" || goto :fail
)

REM --- Fetch and force-overwrite to match origin/main ------------
echo [INFO] Fetching latest "%BRANCH%" from origin...
git fetch origin %BRANCH% || goto :fail

echo [INFO] Resetting all files to origin/%BRANCH% (local changes will be lost)...
git reset --hard origin/%BRANCH% || goto :fail

echo [INFO] Removing untracked files and folders...
git clean -fd

echo.
echo [SUCCESS] Updated to the latest "%BRANCH%".
pause
exit /b 0

:fail
echo.
echo [ERROR] Update failed. See the messages above.
pause
exit /b 1
