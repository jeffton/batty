param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$ReleaseName,
  [string]$SiteName = "Default Web Site",
  [string]$AppPath = "batty",
  [string]$AppPoolName = "BattyProxy",
  [string]$PublicOrigin = "https://t14-dt-pc1028.cbrain.net",
  [string]$BaseUrl = "/batty",
  [int]$BackendPort = 3147,
  [int]$DelaySeconds = 20
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
  throw "ReleaseName is required."
}
if ($DelaySeconds -lt 0) {
  throw "DelaySeconds cannot be negative."
}

function Quote-Argument([string]$value) {
  if ($value.Contains('"')) {
    throw "Deployment arguments cannot contain quotation marks."
  }
  return "`"$value`""
}

$releaseDir = Join-Path (Join-Path $InstallRoot "releases") $ReleaseName
if (-not (Test-Path (Join-Path $releaseDir "dist\server\main.mjs"))) {
  throw "Staged release '$releaseDir' is incomplete."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$opsDir = Join-Path $InstallRoot "ops"
$logsDir = Join-Path $InstallRoot "deploy-logs"
New-Item -ItemType Directory -Force -Path $opsDir, $logsDir | Out-Null

$workerPath = Join-Path $opsDir "complete-deployment-windows.ps1"
Copy-Item -Force (Join-Path $scriptDir "complete-deployment-windows.ps1") $workerPath
Copy-Item -Force (Join-Path $scriptDir "configure-iis-app.ps1") (Join-Path $opsDir "configure-iis-app.ps1")

$requestId = [System.Guid]::NewGuid().ToString("N")
$logPath = Join-Path $logsDir "$requestId.log"
$powershell = Join-Path $PSHOME "powershell.exe"
$arguments = @(
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy Bypass",
  "-File $(Quote-Argument $workerPath)",
  "-InstallRoot $(Quote-Argument $InstallRoot)",
  "-ReleaseName $(Quote-Argument $ReleaseName)",
  "-SiteName $(Quote-Argument $SiteName)",
  "-AppPath $(Quote-Argument $AppPath)",
  "-AppPoolName $(Quote-Argument $AppPoolName)",
  "-PublicOrigin $(Quote-Argument $PublicOrigin)",
  "-BaseUrl $(Quote-Argument $BaseUrl)",
  "-BackendPort $BackendPort",
  "-DelaySeconds $DelaySeconds",
  "-LogPath $(Quote-Argument $logPath)"
)
$commandLine = "$(Quote-Argument $powershell) $($arguments -join ' ')"
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ($result.ReturnValue -ne 0) {
  throw "Could not hand off the deployment (Win32_Process.Create returned $($result.ReturnValue))."
}

Write-Host "Handed off deployment reload to process $($result.ProcessId)"
Write-Host "Deployment log: $logPath"
