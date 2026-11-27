import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateLargestRemainder,
  classifyTools,
  parseTranscriptToolLoad,
  TranscriptToolLoadCache,
  weightOfTool,
} from './toolLoad.js';
import { MEDIAN_TOOL_WEIGHT, STATIC_TOOL_WEIGHTS } from './toolWeights.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseTranscriptToolLoad', () => {
  it('解析初始 addedNames、增量 removedNames / readdedNames、surfacedDefinitions 与 deferred_tools_record', () => {
    const lines = [
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['WebFetch', 'WebSearch', 'Monitor', 'SendToProject'],
          removedNames: [],
          readdedNames: [],
        },
      }),
      // ToolSearch 返回 matches
      JSON.stringify({
        type: 'user',
        toolUseResult: { matches: ['WebFetch'], query: 'select:WebFetch', total_deferred_tools: 4 },
      }),
      // deferred_tools_record 提供完整定义（含实时权重）
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_record',
          entries: [{ name: 'WebFetch', description: 'fetch web page', input_schema: { type: 'object' } }],
        },
      }),
      // 后续 delta：移除 SendToProject，新增 Workflow 并 surfaced
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['Workflow'],
          removedNames: ['SendToProject'],
          readdedNames: ['Monitor'],
          surfacedNames: ['Workflow'],
          surfacedDefinitions: [
            { name: 'Workflow', definition: { name: 'Workflow', description: 'run workflow', input_schema: { type: 'object' } } },
          ],
        },
      }),
      // assistant 直接调用了 WebSearch（说明已加载），也调用了常驻 Bash（不应进入 loaded）
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'tool_use', name: 'WebSearch', input: {} },
          ],
        },
      }),
    ].join('\n');

    const st = parseTranscriptToolLoad(lines);
    expect(st.seenDelta).toBe(true);
    expect([...st.deferred].sort()).toEqual(['Monitor', 'WebFetch', 'WebSearch', 'Workflow']);
    expect([...st.loaded].sort()).toEqual(['WebFetch', 'WebSearch', 'Workflow']);
    expect(st.loaded.has('Bash')).toBe(false);
    expect(st.weights.get('WebFetch')).toBe(
      JSON.stringify({ name: 'WebFetch', description: 'fetch web page', input_schema: { type: 'object' } }).length,
    );
    expect(st.weights.get('Workflow')).toBe(
      JSON.stringify({ name: 'Workflow', description: 'run workflow', input_schema: { type: 'object' } }).length,
    );
  });

  it('compact_boundary 后收到新的 deferred_tools_delta 会重置 deferred 与 loaded，保留已采集的权重', () => {
    const lines = [
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch', 'Monitor'], removedNames: [], readdedNames: [] },
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_record',
          entries: [{ name: 'WebFetch', description: 'abc', input_schema: {} }],
        },
      }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor', 'TaskStop'], removedNames: [], readdedNames: [] },
      }),
    ].join('\n');

    const st = parseTranscriptToolLoad(lines);
    expect([...st.deferred].sort()).toEqual(['Monitor', 'TaskStop']);
    expect([...st.loaded]).toEqual([]);
    expect(st.weights.has('WebFetch')).toBe(true);
  });
});

describe('TranscriptToolLoadCache', () => {
  it('支持按 size+mtime 命中缓存与增量追加读取', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-tl-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch', 'Monitor'], removedNames: [], readdedNames: [] },
      }) + '\n',
      'utf8',
    );

    const cache = new TranscriptToolLoadCache();
    const s1 = await cache.readFile(file);
    expect(s1?.seenDelta).toBe(true);
    expect([...s1!.deferred].sort()).toEqual(['Monitor', 'WebFetch']);
    expect([...s1!.loaded]).toEqual([]);

    // 同一 mtime + size 直接返回同一快照
    const s1b = await cache.readFile(file);
    expect(s1b).toBe(s1);

    // 追加一行 ToolSearch 加载 WebFetch
    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'user', toolUseResult: { matches: ['WebFetch'] } }) + '\n',
      'utf8',
    );
    const s2 = await cache.readFile(file);
    expect([...s2!.deferred].sort()).toEqual(['Monitor', 'WebFetch']);
    expect([...s2!.loaded]).toEqual(['WebFetch']);
  });
});

describe('classifyTools 兜底顺序', () => {
  it('实时记录 > 缓存 > 静态表 > unknown；已停用工具走缓存 > 静态表 > unknown', () => {
    const live = parseTranscriptToolLoad(
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['WebFetch', 'BrandNewDeferred'],
          removedNames: [],
          readdedNames: [],
          surfacedNames: ['WebFetch'],
        },
      }),
    );

    // 有实时记录：启用工具以实时记录为准（含原本不在静态表里的 BrandNewDeferred，以及不在 deferred 里的 CustomResident）
    const res1 = classifyTools({
      enabled: ['Bash', 'WebFetch', 'BrandNewDeferred', 'CustomResident', 'mcp__cosyee__delegate'],
      disabled: ['CachedOnlyTool', 'WebSearch', 'Read', 'TotallyUnknownDisabled'],
      session: live,
      cachedDeferred: ['CachedOnlyTool'],
      cosyeeMcpLoaded: new Map([['mcp__cosyee__delegate', true]]),
    });
    expect(res1.source).toBe('session');
    expect(res1.toolLoad).toEqual({
      Bash: { load: 'resident', source: 'session' },
      WebFetch: { load: 'deferred', loaded: true, source: 'session' },
      BrandNewDeferred: { load: 'deferred', source: 'session' },
      CustomResident: { load: 'resident', source: 'session' },
      mcp__cosyee__delegate: { load: 'resident', source: 'session' },
      // 已停用工具不走 live，按 cache → static → unknown
      CachedOnlyTool: { load: 'deferred', source: 'cache' },
      WebSearch: { load: 'deferred', source: 'static' },
      Read: { load: 'resident', source: 'static' },
      TotallyUnknownDisabled: { load: 'unknown' },
    });

    // 无实时记录、有缓存
    const res2 = classifyTools({
      enabled: ['Bash', 'CachedOnlyTool', 'WebSearch', 'MysteryTool'],
      disabled: [],
      session: null,
      cachedDeferred: ['CachedOnlyTool'],
    });
    expect(res2.source).toBe('cache');
    expect(res2.toolLoad).toEqual({
      Bash: { load: 'resident', source: 'static' },
      CachedOnlyTool: { load: 'deferred', source: 'cache' },
      WebSearch: { load: 'deferred', source: 'static' },
      MysteryTool: { load: 'unknown' },
    });

    // 无实时记录、无缓存 → 静态表
    const res3 = classifyTools({
      enabled: ['Read', 'Monitor', 'MysteryTool'],
      disabled: [],
      session: null,
      cachedDeferred: [],
    });
    expect(res3.source).toBe('static');
    expect(res3.toolLoad).toEqual({
      Read: { load: 'resident', source: 'static' },
      Monitor: { load: 'deferred', source: 'static' },
      MysteryTool: { load: 'unknown' },
    });
  });
});

describe('allocateLargestRemainder & weightOfTool', () => {
  it('最大余数法保证分摊整数之和严格等于合计', () => {
    const items = [
      { name: 'Bash', weight: 4071 },
      { name: 'Read', weight: 1919 },
      { name: 'Edit', weight: 964 },
      { name: 'Glob', weight: 731 },
      { name: 'UnknownTool', weight: weightOfTool('UnknownTool') },
    ];
    expect(weightOfTool('UnknownTool')).toBe(MEDIAN_TOOL_WEIGHT);
    expect(weightOfTool('Bash')).toBe(STATIC_TOOL_WEIGHTS.Bash);
    expect(weightOfTool('Bash', new Map([['Bash', 9999]]))).toBe(9999);

    for (const total of [0, 1, 7, 100, 9849, 14052, 99991]) {
      const alloc = allocateLargestRemainder(total, items);
      const sum = [...alloc.values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(total);
      for (const v of alloc.values()) expect(Number.isInteger(v) && v >= 0).toBe(true);
    }
  });
});
