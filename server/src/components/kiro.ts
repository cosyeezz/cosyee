// kiro.rs 组件：包装 KiroEngine 的状态 / 检查 / 下载。版本号 = release tag。
import type { KiroService } from '../kiro/index.js';
import { type AdapterInfo, type ComponentAdapter } from './common.js';

export function createKiroAdapter(kiro: Pick<KiroService, 'engine' | 'serviceStatus'>): ComponentAdapter {
  const engine = kiro.engine;
  return {
    id: 'kiro',
    name: 'kiro.rs',
    updatedBy: 'server',

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
        // 正在执行的 Kiro 会话数
        busy: kiro.serviceStatus().busySessions,
        job:
          build.state === 'idle'
            ? null
            : { kind: 'update', state: build.state, error: build.state === 'failed' ? build.error : null },
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
