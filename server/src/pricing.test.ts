import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PRICES, type ModelPrice } from '@cosyee/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingService, mergeWithBuiltin, parsePricingMarkdown, validateParsed } from './pricing.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/pricing.md');
const md = fs.readFileSync(FIX, 'utf8');
const get = (models: ModelPrice[], id: string) => models.find((m) => m.id === id);

describe('parsePricingMarkdown', () => {
  const models = parsePricingMarkdown(md);

  it('基础价：带脚注 / 链接 / 备注的模型名都能归一', () => {
    expect(get(models, 'claude-opus-5-5')).toMatchObject({ label: 'Claude Opus 5.5', input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 });
    expect(get(models, 'claude-mythos-5-2')).toMatchObject({ input: 8, read: 0.2 });
    expect(get(models, 'claude-opus-4-1')).toMatchObject({ input: 15, output: 75 });
    expect(get(models, 'claude-sonnet-4')).toMatchObject({ input: 3, read: 0.3 });
    expect(get(models, 'claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
  });

  it('fast 模式价（含「A / B」一行多个模型）', () => {
    expect(get(models, 'claude-opus-5-5')!.fast).toEqual({ input: 8, output: 40 });
    expect(get(models, 'claude-fable-5-2')!.fast).toEqual({ input: 16, output: 80 });
    expect(get(models, 'claude-mythos-5-2')!.fast).toEqual({ input: 16, output: 80 });
    expect(get(models, 'claude-opus-5')!.fast).toEqual({ input: 10, output: 50 });
    expect(get(models, 'claude-opus-4-8')!.fast).toEqual({ input: 10, output: 50 });
    expect(get(models, 'claude-opus-4-7')!.fast).toBeUndefined();
  });

  it('长上下文：Haiku 5.5 两行合成一个模型', () => {
    expect(models.filter((m) => m.id === 'claude-haiku-5-5')).toHaveLength(1);
    const h = get(models, 'claude-haiku-5-5')!;
    expect(h).toMatchObject({ input: 0.1, output: 0.5 });
    expect(h.long).toEqual({ threshold: 100000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 });
  });

  it('通过校验；垃圾输入不抛异常且校验失败', () => {
    expect(validateParsed(models)).toBe(true);
    for (const junk of ['', 'hello', '## Model pricing\n| a | b |\n| - | - |\n| x | y |', '| Claude Opus 4 | $1 / MTok |']) {
      expect(validateParsed(parsePricingMarkdown(junk))).toBe(false);
    }
  });

  it('内置价格表与官方页面（fixture）一致', () => {
    for (const b of BUILTIN_PRICES.models.filter((m) => m.id.startsWith('claude-'))) {
      expect(get(models, b.id), b.id).toEqual(b);
    }
  });
});

describe('validateParsed', () => {
  const ok = parsePricingMarkdown(md);
  it('价格非法或缺系列时失败', () => {
    expect(validateParsed(ok.slice(0, 4))).toBe(false);
    expect(validateParsed(ok.map((m) => (m.id === 'claude-opus-5' ? { ...m, input: 0 } : m)))).toBe(false);
    expect(validateParsed(ok.map((m) => (m.id === 'claude-opus-5' ? { ...m, output: 5000 } : m)))).toBe(false);
    expect(validateParsed(ok.map((m) => (m.id === 'claude-opus-5' ? { ...m, output: NaN } : m)))).toBe(false);
    expect(validateParsed(ok.filter((m) => !m.id.startsWith('claude-haiku')))).toBe(false);
  });
});

describe('mergeWithBuiltin', () => {
  it('官方覆盖内置、缺 long / fast 沿用内置、新 id 追加', () => {
    const merged = mergeWithBuiltin([
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.2, write5m: 0.25, write1h: 0.4, read: 0.02, output: 1 },
      { id: 'claude-opus-9', label: 'Claude Opus 9', input: 1, write5m: 1, write1h: 1, read: 1, output: 1 },
    ]);
    expect(merged).toHaveLength(BUILTIN_PRICES.models.length + 1);
    expect(get(merged, 'claude-haiku-5-5')).toMatchObject({ input: 0.2, long: BUILTIN_PRICES.models.find((m) => m.id === 'claude-haiku-5-5')!.long });
    expect(get(merged, 'claude-opus-9')).toBeTruthy();
    expect(get(merged, 'claude-opus-5-5')).toEqual(get(BUILTIN_PRICES.models, 'claude-opus-5-5'));
  });
});

describe('PricingService', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-pricing-'));
    file = path.join(dir, 'sub', 'pricing.json');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fakeFetch = (body: string, status = 200) =>
    vi.fn(async (..._a: Parameters<typeof fetch>) => new Response(body, { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it('没有缓存时用内置表', () => {
    const s = new PricingService({ file });
    expect(s.table()).toBe(BUILTIN_PRICES);
  });

  it('抓取成功：更新为 official 并原子写缓存；请求头只有 user-agent / accept', async () => {
    const f = fakeFetch(md);
    const s = new PricingService({ file, fetchImpl: f, now: () => 12345 });
    await s.refresh();
    expect(s.table().source).toBe('official');
    expect(s.table().fetchedAt).toBe(12345);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.fetchedAt).toBe(12345);
    expect(validateParsed(saved.models)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['pricing.json']);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ 'user-agent': 'cosyee', accept: 'text/markdown,text/plain,*/*' });
  });

  it('抓取失败（网络错误 / 非 200）：保留内置表，不抛异常', async () => {
    const bad = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const s1 = new PricingService({ file, fetchImpl: bad });
    await expect(s1.refresh()).resolves.toBeUndefined();
    expect(s1.table()).toBe(BUILTIN_PRICES);
    const s2 = new PricingService({ file, fetchImpl: fakeFetch('x', 500) });
    await s2.refresh();
    expect(s2.table()).toBe(BUILTIN_PRICES);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('构造时加载磁盘缓存；之后返回垃圾内容仍保留之前的表', async () => {
    const parsed = parsePricingMarkdown(md).map((m) => (m.id === 'claude-opus-5-5' ? { ...m, input: 3.5 } : m));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 777, models: parsed }));
    const s = new PricingService({ file, fetchImpl: fakeFetch('这不是价格页') });
    expect(s.table().source).toBe('official');
    expect(s.table().fetchedAt).toBe(777);
    expect(get(s.table().models, 'claude-opus-5-5')!.input).toBe(3.5);
    await s.refresh();
    expect(s.table().fetchedAt).toBe(777);
    expect(get(s.table().models, 'claude-opus-5-5')!.input).toBe(3.5);
  });

  it('缓存损坏 / 不可信时忽略', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{oops');
    expect(new PricingService({ file }).table()).toBe(BUILTIN_PRICES);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, models: [] }));
    expect(new PricingService({ file }).table()).toBe(BUILTIN_PRICES);
  });

  it('start：缓存新鲜则不立即抓取；过期才抓；COSYEE_NO_PRICING_FETCH=1 时什么也不做', async () => {
    const parsed = parsePricingMarkdown(md);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1000, models: parsed }));
    const prev = process.env.COSYEE_NO_PRICING_FETCH;
    delete process.env.COSYEE_NO_PRICING_FETCH; // vitest.config 里全局设了 1

    const fresh = fakeFetch(md);
    const s1 = new PricingService({ file, fetchImpl: fresh, now: () => 2000, intervalMs: 10_000 });
    s1.start();
    s1.stop();
    expect(fresh).not.toHaveBeenCalled();

    const stale = fakeFetch(md);
    const s2 = new PricingService({ file, fetchImpl: stale, now: () => 50_000, intervalMs: 10_000 });
    s2.start();
    s2.stop();
    expect(stale).toHaveBeenCalledTimes(1);

    process.env.COSYEE_NO_PRICING_FETCH = '1';
    try {
      const off = fakeFetch(md);
      const s3 = new PricingService({ file, fetchImpl: off, now: () => 50_000, intervalMs: 10_000 });
      s3.start();
      s3.stop();
      expect(off).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.COSYEE_NO_PRICING_FETCH;
      else process.env.COSYEE_NO_PRICING_FETCH = prev;
    }
  });
});
