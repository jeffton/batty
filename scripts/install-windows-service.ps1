param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$BattyRoot = "D:\Batty\root",
  [string]$NodePath = "",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 3147
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  throw "This script must run from an elevated PowerShell session."
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node).Source
}

function XmlEscape([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$winSwVersion = "2.12.0"
$winSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
$winSwUrl = "https://github.com/winsw/winsw/releases/download/v$winSwVersion/WinSW-x64.exe"
$opsDir = Join-Path $InstallRoot "ops"
$logsDir = Join-Path $InstallRoot "logs"
$serviceExe = Join-Path $opsDir "BattyService.exe"
$serviceConfig = Join-Path $opsDir "BattyService.xml"
$currentDir = Join-Path $InstallRoot "current"

New-Item -ItemType Directory -Force -Path $opsDir, $logsDir | Out-Null

if (-not (Test-Path $serviceExe)) {
  $downloadPath = "$serviceExe.download"
  Invoke-WebRequest -UseBasicParsing -Uri $winSwUrl -OutFile $downloadPath
  if ((Get-FileHash -Algorithm SHA256 $downloadPath).Hash -ne $winSwSha256) {
    Remove-Item -Force $downloadPath
    throw "WinSW download failed SHA-256 verification."
  }
  Move-Item -Force $downloadPath $serviceExe
}
if ((Get-FileHash -Algorithm SHA256 $serviceExe).Hash -ne $winSwSha256) {
  throw "WinSW at '$serviceExe' does not match the expected SHA-256."
}

$xml = @"
<service>
  <id>Batty</id>
  <name>Batty</name>
  <description>Batty coding agent server</description>
  <executable>$(XmlEscape $NodePath)</executable>
  <arguments>&quot;$(XmlEscape (Join-Path $currentDir "dist\server\main.mjs"))&quot; &quot;$(XmlEscape $BattyRoot)&quot;</arguments>
  <workingdirectory>$(XmlEscape $currentDir)</workingdirectory>
  <env name="BATTY_HOST" value="$(XmlEscape $BindHost)" />
  <env name="BATTY_PORT" value="$Port" />
  <env name="BATTY_SELF_PATH" value="$(XmlEscape $currentDir)" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(XmlEscape $logsDir)</logpath>
  <log mode="roll" />
</service>
"@
Set-Content -Path $serviceConfig -Value $xml -NoNewline

if (-not (Get-Service -Name Batty -ErrorAction SilentlyContinue)) {
  & $serviceExe install
  if ($LASTEXITCODE -ne 0) {
    throw "WinSW service installation failed with exit code $LASTEXITCODE."
  }
}

Write-Host "Configured the Batty Windows service."
