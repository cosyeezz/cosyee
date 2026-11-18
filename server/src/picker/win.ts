import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PickOptions } from './index.js';

/** Locate win.ps1 (next to this file; also works when compiled output lives in a sibling dir). */
function findScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.COSYEE_PICKER_PS1,
    path.join(here, 'win.ps1'),
    path.resolve(here, '../../src/picker/win.ps1'), // server/dist/picker -> server/src/picker
    path.resolve(process.cwd(), 'server/src/picker/win.ps1'),
    path.resolve(process.cwd(), 'src/picker/win.ps1'),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error('win.ps1 not found (set COSYEE_PICKER_PS1 or copy it next to the compiled win.js)');
}

function powershellExe(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root) {
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(p)) return p;
  }
  return 'powershell.exe';
}

interface PsResult {
  ok: boolean;
  paths?: string[];
  error?: string;
}

/**
 * Runs win.ps1 and returns absolute paths ([] on cancel).
 * Parameters travel through environment variables (no quoting / code-page issues);
 * the script prints pure-ASCII JSON, so stdout decoding is never a problem.
 */
export function pickWindows(opts: PickOptions): Promise<string[]> {
  const script = findScript();
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // hides the console only; the dialog is a normal GUI window
        signal: opts.signal,
        env: {
          ...process.env,
          PICK_MODE: opts.mode ?? 'mixed',
          PICK_TITLE: opts.title ?? '',
          PICK_START_DIR: opts.startDir ?? '',
        },
      },
    );

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject); // spawn failure or AbortError
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (line) {
        try {
          const r = JSON.parse(line) as PsResult;
          if (r.ok) return resolve(r.paths ?? []);
          return reject(new Error(`file picker failed: ${r.error ?? 'unknown error'}`));
        } catch {
          // fall through to generic error
        }
      }
      const stderr = Buffer.concat(err).toString('utf8').trim();
      reject(new Error(`file picker exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
    });
  });
}
