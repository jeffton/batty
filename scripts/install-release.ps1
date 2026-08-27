param(
  [string]$InstallRoot = "D:\Batty\app",
  [string]$ReleaseName,
  [string]$BaseUrl = "/batty",
  [int]$BackendPort = 3147
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir

if ([string]::IsNullOrWhiteSpace($ReleaseName)) {
  $ReleaseName = (git -C $repoDir rev-parse --short HEAD).Trim()
}

function XmlEscape([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

$releasesDir = Join-Path $InstallRoot "releases"
$releaseDir = Join-Path $releasesDir $ReleaseName
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

$backendPath = $BaseUrl.TrimEnd("/")
if ($backendPath -eq "/") {
  $backendPath = ""
}
$proxyUrl = "http://127.0.0.1:$BackendPort$backendPath/{R:1}"
$webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Batty HTTPS reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <conditions>
            <add input="{HTTPS}" pattern="^on$" ignoreCase="true" />
          </conditions>
          <serverVariables>
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
          <action type="Rewrite" url="$(XmlEscape $proxyUrl)" />
        </rule>
        <rule name="Batty HTTP reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="http" />
          </serverVariables>
          <action type="Rewrite" url="$(XmlEscape $proxyUrl)" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
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
