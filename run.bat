@echo off
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 1 /nobreak >nul
node server.js