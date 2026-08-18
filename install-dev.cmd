@echo off
setlocal

rem Double-click entry point for a local dsh plugin install.
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\install-dev.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Local dsh plugin installation failed with exit code %EXIT_CODE%.
)

if /i not "%DSH_DEV_INSTALL_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
