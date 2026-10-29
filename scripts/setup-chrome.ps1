[CmdletBinding()]
param([switch]$Update)
$ErrorActionPreference = 'Stop'
$paths = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
    Where-Object { $_ } |
    ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe' }
$installed = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $installed -or $Update) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Install Google Chrome Stable and enable Google Updater, or install winget to use this helper.'
    }
    if ($installed) {
        & winget.exe upgrade --id Google.Chrome --exact --accept-source-agreements --accept-package-agreements
        # winget returns this status when no applicable update exists.
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "Chrome update failed: $LASTEXITCODE" }
    } else {
        & winget.exe install --id Google.Chrome --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw "Chrome installation failed: $LASTEXITCODE" }
    }
}
$installed = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $installed) { throw 'Chrome installer did not create a supported installation.' }
Write-Output "Chrome $((Get-Item $installed).VersionInfo.ProductVersion): $installed"
