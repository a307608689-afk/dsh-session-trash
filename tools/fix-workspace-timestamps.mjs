// 修复 workspace.json 里的数字时间戳（DSH 的存储只认 ISO 字符串）。
//
// 症状：DSH 重启后侧栏工作区/会话全空，点「新对话」报
//   workspace create failed: ... active Service "workspaceController" is unavailable
// 原因：tables.workspaces[*].updatedAt / createdAt / lastUsedAt 被写成了数字（Date.now()），
//   宿主反序列化 workspace 存储时整份失败，于是 workspace 服务起不来；会话文件本身没丢。
//
// 用法：
//   node tools/fix-workspace-timestamps.mjs            # 只检查（dry run）
//   node tools/fix-workspace-timestamps.mjs --write    # 备份后写入
//
// 默认读取 $DSH_HOME/storages/workspace.json（DSH_HOME 未设置时用 ~/.dsh）。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const file = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : join(home, 'storages', 'workspace.json')
const write = process.argv.includes('--write')

console.log('target : ' + file)
if (!existsSync(file)) {
  console.error('找不到 workspace.json')
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error('ABORT：文件不是合法 JSON（不要手改，先找备份）-> ' + (e && e.message))
  process.exit(3)
}

const tables = doc?.tables?.workspaces
if (!tables || typeof tables !== 'object') {
  console.error('ABORT：没有 tables.workspaces，结构不认识，停手')
  process.exit(4)
}

const fixes = []
for (const [id, ws] of Object.entries(tables)) {
  if (!ws || typeof ws !== 'object') continue
  for (const key of ['updatedAt', 'createdAt', 'lastUsedAt']) {
    const v = ws[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      const iso = new Date(v).toISOString()
      fixes.push({ id, key, from: v, to: iso })
      ws[key] = iso
    }
  }
}

if (!fixes.length) {
  console.log('OK：所有时间字段都是字符串，不需要修')
  process.exit(0)
}

for (const f of fixes) {
  console.log('FIX  ' + f.id.slice(0, 8) + '  ' + f.key + ': ' + f.from + '  ->  "' + f.to + '"')
}

if (!write) {
  console.log('\n（dry run）确认无误后加 --write 再跑一次')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = file + '.bak-' + stamp
copyFileSync(file, backup)
const text = JSON.stringify(doc, null, 2) + '\n'
JSON.parse(text)
writeFileSync(file, text, 'utf8')
console.log('\n已写回：' + file)
console.log('备份  ：' + backup)
console.log('下一步：完全退出 DSH（不是关窗口）再启动。')
