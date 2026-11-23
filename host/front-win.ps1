<#
  Bring a window the host just opened to the front on Windows: "Open in Claude"
  and "Open in Claude", whose Windows Terminal window otherwise opens behind
  the window in front.

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File front-win.ps1 <title> [waitMs]

  Finds the top-level window whose title is <title> (the host starts Windows
  Terminal with that title, and with the tab's own title suppressed so the
  program in it cannot rename it), for up to waitMs, and brings it to the
  front. Answers one line of JSON on stdout and exits 0:
    {"front":true}                 it is the foreground window now
    {"front":false,"why":"..."}    not found in time, or Windows refused
  An exception is a line on stderr and exit 2.

  Why: a process that is not in front may not take the front (the foreground
  lock), and the host runs hidden under Task Scheduler. Measured by
  pc-developer, 2026-11-20: Windows Terminal opened from the host came up
  behind the window in front ("YES, BUT BEHIND"). The same day the folder
  dialog (dialog-win.ps1) was made the foreground window from the same
  hidden process by an ALT tap and the front window's input queue attached
  before SetForegroundWindow. This applies that, to a window of another
  process, and it works for Windows Terminal's: measured by pc-developer,
  2026-11-20, at 9e160cc on the installed host, costmo clicking in Chrome
  and the foreground window read every 0.5 s. Open in tmux three times and
  Open in Claude on a desk with no window: Windows Terminal was the
  foreground window 1.0 to 1.3 s after the host opened it, 4 of 4 ("In
  front, focused"). --suppressApplicationTitle kept the window's title
  exactly the given one while psmux and Claude Code drew in it, so the
  exact match found each. No Alt was left held.
#>
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$WaitMs = 5000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace OrchFront {
  public static class Native {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  }

  public static class Front {
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x2;
    const int SW_RESTORE = 9;

    public static IntPtr Find(string title) {
      IntPtr found = IntPtr.Zero;
      Native.EnumWindows((h, l) => {
        if (!Native.IsWindowVisible(h)) return true;
        StringBuilder s = new StringBuilder(512);
        Native.GetWindowText(h, s, s.Capacity);
        if (s.ToString() == title) { found = h; return false; }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    // The unlock measured for the folder dialog (dialog-win.ps1): an ALT tap,
    // the front window's input queue attached, then the call, then detach.
    public static bool Bring(IntPtr hwnd) {
      if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, SW_RESTORE);
      uint fgPid;
      uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out fgPid);
      uint me = Native.GetCurrentThreadId();
      Native.keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      Native.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      bool attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
      Native.BringWindowToTop(hwnd);
      Native.SetForegroundWindow(hwnd);
      if (attached) Native.AttachThreadInput(me, fgThread, false);
      return Native.GetForegroundWindow() == hwnd;
    }
  }
}
'@

function Write-Answer($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress))
}

try {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
  $hwnd = [IntPtr]::Zero
  while ($hwnd -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
    $hwnd = [OrchFront.Front]::Find($Title)
    if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
  }
  if ($hwnd -eq [IntPtr]::Zero) { Write-Answer @{ front = $false; why = "no window titled '$Title' appeared within $WaitMs ms" }; exit 0 }
  if ([OrchFront.Front]::Bring($hwnd)) { Write-Answer @{ front = $true }; exit 0 }
  # A window that has just appeared may still be taking its first paint;
  # one more try a moment later before saying no.
  Start-Sleep -Milliseconds 250
  if ([OrchFront.Front]::Bring($hwnd)) { Write-Answer @{ front = $true }; exit 0 }
  Write-Answer @{ front = $false; why = 'Windows did not give it the front' }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
