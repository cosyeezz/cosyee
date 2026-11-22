// 本地路径 / 文件链接的纯函数（无副作用，前后端共用）。
// 移植自 axiom2 的 shared/local-paths.ts 与 shared/file-preview.ts（localFileLink），行为保持一致。

/** 像本地路径的文本：posix 绝对 / 盘符 / UNC / ~/ / ./ ../ / file://；含控制字符一律不是。 */
export const isLocalPath = (value: string): boolean =>
  /^(?:\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|file:\/\/)/i.test(value) && !/[\x00-\x1f\x7f]/.test(value);

export interface LocalFileLink {
  /** 斜杠统一成 `/`，已做 URL 解码；可能是相对路径、`~/` 开头或绝对路径 */
  path: string;
  line?: number;
  fragment?: string;
}

/**
 * 解析 Markdown 链接里的 href：是本地文件链接则返回路径（及行号 / 锚点），否则返回 null。
 * 远程（http/https/mailto/…）、javascript:/data:、纯锚点、带 `?query`、`//host`（UNC）、含控制字符的一律不算。
 */
export function localFileLink(href: string): LocalFileLink | null {
  if (!href || href.length > 4096 || /[\x00-\x1f\x7f]/.test(href) || /^[​‌﻿]*#/.test(href)) return null;
  // 模型生成的链接有时在绝对路径前带不可见分隔符：只剥这一段前缀，文件名里的字符保持原样
  let path = href.replace(/^[​‌﻿]+(?=[\\/]|[a-z]:[\\/]|file:\/\/)/i, '');
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if ((url.hostname && url.hostname !== 'localhost') || url.search) return null;
      path = url.pathname + url.hash;
    } catch {
      return null;
    }
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  } else if (
    /^[a-z][a-z\d+.-]*:/i.test(path) &&
    // 盘符路径不算协议；markdown 解析器会把 `F:\a.md` 的反斜杠编码成 `F:%5Ca.md`，也要认
    !/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(path) &&
    !/^[^:/\\]+\.[a-z\d]+:\d+(?::\d+)?$/i.test(path.split('#')[0]!)
  ) {
    // 其它协议（http: mailto: javascript: data: …）；`a.ts:12` 这种「文件名:行号」除外
    return null;
  }
  path = path.replace(/\\/g, '/');
  // 先按 URL 语法切开再解码：%23 属于文件名，不是锚点
  const hash = path.indexOf('#');
  let fragment = hash < 0 ? '' : path.slice(hash + 1);
  if (hash >= 0) path = path.slice(0, hash);
  if (path.includes('?')) return null;
  const suffix = /:(\d+)(?::\d+)?$/.exec(path);
  if (suffix) path = path.slice(0, -suffix[0].length);
  try {
    path = decodeURIComponent(path).replace(/\\/g, '/');
    fragment = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  if (!path || path.startsWith('//') || /[\x00-\x1f\x7f]/.test(path + fragment) || /:/.test(path.replace(/^[a-z]:/i, ''))) return null;
  const selector = /^L(\d+)(?:C\d+)?$/i.exec(fragment);
  const line = selector ? Number(selector[1]) : suffix ? Number(suffix[1]) : undefined;
  return {
    path,
    ...(line && Number.isSafeInteger(line) ? { line } : {}),
    ...(fragment && !selector ? { fragment } : {}),
  };
}

/** 路径是否已是绝对（盘符 / posix / UNC / ~ / file://），不需要再拼基准目录 */
const isAnchored = (p: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|file:\/\/)/i.test(p);

/** 相对路径拼到「某个文件所在目录」上；绝对路径或没有 file 时原样返回（用于 Markdown 文件里的相对链接） */
export function pathRelativeToFile(path: string, file?: string): string {
  return !file || isAnchored(path) ? path : file.replace(/[^\\/]*$/, '') + path;
}

/**
 * 把路径解析成绝对路径（只做字符串运算，不碰文件系统）：
 * 相对路径拼到 base 目录上并折叠 `.` / `..`；`~/` 和 file:// 无法在这里展开，原样返回（由服务端解析）。
 * 输出分隔符跟随 base（盘符或含反斜杠 → `\`，否则 `/`）。
 */
export function resolveAgainst(base: string, path: string): string {
  if (!path || /^(?:~[\\/]?$|~[\\/]|file:\/\/)/i.test(path)) return path;
  const win = /^[A-Za-z]:|\\/.test(base);
  const sep = win ? '\\' : '/';
  const full = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : `${base.replace(/[\\/]+$/, '')}/${path}`;
  const norm = full.replace(/\\/g, '/');
  const unc = norm.startsWith('//');
  const drive = /^[A-Za-z]:/.exec(norm)?.[0] ?? '';
  const rest = norm.slice(drive.length).replace(/^\/+/, '');
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  const body = out.join(sep);
  if (drive) return drive + sep + body;
  if (unc) return sep + sep + body;
  return sep + body;
}

/** 路径的最后一段（文件名 / 目录名）；去掉末尾分隔符 */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 把「原样的文件系统路径」（行内代码 / 工具参数 / 工作目录）转成 localFileLink 能无损解析的 href：
 * 只转义有 URL 含义的 `%`、`#`、`?`，文件名里的这些字符就不会被当成解码 / 锚点 / query。`:12` 行号后缀与反斜杠仍按原规则处理。
 */
export function localPathHref(raw: string): string {
  return raw.replace(/[%#?]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}
