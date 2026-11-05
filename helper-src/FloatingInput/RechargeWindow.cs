using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;
using WpfCursors = System.Windows.Input.Cursors;
using WpfHorizontalAlignment = System.Windows.HorizontalAlignment;

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
    private const double PopupWidth = 540;
    private const double PopupHeight = 760;

    private readonly CoreWebView2Environment _environment;
    private readonly WebView2 _webView = new();
    private bool _ready;

    public RechargeWindow(CoreWebView2Environment environment)
    {
        _environment = environment;
        Title = "DeepSeek 充值";
        Width = PopupWidth;
        Height = PopupHeight;
        MinWidth = 440;
        MinHeight = 560;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.CanResize;
        WindowStartupLocation = WindowStartupLocation.Manual;
        ShowInTaskbar = false;
        Background = new SolidColorBrush(MediaColor.FromRgb(15, 16, 18));
        Foreground = new SolidColorBrush(MediaColor.FromRgb(232, 234, 237));

        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0,
            ResizeBorderThickness = new Thickness(6),
            CornerRadius = new CornerRadius(10),
            GlassFrameThickness = new Thickness(0),
        });

        Content = BuildLayout();
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

    private UIElement BuildLayout()
    {
        var header = new Border
        {
            Background = new SolidColorBrush(MediaColor.FromRgb(23, 24, 27)),
            BorderBrush = new SolidColorBrush(MediaColor.FromRgb(42, 45, 49)),
            BorderThickness = new Thickness(0, 0, 0, 1),
            Padding = new Thickness(14, 0, 8, 0),
            Height = 38,
        };
        var headerGrid = new Grid();
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var title = new TextBlock
        {
            Text = "DeepSeek 充值",
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(MediaColor.FromRgb(232, 234, 237)),
        };
        Grid.SetColumn(title, 0);
        headerGrid.Children.Add(title);

        var close = new Border
        {
            Width = 32,
            Height = 26,
            Background = MediaBrushes.Transparent,
            CornerRadius = new CornerRadius(6),
            Cursor = WpfCursors.Hand,
            Child = new TextBlock
            {
                Text = "×",
                FontSize = 18,
                HorizontalAlignment = WpfHorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = new SolidColorBrush(MediaColor.FromRgb(170, 176, 185)),
            },
        };
        close.MouseLeftButtonUp += (_, _) => Close();
        Grid.SetColumn(close, 1);
        headerGrid.Children.Add(close);
        header.Child = headerGrid;
        header.MouseLeftButtonDown += (_, eventArgs) =>
        {
            if (eventArgs.ButtonState == MouseButtonState.Pressed) DragMove();
        };

        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(header, 0);
        grid.Children.Add(header);
        Grid.SetRow(_webView, 1);
        grid.Children.Add(_webView);

        return new Border
        {
            BorderBrush = new SolidColorBrush(MediaColor.FromRgb(42, 45, 49)),
            BorderThickness = new Thickness(1),
            Background = new SolidColorBrush(MediaColor.FromRgb(15, 16, 18)),
            Child = grid,
        };
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
