@echo off
rem Downloads the latest Rust3D from GitHub and reinstalls the panel.
if not exist "%~dp0installer\install.ps1" (
    echo.
    echo   Unpack the ZIP first, then run update.bat from the unpacked folder.
    echo.
    pause
    exit /b 1
)
start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0installer\install.ps1" -Update
