@echo off
echo.
echo   Removing the Rust3D panel from After Effects and Premiere Pro...
rmdir /s /q "%APPDATA%\Adobe\CEP\extensions\com.rust3d.panel" 2>nul
rmdir /s /q "%APPDATA%\Adobe\CEP\extensions\com.rust3d.importer" 2>nul
echo.
choice /c YN /m "  Also delete downloaded tools, settings and cache (%APPDATA%\Rust3D)"
if errorlevel 2 goto done
rmdir /s /q "%APPDATA%\Rust3D" 2>nul
:done
echo.
echo   Done. Restart After Effects / Premiere Pro.
echo   Exported models in Documents\Rust3D were kept.
echo.
pause
