# picker: native file / folder dialog

```ts
import { pick, supportsMixed } from './picker/index.js';
const items = await pick({ mode: 'mixed', title: '选择文件或文件夹', startDir: 'D:\\data' });
// -> [{ path: 'D:\\data\\a.txt', kind: 'file' }, { path: 'D:\\data\\项目', kind: 'folder' }]  ([] = user cancelled)
```

| File | Role |
|---|---|
| `index.ts` | `pick()`, `supportsMixed`, types; dispatches on `process.platform`, `kind` via `fs.stat`, dedupes. Optional extra `signal: AbortSignal` kills the helper and closes the dialog. |
| `win.ts` + `win.ps1` | Windows: spawns `powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File win.ps1`. Parameters go in via env vars `PICK_MODE/PICK_TITLE/PICK_START_DIR`. The script prints one line of **pure-ASCII** JSON (`\uXXXX` escapes), so Chinese paths survive any console code page. |
| `mac.ts` | macOS: `osascript -l JavaScript` + `NSOpenPanel` (files + directories + multiple). **Not tested** (no Mac available). |
| `try.ts` | Manual test: `npx -y tsx server/src/picker/try.ts mixed` (or `files` / `folders`, optional 2nd arg = start dir). |

`win.ps1` must be shipped next to `win.js` when compiled (or set `COSYEE_PICKER_PS1`). Keep it ASCII-only
(Windows PowerShell 5.1 reads BOM-less files as ANSI) and C# 5 compatible (5.1's CodeDom compiler).

## Result: mixed selection IS implemented on Windows

One dialog, multi-select, files and folders together; "Open" returns every selected item.

How it works (`mode: 'mixed'`):

1. A normal `IFileOpenDialog` (`FOS_ALLOWMULTISELECT | FOS_FORCEFILESYSTEM`, file mode), declared through hand-written COM interop (Add-Type, C# 5).
2. Press "Open" with only files selected: `IFileDialogEvents.OnFileOk` fires. We read the selection from the dialog's
   view (`IServiceProvider` -> `SID_STopLevelBrowser` -> `IShellBrowser.QueryActiveShellView` -> `IFolderView.Items(SVGIO_SELECTION)`).
3. Press "Open" with a folder in the selection: the shell tries to navigate into the folder, which fires
   `OnFolderChanging`. If the target folder is part of the current selection and the navigation was not caused by a mouse click
   somewhere other than the Open button, we read the selection (files + folders) the same way, record it, call
   `IFileDialog.Close()` and return `S_FALSE` to veto the navigation.
4. Double-click on a folder also ends in `OnFolderChanging`, **after** the mouse button was released (so `GetAsyncKeyState` can't tell it apart; tried, it fails).
   To tell them apart, thread-local low-level mouse/keyboard hooks (`WH_MOUSE_LL` / `WH_KEYBOARD_LL`, pumped by the dialog's modal loop)
   remember the last left click (within 800 ms) and whether it hit the Open button (class `Button`, control id 1); any key press clears it.
   Mouse click outside the Open button => normal navigation; otherwise (Open button, Enter, Alt+O, no recent click) => pick.
5. Foreground: an invisible 1x1 topmost WinForms window is the owner; the script sends a dummy Alt key press, attaches input to the current foreground thread and calls `SetForegroundWindow`.
   Verified that the dialog becomes the foreground window. DPI aware (`SetProcessDPIAware`).

`mode: 'files'` = plain multi-select file dialog; `mode: 'folders'` = `FOS_PICKFOLDERS | FOS_ALLOWMULTISELECT` (multi-folder picker).
Startup latency: dialog visible after about 0.8 s (mostly `Add-Type` compile).

### Verified here (automated, UI Automation + a real synthetic mouse)

Test dir with `folderB`, `文件夹A`, `plain.txt`, `测试.txt`:

| Case | Result |
|---|---|
| Cancel | `[]` |
| mixed: `folderB` + `plain.txt` -> Open (button message and a real mouse click) | both returned |
| mixed: `文件夹A` only | returned (Chinese path correct) |
| mixed: `文件夹A` + `folderB` | both |
| mixed: two files only (OnFileOk path) | both |
| mixed: real double-click on `folderB` | dialog stays open and navigates into it (no pick) |
| files / folders modes with 2 items each | both |
| End to end through Node (`try.ts` under tsx): mixed folder + `测试.txt`; cancel | correct `kind`, `[]` |
| `tsc --noEmit` on `server` | clean |

### Known limits / not verified

- **Enter on a selected folder = pick** (not navigate), since Enter is "Open". Double-click, the address bar, the navigation pane, and typing a path still navigate.
  Exception: if you click an item and press Enter/Open via keyboard within 800 ms without any key in between, it is treated as a mouse navigation (Enter does count as a key, so this is basically only the click-then-programmatic-open case).
- The heuristic is real input based; not covered by automation: touch/pen input, Enter key typed in the file-name box with a folder name that is also selected, remote desktop edge cases.
- Search-result / library / "This PC" virtual items without a filesystem path are skipped (`FOS_FORCEFILESYSTEM`).
- Low-level hooks are installed for the lifetime of the dialog only (removed in `finally`); some endpoint-security software dislikes `WH_*_LL` hooks. If hooks fail to install, `mixed` degrades to: double-click navigation is mistaken for a pick when the folder is selected (the first click selects it). Use `files`/`folders` as the fallback then; the front end can offer them with Shift+click on "+".
- Needs Windows PowerShell 5.1 (`powershell.exe`), STA, an interactive desktop session (no service/session-0).
- macOS: `NSOpenPanel` handles mixed natively; code is untested. If the panel does not come to the front, check activation policy and `activateIgnoringOtherApps` (deprecated on macOS 14 but still works).
- Other platforms (Linux): `pick()` throws; `supportsMixed` is `false` (mixed is downgraded to `files` before dispatch).

## Manual test steps (human)

```
npx -y tsx server/src/picker/try.ts mixed
```
1. Browser/other window in front: the dialog must appear in front, title "Cosyee picker test (mixed)".
2. Ctrl+click one folder and one file, click "Open" -> two items listed (`kind` folder + file).
3. Select only a folder, "Open" -> the folder is returned, the dialog does not enter it.
4. Double-click a folder -> enters it. Address bar / left tree navigation works. Cancel / Esc -> `[]`.
5. Try a path containing Chinese characters / spaces.
6. `try.ts files` and `try.ts folders` (folders: Ctrl+click multiple folders).
7. Debug: run with `PICK_DEBUG=1` to see hook / event traces on stderr, or run the script directly:
   `$env:PICK_MODE='mixed'; powershell -NoProfile -STA -ExecutionPolicy Bypass -File server/src/picker/win.ps1`.
8. macOS: same checklist with `try.ts mixed` (untested).
