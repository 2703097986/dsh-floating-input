using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DshFloatingInput;

internal static class Win32
{
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 0x0002;
    public const int HTLEFT = 0x000A;
    public const int HTRIGHT = 0x000B;
    public const int WM_HOTKEY = 0x0312;
    public const int WM_DSH_SHOW = 0x8001;
    public const int WM_DSH_TOGGLE = 0x8002;
    public const int SW_HIDE = 0;
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;

    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_SHIFT = 0x0004;
    public const uint MOD_WIN = 0x0008;
    public const uint MOD_NOREPEAT = 0x4000;

    public const uint VK_SPACE = 0x20;

    public const int DWMWA_CLOAK = 13;
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWCP_ROUND = 2;

    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string? className, string? windowName);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr updateRect, IntPtr updateRgn, uint flags);

    [DllImport("user32.dll")]
    public static extern bool UpdateWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);

    [DllImport("shell32.dll")]
    public static extern int SHQueryUserNotificationState(out int state);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("dwmapi.dll")]
    public static extern int DwmFlush();

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int Size;
        public RECT Monitor;
        public RECT Work;
        public uint Flags;
    }

    public static double ScaleForWindow(IntPtr hwnd)
    {
        try
        {
            if (hwnd != IntPtr.Zero)
            {
                var dpi = GetDpiForWindow(hwnd);
                if (dpi >= 48) return dpi / 96.0;
            }
        }
        catch { }
        return 1.0;
    }

    /// <summary>Monitor work area in WPF device-independent units.</summary>
    public static (double Left, double Top, double Width, double Height)? WorkAreaDip(IntPtr hwnd)
    {
        try
        {
            var monitor = hwnd != IntPtr.Zero
                ? MonitorFromWindow(hwnd, 2)
                : MonitorFromPoint(new POINT { X = 0, Y = 0 }, 2);
            if (monitor == IntPtr.Zero) return null;
            var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
            if (!GetMonitorInfo(monitor, ref info)) return null;
            var scale = ScaleForWindow(hwnd);
            var work = info.Work;
            return (work.Left / scale, work.Top / scale, (work.Right - work.Left) / scale, (work.Bottom - work.Top) / scale);
        }
        catch
        {
            return null;
        }
    }

    public static bool ActivateExistingWindow()
    {
        var handle = FindWindow(null, "DSH Floating Input");
        if (handle == IntPtr.Zero) return false;
        // Ask the WPF window to show itself.  Calling ShowWindow from another
        // process leaves WebView2's composition hidden, which renders black.
        return PostMessage(handle, WM_DSH_SHOW, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool ToggleExistingWindow()
    {
        var handle = FindWindow(null, "DSH Floating Input");
        if (handle == IntPtr.Zero) return false;
        return PostMessage(handle, WM_DSH_TOGGLE, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>Force a window to the foreground across the Windows foreground lock.</summary>
    public static void ForceForegroundWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out _);
        var currentThread = GetCurrentThreadId();
        var attached = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != currentThread)
            {
                attached = AttachThreadInput(currentThread, foregroundThread, true);
            }
            ShowWindow(hwnd, SW_SHOW);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    /// <summary>Show and focus the largest top-level window whose title contains the product name.</summary>
    public static bool IsMainWindowForeground(string titlePart)
    {
        var foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        var result = false;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                var title = new System.Text.StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().Contains(titlePart, StringComparison.OrdinalIgnoreCase)) return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                if (handle != foreground && GetAncestor(foreground, 2) != handle) return true;
                result = true;
                return false;
            }, IntPtr.Zero);
        }
        catch { }
        return result;
    }

    public static bool IsMainWindowOccluded(string titlePart, int helperPid)
    {
        var main = IntPtr.Zero;
        long bestArea = 0;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                var title = new System.Text.StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().Contains(titlePart, StringComparison.OrdinalIgnoreCase)) return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                var area = (long)width * height;
                if (area <= bestArea) return true;
                main = handle;
                bestArea = area;
                return true;
            }, IntPtr.Zero);
            if (main == IntPtr.Zero) return false;

            var occluded = false;
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                if (handle == main) return false;
                if (!IsWindowVisible(handle)) return true;
                GetWindowThreadProcessId(handle, out var pid);
                if (pid == (uint)helperPid) return true;
                var className = new System.Text.StringBuilder(128);
                GetClassName(handle, className, className.Capacity);
                var cls = className.ToString();
                if (cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd") return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                if (rect.Right - rect.Left < 400 || rect.Bottom - rect.Top < 300) return true;
                occluded = true;
                return false;
            }, IntPtr.Zero);
            return occluded;
        }
        catch
        {
            return false;
        }
    }

    public static bool IsMainWindowVisible(string titlePart)
    {
        var visible = false;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                var title = new System.Text.StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().Contains(titlePart, StringComparison.OrdinalIgnoreCase)) return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                if (IsWindowVisible(handle) && !IsIconic(handle))
                {
                    visible = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return visible;
    }

    public static bool ShowMainWindowByTitle(string titlePart)
    {
        var best = IntPtr.Zero;
        long bestArea = 0;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                var title = new System.Text.StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().Contains(titlePart, StringComparison.OrdinalIgnoreCase)) return true;
                if (!IsWindowVisible(handle) || IsIconic(handle))
                {
                    best = handle;
                    return false;
                }
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                var area = (long)width * height;
                if (area <= bestArea) return true;
                best = handle;
                bestArea = area;
                return true;
            }, IntPtr.Zero);
            if (best == IntPtr.Zero) return false;
            ShowAndFocus(best);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Show, repaint and focus a main window restored after an external SW_HIDE.</summary>
    private static void ShowAndFocus(IntPtr hwnd)
    {
        if (IsIconic(hwnd))
        {
            ShowWindow(hwnd, SW_RESTORE);
            System.Threading.Thread.Sleep(50);
        }
        var hidden = !IsWindowVisible(hwnd);
        var parked = false;
        RECT savedRect = default;
        if (hidden && !IsZoomed(hwnd) && GetWindowRect(hwnd, out var rect))
        {
            // Paint while off-screen, then move back.  Electron briefly paints
            // white after a hide/show cycle; parking avoids showing that frame.
            savedRect = rect;
            _ = SetWindowPos(hwnd, IntPtr.Zero, -20000, -20000, 0, 0, 0x0001 | 0x0004 | 0x0010);
            parked = true;
        }
        ShowWindow(hwnd, SW_RESTORE);
        ShowWindow(hwnd, SW_SHOW);
        if (parked)
        {
            System.Threading.Thread.Sleep(260);
            _ = SetWindowPos(hwnd, IntPtr.Zero, savedRect.Left, savedRect.Top, 0, 0, 0x0001 | 0x0004 | 0x0010);
        }
        if (GetWindowRect(hwnd, out var current))
        {
            var width = current.Right - current.Left;
            var height = current.Bottom - current.Top;
            // Nudge the size once so Chromium rebuilds its composition surface.
            _ = SetWindowPos(hwnd, IntPtr.Zero, current.Left, current.Top, width + 1, height, 0x0004 | 0x0010 | 0x0040);
            _ = SetWindowPos(hwnd, IntPtr.Zero, current.Left, current.Top, width, height, 0x0004 | 0x0010 | 0x0040);
        }
        ForceForegroundWindow(hwnd);
    }

    private static void SetCloaked(IntPtr hwnd, bool cloaked)
    {
        var value = cloaked ? 1 : 0;
        try
        {
            _ = DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, ref value, sizeof(int));
        }
        catch { }
    }

    /// <summary>Show and focus the largest top-level window owned by the Electron main process.</summary>
    public static IntPtr FindMainWindow(int processId, string titlePart)
    {
        var best = IntPtr.Zero;
        long bestArea = 0;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                GetWindowThreadProcessId(handle, out var owner);
                if (owner != (uint)processId) return true;
                var title = new System.Text.StringBuilder(512);
                GetWindowText(handle, title, title.Capacity);
                if (title.Length == 0 || !title.ToString().Contains(titlePart, StringComparison.OrdinalIgnoreCase)) return true;
                if (!IsWindowVisible(handle) || IsIconic(handle))
                {
                    best = handle;
                    return false;
                }
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                var area = (long)width * height;
                if (area <= bestArea) return true;
                best = handle;
                bestArea = area;
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return best;
    }

    public static void ShowWindowHandle(IntPtr hwnd)
    {
        if (hwnd != IntPtr.Zero) ShowAndFocus(hwnd);
    }

    public static bool ShowMainWindow(int processId)
    {
        var best = IntPtr.Zero;
        long bestArea = 0;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                GetWindowThreadProcessId(handle, out var owner);
                if (owner != (uint)processId) return true;
                if (!IsWindowVisible(handle) || IsIconic(handle))
                {
                    best = handle;
                    return false;
                }
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                var area = (long)width * height;
                if (area <= bestArea) return true;
                best = handle;
                bestArea = area;
                return true;
            }, IntPtr.Zero);
            if (best == IntPtr.Zero) return false;
            ShowAndFocus(best);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Minimize the largest top-level window owned by the Electron main process.</summary>
    public static bool MinimizeMainWindow(int processId)
    {
        var best = IntPtr.Zero;
        long bestArea = 0;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                _ = lParam;
                GetWindowThreadProcessId(handle, out var owner);
                if (owner != (uint)processId) return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                var area = (long)width * height;
                if (area <= bestArea) return true;
                best = handle;
                bestArea = area;
                return true;
            }, IntPtr.Zero);
            if (best == IntPtr.Zero) return false;
            ShowWindow(best, 6);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Hide every visible top-level window owned by the Electron main process.</summary>
    public static bool HideMainWindow(int processId)
    {
        var hidden = false;
        try
        {
            EnumWindows((handle, lParam) =>
            {
                if (!IsWindowVisible(handle)) return true;
                _ = lParam;
                GetWindowThreadProcessId(handle, out var owner);
                if (owner != (uint)processId) return true;
                if (!GetWindowRect(handle, out var rect)) return true;
                var width = rect.Right - rect.Left;
                var height = rect.Bottom - rect.Top;
                if (width < 400 || height < 300) return true;
                ShowWindow(handle, SW_HIDE);
                hidden = true;
                return true;
            }, IntPtr.Zero);
        }
        catch { }
        return hidden;
    }

    public static void ApplyWindowChrome(IntPtr hwnd, bool dark)
    {
        try
        {
            var preference = DWMWCP_ROUND;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
            var darkValue = dark ? 1 : 0;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref darkValue, sizeof(int));
        }
        catch
        {
            // Older Windows builds simply keep square corners and the light frame.
        }
    }
}
