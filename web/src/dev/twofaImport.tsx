// 2FA 导入流程调试页（?dev=twofaImport）：纯内存 mock，不依赖后端。
// 参数：
//   state   = scan | image | link | backup | preview | picker | region   （默认 scan）
//   theme   = dark | light
//   native  = 1（原生框选 1.4s 后返回示例二维码）| wait（一直等待）| err（返回错误）| cancel
//   narrow  = 1（窄屏 320px）
//   autofeed= 1（image / scan 状态挂载后自动「粘贴」一张生成的 otpauth 二维码图片，验证真实解码）
//   qr      = 0 | 1 | 2（region 状态里示例画面包含几个二维码，默认 1）
import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  TwoFaGroup,
  TwoFaImportInput,
  TwoFaImportPreviewInput,
  TwoFaImportPreviewItem,
  TwoFaImportPreviewResult,
  TwoFaImportResult,
} from '../core/twofa/types';
import '../ui/layout/AppShell.css';
import '../ui/twofa/TwoFactorPanel.css';
import { TwoFactorImportView, type TwoFaImportMethod } from '../ui/twofa/TwoFactorImport';
import { ScreenRegionPicker } from '../ui/twofa/ScreenRegionPicker';

const NOW = '2026-11-27T08:30:00.000Z';
const GROUPS: TwoFaGroup[] = [
  { id: 'g-work', parentId: null, name: '工作账号', sort: 0, updatedAt: NOW, version: 1 },
  { id: 'g-cloud', parentId: 'g-work', name: '云基础设施与运维平台', sort: 0, updatedAt: NOW, version: 1 },
  { id: 'g-prod', parentId: 'g-cloud', name: '生产集群（ap-southeast）', sort: 0, updatedAt: NOW, version: 1 },
  { id: 'g-empty', parentId: 'g-work', name: '临时归档', sort: 1, updatedAt: NOW, version: 1 },
  { id: 'g-life', parentId: null, name: '个人生活', sort: 1, updatedAt: NOW, version: 1 },
];

const DUP_SECRET = 'JBSWY3DPEHPK3PXP';
const SAMPLE_LINKS = [
  'otpauth://totp/GitHub:dane.chen@cosyee.dev?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
  'otpauth://totp/Google:dane@gmail.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Google',
  'otpauth://totp/Amazon%20Web%20Services:root-account-production-ap-southeast@very-long-company-name.example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Amazon%20Web%20Services&algorithm=SHA256&digits=8&period=60',
  'otpauth://totp/Cloudflare:ops@cosyee.dev?secret=NBSWY3DPEB3W64TMMQ&issuer=Cloudflare&period=45',
  'otpauth://totp/Notion:me@notion.so?secret=KRSXG5CTMVRXEZLU&issuer=Notion',
  'otpauth://hotp/Legacy:old-token?secret=GEZDGNBVGY3TQOJQ&counter=1&issuer=Legacy',
].join('\n');

/** 极简解析：够 dev 页验证流程用，不是真实后端 */
function parseLinks(text: string): { items: Omit<TwoFaImportPreviewItem, 'index'>[]; unsupported: number; errors: string[] } {
  const items: Omit<TwoFaImportPreviewItem, 'index'>[] = [];
  const errors: string[] = [];
  let unsupported = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('otpauth-migration://')) {
      for (const [issuer, account] of [
        ['Slack', 'team@cosyee.dev'],
        ['Dropbox', 'dane@cosyee.dev'],
        ['Discord', 'dane#0042'],
      ]) {
        items.push({ issuer, account, algorithm: 'SHA1', digits: 6, period: 30, duplicate: false });
      }
      continue;
    }
    if (!/^otpauth:\/\//i.test(line)) {
      errors.push(`无法识别：${line.slice(0, 48)}${line.length > 48 ? '…' : ''}`);
      continue;
    }
    try {
      const u = new URL(line);
      if (u.hostname === 'hotp') {
        unsupported++;
        continue;
      }
      const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const [lIssuer, ...rest] = label.includes(':') ? label.split(':') : ['', label];
      const issuer = u.searchParams.get('issuer') ?? lIssuer;
      const secret = u.searchParams.get('secret') ?? '';
      items.push({
        issuer,
        account: rest.join(':').trim() || (lIssuer ? '' : label),
        algorithm: (u.searchParams.get('algorithm')?.toUpperCase() as 'SHA1') ?? 'SHA1',
        digits: u.searchParams.get('digits') === '8' ? 8 : 6,
        period: Number(u.searchParams.get('period') ?? 30) || 30,
        duplicate: secret === DUP_SECRET,
      });
    } catch {
      errors.push('链接格式不正确');
    }
  }
  return { items, unsupported, errors };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockPreview(input: TwoFaImportPreviewInput): Promise<TwoFaImportPreviewResult> {
  await delay(260);
  const r = parseLinks(input.text);
  return { items: r.items.map((it, index) => ({ ...it, index })), unsupported: r.unsupported, errors: r.errors };
}

async function mockImport(input: TwoFaImportInput): Promise<TwoFaImportResult> {
  await delay(500);
  const r = parseLinks(input.text);
  const ex = new Set(input.exclude ?? []);
  const kept = r.items.filter((_, i) => !ex.has(i));
  return { added: kept.length, skipped: r.items.length - kept.length, unsupported: r.unsupported, errors: r.errors };
}

// ───────── 生成二维码 ─────────

function drawQr(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) ctx.fillRect(Math.round(x + (c + quiet) * cell), Math.round(y + (r + quiet) * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
}

function makeQrBlob(text: string, size = 360): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawQr(c.getContext('2d')!, text, 0, 0, size);
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
}

/** 模拟桌面：渐变背景 + 假窗口 + 二维码 */
function makeDesktopFrame(texts: string[]): HTMLCanvasElement {
  const W = 1600;
  const H = 900;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#2b3a55');
  g.addColorStop(1, '#6b4f7a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 假窗口
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.beginPath();
  ctx.roundRect(120, 90, 1360, 700, 14);
  ctx.fill();
  ctx.fillStyle = '#e7e9ee';
  ctx.fillRect(120, 90, 1360, 44);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = ['#ff5f57', '#febc2e', '#28c840'][i];
    ctx.beginPath();
    ctx.arc(146 + i * 22, 112, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#c9ced8';
  for (let i = 0; i < 9; i++) ctx.fillRect(160, 180 + i * 46, 360 - (i % 3) * 70, 12);
  ctx.fillStyle = '#222';
  ctx.font = '600 26px sans-serif';
  ctx.fillText('用验证器 App 扫描二维码', 620, 210);
  ctx.fillStyle = '#666';
  ctx.font = '16px sans-serif';
  ctx.fillText('为你的账户启用两步验证', 620, 242);
  const spots = texts.length > 1 ? [[620, 280], [1000, 420]] : [[760, 300]];
  texts.forEach((t, i) => {
    const [x, y] = spots[i] ?? [620, 300];
    drawQr(ctx, t, x, y, texts.length > 1 ? 260 : 300);
  });
  return c;
}

// ───────── 原生桥 mock ─────────

function installNative(mode: string | null) {
  if (!mode) {
    delete window.__cosyeeScreenQr;
    return;
  }
  window.__cosyeeScreenQr = {
    available: true,
    scan: () =>
      new Promise((resolve) => {
        if (mode === 'wait') return; // 一直等待
        setTimeout(() => {
          if (mode === 'err') resolve({ status: 'error', message: '屏幕录制权限未开启，请在系统设置中允许后重试' });
          else if (mode === 'cancel') resolve({ status: 'cancelled' });
          else resolve({ status: 'ok', texts: [SAMPLE_LINKS.split('\n')[1]] });
        }, 1400);
      }),
  };
}

// ───────── 页面 ─────────

const STATES: { id: string; label: string }[] = [
  { id: 'scan', label: '扫描' },
  { id: 'image', label: '图片' },
  { id: 'link', label: '链接' },
  { id: 'backup', label: '备份' },
  { id: 'preview', label: '预览' },
  { id: 'picker', label: '分组选择' },
  { id: 'region', label: '框选' },
];

/** 往目标上派发一次带图片文件的 paste，模拟 Ctrl+V 粘贴截图 */
async function pasteImage(text: string) {
  const blob = await makeQrBlob(text);
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'qr-sample.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}

/** 模拟「粘贴」文本到链接框并触发自动解析 */
function pasteLinkText(text: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('.cz-2fa-imp__ta');
  if (!ta) return;
  ta.focus();
  ta.dispatchEvent(new Event('paste', { bubbles: true }));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export default function TwoFaImportDevPage() {
  const params = new URLSearchParams(location.search);
  const state = params.get('state') ?? 'scan';
  const nativeMode = params.get('native');
  const autofeed = params.get('autofeed') === '1';
  const qrCount = Number(params.get('qr') ?? 1);
  const [theme, setTheme] = useState(params.get('theme') === 'light' ? 'light' : 'dark');
  const [narrow, setNarrow] = useState(params.get('narrow') === '1');
  const [method, setMethod] = useState<TwoFaImportMethod>(
    (['scan', 'image', 'link', 'backup'] as const).find((m) => m === state) ?? (state === 'preview' || state === 'picker' ? 'link' : 'scan'),
  );
  const [log, setLog] = useState<string>('');
  const [regionOpen, setRegionOpen] = useState(state === 'region');
  const [regionResult, setRegionResult] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // 原生桥必须在子组件挂载前就位（getScanAvailability 在首次渲染时读取）
  useMemo(() => installNative(nativeMode), [nativeMode]);

  const frame = useMemo(() => {
    const t = SAMPLE_LINKS.split('\n');
    return makeDesktopFrame(qrCount === 0 ? [] : qrCount === 2 ? [t[1], t[3]] : [t[1]]);
  }, [qrCount]);

  // 自动化驱动（只为验收截图）
  useEffect(() => {
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    if (state === 'preview' || state === 'picker') {
      later(() => pasteLinkText(SAMPLE_LINKS), 250);
    }
    if (state === 'picker') {
      later(() => document.querySelector<HTMLButtonElement>('.cz-2fa-gp')?.click(), 1000);
    }
    if (autofeed && (state === 'image' || state === 'scan')) {
      later(() => void pasteImage(SAMPLE_LINKS.split('\n')[1]), 350);
    }
    return () => timers.forEach(window.clearTimeout);
  }, [state, autofeed, epoch]);

  const go = (s: string) => {
    const u = new URL(location.href);
    u.searchParams.set('state', s);
    location.href = u.toString();
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ambient), var(--bg)', color: 'var(--text)', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 14, fontSize: 12 }}>
        {STATES.map((s) => (
          <button key={s.id} type="button" className={`cz-2fa-btn is-sm${s.id === state ? ' is-primary' : ''}`} onClick={() => go(s.id)}>
            {s.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="cz-2fa-btn is-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '切到浅色' : '切到深色'}
        </button>
        <button type="button" className="cz-2fa-btn is-sm" onClick={() => setNarrow(!narrow)}>
          {narrow ? '常规宽度' : '窄屏 320'}
        </button>
        <button type="button" className="cz-2fa-btn is-sm" onClick={() => void pasteImage(SAMPLE_LINKS.split('\n')[1])}>
          模拟粘贴二维码截图
        </button>
        <button type="button" className="cz-2fa-btn is-sm" onClick={() => setRegionOpen(true)}>
          打开框选层
        </button>
        <button type="button" className="cz-2fa-btn is-sm" onClick={() => setEpoch((n) => n + 1)}>
          重置
        </button>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div
          ref={slotRef}
          className="cz-2fa-pop"
          style={{
            position: 'relative',
            top: 'auto',
            right: 'auto',
            width: narrow ? 320 : 360,
            maxHeight: '78vh',
            animation: 'none',
          }}
        >
          <TwoFactorImportView
            key={`${method}-${epoch}`}
            method={method}
            groups={GROUPS}
            defaultGroupId="g-cloud"
            previewImport={mockPreview}
            importText={mockImport}
            onBack={() => setLog('onBack()')}
            onDone={(r) => setLog(`onDone(${JSON.stringify(r)})`)}
            onSwitchMethod={(m) => {
              setLog(`onSwitchMethod(${m})`);
              setMethod(m);
            }}
          />
        </div>
        <pre style={{ margin: 0, fontSize: 11.5, color: 'var(--text-3)', maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {`state=${state}  native=${nativeMode ?? '无'}  method=${method}\n${log}${regionResult ? `\n框选结果：${regionResult}` : ''}`}
        </pre>
      </div>

      {regionOpen && (
        <ScreenRegionPicker
          frame={frame}
          onCancel={() => {
            setRegionOpen(false);
            setLog('region: onCancel()');
          }}
          onResult={(t) => {
            setRegionOpen(false);
            setRegionResult(t);
            setLog('region: onResult()');
          }}
        />
      )}
    </div>
  );
}
