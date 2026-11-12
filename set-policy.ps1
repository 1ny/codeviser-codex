param(
    [Parameter(Mandatory)]
    [ValidateSet('readonly', 'scripts', 'unrestricted')]
    [string]$Policy,
    [switch]$EnableGuiAutomation
)

$ErrorActionPreference = 'Stop'
if ($EnableGuiAutomation -and $Policy -ne 'unrestricted') {
    throw '-EnableGuiAutomation is only valid with unrestricted policy.'
}

$userProfile = [Environment]::GetFolderPath('UserProfile')
if (-not $userProfile) { $userProfile = $env:USERPROFILE }
if (-not $userProfile) { throw 'User profile could not be located.' }
$configPath = Join-Path $userProfile '.codex\config.toml'
if (-not (Test-Path -LiteralPath $configPath)) { throw "Codex config was not found: $configPath" }

$content = Get-Content -LiteralPath $configPath -Raw
$serverMatch = [regex]::Match(
    $content,
    '(?ms)^\[mcp_servers\.codeviser\.env\]\r?\n(?<body>.*?)(?=^\[|\z)'
)
if (-not $serverMatch.Success) {
    throw 'The [mcp_servers.codeviser.env] section was not found. Run install.ps1 first.'
}

$body = $serverMatch.Groups['body'].Value
function Set-TomlEnvironmentValue {
    param([string]$Text, [string]$Name, [string]$Value)
    $line = "$Name = '$($Value.Replace("'", "''"))'"
    if ($Text -match "(?m)^$([regex]::Escape($Name))\s*=") {
        return [regex]::Replace($Text, "(?m)^$([regex]::Escape($Name))\s*=.*$", $line)
    }
    return $Text.TrimEnd() + "`r`n" + $line + "`r`n"
}

$body = Set-TomlEnvironmentValue -Text $body -Name 'CVD_ACCESS_POLICY' -Value $Policy
$body = Set-TomlEnvironmentValue -Text $body -Name 'CVD_ENABLE_GUI_AUTOMATION' `
    -Value $EnableGuiAutomation.IsPresent.ToString().ToLowerInvariant()
$updated = $content.Substring(0, $serverMatch.Groups['body'].Index) +
    $body +
    $content.Substring($serverMatch.Groups['body'].Index + $serverMatch.Groups['body'].Length)
Set-Content -LiteralPath $configPath -Value $updated -Encoding UTF8

Write-Host "CodeViser MCP policy changed to: $Policy" -ForegroundColor Green
Write-Host "GUI automation: $($EnableGuiAutomation.IsPresent)"
Write-Host 'Fully close and restart Codex Desktop to apply the new policy.' -ForegroundColor Yellow
