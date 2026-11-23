// API 账号的模型映射：规范化、环境变量注入、模型列表探测与解析。
import { describe, expect, it, vi } from 'vitest';
import { applyApiEnv, normalizeModelMap } from './accounts/api-config.js';
import { candidateUrls, fetchModelList, parseModels } from './accounts/model-list.js';

describe('normalizeModelMap', () => {
  it('一项都没有时返回 null（= 不介入）', () => {
    expect(normalizeModelMap(undefined)).toBeNull();
    expect(normalizeModelMap({})).toBeNull();
    expect(normalizeModelMap({ alias: {} })).toBeNull();
    expect(normalizeModelMap({ alias: { sonnet: { id: '  ' } }, extra: [] })).toBeNull();
  });

  it('别名只认 sonnet / opus / fable / haiku，字符串简写等价于 { id }', () => {
    const m = normalizeModelMap({ alias: { sonnet: 'deepseek-v3.2', gpt: 'x', opus: { id: 'kimi-k2', label: 'Kimi', m1: true } } });
    expect(m?.alias).toEqual({ sonnet: { id: 'deepseek-v3.2' }, opus: { id: 'kimi-k2', label: 'Kimi', m1: true } });
  });

  it('放过第三方的 provider/model 与 model:tag，挡掉带空格 / 引号的', () => {
    const m = normalizeModelMap({
      alias: { sonnet: 'deepseek/deepseek-v3.2', opus: 'qwen:72b', haiku: 'bad name', fable: 'x"y' },
    });
    expect(m?.alias).toEqual({ sonnet: { id: 'deepseek/deepseek-v3.2' }, opus: { id: 'qwen:72b' } });
  });

  it('extra 去重、丢非法项', () => {
    const m = normalizeModelMap({ extra: ['a', 'a', { id: 'b', label: ' B ' }, { id: '' }, 'c d'] });
    expect(m?.extra).toEqual([{ id: 'a' }, { id: 'b', label: 'B' }]);
  });

  it('subagent / fallback 只收合法 id', () => {
    expect(normalizeModelMap({ subagent: 'deepseek-v3.2', fallback: 'bad name' })).toEqual({ subagent: 'deepseek-v3.2' });
  });
});

describe('applyApiEnv 的模型映射', () => {
  const cfg = { baseUrl: 'https://proxy.test', apiKey: 'sk-1', authType: 'apiKey' as const };

  it('没有映射时一个模型变量都不写', () => {
    const env: NodeJS.ProcessEnv = {};
    applyApiEnv(env, cfg);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.test');
    expect(Object.keys(env).filter((k) => k.includes('MODEL'))).toEqual([]);
  });

  it('按别名写 CLI 的重映射变量；label 写 _NAME；m1 加 [1m] 后缀', () => {
    const env: NodeJS.ProcessEnv = {};
    applyApiEnv(env, {
      ...cfg,
      models: {
        alias: {
          sonnet: { id: 'deepseek-v3.2', label: 'DeepSeek', m1: true },
          haiku: { id: 'minimax-m2.5' },
        },
        subagent: 'qwen3-coder-next',
        fallback: 'kimi-k2',
      },
    });
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v3.2[1m]');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe('DeepSeek');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('minimax-m2.5');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('qwen3-coder-next');
    expect(env.ANTHROPIC_DEFAULT_MODEL).toBe('kimi-k2');
    // 没配的别名不写，保持 CLI 默认
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it('清掉外部环境继承来的模型变量（含会抢先于 HAIKU 的 SMALL_FAST_MODEL）', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_SMALL_FAST_MODEL: '外部的',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '外部的',
      anthropic_model: '外部的',
      CLAUDE_CODE_SUBAGENT_MODEL: '外部的',
    };
    applyApiEnv(env, { ...cfg, models: { alias: { haiku: { id: 'minimax-m2.5' } } } });
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(env.anthropic_model).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('minimax-m2.5');
  });
});

describe('模型列表探测', () => {
  it('候选端点：baseUrl 已以 /v1 结尾时不重复加', () => {
    expect(candidateUrls('')).toEqual(['https://api.anthropic.com/v1/models', 'https://api.anthropic.com/models']);
    expect(candidateUrls('https://p.test/')).toEqual(['https://p.test/v1/models', 'https://p.test/models']);
    expect(candidateUrls('https://p.test/v1')).toEqual(['https://p.test/v1/models']);
  });

  it('解析 OpenAI / Anthropic 风格与纯字符串数组', () => {
    expect(parseModels({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(parseModels({ models: ['a', { name: 'b' }, { model: 'c' }] })).toEqual(['a', 'b', 'c']);
    expect(parseModels(['a', 'a', 'bad name', ''])).toEqual(['a']);
    expect(parseModels({ nope: 1 })).toEqual([]);
  });

  it('第一个端点 404 时退到第二个；认证头按 authType 给', () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (String(url).endsWith('/v1/models')) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    return fetchModelList({ baseUrl: 'https://p.test', apiKey: 'sk-2', authType: 'authToken' }, fetchImpl).then((r) => {
      expect(r).toEqual({ url: 'https://p.test/models', models: ['gpt-5.6-sol'] });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.headers.authorization).toBe('Bearer sk-2');
      expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    });
  });

  it('全部失败时抛出最后一个原因', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchModelList({ baseUrl: 'https://p.test/v1', apiKey: 'k', authType: 'apiKey' }, fetchImpl))
      .rejects.toThrow(/HTTP 500/);
  });
});
