<#
  Windows native file/folder picker (IFileOpenDialog via COM).

  Params (or env vars PICK_MODE / PICK_TITLE / PICK_START_DIR):
    -Mode      mixed | files | folders
    -Title     dialog title
    -StartDir  initial folder

  Output: ONE line of pure-ASCII JSON on stdout (non-ASCII is \uXXXX-escaped, so no
  console-encoding problems):
    {"ok":true,"paths":["C:\\a","C:\\b"]}      cancel => "paths":[]
    {"ok":false,"error":"..."}                   (exit code 1)

  Must run in an STA thread:  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File win.ps1
  Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
  The C# below must stay C# 5 compatible (Windows PowerShell 5.1 CodeDom compiler).

  Mixed-selection trick (see README.md): the dialog is a normal multi-select *file* dialog.
  When the user presses "Open" while a folder is selected, the shell tries to navigate into
  it, which raises IFileDialogEvents.OnFolderChanging. There we detect "target folder is part of
  the current selection and was not caused by a recent mouse click outside the Open button"
  (= Open button / Enter / Alt+O, as opposed to a double-click on a folder; tracked with
  low-level mouse/keyboard hooks), read the whole selection from the dialog's IFolderView,
  block the navigation (S_FALSE) and Close() the dialog.
#>
param(
  [string]$Mode = $env:PICK_MODE,
  [string]$Title = $env:PICK_TITLE,
  [string]$StartDir = $env:PICK_START_DIR
)
$ErrorActionPreference = 'Stop'
if (-not $Mode) { $Mode = 'mixed' }

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace CosyeePick
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    public class FileOpenDialogCoClass { }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemArray
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
        void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
        void GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
        void GetCount(out uint pdwNumItems);
        void GetItemAt(uint dwIndex, out IShellItem ppsi);
        void EnumItems(out IntPtr ppenumShellItems);
    }

    [ComImport, Guid("973510DB-7D7F-452B-8975-74A85828D354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialogEvents
    {
        [PreserveSig] int OnFileOk(IntPtr pfd);
        [PreserveSig] int OnFolderChanging(IntPtr pfd, IShellItem psiFolder);
        [PreserveSig] int OnFolderChange(IntPtr pfd);
        [PreserveSig] int OnSelectionChange(IntPtr pfd);
        [PreserveSig] int OnShareViolation(IntPtr pfd, IShellItem psi, out int pResponse);
        [PreserveSig] int OnTypeChange(IntPtr pfd);
        [PreserveSig] int OnOverwrite(IntPtr pfd, IShellItem psi, out int pResponse);
    }

    // IFileOpenDialog with the full vtable (IModalWindow + IFileDialog + IFileOpenDialog).
    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IFileDialogEvents pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IShellItemArray ppenum);
        void GetSelectedItems(out IShellItemArray ppsai);
    }

    [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IServiceProviderCom
    {
        [PreserveSig] int QueryService(ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
    }

    // IShellBrowser: only QueryActiveShellView (slot 13 incl. IOleWindow) is used.
    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellBrowser
    {
        void GetWindow(out IntPtr phwnd);                 // IOleWindow
        void ContextSensitiveHelp(bool fEnterMode);       // IOleWindow
        void InsertMenusSB();
        void SetMenuSB();
        void RemoveMenusSB();
        void SetStatusTextSB();
        void EnableModelessSB();
        void TranslateAcceleratorSB();
        void BrowseObject();
        void GetViewStateStream();
        void GetControlWindow();
        void SendControlMsg();
        [PreserveSig] int QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object ppshv);
    }

    [ComImport, Guid("cde725b0-ccc9-4519-917e-325d72fab4ce"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFolderView
    {
        void GetCurrentViewMode(out uint pViewMode);
        void SetCurrentViewMode(uint viewMode);
        void GetFolder(ref Guid riid, out IntPtr ppv);
        void Item(int iItemIndex, out IntPtr ppidl);
        void ItemCount(uint uFlags, out int pcItems);
        [PreserveSig] int Items(uint uFlags, ref Guid riid, out IntPtr ppv);
    }

    public class DialogEvents : IFileDialogEvents
    {
        public IFileOpenDialog Dlg;
        public bool Mixed;
        public bool Picked;
        public List<string> Paths = new List<string>();
        public bool Debug;

        const uint SIGDN_FILESYSPATH = 0x80058000;
        const uint SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000;

        // ---- input tracking (low-level hooks; delivered on this thread by the dialog's modal loop) ----
        // Used only to tell "user pressed Open / Enter" apart from "user double-clicked a folder",
        // because both end in OnFolderChanging (the double-click navigation is raised AFTER the
        // button is released, so GetAsyncKeyState cannot tell them apart).
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr hMod, uint tid);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
        IntPtr hookMouse = IntPtr.Zero, hookKey = IntPtr.Zero;
        HookProc procMouse, procKey;          // keep delegates alive
        int lastMouseTick = 0;                // Environment.TickCount of last left-button down/up
        bool hasMouse = false;
        bool lastMouseOnOpenButton = false;   // that click landed on the dialog's Open button (ctrl id 1)

        public void InstallHooks()
        {
            procMouse = MouseProc; procKey = KeyProc;
            IntPtr mod = GetModuleHandle(null);
            hookMouse = SetWindowsHookEx(14 /*WH_MOUSE_LL*/, procMouse, mod, 0);
            hookKey = SetWindowsHookEx(13 /*WH_KEYBOARD_LL*/, procKey, mod, 0);
            Log("hooks " + hookMouse + "/" + hookKey);
        }

        public void RemoveHooks()
        {
            if (hookMouse != IntPtr.Zero) { UnhookWindowsHookEx(hookMouse); hookMouse = IntPtr.Zero; }
            if (hookKey != IntPtr.Zero) { UnhookWindowsHookEx(hookKey); hookKey = IntPtr.Zero; }
        }

        IntPtr MouseProc(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0)
            {
                int msg = w.ToInt32();
                if (msg == 0x201 || msg == 0x202) // WM_LBUTTONDOWN / WM_LBUTTONUP
                {
                    try
                    {
                        int x = Marshal.ReadInt32(l, 0), y = Marshal.ReadInt32(l, 4);
                        POINT pt; pt.X = x; pt.Y = y;
                        IntPtr h = WindowFromPoint(pt);
                        bool openBtn = false;
                        if (h != IntPtr.Zero)
                        {
                            StringBuilder sb = new StringBuilder(64); GetClassName(h, sb, 64);
                            openBtn = sb.ToString() == "Button" && GetDlgCtrlID(h) == 1;
                        }
                        lastMouseOnOpenButton = openBtn;
                    }
                    catch (Exception) { lastMouseOnOpenButton = false; }
                    lastMouseTick = Environment.TickCount; hasMouse = true;
                }
            }
            return CallNextHookEx(hookMouse, code, w, l);
        }

        IntPtr KeyProc(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0 && (w.ToInt32() == 0x100 || w.ToInt32() == 0x104)) hasMouse = false; // any key => keyboard-driven
            return CallNextHookEx(hookKey, code, w, l);
        }

        // true when the navigation was most likely caused by a mouse click that was NOT on the Open button
        // (double-click on a folder, click in the nav pane / breadcrumb ...).
        bool NavigationFromMouseClick()
        {
            if (!hasMouse) return false;
            if (unchecked(Environment.TickCount - lastMouseTick) > 800) return false;
            return !lastMouseOnOpenButton;
        }

        void Log(string s) { if (Debug) Console.Error.WriteLine("[pick] " + s); }

        public static string PathOf(IShellItem it)
        {
            string p = null;
            try { it.GetDisplayName(SIGDN_FILESYSPATH, out p); }
            catch (Exception)
            {
                try { it.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, out p); } catch (Exception) { p = null; }
            }
            return p;
        }

        static List<string> FromArray(IShellItemArray arr)
        {
            List<string> res = new List<string>();
            if (arr == null) return res;
            uint n; arr.GetCount(out n);
            for (uint i = 0; i < n; i++)
            {
                IShellItem it; arr.GetItemAt(i, out it);
                string p = PathOf(it);
                if (!string.IsNullOrEmpty(p)) res.Add(p);
                Marshal.ReleaseComObject(it);
            }
            return res;
        }

        // Selection of the dialog's current view (includes folders). Dialog -> IServiceProvider ->
        // SID_STopLevelBrowser -> IShellBrowser -> active IShellView -> IFolderView.Items(SVGIO_SELECTION).
        public List<string> ReadViewSelection()
        {
            List<string> res = new List<string>();
            try
            {
                IServiceProviderCom sp = (IServiceProviderCom)(object)Dlg;
                Guid sid = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
                Guid iidSB = new Guid("000214E2-0000-0000-C000-000000000046");
                IntPtr pSB;
                int hr = sp.QueryService(ref sid, ref iidSB, out pSB);
                if (hr != 0 || pSB == IntPtr.Zero) { Log("QueryService hr=" + hr.ToString("X")); return res; }
                IShellBrowser sb = (IShellBrowser)Marshal.GetObjectForIUnknown(pSB);
                Marshal.Release(pSB);
                object view;
                hr = sb.QueryActiveShellView(out view);
                if (hr != 0 || view == null) { Log("QueryActiveShellView hr=" + hr.ToString("X")); return res; }
                IFolderView fv = (IFolderView)view;
                Guid iidArr = new Guid("b63ea76d-1f85-456f-a19c-48159efa858b");
                IntPtr pArr;
                hr = fv.Items(0x1 /* SVGIO_SELECTION */, ref iidArr, out pArr);
                if (hr != 0 || pArr == IntPtr.Zero) { Log("Items hr=" + hr.ToString("X")); return res; }
                IShellItemArray arr = (IShellItemArray)Marshal.GetObjectForIUnknown(pArr);
                Marshal.Release(pArr);
                res = FromArray(arr);
            }
            catch (Exception e) { Log("ReadViewSelection: " + e.Message); }
            return res;
        }

        public List<string> ReadSelectedItems()
        {
            try
            {
                IShellItemArray arr; Dlg.GetSelectedItems(out arr);
                return FromArray(arr);
            }
            catch (Exception e) { Log("GetSelectedItems: " + e.Message); return new List<string>(); }
        }

        List<string> Selection()
        {
            List<string> s = ReadViewSelection();
            if (s.Count == 0) s = ReadSelectedItems();
            return s;
        }

        public int OnFileOk(IntPtr pfd)
        {
            if (!Mixed) return 0;
            List<string> s = Selection();
            Log("OnFileOk selection=" + s.Count);
            if (s.Count > 0) { Picked = true; Paths = s; }
            return 0; // S_OK: let the dialog close normally
        }

        public int OnFolderChanging(IntPtr pfd, IShellItem psiFolder)
        {
            if (!Mixed || Picked) return 0;
            string target = PathOf(psiFolder);
            bool byMouse = NavigationFromMouseClick();
            Log("OnFolderChanging -> " + target + " byMouseClick=" + byMouse);
            if (byMouse || string.IsNullOrEmpty(target)) return 0; // double-click etc.: navigate normally
            List<string> s = Selection();
            bool inSel = false;
            foreach (string p in s)
                if (string.Equals(p.TrimEnd('\\'), target.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) { inSel = true; break; }
            if (!inSel) return 0; // address bar / nav pane / typed path: navigate normally
            Picked = true; Paths = s;
            try { Dlg.Close(unchecked((int)0x800704C7)); } catch (Exception e) { Log("Close: " + e.Message); }
            return 1; // S_FALSE: veto navigation
        }

        public int OnFolderChange(IntPtr pfd) { return 0; }
        public int OnSelectionChange(IntPtr pfd) { return 0; }
        public int OnShareViolation(IntPtr pfd, IShellItem psi, out int pResponse) { pResponse = 0; return 0; }
        public int OnTypeChange(IntPtr pfd) { return 0; }
        public int OnOverwrite(IntPtr pfd, IShellItem psi, out int pResponse) { pResponse = 0; return 0; }
    }

    public static class Picker
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        public static string Esc(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        public static string Err(string msg) { return "{\"ok\":false,\"error\":" + Esc(msg) + "}"; }

        static string Ok(List<string> paths)
        {
            StringBuilder sb = new StringBuilder("{\"ok\":true,\"paths\":[");
            for (int i = 0; i < paths.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Esc(paths[i])); }
            return sb.Append("]}").ToString();
        }

        // Make the (invisible, topmost) owner the foreground window even if the caller process
        // does not own the foreground (browser in front).
        static void ForceForeground(IntPtr h)
        {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);   // Alt down/up unlocks SetForegroundWindow
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            uint pid, me = GetCurrentThreadId();
            uint fgT = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            bool att = fgT != 0 && fgT != me && AttachThreadInput(me, fgT, true);
            SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // TOPMOST|NOSIZE|NOMOVE|SHOWWINDOW
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (att) AttachThreadInput(me, fgT, false);
        }

        public static string Run(string mode, string title, string startDir, bool debug)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            if (string.IsNullOrEmpty(mode)) mode = "mixed";
            bool folders = mode == "folders";
            bool mixed = mode == "mixed";

            IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogCoClass();
            uint opts; dlg.GetOptions(out opts);
            opts |= 0x40 /*FORCEFILESYSTEM*/ | 0x200 /*ALLOWMULTISELECT*/ | 0x800 /*PATHMUSTEXIST*/ | 0x8 /*NOCHANGEDIR*/;
            if (folders) opts |= 0x20; /*PICKFOLDERS*/
            else opts |= 0x1000; /*FILEMUSTEXIST*/
            dlg.SetOptions(opts);
            if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
            if (!string.IsNullOrEmpty(startDir) && System.IO.Directory.Exists(startDir))
            {
                try
                {
                    Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                    IShellItem si; SHCreateItemFromParsingName(startDir, IntPtr.Zero, ref iid, out si);
                    dlg.SetFolder(si);
                }
                catch (Exception) { }
            }

            DialogEvents ev = new DialogEvents();
            ev.Dlg = dlg; ev.Mixed = mixed; ev.Debug = debug;
            uint cookie = 0;
            if (mixed) { dlg.Advise(ev, out cookie); ev.InstallHooks(); }

            Application.EnableVisualStyles();
            Form owner = new Form();
            owner.FormBorderStyle = FormBorderStyle.None;
            owner.ShowInTaskbar = false;
            owner.StartPosition = FormStartPosition.Manual;
            owner.Size = new System.Drawing.Size(1, 1);
            owner.Location = new System.Drawing.Point(-32000, -32000);
            owner.Opacity = 0;
            owner.TopMost = true;
            owner.Show();
            ForceForeground(owner.Handle);

            int hr;
            try { hr = dlg.Show(owner.Handle); }
            finally
            {
                ev.RemoveHooks();
                if (mixed && cookie != 0) { try { dlg.Unadvise(cookie); } catch (Exception) { } }
                owner.Close();
            }

            if (ev.Picked) return Ok(ev.Paths);
            if (hr == unchecked((int)0x800704C7)) return Ok(new List<string>()); // ERROR_CANCELLED
            if (hr != 0) return Err("IFileOpenDialog.Show failed: 0x" + hr.ToString("X8"));
            IShellItemArray arr; dlg.GetResults(out arr);
            List<string> res = new List<string>();
            uint n; arr.GetCount(out n);
            for (uint i = 0; i < n; i++)
            {
                IShellItem it; arr.GetItemAt(i, out it);
                string p = DialogEvents.PathOf(it);
                if (!string.IsNullOrEmpty(p)) res.Add(p);
            }
            return Ok(res);
        }
    }
}
'@

try {
  if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'PowerShell must be started with -STA' }
  Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition $src -Language CSharp
  $json = [CosyeePick.Picker]::Run($Mode, $Title, $StartDir, [bool]$env:PICK_DEBUG)
  [Console]::Out.WriteLine($json)
  exit 0
} catch {
  $m = $_.Exception.Message
  if ($_.Exception.InnerException) { $m = $m + ' | ' + $_.Exception.InnerException.Message }
  $m = (($m -replace '\\', '\\') -replace '"', '\"') -replace '[^\x20-\x7e]', '?'
  try { [Console]::Out.WriteLine('{"ok":false,"error":"' + $m + '"}') } catch { }
  exit 1
}
