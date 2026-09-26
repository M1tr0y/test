@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Rust3D — установка

echo.
echo   RUST3D — установка
echo   ==================
echo.

where py >nul 2>nul
if errorlevel 1 (
    echo   Python не найден — ставлю через winget...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo   Не получилось. Поставь Python 3.10+ с python.org ^(галочка "Add to PATH"^) и запусти снова.
        pause
        exit /b 1
    )
    echo   Python установлен. Закрой это окно и запусти install.bat ещё раз.
    pause
    exit /b 0
)

echo   Создаю окружение...
py -3 -m venv .venv || goto :fail
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r requirements.txt -q || goto :fail

echo   Создаю ярлык на рабочем столе...
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Rust3D.lnk');" ^
  "$s.TargetPath='%~dp0.venv\Scripts\pythonw.exe'; $s.Arguments='-m rust3d'; $s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%SystemRoot%\System32\imageres.dll,196'; $s.Save()"

echo.
echo   Готово! Запускаю Rust3D — дальше мастер настройки спросит про Rust, AE, Premiere и Blender.
start "" ".venv\Scripts\pythonw.exe" -m rust3d
exit /b 0

:fail
echo   Ошибка установки — см. сообщения выше.
pause
exit /b 1
