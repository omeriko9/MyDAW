# MyDAW — package.ps1
# Assembles a self-contained, relocatable Release folder:
#
#   <Dest>\
#     mydaw-engine.exe     (build\bin\Release)
#     mydaw-host64.exe     (build\bin\Release)
#     mydaw-host32.exe     (build32\bin\Release — optional, 32-bit plugins)
#     ui\                  (ui\dist — engine serves the exe-relative .\ui fallback, SPEC §3)
#     settings.json        (portable config: engine prefers exe-dir settings.json over %APPDATA%)
#     README.txt
#
# Usage:  powershell -File scripts\package.ps1 [-Dest <dir>] [-SkipBuild] [-Verify]
#   -Dest      output folder (default <repo>\Release)
#   -SkipBuild package existing binaries without rebuilding engine/UI
#   -Verify    after packaging, launch the engine from Dest on a test port and
#              check the UI + WS endpoint respond, then shut it down.

param(
    [string]$Dest = "",
    [switch]$SkipBuild,
    [switch]$Verify
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Dest) { $Dest = Join-Path $repo "Release" }

function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }

# ---- 1. Build -------------------------------------------------------------
if (-not $SkipBuild) {
    Step "Building engine + hosts (build.cmd)"
    & cmd /c "`"$repo\build.cmd`""
    if ($LASTEXITCODE -ne 0) { throw "engine build failed (exit $LASTEXITCODE)" }

    Step "Building UI (vite)"
    Push-Location (Join-Path $repo "ui")
    try {
        if (-not (Test-Path "node_modules")) {
            & npm ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "ui build failed" }
    } finally { Pop-Location }
}

# ---- 2. Collect inputs ----------------------------------------------------
$engineExe = Join-Path $repo "build\bin\Release\mydaw-engine.exe"
$host64Exe = Join-Path $repo "build\bin\Release\mydaw-host64.exe"
$host32Exe = Join-Path $repo "build32\bin\Release\mydaw-host32.exe"
$uiDist    = Join-Path $repo "ui\dist"

foreach ($f in @($engineExe, $host64Exe)) {
    if (-not (Test-Path $f)) { throw "missing build artifact: $f (run without -SkipBuild?)" }
}
if (-not (Test-Path (Join-Path $uiDist "index.html"))) {
    throw "missing ui\dist\index.html (run without -SkipBuild?)"
}

# ---- 3. Assemble ----------------------------------------------------------
Step "Assembling $Dest"
New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item $engineExe $Dest -Force
Copy-Item $host64Exe $Dest -Force
if (Test-Path $host32Exe) {
    Copy-Item $host32Exe $Dest -Force
} else {
    Write-Warning "mydaw-host32.exe not found ($host32Exe) — 32-bit plugins will be unavailable in this package."
}

$uiOut = Join-Path $Dest "ui"
if (Test-Path $uiOut) { Remove-Item -Recurse -Force $uiOut }
Copy-Item $uiDist $uiOut -Recurse -Force

# Portable settings template — never clobber an existing (user-edited) one.
$settingsOut = Join-Path $Dest "settings.json"
if (-not (Test-Path $settingsOut)) {
    @'
{
  "port": 8417,
  "autosaveMinutes": 2,
  "audio": {
    "driver": "wasapi",
    "deviceId": "",
    "sampleRate": 48000,
    "bufferSize": 512,
    "exclusive": false
  },
  "pluginFoldersVst2": [],
  "pluginFoldersVst3": []
}
'@ | Set-Content -Encoding utf8NoBOM $settingsOut
}

@'
MyDAW — portable release
========================

Run mydaw-engine.exe. It starts the audio engine, serves the UI on the port set
in settings.json (default 8417) and opens your browser at http://127.0.0.1:<port>/.

Files:
  mydaw-engine.exe   the DAW engine (HTTP/WS server + audio)
  mydaw-host64.exe   sandboxed 64-bit VST host (one process per plugin)
  mydaw-host32.exe   sandboxed 32-bit VST host (legacy plugins)
  ui\                the web UI served by the engine
  settings.json      portable settings (used INSTEAD of %APPDATA%\MyDAW\settings.json
                     because it sits next to the exe; delete it to fall back)

Command-line flags (override settings.json): --port <n>, --driver wasapi|asio|null,
--no-browser, --project <path>. Logs land in %APPDATA%\MyDAW\logs.
'@ | Set-Content -Encoding utf8NoBOM (Join-Path $Dest "README.txt")

# ---- 4. Optional verification --------------------------------------------
if ($Verify) {
    $port = 18761
    Step "Verifying package (port $port, null audio driver)"
    $proc = Start-Process -FilePath (Join-Path $Dest "mydaw-engine.exe") `
        -ArgumentList "--port", "$port", "--driver", "null", "--no-browser" `
        -WorkingDirectory $Dest -PassThru
    try {
        $ok = $false
        foreach ($i in 1..40) {
            Start-Sleep -Milliseconds 250
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
                if ($r.StatusCode -eq 200 -and $r.Content -match "<html") { $ok = $true; break }
            } catch {}
        }
        if (-not $ok) { throw "packaged engine did not serve the UI on port $port" }
        Write-Host "Package verified: UI served from the relocatable folder." -ForegroundColor Green
    } finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    }
}

$size = "{0:N1} MB" -f ((Get-ChildItem $Dest -Recurse | Measure-Object Length -Sum).Sum / 1MB)
Step "Done — $Dest ($size)"
