# Keys into one window, and only while that window is the foreground: a key
# goes to whatever is in front, so a dialog that did not take the front would
# send the person's half-typed browser text instead.
#
#   press-keys.ps1 -Title 'Open' -Keys 'pick.png{ENTER}'         SendKeys syntax
#   press-keys.ps1 -Title 'windows-scratch' -Prefix -Vk 0x11,0x56  a chord (Ctrl+V)
#   press-keys.ps1 -Title 'Choose the folder your agent lives in' -Vk 0x1B   Escape
#
# Text with a " in it goes through $env:PRESS_KEYS: Windows PowerShell 5.1 drops
# the quotes of an argument it hands on ("a.png" "b.log" arrived as one name).
# Measured 2026-11-24 (task 356): SendKeys typed names and {ENTER} into Chrome's
# Open dialog, and keybd_event sent Escape to the folder dialog and Ctrl+V to
# Chrome. SendInput mouse clicks from the same shell did nothing there.
[CmdletBinding(PositionalBinding = $false)]
param([Parameter(Mandatory)][string]$Title, [switch]$Prefix, [string]$Keys, [int[]]$Vk)
if ($env:PRESS_KEYS) { $Keys = $env:PRESS_KEYS }
if (-not $Keys -and -not $Vk) { 'nothing to send: give -Keys or -Vk'; exit 2 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class PK {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
function Front { $t = New-Object Text.StringBuilder 256; [void][PK]::GetWindowText([PK]::GetForegroundWindow(), $t, 256); $t.ToString() }
function Ok { $f = Front; if ($Prefix) { $f.StartsWith($Title) } else { $f -eq $Title } }
if (-not (Ok)) { "refused: foreground is '$(Front)'"; exit 1 }
if ($Vk) {
  $codes = [byte[]]$Vk
  foreach ($c in $codes) { [PK]::keybd_event($c, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 60
  [array]::Reverse($codes)
  foreach ($c in $codes) { [PK]::keybd_event($c, 0, 2, [UIntPtr]::Zero) }
}
if ($Keys) {
  # An {ENTER} at the end is sent apart, after the window is checked again.
  $enter = $Keys.EndsWith('{ENTER}')
  $body = if ($enter) { $Keys.Substring(0, $Keys.Length - 7) } else { $Keys }
  if ($body) { [System.Windows.Forms.SendKeys]::SendWait($body) }
  if ($enter) {
    Start-Sleep -Milliseconds 300
    if (-not (Ok)) { "refused before Enter: foreground is '$(Front)'"; exit 1 }
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }
}
"sent to '$Title'; foreground now '$(Front)'"
