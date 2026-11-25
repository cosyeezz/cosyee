// kiro.rs 组件：包装 KiroEngine 的状态 / 检查 / 下载。版本号 = release tag。
import type { KiroService } from '../kiro/index.js';
import type { KiroEngine } from '../kiro/engine.js';
import { type AdapterInfo, type ComponentAdapter } from './common.js';

/** 服务端里用：带服务启停，busy 是正在执行的 Kiro 会话数 */
export function createKiroAdapter(
  kiro: Pick<KiroService, 'engine' | 'serviceStatus' | 'componentService' | 'startService' | 'stopService' | 'restartService'>,
): ComponentAdapter {
  return {
    ...createKiroEngineAdapter(kiro.engine, () => kiro.serviceStatus().busySessions),
    service: {
      status: () => kiro.componentService(),
      start: () => kiro.startService(),
      stop: (force) => kiro.stopService(force),
      restart: (force) => kiro.restartService(force),
    },
  };
}

/** 只管程序本身（检查、下载、更新），不管服务进程；服务端没运行时的命令行入口用 */
export function createKiroEngineAdapter(
  engine: Pick<KiroEngine, 'status' | 'check' | 'startBuild' | 'waitForBuild' | 'getLog'>,
  busy: () => number = () => 0,
): ComponentAdapter {
  return {
    id: 'kiro',
    name: 'kiro.rs',
    updatedBy: 'server',
    // 没装时「更新」就是下载
    installable: true,

    async info(): Promise<AdapterInfo> {
      const s = engine.status();
      const build = s.build;
      return {
        installed: s.source !== 'none',
        custom: s.source === 'env',
        version: s.current?.commit ?? null,
        latest: s.latest?.commit ?? null,
        updateAvailable: s.updateAvailable,
        checkedAt: s.checkedAt,
        checkError: null,
        busy: busy(),
        job:
          build.state === 'idle'
            ? null
            : { kind: s.source === 'none' ? 'install' : 'update', state: build.state, error: build.state === 'failed' ? build.error : null },
      };
    },

    async check(): Promise<void> {
      await engine.check();
    },

    async update(): Promise<void> {
      engine.startBuild();
      await engine.waitForBuild();
      const b = engine.status().build;
      if (b.state === 'failed') throw new Error(b.error ?? '下载失败');
    },

    log: (from) => engine.getLog(from),
  };
}
