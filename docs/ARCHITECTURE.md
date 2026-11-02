# 架构与实现

> 给想读代码、想改插件的人。只想装来用的话，看 [README](../README.md) 就够了。

## 1. 插件契约

DSH 插件分两半：**宿主半端**（Node 进程里跑）和**浏览器半端**（Web 界面里跑）。

宿主半端 `index.js` 导出三个东西：

```js
export const name = 'dsh-session-trash'
export const inject = ['webServer', 'sessions']   // 声明依赖的宿主服务
export function apply(ctx) { /* 注册入口 */ }
```

路由通过 `ctx.webServer.register` 挂到 DSH 同源下：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/dsh-session-trash/list',
  handler: async (req, res) => { /* ... */ },
}))
```

`ctx.effect(fn)` 在插件卸载时会调用 `fn` 返回的清理函数，所以路由、定时器都不用手动反注册。

浏览器半端 `client.js` 通过插槽挂 UI：

```js
slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: 'session-trash', order: 55, label: '回收站' },
  { /* 渲染函数 */ },
))
```

`settings.section` 是设置页的一栏，`order` 决定排序。

`cordis.patch.yml` + `package.json` 里的 `dsh.bundle` / `dsh.client` 字段告诉 DSH 加载哪两个入口。

## 2. 数据模型：会话就是目录

DSH 里「会话」不是一个数据库行，而是一个目录：

```
~/.dsh/sessions/<工作区目录名>/<sessionId>/session.v4.jsonl.zstd
```

归属关系写在 `~/.dsh/storages/workspace.json`：

| 字段 | 含义 |
|---|---|
| `tables.workspaces[*].sessionIds` | 每个工作区包含哪些会话 |
| `global.archivedSessionIds` | 归档的会话 |
| `global.pinnedSessionIds` | 置顶的会话 |

所以在这个插件里：

- **删除** = 把会话目录搬进回收站 + 从上面三处名单里摘掉；
- **恢复** = 把目录搬回原位 + 按记录的位置插回名单。

不碰 `session.v4.jsonl.zstd` 的内容本身，用户永远可以拿回原始文件。

## 3. 删除 / 恢复 / 彻底删除

### 删除

```
分析（/analyze）→ 留档快照 → 搬目录 → 写 workspace.json → 记 journal
```

1. **分析**：读会话目录在不在、多大、是否归档 / 置顶 / 正在运行，把结果给前端确认；
2. **留档**：把 `workspace.json`、`index.json`、`archive.json` 和相关元数据打成 zstd 包，记 sha256。留档失败会**中止删除**；
3. **搬目录**：`~/.dsh/session-trash/payload/<trashId>/`，搬完做文件数 / 字节数比对（跨盘复制也能校验）；
4. **写名单**：走唯一入口 `writeWorkspaceDoc()`（见第 4 节）；
5. **记审计**：`journal.jsonl` 追加一条。

### 恢复

反向走一遍：从 `payload/` 搬回 `sessions/`，按删除时记录的 `workspaceId` / 原位置把 sid 插回名单，归档 / 置顶状态一并恢复。

### 彻底删除

先做一次留档（带 sha256），再删目录、删索引条目。留档仍可从「留档」页还原。

## 4. 写 `workspace.json` 的三道闸

`workspace.json` 是 DSH 的命根子，写坏了会导致**重启后工作区全空**。所以插件里所有写操作都收敛到唯一入口 `writeWorkspaceDoc()`：

1. **字段校验**：`updatedAt` / `createdAt` / `lastUsedAt` 必须是 ISO 字符串（历史上写成 `Date.now()` 数字，会让宿主反序列化失败），`path` 必须是非空字符串，`sessionIds` 必须是字符串数组；
2. **版本复核**：写之前比对 `mtimeMs:size` 戳，如果文件在这期间被别的进程改过，直接抛 `WORKSPACE_STALE`，**一个字节都不写**；
3. **原子写 + 回读校验**：先写 `.tmp-<pid>` 再 `rename`，写完读回来再校验一遍工作区列表和时间戳类型，不对就抛错。

写之前还会把原文件备份到 `backups/`。

读取侧另有一层自愈：发现历史数字时间戳会自动转成 ISO（`repairWorkspaceTimestamps()`），并记一条 journal。

## 5. 并发控制

两个层级：

- **进程内**：`withOpLock()` 把所有会改数据的操作串成一条链，前一个没结束，后一个排队；
- **跨进程**：一个 lock 目录 + 超时获取，拿不到锁时明确返回 `TRASH_BUSY`（HTTP 409），**不静默降级**——静默降级会丢并发写。

## 6. 留档（archive）

- 存储：`~/.dsh/session-trash/archive/<archiveId>.zst`，索引在 `archive.json`；
- 单个包上限 48 MB（避免把内存打满），总配额默认 2 GB（可配）；
- 每个包带 sha256，还原前先校验，不一致拒绝还原（`ARCHIVE_CORRUPT`）；
- 还原时包内路径逐条过 `safeJoinInside()`，有非法路径直接拒绝（`BAD_ARCHIVE_PATH`）。

## 7. 审计与自愈

- **journal**：`journal.jsonl` 记 delete / restore / purge / auto-purge / boot / config，超过 2 MB 轮转，保留 5 份；
- **退出自检**：页面关闭时做一次只读体检，结果写 `last-exit.json`，下次启动能判断上次是不是非正常退出；
- **启动对齐**：启动时把 `index.json` 的条目和 `payload/` 目录对齐，清掉已经不一致的条目；
- **孤儿目录**：磁盘上存在但不被任何工作区 / 归档 / 置顶引用的会话目录，单独列出来，可批量移进回收站。

## 8. 安全设计

| 面 | 处理 |
|---|---|
| 路径穿越 | `lib/path-safety.mjs`：`pathInside()` 先 `resolve` 再按分隔符比较；`safeJoinInside()` 拒绝空串、绝对路径、盘符开头、`..` 逃逸 |
| 输入校验 | 所有 POST body 逐字段判类型，不合法就 400；`retentionDays` 只接受 7/30/90，`autoPurgeMinutes` 限制 5–1440 |
| 外部网络 | **零**。前端只请求同源 `/dsh-session-trash/*`，服务端不起任何出站连接 |
| 第三方依赖 | **零**。只用 Node 内置模块 |
| 代码执行 | 无 `eval` / `new Function` / 动态 `import` 用户输入 |
| 数据外发 | 无。诊断包不含对话正文，只在本地生成、由用户自己决定发给谁 |
| 权限 | 只读写 `DSH_HOME` 下的目录，不申请管理员 / root |

## 9. 目录结构

```
dsh-session-trash/
├── index.js              宿主半端：路由、存储、删除/恢复/留档逻辑
├── client.js             浏览器半端：设置页「回收站」、删除菜单、确认框
├── cordis.patch.yml      插件加载声明
├── lib/
│   ├── path-safety.mjs   路径边界（可单测）
│   └── tree.mjs          目录统计 / 复制后比对（可单测）
├── locale/               zh.json / en.json
├── tools/
│   ├── fix-workspace-timestamps.mjs   修 workspace.json 时间戳
│   └── rollback-trash.mjs             卸载前把所有会话搬回原位
├── test/                 单测 + 集成测试
└── docs/                 架构、更新日志、救援步骤、截图
```

## 10. 为什么有些操作看起来「慢」

删除要搬整个会话目录、写留档、写 `workspace.json`，都是磁盘操作；插件故意不做成「乐观返回」，而是等每一步真的落地才回响应。宁可慢一拍，也不要在界面上显示「已删除」而磁盘还没动。
