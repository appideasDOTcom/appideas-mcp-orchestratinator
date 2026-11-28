param([string]$Out)
# Whole-desktop screenshot plus the foreground window and every visible #32770 dialog.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
function Desc($h) {
  $c = New-Object Text.StringBuilder 256; [void][W]::GetClassName($h, $c, 256)
  $t = New-Object Text.StringBuilder 256; [void][W]::GetWindowText($h, $t, 256)
  $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  "$n pid=$p class=$($c.ToString()) title='$($t.ToString())'"
}
"foreground: " + (Desc ([W]::GetForegroundWindow()))
$list = New-Object Collections.ArrayList
[W]::EnumWindows({ param($h,$l) if ([W]::IsWindowVisible($h)) { $c = New-Object Text.StringBuilder 256; [void][W]::GetClassName($h,$c,256); if ($c.ToString() -eq '#32770') { [void]$list.Add($h) } }; $true }, [IntPtr]::Zero) | Out-Null
foreach ($h in $list) { "dialog: " + (Desc $h) }
if ($Out) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  "saved $Out"
}
