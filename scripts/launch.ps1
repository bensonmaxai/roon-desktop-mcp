[CmdletBinding()]
param(
    [string]$DependenciesDir = $env:ROON_DESKTOP_DEPENDENCIES,
    [string]$RuntimeDir = $env:ROON_DESKTOP_DATA_DIR,
    [string]$DriverPath = $env:ROON_DESKTOP_DRIVER,
    [string]$RoonPath = $env:ROON_DESKTOP_APP,
    [string]$NodePath,
    [ValidateSet('0', '1')][string]$AllowForeground = '0',
    [ValidateSet('0', '1')][string]$AllowInput = '0',
    [ValidateRange(1, 100000)][int]$MaxOperations = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-OutsideOneDrive {
    param([Parameter(Mandatory = $true)][string]$PathValue, [Parameter(Mandatory = $true)][string]$Label)
    $fullPath = [System.IO.Path]::GetFullPath($PathValue)
    if ($fullPath -match '(^|[\\/])OneDrive(?:[^\\/]*)?([\\/]|$)') {
        throw "$Label must be outside OneDrive: $fullPath"
    }
    return $fullPath
}

function Get-DefaultDependenciesDir {
    return (Join-Path $env:LOCALAPPDATA 'Codex\dependencies\roon-desktop-mcp')
}

function Get-DefaultRuntimeDir {
    return (Join-Path $env:LOCALAPPDATA 'Codex\RoonDesktopMCP')
}

function Get-DefaultDriverPath {
    $candidate = Join-Path $env:USERPROFILE '.cua-driver\packages\releases\0.8.3-x86_64-pc-windows-msvc\cua-driver.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    throw 'Supply -DriverPath or ROON_DESKTOP_DRIVER for an installed cua-driver.exe.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverSource = Join-Path $repoRoot 'src\server.mjs'
if (-not (Test-Path -LiteralPath $serverSource -PathType Leaf)) { throw "Missing server source: $serverSource" }

if ([string]::IsNullOrWhiteSpace($DependenciesDir)) { $DependenciesDir = Get-DefaultDependenciesDir }
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) { $RuntimeDir = Get-DefaultRuntimeDir }
if ([string]::IsNullOrWhiteSpace($DriverPath)) { $DriverPath = Get-DefaultDriverPath }
if ([string]::IsNullOrWhiteSpace($RoonPath)) { $RoonPath = Join-Path $env:LOCALAPPDATA 'Roon\Application\Roon.exe' }
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = (Get-Command node -ErrorAction Stop).Source }

$DependenciesDir = Assert-OutsideOneDrive -PathValue $DependenciesDir -Label 'Dependency prefix'
$RuntimeDir = Assert-OutsideOneDrive -PathValue $RuntimeDir -Label 'Runtime directory'
$DriverPath = [System.IO.Path]::GetFullPath($DriverPath)
$RoonPath = [System.IO.Path]::GetFullPath($RoonPath)
$NodePath = [System.IO.Path]::GetFullPath($NodePath)

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $DependenciesDir -PathType Container)) { throw "Dependency prefix not found: $DependenciesDir. Run scripts\setup.ps1 first." }
foreach ($relativePackage in @('node_modules\@modelcontextprotocol\sdk\package.json', 'node_modules\zod\package.json', 'node_modules\pngjs\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $DependenciesDir $relativePackage) -PathType Leaf)) {
        throw "Required external dependency is missing: $relativePackage. Run scripts\setup.ps1 first."
    }
}
if (-not (Test-Path -LiteralPath $DriverPath -PathType Leaf)) { throw "cua-driver.exe not found: $DriverPath" }
if (-not (Test-Path -LiteralPath $RoonPath -PathType Leaf)) { throw "Roon.exe not found: $RoonPath" }
if ((Split-Path -Leaf $RoonPath).ToLowerInvariant() -ne 'roon.exe') { throw "RoonPath must identify Roon.exe: $RoonPath" }

$nodeVersionText = (& $NodePath --version).Trim()
$nodeVersion = [version]($nodeVersionText.TrimStart('v'))
if ($nodeVersion -lt [version]'22.0.0') { throw "Node 22 or newer is required; found $nodeVersionText" }

$null = New-Item -ItemType Directory -Force -Path $RuntimeDir
$env:ROON_DESKTOP_DEPENDENCIES = $DependenciesDir
$env:ROON_DESKTOP_DATA_DIR = $RuntimeDir
$env:ROON_DESKTOP_DRIVER = $DriverPath
$env:ROON_DESKTOP_APP = $RoonPath
$env:ROON_DESKTOP_ALLOW_FOREGROUND = $AllowForeground
$env:ROON_DESKTOP_ALLOW_INPUT = $AllowInput
$env:ROON_DESKTOP_MAX_OPERATIONS = [string]$MaxOperations

& $NodePath $serverSource
exit $LASTEXITCODE
