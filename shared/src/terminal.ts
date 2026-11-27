// 内置终端（工作空间里的「指令式」终端）：命令在服务端所在的宿主机上执行，输出实时推给前端。
// 每条命令单独起一个 shell 进程执行（不是 PTY），执行完记下它最后所在的目录，下一条命令从那里开始；
// 环境变量不跨命令保留。每个工作空间一个终端，多个客户端（桌面 / 手机远程）连上看到的是同一份。
//
// 传输：独立 WebSocket  GET /api/terminal/ws?root=<工作空间绝对路径>
// （鉴权、Host / Origin 校验与 /ws 相同；root 必须是已登记的工作空间）。
// 连上后服务端先发一条 snapshot，之后推增量；客户端断线重连后重新拿 snapshot 即可。

/** 可选的 shell。Windows：pwsh / powershell / cmd / gitbash；macOS、Linux：zsh / bash / sh / pwsh */
export type TermShell = 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'bash' | 'zsh' | 'sh';

export interface TermShellInfo {
  id: TermShell;
  /** 显示名，如 "PowerShell 7"、"Windows PowerShell"、"命令提示符"、"Git Bash"、"zsh" */
  label: string;
}

export type TermBlockState = 'running' | 'done' | 'stopped' | 'error';

/** 一条命令的执行记录（一个「块」） */
export interface TermBlock {
  id: string;
  cmd: string;
  /** 执行时所在目录 */
  cwd: string;
  shell: TermShell;
  startedAt: number;
  endedAt?: number;
  /** 进程退出码；被停止 / 启动失败时可能为 null */
  exitCode?: number | null;
  state: TermBlockState;
  /** stdout 与 stderr 按到达顺序合并的原始输出（可能含 ANSI 转义、\r）。过长时只保留末尾，truncated = true */
  output: string;
  truncated?: boolean;
}

export interface TermSnapshot {
  /** 工作空间根目录（终端的标识） */
  root: string;
  /** 下一条命令的执行目录 */
  cwd: string;
  shell: TermShell;
  /** 本机可用的 shell（已探测存在的） */
  shells: TermShellInfo[];
  /** 服务端平台，前端据此显示提示符风格 */
  platform: 'win32' | 'darwin' | 'linux' | string;
  /** 最近的执行记录，旧 → 新（只在内存里，服务端重启后为空） */
  blocks: TermBlock[];
  /** 本工作空间的命令历史，旧 → 新，已去重（重复执行的命令移到最后）。落盘，跨设备共享 */
  history: string[];
}

export type TermClientMsg =
  /** 执行一条命令。id 由前端生成（UUID），用于把乐观显示的块和服务端的 block 对上 */
  | { t: 'run'; id: string; cmd: string }
  /** 给正在运行的命令写 stdin（data 原样写入，回车由前端带上 "\n"） */
  | { t: 'stdin'; id: string; data: string }
  /** 停止正在运行的命令（杀掉整个进程树） */
  | { t: 'stop'; id: string }
  /** 清空执行记录（不影响历史命令、不停止正在运行的命令——运行中的块保留） */
  | { t: 'clear' }
  /** 切换 shell，下一条命令生效 */
  | { t: 'shell'; shell: TermShell }
  /** 把执行目录重置回工作空间根目录 */
  | { t: 'cwd.reset' }
  /** 从历史里删掉一条命令 */
  | { t: 'history.remove'; cmd: string }
  /** 清空历史命令 */
  | { t: 'history.clear' };

export type TermServerMsg =
  | { t: 'snapshot'; snap: TermSnapshot }
  /** 新开始执行的块（output 为空）。所有连着的客户端都会收到 */
  | { t: 'block'; block: TermBlock }
  /** 追加输出（服务端会合并约 30ms 内的分片再发） */
  | { t: 'out'; id: string; data: string }
  /** 块执行结束 */
  | { t: 'end'; id: string; state: TermBlockState; exitCode: number | null; endedAt: number; truncated?: boolean }
  /** 执行目录变化（cd 之后 / cwd.reset） */
  | { t: 'cwd'; cwd: string }
  | { t: 'shell'; shell: TermShell }
  | { t: 'history'; history: string[] }
  /** 执行记录被清空；keep 为仍保留的（运行中的）块 id */
  | { t: 'cleared'; keep: string[] }
  | { t: 'error'; message: string; id?: string };

/** 单个块输出最多保留的字符数（超出丢掉开头） */
export const TERM_OUTPUT_LIMIT = 256 * 1024;
/** 每个终端在内存里最多保留的块数 */
export const TERM_BLOCK_LIMIT = 200;
/** 每个工作空间最多保留的历史命令条数 */
export const TERM_HISTORY_LIMIT = 500;
