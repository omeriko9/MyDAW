# MyDAW dev loop: starts the built engine exe + Vite dev server for the UI. SPEC §2.
#
#   pwsh scripts/dev.ps1                  # engine (Release build) + vite dev
#   pwsh scripts/dev.ps1 -Config Debug    # use the Debug engine build
#   pwsh scripts/dev.ps1 -EngineOnly      # just the engine
#   pwsh scripts/dev.ps1 -UiOnly          # just vite (engine already running elsewhere)
#
# The engine serves the production UI + WS API at http://127.0.0.1:8417; during dev you
# normally use the Vite dev server URL (default http://localhost:5173) which talks to the
# engine's WS endpoint directly.

[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Config = 'Release',
    [string[]]$EngineArgs = @(),
    [switch]$EngineOnly,
    [switch]$UiOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EngineExe = Join-Path $Root "build\bin\$Config\mydaw-engine.exe"
$UiDir = Join-Path $Root 'ui'

$engineProc = $null

try {
    # ------------------------------------------------------------------------ engine
    if (-not $UiOnly) {
        if (-not (Test-Path -LiteralPath $EngineExe)) {
            throw "Engine not built: $EngineExe`nRun scripts/build.ps1 (or: cmake --preset x64-release && cmake --build --preset x64-release)."
        }
        Write-Host "Starting engine: $EngineExe $($EngineArgs -join ' ')" -ForegroundColor Cyan
        if ($EngineArgs.Count -gt 0) {
            $engineProc = Start-Process -FilePath $EngineExe -ArgumentList $EngineArgs -WorkingDirectory $Root -PassThru
        }
        else {
            $engineProc = Start-Process -FilePath $EngineExe -WorkingDirectory $Root -PassThru
        }
        Write-Host "Engine PID $($engineProc.Id)" -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host '  Engine UI + API : http://127.0.0.1:8417   (WS: ws://127.0.0.1:8417/ws)' -ForegroundColor Green
    if (-not $EngineOnly) {
        Write-Host '  Vite dev UI     : http://localhost:5173  (hot reload; see vite output below)' -ForegroundColor Green
    }
    Write-Host ''

    # ------------------------------------------------------------------------ vite dev
    if (-not $EngineOnly) {
        if (-not (Test-Path -LiteralPath (Join-Path $UiDir 'package.json'))) {
            throw "ui/package.json not found at $UiDir - ui module missing (or pass -EngineOnly)."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $UiDir 'node_modules'))) {
            Write-Host 'ui/node_modules missing - running npm install first...' -ForegroundColor Yellow
            Push-Location $UiDir
            try {
                npm install
                if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
            }
            finally {
                Pop-Location
            }
        }
        Push-Location $UiDir
        try {
            npm run dev   # blocks until Ctrl+C
            if ($LASTEXITCODE -ne 0) { throw "npm run dev exited with code $LASTEXITCODE" }
        }
        finally {
            Pop-Location
        }
    }
    elseif ($engineProc) {
        Write-Host 'Engine running in its own window. Press Ctrl+C here to stop it.' -ForegroundColor Cyan
        Wait-Process -InputObject $engineProc -ErrorAction SilentlyContinue
        $engineProc = $null
    }
}
finally {
    if ($engineProc -and -not $engineProc.HasExited) {
        Write-Host "Stopping engine (PID $($engineProc.Id))..." -ForegroundColor Yellow
        try { Stop-Process -Id $engineProc.Id -Force -Confirm:$false -ErrorAction Stop } catch {}
    }
}
