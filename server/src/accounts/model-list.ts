// 拉取服务商的模型列表，供映射表的下拉用。由服务端代发（密钥不出本机，也绕开浏览器跨域）。
// 兼容两种常见响应：OpenAI / Anthropic 风格的 { data: [{ id }] }，以及 { models: [...] } 和纯字符串数组。
import type { ApiModelListing } from '@cosyee/shared';
import { OFFICIAL_HOST } from './api-config.js';
import type { ApiConfig } from './api-config.js';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 500;
/** 模型 id 的形状，与 api-config 里的校验一致 */
const ID_RE = /^[A-Za-z0-9._:/@+[\]-]{1,120}$/;

/** 要试的端点：baseUrl 已经以 /v1 结尾时不再重复加 */
export function candidateUrls(baseUrl: string): string[] {
  const base = (baseUrl.trim() || `https://${OFFICIAL_HOST}`).replace(/\/+$/, '');
  const out = /\/v\d+$/.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
  return [...new Set(out)];
}

function headers(cfg: Pick<ApiConfig, 'apiKey' | 'authType'>): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'anthropic-version': '2023-06-01' };
  if (cfg.authType === 'authToken') h.authorization = `Bearer ${cfg.apiKey}`;
  else h['x-api-key'] = cfg.apiKey;
  return h;
}

/** 从响应 JSON 里挑出模型 id；认不出返回空数组 */
export function parseModels(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let id: unknown;
    if (typeof r === 'string') id = r;
    else if (r && typeof r === 'object') {
      const o = r as Record<string, unknown>;
      id = o.id ?? o.name ?? o.model;
    }
    if (typeof id !== 'string') continue;
    const s = id.trim();
    if (!s || !ID_RE.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

async function readJson(res: Response): Promise<unknown> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('模型列表响应过大');
  return JSON.parse(new TextDecoder().decode(buf));
}

/**
 * 依次试候选端点，第一个拿到非空列表的算成功。
 * 全部失败时抛最后一个错误的说明（HTTP 状态或网络原因），由 http 层转成 502。
 */
export async function fetchModelList(
  cfg: Pick<ApiConfig, 'baseUrl' | 'apiKey' | 'authType'>,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiModelListing> {
  const urls = candidateUrls(cfg.baseUrl);
  let last = '';
  for (const url of urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { headers: headers(cfg), signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) {
        last = `${url} 返回 HTTP ${res.status}`;
        continue;
      }
      const models = parseModels(await readJson(res));
      if (!models.length) {
        last = `${url} 没有返回可识别的模型列表`;
        continue;
      }
      return { url, models };
    } catch (e) {
      last = `${url}：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(last || '拉取失败');
}
