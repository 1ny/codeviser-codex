param(
    [string]$CvdRoot,
    [Alias('MasterConfig')][string]$MasterConfigPath,
    [string]$AutoStartScript
)

$ErrorActionPreference = 'Stop'
$packageRoot = $PSScriptRoot
$installRoot = $packageRoot
$errorLog = Join-Path $packageRoot 'install-error.log'

function Convert-ToAscii([string]$text) {
    return [Text.Encoding]::ASCII.GetString([Text.Encoding]::ASCII.GetBytes($text))
}

trap {
    $details = Convert-ToAscii (($_ | Out-String).Trim())
    Set-Content -LiteralPath $errorLog -Value $details -Encoding Ascii
    Write-Host ''
    Write-Host '[INSTALL ERROR]' -ForegroundColor Red
    Write-Host $details
    Write-Host "Log: $errorLog" -ForegroundColor Yellow
    Read-Host 'Press Enter to close'
    exit 1
}

function Find-Codex {
    $command = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    if ($command) { return $command }
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $binRoot) {
        return Get-ChildItem -LiteralPath $binRoot -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    return $null
}

function Invoke-CodexCapture([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $codex @Arguments 2>&1
        return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Convert-ToTomlLiteral([string]$value) {
    return "'" + $value.Replace("'", "''") + "'"
}

function Set-CodexMcpConfig {
    param(
        [string]$ConfigPath,
        [string]$Command,
        [string[]]$Arguments,
        [hashtable]$Environment
    )
    $configDirectory = Split-Path -Parent $ConfigPath
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
    $content = if (Test-Path -LiteralPath $ConfigPath) { Get-Content -LiteralPath $ConfigPath -Raw } else { '' }
    $sectionPattern = '(?ms)^\[mcp_servers\.(?:codeviser_cvd|codeviser)(?:\.env)?\]\r?\n.*?(?=^\[|\z)'
    $content = [regex]::Replace($content, $sectionPattern, '').TrimEnd()
    $argumentText = ($Arguments | ForEach-Object { Convert-ToTomlLiteral $_ }) -join ', '
    $lines = @(
        '',
        '',
        '[mcp_servers.codeviser]',
        "command = $(Convert-ToTomlLiteral $Command)",
        "args = [$argumentText]",
        'startup_timeout_sec = 30.0',
        '',
        '[mcp_servers.codeviser.env]'
    )
    foreach ($name in ($Environment.Keys | Sort-Object)) {
        $lines += "$name = $(Convert-ToTomlLiteral ([string]$Environment[$name]))"
    }
    Set-Content -LiteralPath $ConfigPath -Value ($content + ($lines -join "`r`n") + "`r`n") -Encoding UTF8
}

if (-not $CvdRoot) {
    $knownRoots = @('C:\JnDTech\CVI\CVD', 'C:\Program Files\JnDTech\CVI\CVD', 'C:\Program Files (x86)\JnDTech\CVI\CVD')
    $CvdRoot = $knownRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'API\BinR\CVDAPI.dll') } | Select-Object -First 1
}
if (-not $CvdRoot) { throw 'CodeViser CVD was not found. Specify -CvdRoot "C:\path\to\CVD".' }

$cvdExe = Join-Path $CvdRoot 'Bin\CVD.exe'
$apiDir = Join-Path $CvdRoot 'API\BinR'
$hotkeyFile = Join-Path $CvdRoot 'Script\cvd_hotkey.xml'
$codex = Find-Codex
if (-not (Test-Path -LiteralPath $cvdExe)) { throw "CVD.exe was not found: $cvdExe" }
if (-not (Test-Path -LiteralPath (Join-Path $apiDir 'CVDAPI.dll'))) { throw "CVDAPI.dll was not found: $apiDir" }
if (-not $codex) { throw 'Codex CLI was not found. Install and start Codex Desktop once, then retry.' }

if (-not $MasterConfigPath) { $MasterConfigPath = Join-Path $packageRoot 'config\master.csf' }
if (-not (Test-Path -LiteralPath $MasterConfigPath)) { throw "Master config was not found: $MasterConfigPath" }
$deployedMasterConfig = (Resolve-Path -LiteralPath $MasterConfigPath).Path

if (-not $AutoStartScript) {
    $autoStartCandidates = @(
        'C:\CVD\autostart.cmm',
        (Join-Path $CvdRoot 'autostart.cmm'),
        (Join-Path $packageRoot 'autostart.cmm')
    )
    $AutoStartScript = $autoStartCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if ($AutoStartScript) {
    if (-not (Test-Path -LiteralPath $AutoStartScript -PathType Leaf)) { throw "Auto-start CMM was not found: $AutoStartScript" }
    $AutoStartScript = (Resolve-Path -LiteralPath $AutoStartScript).Path
}

$removeOldResult = Invoke-CodexCapture @('mcp', 'remove', 'codeviser_cvd')
$removeResult = Invoke-CodexCapture @('mcp', 'remove', 'codeviser')
$mcpArgs = @(
    'mcp', 'add', 'codeviser',
    '--env', "CVD_API_DIR=$apiDir",
    '--env', 'CVD_HOST=127.0.0.1',
    '--env', 'CVD_MULTI_PORT=8888',
    '--env', 'CVD_MASTER_PORT=20000',
    '--env', "CVD_HOTKEY_FILE=$hotkeyFile",
    '--env', "CVD_STATUS_LOG=$(Join-Path $installRoot 'status.log')",
    '--env', 'CVD_POWERSHELL32=C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe',
    '--', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $installRoot 'mcp\run-server.ps1')
)
$addResult = Invoke-CodexCapture $mcpArgs
if ($addResult.ExitCode -ne 0) {
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    if (-not $userProfile) {
        throw "Codex MCP registration failed and the user profile could not be located.`n$(Convert-ToAscii ($addResult.Output | Out-String))"
    }
    $configPath = Join-Path $userProfile '.codex\config.toml'
    $serverArguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $installRoot 'mcp\run-server.ps1')
    )
    $serverEnvironment = @{
        CVD_API_DIR = $apiDir
        CVD_HOST = '127.0.0.1'
        CVD_MULTI_PORT = '8888'
        CVD_MASTER_PORT = '20000'
        CVD_HOTKEY_FILE = $hotkeyFile
        CVD_STATUS_LOG = (Join-Path $installRoot 'status.log')
        CVD_POWERSHELL32 = 'C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
    }
    Set-CodexMcpConfig -ConfigPath $configPath -Command 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Arguments $serverArguments -Environment $serverEnvironment
    Write-Host 'Codex CLI registration was unavailable; config.toml was updated directly.' -ForegroundColor Yellow
}
else {
    $listResult = Invoke-CodexCapture @('mcp', 'list')
    if ($listResult.ExitCode -ne 0 -or -not (($listResult.Output | Out-String) -match '(?m)^codeviser\b')) {
        throw "MCP registration could not be verified.`n$(Convert-ToAscii ($listResult.Output | Out-String))"
    }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'CodeViser CVD Master.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$launcher = Join-Path $installRoot 'launch-cvd.cmd'
$shortcut.TargetPath = $launcher
$shortcutArguments = ''
if ($AutoStartScript) { $shortcutArguments += " -AutoStartScript `"$AutoStartScript`"" }
$shortcut.Arguments = $shortcutArguments.Trim()
$shortcut.WorkingDirectory = Split-Path $cvdExe -Parent
$shortcut.IconLocation = "$cvdExe,0"
$shortcut.Save()

@{ shortcut = $shortcutPath; codex = $codex; cvdRoot = $CvdRoot; installRoot = $installRoot; autoStartScript = $AutoStartScript } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'install-info.json') -Encoding UTF8

Write-Host ''
if (Test-Path -LiteralPath $errorLog) { Remove-Item -LiteralPath $errorLog -Force }
Write-Host 'INSTALL COMPLETE' -ForegroundColor Green
Write-Host "MCP: codeviser"
Write-Host "Install path: $installRoot"
Write-Host "Shortcut: $shortcutPath"
if ($AutoStartScript) { Write-Host "Auto-start CMM: $AutoStartScript" }
else { Write-Host 'Auto-start CMM: disabled (use -AutoStartScript "D:\path\autostart.cmm" to enable).' -ForegroundColor Yellow }
Write-Host 'Fully close and restart Codex Desktop.' -ForegroundColor Yellow
$global:LASTEXITCODE = 0
