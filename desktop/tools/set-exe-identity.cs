using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

/// <summary>
/// Give a Windows executable the product's icon and version identity.
///
/// Why this exists: the window belongs to the Electron core process, so the taskbar
/// button and Task Manager read **its** icon and version resource — not the launcher's.
/// Renaming electron.exe leaves both saying "Electron"/"GitHub, Inc.", which is what
/// the launcher alone could never fix.
///
/// How: the Win32 resource-update API (BeginUpdateResource/UpdateResource/
/// EndUpdateResource), which is the supported way to rewrite a PE's resources — and
/// the same mechanism rcedit uses. Hand-editing a 235 MB PE is exactly the kind of
/// change that produces a file which no longer loads; this does not touch the layout
/// itself.
///
/// What: every RT_ICON / RT_GROUP_ICON / RT_VERSION resource is transplanted from
/// <c>source</c> into <c>target</c>, after deleting the target's own copies (an old
/// icon group left at a different id would keep Explorer and the taskbar on the
/// Electron artwork). The blobs are authored by csc from normal assembly attributes
/// and <c>/win32icon:</c>, so the icon group and VS_VERSIONINFO structures are
/// produced by the same toolchain that already builds the launcher, instead of being
/// assembled by hand here.
///
///   set-exe-identity.exe &lt;target.exe&gt; &lt;source.exe&gt;
///
/// It then re-opens the target and reads the version info back, failing if the target
/// does not report what the source describes — a silent no-op would otherwise look
/// exactly like success.
/// </summary>
internal static class SetExeIdentity
{
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;

    private static readonly IntPtr RT_ICON = (IntPtr)3;
    private static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;
    private static readonly IntPtr RT_VERSION = (IntPtr)16;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumNameProc callback, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumLangProc callback, IntPtr param);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr FindResourceEx(IntPtr module, IntPtr type, IntPtr name, ushort language);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr data);

    private delegate bool EnumNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    private delegate bool EnumLangProc(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);

    /// <summary>One resource, identified the way the Win32 API does.</summary>
    private sealed class Entry
    {
        public IntPtr Type;
        public int Id;
        public ushort Language;
        public byte[] Data;
    }

    private static string ResourceTypeName(IntPtr type)
    {
        if (type == RT_ICON) return "RT_ICON";
        if (type == RT_GROUP_ICON) return "RT_GROUP_ICON";
        if (type == RT_VERSION) return "RT_VERSION";
        return "type " + type.ToString();
    }

    private static void Report(string what)
    {
        Console.Error.WriteLine("[identity] " + what + " failed (Win32 error " + Marshal.GetLastWin32Error().ToString() + ")");
    }

    private static byte[] ReadResource(IntPtr module, IntPtr type, IntPtr name, ushort language)
    {
        IntPtr info = FindResourceEx(module, type, name, language);
        if (info == IntPtr.Zero) return null;
        uint size = SizeofResource(module, info);
        IntPtr loaded = LoadResource(module, info);
        if (loaded == IntPtr.Zero) return null;
        IntPtr data = LockResource(loaded);
        if (data == IntPtr.Zero) return null;
        byte[] buffer = new byte[(int)size];
        Marshal.Copy(data, buffer, 0, (int)size);
        return buffer;
    }

    /// <summary>List the icon and version resources of one file, optionally reading them.</summary>
    private static List<Entry> Collect(string path, bool withData)
    {
        IntPtr module = LoadLibraryEx(path, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero)
        {
            Report("LoadLibraryEx(" + path + ")");
            throw new InvalidOperationException("cannot read " + path);
        }
        List<Entry> entries = new List<Entry>();
        try
        {
            IntPtr[] types = new IntPtr[] { RT_ICON, RT_GROUP_ICON, RT_VERSION };
            foreach (IntPtr type in types)
            {
                IntPtr capturedType = type;
                EnumResourceNames(module, type, delegate(IntPtr mod, IntPtr t, IntPtr name, IntPtr param)
                {
                    // Icons and version blocks are always integer-id resources. A
                    // string-named one is not ours to move, and its pointer would not
                    // survive the module being unloaded anyway.
                    if (name.ToInt64() > 0xFFFF) return true;
                    int id = (int)name.ToInt64();
                    EnumResourceLanguages(mod, t, name, delegate(IntPtr m2, IntPtr t2, IntPtr n2, ushort lang, IntPtr p2)
                    {
                        Entry entry = new Entry();
                        entry.Type = capturedType;
                        entry.Id = id;
                        entry.Language = lang;
                        if (withData) entry.Data = ReadResource(m2, t2, n2, lang);
                        entries.Add(entry);
                        return true;
                    }, IntPtr.Zero);
                    return true;
                }, IntPtr.Zero);
            }
        }
        finally
        {
            FreeLibrary(module);
        }
        return entries;
    }

    private static int CountOf(List<Entry> entries, IntPtr type)
    {
        int count = 0;
        foreach (Entry entry in entries) if (entry.Type == type) count++;
        return count;
    }

    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: set-exe-identity <target.exe> <source.exe>");
            return 2;
        }
        string target = args[0];
        string source = args[1];

        try
        {
            List<Entry> existing = Collect(target, false);
            List<Entry> replacement = Collect(source, true);
            if (CountOf(replacement, RT_GROUP_ICON) == 0 && CountOf(replacement, RT_VERSION) == 0)
            {
                Console.Error.WriteLine("[identity] " + source + " has no icon or version resources to copy");
                return 1;
            }

            // `false` keeps every other resource of the target — Electron's manifest
            // and string tables must survive untouched.
            IntPtr update = BeginUpdateResource(target, false);
            if (update == IntPtr.Zero)
            {
                Report("BeginUpdateResource(" + target + ")");
                return 1;
            }

            bool ok = true;
            foreach (Entry entry in existing)
            {
                // A null buffer with size 0 deletes the resource.
                if (!UpdateResource(update, entry.Type, (IntPtr)entry.Id, entry.Language, null, 0))
                {
                    Report("deleting " + ResourceTypeName(entry.Type) + " " + entry.Id.ToString());
                    ok = false;
                }
            }
            if (ok)
            {
                foreach (Entry entry in replacement)
                {
                    if (entry.Data == null)
                    {
                        Console.Error.WriteLine("[identity] could not read " + ResourceTypeName(entry.Type) + " " + entry.Id.ToString() + " from the source");
                        ok = false;
                        continue;
                    }
                    if (!UpdateResource(update, entry.Type, (IntPtr)entry.Id, entry.Language, entry.Data, (uint)entry.Data.Length))
                    {
                        Report("writing " + ResourceTypeName(entry.Type) + " " + entry.Id.ToString());
                        ok = false;
                    }
                }
            }

            // Discard rather than commit if anything failed: a half-rewritten resource
            // directory is worse than no change at all.
            if (!EndUpdateResource(update, !ok))
            {
                Report("EndUpdateResource");
                return 1;
            }
            if (!ok) return 1;

            FileVersionInfo got = FileVersionInfo.GetVersionInfo(target);
            FileVersionInfo want = FileVersionInfo.GetVersionInfo(source);
            Console.WriteLine("[identity] " + target);
            Console.WriteLine("[identity]   ProductName     = " + got.ProductName);
            Console.WriteLine("[identity]   FileDescription = " + got.FileDescription);
            Console.WriteLine("[identity]   CompanyName     = " + got.CompanyName);
            Console.WriteLine("[identity]   FileVersion     = " + got.FileVersion);
            Console.WriteLine("[identity]   icons=" + CountOf(replacement, RT_ICON).ToString()
                + " groups=" + CountOf(replacement, RT_GROUP_ICON).ToString()
                + " versionBlocks=" + CountOf(replacement, RT_VERSION).ToString());

            bool matches = got.ProductName == want.ProductName
                && got.FileDescription == want.FileDescription
                && got.FileVersion == want.FileVersion;
            if (!matches)
            {
                Console.Error.WriteLine("[identity] the target does not read back as the source describes"
                    + " (wanted ProductName='" + want.ProductName + "' FileVersion='" + want.FileVersion + "')");
                return 1;
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[identity] " + error.Message);
            return 1;
        }
    }
}
