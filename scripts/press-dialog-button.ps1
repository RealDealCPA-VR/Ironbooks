# Press a button in one of Ironbooks' native message boxes, for the desktop end-to-end tests
# (scripts/e2e-helpers.mjs). Uses Microsoft Active Accessibility's default action, the way screen
# readers press buttons: no mouse, no keyboard, no need for the window to be in front, and only
# windows of the given Ironbooks executable are searched — never another program's.
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$TimeoutSec = 40
)

Add-Type -ReferencedAssemblies 'Accessibility' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;

public static class IbDialogButton {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible container, int start, int count, [Out] object[] children, out int obtained);

  static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  const uint OBJID_CLIENT = 0xFFFFFFFC;

  static bool PressIn(IAccessible acc, string name, int depth) {
    if (acc == null || depth > 14) return false;
    int count;
    try { count = acc.accChildCount; } catch { return false; }
    if (count <= 0) return false;
    var kids = new object[count];
    int got;
    if (AccessibleChildren(acc, 0, count, kids, out got) != 0) return false;
    for (int i = 0; i < got; i++) {
      var child = kids[i] as IAccessible;
      if (child != null) {
        string n = null;
        try { n = child.get_accName(0); } catch { }
        if (n == name) { try { child.accDoDefaultAction(0); return true; } catch { } }
        if (PressIn(child, name, depth + 1)) return true;
      } else if (kids[i] is int) {
        int id = (int)kids[i];
        string n = null;
        try { n = acc.get_accName(id); } catch { }
        if (n == name) { try { acc.accDoDefaultAction(id); return true; } catch { } }
      }
    }
    return false;
  }

  /** Press the button named `name` in a visible window of one of `pids`. */
  public static bool Press(uint[] pids, string name) {
    var set = new HashSet<uint>(pids);
    var hwnds = new List<IntPtr>();
    EnumProc collect = (h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) hwnds.Add(h);
      return true;
    };
    EnumWindows(collect, IntPtr.Zero);
    foreach (var top in hwnds.ToArray()) EnumChildWindows(top, collect, IntPtr.Zero);
    foreach (var h in hwnds) {
      object obj;
      var iid = IID_IAccessible;
      if (AccessibleObjectFromWindow(h, OBJID_CLIENT, ref iid, out obj) != 0) continue;
      if (PressIn(obj as IAccessible, name, 0)) return true;
    }
    return false;
  }
}
'@

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $pids = [uint32[]]@(Get-Process -Name Ironbooks -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath } | ForEach-Object { $_.Id })
  if ($pids.Count -gt 0 -and [IbDialogButton]::Press($pids, $Name)) { 'pressed'; exit 0 }
  Start-Sleep -Milliseconds 500
}
'notfound'
exit 1
