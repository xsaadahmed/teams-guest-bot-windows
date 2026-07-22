import { execFile } from 'child_process';

export type UiWindowLayout = {
  width: number;
  height: number;
  /** Distance from left screen edge (px). */
  left?: number;
  /** Absolute Y from top of screen (px). Takes precedence over `bottom` when set. */
  top?: number;
  /** Distance from bottom screen edge (px). Used only when `top` is omitted. */
  bottom?: number;
  /** Keep above other apps (Teams-style floating control). */
  topmost?: boolean;
};

/** Once PowerShell spawn is blocked (corporate EPERM), stop retrying. */
let spawnBlocked = false;

function markSpawnBlocked(err: Error): void {
  const msg = err.message || String(err);
  if (/EPERM|spawn/i.test(msg)) {
    spawnBlocked = true;
  }
  console.warn('[uiWindow] Could not position UI window:', msg);
  if (spawnBlocked) {
    console.warn('[uiWindow] Disabling further window-layout attempts (use in-page mini overlay).');
  }
}

/**
 * Positions the Edge/Chrome "Meeting Assistant" app window.
 * Uses SWP_NOACTIVATE so it does not steal keyboard focus.
 * Prefer absolute `top` when restoring the full window; use `bottom` for the overlay.
 */
export function applyUiWindowLayout(layout: UiWindowLayout): void {
  if (process.platform !== 'win32') return;
  // After a spawn EPERM, skip further attempts (corporate policy) — UI uses in-page overlay.
  if (spawnBlocked) return;

  const left = Number.isFinite(layout.left) ? Math.round(layout.left as number) : 8;
  const topmost = layout.topmost === true ? 1 : 0;
  const { width, height } = layout;
  const hasTop = layout.top != null && Number.isFinite(layout.top);
  const top = hasTop ? Math.round(layout.top as number) : -1;
  const bottom = Number.isFinite(layout.bottom) ? Math.round(layout.bottom as number) : 8;

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
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_FRAMECHANGED = 0x0020;

  static bool TitleMatch(string t) {
    if (string.IsNullOrEmpty(t)) return false;
    return t.IndexOf("Meeting Assi", StringComparison.OrdinalIgnoreCase) >= 0
        || t.IndexOf("e& Meeting", StringComparison.OrdinalIgnoreCase) >= 0
        || t.IndexOf("localhost:3000", StringComparison.OrdinalIgnoreCase) >= 0
        || t.IndexOf("127.0.0.1:3000", StringComparison.OrdinalIgnoreCase) >= 0;
  }

  static bool IsChromeFamily(string cls) {
    return cls.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) >= 0
        || cls.IndexOf("Chrome_WindowImpl", StringComparison.OrdinalIgnoreCase) >= 0;
  }

  public static List<long> FindCandidates() {
    var list = new List<long>();
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h)) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      var t = title.ToString();
      if (!TitleMatch(t)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      // Prefer real browser top-level windows; still accept title match as fallback.
      list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static long PreferForeground(List<long> ids) {
    if (ids == null || ids.Count == 0) return 0;
    IntPtr fg = GetForegroundWindow();
    long fgId = fg.ToInt64();
    foreach (var id in ids) {
      if (id == fgId) return id;
    }
    // Foreground might be our Edge app even if title enum missed it — use FG when Chrome-like.
    if (fg != IntPtr.Zero) {
      var cls = new StringBuilder(256);
      GetClassName(fg, cls, cls.Capacity);
      var title = new StringBuilder(512);
      GetWindowText(fg, title, title.Capacity);
      if (IsChromeFamily(cls.ToString()) && (TitleMatch(title.ToString()) || ids.Count == 0))
        return fgId;
    }
    // Pick the window that is already closest to our target size, else first.
    return ids[0];
  }
}
"@
$w = ${width}; $h = ${height}; $left = ${left}; $bottom = ${bottom}; $top = ${top}; $topmost = ${topmost}
# Use the working area (excludes taskbar) so the overlay sits on the visible bottom of the screen.
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($top -ge 0) {
  $y = $top
  $x = $left
} else {
  $x = $wa.Left + $left
  $y = [Math]::Max($wa.Top, $wa.Bottom - $h - $bottom)
}
$ids = [UiWin]::FindCandidates()
$target = [UiWin]::PreferForeground($ids)
if ($target -eq 0) {
  # Last resort: if foreground is an Edge/Chrome window, move that.
  $fg = [UiWin]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][UiWin]::GetClassName($fg, $cls, $cls.Capacity)
    if ($cls.ToString() -match 'Chrome_WidgetWin') { $target = $fg.ToInt64() }
  }
}
if ($target -eq 0) { Write-Output "moved:0"; return }
$after = if ($topmost -eq 1) { [UiWin]::HWND_TOPMOST } else { [UiWin]::HWND_NOTOPMOST }
$flags = [UiWin]::SWP_NOACTIVATE -bor [UiWin]::SWP_SHOWWINDOW -bor [UiWin]::SWP_FRAMECHANGED
$hw = [IntPtr]$target
# Clear/set topmost and resize in two steps — more reliable on Edge --app windows.
[void][UiWin]::SetWindowPos($hw, $after, $x, $y, $w, $h, $flags)
if ($topmost -eq 0) {
  # Ensure we are not stuck always-on-top (fixes Alt+Tab feeling "locked").
  [void][UiWin]::SetWindowPos($hw, [UiWin]::HWND_NOTOPMOST, $x, $y, $w, $h, $flags)
}
Write-Output ("moved:1 hwnd=" + $target + " topmost=" + $topmost + " " + $w + "x" + $h + "@" + $x + "," + $y)
`;

  try {
    execFile(
      'powershell',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) {
          markSpawnBlocked(err);
          return;
        }
        const out = String(stdout || '').trim();
        if (out) console.log('[uiWindow]', out);
      },
    );
  } catch (err) {
    markSpawnBlocked(err as Error);
  }
}
