# MyDAW — one-command release: build -> verify -> package -> publish.
#
#   pwsh scripts/release.ps1 -Version 1.1.0                 # everything up to dist\
#   pwsh scripts/release.ps1 -Version 1.1.0 -Publish        # + gh release create/upload
#   pwsh scripts/release.ps1 -Version 1.1.0 -SkipBuild      # package what's on disk
#   pwsh scripts/release.ps1 -Version 1.1.0 -SkipGate       # DANGER: skip the full gate
#   pwsh scripts/release.ps1 -Version 1.1.0 -Publish -Notes "What changed..."
#
# The chain (each step fails loudly; nothing later runs after a failure):
#   1. scripts/build.ps1            — UI + engine/host64 (x64) + host32 (Win32)
#   2. node scripts/gate.mjs --full — THE definition of done for a release (NEXT.md)
#   3. scripts/package-portable.ps1 — dist\MyDAW-Portable-<Version>.exe (+ .sha256)
#   4. (-Publish) gh release create v<Version> with the exe + checksum attached;
#      if the tag already exists, the assets are uploaded onto it (--clobber).
#
# -Publish needs an authenticated GitHub CLI (`gh auth status`). Without -Publish the
# script stops after packaging and prints the exact gh command to run.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$Publish,
    [switch]$SkipBuild,
    [switch]$SkipGate,
    [string]$Notes = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $Root
try {
    if ($Version -notmatch '^\d+\.\d+\.\d+([-.].+)?$') {
        throw "Version '$Version' does not look like semver (e.g. 1.1.0)."
    }

    # Dirty working tree = the release wouldn't match any commit. Warn, don't block —
    # instrument-not-product posture, but the warning must be unmissable.
    $dirty = git -C $Root status --porcelain
    if ($dirty) {
        Write-Warning "Working tree is DIRTY — this release will not correspond to a commit:"
        $dirty | Select-Object -First 10 | ForEach-Object { Write-Warning "  $_" }
    }

    if (-not $SkipBuild) {
        Write-Host "== 1/4 build (ui + engine + hosts) ==" -ForegroundColor Cyan
        & pwsh -NoProfile -File (Join-Path $Root 'scripts\build.ps1')
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed ($LASTEXITCODE)" }
    } else {
        Write-Host "== 1/4 build SKIPPED (-SkipBuild) — packaging what's on disk ==" -ForegroundColor Yellow
    }

    if (-not $SkipGate) {
        Write-Host "== 2/4 gate --full (release tier) ==" -ForegroundColor Cyan
        node (Join-Path $Root 'scripts\gate.mjs') --full
        if ($LASTEXITCODE -ne 0) { throw "gate --full FAILED — not releasing a red build" }
    } else {
        Write-Host "== 2/4 gate SKIPPED (-SkipGate) — you own whatever ships ==" -ForegroundColor Yellow
    }

    Write-Host "== 3/4 package ==" -ForegroundColor Cyan
    & pwsh -NoProfile -File (Join-Path $Root 'scripts\package-portable.ps1') -Version $Version
    if ($LASTEXITCODE -ne 0) { throw "package-portable.ps1 failed ($LASTEXITCODE)" }

    $exe = Join-Path $Root "dist\MyDAW-Portable-$Version.exe"
    $sha = "$exe.sha256"
    if (-not (Test-Path $exe)) { throw "expected artifact missing: $exe" }

    if (-not $Publish) {
        Write-Host "== 4/4 publish SKIPPED (no -Publish) ==" -ForegroundColor Yellow
        Write-Host "Artifact ready: $exe"
        Write-Host "Publish with:"
        Write-Host "  gh release create v$Version `"$exe`" `"$sha`" --title `"MyDAW $Version`" --notes `"...`""
        return
    }

    Write-Host "== 4/4 publish to GitHub Releases ==" -ForegroundColor Cyan
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw "gh is not authenticated — run 'gh auth login' first" }

    $tag = "v$Version"
    if ($Notes -eq "") { $Notes = "MyDAW $Version — portable single-exe build. Unzip nothing: run the exe." }

    gh release view $tag *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Release $tag exists — uploading assets onto it (--clobber)."
        gh release upload $tag $exe $sha --clobber
        if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    } else {
        gh release create $tag $exe $sha --title "MyDAW $Version" --notes $Notes
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    }
    Write-Host "Published: $tag" -ForegroundColor Green
} finally {
    Pop-Location
}
