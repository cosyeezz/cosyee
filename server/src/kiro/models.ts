// Kiro 模型映射：从内置 kiro.rs 服务的 /v1/models 拉取账号可用的模型，
// 每个系列（opus / sonnet / fable / haiku）取版本最高的一个做别名重映射，其余进「自定义模型」。
import type { ApiModelMap, ApiModelTarget, ModelAlias } from '@cosyee/shared';
import { MODEL_ALIASES } from '@cosyee/shared';
import { parseModels } from '../accounts/model-list.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
/** claude-<系列>-<主版本>[-或.<次版本>][-<8 位日期>]（Kiro 用 claude-sonnet-5.5 这种点号写法） */
const MODEL_RE = /^claude-(opus|sonnet|fable|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:-(\d{8}))?$/;

interface ParsedModel {
  family: ModelAlias;
  major: number;
  minor: number;
  date: number;
}

function parseModelId(id: string): ParsedModel | null {
  const m = MODEL_RE.exec(id);
  if (!m) return null;
  return {
    family: m[1] as ModelAlias,
    major: Number(m[2]),
    minor: m[3] ? Number(m[3]) : 0,
    date: m[4] ? Number(m[4]) : 0,
  };
}

/** 版本比较：先主版本，再次版本，日期只在同版本里决胜；a 更新返回正数 */
function compareVersion(a: ParsedModel, b: ParsedModel): number {
  return a.major - b.major || a.minor - b.minor || a.date - b.date;
}

/**
 * 模型 id 列表 → 映射表。纯函数：
 * - 每个系列版本最高的进 alias[系列]；没有的系列不配
 * - 其余（旧版本、认不出的）进 extra
 * - 带 -thinking 后缀的丢掉（Kiro 的 thinking 变体由客户端参数控制，不单独当模型）
 * 一个模型都没有时返回 null。
 */
export function buildKiroModelMap(ids: readonly string[]): ApiModelMap | null {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || id.endsWith('-thinking') || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }

  const best = new Map<ModelAlias, { id: string; p: ParsedModel }>();
  for (const id of list) {
    const p = parseModelId(id);
    if (!p) continue;
    const cur = best.get(p.family);
    if (!cur || compareVersion(p, cur.p) > 0) best.set(p.family, { id, p });
  }

  const alias: Partial<Record<ModelAlias, ApiModelTarget>> = {};
  const picked = new Set<string>();
  for (const a of MODEL_ALIASES) {
    const b = best.get(a);
    if (!b) continue;
    alias[a] = { id: b.id };
    picked.add(b.id);
  }
  const extra: ApiModelTarget[] = list.filter((id) => !picked.has(id)).map((id) => ({ id }));

  const out: ApiModelMap = {};
  if (Object.keys(alias).length) out.alias = alias;
  if (extra.length) out.extra = extra;
  return Object.keys(out).length ? out : null;
}

/** 用某个账号的客户端 Key 拉模型列表（服务只返回该 Key 所在分组的凭据能用的模型）；已丢掉 -thinking */
export async function fetchKiroModels(
  port: number,
  clientKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
    headers: { 'x-api-key': clientKey, accept: 'application/json', 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`拉取 Kiro 模型列表失败（HTTP ${res.status}）`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('Kiro 模型列表响应过大');
  const ids = parseModels(JSON.parse(new TextDecoder().decode(buf))).filter((id) => !id.endsWith('-thinking'));
  if (!ids.length) throw new Error('Kiro 没有返回可用模型');
  return ids;
}
