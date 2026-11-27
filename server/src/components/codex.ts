// OpenAI Codex CLI 组件：包装 CodexCli 的状态 / 检查 / 升级。
import type { CodexCli } from '../delegate/codexCli.js';
import { type AdapterInfo, type ComponentAdapter } from './common.js';

export function createCodexAdapter(
  cli: Pick<CodexCli, 'status' | 'check' | 'update' | 'waitForJob' | 'log'> & Partial<Pick<CodexCli, 'restoreCheck'>>,
): ComponentAdapter {
  return {
    id: 'codex',
    name: 'Codex CLI',
    updatedBy: 'server',
    installable: true,

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
        job: s.job ? { kind: s.job.kind, state: s.job.state, error: s.job.error } : null,
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

    restore: (latest, at) => cli.restoreCheck?.(latest, at),

    log: (from) => cli.log(from),
  };
}
