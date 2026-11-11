$ErrorActionPreference = 'Stop'
$installRoot = $PSScriptRoot
$errorLog = Join-Path $PSScriptRoot 'uninstall-error.log'
function Convert-ToAscii([string]$text) { return [Text.Encoding]::ASCII.GetString([Text.Encoding]::ASCII.GetBytes($text)) }
trap {
    $details = Convert-ToAscii (($_ | Out-String).Trim())
    Set-Content -LiteralPath $errorLog -Value $details -Encoding Ascii
    Write-Host '[UNINSTALL ERROR]' -ForegroundColor Red
    Write-Host $details
    Write-Host "Log: $errorLog" -ForegroundColor Yellow
    Read-Host 'Press Enter to close'
    exit 1
}
$codex = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $codex) {
    $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $binRoot) {
        $codex = Get-ChildItem -LiteralPath $binRoot -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
}
if ($codex) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $removeOldOutput = & $codex mcp remove codeviser_cvd 2>&1
        $removeOutput = & $codex mcp remove codeviser 2>&1
        $removeExitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previousPreference }
}
if (-not $codex -or $removeExitCode -ne 0) {
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    if (-not $userProfile) { $userProfile = $env:USERPROFILE }
    if ($userProfile) {
        $configPath = Join-Path $userProfile '.codex\config.toml'
        if (Test-Path -LiteralPath $configPath) {
            $content = Get-Content -LiteralPath $configPath -Raw
            $sectionPattern = '(?ms)^\[mcp_servers\.(?:codeviser_cvd|codeviser)(?:\.env)?\]\r?\n.*?(?=^\[|\z)'
            $updated = [regex]::Replace($content, $sectionPattern, '').TrimEnd() + "`r`n"
            Set-Content -LiteralPath $configPath -Value $updated -Encoding UTF8
        }
    }
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodeViser CVD Master.lnk'
if (Test-Path -LiteralPath (Join-Path $installRoot 'install-info.json')) {
    try { $shortcutPath = (Get-Content -LiteralPath (Join-Path $installRoot 'install-info.json') -Raw | ConvertFrom-Json).shortcut } catch { }
}
if ($shortcutPath -and (Test-Path -LiteralPath $shortcutPath)) { Remove-Item -LiteralPath $shortcutPath -Force }
foreach ($generatedFile in @('install-info.json', 'status.log')) {
    $generatedPath = Join-Path $installRoot $generatedFile
    if (Test-Path -LiteralPath $generatedPath) { Remove-Item -LiteralPath $generatedPath -Force }
}
if (Test-Path -LiteralPath $errorLog) { Remove-Item -LiteralPath $errorLog -Force }
Write-Host 'UNINSTALL COMPLETE. CodeViser CVD and board files were not changed.' -ForegroundColor Green
$global:LASTEXITCODE = 0
