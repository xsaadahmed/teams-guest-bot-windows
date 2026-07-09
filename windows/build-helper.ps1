<#
.SYNOPSIS
  Builds the WASAPI loopback capture helper into a single self-contained .exe that needs no
  .NET install and no admin rights on the machine it eventually runs on.

.DESCRIPTION
  Requires the .NET 8 SDK on the BUILD machine only:
  https://dotnet.microsoft.com/download (a normal per-user download - it does NOT need to
  also be present on every laptop this eventually runs on, because --self-contained bundles
  the whole runtime into the .exe itself).

  Run this once, and again any time windows/WasapiLoopbackRecorder/Program.cs changes.
  The output is a single file - once built, you can copy just that .exe around; it doesn't
  need the rest of this repo to run.

.EXAMPLE
  .\windows\build-helper.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$wasapiProj = Join-Path $root "windows\WasapiLoopbackRecorder\WasapiLoopbackRecorder.csproj"
$wasapiOut = Join-Path $root "windows\WasapiLoopbackRecorder\publish"
$dismissProj = Join-Path $root "windows\DismissTeamsDialog\DismissTeamsDialog.csproj"
$dismissOut = Join-Path $root "windows\DismissTeamsDialog\publish"

function Resolve-DotNetCli {
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
            return $candidate
        }
    }

    Write-Error @"
.NET 8 SDK not found.

Install from https://dotnet.microsoft.com/download (per-user install is fine).
If already installed to %USERPROFILE%\.dotnet, re-open this shell or run:
  `$env:DOTNET_ROOT = `"`$env:USERPROFILE\.dotnet`"; `$env:PATH = `"`$env:DOTNET_ROOT;`$env:PATH`"
"@
    exit 1
}

$dotnetExe = Resolve-DotNetCli
Write-Host ".NET SDK: $(& $dotnetExe --version)"
$publishArgs = @(
    "-c", "Release",
    "-r", "win-x64",
    "--self-contained", "true",
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true"
)

Write-Host "Building WASAPI loopback helper (self-contained, single file, win-x64)..." -ForegroundColor Cyan
& $dotnetExe publish $wasapiProj @publishArgs -o $wasapiOut
if ($LASTEXITCODE -ne 0) {
    Write-Error "WASAPI helper build failed - see errors above."
    exit 1
}

Write-Host "Building Teams dialog dismiss helper (self-contained, single file, win-x64)..." -ForegroundColor Cyan
& $dotnetExe publish $dismissProj @publishArgs -o $dismissOut
if ($LASTEXITCODE -ne 0) {
    Write-Error "Dismiss helper build failed - see errors above."
    exit 1
}

$wasapiExe = Join-Path $wasapiOut "WasapiLoopbackRecorder.exe"
$dismissExe = Join-Path $dismissOut "DismissTeamsDialog.exe"
Write-Host "Built: $wasapiExe" -ForegroundColor Green
Write-Host "Built: $dismissExe" -ForegroundColor Green
Write-Host "Both files are fully self-contained - copy them to other machines (no .NET install needed there)."
Write-Host ""
Write-Host "Quick manual test (Ctrl+C to stop, then check the file plays back and isn't silent):"
Write-Host "  $wasapiExe test.wav"
