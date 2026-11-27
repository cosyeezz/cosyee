/**
 * macOS picker: `osascript -l JavaScript` (JXA) driving NSOpenPanel.
 *
 * Tested on macOS 26.6 (see README.md). Most of the script is about getting the panel activated so
 * it accepts clicks; PICK_DEBUG=1 in the environment prints that timeline to stderr.
 * osascript prints run()'s return value (the JSON) to stdout.
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

  var debug = !!env('PICK_DEBUG');
  var t0 = Date.now();
  function dbg(s) { if (debug) console.log('+' + (Date.now() - t0) + 'ms ' + s); }   // goes to stderr

  // macOS 14+ uses cooperative activation: a background "accessory" process launched by the server
  // is usually refused focus, so the panel shows up but swallows clicks until the system lets it
  // activate (sometimes never). A "regular" app gets activated, but often only after a retry.
  // finishLaunching is what every normal app does at startup; osascript skips it.
  var app = $.NSApplication.sharedApplication;
  var me = $.NSRunningApplication.currentApplication;
  var prev = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  app.finishLaunching;

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
  panel.makeKeyAndOrderFront(null);          // the system won't activate a process that shows no window

  function askFront() {
    if (app.respondsToSelector('activate')) app.activate;   // macOS 14+
    app.activateIgnoringOtherApps(true);
  }
  // Seen on macOS 26: while the main thread is still busy loading the panel, WindowServer throws away
  // our queued events whenever its buffer fills up (moving the mouse fills it within milliseconds).
  // When the "app activated" event is among them, the system has us frontmost but AppKit still
  // believes we are in the background: every click on the panel is then eaten as an "activate this
  // app" click that changes nothing, so the panel can't be clicked or dragged for as long as that
  // lasts. The timer below detects that state and hands AppKit the event it missed.
  var activated = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    13 /* NSEventTypeAppKitDefined */, { x: 0, y: 0 }, 0, 0, 0, null, 1 /* NSEventSubtypeApplicationActivated */, 0, 0);
  var asks = 0, settled = false, lost = 0, last = '';
  var timer = $.NSTimer.timerWithTimeIntervalRepeatsBlock(0.1, true, function () {
    var a = app.isActive, s = me.isActive;
    if (debug) {
      var now = 'app=' + a + ' system=' + s + ' key=' + panel.isKeyWindow;
      if (now !== last) { dbg(now); last = now; }
    }
    if (a) { settled = true; lost = 0; return; }
    if (s) {
      // wait one more tick so a real "activated" event that is merely late gets handled first
      if (++lost >= 2) { dbg('repair: sending the missed activated event'); app.sendEvent(activated); settled = true; lost = 0; }
      return;
    }
    lost = 0;
    // not frontmost: keep asking, but only until we've been active once and for at most ~3s,
    // so we never fight a user who deliberately switched away
    if (!settled && asks < 30) { asks++; askFront(); }
  });
  // common modes: the timer must also fire inside runModal's modal run loop. It keeps running for the
  // whole lifetime of the panel because the lost event can happen again after the user switches back.
  $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
  askFront();

  var result = panel.runModal;               // NSModalResponseOK === 1
  timer.invalidate;
  dbg('runModal returned ' + result);
  // hand focus back to the app the user came from (we're active now, so yielding is allowed)
  if (prev && !prev.isNil()) prev.activateWithOptions(0);
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
        if (process.env.PICK_DEBUG && stderr) process.stderr.write(stderr);   // activation timeline
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
