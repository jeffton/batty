[CmdletBinding()]
param(
    [string]$AppRoot = 'D:\Batty\app',
    [string]$ServiceName = 'Batty',
    [string]$AppPoolName = 'BattyProxy',
    [string]$ServiceXml = 'D:\Batty\app\ops\BattyService.xml',
    [string]$IisUrl = 'http://localhost/batty/',
    [string]$ReleasePath,
    [switch]$StageOnly,
    [switch]$AllowDirty
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}

function Copy-Tree([string]$Source, [string]$Destination, [string[]]$Extra = @()) {
    & robocopy.exe $Source $Destination /E /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS @Extra
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
}

function Set-Current([string]$Target) {
    $current = Join-Path $AppRoot 'current'
    if (Test-Path $current) {
        $item = Get-Item $current
        if ($item.LinkType -ne 'Junction') { throw "$current must be a junction" }
        # Remove the junction itself, never its release contents.
        [System.IO.Directory]::Delete($current)
    }
    New-Item -ItemType Junction -Path $current -Target $Target | Out-Null
}

if (-not $ReleasePath) {
    Push-Location $repo
    try {
        Invoke-Native git @('pull', '--ff-only')
        if (-not $AllowDirty -and (git status --porcelain)) { throw 'Commit changes before deploying, or explicitly use -AllowDirty.' }
        & (Join-Path $PSScriptRoot 'setup-chrome.ps1')
        $revision = (git rev-parse --short HEAD).Trim()
        $buildId = "$revision-windows-$(Get-Date -Format yyyyMMddHHmmss)"
        Invoke-Native pnpm @('install', '--frozen-lockfile')
        $oldBuildId = $env:BATTY_BUILD_ID
        try {
            $env:BATTY_BUILD_ID = $buildId
            Invoke-Native pnpm @('build')
        } finally { $env:BATTY_BUILD_ID = $oldBuildId }
        $ReleasePath = Join-Path $AppRoot "releases\batty2-$buildId"
        New-Item -ItemType Directory $ReleasePath | Out-Null
        Copy-Tree (Join-Path $repo 'dist') (Join-Path $ReleasePath 'dist')
        foreach ($name in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md')) {
            Copy-Item (Join-Path $repo $name) $ReleasePath
        }
        # Open clients can still request immutable chunks from the previous release.
        $previousAssets = Join-Path $AppRoot 'current\dist\client\assets'
        if (Test-Path $previousAssets) {
            & robocopy.exe $previousAssets (Join-Path $ReleasePath 'dist\client\assets') /E /XC /XN /XO /R:2 /W:1 /NFL /NDL /NJH /NJS
            if ($LASTEXITCODE -ge 8) { throw 'Copying retained client assets failed' }
        }
        Set-Content (Join-Path $ReleasePath 'BUILD_ID') $buildId -Encoding utf8
        Push-Location $ReleasePath
        # Release dependencies are read-only; hardlinking avoids Windows' slower clone-first import.
        try { Invoke-Native pnpm @('install', '--prod', '--frozen-lockfile', '--config.package-import-method=hardlink') } finally { Pop-Location }
    } finally { Pop-Location }
}
$ReleasePath = (Resolve-Path $ReleasePath).Path
foreach ($entry in @('main', 'cron-cli', 'stop-service')) {
    if (-not (Test-Path (Join-Path $ReleasePath "dist\server\$entry.mjs"))) { throw "Release entry is missing: $entry" }
}
if (-not (Test-Path (Join-Path $ReleasePath 'BUILD_ID'))) { throw 'Release BUILD_ID is missing' }
if ($StageOnly) {
    Write-Output "STAGED_RELEASE=$ReleasePath"
    exit 0
}

# Run activation through Task Scheduler, outside WinSW's process tree, if deploying from Batty.
Import-Module WebAdministration
$previousRelease = (Get-Item (Join-Path $AppRoot 'current')).Target
[xml]$service = [System.IO.File]::ReadAllText($ServiceXml)
$port = ($service.service.env | Where-Object name -eq 'BATTY_PORT').value
$web = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\deploy\web.config'))
[System.IO.File]::WriteAllText((Join-Path $ReleasePath 'web.config'), $web.Replace('3148', $port))
$stopped = $false
$committed = $false
try {
    Stop-Service $ServiceName
    $stopped = $true
    (Get-Service $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
    Set-Current $ReleasePath
    # IIS caches web.config across junction swaps; reload the release's rewrite rules.
    Restart-WebAppPool -Name $AppPoolName
    Start-Service $ServiceName
    $expectedBuild = (Get-Content (Join-Path $ReleasePath 'BUILD_ID') -Raw).Trim()
    $healthy = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 2
            if ($health.ok -and $health.buildId -eq $expectedBuild) { $healthy = $true; break }
        } catch { Write-Verbose $_ }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Release failed its health/build-ID gate' }
    $publicBase = [uri]($IisUrl.TrimEnd('/') + '/')
    $iisHealth = Invoke-RestMethod ([uri]::new($publicBase, 'healthz')) -TimeoutSec 10
    if (-not $iisHealth.ok -or $iisHealth.buildId -ne $expectedBuild) { throw 'IIS failed its health/build-ID gate' }
    $shell = Invoke-WebRequest $publicBase -UseBasicParsing -TimeoutSec 10
    if (-not $shell.Content.Contains('<base href="' + $publicBase.AbsolutePath + '">')) { throw 'IIS app-shell base path is incorrect' }
    $asset = [regex]::Match($shell.Content, '<script[^>]+src="([^"]+\.js)"')
    if (-not $asset.Success) { throw 'IIS app-shell script is missing' }
    $script = Invoke-WebRequest ([uri]::new($publicBase, $asset.Groups[1].Value)) -UseBasicParsing -TimeoutSec 10
    if ($script.Headers['Content-Type'] -notmatch 'javascript') { throw 'IIS app-shell script did not return JavaScript' }
    $manifest = Invoke-RestMethod ([uri]::new($publicBase, 'manifest.webmanifest')) -TimeoutSec 10
    if ($manifest.start_url -ne $publicBase.AbsolutePath -or $manifest.scope -ne $publicBase.AbsolutePath) { throw 'IIS manifest base path is incorrect' }
    Write-Output "VERIFIED_BACKEND_AND_IIS=$expectedBuild"
    Set-Content (Join-Path $ReleasePath 'HEALTHY') (Get-Date -Format o)
    $committed = $true
    Write-Output "DEPLOYED_RELEASE=$ReleasePath"
} catch {
    $failure = $_
    if ($stopped -and -not $committed) {
        Stop-Service $ServiceName -ErrorAction SilentlyContinue
        Set-Current $previousRelease
        Restart-WebAppPool -Name $AppPoolName
        Start-Service $ServiceName
    }
    throw $failure
}
