param(
    [string]$DllDirectory = "C:\JnDTech\CVI\CVD\API\BinR",
    [string]$HostAddress = "127.0.0.1",
    [int]$MultiServerPort = 8888,
    [int]$CvdMasterPort = 20000,
    [int]$TimeoutMs = 5000,
    [switch]$KeepAlive,
    [int]$ParentProcessId = 0,
    [string]$SessionEventLog
)

$ErrorActionPreference = 'Stop'

function Write-BridgeResponse {
    param([hashtable]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function Write-KeeperSessionEvent {
    param([int]$Session)
    if ([string]::IsNullOrWhiteSpace($SessionEventLog)) { return }
    $event = @{
        time = [DateTime]::Now.ToString('o')
        session = $Session
        connected = ($Session -ne 0)
        keeperPid = $PID
    } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($SessionEventLog, $event + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}

if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) {
    # Expected: the supplied CVDAPI.dll is 32-bit.
} elseif ([Environment]::Is64BitProcess) {
    Write-BridgeResponse @{ ready = $false; error = 'cvd-bridge.ps1 must run in 32-bit PowerShell (SysWOW64).' }
    exit 2
}

$dllPath = Join-Path $DllDirectory 'CVDAPI.dll'
if (-not (Test-Path -LiteralPath $dllPath)) {
    Write-BridgeResponse @{ ready = $false; error = "CVDAPI.dll not found: $dllPath" }
    exit 3
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class CvdNative {
    private const string DllName = "CVDAPI.dll";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string lpPathName);

    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_Init();
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern int CVD_Connect(int port, string address);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_Config(int guiPort);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_SetTimeOut(int timeoutMs);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_CheckSession();
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_GetState(out int state);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_GetDebugState(out int state);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_GetCurrentPC(out UInt32 value);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_Run();
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_Stop();
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_SystemReset();
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern int CVD_Cmd(string command);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_ReadRegister(int type, int index, out UInt32 value, int stringParameter);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_ReadMemory(int type, UInt32 address, int size, [Out] byte[] value);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)] public static extern int CVD_GetSymbol(string symbol, out UInt32 address, out UInt32 size);
    [DllImport(DllName, CallingConvention = CallingConvention.Cdecl)] public static extern int CVD_Quit();
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp
[void][CvdNative]::SetDllDirectory($DllDirectory)

$connected = $false
$initResult = 0
$connectResult = 0
$configResult = 0

function Connect-Cvd {
    if ($script:connected) { return $true }
    $script:initResult = [CvdNative]::CVD_Init()
    if ($script:initResult -eq 0) { return $false }
    [void][CvdNative]::CVD_SetTimeOut($TimeoutMs)
    $script:connectResult = [CvdNative]::CVD_Connect($MultiServerPort, $HostAddress)
    if ($script:connectResult -eq 0) {
        [void][CvdNative]::CVD_Quit()
        return $false
    }
    $script:configResult = [CvdNative]::CVD_Config($CvdMasterPort)
    $script:connected = ($script:configResult -ne 0)
    if (-not $script:connected) { [void][CvdNative]::CVD_Quit() }
    return $script:connected
}

function Require-Cvd {
    if ($script:connected -and [CvdNative]::CVD_CheckSession() -eq 0) {
        [void][CvdNative]::CVD_Quit()
        $script:connected = $false
    }
    if (-not (Connect-Cvd)) {
        throw "CVD API connection failed (Init=$initResult, Connect=$connectResult, Config=$configResult). Check CVD-Multi-Server:8888 and CVD Master:$CvdMasterPort."
    }
}

function Get-CvdSnapshot {
    $snapshot = [ordered]@{
        cvdState = $null
        debugState = $null
        pc = $null
        errors = @()
    }
    try {
        $value = 0
        if ([CvdNative]::CVD_GetState([ref]$value) -eq 0) { throw 'CVD_GetState failed.' }
        $snapshot.cvdState = $value
    } catch { $snapshot.errors += $_.Exception.Message }
    try {
        $value = 0
        if ([CvdNative]::CVD_GetDebugState([ref]$value) -eq 0) { throw 'CVD_GetDebugState failed.' }
        $snapshot.debugState = $value
    } catch { $snapshot.errors += $_.Exception.Message }
    try {
        [uint32]$value = 0
        if ([CvdNative]::CVD_GetCurrentPC([ref]$value) -eq 0) { throw 'CVD_GetCurrentPC failed.' }
        $snapshot.pc = ('0x{0:X8}' -f $value)
    } catch { $snapshot.errors += $_.Exception.Message }
    return $snapshot
}

$firstConnect = Connect-Cvd
Write-BridgeResponse @{
    ready = $true
    connected = $firstConnect
    processBits = 32
    dll = $dllPath
    host = $HostAddress
    multiServerPort = $MultiServerPort
    cvdMasterPort = $CvdMasterPort
    results = @{ init = $initResult; connect = $connectResult; config = $configResult }
}

$keeperMutex = $null
$ownsKeeperMutex = $false
try {
    if ($KeepAlive) {
        $mutexName = 'Local\CodeViserCvdApiKeeper_{0}_{1}' -f $MultiServerPort, $CvdMasterPort
        $keeperMutex = New-Object Threading.Mutex($false, $mutexName)
        try {
            $ownsKeeperMutex = $keeperMutex.WaitOne(0)
        } catch [Threading.AbandonedMutexException] {
            $ownsKeeperMutex = $true
        }
        if (-not $ownsKeeperMutex) {
            Write-BridgeResponse @{ keeper = $false; duplicate = $true; message = 'An API keeper is already running.' }
            exit 0
        }

        $lastSession = $(if ($connected) { [CvdNative]::CVD_CheckSession() } else { 0 })
        Write-KeeperSessionEvent -Session $lastSession
        Write-BridgeResponse @{ keeper = $true; connected = $connected; session = $lastSession }
        while ((Get-Process -Name CVD -ErrorAction SilentlyContinue) -and
               (($ParentProcessId -eq 0) -or (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue))) {
            Start-Sleep -Seconds 2
            $currentSession = $(if ($connected) { [CvdNative]::CVD_CheckSession() } else { 0 })
            if ($currentSession -ne $lastSession) {
                Write-KeeperSessionEvent -Session $currentSession
                $lastSession = $currentSession
            }
            if ($currentSession -eq 0) {
                $connected = $false
                Start-Sleep -Seconds 1
                $connected = Connect-Cvd
                $currentSession = $(if ($connected) { [CvdNative]::CVD_CheckSession() } else { 0 })
                if ($currentSession -ne $lastSession) {
                    Write-KeeperSessionEvent -Session $currentSession
                    $lastSession = $currentSession
                }
            }
        }
        if ($lastSession -ne 0) { Write-KeeperSessionEvent -Session 0 }
        exit 0
    }

    while (($line = [Console]::In.ReadLine()) -ne $null) {
        $line = $line.TrimStart([char]0xFEFF)
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $request = $null
        try {
            $request = $line | ConvertFrom-Json
            $id = $request.id
            switch ($request.command) {
                'health' {
                    if ($connected -and [CvdNative]::CVD_CheckSession() -eq 0) { $connected = $false }
                    if (-not $connected) { $connected = Connect-Cvd }
                    $session = 0
                    if ($connected) { $session = [CvdNative]::CVD_CheckSession() }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{
                        connected = $connected; session = $session; host = $HostAddress;
                        multiServerPort = $MultiServerPort; cvdMasterPort = $CvdMasterPort;
                        processBits = 32; dll = $dllPath
                    }}
                }
                'reconnect' {
                    if ($connected) { [void][CvdNative]::CVD_Quit() }
                    $connected = $false
                    $ok = Connect-Cvd
                    Write-BridgeResponse @{ id = $id; ok = $ok; result = @{ connected = $ok; init = $initResult; connect = $connectResult; config = $configResult } }
                }
                'get_status' {
                    $apiError = $null
                    try { Require-Cvd } catch { $apiError = $_.Exception.Message }
                    $session = $(if ($connected) { [CvdNative]::CVD_CheckSession() } else { 0 })
                    $target = $(if ($connected -and $session -ne 0) { Get-CvdSnapshot } else {
                        [ordered]@{ cvdState = $null; debugState = $null; pc = $null; errors = @($apiError) }
                    })
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{
                        api = @{
                            connected = ($connected -and $session -ne 0)
                            session = $session
                            host = $HostAddress
                            multiServerPort = $MultiServerPort
                            cvdMasterPort = $CvdMasterPort
                            processBits = 32
                            dll = $dllPath
                            error = $apiError
                        }
                        target = $target
                    }}
                }
                'get_state' {
                    Require-Cvd
                    $value = 0
                    $rc = [CvdNative]::CVD_GetState([ref]$value)
                    if ($rc -eq 0) { throw 'CVD_GetState failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ state = $value } }
                }
                'get_debug_state' {
                    Require-Cvd
                    $value = 0
                    $rc = [CvdNative]::CVD_GetDebugState([ref]$value)
                    if ($rc -eq 0) { throw 'CVD_GetDebugState failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ debugState = $value } }
                }
                'get_pc' {
                    Require-Cvd
                    [uint32]$value = 0
                    $rc = [CvdNative]::CVD_GetCurrentPC([ref]$value)
                    if ($rc -eq 0) { throw 'CVD_GetCurrentPC failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ pc = ('0x{0:X8}' -f $value); decimal = [uint64]$value } }
                }
                'run' {
                    Require-Cvd
                    $rc = [CvdNative]::CVD_Run()
                    if ($rc -eq 0) { throw 'CVD_Run failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ action = 'run'; accepted = $true } }
                }
                'stop' {
                    Require-Cvd
                    $rc = [CvdNative]::CVD_Stop()
                    if ($rc -eq 0) { throw 'CVD_Stop failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ action = 'stop'; accepted = $true } }
                }
                'reset' {
                    Require-Cvd
                    $rc = [CvdNative]::CVD_SystemReset()
                    if ($rc -eq 0) { throw 'CVD_SystemReset failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ action = 'system_reset'; accepted = $true } }
                }
                'command' {
                    Require-Cvd
                    $commandText = [string]$request.text
                    if ([string]::IsNullOrWhiteSpace($commandText)) { throw 'CVD command must not be empty.' }
                    if ($commandText.Length -gt 1024) { throw 'CVD command must be 1024 characters or fewer.' }
                    if ($commandText -match '[\r\n\x00]') { throw 'CVD command must be one line.' }
                    $before = Get-CvdSnapshot
                    $rc = [CvdNative]::CVD_Cmd($commandText)
                    if ($rc -eq 0) { throw "CVD_Cmd failed: $commandText" }
                    $settleMs = [Math]::Max(0, [Math]::Min([int]$request.settleMs, 5000))
                    if ($settleMs -gt 0) { Start-Sleep -Milliseconds $settleMs }
                    $after = Get-CvdSnapshot
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{
                        action = 'command'
                        command = $commandText
                        accepted = $true
                        outputCapture = 'state-observation'
                        before = $before
                        after = $after
                    }}
                }
                'run_script' {
                    Require-Cvd
                    $scriptPath = [IO.Path]::GetFullPath([string]$request.path)
                    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "CMM script not found: $scriptPath" }
                    if ([IO.Path]::GetExtension($scriptPath) -ine '.cmm') { throw 'Only .cmm scripts can be executed.' }
                    $argumentsText = [string]$request.argumentsText
                    if ($argumentsText -match '[\r\n\x00]') { throw 'CMM arguments must be one line.' }
                    $escapedPath = $scriptPath.Replace('"', '""')
                    $commandText = 'CD.DO "' + $escapedPath + '"'
                    if (-not [string]::IsNullOrWhiteSpace($argumentsText)) { $commandText += ' ' + $argumentsText }
                    $before = Get-CvdSnapshot
                    $rc = [CvdNative]::CVD_Cmd($commandText)
                    if ($rc -eq 0) { throw "CVD_Cmd failed while starting script: $scriptPath" }
                    $settleMs = [Math]::Max(0, [Math]::Min([int]$request.settleMs, 5000))
                    if ($settleMs -gt 0) { Start-Sleep -Milliseconds $settleMs }
                    $after = Get-CvdSnapshot
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{
                        action = 'run_script'
                        script = $scriptPath
                        accepted = $true
                        outputCapture = 'state-observation'
                        before = $before
                        after = $after
                        note = 'CVDAPI.dll does not expose CVD console PRINT text.'
                    }}
                }
                'read_register' {
                    Require-Cvd
                    [uint32]$value = 0
                    $rc = [CvdNative]::CVD_ReadRegister([int]$request.type, [int]$request.index, [ref]$value, 0)
                    if ($rc -eq 0) { throw 'CVD_ReadRegister failed.' }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ type = [int]$request.type; index = [int]$request.index; value = ('0x{0:X8}' -f $value); decimal = [uint64]$value } }
                }
                'read_memory' {
                    Require-Cvd
                    $count = [int]$request.size
                    if ($count -lt 1 -or $count -gt 1024) { throw 'size must be between 1 and 1024 bytes.' }
                    [uint32]$address = [Convert]::ToUInt32(([string]$request.address).Replace('0x',''), 16)
                    $buffer = New-Object byte[] $count
                    $rc = [CvdNative]::CVD_ReadMemory([int]$request.type, $address, $count, $buffer)
                    if ($rc -eq 0) { throw 'CVD_ReadMemory failed.' }
                    $hex = ($buffer | ForEach-Object { $_.ToString('X2') }) -join ' '
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ type = [int]$request.type; address = ('0x{0:X8}' -f $address); size = $count; hex = $hex } }
                }
                'get_symbol' {
                    Require-Cvd
                    [uint32]$address = 0
                    [uint32]$size = 0
                    $rc = [CvdNative]::CVD_GetSymbol([string]$request.symbol, [ref]$address, [ref]$size)
                    if ($rc -eq 0) { throw "CVD_GetSymbol failed for '$($request.symbol)'." }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ symbol = [string]$request.symbol; address = ('0x{0:X8}' -f $address); size = [uint64]$size } }
                }
                'shutdown' {
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ shuttingDown = $true } }
                    break
                }
                default { throw "Unknown bridge command: $($request.command)" }
            }
            if ($request.command -eq 'shutdown') { break }
        } catch {
            $responseId = if ($null -ne $request) { $request.id } else { $null }
            Write-BridgeResponse @{ id = $responseId; ok = $false; error = $_.Exception.Message }
        }
    }
} finally {
    if ($connected) { [void][CvdNative]::CVD_Quit() }
    if ($ownsKeeperMutex -and $null -ne $keeperMutex) {
        try { $keeperMutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $keeperMutex) { $keeperMutex.Dispose() }
}
