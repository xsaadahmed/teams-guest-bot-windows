using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// Dismiss Chromium's native "Open ms-teams.exe?" protocol bubble via Win32.
// Never send Escape to the Teams page — only to the small native prompt window.
// Port of windows/dismiss-ms-teams-dialog.ps1 — no PowerShell at runtime.

internal static class Native
{
    internal delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    internal delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    internal const int BmClick = 0x00F5;

    [DllImport("user32.dll")]
    internal static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool EnumChildWindows(IntPtr hWnd, EnumChildProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    internal static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr FindWindow(string? cls, string? title);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

internal static class Program
{
    private static readonly string[] ChromeTitlePatterns =
        ["Microsoft Teams", "teams.live.com", "Chromium", "Chrome"];

    private static readonly string[] PromptTitles =
    [
        "Open ms-teams.exe?",
        "Open Microsoft Teams",
    ];

    private static int Main(string[] args)
    {
        var retries = 5;
        if (args.Length > 0 && int.TryParse(args[0], out var parsed) && parsed > 0)
        {
            retries = parsed;
        }

        for (var i = 0; i < retries; i++)
        {
            if (ClickCancelOnPromptWindow()) return 0;
            if (DismissViaTitleWindow()) return 0;

            var chrome = FindChromeWindow();
            if (chrome != IntPtr.Zero)
            {
                Native.SetForegroundWindow(chrome);
                Thread.Sleep(120);
                if (ClickCancelOnPromptWindow()) return 0;
            }

            Thread.Sleep(500);
        }

        return 1;
    }

    private static bool ClickCancelOnPromptWindow()
    {
        var found = false;
        Native.EnumWindows(
            (hWnd, _) =>
            {
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (!WindowTitleMatchesPrompt(hWnd)) return true;

                Native.SetForegroundWindow(hWnd);
                Thread.Sleep(80);
                if (ClickCancelButton(hWnd))
                {
                    found = true;
                    return false;
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    private static bool WindowTitleMatchesPrompt(IntPtr hWnd)
    {
        var title = GetWindowText(hWnd);
        if (PromptTitles.Any(p => title.Contains(p, StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return title.Contains("teams.live.com wants to open", StringComparison.OrdinalIgnoreCase)
            || title.Contains("teams.microsoft.com wants to open", StringComparison.OrdinalIgnoreCase)
            || title.Contains("ms-teams", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ClickCancelButton(IntPtr root)
    {
        IntPtr cancel = IntPtr.Zero;
        Native.EnumChildWindows(
            root,
            (hWnd, _) =>
            {
                var cls = GetClassName(hWnd);
                if (!cls.Equals("Button", StringComparison.OrdinalIgnoreCase)) return true;

                var text = GetWindowText(hWnd);
                if (text.Equals("Cancel", StringComparison.OrdinalIgnoreCase))
                {
                    cancel = hWnd;
                    return false;
                }

                return true;
            },
            IntPtr.Zero);

        if (cancel == IntPtr.Zero) return false;

        Native.SendMessage(cancel, Native.BmClick, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    private static bool DismissViaTitleWindow()
    {
        foreach (var title in PromptTitles)
        {
            var hwnd = Native.FindWindow(null, title);
            if (hwnd == IntPtr.Zero) continue;

            Native.SetForegroundWindow(hwnd);
            Thread.Sleep(120);
            if (ClickCancelButton(hwnd)) return true;

            SendKeys.SendWait("{ESC}");
            return true;
        }

        return false;
    }

    private static IntPtr FindChromeWindow()
    {
        IntPtr match = IntPtr.Zero;
        Native.EnumWindows(
            (hWnd, _) =>
            {
                if (!Native.IsWindowVisible(hWnd)) return true;

                var title = GetWindowText(hWnd);
                if (ChromeTitlePatterns.Any(p => title.Contains(p, StringComparison.OrdinalIgnoreCase)))
                {
                    match = hWnd;
                    return false;
                }

                return true;
            },
            IntPtr.Zero);

        return match;
    }

    private static string GetWindowText(IntPtr hWnd)
    {
        var sb = new StringBuilder(512);
        _ = Native.GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string GetClassName(IntPtr hWnd)
    {
        var sb = new StringBuilder(256);
        _ = Native.GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
