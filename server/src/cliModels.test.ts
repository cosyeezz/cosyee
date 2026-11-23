// 模型菜单的数据源：initialize 响应的解析、按账号缓存、失败保留旧值、落盘与后台重拉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliModelsDisk, CliModelsProvider, parseCliModels, type FetchedModels } from './cliModels.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');

/** control-probe.jsonl 里 initialize 的 response（含 account 等字段） */
function initResponse(): Record<string, unknown> {
  for (const line of fs.readFileSync(path.join(FIX, 'control-probe.jsonl'), 'utf8').split('\n')) {
    if (!line.includes('"models"')) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_response' && Array.isArray(m.response?.response?.models)) return m.response.response;
  }
  throw new Error('fixture 里没有 initialize 响应');
}

describe('parseCliModels', () => {
  it('fixture：去掉 default，别名在前，全名保留，只留模型字段', () => {
    const r = initResponse();
    expect(r.account).toBeDefined(); // fixture 里确实有账号信息……
    const list = parseCliModels(r)!;
    expect(list.map((m) => m.value).slice(0, 4)).toEqual(['opus', 'sonnet', 'fable', 'haiku']);
    expect(list.some((m) => m.value === 'default')).toBe(false);
    expect(list.find((m) => m.value === 'opus')).toMatchObject({ displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' });
    // ……但结果里只有模型字段
    for (const m of list) {
      expect(Object.keys(m).every((k) => ['value', 'resolvedModel', 'displayName', 'description', 'efforts'].includes(k))).toBe(true);
    }
    expect(JSON.stringify(list)).not.toMatch(/@|email|organization/i);
  });

  it('强度：没有 supportedEffortLevels 的 = 不支持；未知档位丢掉；只给 supportsEffort 的 = 全部 5 档', () => {
    const list = parseCliModels({
      models: [
        { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', supportsThinkingOff: true },
        { value: 'claude-opus-4-6', displayName: 'Opus 4.6', supportedEffortLevels: ['low', 'medium', 'high', 'max', 'turbo'] },
        { value: 'x', displayName: 'X', supportsEffort: true },
      ],
    })!;
    expect(list[0]!.efforts).toBeUndefined();
    expect(list[1]!.efforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(list[2]!.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('非法 / 重复的 value 丢掉；没有 displayName 用 value；一个都没有返回 null', () => {
    const list = parseCliModels({
      models: [{ value: 'a b' }, { value: 'qwen3' }, { value: 'qwen3', displayName: 'dup' }, null, 'str', { displayName: 'no value' }],
    })!;
    expect(list).toEqual([{ value: 'qwen3', displayName: 'qwen3' }]);
    expect(parseCliModels({ models: [{ value: 'default' }] })).toBeNull();
    expect(parseCliModels(null)).toBeNull();
    expect(parseCliModels({})).toBeNull();
  });
});

const fetched = (...values: string[]): FetchedModels => ({ models: values.map((v) => ({ value: v, displayName: v })), cli: '2.1.0' });

describe('CliModelsProvider', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });
  const diskFile = () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-models-'));
    return path.join(tmp, 'cli-models.json');
  };

  it('缓存：第二次不再起进程；并发只拉一次', async () => {
    const fetcher = vi.fn(async () => fetched('sonnet'));
    const p = new CliModelsProvider({ id: 'a', fetcher });
    const [x, y] = await Promise.all([p.get(), p.get()]);
    expect(x?.models.map((m) => m.value)).toEqual(['sonnet']);
    expect(y).toBe(x);
    await p.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refresh：10 秒内不重复拉，之后重拉', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async () => fetched('sonnet'));
    const p = new CliModelsProvider({ id: 'a', fetcher, now: () => now });
    await p.get();
    await p.get(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 11_000;
    await p.get(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('失败时保留上一次成功的结果；全都失败返回 null', async () => {
    let now = 0;
    const fetcher = vi.fn<() => Promise<FetchedModels | null>>().mockResolvedValueOnce(fetched('opus')).mockResolvedValue(null);
    const p = new CliModelsProvider({ id: 'a', fetcher, now: () => now });
    await p.get();
    now += 11_000;
    expect((await p.get(true))?.models[0]!.value).toBe('opus');

    const q = new CliModelsProvider({ id: 'b', fetcher: async () => { throw new Error('boom'); } });
    expect(await q.get()).toBeNull();
  });

  it('reset：在途结果丢弃，下次重拉', async () => {
    let release!: (v: FetchedModels) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<FetchedModels>((r) => (release = r)))
      .mockResolvedValue(fetched('haiku'));
    const p = new CliModelsProvider({ id: 'a', fetcher });
    const first = p.get();
    p.reset();
    release(fetched('opus'));
    expect(await first).toBeNull();
    expect((await p.get())?.models[0]!.value).toBe('haiku');
  });

  it('落盘：新进程先用落盘的（同时后台重拉一次），reset 删掉落盘条目', async () => {
    const file = diskFile();
    const a = new CliModelsProvider({ id: 'acc', fetcher: async () => fetched('opus', 'sonnet'), disk: new CliModelsDisk(file) });
    await a.get();
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['acc']);

    // 模拟服务重启：新的 disk / provider
    let release!: (v: FetchedModels) => void;
    const fetcher = vi.fn(() => new Promise<FetchedModels>((r) => (release = r)));
    const disk = new CliModelsDisk(file);
    const b = new CliModelsProvider({ id: 'acc', fetcher, disk });
    expect((await b.get())?.models.map((m) => m.value)).toEqual(['opus', 'sonnet']); // 立即返回，不等进程
    expect(fetcher).toHaveBeenCalledTimes(1); // 后台在重拉
    release(fetched('fable'));
    await vi.waitFor(async () => expect((await b.get())?.models[0]!.value).toBe('fable'));
    expect(fetcher).toHaveBeenCalledTimes(1);

    b.reset();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('落盘文件坏了 / 字段不合法：当没有', async () => {
    const file = diskFile();
    fs.writeFileSync(file, '{ not json');
    const fetcher = vi.fn(async () => fetched('sonnet'));
    expect((await new CliModelsProvider({ id: 'a', fetcher, disk: new CliModelsDisk(file) }).get())?.models[0]!.value).toBe('sonnet');

    fs.writeFileSync(file, JSON.stringify({ a: { at: 1, models: [{ value: 'a b' }] }, b: { at: 'x', models: [{ value: 'ok' }] } }));
    const disk = new CliModelsDisk(file);
    expect(disk.get('a')).toBeUndefined();
    expect(disk.get('b')).toBeUndefined();
  });
});
