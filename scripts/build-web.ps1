$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$webDir = Join-Path $root "web"
$publicDir = Join-Path $root "public"

Write-Host "== Building web UI (cozy-meet-helper) ==" -ForegroundColor Cyan

Push-Location $webDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host ">> npm ci (web)" -ForegroundColor Cyan
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed in web/" }
    }

    Write-Host ">> npm run build (web)" -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        throw "vite build failed in web/ (exit $LASTEXITCODE)"
    }
} finally {
    Pop-Location
}

# TanStack Start (nitro: false) writes client assets to dist/client.
$outPublic = Join-Path $webDir "dist\client"
if (-not (Test-Path $outPublic)) {
    # Fallback if output layout changes.
    $outPublic = Join-Path $webDir ".output\public"
}
$assetsDir = Join-Path $outPublic "assets"
if (-not (Test-Path $assetsDir)) {
    throw "No built assets at $assetsDir — web build did not produce client output."
}

if (Test-Path $publicDir) {
    Remove-Item $publicDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $publicDir | Out-Null
Copy-Item -Recurse (Join-Path $outPublic "*") $publicDir -Force

$shell = Join-Path $publicDir "_shell.html"
$index = Join-Path $publicDir "index.html"
if (-not (Test-Path $index) -and (Test-Path $shell)) {
    Copy-Item $shell $index -Force
    Write-Host "Copied _shell.html -> index.html"
}

if (-not (Test-Path $index)) {
    throw "No index.html or _shell.html in $publicDir after build."
}

Write-Host "Web UI copied to $publicDir" -ForegroundColor Green
