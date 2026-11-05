using System;
using System.Diagnostics;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

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
    private readonly CoreWebView2Environment _environment;
    private readonly WebView2 _webView = new();
    private bool _ready;

    public RechargeWindow(CoreWebView2Environment environment)
    {
        _environment = environment;
        Title = "DeepSeek 充值";
        Width = 540;
        Height = 760;
        MinWidth = 420;
        MinHeight = 560;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = System.Windows.Media.Brushes.Black;
        Content = _webView;
        Loaded += OnLoaded;
        Closed += (_, _) => _webView.Dispose();
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
}
