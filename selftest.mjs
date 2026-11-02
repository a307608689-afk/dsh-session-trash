// 自测：在真实会话根目录下造「假会话」，全程只走插件自己的 HTTP 接口。
// 假会话不写进 workspace.json，所以不会出现在侧栏，也不碰任何真实对话。
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BASE = process.env.TRASH_BASE || 'http://127.0.0.1:6133/dsh-session-trash'
// 工作区目录名由宿主按工作区路径生成（形如 --D-path-to-workspace--）。
// 没显式指定时自动取 sessions/ 下第一个非隐藏目录，避免把个人路径写死进仓库。
const WS_DIR = process.env.DSH_WS_DIR || (await fsp.readdir(join(HOME, 'sessions')).then((ds) => ds.find((d) => !d.startsWith('.')) || '').catch(() => ''))
if (!WS_DIR) {
  console.error('找不到会话目录：请设置 DSH_HOME 或 DSH_WS_DIR')
  process.exit(1)
}
const stamp = Date.now()
const mkSid = (n) => `session-selftest-${stamp}-${n}`
const dirOf = (sid) => join(HOME, 'sessions', WS_DIR, sid)

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return r.json()
}
const get = async (path) => (await fetch(BASE + path)).json()
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''))
  if (!cond) process.exitCode = 1
}
const make = async (sid) => {
  const dir = dirOf(sid)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('selftest-not-a-real-log'))
  return dir
}
const cleanup = async (sids) => {
  for (const sid of sids) {
    await fsp.rm(dirOf(sid), { recursive: true, force: true })
  }
}

const created = []
try {
  /* ── A. 单条全链路 ─────────────────────────────────────────────── */
  const sidA = mkSid('a')
  const dirA = await make(sidA)
  created.push(sidA)
  console.log('created', dirA)

  const a1 = await post('/analyze', { sessionId: sidA })
  ok('analyze: 找到目录', a1.ok === true && a1.dirFound === true, { dirFound: a1.dirFound, inWorkspace: a1.inWorkspace })
  ok('analyze: 未标记已删除', a1.trashed === false)

  const d1 = await post('/delete', { sessionId: sidA, title: '自测会话 A', releaseAttachments: true })
  ok('delete: 成功', d1.ok === true, d1.error)
  ok('delete: 目录已搬走', !(await fsp.stat(dirA).then(() => true).catch(() => false)))
  ok('delete: 记录了附件释放清单', Boolean(d1.entry && d1.entry.attachments) && Array.isArray(d1.entry.attachments.candidates) && Array.isArray(d1.entry.attachments.selected), d1.entry && d1.entry.attachments)

  const l1 = await get('/list')
  const e1 = (l1.entries || []).find((x) => x.sessionId === sidA)
  ok('list: 回收站里有这一条', Boolean(e1), e1 ? { daysLeft: e1.daysLeft, sizeMB: e1.sizeMB } : null)
  ok('list: 返回孤儿附件统计', Boolean(l1.orphan) && typeof l1.orphan.count === 'number', l1.orphan)

  const d2 = await post('/delete', { sessionId: sidA })
  ok('delete: 重复删除被拒', d2.ok === false && d2.code === 'ALREADY_TRASHED', d2.code)

  const r1 = await post('/restore', { trashId: e1.trashId })
  ok('restore: 成功', r1.ok === true, r1.error)
  ok('restore: 目录回到原位', await fsp.stat(dirA).then(() => true).catch(() => false))

  const d3 = await post('/delete', { sessionId: sidA, releaseAttachments: false })
  const l2 = await get('/list')
  const e2 = (l2.entries || []).find((x) => x.sessionId === sidA)
  ok('delete: 不勾附件时清单为空', d3.ok === true && (!d3.entry.attachments.shas || d3.entry.attachments.shas.length === 0), d3.entry && d3.entry.attachments)

  const p1 = await post('/purge', { trashId: e2.trashId })
  ok('purge: 成功', p1.ok === true, p1.error)
  ok('purge: 返回释放结果', Boolean(p1.release) && typeof p1.release.freedMB === 'number', p1.release)
  const l3 = await get('/list')
  ok('purge: 列表里没了', !(l3.entries || []).some((x) => x.sessionId === sidA))

  /* ── B. 保留期设置 ─────────────────────────────────────────────── */
  const c1 = await get('/config')
  ok('config: 能读到保留期', Array.isArray(c1.allowed) && c1.allowed.includes(30), { retentionDays: c1.retentionDays, allowed: c1.allowed })
  const c2 = await post('/config', { retentionDays: 90 })
  ok('config: 改成 90 天', c2.ok === true && c2.retentionDays === 90)
  const l4 = await get('/list')
  ok('config: list 跟随新保留期', l4.retentionDays === 90, l4.retentionDays)
  const c3 = await post('/config', { retentionDays: 5 })
  ok('config: 非法值被拒', c3.ok === false, c3.error)
  await post('/config', { retentionDays: 30 })

  /* ── C. 批量恢复 / 批量彻底删除 ─────────────────────────────────── */
  const sidB = mkSid('b')
  const sidC = mkSid('c')
  await make(sidB)
  await make(sidC)
  created.push(sidB, sidC)
  const dB = await post('/delete', { sessionId: sidB, title: '自测 B' })
  const dC = await post('/delete', { sessionId: sidC, title: '自测 C' })
  ok('batch: 两条都进了回收站', dB.ok === true && dC.ok === true)
  const rb = await post('/restore-batch', { trashIds: [dB.entry.trashId, dC.entry.trashId] })
  ok('batch: 批量恢复 2 条', rb.ok === true && rb.restored === 2, { restored: rb.restored, failed: rb.failed })
  ok('batch: 目录都回到原位', await fsp.stat(dirOf(sidB)).then(() => true).catch(() => false) && await fsp.stat(dirOf(sidC)).then(() => true).catch(() => false))

  const dB2 = await post('/delete', { sessionId: sidB })
  const dC2 = await post('/delete', { sessionId: sidC })
  const pb = await post('/purge-batch', { trashIds: [dB2.entry.trashId, dC2.entry.trashId] })
  ok('batch: 批量彻底删除 2 条', pb.ok === true && pb.purged === 2, { purged: pb.purged, freedMB: pb.freedMB })

  /* ── D. 延长保留 ───────────────────────────────────────────────── */
  const ex = await post('/extend', {})
  ok('extend: 调用成功', ex.ok === true && typeof ex.changed === 'number', { changed: ex.changed })
} finally {
  await cleanup(created)
  console.log('cleaned', created.map(dirOf).join(' | '))
}
