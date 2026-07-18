# MyDAW incremental rebuild — one command after a manual source change.
#
#   pwsh scripts/rebuild.ps1                 # default: engine only (target mydaw-engine)
#   pwsh scripts/rebuild.ps1 -Engine -Run    # rebuild engine, then (re)launch it
#   pwsh scripts/rebuild.ps1 -Host64         # 64-bit plugin host (target mydaw-host, build/)
#   pwsh scripts/rebuild.ps1 -Host32         # 32-bit bridge host (target mydaw-host, build32/)
#   pwsh scripts/rebuild.ps1 -Ui             # npm run build in ui/ -> ui/dist
#   pwsh scripts/rebuild.ps1 -All            # everything
#
# Unlike scripts/build.ps1 (full pipeline incl. npm ci + configure), this reuses the
# existing build/ and build32/ trees and only configures when a tree is missing, so
# unchanged translation units are skipped. Running MyDAW processes are stopped (with a
# warning) only when they lock a binary being rebuilt. Each step fails loudly; elapsed
# time and artifact paths are printed at the end.

[CmdletBinding()]
param(
    [switch]$Engine,
    [switch]$Host64,
    [switch]$Host32,
    [switch]$Ui,
    [switch]$All,
    [switch]$Run
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EngineExe = Join-Path $Root 'build\bin\Release\mydaw-engine.exe'

if ($All) { $Engine = $true; $Host64 = $true; $Host32 = $true; $Ui = $true }
if (-not ($Engine -or $Host64 -or $Host32 -or $Ui)) { $Engine = $true } # default

$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Invoke-Step {
    param([Parameter(Mandatory)][string]$Name,
          [Parameter(Mandatory)][scriptblock]$Body)
    Write-Host ''
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Body
    Write-Host "==> OK: $Name" -ForegroundColor Green
}

function Assert-ExitCode {
    param([Parameter(Mandatory)][string]$What)
    if ($LASTEXITCODE -ne 0) {
        throw "REBUILD FAILED: $What exited with code $LASTEXITCODE"
    }
}

# Stop running processes (by image name, no extension) that would lock a binary we are
# about to overwrite. Warns per process; silent no-op when nothing is running.
function Stop-LockingProcesses {
    param([Parameter(Mandatory)][string[]]$Names,
          [Parameter(Mandatory)][string]$Reason)
    foreach ($name in $Names) {
        $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
        foreach ($proc in $procs) {
            Write-Warning "Stopping '$($proc.ProcessName)' (PID $($proc.Id)) — $Reason"
            try { Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction Stop } catch {}
        }
        if ($procs.Count -gt 0) { Wait-Process -Name $name -Timeout 10 -ErrorAction SilentlyContinue }
    }
}

# Configure a build tree only when it does not exist yet (build.ps1 normally creates it).
function Ensure-Configured {
    param([Parameter(Mandatory)][string]$BuildDir,
          [Parameter(Mandatory)][string]$Preset)
    if (-not (Test-Path -LiteralPath (Join-Path $Root "$BuildDir\CMakeCache.txt"))) {
        Write-Host "    ($BuildDir\ not configured yet — running cmake --preset $Preset)" -ForegroundColor Yellow
        cmake --preset $Preset
        Assert-ExitCode "cmake configure ($Preset)"
        try {
            # Keep Dropbox from syncing the build tree (same as build.ps1).
            Set-Content -LiteralPath (Join-Path $Root $BuildDir) -Stream com.dropbox.ignored -Value 1 -ErrorAction Stop
        } catch {}
    }
}

$built = @() # artifact paths to print at the end

Push-Location $Root
try {
    # ------------------------------------------------------------------ engine (x64)
    if ($Engine) {
        Invoke-Step 'Rebuild mydaw-engine (build/, Release, incremental)' {
            Ensure-Configured -BuildDir 'build' -Preset 'x64-release'
            Stop-LockingProcesses -Names @('mydaw-engine') `
                -Reason 'it locks mydaw-engine.exe being rebuilt'
            cmake --build build --config Release --target mydaw-engine
            Assert-ExitCode 'cmake build (mydaw-engine)'
        }
        $built += $EngineExe
    }

    # ------------------------------------------------------------------ host64 (x64)
    if ($Host64) {
        Invoke-Step 'Rebuild mydaw-host64 (build/, target mydaw-host, Release, incremental)' {
            Ensure-Configured -BuildDir 'build' -Preset 'x64-release'
            # A running engine spawns/auto-restarts host processes, which would re-lock
            # the exe mid-build — stop the engine too.
            Stop-LockingProcesses -Names @('mydaw-host64', 'mydaw-engine') `
                -Reason 'it locks (or respawns processes that lock) mydaw-host64.exe being rebuilt'
            cmake --build build --config Release --target mydaw-host
            Assert-ExitCode 'cmake build (mydaw-host, x64)'
        }
        $built += (Join-Path $Root 'build\bin\Release\mydaw-host64.exe')
    }

    # ----------------------------------------------------------------- host32 (Win32)
    if ($Host32) {
        Invoke-Step 'Rebuild mydaw-host32 (build32/, target mydaw-host, Release, incremental)' {
            Ensure-Configured -BuildDir 'build32' -Preset 'host32-release'
            Stop-LockingProcesses -Names @('mydaw-host32', 'mydaw-engine') `
                -Reason 'it locks (or respawns processes that lock) mydaw-host32.exe being rebuilt'
            cmake --build build32 --config Release --target mydaw-host
            Assert-ExitCode 'cmake build (mydaw-host, Win32)'
        }
        $built += (Join-Path $Root 'build32\bin\Release\mydaw-host32.exe')
    }

    # -------------------------------------------------------------------------- UI
    if ($Ui) {
        Invoke-Step 'Rebuild UI (npm run build in ui/ -> ui/dist)' {
            Push-Location (Join-Path $Root 'ui')
            try {
                npm run build
                Assert-ExitCode 'npm run build (ui)'
            }
            finally {
                Pop-Location
            }
        }
        $built += (Join-Path $Root 'ui\dist\index.html')
    }

    # ------------------------------------------------------------------------ relaunch
    if ($Run) {
        Invoke-Step 'Relaunch mydaw-engine' {
            if (-not (Test-Path -LiteralPath $EngineExe)) {
                throw "REBUILD FAILED: cannot relaunch — $EngineExe not found (build it with -Engine)."
            }
            # A still-running engine holds port 8417 — stop it before relaunching.
            Stop-LockingProcesses -Names @('mydaw-engine') `
                -Reason 'relaunching the engine (-Run)'
            Start-Process -FilePath $EngineExe -WorkingDirectory (Split-Path $EngineExe)
            Write-Host "    launched $EngineExe (UI at http://127.0.0.1:8417)"
        }
    }

    # ------------------------------------------------------------------------ summary
    $sw.Stop()
    Write-Host ''
    Write-Host ("==> Done in {0:n1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Cyan
    foreach ($artifact in $built) {
        if (Test-Path -LiteralPath $artifact) {
            Write-Host "    [ok]      $artifact" -ForegroundColor Green
        }
        else {
            Write-Host "    [MISSING] $artifact" -ForegroundColor Red
            throw "REBUILD FAILED: expected artifact missing: $artifact"
        }
    }
}
finally {
    Pop-Location
}
