<#
.SYNOPSIS
Verifies a Unified Model Router installation on Windows.
.DESCRIPTION
Usually run through the cross-platform entry point: node install.mjs --verify
.PARAMETER NoService
Skips the router service checks, for installations made with -NoService.
.EXAMPLE
node install.mjs --verify
.LINK
https://github.com/mirzahusadzic/unified-model-router/blob/main/docs/setup.md
#>
[CmdletBinding()]
param(
    [switch]$NoService
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'private-path.ps1')
. (Join-Path $PSScriptRoot 'service-pids.ps1')
$ScriptsDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts'

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$ConfigPath = Join-Path $CodexHome 'config.toml'
$ProfilePath = Join-Path $CodexHome 'unified-openrouter.config.toml'
$ModelsPath = Join-Path $CodexHome 'models.json'
$RouterPath = Join-Path $CodexHome 'unified-router\router.mjs'
$StartCmd = Join-Path $CodexHome 'unified-router\start-router.cmd'
$StartupScript = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$RequiredPaths = @($ConfigPath, $ProfilePath, $ModelsPath, $RouterPath)
if (-not $NoService) {
    $RequiredPaths += @($StartCmd, $StartupScript)
}

foreach ($Path in $RequiredPaths) {
    if (-not (Test-Path $Path)) { throw "Missing required file: $Path" }
}

& node (Join-Path $ScriptsDir 'verify-credentials.mjs') $CodexHome
if ($LASTEXITCODE -ne 0) { throw 'Router credential verification failed.' }
& node (Join-Path $ScriptsDir 'verify-router.mjs') $CodexHome
if ($LASTEXITCODE -ne 0) { throw 'The installed router differs from this repository; rerun the installer.' }
foreach ($Path in @($ConfigPath, $ProfilePath, (Join-Path $CodexHome 'unified-router'), (Join-Path $CodexHome 'unified-router\openrouter.env'))) {
    Assert-PrivatePath $Path
}

$Config = [System.IO.File]::ReadAllText($ConfigPath, $Utf8NoBom)
foreach ($Expected in @(
    '# BEGIN codex-unified-router managed keys',
    'model_provider = "unified"',
    '[model_providers.unified]',
    'requires_openai_auth = true',
    'supports_websockets = false'
)) {
    if (-not $Config.Contains($Expected)) { throw "Config is missing: $Expected" }
}

& node (Join-Path $ScriptsDir 'verify-catalog.mjs') $ModelsPath
if ($LASTEXITCODE -ne 0) { throw 'The installed model catalog does not match the repository.' }

if (-not $NoService) {
    $ServicePids = Get-RouterServicePids -StartCmd $StartCmd
    & node (Join-Path $ScriptsDir 'verify-health.mjs') $RouterPath 'http://127.0.0.1:18766/health' "--service-pid=$ServicePids"
    if ($LASTEXITCODE -ne 0) {
        throw 'The Unified Model Router health check failed.'
    }
    & node (Join-Path $ScriptsDir 'codex-daemon.mjs') --verify $CodexHome
    if ($LASTEXITCODE -ne 0) { throw 'The Codex app-server daemon is not pinned to the CLI.' }
}

Write-Host 'Install looks valid.'
$DefaultModel = (Select-String -Path $ConfigPath -Pattern '^model = "(.*)"$' | Select-Object -First 1).Matches.Groups[1].Value
Write-Host "Default main model: $DefaultModel"
& node (Join-Path $ScriptsDir 'verify-catalog.mjs') --report $ModelsPath
