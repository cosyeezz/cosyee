# Cosyee WebUI

本机 Claude Code CLI 的网页界面。直接驱动已登录的 `claude` 命令（走订阅，不用 API key），以 `--dangerously-skip-permissions` 运行，具备 CLI 的全部能力。规格见 [SPEC.md](SPEC.md)。

> ⚠️ 跳过权限确认意味着模型可以不经询问执行任意命令、改动任意文件。只在你信任的目录里使用。

## 环境要求

- Node.js 24+
- 已安装并登录的 Claude Code CLI（终端里 `claude auth status` 显示已登录）
- Windows 10/11（选择窗口依赖 Windows PowerShell 5.1）；macOS 可运行，文件选择窗口未实测

## 启动（开发模式）

```bash
npm install
npm run dev
```

后端启动后会在控制台打印访问地址，直接用浏览器打开即可（不需要 token）：

```
Cosyee: http://127.0.0.1:5273/
```

`npm run dev` 里后端**不会**因为改代码而自动重启（避免重启时杀掉正在运行的 claude 会话）；改了 `server/` 后请手动重启。前端（Vite）仍会热更新。需要后端自动重启时用 `npm run dev:watch -w server`。

## 目录

| 目录 | 内容 |
|---|---|
| `shared/` | 前后端协议类型（`protocol.ts`）、会话流视图模型（`view.ts`）、模型列表，以及真实 CLI 输出样本 `fixtures/` |
| `server/` | 后端：一个会话一个 `claude` 进程（stream-json 双向）、读取 `~/.claude/projects` 下的会话记录、工作空间、选择窗口、预览、上下文 |
| `web/` | 前端：React + Vite。`core/reducer.ts` 把 CLI 事件归约成回合视图，`ui/` 下是各组件 |
| `desktop/` | 桌面版（Electron）：主进程 + preload，打包配置，构建脚本 |
| `client/` | 轻量客户端（Tauri 2，Windows / macOS / Android）：服务器列表页 `ui/` + Rust 外壳 `src-tauri/` |
| `icons/` | 图标（由设计会话维护，未完成的图标显示占位方块） |
| `spike/` | 验证阶段的探测脚本与结论（`FINDINGS.md`、`FINDINGS2.md`） |

## 常用命令

```bash
npm run typecheck   # 各工作区的类型检查
npm test            # 后端与前端单测
```

## 多台设备使用（Tailscale + 轻量客户端）

一台机器跑服务端，其它电脑 / 手机装几 MB 的客户端连过去。设备之间走 [Tailscale](https://tailscale.com) 内网，**不用任何令牌**。

### 1. 服务端：Tailscale 模式

```bash
COSYEE_HOST=tailscale npm start      # 源码运行（PowerShell：$env:COSYEE_HOST='tailscale'; npm start）
```

不想拉源码时，用 npm 直接从 GitHub 装（需要 Node.js 24+ 和已登录的 Claude Code CLI）：

```bash
npm i -g github:cosyeezz/cosyee#server-dist
# 本机没装 git 时用 tarball 地址，效果一样：
# npm i -g https://codeload.github.com/cosyeezz/cosyee/tar.gz/refs/heads/server-dist

cosyee-server --tailscale            # 不加参数则只监听 127.0.0.1；--port 改端口；--help 看用法
```

更新：重新执行同一条 `npm i -g` 命令（`--prefer-online` 可跳过 npm 缓存）。`server-dist` 分支由 `.github/workflows/server-dist.yml` 在 main 每次改动服务端 / 前端后自动构建并覆盖推送，内容是打好的单文件 `server.mjs` + 前端静态文件，没有任何依赖和安装脚本。不直接装 main 是因为 npm 装 git 仓库时会先在本机装全部开发依赖（Electron、Vite、Tauri CLI…，几百 MB）再构建。

也可以用发布页的 `cosyee-server_*.zip`：解压后 Windows 双击 `start.cmd`，macOS / Linux 运行 `./start.sh`，默认就是 Tailscale 模式。自己打包：`npm run pack:server`，输出到 `server/dist/cosyee-server/`。

Tailscale 模式下后端监听所有网卡，但在 TCP 层只接受两种连接，其它直接断开：

- 本机回环（`127.0.0.1` → `127.0.0.1`）；
- 来源是 tailnet 地址（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`），且连的是本机 **Tailscale 网卡**上的地址（按网卡名识别，运营商 CGNAT 同段地址不算）。

Host / Origin 白名单额外放行 Tailscale IP、本机名（MagicDNS 短名）和 `*.ts.net`（含 `tailscale serve` 反代出来的 `https://<机器名>.<tailnet>.ts.net`）。启动时控制台会打印可用地址。

> ⚠️ tailnet 里的任何设备都能让模型在服务端机器上执行任意命令。共享了设备或开了 Tailscale Funnel 的 tailnet 不要用，或者用 Tailscale ACL 限制只有你自己的设备能访问 7878 端口。

### 2. 客户端（`client/`，Tauri 2）

客户端只是一个系统 WebView 外壳：首页是服务器列表（存在本地），选中后整页打开服务端网页。没有业务逻辑，也不需要随服务端升级。

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows | `*_windows_x64_setup.exe` / `*_portable.exe` | 用系统自带的 WebView2 |
| macOS | `*_macos_universal.dmg` | 未经 Apple 公证：拖进「应用程序」后执行一次 `xattr -cr /Applications/Cosyee.app` |
| Android | `*_android_arm64.apk` | 允许安装未知来源应用 |

- 添加服务器：填 Tailscale IP 或机器名，端口不写默认 7878，例如 `100.106.9.14`、`my-pc`、`https://my-pc.xxx.ts.net`。
- 回到服务器列表：`Ctrl+Shift+L`（macOS `⌘⇧L` 或菜单「连接 → 服务器列表」）；Android 用返回键。
- 本地开发：`npm run dev:client`；本地打包：`npm run build:client`（需要 Rust 工具链）。改图标：改 `client/scripts/make-icon.mjs` 后 `npm run icon -w client`。

### 3. 其它电脑也想用本机后端

桌面客户端（Windows / macOS）的服务器列表下面有「本机服务」：检测 Node.js 和 Claude CLI → 一键用 npm 安装 / 更新（就是上面那条 `npm i -g`）→ 启动 / 停止。启动后自动在列表里加上「本机」（`http://127.0.0.1:7878`）。

- 服务端作为独立后台进程运行，关掉客户端不会停；日志在 `~/.cosyee/server.log`。
- 勾选「允许手机和其它电脑通过 Tailscale 连接」时以 Tailscale 模式启动，否则只监听 `127.0.0.1`。
- 停止走 `POST /api/shutdown`：只接受本机回环连接，tailnet 里的设备关不掉。
- macOS 上如果 Node 是官方 pkg 装的，`npm i -g` 需要管理员权限会失败；用 Homebrew / nvm 装的 Node 没这个问题。

每台电脑的后端各用各的 `~/.claude` 会话和登录状态，互不影响。

### 4. 发布

推送 `v*` 标签触发 `.github/workflows/release.yml`，构建 Windows / macOS / Android 客户端和独立服务端包，上传到同名 Release：

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Android 签名用仓库 secrets：`ANDROID_KEYSTORE_B64`（PKCS12 密钥库 base64）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`。**密钥丢了以后发的 APK 无法覆盖安装旧版本**，请自行备份。

## 桌面版（Electron）

桌面版把现有网页界面装进一个 Electron 窗口，前端零改动。主进程用 `utilityProcess` 启动后端（端口随机），再由后端启动各个 `claude` 子进程；窗口加载 `http://127.0.0.1:<端口>/`。

```bash
npm run dev:desktop    # 开发：后端 7878（tsx）+ Vite 5273 + Electron 窗口加载 Vite 地址
npm run build:desktop  # 构建：web/dist + desktop/dist（main.cjs、preload.cjs、server/server.mjs）
npm run start:desktop  # 用构建产物启动桌面版（需先 build:desktop）
npm run pack:desktop   # 打包 Windows x64 安装程序（NSIS），输出到 desktop/release/
```

- **Electron 版本**：45.3.3，内置 Node 24.22.3，满足 Node >= 22；版本固定为精确版本（electron-builder 不接受范围）。备选的旧线：44.11.3 / 43.8.10 / 42.11.18。
- **首次安装**：npm 11 默认不跑依赖的安装脚本，`npm install` 后如果启动时报 Electron 二进制缺失，执行一次 `node node_modules/electron/install.js`。
- **token 机制**：主进程每次启动生成 32 字节随机 token，通过 `init` 消息（不走环境变量，避免泄漏给 `claude` 子进程）交给后端；窗口通过 `session.webRequest.onBeforeSendHeaders` 给发往后端端口的 http 和 ws 请求自动加上 `x-cosyee-token` 头。后端启用 token 后，缺失或错误一律 403（常量时间比较），所以本机其它程序即使扫到端口也无法访问。网页版（不传 `authToken`）行为不变。
- **开发模式**（`COSYEE_DESKTOP_DEV=1`）：窗口直接加载 Vite 地址，连接已运行的后端，**不启停后端，也不使用 token**。仅用于开发。
- **退出**：关闭窗口时若还有会话在执行（`GET /api/running`），先弹窗确认；确认后向后端发 `shutdown`，最多等 10 秒，之后强杀进程树，不留 `claude` 残留进程。后端意外退出时弹窗并可一键重启。
- **日志**：`%APPDATA%\Cosyee\logs\desktop.log`。
- **打包说明**：后端和前端放在 asar 之外（`resources/server`、`resources/web`）。暂无自定义图标（用 Electron 默认图标）、未签名；`pack:mac` 配置已写但未实测。
- **已知限制**：如果主进程被强杀（任务管理器结束进程），后端会随之被杀，但正在执行的 `claude` 子进程可能残留；正常关闭、崩溃重启对话框、窗口关闭都会清理干净。

## 环境变量

| 变量 | 作用 |
|---|---|
| `COSYEE_HOST` | 监听地址，默认 `127.0.0.1`；`tailscale` 为 Tailscale 模式（见上文） |
| `COSYEE_PORT` | 后端端口，默认 7878 |
| `COSYEE_WEB_PORT` | 开发模式前端（Vite）端口，默认 5273；前后端都读这个变量 |
| `COSYEE_CLAUDE` | `claude` 可执行文件的路径，默认从 PATH 查找 |
| `COSYEE_ACCOUNTS_DIR` | 添加的账号的配置目录放在哪里，默认 `~/.claude-accounts`（主要供测试用） |
| `COSYEE_DESKTOP_DEV` | 仅桌面版开发：设为 1 时窗口加载 Vite 地址并连接已运行的后端（由 `npm run dev:desktop` 设置） |

## 多账号

左下角账户栏点开是账号列表：点哪个切换到哪个，最后一项「添加账号」。

- **登录一次即可**：添加账号时后台运行 `claude auth login --claudeai`，自动打开浏览器；浏览器没打开时对话框里有登录页链接，回调失败时可以把授权码粘贴进来。登录凭据存在该账号自己的配置目录里，之后切换不用再登录。
- **配置目录**：默认账号就是原来的 `~/.claude`（或 `CLAUDE_CONFIG_DIR`），不做任何改动；添加的账号放在 `~/.claude-accounts/<id>/`，启动 `claude` 时用 `CLAUDE_CONFIG_DIR` 指向它。账号列表和当前账号记在 `~/.cosyee/state.json`。
- **共享的内容**（账号目录里是指向默认账号目录的链接，目录用 junction，文件用符号链接，没有权限时退回硬链接）：
  - 会话历史 `projects/`、`file-history/`、`todos/`、`plans/`、`tasks/` 等；
  - `skills/`、`agents/`、`commands/`、`plugins/`、`output-styles/`、`hooks/`；
  - `settings.json`、`CLAUDE.md`、`history.jsonl`、`keybindings.json`。
- **MCP**：MCP 配置在 `.claude.json` 里（与登录信息同一个文件，没法链接），由 Cosyee 在账号没有运行中的 `claude` 进程时做三方同步：默认账号的 `~/.claude.json` 为主，账号目录里的 `.cosyee-mcp-sync.json` 记上次同步的快照。同步的是用户级 `mcpServers`，以及各项目的 MCP 服务器、启用 / 停用、信任和已允许的工具。
- **切换**（切换模式）：有执行中的会话时先提示「有 N 个会话正在执行」，可以强制切换（会停止这些会话）。切换后后端停止所有 `claude` 进程、清空缓存，前端整页刷新，账户栏、额度、上下文等都从新账号重新读取，不会残留旧账号的信息。
- **并行模式**（账户栏上方的开关，默认关 = 切换模式）：
  - 每个会话绑定一个账号：会话每次发送都会记下它用的账号（记在 `~/.cosyee/state.json` 的 `accounts.sessions`，切换模式下也记）。并行模式下会话用绑定的账号（账号已移除则用当前账号），新会话用当前账号。
  - 账号菜单里点另一个账号只是改「新会话用哪个账号」，不停止任何会话、不刷新页面；不同账号的会话可以同时执行，各自的 `claude` 进程用各自的 `CLAUDE_CONFIG_DIR`。
  - 会话行标题下方显示账号名；上下文、额度（`/api/usage?session=<id>`）都按会话所属账号读取，账户栏显示的是新会话用的账号。
  - 已打开的会话换了账号（比如绑定的账号被移除）：空闲的进程会在下次发送时换成新账号的进程。
  - 关闭并行模式：其它账号有执行中的会话时先提示，可以强制切换（停止它们）；之后整页刷新，全部回到当前账号。
  - MCP 同步照旧只在该账号没有运行中的进程时做；默认账号有进程在跑时也跳过，避免和 CLI 同时写 `~/.claude.json`。
  - 账号有执行中的会话时不能移除。
- **移除**：只能移除添加的账号（不能移除默认账号和当前账号；并行模式下有执行中会话的账号也不能移除）；先解除共享链接，再删除该账号目录里的私有内容，不会碰共享的内容。
- 在终端里用某个添加的账号：`CLAUDE_CONFIG_DIR=~/.claude-accounts/<id> claude`。
- 列表只显示名字、套餐和备注名，不显示、不下发邮箱和账号 uuid（前端拿到的 id 只是本地目录名）。

## 安全

- 后端默认只监听 `127.0.0.1`（Tailscale 模式见上文），网页版不使用 token（桌面版见上文 token 机制）；靠校验 Host（防 DNS rebinding）和 Origin（防其它网页跨站调用）保护。本机上的其它程序仍可直接访问接口，请只在你信任的机器上使用。
- 只能预览经系统选择窗口选出的文件，以及你粘贴进输入框的图片。
- 粘贴图片会存到 `~/.cosyee/pastes/`（`paste-时间戳-随机串.扩展名`）。只收 png / jpeg / gif / webp，按文件头判断类型，单张不超过 20MB；这些文件不会自动清理，需要时自己删。
- 不修改 `~/.claude` 下的配置；唯一的写入是「改名」时在会话记录末尾追加标题行（与 CLI 自己的 `/rename` 相同）。**例外**：用了多账号时，添加的账号里改过的 MCP 配置会同步回 `~/.claude.json`（见上文「多账号」）。
- 上下文面板里的 skill「开 / 手动 / 关」只存在 `~/.cosyee/state.json`，启动 `claude` 时用 `--settings` 传入，不改 `~/.claude/settings.json`；在 Cosyee 里关掉的 skill 在终端里照常可用。
- **例外**：上下文面板里的 MCP 开关调用的是 CLI 自己的 `mcp_toggle`，效果与终端 `/mcp` 里启用/停用相同，会按项目写入 `~/.claude.json`（`disabledMcpServers` 等），终端里也会看到这个变化。
- 账户栏只显示名字和套餐，不显示、不下发邮箱。

## 已知限制

- 通过 Cosyee 创建的会话是 `-p`（非交互）模式启动的，**不会出现在终端 `claude --resume` 的选择列表里**，但可以用 `claude --resume <会话 ID 或标题>` 直接续接。
- macOS 的文件 / 文件夹混选窗口已写好但未实测。
- 部分模型（如 Haiku）不返回思考文本，只显示「已思考（N tokens）」。
