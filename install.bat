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

where py >nul 2>nul
if errorlevel 1 (
    echo   Python not found - installing it with winget...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo   [ERROR] Could not install Python automatically.
        echo   Install Python 3.12 from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
        goto :end
    )
    echo.
    echo   Python installed. Close this window and run install.bat again.
    goto :end
)

echo   [1/3] Creating environment...
py -3 -m venv .venv
if errorlevel 1 ( echo   [ERROR] venv failed & goto :end )

echo   [2/3] Installing libraries...
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r requirements.txt
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
