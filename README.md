# 虚拟电话和邮箱系统（dsh-telephone 0.3.0）

让 DSH 会话像住户一样互相打电话、投信：业主画线决定谁能叫醒谁；每个电话簿节点有自己的邮箱，任务正文走邮件，电话只负责叫醒。

> 传输层基于 [dsh-session-bus](https://github.com/donyue7/dsh-session-bus) 0.4.0（MIT，见 `THIRD_PARTY_NOTICES.md`）。电话页、独立邮箱、配额、优先级/静默/去重/TTL/回执由本插件提供。

## 功能

- **电话**：叫醒一个会话，需要业主画线；
- **插件邮箱**：每个电话簿节点自动分配，用于电话附言、回执和短跟进；
- **投信 ≠ 叫醒**：信先落邮箱；需要叫醒时再单独 `phone_call`；
- 电话支持 `priority`、`delivery=queue/steer/quiet`、`dedupeKey`、`ttlMs`、`letterId`；
- 业主可设全局静默、单节点静默、每目标每小时呼叫上限（1–100 或 **∞**）；
- 回执：`queued → delivered → read → replied`，以及 `expired / suppressed / failed`；
- 已归档会话不进入电话簿、可呼叫或可投信列表；
- 兼容旧工具名和 `/api/telephone-v10`。

## 视频

[Bilibili 演示视频：dsh-telephone 0.3.0](https://www.bilibili.com/video/BV1fJ4A6gEEW)

## 兼容性

- DSH：`0.2.1-rc.3`（`engines.dsh` 有范围；更老版本未回归）
- Node.js：`>= 22`
- 平台：DSH 桌面端 Web UI
- 依赖 Host 服务 `workspaceRegistry`（归档会话过滤）

## 安装

### GitHub Release

1. 从 [Releases](https://github.com/dhd78/dsh-telephone/releases) 下载 `dsh-telephone-v0.3.0.zip` 和 `SHA256SUMS`；
2. 用 `SHA256SUMS` 核对 SHA-256；
3. 解压，用 DSH 插件管理器 `install_bundle` 指向解压目录；
4. 按提示 `pnpm install`，重启 DSH，刷新页面；
5. 打开「设置 → 插件 → 虚拟电话和邮箱系统」。

### npm

npm 暂未发布；当前请用上面的 GitHub Release。

### 从 0.1.x / 0.2.x 升级

升级前备份整个电话数据目录：

```powershell
Copy-Item "$env:DSH_HOME\telephone" "$env:DSH_HOME\telephone.backup" -Recurse
```

安装 0.3.0 后重启 DSH，确认旧电话簿、配额和设置还在，并自动补上邮箱。

> 0.3.0 会把 `state.json` 升到 v2。旧版代码不识别 mailbox/call/回执字段；回滚前必须备份，否则新邮箱和回执可能丢失。

## 使用

- 电话正文 **≤100 字**：我是谁 + 看哪封信 + 回电；任务详情写进邮箱。
- 投信：发送方和收信方都在电话簿即可，**不要求接线**；超过 1000 封/小时会返回 `mail-rate-limited`。
- 呼叫：双方必须有一条电话线；没有线只能投信。
- 一条专线同一对会话同时只有一条；到达上限、挂断或 60 分钟空闲后关闭。
- 配额：业主给每个会话分配“新建专线次数”；新建专线消耗 1 次，已有专线内通话不消耗。
- 节点可静默、移出电话簿、打开邮箱；活跃专线会在移出前先挂断。

## 截图

演示会话为 1/2/3，截图已脱敏。

![电话簿与邮箱未读](docs/screenshots/01-overview.png)

| 电话簿 / 住户映射 | 节点详情：静默、配额、打开邮箱 |
| --- | --- |
| ![电话簿](docs/screenshots/02-phonebook.png) | ![静默与配额](docs/screenshots/03-dnd.png) |

| 最近呼叫与回执 | 打开邮箱：inbox / archive / index |
| --- | --- |
| ![回执](docs/screenshots/04-receipts.png) | ![邮箱目录](docs/screenshots/05-mailbox-folder.png) |

![邮箱根目录](docs/screenshots/06-mailbox-root.png)

## 限制与隐私

- 邮箱是 **本地明文文件**，不是加密信箱；能读磁盘/备份的人都能读到正文。不要把 Token、密码、密钥写进信件。
- 完整正文在 `%DSH_HOME%/telephone/mailboxes/<mailboxId>/inbox/*.md`；`index.json` 存标题、发件人、120 字预览和状态。
- 插件页 API 只服务本机 DSH Web UI，没有额外鉴权；不要把 DSH Web 暴露到局域网/公网。
- 不联网、不上传；被叫醒会话执行的任务是否联网，取决于该会话的权限。

更完整的威胁模型见 [SECURITY.md](SECURITY.md)；测试与回归见 [docs/TESTING.md](docs/TESTING.md)；开发注意事项见 [docs/DEVELOPING.md](docs/DEVELOPING.md)。

## AI 参与声明

- README、发布文档和安全说明由 AI 生成或整理；
- 大部分程序设计与实现由 **榫卯**（业主的 AI 插件制作助手）完成，业主 dhd 提供思路、需求与验收；
- **实际创作者：榫卯（07-插件制作师）与 dhd（GitHub: dhd78）**。

完整声明见 [AI-DISCLOSURE.md](AI-DISCLOSURE.md)。

## 许可

MIT。transport 部分来自 `dsh-session-bus` 0.4.0（MIT，版权 donyue7）；原许可证在 `LICENSE.dsh-session-bus`，第三方说明在 `THIRD_PARTY_NOTICES.md`。
