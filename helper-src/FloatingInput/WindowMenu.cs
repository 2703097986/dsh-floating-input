using System.Windows.Forms;
using Application = System.Windows.Forms.Application;

namespace DshFloatingInput;

internal static class WindowMenu
{
    public static void ShowAtCursor()
    {
        Application.EnableVisualStyles();

        var menu = new ContextMenuStrip
        {
            ShowImageMargin = false,
            Font = new Font("Microsoft YaHei UI", 9F),
        };

        var open = new ToolStripMenuItem("打开快捷栏");
        open.Click += (_, _) => Win32.ActivateExistingWindow();
        var reset = new ToolStripMenuItem("重置快捷栏位置");
        reset.Click += (_, _) => Win32.ResetExistingWindow();

        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(reset);
        menu.Closed += (_, _) => Application.ExitThread();
        menu.Show(Cursor.Position);
        Application.Run();
    }
}
