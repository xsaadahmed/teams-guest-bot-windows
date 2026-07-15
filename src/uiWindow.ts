import { execFile } from 'child_process';

export type UiWindowLayout = {
  width: number;
  height: number;
  /** Distance from left screen edge (px). */
  left?: number;
  /** Distance from bottom screen edge (px). */
  bottom?: number;
  /** Keep above other apps (Teams-style floating control). */
  topmost?: boolean;
};

/**
 * Positions the Edge/Chrome "Meeting Assistant" app window at bottom-left and optionally
 * pins it HWND_TOPMOST. Uses SWP_NOACTIVATE so it does not steal keyboard focus.
 */
export function applyUiWindowLayout(layout: UiWindowLayout): void {
  if (process.platform !== 'win32') return;

  const left = layout.left ?? 8;
  const bottom = layout.bottom ?? 8;
  const topmost = layout.topmost !== false ? 1 : 0;
  const { width, height } = layout;

  const script = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class UiWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public static List<long> Find(string needle) {
    var list = new List<long>();
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var t = sb.ToString();
      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$w = ${width}; $h = ${height}; $left = ${left}; $bottom = ${bottom}; $topmost = ${topmost}
$screenH = [UiWin]::GetSystemMetrics(1)
$y = [Math]::Max(0, $screenH - $h - $bottom)
$ids = [UiWin]::Find("Meeting Assi")
if ($ids.Count -eq 0) { $ids = [UiWin]::Find("localhost:3000") }
$after = if ($topmost -eq 1) { [UiWin]::HWND_TOPMOST } else { [UiWin]::HWND_NOTOPMOST }
$flags = [UiWin]::SWP_NOACTIVATE -bor [UiWin]::SWP_SHOWWINDOW
foreach ($id in $ids) {
  $hw = [IntPtr]$id
  [void][UiWin]::SetWindowPos($hw, $after, $left, $y, $w, $h, $flags)
}
Write-Output ("moved:" + $ids.Count)
`;

  execFile(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err) {
        console.warn('[uiWindow] Could not position UI window:', err.message);
        return;
      }
      const out = String(stdout || '').trim();
      if (out) console.log('[uiWindow]', out);
    },
  );
}
