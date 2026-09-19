using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("DeepSeek Harness")]
[assembly: AssemblyProduct("DeepSeek Harness")]
[assembly: AssemblyDescription("DeepSeek Harness 桌面版（便携）")]
[assembly: AssemblyCompany("DeepSeek Harness Desktop")]
[assembly: AssemblyCopyright("MIT")]
[assembly: AssemblyVersion("0.1.5.0")]
[assembly: AssemblyFileVersion("0.1.5.0")]

/// <summary>
/// Double-click entry point for the portable build.
///
/// It carries the product icon and version metadata that a renamed
/// electron.exe cannot, then starts the Electron core in the same directory
/// and exits immediately — the window, the tray and the local dsh service all
/// belong to the child process.
/// </summary>
internal static class DshDesktopLauncher
{
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string core = Path.Combine(dir, "electron-core.exe");
        if (!File.Exists(core)) core = Path.Combine(dir, "electron.exe");
        if (!File.Exists(core))
        {
            MessageBox.Show(
                "找不到 electron-core.exe。\r\n\r\n该目录不是完整的便携版，请重新解压安装包。",
                "DeepSeek Harness",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 2;
        }

        ProcessStartInfo start = new ProcessStartInfo(core);
        start.UseShellExecute = false;
        start.WorkingDirectory = dir;

        // Pass the app directory explicitly: the Electron core is renamed, so
        // discovery by executable name is not relied upon.
        string app = Path.Combine(dir, "resources", "app");
        StringBuilder arguments = new StringBuilder();
        if (Directory.Exists(app)) arguments.Append(Quote(app));
        if (args.Length > 0)
        {
            if (arguments.Length > 0) arguments.Append(' ');
            string[] quoted = new string[args.Length];
            for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
            arguments.Append(string.Join(" ", quoted));
        }
        start.Arguments = arguments.ToString();

        try
        {
            Process.Start(start);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "无法启动 DeepSeek Harness：\r\n\r\n" + error.Message,
                "DeepSeek Harness",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}
