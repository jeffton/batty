param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$ReleaseName,
  [string]$BattyRoot = "D:\Batty\root",
  [string]$NodePath = "",
  [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir

if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
  $ReleaseName = (git -C $repoDir rev-parse --short HEAD).Trim()
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node).Source
}

function XmlEscape([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$releasesDir = Join-Path $InstallRoot "releases"
$releaseDir = Join-Path $releasesDir $ReleaseName
$currentDir = Join-Path $InstallRoot "current"
$tmpDir = Join-Path $InstallRoot (".release-{0}.{1}" -f $ReleaseName, [System.Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "logs") | Out-Null
if (Test-Path $tmpDir) {
  Remove-Item -Recurse -Force $tmpDir
}
New-Item -ItemType Directory -Force -Path (Join-Path $tmpDir "dist") | Out-Null

Copy-Item (Join-Path $repoDir "README.md") (Join-Path $tmpDir "README.md")
Copy-Item (Join-Path $repoDir "package.json") (Join-Path $tmpDir "package.json")
Copy-Item (Join-Path $repoDir "pnpm-lock.yaml") (Join-Path $tmpDir "pnpm-lock.yaml")
Copy-Item (Join-Path $repoDir "pnpm-workspace.yaml") (Join-Path $tmpDir "pnpm-workspace.yaml")
Copy-Item -Recurse (Join-Path $repoDir "patches") (Join-Path $tmpDir "patches")
Copy-Item -Recurse (Join-Path $repoDir "dist\client") (Join-Path $tmpDir "dist\client")
Copy-Item -Recurse (Join-Path $repoDir "dist\server") (Join-Path $tmpDir "dist\server")
New-Item -ItemType Directory -Force -Path (Join-Path $tmpDir "logs") | Out-Null

$startScript = @"
@echo off
setlocal
set BATTY_HOST=$BindHost
set BATTY_PORT=%ASPNETCORE_PORT%
set BATTY_SELF_PATH=$currentDir
"$NodePath" "$currentDir\dist\server\main.mjs" "$BattyRoot"
"@
Set-Content -Path (Join-Path $tmpDir "start-batty.cmd") -Value $startScript -NoNewline

$webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore
        processPath="$(XmlEscape (Join-Path $currentDir "start-batty.cmd"))"
        arguments=""
        stdoutLogEnabled="true"
        stdoutLogFile="$(XmlEscape (Join-Path $InstallRoot "logs\stdout"))"
        hostingModel="OutOfProcess"
        requestTimeout="01:00:00" />
    </system.webServer>
  </location>
</configuration>
"@
Set-Content -Path (Join-Path $tmpDir "web.config") -Value $webConfig -NoNewline

if (Test-Path $releaseDir) {
  Remove-Item -Recurse -Force $releaseDir
}
Move-Item $tmpDir $releaseDir

Push-Location $releaseDir
try {
  & (Get-Command corepack).Source pnpm install --prod --frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    throw "Production dependency installation failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

Write-Host "Staged Batty release at $releaseDir"
