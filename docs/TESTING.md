# 测试与回归

## 自动测试

在仓库根目录运行：

```powershell
$node = "Z:\dsh-home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node test/phone-smoke.mjs
& $node test/phone-v02-smoke.mjs
& $node test/phone-v03-smoke.mjs
& $node test/phone-v03-tools.mjs
& $node test/phone-v03-migration.mjs
& $node test/phone-v03-archived.mjs
```

覆盖：配额/计数/100 字/60 分钟超时、v0.2 配置、v0.3 投信/DND/quiet/dedupe、工具参数、v1→v2 迁移、归档过滤。

## 发布前人工回归

0.3.0 发布前已在干净 DSH 实例（独立 `DSH_HOME`、官方 web 模板、独立端口）完成：

- 插件页出现，版本 0.3.0；
- 加入电话簿自动分配邮箱；
- 无接线投信、不响铃、不唤醒；
- 收信方读信、未读减少；
- 画线后呼叫、回电、挂断；
- 静默 / quiet / 每小时上限（含 ∞）；
- 回执列表；
- 打开邮箱目录；
- 归档会话不出现在电话簿/可呼叫/可投信列表。

## 以后改版至少跑

- [ ] 六项自动测试
- [ ] 干净实例安装 + 插件页出现
- [ ] 无线投信 / 读信
- [ ] 有线呼叫 / 回电 / 挂断
- [ ] 静默、DND、∞ 上限
- [ ] 回执与打开邮箱目录
- [ ] v1 state 迁移
- [ ] 归档过滤
- [ ] 升级后会话仍能正常发消息（无 422）
