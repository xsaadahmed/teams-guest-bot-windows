using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

// Dismiss Chromium's native "Open ms-teams.exe?" protocol bubble.
// Uses UI Automation (modern Chromium Views) with Win32 + Escape fallbacks.
// Optional argv: one or more Chromium PIDs (browser PID from CDP is enough — we expand the process tree).

internal static class Native
{
    internal delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    internal delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    internal const uint Th32csnapProcess = 0x00000002;
    internal const int BmClick = 0x00F5;
    internal const uint WmKeydown = 0x0100;
    internal const uint WmKeyup = 0x0101;
    internal const int VkEscape = 0x1B;

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool Process32First(IntPtr hSnapshot, ref ProcessEntry32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool Process32Next(IntPtr hSnapshot, ref ProcessEntry32 lppe);

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr FindWindow(string? cls, string? title);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct ProcessEntry32
    {
        public uint DwSize;
        public uint CntUsage;
        public uint Th32ProcessId;
        public IntPtr Th32DefaultHeapId;
        public uint Th32ModuleId;
        public uint CntThreads;
        public uint Th32ParentProcessId;
        public int PcPriClassBase;
        public uint DwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string SzExeFile;
    }
}

internal static class Program
{
    private static readonly string[] PromptTitleFragments =
    [
        "Open ms-teams.exe?",
        "Open Microsoft Teams",
        "wants to open this application",
        "wants to open",
        "ms-teams",
        "msteams",
    ];

    private static readonly HashSet<uint> ChromePids = [];

    private static int Main(string[] args)
    {
        foreach (var arg in args)
        {
            if (uint.TryParse(arg, out var pid) && pid > 0)
            {
                ExpandProcessTree(pid);
            }
        }

        const int retries = 10;
        for (var i = 0; i < retries; i++)
        {
            if (TryDismiss()) return 0;
            Thread.Sleep(350);
        }

        return 1;
    }

    private static void ExpandProcessTree(uint rootPid)
    {
        var snapshot = Native.CreateToolhelp32Snapshot(Native.Th32csnapProcess, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
        {
            ChromePids.Add(rootPid);
            return;
        }

        try
        {
            var entries = new List<(uint Pid, uint Parent)>();
            var entry = new Native.ProcessEntry32 { DwSize = (uint)Marshal.SizeOf<Native.ProcessEntry32>() };
            if (Native.Process32First(snapshot, ref entry))
            {
                do
                {
                    entries.Add((entry.Th32ProcessId, entry.Th32ParentProcessId));
                } while (Native.Process32Next(snapshot, ref entry));
            }

            var queue = new Queue<uint>();
            queue.Enqueue(rootPid);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (!ChromePids.Add(current)) continue;
                foreach (var (pid, parent) in entries)
                {
                    if (parent == current) queue.Enqueue(pid);
                }
            }
        }
        finally
        {
            _ = Native.CloseHandle(snapshot);
        }
    }

    private static bool TryDismiss()
    {
        if (TryDismissViaUIA()) return true;
        if (TryDismissViaWin32()) return true;
        return false;
    }

    private static bool TryDismissViaUIA()
    {
        var found = false;
        try
        {
            var root = AutomationElement.RootElement;
            var windows = root.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement window in windows)
            {
                if (TryDismissElement(window)) found = true;
            }

            // Some Chromium prompts are nested under the browser window, not top-level.
            foreach (AutomationElement window in windows)
            {
                try
                {
                    if (!BelongsToChromeProcess(window.Current.ProcessId)) continue;
                    var descendants = window.FindAll(
                        TreeScope.Descendants,
                        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
                    foreach (AutomationElement child in descendants)
                    {
                        if (TryDismissElement(child)) found = true;
                    }
                }
                catch
                {
                    // element went stale
                }
            }
        }
        catch
        {
            // UIA unavailable in rare locked-down environments
        }

        return found;
    }

    private static bool TryDismissElement(AutomationElement element)
    {
        string name;
        int pid;
        try
        {
            name = element.Current.Name ?? "";
            pid = element.Current.ProcessId;
        }
        catch
        {
            return false;
        }

        if (!LooksLikePromptTitle(name)) return false;
        if (!BelongsToChromeProcess((uint)pid) && !IsExactProtocolTitle(name)) return false;

        if (InvokeCancelButton(element)) return true;

        try
        {
            var hwnd = (IntPtr)element.Current.NativeWindowHandle;
            if (hwnd != IntPtr.Zero)
            {
                if (ClickCancelButtonWin32(hwnd)) return true;
                if (SendEscape(hwnd)) return true;
            }
        }
        catch
        {
            // ignore
        }

        return false;
    }

    private static bool TryDismissViaWin32()
    {
        foreach (var title in new[] { "Open ms-teams.exe?", "Open Microsoft Teams" })
        {
            var hwnd = Native.FindWindow(null, title);
            if (hwnd == IntPtr.Zero) continue;
            if (!BelongsToChromeProcess(hwnd) && title != "Open ms-teams.exe?") continue;
            if (ClickCancelButtonWin32(hwnd)) return true;
            if (SendEscape(hwnd)) return true;
        }

        var found = false;
        Native.EnumWindows(
            (hWnd, _) =>
            {
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (!BelongsToChromeProcess(hWnd) && !WindowLooksLikePrompt(hWnd)) return true;

                if (WindowLooksLikePrompt(hWnd) || WindowContainsPromptText(hWnd))
                {
                    if (ClickCancelButtonWin32(hWnd) || SendEscape(hWnd))
                    {
                        found = true;
                        return false;
                    }
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    private static bool BelongsToChromeProcess(uint pid)
    {
        if (ChromePids.Count == 0) return true;
        return ChromePids.Contains(pid);
    }

    private static bool BelongsToChromeProcess(IntPtr hWnd)
    {
        Native.GetWindowThreadProcessId(hWnd, out var pid);
        return BelongsToChromeProcess(pid);
    }

    private static bool IsExactProtocolTitle(string title) =>
        title.Equals("Open ms-teams.exe?", StringComparison.OrdinalIgnoreCase);

    private static bool LooksLikePromptTitle(string title) =>
        PromptTitleFragments.Any(f => title.Contains(f, StringComparison.OrdinalIgnoreCase));

    private static bool WindowLooksLikePrompt(IntPtr hWnd)
    {
        var title = ReadWindowText(hWnd);
        return LooksLikePromptTitle(title);
    }

    private static bool WindowContainsPromptText(IntPtr hWnd)
    {
        var found = false;
        Native.EnumChildWindows(
            hWnd,
            (child, _) =>
            {
                var text = ReadWindowText(child);
                if (LooksLikePromptTitle(text))
                {
                    found = true;
                    return false;
                }

                return true;
            },
            IntPtr.Zero);
        return found;
    }

    private static bool InvokeCancelButton(AutomationElement root)
    {
        foreach (AutomationElement btn in root.FindAll(
                     TreeScope.Descendants,
                     new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
        {
            string name;
            try
            {
                name = btn.Current.Name ?? "";
            }
            catch
            {
                continue;
            }

            if (!name.Contains("Cancel", StringComparison.OrdinalIgnoreCase)) continue;
            if (!btn.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern)) continue;
            ((InvokePattern)pattern).Invoke();
            return true;
        }

        return false;
    }

    private static bool ClickCancelButtonWin32(IntPtr root)
    {
        IntPtr cancel = IntPtr.Zero;
        EnumButtonsRecursive(
            root,
            (hWnd, text) =>
            {
                if (text.Contains("Cancel", StringComparison.OrdinalIgnoreCase))
                {
                    cancel = hWnd;
                    return false;
                }

                return true;
            });

        if (cancel == IntPtr.Zero) return false;

        Native.SendMessage(cancel, Native.BmClick, IntPtr.Zero, IntPtr.Zero);
        return true;
    }

    private static void EnumButtonsRecursive(IntPtr root, Func<IntPtr, string, bool> visitor)
    {
        Native.EnumChildWindows(
            root,
            (hWnd, _) =>
            {
                var cls = ReadClassName(hWnd);
                if (cls.Equals("Button", StringComparison.OrdinalIgnoreCase))
                {
                    var text = ReadWindowText(hWnd);
                    if (!visitor(hWnd, text)) return false;
                }

                EnumButtonsRecursive(hWnd, visitor);
                return true;
            },
            IntPtr.Zero);
    }

    private static bool SendEscape(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        _ = Native.PostMessage(hwnd, Native.WmKeydown, (IntPtr)Native.VkEscape, IntPtr.Zero);
        _ = Native.PostMessage(hwnd, Native.WmKeyup, (IntPtr)Native.VkEscape, IntPtr.Zero);
        return true;
    }

    private static string ReadWindowText(IntPtr hWnd)
    {
        var sb = new StringBuilder(512);
        _ = Native.GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string ReadClassName(IntPtr hWnd)
    {
        var sb = new StringBuilder(256);
        _ = Native.GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
