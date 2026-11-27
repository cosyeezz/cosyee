// 真实本机 Codex CLI 冒烟测试：默认跳过，仅在 COSYEE_CODEX_LIVE=1 时运行。
// 绝不修改 ~/.codex；deviceAuth 登录使用临时目录并在解析出链接与验证码后立刻取消。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAccounts } from './accounts/codex.js';
import { CodexPool } from './delegate/codexAppServer.js';
import { CodexCli } from './delegate/codexCli.js';
import { StateStore } from './workspaces.js';

const live = process.env.COSYEE_CODEX_LIVE === '1';

describe.skipIf(!live)('Codex 真实本机冒烟', () => {
  it('CodexCli 读到版本；CodexAccounts.list() 返回默认账号信息与额度；deviceAuth 解析出链接和验证码后取消', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-live-'));
    const pool = new CodexPool();
    const cli = new CodexCli({ pool });
    const store = new StateStore(path.join(tmp, 'state.json'));
    const accounts = new CodexAccounts({
      store,
      accountsRoot: () => path.join(tmp, 'codex-accounts'),
      readAccount: (o) => pool.readAccount(o),
      readRateLimits: (o) => pool.readRateLimitsRaw(o),
    });
    try {
      const cliStatus = await cli.status();
      expect(cliStatus.installed).toBe(true);
      expect(cliStatus.version).toMatch(/^\d+\.\d+\.\d+/);

      accounts.list({ refresh: true });
      await accounts.waitForProbes();
      const list = accounts.list();
      expect(list.installed).toBe(true);
      const def = list.list.find((a) => a.isDefault);
      expect(def).toBeTruthy();
      expect(def?.loggedIn).toBe(true);

      // deviceAuth 临时目录登录，拿到链接与 userCode 后立刻取消
      const login = accounts.startLogin({ method: 'deviceAuth' });
      const deadline = Date.now() + 15_000;
      let cur = accounts.getLogin(login.loginId);
      while (cur.status === 'starting' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        cur = accounts.getLogin(login.loginId);
      }
      accounts.cancelLogin(login.loginId);
      expect(cur.status).toBe('waiting');
      expect(cur.url).toMatch(/^https:\/\//);
      expect(cur.userCode).toMatch(/^[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/);
    } finally {
      accounts.dispose();
      cli.dispose();
      pool.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
