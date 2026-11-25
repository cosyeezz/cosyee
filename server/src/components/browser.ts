// 内置浏览器组件（agent-browser）：没装时可在「本机组件」里一键安装，之后跟其它组件一样检查 / 自动更新。
import type { BrowserInstall } from '../browser/install.js';
import type { BrowserManager } from '../browser/manager.js';
import { type AdapterInfo, type ComponentAdapter } from './common.js';

export function createBrowserAdapter(install: BrowserInstall, manager: Pick<BrowserManager, 'busy' | 'close'>): ComponentAdapter {
  return {
    id: 'browser',
    name: '内置浏览器（agent-browser）',
    updatedBy: 'server',
    installable: true,

    async info(): Promise<AdapterInfo> {
      const s = install.status();
      return {
        installed: s.installed,
        custom: s.custom,
        version: s.version,
        latest: s.latest,
        updateAvailable: s.updateAvailable,
        checkedAt: s.checkedAt,
        checkError: null,
        busy: manager.busy(),
        job: s.job ? { kind: s.installed ? 'update' : 'install', ...s.job } : null,
      };
    },

    check: () => install.check(),

    // 替换程序前先关掉正在跑的浏览器（新版本下次打开时启动）
    update: () => install.install(() => manager.close()),

    log: (from) => install.logs.read(from),
  };
}
