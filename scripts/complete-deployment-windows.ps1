param(
  [string]$InstallRoot,
  [string]$ReleaseName,
  [string]$SiteName,
  [string]$AppPath,
  [string]$AppPoolName,
  [string]$PublicOrigin,
  [string]$BaseUrl,
  [int]$BackendPort = 3147,
  [int]$DelaySeconds = 20,
  [string]$LogPath
)

$ErrorActionPreference = "Stop"
Start-Transcript -Path $LogPath -Append | Out-Null

function Wait-ForUrl([string]$url) {
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Head -Uri $url -TimeoutSec 2 | Out-Null
      return
    } catch {
      if ($attempt -eq 30) {
        throw
      }
      Start-Sleep -Seconds 1
    }
  }
}

function Remove-Junction([string]$path) {
  cmd /d /c rmdir "$path" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not remove current junction (exit code $LASTEXITCODE)."
  }
}

$activationStarted = $false
$previousReleaseDir = $null
$currentDir = Join-Path $InstallRoot "current"

try {
  Start-Sleep -Seconds $DelaySeconds

  $releaseDir = Join-Path (Join-Path $InstallRoot "releases") $ReleaseName
  if (-not (Test-Path (Join-Path $releaseDir "dist\server\main.mjs"))) {
    throw "Staged release '$releaseDir' is incomplete."
  }

  Import-Module WebAdministration
  $sitePath = "IIS:\Sites\$SiteName"
  $appName = $AppPath.Trim("/").Replace("/", "\")
  $appIisPath = "$sitePath\$appName"
  if (Test-Path $appIisPath) {
    $existingPool = (Get-ItemProperty $appIisPath).applicationPool
    if ($existingPool -ne $AppPoolName) {
      throw "IIS application '$AppPath' uses app pool '$existingPool'. Move it to the dedicated '$AppPoolName' pool before deploying."
    }
  }

  if (Test-Path $currentDir) {
    $current = Get-Item $currentDir
    if (-not ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to replace non-junction '$currentDir'."
    }
    $previousReleaseDir = $current.Target
  }

  $activationStarted = $true
  if ((Get-Service -Name Batty).Status -ne "Stopped") {
    Stop-Service -Name Batty
    (Get-Service -Name Batty).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
  }

  if (Test-Path $currentDir) {
    Remove-Junction $currentDir
  }
  New-Item -ItemType Junction -Path $currentDir -Target $releaseDir | Out-Null

  & (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "configure-iis-app.ps1") `
    -SiteName $SiteName `
    -AppPath $AppPath `
    -PhysicalPath $currentDir `
    -AppPoolName $AppPoolName

  Start-Service -Name Batty
  (Get-Service -Name Batty).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))

  $backendPath = $BaseUrl.TrimEnd("/")
  if ($backendPath -eq "/") {
    $backendPath = ""
  }
  Wait-ForUrl "http://127.0.0.1:$BackendPort$backendPath/healthz"
  Wait-ForUrl "$($PublicOrigin.TrimEnd('/'))$backendPath/healthz"

  Write-Host "Activated Batty release $ReleaseName"
} catch {
  $deploymentError = $_
  if ($activationStarted -and $previousReleaseDir) {
    try {
      if ((Get-Service -Name Batty).Status -ne "Stopped") {
        Stop-Service -Name Batty
        (Get-Service -Name Batty).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
      }
      if (Test-Path $currentDir) {
        Remove-Junction $currentDir
      }
      New-Item -ItemType Junction -Path $currentDir -Target $previousReleaseDir | Out-Null
      & (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "configure-iis-app.ps1") `
        -SiteName $SiteName `
        -AppPath $AppPath `
        -PhysicalPath $currentDir `
        -AppPoolName $AppPoolName
      Start-Service -Name Batty
      (Get-Service -Name Batty).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
      Write-Warning "Deployment failed; restored '$previousReleaseDir'."
    } catch {
      throw "Deployment failed: $deploymentError Rollback also failed: $_"
    }
  }
  throw $deploymentError
} finally {
  Stop-Transcript | Out-Null
}
