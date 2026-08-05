param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$BattyRoot = "D:\Batty\root",
  [string[]]$WorkspacesRoots = @("D:\projects"),
  [string]$PublicOrigin = "https://t14-dt-pc1028.cbrain.net",
  [string]$BaseUrl = "/batty",
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "batty"
)

$ErrorActionPreference = "Stop"

function Step([string]$message) {
  Write-Host ""
  Write-Host "==> $message"
}

function Ensure-Directory([string]$path) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
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

if (-not (Test-Path $optionsPath)) {
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
  -BattyRoot $BattyRoot

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

Step "Handing off deployment reload"
$handoffParameters = @{
  InstallRoot = $InstallRoot
  ReleaseName = $releaseName
  SiteName = $SiteName
  AppPath = $AppPath
  ConfigureIis = $isAdmin
}
& (Join-Path $scriptDir "handoff-restart-windows.ps1") @handoffParameters

Write-Host ""
if ($isAdmin) {
  Write-Host "Deployment to $PublicOrigin$BaseUrl will activate after the handoff delay."
  exit 0
}

Write-Host "The release will be activated after the handoff delay."
Write-Host "Finish the IIS step from an elevated PowerShell session afterward:"
Write-Host "  powershell -ExecutionPolicy Bypass -File '$scriptDir\configure-iis-app.ps1' -SiteName '$SiteName' -AppPath '$AppPath' -PhysicalPath '$InstallRoot\current'"
exit 2
