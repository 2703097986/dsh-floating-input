using System;
using System.Threading;
using System.Windows;
using Application = System.Windows.Application;
using MessageBox = System.Windows.MessageBox;

namespace DshFloatingInput;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var options = LaunchOptions.Parse(args);

        // Auxiliary commands are intentionally handled before the single-instance
        // mutex so they can act on the already-running floating window.
        if (options.HideMainPid > 0)
        {
            Win32.HideMainWindow(options.HideMainPid);
            return;
        }
        if (options.Toggle)
        {
            Environment.ExitCode = Win32.ToggleExistingWindow() ? 0 : 2;
            return;
        }
        if (options.Show)
        {
            Environment.ExitCode = Win32.ActivateExistingWindow() ? 0 : 2;
            return;
        }

        if (string.IsNullOrWhiteSpace(options.Url))
        {
            MessageBox.Show(
                "DSH 悬浮输入缺少 --url 参数。\n请从 DeepSeek Harness 插件启动。",
                "DeepSeek Harness 悬浮输入",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            return;
        }

        using var mutex = new Mutex(true, @"Local\DshFloatingInput.Singleton", out var createdNew);
        if (!createdNew)
        {
            Win32.ActivateExistingWindow();
            return;
        }

        var app = new Application
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown,
        };
        var window = new MainWindow(options);
        app.Run(window);
    }
}

internal sealed record LaunchOptions(string Url, int ParentPid, bool Show, bool Toggle, int HideMainPid, int MainPid)
{
    public static LaunchOptions Parse(string[] args)
    {
        var url = string.Empty;
        var parentPid = 0;
        var show = false;
        var toggle = false;
        var hideMainPid = 0;
        var mainPid = 0;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--url" when i + 1 < args.Length:
                    url = args[++i];
                    break;
                case "--parent-pid" when i + 1 < args.Length:
                    _ = int.TryParse(args[++i], out parentPid);
                    break;
                case "--show":
                    show = true;
                    break;
                case "--toggle":
                    toggle = true;
                    break;
                case "--hide-main" when i + 1 < args.Length:
                    _ = int.TryParse(args[++i], out hideMainPid);
                    break;
                case "--main-pid" when i + 1 < args.Length:
                    _ = int.TryParse(args[++i], out mainPid);
                    break;
            }
        }
        return new LaunchOptions(url, parentPid, show, toggle, hideMainPid, mainPid);
    }
}
