@echo off
rem Opens the Rust3D installer window (PowerShell + WPF, nothing else needed).
if not exist "%~dp0installer\install.ps1" (
    echo.
    echo   Unpack the ZIP first: right click the ZIP - "Extract All",
    echo   then run install.bat from the unpacked folder.
    echo.
    pause
    exit /b 1
)
start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0installer\install.ps1"
