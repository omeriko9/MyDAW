@echo off
setlocal

rem MyDAW run wrapper:
rem   1) stop any running MyDAW processes
rem   2) run the full build
rem   3) launch the rebuilt engine only if the build succeeded

set "ROOT=%~dp0"
pushd "%ROOT%" >nul
if errorlevel 1 exit /b 1

for %%P in (mydaw-engine.exe mydaw-host64.exe mydaw-host32.exe) do (
    taskkill /F /IM %%P >nul 2>nul
)

call "%ROOT%build.cmd" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    popd >nul
    exit /b %RC%
)

if not exist "%ROOT%build\bin\Release\mydaw-engine.exe" (
    echo RUN FAILED: built engine not found at "%ROOT%build\bin\Release\mydaw-engine.exe"
    popd >nul
    exit /b 1
)

start "" "%ROOT%build\bin\Release\mydaw-engine.exe"
popd >nul
exit /b 0
