<#
  The Windows folder dialog (host/dialog.js, issue #28): Windows' own
  IFileOpenDialog, owned by an invisible always-on-top window that is brought
  to the front before the dialog opens.

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File dialog-win.ps1 <start> [title]

  Answers on stdout with one line of JSON, the contract every backend in
  dialog.js keeps, and exits 0 for both:
    {"path":"C:\\..."}            a folder was chosen
    {"cancelled":true}            closed without a choice
  Anything else (an exception) is a line on stderr and exit 2. Killing the
  process takes the dialog off the screen (measured), which is how the host
  closes one that was left open.

  Why it is built this way was measured, not chosen (pc-developer, Windows 11
  26200, Windows PowerShell 5.1, started from a hidden conhost --headless
  scheduled task like the installed host, the foreground window read every
  0.5 s, costmo watching the screen, 2026-11-20):
  - Show(no owner): drawn behind the window in front. Never the foreground.
  - Owned by an always-on-top window: drawn above everything, but the window
    in front kept the keyboard.
  - That owner, brought to the front first with an ALT tap and the front
    window's input queue attached (Unlock below): the dialog became the
    foreground window in about 1.5 s from the start, and the browser got the
    focus back when it closed. This one.
  - The path came back intact with a space and non-ASCII letters in it, which
    needs [Console]::OutputEncoding set to UTF-8: the console's code page
    mangles them on the way to node otherwise.
  Arguments, not -Command: -File hands each argument over whole, so a start
  folder with a quote or a space in it is a path and never source.
#>
param(
  [string]$Start = '',
  [string]$Title = 'Choose the folder your agent lives in'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace OrchDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] public class FileOpenDialogCoClass {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemArray {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
    void GetCount(out uint pdwNumItems);
    void GetItemAt(uint dwIndex, out IShellItem ppsi);
    void EnumItems(out IntPtr ppenumShellItems);
  }

  // IModalWindow::Show, then IFileDialog, then IFileOpenDialog, in vtable order.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IShellItemArray ppsai);
  }

  public static class Native {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    public static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  }

  public static class Dialog {
    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int ERROR_CANCELLED = unchecked((int)0x800704C7);
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x2;

    // A process that is not in front may not take the front (the foreground
    // lock), which is why a dialog from this host opened behind the browser.
    // Windows lets the next SetForegroundWindow through after input, and a
    // thread sharing the front window's input queue may set the front window:
    // an ALT tap and AttachThreadInput, then the call, then detach.
    public static void BringToFront(IntPtr hwnd) {
      uint fgPid;
      uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out fgPid);
      uint me = Native.GetCurrentThreadId();
      Native.keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      Native.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      bool attached = fgThread != 0 && fgThread != me && Native.AttachThreadInput(me, fgThread, true);
      Native.BringWindowToTop(hwnd);
      Native.SetForegroundWindow(hwnd);
      if (attached) Native.AttachThreadInput(me, fgThread, false);
    }

    // null when cancelled.
    public static string[] Show(IntPtr owner, string start, string title) {
      IFileOpenDialog d = (IFileOpenDialog)new FileOpenDialogCoClass();
      uint opts;
      d.GetOptions(out opts);
      d.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      if (!string.IsNullOrEmpty(title)) d.SetTitle(title);
      if (!string.IsNullOrEmpty(start)) {
        // A start folder that cannot be parsed opens the dialog wherever
        // Windows last left it, rather than failing the question.
        try {
          Guid iid = typeof(IShellItem).GUID;
          IShellItem si;
          Native.SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out si);
          d.SetFolder(si);
        } catch { }
      }
      int hr = d.Show(owner);
      if (hr == ERROR_CANCELLED) return null;
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      IShellItemArray results;
      d.GetResults(out results);
      uint n;
      results.GetCount(out n);
      string[] paths = new string[n];
      for (uint i = 0; i < n; i++) {
        IShellItem item;
        results.GetItemAt(i, out item);
        string p;
        item.GetDisplayName(SIGDN_FILESYSPATH, out p);
        paths[i] = p;
      }
      return paths;
    }
  }
}
'@

function Write-Answer($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 3))
}

try {
  # The owner: 1x1, transparent, out of the taskbar, always on top. The dialog
  # is drawn above every ordinary window because of it, and given the
  # keyboard because it is brought to the front first.
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.FormBorderStyle = 'None'
  $owner.StartPosition = 'Manual'
  $owner.Size = New-Object System.Drawing.Size(1, 1)
  $owner.Opacity = 0
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $owner.Location = New-Object System.Drawing.Point(($area.Left + [int]($area.Width / 2)), ($area.Top + [int]($area.Height / 3)))
  $owner.Show()
  [System.Windows.Forms.Application]::DoEvents()
  [OrchDialog.Dialog]::BringToFront($owner.Handle)
  $paths = [OrchDialog.Dialog]::Show($owner.Handle, $Start, $Title)
  $owner.Close()
  if ($null -eq $paths) { Write-Answer @{ cancelled = $true }; exit 0 }
  Write-Answer @{ path = $paths[0] }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
