# 阶段 0 验证结论（2026-11-16，claude 2.1.325，Windows 11，Node 24.19）

| 项目 | 结果 |
|---|---|
| 订阅登录驱动 `claude -p` | ✅ `apiKeySource: none`，走本机 OAuth 登录，不需要 API Key |
| stream-json 双向多轮 | ✅ `--input-format stream-json --output-format stream-json --verbose`，一个进程连续多轮；每轮都会重新发 `system/init` |
| `--dangerously-skip-permissions` | ✅ `permissionMode: bypassPermissions`，Bash 工具直接执行 |
| `ENABLE_TOOL_SEARCH` | ✅ `false` 首轮上下文 ≈38.5k token；`true` ≈22.5k（多出 `ToolSearch` 工具）|
| MCP 按会话开关 | ✅ `--strict-mcp-config --mcp-config '<json>'` 只加载指定服务（连 claude.ai 连接器也排除）|
| 网页终端兜底 | ✅ `@lydell/node-pty`（带预编译，无需编译）能起交互式 `claude.exe`，`/mcp` 对话框正常渲染 |

## init 消息里可直接拿来做管理面板的字段
`tools`、`mcp_servers`(name/status/source)、`slash_commands`、`skills`、`plugins`、`agents`、`model`、`permissionMode`、`memory_paths`、`fast_mode_state` 等。

## 注意事项
- MCP 服务是异步连接的：第一轮 init 里可能还是 `pending` 或为空。
- 后端启动 claude 时要清掉继承来的 `CLAUDE_CODE_*` 环境变量（如 `CLAUDE_CODE_CHILD_SESSION`），否则会关闭会话保存。
- 结果里的 `total_cost_usd` 是按 API 价格估算的，订阅用户并不实际扣这笔钱。
- 其他可用开关：`--setting-sources`、`--settings`、`--disable-slash-commands`、`--safe-mode`、`--plugin-dir`、`--effort`、`--include-partial-messages`（逐字流式）、`--resume`、`--fork-session`。
