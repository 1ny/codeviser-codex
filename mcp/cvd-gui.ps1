param(
    [Parameter(Mandatory)][string]$MenuId,
    [Parameter(Mandatory)][string]$MenuName,
    [Parameter(Mandatory)][string]$Hotkey
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class CvdGuiNative {
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
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp

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
    param([Parameter(Mandatory)][string]$Value)
    $parts = @($Value -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw 'Empty CVD menu hotkey.' }
    $modifiers = [Collections.Generic.List[byte]]::new()
    $keyName = $null
    foreach ($part in $parts) {
        switch -Regex ($part) {
            '^(Ctrl|Control)$' { $modifiers.Add([byte]0x11); continue }
            '^Alt$' { $modifiers.Add([byte]0x12); continue }
            '^Shift$' { $modifiers.Add([byte]0x10); continue }
            default { $keyName = $part }
        }
    }
    if (-not $keyName) { throw "Hotkey has no key component: $Value" }
    $keyCode = Get-VirtualKeyCode -Key $keyName
    foreach ($modifier in $modifiers) { [CvdGuiNative]::keybd_event($modifier, 0, 0, [UIntPtr]::Zero) }
    [CvdGuiNative]::keybd_event($keyCode, 0, 0, [UIntPtr]::Zero)
    [CvdGuiNative]::keybd_event($keyCode, 0, 2, [UIntPtr]::Zero)
    for ($index = $modifiers.Count - 1; $index -ge 0; $index--) {
        [CvdGuiNative]::keybd_event($modifiers[$index], 0, 2, [UIntPtr]::Zero)
    }
    return ('VK 0x{0:X2}' -f $keyCode)
}

$window = [IntPtr]::Zero
foreach ($process in [Diagnostics.Process]::GetProcessesByName('CVD')) {
    $process.Refresh()
    $candidate = $process.MainWindowHandle
    if ($candidate -eq [IntPtr]::Zero) { $candidate = [CvdGuiNative]::FindWindowForProcess($process.Id) }
    if ($candidate -ne [IntPtr]::Zero) { $window = $candidate; break }
}
if ($window -eq [IntPtr]::Zero) {
    throw 'CVD GUI window was not found. GUI automation requires a visible CVD window.'
}

[void][CvdGuiNative]::ShowWindow($window, 9)
if (-not [CvdGuiNative]::SetForegroundWindow($window)) {
    throw 'CVD GUI window could not be activated, so the hotkey was not sent.'
}
Start-Sleep -Milliseconds 150
$keyCode = Send-CvdHotkey -Value $Hotkey

@{
    action = 'menu_hotkey'
    menuId = $MenuId
    name = $MenuName
    hotkey = $Hotkey
    keyCode = $keyCode
    transport = 'isolated-gui-helper'
    window = ('0x{0:X}' -f $window.ToInt64())
    accepted = $true
} | ConvertTo-Json -Compress
