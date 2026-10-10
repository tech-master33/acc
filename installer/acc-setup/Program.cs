// ACC installer for Windows.
//
// Ships as one self-contained acc-setup.exe: the application payload is
// embedded, so it installs with no network access, or it can fetch the latest
// release with --from-github.
//
//   acc-setup.exe                 install (payload bundled in this exe)
//   acc-setup.exe --boot          also start ACC when the user signs in
//   acc-setup.exe --start         also launch ACC now and open the panel
//   acc-setup.exe --from-github   download the latest release instead
//   acc-setup.exe --version 0.2.0 download a specific release
//   acc-setup.exe --dir <path>    install somewhere other than %LOCALAPPDATA%\ACC
//   acc-setup.exe --no-path       do not put the `acc` command on your PATH
//   acc-setup.exe --uninstall     remove ACC and its command

using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Versioning;

namespace AccSetup;

[SupportedOSPlatform("windows")]
internal static class Program
{
    private const string Repo = "tech-master33/acc";
    private const string PayloadResource = "acc.zip";
    private const int MinimumNodeMajor = 20;

    private static int Main(string[] args)
    {
        if (Has(args, "-h") || Has(args, "--help"))
        {
            PrintHelp();
            return 0;
        }

        Console.WriteLine("ACC installer");
        Console.WriteLine("=============");

        var target = Value(args, "--dir")
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ACC");

        if (Has(args, "--uninstall"))
        {
            return Uninstall(target);
        }

        var node = FindNode();
        if (node is null)
        {
            Error("Node.js 20 or newer is required but was not found on your PATH.");
            Console.WriteLine("Install it from https://nodejs.org/ and run this installer again.");
            return 1;
        }

        var nodeMajor = NodeMajor(node);
        if (nodeMajor is null || nodeMajor < MinimumNodeMajor)
        {
            Error($"Node.js {MinimumNodeMajor} or newer is required (found {nodeMajor?.ToString() ?? "unknown"}).");
            return 1;
        }

        Console.WriteLine($"Node:      {node} (version {nodeMajor})");
        Console.WriteLine($"Location:  {target}");

        var work = Path.Combine(Path.GetTempPath(), "acc-setup-" + Guid.NewGuid().ToString("n"));
        try
        {
            Directory.CreateDirectory(work);
            var zip = Path.Combine(work, PayloadResource);

            if (!Has(args, "--from-github") && TryWriteEmbeddedPayload(zip))
            {
                Console.WriteLine("Payload:   bundled with this installer");
            }
            else
            {
                var version = Value(args, "--version");
                var url = version is null
                    ? $"https://github.com/{Repo}/releases/latest/download/{PayloadResource}"
                    : $"https://github.com/{Repo}/releases/download/v{version}/{PayloadResource}";
                Console.WriteLine($"Payload:   downloading {url}");
                Download(url, zip);
            }

            var extracted = Path.Combine(work, "extracted");
            ZipFile.ExtractToDirectory(zip, extracted);
            var source = Directory.Exists(Path.Combine(extracted, "acc"))
                ? Path.Combine(extracted, "acc")
                : extracted;

            InstallTree(source, target);
        }
        catch (Exception error)
        {
            Error(error.Message);
            return 1;
        }
        finally
        {
            TryDelete(work);
        }

        var entry = Path.Combine(target, "bin", "acc.mjs");
        var shim = Path.Combine(target, "bin", "acc.cmd");
        File.WriteAllText(shim, $"@echo off\r\n\"{node}\" \"{entry}\" %*\r\n");

        if (!Has(args, "--no-path"))
        {
            var placed = PlaceOnPath(shim, target);
            Console.WriteLine($"Command:   {placed}");
        }

        if (Has(args, "--boot"))
        {
            Run(node, entry, "boot on");
        }

        if (Has(args, "--start"))
        {
            StartDetached(node, entry);
        }

        Console.WriteLine();
        Console.WriteLine("Installed.");
        Console.WriteLine("  1. Start it:      acc serve");
        Console.WriteLine("  2. Open the panel: http://127.0.0.1:8788/");
        Console.WriteLine("  3. Enable a provider, then: acc connect claude-desktop");
        Console.WriteLine();
        Console.WriteLine("Tip: `acc boot on` starts ACC automatically when you sign in.");
        return 0;
    }

    private static int Uninstall(string target)
    {
        var entry = Path.Combine(target, "bin", "acc.mjs");
        var node = FindNode();
        if (node is not null && File.Exists(entry))
        {
            // Best effort: remove the start-at-sign-in entry first.
            Run(node, entry, "boot off", quiet: true);
        }

        foreach (var shim in ShimPaths(target))
        {
            TryDeleteFile(shim);
        }
        TryDelete(target);
        Console.WriteLine($"Removed {target}.");
        Console.WriteLine("Your settings in %USERPROFILE%\\.acc were left alone; delete that folder to forget everything.");
        return 0;
    }

    private static void InstallTree(string source, string target)
    {
        // Replace the code, keep anything else the user may have placed here.
        foreach (var stale in new[] { "bin", "src" })
        {
            TryDelete(Path.Combine(target, stale));
        }
        Directory.CreateDirectory(target);

        foreach (var dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, dir)));
        }
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination, overwrite: true);
        }
    }

    /// <summary>Put the `acc` command where a new terminal will find it.</summary>
    private static string PlaceOnPath(string shim, string target)
    {
        // WindowsApps is already on PATH and is writable by the user, so this
        // needs no PATH editing at all.
        var windowsApps = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps");
        try
        {
            if (Directory.Exists(windowsApps))
            {
                var alias = Path.Combine(windowsApps, "acc.cmd");
                File.Copy(shim, alias, overwrite: true);
                return alias;
            }
        }
        catch (IOException)
        {
            // fall through to a PATH entry
        }

        var binDir = Path.Combine(target, "bin");
        try
        {
            var current = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
            var parts = current.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (!parts.Any(part => string.Equals(part, binDir, StringComparison.OrdinalIgnoreCase)))
            {
                var updated = string.Join(';', parts.Append(binDir));
                Environment.SetEnvironmentVariable("Path", updated, EnvironmentVariableTarget.User);
                Console.WriteLine("Note:      open a new terminal for `acc` to be on your PATH.");
            }
        }
        catch (Exception error)
        {
            Console.WriteLine($"Note:      could not update PATH ({error.Message}). Use: {shim}");
        }
        return shim;
    }

    private static IEnumerable<string> ShimPaths(string target)
    {
        yield return Path.Combine(target, "bin", "acc.cmd");
        yield return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps", "acc.cmd");
    }

    private static bool TryWriteEmbeddedPayload(string destination)
    {
        try
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource);
            if (stream is null) return false;
            using var file = File.Create(destination);
            stream.CopyTo(file);
            return file.Length > 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void Download(string url, string destination)
    {
        using var client = new HttpClient();
        client.Timeout = TimeSpan.FromMinutes(5);
        using var response = client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult();
        response.EnsureSuccessStatusCode();
        using var remote = response.Content.ReadAsStream();
        using var file = File.Create(destination);
        remote.CopyTo(file);
    }

    private static string? FindNode()
    {
        var candidates = new List<string>();
        var path = Environment.GetEnvironmentVariable("Path") ?? "";
        foreach (var dir in path.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            candidates.Add(Path.Combine(dir, "node.exe"));
        }
        candidates.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        candidates.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Volta", "bin", "node.exe"));
        candidates.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Volta", "node.exe"));

        return candidates.FirstOrDefault(File.Exists);
    }

    private static int? NodeMajor(string node)
    {
        var output = Capture(node, "--version");
        if (output is null) return null;
        var text = output.Trim().TrimStart('v');
        var major = text.Split('.')[0];
        return int.TryParse(major, out var value) ? value : null;
    }

    private static string? Capture(string file, string arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(file, arguments)
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (process is null) return null;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(20_000);
            return output;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void Run(string file, string entry, string arguments, bool quiet = false)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(file, $"\"{entry}\" {arguments}")
            {
                UseShellExecute = false,
                CreateNoWindow = quiet,
            });
            process?.WaitForExit(60_000);
        }
        catch (Exception error)
        {
            if (!quiet) Console.WriteLine($"Note:      could not run `acc {arguments}` ({error.Message})");
        }
    }

    private static void StartDetached(string node, string entry)
    {
        try
        {
            Process.Start(new ProcessStartInfo(node, $"\"{entry}\" serve")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            Process.Start(new ProcessStartInfo("http://127.0.0.1:8788/") { UseShellExecute = true });
        }
        catch (Exception error)
        {
            Console.WriteLine($"Note:      could not start ACC ({error.Message}). Run: acc serve");
        }
    }

    private static void TryDelete(string directory)
    {
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
            // A locked file is not worth failing the install over.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteFile(string file)
    {
        try
        {
            if (File.Exists(file)) File.Delete(file);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static bool Has(string[] args, string flag) =>
        args.Any(arg => string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase));

    private static string? Value(string[] args, string flag)
    {
        for (var index = 0; index < args.Length; index++)
        {
            if (!string.Equals(args[index], flag, StringComparison.OrdinalIgnoreCase)) continue;
            return index + 1 < args.Length ? args[index + 1] : null;
        }
        return null;
    }

    private static void Error(string message)
    {
        Console.Error.WriteLine("Error: " + message);
    }

    private static void PrintHelp()
    {
        Console.WriteLine("""
            ACC installer

            Usage: acc-setup.exe [options]

              (no options)      Install ACC using the payload bundled in this exe.
              --boot            Also start ACC automatically when you sign in.
              --start           Also start ACC now and open the control panel.
              --from-github     Download the latest release instead of using the bundle.
              --version <x.y.z> Download a specific release.
              --dir <path>      Install somewhere other than %LOCALAPPDATA%\ACC.
              --no-path         Do not put the `acc` command on your PATH.
              --uninstall       Remove ACC (settings in %USERPROFILE%\.acc are kept).
              -h, --help        Show this help.

            ACC needs Node.js 20 or newer: https://nodejs.org/
            """);
    }
}
