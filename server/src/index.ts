// 入口：启动服务、打印访问地址、处理退出信号。接口约定见 shared/src/protocol.ts。
// 源码运行（npm run dev / npm start）和独立服务端包（server/scripts/bundle.mjs 打出的 server.mjs）共用这个入口。
import os from 'node:os';
import { TAILSCALE_MODE, devPort, tailscaleAddrs } from './security.js';
import { startServer } from './server.js';

/** 打包时由 esbuild 注入；用 tsx 跑源码时没有（startServer 自己读 package.json） */
declare const __COSYEE_VERSION__: string | undefined;

async function main(): Promise<void> {
  const bundled = typeof __COSYEE_VERSION__ === 'string';
  const srv = await startServer({ version: bundled ? __COSYEE_VERSION__ : undefined });
  const bindHost = process.env.COSYEE_HOST ?? '127.0.0.1';
  // 源码运行时开发前端跑在 Vite（COSYEE_WEB_PORT）；生产 / 独立包由本服务托管
  if (!bundled) console.log(`Cosyee（开发，Vite）: http://127.0.0.1:${devPort()}/`);
  console.log(`Cosyee: http://127.0.0.1:${srv.port}/`);
  if (bindHost === TAILSCALE_MODE) {
    const ips = tailscaleAddrs().filter((a) => !a.includes(':'));
    if (ips.length === 0) console.warn('提示：还没检测到 Tailscale 网卡（Tailscale 没启动或没登录）。启动后无需重启本服务，直接用 Tailscale 地址访问即可。');
    for (const ip of ips) console.log(`Cosyee（Tailscale）: http://${ip}:${srv.port}/`);
    console.log(`Cosyee（MagicDNS）: http://${os.hostname().toLowerCase()}:${srv.port}/`);
    console.log('只接受本机和 tailnet 内设备的连接，不需要令牌。');
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
