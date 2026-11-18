// 桌面版后端入口：由 Electron 主进程用 utilityProcess.fork 启动（打包成单文件后运行）。
//
// 与主进程的消息约定（process.parentPort）：
//   主进程 → 本进程  { type: 'init', token, webDist, host, port, stateFile? }   必须先发，令牌不走环境变量（否则会被 claude 子进程继承）
//                    { type: 'shutdown' }                         优雅退出
//   本进程 → 主进程  { type: 'ready', port } | { type: 'error', message, code? } | { type: 'stopped' }
import { startServer } from './server.js';

/** 构建时由 esbuild 注入（见 desktop/scripts/build-server.mjs）；直接用 tsx 跑时没有 */
declare const __COSYEE_VERSION__: string | undefined;

interface ParentPort {
  on(event: 'message', fn: (e: { data: unknown }) => void): void;
  postMessage(msg: unknown): void;
}

interface InitMsg {
  type: 'init';
  token: string;
  webDist: string;
  /** 监听地址（IPv4）与端口；port 0 表示随机 */
  host: string;
  port: number;
  stateFile?: string;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('desktop-entry 必须在 Electron utilityProcess 里运行');
  process.exit(1);
}
const send = (m: unknown) => parentPort.postMessage(m);

let started = false;

async function onInit(m: InitMsg): Promise<void> {
  if (started) return;
  started = true;
  try {
    const srv = await startServer({
      host: m.host,
      port: m.port, // 0 = 随机；实际端口通过 ready 消息告诉主进程
      webDist: m.webDist,
      stateFile: m.stateFile,
      authToken: m.token,
      version: typeof __COSYEE_VERSION__ === 'string' ? __COSYEE_VERSION__ : undefined,
    });
    // 兜底：进程无论如何退出，都同步杀掉还活着的 claude 子进程树
    process.on('exit', () => srv.manager.killAllSync());

    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      srv.stop().then(
        () => {
          send({ type: 'stopped' });
          process.exit(0);
        },
        () => process.exit(1),
      );
    };
    parentPort!.on('message', (e) => {
      if ((e.data as { type?: string } | null)?.type === 'shutdown') shutdown();
    });
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    send({ type: 'ready', port: srv.port });
  } catch (e) {
    send({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
      code: (e as NodeJS.ErrnoException | undefined)?.code, // EADDRINUSE 等，主进程据此弹「端口被占用」
    });
    process.exit(1);
  }
}

parentPort.on('message', (e) => {
  const d = e.data as { type?: string } | null;
  if (d?.type === 'init') void onInit(d as InitMsg);
});
