param(
    [string]$CvdExe = 'C:\JnDTech\CVI\CVD\Bin\CVD.exe',
    [string]$ApiDir = 'C:\JnDTech\CVI\CVD\API\BinR',
    [string]$MasterConfig,
    [string]$AutoStartScript,
    [int]$MultiServerPort = 8888,
    [int]$MasterPort = 20000,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
if (-not $MasterConfig) { $MasterConfig = Join-Path $PSScriptRoot 'config\master.csf' }
$bridge = Join-Path $PSScriptRoot 'mcp\cvd-bridge.ps1'
if (-not (Test-Path -LiteralPath $bridge)) {
    $bridge = Join-Path $PSScriptRoot 'cvd-bridge.ps1'
}
$powershell32 = 'C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$statusLog = Join-Path $PSScriptRoot 'status.log'
$sessionEventLog = Join-Path $PSScriptRoot 'api-session.log'
try { $host.UI.RawUI.WindowTitle = 'CodeViser API Monitor' } catch {}

function Write-Status([string]$level, [string]$message) {
    $color = switch ($level) { 'OK' { 'Green' } 'ERROR' { 'Red' } 'WARN' { 'Yellow' } default { 'Cyan' } }
    Write-Host ("[{0:HH:mm:ss}] [{1}] {2}" -f (Get-Date), $level, $message) -ForegroundColor $color
    if ($level -eq 'ERROR') { try { [Console]::Beep(1000, 250) } catch {} }
}

function Test-CvdApi {
    try {
        $lines = @(
            '{"id":"health","command":"health"}',
            '{"id":"shutdown","command":"shutdown"}'
        ) | & $powershell32 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $bridge -DllDirectory $ApiDir -HostAddress '127.0.0.1' `
            -MultiServerPort $MultiServerPort -CvdMasterPort $MasterPort 2>&1
        foreach ($line in $lines) {
            try {
                $message = $line | ConvertFrom-Json -ErrorAction Stop
                if ($message.id -eq 'health' -and $message.ok) { return $message.result }
            } catch {}
        }
    } catch { Write-Status 'ERROR' $_.Exception.Message }
    return $null
}

function Invoke-CvdCommand([string]$commandText) {
    try {
        $lines = @(
            (@{ id = 'command'; command = 'command'; text = $commandText } | ConvertTo-Json -Compress),
            '{"id":"shutdown","command":"shutdown"}'
        ) | & $powershell32 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File $bridge -DllDirectory $ApiDir -HostAddress '127.0.0.1' `
            -MultiServerPort $MultiServerPort -CvdMasterPort $MasterPort 2>&1
        foreach ($line in $lines) {
            try {
                $message = $line | ConvertFrom-Json -ErrorAction Stop
                if ($message.id -eq 'command') { return $message }
            } catch {}
        }
    } catch { Write-Status 'ERROR' $_.Exception.Message }
    return $null
}

function Start-CvdApiKeeper {
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $bridge),
        '-DllDirectory', ('"{0}"' -f $ApiDir),
        '-HostAddress', '127.0.0.1',
        '-MultiServerPort', $MultiServerPort,
        '-CvdMasterPort', $MasterPort,
        '-ParentProcessId', $PID,
        '-SessionEventLog', ('"{0}"' -f $sessionEventLog),
        '-KeepAlive'
    )
    try {
        return Start-Process -FilePath $powershell32 -ArgumentList $arguments -WindowStyle Hidden -PassThru
    } catch {
        Write-Status 'ERROR' "Failed to start persistent API connection: $($_.Exception.Message)"
        return $null
    }
}

try { Clear-Host } catch {}
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ' CodeViser CVD API Monitor' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host 'R: active API recheck   Q: close monitor'
Write-Host 'This monitor never runs SYStem.Up, Run, Reset, or writes memory.'
Write-Host ''

foreach ($requiredFile in @($CvdExe, (Join-Path $ApiDir 'CVDAPI.dll'), $MasterConfig, $bridge, $powershell32)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        Write-Status 'ERROR' "Required file not found: $requiredFile"
        Read-Host 'Press Enter to close'
        exit 1
    }
}
if ($AutoStartScript -and -not (Test-Path -LiteralPath $AutoStartScript -PathType Leaf)) {
    Write-Status 'ERROR' "Auto-start CMM not found: $AutoStartScript"
    Read-Host 'Press Enter to close'
    exit 1
}
try { [IO.File]::WriteAllText($sessionEventLog, '', (New-Object Text.UTF8Encoding($false))) } catch {}

if (-not (Get-Process -Name CVD -ErrorAction SilentlyContinue)) {
    $startedCvd = Start-Process -FilePath $CvdExe -WorkingDirectory (Split-Path $CvdExe -Parent) `
        -ArgumentList @('-Multi', '-Master', '-CORE=1', $MasterConfig) -PassThru
    Write-Status 'INFO' "CVD Master launch requested: pid=$($startedCvd.Id). Waiting for API..."
} else {
    $existingIds = @(Get-Process -Name CVD -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','
    Write-Status 'INFO' "Existing CVD process detected: pid=$existingIds. A duplicate was not started."
}

Start-Sleep -Milliseconds 800
$visibleCvd = @(Get-Process -Name CVD -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)
if (-not $visibleCvd) {
    Write-Status 'WARN' 'A CVD process exists but no visible GUI was detected. Close stale/background CVD processes and relaunch the shortcut if the GUI is missing.'
}

$health = $null
for ($attempt = 1; $attempt -le 6 -and -not $health; $attempt++) {
    if ($attempt -gt 1) { Start-Sleep -Seconds 2 }
    $candidate = Test-CvdApi
    if ($candidate -and $candidate.connected -and [int]$candidate.session -ne 0) { $health = $candidate }
}
if ($health) {
    Write-Status 'OK' "API connected: session=$($health.session), multi=$($health.multiServerPort), master=$($health.cvdMasterPort)"
    if ($AutoStartScript) {
        $escapedScript = $AutoStartScript.Replace('"', '""')
        $autoStartCommand = 'CD.DO "' + $escapedScript + '"'
        $commandResult = Invoke-CvdCommand $autoStartCommand
        if ($commandResult -and $commandResult.ok) {
            Write-Status 'OK' "Auto-start CMM accepted: $AutoStartScript"
        } else {
            $reason = if ($commandResult.error) { [string]$commandResult.error } else { 'No command response.' }
            Write-Status 'ERROR' "Auto-start CMM failed: $reason"
        }
    }
    $apiKeeper = Start-CvdApiKeeper
    if ($apiKeeper) {
        Start-Sleep -Seconds 1
        $apiKeeper.Refresh()
        if ($apiKeeper.HasExited) {
            Write-Status 'WARN' 'Persistent API connection did not remain active.'
        } else {
            Write-Status 'OK' "Persistent API connection started: pid=$($apiKeeper.Id), listener=$MultiServerPort"
        }
    }
} else {
    Write-Status 'ERROR' 'Initial API check failed. Check Multi-Server Server Start, master port, and test.exe.'
}
if ($Once) { exit $(if ($health) { 0 } else { 1 }) }

$previousApiSession = $(if ($health) { [int]$health.session } else { 0 })
$seenSessionEvents = 0
$seenLogLines = if (Test-Path -LiteralPath $statusLog) { @(Get-Content -LiteralPath $statusLog -ErrorAction SilentlyContinue).Count } else { 0 }
Write-Status 'INFO' "Session monitor started. apiSession=$previousApiSession, masterSession=$MasterPort"

while ($true) {
    Start-Sleep -Seconds 1
    $cvd = [bool](Get-Process -Name CVD -ErrorAction SilentlyContinue)
    if ($cvd -and ($null -eq $apiKeeper -or $apiKeeper.HasExited)) {
        if ($previousApiSession -ne 0) {
            $previousApiSession = 0
            Write-Status 'ERROR' 'API session disconnected. Restarting persistent connection.'
        }
        $apiKeeper = Start-CvdApiKeeper
    }

    if (Test-Path -LiteralPath $sessionEventLog) {
        $sessionLines = @(Get-Content -LiteralPath $sessionEventLog -ErrorAction SilentlyContinue)
        if ($sessionLines.Count -lt $seenSessionEvents) { $seenSessionEvents = 0 }
        if ($sessionLines.Count -gt $seenSessionEvents) {
            foreach ($line in $sessionLines[$seenSessionEvents..($sessionLines.Count - 1)]) {
                try {
                    $event = $line | ConvertFrom-Json
                    $session = [int]$event.session
                    if ($session -ne $previousApiSession) {
                        $previousApiSession = $session
                        if ($session -ne 0) { Write-Status 'OK' "API session connected: session=$session" }
                        else { Write-Status 'ERROR' 'API session disconnected.' }
                    }
                } catch {}
            }
            $seenSessionEvents = $sessionLines.Count
        }
    }

    if (Test-Path -LiteralPath $statusLog) {
        $allLines = @(Get-Content -LiteralPath $statusLog -ErrorAction SilentlyContinue)
        if ($allLines.Count -gt $seenLogLines) {
            foreach ($line in $allLines[$seenLogLines..($allLines.Count - 1)]) {
                try {
                    $event = $line | ConvertFrom-Json
                    if ($event.level -eq 'error') { Write-Status 'ERROR' "MCP $($event.event): tool=$($event.tool) $($event.error)" }
                    elseif ($event.event -eq 'tool_ok') { Write-Status 'OK' "MCP tool completed: $($event.tool)" }
                } catch {}
            }
            $seenLogLines = $allLines.Count
        }
    }

    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true).Key
        if ($key -eq [ConsoleKey]::Q) { break }
        if ($key -eq [ConsoleKey]::R) {
            Write-Status 'INFO' 'Running active API health check...'
            $health = Test-CvdApi
            if ($health -and $health.connected -and [int]$health.session -ne 0) {
                Write-Status 'OK' "API connected: session=$($health.session), multi=$($health.multiServerPort), master=$($health.cvdMasterPort)"
            } else { Write-Status 'ERROR' 'API health check failed.' }
        }
    }
}

Write-Status 'INFO' 'Monitor closed. Persistent API connection will close; CVD remains running.'
