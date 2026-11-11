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
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CvdNative {
    private const string DllName = "CVDAPI.dll";

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string lpPathName);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    public static IntPtr FindWindowForProcess(int processId) {
        IntPtr first = IntPtr.Zero;
        IntPtr visible = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != (uint)processId) return true;
            if (first == IntPtr.Zero) first = hWnd;
            if (IsWindowVisible(hWnd)) { visible = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return visible != IntPtr.Zero ? visible : first;
    }

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
    if ($script:connectResult -eq 0) { return $false }
    $script:configResult = [CvdNative]::CVD_Config($CvdMasterPort)
    $script:connected = ($script:configResult -ne 0)
    return $script:connected
}

function Require-Cvd {
    if (-not (Connect-Cvd)) {
        throw "CVD API connection failed (Init=$initResult, Connect=$connectResult, Config=$configResult). Check CVD-Multi-Server:8888 and CVD Master:$CvdMasterPort."
    }
}

function Get-VirtualKeyCode {
    param([Parameter(Mandatory)][string]$Key)
    if ($Key -match '^F(\d{1,2})$') {
        $number = [int]$Matches[1]
        if ($number -lt 1 -or $number -gt 24) { throw "Unsupported function key: $Key" }
        return [byte](0x70 + $number - 1)
    }
    if ($Key.Length -eq 1 -and $Key -match '^[A-Za-z0-9]$') {
        return [byte][char]$Key.ToUpperInvariant()
    }
    throw "Unsupported CVD menu hotkey component: $Key"
}

function Send-CvdHotkey {
    param([Parameter(Mandatory)][string]$Hotkey)
    $parts = @($Hotkey -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw 'Empty CVD menu hotkey.' }
    $modifiers = [System.Collections.Generic.List[byte]]::new()
    $keyName = $null
    foreach ($part in $parts) {
        switch -Regex ($part) {
            '^(Ctrl|Control)$' { $modifiers.Add([byte]0x11); continue }
            '^Alt$' { $modifiers.Add([byte]0x12); continue }
            '^Shift$' { $modifiers.Add([byte]0x10); continue }
            default { $keyName = $part }
        }
    }
    if (-not $keyName) { throw "Hotkey has no key component: $Hotkey" }
    $keyCode = Get-VirtualKeyCode -Key $keyName
    foreach ($modifier in $modifiers) { [CvdNative]::keybd_event($modifier, 0, 0, [UIntPtr]::Zero) }
    [CvdNative]::keybd_event($keyCode, 0, 0, [UIntPtr]::Zero)
    [CvdNative]::keybd_event($keyCode, 0, 2, [UIntPtr]::Zero)
    for ($index = $modifiers.Count - 1; $index -ge 0; $index--) {
        [CvdNative]::keybd_event($modifiers[$index], 0, 2, [UIntPtr]::Zero)
    }
    return ('VK 0x{0:X2}' -f $keyCode)
}

function Invoke-CvdMenuHotkey {
    param([Parameter(Mandatory)][string]$Hotkey)
    $window = [IntPtr]::Zero
    foreach ($process in [Diagnostics.Process]::GetProcessesByName('CVD')) {
        $process.Refresh()
        $candidate = $process.MainWindowHandle
        if ($candidate -eq [IntPtr]::Zero) { $candidate = [CvdNative]::FindWindowForProcess($process.Id) }
        if ($candidate -ne [IntPtr]::Zero) { $window = $candidate; break }
    }
    if ($window -eq [IntPtr]::Zero) {
        throw 'CVD GUI window was not found. DEBUG.HideDebugWindow ON may be hiding the window; menu execution requires a visible CVD window.'
    }

    [void][CvdNative]::ShowWindow($window, 9)
    if (-not [CvdNative]::SetForegroundWindow($window)) {
        throw 'CVD GUI window could not be activated, so the hotkey was not sent.'
    }
    Start-Sleep -Milliseconds 150
    $keyCode = Send-CvdHotkey -Hotkey $Hotkey
    return @{ hotkey = $Hotkey; keyCode = $keyCode; window = ('0x{0:X}' -f $window.ToInt64()) }
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
                    $rc = [CvdNative]::CVD_Cmd($commandText)
                    if ($rc -eq 0) { throw "CVD_Cmd failed: $commandText" }
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{ action = 'command'; command = $commandText; accepted = $true } }
                }
                'menu_hotkey' {
                    $hotkey = [string]$request.hotkey
                    if ([string]::IsNullOrWhiteSpace($hotkey)) { throw 'CVD menu hotkey must not be empty.' }
                    $details = Invoke-CvdMenuHotkey -Hotkey $hotkey
                    Write-BridgeResponse @{ id = $id; ok = $true; result = @{
                        action = 'menu_hotkey'; menuId = [string]$request.menuId; name = [string]$request.name;
                        hotkey = $details.hotkey; transport = 'direct-gui'; window = $details.window; accepted = $true
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
