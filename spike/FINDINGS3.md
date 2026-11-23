# FINDINGS3：消息队列 / 优先级 / 取消 / 回退（rewind）协议实测

- 被测：claude.exe 2.1.326，模型 `claude-haiku-5-5`，`--effort low`；启动参数同 `buildArgs`（含 `--replay-user-messages`），env 经 `cleanEnv`。
- 脚本：`spike/queue-probe.mjs <A|B|C|D|E|E2|F|G|H>`；fixture：`shared/fixtures/queue-*.jsonl`（stdout）与 `queue-*.transcript.jsonl`；发送内容 / 时间线：`spike/queue-*.sent.json`、`spike/queue-*.timeline.txt`。
- 场景：A=steering(next)，B=follow-up(later)，C=不带 priority，D=cancel_async_message，E=interrupt send_now，E2=priority `now`，G=interrupt cancel_queued，F=rewind，H=补充（rewind 失败形态、回退第一条、空闲时发 next）。
- M1 统一提示词：依次单独调用 3 次 `sleep 4`（Bash），每次后报告，最后说 `DONE-M1`；约 15 秒运行窗口，+3~5s 注入 M2。时间为相对场景第一行 stdin 的秒数。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| user 消息的 `uuid` | 生效。原样成为 `command_lifecycle.command_uuid`、echo 的 `uuid`、`status.user_message_uuids[]`、transcript 的 `source_uuid`/`commandUuid`，是唯一关联键 |
| `priority` | 生效：`now`/`next`/`later`。**不带 priority = next**（C 与 A 时间线一致） |
| `command_lifecycle` | **顶层帧** `type:"command_lifecycle"`，不是 system 子类型 |
| echo | 带我们的 uuid、`isReplay:true`、`timestamp`；**timestamp 是入队时刻**，不是 echo 时刻 |
| steering 的 echo 位置 | tool_result 的 user 帧之后、`lifecycle started` 与 `status requesting` 之前；不开新 turn，无新 init/result |
| send_now vs `now` | 都能立即发送。send_now 有回执，但 M1 的 result 为 error 且 transcript 留中断标记；`now` 一步到位、静默，result 为 success |
| cancel_async_message | 成功 `{"cancelled":true,"message_uuid":"…"}`，失败 `{"cancelled":false}`，外层都是 `success` |
| rewind_conversation | 成败外层都是 `success`，看内层 `rewound`；运行中可调用（`interrupt_if_running:true`），先中断再回应 |
| rewind 对 transcript | **分叉而非截断**：旧分支保留，新消息 `parentUuid` 挂回被回退消息的父节点，并追加 `last-prompt{rewound:true,cutUuid}` |
| rewind_files | 当前启动参数下不可用：`File rewinding is not enabled.` |
| steering 在 transcript | **没有 user 条目**：`attachment{queued_command}` + `queue-operation remove(absorbed_mid_turn)` |
| follow-up 在 transcript | 普通 user 条目（`origin:"sdk"`） |

## 1. init.capabilities

```
"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","interrupt_send_now_v1",
 "interrupt_requeue_taken_v1","msg_lifecycle_v1","request_marker_lists_v1","ask_user_question_unanswered_v1",
 "lifecycle_wakeup_source_v1",...]
```

- 没有 rewind 的能力位，但 `rewind_conversation` 可用。
- 每个新 turn 都会再发一次 init（later 开的新轮也有），steering 不会。

## 2. 三种 priority

| priority | 忙碌时行为 | lifecycle | echo 位置 | result |
|---|---|---|---|---|
| `next` / 缺省 | 等当前工具返回后**并入同一 turn**（不打断运行中的工具） | `queued` → `started`（并入时）→ `completed`（**在 result 之前**） | tool_result 之后、`started` 之前 | 一个 result 覆盖 M1+M2 |
| `later` | 当前 turn 全结束后另开新 turn | `queued` → … → M1 completed → `started` → init/status/echo/assistant/result → `completed` | 新 turn 内，`status requesting` 之后 | 两个 result |
| `now` | **静默中止**当前 turn 并立即处理 | `queued` → M1 `cancelled` → `started` → … → `completed` | 新 turn 内 | M1 result 为 success + `terminal_reason:"aborted_tools"` |
| 空闲时发 | 无区别 | `queued` 与 `started` 同一毫秒 | `status requesting` 后约 0.7~1.3s | 正常 |

信号：`queued`（写入后 <1ms 同步发出，早于任何 control_response）/ `started`（同时 `system/status requesting` 的 `user_message_uuids` 含该 uuid；steering 并入后为 `[M1, M2]`）/ `completed` / `cancelled`（被取消的永远没有 echo）。schema 另有 `discarded`、`refused`，未触发，按终态失败处理。

A（steering）节选：

```
+3.96s -> {"type":"user","priority":"next","uuid":"83a2459f-…","message":{"role":"user","content":"另外请在最后说一句 STEER-OK"}}
+3.96s <- {"type":"command_lifecycle","command_uuid":"83a2459f-…","state":"queued","uuid":"ae54c07c-…","session_id":"…"}
+7.98s <- user tool_result
+7.99s <- {"type":"user","message":{"role":"user","content":"另外请在最后说一句 STEER-OK"},"parent_tool_use_id":null,"uuid":"83a2459f-…","timestamp":"…03.321Z","isReplay":true}
+7.99s <- command_lifecycle started (M2)
+7.99s <- system/status requesting user_message_uuids:[M1, M2]
+19.67s <- assistant "…DONE-M1\n\nSTEER-OK"
+19.68s <- command_lifecycle completed (M2)
+19.69s <- result success
+19.69s <- command_lifecycle completed (M1)
```

B（later）节选：

```
+3.94s -> user priority:"later" uuid=055e0e58
+3.94s <- lifecycle queued (M2)        （M1 期间无 echo、无 started）
+19.26s <- result success "…DONE-M1" → completed (M1) → started (M2)
+19.28s <- system/init → status requesting [M2]
+20.06s <- user isReplay uuid=055e0e58
+20.15s <- result success → completed (M2)
```

## 3. echo（isReplay）

```json
{"type":"user","message":{"role":"user","content":"…"},"session_id":"…","parent_tool_use_id":null,
 "uuid":"<我们的 uuid>","timestamp":"<入队时刻>","isReplay":true}
```

- 工具结果 user 帧没有 isReplay；echo 不回显 priority；content 回显为字符串（发 block 数组时未测）。
- 排序按到达顺序，不按 timestamp。被取消的消息永无 echo。

## 4. command_lifecycle

```json
{"type":"command_lifecycle","command_uuid":"<消息 uuid>","state":"queued","uuid":"<帧 uuid>","session_id":"…"}
```

顺序：`queued` 总是最先；普通消息 `completed` 紧跟 result 之后，steering 的在 result 之前；被中断：result → `cancelled(被中断的)` → `started(下一条)`；`cancel_async_message` 成功时 `cancelled` 帧先于 control_response；`interrupt{cancel_queued}` 每条一个 `cancelled`，当前运行的随后也 `cancelled`。

## 5. 取消

cancel_async_message（D）：

```
-> {"type":"control_request","request_id":"…","request":{"subtype":"cancel_async_message","message_uuid":"c85e7602-…"}}
<- command_lifecycle cancelled
<- {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"cancelled":true,"message_uuid":"c85e7602-…"}}}
失败: {"response":{"subtype":"success","response":{"cancelled":false}}}
```

- 重复取消、不存在、已被消费都返回 `cancelled:false`，无法区分原因。
- transcript 只有 `queue-operation enqueue`（带 content）和 `dequeue`。

interrupt + cancel_queued（G）：同时清空队列并中断当前 turn，没有“只清队列”的选项；transcript 记 `queue-operation remove reason:"cleared_on_cancel"`。单条撤回用 `cancel_async_message`。

## 6. send_now vs priority `now`

send_now（E）：

```
-> user priority:"later" uuid=c427f1cf
-> {"type":"control_request","request":{"subtype":"interrupt","send_now":true,"message_uuid":"c427f1cf-…"}}
<- {"response":{"subtype":"success","response":{"still_queued":["c427f1cf-…"],"send_now":"stopped"}}}
<- user tool_result "The user doesn't want to proceed…" / user "[Request interrupted by user for tool use]"
<- result error_during_execution terminal_reason:"aborted_tools" is_error:true
<- lifecycle cancelled (M1) → started (M2) → echo → … → completed
没有等待消息时: {"still_queued":[],"send_now":"nothing_waiting"}
```

priority now（E2）：tool_result `"<error>Command was aborted before completion</error>"` → result success `aborted_tools` is_error:false → M1 cancelled → M2 started。

| | send_now | `now` |
|---|---|---|
| 请求数 | 2（或对已排队消息 1） | 1 |
| 回执 | 有（`stopped`/`delivering`/`nothing_waiting`） | 无 |
| M1 result | error，is_error:true | success |
| transcript | 有 `[Request interrupted by user for tool use]` | 无 |

判断“被用户中断”用 `terminal_reason==="aborted_tools"`（或 `aborted_streaming`）或 `cancelled` 帧，不要靠 `is_error`。

## 7. rewind

请求 / 响应：

```json
-> {"type":"control_request","request_id":"…","request":{"subtype":"rewind_conversation","target_message_uuid":"41a3b145-…"}}
<- {"response":{"subtype":"success","response":{"rewound":true,"targetMessageUuid":"41a3b145-…","prefillText":"记住数字 2，回复 OK","precedingAssistantUuid":"2d5fa7d2-…"}}}
失败: {"rewound":false,"prefillText":null,"precedingAssistantUuid":null,"error":"target not found","reason":"target_not_found"}
```

- `target_message_uuid` 是要回退的 user 消息；它及之后都被回退；`prefillText` 填回输入框。
- 回退第一条：`precedingAssistantUuid:null`，之后新消息成为新根。
- 运行中（`interrupt_if_running:true`）：先出现与 interrupt 相同的中断序列（tool_result 拒绝 → `[Request interrupted…]` → result error aborted_tools → lifecycle cancelled），约 30ms 后才回 control_response。前端要把这个 result 与在途 rewind 关联，不当错误展示。
- 回退同时作用于模型上下文（实测模型不再记得被回退的内容）。
- 实时流上 rewind **没有事件帧**，只有 control_response。
- rewind_files：`dry_run` → `{"canRewind":false,"error":"File rewinding is not enabled."}`；非 dry_run → control_response `subtype:"error"`。暂不做入口。

transcript：分叉而非截断。

```
U1 (root) └ A1 └ att
              ├ U2 "记住数字 2"   ← 被回退（死分支）
              └ U3 …            ← parentUuid 与 U2 相同，当前分支
```

回退标记：`{"type":"last-prompt","lastPrompt":"…","leafUuid":"<回退后叶子>","explicit":true,"rewound":true,"cutUuid":"<被切的 user uuid>"}`。

前端从 transcript 重建：按 `uuid`/`parentUuid` 建树（user/assistant/attachment/system 有 uuid；queue-operation、last-prompt 等无 uuid 不进树），取最后一个对话节点沿 `parentUuid` 回到根，**不在这条链上的就是被回退的**。

## 8. steering / follow-up 在 transcript

steering：没有 user 条目。

```json
{"type":"queue-operation","operation":"enqueue","content":"…"}
{"parentUuid":"…","type":"attachment","uuid":"…","attachment":{"type":"queued_command","prompt":"…","source_uuid":"<消息 uuid>","commandMode":"prompt","hostsOwnTurn":true}}
{"type":"queue-operation","operation":"remove","reason":"absorbed_mid_turn","commandUuid":"<消息 uuid>"}
```

附件挂在 tool_result 之后、下一个 assistant 之前。

follow-up：`enqueue` → `dequeue` → 普通 `user` 条目（uuid 即我们的 uuid，`origin:"sdk"`）。

被取消：`enqueue` + `dequeue`（cancel_async_message）或 `remove reason:"cleared_on_cancel"`；不进对话链。

## 9. 未实测

`requeue_if_interrupted_within_ms`；lifecycle `discarded`/`refused`；interrupt 响应 `turn` / `put_back`；block 数组（含图片）的 echo；steering 在最后一次工具结果之后才到达时的行为；子代理并行时 `next` 并入哪一层；不带 `interrupt_if_running` 时运行中 rewind 是否被拒。

## initialize 的 models（模型菜单数据源）— 2026-11-23，CLI 2.1.326，脚本 `models-probe.mjs`

不发消息起 `claude -p --input-format stream-json …`，发 `control_request initialize`，约 0.6–0.7s 返回（不调模型、不耗额度）。`response.account` 含邮箱，只取 `models`。

| 情形 | models |
|---|---|
| 订阅账号 | `default`（Default (recommended)）+ `opus/sonnet/fable/haiku`（displayName 带版本：Opus 5.5 …）+ 全名 9 个（`claude-fable-5-1`、`claude-haiku-4-5-20251001`、`claude-sonnet-5`、`claude-opus-5`、`claude-fable-5`、`claude-opus-4-8/4-7/4-6`、`claude-sonnet-4-6`） |
| API 账号（第三方 Base URL，无映射） | 只有 `default` + 4 个别名；displayName 只是「Opus」「Sonnet」，版本在 description 开头：`Opus 5.5 · Best for … · $4/$20 per Mtok` |
| API + `ANTHROPIC_DEFAULT_*_MODEL[_NAME]` | 映射过的别名：displayName = `_NAME`，没给就 = 模型 id；resolvedModel = 映射值（含 `[1m]`）；description `Custom Sonnet model (1M context)`；没映射的别名保持原样 |

`supportedEffortLevels`：多数 5 档；`claude-opus-4-6` / `claude-sonnet-4-6` 无 xhigh；`claude-haiku-4-5-20251001` 没有该字段（不支持强度）；自定义映射的别名报 5 档。
