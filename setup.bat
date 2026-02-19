@echo off
:: ============================================================
:: Autonomous Agent — Windows Setup Launcher
:: Double-click this file to start setup.
:: ============================================================

title Autonomous Agent Setup
color 0B

echo.
echo   Starting setup...
echo.

:: Check if PowerShell is available
where powershell >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo   ERROR: PowerShell not found.
    echo   Please install PowerShell or run setup manually.
    echo   https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-windows
    pause
    exit /b 1
)

:: Run the PowerShell setup with bypass policy (for unsigned script)
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup.ps1"

:: If PowerShell exits with error, keep window open
if %ERRORLEVEL% neq 0 (
    echo.
    echo   Setup encountered an error. See above for details.
    pause
)
