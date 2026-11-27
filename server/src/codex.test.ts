import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodexInfo } from './delegate/codex.js';

const tmps: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-resolve-'));
  tmps.push(d);
  return d;
}
function touch(p: string, text = ''): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('resolveCodexInfo', () => {
  it('COSYEE_CODEX 优先于 PATH；指向不存在的文件返回 null', () => {
    const d = tmp();
    const custom = touch(path.join(d, 'custom', 'codex.exe'));
    const onPath = touch(path.join(d, 'bin', 'codex.exe'));
    const env = { COSYEE_CODEX: custom, PATH: path.dirname(onPath) };
    const r = resolveCodexInfo(env, { platform: 'win32', homedir: d });
    expect(r).toEqual({ execPath: custom, rawPath: custom, installKind: 'custom' });
    expect(resolveCodexInfo({ COSYEE_CODEX: path.join(d, 'nope.exe'), PATH: path.dirname(onPath) }, { platform: 'win32', homedir: d })).toBeNull();
  });

  it('PATH 优先于默认安装目录；同目录 exe 优先于 cmd 垫片', () => {
    const d = tmp();
    const dflt = touch(path.join(d, 'local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    const exe = touch(path.join(d, 'p', 'codex.exe'));
    touch(path.join(d, 'p', 'codex.cmd'));
    const r = resolveCodexInfo({ PATH: path.join(d, 'p'), LOCALAPPDATA: path.join(d, 'local') }, { platform: 'win32', homedir: d });
    expect(r?.execPath).toBe(exe);
    expect(r?.installKind).toBe('standalone');
    const r2 = resolveCodexInfo({ PATH: path.join(d, 'empty'), LOCALAPPDATA: path.join(d, 'local') }, { platform: 'win32', homedir: d });
    expect(r2?.execPath).toBe(dflt);
  });

  it('Windows npm 垫片解析到原生 exe（用临时目录伪造布局）', () => {
    const d = tmp();
    const npmDir = path.join(d, 'npm');
    const shim = touch(path.join(npmDir, 'codex.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*\r\n');
    const exe = touch(path.join(npmDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    const r = resolveCodexInfo({ PATH: npmDir }, { platform: 'win32', arch: 'x64', homedir: d });
    expect(r).toEqual({ execPath: exe, rawPath: shim, installKind: 'npm' });
  });

  it('依赖被提升到上层 node_modules 时也能找到', () => {
    const d = tmp();
    const npmDir = path.join(d, 'npm');
    touch(path.join(npmDir, 'codex.cmd'), 'x');
    touch(path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    const exe = touch(path.join(npmDir, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    expect(resolveCodexInfo({ PATH: npmDir }, { platform: 'win32', arch: 'x64', homedir: d })?.execPath).toBe(exe);
  });

  it('解析不到原生 exe 时退回垫片本身', () => {
    const d = tmp();
    const shim = touch(path.join(d, 'npm', 'codex.cmd'), 'x');
    const r = resolveCodexInfo({ PATH: path.join(d, 'npm') }, { platform: 'win32', arch: 'x64', homedir: d });
    expect(r?.execPath).toBe(shim);
    expect(r?.rawPath).toBe(shim);
  });

  it('哪里都没有时返回 null', () => {
    const d = tmp();
    expect(resolveCodexInfo({ PATH: path.join(d, 'a'), LOCALAPPDATA: path.join(d, 'l'), APPDATA: path.join(d, 'r') }, { platform: 'win32', homedir: d })).toBeNull();
  });
});
