@echo off
rem ============================================================================
rem MyDAW one-command build — builds EVERYTHING:
rem   ui (npm install + vite build) -> engine x64 + 64-bit plugin host
rem   -> 32-bit bridge plugin host
rem
rem Usage:   build.cmd [-SkipUi] [-SkipX64] [-SkipHost32] [-Clean]
rem          (double-clicking with no args builds everything)
rem
rem This is a thin launcher for scripts\build.ps1 (the real build logic).
rem For fast incremental rebuilds while developing, use scripts\rebuild.ps1.
rem ============================================================================
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo BUILD FAILED ^(exit %RC%^)
    pause
)
exit /b %RC%
