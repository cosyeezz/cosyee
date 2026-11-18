// 入口：启动服务、打印访问地址、处理退出信号。接口约定见 shared/src/protocol.ts。
import { devPort } from './security.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const srv = await startServer();
  // 开发时前端跑在 Vite（COSYEE_WEB_PORT），生产时由本服务托管
  console.log(`Cosyee: http://127.0.0.1:${devPort()}/`);
  const bindHost = process.env.COSYEE_HOST ?? '127.0.0.1';
  console.log(`Cosyee: http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${srv.port}/`);
  if (bindHost !== '127.0.0.1') {
    console.warn(`警告：监听 ${bindHost}，且网页版没有访问令牌——同一网络里的任何人都能在本机执行任意命令。请改用桌面版（带令牌），或确保网络可信。`);
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
