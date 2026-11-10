@echo off
REM Starts the Stremio -> qBittorrent bridge.
REM Edit bridge\config.json before the first run (qBittorrent credentials).

cd /d "%~dp0"
node server.js
pause
