// 内置工具的启用 / 停用：POST /api/tools 校验、落盘、启动时经 --settings 的 permissions.deny 下发、
// 运行中经 apply_flag_settings 整体替换，并随上下文用量带给前端。用假 claude 记录收到的参数与控制请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SUBAGENTS, type SubagentConfig, type SubagentState } from '@cosyee/shared';
import { DELEGATE_TOOL_NAMES, NATIVE_SUBAGENT_TOOLS } from './delegate/mcp.js';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let srv: RunningServer;
let stateFile: string;
let logFile: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};

const FAKE = String.raw`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, 'ARGS ' + JSON.stringify(process.argv.slice(2)) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'control_request') continue;
    const sub = m.request.subtype;
    fs.appendFileSync(process.env.FAKE_LOG, 'CTRL ' + sub + ' ' + JSON.stringify(m.request.settings || null) + '\n');
    let body = {};
    if (sub === 'get_context_usage') body = { categories: [], totalTokens: 10, maxTokens: 100, percentage: 10 };
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: body } }) + '\n');
  }
});
`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-tools-'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_HOME', 'COSYEE_CLAUDE', 'COSYEE_AGY', 'FAKE_LOG']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  // 写入假登录凭据，使测试中的默认 Claude 账号视为已登录
  fs.writeFileSync(
    path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { refreshToken: 'test-refresh-token' } }),
  );
  // 只为让委派算作可用（结果与本机装没装无关）；这里不派任务，不会真的启动
  process.env.COSYEE_AGY = path.join(tmp, 'no-such-agy');
  logFile = path.join(tmp, 'log.txt');
  process.env.FAKE_LOG = logFile;
  cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  const js = path.join(tmp, 'fake.cjs');
  fs.writeFileSync(js, FAKE);
  if (process.platform === 'win32') {
    const cmd = path.join(tmp, 'fake.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    process.env.COSYEE_CLAUDE = cmd;
  } else {
    const sh = path.join(tmp, 'fake.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    process.env.COSYEE_CLAUDE = sh;
  }
  stateFile = path.join(tmp, 'state.json');
  // agy 委派要有一个在 Cosyee 里登录过的账号才算可用：放一个带令牌文件的假账号
  const agyDir = path.join(tmp, 'agy-accounts', 'abcd1234');
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), '{}');
  fs.writeFileSync(stateFile, JSON.stringify({ agyAccounts: { list: [{ id: 'abcd1234', label: '', dir: agyDir, createdAt: 1 }], active: 'abcd1234' } }));
  srv = await startServer({ port: 0, webDist: null, stateFile });
  srv.workspaces.add(cwd);
});

afterAll(async () => {
  await srv.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
/** 状态文件是异步落盘的：等到内容满足条件 */
const savedTools = (want: string[]) =>
  vi.waitFor(() => {
    const o = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { disabledTools?: string[] };
    expect(o.disabledTools ?? []).toEqual(want);
  });
const SID = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a11';

describe('POST /api/tools', () => {
  it('校验：非法工具名（含 mcp__ 前缀）与非布尔 enabled 返回 400，不落盘', async () => {
    expect((await post('/api/tools', { name: 'mcp__github__search', enabled: false })).status).toBe(400);
    expect((await post('/api/tools', { name: 'a b', enabled: false })).status).toBe(400);
    expect((await post('/api/tools', { name: 'WebFetch', enabled: 'no' })).status).toBe(400);
    expect((await post('/api/tools', {})).status).toBe(400);
    expect(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).disabledTools ?? [] : []).toEqual([]);
  });

  it('停用后落盘；重复停用不重复；启动的进程经 --settings 带上 permissions.deny，并随上下文下发', async () => {
    const r = await post('/api/tools', { name: 'WebFetch', enabled: false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { disabledTools: string[] }).disabledTools).toEqual(['WebFetch']);
    await post('/api/tools', { name: 'WebFetch', enabled: false });
    await savedTools(['WebFetch']);

    const ctx = (await (await post(`/api/context/${SID}/refresh`, { cwd, draft: true })).json()) as { disabledTools?: string[] };
    expect(ctx.disabledTools).toEqual(['WebFetch']);
    const args = log().find((l) => l.startsWith('ARGS '))!;
    const argv = JSON.parse(args.slice(5)) as string[];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(['WebFetch', ...DELEGATE_TOOL_NAMES]);
  }, 30_000);

  it('运行中的进程立即收到完整名单（整体替换）；重新启用后名单收缩，清空时只剩 native 停用的 delegate 系列', async () => {
    const applies = () =>
      log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).map((l) => JSON.parse(l.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } });
    const before = applies().length;
    await post('/api/tools', { name: 'Glob', enabled: false });
    expect(applies().slice(before).pop()?.permissions.deny).toEqual(['WebFetch', 'Glob', ...DELEGATE_TOOL_NAMES]);
    await post('/api/tools', { name: 'WebFetch', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual(['Glob', ...DELEGATE_TOOL_NAMES]);
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual([...DELEGATE_TOOL_NAMES]);
    await savedTools([]);
    // 本来就是启用状态：不再下发
    const n = applies().length;
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(applies().length).toBe(n);
  }, 30_000);

  it('委派辅助工具不允许单独停用；委派模式下忽略对辅助工具的历史残留 deny，且重新启用 delegate 时清理残留', async () => {
    for (const aux of DELEGATE_TOOL_NAMES.slice(1)) {
      expect((await post('/api/tools', { name: aux, enabled: false })).status).toBe(400);
    }

    // 模拟历史 state.json 中残留了单独停用的 delegate_result
    await post('/api/subagents', {
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
    });
    srv.store.state.disabledTools = ['mcp__cosyee__delegate_result', 'Glob'];
    const r = await post('/api/tools', { name: 'Glob', enabled: true });
    expect(r.status).toBe(200);
    const last = JSON.parse(
      log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).pop()!.slice('CTRL apply_flag_settings '.length),
    ) as { permissions: { deny: string[] } };
    // 委派模式下辅助工具跟随 delegate 一起放行，不被 deny
    expect(last.permissions.deny).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    expect(last.permissions.deny).not.toContain('mcp__cosyee__delegate_result');

    // 重新启用 delegate 时顺手清理残留的辅助工具停用项
    const cleaned = (await (await post('/api/tools', { name: 'mcp__cosyee__delegate', enabled: true })).json()) as { disabledTools: string[] };
    expect(cleaned.disabledTools).toEqual([]);
    await post('/api/subagents', structuredClone(DEFAULT_SUBAGENTS));
  }, 30_000);

  it('探测进程收不到 init：上下文带上落盘的 knownTools', async () => {
    srv.store.state.knownTools = ['Bash', 'Read'];
    const sid = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a12';
    const ctx = (await (await post(`/api/context/${sid}/refresh`, { cwd, draft: true })).json()) as { tools?: string[] };
    expect(ctx.tools).toEqual(['Bash', 'Read']);
  }, 30_000);
});

describe('POST /api/agents', () => {
  const applies = () =>
    log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).map((l) => JSON.parse(l.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } });

  it('校验：含括号 / 空白的名字与非布尔 enabled 返回 400', async () => {
    expect((await post('/api/agents', { name: 'a(b)', enabled: false })).status).toBe(400);
    expect((await post('/api/agents', { name: 'a b', enabled: false })).status).toBe(400);
    expect((await post('/api/agents', { name: 'Explore', enabled: 1 })).status).toBe(400);
  });

  it('关闭后落盘，以 Agent(名字) 与停用工具一起整体下发；随上下文带上；重新开启后移除', async () => {
    await post('/api/tools', { name: 'Glob', enabled: false });
    const r = await post('/api/agents', { name: 'Explore', enabled: false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { disabledAgents: string[] }).disabledAgents).toEqual(['Explore']);
    expect(applies().pop()?.permissions.deny).toEqual(['Glob', 'Agent(Explore)', ...DELEGATE_TOOL_NAMES]);
    await vi.waitFor(() => {
      const o = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { disabledAgents?: string[] };
      expect(o.disabledAgents).toEqual(['Explore']);
    });

    const sid = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a13';
    const ctx = (await (await post(`/api/context/${sid}/refresh`, { cwd, draft: true })).json()) as { disabledAgents?: string[] };
    expect(ctx.disabledAgents).toEqual(['Explore']);
    const args = log().filter((l) => l.startsWith('ARGS ')).pop()!;
    const argv = JSON.parse(args.slice(5)) as string[];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(['Glob', 'Agent(Explore)', ...DELEGATE_TOOL_NAMES]);

    await post('/api/agents', { name: 'Explore', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual(['Glob', ...DELEGATE_TOOL_NAMES]);
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual([...DELEGATE_TOOL_NAMES]);
  }, 30_000);
});

describe('POST /api/subagents', () => {
  const lastDeny = () =>
    (JSON.parse(log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).pop()!.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } }).permissions.deny;
  const savedSub = (wantMode: SubagentConfig['mode'], wantBackend?: 'claude' | 'agy') =>
    vi.waitFor(() => {
      const sub = (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { subagents?: SubagentConfig }).subagents;
      expect(sub?.mode).toBe(wantMode);
      if (wantBackend) expect(sub?.delegate.default?.backend).toBe(wantBackend);
    });
  type Ctx = { nativeAgents?: boolean; disabledTools?: string[]; disabledAgents?: string[] };
  const refresh = async (sid: string) => (await (await post(`/api/context/${sid}/refresh`, { cwd, draft: true })).json()) as Ctx;
  const nativeCfg = (): SubagentConfig => structuredClone(DEFAULT_SUBAGENTS);
  const delegateCfg = (backend: 'claude' | 'agy', accountId = backend === 'agy' ? 'abcd1234' : 'default'): SubagentConfig => ({
    ...structuredClone(DEFAULT_SUBAGENTS),
    mode: 'delegate',
    delegate: { default: { backend, accountId, model: null, effort: null } },
  });

  it('非法配置返回 400；默认 native，deny 含 delegate 系列', async () => {
    expect((await post('/api/subagents', { mode: 'bad' })).status).toBe(400);
    expect((await post('/api/subagents', {})).status).toBe(400);
    expect((await refresh('0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a14')).nativeAgents).toBe(true);
  }, 30_000);

  it('切到 claude / agy 后落盘并立即停用整个 Agent、放行 delegate；新进程启动就带上；切回 native 后恢复', async () => {
    const r = await post('/api/subagents', delegateCfg('claude'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; state: SubagentState };
    expect(body.ok).toBe(true);
    expect(body.state.effective).toBe('delegate');
    expect(lastDeny()).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    await savedSub('delegate', 'claude');

    const ctx = await refresh('0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a15');
    expect(ctx.nativeAgents).toBe(false);
    expect(ctx.disabledTools).toEqual([]);
    expect(ctx.disabledAgents).toEqual([]);
    const argv = JSON.parse(log().filter((l) => l.startsWith('ARGS ')).pop()!.slice(5)) as string[];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual([...NATIVE_SUBAGENT_TOOLS]);

    await post('/api/subagents', delegateCfg('agy'));
    expect(lastDeny()).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    await savedSub('delegate', 'agy');

    await post('/api/subagents', nativeCfg());
    expect(lastDeny()).toEqual([...DELEGATE_TOOL_NAMES]);
    await savedSub('native');
  }, 30_000);

  it('委派模式下手动停用 delegate：立即退回 native（放行 Agent）；重新启用后又停用 Agent', async () => {
    await post('/api/subagents', delegateCfg('claude'));
    srv.store.state.disabledTools = ['mcp__cosyee__delegate'];
    await post('/api/tools', { name: 'Glob', enabled: false });
    expect(lastDeny()).toEqual(['mcp__cosyee__delegate', 'Glob', ...DELEGATE_TOOL_NAMES.slice(1)]);
    srv.store.state.disabledTools = ['Glob'];
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(lastDeny()).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    await post('/api/subagents', nativeCfg());
  }, 30_000);

  it('不修改用户级 / 项目级 settings.json（含用户自定义 deny、注释、损坏 JSON），且多工作区运行中会话同时生效、无重复项', async () => {
    const userSettingsPath = path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    const userContent = JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)', 'CustomRule'] } }, null, 2);
    fs.writeFileSync(userSettingsPath, userContent);

    const cwd2 = path.join(tmp, 'ws2');
    fs.mkdirSync(path.join(cwd2, '.claude'), { recursive: true });
    // 项目级 settings.json 带 JSONC 注释与损坏内容：不应影响切换，也不应被改写
    const projSettingsPath = path.join(cwd2, '.claude', 'settings.json');
    const projContent = '// user comment\n{ "permissions": { "deny": ["Read(.env)"] }, broken';
    fs.writeFileSync(projSettingsPath, projContent);
    srv.workspaces.add(cwd2);

    // 在第二个工作区也拉起一个运行中进程
    const sid2 = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a20';
    await post(`/api/context/${sid2}/refresh`, { cwd: cwd2, draft: true });

    const beforeApplies = log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).length;
    await post('/api/subagents', delegateCfg('claude'));
    const afterClaude = log()
      .filter((l) => l.startsWith('CTRL apply_flag_settings '))
      .slice(beforeApplies)
      .map((l) => (JSON.parse(l.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } }).permissions.deny);
    // 多个运行中进程都立即收到 apply_flag_settings，且严格互斥（含 Agent，不含 delegate，无重复）
    expect(afterClaude.length).toBeGreaterThanOrEqual(2);
    for (const d of afterClaude) {
      expect(d).toContain('Agent');
      expect(new Set(d).size).toBe(d.length);
      for (const name of DELEGATE_TOOL_NAMES) expect(d).not.toContain(name);
    }

    // 切回 native：所有运行中进程立即放行 Agent、停用全部 delegate，无重复
    const beforeNative = log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).length;
    await post('/api/subagents', nativeCfg());
    const afterNative = log()
      .filter((l) => l.startsWith('CTRL apply_flag_settings '))
      .slice(beforeNative)
      .map((l) => (JSON.parse(l.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } }).permissions.deny);
    expect(afterNative.length).toBeGreaterThanOrEqual(2);
    for (const d of afterNative) {
      expect(d).not.toContain('Agent');
      expect(new Set(d).size).toBe(d.length);
      for (const name of DELEGATE_TOOL_NAMES) expect(d).toContain(name);
    }

    // 用户级与项目级 settings.json 纹丝未动
    expect(fs.readFileSync(userSettingsPath, 'utf8')).toBe(userContent);
    expect(fs.readFileSync(projSettingsPath, 'utf8')).toBe(projContent);
  }, 30_000);

  it('委派后端不可用时退回原生：接口 effective 与运行中进程 permissions.deny 保持一致', async () => {
    // 另起一个服务实例，清空 COSYEE_AGY 和 PATH/LOCALAPPDATA 让 agy 不可用，claude 仍可用
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-fallback-'));
    const log2 = path.join(tmp2, 'log.txt');
    const prevAgy = process.env.COSYEE_AGY;
    const prevPath = process.env.PATH;
    const prevPathWin = process.env.Path;
    const prevLocal = process.env.LOCALAPPDATA;
    const prevFakeLog = process.env.FAKE_LOG;
    delete process.env.COSYEE_AGY;
    process.env.PATH = '';
    if ('Path' in process.env) process.env.Path = '';
    process.env.LOCALAPPDATA = path.join(tmp2, 'empty-local');
    process.env.FAKE_LOG = log2;
    const srv2 = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp2, 'state.json'),
      claudePath: process.env.COSYEE_CLAUDE,
    });
    try {
      const ws = path.join(tmp2, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      srv2.workspaces.add(ws);
      const post2 = (p: string, body: unknown) =>
        fetch(`http://127.0.0.1:${srv2.port}${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      // 拉起运行中进程
      await post2('/api/context/0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a21/refresh', { cwd: ws, draft: true });
      // 尝试切到不可用的 agy -> 服务端保存 mode='delegate'，但 effective 退回 'native'
      const r = await post2('/api/subagents', delegateCfg('agy', 'abcd1234'));
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; state: SubagentState };
      expect(body.state.config.mode).toBe('delegate');
      expect(body.state.effective).toBe('native');
      expect(body.state.fallbackReason).toBeTruthy();
      // 运行中进程收到的 deny 仍保持原生模式（放行 Agent、停用 delegate）
      const lines = fs.readFileSync(log2, 'utf8').split('\n').filter((l) => l.startsWith('CTRL apply_flag_settings '));
      const last = (JSON.parse(lines.pop()!.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } }).permissions.deny;
      expect(last).not.toContain('Agent');
      expect(last).toEqual([...DELEGATE_TOOL_NAMES]);
    } finally {
      await srv2.stop();
      if (prevAgy === undefined) delete process.env.COSYEE_AGY;
      else process.env.COSYEE_AGY = prevAgy;
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevPathWin !== undefined) process.env.Path = prevPathWin;
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocal;
      if (prevFakeLog === undefined) delete process.env.FAKE_LOG;
      else process.env.FAKE_LOG = prevFakeLog;
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  }, 30_000);
});
