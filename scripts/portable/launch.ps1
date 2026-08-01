# MyDAW portable launcher (SPEC §3 portable layout).
#
# Runs from the self-extractor's temp directory (hidden, via launch.vbs). The exe the
# user double-clicked IS the app: this script unpacks the payload into a stable
# per-user location — %LOCALAPPDATA%\MyDAW\app — exactly once per version (marker
# file), then starts the engine from there. Later double-clicks skip the unpack, and
# a double-click while MyDAW is already running just reopens the UI tab instead of
# failing on the taken port. Everything is per-user: no admin, no registry, no
# firewall prompt (the engine listens on 127.0.0.1 only). Removal = delete
# %LOCALAPPDATA%\MyDAW (the app) and %APPDATA%\MyDAW (settings).

$ErrorActionPreference = 'Stop'

$ver  = (Get-Content (Join-Path $PSScriptRoot 'version.txt') | Select-Object -First 1).Trim()
$dst  = Join-Path $env:LOCALAPPDATA 'MyDAW\app'
$marker = Join-Path $dst 'portable-version.txt'

# Already running? The engine refuses a taken port, so reopen the UI instead.
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:8417/' -TimeoutSec 2 -UseBasicParsing
  if ($r.StatusCode -eq 200) {
    Start-Process 'http://127.0.0.1:8417/'
    exit 0
  }
} catch { }

$cur = ''
if (Test-Path $marker) { $cur = (Get-Content $marker -ErrorAction SilentlyContinue | Select-Object -First 1) }
if ($cur -ne $ver) {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force $dst | Out-Null
  Expand-Archive (Join-Path $PSScriptRoot 'payload.zip') $dst -Force
  Set-Content $marker $ver
}

# The engine finds mydaw-host64/32.exe and ui\ next to itself; it opens the browser.
Start-Process (Join-Path $dst 'mydaw-engine.exe') -WorkingDirectory $dst
