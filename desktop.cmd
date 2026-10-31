@echo off
rem GitHub Desktop one-click launcher - double-click for the interactive menu
setlocal
where pwsh >nul 2>nul && (set "SH=pwsh") || (set "SH=powershell")
"%SH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop.ps1" %*
endlocal
