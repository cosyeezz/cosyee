import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PRICES, type LedgerWindowDetail, type LedgerWindowList } from '@cosyee/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../server.js';
import { createLedger } from './service.js';
import { FIVE_HOURS_MS, ledger as globalLedger } from './sink.js';

const BASE = Date.UTC(2026, 10, 27, 10, 0, 0);
const MIN = 60_000;

describe('createLedger 服务', () => {
  it('list 过滤与 detail 详情查询（含账号显示名与字段裁剪）', () => {
    const end = BASE + FIVE_HOURS_MS;
    const svc = createLedger({
      path: ':memory:',
      prices: () => BUILTIN_PRICES,
      accountInfo: (backend, account) => {
        if (backend === 'claude' && account === 'default') return { name: '主账号' };
        if (backend === 'codex' && account === 'acc_1') return { name: 'Codex Pro' };
        return null;
      },
      now: () => BASE + 40 * MIN,
    });

    try {
      svc.sink.snapshot({
        backend: 'claude',
        account: 'default',
        accountKind: 'subscription',
        kind: 'session',
        group: null,
        at: BASE + 10 * MIN,
        percent: 10,
        resetsAt: end,
        windowMs: FIVE_HOURS_MS,
        source: 'event',
      });
      svc.sink.snapshot({
        backend: 'claude',
        account: 'default',
        accountKind: 'subscription',
        kind: 'session',
        group: null,
        at: BASE + 30 * MIN,
        percent: 20,
        resetsAt: end,
        windowMs: FIVE_HOURS_MS,
        source: 'probe',
      });
      svc.sink.snapshot({
        backend: 'codex',
        account: 'acc_1',
        accountKind: 'subscription',
        kind: 'session',
        group: null,
        at: BASE + 15 * MIN,
        percent: 5,
        resetsAt: end + 60 * MIN,
        windowMs: FIVE_HOURS_MS,
        source: 'event',
      });
      svc.sink.record({
        backend: 'claude',
        id: 'm1',
        at: BASE + 20 * MIN,
        account: 'default',
        accountKind: 'subscription',
        session: 's1',
        layer: 'main',
        agent: null,
        toolUseId: null,
        model: 'claude-opus-5-5',
        effort: 'medium',
        input: 250_000,
        create5m: 0,
        create1h: 0,
        read: 0,
        output: 0,
        reasoning: 0,
        fast: false,
        usGeo: false,
        estimated: false,
      });

      const all = svc.list();
      expect(all.enabled).toBe(true);
      expect(all.windows).toHaveLength(2);
      // 列表项不含 rows / snapshots
      expect('rows' in all.windows[0]!).toBe(false);
      expect('snapshots' in all.windows[0]!).toBe(false);
      expect(all.windows[0]!.accountName).toBe('Codex Pro');
      expect(all.windows[1]!.accountName).toBe('主账号');

      const filtered = svc.list({ backend: 'claude', kind: 'session' });
      expect(filtered.windows).toHaveLength(1);
      const id = filtered.windows[0]!.id;

      const detail = svc.detail(id);
      expect(detail).not.toBeNull();
      expect(detail!.accountName).toBe('主账号');
      expect(detail!.rows).toHaveLength(1);
      expect(detail!.snapshots).toHaveLength(2);
      expect(detail!.estimate.usdPer100).toBeCloseTo(10, 6);

      expect(svc.detail('claude|default|session||9999999999999')).toBeNull();
      expect(svc.detail('invalid-id')).toBeNull();
    } finally {
      svc.close();
    }
  });
});

describe('HTTP /api/ledger 路由', () => {
  let srv: RunningServer | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    if (srv) {
      await srv.stop();
      srv = null;
    }
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it('GET /api/ledger/windows 与 GET /api/ledger/windows/:id 正常返回与校验', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-ledger-http-'));
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state.json'),
      pricing: { table: () => BUILTIN_PRICES },
      cliModels: false,
    });
    const base = `http://127.0.0.1:${srv.port}`;

    // 通过全局 sink 写入一条快照与请求（确保都在 [start, end) 窗口内）
    const now = Date.now();
    const end = now + FIVE_HOURS_MS - 60_000;
    globalLedger.snapshot({
      backend: 'agy',
      account: 'a1',
      accountKind: 'subscription',
      kind: 'weekly',
      group: 'Claude · GPT',
      at: now - 10_000,
      percent: 12,
      resetsAt: end,
      windowMs: FIVE_HOURS_MS,
      source: 'event',
    });
    globalLedger.record({
      backend: 'agy',
      id: 'agy_1',
      at: now - 5_000,
      account: 'a1',
      accountKind: 'subscription',
      session: null,
      layer: 'delegate',
      agent: 'reviewer',
      toolUseId: 'tu_1',
      model: 'gpt-5.4',
      effort: null,
      input: 10_000,
      create5m: 0,
      create1h: 0,
      read: 0,
      output: 2_000,
      reasoning: 500,
      fast: false,
      usGeo: false,
      estimated: true,
    });

    const listRes = await fetch(`${base}/api/ledger/windows?backend=agy`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as LedgerWindowList;
    expect(listBody.enabled).toBe(true);
    expect(listBody.windows).toHaveLength(1);
    const winId = listBody.windows[0]!.id;

    const detailRes = await fetch(`${base}/api/ledger/windows/${encodeURIComponent(winId)}`);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as LedgerWindowDetail;
    expect(detailBody.id).toBe(winId);
    expect(detailBody.group).toBe('Claude · GPT');
    expect(detailBody.rows).toHaveLength(1);
    expect(detailBody.rows[0]!.agent).toBe('reviewer');

    // 不存在的 id 返回 404；非法查询参数返回 400
    expect((await fetch(`${base}/api/ledger/windows/${encodeURIComponent('agy|a1|weekly||123')}`)).status).toBe(404);
    expect((await fetch(`${base}/api/ledger/windows?backend=invalid`)).status).toBe(400);
    expect((await fetch(`${base}/api/ledger/windows?kind=invalid`)).status).toBe(400);
  });
});
