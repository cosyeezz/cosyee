// 经 http 远程访问（http://100.x.x.x:7878）时，浏览器不给麦克风权限：服务端开了 Tailscale HTTPS 入口
// （Bootstrap.httpsUrl）时自动跳过去，语音输入和通话就都能用。先探测一下 HTTPS 地址通不通，
// 不通（证书还没签好、这台设备解析不了 MagicDNS 名）就留在当前页面，不把人跳到错误页。

/** 当前页面是否需要换到 HTTPS（已是安全上下文 / 已经在那个地址上时不需要） */
export function needsHttps(httpsUrl: string, loc: Pick<Location, 'origin'> = location, secure = window.isSecureContext): boolean {
  if (secure) return false;
  try {
    return new URL(httpsUrl).origin !== loc.origin;
  } catch {
    return false;
  }
}

export async function upgradeToHttps(httpsUrl: string): Promise<void> {
  if (!needsHttps(httpsUrl)) return;
  const base = httpsUrl.replace(/\/+$/, '');
  try {
    // no-cors：跨源也能发出去，拿到的是不透明响应；只要不抛错就说明 TLS 握手和连接都通
    await fetch(`${base}/api/bootstrap`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  } catch {
    return;
  }
  location.replace(base + location.pathname + location.search + location.hash);
}
