// 语音模型就绪保证：未就绪则触发下载并轮询进度，就绪后返回。
import type { SpeechAssetStatus, SpeechKind } from '@cosyee/shared';
import { api } from '../api';

const POLL_MS = 1000;

function pctOf(s: SpeechAssetStatus): number | null {
  return s.total ? Math.min(100, Math.round(((s.received ?? 0) / s.total) * 100)) : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function ensureSpeech(
  kind: SpeechKind,
  onProgress?: (pct: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  let st = (await api.speechStatus())[kind];
  if (st.phase === 'ready') return;
  st = (await api.speechPrepare(kind))[kind];
  for (;;) {
    if (st.phase === 'ready') return;
    if (st.phase === 'error') throw new Error(st.error ?? '语音模型准备失败');
    onProgress?.(pctOf(st));
    await sleep(POLL_MS, signal); // 被取消时这里抛 AbortError，调用方按需忽略
    st = (await api.speechStatus())[kind];
  }
}
