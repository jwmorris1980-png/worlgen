@echo off
rem Starts ComfyUI for worlgen without the desktop app: same install, models and output folder.
rem Leave this window open while building worlds. Close it to stop ComfyUI.
set C=D:\Comfy-Desktop\ComfyUI-Installs\iamgod\ComfyUI
cd /d "%C%"
"%C%\.venv\Scripts\python.exe" main.py --port 8189 --extra-model-paths-config "C:\Users\Yeyian PC\AppData\Roaming\Comfy Desktop\instance-model-paths\inst-1789321302269.yaml" --output-directory D:\Comfy-Desktop\ComfyUI-Shared\output --input-directory D:\Comfy-Desktop\ComfyUI-Shared\input
