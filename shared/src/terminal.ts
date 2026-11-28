// 内置终端（工作空间里的「指令式」终端）：命令在服务端所在的宿主机上执行，输出实时推给前端。
// 每条命令单独起一个 shell 进程执行（不是 PTY），执行完记下它最后所在的目录，下一条命令从那里开始；
// 环境变量不跨命令保留。
//
// 多终端（标签页）：每个工作空间可同时有多个终端（最多 TERM_TAB_LIMIT 个），各自独立的执行记录 / 目录 /
// shell / 运行中进程；命令历史按工作空间共享。终端列表在服务端（内存），多个客户端（桌面 / 手机远程）
// 看到的是同一组标签；「当前选中哪个标签」由各客户端自己记。一个工作空间始终至少有一个终端。
//
// 传输：每个终端一条独立 WebSocket
//   GET /api/terminal/ws?root=<工作空间绝对路径>[&id=<终端 id>][&create=1]
// （鉴权、Host / Origin 校验与 /ws 相同；root 必须是已登记的工作空间）。
//   - 不带 id：连到该工作空间的第一个终端（没有就新建一个）——兼容旧客户端。
//   - 带 id、该终端存在：连上它。
//   - 带 id + create=1、不存在：用这个 id 新建终端（追加到末尾）后连上；超过上限时发 error 并以 4429 关闭。
//   - 带 id、不存在、没有 create：发 { t: 'closed', id, next } 并以 4404 关闭（终端已被别的设备关掉）。
// 连上后服务端先发一条 snapshot（含终端列表 tabs），之后推增量；
// 终端列表或任一终端的状态（运行中 / 目录 / shell / 名字）变化时，向该工作空间的所有连接广播 { t: 'tabs' }。
// 断线重连时不要带 create=1，避免把别处关掉的终端又建回来。

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

/** 终端标签的状态：idle 空闲；running 有命令在跑；failed 最近一条结束的命令出错（state=error 或退出码非 0，被用户停止不算） */
export type TermTabStatus = 'idle' | 'running' | 'failed';

/** 终端列表里的一项（标签页） */
export interface TermTabInfo {
  id: string;
  /** 用户自定义的名字；没有时前端按 runningCmd → cwd 目录名 自动生成 */
  name?: string;
  cwd: string;
  shell: TermShell;
  status: TermTabStatus;
  /** status 为 running 时，最近开始的那条运行中命令 */
  runningCmd?: string;
  createdAt: number;
}

export interface TermSnapshot {
  /** 本连接对应的终端 id */
  id: string;
  /** 工作空间根目录 */
  root: string;
  /** 本工作空间的全部终端，按标签顺序 */
  tabs: TermTabInfo[];
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
  | { t: 'history.clear' }
  /** 关闭某个终端（可以是任意标签，不限于本连接的），会停止它里面所有运行中的命令。
   *  关掉的是最后一个时，服务端自动新建一个空终端顶上 */
  | { t: 'tab.close'; id: string }
  /** 重命名；name 为空串表示恢复自动命名。最长 40 字符 */
  | { t: 'tab.rename'; id: string; name: string }
  /** 调整顺序：把 id 移到 index 位置（按移除后的数组计算，越界则夹到两端） */
  | { t: 'tab.move'; id: string; index: number };

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
  /** 终端列表（顺序 / 增删 / 任一终端的状态、目录、shell、名字变化），发给该工作空间所有连接 */
  | { t: 'tabs'; tabs: TermTabInfo[] }
  /** 本连接对应的终端已被关闭（或连接时就不存在）；next 为建议切换到的终端 id。随后服务端以 4404 关闭连接 */
  | { t: 'closed'; id: string; next: string }
  | { t: 'error'; message: string; id?: string };

/** 单个块输出最多保留的字符数（超出丢掉开头） */
export const TERM_OUTPUT_LIMIT = 256 * 1024;
/** 每个终端在内存里最多保留的块数 */
export const TERM_BLOCK_LIMIT = 200;
/** 每个工作空间最多保留的历史命令条数 */
export const TERM_HISTORY_LIMIT = 500;
/** 每个工作空间最多同时存在的终端数 */
export const TERM_TAB_LIMIT = 8;
/** 终端自定义名字的最大长度 */
export const TERM_TAB_NAME_MAX = 40;
/** WebSocket 关闭码：终端不存在 / 已关闭 */
export const TERM_WS_CLOSED = 4404;
/** WebSocket 关闭码：超过终端数上限 */
export const TERM_WS_LIMIT = 4429;
