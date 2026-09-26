@echo off
rem Builds a single Rust3D.exe (needs install.bat to have been run once).
cd /d "%~dp0"
".venv\Scripts\python.exe" -m pip install pyinstaller -q
".venv\Scripts\pyinstaller.exe" --noconfirm --onefile --windowed --name Rust3D ^
  --add-data "ui;ui" --add-data "blender;blender" --add-data "premiere_panel;premiere_panel" ^
  run.py
echo Done: dist\Rust3D.exe
pause
