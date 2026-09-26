@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    call install.bat
    exit /b
)
".venv\Scripts\python.exe" -m rust3d
if errorlevel 1 (
    echo.
    echo   [ERROR] Rust3D crashed - send a screenshot of this window.
    pause
)
