param(
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "batty",
  [string]$PhysicalPath = "D:\Batty\app\current",
  [string]$AppPoolName = "Batty"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  throw "This script must run from an elevated PowerShell session."
}

Import-Module WebAdministration

if (-not (Test-Path "IIS:\AppPools\$AppPoolName")) {
  New-WebAppPool -Name $AppPoolName | Out-Null
  Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name processModel.identityType -Value "ApplicationPoolIdentity"
}
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name managedRuntimeVersion -Value ""
Set-ItemProperty "IIS:\AppPools\$AppPoolName" -Name managedPipelineMode -Value "Integrated"

$sitePath = "IIS:\Sites\$SiteName"
if (-not (Test-Path $sitePath)) {
  throw "IIS site '$SiteName' was not found."
}

$appName = $AppPath.Trim('/').Replace('/', '\')
$appIisPath = "$sitePath\$appName"
if (Test-Path $appIisPath) {
  Set-ItemProperty $appIisPath -Name physicalPath -Value $PhysicalPath
  Set-ItemProperty $appIisPath -Name applicationPool -Value $AppPoolName
} else {
  New-WebApplication -Site $SiteName -Name $AppPath.Trim('/') -PhysicalPath $PhysicalPath -ApplicationPool $AppPoolName | Out-Null
}

Restart-WebAppPool -Name $AppPoolName
Write-Host "Configured IIS application https://<site>/$($AppPath.Trim('/')) -> $PhysicalPath"
