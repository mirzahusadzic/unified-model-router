<#
.SYNOPSIS
Installs or updates the Unified Model Router on Windows.
.DESCRIPTION
Usually run through the cross-platform entry point, which also lists the
environment settings: node install.mjs --help
.PARAMETER Force
Merges into an unmanaged Codex configuration without asking. It is backed up first.
.PARAMETER NoService
Writes files only: does not start the router or restart the Codex daemon.
.PARAMETER ApiKeyFile
Reads the OpenRouter key from this file.
.PARAMETER ChangeApiKey
Asks for a new OpenRouter key and replaces the stored one.
.EXAMPLE
node install.mjs
.EXAMPLE
node install.mjs --change-api-key
.LINK
https://github.com/mirzahusadzic/unified-model-router/blob/main/docs/setup.md
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoService,
    [string]$ApiKeyFile,
    [switch]$ChangeApiKey
)

$ErrorActionPreference = 'Stop'

$PlatformDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent (Split-Path -Parent $PlatformDir)
. (Join-Path $PlatformDir 'private-path.ps1')
. (Join-Path $PlatformDir 'service-pids.ps1')
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $CodexHome "backups\codex-unified-router-$Stamp-$PID"
$RouterDir = Join-Path $CodexHome 'unified-router'
$RouterFile = Join-Path $RouterDir 'router.mjs'
$RouterEnv = Join-Path $RouterDir 'openrouter.env'
$RouterLog = Join-Path $RouterDir 'router.log'
$RouterErrorLog = Join-Path $RouterDir 'router.error.log'
$ExistingConfig = Join-Path $CodexHome 'config.toml'
$OpenRouterProfile = Join-Path $CodexHome 'unified-openrouter.config.toml'
$StartCmd = Join-Path $RouterDir 'start-router.cmd'
$StartupName = 'Codex Unified Router.vbs'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Fail-Install([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine("Error: $Message")
    exit $Code
}

if ($ApiKeyFile -and $ChangeApiKey) {
    Fail-Install "Use either -ApiKeyFile or -ChangeApiKey, not both.`nRun 'node install.mjs --help' for usage." 2
}

foreach ($Setting in @('CODEX_ROUTER_RESTART_DAEMON', 'CODEX_ROUTER_PIN_DAEMON')) {
    $Value = [Environment]::GetEnvironmentVariable($Setting)
    if ($Value -and $Value -notin @('0', '1')) {
        Fail-Install "$Setting must be 0 or 1" 2
    }
}
$NativeModels = if ($env:CODEX_ROUTER_NATIVE_MODELS) { $env:CODEX_ROUTER_NATIVE_MODELS } else { 'auto' }
if ($NativeModels -notin @('auto', 'show', 'hide')) {
    Fail-Install 'CODEX_ROUTER_NATIVE_MODELS must be auto, show, or hide' 2
}
# merge-config.mjs applies these; checking them here fails before any prompt.
foreach ($Setting in @('CODEX_ROUTER_DISABLE_APPS', 'CODEX_ROUTER_DISABLE_GUARDIAN', 'CODEX_ROUTER_DISABLE_ANALYTICS', 'CODEX_ROUTER_SANDBOX_NETWORK')) {
    $Value = [Environment]::GetEnvironmentVariable($Setting)
    if ($null -ne $Value -and $Value -notin @('0', '1')) { Fail-Install "$Setting must be 0 or 1" 2 }
}
$AgentThreads = $env:CODEX_ROUTER_AGENT_THREADS
if ($null -ne $AgentThreads -and $AgentThreads -cnotmatch '^(0|[1-9][0-9]{0,2})$') {
    Fail-Install 'CODEX_ROUTER_AGENT_THREADS must be 0 or a whole number from 1 to 999' 2
}

foreach ($CommandName in @('codex', 'node')) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        Fail-Install "Required command not found: $CommandName"
    }
}

# Merging into a configuration the router does not manage yet needs consent:
# a yes at the prompt, or -Force where no terminal is available. Only a real
# marker line counts as managed, never one inside a TOML string or comment.
$ConfigManaged = Join-Path $RepoDir 'scripts\config-managed.mjs'
$Unmanaged = @()
foreach ($ConfigFile in @($ExistingConfig, $OpenRouterProfile)) {
    if (Test-Path -LiteralPath $ConfigFile) {
        & node $ConfigManaged $ConfigFile
        if ($LASTEXITCODE -ne 0) { $Unmanaged += $ConfigFile }
    }
}
if (-not $Force -and $Unmanaged.Count -gt 0) {
    if ([Console]::IsInputRedirected) {
        Fail-Install "Existing Codex configuration found: $($Unmanaged -join ', '). Run the installer in a terminal to confirm merging into it, or pass -Force. The files are backed up first." 2
    }
    Write-Host 'Existing Codex configuration found:'
    $Unmanaged | ForEach-Object { Write-Host "  $_" }
    Write-Host 'The installer backs these files up, then adds its settings and keeps everything else.'
    $Answer = Read-Host 'Merge into them? [y/N]'
    if ($Answer -notmatch '^(?i)(y|yes)$') { Fail-Install 'Nothing was changed.' 2 }
    $Force = [switch]$true
}

# The OpenRouter key comes from -ApiKeyFile, OPENROUTER_API_KEY, or the stored
# key; otherwise ask for it without echoing. It never appears in a command
# line, where other processes could read it.
$PromptedKey = $null
if ($ApiKeyFile -and -not (Test-Path -LiteralPath $ApiKeyFile -PathType Leaf)) {
    Fail-Install "API key file not found: $ApiKeyFile" 2
}
# -ChangeApiKey asks for a new key even when one is stored or set.
if ($ChangeApiKey -or (-not $ApiKeyFile -and [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY) -and -not (Test-Path $RouterEnv))) {
    if ([Console]::IsInputRedirected) {
        Fail-Install 'No terminal to ask for the OpenRouter API key. Run the installer in a terminal, or pass -ApiKeyFile <path>.'
    }
    Write-Host 'Enter your OpenRouter API key (create one at https://openrouter.ai/keys).'
    Write-Host 'Typing is hidden: paste the key and press Enter.'
    $SecureKey = Read-Host 'OpenRouter API key' -AsSecureString
    $KeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
    try { $PromptedKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($KeyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($KeyPointer) }
    if ([string]::IsNullOrWhiteSpace($PromptedKey)) { Fail-Install 'No OpenRouter API key entered.' }
}

function Write-Step([string]$Message) { [Console]::Error.WriteLine("==> $Message") }

Write-Step "Installing the Unified Model Router into $CodexHome"
if ($PromptedKey) { Write-Step 'Using the OpenRouter API key you entered' }
elseif ($ApiKeyFile) { Write-Step "Reading the OpenRouter API key from $ApiKeyFile" }
elseif (-not [string]::IsNullOrWhiteSpace($env:OPENROUTER_API_KEY)) { Write-Step 'Using the OpenRouter API key from OPENROUTER_API_KEY' }
else { Write-Step 'Using the stored OpenRouter API key' }

Write-Step "Backing up the current configuration to $BackupDir"
New-Item -ItemType Directory -Force -Path $CodexHome, $BackupDir, $RouterDir | Out-Null
Set-PrivatePath $BackupDir
Set-PrivatePath $RouterDir
foreach ($SensitiveFile in @($ExistingConfig, $OpenRouterProfile, $RouterEnv)) {
    if (Test-Path -LiteralPath $SensitiveFile) { Set-PrivatePath $SensitiveFile }
}
foreach ($Name in @('config.toml', 'deepseek.config.toml', 'unified-openrouter.config.toml', 'models.json')) {
    $ExistingFile = Join-Path $CodexHome $Name
    if (Test-Path $ExistingFile) {
        Copy-Item -Force $ExistingFile (Join-Path $BackupDir $Name)
    }
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-unified-router-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
Set-PrivatePath $TempDir

try {
    Write-Step 'Building the model catalog'
    $BundledFile = Join-Path $TempDir 'bundled-models.json'
    $BundledText = (& codex debug models --bundled) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($BundledText)) {
        throw 'Could not read the Codex bundled model catalog.'
    }
    [System.IO.File]::WriteAllText($BundledFile, $BundledText + "`n", $Utf8NoBom)

    # Native OpenAI models need a ChatGPT plan. In auto mode, hide them from /model
    # only when Codex's login shows a missing or lapsed plan.
    $NativeReason = 'CODEX_ROUTER_NATIVE_MODELS=hide'
    if ($NativeModels -eq 'auto') {
        $PlanStatus = & node (Join-Path $RepoDir 'scripts\chatgpt-plan.mjs') $CodexHome
        $NativeModels = if ($PlanStatus -eq 'inactive') { 'hide' } else { 'show' }
        if ($NativeModels -eq 'hide') { $NativeReason = 'no active ChatGPT plan' }
    }

    $ModelsFile = Join-Path $TempDir 'models.json'
    & node (Join-Path $RepoDir 'scripts\build-catalog.mjs') `
        '--bundled' $BundledFile `
        '--catalog-dir' (Join-Path $RepoDir 'catalog') `
        '--instructions' (Join-Path $RepoDir 'prompts\openrouter-instructions.md') `
        '--persistent' (Join-Path $RepoDir 'prompts\openrouter-persistent.md') `
        '--native-models' $NativeModels `
        '--output' $ModelsFile
    if ($LASTEXITCODE -ne 0) { throw 'Catalog merge failed.' }
    if ($NativeModels -eq 'hide') { Write-Step "Hiding native OpenAI models from /model ($NativeReason)" }

    Write-Step 'Updating the Codex configuration'
    $ConfigOut = Join-Path $TempDir 'config.toml'
    $PrepareCredentials = Join-Path $RepoDir 'scripts\prepare-credentials.mjs'
    # Credentials are prepared with the other generated files and installed with
    # them, so a failed merge leaves the stored ones untouched.
    $StagedEnv = Join-Path $TempDir 'openrouter.env'
    if (Test-Path -LiteralPath $RouterEnv) { Copy-Item -LiteralPath $RouterEnv $StagedEnv }
    if ($PromptedKey) {
        $PromptedKey | & node $PrepareCredentials $StagedEnv --api-key-stdin
        $PromptedKey = $null
    } elseif ($ApiKeyFile) {
        & node $PrepareCredentials $StagedEnv --api-key-file $ApiKeyFile
    } else {
        & node $PrepareCredentials $StagedEnv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Router credential setup failed.' }
    $OpenRouterOut = Join-Path $TempDir 'unified-openrouter.config.toml'
    $MergeFlags = @()
    if ($Force) { $MergeFlags += '--force' }
    & node (Join-Path $RepoDir 'scripts\merge-config.mjs') $ExistingConfig $CodexHome $ConfigOut $StagedEnv $OpenRouterOut @MergeFlags
    if ($LASTEXITCODE -ne 0) { throw 'Codex config merge failed.' }

    & node (Join-Path $RepoDir 'scripts\verify-catalog.mjs') $ModelsFile
    if ($LASTEXITCODE -ne 0) { throw 'The generated model catalog does not match the repository.' }

    if (-not (Test-Path -LiteralPath $RouterEnv)) {
        [System.IO.File]::WriteAllText($RouterEnv, '', $Utf8NoBom)
    }
    Set-PrivatePath $RouterEnv
    [System.IO.File]::WriteAllText($RouterEnv, [System.IO.File]::ReadAllText($StagedEnv, $Utf8NoBom), $Utf8NoBom)
    if (-not (Test-Path -LiteralPath $ExistingConfig)) {
        [System.IO.File]::WriteAllText($ExistingConfig, '', $Utf8NoBom)
    }
    Set-PrivatePath $ExistingConfig
    [System.IO.File]::WriteAllText($ExistingConfig, [System.IO.File]::ReadAllText($ConfigOut, $Utf8NoBom), $Utf8NoBom)
    if (-not (Test-Path -LiteralPath $OpenRouterProfile)) {
        [System.IO.File]::WriteAllText($OpenRouterProfile, '', $Utf8NoBom)
    }
    Set-PrivatePath $OpenRouterProfile
    [System.IO.File]::WriteAllText($OpenRouterProfile, [System.IO.File]::ReadAllText($OpenRouterOut, $Utf8NoBom), $Utf8NoBom)
    Write-Step 'Installing the loopback router at 127.0.0.1:18766'
    Copy-Item -Force $ModelsFile (Join-Path $CodexHome 'models.json')
    # The router's modules sit beside its entry file, which is installed as router.mjs.
    # A module this version no longer has is removed, since the revision covers every one.
    Get-ChildItem -LiteralPath $RouterDir -Filter '*.mjs' |
        Where-Object { $_.Name -ne 'router.mjs' -and ($_.Name -eq 'unified-router.mjs' -or -not (Test-Path -LiteralPath (Join-Path $RepoDir "router\$($_.Name)"))) } |
        ForEach-Object { Remove-Item -Force -LiteralPath $_.FullName }
    Get-ChildItem -LiteralPath (Join-Path $RepoDir 'router') -Filter '*.mjs' |
        Where-Object { $_.Name -ne 'unified-router.mjs' } |
        ForEach-Object { Copy-Item -Force $_.FullName (Join-Path $RouterDir $_.Name) }
    Copy-Item -Force (Join-Path $RepoDir 'router\unified-router.mjs') $RouterFile

    $LegacyProfile = Join-Path $CodexHome 'deepseek.config.toml'
    if (Test-Path $LegacyProfile) {
        Move-Item -Force $LegacyProfile (Join-Path $BackupDir 'deepseek.config.toml.retired')
    }

    if (-not $NoService) {
        $NodeExe = (Get-Command node).Source
        $CatalogPath = Join-Path $CodexHome 'models.json'
        # Percent signs expand when the batch file runs. File names cannot
        # contain a quote, so percent is the only path character needing escape.
        $CmdRouterEnv = $RouterEnv.Replace('%', '%%')
        $CmdCatalogPath = $CatalogPath.Replace('%', '%%')
        $CmdNodeExe = $NodeExe.Replace('%', '%%')
        $CmdRouterFile = $RouterFile.Replace('%', '%%')
        $CmdRouterLog = $RouterLog.Replace('%', '%%')
        $CmdRouterErrorLog = $RouterErrorLog.Replace('%', '%%')
        $CmdContent = @"
@echo off
chcp 65001 >nul
set "CODEX_ROUTER_ENV_FILE=$CmdRouterEnv"
set "CODEX_MODEL_CATALOG=$CmdCatalogPath"
set "CODEX_ROUTER_PORT=18766"
:run
"$CmdNodeExe" "$CmdRouterFile" >> "$CmdRouterLog" 2>> "$CmdRouterErrorLog"
if not errorlevel 1 goto :eof
ping -n 3 127.0.0.1 >nul
goto run
"@
        $CmdContent = $CmdContent -replace "`r?`n", "`r`n"
        [System.IO.File]::WriteAllText($StartCmd, $CmdContent, $Utf8NoBom)

        $StartupDir = [Environment]::GetFolderPath('Startup')
        New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
        $StartupScript = Join-Path $StartupDir $StartupName
        $EscapedStartCmd = $StartCmd.Replace('"', '""')
        $VbsContent = 'Set shell = CreateObject("WScript.Shell")' + "`r`n" +
            'shell.Run Chr(34) & "' + $EscapedStartCmd + '" & Chr(34), 0, False' + "`r`n"
        [System.IO.File]::WriteAllText($StartupScript, $VbsContent, $Utf8NoBom)

        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            if ($_.ProcessId -eq $PID -or -not $_.CommandLine) { return $false }
            $CommandLine = $_.CommandLine
            $Router = $CommandLine.IndexOf($RouterFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $CommandLine -match '(?i)(^|[\\/"])node(\.exe)?([" ]|$)'
            $Supervisor = $CommandLine.IndexOf($StartCmd, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $CommandLine -match '(?i)(cmd\.exe|wscript\.exe|start-router\.cmd)'
            $Startup = $CommandLine.IndexOf($StartupScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                $CommandLine -match '(?i)wscript\.exe'
            $Router -or $Supervisor -or $Startup
        } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList "`"$StartupScript`""

        Write-Step 'Starting the router and checking its health'
        $Healthy = $false
        for ($Attempt = 0; $Attempt -lt 25; $Attempt += 1) {
            try {
                # The router answering must be the supervisor's, not a stray copy.
                $ServicePids = Get-RouterServicePids -StartCmd $StartCmd
                & node (Join-Path $RepoDir 'scripts\verify-health.mjs') $RouterFile 'http://127.0.0.1:18766/health' "--service-pid=$ServicePids" 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $Healthy = $true
                    break
                }
            } catch {
            }
            Start-Sleep -Milliseconds 200
        }
        if (-not $Healthy) {
            throw "The Unified Model Router was installed but did not become healthy. Check $RouterErrorLog."
        }

        # Restart the shared app-server daemon so it loads the new
        # configuration, and pin it to the CLI's Codex; codex-daemon.mjs
        # explains when it skips either.
        $RunByDaemon = $false
        $Ancestor = $PID
        for ($Depth = 0; $Depth -lt 64 -and $Ancestor; $Depth += 1) {
            $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$Ancestor" -ErrorAction SilentlyContinue
            if (-not $Process) { break }
            if ($Process.CommandLine -and $Process.CommandLine -match '(?i)(^|[\\/"])codex(\.exe)?"?\s+app-server(\s|$)') { $RunByDaemon = $true; break }
            if ($Process.ParentProcessId -eq $Ancestor) { break }
            $Ancestor = $Process.ParentProcessId
        }
        $DaemonArgs = @((Join-Path $RepoDir 'scripts\codex-daemon.mjs'), $CodexHome)
        if ($RunByDaemon) { $DaemonArgs += '--codex-runs-installer' }
        & node @DaemonArgs
    }
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Installed the Unified Model Router in $CodexHome"
Write-Host "Backups: $BackupDir"
Write-Host @'

Start Codex with a model, or switch with /model:
  DeepSeek V4.1 Flash 1017 (default)
    codex
  Ultra Spark: DeepSeek delegating to non-training Muse workers
    codex -m ultra-spark-private/deepseek-v4.1-flash-1017
  Ultra Spark Contributor: DeepSeek delegating to Muse Contributor workers
    codex -m ultra-spark/deepseek-v4.1-flash-1017
  Muse Spark 1.3
    codex -m openrouter/meta/muse-spark-1.3
  Muse Spark 1.3 Contributor
    codex -m openrouter/meta/muse-spark-1.3-contributor
  GPT-6.1 Sol (OpenRouter)
    codex -m openrouter/openai/gpt-6.1-sol
  Claude Sonnet 5.5
    codex -m anthropic/claude-sonnet-5-5
  Claude Opus 5.5
    codex -m anthropic/claude-opus-5-5
'@
if ($NativeModels -eq 'show') {
    Write-Host "  GPT-6 Astra (requires a ChatGPT plan)`n    codex -m gpt-6-astra"
}
Write-Host @'

Meta trains on everything sent to Muse Spark 1.3 Contributor, including
Ultra Spark Contributor's workers, so use them for share-safe code only.
'@
if ($NativeModels -eq 'hide') {
    Write-Host "Native OpenAI models are hidden from /model ($NativeReason)."
}
# Hidden native models stay usable by name, so the warning covers them too.
Write-Host @'
Tracked Codex sessions never mix OpenAI, Claude, or non-training
Ultra Spark models with Muse Spark 1.3 Contributor or Ultra Spark
Contributor.
'@
Write-Host 'Restart Codex windows opened before this install to pick up the changes.'
