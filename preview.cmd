@echo off
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

rem Ask the port probe whether BIFROST is already running, or which port is free.
rem It distinguishes our own server from an unrelated program holding the port.
set "ACTION="
set "CHOSEN="
for /f "tokens=1,2" %%A in ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preview-port.ps1" -Preferred %PORT% 2^>nul') do (
    set "ACTION=%%A"
    set "CHOSEN=%%B"
)

if /i "%ACTION%"=="OPEN" (
    echo BIFROST preview is already running at http://localhost:%CHOSEN%/
    start "" "http://localhost:%CHOSEN%/"
    exit /b 0
)

if /i "%ACTION%"=="BUSY" (
    echo Port %PORT% and the next 9 ports are all occupied by other programs.
    echo Try a free port, for example:  preview.cmd 9000
    pause
    exit /b 1
)

rem ACTION is START (or the probe was unavailable): use the probed free port when we have one.
if defined CHOSEN set "PORT=%CHOSEN%"

where node >nul 2>&1
if not errorlevel 1 (
    node "%~dp0preview-server.mjs" %PORT%
    if errorlevel 1 pause
    exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%~dp0preview-server.mjs" %PORT%
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preview-server.ps1" -Port %PORT%
)
if errorlevel 1 pause
exit /b 0
