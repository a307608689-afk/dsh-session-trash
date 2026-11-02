# 救援步骤：DSH 重启后工作区 / 会话全空

把下面整段交给任意 AI 助手或按步骤手动执行。适用症状：**DSH 重启后侧栏工作区、会话全空；新建对话弹「无法打开文件夹」并报 `workspaceController is unavailable`**。

---

## 背景（先读，别急着改）

DSH 的 `~/.dsh/storages/workspace.json` 是强 schema 存储，启动时整份反序列化；**只要有一个字段类型不对（最常见：某个工作区的 `updatedAt` 被写成了数字而不是 ISO 字符串），整个 workspace 服务就起不来**，界面表现就是「工作区、会话全没了」。会话目录 `~/.dsh/sessions/**` 本身通常没丢，**不要删、不要动、不要点「重新选择文件夹」**。

## 第 0 步：只读诊断（不改任何文件）

1. 找 DSH home：默认 `~/.dsh`（或环境变量 `DSH_HOME`）。
2. 用 Node 只读检查（Windows PowerShell 直接跑）：

   ```powershell
   node -e "const f=require('os').homedir()+'/.dsh/storages/workspace.json';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));const w=d.tables.workspaces;const keys=['updatedAt','createdAt','lastUsedAt'];for(const [id,v] of Object.entries(w)){for(const k of keys){if(v[k]!==undefined)console.log(id,k,typeof v[k],JSON.stringify(v[k]).slice(0,40))}console.log(id,'sessions',(v.sessionIds||[]).length)}console.log('global keys',Object.keys(d.global))"
   ```

   判断：任何一行打印 `number`（而不是 `string`）就是坏字段，记下是哪个 id、哪个字段。
3. 顺手确认会话目录还在：

   ```powershell
   (Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Filter "session.v4.jsonl.zstd").Count
   ```

   结果大于 0 就说明数据没丢，只是索引文件坏了。

## 第 1 步：备份

```powershell
$f = "$env:USERPROFILE\.dsh\storages\workspace.json"
Copy-Item $f "$f.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
```

## 第 2 步：修时间字段（两种做法，任选其一）

**A. 用「会话回收站」插件自带的工具（推荐，会先 dry-run 再写、自动备份）**

```powershell
node tools/fix-workspace-timestamps.mjs
# 看输出确认只列时间字段（FIX <id>.<key>: <number> -> "<ISO>"），再写：
node tools/fix-workspace-timestamps.mjs --write
```

**B. 没有插件时，用内联脚本修**

```powershell
node -e "const fs=require('fs'),os=require('os');const f=os.homedir()+'/.dsh/storages/workspace.json';const d=JSON.parse(fs.readFileSync(f,'utf8'));let n=0;for(const v of Object.values(d.tables.workspaces)){for(const k of ['updatedAt','createdAt','lastUsedAt']){if(typeof v[k]==='number'){v[k]=new Date(v[k]).toISOString();n++}}}fs.writeFileSync(f+'.tmp',JSON.stringify(d,null,2),'utf8');fs.renameSync(f+'.tmp',f);const c=JSON.parse(fs.readFileSync(f,'utf8'));const bad=[];for(const [id,v] of Object.entries(c.tables.workspaces)){for(const k of ['updatedAt','createdAt','lastUsedAt']){if(v[k]!==undefined&&typeof v[k]!=='string')bad.push(id+'.'+k)}}console.log('fixed',n,'bad left',bad.length,bad)"
```

## 第 3 步：完全退出 DSH，再启动

workspace 服务只在启动时加载文件，**改完必须彻底退出进程**（托盘退出，或任务管理器结束 DeepSeek Harness / dsh 进程），再重新打开。

## 第 4 步：验证

1. 侧栏出现工作区和会话，数量与 `workspace.json` 里 `sessionIds` 总和一致；
2. 新建对话不再报 `workspaceController is unavailable`；
3. 可选：`GET http://127.0.0.1:<端口>/dsh-session-trash/health`（端口看浏览器地址栏；插件装了才有）→ `workspace.badTimestamps=0`、`dangling=0`。

## 第 5 步：如果 workspace.json 已经彻底坏了（JSON.parse 就报错）

从插件备份里挑最近一份合法的覆盖，再重启：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\session-trash\backups\workspace-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 10 Name,Length,LastWriteTime
# 挑一份能 JSON.parse 的，先备份坏的，再覆盖：
Copy-Item "$env:USERPROFILE\.dsh\storages\workspace.json" "$env:USERPROFILE\.dsh\storages\workspace.json.broken-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
Copy-Item "<选中的备份文件>" "$env:USERPROFILE\.dsh\storages\workspace.json" -Force
```

## 绝对不要做的事

- ❌ 删/移动 `~/.dsh/sessions` 下的会话目录（那是真正的内容）。
- ❌ 删 `~/.dsh/storages` 下的文件，或删掉整个 `.dsh`。
- ❌ 点 DSH 里的「重新选择文件夹」：它会新建一个空工作区，看起来更像「数据没了」。
- ❌ 手工用记事本/编辑器改 workspace.json（编码、引号、格式很容易再坏一次）。
- ❌ 只改内存/只重启前端（F5）——必须关掉宿主进程再启动。

## 做完请回报

- 改前/改后各工作区的 `updatedAt` 类型与值；
- 备份文件路径；
- 重启后侧栏工作区数、会话总数；
- `/health` 的 `workspace` 段（如果装了插件）。
