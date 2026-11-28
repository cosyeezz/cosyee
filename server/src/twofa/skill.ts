// 给 Claude 的内置 2FA skill：在 Cosyee 的同一个本地插件目录（claude --plugin-dir）里生成：
//   bin/cosyee-2fa         POSIX sh 包装脚本，用当前 Node（Electron 下加 ELECTRON_RUN_AS_NODE=1）执行 cosyee-2fa.mjs
//   bin/cosyee-2fa.mjs     零依赖 CLI，通过 COSYEE_API_URL + COSYEE_AGENT_TOKEN 访问 /api/2fa/agent/*
//   skills/2fa/SKILL.md    中文使用指南（首次配置、取码、配合内置浏览器自动填码、同步/恢复、安全规则）
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_NAME, shq } from '../browser/skill.js';

export const TWOFA_SKILL_NAME = '2fa';
export const TWOFA_FULL_SKILL = `${PLUGIN_NAME}:${TWOFA_SKILL_NAME}`;

export interface TwoFaPluginOptions {
  /** 插件目录，与内置浏览器共用（<数据目录>/claude-plugin） */
  pluginDir: string;
  platform?: NodeJS.Platform;
  /** Node / Electron 可执行文件路径，默认 process.execPath */
  nodePath?: string;
  /** 当前是否运行在 Electron 下（需要 ELECTRON_RUN_AS_NODE=1） */
  isElectron?: boolean;
}

/** 写进脚本 / 文档里的路径：Windows 上换成正斜杠（Git Bash 认） */
const posixPath = (p: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? p.replace(/\\/g, '/') : p;

/** 内容不同才写（原子写入 + 权限设置） */
function writeIfChanged(file: string, content: string, mode: number): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== mode) {
        fs.chmodSync(file, mode);
      }
      return;
    }
  } catch {
    /* 不存在：写入 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** POSIX sh 包装脚本：Windows 上 Claude 的 Bash 工具是 Git Bash */
export function twoFaWrapperScript(opts: { nodeBin: string; cliScript: string; isElectron: boolean }): string {
  const electronLine = opts.isElectron ? 'export ELECTRON_RUN_AS_NODE=1\n' : '';
  return `#!/bin/sh
# 由 Cosyee 生成，每次启动会话时刷新，不要手改。
${electronLine}exec ${shq(opts.nodeBin)} ${shq(opts.cliScript)} "$@"
`;
}

/** 零依赖 CLI（cosyee-2fa.mjs）：读 COSYEE_API_URL / COSYEE_AGENT_TOKEN，调用 /api/2fa/agent/* */
export function twoFaCliSource(): string {
  return `#!/usr/bin/env node
// Cosyee 2FA CLI（由 Cosyee 自动生成，零依赖）
const apiUrl = (process.env.COSYEE_API_URL || '').replace(/\\/+$/, '');
const token = process.env.COSYEE_AGENT_TOKEN || '';

const args = process.argv.slice(2);
let jsonOut = false;
const rest = [];
for (const a of args) {
  if (a === '--json') jsonOut = true;
  else rest.push(a);
}

function usage(exitCode = 0) {
  const msg = [
    '用法: cosyee-2fa <命令> [参数] [--json]',
    '  code <关键词>       按网站名/账号/标签/分组路径模糊查询并获取当前验证码',
    '  code --id <id>      按条目 id 获取当前验证码',
    '  list                列出所有 2FA 条目（名称、路径、标签；不含密钥）',
    '  status              查看 GitHub 同步配置与状态',
    '  sync                立即与 GitHub 同步',
    '  setup               首次配置或换机恢复 GitHub 私有仓库同步',
  ].join('\\n');
  process.stderr.write(msg + '\\n');
  process.exit(exitCode);
}

const cmd = rest[0];
if (!cmd || cmd === '-h' || cmd === '--help') usage(cmd ? 0 : 2);

if (!apiUrl || !token) {
  process.stderr.write('缺少 COSYEE_API_URL 或 COSYEE_AGENT_TOKEN，请在 Cosyee 会话中使用。\\n');
  process.exit(2);
}

async function callApi(method, pathname) {
  let res;
  try {
    res = await fetch(apiUrl + pathname, {
      method,
      headers: {
        'x-cosyee-agent-token': token,
        'accept': 'application/json',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(\`无法连接 Cosyee 服务（\${apiUrl}）：\${msg}\\n\`);
    process.exit(1);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || \`HTTP \${res.status}\` };
  }
  if (!res.ok) {
    const err = data && typeof data.error === 'string' ? data.error : \`请求失败（HTTP \${res.status}）\`;
    if (jsonOut) console.log(JSON.stringify({ ok: false, status: res.status, error: err }, null, 2));
    else process.stderr.write(\`错误：\${err}\\n\`);
    process.exit(1);
  }
  return data;
}

async function main() {
  if (cmd === 'code') {
    let id = '';
    const qParts = [];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--id' && rest[i + 1]) {
        id = rest[++i];
      } else if (rest[i].startsWith('--id=')) {
        id = rest[i].slice(5);
      } else {
        qParts.push(rest[i]);
      }
    }
    const q = qParts.join(' ').trim();
    if (!id && !q) {
      process.stderr.write('请提供查询关键词或 --id <id>\\n');
      process.exit(2);
    }
    const qs = id ? \`id=\${encodeURIComponent(id)}\` : \`q=\${encodeURIComponent(q)}\`;
    const data = await callApi('GET', \`/api/2fa/agent/code?\${qs}\`);
    if (jsonOut) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (Array.isArray(data.matches)) {
      console.log(\`找到 \${data.matches.length} 条匹配记录，请用更精确的关键词或 --id 指定：\`);
      for (const m of data.matches) {
        const label = [m.issuer, m.account].filter(Boolean).join(' / ');
        const loc = m.path ? \` [\${m.path}]\` : '';
        console.log(\`- \${label}\${loc}  (id: \${m.id})\`);
      }
      return;
    }
    const title = [data.issuer, data.account].filter(Boolean).join(' / ');
    const loc = data.path ? \` [\${data.path}]\` : '';
    console.log(\`\${title}\${loc}\`);
    console.log(\`验证码：\${data.code}（剩余 \${data.remaining} 秒 / 周期 \${data.period} 秒）\`);
    return;
  }

  if (cmd === 'list') {
    const data = await callApi('GET', '/api/2fa/agent/list');
    if (jsonOut) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) {
      console.log('暂无 2FA 记录。');
      return;
    }
    for (const e of entries) {
      const label = [e.issuer, e.account].filter(Boolean).join(' / ');
      const loc = e.path ? \` [\${e.path}]\` : '';
      const tags = Array.isArray(e.tags) && e.tags.length ? \` #\${e.tags.join(' #')}\` : '';
      console.log(\`- \${label}\${loc}\${tags}  (id: \${e.id})\`);
    }
    return;
  }

  if (cmd === 'status') {
    const data = await callApi('GET', '/api/2fa/agent/status');
    if (jsonOut) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const s = data.sync || {};
    if (!s.configured) {
      console.log('状态：尚未配置 GitHub 同步（可运行 cosyee-2fa setup 进行配置）。');
      if (s.lastError) console.log(\`最近错误：\${s.lastError}\`);
      return;
    }
    console.log(\`状态：\${s.syncing ? '正在同步' : '已配置'}\`);
    if (s.ghLogin) console.log(\`GitHub 账号：\${s.ghLogin}\`);
    if (s.repo) console.log(\`保管库仓库：\${s.repo}\`);
    if (s.keyRepo) console.log(\`密钥仓库：\${s.keyRepo}\`);
    if (s.lastSyncAt) console.log(\`上次同步：\${s.lastSyncAt}\`);
    if (s.lastError) console.log(\`最近错误：\${s.lastError}\`);
    return;
  }

  if (cmd === 'sync') {
    const data = await callApi('POST', '/api/2fa/agent/sync');
    if (jsonOut) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const s = data.sync || {};
    console.log(\`同步完成（\${s.lastSyncAt || '刚刚'}）。\`);
    return;
  }

  if (cmd === 'setup') {
    const data = await callApi('POST', '/api/2fa/agent/setup');
    if (jsonOut) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    for (const step of data.steps || []) console.log(\`- \${step}\`);
    const s = data.sync || {};
    console.log(\`配置完成：\${s.repo || ''}（密钥库：\${s.keyRepo || ''}）\`);
    return;
  }

  process.stderr.write(\`未知命令：\${cmd}\\n\`);
  usage(2);
}

main().catch((e) => {
  process.stderr.write(\`错误：\${e instanceof Error ? e.message : String(e)}\\n\`);
  process.exit(1);
});
`;
}

/** SKILL.md：内置 2FA 技能说明（中文） */
export function twoFaSkillMarkdown(wrapper: string): string {
  const W = shq(wrapper);
  return `---
name: ${TWOFA_SKILL_NAME}
description: Cosyee 内置 2FA（两步验证 / 动态验证码 / TOTP / OTP）助手。用于首次配置 GitHub 私有仓库加密同步、换机恢复、查询 2FA 条目、获取当前 6/8 位动态验证码，以及配合 Cosyee 内置浏览器在登录页面自动填写两步验证码。
---

# Cosyee 内置 2FA 验证器

Cosyee 内置了本地 SQLite + GitHub 私有仓库自动加密同步的 2FA（TOTP）验证器。所有操作通过下面的命令执行（绝对路径，原样使用）：

\`\`\`bash
${W} <命令> [参数] [--json]
\`\`\`

## 一、首次配置流程

当用户第一次使用、或请求配置 2FA 同步时，按顺序执行：

1. **检查 GitHub CLI（\`gh\`）是否安装**：运行 \`gh --version\`。
   - 如果未安装，提示用户先安装：Windows 可运行 \`winget install GitHub.cli\`，或前往 https://cli.github.com 下载安装，装好后重新打开终端。
2. **检查登录状态**：运行 \`gh auth status\`。
   - 如果未登录，请用户在自己的终端里运行 \`gh auth login\` 完成登录（不要替用户跑交互式登录）。
   - 如果用户还没有 GitHub 账号，引导前往 https://github.com/signup 注册，并提醒：**务必开启 GitHub 自己的两步验证，并把 GitHub 恢复码（Recovery Codes）离线保存在安全的地方，不要只存进这个 2FA 保管库里**（否则进不去 GitHub 就拿不到同步数据）。
3. **初始化私有仓库与密钥**：确认 \`gh\` 已登录后，运行：
   \`\`\`bash
   ${W} setup
   \`\`\`
   它会自动检查/创建两个**私有**仓库（\`cosyee-2fa-vault\` 存放 AES-256-GCM 密文与应急解密脚本 \`decrypt.mjs\`，\`cosyee-2fa-key\` 存放随机生成的 256 位密钥 \`key.txt\`），并完成首次同步。
4. **引导用户导入或添加条目**：
   - 告诉用户点击 Cosyee 窗口右上角「内置浏览器」旁边的 **2FA 盾牌钥匙图标**打开面板；
   - **从 Chrome 插件导入**：在 Chrome 的 Authenticator 扩展里点右上角齿轮 →「备份」→「导出」（注意**不要勾选加密密码**），再在 Cosyee 2FA 面板的设置里导入该文件；
   - **手动添加**：点右上角「＋」输入网站名、账号和密钥；
   - 之后的任何修改都会自动防抖加密同步到 GitHub，无需手动维护密码。

## 二、取码与列表

\`\`\`bash
${W} code github              # 按网站名 / 账号 / 备注 / 标签 / 分组路径模糊匹配
${W} code --id <条目id>       # 多条匹配时按 id 精确取码
${W} list                     # 列出全部条目名称、路径与标签（不含密钥）
\`\`\`

如果匹配到多条记录，命令不会直接返回验证码，而是列出候选项与 \`id\`；向用户确认是哪一个后再用 \`--id\` 取码。

## 三、配合内置浏览器自动填码

在 Cosyee 内置浏览器里登录遇到 2FA 输入框时：

1. 先用 \`${W} code <关键词> --json\` 获取 \`code\` 和 \`remaining\`（剩余有效秒数）。
2. **如果 \`remaining < 5\`**，先等待 \`remaining + 1\` 秒再重新取下一个周期的验证码，避免刚填完就过期。
3. 按内置浏览器技能 \`cosyee:browser\` 的用法：先 \`snapshot -i\` 找到验证码输入框的引用，再用它的 \`fill <ref> <code>\` 填入并提交（有的网站是 6 个单独的格子，逐格填或对第一格 \`type\`）。
4. 提交后再 \`snapshot\` 确认是否登录成功；提示验证码错误时重新取码再试一次，不要反复重试。

## 四、状态、同步与换机恢复

\`\`\`bash
${W} status                   # 查看同步配置、上次同步时间与错误信息
${W} sync                     # 立即执行一次双向合并同步
\`\`\`

**换机恢复**：在新电脑上安装并登录 \`gh auth login\` 后，直接运行 \`${W} setup\`。它会自动检测到已有的 \`cosyee-2fa-key\` 和 \`cosyee-2fa-vault\` 私有仓库，下载密钥并拉取全部 2FA 数据。

## 五、安全规则

- **绝不输出**任何 TOTP 明文 \`secret\`、\`otpauth://\` 链接或加密密钥内容（命令行工具本身也不会返回这些敏感字段）。
- **绝不向用户索要**网站登录密码或 GitHub 密码。
- **可以向用户展示**当前动态验证码（6 位或 8 位数字）以及剩余有效秒数。
`;
}

/** 生成（或刷新）2FA 插件文件到共享插件目录 */
export function ensureTwoFaPlugin(o: TwoFaPluginOptions): string {
  const platform = o.platform ?? process.platform;
  const nodeBin = posixPath(o.nodePath ?? process.execPath, platform);
  const isElectron = o.isElectron ?? Boolean(process.versions.electron);

  const cliScript = path.join(o.pluginDir, 'bin', 'cosyee-2fa.mjs');
  const wrapper = path.join(o.pluginDir, 'bin', 'cosyee-2fa');

  writeIfChanged(cliScript, twoFaCliSource(), 0o644);
  writeIfChanged(
    wrapper,
    twoFaWrapperScript({ nodeBin, cliScript: posixPath(cliScript, platform), isElectron }),
    0o755,
  );

  // 如果 plugin.json 还没由浏览器插件写入（如独立调用），补写一份
  const manifestPath = path.join(o.pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    writeIfChanged(
      manifestPath,
      JSON.stringify({ name: PLUGIN_NAME, description: 'Cosyee 内置工具', version: '1.0.0' }, null, 2) + '\n',
      0o644,
    );
  }

  writeIfChanged(
    path.join(o.pluginDir, 'skills', TWOFA_SKILL_NAME, 'SKILL.md'),
    twoFaSkillMarkdown(posixPath(wrapper, platform)),
    0o644,
  );
  return o.pluginDir;
}
