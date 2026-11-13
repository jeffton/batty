$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "batty-deploy-$([guid]::NewGuid())"
New-Item -ItemType Directory (Join-Path $fixture 'scripts') | Out-Null
try {
    $script = Join-Path $fixture 'scripts\deploy-windows.ps1'
    Copy-Item (Join-Path $PSScriptRoot 'deploy-windows.ps1') $script
    $updated = @'
param([string]$AppRoot, [switch]$StageOnly)
if (-not $StageOnly -or $AppRoot -ne 'fixture-app') { throw 'Deployment parameters were lost' }
Set-Content (Join-Path $PSScriptRoot '..\result') 'updated deployment'
'@
    Set-Content (Join-Path $fixture 'updated.ps1') $updated
    function git {
        if (($args -join ' ') -ne 'pull --ff-only') { throw "Unexpected git command: $args" }
        Copy-Item (Join-Path $fixture 'updated.ps1') (Join-Path $fixture 'scripts\deploy-windows.ps1')
        $global:LASTEXITCODE = 0
    }
    & $script -AppRoot 'fixture-app' -StageOnly
    if ((Get-Content (Join-Path $fixture 'result') -Raw).Trim() -ne 'updated deployment') {
        throw 'Deployment continued with stale packaging logic'
    }
    Write-Output 'Windows deployment reload after pull passed'
} finally {
    Remove-Item Function:\git -ErrorAction SilentlyContinue
    Remove-Item $fixture -Recurse -Force
}
