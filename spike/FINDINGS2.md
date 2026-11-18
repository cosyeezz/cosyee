
## 记录与账户（B2）

环境：Windows 11、Claude Code CLI 2.1.325。全部为只读调研 + 自建临时会话验证（cwd `...\Temp\b2probe`，`claude -p "只回复 ok" --model haiku`，已 `env -u` 去掉全部 `CLAUDE_CODE_*` 与 `CLAUDECODE`）。脱敏样本：`F:\Cosyee\shared\fixtures\transcript-sample.jsonl`（前 10 行为真实临时会话条目，后 10 行为按真实结构手写的示例：Agent tool_use/tool_result、system/turn_duration、system/local_command、ai-title、custom-title、agent-name、tools-used；账户 uuid 与用户名已替换）。

### 1. projects 目录名编码与反查 cwd

- 规则：cwd 中每个非 `[A-Za-z0-9]` 字符替换为 `-`。`F:\Cosyee` -> `F--Cosyee`；`C:\Users\<user>\AppData\Local\Temp\b2probe` -> `C--Users-<user>-AppData-Local-Temp-b2probe`。本机 37 个项目目录全部吻合，0 例外。
- 有损不可逆（`\`、`:`、`.`、空格、`-`、中文都变成 `-`），不能从目录名还原 cwd。长路径 CLI 有截断前缀逻辑（本机最长 115 字符，未遇到）。
- 结论：**反查 cwd 读会话 jsonl 开头第一个带 `cwd` 字段的条目**（user/assistant/attachment/system 都带）。本机该条目最远在文件前约 12.5KB，读头 64KB 足够；有 1 个文件无 cwd（需兜底显示目录名）。会话被迁移时会有 `{"type":"relocated","relocatedCwd":"F:\\Cosyee","sessionId":"..."}`，优先于 cwd。同一目录下可能混有 cwd 不同的会话（slug 相同），CLI 会过滤，WebUI 按各文件自己的 cwd 分组即可。
- 项目目录内还有：`<sessionId>/`（`subagents/`、`tool-results/`、`custom-title.json`）、`memory/`、`<id>.desktop-released.json`（`{"v":1,"releasedAt":...,"reason":"delete"}`，桌面端标记删除，列表应据此隐藏）。

### 2. jsonl 条目类型

每行一个 JSON，`type` 取值（本机统计）：`user` `assistant` `attachment` `system`（`subtype`：turn_duration、compact_boundary、away_summary、local_command、informational、stop_hook_summary、agents_killed、scheduled_task_fire）、`queue-operation`（enqueue/dequeue/remove）、`last-prompt`、`ai-title`、`custom-title`、`agent-name`、`session-owner`、`mode`、`permission-mode`、`atis-latch`、`cost-state`、`tools-used`、`file-history-snapshot`、`file-history-delta`、`api-request`、`api-request-blob`、`api-request-shape`、`continued-in`、`bridge-session`、`relocated`。CLI 源码另有 `tag`、`agent-color`、`agent-setting`、`pr-link`（本机未见）。本机**没有** `summary` 与 `progress` 类型；未知 type 必须忽略而不是报错。

字段分组：

| 类别 | 类型 | uuid | parentUuid | isSidechain | timestamp | sessionId | isMeta |
|---|---|---|---|---|---|---|---|
| 消息链 | user / assistant / attachment / system | 有 | 有（首条 null） | 有 | 有 | 有 | user、system 可有 |
| 元数据 | 其余全部 | 无 | 无 | 无 | 仅 queue-operation、api-request*、file-history-delta、continued-in 有 | 有 | 无 |

消息链条目公共字段：`userType`、`entrypoint`（`cli` / `sdk-cli`...）、`cwd`、`version`、`gitBranch`，部分有 `slug`。user 另有 `promptId`、`permissionMode`、`promptSource`、`turnOrigin`、`turnPosition`、`isMeta`、`isCompactSummary`、`isVisibleInTranscriptOnly`、`toolUseResult`、`sourceToolAssistantUUID`、`agentId`（子代理文件内）。assistant 另有 `requestId`、`message{model,id,content,usage}`。

user 条目三种形态（本机统计）：content 为纯字符串（用户输入、`<command-name>`、`<local-command-stdout>`、`<task-notification>`、压缩摘要）；content 为数组且含 `tool_result`（占大头，不是用户说的话）；content 为数组的 `text`/`image`（带图输入）。

精简示例（真实）：
```json
{"parentUuid":null,"isSidechain":false,"promptId":"6c0e...","type":"user","message":{"role":"user","content":"只回复 ok"},"uuid":"85e7...","timestamp":"2026-11-16T13:07:00.714Z","permissionMode":"default","promptSource":"sdk","turnOrigin":"sdk","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\<user>\\AppData\\Local\\Temp\\b2probe","sessionId":"356bef19-...","version":"2.1.325","gitBranch":"HEAD"}
{"parentUuid":"fb21...","isSidechain":false,"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_...","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":4}},"requestId":"req_...","uuid":"e742...","timestamp":"2026-11-16T13:07:02.374Z","sessionId":"356bef19-...","version":"2.1.325"}
{"type":"attachment","attachment":{"type":"date","date":"2026-11-16"},"rendered":[{"content":"<system-reminder>..."}],"renderedRole":"system","uuid":"...","parentUuid":"...","timestamp":"...","sessionId":"..."}
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-16T13:07:00.649Z","sessionId":"...","content":"只回复 ok"}
{"type":"last-prompt","lastPrompt":"只回复 ok","leafUuid":"fb21...","sessionId":"..."}
{"type":"mode","mode":"normal","sessionId":"..."}
{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"..."}
{"type":"cost-state","sessionId":"...","totalCostUSD":0.0018,"totalAPIDuration":970,"modelUsage":{}}
{"type":"system","subtype":"turn_duration","durationMs":5000,"messageCount":4,"uuid":"...","parentUuid":"...","timestamp":"...","sessionId":"..."}
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"auto","preTokens":0,"postTokens":0},"logicalParentUuid":"..."}
```
- attachment 的 `attachment.type` 本机有 30+ 种（environment、model、skill_listing、date、total_tokens_reminder、file、queued_command、task_reminder、prompt_snapshot、session_context ...），多为注入给模型的 system-reminder，WebUI 渲染对话时**默认全部隐藏**；`prompt_snapshot`、`session_context`、`api-request-blob` 含系统提示词与邮箱等，不要展示也不要转存。
- 压缩摘要：`user` 条目 `isCompactSummary:true`（+`isVisibleInTranscriptOnly`），内容 "This session is being continued from a previous conversation..."。
- 元数据条目会被 CLI 反复重写到文件尾部（大文件中同一 ai-title 可重复数百次），读尾部即可取到最新值。

### 3. 标题

- 自动标题：`{"type":"ai-title","aiTitle":"Claude订阅计费与缓存命中","sessionId":"..."}`。
- 用户 `/rename X`：CLI 连续追加两行（紧随一条 system/local_command）：
```json
{"type":"custom-title","customTitle":"X","sessionId":"..."}
{"type":"agent-name","agentName":"X","sessionId":"..."}
```
  桌面端同样写 custom-title + agent-name。另有侧文件 `<project>/<sessionId>/custom-title.json`（`{"customTitle":"..."}`），仅在文件尾部找不到标题时作回退（本机 6 个）。
- 同一文件多条时：各类型都取**最后一条**。
- 显示优先级：CLI 为 `agentName > customTitle > aiTitle > summary > 首条用户消息 > "(session)"/会话 id 前 8 位`；SDK `listSessions` 为 `customTitle > aiTitle > lastPrompt > summaryHint > firstPrompt`（不读 agent-name）。WebUI 建议：`customTitle(最后) > agentName(最后) > aiTitle(最后) > 首条真实用户消息 > 会话 id 前 8 位`，并保证改名时两者同写（见第 4 条），这样与 CLI 一致。
- `claude -p --resume "<标题>"` 按**最新 custom-title** 匹配（实测）。
- 无标题时的"第一条真实用户消息"（与 SDK 一致）：`type=user`，排除 `isMeta`、`isCompactSummary`、`isSidechain`；content 为数组时遇到 `tool_result` 整条跳过，只取 `text` 块；以这些标签开头的跳过：`<bash-*>`、`<local-command-*>`、`<task-notification>`、`<system-reminder>`、`<tick>`、`<teammate-message>`、`<cross-session-message>`、`<command-*>` 等；`<command-name>` 类仅在没有其他真实输入时作兜底；超过 200 字符截断加 `…`；全无则显示 "(session)"。

### 4. 改名写回（已实测）

- 方法：往会话文件末尾追加两行（单行 JSON + `\n`），两者同值：
```json
{"type":"custom-title","customTitle":"新名","sessionId":"<id>"}
{"type":"agent-name","agentName":"新名","sessionId":"<id>"}
```
  只写 custom-title 会被旧 agent-name 盖住（CLI 优先 agentName）。SDK `renameSession(sessionId,title,{dir})` 只追加 custom-title。
- 实测：临时会话依次追加后，SDK `getSessionInfo` 立即读到新 customTitle；`claude -p --resume "<新名>"` 命中同一 sessionId，旧标题报 `--resume requires a valid session ID or session title ... does not match any session title`。
- 注意：**会话进程运行中**，CLI 会在下一轮/退出时把内存里的旧标题重写到文件尾，覆盖外部追加。运行中的会话应走控制请求 `{"subtype":"rename_session","title":"新名","source":"host","session_id":"<id>"}`；离线会话才直接追加文件。追加前确认文件末尾以 `\n` 结尾（否则先补一个换行）。
- CLI `/resume` 选择器过滤：isSidechain、teamName、被 `continued-in` 取代、daemon 会话、/loop 会话、cwd 与 slug 不符，以及 **`entrypoint` 属于 `sdk-cli`/`sdk-ts`/`sdk-py`**。实测 `claude -p` 即使设 `CLAUDE_CODE_ENTRYPOINT=cli`，条目里 entrypoint 仍是 `sdk-cli`。结论：WebUI 用 `-p`/stream-json 创建的会话**不会出现在 CLI 的 `claude --resume` 选择器里**，但 `claude --resume <id>` 或 `--resume "<标题>"` 仍可恢复。TUI 选择器本身未实测（会写 `~/.claude.json`），以源码为准。
- 临时会话需清除的环境变量：`CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_ATTENDED`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN`、`CLAUDE_CODE_EXECPATH`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（`env -u` 去掉后 `claude -p` 正常落盘）。

### 5. 上次活动时间

- CLI 源码：`modified = min(尾部最后一条带 timestamp 的消息时间, 文件 mtime)`。SDK `lastModified` 直接用 mtime。
- mtime 会被元数据重写（ai-title/last-prompt 重复追加）、改名追加、`--resume` 打开推进，也受复制/同步影响，不等于真实对话时间；元数据条目多数无 timestamp，所以取"最后一条带 timestamp 的 user/assistant/system/attachment"。
- 结论：列表初排用 mtime（只需 stat）；读尾部 64KB 后用 `min(末条消息 timestamp, mtime)` 修正显示。尾部全是元数据而无 timestamp 时回退 mtime。

### 6. 子代理记录

- 路径：`<project>/<sessionId>/subagents/agent-<agentId>.jsonl`，旁边 `agent-<agentId>.meta.json`（本机 100 个子代理 jsonl，较老的无 meta）。主会话列表必须跳过这些文件（只扫 `<project>/*.jsonl`，不递归）。
- 子代理 jsonl 每条都有 `"isSidechain":true` 与 `"agentId"`，`sessionId` 为主会话 id；首条 `parentUuid:null`，content 是 Agent 的 prompt。
- meta.json 关键字段：
```json
{"agentType":"general-purpose","description":"示例","toolUseId":"toolu_01X9a7m...","isBuiltIn":true,"spawnDepth":1,"model":"...","finished":true,"stoppedByUser":false}
```
- 映射：主会话 assistant 的 Agent `tool_use` block `id` == meta.`toolUseId`。对应 tool_result 的 user 条目带 `toolUseResult`：同步为 `{"status":"completed","agentId":"<id>","agentType":"...","totalDurationMs":..,"totalTokens":..,"totalToolUseCount":..,"content":[...]}`；后台为 `{"isAsync":true,"status":"async_launched","agentId":"<id>","description":"...","outputFile":"..."}`。`toolUseResult.agentId` 即文件名 `agent-<agentId>`。老会话无 meta 时靠这条路径反查。
- 主会话大输出另存 `<sessionId>/tool-results/toolu_*.txt`。

### 7. 账户信息（只读）

- `claude auth status`：默认输出 JSON（`--json` 即默认，`--text` 为可读文本）。字段（邮箱/组织名脱敏）：
```json
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"<email>","orgId":"<uuid>","orgName":"<email>'s Organization","subscriptionType":"pro","planTier":"pro","loginExpiresAt":"...","configDirectory":"...","projectsDirectory":"...","analyticsDisabled":false}
```
  文本模式："Login method: Claude Pro account / Organization / Email / Sign-in ends"。
- `~/.claude.json` 顶层 `oauthAccount`：`accountUuid`、`emailAddress`、`organizationUuid`、`organizationName`（可含邮箱）、`organizationType`（`claude_pro` / `claude_max` ...）、`organizationRole`、`billingType`、`hasExtraUsageEnabled`、`displayName`、`fullName`（可能就是邮箱本地部分）、`seatTier`、`organizationRateLimitTier`、`userRateLimitTier`、`subscriptionCreatedAt`、`accountCreatedAt`、`claudeCodeTrialEndsAt` 等。
- WebUI 建议：套餐用 `claude auth status` 的 `subscriptionType`/`planTier`（最直接，且不用解析大文件 `~/.claude.json`）；界面只展示邮箱和套餐，不展示 uuid/orgName；不要缓存或转发 token。每个会话文件首部的 `session-owner`、`credential_org` 含账户/组织 uuid，导出或分享记录时需剔除。

### 8. 大文件与列表扫描策略

- 本机顶层会话文件 237 个、子代理 100 个（共 337）；最大 70.6MB，其后 34.6MB、19.2MB。体积主要来自 api-request-blob、attachment（prompt_snapshot、skill_listing）与 tool_result。
- 列表策略（与 CLI/SDK 一致，缓冲 65536 字节）：
  1. 对每个项目目录 `readdir`，只取 `*.jsonl`（不递归），`stat` 得 mtime/size，据此排序分页，先返回。
  2. 并发（约 32）补全元数据：读**头 64KB**（首个带 cwd 的条目 -> cwd/gitBranch/entrypoint/创建时间、首条真实用户消息、isSidechain）与**尾 64KB**（最后的 custom-title/agent-name/ai-title/last-prompt、最后带 timestamp 的条目）。尾部读取要丢弃第一条不完整行，解析失败的行直接跳过。
  3. 标题与活动时间都以尾部为准；尾部没有时才回退头部/`custom-title.json`/会话 id。
  4. 打开会话时才全量流式读取（`readline` 逐行，不要整文件 `readFileSync`；70MB 文件整读会卡），渲染层默认过滤 attachment/api-request*/元数据类条目，大 tool_result 做折叠。
  5. 对 mtime+size 不变的文件缓存元数据；文件监听只关心 size 增长（追加）。


## 协议（B1）

> 环境：claude 2.1.325，Windows 11，订阅登录；所有探测 `--model haiku`（实际 `claude-haiku-5-5`）；启动前已从 env 删除 `CLAUDE_CODE_*` / `CLAUDECODE`。
> 原始样本：`F:\Cosyee\shared\fixtures\*.jsonl`（已脱敏：邮箱 -> `user@example.com`，account/org uuid -> 占位 uuid，用户名 -> `user`）。探测脚本：`F:\Cosyee\spike\probe3.mjs`（`node probe3.mjs <basic|resume|cwdenc|subagents|subfg|context|control|interrupt|setmodel|effort|thinking>`）、`an.mjs`（分析）、`scanbin.mjs`（只读扫 claude.exe 字符串，用来读 control 子类型的 schema 描述）、`sanitize.mjs`（脱敏）。

### 0. 总览：stdout 消息类型

| type / subtype | 说明 |
|---|---|
| `system/init` | **每一轮**（含 CLI 自动续轮、/compact 后、set_model 后）都会重发；含 cwd、session_id、model、tools、slash_commands、skills、agents、mcp_servers、capabilities 等 |
| `system/status` | `{status:"requesting"}` 每次请求前；`/compact` 时 `{status:"compacting"}` -> `{status:null,compact_result:"success"}` |
| `stream_event` | 见第 3 节；仅主代理 |
| `assistant` | **每个 content block 单独一条**（同一 `message.id`）；tool_use block 带 `caller:{type:"direct"}`，消息带 `wire_tool_inputs` |
| `user` | tool_result（带 `tool_use_result`、`tool_result_meta`）、子代理 prompt、`[Request interrupted…]`、/compact 摘要（`isReplay`） |
| `system/thinking_tokens` | `{estimated_tokens, estimated_tokens_delta}`，thinking 期间实时计数 |
| `rate_limit_event` | `rate_limit_info{status,resetsAt,rateLimitType,unifiedWindows…}` |
| `system/task_*`、`background_tasks_changed` | 子代理/后台任务生命周期，见第 2 节 |
| `control_response` | 见第 4-6 节 |
| `result` | 每轮结束；`subtype:success\|error_during_execution`、`is_error`、`stop_reason`、`terminal_reason`、`num_turns`、`duration_ms`、`total_cost_usd`、`usage{…output_tokens_details.thinking_tokens}`、`modelUsage{<model>{contextWindow:1000000,costUSD…}}`、`subagent_stats`、`result`（文本）、`session_id` |

典型一轮：`init -> status(requesting) -> stream_event* -> assistant(tool_use) -> rate_limit_event -> user(tool_result) -> thinking_tokens -> assistant(thinking) -> assistant(text) -> result`。

### 1. 会话 ID

| 问题 | 结论 |
|---|---|
| `--session-id <uuid>` | 生效；`system/init.session_id` 与 `result.session_id` 都等于传入 uuid |
| 记录文件 | `~/.claude/projects/<编码cwd>/<uuid>.jsonl`；同名目录 `<uuid>/subagents/` 放子代理记录；首行是 `session-owner` |
| cwd 编码规则 | **每个非 ASCII 字母数字字符各换成一个 `-`**（`:` `\` `.` `_` 空格、每个汉字都各算一个，不合并） |
| `--resume <uuid>` | 进程退出后重启：`session_id` **不变**，记录继续追加到同一文件，上下文接上（模型正确复述第一轮暗号与命令） |

```
F:\Cosyee\spike                                   -> F--Cosyee-spike
C:\Users\user\AppData\Local\Temp\cwd.enc_test dir 中文-x
                                                  -> C--Users-user-AppData-Local-Temp-cwd-enc-test-dir----x
```
实现建议：`cwd.replace(/[^A-Za-z0-9]/g, '-')`（汉字为 BMP 字符，一字一 `-`；增补平面字符未测，找不到文件时应按目录扫描 `<uuid>.jsonl` 兜底）。样本：`basic-tool.jsonl`、`resume.jsonl`、`cwdenc.jsonl`。

### 2. 子代理

| 问题 | 结论 |
|---|---|
| 工具名 | `tool_use.name == "Agent"`（init.tools 里仍叫 `"Task"`，**以 Agent 为准，两者都要识别**） |
| tool_use input | `{description, subagent_type, prompt, run_in_background?}` |
| 默认前后台 | `-p` 下**默认后台**（`task_started.is_backgrounded:true`）；模型显式传 `run_in_background:false` 才前台 |
| `--forward-subagent-text` | 转发子代理的**完整** assistant/user 消息（thinking、text、tool_use、tool_result 都有）；**不转发 stream_event**（带 `parent_tool_use_id` 的 stream_event 数为 0，也无子代理 message_start） |
| `parent_tool_use_id` | 在消息**顶层**，值 = 主代理那条 `Agent` tool_use 的 id；另有顶层 `agent_id`、`subagent_type`、`task_description`。主代理自己的消息为 `null` |
| 子代理 tool_use / tool_result | 转发（assistant 里的 tool_use，user 里的 tool_result，均带 `parent_tool_use_id`）；前台时首条 user（文本）是子代理的 prompt |
| 磁盘记录 | `~/.claude/projects/<cwd编码>/<sid>/subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json`；meta.`toolUseId` == 主代理 Agent tool_use 的 id；`task_started/task_notification` 的 `task_id` == `agentId` |

system 子类型：

| subtype | 关键字段 |
|---|---|
| `background_tasks_changed` | `tasks:[{task_id,run_id,task_type:"local_agent",subagent_type,description}]`（任务集合快照，空集也会发） |
| `task_started` | `task_id, run_id, tool_use_id, description, subagent_type, is_backgrounded, spawn_depth, task_type, prompt` |
| `task_progress` | `task_id, tool_use_id, description, usage{total_tokens,tool_uses,duration_ms}, last_tool_name` |
| `task_updated` | `task_id, run_id, patch{status:"completed", end_time}` |
| `task_notification` | `task_id, run_id, tool_use_id, status, output_file, summary, usage` |

主代理收到的 tool_result：

* **后台**（立即返回）：`content` 为文本 `"Async agent launched successfully… agentId … output_file …"`；`tool_use_result:{isAsync:true,status:"async_launched",agentId,description,resolvedModel,prompt,outputFile,canReadOutputFile,canContinueAgent}`。主代理随后先 `result` 结束这一轮；子代理完成后 **CLI 自动起新一轮**（`init -> assistant -> result`，无需 stdin 输入；即便 stdin 已关闭，进程也会等任务完成才退出，`subagents.jsonl` 共 3 个 result）。**前端不能把第一个 result 当作“会话空闲”，要结合 `background_tasks_changed.tasks` 是否为空。**
* **前台**：`task_notification` 先于 tool_result；tool_result 的 `parent_tool_use_id:null`，文本以 `[Subagent hand-back]` 开头 + `agentId` + `<usage>`；`tool_use_result:{status:"completed",prompt,agentId,agentType,toolsUsed,content[],resolvedModel,totalDurationMs,totalTokens,totalToolUseCount,usage,toolStats,canContinueAgent}`。

```json
{"type":"assistant","parent_tool_use_id":"toolu_01Lv5…","agent_id":"a49bbf4470cede9cd","subagent_type":"general-purpose","task_description":"Run echo AAA","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo AAA"}}]}}
```
`output_file`（`%TEMP%\claude\<hash>\<sid>\tasks\<agentId>.output`）实测为 **0 字节**，不可依赖；要还原子代理过程用转发消息或 `subagents/agent-*.jsonl`（含 `isSidechain:true`、`agentId`，以及 attachment / api-request* / prompt_snapshot 噪声行）。样本：`subagents.jsonl`（并行 2 个后台）、`subagents-fg.jsonl`（前台）、`subagent-transcript.jsonl`（磁盘记录，裁剪为 user/assistant 行）+ `subagent-transcript.meta.json`。

### 3. stream_event 结构

外层：`{"type":"stream_event","event":{…},"session_id","parent_tool_use_id":null,"uuid","api_message_id"}`；仅主代理，`parent_tool_use_id` 恒为 null（子代理不发 stream_event）。

| event.type | 内容 |
|---|---|
| `message_start` | `message{id,model,usage…,content:[]}` |
| `content_block_start` | `index, content_block`：text `{type:"text",text:""}`；tool_use `{type:"tool_use",id,name,input:{}}`（input 为空，靠 delta 拼）；thinking `{type:"thinking",thinking:"",signature:""}`，且 stream_event 顶层多 `thinking_display:"updates"` |
| `content_block_delta` | `text_delta{text}`；`input_json_delta{partial_json}`（拼完 JSON.parse）；`thinking_delta{thinking, estimated_tokens}`；`signature_delta{signature}` |
| `content_block_stop` | `{index}` |
| `message_delta` | `delta{stop_reason,…}`, `usage{output_tokens, output_tokens_details.thinking_tokens,…}`, `context_management` |
| `message_stop` | 无负载 |

之后紧跟同内容的完整 `assistant` 消息（每 block 一条，可用 `message.id` + block 顺序与流式增量对账，以完整消息覆盖流式状态）。

### 4. `/context`、`/compact`、上下文用量

| 项 | 结论 |
|---|---|
| `/context`（作为 user 消息发） | 可用，但**只有 markdown 文本**：`init -> assistant{message.model:"<synthetic>", content:[text "## Context Usage …"]} -> result(num_turns:0, stop_reason:null)`。不要解析它 |
| `/compact` | 可用：`status{compacting} -> status{null,compact_result:"success"} -> init -> system/compact_boundary{compact_metadata{trigger:"manual",pre_tokens,post_tokens,cumulative_dropped_tokens,duration_ms},logical_parent_uuid} -> user(摘要 "This session is being continued…", isReplay) -> user(<local-command-stdout>Compacted </local-command-stdout>, isReplay) -> result`；压缩后下一轮正常 |
| **结构化上下文用量** | control_request 子类型 **`get_context_usage`**，可选参数 `detail:"summary"\|"full"`（full 逐类别调 token-count API，summary 用上轮 usage + 本地估算） |

```json
->  {"type":"control_request","request_id":"c0","request":{"subtype":"get_context_usage"}}
<-  {"type":"control_response","response":{"subtype":"success","request_id":"c0","response":{
      "categories":[{"id":"system_prompt","name":"System prompt","tokens":3361,"color":"promptBorder","kind":"used"}, ...],
      "totalTokens":22500,"maxTokens":150000,"rawMaxTokens":1000000,"percentage":15,
      "autoCompactThreshold":"...","isAutoCompactEnabled":true,"autocompactSource":"env",
      "model":"claude-haiku-5-5","messageBreakdown":"...","apiUsage":"...","gridRows":"...",
      "memoryFiles":[],"mcpTools":[],"agents":[],"slashCommands":"...","skills":"..."}}}
```
注意 `maxTokens` 是**有效窗口**（本机 env `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000` 生效，故 150000；`modelUsage.contextWindow` 则是模型原生 1000000）。进度条应用 `totalTokens/maxTokens`。样本：`context.jsonl`、`control-probe.jsonl`。

### 5. 中断（interrupt）

```json
->  {"type":"control_request","request_id":"r1","request":{"subtype":"interrupt"}}
<-  {"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"still_queued":[]}}}
<-  {"type":"user", ... "content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}   // 此前还有一条被拒绝形态的 tool_result
<-  {"type":"result","subtype":"error_during_execution","is_error":true,"stop_reason":"tool_use","terminal_reason":"aborted_tools","errors":["[ede_diagnostic] ..."]}
```
* 在长命令（`ping -n 31`，约 30s）执行 ~4s 时发 interrupt：control_response 立即 success，`response:{still_queued:[]}`（`init.capabilities` 含 `interrupt_receipt_v1`、`interrupt_cancel_queued_v1`）。
* 本轮以 `result.subtype:"error_during_execution"`、`is_error:true`、`terminal_reason:"aborted_tools"` 结束（纯文本生成期间被中断时的 `terminal_reason` 未测）。该 result **不是真错误**，UI 应显示为“已中断”。
* 被中断的 tool_use 会得到一条 tool_result（内容 "The user doesn't want to proceed with this tool use…"）+ 一条 `[Request interrupted by user for tool use]` 的 user 文本。
* **进程存活**：1s 后发下一条 user 消息，正常 `init -> assistant("alive") -> result(success)`。
* 坑：Bash 工具的 `sleep 30` 在本机被 hook 拦截（"Blocked: standalone sleep"，此时没有可中断的东西），测试请用 `ping -n 31 127.0.0.1` 之类。样本：`interrupt.jsonl`。

### 6. 中途切换模型 / effort / thinking 预算

| control_request.subtype | 结果 |
|---|---|
| `set_model {model:"sonnet"}` | **成功**：`response:{model:"claude-sonnet-5-5"}`；**下一轮** `system/init.model` 变为 `claude-sonnet-5-5`（再 `set_model haiku` 同理变回）。`model` 省略/null/`"default"` = 恢复默认 |
| `set_max_thinking_tokens {max_thinking_tokens:8000}` | 成功（response 无 body）；`null` 重置为会话默认；可带 `thinking_display` |
| **`apply_flag_settings {settings:{effortLevel:"high"}}`** | **成功，这是运行中改 effort 的正确途径**：之后 `get_settings` 的 `applied.effort` 由 `low` 变 `high`，`effective.effortLevel:"high"`（取值同 `--effort`：low/medium/high/xhigh/max） |
| `set_effort`、`set_effort_level`、`get_session_info` | **失败**：`{"subtype":"error","request_id":"…","error":"Unsupported control request subtype: set_effort","error_code":"unsupported_request"}` |
| `set_permission_mode {mode:"bypassPermissions"}` | 成功，`response:{mode:"bypassPermissions"}` |
| `get_settings` | 成功：`{effective, sources, applied{model,effort,advisor,ultracode,ultracodeRequested,ultracodeAvailable,ultrathinkAvailable,…}}`（含用户 settings，**可能含个人信息，别原样上传**） |
| `initialize` | 成功：`commands, agents, output_style, models[…], account{email,organization,subscriptionType…}, pid, claude_code_version, current_permission_mode, fast_mode_state, session_state, capabilities…`（`account` 是个人信息，fixtures 已脱敏） |
| `mcp_status` | 成功 `{mcpServers:[{name,status,serverInfo,config,…}]}` |
| `rewind_files` | 成功但 `{canRewind:false,error:"File rewinding is not enabled."}` |
| 未知子类型 | `unsupported_request` 错误，进程不受影响 |

control_response 通用格式：`{"type":"control_response","response":{"subtype":"success"|"error","request_id":"…","response":{…}}}`（错误时为 `error` + `error_code` 字段，无 `response`）。**响应可能乱序**（同批多个请求，r3 的响应排在 r4/r5 之后），必须按 `request_id` 匹配；一轮生成进行中也会即时处理 control_request。
其它从二进制 schema 看到、未实测的子类型：`update_settings`（source: localSettings|userSettings）、`get_task_output{task_id}`、`start_shell_task`（@internal）、`get_usage`、`file_suggestions`、`read_file`、`get_workspace_diff`、`stop_task`。样本：`setmodel.jsonl`、`effort.jsonl`、`control-probe.jsonl`。

### 7. Ultracode

* **存在，但不是命令行参数**：`claude --help` 无 ultracode 字样（只有 `--effort <level>`；`ultrareview` 子命令是云端多代理 code review，与 Ultracode 无关）；`~/.claude/settings.json`（只读查看）也没有该键；没有专用环境变量（二进制里只看到 `CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_DISABLE_ULTRATHINK`，不属于 Ultracode）。
* 从二进制字符串得到：Ultracode = “standing dynamic-workflow orchestration, at any effort level”，**仅会话级、不落盘**（TUI 里 `/effort ultracode [on|off]`，“this session only”）。
* SDK / stream-json 下的开关：**settings 键 `ultracode`（boolean）**，可 `--settings '{"ultracode":true}'` 启动，或运行中 `apply_flag_settings {settings:{ultracode:true}}`。
* 状态查询：`get_settings.applied` 里三个字段：`ultracode`（是否生效）、`ultracodeRequested`（是否被请求）、`ultracodeAvailable`（能否生效：需 dynamic workflows 开启 + 模型支持；宿主应**仅当其为 true 时才显示 Ultracode 开关**）。
* 实测（haiku）：`apply_flag_settings {ultracode:true}` 返回 success，`ultracodeRequested:true`，但 `ultracode:false`、`ultracodeAvailable:false`（haiku 下不可用）。**未验证真正生效后的行为**，需在支持的模型上再测（本次约束全部 haiku）。
* 相关：`ultrathink` 关键字——`ultrathinkAvailable` 为 true 时，用户消息里键入 `ultrathink` 该轮按 xhigh 跑；`init.per_turn_effort_active:true` 表示改 effort 不破坏 prompt cache。样本：`effort.jsonl`。

### 8. thinking（`--effort high`）

| 位置 | 样子 |
|---|---|
| stream | `content_block_start{content_block:{type:"thinking",thinking:"",signature:""}}`（顶层 `thinking_display:"updates"`）-> 多个 `content_block_delta{delta:{type:"thinking_delta",thinking:"",estimated_tokens:50\|null}}` -> `signature_delta` -> `content_block_stop` |
| system | 并行的 `system/thinking_tokens{estimated_tokens:242,estimated_tokens_delta:192}`（累计估算，适合做“思考中 N tokens”） |
| assistant 消息 | `content:[{"type":"thinking","thinking":"","signature":"CAQSvg…"}]`，单独一条（早于 text 那条） |
| result | `usage.output_tokens_details.thinking_tokens:133`（真实计数） |

**关键：haiku-5-5 下 thinking 文本始终为空串**（只有 signature 与 token 计数，不暴露思考内容）；前端对 thinking block 在 `thinking` 为空时应显示“思考中 / 已思考（N tokens）”，不要假设有文本。其它模型是否返回摘要文本未测。`--effort low` 时 `thinking_tokens` 多为 0。样本：`thinking.jsonl`、`basic-tool.jsonl`。

### 9. 其它对实现有影响的发现

1. 每轮重发 `system/init`：不要当作“新会话开始”；用 `session_id` 判断会话，`init.model` 判断当前模型。
2. assistant 消息按 block 拆分：同一 `message.id` 多条，渲染时按 `message.id` 聚合。
3. 后台子代理会让 CLI 在 result 之后继续自动跑新一轮；要停止需中断 / `stop_task` / 杀进程。
4. `result.subtype:"error_during_execution"` 同时用于用户中断，需结合 `terminal_reason`（`aborted_tools`）与 `errors` 区分。
5. 磁盘 transcript 首行 `session-owner` 含 accountUuid/organizationUuid，`initialize.account` 含邮箱：任何日志/上报前必须脱敏。
