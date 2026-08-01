# MyDAW — portable single-exe packager (ROADMAP Phase 5 "Packaging").
#
#   pwsh scripts/package-portable.ps1 [-Version 1.0.0]
#
# Produces dist\MyDAW-Portable-<Version>.exe: a self-extracting exe built with
# IExpress (ships with every Windows — no tooling to install) around the CURRENT
# build outputs. It deliberately performs NO build of any kind: the artifact freezes
# whatever build\bin\Release, build32\bin\Release and ui\dist hold right now, so run
# the gate before packaging a release.
#
# What the exe does on the user's machine (see scripts/portable/launch.ps1):
# extracts once per version to %LOCALAPPDATA%\MyDAW\app and starts the engine —
# no admin, no registry, no firewall prompt (loopback-only server). The exe IS the
# app; deleting it plus %LOCALAPPDATA%\MyDAW and %APPDATA%\MyDAW removes everything.
#
# Known cosmetic reality: the artifact is unsigned, so first download triggers
# SmartScreen ("More info" -> "Run anyway"). A code-signing cert is the only fix.

param([string]$Version = "1.0.0")
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$out  = Join-Path $root "dist"
$name = "MyDAW-Portable-$Version.exe"

# ---- sources (frozen — never built here) --------------------------------------------
$engine = Join-Path $root 'build\bin\Release\mydaw-engine.exe'
$host64 = Join-Path $root 'build\bin\Release\mydaw-host64.exe'
$host32 = Join-Path $root 'build32\bin\Release\mydaw-host32.exe'
$uidist = Join-Path $root 'ui\dist'
$license = Join-Path $root 'LICENSE'
foreach ($p in @($engine, $host64, $host32, $license, (Join-Path $uidist 'index.html'))) {
  if (-not (Test-Path $p)) { throw "missing prerequisite: $p (build it first — the packager never builds)" }
}

# ---- stage the payload: the exact on-disk layout the engine resolves ----------------
# <app>\mydaw-engine.exe + mydaw-host64.exe + mydaw-host32.exe (App::resolveHostPaths
# sameDir rule) + ui\ (App::resolveUiRoot candidate #3) + LICENSE.
$work  = Join-Path $env:TEMP "mydaw-package"
$stage = Join-Path $work "stage"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $engine, $host64, $host32, $license $stage
Copy-Item $uidist (Join-Path $stage 'ui') -Recurse

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $work 'payload.zip') -CompressionLevel Optimal
Copy-Item (Join-Path $PSScriptRoot 'portable\launch.ps1') $work
Copy-Item (Join-Path $PSScriptRoot 'portable\launch.vbs') $work
Set-Content (Join-Path $work 'version.txt') $Version

# ---- IExpress SED --------------------------------------------------------------------
New-Item -ItemType Directory -Force $out | Out-Null
$target = Join-Path $out $name
if (Test-Path $target) { Remove-Item $target -Force }
$sed = Join-Path $work 'mydaw.sed'
@"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$target
FriendlyName=MyDAW $Version
AppLaunched=wscript.exe launch.vbs
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="payload.zip"
FILE1="launch.vbs"
FILE2="launch.ps1"
FILE3="version.txt"
[SourceFiles]
SourceFiles0=$work\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
"@ | Set-Content $sed -Encoding ASCII

& "$env:WINDIR\System32\iexpress.exe" /N /Q $sed | Out-Null
if (-not (Test-Path $target)) { throw "iexpress produced no output (SED: $sed)" }

$sha = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
$mb  = [math]::Round((Get-Item $target).Length / 1MB, 1)
"built  : $target"
"size   : $mb MB"
"sha256 : $sha"
Set-Content (Join-Path $out "$name.sha256") "$sha  $name"
