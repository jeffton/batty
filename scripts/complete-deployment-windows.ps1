param(
  [string]$InstallRoot,
  [string]$ReleaseName,
  [string]$SiteName,
  [string]$AppPath,
  [string]$AppPoolName,
  [string]$PublicOrigin,
  [string]$BaseUrl,
  [int]$BackendPort = 3147,
  [string]$LogPath,
  [string]$BattyRoot,
  [switch]$Force
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

function Wait-ForDeploymentDrain([string]$cliPath, [string]$battyRoot) {
  & (Get-Command node).Source $cliPath --root $battyRoot drain
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment drain failed with exit code $LASTEXITCODE."
  }
}

function Remove-Junction([string]$path) {
  cmd /d /c rmdir "$path" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not remove current junction (exit code $LASTEXITCODE)."
  }
}

$activationStarted = $false
$storageChanged = $false
$previousReleaseDir = $null
$currentDir = Join-Path $InstallRoot "current"

try {
  $backendPath = $BaseUrl.TrimEnd("/")
  if ($backendPath -eq "/") {
    $backendPath = ""
  }
  $releaseDir = Join-Path (Join-Path $InstallRoot "releases") $ReleaseName
  $cliPath = Join-Path $releaseDir "dist\server\cli.mjs"
  if (-not (Test-Path (Join-Path $releaseDir "dist\server\main.mjs")) -or -not (Test-Path $cliPath)) {
    throw "Staged release '$releaseDir' is incomplete."
  }
  $serviceStatus = (Get-Service -Name Batty).Status
  if ($serviceStatus -ne "Stopped" -and -not $Force) {
    Wait-ForDeploymentDrain $cliPath $BattyRoot
  }

  if (Test-Path $currentDir) {
    $current = Get-Item $currentDir
    if (-not ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to replace non-junction '$currentDir'."
    }
    $previousReleaseDir = $current.Target
  }

  if ((Get-Service -Name Batty).Status -ne "Stopped") {
    Stop-Service -Name Batty
    (Get-Service -Name Batty).WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
  }

  $activationStarted = $true
  $storageChanged = $true
  $metadataOutput = & (Get-Command node).Source $cliPath --root $BattyRoot normalize-session-metadata
  if ($LASTEXITCODE -ne 0) {
    throw "Session metadata normalization failed with exit code $LASTEXITCODE."
  }
  $metadataSummary = (($metadataOutput -join "`n") | ConvertFrom-Json)
  $convertedFiles = $metadataSummary.convertedFiles
  if (
    $null -eq $metadataSummary -or
    $null -eq $metadataSummary.PSObject.Properties["convertedFiles"] -or
    (($convertedFiles -isnot [int]) -and ($convertedFiles -isnot [long])) -or
    $convertedFiles -lt 0
  ) {
    throw "Session metadata normalization returned an invalid convertedFiles count."
  }
  $storageChanged = ($convertedFiles -gt 0)

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

  Wait-ForUrl "http://127.0.0.1:$BackendPort$backendPath/healthz"
  Wait-ForUrl "$($PublicOrigin.TrimEnd('/'))$backendPath/healthz"

  Write-Host "Activated Batty release $ReleaseName"
} catch {
  $deploymentError = $_
  if ($activationStarted -and $storageChanged) {
    try {
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
      Write-Warning "Deployment failed after session metadata changed; selected '$releaseDir' and left Batty stopped."
    } catch {
      throw "Deployment failed: $deploymentError Could not preserve prepared release '$releaseDir' with Batty stopped: $_"
    }
  } elseif ($activationStarted -and $previousReleaseDir) {
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
