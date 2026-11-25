// 在系统文件管理器 / 终端里打开路径。路径的授权由 http 层校验（工作空间列表 / 会话 cwd 内）；
// 这里 spawn 一律用参数数组、不经过 shell，路径只作为参数或 cwd / 环境变量传递，从不拼进命令字符串。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SpawnOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Windows：参数原样交给进程（explorer 的 `/select,"path"` 需要自己加引号） */
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
}

/**
 * 启动外部程序。返回 Promise<boolean> 表示「是否真的启动了」（命令不存在为 false），用于终端的逐级回退；
 * 返回 false（或 resolve 为 false）才算失败，其它返回值都当作已启动（测试里的简单 spawner）。
 */
export type Spawner = (cmd: string, args: string[], opts?: SpawnOpts) => unknown;

export const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      shell: false,
      cwd: opts?.cwd,
      env: opts?.env,
      windowsVerbatimArguments: opts?.windowsVerbatimArguments,
      windowsHide: opts?.windowsHide,
    });
    child.once('error', () => resolve(false)); // 找不到命令等：忽略，不能让进程崩
    child.once('spawn', () => resolve(true));
    child.unref();
  });

export interface Command {
  cmd: string;
  args: string[];
  opts?: SpawnOpts;
}

export function revealCommand(dir: string, platform: NodeJS.Platform = process.platform): Command {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] }; // explorer 成功时退出码也常为 1，所以不看退出码
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

/**
 * 「在文件管理器中显示并选中该文件」：
 * - Windows：`explorer.exe /select,"<path>"`。必须 windowsVerbatimArguments 自己加引号，否则 Node 会把
 *   带空格的路径转义成 `/select,\"..\"`，explorer 不认；路径要用反斜杠，否则只会打开「文档」；
 * - macOS：`open -R <path>`；
 * - Linux：没有统一的「选中」协议，退而打开父目录。
 */
export function revealFileCommand(file: string, platform: NodeJS.Platform = process.platform): Command {
  if (platform === 'win32') {
    const p = path.win32.normalize(file);
    return { cmd: 'explorer.exe', args: [`/select,"${p}"`], opts: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', file] };
  return revealCommand(path.posix.dirname(file.replace(/\\/g, '/')), platform);
}

/**
 * 「用系统默认应用打开文件」：
 * - Windows：`explorer.exe "<path>"`，同样 windowsVerbatimArguments 自己加引号并规范化反斜杠，
 *   避免路径含空格或逗号时被 explorer 拆开；
 * - macOS：`open <path>`；
 * - Linux：`xdg-open <path>`。
 */
export function openFileCommand(file: string, platform: NodeJS.Platform = process.platform): Command {
  if (platform === 'win32') {
    const p = path.win32.normalize(file);
    return { cmd: 'explorer.exe', args: [`"${p}"`], opts: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

/**
 * 用默认应用打开等于「直接执行」或高风险启动的文件扩展名（全平台统一，宁多勿少）。
 * 注意：.apk / .zip / .docx / .pdf / .md / .txt / .json / .ts / .html 与常见图片音视频不在此列。
 */
const RUNNABLE_EXT = new Set([
  // Windows 可执行 / 脚本 / 快捷方式 / 安装包 / 配置
  'exe', 'com', 'bat', 'cmd', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msc', 'msix', 'appx', 'appxbundle', 'msixbundle',
  'application', 'gadget', 'hta', 'vb', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs', 'ws', 'wsf', 'wsh', 'wsc', 'sct',
  'ps1', 'psm1', 'psd1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml',
  'reg', 'inf', 'scf', 'lnk', 'url', 'website', 'library-ms', 'search-ms', 'settingcontent-ms', 'appref-ms',
  'chm', 'hlp', 'diagcab', 'theme', 'themepack', 'deskthemepack', 'mht', 'mhtml', 'rdp', 'wsb',
  'xll', 'wll', 'xla', 'xlam', 'docm', 'dotm', 'xlsm', 'xltm', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  'ade', 'adp', 'bas', 'crt', 'ins', 'isp', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mav', 'maw',
  'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'ops', 'pcd', 'prf', 'prg', 'shb', 'shs', 'vsmacros', 'vsw',
  'ocx', 'sys', 'drv', 'dll', 'ahk', 'au3',
  // 跨平台脚本 / 字节码 / JVM
  'jar', 'jnlp', 'py', 'pyw', 'pyc', 'pyz', 'pyzw', 'rb', 'pl', 'php',
  // Unix / macOS / Linux 可执行与启动器 / 包 / 磁盘镜像
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'command', 'tool', 'workflow', 'scpt', 'scptd', 'applescript',
  'app', 'action', 'prefpane', 'qlgenerator', 'saver', 'kext', 'plugin', 'bundle', 'service', 'osax',
  'desktop', 'appimage', 'run', 'bin', 'out', 'elf', 'so', 'dylib', 'terminal', 'fileloc', 'inetloc', 'webloc',
  'iso', 'img', 'vhd', 'vhdx', 'dmg', 'pkg', 'mpkg', 'deb', 'rpm', 'snap', 'flatpak', 'flatpakref', 'cab',
]);

/** 判断「用默认应用打开等于执行」的文件（含 macOS 的 .app / .workflow 目录与非 Windows 无扩展名可执行文件）。 */
export function isRunnableFile(
  realPath: string,
  stat: Pick<fs.Stats, 'isFile' | 'mode'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // 目录只有在 macOS 上才可能是可执行的包；别处名为 next.js、foo.app 的目录就是普通目录
  if (!stat.isFile() && platform !== 'darwin') return false;
  const base = (realPath.split(/[\\/]/).pop() ?? '').replace(/[. ]+$/, '');
  const ext = path.posix.extname(base).slice(1).toLowerCase();
  if (ext && RUNNABLE_EXT.has(ext)) return true;
  if (platform !== 'win32' && !ext && stat.isFile() && (stat.mode & 0o111) !== 0) return true;
  return false;
}

export type OpenPathResult = 'opened' | 'revealed' | 'missing' | 'failed';

/**
 * 用系统默认应用打开路径（abs 为请求路径，real 为授权后的 realpath）：
 * - 可执行类（abs 或 real 任一命中）：不直接运行，改为在文件管理器中选中（.app 目录也是选中）；
 * - 其它目录：在文件管理器中打开；
 * - 其它文件：用默认应用打开 real 路径。
 */
export async function openPath(
  abs: string,
  real: string,
  spawner: Spawner = defaultSpawner,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenPathResult> {
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return 'missing';
  }
  const runnable = isRunnableFile(real, st, platform) || isRunnableFile(abs, st, platform);
  const c = runnable
    ? revealFileCommand(real, platform)
    : st.isDirectory()
      ? revealCommand(real, platform)
      : openFileCommand(real, platform);
  let ok: unknown;
  try {
    ok = await spawner(c.cmd, c.args, c.opts);
  } catch {
    ok = false;
  }
  if (ok === false) return 'failed';
  return runnable ? 'revealed' : 'opened';
}

/** 目录存在才打开；返回是否真的发出了命令 */
export function revealFolder(dir: string, spawner: Spawner = defaultSpawner): boolean {
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch { /* 不存在 */ }
  if (!isDir) return false;
  const { cmd, args, opts } = revealCommand(dir);
  void spawner(cmd, args, opts);
  return true;
}

/** 文件 → 在文件管理器里选中；目录 → 直接打开。路径不存在返回 false。 */
export function revealPath(target: string, spawner: Spawner = defaultSpawner, platform: NodeJS.Platform = process.platform): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return false;
  }
  const c = st.isDirectory() ? revealCommand(target, platform) : revealFileCommand(target, platform);
  void spawner(c.cmd, c.args, c.opts);
  return true;
}

/**
 * 在 dir 里打开系统终端：按优先级给出一串候选命令，前一个启动失败（命令不存在）再试下一个。
 * 目录一律通过 spawn 的 cwd 传给「会继承工作目录」的程序（cmd / xterm），避免它进入命令行被 cmd 的 `&`、wt 的 `;` 等解析；
 * 只有 wt 的 `-d` 和 macOS 的 `open -a Terminal <dir>` 必须把目录放在参数里。
 */
export function terminalCommands(dir: string, platform: NodeJS.Platform = process.platform): Command[] {
  if (platform === 'win32') {
    const list: Command[] = [];
    // wt 把 `;` 当子命令分隔符、末尾反斜杠会吃掉结尾引号：这两种目录跳过 wt，走后面的回退
    if (!dir.includes(';') && !/[\\/]$/.test(dir)) list.push({ cmd: 'wt.exe', args: ['-d', dir] });
    // `start "" cmd.exe`：新开一个控制台窗口，继承 cwd。空标题参数 '' 会被 Node 引成 ""
    list.push({ cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], opts: { cwd: dir, windowsHide: true } });
    const script = 'Start-Process -FilePath powershell.exe -WorkingDirectory $env:COSYEE_TERMINAL_CWD';
    list.push({
      cmd: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      opts: { env: { ...process.env, COSYEE_TERMINAL_CWD: dir }, windowsHide: true },
    });
    return list;
  }
  if (platform === 'darwin') return [{ cmd: 'open', args: ['-a', 'Terminal', dir] }];
  return [
    { cmd: 'x-terminal-emulator', args: [], opts: { cwd: dir } },
    { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'konsole', args: ['--workdir', dir] },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'xterm', args: [], opts: { cwd: dir } },
  ];
}

/** 目录存在才打开终端；依次尝试候选命令。返回是否有命令成功启动。 */
export async function openTerminal(dir: string, spawner: Spawner = defaultSpawner, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch { /* 不存在 */ }
  if (!isDir) return false;
  for (const c of terminalCommands(dir, platform)) {
    let ok: unknown;
    try {
      ok = await spawner(c.cmd, c.args, c.opts);
    } catch {
      ok = false;
    }
    if (ok !== false) return true;
  }
  return false;
}
