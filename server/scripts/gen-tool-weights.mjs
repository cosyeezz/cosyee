#!/usr/bin/env node
// 生成内置工具定义长度权重表（server/src/toolWeights.ts）。
// 原理：起一个本机临时 HTTP 服务，用临时 CLAUDE_CONFIG_DIR + 假 API Key 跑多组本机 claude CLI 配置
// （常规全量、PowerShell/LSP/Tasks 开启、stream-json + --permission-prompt-tool stdio、ENABLE_TOOL_SEARCH=true、
//  旧版 TodoWrite 模式），截获请求体里的 tools 数组计算 JSON.stringify({name,description,input_schema}).length，
// 立刻返回 400 结束并合并结果。绝不使用用户真实凭据/配置，绝不访问外网，绝不打印请求头。
// 对于 API Key 模式不出现的订阅/实验专属内置工具，可从本机 ~/.claude/projects 的会话记录里读取
// deferred_tools_record / surfacedDefinitions 补齐（只取非 mcp__ 工具的整数长度，不保留正文）。
//
// 用法：node server/scripts/gen-tool-weights.mjs [--claude <path>] [--no-transcripts]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(HERE, '../src/toolWeights.ts');

const args = process.argv.slice(2);
const noTranscripts = args.includes('--no-transcripts');
const claudeFlagIdx = args.indexOf('--claude');
const claudeArg = claudeFlagIdx >= 0 ? args[claudeFlagIdx + 1] : undefined;

function findClaude() {
  if (claudeArg) return claudeArg;
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  const localBin = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(localBin)) return localBin;
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function defWeight(def) {
  if (!def || typeof def !== 'object' || typeof def.name !== 'string') return null;
  return JSON.stringify({
    name: def.name,
    description: def.description ?? '',
    input_schema: def.input_schema ?? {},
  }).length;
}

const claudePath = findClaude();
let cliVersion = 'unknown';
try {
  cliVersion = execFileSync(claudePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
} catch (e) {
  console.error('Failed to get claude version:', e.message);
}

console.log(`Using claude: ${claudePath} (${cliVersion})`);

/** 运行一次隔离的本机截获，返回本轮抓到的工具权重 Map */
async function runCapture({ label, cliArgs, extraEnv, stdinLine }) {
  const captured = new Map();
  let deferredInPayload = 0;
  let capturedOnce = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw);
        if (Array.isArray(body?.tools) && body.tools.length > 0) {
          for (const t of body.tools) {
            if (typeof t?.name !== 'string' || t.name.startsWith('mcp__') || t.name === 'DeferredToolPlaceholder') continue;
            if (t.defer_loading) deferredInPayload++;
            const w = defWeight(t);
            if (w && w > 0) captured.set(t.name, w);
          }
          capturedOnce = true;
        }
      } catch {
        // 非 JSON 请求体忽略
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'cosyee-weight-capture' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-weights-'));
  const cfgDir = path.join(tmpBase, 'cfg');
  const workDir = path.join(tmpBase, 'work');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfgDir,
    ANTHROPIC_API_KEY: 'sk-ant-api03-dummy-00000000000000000000000000000000',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extraEnv,
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    await new Promise((resolve) => {
      const child = spawn(claudePath, cliArgs, {
        cwd: workDir,
        env,
        stdio: [stdinLine ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      });
      if (stdinLine && child.stdin) {
        child.stdin.write(stdinLine + '\n');
        child.stdin.end();
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 30_000);
      const poll = setInterval(() => {
        if (capturedOnce) {
          clearInterval(poll);
          setTimeout(() => {
            try { child.kill(); } catch {}
          }, 400);
        }
      }, 100);
      child.on('exit', () => {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      });
      child.on('error', (err) => {
        console.error(`[${label}] Spawn error:`, err.message);
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      });
    });
  } finally {
    server.close();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(`  [${label}] captured ${captured.size} tools${deferredInPayload ? ` (${deferredInPayload} with defer_loading)` : ''}`);
  return captured;
}

const STREAM_USER_MSG = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

const captures = [
  {
    label: 'flat-all',
    cliArgs: ['-p', 'hi', '--no-session-persistence'],
    extraEnv: {
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      ENABLE_LSP_TOOL: '1',
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
  },
  {
    label: 'stream-stdio',
    cliArgs: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--no-session-persistence'],
    extraEnv: {
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      ENABLE_LSP_TOOL: '1',
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
    stdinLine: STREAM_USER_MSG,
  },
  {
    label: 'tool-search-on',
    cliArgs: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--no-session-persistence'],
    extraEnv: {
      ENABLE_TOOL_SEARCH: 'true',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      ENABLE_LSP_TOOL: '1',
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
    stdinLine: STREAM_USER_MSG,
  },
  {
    label: 'legacy-todo',
    cliArgs: ['-p', 'hi', '--no-session-persistence'],
    extraEnv: {
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_ENABLE_TASKS: '0',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
  },
];

const capturedFromCli = new Map();
for (const c of captures) {
  const m = await runCapture(c);
  for (const [k, v] of m) {
    if (!capturedFromCli.has(k)) capturedFromCli.set(k, v);
  }
}
console.log(`Merged ${capturedFromCli.size} unique tools from CLI captures.`);

// 从本机历史会话记录补齐订阅/实验专属内置工具的定义长度（只取非 mcp__ 工具的整数长度）
const fromTranscripts = new Map();
if (!noTranscripts) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (fs.existsSync(projectsRoot)) {
    const dirs = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const pdir = path.join(projectsRoot, d.name);
      let files = [];
      try {
        files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const fp = path.join(pdir, f);
        let text;
        try {
          text = fs.readFileSync(fp, 'utf8');
        } catch {
          continue;
        }
        if (!text.includes('deferred_tools_')) continue;
        for (const line of text.split('\n')) {
          if (!line.includes('deferred_tools_')) continue;
          try {
            const j = JSON.parse(line);
            const att = j.attachment;
            if (att?.type === 'deferred_tools_record' && Array.isArray(att.entries)) {
              for (const e of att.entries) {
                if (typeof e?.name !== 'string' || e.name.startsWith('mcp__')) continue;
                const w = defWeight(e);
                if (w && w > 0) fromTranscripts.set(e.name, w);
              }
            } else if (att?.type === 'deferred_tools_delta' && Array.isArray(att.surfacedDefinitions)) {
              for (const s of att.surfacedDefinitions) {
                const def = s?.definition;
                const name = def?.name ?? s?.name;
                if (typeof name !== 'string' || name.startsWith('mcp__')) continue;
                const w = defWeight({ name, description: def?.description, input_schema: def?.input_schema });
                if (w && w > 0) fromTranscripts.set(name, w);
              }
            }
          } catch {
            // 忽略坏行
          }
        }
      }
    }
  }
}

const merged = new Map(capturedFromCli);
let addedFromTranscripts = 0;
for (const [k, v] of fromTranscripts) {
  if (!merged.has(k)) {
    merged.set(k, v);
    addedFromTranscripts++;
  }
}
console.log(`Added ${addedFromTranscripts} subscriber/experiment tools from transcripts (total ${merged.size}).`);

if (merged.size === 0) {
  console.error('No tool weights captured; aborting without overwriting output.');
  process.exit(1);
}

const sorted = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b));
const vals = sorted.map(([, v]) => v).sort((a, b) => a - b);
const mid = Math.floor(vals.length / 2);
const median = vals.length % 2 === 1 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);

const lines = [
  `// 由 server/scripts/gen-tool-weights.mjs 自动生成，请勿手改。`,
  `// CLI 版本：${cliVersion}`,
  `// 权重 = JSON.stringify({ name, description, input_schema }).length（与 CLI 内部按定义长度分摊一致）。`,
  `// 重新生成：node server/scripts/gen-tool-weights.mjs`,
  ``,
  `export const TOOL_WEIGHTS_CLI_VERSION = ${JSON.stringify(cliVersion)};`,
  ``,
  `export const STATIC_TOOL_WEIGHTS: Readonly<Record<string, number>> = {`,
  ...sorted.map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`),
  `};`,
  ``,
  `/** 静态表权重的中位数：未知工具缺省权重 */`,
  `export const MEDIAN_TOOL_WEIGHT = ${median};`,
  ``,
];

fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
console.log(`Wrote ${OUT_FILE} (${sorted.length} tools, median=${median})`);
