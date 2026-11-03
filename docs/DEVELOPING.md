# 开发注意事项

## 安装 / 重载

- 不要在运行中的 Host 上反复 `link:` 装卸插件；先隔离环境跑通，再重装。
- Host 改动后重载插件或重启实例；`client.js` 改动后刷新页面。
- 重新安装 bundle 时先备份整个 `%DSH_HOME%/telephone/`。

## 通知注入

- 注入 `user/message` 必须同时带 `id`、`role: 'user'`、`content`、`source`；缺 `role` 会写坏 session log，后续请求 422。
- 通知路径要 try/catch：通知失败只能吞掉，不能 fatal。
- 冷启动/权限提升交给 session-bus；目标默认权限 `delegate`，不要凭空提权。

## 邮箱

- 正文只写 `mailboxes/<mailboxId>/inbox/<letterId>.md`；`state.json`、`audit.jsonl` 和电话封套不写正文。
- `index.json` 存标题、发件人、120 字预览、状态；不是完整正文。
- `mailboxId` 用 `mbx_` 前缀；`letterId` 用 `ltr_` 前缀；路径必须限制在 mailbox 根目录内。
- 移出电话簿时邮箱目录归档，不删除会话。

## 本地 API

- 插件页 API 只服务本机 Web UI，没有额外鉴权/Origin 校验；不要暴露 DSH Web。
- `POST /api/telephone-v10/mailbox/open` 只接受已存在的 mailbox，并限制在根目录内；不要扩展成通用“打开任意路径”。

## 数据

`%DSH_HOME%/telephone/`：

- `state.json`：电话簿、连线、配额、专线、邮箱索引、最近呼叫、设置；
- `audit.jsonl`：呼叫/投递/读取/关闭元数据，不含正文；
- `mailboxes/<mailboxId>/`：信件正文、索引、归档。

升级/回滚前备份整个目录；旧版不识别 v2 的 mailbox/call/回执字段。
