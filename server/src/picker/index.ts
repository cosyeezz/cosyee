/**
 * Native file / folder picker for the local WebUI backend.
 *
 *   - Windows: PowerShell + COM IFileOpenDialog (win.ts / win.ps1). Mixed file+folder selection works.
 *   - macOS:   osascript JXA + NSOpenPanel (mac.ts). Mixed selection supported natively (untested here).
 *   - others:  not supported (throws).
 */
import { stat } from 'node:fs/promises';

export type PickMode = 'mixed' | 'files' | 'folders';

export interface PickedItem {
  path: string;
  kind: 'file' | 'folder';
}

export interface PickOptions {
  /** 'mixed' (default) is downgraded to 'files' on platforms without mixed support. */
  mode?: PickMode;
  title?: string;
  /** Initial directory (ignored when it does not exist). */
  startDir?: string;
  /** Optional: abort kills the helper process and closes the dialog (rejects with AbortError). */
  signal?: AbortSignal;
}

/** Whether the current platform's dialog can select files and folders in one go. */
export const supportsMixed: boolean = process.platform === 'win32' || process.platform === 'darwin';

/** Opens the native dialog; resolves with the selected items, or [] when the user cancels. */
export async function pick(opts: PickOptions = {}): Promise<PickedItem[]> {
  let mode: PickMode = opts.mode ?? 'mixed';
  if (mode === 'mixed' && !supportsMixed) mode = 'files';
  const o = { ...opts, mode };

  let paths: string[];
  switch (process.platform) {
    case 'win32': {
      const { pickWindows } = await import('./win.js');
      paths = await pickWindows(o);
      break;
    }
    case 'darwin': {
      const { pickMac } = await import('./mac.js');
      paths = await pickMac(o);
      break;
    }
    default:
      throw new Error(`Native file picker is not supported on platform "${process.platform}"`);
  }

  const seen = new Set<string>();
  const items: PickedItem[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    let kind: PickedItem['kind'] = 'file';
    try {
      kind = (await stat(p)).isDirectory() ? 'folder' : 'file';
    } catch {
      // vanished between selection and stat: keep it as a file entry
    }
    items.push({ path: p, kind });
  }
  return items;
}
