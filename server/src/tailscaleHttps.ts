// Tailscale 模式下自动开一个 HTTPS 入口：tailscale serve 把 https://<机器名>.<tailnet>.ts.net 反代到本服务。
// 浏览器只在安全上下文（HTTPS / 本机）里允许用麦克风，手机、其它电脑经 http://100.x.x.x:7878 访问时
// 语音输入和通话用不了；有了这个地址，网页会自动跳过去（见 web 的 MainApp）。
//
// 只在 serve 还没有任何配置时才写入（--bg 持久化，重启后仍在），已有配置的一律不碰：
// 可能是用户自己配的别的服务。tailnet 没开 HTTPS 证书、CLI 找不到、没权限（Linux 需要 operator）时放弃，
// 只打一行提示。tailscale serve 只在 tailnet 内可见，不是 Funnel，不会暴露到公网。
// 关闭：COSYEE_TS_HTTPS=0；撤销已写入的配置：tailscale serve --https=443 off
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function cli(): string {
  const cands =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
        : [];
  return cands.find((p) => fs.existsSync(p)) ?? 'tailscale';
}

function run(args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli(), args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().split('\n')[0] || err.message));
      else resolve(out);
    });
  });
}

interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/** serve 配置里 https://<dns>/ 是否反代到本服务的端口 */
export function servesPort(cfg: ServeConfig, dns: string, port: number): boolean {
  const proxy = cfg.Web?.[`${dns}:443`]?.Handlers?.['/']?.Proxy ?? '';
  return new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost)?:?${port}/?$`).test(proxy);
}

export interface TailscaleSelf {
  /** MagicDNS 全名（去掉末尾的点），例如 my-server.tail1234.ts.net */
  dns: string;
  certDomains: string[];
}

/** 读本机在 tailnet 里的名字；CLI 找不到、没登录时返回 null */
export async function tailscaleSelf(): Promise<TailscaleSelf | null> {
  try {
    const st = JSON.parse(await run(['status', '--json'])) as { Self?: { DNSName?: string }; CertDomains?: string[] | null };
    return { dns: (st.Self?.DNSName ?? '').replace(/\.$/, ''), certDomains: st.CertDomains ?? [] };
  } catch {
    return null;
  }
}

/** MagicDNS 全名的第一段（机器名）：my-server.tail1234.ts.net. -> my-server */
export function magicDnsShortName(dns: string): string {
  return dns.trim().toLowerCase().replace(/\.$/, '').split('.')[0] ?? '';
}

/** 确保 HTTPS 入口可用，返回 https://<机器名>.<tailnet>.ts.net；做不到时返回 null */
export async function ensureTailscaleHttps(port: number, self?: TailscaleSelf | null): Promise<string | null> {
  if (process.env.COSYEE_TS_HTTPS === '0') return null;
  try {
    const st = self ?? (await tailscaleSelf());
    if (!st) throw new Error('读不到 tailscale status');
    const dns = st.dns;
    if (!dns || !st.certDomains.includes(dns)) {
      if (dns) console.log('提示：tailnet 没有开启 HTTPS 证书，远程语音输入不可用（Tailscale 管理后台 → DNS → 启用 HTTPS）。');
      return null;
    }
    const url = `https://${dns}`;
    const cfg = JSON.parse((await run(['serve', 'status', '--json'])).trim() || '{}') as ServeConfig;
    if (servesPort(cfg, dns, port)) return url;
    if (cfg.TCP && Object.keys(cfg.TCP).length > 0) {
      console.log('提示：tailscale serve 已有别的配置，没有自动添加 HTTPS 入口（远程语音输入需要 HTTPS）。');
      return null;
    }
    await run(['serve', '--bg', `http://127.0.0.1:${port}`], 60_000);
    return url;
  } catch (e) {
    console.log(`提示：没能自动开启 Tailscale HTTPS 入口（${e instanceof Error ? e.message : String(e)}），远程语音输入不可用。`);
    return null;
  }
}
