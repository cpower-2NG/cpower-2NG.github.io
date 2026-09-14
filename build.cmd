@echo off
rem Build the content index: compile content-src Markdown and write data/entries.json,
rem feed.xml and sitemap.xml. Keep this file ASCII-only (cmd reads batch files using
rem the OEM code page, where multi-byte characters can collide with shell metacharacters).

where node >nul 2>&1
if not errorlevel 1 (
    node "%~dp0build.mjs"
    if errorlevel 1 pause
    exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%~dp0build.mjs"
    if errorlevel 1 pause
    exit /b 0
)

echo Node.js not found. build.mjs requires Node.js to run.
echo ^(preview.cmd works without Node because it falls back to PowerShell^)
pause
