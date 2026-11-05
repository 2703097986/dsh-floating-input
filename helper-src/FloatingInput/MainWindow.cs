using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Forms = System.Windows.Forms;
using Application = System.Windows.Application;
using Clipboard = System.Windows.Clipboard;
using Color = System.Windows.Media.Color;
using MessageBox = System.Windows.MessageBox;

namespace DshFloatingInput;

internal sealed class MainWindow : Window
{
    private const int HotkeyId = 0x4453;
    private const int HideHotkeyId = 0x4454;
    private const double CollapsedHeight = 98;
    private const double MinWindowWidth = 560;
    private const double MaxWindowWidth = 1100;
    private const double MinWindowHeight = 98;
    private const double MinCollapsedHeight = 42;
    private const double MaxWindowHeight = 940;

    private readonly LaunchOptions _options;
    private readonly WindowSettings _settings;
    private readonly WebView2 _webView = new();
    private readonly DispatcherTimer _saveTimer;
    private RechargeWindow? _rechargeWindow;

    private readonly DispatcherTimer? _watchdog;

    private HwndSource? _source;
    private IntPtr _hwnd;
    private bool _reallyClosing;
    private bool _suppressSave;
    private bool _webReady;
    private bool _isDark;
    private int _loadRetries;
    private string _resizeEdge = "right";
    private bool _resizeHorizontal;
    private bool _expandUp;
    private bool _collapsed;
    private DateTime _lastDesktopToggle;
    private DateTime _suppressPageReturnUntil;
    private IntPtr _mainWindow;
    private bool _desktopParked;
    private Win32.RECT _desktopParkedRect;
    private string _dock = "float";
    private double _freeLeft = double.NaN;
    private double _freeTop = double.NaN;
    private double _expandedHeight;
    private double _expandedTop = double.NaN;
    private double _resizeStartWidth;
    private double _resizeLeft;
    private double _resizeRight;

    public MainWindow(LaunchOptions options)
    {
        _options = options;
        _settings = WindowSettings.Load();
        _isDark = true;

        Title = "DSH Floating Input";
        Width = Math.Clamp(_settings.Width, MinWindowWidth, MaxWindowWidth);
        Height = CollapsedHeight;
        MinWidth = MinWindowWidth;
        MaxWidth = MaxWindowWidth;
        MinHeight = MinCollapsedHeight;
        MaxHeight = MaxWindowHeight;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = false;
        ShowInTaskbar = false;
        Topmost = _settings.Pinned;
        WindowStartupLocation = WindowStartupLocation.Manual;
        SnapsToDevicePixels = true;
        UseLayoutRounding = true;
        Background = new SolidColorBrush(Color.FromRgb(13, 14, 16));
        Foreground = new SolidColorBrush(Color.FromRgb(240, 241, 243));

        _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 13, 14, 16);
        _webView.HorizontalAlignment = System.Windows.HorizontalAlignment.Stretch;
        _webView.VerticalAlignment = System.Windows.VerticalAlignment.Stretch;
        Content = _webView;

        _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(550) };
        _saveTimer.Tick += (_, _) =>
        {
            _saveTimer.Stop();
            PersistWindow();
        };

        if (options.ParentPid > 0)
        {
            _watchdog = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _watchdog.Tick += (_, _) => CheckParent();
            _watchdog.Start();
        }

        Loaded += OnLoaded;
        SourceInitialized += OnSourceInitialized;
        LocationChanged += (_, _) => ScheduleSave();
        SizeChanged += (_, _) => ScheduleSave();
        Closing += OnClosing;
        Closed += OnClosed;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        _ = InitializeWebViewAsync();
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        _source = HwndSource.FromHwnd(_hwnd);
        _source?.AddHook(WndProc);
        RestorePosition();
        Win32.ApplyWindowChrome(_hwnd, _isDark);
        try
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            var screen = Forms.Screen.FromHandle(_hwnd);
            var area = CurrentWorkArea();
            Log($"window dpi={dpi.DpiScaleX:0.##} winDpi={Win32.GetDpiForWindow(_hwnd)} screen={screen.Bounds} work={screen.WorkingArea} area={area.Left:0},{area.Top:0},{area.Width:0}x{area.Height:0} h={Height:0} at={Left:0},{Top:0}");
        }
        catch { }
        RegisterConfiguredHotkey();
    }

    private void RegisterConfiguredHotkey()
    {
        if (_hwnd == IntPtr.Zero) return;
        Win32.UnregisterHotKey(_hwnd, HotkeyId);
        Win32.UnregisterHotKey(_hwnd, HideHotkeyId);
        if (!TryParseHotkey(_settings.Hotkey, out var modifiers, out var virtualKey))
        {
            _settings.Hotkey = "Ctrl+Alt+Space";
            modifiers = Win32.MOD_CONTROL | Win32.MOD_ALT;
            virtualKey = Win32.VK_SPACE;
        }
        if (!Win32.RegisterHotKey(_hwnd, HotkeyId, modifiers | Win32.MOD_NOREPEAT, virtualKey))
        {
            Log($"global hotkey {_settings.Hotkey} is unavailable");
        }
        if (!TryParseHotkey(_settings.HideHotkey, out var hideModifiers, out var hideVirtualKey))
        {
            _settings.HideHotkey = "Ctrl+Alt+H";
            hideModifiers = Win32.MOD_CONTROL | Win32.MOD_ALT;
            hideVirtualKey = (uint)KeyInterop.VirtualKeyFromKey(Key.H);
        }
        if (!Win32.RegisterHotKey(_hwnd, HideHotkeyId, hideModifiers | Win32.MOD_NOREPEAT, hideVirtualKey))
        {
            Log($"hide hotkey {_settings.HideHotkey} is unavailable");
        }
    }

    private static bool TryParseHotkey(string value, out uint modifiers, out uint virtualKey)
    {
        modifiers = 0;
        virtualKey = 0;
        var parts = (value ?? "").Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        string? keyName = null;
        foreach (var part in parts)
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl":
                case "control":
                    modifiers |= Win32.MOD_CONTROL;
                    break;
                case "alt":
                    modifiers |= Win32.MOD_ALT;
                    break;
                case "shift":
                    modifiers |= Win32.MOD_SHIFT;
                    break;
                case "win":
                    modifiers |= Win32.MOD_WIN;
                    break;
                default:
                    keyName = part;
                    break;
            }
        }
        if (string.IsNullOrWhiteSpace(keyName) || modifiers == 0) return false;
        try
        {
            var converted = new KeyConverter().ConvertFromString(keyName);
            if (converted is not Key key) return false;
            var vk = KeyInterop.VirtualKeyFromKey(key);
            if (vk == 0) return false;
            virtualKey = (uint)vk;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSHFloatingInput",
                "WebView2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await _webView.EnsureCoreWebView2Async(environment);

            var core = _webView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;

            _webReady = true;
            core.Navigate(_options.Url);
        }
        catch (Exception error)
        {
            Log("WebView2 initialization failed: " + error);
            MessageBox.Show(
                "鏃犳硶鍒濆鍖?WebView2 杩愯鏃躲€俓n\n璇峰畨瑁?Microsoft Edge WebView2 Runtime 鍚庨噸璇曘€俓n\n" + error.Message,
                "DeepSeek Harness 鎮诞杈撳叆",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            ReallyClose();
        }
    }

    private async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            _loadRetries = 0;
            PostHostState();
            return;
        }

        if (_loadRetries < 12)
        {
            _loadRetries++;
            await Task.Delay(700);
            if (_reallyClosing) return;
            try { _webView.CoreWebView2?.Navigate(_options.Url); } catch { }
            return;
        }

        Log("navigation failed: " + e.WebErrorStatus);
        try
        {
            _webView.NavigateToString(
                "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
                "html,body{height:100%;margin:0;background:#f7f9fc;color:#142033;font:13px 'Segoe UI','Microsoft YaHei UI',sans-serif}" +
                "body{display:flex;align-items:center;justify-content:center;text-align:center}" +
                ".box{padding:20px}.t{font-weight:650;font-size:14px;margin-bottom:6px}.s{color:#7c8798;font-size:12px}" +
                "</style></head><body><div class=\"box\"><div class=\"t\">鏆傛椂鏃犳硶杩炴帴 DeepSeek Harness</div>" +
                "<div class=\"s\">鎮诞绐椾細鍦?DSH 鍚姩瀹屾垚鍚庤嚜鍔ㄩ噸璇曘€?/div></div></body></html>");
        }
        catch { }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        OpenExternal(e.Uri);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
            switch (type)
            {
                case "resize":
                {
                    var height = root.TryGetProperty("height", out var h) && h.TryGetDouble(out var hv) ? hv : Height;
                    var width = root.TryGetProperty("width", out var w) && w.TryGetDouble(out var wv) ? wv : Width;
                    var direction = root.TryGetProperty("direction", out var dir) ? dir.GetString() : null;
                    var collapsed = root.TryGetProperty("collapsed", out var collapsedFlag) && collapsedFlag.ValueKind == JsonValueKind.True;
                    Dispatcher.Invoke(() => ApplyContentSize(width, height, string.Equals(direction, "up", StringComparison.OrdinalIgnoreCase), collapsed));
                    break;
                }
                case "drag":
                    Dispatcher.Invoke(BeginDrag);
                    break;
                case "pin":
                {
                    var pinned = root.TryGetProperty("value", out var p) && p.ValueKind == JsonValueKind.True;
                    Dispatcher.Invoke(() => SetPinned(pinned));
                    break;
                }
                case "resize-start":
                {
                    var edges = root.TryGetProperty("edges", out var edgeValue) ? edgeValue.GetString() : null;
                    Dispatcher.Invoke(() => BeginResize(edges));
                    break;
                }
                case "window-resize":
                {
                    var dx = root.TryGetProperty("dx", out var d) && d.TryGetDouble(out var value) ? value : 0;
                    Dispatcher.Invoke(() => ApplyResize(dx));
                    break;
                }
                case "resize-end":
                    Dispatcher.Invoke(() => ScheduleSave());
                    break;
                case "collapse":
                    Dispatcher.Invoke(CollapseWindow);
                    break;
                case "expand":
                    Dispatcher.Invoke(ExpandWindow);
                    break;
                case "hotkey":
                    if (root.TryGetProperty("value", out var hotkeyValue) && hotkeyValue.GetString() is { Length: > 0 } hotkey)
                    {
                        var target = root.TryGetProperty("target", out var targetValue) ? targetValue.GetString() : null;
                        if (target == "hide") _settings.HideHotkey = hotkey;
                        else _settings.Hotkey = hotkey;
                        _settings.Save();
                        Dispatcher.BeginInvoke(new Action(RegisterConfiguredHotkey));
                    }
                    break;
                case "prefs":
                    if (root.TryGetProperty("expandUp", out var expandPref)) _settings.ExpandUp = expandPref.ValueKind == JsonValueKind.True;
                    if (root.TryGetProperty("dock", out var dockPref)) _settings.Dock = dockPref.GetString() is "center" or "left" ? dockPref.GetString()! : "float";
                    if (root.TryGetProperty("fontScale", out var fontPref) && fontPref.TryGetDouble(out var fontValue)) _settings.FontScale = Math.Clamp(fontValue, 0.8, 1.5);
                    if (root.TryGetProperty("hotkey", out var hotkeyPref) && hotkeyPref.GetString() is { Length: > 0 } hotkeyPrefValue) _settings.Hotkey = hotkeyPrefValue;
                    if (root.TryGetProperty("hideHotkey", out var hideHotkeyPref) && hideHotkeyPref.GetString() is { Length: > 0 } hideHotkeyValue) _settings.HideHotkey = hideHotkeyValue;
                    if (root.TryGetProperty("extraPrompt", out var promptPref)) _settings.ExtraPrompt = promptPref.GetString() ?? "";
                    _settings.Save();
                    Dispatcher.BeginInvoke(new Action(RegisterConfiguredHotkey));
                    break;
                case "settings":
                    var dock = root.TryGetProperty("dock", out var dockValue) ? dockValue.GetString() : null;
                    var nextDock = dock is "center" or "left" ? dock : "float";
                    if (_dock == "float" && nextDock != "float")
                    {
                        _freeLeft = Left;
                        _freeTop = Top;
                    }
                    _dock = nextDock;
                    if (_dock == "float" && double.IsFinite(_freeLeft) && double.IsFinite(_freeTop))
                    {
                        Left = _freeLeft;
                        Top = _freeTop;
                    }
                    Dispatcher.BeginInvoke(new Action(PositionDocked));
                    break;
                case "hide":
                case "minimize":
                case "close":
                    Dispatcher.Invoke(HideWidget);
                    break;
                case "return":
                    Dispatcher.Invoke(OnPageReturn);
                    break;
                case "quit":
                    Dispatcher.Invoke(ReallyClose);
                    break;
                case "ready":
                    PostHostState();
                    break;
                case "open-recharge":
                    var rechargeAnchor = ReadRechargeAnchor(root);
                    Dispatcher.Invoke(() => OpenRechargeWindow(rechargeAnchor));
                    break;
                case "open-external":
                    if (root.TryGetProperty("url", out var url) && url.GetString() is { } external)
                    {
                        OpenExternal(external);
                    }
                    break;
                case "copy":
                    if (root.TryGetProperty("text", out var text) && text.GetString() is { Length: > 0 } copyText)
                    {
                        Dispatcher.Invoke(() => Clipboard.SetText(copyText));
                    }
                    break;
            }
        }
        catch (Exception error)
        {
            Log("web message failed: " + error.Message);
        }
    }

    private void ApplyContentSize(double width, double height, bool expandUp, bool autoCollapsed)
    {
        if (_reallyClosing) return;
        if (_collapsed)
        {
            Width = Math.Clamp(width, MinWindowWidth, MaxWindowWidth);
            ApplyCollapsedHeight();
            return;
        }
        var newWidth = Math.Clamp(width, MinWindowWidth, MaxWindowWidth);
        var newHeight = Math.Clamp(height, autoCollapsed ? MinCollapsedHeight : MinWindowHeight, MaxWindowHeight);
        var bottom = Top + Height;
        var top = expandUp ? bottom - newHeight : Top;
        _expandUp = expandUp;
        var area = CurrentWorkArea();

        _suppressSave = true;
        try
        {
            if (Math.Abs(newWidth - Width) > 0.5) Width = newWidth;
            Height = newHeight;
            var minTop = area.Top + 8;
            var maxTop = area.Bottom - newHeight - 8;
            if (maxTop < minTop) maxTop = minTop;
            Top = Math.Clamp(top, minTop, maxTop);
            var minLeft = area.Left + 8;
            var maxLeft = area.Right - newWidth - 8;
            if (maxLeft < minLeft) maxLeft = minLeft;
            Left = Math.Clamp(Left, minLeft, maxLeft);
        }
        finally
        {
            _suppressSave = false;
        }
        PositionDocked();
        ScheduleSave();
    }

    private void BeginResize(string? edges)
    {
        var spec = edges ?? "right";
        _resizeHorizontal = spec.Contains("left", StringComparison.OrdinalIgnoreCase) ||
                            spec.Contains("right", StringComparison.OrdinalIgnoreCase);
        _resizeEdge = spec.Contains("left", StringComparison.OrdinalIgnoreCase) ? "left" : "right";
        _resizeStartWidth = Width;
        _resizeLeft = Left;
        _resizeRight = Left + ActualWidth;
    }

    private void ApplyResize(double dx)
    {
        if (_reallyClosing || !_resizeHorizontal || _resizeStartWidth <= 0) return;
        var area = CurrentWorkArea();
        var delta = _resizeEdge == "left" ? -dx : dx;
        var width = Math.Clamp(_resizeStartWidth + delta, MinWindowWidth, MaxWindowWidth);
        var left = _resizeEdge == "left" ? _resizeRight - width : _resizeLeft;

        _suppressSave = true;
        try
        {
            Width = width;
            var maxLeft = area.Right - width - 8;
            if (maxLeft < area.Left + 8) maxLeft = area.Left + 8;
            Left = Math.Clamp(left, area.Left + 8, maxLeft);
            var maxTop = area.Bottom - Height - 8;
            if (maxTop < area.Top + 8) maxTop = area.Top + 8;
            Top = Math.Clamp(Top, area.Top + 8, maxTop);
        }
        finally
        {
            _suppressSave = false;
        }
    }

    private void BeginDrag()
    {
        if (_dock != "float") return;
        if (_hwnd == IntPtr.Zero) return;
        Win32.ReleaseCapture();
        _ = Win32.SendMessage(_hwnd, Win32.WM_NCLBUTTONDOWN, new IntPtr(Win32.HTCAPTION), IntPtr.Zero);
    }

    private void SetPinned(bool pinned)
    {
        Topmost = pinned;
        _settings.Pinned = pinned;
        ScheduleSave();
        PostHostState();
    }

    private void PostHostState()
    {
        if (!_webReady) return;
        try
        {
            _webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "host-state",
                pinned = Topmost,
                dark = _isDark,
                collapsed = _collapsed,
                prefs = new
                {
                    expandUp = _settings.ExpandUp,
                    dock = _settings.Dock,
                    fontScale = _settings.FontScale,
                    hotkey = _settings.Hotkey,
                    hideHotkey = _settings.HideHotkey,
                    extraPrompt = _settings.ExtraPrompt,
                },
            }));
        }
        catch
        {
            // The page may be navigating.
        }
    }

    private void ShowWidget()
    {
        try
        {
            Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            if (_collapsed) ExpandWindow();
            Topmost = _settings.Pinned;
            Activate();
            _webView.InvalidateVisual();
            if (_hwnd != IntPtr.Zero) Win32.ForceForegroundWindow(_hwnd);
            PositionDocked();
            Dispatcher.BeginInvoke(new Action(PostFocusInput), DispatcherPriority.Input);
        }
        catch (Exception error)
        {
            Log("ShowWidget failed: " + error);
        }
    }

    private void PostFocusInput()
    {
        if (!_webReady) return;
        try
        {
            _webView.Focus();
            Keyboard.Focus(_webView);
            _webView.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"focus\"}");
        }
        catch { }
    }

    private void PositionDocked()
    {
        if (_dock == "float" || _hwnd == IntPtr.Zero) return;
        var area = CurrentWorkArea();
        _suppressSave = true;
        try
        {
            Left = _dock == "left" ? area.Left + 8 : area.Left + (area.Width - Width) / 2;
            Top = area.Bottom - Height - 8;
        }
        finally
        {
            _suppressSave = false;
        }
    }

    private void EnsureDesktopVisible()
    {
        if (_options.MainPid <= 0 || _desktopParked) return;
        if (_mainWindow == IntPtr.Zero || !Win32.IsWindow(_mainWindow))
        {
            _mainWindow = Win32.FindMainWindow(_options.MainPid, "DeepSeek Harness");
        }
        if (_mainWindow == IntPtr.Zero)
        {
            var shown = Win32.ShowMainWindowByTitle("DeepSeek Harness");
            if (!shown) Win32.ShowMainWindow(_options.MainPid);
            _mainWindow = Win32.FindMainWindow(_options.MainPid, "DeepSeek Harness");
        }
        if (_mainWindow == IntPtr.Zero) return;

        if (Win32.GetWindowRect(_mainWindow, out var rect) && rect.Left <= -10000)
        {
            var area = CurrentWorkArea();
            var width = Math.Max(640, rect.Right - rect.Left);
            var height = Math.Max(480, rect.Bottom - rect.Top);
            Win32.SetWindowPos(_mainWindow, IntPtr.Zero,
                (int)(area.Left + (area.Width - width) / 2),
                (int)(area.Top + (area.Height - height) / 2),
                width, height, 0x0004 | 0x0010);
        }
        Win32.ShowWindowHandle(_mainWindow);
        if (_hwnd != IntPtr.Zero) Win32.ForceForegroundWindow(_hwnd);
    }

    private void HideWidget()
    {
        Hide();
    }

    private void CheckDesktopButtonClick()
    {
        if (!Win32.GetCursorPos(out var point)) return;
        if (!Win32.GetWindowRect(_hwnd, out var rect)) return;
        var scale = Win32.GetDpiForWindow(_hwnd) / 96.0;
        // Order is now ... [窗口] [收起] at the far right.
        var right = rect.Right - 8 * scale - 56 * scale;
        var left = right - 34 * scale;
        var bottom = rect.Top + 44 * scale;
        if (point.X < left || point.X > right || point.Y < rect.Top || point.Y > bottom) return;
        _suppressPageReturnUntil = DateTime.UtcNow.AddMilliseconds(650);
        ReturnToDesktop();
    }

    private void OnPageReturn()
    {
        if (DateTime.UtcNow < _suppressPageReturnUntil) return;
        ReturnToDesktop();
    }

    private void ReturnToDesktop()
    {
        var now = DateTime.UtcNow;
        if ((now - _lastDesktopToggle).TotalMilliseconds < 400) return;
        _lastDesktopToggle = now;

        if (_options.MainPid > 0 && (_mainWindow == IntPtr.Zero || !Win32.IsWindow(_mainWindow)))
        {
            _mainWindow = Win32.FindMainWindow(_options.MainPid, "DeepSeek Harness");
        }
        if (_mainWindow != IntPtr.Zero &&
            Win32.IsWindowVisible(_mainWindow) && !Win32.IsIconic(_mainWindow) &&
            !Win32.IsMainWindowOccluded("DeepSeek Harness", Environment.ProcessId) &&
            Win32.GetWindowRect(_mainWindow, out var rect) && rect.Left > -10000)
        {
            Win32.MinimizeMainWindow(_options.MainPid);
            return;
        }
        _desktopParked = false;
        EnsureDesktopVisible();
    }

    private void CollapseWindow()
    {
        if (_collapsed) return;
        _expandedHeight = Height;
        _expandedTop = Top;
        _collapsed = true;
        ApplyCollapsedHeight();
        PostCollapsedState();
    }

    private void ExpandWindow()
    {
        if (!_collapsed) return;
        _collapsed = false;
        ApplyCollapsedHeight();
        PostCollapsedState();
    }

    private void ApplyCollapsedHeight()
    {
        var target = _collapsed ? MinCollapsedHeight : (_expandedHeight > 0 ? _expandedHeight : MinWindowHeight);
        var restoreTop = !_collapsed && double.IsFinite(_expandedTop) ? _expandedTop : double.NaN;
        if (!_collapsed)
        {
            _expandedHeight = 0;
            _expandedTop = double.NaN;
        }
        var bottom = Top + Height;
        _suppressSave = true;
        try
        {
            Height = Math.Clamp(target, MinCollapsedHeight, MaxWindowHeight);
            if (double.IsFinite(restoreTop)) Top = restoreTop;
            else if (_expandUp) Top = bottom - Height;
            var area = CurrentWorkArea();
            var maxTop = area.Bottom - Height - 8;
            if (maxTop < area.Top + 8) maxTop = area.Top + 8;
            Top = Math.Clamp(Top, area.Top + 8, maxTop);
        }
        finally
        {
            _suppressSave = false;
        }
        PositionDocked();
    }

    private void PostCollapsedState()
    {
        if (!_webReady) return;
        try
        {
            _webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "collapsed",
                value = _collapsed,
            }));
        }
        catch
        {
            // The page may be navigating.
        }
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == Win32.WM_HOTKEY && wParam.ToInt32() == HotkeyId)
        {
            Dispatcher.BeginInvoke(new Action(ShowWidget), DispatcherPriority.Normal);
            handled = true;
        }
        else if (msg == Win32.WM_HOTKEY && wParam.ToInt32() == HideHotkeyId)
        {
            Dispatcher.BeginInvoke(new Action(CollapseWindow), DispatcherPriority.Normal);
            handled = true;
        }
        else if (msg == Win32.WM_DSH_SHOW)
        {
            Dispatcher.BeginInvoke(new Action(ShowWidget), DispatcherPriority.Normal);
            handled = true;
        }
        else if (msg == Win32.WM_DSH_TOGGLE)
        {
            if (IsVisible) Dispatcher.BeginInvoke(new Action(HideWidget), DispatcherPriority.Normal);
            else Dispatcher.BeginInvoke(new Action(ShowWidget), DispatcherPriority.Normal);
            handled = true;
        }
        else if (msg == 0x0006 && (wParam.ToInt32() & 0xFFFF) != 0)
        {
            Dispatcher.BeginInvoke(new Action(CheckDesktopButtonClick), DispatcherPriority.Input);
        }

        return IntPtr.Zero;
    }

    private void CheckParent()
    {
        if (_options.ParentPid <= 0) return;
        try
        {
            using var process = Process.GetProcessById(_options.ParentPid);
            if (process.HasExited) ReallyClose();
        }
        catch
        {
            ReallyClose();
        }
    }

    private void RestorePosition()
    {
        var area = CurrentWorkArea();
        var width = Math.Clamp(_settings.Width, MinWindowWidth, MaxWindowWidth);
        var left = _settings.Left;
        var top = _settings.Top;
        var valid = _settings.Positioned && double.IsFinite(left) && double.IsFinite(top) &&
                    left > area.Left - 4000 && top > area.Top - 4000 &&
                    left < area.Right + 4000 && top < area.Bottom + 4000;
        if (!valid)
        {
            left = area.Right - width - 24;
            top = area.Top + 80;
        }
        var maxLeft = area.Right - width - 8;
        if (maxLeft < area.Left + 8) maxLeft = area.Left + 8;
        var maxTop = area.Bottom - Height - 8;
        if (maxTop < area.Top + 8) maxTop = area.Top + 8;
        Left = Math.Clamp(left, area.Left + 8, maxLeft);
        Top = Math.Clamp(top, area.Top + 8, maxTop);
        _settings.Positioned = true;
    }

    private Rect CurrentWorkArea()
    {
        var monitor = Win32.WorkAreaDip(_hwnd);
        if (monitor is { } area)
        {
            return new Rect(area.Left, area.Top, area.Width, area.Height);
        }
        var system = SystemParameters.WorkArea;
        var systemScale = Win32.ScaleForWindow(_hwnd);
        return new Rect(system.Left / systemScale, system.Top / systemScale, system.Width / systemScale, system.Height / systemScale);
    }

    private void ScheduleSave()
    {
        if (_suppressSave || _reallyClosing || _collapsed) return;
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    private void PersistWindow(bool force = false)
    {
        if (_reallyClosing && !force) return;
        var top = _collapsed && double.IsFinite(_expandedTop) ? _expandedTop : Top;
        var height = _collapsed && _expandedHeight > 0 ? _expandedHeight : ActualHeight;
        _settings.Left = Left;
        _settings.Top = top;
        _settings.Bottom = top + height;
        _settings.Width = Width;
        _settings.Save();
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_reallyClosing) return;
        e.Cancel = true;
        HideWidget();
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _watchdog?.Stop();
        _saveTimer.Stop();
        if (_hwnd != IntPtr.Zero)
        {
            Win32.UnregisterHotKey(_hwnd, HotkeyId);
            Win32.UnregisterHotKey(_hwnd, HideHotkeyId);
        }
        _source?.RemoveHook(WndProc);
        _webView.Dispose();
        PersistWindow(true);
    }

    private void ReallyClose()
    {
        if (_reallyClosing) return;
        _reallyClosing = true;
        try { Application.Current.Shutdown(); } catch { }
    }

    private Rect? ReadRechargeAnchor(JsonElement root)
    {
        if (!root.TryGetProperty("anchor", out var anchor) || anchor.ValueKind != JsonValueKind.Object) return null;
        if (!anchor.TryGetProperty("left", out var leftValue) || !leftValue.TryGetDouble(out var left)) return null;
        if (!anchor.TryGetProperty("top", out var topValue) || !topValue.TryGetDouble(out var top)) return null;
        if (!anchor.TryGetProperty("width", out var widthValue) || !widthValue.TryGetDouble(out var width)) return null;
        if (!anchor.TryGetProperty("height", out var heightValue) || !heightValue.TryGetDouble(out var height)) return null;
        if (!anchor.TryGetProperty("viewportWidth", out var viewportWidthValue) || !viewportWidthValue.TryGetDouble(out var viewportWidth)) return null;
        if (!anchor.TryGetProperty("viewportHeight", out var viewportHeightValue) || !viewportHeightValue.TryGetDouble(out var viewportHeight)) return null;
        if (viewportWidth <= 0 || viewportHeight <= 0 || ActualWidth <= 0 || ActualHeight <= 0) return null;
        var scaleX = ActualWidth / viewportWidth;
        var scaleY = ActualHeight / viewportHeight;
        return new Rect(
            Left + left * scaleX,
            Top + top * scaleY,
            Math.Max(1, width * scaleX),
            Math.Max(1, height * scaleY));
    }

    private void OpenRechargeWindow(Rect? anchor = null)
    {
        try
        {
            if (_webView.CoreWebView2 is null) return;
            var workArea = CurrentWorkArea();
            if (_rechargeWindow is { IsLoaded: true })
            {
                _rechargeWindow.PlaceAbove(anchor ?? Rect.Empty, workArea);
                _rechargeWindow.Activate();
                return;
            }
            _rechargeWindow = new RechargeWindow(_webView.CoreWebView2.Environment)
            {
                Topmost = Topmost,
            };
            _rechargeWindow.Closed += (_, _) => _rechargeWindow = null;
            _rechargeWindow.PlaceAbove(anchor ?? Rect.Empty, workArea);
            _rechargeWindow.Show();
            _rechargeWindow.Activate();
        }
        catch (Exception error)
        {
            Log("open recharge failed: " + error);
        }
    }

    private void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            Log("open external failed: " + error.Message);
        }
    }

    private static void Log(string message)
    {
        try
        {
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSHFloatingInput");
            Directory.CreateDirectory(root);
            var file = Path.Combine(root, "helper.log");
            if (File.Exists(file) && new FileInfo(file).Length > 256 * 1024)
            {
                File.Move(file, file + ".old", true);
            }
            File.AppendAllText(file, $"[{DateTimeOffset.Now:O}] {message}{Environment.NewLine}");
        }
        catch { }
    }
}
