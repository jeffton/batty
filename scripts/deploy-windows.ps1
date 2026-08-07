param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$BattyRoot = "D:\Batty\root",
  [string[]]$WorkspacesRoots = @("D:\projects"),
  [string]$PublicOrigin = "https://t14-dt-pc1028.cbrain.net",
  [string]$BaseUrl = "/batty",
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "batty",
  [string]$AppPoolName = "BattyProxy",
  [int]$BackendPort = 3147
)

$ErrorActionPreference = "Stop"

function Step([string]$message) {
  Write-Host ""
  Write-Host "==> $message"
}

function Ensure-Directory([string]$path) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

function Normalize-BaseUrl([string]$path) {
  $normalized = "/" + $path.Trim().Trim("/").Replace("\", "/")
  if ($normalized -eq "/") {
    return "/"
  }
  return $normalized
}

$BaseUrl = Normalize-BaseUrl $BaseUrl
$applicationBaseUrl = Normalize-BaseUrl $AppPath
if ($applicationBaseUrl -ne $BaseUrl) {
  throw "IIS AppPath '$AppPath' and Batty BaseUrl '$BaseUrl' must identify the same URL path."
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  throw "Windows deployment must run from an elevated PowerShell session."
}

Import-Module WebAdministration
if (-not (Get-WebGlobalModule -Name RewriteModule -ErrorAction SilentlyContinue)) {
  throw "IIS URL Rewrite 2 is required."
}
if (-not (Get-WebGlobalModule -Name ApplicationRequestRouting -ErrorAction SilentlyContinue)) {
  throw "IIS Application Request Routing 3 is required."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$corepack = (Get-Command corepack).Source
$commit = (git -C $repoDir rev-parse --short HEAD).Trim()
$releaseName = "{0}-{1}" -f $commit, (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmssfff")
$optionsDir = Join-Path $BattyRoot ".batty"
$optionsPath = Join-Path $optionsDir "options.json"

$validationFailures = @()

Step "Installing dependencies"
Push-Location $repoDir
try {
  & $corepack pnpm install

  Step "Running checks"
  & $corepack pnpm check
  if ($LASTEXITCODE -ne 0) {
    $validationFailures += "pnpm check"
  }

  Step "Building app"
  & $corepack pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm build failed"
  }
} finally {
  Pop-Location
}

if (Test-Path $optionsPath) {
  $configuredBaseUrl = Normalize-BaseUrl ((Get-Content -Raw $optionsPath | ConvertFrom-Json).baseUrl)
  if ($configuredBaseUrl -ne $BaseUrl) {
    throw "Batty root '$BattyRoot' is configured for baseUrl '$configuredBaseUrl', not '$BaseUrl'."
  }
} else {
  Step "Initializing Batty root configuration"
  Ensure-Directory $optionsDir
  [ordered]@{
    workspacesRoots = @($WorkspacesRoots)
    webPushSubject = $PublicOrigin
    baseUrl = $BaseUrl
  } | ConvertTo-Json -Depth 10 | Set-Content -Path $optionsPath
}
if ($validationFailures.Count -gt 0) {
  Write-Warning ("Continuing deployment after validation failures: " + ($validationFailures -join ", "))
}

Step "Packaging release"
& (Join-Path $scriptDir "install-release.ps1") `
  -InstallRoot $InstallRoot `
  -ReleaseName $releaseName `
  -BaseUrl $BaseUrl `
  -BackendPort $BackendPort

Step "Configuring Windows service"
& (Join-Path $scriptDir "install-windows-service.ps1") `
  -InstallRoot $InstallRoot `
  -BattyRoot $BattyRoot `
  -Port $BackendPort

Step "Handing off deployment reload"
& (Join-Path $scriptDir "handoff-restart-windows.ps1") `
  -InstallRoot $InstallRoot `
  -ReleaseName $releaseName `
  -SiteName $SiteName `
  -AppPath $AppPath `
  -AppPoolName $AppPoolName `
  -PublicOrigin $PublicOrigin `
  -BaseUrl $BaseUrl `
  -BackendPort $BackendPort

Write-Host ""
Write-Host "Deployment to $PublicOrigin$BaseUrl will activate after the handoff delay."
