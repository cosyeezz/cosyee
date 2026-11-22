// 非安全上下文（通过 http://<Tailscale IP> 等非 localhost 地址访问）里不可用的浏览器 API 的兜底实现。
// crypto.randomUUID、navigator.clipboard 只在 HTTPS / localhost 下存在；crypto.getRandomValues、execCommand 则不受限制。

/** RFC 4122 v4 UUID。优先 crypto.randomUUID，不可用时用 getRandomValues 拼。 */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 复制文字到剪贴板，成功返回 true，失败静默返回 false。非安全上下文退回 execCommand('copy')。 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 没有权限等：再试旧办法 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  const prev = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.();
  return ok;
}
