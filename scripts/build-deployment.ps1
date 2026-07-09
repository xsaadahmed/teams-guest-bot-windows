<#
.SYNOPSIS
  Builds the portable Windows deployment zip for locked-down corporate laptops.

.DESCRIPTION
  Produces deployment/TeamsGuestBot-Windows.zip containing:
    - Portable Node.js (node.exe)
    - Compiled JavaScript (build/)
    - Production node_modules (incl. Playwright Chromium at PLAYWRIGHT_BROWSERS_PATH=0)
    - Self-contained .NET helper executables

  Run on a dev machine with internet, Node, npm, and .NET 8 SDK.
  The corporate laptop only needs: git clone, git lfs pull, unzip, Start-Bot.cmd.

.EXAMPLE
  .\scripts\build-deployment.ps1
#>
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$nodeVersion = "22.22.0"
$nodeZipName = "node-v$nodeVersion-win-x64.zip"
$nodeZipUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeZipName"
$cacheDir = Join-Path $root "deployment\.cache"
$stagingDir = Join-Path $root "deployment\.staging"
$outZip = Join-Path $root "deployment\TeamsGuestBot-Windows.zip"

Write-Host "== Building portable Windows deployment bundle ==" -ForegroundColor Cyan
Write-Host "Project root: $root"

function Ensure-DotNet {
    function Test-DotNetSdk([string]$dotnetExe) {
        if (-not (Test-Path $dotnetExe)) { return $false }
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'SilentlyContinue'
            $version = & $dotnetExe --version 2>$null
            return ($LASTEXITCODE -eq 0 -and $version)
        } finally {
            $ErrorActionPreference = $prevEap
        }
    }

    # Prefer per-user install first — PATH often has a broken dotnet stub with no SDK.
    $candidates = @(
        (Join-Path $env:USERPROFILE ".dotnet\dotnet.exe"),
        "${env:ProgramFiles}\dotnet\dotnet.exe"
    )
    if (Get-Command dotnet -ErrorAction SilentlyContinue) {
        $pathDotNet = (Get-Command dotnet).Source
        if ($pathDotNet -notin $candidates) { $candidates += $pathDotNet }
    }

    foreach ($candidate in $candidates) {
        if (Test-DotNetSdk $candidate) {
            $dotnetDir = Split-Path -Parent $candidate
            $env:DOTNET_ROOT = $dotnetDir
            if ($env:PATH -notlike "*$dotnetDir*") {
                $env:PATH = "$dotnetDir;$env:PATH"
            }
            Write-Host ".NET SDK: $(& $candidate --version) ($candidate)"
            return
        }
    }

    throw ".NET 8 SDK required to build WASAPI/Dismiss helpers. Install from https://dotnet.microsoft.com/download (per-user install to %USERPROFILE%\.dotnet works)."
}

function Invoke-Step([string]$Label, [scriptblock]$Action) {
    Write-Host ""
    Write-Host ">> $Label" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "Step failed: $Label (exit $LASTEXITCODE)"
    }
}

Ensure-DotNet

Invoke-Step "npm ci" { npm ci }
Invoke-Step "TypeScript compile" { npm run build }
Invoke-Step "Build .NET helpers" {
    & (Join-Path $root "windows\build-helper.ps1")
}

Invoke-Step "Install Playwright Chromium (portable path)" {
    $env:PLAYWRIGHT_BROWSERS_PATH = "0"
    npx playwright install chromium
}

Invoke-Step "Prune dev dependencies" {
    npm prune --omit=dev
}

$browserDir = Join-Path $root "node_modules\playwright-core\.local-browsers"
if (-not (Test-Path $browserDir)) {
    throw "Playwright browsers not found at $browserDir after install. Expected PLAYWRIGHT_BROWSERS_PATH=0 layout."
}
Write-Host "Playwright browsers: $browserDir"

Invoke-Step "Download portable Node.js $nodeVersion" {
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $nodeZipPath = Join-Path $cacheDir $nodeZipName
    if (-not (Test-Path $nodeZipPath)) {
        Write-Host "Downloading $nodeZipUrl ..."
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath -UseBasicParsing
    }
}

Invoke-Step "Stage bundle contents" {
    if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
    New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

    $nodeExtract = Join-Path $cacheDir "node-v$nodeVersion-win-x64"
    if (-not (Test-Path (Join-Path $nodeExtract "node.exe"))) {
        Expand-Archive -Path (Join-Path $cacheDir $nodeZipName) -DestinationPath $cacheDir -Force
    }

    $destNode = Join-Path $stagingDir "node"
    New-Item -ItemType Directory -Force -Path $destNode | Out-Null
    Copy-Item (Join-Path $nodeExtract "node.exe") $destNode

    Copy-Item -Recurse (Join-Path $root "build") (Join-Path $stagingDir "build")
    Copy-Item -Recurse (Join-Path $root "node_modules") (Join-Path $stagingDir "node_modules")

    $wasapiOut = Join-Path $stagingDir "windows\WasapiLoopbackRecorder\publish"
    $dismissOut = Join-Path $stagingDir "windows\DismissTeamsDialog\publish"
    New-Item -ItemType Directory -Force -Path $wasapiOut | Out-Null
    New-Item -ItemType Directory -Force -Path $dismissOut | Out-Null
    Copy-Item (Join-Path $root "windows\WasapiLoopbackRecorder\publish\WasapiLoopbackRecorder.exe") $wasapiOut
    Copy-Item (Join-Path $root "windows\DismissTeamsDialog\publish\DismissTeamsDialog.exe") $dismissOut
    Copy-Item (Join-Path $root "windows\chromium-policy.json") (Join-Path $stagingDir "windows\chromium-policy.json")

    Set-Content -Path (Join-Path $stagingDir "PORTABLE-BUNDLE.txt") -Value @(
        "teams-guest-bot portable Windows runtime bundle"
        "Built: $(Get-Date -Format o)"
        "Node: v$nodeVersion"
        "Playwright browsers: node_modules/playwright-core/.local-browsers (PLAYWRIGHT_BROWSERS_PATH=0)"
    )
}

Invoke-Step "Create zip archive" {
    if (Test-Path $outZip) { Remove-Item -Force $outZip }
    New-Item -ItemType Directory -Force -Path (Split-Path $outZip) | Out-Null
    Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $outZip -CompressionLevel Optimal
}

$sizeMb = [math]::Round((Get-Item $outZip).Length / 1MB, 1)
Write-Host ""
Write-Host "Built: $outZip ($sizeMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. git lfs track `"deployment/*.zip`""
Write-Host "  2. git add deployment/TeamsGuestBot-Windows.zip .gitattributes"
Write-Host "  3. git commit && git push"
Write-Host ""
Write-Host "Corporate laptop:"
Write-Host "  git clone ... && cd teams-guest-bot-windows && git lfs pull"
Write-Host "  tar -xf deployment\TeamsGuestBot-Windows.zip"
Write-Host "  Start-Bot.cmd"
