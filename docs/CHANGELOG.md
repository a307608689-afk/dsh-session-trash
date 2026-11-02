# 更新日志

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.7

开源准备：

- 补齐 `LICENSE`（MIT）、`.gitignore`、`package.json` 元数据（`license` / `repository` / `scripts` / `engines`）；
- 测试脚本脱敏：`selftest.mjs` 与 `test/integration.mjs` 里的硬编码用户路径改为 `os.homedir()`，工作区目录名支持 `DSH_WS_DIR` 覆盖并在缺省时自动探测；
- 文档里的绝对路径改为仓库相对路径；
- README 重排为「功能 / 安装 / 使用 / 数据与隐私 / 接口 / 边界 / 排查 / 卸载 / 开发」结构，版本流水账移入本文件。

## 0.1.6（2026-11-02）

### journal 轮转

- 单文件超过 **2 MB** 自动轮转成 `journal-<日期>-<时间>-<毫秒>.jsonl`，只保留最近 **5 份**（约 10 MB 上限）。
- 轮转在写日志之后异步做，不阻塞请求；改名同盘原子，失败只记一行日志。
- `/diagnostics` 的 `journalTail` 先读当前文件，不够 200 条时自动补最近一份归档。

### 过期自动清理

- 插件每分钟看一眼（轻量：只读 `index.json` 比对 `expiresAt`），到点才真正进写锁执行清理；默认 **30 分钟**一次。
- 间隔可配：`POST /config {"autoPurgeMinutes": 30}`，`0` = 关闭，允许 `5–1440`；`/health` 的 `autoPurge` 字段显示上一轮时间与清理条数。
- 启动 6 秒后先跑一次，之后按间隔跑；定时器在插件卸载时清理，不会重复叠加。
- `expiresAt` 兼容两种历史写法（毫秒数 / ISO 字符串），旧条目也能正常到期。

### 测试

- 纯函数单测（`node --test test/path-safety.test.mjs test/tree.test.mjs`）：路径越界、盘符、`..`、前缀同名兄弟目录、目录统计与复制后比对，共 15 项。
- 集成测试（`node test/integration.mjs`）：锁冲突 409、两路并发删除不重复、改保留期不改旧条目、`archive.json` 损坏隔离，共 9 项；跑完自动清理假会话与测试留档。

## 0.1.4

### 文件留档（回收站 → 文件留档）

- 每次插件启动时自动留档一份**元数据快照**（会话日志目录之外的 workspace.json / 回收站索引 / journal / archive 索引），同一天只留一份。
- 每次**彻底删除**之前自动留档该会话的回收站目录，留档失败会中止删除（不会出现「删了但没备份」）。
- 留档包是 zstd 压缩的 JSON（base64 存文件内容），带 sha256；默认配额 2 GB，超出按「先删最旧的删除前快照、启动快照最后删」的顺序腾空间。
- 留档过期时间跟回收站保留期一致；到期自动清理。
- 只覆盖**元数据**，不备份工作目录里的文件，也不备份附件目录。
- 启动快照只能下载/查看，不能直接还原；删除前快照可还原回原目录（目标已存在时拒绝）。

### 数据正确性

- 跨进程写锁：`~/.dsh/session-trash/.lock` 目录互斥，锁残留超过 30 秒自动清理，等待超过 4 秒放弃（不阻塞）。
- 合并导入：目标会话 15 秒内仍在写入时拒绝（`TARGET_BUSY`），避免写坏正在生成的日志；写完回读校验，失败自动从 `.bak` 恢复。
- 流式导出：`GET /export/stream` 逐事件写出，不再把整份对话拼进内存。

### 接口新增

`GET /archive`、`POST /archive/snapshot`、`GET /archive/download?archiveId=`、`GET /archive/peek?archiveId=`、`POST /archive/restore`、`POST /archive/purge`、`POST /archive/purge-expired`、`GET /export/stream`、`GET /diagnostics`。

### 安全修复

- 归档还原拒绝越界路径：`files[].path` 不允许 `..` 或绝对路径，`originalDir` 必须在 `~/.dsh/sessions` 内，否则整包拒绝（`BAD_ARCHIVE_PATH` / `BAD_ORIGINAL_DIR`）。
- 跨盘搬移改为「复制后校验文件数与字节数，一致才删源」，不一致返回 `COPY_VERIFY_FAILED` 并保留源目录。

### 卸载 / 回滚

新增 `tools/rollback-trash.mjs`：先 dry-run，再 `--write` 真正把回收站条目搬回原位并写回工作区名单。

### 诊断

设置 → 回收站 → 安全区 →「导出诊断包」下载一个 JSON（含 health、条目摘要、留档摘要、最近 200 条 journal、上次自检结果），不含对话正文。

## 0.1.3

- **数据写入拦截**：所有对 `workspace.json` 的写都必须走 `writeWorkspaceDoc()`（结构 / 时间字段 / 路径 / sessionIds 类型校验 + 备份 + 原子写 + 回读比对）。
- **版本复核**：读文件时记下 `mtime+size`，写之前再比一次；被别的程序改过就放弃本次改动。
- **互斥**：所有会改数据的接口在进程内串行，避免并发丢更新。
- **崩溃自愈**：启动时 `reconcileTrash()` 把回收站 `index.json` 与 `payload/` 目录对齐。
- **退出自检（L1 + L2）**：`pagehide` 时 `sendBeacon` 调 `POST /precheck` 做只读体检；下次启动若有 `ok:false` 记录则弹横幅，可修复或忽略。
- 设置位置：**设置 → 回收站 → 底部「安全」**；「数据写入校验」固定启用不可关闭。

## 0.1.2

- 回收站页顶部提示「有 N 个会话目录不属于任何工作区（共 X MB），可以清理」。
- 新增 `GET /dsh-session-trash/orphan-dirs`（列表，含 sid/title/sizeMB/mtime）与 `POST /dsh-session-trash/orphan-dirs {"sids":[...]}`（搬进回收站）。
- 清理不动 `workspace.json`，不新增/不删除任何会话登记。

## 0.1.1

- 所有 `workspace.json` 写入统一走 `writeWorkspaceDoc()`：校验时间字段是字符串、序列化后能解析回来才落盘，落盘后回读比对工作区 ID 集合，任一不满足就抛错并让调用方回滚。
- 读取时发现数字时间戳自动转 ISO 并记一条 `workspace-repair` 日志（写前自动备份）。
- 插件启动时做一次体检；`GET /dsh-session-trash/health` 返回 `workspace` 字段：`{ ok, workspaces, sessions, badTimestamps }`。

## 0.1.0（M0 / M1）

- M0 宿主骨架：`/dsh-session-trash/{health,list,analyze,delete,restore,purge}`，回收站存 `~/.dsh/session-trash`（payload / backups / index.json / journal.jsonl）。
- M1 客户端：会话「⋯」菜单最后一项「删除会话…」、删除确认层、设置页「回收站」（恢复 / 彻底删除 / 刷新）。
- M1.1：点完菜单项自动收起；删除成功后调用 `sessions.refresh()` 刷新侧栏，并留「刷新页面」兜底。
- M2 分析引擎：分叉会话、子任务会话（origin=subagent）、绑定定时提醒、附件引用（总数 / 只被它用 / 与其他对话共用），附件索引在空闲时预建并缓存 60 秒。
