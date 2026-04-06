<#
.SYNOPSIS
  Bump version, commit, tag, push, build, and publish a new release.
.DESCRIPTION
  Interactive release script for molexMedia. Prompts for version bump type
  (patch / minor / major), updates package.json, commits, tags, pushes,
  then builds and uploads to GitHub Releases via electron-builder.
  Requires GH_TOKEN environment variable to be set.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Preflight checks ---
# electron-builder accepts GH_TOKEN or GITHUB_TOKEN
# Check current session, then fall back to persisted user-level env vars
if (-not $env:GH_TOKEN) {
    $env:GH_TOKEN = $env:GITHUB_TOKEN
}
if (-not $env:GH_TOKEN) {
    $env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User')
}
if (-not $env:GH_TOKEN) {
    $env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN', 'User')
}
if (-not $env:GH_TOKEN) {
    Write-Host "`n  ERROR: GH_TOKEN environment variable is not set." -ForegroundColor Red
    Write-Host "  Create a GitHub PAT at https://github.com/settings/tokens/new (repo scope)" -ForegroundColor Yellow
    Write-Host "  Then run:  [Environment]::SetEnvironmentVariable('GH_TOKEN', 'ghp_...', 'User')" -ForegroundColor Yellow
    Write-Host "  and restart your terminal.`n" -ForegroundColor Yellow
    exit 1
}

# Ensure clean working tree (allow untracked)
$status = git status --porcelain 2>&1
$dirty = ($status | Where-Object { $_ -notmatch '^\?\?' })
if ($dirty) {
    Write-Host "`n  ERROR: You have uncommitted changes. Commit or stash them first.`n" -ForegroundColor Red
    git status --short
    exit 1
}

# --- Read current version ---
$pkgPath = Join-Path $PSScriptRoot 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$current = [version]$pkg.version
Write-Host "`n  Current version: " -NoNewline
Write-Host "v$current" -ForegroundColor Cyan

# --- Prompt for bump type ---
Write-Host ""
Write-Host "  [1] patch  ->  $($current.Major).$($current.Minor).$($current.Build + 1)" -ForegroundColor DarkGray
Write-Host "  [2] minor  ->  $($current.Major).$($current.Minor + 1).0" -ForegroundColor DarkGray
Write-Host "  [3] major  ->  $($current.Major + 1).0.0" -ForegroundColor DarkGray
Write-Host ""

do {
    $choice = Read-Host "  Bump type (1/2/3)"
} while ($choice -notin '1', '2', '3')

switch ($choice) {
    '1' { $next = "$($current.Major).$($current.Minor).$($current.Build + 1)" }
    '2' { $next = "$($current.Major).$($current.Minor + 1).0" }
    '3' { $next = "$($current.Major + 1).0.0" }
}

Write-Host ""
Write-Host "  New version: " -NoNewline
Write-Host "v$next" -ForegroundColor Green

$confirm = Read-Host "  Proceed? (y/n)"
if ($confirm -ne 'y') {
    Write-Host "  Aborted.`n" -ForegroundColor Yellow
    exit 0
}

# --- Bump version in package.json ---
Write-Host ""
Write-Host "  [1/5] Bumping version..." -ForegroundColor Cyan
$raw = Get-Content $pkgPath -Raw
$raw = $raw -replace "`"version`":\s*`"[^`"]+`"", "`"version`": `"$next`""
Set-Content $pkgPath -Value $raw -NoNewline
Write-Host "        package.json -> v$next"

# --- Commit and tag ---
Write-Host "  [2/5] Committing and tagging..." -ForegroundColor Cyan
git add package.json
git commit -m "v$next" --quiet
git tag "v$next"
Write-Host "        Tagged v$next"

# --- Push ---
Write-Host "  [3/5] Pushing to origin..." -ForegroundColor Cyan
git push --quiet
git push --tags --quiet
Write-Host "        Pushed commits + tags"

# --- Build ---
Write-Host "  [4/5] Building app..." -ForegroundColor Cyan
npx electron-vite build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: electron-vite build failed" -ForegroundColor Red
    exit 1
}

# --- Publish ---
Write-Host "  [5/5] Publishing to GitHub Releases..." -ForegroundColor Cyan
npx electron-builder --publish always
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: electron-builder publish failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  v$next released successfully!" -ForegroundColor Green
Write-Host "  https://github.com/tonywied17/molex-media-electron/releases/tag/v$next" -ForegroundColor DarkGray
Write-Host ""
