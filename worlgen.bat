@echo off
rem worlgen - the only thing you need to start.
rem Opens the site; pressing Build it starts the 3D engine by itself and stops it after.
rem Close this window to stop everything (the engine stops with it).
title worlgen
cd /d "%~dp0"
if /i not "%1"=="nobrowser" start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8777/viewer/"
python serve.py
