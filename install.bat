@echo off
setlocal
cd /d "%~dp0"
title Rust3D setup

echo.
echo   RUST3D setup
echo   ============
echo   Folder: %~dp0
echo.

if not exist "rust3d\app.py" (
    echo   [ERROR] Program files not found next to install.bat.
    echo   Unpack the ZIP first: right click the ZIP - "Extract All", then run install.bat from the unpacked folder.
    goto :end
)

rem pywebview needs pythonnet, which only ships ready builds for mature Python versions,
rem so the app always runs on Python 3.12 (installed next to any other Python you have).
py -3.12 --version >nul 2>nul
if errorlevel 1 (
    echo   Python 3.12 not found - installing it with winget...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    py -3.12 --version >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   [ERROR] Python 3.12 is still not available.
        echo   If winget just installed it: close this window and run install.bat again.
        echo   Otherwise install Python 3.12 from https://www.python.org/downloads/release/python-3129/
        echo   "Windows installer 64-bit", then run install.bat again.
        goto :end
    )
)

echo   [1/3] Creating environment (Python 3.12)...
if exist ".venv" rmdir /s /q ".venv"
py -3.12 -m venv .venv
if errorlevel 1 ( echo   [ERROR] venv failed & goto :end )

echo   [2/3] Installing libraries...
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install --only-binary pythonnet -r requirements.txt
if errorlevel 1 ( echo   [ERROR] pip install failed & goto :end )

echo   [3/3] Creating desktop shortcut...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Rust3D.lnk'); $s.TargetPath='%~dp0run.bat'; $s.WorkingDirectory='%~dp0'; $s.Save(); Write-Host ('   Shortcut: ' + [Environment]::GetFolderPath('Desktop') + '\Rust3D.lnk')"

echo.
echo   Done! Starting Rust3D...
echo.
".venv\Scripts\python.exe" -m rust3d
if errorlevel 1 echo   [ERROR] Rust3D crashed - send a screenshot of this window.

:end
echo.
pause
