@echo off
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$listener = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($listener) { Start-Process 'http://localhost:%PORT%/'; exit 0 }; exit 1"
if not errorlevel 1 exit /b 0

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
