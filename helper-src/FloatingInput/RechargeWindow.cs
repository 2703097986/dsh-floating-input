using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MediaColor = System.Windows.Media.Color;

namespace DshFloatingInput;

/// <summary>
/// A small pure WebView2 popup for the official DeepSeek top-up page.
/// It intentionally does not build or handle payment orders itself: the
/// official site owns the amount selection, payment method and QR code.
/// The window is borderless; clicking the balance button again closes it.
/// </summary>
internal sealed class RechargeWindow : Window
{
    private const string RechargeUrl = "https://platform.deepseek.com/top_up";
    private const double PopupWidth = 360;
    private const double PopupHeight = 500;

    private readonly CoreWebView2Environment _environment;
    private readonly WebView2 _webView = new();
    private bool _ready;

    public RechargeWindow(CoreWebView2Environment environment)
    {
        _environment = environment;
        Title = "DeepSeek 充值";
        Width = PopupWidth;
        Height = PopupHeight;
        MinWidth = 300;
        MinHeight = 360;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        ShowInTaskbar = false;
        Background = new SolidColorBrush(MediaColor.FromRgb(15, 16, 18));
        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0,
            ResizeBorderThickness = new Thickness(0),
            CornerRadius = new CornerRadius(10),
            GlassFrameThickness = new Thickness(0),
        });
        Content = new Border
        {
            Background = new SolidColorBrush(MediaColor.FromRgb(15, 16, 18)),
            BorderBrush = new SolidColorBrush(MediaColor.FromRgb(56, 60, 66)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(1),
            Child = _webView,
        };
        Loaded += OnLoaded;
        Closed += (_, _) => _webView.Dispose();
    }

    public void PlaceAboveQuickBar(Rect quickBar, Rect workArea)
    {
        var width = Math.Min(PopupWidth, Math.Max(300, workArea.Width - 24));
        var height = Math.Min(PopupHeight, Math.Max(360, workArea.Height - 24));
        Width = width;
        Height = height;

        var left = quickBar.Right - width;
        var top = quickBar.Top - height - 8;
        if (top < workArea.Top + 8) top = quickBar.Bottom + 8;

        Left = Math.Clamp(left, workArea.Left + 8, Math.Max(workArea.Left + 8, workArea.Right - width - 8));
        Top = Math.Clamp(top, workArea.Top + 8, Math.Max(workArea.Top + 8, workArea.Bottom - height - 8));
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
            core.NavigationCompleted += async (_, _) => await HideScrollbarsAndAddEscapeAsync();
            core.WebMessageReceived += (_, args) =>
            {
                if (args.WebMessageAsJson.Contains("dsh-close-recharge", StringComparison.Ordinal)) Close();
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

    private async System.Threading.Tasks.Task HideScrollbarsAndAddEscapeAsync()
    {
        if (_webView.CoreWebView2 is null) return;
        try
        {
            await _webView.CoreWebView2.ExecuteScriptAsync("""
                (function () {
                  if (document.getElementById('dsh-hide-scrollbars')) return;
                  var style = document.createElement('style');
                  style.id = 'dsh-hide-scrollbars';
                  style.textContent = 'html,body,*{scrollbar-width:none!important;-ms-overflow-style:none!important}*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}';
                  (document.head || document.documentElement).appendChild(style);
                  document.addEventListener('keydown', function (event) {
                    if (event.key === 'Escape' && window.chrome && window.chrome.webview) {
                      window.chrome.webview.postMessage('dsh-close-recharge');
                    }
                  });
                })();
                """);
        }
        catch { }
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
}
