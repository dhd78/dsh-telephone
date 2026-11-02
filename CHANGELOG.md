# Changelog

## 0.3.0 — 2026-11-01

- 更名显示为「虚拟电话和邮箱系统」（内部包名仍为 `dsh-telephone`，兼容旧安装与工具名）。
- 电话簿节点自动分配稳定邮箱：`%DSH_HOME%/telephone/mailboxes/<mailboxId>/`；移出电话簿时归档。
- 新增 `phone_mailbox_list` / `phone_mailbox_read` / `phone_mailbox_send`；投信不要求电话线，只要求双方在电话簿。
- 邮箱正文只落文件，不进 `state.json`、审计或电话封套；Agent 只能读自己的邮箱。
- `phone_call` 新增 `priority`（urgent/normal/low）、`dedupeKey`、`ttlMs`、`delivery=quiet`、`letterId`。
- 新增业主静默（全局时段 / 单节点 / 每小时上限）；被抑制的呼叫标 `suppressed`，不消耗专线配额。
- 每小时呼叫上限支持 1–100，也支持 **∞**（不按小时限流）；面板可直接切换。
- 新增呼叫回执：`queued → delivered → read → replied`，以及 `expired / suppressed / failed`；`phone_status` 最近呼叫。
- 新增 `POST /api/telephone-v10/mailbox/open`（业主面板按钮；路径限制在 mailbox 根目录）。
- 面板新增邮箱未读、静默、最近呼叫/回执、打开邮箱目录。
- 面板新增默认优先级、默认投递、紧急可穿透静默；每次呼叫的 priority 仍由调用方决定。
- 已归档会话不再进入电话簿、住户映射、可呼叫/可投信列表；服务端按 `workspaceRegistry.archivedSessionIds` 过滤。
- 电话图节点放大并截断标签，最近呼叫/回执改用中文显示。
- 保持旧工具与 `/api/telephone-v10` 兼容；`state.json` 升至 v2，旧电话簿自动补邮箱。

## 0.2.2 — 2026-10-28

- ∞ 软无限配额；面板节点显示 `配额 ∞`。
- 默认 queue / 可选 steer；不硬杀工具。

## 0.1.7 — 2026-10-27

- 修复插件页「强制挂断」被参与者校验拒绝的 bug：`owner-page` 现在可以挂断任意活跃专线，审计记 `closedBy=owner-page`。
- 新增单元测试覆盖 owner-page 挂断。

## 0.1.6 — 2026-10-27

- 插件页新增「移出电话簿」：从电话簿删除某个住户节点；相关电话线删除，活跃专线先挂断（`closedBy=owner-page`, `reason=unlink`），配额一并移除；不删除 DSH 会话本身。

## 0.1.5 — 2026-10-27

- 新增「离线可唤醒」开关（插件页）：关闭后，目标会话不在线时 `phone_call` 直接报错，不做 resume；开启时保持原有冷启动行为。
- 开关持久化在 `state.json` 的 `settings.allowColdResume`，默认开启。

## 0.1.4 — 2026-10-27

- 插件页新增「清空电话线」：先逐条挂断活跃专线（安静通知双方），再清空全部电话线；带二次确认。

## 0.1.3 — 2026-10-27

- 插件页新增「一键互拉」：给电话簿里所有已启用住户两两补电话线，已有线保留原 max；密集时自动隐藏连线文字，避免 91 条线糊成一片。

## 0.1.2 — 2026-10-27

- 修复审计语义：`line-closed` 的 `from` / `to` 仍是专线两端；新增 `closedBy` 记录实际挂断方（会话 id / `system` / `owner-page`）。
- `phone_hangup` 工具记录发起挂断的会话；60 分钟超时记录 `system`；插件页强制挂断记录 `owner-page`。
- 单元测试覆盖 `closedBy`。

## 0.1.1 — 2026-10-27

- 修复 `#notifyQuiet` 注入 `user/message` 时缺少 `id` / `role` 的问题（会导致后续请求 422）。
- 修复 `#notifyQuiet` 访问 `ctx.agents` 未 inject `agents` 导致的 Host fatal。
- 修复回电提示：投递时使用自定义 reply block，接收方看到 `phone_call(...)`，不再提示不存在的 `bus_send`。
- 电话簿别名与住户名对齐；测试说明区分“测试专用共享文档”和正式信箱。
- 补充单元测试：配额/计数/上限/自动新线/100 字/60 分钟超时/quiet payload/回电指令。
- 通过 00-测试员·量规安全回归：call → 回电 → 挂断，无 422、无新 Host crash。

## 0.1.0 — 2026-10-27

- 首个可用版：电话簿、连线、专线计数、业主配额、离线唤醒、挂断、quiet 通知。
