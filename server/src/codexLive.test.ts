import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexBackend, CodexPool } from './delegate/codexAppServer.js';

const live = process.env.COSYEE_CODEX_LIVE === '1';

describe.skipIf(!live)('Codex 真机冒烟（COSYEE_CODEX_LIVE=1）', () => {
  it('只读提示：线程 id、流式文字、最终回答、用量；再读模型列表', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-live-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const pool = new CodexPool();
    const be = new CodexBackend({ pool });
    try {
      expect(be.availability()).toEqual({ ok: true });
      const ml = await be.models({ cwd: dir });
      console.log('LIVE models', JSON.stringify(ml));
      expect(ml.models.length).toBeGreaterThan(0);
      const updates: string[] = [];
      let sess = '';
      const r = await be.run({
        cwd: dir,
        prompt: '列出当前目录文件并回答 OK',
        readOnly: true,
        defaults: ml.current ? { model: ml.current.model, effort: ml.current.effort ?? undefined } : undefined,
        signal: new AbortController().signal,
        onUpdate: (u: any) => void updates.push(u.sessionUpdate),
        onSession: (id: string) => void (sess = id),
      } as any);
      console.log('LIVE result', JSON.stringify(r), updates);
      expect(r.sessionId).toBeTruthy();
      expect(r.sessionId).toBe(sess);
      expect(r.stopReason).toBe('end_turn');
      expect(r.response).toMatch(/OK/);
      expect(r.usage).toBeTruthy();
    } finally {
      pool.dispose();
    }
  }, 180_000);
  it('沙箱真拦截：只读（agentReadOnly）写不进文件；可写能写；续接同一会话保留上下文', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-live-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const pool = new CodexPool();
    const be = new CodexBackend({ pool });
    const tools: string[] = [];
    const run = (prompt: string, extra: Record<string, unknown>) =>
      be.run({
        cwd: dir,
        prompt,
        signal: new AbortController().signal,
        effort: 'low',
        onUpdate: (u: any) => u.sessionUpdate === 'tool_call' && tools.push(String(u.name ?? u.title ?? '')),
        ...extra,
      } as any);
    // 不在提示词里提只读：模型会真去执行，结果只能由沙箱决定
    const cmd = (f: string) => `这是沙箱自动化测试。用 shell 执行这条命令写文件：node -e "require('fs').writeFileSync('${f}','x')"。然后只回复命令的退出码和错误原文。`;
    try {
      const ro = await run(cmd('ro.txt'), { agentReadOnly: true });
      console.log('LIVE ro', ro.response);
      expect(fs.existsSync(path.join(dir, 'ro.txt'))).toBe(false);

      const rw = await run(cmd('rw.txt') + '最后再记住暗号：青鸟-42。', {});
      console.log('LIVE rw', rw.response);
      expect(fs.existsSync(path.join(dir, 'rw.txt'))).toBe(true);
      // 委派里不再派下级代理（用户的 ~/.codex/AGENTS.md 可能要求主会话只编排）：命令由本线程自己执行
      console.log('LIVE tools', tools);
      expect(tools.some((t) => /collab|subAgent/i.test(t))).toBe(false);

      const again = await run('刚才让你记住的暗号是什么？只回复暗号。', { sessionId: rw.sessionId, accountId: rw.accountId });
      console.log('LIVE resume', again.response, JSON.stringify(rw.usage), JSON.stringify(again.usage));
      expect(again.sessionId).toBe(rw.sessionId);
      expect(again.response).toMatch(/青鸟-?42/);
    } finally {
      pool.dispose();
    }
  }, 300_000);
});
