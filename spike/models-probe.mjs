// 发 initialize 取 models（去掉 account 等个人信息）。用法：node models-probe.mjs <case>
//   sub         当前订阅账号
//   api         临时配置目录 + 假 Key + 第三方 Base URL，无映射
//   api-map     同上 + 别名重映射
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const which = process.argv[2] ?? 'sub';
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/i.test(k)) delete env[k];
if (which !== 'sub') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-models-'));
  env.CLAUDE_CONFIG_DIR = dir;
  env.ANTHROPIC_AUTH_TOKEN = 'sk-fake-0000000000000000';
  env.ANTHROPIC_BASE_URL = 'https://gw.example.invalid';
}
if (which === 'api-map') {
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'minimax-m2.5[1m]';
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = 'MiniMax 自定义';
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek/deepseek-v3.2';
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-coder-next';
}
const t0 = Date.now();
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
  { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
let buf = '';
const timer = setTimeout(() => { console.log('TIMEOUT'); p.kill(); }, 30000);
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'control_response' && m.response?.request_id === 'init') {
      clearTimeout(timer);
      const r = m.response.response ?? {};
      console.log(JSON.stringify({ case: which, ms: Date.now() - t0, subtype: m.response.subtype, error: m.response.error, version: r.claude_code_version,
        models: (r.models ?? []).map((x) => ({ v: x.value, r: x.resolvedModel, n: x.displayName, d: x.description, e: x.supportedEffortLevels?.join('/') ?? (x.supportsEffort ? 'yes' : '-') })) }, null, 1));
      p.stdin.end(); setTimeout(() => p.kill(), 1500);
    }
  }
});
p.stderr.on('data', (d) => process.stderr.write(d));
p.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }) + '\n');
