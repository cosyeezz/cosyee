/**
 * macOS picker: `osascript -l JavaScript` (JXA) driving NSOpenPanel.
 *
 * NOTE: written without access to a Mac -- NOT tested on real hardware. Things to check first if it
 * misbehaves: (1) the panel appears in front (activation policy + activateIgnoringOtherApps),
 * (2) the printed JSON (osascript prints run()'s return value to stdout).
 *
 * NSOpenPanel natively supports choosing files AND folders in the same panel
 * (canChooseFiles + canChooseDirectories + allowsMultipleSelection), so 'mixed' needs no tricks.
 * Parameters are passed through environment variables to avoid any quoting problems.
 */
import { execFile } from 'node:child_process';
import type { PickOptions } from './index.js';

const JXA = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');

function env(key) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(key);
  return (v && !v.isNil()) ? ObjC.unwrap(v) : '';
}

function run() {
  var mode = env('PICK_MODE') || 'mixed';
  var title = env('PICK_TITLE');
  var startDir = env('PICK_START_DIR');

  // A bare osascript process has no Dock presence; "accessory" lets it own a key window,
  // and activating makes the panel come to the front over the browser.
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.activateIgnoringOtherApps(true);

  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = (mode !== 'folders');
  panel.canChooseDirectories = (mode !== 'files');
  panel.allowsMultipleSelection = true;
  panel.resolvesAliases = true;
  panel.canCreateDirectories = false;
  if (title) { panel.title = title; panel.message = title; }
  if (startDir) {
    var fm = $.NSFileManager.defaultManager;
    if (fm.fileExistsAtPath(startDir)) panel.directoryURL = $.NSURL.fileURLWithPath(startDir);
  }
  panel.level = $.NSModalPanelWindowLevel;   // stay above other windows
  panel.makeKeyAndOrderFront(null);

  var result = panel.runModal;               // NSModalResponseOK === 1
  var out = [];
  if (Number(result) === 1) {
    var urls = panel.URLs;
    for (var i = 0; i < urls.count; i++) {
      out.push(ObjC.unwrap(urls.objectAtIndex(i).path));
    }
  }
  return JSON.stringify(out);
}
`;

export function pickMac(opts: PickOptions): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', JXA],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        signal: opts.signal,
        env: {
          ...process.env,
          PICK_MODE: opts.mode ?? 'mixed',
          PICK_TITLE: opts.title ?? '',
          PICK_START_DIR: opts.startDir ?? '',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`osascript failed: ${(stderr || error.message).trim().slice(0, 500)}`));
        }
        const line = stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('['));
        if (!line) return reject(new Error(`unexpected osascript output: ${stdout.slice(0, 200)}`));
        try {
          resolve(JSON.parse(line) as string[]);
        } catch (e) {
          reject(new Error(`cannot parse osascript output: ${line.slice(0, 200)}`));
        }
      },
    );
  });
}
