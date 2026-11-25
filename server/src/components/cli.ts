// 组件命令行入口：服务端没运行时，桌面客户端用 `node server.mjs components <命令>` 检查、安装、更新组件。
// 只管程序本身，不启动 kiro.rs 服务，也不碰服务端（服务端组件由客户端自己更新）。
//   components list           → {"result": {list: [...]}}
//   components check <id>     → {"result": ComponentStatus}
//   components update <id>    → 若干行 {"log": "..."}，最后 {"result": ComponentStatus}
// 每行一个 JSON，写到 stdout；出错时最后一行是 {"error": "..."}，退出码 1。其它输出一律写 stderr。
import path from 'node:path';
import { BrowserInstall } from '../browser/install.js';
import { AgyCli } from '../delegate/agyCli.js';
import { KiroEngine } from '../kiro/engine.js';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { createAgyAdapter } from './agy.js';
import { createBrowserAdapter } from './browser.js';
import { createClaudeAdapter } from './claude.js';
import { type ComponentAdapter, errText } from './common.js';
import { createKiroEngineAdapter } from './kiro.js';
import { ComponentUpdater } from './updater.js';

const LOG_POLL_MS = 300;

/** 不依赖服务端进程的组件（server 组件除外） */
export function standaloneAdapters(home: () => string = cosyeeHome): ComponentAdapter[] {
  return [
    createClaudeAdapter({ running: () => 0 }),
    createKiroEngineAdapter(new KiroEngine({ rootDir: () => path.join(home(), 'kiro-rs') })),
    createAgyAdapter(new AgyCli({})),
    createBrowserAdapter(new BrowserInstall({ rootDir: () => path.join(home(), 'agent-browser') }), {
      busy: () => 0,
      close: async () => {},
    }),
  ];
}

export interface ComponentsCliOptions {
  updater?: ComponentUpdater;
  write?: (line: string) => void;
  pollMs?: number;
}

/** 返回退出码 */
export async function runComponentsCli(args: string[], opts: ComponentsCliOptions = {}): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const out = (obj: unknown) => write(JSON.stringify(obj));
  const updater = opts.updater ?? new ComponentUpdater({ adapters: standaloneAdapters() });
  const [cmd, id] = args;
  try {
    if (cmd === 'list') {
      out({ result: await updater.list() });
      return 0;
    }
    if ((cmd === 'check' || cmd === 'update') && id) {
      if (cmd === 'check') {
        out({ result: await updater.check(id) });
        return 0;
      }
      await updater.update(id);
      let from = 0;
      const flush = () => {
        const r = updater.log(id, from);
        for (const line of r.lines) out({ log: line });
        from = r.next;
      };
      const timer = setInterval(flush, opts.pollMs ?? LOG_POLL_MS);
      try {
        await updater.waitForJobs();
      } finally {
        clearInterval(timer);
        flush();
      }
      const st = await updater.status(id);
      if (st.job?.state === 'failed') {
        out({ error: st.job.error ?? '更新失败' });
        return 1;
      }
      out({ result: st });
      return 0;
    }
    out({ error: '用法：components list | check <id> | update <id>' });
    return 1;
  } catch (e) {
    out({ error: e instanceof HttpError ? e.message : errText(e) });
    return 1;
  }
}
