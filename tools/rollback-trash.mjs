#!/usr/bin/env node
/**
 * rollback-trash.mjs —— 卸载「回收站」插件前，把还留在回收站里的会话搬回列表。
 *
 * 为什么需要它：插件删掉的会话被搬到 ~/.dsh/session-trash/payload/ 下，同时从
 * ~/.dsh/storages/workspace.json 的三处名单里摘掉了。卸载插件不会自动搬回来，
 * 会话就会一直躺在 session-trash 里（数据没丢，但界面上看不到）。
 *
 * 用法：
 *   node tools/rollback-trash.mjs                   # 只看计划，不动文件（默认）
 *   node tools/rollback-trash.mjs --write           # 真的搬回去
 *   node tools/rollback-trash.mjs --write --keep    # 搬回去后保留 payload 目录（不删空壳）
 *
 * 它做的事：
 *   1. 读 session-trash/index.json 的条目；
 *   2. 对每条：把 payload/<sid>__<ts>/ 搬回 originalDir（目标已存在则跳过并报告）；
 *   3. 把 sessionId 追加回它原来所属工作区的 sessionIds（不重排）；
 *   4. 写 workspace.json 前先备份到 session-trash/backups/。
 * 不做的事：不还原附件引用（附件本来就按内容寻址、没被删）、不处理留档包、不删 index.json。
 */

import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const TRASH = join(HOME, 'session-trash')
const INDEX = join(TRASH, 'index.json')
const PAYLOAD = join(TRASH, 'payload')
const BACKUPS = join(TRASH, 'backups')
const WORKSPACE = join(HOME, 'storages', 'workspace.json')

const args = new Set(process.argv.slice(2))
const WRITE = args.has('--write')
const KEEP = args.has('--keep')

const readJson = async (p, d) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d }
}

const main = async () => {
  const index = await readJson(INDEX, null)
  if (!index || !Array.isArray(index.entries)) {
    console.error('没找到可用的回收站索引：' + INDEX)
    process.exit(1)
  }
  const wsDoc = await readJson(WORKSPACE, null)
  if (!wsDoc || !wsDoc.tables || !wsDoc.tables.workspaces) {
    console.error('没找到可用的 workspace.json：' + WORKSPACE)
    process.exit(1)
  }

  const plans = []
  for (const e of index.entries) {
    const candidates = []
    // payload 目录名是 <sid>__<ts>；按 sessionId 前缀找
    const names = existsSync(PAYLOAD) ? await fsp.readdir(PAYLOAD) : []
    for (const n of names) if (n === e.sessionId || n.startsWith(e.sessionId + '__')) candidates.push(join(PAYLOAD, n))
    plans.push({ entry: e, dirs: candidates })
  }

  const willMove = plans.filter((p) => p.dirs.length > 0)
  const noDir = plans.filter((p) => p.dirs.length === 0)

  console.log('回收站条目：' + index.entries.length)
  console.log('可搬回：' + willMove.length + '，找不到目录：' + noDir.length)
  for (const p of willMove) {
    const target = p.entry.originalDir
    const exists = existsSync(target)
    console.log('- ' + (p.entry.title || p.entry.sessionId) + ' -> ' + target + (exists ? '  [目标已存在，将跳过]' : ''))
  }
  for (const p of noDir) console.log('! 缺目录：' + (p.entry.title || p.entry.sessionId))

  if (!WRITE) {
    console.log('\n这是 dry-run，没有改动任何文件。确认无误后加 --write 再跑一次。')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await fsp.mkdir(BACKUPS, { recursive: true })
  await fsp.copyFile(WORKSPACE, join(BACKUPS, 'workspace.json.pre-rollback-' + stamp))
  console.log('\n已备份 workspace.json -> backups/workspace.json.pre-rollback-' + stamp)

  let moved = 0
  let skipped = 0
  for (const p of willMove) {
    const target = p.entry.originalDir
    if (existsSync(target)) { skipped += 1; continue }
    const src = p.dirs[0]
    await fsp.mkdir(dirname(target), { recursive: true })
    try {
      await fsp.rename(src, target)
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        await fsp.cp(src, target, { recursive: true })
        await fsp.rm(src, { recursive: true, force: true })
      } else { console.error('搬移失败：' + src + ' -> ' + target + ' :: ' + e.message); skipped += 1; continue }
    }
    moved += 1
    const wsId = p.entry.workspaceId
    const ws = wsId && wsDoc.tables.workspaces[wsId] ? wsDoc.tables.workspaces[wsId] : null
    if (ws) {
      ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
      if (!ws.sessionIds.includes(p.entry.sessionId)) ws.sessionIds.push(p.entry.sessionId)
      ws.updatedAt = new Date().toISOString()
    }
    if (!KEEP) { try { await fsp.rm(src, { recursive: true, force: true }) } catch { /* 空壳删不掉无所谓 */ } }
  }

  for (const ws of Object.values(wsDoc.tables.workspaces)) {
    if (!Array.isArray(ws.sessionIds)) ws.sessionIds = []
    if (!ws.updatedAt || typeof ws.updatedAt !== 'string') ws.updatedAt = new Date().toISOString()
  }
  const tmp = WORKSPACE + '.tmp-rollback'
  await fsp.writeFile(tmp, JSON.stringify(wsDoc, null, 2), 'utf8')
  await fsp.rename(tmp, WORKSPACE)
  console.log('\n搬回 ' + moved + ' 个，跳过 ' + skipped + ' 个；workspace.json 已更新。')
  console.log('剩余条目仍在 ' + INDEX + '（脚本不删索引，确认无误后可以手动删除或整目录移走）。')
}

main().catch((e) => { console.error('ROLLBACK FAILED:', e); process.exit(2) })
