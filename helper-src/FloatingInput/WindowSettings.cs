using System;
using System.IO;
using System.Text.Json;

namespace DshFloatingInput;

internal sealed class WindowSettings
{
    public double Left { get; set; } = double.NaN;
    public double Top { get; set; } = double.NaN;
    public double Bottom { get; set; } = double.NaN;
    public double Width { get; set; } = 700;
    public bool Pinned { get; set; } = true;
    public bool Positioned { get; set; }
    public bool ExpandUp { get; set; }
    public string Dock { get; set; } = "float";
    public double FontScale { get; set; } = 1;
    public string ExtraPrompt { get; set; } = "";
    public string Hotkey { get; set; } = "Ctrl+Alt+Space";
    public string HideHotkey { get; set; } = "Ctrl+Alt+H";

    private static string SettingsPath
    {
        get
        {
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSHFloatingInput");
            Directory.CreateDirectory(root);
            return Path.Combine(root, "window.json");
        }
    }

    public static WindowSettings Load()
    {
        try
        {
            var json = File.ReadAllText(SettingsPath);
            var settings = JsonSerializer.Deserialize<WindowSettings>(json);
            if (settings is not null)
            {
                if (settings.Width < 520 || settings.Width > 1200) settings.Width = 700;
                return settings;
            }
        }
        catch
        {
            // First launch or a corrupt settings file: use safe defaults.
        }
        return new WindowSettings();
    }

    public void Save()
    {
        try
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            var path = SettingsPath;
            var temp = path + ".tmp";
            File.WriteAllText(temp, json);
            File.Move(temp, path, true);
        }
        catch
        {
            // Window persistence must never take the widget down.
        }
    }
}
