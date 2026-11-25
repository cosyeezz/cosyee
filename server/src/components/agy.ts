// Antigravity CLI 组件：包装 AgyCli 的状态 / 检查 / 升级。
import type { AgyCli } from '../delegate/agyCli.js';
import { type AdapterInfo, type ComponentAdapter } from './common.js';

export function createAgyAdapter(cli: Pick<AgyCli, 'status' | 'check' | 'update' | 'waitForJob' | 'log'>): ComponentAdapter {
  return {
    id: 'agy',
    name: 'Antigravity CLI',
    updatedBy: 'server',

    async info(): Promise<AdapterInfo> {
      const s = await cli.status();
      return {
        installed: s.installed,
        custom: s.custom,
        version: s.version,
        latest: s.latest,
        updateAvailable: s.updateAvailable,
        checkedAt: s.checkedAt,
        checkError: s.checkError,
        busy: s.busy,
        job: s.job ? { kind: 'update', state: s.job.state, error: s.job.error } : null,
      };
    },

    async check(): Promise<void> {
      const s = await cli.check();
      if (s.checkError) throw new Error(s.checkError);
    },

    async update(): Promise<void> {
      await cli.update();
      await cli.waitForJob();
      const job = (await cli.status()).job;
      if (job?.state === 'failed') throw new Error(job.error ?? '升级失败');
    },

    log: (from) => cli.log(from),
  };
}
