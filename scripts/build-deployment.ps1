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
  The corporate laptop only needs: git clone, Unpack-Bundle.cmd, Start-Bot.cmd.

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
$splitPrefix = Join-Path $root "deployment\TeamsGuestBot-Windows.zip"
$manifestPath = Join-Path $root "deployment\TeamsGuestBot-Windows.zip.manifest"
$chunkBytes = 95 * 1024 * 1024   # stay under GitHub's 100 MB per-file limit

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
Invoke-Step "Build web UI" {
    & (Join-Path $root "scripts\build-web.ps1")
}
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
    if (Test-Path (Join-Path $root "public")) {
        Copy-Item -Recurse (Join-Path $root "public") (Join-Path $stagingDir "public")
    }

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

Invoke-Step "Split archive for plain-git commit (95 MB parts)" {
    Get-ChildItem "$splitPrefix.*" -ErrorAction SilentlyContinue | Remove-Item -Force
    if (Test-Path $manifestPath) { Remove-Item -Force $manifestPath }

    $inputStream = [System.IO.File]::OpenRead($outZip)
    $buffer = New-Object byte[] $chunkBytes
    $partNum = 0
    try {
        while ($inputStream.Position -lt $inputStream.Length) {
            $remaining = [Math]::Min([int64]$chunkBytes, $inputStream.Length - $inputStream.Position)
            $read = $inputStream.Read($buffer, 0, [int]$remaining)
            if ($read -le 0) { break }

            $partNum++
            $partPath = "{0}.{1:D3}" -f $splitPrefix, $partNum
            $partStream = [System.IO.File]::Create($partPath)
            try {
                $partStream.Write($buffer, 0, $read)
            } finally {
                $partStream.Close()
            }

            $partSizeMb = [math]::Round((Get-Item $partPath).Length / 1MB, 2)
            if ((Get-Item $partPath).Length -gt (100 * 1024 * 1024)) {
                throw "Part $partPath is ${partSizeMb} MB — exceeds GitHub 100 MB limit."
            }
            Write-Host "  Wrote $(Split-Path -Leaf $partPath) ($partSizeMb MB)"
        }
    } finally {
        $inputStream.Close()
    }

    if ($partNum -eq 0) { throw "Archive split produced zero parts." }

    Remove-Item -Force $outZip

    @(
        "parts=$partNum"
        "chunk_bytes=$chunkBytes"
        "archive=TeamsGuestBot-Windows.zip"
        "built=$(Get-Date -Format o)"
    ) | Set-Content -Path $manifestPath -Encoding ascii
}

$totalMb = 0
Get-ChildItem "$splitPrefix.*" | ForEach-Object { $totalMb += $_.Length }
$totalMb = [math]::Round($totalMb / 1MB, 1)
Write-Host ""
Write-Host "Built: $partNum split parts ($totalMb MB total) in deployment\" -ForegroundColor Green
Write-Host "Manifest: deployment\TeamsGuestBot-Windows.zip.manifest"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  git add deployment/"
Write-Host "  git commit -m `"Update portable deployment bundle (split archive)`""
Write-Host "  git push"
Write-Host ""
Write-Host "Corporate laptop:"
Write-Host "  git clone https://github.com/xsaadahmed/teams-guest-bot-windows"
Write-Host "  cd teams-guest-bot-windows"
Write-Host "  Unpack-Bundle.cmd"
Write-Host "  Start-Bot.cmd"
