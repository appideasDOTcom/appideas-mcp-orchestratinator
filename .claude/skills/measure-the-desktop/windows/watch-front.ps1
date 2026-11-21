<#
  Which window is in front, every 0.5 s, written only when it changes: time,
  process, pid, window class and title. "Drawn" and "in front" are different
  answers, and this is the one that says which.

    watch-front.ps1 [-Seconds 60] [-Out <file>]

  Default out: watch-front.log in $env:PROBE_DIR (default %TEMP%\orch-desktop-probe).
  Run it hidden beside a probe, so it is not itself the window in front:

    Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<this file>','-Seconds','90'

  A dialog in front reads as its own process with class #32770 (powershell for
  host/dialog-win.ps1); a Windows Terminal window as WindowsTerminal with class
  CASCADIA_HOSTING_WINDOW_CLASS and the title it was given. Claude Code
  animates its window title with a spinner, so a terminal running Claude
  writes a line every second or so; fold those when reading.
#>
param(
  [int]$Seconds = 60,
  [string]$Out = ''
)
if (-not $Out) {
  $dir = if ($env:PROBE_DIR) { $env:PROBE_DIR } else { Join-Path $env:TEMP 'orch-desktop-probe' }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Out = Join-Path $dir 'watch-front.log'
}
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class OrchFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
'@
$last = ''
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $h = [OrchFg]::GetForegroundWindow(); $p = 0; [void][OrchFg]::GetWindowThreadProcessId($h, [ref]$p)
  $t = New-Object System.Text.StringBuilder 512; [void][OrchFg]::GetWindowText($h, $t, 512)
  $c = New-Object System.Text.StringBuilder 128; [void][OrchFg]::GetClassName($h, $c, 128)
  $name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  $now = "$name pid=$p class=$($c.ToString()) title='$($t.ToString())'"
  if ($now -ne $last) { '{0:HH:mm:ss.f} {1}' -f (Get-Date), $now | Out-File -FilePath $Out -Append -Encoding utf8; $last = $now }
  Start-Sleep -Milliseconds 500
}
