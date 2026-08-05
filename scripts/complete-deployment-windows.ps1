param(
  [string]$InstallRoot,
  [string]$ReleaseName,
  [string]$SiteName,
  [string]$AppPath,
  [int]$DelaySeconds = 20,
  [string]$LogPath,
  [switch]$ConfigureIis
)

$ErrorActionPreference = "Stop"
Start-Transcript -Path $LogPath -Append | Out-Null

try {
  Start-Sleep -Seconds $DelaySeconds

  $releaseDir = Join-Path (Join-Path $InstallRoot "releases") $ReleaseName
  if (-not (Test-Path (Join-Path $releaseDir "dist\server\main.mjs"))) {
    throw "Staged release '$releaseDir' is incomplete."
  }

  $currentDir = Join-Path $InstallRoot "current"
  if (Test-Path $currentDir) {
    $current = Get-Item $currentDir
    if (-not ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to replace non-junction '$currentDir'."
    }
    cmd /d /c rmdir "$currentDir" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not remove current junction (exit code $LASTEXITCODE)."
    }
  }
  New-Item -ItemType Junction -Path $currentDir -Target $releaseDir | Out-Null

  if ($ConfigureIis) {
    & (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "configure-iis-app.ps1") `
      -SiteName $SiteName `
      -AppPath $AppPath `
      -PhysicalPath $currentDir
  }

  Write-Host "Activated Batty release $ReleaseName"
} finally {
  Stop-Transcript | Out-Null
}
