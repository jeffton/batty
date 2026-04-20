param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$BattyRoot = "D:\Batty\root",
  [string]$WorkspacesRoot = "D:\projects",
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

function JsonObjectToHashtable($value) {
  $result = @{}
  if ($null -eq $value) {
    return $result
  }
  foreach ($property in $value.PSObject.Properties) {
    $result[$property.Name] = $property.Value
  }
  return $result
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$corepack = (Get-Command corepack).Source
$releaseName = (git -C $repoDir rev-parse --short HEAD).Trim()
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

  Step "Running tests"
  & $corepack pnpm test
  if ($LASTEXITCODE -ne 0) {
    $validationFailures += "pnpm test"
  }

  Step "Building app"
  & $corepack pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm build failed"
  }
} finally {
  Pop-Location
}

Step "Writing Batty root configuration"
Ensure-Directory $optionsDir
$existingOptions = @{}
if (Test-Path $optionsPath) {
  $existingOptions = JsonObjectToHashtable (Get-Content $optionsPath -Raw | ConvertFrom-Json)
}
$nextOptions = @{
  workspacesRoot = $WorkspacesRoot
  webPushSubject = $PublicOrigin
  baseUrl = $BaseUrl
}
foreach ($entry in $existingOptions.GetEnumerator()) {
  if (-not $nextOptions.ContainsKey($entry.Key)) {
    $nextOptions[$entry.Key] = $entry.Value
  }
}
$orderedOptions = [ordered]@{}
foreach ($key in @("authSecret", "workspacesRoot", "webPushSubject", "cronDailySessionStartTime", "braveSearchKey", "pinnedWorkspaceIds", "assistantWorkspaceId", "baseUrl")) {
  if ($nextOptions.ContainsKey($key) -and $null -ne $nextOptions[$key]) {
    $orderedOptions[$key] = $nextOptions[$key]
  }
}
$orderedOptions | ConvertTo-Json -Depth 10 | Set-Content -Path $optionsPath

if ($validationFailures.Count -gt 0) {
  Write-Warning ("Continuing deployment after validation failures: " + ($validationFailures -join ", "))
}

Step "Packaging release"
& (Join-Path $scriptDir "install-release.ps1") -InstallRoot $InstallRoot -ReleaseName $releaseName -BattyRoot $BattyRoot

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if ($isAdmin) {
  Step "Configuring IIS application"
  & (Join-Path $scriptDir "configure-iis-app.ps1") -SiteName $SiteName -AppPath $AppPath -PhysicalPath (Join-Path $InstallRoot "current")
  Write-Host ""
  Write-Host "Deployed Batty to $PublicOrigin$BaseUrl"
  exit 0
}

Write-Host ""
Write-Host "Batty is packaged and configured at:"
Write-Host "  Install: $InstallRoot"
Write-Host "  Data:    $BattyRoot"
Write-Host ""
Write-Host "Finish the IIS step from an elevated PowerShell session:"
Write-Host "  powershell -ExecutionPolicy Bypass -File '$scriptDir\configure-iis-app.ps1' -SiteName '$SiteName' -AppPath '$AppPath' -PhysicalPath '$InstallRoot\current'"
exit 2
