/**
 * 集成测试：跑在真实 DSH 实例上的假数据，结束时清理干净。
 * 用法：node test/integration.mjs [baseUrl]
 * 覆盖：锁冲突 / 并发删除 / 改保留期不影响旧条目 / archive.json 损坏隔离
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = (process.argv[2] || process.env.TRASH_BASE || 'http://127.0.0.1:45155/dsh-session-trash').replace(/\/$/, '')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const TRASH_DIR = join(HOME, 'session-trash')
const INDEX_PATH = join(TRASH_DIR, 'index.json')
const ARCHIVE_JSON = join(TRASH_DIR, 'archive.json')
const LOCK_DIR = join(TRASH_DIR, '.lock')
const SESSIONS_DIR = join(HOME, 'sessions')

const stamp = Date.now().toString(36)
const made = { dirs: [], trashIds: [], archives: [], lock: false }
let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('PASS', name, extra === undefined ? '' : ':: ' + JSON.stringify(extra)) }
  else { fail += 1; console.log('FAIL', name, extra === undefined ? '' : ':: ' + JSON.stringify(extra)) }
}
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) })
const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
})

async function makeSession(tag) {
  const sid = 'session-itest-' + tag + '-' + stamp
  const dir = join(SESSIONS_DIR, '--itest--', sid)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, 'session.v4.jsonl.zstd'), 'junk-' + tag)
  made.dirs.push(dir)
  return sid
}

async function readIndex() {
  return JSON.parse(await fsp.readFile(INDEX_PATH, 'utf8'))
}
async function listArchives() {
  const r = await j(await fetch(BASE + '/archive'))
  return (r.body && r.body.entries) || []
}
async function purgeArchives(ids) {
  if (!ids.length) return
  await post('/archive/purge', { archiveIds: ids })
}

async function cleanup() {
  try {
    if (made.lock) await fsp.rm(LOCK_DIR, { recursive: true, force: true })
    for (const dir of made.dirs) await fsp.rm(dir, { recursive: true, force: true })
    for (const id of made.trashIds) {
      try { await post('/purge', { trashId: id }) } catch { /* ignore */ }
    }
    await purgeArchives(made.archives)
    if (made.archiveBackup !== undefined) {
      if (made.archiveBackup === null) await fsp.rm(ARCHIVE_JSON, { force: true })
      else await fsp.writeFile(ARCHIVE_JSON, made.archiveBackup)
    }
    await fsp.rm(join(SESSIONS_DIR, '--itest--'), { recursive: true, force: true }).catch(() => {})
  } catch (e) {
    console.log('cleanup warning:', String(e && e.message))
  }
}

try {
  await fsp.mkdir(TRASH_DIR, { recursive: true })
  const archivesBefore = new Set((await listArchives()).map((e) => e.archiveId))

  // ── 1) 锁被占：删除返回 409 TRASH_BUSY ──
  const sidA = await makeSession('lock')
  await fsp.mkdir(LOCK_DIR, { recursive: true })
  made.lock = true
  await fsp.writeFile(join(LOCK_DIR, 'owner'), String(process.pid))
  const locked = await j(await post('/delete', { sessionId: sidA }))
  ok('锁被占 → 409 TRASH_BUSY', locked.status === 409 && locked.body && locked.body.code === 'TRASH_BUSY', locked.body)
  await fsp.rm(LOCK_DIR, { recursive: true, force: true })
  made.lock = false

  // ── 2) 两个并发删除：都成功，trashId 不重复 ──
  const sidB = await makeSession('par1')
  const sidC = await makeSession('par2')
  const [r1, r2] = await Promise.all([
    post('/delete', { sessionId: sidB }).then((r) => r.json()),
    post('/delete', { sessionId: sidC }).then((r) => r.json()),
  ])
  ok('并发删除都成功', r1.ok === true && r2.ok === true, { b: r1.ok, c: r2.ok })
  const idx2 = await readIndex()
  const mine = idx2.entries.filter((e) => String(e.sessionId).includes(stamp))
  const ids = mine.map((e) => e.trashId)
  made.trashIds.push(...ids)
  ok('索引里不重复', new Set(ids).size === ids.length, ids)
  const list2 = await j(await fetch(BASE + '/list'))
  const rows = (list2.body && list2.body.entries) || []
  ok('列表里能看到两条', ids.every((id) => rows.some((r) => r.trashId === id)), ids.length)

  // ── 3) 改保留期不改旧条目的 expiresAt ──
  const before = mine.map((e) => ({ id: e.trashId, exp: e.expiresAt }))
  await post('/config', { retentionDays: 90 })
  const idx3 = await readIndex()
  const after = before.map((b) => (idx3.entries.find((e) => e.trashId === b.id) || {}).expiresAt)
  ok('旧条目 expiresAt 不变', before.every((b, i) => after[i] === b.exp), before.length)
  const cfg = await j(await fetch(BASE + '/health'))
  ok('保留期已改 90', cfg.body && cfg.body.retentionDays === 90, cfg.body && cfg.body.retentionDays)
  await post('/config', { retentionDays: 30 })

  // ── 4) archive.json 损坏：隔离成 .corrupt-*，接口仍可用 ──
  let backup = null
  try { backup = await fsp.readFile(ARCHIVE_JSON, 'utf8') } catch { backup = null }
  made.archiveBackup = backup
  await fsp.writeFile(ARCHIVE_JSON, '{ this is not json')
  const arch = await j(await fetch(BASE + '/archive'))
  ok('archive 接口仍返回 200', arch.status === 200 && arch.body && arch.body.ok === true, arch.status)
  ok('损坏时按空档案处理', arch.body && Array.isArray(arch.body.entries), arch.body && arch.body.entries.length)
  const files = await fsp.readdir(TRASH_DIR)
  ok('损坏文件已隔离', files.some((f) => f.startsWith('archive.json.corrupt-')), files.filter((f) => f.includes('corrupt')))
  if (backup !== null) await fsp.writeFile(ARCHIVE_JSON, backup)
  else await fsp.rm(ARCHIVE_JSON, { force: true })
  for (const f of files.filter((x) => x.startsWith('archive.json.corrupt-'))) {
    await fsp.rm(join(TRASH_DIR, f), { force: true })
  }

  // 清理：purge 掉测试条目（会顺带生成 predelete 留档，再删掉）
  for (const id of made.trashIds.slice()) {
    await post('/purge', { trashId: id })
  }
  made.trashIds = []
  const archivesAfter = await listArchives()
  made.archives = archivesAfter.map((e) => e.archiveId).filter((id) => !archivesBefore.has(id))
  await purgeArchives(made.archives)
  made.archives = []
} catch (e) {
  console.log('ERROR', String(e && e.stack))
  fail += 1
} finally {
  await cleanup()
  console.log('\nSUMMARY', pass, 'PASS /', fail, 'FAIL')
  process.exit(fail ? 1 : 0)
}
