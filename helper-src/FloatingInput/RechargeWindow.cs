using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MediaColor = System.Windows.Media.Color;

namespace DshFloatingInput;

/// <summary>
/// A small dedicated WebView2 window for the official DeepSeek top-up page.
/// It intentionally does not build or handle payment orders itself: the
/// official site owns the amount selection, payment method and QR code.
/// Cookies are stored in the same WebView2 profile as the quick bar, so the
/// user only signs in once.
/// </summary>
internal sealed class RechargeWindow : Window
{
    private const string RechargeUrl = "https://platform.deepseek.com/top_up";
    private const double PopupWidth = 460;
    private const double PopupHeight = 640;
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;

    private readonly CoreWebView2Environment _environment;
    private readonly WebView2 _webView = new();
    private bool _ready;

    public RechargeWindow(CoreWebView2Environment environment)
    {
        _environment = environment;
        Title = "DeepSeek 充值";
        Width = PopupWidth;
        Height = PopupHeight;
        MinWidth = 400;
        MinHeight = 500;
        WindowStyle = WindowStyle.SingleBorderWindow;
        ResizeMode = ResizeMode.CanResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        ShowInTaskbar = false;
        Background = new SolidColorBrush(MediaColor.FromRgb(15, 16, 18));
        Foreground = new SolidColorBrush(MediaColor.FromRgb(232, 234, 237));
        Content = _webView;
        Loaded += OnLoaded;
        Closed += (_, _) => _webView.Dispose();
    }

    public void PlaceAbove(Rect anchor, Rect workArea)
    {
        var width = Math.Min(PopupWidth, Math.Max(360, workArea.Width - 24));
        var height = Math.Min(PopupHeight, Math.Max(420, workArea.Height - 24));
        Width = width;
        Height = height;

        var center = anchor.IsEmpty ? workArea.Left + workArea.Width / 2 : anchor.Left + anchor.Width / 2;
        var left = center - width / 2;
        var top = anchor.IsEmpty ? workArea.Top + (workArea.Height - height) / 2 : anchor.Top - height - 8;
        if (top < workArea.Top + 8) top = anchor.IsEmpty ? workArea.Top + 8 : anchor.Bottom + 8;

        Left = Math.Clamp(left, workArea.Left + 8, Math.Max(workArea.Left + 8, workArea.Right - width - 8));
        Top = Math.Clamp(top, workArea.Top + 8, Math.Max(workArea.Top + 8, workArea.Bottom - height - 8));
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        try
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            var dark = 1;
            DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int));
            var caption = ColorRef(23, 24, 27);
            DwmSetWindowAttribute(hwnd, DwmwaCaptionColor, ref caption, sizeof(int));
            var text = ColorRef(232, 234, 237);
            DwmSetWindowAttribute(hwnd, DwmwaTextColor, ref text, sizeof(int));
            var border = ColorRef(42, 45, 49);
            DwmSetWindowAttribute(hwnd, DwmwaBorderColor, ref border, sizeof(int));
        }
        catch { }
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_ready) return;
        try
        {
            await _webView.EnsureCoreWebView2Async(_environment);
            var core = _webView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.Settings.IsSwipeNavigationEnabled = false;
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) NavigateOrOpen(uri);
            };
            core.Navigate(RechargeUrl);
            _ready = true;
        }
        catch (Exception error)
        {
            System.Windows.MessageBox.Show(
                "无法打开 DeepSeek 官方充值页：\n" + error.Message,
                "DeepSeek 充值",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            Close();
        }
    }

    private void NavigateOrOpen(Uri uri)
    {
        if (uri.Scheme is "http" or "https" && _webView.CoreWebView2 is not null)
        {
            _webView.CoreWebView2.Navigate(uri.AbsoluteUri);
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch { }
    }

    private static int ColorRef(byte red, byte green, byte blue) => red | (green << 8) | (blue << 16);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
