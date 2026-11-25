// 入口：启动服务、打印访问地址、处理退出信号。接口约定见 shared/src/protocol.ts。
// 源码运行（npm run dev / npm start）和独立服务端包（server/scripts/bundle.mjs 打出的 server.mjs）共用这个入口。
import os from 'node:os';
import { TAILSCALE_MODE, devPort, setTailscaleNames, tailscaleAddrs } from './security.js';
import { startServer } from './server.js';
import { ensureTailscaleHttps, magicDnsShortName, tailscaleSelf } from './tailscaleHttps.js';

/** 打包时由 esbuild 注入；用 tsx 跑源码时没有（startServer 自己读 package.json） */
declare const __COSYEE_VERSION__: string | undefined;

async function main(): Promise<void> {
  // 默认 Tailscale 模式（本机 + tailnet 内设备可访问）；只给本机用时设 COSYEE_HOST=127.0.0.1（或 cosyee-server --local）。
  // 桌面版走 desktop-entry.ts，不受影响。
  if (!process.env.COSYEE_HOST) process.env.COSYEE_HOST = TAILSCALE_MODE;
  const bundled = typeof __COSYEE_VERSION__ === 'string';
  let requestShutdown: (sig: string) => void = () => {};
  let httpsUrl: string | null = null;
  const srv = await startServer({
    // 语音模型默认在后台预先下载；不需要语音时设 COSYEE_SPEECH=0
    prefetchSpeech: process.env.COSYEE_SPEECH !== '0',
    httpsUrl: () => httpsUrl,
    version: bundled ? __COSYEE_VERSION__ : undefined,
    // 客户端「停止本地服务」（Windows 上后台进程收不到信号，只能走接口）
    onShutdown: () => requestShutdown('POST /api/shutdown'),
  });
  const bindHost = process.env.COSYEE_HOST;
  // 源码运行时开发前端跑在 Vite（COSYEE_WEB_PORT）；生产 / 独立包由本服务托管
  if (!bundled) console.log(`Cosyee（开发，Vite）: http://127.0.0.1:${devPort()}/`);
  console.log(`Cosyee: http://127.0.0.1:${srv.port}/`);
  if (bindHost === TAILSCALE_MODE) {
    const ips = tailscaleAddrs().filter((a) => !a.includes(':'));
    if (ips.length === 0) console.warn('提示：还没检测到 Tailscale 网卡（Tailscale 没启动或没登录）。启动后无需重启本服务，直接用 Tailscale 地址访问即可。');
    for (const ip of ips) console.log(`Cosyee（Tailscale）: http://${ip}:${srv.port}/`);
    // Tailscale 里的机器名可以跟系统主机名不同（管理后台改过名），以 tailscale status 为准，补进 Host 白名单
    const self = await tailscaleSelf();
    const tsName = self ? magicDnsShortName(self.dns) : '';
    if (tsName) setTailscaleNames([tsName]);
    console.log(`Cosyee（MagicDNS）: http://${tsName || os.hostname().toLowerCase().replace(/\.local$/, '')}:${srv.port}/`);
    console.log('只接受本机和 tailnet 内设备的连接，不需要令牌。');
    void ensureTailscaleHttps(srv.port, self).then((u) => {
      httpsUrl = u;
      if (u) console.log(`Cosyee（HTTPS，可用语音输入）: ${u}/`);
    });
  } else if (bindHost !== '127.0.0.1') {
    console.log(`Cosyee: http://${bindHost === '0.0.0.0' ? '<本机局域网 IP>' : bindHost}:${srv.port}/`);
    console.warn(`警告：监听 ${bindHost}，且没有访问令牌——同一网络里的任何人都能在本机执行任意命令。跨设备访问请改用 COSYEE_HOST=tailscale。`);
  }

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${sig}，正在关闭…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    srv.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  requestShutdown = shutdown;
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // 兜底：进程无论如何退出，都同步杀掉还活着的 claude 子进程树
  process.on('exit', () => srv.manager.killAllSync());
}

main().catch((e) => {
  console.error('启动失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
