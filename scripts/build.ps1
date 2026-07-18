# MyDAW full build: ui (npm) -> engine+host64 x64 Release -> host32 Win32 Release. SPEC 3.
#
#   pwsh scripts/build.ps1                 # everything
#   pwsh scripts/build.ps1 -SkipUi         # native only
#   pwsh scripts/build.ps1 -SkipHost32     # skip the 32-bit bridge host
#   pwsh scripts/build.ps1 -Clean          # wipe build/ and build32/ first
#
# Each step fails loudly (non-zero exit code aborts the script). Artifact paths are
# printed at the end. build/ and build32/ are marked Dropbox-ignored right after each
# configure (NTFS alternate stream com.dropbox.ignored).

[CmdletBinding()]
param(
    [switch]$SkipUi,
    [switch]$SkipX64,
    [switch]$SkipHost32,
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

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
        throw "BUILD FAILED: $What exited with code $LASTEXITCODE"
    }
}

function Stop-LockingProcesses {
    param([Parameter(Mandatory)][string[]]$Names,
          [Parameter(Mandatory)][string]$Reason)
    foreach ($name in $Names) {
        $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
        foreach ($proc in $procs) {
            Write-Warning "Stopping '$($proc.ProcessName)' (PID $($proc.Id)) - $Reason"
            try { Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction Stop } catch {}
        }
        if ($procs.Count -gt 0) {
            Wait-Process -Name $name -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
}

function Test-StaleCompilerCache {
    param([Parameter(Mandatory)][string]$BuildDir)
    $cache = Join-Path (Join-Path $Root $BuildDir) 'CMakeCache.txt'
    if (-not (Test-Path -LiteralPath $cache)) {
        return $false
    }
    $keys = @('CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_AR', 'CMAKE_LINKER')
    foreach ($line in Get-Content -LiteralPath $cache) {
        foreach ($key in $keys) {
            if ($line -notmatch "^$key(?::[^=]+)?=(.+)$") {
                continue
            }
            $tool = $Matches[1].Trim()
            if (-not $tool -or $tool -match 'NOTFOUND$') {
                continue
            }
            if (-not (Test-Path -LiteralPath $tool)) {
                Write-Warning "${BuildDir} has stale cached tool path for ${key}: $tool"
                return $true
            }
        }
    }
    return $false
}

function Reset-BuildDir {
    param([Parameter(Mandatory)][string]$BuildDir)
    $dir = Join-Path $Root $BuildDir
    if (Test-Path -LiteralPath $dir) {
        Remove-Item -LiteralPath $dir -Recurse -Force -Confirm:$false
        Write-Host "    removed stale build tree $dir" -ForegroundColor Yellow
    }
}

function Clear-BuildTrackingState {
    param([Parameter(Mandatory)][string]$BuildDir)
    $targets = @(
        (Join-Path $Root "$BuildDir\engine\mydaw-engine.dir\Release\mydaw-engine.tlog"),
        (Join-Path $Root "$BuildDir\plugin-host\mydaw-host.dir\Release\mydaw-host.tlog"),
        (Join-Path $Root "$BuildDir\plugin-host\mydaw-host.vcxproj.FileListAbsolute.txt")
    )
    foreach ($path in $targets) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "    cleared tracking state $path" -ForegroundColor Yellow
        }
    }
}

function Invoke-CMakeBuildPreset {
    param(
        [Parameter(Mandatory)][string]$Preset,
        [Parameter(Mandatory)][string]$BuildDir,
        [Parameter(Mandatory)][string]$What
    )

    $attempt = 1
    while ($true) {
        & cmake --build --preset $Preset
        $rc = $LASTEXITCODE
        if ($rc -eq 0) {
            return
        }

        $canRetry = $attempt -eq 1
        $msbuildLogs = @(
            (Join-Path $Root "$BuildDir\engine\mydaw-engine.dir\Release\mydaw-engine.tlog"),
            (Join-Path $Root "$BuildDir\plugin-host\mydaw-host.dir\Release\mydaw-host.tlog")
        )
        $hasTrackingState = $false
        foreach ($p in $msbuildLogs) {
            if (Test-Path -LiteralPath $p) {
                $hasTrackingState = $true
                break
            }
        }

        if (-not $canRetry -or -not $hasTrackingState) {
            $global:LASTEXITCODE = $rc
            Assert-ExitCode $What
        }

        Write-Warning "$What hit an MSBuild tracking/log lock; clearing .tlog state and retrying once"
        Stop-LockingProcesses -Names @('mydaw-engine', 'mydaw-host64', 'mydaw-host32', 'MSBuild', 'mspdbsrv') `
            -Reason 'recovering from MSBuild tracking/log lock during build'
        Clear-BuildTrackingState -BuildDir $BuildDir
        Start-Sleep -Milliseconds 500
        $attempt++
    }
}

function Set-DropboxIgnored {
    # Mark a directory ignored by Dropbox sync (Dropbox honors this NTFS alternate stream).
    param([Parameter(Mandatory)][string]$Dir)
    try {
        if (Test-Path -LiteralPath $Dir) {
            Set-Content -LiteralPath $Dir -Stream com.dropbox.ignored -Value 1 -ErrorAction Stop
            Write-Host "    (marked Dropbox-ignored: $Dir)" -ForegroundColor DarkGray
        }
    }
    catch {
        Write-Warning "Could not mark '$Dir' as Dropbox-ignored: $($_.Exception.Message)"
    }
}

Push-Location $Root
try {
    if ($Clean) {
        Invoke-Step 'Clean build/ and build32/' {
            foreach ($d in @('build', 'build32')) {
                $p = Join-Path $Root $d
                if (Test-Path -LiteralPath $p) {
                    Remove-Item -LiteralPath $p -Recurse -Force -Confirm:$false
                    Write-Host "    removed $p"
                }
            }
        }
    }

    # ------------------------------------------------------------------ 1. UI (Vite/React)
    if (-not $SkipUi) {
        Invoke-Step 'UI: npm install + build (ui/ -> ui/dist)' {
            $uiDir = Join-Path $Root 'ui'
            if (-not (Test-Path -LiteralPath (Join-Path $uiDir 'package.json'))) {
                throw "BUILD FAILED: $uiDir\package.json not found - ui module missing (or pass -SkipUi)."
            }
            Push-Location $uiDir
            try {
                if (Test-Path -LiteralPath (Join-Path $uiDir 'package-lock.json')) {
                    npm ci
                    Assert-ExitCode 'npm ci (ui)'
                }
                else {
                    npm install
                    Assert-ExitCode 'npm install (ui)'
                }
                npm run build
                Assert-ExitCode 'npm run build (ui)'
            }
            finally {
                Pop-Location
            }
        }
    }
    else {
        Write-Host 'Skipping UI build (-SkipUi).' -ForegroundColor Yellow
    }

    # ------------------------------------------------------------- 2. engine + host64 (x64)
    if (-not $SkipX64) {
        Invoke-Step 'Stop running MyDAW x64 processes' {
            Stop-LockingProcesses -Names @('mydaw-engine', 'mydaw-host64') `
                -Reason 'full build is about to overwrite x64 binaries'
        }
        if (Test-StaleCompilerCache -BuildDir 'build') {
            Invoke-Step 'Reset stale x64 build tree (build/)' {
                Reset-BuildDir -BuildDir 'build'
            }
        }
        Invoke-Step 'CMake configure: preset x64-release (build/)' {
            cmake --preset x64-release
            Set-DropboxIgnored (Join-Path $Root 'build')   # right after configure, pass or fail comes next
            Assert-ExitCode 'cmake configure (x64-release)'
        }
        Invoke-Step 'CMake build: mydaw-engine + mydaw-host64 (Release)' {
            Invoke-CMakeBuildPreset -Preset 'x64-release' -BuildDir 'build' -What 'cmake build (x64-release)'
        }
    }
    else {
        Write-Host 'Skipping x64 build (-SkipX64).' -ForegroundColor Yellow
    }

    # --------------------------------------------------------------------- 3. host32 (Win32)
    if (-not $SkipHost32) {
        Invoke-Step 'Stop running MyDAW Win32 bridge processes' {
            Stop-LockingProcesses -Names @('mydaw-host32', 'mydaw-engine') `
                -Reason 'full build is about to overwrite Win32 bridge binaries'
        }
        if (Test-StaleCompilerCache -BuildDir 'build32') {
            Invoke-Step 'Reset stale Win32 build tree (build32/)' {
                Reset-BuildDir -BuildDir 'build32'
            }
        }
        Invoke-Step 'CMake configure: preset host32-release (build32/)' {
            cmake --preset host32-release
            Set-DropboxIgnored (Join-Path $Root 'build32')
            Assert-ExitCode 'cmake configure (host32-release)'
        }
        Invoke-Step 'CMake build: mydaw-host32 (Release)' {
            Invoke-CMakeBuildPreset -Preset 'host32-release' -BuildDir 'build32' -What 'cmake build (host32-release)'
        }
    }
    else {
        Write-Host 'Skipping host32 build (-SkipHost32).' -ForegroundColor Yellow
    }

    # ------------------------------------------------------------------------- 4. artifacts
    Write-Host ''
    Write-Host '==> Artifacts' -ForegroundColor Cyan
    $artifacts = @(
        @{ Path = 'build\bin\Release\mydaw-engine.exe';   Skipped = $SkipX64 },
        @{ Path = 'build\bin\Release\mydaw-host64.exe';   Skipped = $SkipX64 },
        @{ Path = 'build32\bin\Release\mydaw-host32.exe'; Skipped = $SkipHost32 },
        @{ Path = 'ui\dist\index.html';                   Skipped = $SkipUi }
    )
    $missing = $false
    foreach ($a in $artifacts) {
        $full = Join-Path $Root $a.Path
        if (Test-Path -LiteralPath $full) {
            Write-Host "    [ok]      $full" -ForegroundColor Green
        }
        elseif ($a.Skipped) {
            Write-Host "    [skipped] $full" -ForegroundColor Yellow
        }
        else {
            Write-Host "    [MISSING] $full" -ForegroundColor Red
            $missing = $true
        }
    }
    if ($missing) {
        throw 'BUILD FAILED: expected artifacts are missing (see list above).'
    }
    Write-Host ''
    Write-Host 'Build complete.' -ForegroundColor Green
}
finally {
    Pop-Location
}
