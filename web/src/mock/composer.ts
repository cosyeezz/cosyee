// 输入框调试用的假数据：与 api.pick / previewInfo / previewRawUrl 同签名。
import type { PickedItem, PreviewInfo } from '@cosyee/shared';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const POOL: PickedItem[] = [
  { path: 'C:\\Users\\Some One\\My Documents\\季度 报告 v2.docx', kind: 'file', previewToken: 'mock-file-1', isImage: false },
  { path: 'D:\\项目\\设计稿\\首页截图.png', kind: 'file', previewToken: 'mock-img-1', isImage: true },
  { path: 'C:\\Users\\Some One\\src\\cosyee', kind: 'folder', previewToken: 'mock-folder-1', isImage: false },
  { path: '/Users/zhangsan/文档/说明.md', kind: 'file', previewToken: 'mock-file-2', isImage: false },
];

let call = 0;

/** 每次返回 2 项（轮流取，覆盖文件 / 图片 / 文件夹）；mode=folders 只返回文件夹，files 只返回文件 */
export async function mockPick(mode?: 'mixed' | 'files' | 'folders'): Promise<{ items: PickedItem[]; supportsMixed: boolean }> {
  await delay(300);
  let pool = POOL;
  if (mode === 'folders') pool = POOL.filter((p) => p.kind === 'folder');
  else if (mode === 'files') pool = POOL.filter((p) => p.kind === 'file');
  const items = [pool[call % pool.length], pool[(call + 1) % pool.length]].filter((v, i, a) => a.indexOf(v) === i);
  call += 2;
  return { items, supportsMixed: mode === 'mixed' };
}

export async function mockPreviewInfo(token: string): Promise<PreviewInfo> {
  await delay(150);
  const item = POOL.find((p) => p.previewToken === token) ?? POOL[0];
  return {
    path: item.path,
    kind: item.kind,
    size: item.kind === 'folder' ? null : item.isImage ? 238_412 : 18_204,
    mtime: Date.now() - 3 * 3600_000,
    isImage: item.isImage,
  };
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150" viewBox="0 0 240 150">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a90e2"/><stop offset="1" stop-color="#9b59b6"/></linearGradient></defs>
<rect width="240" height="150" rx="10" fill="url(#g)"/><circle cx="70" cy="55" r="18" fill="#ffffff" fill-opacity=".8"/>
<path d="M0 150 L80 80 L130 120 L170 90 L240 150 Z" fill="#ffffff" fill-opacity=".35"/></svg>`;

export function mockPreviewRawUrl(_token: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`;
}

export const MOCK_SLASH_COMMANDS = ['compact', 'clear', 'context', 'cost', 'help', 'init', 'review', 'resume'];
export const MOCK_SKILLS = ['code-review', 'frontend-design', 'pdf', 'xlsx', 'skill-creator'];
