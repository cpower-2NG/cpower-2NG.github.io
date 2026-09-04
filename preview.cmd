@echo off
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"
start "BIFROST Preview" "http://localhost:%PORT%/"
node "%~dp0preview-server.mjs" %PORT%
