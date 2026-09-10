[CmdletBinding()]
param(
    [string]$DependenciesDir = $env:ROON_DESKTOP_DEPENDENCIES,
    [string]$RuntimeDir = $env:ROON_DESKTOP_DATA_DIR,
    [string]$DriverPath = $env:ROON_DESKTOP_DRIVER,
    [string]$RoonPath = $env:ROON_DESKTOP_APP,
    [string]$NodePath,
    [switch]$SkipInstall
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

function Get-NodeExecutable {
    param([string]$ConfiguredPath)
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) { throw "Node executable not found: $ConfiguredPath" }
        return [System.IO.Path]::GetFullPath($ConfiguredPath)
    }
    return (Get-Command node -ErrorAction Stop).Source
}

function Copy-IfChanged {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
    $copyRequired = -not (Test-Path -LiteralPath $Destination -PathType Leaf)
    if (-not $copyRequired) {
        $copyRequired = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    }
    if ($copyRequired) { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
}

function Assert-InstalledDependencyVersions {
    param([Parameter(Mandatory = $true)][string]$Prefix, [Parameter(Mandatory = $true)]$Manifest)
    foreach ($packageName in @('@modelcontextprotocol/sdk', 'zod', 'pngjs')) {
        $expectedProperty = $Manifest.dependencies.PSObject.Properties[$packageName]
        if ($null -eq $expectedProperty) { throw "package.json is missing dependency: $packageName" }
        $installedPath = Join-Path $Prefix "node_modules\$packageName\package.json"
        if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
            throw "Required external dependency is missing: $packageName. Run setup without -SkipInstall."
        }
        $installed = Get-Content -LiteralPath $installedPath -Raw | ConvertFrom-Json
        if ([string]$installed.version -ne [string]$expectedProperty.Value) {
            throw "Installed $packageName version $($installed.version) does not match package.json $($expectedProperty.Value). Run setup without -SkipInstall."
        }
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageSource = Join-Path $repoRoot 'package.json'
$lockSource = Join-Path $repoRoot 'package-lock.json'
$serverSource = Join-Path $repoRoot 'src\server.mjs'
if (-not (Test-Path -LiteralPath $packageSource -PathType Leaf)) { throw "Missing package.json: $packageSource" }
if (-not (Test-Path -LiteralPath $lockSource -PathType Leaf)) { throw "Missing package-lock.json: $lockSource" }
if (-not (Test-Path -LiteralPath $serverSource -PathType Leaf)) { throw "Missing server source: $serverSource" }

$NodePath = Get-NodeExecutable -ConfiguredPath $NodePath
$nodeVersionText = (& $NodePath --version).Trim()
$nodeVersion = [version]($nodeVersionText.TrimStart('v'))
if ($nodeVersion -lt [version]'22.0.0') { throw "Node 22 or newer is required; found $nodeVersionText" }

$manifest = Get-Content -LiteralPath $packageSource -Raw | ConvertFrom-Json
$lockDependenciesJson = & $NodePath -e 'const fs=require(process.argv[2]);const lock=JSON.parse(fs.readFileSync(process.argv[1]));const root=Object.entries(lock.packages).find(entry=>entry[0].length===0)[1];if(!root||!root.dependencies)throw Error();process.stdout.write(JSON.stringify(root.dependencies));' $lockSource fs
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($lockDependenciesJson)) { throw 'Unable to read package-lock.json root dependencies with Node.' }
$lockDependencies = $lockDependenciesJson | ConvertFrom-Json
foreach ($packageName in @('@modelcontextprotocol/sdk', 'zod', 'pngjs')) {
    $manifestVersion = $manifest.dependencies.PSObject.Properties[$packageName].Value
    $lockVersion = $lockDependencies.PSObject.Properties[$packageName].Value
    if ([string]::IsNullOrWhiteSpace($manifestVersion) -or [string]$lockVersion -ne [string]$manifestVersion) {
        throw "package-lock.json does not match package.json for $packageName"
    }
}

if ([string]::IsNullOrWhiteSpace($DependenciesDir)) { $DependenciesDir = Get-DefaultDependenciesDir }
if ([string]::IsNullOrWhiteSpace($RuntimeDir)) { $RuntimeDir = Get-DefaultRuntimeDir }
if ([string]::IsNullOrWhiteSpace($DriverPath)) { $DriverPath = Get-DefaultDriverPath }
if ([string]::IsNullOrWhiteSpace($RoonPath)) { $RoonPath = Join-Path $env:LOCALAPPDATA 'Roon\Application\Roon.exe' }

$DependenciesDir = Assert-OutsideOneDrive -PathValue $DependenciesDir -Label 'Dependency prefix'
$RuntimeDir = Assert-OutsideOneDrive -PathValue $RuntimeDir -Label 'Runtime directory'
$DriverPath = [System.IO.Path]::GetFullPath($DriverPath)
$RoonPath = [System.IO.Path]::GetFullPath($RoonPath)

if (-not (Test-Path -LiteralPath $DriverPath -PathType Leaf)) { throw "cua-driver.exe not found: $DriverPath" }
if (-not (Test-Path -LiteralPath $RoonPath -PathType Leaf)) { throw "Roon.exe not found: $RoonPath" }
if ((Split-Path -Leaf $RoonPath).ToLowerInvariant() -ne 'roon.exe') { throw "RoonPath must identify Roon.exe: $RoonPath" }

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction Stop }

$null = New-Item -ItemType Directory -Force -Path $DependenciesDir
$null = New-Item -ItemType Directory -Force -Path $RuntimeDir
$packageDestination = Join-Path $DependenciesDir 'package.json'
$lockDestination = Join-Path $DependenciesDir 'package-lock.json'
Copy-IfChanged -Source $packageSource -Destination $packageDestination
Copy-IfChanged -Source $lockSource -Destination $lockDestination

if (-not $SkipInstall) {
    & $npm.Source install --prefix $DependenciesDir --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}

Assert-InstalledDependencyVersions -Prefix $DependenciesDir -Manifest $manifest

& $NodePath --check $serverSource
if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed with exit code $LASTEXITCODE" }

Write-Output 'Roon Desktop MCP setup complete.'
Write-Output "Dependencies: $DependenciesDir"
Write-Output "Runtime:      $RuntimeDir"
Write-Output "Driver:       $DriverPath"
Write-Output "Roon app:     $RoonPath"
Write-Output 'Foreground delivery remains disabled by default. Launch with scripts\launch.ps1.'
