@echo off
rem DOOM Web - starts a local web server and opens the game in the browser.
cd /d "%~dp0dist"
start "" http://localhost:8123
echo DOOM is running at http://localhost:8123
echo Close this window to stop the server.
python -m http.server 8123 --bind 0.0.0.0
