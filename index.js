/**
 * dsh-session-trash —— 宿主半端
 * ============================================================================
 * 做什么：
 *   1. 一个「删除会话」的真实实现：把会话目录搬进 ~/.dsh/session-trash/payload/，
 *      并从 ~/.dsh/storages/workspace.json 的三处名单里摘掉，回收站里能找回。
 *   2. 回收站存储：index.json（条目）、journal.jsonl（审计）、backups/（workspace.json 备份）。
 *   3. 给浏览器半端用的 HTTP 接口（同源，路径前缀 /dsh-session-trash）。
 *
 * 为什么自己搬目录：DSH 目前没有删除会话的 API，也没有回收站；会话＝
 * ~/.dsh/sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd，工作区归属记在
 * ~/.dsh/storages/workspace.json 的 tables.workspaces[*].sessionIds 里，
 * 另有 global.archivedSessionIds / global.pinnedSessionIds 两张名单。
 * 所以「删除」＝搬目录＋从这些名单里摘掉；「恢复」＝搬回来＋按原位插回。
 *
 * 求稳纪律（方案 §13）：
 *   · 不确定就停手：目录不存在、格式不认识、目标已存在 → 报错，不猜着改；
 *   · 只追加不重排：恢复时按记录的位置插回，不动别人的顺序；
 *   · 先回收站后销毁：删除一律先进回收站，彻底删除是另一个动作；
 *   · 一切可撤销：客户端撤销走 /restore（同一套逻辑）。
 */

import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, resolve, isAbsolute, sep } from 'node:path'
import { pathInside, safeJoinInside } from './lib/path-safety.mjs'
import { treeStats } from './lib/tree.mjs'

export const name = 'dsh-session-trash'
export const inject = ['webServer', 'sessions']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(HOME, 'sessions')
const WORKSPACE_JSON = join(HOME, 'storages', 'workspace.json')
const PROJCACHE_DIR = join(HOME, 'storages', 'session_projcache', 'sessions')

const TRASH_DIR = join(HOME, 'session-trash')
const PAYLOAD_DIR = join(TRASH_DIR, 'payload')
const BACKUP_DIR = join(TRASH_DIR, 'backups')
const INDEX_PATH = join(TRASH_DIR, 'index.json')
const JOURNAL_PATH = join(TRASH_DIR, 'journal.jsonl')
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024
const JOURNAL_KEEP = 5
const AUTO_PURGE_MINUTES_DEFAULT = 30

const DEFAULT_RETENTION_DAYS = 30
const ALLOWED_RETENTION_DAYS = [7, 30, 90]
const SESSION_FILE = 'session.v4.jsonl.zstd'
const ROUTE = '/dsh-session-trash'
const LAST_EXIT_PATH = join(TRASH_DIR, 'last-exit.json')

// ── 跨盘搬运校验（P0 修复，见方案 §19.2）─────────────────────────────
// 路径安全函数在 lib/path-safety.mjs，目录统计在 lib/tree.mjs（便于单测）。

async function copyThenVerify(src, dst) {
  await fsp.cp(src, dst, { recursive: true, force: false, errorOnExist: false })
  const a = await treeStats(src)
  const b = await treeStats(dst)
  if (a.files !== b.files || a.bytes !== b.bytes) {
    const err = new Error(
      '复制校验失败，源目录已保留：源 ' + a.files + ' 个文件/' + a.bytes +
      ' 字节，目标 ' + b.files + ' 个文件/' + b.bytes + ' 字节',
    )
    err.code = 'COPY_VERIFY_FAILED'
    throw err
  }
  return { files: a.files, bytes: a.bytes }
}


// ── 写入时拦截（M6）：进程内互斥 + 版本复核 ────────────────────────────
let opChain = Promise.resolve()

// 跨进程锁：用 mkdir 的原子性（EEXIST 即被占），持锁期间其它进程/实例的写操作排队。
// 30 秒没有释放视为残留锁，直接清掉（进程被杀不会留下永久死锁）。
const LOCK_DIR = join(TRASH_DIR, '.lock')
const LOCK_STALE_MS = 30000
const LOCK_WAIT_MS = 4000

async function acquireFsLock() {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await fsp.mkdir(LOCK_DIR)
      try { await fsp.writeFile(join(LOCK_DIR, 'owner'), String(process.pid), 'utf8') } catch { /* ignore */ }
      return true
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e
      try {
        const st = await fsp.stat(join(LOCK_DIR, 'owner')).catch(() => null)
        const at = st ? st.mtimeMs : (await fsp.stat(LOCK_DIR)).mtimeMs
        if (Date.now() - at > LOCK_STALE_MS) {
          await fsp.rm(LOCK_DIR, { recursive: true, force: true })
          continue
        }
      } catch { /* 锁刚释放 */ }
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 60))
    }
  }
}

async function releaseFsLock() {
  try { await fsp.rm(LOCK_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
}

function withOpLock(fn) {
  const run = opChain.then(async () => {
    const got = await acquireFsLock()
    if (!got) {
      // P2-4：等不到锁就明确失败，不能假装成功（静默降级会丢并发写）
      const e = new Error('另一个操作正在进行（可能是另一个窗口或后台任务），请等它完成后再试')
      e.code = 'TRASH_BUSY'
      throw e
    }
    try {
      return await fn()
    } finally {
      await releaseFsLock()
    }
  })
  opChain = run.then(() => undefined, () => undefined)
  return run
}
let wsStamp = null
async function workspaceStampNow() {
  try { const st = await fsp.stat(WORKSPACE_JSON); return st.mtimeMs + ':' + st.size } catch { return null }
}
function staleWorkspaceError() {
  const e = new Error('workspace.json 刚被其它程序改过，这次改动已放弃（没写任何东西），请刷新后重试')
  e.code = 'WORKSPACE_STALE'
  return e
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

async function readJournalTail(n) {
  const parseLines = (raw) => raw.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const out = []
  try { out.push(...parseLines(await fsp.readFile(JOURNAL_PATH, 'utf8'))) } catch { /* 没有当前文件 */ }
  if (out.length < n) {
    try {
      const files = (await fsp.readdir(TRASH_DIR)).filter((f) => /^journal-\d{8}-\d{6}(-\d{3})?\.jsonl$/.test(f)).sort().reverse()
      for (const f of files) {
        if (out.length >= n) break
        const older = parseLines(await fsp.readFile(join(TRASH_DIR, f), 'utf8'))
        out.unshift(...older)
      }
    } catch { /* ignore */ }
  }
  return out.slice(-n)
}

const log = (...a) => { try { console.log('[session-trash]', ...a) } catch { /* ignore */ } }

function nowIso() { return new Date().toISOString() }

// expiresAt 历史上有两种写法（毫秒数 / ISO 字符串），统一成毫秒
function expiresMs(value) {
  if (typeof value === 'number') return value
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : 0
}

async function ensureLayout() {
  for (const d of [TRASH_DIR, PAYLOAD_DIR, BACKUP_DIR]) {
    await fsp.mkdir(d, { recursive: true })
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fsp.readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 先写 .tmp 再 rename：中途崩了也不会留下半个 JSON。 */
async function writeJsonAtomic(path, value) {
  await fsp.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await fsp.rename(tmp, path)
}

/** workspace.json 里的时间字段必须是 ISO 字符串；历史上写成 Date.now() 数字会让 DSH 启动时
 *  反序列化失败（表现为工作区全空、workspace/create 报 workspaceController unavailable）。 */
function repairWorkspaceTimestamps(doc) {
  const tables = doc && doc.tables && doc.tables.workspaces
  if (!tables || typeof tables !== 'object') return 0
  let fixed = 0
  for (const ws of Object.values(tables)) {
    if (!ws || typeof ws !== 'object') continue
    for (const k of ['updatedAt', 'createdAt', 'lastUsedAt']) {
      const v = ws[k]
      if (typeof v === 'number' && Number.isFinite(v)) {
        ws[k] = new Date(v).toISOString()
        fixed++
      }
    }
  }
  return fixed
}

/** 写 workspace.json 统一入口：字段检查 + 版本复核 + 写后回读校验，不合法就抛。 */
async function writeWorkspaceDoc(doc, opts = {}) {
  const wrong = []
  for (const [id, ws] of Object.entries(doc.tables.workspaces)) {
    for (const k of ['updatedAt', 'createdAt', 'lastUsedAt']) {
      const v = ws && ws[k]
      if (v !== undefined && typeof v !== 'string') wrong.push(id.slice(0, 8) + '.' + k + '=' + typeof v)
    }
    if (typeof ws.path !== 'string' || !ws.path) wrong.push(id.slice(0, 8) + '.path')
    if (!Array.isArray(ws.sessionIds) || ws.sessionIds.some((x) => typeof x !== 'string')) wrong.push(id.slice(0, 8) + '.sessionIds')
  }
  if (wrong.length) throw new Error('workspace.json 字段不合法，拒绝写入：' + wrong.slice(0, 5).join(', '))
  const text = JSON.stringify(doc, null, 2) + '\n'
  const parsed = JSON.parse(text)
  if (!parsed.tables || !parsed.tables.workspaces || !parsed.unit) throw new Error('workspace.json 结构不完整，停手')
  if (!opts.force) {
    const cur = await workspaceStampNow()
    if (wsStamp && cur && cur !== wsStamp) throw staleWorkspaceError()
  }
  await writeJsonAtomic(WORKSPACE_JSON, doc)
  const back = JSON.parse(await fsp.readFile(WORKSPACE_JSON, 'utf8'))
  const a = Object.keys(parsed.tables.workspaces).sort().join()
  const b = Object.keys(back.tables.workspaces || {}).sort().join()
  if (a !== b) throw new Error('workspace.json 回读校验失败（工作区列表变了）')
  for (const [id, ws] of Object.entries(back.tables.workspaces)) {
    for (const k of ['updatedAt', 'createdAt', 'lastUsedAt']) {
      if (ws && ws[k] !== undefined && typeof ws[k] !== 'string') throw new Error('workspace.json 回读校验失败：' + id.slice(0, 8) + '.' + k + ' 不是 ISO 字符串')
    }
  }
  wsStamp = await workspaceStampNow()
}

async function workspaceHealth() {
  try {
    const doc = await readWorkspaceDoc()
    const all = Object.values(doc.tables.workspaces)
    let bad = 0
    for (const ws of all) {
      for (const k of ['updatedAt', 'createdAt', 'lastUsedAt']) {
        if (ws && ws[k] !== undefined && typeof ws[k] !== 'string') bad++
      }
    }
    // 名单和磁盘对不对得上：悬空 = 写了但目录不在；孤儿 = 目录在但没被任何工作区/归档/置顶引用
    const rows = await listSessionDirsCached().catch(() => [])
    const onDisk = new Set(rows.map((r) => r.sid))
    const declared = new Set()
    for (const ws of all) for (const s of ws.sessionIds || []) declared.add(s)
    for (const s of doc.global.archivedSessionIds || []) declared.add(s)
    for (const s of doc.global.pinnedSessionIds || []) declared.add(s)
    const dangling = [...declared].filter((s) => !onDisk.has(s))
    const orphan = [...onDisk].filter((s) => !declared.has(s))
    return {
      ok: bad === 0 && dangling.length === 0,
      workspaces: all.length,
      sessions: all.reduce((n, ws) => n + (Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0), 0),
      badTimestamps: bad,
      dangling: dangling.length,
      danglingIds: dangling.slice(0, 5),
      orphanDirs: orphan.length,
      dirsOnDisk: onDisk.size,
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

function journalStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`
}

// P2-3：超过 2MB 就轮转成 journal-<时间>.jsonl，只留最近 5 份
async function rotateJournalIfNeeded() {
  try {
    let st
    try { st = await fsp.stat(JOURNAL_PATH) } catch { return }
    if (!st || st.size < JOURNAL_MAX_BYTES) return
    const archived = join(TRASH_DIR, `journal-${journalStamp()}.jsonl`)
    await fsp.rename(JOURNAL_PATH, archived)
    const files = (await fsp.readdir(TRASH_DIR)).filter((f) => /^journal-\d{8}-\d{6}(-\d{3})?\.jsonl$/.test(f)).sort().reverse()
    for (const f of files.slice(JOURNAL_KEEP)) {
      await fsp.unlink(join(TRASH_DIR, f)).catch(() => {})
    }
    log('journal 已轮转 →', archived)
  } catch (e) {
    log('journal 轮转失败：', e && e.message)
  }
}

async function journal(event) {
  try {
    await fsp.mkdir(TRASH_DIR, { recursive: true })
    await fsp.appendFile(JOURNAL_PATH, JSON.stringify({ at: nowIso(), ...event }) + '\n', 'utf8')
  } catch (e) {
    log('journal 失败：', e && e.message)
  }
  rotateJournalIfNeeded().catch(() => {})
}

async function dirSizeMB(dir) {
  try {
    const st = await fsp.stat(join(dir, SESSION_FILE))
    return Math.round((st.size / 1024 / 1024) * 10) / 10
  } catch {
    try {
      let total = 0
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!e.isFile()) continue
        total += (await fsp.stat(join(dir, e.name))).size
      }
      return Math.round((total / 1024 / 1024) * 10) / 10
    } catch {
      return 0
    }
  }
}

/** 会话目录可能在一级（未分组）也可能在 sessions/<工作区>/<会话> 下。 */
async function listSessionDirs() {
  const out = []
  let level1 = []
  try {
    level1 = (await fsp.readdir(SESSIONS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const ws of level1) {
    const wsDir = join(SESSIONS_DIR, ws)
    if (existsSync(join(wsDir, SESSION_FILE))) {
      out.push({ ws: '', sid: ws, dir: wsDir })
      continue
    }
    let kids = []
    try {
      kids = (await fsp.readdir(wsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const sid of kids) {
      const dir = join(wsDir, sid)
      if (existsSync(join(dir, SESSION_FILE))) out.push({ ws, sid, dir })
    }
  }
  return out
}

let dirCache = { at: 0, rows: [] }
async function listSessionDirsCached() {
  const now = Date.now()
  if (dirCache.rows.length && now - dirCache.at < 5000) return dirCache.rows
  const rows = await listSessionDirs()
  dirCache = { at: now, rows }
  return rows
}

/** 会话头（日志第一帧的第一条记录）：用来找分叉关系与创建时间。带缓存。 */
const headerCache = new Map()
async function readHeader(sid, dir) {
  if (headerCache.has(sid)) return headerCache.get(sid)
  let header = null
  try {
    const buf = await fsp.readFile(join(dir, SESSION_FILE))
    const text = zstdDecompressSync(buf).toString('utf8')
    const first = text.split('\n').find((l) => l.trim())
    if (first) {
      const rec = JSON.parse(first)
      header = {
        id: String(rec.id || sid),
        createdAt: Number(rec.createdAt || 0),
        cwd: rec.cwd ? String(rec.cwd) : undefined,
        parentSession: rec.parentSession ? String(rec.parentSession) : undefined,
        origin: rec.origin ? String(rec.origin) : undefined,
        agentPreset: rec.agentPreset ? String(rec.agentPreset) : undefined,
      }
    }
  } catch { /* 读不出来就当没有头 */ }
  headerCache.set(sid, header)
  return header
}

/** 以 sid 为父的会话：分叉（普通）与子代理（origin === 'subagent'）。 */
async function childrenOf(sid) {
  const all = await listSessionDirsCached()
  const forks = []
  const subs = []
  const index = await readIndex()
  const trashed = new Set(index.entries.map((e) => e.sessionId))
  for (const row of all) {
    if (row.sid === sid) continue
    if (trashed.has(row.sid)) continue
    const head = await readHeader(row.sid, row.dir)
    if (!head || head.parentSession !== sid) continue
    const item = { sessionId: row.sid, title: titleOf(row.sid), createdAt: head.createdAt }
    if (head.origin === 'subagent') subs.push(item)
    else forks.push(item)
  }
  return { forks, subs }
}

/** 绑在这个会话上的定时提醒（有 schedule 服务才查；没有就当 0，不猜）。 */
async function remindersOf(ctx, sid) {
  try {
    const sched = ctx && ctx.get ? ctx.get('schedule') : undefined
    if (!sched || typeof sched.list !== 'function') return []
    const r = await sched.list()
    const rows = Array.isArray(r) ? r : Array.isArray(r && r.items) ? r.items : Array.isArray(r && r.records) ? r.records : []
    return rows
      .filter((x) => x && (x.sessionId === sid || x.session === sid || (x.target && x.target.sessionId === sid)))
      .map((x) => ({ title: String(x.title || x.name || x.prompt || '提醒'), at: x.nextRunAt || x.at || x.dueAt || null }))
  } catch {
    return []
  }
}

/** 团队身份：只有活着的会话能问；问不到就 checked:false，不猜。 */
async function teamOf(ctx, sid) {
  try {
    const teams = ctx && ctx.get ? ctx.get('agentTeams') : undefined
    const agents = ctx && ctx.get ? ctx.get('agents') : undefined
    if (!teams || typeof teams.tryMembership !== 'function' || !agents || typeof agents.get !== 'function') return { checked: false }
    const agent = agents.get(sid)
    if (!agent) return { checked: false }
    const m = teams.tryMembership(agent)
    if (!m) return { checked: true, inTeam: false }
    let members = 0
    try {
      const list = await teams.listMembers(agent)
      members = Array.isArray(list) ? list.length : 0
    } catch { /* 数不出来就只给角色 */ }
    return { checked: true, inTeam: true, role: m.role, name: String(m.name || ''), members }
  } catch {
    return { checked: false }
  }
}

/** 当前目标：只存在于会话日志里，只有活着的会话能通过 goals 服务读到。 */
async function goalOf(ctx, sid) {
  try {
    const goals = ctx && ctx.get ? ctx.get('goals') : undefined
    const agents = ctx && ctx.get ? ctx.get('agents') : undefined
    if (!goals || typeof goals.get !== 'function' || !agents || typeof agents.get !== 'function') return { checked: false }
    const agent = agents.get(sid)
    if (!agent) return { checked: false }
    const v = goals.get(agent)
    if (!v) return { checked: true, present: false }
    return {
      checked: true,
      present: true,
      phase: String(v.phase || ''),
      objective: String(v.objective || '').slice(0, 120),
      roundsStarted: Number(v.roundsStarted || 0),
    }
  } catch {
    return { checked: false }
  }
}

async function findSessionDir(sid) {
  const all = await listSessionDirs()
  return all.find((x) => x.sid === sid) || null
}

function titleOf(sid) {
  try {
    const raw = readFileSync(join(PROJCACHE_DIR, sid + '.json'), 'utf8')
    const rec = JSON.parse(raw)?.record?.rows || {}
    const t = String(rec?.title?.val || '').trim()
    return t || sid
  } catch {
    return sid
  }
}

async function readWorkspaceDoc() {
  const doc = await readJson(WORKSPACE_JSON, null)
  if (!doc || typeof doc !== 'object' || !doc.tables || typeof doc.tables.workspaces !== 'object') {
    throw new Error('workspace.json 不存在或结构不认识，停手（不猜着改）')
  }
  doc.global = doc.global || {}
  if (!Array.isArray(doc.global.archivedSessionIds)) doc.global.archivedSessionIds = []
  if (!Array.isArray(doc.global.pinnedSessionIds)) doc.global.pinnedSessionIds = []
  const fixed = repairWorkspaceTimestamps(doc)
  if (fixed > 0) {
    try {
      await backupWorkspace()
      await writeWorkspaceDoc(doc, { force: true })
      await journal({ action: 'workspace-repair', fixed, reason: '把数字时间戳转回 ISO 字符串' })
      log('workspace.json 时间戳已自动修复：' + fixed + ' 处')
    } catch (e) {
      log('workspace.json 时间戳自修复失败：', (e && e.message) || e)
    }
  }
  wsStamp = await workspaceStampNow()
  return doc
}

function workspaceOf(doc, sid) {
  for (const [id, ws] of Object.entries(doc.tables.workspaces)) {
    const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : []
    const index = ids.indexOf(sid)
    if (index >= 0) return { id, ws, index }
  }
  return null
}

async function backupWorkspace() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `workspace-${stamp}.json`
    await fsp.copyFile(WORKSPACE_JSON, join(BACKUP_DIR, name))
    // 只留最近 40 份：备份是防手滑用的，不是归档，越攒越多反而没人看
    try {
      const all = (await fsp.readdir(BACKUP_DIR))
        .filter((f) => /^workspace-.*\.json$/.test(f))
        .sort()
      for (const old of all.slice(0, Math.max(0, all.length - 40))) {
        await fsp.rm(join(BACKUP_DIR, old), { force: true })
      }
    } catch { /* 清理失败不影响主流程 */ }
    return name
  } catch {
    return null
  }
}

function daysLeft(expiresAt) {
  const ms = expiresMs(expiresAt) - Date.now()
  return Math.max(0, Math.ceil(ms / 86400000))
}


/** 当前保留期（存在 index.json 里，缺省 30 天）。 */
function retentionOf(index) {
  const n = Number(index && index.retentionDays)
  return ALLOWED_RETENTION_DAYS.includes(n) ? n : DEFAULT_RETENTION_DAYS
}

function objectPathOf(sha) {
  return join(ATT_OBJECTS_DIR, String(sha).slice(0, 2), String(sha))
}

/** 只被这个会话引用的附件 sha（完整列表，不截断）。 */
async function ownAttachmentShas(sid) {
  const map = await attachmentIndexFor(sid)
  const out = []
  for (const [sha, e] of map) {
    if (e.sessions.has(sid) && e.sessions.size <= 1) out.push({ sha, bytes: e.bytes || 0, name: e.name || '' })
  }
  return out
}

/** 附件明细：own = 只被这个会话引用（可释放），shared = 还被别的会话引用（必保留）。 */
async function attachmentsOfFull(sid) {
  const map = await attachmentIndexFor(sid)
  const own = []
  const shared = []
  let total = 0
  let totalBytes = 0
  for (const [sha, e] of map) {
    if (!e.sessions || !e.sessions.has(sid)) continue
    const item = { sha, bytes: e.bytes || 0, name: e.name || '', refCount: e.sessions.size }
    total += 1
    totalBytes += item.bytes
    if (item.refCount <= 1) own.push(item)
    else shared.push(item)
  }
  own.sort((a, b) => b.bytes - a.bytes)
  shared.sort((a, b) => b.bytes - a.bytes)
  const mb = (b) => Math.round((b / 1048576) * 10) / 10
  return {
    ok: true,
    total,
    totalMB: mb(totalBytes),
    own,
    ownMB: mb(own.reduce((a, b) => a + b.bytes, 0)),
    shared,
    sharedMB: mb(shared.reduce((a, b) => a + b.bytes, 0)),
  }
}

/** 回收站条目里「用户勾选要释放」的 sha；兼容旧条目（shas = 删除时全选）。 */
function selectedShasOf(entry) {
  const a = entry && entry.attachments
  if (!a) return []
  if (Array.isArray(a.selected)) return a.selected
  if (Array.isArray(a.shas)) return a.shas
  return []
}

/** 释放一批附件对象：仍然被别的会话引用的保留（求稳，不删）。 */
async function releaseAttachmentObjects(shas, ignoreSid) {
  if (!Array.isArray(shas) || !shas.length) return { freedMB: 0, freed: 0, kept: 0 }
  attIndex = { at: 0, map: null } // 先别用缓存，按现在的实际情况判断
  dirCache = { at: 0, rows: [] } // 目录缓存同样失效：新会话可能刚建好，别把它漏掉
  let map = null
  try { map = await attachmentIndex() } catch { map = null }
  let bytes = 0
  let freed = 0
  let kept = 0
  for (const sha of shas) {
    const hit = map ? map.get(sha) : null
    const others = hit ? [...hit.sessions].filter((s) => s !== ignoreSid) : []
    if (others.length) { kept += 1; continue }
    const file = objectPathOf(sha)
    try {
      const st = await fsp.stat(file)
      bytes += st.size
      await fsp.rm(file, { force: true })
      freed += 1
    } catch { /* 已经不在了就算了 */ }
  }
  return { freedMB: Math.round((bytes / 1048576) * 10) / 10, freed, kept }
}

/** 附件对象目录里已经没有任何会话引用的（孤儿）。 */
async function readIndex() {
  const doc = await readJson(INDEX_PATH, null)
  if (!doc || !Array.isArray(doc.entries)) return { version: 1, entries: [] }
  return doc
}

/* ── 附件引用索引（跨会话统计，用来判断「只被它使用」） ──────────────── */

const ATT_OBJECTS_DIR = join(HOME, 'attachments', 'v1', 'objects')
const attFileCache = new Map() // 日志路径 -> { mtimeMs, size, refs: [{ sha, bytes, name }] }
let attIndex = { at: 0, map: null }

const SHA_RE = /"attachmentId"\s*:\s*"sha256:([0-9a-f]{64})"/g

function refsFromLogText(text, sid) {
  const refs = []
  if (!text.includes('attachmentId')) return refs
  for (const line of text.split('\n')) {
    if (!line.includes('attachmentId')) continue
    SHA_RE.lastIndex = 0
    let m
    while ((m = SHA_RE.exec(line))) {
      const sha = m[1]
      const tail = line.slice(m.index, m.index + 500)
      const bytesM = /"bytes"\s*:\s*(\d+)/.exec(tail)
      const nameM = /"name"\s*:\s*"([^"]{0,160})"/.exec(tail)
      refs.push({ sha, bytes: bytesM ? Number(bytesM[1]) : 0, name: nameM ? nameM[1] : '', sid })
    }
  }
  return refs
}

async function refsOfSessionFile(row) {
  const file = join(row.dir, SESSION_FILE)
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const hit = attFileCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.refs
  let refs = []
  try {
    if (st.size <= 32 * 1024 * 1024) {
      const buf = await fsp.readFile(file)
      const frames = []
      let off = 0
      const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      while (off < buf.length) {
        const i = buf.indexOf(MAGIC, off)
        if (i < 0) break
        const n = buf.indexOf(MAGIC, i + 4)
        const end = n < 0 ? buf.length : n
        try { frames.push(zstdDecompressSync(buf.subarray(i, end))) } catch { /* 跳过坏帧 */ }
        off = end
      }
      const text = frames.length ? Buffer.concat(frames).toString('utf8') : zstdDecompressSync(buf).toString('utf8')
      refs = refsFromLogText(text, row.sid)
    }
  } catch { refs = [] }
  attFileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, refs })
  return refs
}

/** sha -> { bytes, name, sessions:Set } */
async function listTrashPayloadRows() {
  const out = []
  let kids = []
  try { kids = await fsp.readdir(PAYLOAD_DIR, { withFileTypes: true }) } catch { return out }
  for (const k of kids) {
    if (!k || !k.isDirectory()) continue
    const trashId = k.name
    const at = trashId.lastIndexOf('__')
    const sid = at > 0 ? trashId.slice(0, at) : trashId
    const dir = join(PAYLOAD_DIR, trashId)
    if (existsSync(join(dir, SESSION_FILE))) out.push({ ws: '', sid, dir, trashed: true })
  }
  return out
}

async function attachmentIndex() {
  const now = Date.now()
  if (attIndex.map && now - attIndex.at < 60000) return attIndex.map
  const rows = (await listSessionDirsCached()).concat(await listTrashPayloadRows())
  const map = new Map()
  for (const row of rows) {
    let refs = []
    try { refs = (await refsOfSessionFile(row)) || [] } catch { refs = [] }
    for (const r of refs) {
      let e = map.get(r.sha)
      if (!e) { e = { bytes: r.bytes, name: r.name, sessions: new Set() }; map.set(r.sha, e) }
      if (!e.bytes && r.bytes) e.bytes = r.bytes
      if (!e.name && r.name) e.name = r.name
      e.sessions.add(r.sid)
    }
  }
  attIndex = { at: now, map }
  return map
}

/** 刚建的会话可能还没进索引（索引有 60s 缓存）→ 查不到就强制重建一次，避免把附件算成 0。 */
const attNegative = new Map()
async function attachmentIndexFor(sid) {
  let map = await attachmentIndex()
  for (const e of map.values()) if (e.sessions.has(sid)) return map
  const last = attNegative.get(sid) || 0
  if (Date.now() - last < 60000) return map
  attIndex = { at: 0, map: null }
  dirCache = { at: 0, rows: [] } // 目录缓存也要一起失效，不然刚建的会话扫不到
  map = await attachmentIndex()
  let has = false
  for (const e of map.values()) if (e.sessions.has(sid)) { has = true; break }
  if (!has) attNegative.set(sid, Date.now())
  return map
}

async function attachmentsOf(sid) {
  const map = await attachmentIndexFor(sid)
  const mine = []
  for (const [sha, e] of map) {
    if (!e.sessions.has(sid)) continue
    mine.push({ sha, bytes: e.bytes || 0, name: e.name || '', refs: e.sessions.size })
  }
  const own = mine.filter((x) => x.refs <= 1)
  const shared = mine.filter((x) => x.refs > 1)
  const sum = (arr) => arr.reduce((a, b) => a + (b.bytes || 0), 0)
  const mb = (n) => Math.round((n / 1048576) * 10) / 10
  const items = (arr) => arr.slice(0, 5).map((x) => ({ name: x.name || (x.sha || '').slice(0, 12), sizeMB: mb(x.bytes), refs: x.refs }))
  return {
    total: mine.length,
    sizeMB: mb(sum(mine)),
    ownCount: own.length,
    ownSizeMB: mb(sum(own)),
    ownItems: items(own),
    sharedCount: shared.length,
    sharedSizeMB: mb(sum(shared)),
    sharedItems: items(shared),
  }
}

/** 附件对象目录里存在、但没有任何会话引用的（孤儿）。只统计，不删。 */
async function orphanAttachments(attMap) {
  let dirs = []
  try { dirs = await fsp.readdir(ATT_OBJECTS_DIR) } catch { return { count: 0, sizeMB: 0 } }
  let count = 0
  let bytes = 0
  for (const d of dirs) {
    let files = []
    try { files = await fsp.readdir(join(ATT_OBJECTS_DIR, d)) } catch { continue }
    for (const f of files) {
      if (!/^[0-9a-f]{64}$/.test(f)) continue
      if (attMap && attMap.has(f)) continue
      count += 1
      try { const st = await fsp.stat(join(ATT_OBJECTS_DIR, d, f)); bytes += st.size } catch { /* ignore */ }
    }
  }
  return { count, sizeMB: Math.round((bytes / 1048576) * 10) / 10 }
}

/* ── 核心动作 ─────────────────────────────────────────────────────────── */

async function analyze(sid) {
  await ensureLayout()
  const index = await readIndex()
  const entry = index.entries.find((e) => e.sessionId === sid) || null
  const found = await findSessionDir(sid)
  let wsInfo = null
  let archived = false
  let pinned = false
  try {
    const doc = await readWorkspaceDoc()
    wsInfo = workspaceOf(doc, sid)
    archived = doc.global.archivedSessionIds.includes(sid)
    pinned = doc.global.pinnedSessionIds.includes(sid)
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
  const { forks, subs } = await childrenOf(sid)
  const reminders = await remindersOf(ctxRef, sid)
  const team = await teamOf(ctxRef, sid)
  const goal = await goalOf(ctxRef, sid)

  return {
    ok: true,
    sessionId: sid,
    title: titleOf(sid),
    trashed: Boolean(entry),
    trashId: entry ? entry.trashId : null,
    dirFound: Boolean(found),
    workspaceDir: found ? found.ws : null,
    inWorkspace: Boolean(wsInfo),
    workspace: wsInfo ? { id: wsInfo.id, title: String(wsInfo.ws.title || '') } : null,
    order: wsInfo ? wsInfo.index : -1,
    archived,
    pinned,
    live: Boolean(ctxRef && ctxRef.sessions && ctxRef.sessions.get && ctxRef.sessions.get(sid)),
    sizeMB: found ? await dirSizeMB(found.dir) : 0,
    forks: { count: forks.length, items: forks.slice(0, 5) },
    subagents: { count: subs.length, items: subs.slice(0, 5) },
    reminders: { count: reminders.length, items: reminders.slice(0, 5) },
    team,
    goal,
    attachments: await (async () => {
      try { return await attachmentsOf(sid) } catch { return null }
    })(),
    retentionDays: retentionOf(index),
  }
}

/** ctx 在 apply 里赋值，供 analyze 判断「这个会话现在是不是活着」。 */
let ctxRef = null

async function moveSessionToTrash(sid, titleHint, withAttachments, groupTrashId, releaseShas) {
  await ensureLayout()
  const index = await readIndex()
  if (index.entries.some((e) => e.sessionId === sid)) {
    return { ok: false, code: 'ALREADY_TRASHED', error: '这个会话已经在回收站里了' }
  }
  const found = await findSessionDir(sid)
  if (!found) {
    return { ok: false, code: 'SESSION_DIR_NOT_FOUND', error: '找不到这个会话的目录（可能已经不在本地了）' }
  }
  const doc = await readWorkspaceDoc()
  const wsInfo = workspaceOf(doc, sid)
  const pinned = doc.global.pinnedSessionIds.includes(sid)
  const archived = doc.global.archivedSessionIds.includes(sid)

  // 候选附件必须在搬目录之前算：目录搬走之后，附件索引就扫不到这个会话了
  let attCandidates = []
  if (withAttachments || (Array.isArray(releaseShas) && releaseShas.length)) {
    try { attCandidates = await ownAttachmentShas(sid) } catch { attCandidates = [] }
  }

  const trashId = `${sid}__${Date.now()}`
  const payload = join(PAYLOAD_DIR, trashId)
  const backup = await backupWorkspace()

  // 1) 先搬目录（同盘 rename；跨盘才退化成复制）
  await fsp.mkdir(PAYLOAD_DIR, { recursive: true })
  try {
    await fsp.rename(found.dir, payload)
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await copyThenVerify(found.dir, payload)
      await fsp.rm(found.dir, { recursive: true, force: true })
    } else {
      return { ok: false, code: 'MOVE_FAILED', error: String(e && e.message) }
    }
  }

  dirCache = { at: 0, rows: [] } // 目录刚搬走，下一次查找要重新扫，别拿旧缓存

  // 2) 改 workspace.json（摘掉三处名单）
  try {
    if (wsInfo) wsInfo.ws.sessionIds = wsInfo.ws.sessionIds.filter((x) => x !== sid)
    doc.global.archivedSessionIds = doc.global.archivedSessionIds.filter((x) => x !== sid)
    doc.global.pinnedSessionIds = doc.global.pinnedSessionIds.filter((x) => x !== sid)
    await writeWorkspaceDoc(doc)
  } catch (e) {
    // 名单没改成 → 目录先搬回去，保持前后一致
    try { await fsp.rename(payload, found.dir) } catch { /* 记在 journal 里 */ }
    await journal({ action: 'delete', sid, ok: false, reason: 'workspace.json 写入失败', error: String(e && e.message) })
    return { ok: false, code: 'WORKSPACE_WRITE_FAILED', error: String(e && e.message) }
  }

  // 只有勾了「一并释放附件」或显式传了 sha 列表，才算候选；换句话说不勾就是一个附件都不动
  const candidates = attCandidates
  const candidateSet = new Set(candidates.map((x) => x.sha))
  let selected = []
  if (Array.isArray(releaseShas)) selected = releaseShas.map(String).filter((s) => candidateSet.has(s))
  else if (withAttachments) selected = candidates.map((x) => x.sha)
  const mbOf = (b) => Math.round((b / 1048576) * 10) / 10
  const ownBytes = candidates.reduce((a, b) => a + (b.bytes || 0), 0)
  const selectedBytes = candidates.filter((x) => selected.includes(x.sha)).reduce((a, b) => a + (b.bytes || 0), 0)
  attIndex = { at: 0, map: null } // 会话目录刚搬走，引用计数要重算

  const entry = {
    trashId,
    sessionId: sid,
    title: String(titleHint || titleOf(sid)),
    workspaceId: wsInfo ? wsInfo.id : null,
    workspaceTitle: wsInfo ? String(wsInfo.ws.title || '') : '',
    workspaceDir: found.ws,
    originalDir: found.dir,
    order: wsInfo ? wsInfo.index : -1,
    pinned,
    archived,
    group: groupTrashId || null,
    deletedAt: nowIso(),
    expiresAt: Date.now() + retentionOf(index) * 86400000,
    sizeMB: await dirSizeMB(payload),
    attachments: {
      count: candidates.length,
      sizeMB: mbOf(ownBytes),
      candidates: candidates.map((x) => ({ sha: x.sha, bytes: x.bytes || 0, name: x.name || '' })),
      selected,
      selectedCount: selected.length,
      selectedMB: mbOf(selectedBytes),
      snapshotAt: Date.now(),
    },
  }
  index.entries.push(entry)
  await writeJsonAtomic(INDEX_PATH, index)
  await journal({ action: 'delete', sid, trashId, workspaceBackup: backup, ok: true })
  return { ok: true, entry }
}

async function restoreFromTrash(trashId) {
  await ensureLayout()
  const index = await readIndex()
  const entry = index.entries.find((e) => e.trashId === trashId)
  if (!entry) return { ok: false, code: 'NOT_FOUND', error: '回收站里没有这一条' }
  const payload = join(PAYLOAD_DIR, trashId)
  if (!existsSync(payload)) return { ok: false, code: 'PAYLOAD_MISSING', error: '回收站里的文件不见了' }
  if (existsSync(entry.originalDir)) {
    return { ok: false, code: 'TARGET_EXISTS', error: '原来的位置已经有一个同名会话了，先处理它再恢复' }
  }
  if (!pathInside(SESSIONS_DIR, entry.originalDir)) {
    return { ok: false, code: 'BAD_ORIGINAL_DIR', error: '回收站条目记录的原始目录不在会话目录内，已拒绝恢复：' + String(entry.originalDir) }
  }
  await fsp.mkdir(dirname(entry.originalDir), { recursive: true })
  try {
    await fsp.rename(payload, entry.originalDir)
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await copyThenVerify(payload, entry.originalDir)
      await fsp.rm(payload, { recursive: true, force: true })
    } else {
      return { ok: false, code: 'MOVE_FAILED', error: String(e && e.message) }
    }
  }
  dirCache = { at: 0, rows: [] } // 目录刚搬回来，别让旧缓存漏掉它
  const doc = await readWorkspaceDoc()
  const ws = entry.workspaceId ? doc.tables.workspaces[entry.workspaceId] : null
  if (ws) {
    if (!Array.isArray(ws.sessionIds)) ws.sessionIds = []
    const at = Math.max(0, Math.min(entry.order >= 0 ? entry.order : ws.sessionIds.length, ws.sessionIds.length))
    ws.sessionIds.splice(at, 0, entry.sessionId)
  }
  if (entry.archived && !doc.global.archivedSessionIds.includes(entry.sessionId)) {
    doc.global.archivedSessionIds.push(entry.sessionId)
  }
  if (entry.pinned && !doc.global.pinnedSessionIds.includes(entry.sessionId)) {
    doc.global.pinnedSessionIds.push(entry.sessionId)
  }
  await writeWorkspaceDoc(doc)
  index.entries = index.entries.filter((e) => e.trashId !== trashId)
  await writeJsonAtomic(INDEX_PATH, index)
  await journal({ action: 'restore', sid: entry.sessionId, trashId, ok: true })
  return { ok: true, entry }
}

async function purgeOne(trashId) {
  await ensureLayout()
  const index = await readIndex()
  const entry = index.entries.find((e) => e.trashId === trashId)
  if (!entry) return { ok: false, code: 'NOT_FOUND', error: '回收站里没有这一条' }

  // 彻底删除不可逆：先留档，留档失败就不删（宁可删不掉，也不能删了没退路）。
  let snapshot = null
  try {
    const snap = await createPredeleteSnapshot(entry)
    if (!snap.ok) {
      return { ok: false, code: 'SNAPSHOT_FAILED', error: '彻底删除前的留档失败，已中止删除：' + (snap.error || snap.code || '未知原因') }
    }
    snapshot = snap.archiveId || null
  } catch (e) {
    return { ok: false, code: 'SNAPSHOT_FAILED', error: '彻底删除前的留档失败，已中止删除：' + String((e && e.message) || e) }
  }

  try {
    await fsp.rm(join(PAYLOAD_DIR, trashId), { recursive: true, force: true })
  } catch (e) {
    return { ok: false, code: 'PURGE_FAILED', error: String(e && e.message) }
  }
  let release = { freedMB: 0, freed: 0, kept: 0, keptBecause: [] }
  try {
    const wanted = selectedShasOf(entry)
    release = await releaseAttachmentObjects(wanted, entry.sessionId)
    if (wanted.length) {
      const map = await attachmentIndex().catch(() => null)
      release.keptBecause = wanted
        .filter((sha) => map && map.has(sha))
        .map((sha) => ({ sha, name: (map.get(sha) || {}).name || '', reason: '后来又被其他对话引用了，保留' }))
      release.requested = wanted.length
    }
  } catch { /* 附件释放失败不影响会话删除 */ }
  index.entries = index.entries.filter((e) => e.trashId !== trashId)
  await writeJsonAtomic(INDEX_PATH, index)
  await journal({ action: 'purge', sid: entry.sessionId, trashId, ok: true, release, archiveId: snapshot })
  return { ok: true, entry, release }
}

/** 到期自动清理：按保留期执行，但每次都落 journal。 */
async function purgeExpired() {
  const index = await readIndex()
  const dead = index.entries.filter((e) => expiresMs(e.expiresAt) <= Date.now())
  for (const e of dead) {
    try {
      await fsp.rm(join(PAYLOAD_DIR, e.trashId), { recursive: true, force: true })
      await releaseAttachmentObjects(selectedShasOf(e), e.sessionId)
      await journal({ action: 'auto-purge', sid: e.sessionId, trashId: e.trashId, ok: true })
    } catch (err) {
      await journal({ action: 'auto-purge', sid: e.sessionId, trashId: e.trashId, ok: false, error: String(err && err.message) })
    }
  }
  if (dead.length) {
    index.entries = index.entries.filter((e) => expiresMs(e.expiresAt) > Date.now())
    await writeJsonAtomic(INDEX_PATH, index)
  }
  return dead.length
}

/* ── P1-4 自动清理：每分钟看一眼，到点才真跑 ─────────────────────── */
let lastAutoPurge = { at: null, atMs: 0, purged: 0 }

async function autoPurgeTick() {
  let minutes = AUTO_PURGE_MINUTES_DEFAULT
  try { minutes = Number((await settingsOf()).autoPurgeMinutes) } catch { /* 默认 */ }
  if (!minutes || minutes <= 0) return 0
  if (Date.now() - lastAutoPurge.atMs < minutes * 60000) return 0
  const index = await readIndex().catch(() => null)
  if (!index) return 0
  const due = (index.entries || []).filter((e) => expiresMs(e.expiresAt) <= Date.now()).length
  if (!due) { lastAutoPurge.atMs = Date.now(); return 0 }
  const n = await withOpLock(() => purgeExpired()).catch((e) => {
    log('auto-purge 失败：', e && e.message)
    return 0
  })
  lastAutoPurge = { at: nowIso(), atMs: Date.now(), purged: n }
  if (n) await journal({ action: 'auto-purge-timer', purged: n, ok: true })
  return n
}

async function listTrash() {
  await ensureLayout()
  const purged = await purgeExpired().catch(() => 0)
  const index = await readIndex()
  const rows = index.entries
    .slice()
    .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
    .map((e) => ({
      ...e,
      daysLeft: daysLeft(e.expiresAt),
      soon: daysLeft(e.expiresAt) <= 3,
      payloadExists: existsSync(join(PAYLOAD_DIR, e.trashId)),
    }))
  let orphan = { count: 0, sizeMB: 0 }
  try {
    const map = await attachmentIndex()
    orphan = await orphanAttachments(map)
  } catch { /* 统计不出来就不显示 */ }
  return { entries: rows, purged, retentionDays: retentionOf(index), soonCount: rows.filter((r) => r.soon).length, orphan }
}


/** 孤儿会话目录：磁盘上有目录，但没被任何工作区 / 归档 / 置顶 / 回收站引用。 */
async function listOrphanDirs() {
  const doc = await readWorkspaceDoc()
  const declared = new Set()
  for (const ws of Object.values(doc.tables.workspaces || {})) {
    for (const s of ws.sessionIds || []) declared.add(String(s))
  }
  for (const s of doc.global.archivedSessionIds || []) declared.add(String(s))
  for (const s of doc.global.pinnedSessionIds || []) declared.add(String(s))
  const index = await readIndex()
  for (const e of index.entries) declared.add(String(e.sessionId))
  const rows = await listSessionDirs()
  const out = []
  for (const r of rows) {
    if (declared.has(String(r.sid))) continue
    let mtime = 0
    try { mtime = (await fsp.stat(join(r.dir, SESSION_FILE))).mtimeMs } catch { mtime = 0 }
    let sizeMB = 0
    try { sizeMB = await dirSizeMB(r.dir) } catch { sizeMB = 0 }
    out.push({
      sid: r.sid,
      dir: r.dir,
      title: String(titleOf(r.sid) || ''),
      sizeMB,
      mtime: Math.round(mtime),
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 把孤儿目录搬进回收站（可恢复：恢复时只搬回原目录，不动 workspace.json）。 */
async function moveOrphanToTrash(sids) {
  await ensureLayout()
  const wanted = new Set((Array.isArray(sids) ? sids : []).map(String).filter(Boolean))
  const index = await readIndex()
  const retention = retentionOf(index)
  const orphans = (await listOrphanDirs()).filter((o) => wanted.has(String(o.sid)))
  const moved = []
  const skipped = []
  for (const o of orphans) {
    const trashId = o.sid + '__' + Date.now()
    const payload = join(PAYLOAD_DIR, trashId)
    await fsp.mkdir(PAYLOAD_DIR, { recursive: true })
    try {
      await fsp.rename(o.dir, payload)
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        try {
          await copyThenVerify(o.dir, payload)
          await fsp.rm(o.dir, { recursive: true, force: true })
        } catch (e2) {
          skipped.push({ sid: o.sid, reason: String(e2 && e2.message) })
          continue
        }
      } else {
        skipped.push({ sid: o.sid, reason: String(e && e.message) })
        continue
      }
    }
    const sizeMB = await dirSizeMB(payload).catch(() => o.sizeMB || 0)
    const entry = {
      trashId,
      sessionId: o.sid,
      title: o.title || o.sid,
      workspaceId: null,
      workspaceTitle: '',
      workspaceDir: '',
      originalDir: o.dir,
      order: -1,
      pinned: false,
      archived: false,
      group: null,
      orphan: true,
      deletedAt: nowIso(),
      expiresAt: Date.now() + retention * 86400000,
      sizeMB,
      attachments: {
        count: 0, sizeMB: 0, candidates: [], selected: [],
        selectedCount: 0, selectedMB: 0, snapshotAt: Date.now(),
      },
    }
    index.entries.push(entry)
    moved.push(entry)
  }
  if (moved.length) {
    await writeJsonAtomic(INDEX_PATH, index)
    dirCache = { at: 0, rows: [] }
    attIndex = { at: 0, map: null }
    await journal({
      action: 'orphan-cleanup',
      ok: true,
      moved: moved.length,
      sids: moved.map((m) => m.sessionId).slice(0, 20),
    })
  }
  const freedMB = Math.round(moved.reduce((a, m) => a + (m.sizeMB || 0), 0) * 10) / 10
  return { ok: true, moved: moved.length, skipped, freedMB, entries: moved }
}

/* ── 文件留档（archive）：会话目录 / 元数据的快照 ────────────────────── */

const ARCHIVE_DIR = join(TRASH_DIR, 'archive')
const ARCHIVE_JSON = join(TRASH_DIR, 'archive.json')
const DEFAULT_ARCHIVE_MAX_MB = 2048

function archiveDefault() {
  return { version: 1, entries: [], limits: { maxMB: DEFAULT_ARCHIVE_MAX_MB }, updatedAt: nowIso() }
}

async function readArchiveDoc() {
  const doc = await readJson(ARCHIVE_JSON, null)
  if (!doc || typeof doc !== 'object') {
    // P2-1：archive.json 坏了就隔离到 .corrupt-<ts>，保留现场，别让下次写入直接覆盖
    try {
      await fsp.access(ARCHIVE_JSON)
      const bad = ARCHIVE_JSON + '.corrupt-' + Date.now()
      await fsp.rename(ARCHIVE_JSON, bad)
      log('archive.json 读不出来，已隔离到', bad)
      await journal({ action: 'archive-quarantine', path: bad, ok: true })
    } catch { /* 文件本来就不存在 */ }
    return archiveDefault()
  }
  if (!Array.isArray(doc.entries)) doc.entries = []
  if (!doc.limits || typeof doc.limits.maxMB !== 'number') doc.limits = { maxMB: DEFAULT_ARCHIVE_MAX_MB }
  if (!doc.version) doc.version = 1
  return doc
}

async function writeArchiveDoc(doc) {
  doc.updatedAt = nowIso()
  await writeJsonAtomic(ARCHIVE_JSON, doc)
}

function archiveMaxMB(doc) {
  const mb = doc && doc.limits && Number(doc.limits.maxMB)
  return Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_ARCHIVE_MAX_MB
}

function archiveTotalBytes(doc) {
  return (doc.entries || []).reduce((sum, e) => sum + (Number(e.bytes) || 0), 0)
}

function archiveDaysLeft(expiresAt) {
  if (!expiresAt) return null
  return Math.max(0, Math.ceil((expiresMs(expiresAt) - Date.now()) / 86400000))
}

async function walkFiles(root, rel, out) {
  let items = []
  try { items = await fsp.readdir(root, { withFileTypes: true }) } catch { return }
  for (const it of items) {
    const abs = join(root, it.name)
    const relPath = rel ? rel + "/" + it.name : it.name
    if (it.isDirectory()) { await walkFiles(abs, relPath, out); continue }
    if (!it.isFile()) continue
    try {
      const st = await fsp.stat(abs)
      out.push({ rel: relPath, abs, bytes: st.size })
    } catch { /* ignore */ }
  }
}

async function snapshotFilesFor(opts) {
  if (opts.scope === 'session') {
    const found = await findSessionDir(opts.sessionId)
    if (!found || !found.dir) return { ok: false, code: 'SESSION_NOT_FOUND', error: '要留档的会话目录不在了' }
    const files = []
    await walkFiles(found.dir, '', files)
    return { ok: true, dir: found.dir, files: files.map((f) => ({ path: f.rel, abs: f.abs, bytes: f.bytes })) }
  }
  const wanted = [
    { path: 'storages/workspace.json', abs: WORKSPACE_JSON },
    { path: 'session-trash/index.json', abs: INDEX_PATH },
    { path: 'session-trash/journal.jsonl', abs: JOURNAL_PATH },
    { path: 'session-trash/archive.json', abs: ARCHIVE_JSON },
  ]
  const files = []
  for (const w of wanted) {
    try {
      const st = await fsp.stat(w.abs)
      if (st.isFile()) files.push({ path: w.path, abs: w.abs, bytes: st.size })
    } catch { /* 文件不存在就跳过 */ }
  }
  return { ok: true, files }
}

async function createArchive(opts) {
  await ensureLayout()
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true })
  const doc = await readArchiveDoc()
  const picked = await snapshotFilesFor(opts)
  if (!picked.ok) return picked
  const parts = []
  let rawBytes = 0
  for (const f of picked.files) {
    const buf = await fsp.readFile(f.abs).catch(() => null)
    if (!buf) continue
    parts.push({ path: f.path, bytes: buf.length, data: buf.toString('base64') })
    rawBytes += buf.length
    if (rawBytes > 48 * 1024 * 1024) return { ok: false, code: 'ARCHIVE_TOO_BIG', error: '这次留档的内容超过 48MB，已放弃（避免把内存打满）' }
  }
  if (!parts.length) return { ok: false, code: 'ARCHIVE_EMPTY', error: '没有可留档的文件' }
  const payload = JSON.stringify({
    kind: opts.kind, reason: opts.reason || '', createdAt: nowIso(),
    sessionId: opts.sessionId || null, title: opts.title || null,
    files: parts,
  })
  const packed = zstdCompressSync(Buffer.from(payload, 'utf8'))
  const limitBytes = archiveMaxMB(doc) * 1024 * 1024
  if (archiveTotalBytes(doc) + packed.length > limitBytes) {
    await pruneArchives(doc, { forceFree: packed.length }).catch(() => null)
    const again = await readArchiveDoc()
    if (archiveTotalBytes(again) + packed.length > archiveMaxMB(again) * 1024 * 1024) {
      return { ok: false, code: 'ARCHIVE_QUOTA', error: '留档空间已满（上限 ' + archiveMaxMB(again) + 'MB），清理旧留档后再试' }
    }
  }
  const archiveId = (opts.kind === 'boot' ? 'boot' : 'predelete') + '-' + Date.now() + '-' + randomUUID().slice(0, 8)
  const file = join(ARCHIVE_DIR, archiveId + '.zst')
  await fsp.writeFile(file, packed)
  const retentionDays = retentionOf(await readIndex().catch(() => ({ entries: [] })))
  const entry = {
    archiveId, kind: opts.kind, reason: opts.reason || '',
    sessionId: opts.sessionId || null,
    workspaceId: opts.workspaceId || null,
    workspaceTitle: opts.workspaceTitle || '',
    title: opts.title || '',
    originalDir: picked.dir || null,
    files: parts.map((x) => ({ path: x.path, bytes: x.bytes })),
    rawBytes, bytes: packed.length, sha256: createHash('sha256').update(packed).digest('hex'),
    createdAt: nowIso(),
    expiresAt: Date.now() + retentionDays * 86400000,
  }
  const latest = await readArchiveDoc()
  latest.entries.push(entry)
  latest.limits.maxMB = archiveMaxMB(latest)
  await pruneArchives(latest, {})
  await journal({ action: 'archive-create', archiveId, kind: entry.kind, sid: entry.sessionId, bytes: entry.bytes, files: entry.files.length })
  return { ok: true, entry, archiveId }
}

/** 清过期 + 超限时从最旧的普通快照开始删（启动快照最后删）。 */
async function pruneArchives(doc, opts = {}) {
  const now = Date.now()
  const before = doc.entries.length
  const keep = []
  for (const e of doc.entries) {
    if (e.expiresAt && expiresMs(e.expiresAt) <= now) {
      await deleteArchiveFile(e)
      continue
    }
    keep.push(e)
  }
  doc.entries = keep
  const limitBytes = archiveMaxMB(doc) * 1024 * 1024
  const reserve = Number(opts.forceFree) || 0
  while (doc.entries.length && archiveTotalBytes(doc) + reserve > limitBytes) {
    const idx = doc.entries.findIndex((e) => e.kind !== 'boot')
    const i = idx >= 0 ? idx : 0
    const [gone] = doc.entries.splice(i, 1)
    if (gone) await deleteArchiveFile(gone)
  }
  await writeArchiveDoc(doc)
  return { removed: before - doc.entries.length }
}

async function deleteArchiveFile(entry) {
  try { await fsp.rm(join(ARCHIVE_DIR, entry.archiveId + '.zst'), { force: true }) } catch { /* ignore */ }
}

async function listArchives(query) {
  await ensureLayout()
  const doc = await readArchiveDoc()
  await pruneExpiredArchives().catch(() => 0)
  const fresh = await readArchiveDoc()
  const q = String((query && query.query) || '').trim().toLowerCase()
  const kind = String((query && query.kind) || '').trim()
  const rows = fresh.entries
    .filter((e) => (!kind || kind === 'all' ? true : e.kind === kind))
    .filter((e) => (!q ? true : (String(e.title || '') + ' ' + String(e.sessionId || '') + ' ' + String(e.reason || '')).toLowerCase().includes(q)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((e) => ({ ...e, daysLeft: archiveDaysLeft(e.expiresAt), sizeMB: Math.round((Number(e.bytes) || 0) / 1048576 * 100) / 100 }))
  return { entries: rows, totalMB: Math.round(archiveTotalBytes(fresh) / 1048576 * 100) / 100, maxMB: archiveMaxMB(fresh) }
}

async function readArchivePayload(archiveId) {
  const doc = await readArchiveDoc()
  const entry = doc.entries.find((e) => e.archiveId === archiveId)
  if (!entry) return { ok: false, code: 'NOT_FOUND', error: '没有这条留档' }
  try {
    const buf = await fsp.readFile(join(ARCHIVE_DIR, archiveId + '.zst'))
    const verify = createHash('sha256').update(buf).digest('hex')
    if (entry.sha256 && verify !== entry.sha256) return { ok: false, code: 'ARCHIVE_CORRUPT', error: '留档文件校验和不一致，可能已损坏' }
    const payload = JSON.parse(zstdDecompressFirstFrame(buf).toString('utf8'))
    return { ok: true, entry, payload }
  } catch (e) {
    return { ok: false, code: 'ARCHIVE_CORRUPT', error: '留档读不出来：' + String((e && e.message) || e) }
  }
}

function zstdDecompressFirstFrame(buf) {
  return zstdDecompressSync(buf)
}

async function restoreArchive(archiveId, targetWorkspaceId) {
  const read = await readArchivePayload(archiveId)
  if (!read.ok) return read
  const { entry, payload } = read
  if (entry.kind === 'boot') return { ok: false, code: 'BOOT_NOT_RESTORABLE', error: '启动留档只用来下载/查看，不能还原（它存的是元数据）' }
  if (!entry.originalDir) return { ok: false, code: 'NO_DIR', error: '这条留档没记录原始目录，无法还原' }
  // P0-1：归档包与 archive.json 都是磁盘上的普通文件，可能被改；先证明目标在会话目录内
  if (!pathInside(SESSIONS_DIR, entry.originalDir)) {
    return { ok: false, code: 'BAD_ORIGINAL_DIR', error: '留档记录的原始目录不在会话目录内，已拒绝还原：' + String(entry.originalDir) }
  }
  if (existsSync(join(entry.originalDir, SESSION_FILE))) return { ok: false, code: 'TARGET_EXISTS', error: '原目录已经有会话了，为避免覆盖，已拒绝还原' }
  // 先校验全部相对路径，一条不合法就整体拒绝（避免写了一半）
  const targets = []
  for (const f of payload.files || []) {
    const sj = safeJoinInside(entry.originalDir, f.path)
    if (!sj.ok) return { ok: false, code: 'BAD_ARCHIVE_PATH', error: '留档包里有非法路径，已拒绝还原：' + String(f.path) }
    targets.push({ dest: sj.dest, data: f.data })
  }
  if (!targets.length) return { ok: false, code: 'EMPTY_ARCHIVE', error: '留档包里没有文件，已拒绝还原' }
  await fsp.mkdir(entry.originalDir, { recursive: true })
  for (const tg of targets) {
    await fsp.mkdir(dirname(tg.dest), { recursive: true })
    await fsp.writeFile(tg.dest, Buffer.from(tg.data, 'base64'))
  }
  let pulled = false
  if (targetWorkspaceId || entry.workspaceId) {
    try {
      const doc = await readWorkspaceDoc()
      const wsId = targetWorkspaceId || entry.workspaceId
      const ws = doc.tables.workspaces[wsId]
      if (ws) {
        ws.sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
        if (!ws.sessionIds.includes(entry.sessionId)) ws.sessionIds.push(entry.sessionId)
        ws.updatedAt = new Date().toISOString()
        await writeWorkspaceDoc(doc)
        pulled = true
      }
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'RESTORE_WORKSPACE_FAILED', error: '文件已还原，但写回工作区名单失败：' + String((e && e.message) || e) }
    }
  }
  await journal({ action: 'archive-restore', archiveId, sid: entry.sessionId, inWorkspace: pulled })
  return { ok: true, sessionId: entry.sessionId, dir: entry.originalDir, inWorkspace: pulled }
}

async function purgeArchives(ids) {
  const doc = await readArchiveDoc()
  const wanted = new Set((ids || []).map(String))
  const keep = []
  let purged = 0
  let freed = 0
  for (const e of doc.entries) {
    if (wanted.has(e.archiveId)) {
      await deleteArchiveFile(e)
      purged += 1
      freed += Number(e.bytes) || 0
    } else keep.push(e)
  }
  doc.entries = keep
  await writeArchiveDoc(doc)
  if (purged) await journal({ action: 'archive-purge', purged, freedMB: Math.round(freed / 1048576 * 100) / 100 })
  return { ok: true, purged, freedMB: Math.round(freed / 1048576 * 100) / 100 }
}

async function pruneExpiredArchives() {
  const doc = await readArchiveDoc()
  const now = Date.now()
  const keep = []
  let purged = 0
  let freed = 0
  for (const e of doc.entries) {
    if (expiresMs(e.expiresAt) <= now) { await deleteArchiveFile(e); purged += 1; freed += Number(e.bytes) || 0 }
    else keep.push(e)
  }
  if (purged) { doc.entries = keep; await writeArchiveDoc(doc); await journal({ action: 'archive-expired', purged, freedMB: Math.round(freed / 1048576 * 100) / 100 }) }
  return purged
}

/** 彻底删除前留档：失败就让调用方中止删除。 */
async function createPredeleteSnapshot(entry) {
  if (!entry || !entry.sessionId) return { ok: false, error: '没有 sessionId' }
  const dirOk = existsSync(join(PAYLOAD_DIR, entry.trashId))
  if (!dirOk) return { ok: false, error: '回收站里这条的目录已经不见了' }
  const payload = await collectPayloadFiles(entry.trashId)
  if (!payload.ok) return payload
  return createArchive({
    kind: 'predelete',
    reason: 'purge:' + (entry.workspaceTitle || ''),
    sessionId: entry.sessionId,
    workspaceId: entry.workspaceId || null,
    workspaceTitle: entry.workspaceTitle || '',
    title: entry.title || entry.sessionId,
    scope: 'dir',
    dir: join(PAYLOAD_DIR, entry.trashId),
  })
}

async function collectPayloadFiles(trashId) {
  const dir = join(PAYLOAD_DIR, trashId)
  const files = []
  await walkFiles(dir, '', files)
  if (!files.length) return { ok: false, error: '目录里没有文件' }
  return { ok: true, files: files.map((f) => ({ path: f.rel, abs: f.abs, bytes: f.bytes })) }
}

async function bootArchiveSnapshot() {
  try {
    const settings = await settingsOf()
    if (settings.bootSnapshot === false) return
    const doc = await readArchiveDoc()
    const day = new Date().toISOString().slice(0, 10)
    const hasToday = doc.entries.some((e) => e.kind === 'boot' && String(e.createdAt).slice(0, 10) === day)
    if (hasToday) return
    const r = await createArchive({ kind: 'boot', reason: 'startup', scope: 'metadata' })
    if (!r.ok) await journal({ action: 'archive-boot-failed', error: r.error || r.code })
  } catch (e) {
    log('boot snapshot failed:', e && e.message)
  }
}

async function archiveStats() {
  try {
    const doc = await readArchiveDoc()
    return { count: doc.entries.length, totalMB: Math.round(archiveTotalBytes(doc) / 1048576 * 100) / 100, maxMB: archiveMaxMB(doc) }
  } catch { return { count: 0, totalMB: 0, maxMB: DEFAULT_ARCHIVE_MAX_MB } }
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */

// ── 崩溃自愈（M6）：把回收站 index 与 payload 目录对齐 ───────────────────
async function reconcileTrash() {
  await ensureLayout()
  const report = { added: 0, dropped: 0, broken: 0, recovered: [], repaired: [] }
  const index = await readIndex()
  let dirs = []
  try { dirs = await fsp.readdir(PAYLOAD_DIR) } catch { dirs = [] }
  const payloadSet = new Set(dirs.filter((d) => !d.startsWith('.')))
  const known = new Set(index.entries.map((e) => e.trashId))
  const doc = await readWorkspaceDoc().catch(() => null)
  for (const name of payloadSet) {
    if (known.has(name)) continue
    const m = /^(.*)__(\d{10,})$/.exec(name)
    if (!m) continue
    const sid = m[1]
    const ts = Number(m[2])
    const where = doc ? workspaceOf(doc, sid) : null
    const wsPath = where ? String(where.ws.path || '') : ''
    const dirName = wsPath ? await workspaceDirNameFor(wsPath) : ''
    index.entries.push({
      trashId: name,
      sessionId: sid,
      title: titleOf(sid),
      workspaceId: where ? where.id : null,
      workspaceTitle: where ? String(where.ws.title || '') : '',
      workspaceDir: wsPath,
      originalDir: join(SESSIONS_DIR, dirName, sid),
      order: where ? where.index : -1,
      pinned: false,
      archived: false,
      group: null,
      deletedAt: new Date(ts).toISOString(),
      expiresAt: ts + retentionOf(index) * 86400000,
      sizeMB: await dirSizeMB(join(PAYLOAD_DIR, name)),
      attachments: null,
      recovered: true,
    })
    report.added += 1
    report.recovered.push(sid)
  }
  const keep = []
  for (const e of index.entries) {
    if (payloadSet.has(e.trashId)) { keep.push(e); continue }
    if (e.originalDir && existsSync(e.originalDir)) { report.dropped += 1; report.repaired.push(e.sessionId); continue }
    if (!e.broken) { e.broken = 'payload-missing'; report.broken += 1 }
    keep.push(e)
  }
  index.entries = keep
  await writeJsonAtomic(INDEX_PATH, index)
  if (report.added || report.dropped || report.broken) {
    await journal({ action: 'reconcile', added: report.added, dropped: report.dropped, broken: report.broken })
  }
  return report
}

async function settingsOf() {
  const index = await readIndex().catch(() => ({ entries: [], settings: {} }))
  const s = (index && index.settings) || {}
  return {
    exitCheck: s.exitCheck !== false,
    diagnostics: s.diagnostics === true,
    bootSnapshot: s.bootSnapshot !== false,
    archiveBeforeDelete: s.archiveBeforeDelete !== false,
    autoPurgeMinutes: (() => {
      const raw = Number(s.autoPurgeMinutes)
      if (raw === 0) return 0
      if (Number.isFinite(raw) && raw >= 5 && raw <= 1440) return Math.round(raw)
      return AUTO_PURGE_MINUTES_DEFAULT
    })(),
    retentionDays: retentionOf(index),
  }
}

// ── 退出自检（M6）：只读体检，结果写 last-exit.json ──────────────────────
async function precheckRun() {
  const issues = []
  const health = await workspaceHealth()
  if (health.error) issues.push({ level: 'bad', text: 'workspace.json 读不出来：' + health.error })
  if (health.badTimestamps) issues.push({ level: 'bad', text: 'workspace.json 有 ' + health.badTimestamps + ' 个时间字段不是 ISO 字符串（重启后可能导致工作区全空）' })
  if (health.dangling) issues.push({ level: 'warn', text: '有 ' + health.dangling + ' 个会话登记在名单里、磁盘上却找不到' })
  const index = await readIndex().catch(() => ({ entries: [] }))
  let broken = 0
  for (const e of index.entries) {
    if (e.broken) { broken += 1; continue }
    if (!existsSync(join(PAYLOAD_DIR, e.trashId))) broken += 1
  }
  if (broken) issues.push({ level: 'bad', text: '回收站有 ' + broken + ' 条记录的目录不见了' })
  if (health.orphanDirs) issues.push({ level: 'info', text: '有 ' + health.orphanDirs + ' 个会话目录不属于任何工作区（可在回收站页清理）' })
  const ok = !issues.some((x) => x.level === 'bad')
  const result = {
    checkedAt: nowIso(),
    ok,
    problems: issues,
    workspace: { ok: health.ok, badTimestamps: health.badTimestamps || 0, dangling: health.dangling || 0, orphanDirs: health.orphanDirs || 0 },
    trash: { count: index.entries.length, broken },
  }
  await fsp.mkdir(TRASH_DIR, { recursive: true })
  await writeJsonAtomic(LAST_EXIT_PATH, result)
  await journal({ action: 'precheck', ok, problems: issues.filter((x) => x.level !== 'info').length })
  return result
}

/** 修复：reconcile + 把已经在回收站里的会话从 workspace.json 名单里摘掉。 */
async function repairWorkspaceLists() {
  const report = await reconcileTrash()
  const index = await readIndex()
  const trashIds = new Set(index.entries.map((e) => e.sessionId))
  const doc = await readWorkspaceDoc()
  let pulled = 0
  for (const ws of Object.values(doc.tables.workspaces)) {
    const before = Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0
    ws.sessionIds = (ws.sessionIds || []).filter((sid) => !trashIds.has(sid))
    pulled += before - ws.sessionIds.length
  }
  const a0 = doc.global.archivedSessionIds.length
  doc.global.archivedSessionIds = doc.global.archivedSessionIds.filter((sid) => !trashIds.has(sid))
  const p0 = doc.global.pinnedSessionIds.length
  doc.global.pinnedSessionIds = doc.global.pinnedSessionIds.filter((sid) => !trashIds.has(sid))
  pulled += (a0 - doc.global.archivedSessionIds.length) + (p0 - doc.global.pinnedSessionIds.length)
  if (pulled) {
    await backupWorkspace()
    await writeWorkspaceDoc(doc, { force: true })
    await journal({ action: 'repair', pulled, added: report.added, dropped: report.dropped, broken: report.broken })
  }
  return { ok: true, reconcile: report, pulledFromWorkspace: pulled }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > limit) raw = raw.slice(0, limit) })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

/** 连带删除：先删主会话，再逐个删分叉；任何一个失败就整体撤回。 */

/* ── 导出 / 导入（M4） ───────────────────────────────────────────────── */

const EXPORT_KIND = 'dsh-session-export'
const EXPORT_SCHEMA = 2
const MAX_IMPORT_BYTES = 24 * 1024 * 1024
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志是多帧 zstd；按 magic 切片，逐帧解压后拼起来。 */
function readLogText(file) {
  const buf = readFileSync(file)
  const parts = []
  let i = 0
  while (i < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, i)
    if (start < 0) break
    const next = buf.indexOf(ZSTD_MAGIC, start + 4)
    const end = next < 0 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      // 坏帧就停在最后一帧，不猜后面的内容
      break
    }
    i = end
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 读出 header 与事件（不含 header 本身）。 */
function readLog(dir) {
  const text = readLogText(join(dir, SESSION_FILE))
  const lines = text.split('\n').filter(Boolean)
  let header = null
  const events = []
  for (const line of lines) {
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (!header && obj && obj.type === 'session') { header = obj; continue }
    if (obj && obj.type) events.push(obj)
  }
  return { header, events }
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const eventFingerprint = (ev) => sha1(JSON.stringify([ev.type, ev.time, ev.data]))
const isChatEvent = (ev) => ev.type === 'user/message' || ev.type === 'assistant/message'

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') out.push(part.text)
    else if (part.type === 'image') out.push('[图片]')
    else if (part.type === 'reasoning') continue
  }
  return out.join('\n').trim()
}

function titleOfEvents(events, fallback) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev.type === 'session/title' && ev.data && ev.data.title) return String(ev.data.title)
  }
  return fallback
}

function renderMarkdown(header, title, events) {
  const lines = ['# ' + title, '']
  lines.push('- 会话 ID：' + header.id)
  lines.push('- 导出时间：' + nowIso())
  lines.push('- 消息条数：' + events.filter(isChatEvent).length)
  lines.push('')
  for (const ev of events) {
    if (!isChatEvent(ev)) continue
    const role = ev.type === 'user/message' ? '你' : 'AI'
    const when = ev.time ? new Date(ev.time).toLocaleString('zh-CN', { hour12: false }) : ''
    lines.push('## ' + role + (when ? ' · ' + when : ''))
    lines.push('')
    const body = textOfContent(ev.data && ev.data.content)
    lines.push(body || '（无文字内容）')
    lines.push('')
  }
  return lines.join('\n')
}

async function exportSessionData(sid) {
  const found = await findSessionDir(sid)
  if (!found || !found.dir) return { ok: false, code: 'NOT_FOUND', error: '找不到这个会话的目录' }
  const { header, events } = readLog(found.dir)
  const title = titleOfEvents(events, '') || titleOf(sid) || sid
  const messages = events.filter(isChatEvent).length
  const payload = {
    kind: EXPORT_KIND,
    schemaVersion: EXPORT_SCHEMA,
    exportedAt: nowIso(),
    session: {
      id: sid,
      title,
      cwd: (header && header.cwd) || (found.row && found.row.cwd) || '',
      createdAt: (header && header.createdAt) || null,
      agentPreset: (header && header.agentPreset) || '',
    },
    messages,
    events,
  }
  const safe = String(title || sid).replace(/[\\/:*?"<>|\n\r\t]/g, '-').slice(0, 80) || sid
  return {
    ok: true,
    title,
    messages,
    md: renderMarkdown(header || { id: sid }, title, events),
    json: JSON.stringify(payload),
    suggestedName: safe,
  }
}

function parseExport(text) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, code: 'EMPTY', error: '文件是空的' }
  if (body.length > MAX_IMPORT_BYTES) return { ok: false, code: 'TOO_BIG', error: '文件太大（上限 24 MB）' }
  let obj
  try { obj = JSON.parse(body) } catch { return { ok: false, code: 'BAD_JSON', error: '这不是本插件导出的 JSON 文件' } }
  if (!obj || obj.kind !== EXPORT_KIND) return { ok: false, code: 'BAD_KIND', error: '文件类型不认识（缺 kind=dsh-session-export）' }
  const schema = Number(obj.schemaVersion || 0)
  if (schema > EXPORT_SCHEMA) return { ok: false, code: 'SCHEMA_TOO_NEW', error: '这份文件来自更新版本的插件（v' + schema + '），当前只支持到 v' + EXPORT_SCHEMA }
  const session = obj.session || {}
  const events = Array.isArray(obj.events) ? obj.events.filter((e) => e && typeof e === 'object' && e.type) : []
  if (!session.id) return { ok: false, code: 'NO_SESSION_ID', error: '文件里没有会话 ID' }
  return {
    ok: true,
    schemaVersion: schema,
    session: { id: String(session.id), title: String(session.title || session.id), cwd: String(session.cwd || '') },
    events,
    messages: events.filter(isChatEvent).length,
  }
}

/** 这份文件现在落在哪：已在列表 / 在回收站 / 全新。 */
async function importSeat(parsed) {
  const sid = parsed.session.id
  const trash = await readIndex()
  const trashed = trash.entries.find((e) => e.sessionId === sid)
  if (trashed) return { kind: 'trash', sessionId: sid, trashId: trashed.trashId, title: trashed.title, daysLeft: daysLeft(trashed.expiresAt) }
  const doc = await readWorkspaceDoc()
  if (doc) {
    for (const [id, ws] of Object.entries(doc.tables.workspaces || {})) {
      if ((ws.sessionIds || []).includes(sid)) {
        return {
          kind: 'list',
          sessionId: sid,
          workspaceId: id,
          workspaceTitle: String(ws.title || ''),
          title: titleOf(sid) || parsed.session.title,
        }
      }
    }
  }
  return { kind: 'new', sessionId: sid, title: parsed.session.title }
}

async function workspaceForImport(cwd) {
  const doc = await readWorkspaceDoc()
  if (!doc) return null
  const workspaces = doc.tables.workspaces || {}
  const ids = doc.global.workspaceIds || []
  let pick = null
  for (const id of ids) {
    const ws = workspaces[id]
    if (!ws) continue
    if (cwd && ws.path && String(ws.path).toLowerCase() === String(cwd).toLowerCase()) { pick = { id, ws }; break }
  }
  if (!pick) {
    const first = ids.map((id) => ({ id, ws: workspaces[id] })).find((x) => x.ws)
    if (first) pick = first
  }
  if (!pick) return null
  return { doc, workspaceId: pick.id, ws: pick.ws }
}

function newSessionId() { return 'session-' + randomUUID() }

/** 把事件按 seq 重新编号（保留时间），header 换成新的。 */
function buildLogText(header, events, startSeq = 0) {
  const lines = [JSON.stringify(header)]
  let seq = startSeq
  for (const ev of events) {
    const copy = { ...ev, seq: (seq += 1) }
    lines.push(JSON.stringify(copy))
  }
  return lines.join('\n') + '\n'
}

async function writeSessionDir(sid, cwd, text) {
  const wsDir = await workspaceDirNameFor(cwd)
  const dir = join(SESSIONS_DIR, wsDir, sid)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, SESSION_FILE), zstdCompressSync(Buffer.from(text, 'utf8')))
  return dir
}

/** 会话落在 sessions/ 下的哪一级目录：优先用「当前工作区」的目录名。 */
function dirNameForPath(cwd) {
  const norm = (p) => String(p).replace(/[:\\/]+/g, '-').replace(/\s+/g, ' ').replace(/^-+|-+$/g, '').toLowerCase()
  return norm(cwd)
}

async function workspaceDirNameFor(cwd) {
  const dirs = await fsp.readdir(SESSIONS_DIR).catch(() => [])
  if (cwd && dirs.length) {
    const target = dirNameForPath(cwd)
    for (const d of dirs) {
      const decoded = d.replace(/^--|--$/g, '').replace(/~([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      if (dirNameForPath(decoded) === target) return d
    }
    const guess = '--' + target.replace(/\s+/g, '~0020') + '--'
    if (dirs.includes(guess)) return guess
  }
  const withDash = dirs.find((d) => d.startsWith('--D-'))
  return withDash || dirs[0] || '--default--'
}


async function importAsNew(parsed, { copyTitle } = {}) {
  const events = parsed.events
  const sid = newSessionId()
  const title = (copyTitle ? parsed.session.title + '（导入）' : parsed.session.title) || sid
  const header = {
    type: 'session', version: 4, id: sid, createdAt: Date.now(),
    cwd: parsed.session.cwd || '', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  }
  const hasTitle = events.some((ev) => ev.type === 'session/title')
  const withTitle = hasTitle ? events : events.concat([{ type: 'session/title', seq: 0, time: Date.now(), data: { title } }])
  const dir = await writeSessionDir(sid, header.cwd, buildLogText(header, withTitle))
  const pick = await workspaceForImport(header.cwd)
  if (pick) {
    await backupWorkspace()
    pick.ws.sessionIds = Array.isArray(pick.ws.sessionIds) ? pick.ws.sessionIds : []
    if (!pick.ws.sessionIds.includes(sid)) pick.ws.sessionIds.push(sid)
    // 必须是 ISO 字符串：DSH 的 workspace 存储按字符串校验时间字段，
    // 写成 Date.now() 数字会让整份 workspace.json 反序列化失败（表现为工作区全空、
    // workspace/create 报 workspaceController unavailable），且只有重启才暴露。
    pick.ws.updatedAt = new Date().toISOString()
    await writeWorkspaceDoc(pick.doc)
  }
  return { ok: true, sessionId: sid, title, dir, added: events.filter(isChatEvent).length, workspaceId: pick ? pick.workspaceId : null }
}

async function importMerge(parsed, targetSid) {
  const found = await findSessionDir(targetSid)
  if (!found || !found.dir) return { ok: false, code: 'TARGET_NOT_FOUND', error: '要合并的目标会话不在了' }
  // 会话正在生成时日志会被持续追加，合并写入会和它抢同一个文件 → 直接拒绝，让用户稍后再试。
  try {
    const st = await fsp.stat(join(found.dir, SESSION_FILE))
    if (Date.now() - st.mtimeMs < 15000) {
      return { ok: false, code: 'TARGET_BUSY', error: '这个对话刚刚还在写入（可能在生成回答），等它停下来再合并' }
    }
  } catch { /* 没有日志就交给后面报错 */ }

  const target = readLog(found.dir)
  const known = new Set(target.events.map(eventFingerprint))
  const incoming = parsed.events.filter((ev) => !known.has(eventFingerprint(ev)))
  if (!incoming.length) return { ok: true, sessionId: targetSid, added: 0, skipped: parsed.events.length }
  const maxSeq = target.events.reduce((m, ev) => Math.max(m, Number(ev.seq) || 0), 0)
  const backup = join(found.dir, SESSION_FILE + '.bak-' + Date.now())
  await fsp.copyFile(join(found.dir, SESSION_FILE), backup)
  const header = target.header || { type: 'session', version: 4, id: targetSid, createdAt: Date.now() }
  const text = buildLogText(header, target.events.concat(incoming), 0).replace(/\n$/, '\n')
  await fsp.writeFile(join(found.dir, SESSION_FILE), zstdCompressSync(Buffer.from(text, 'utf8')))

  // 写完回读：帧坏了就立刻用备份还原，别让坏日志留在那儿。
  try {
    const back = readLog(found.dir)
    const expect = target.events.length + incoming.length
    if (!back || !Array.isArray(back.events) || back.events.length < expect) throw new Error('readback short')
  } catch {
    try { await fsp.copyFile(backup, join(found.dir, SESSION_FILE)) } catch { /* ignore */ }
    return { ok: false, code: 'MERGE_VERIFY_FAILED', error: '写入后回读校验失败，已从备份恢复原日志' }
  }
  return { ok: true, sessionId: targetSid, added: incoming.filter(isChatEvent).length, appended: incoming.length, skipped: parsed.events.length - incoming.length, backup }
}

async function importRestoreThenMerge(parsed) {
  const index = await readIndex()
  const entry = index.entries.find((e) => e.sessionId === parsed.session.id)
  if (!entry) return { ok: false, code: 'NOT_IN_TRASH', error: '回收站里也没有这个会话' }
  const r = await restoreGroup(entry.trashId)
  if (!r.ok) return r
  const merged = await importMerge(parsed, parsed.session.id)
  return { ok: true, mode: 'restore', sessionId: parsed.session.id, restored: true, added: merged.added || 0, skipped: merged.skipped || 0 }
}

async function deleteWithForks(sid, title, withAttachments, releaseShas) {
  const main = await moveSessionToTrash(sid, title, withAttachments, null, releaseShas)
  if (!main.ok) return main
  const { forks } = await childrenOf(sid)
  const moved = []
  for (const f of forks) {
    const r = await moveSessionToTrash(f.sessionId, f.title, false, main.entry.trashId)
    if (!r.ok) {
      for (const old of moved.slice().reverse()) { try { await restoreFromTrash(old) } catch { /* ignore */ } }
      try { await restoreFromTrash(main.entry.trashId) } catch { /* ignore */ }
      return { ok: false, code: 'FORK_DELETE_FAILED', error: '分叉里有删不掉的，已经整体撤回：' + String(r.error || '') }
    }
    moved.push(r.entry.trashId)
  }
  if (moved.length) {
    const index = await readIndex()
    const e = index.entries.find((x) => x.trashId === main.entry.trashId)
    if (e) e.withForks = moved.length
    await writeJsonAtomic(INDEX_PATH, index)
    main.entry.withForks = moved.length
  }
  return main
}

/** 恢复一条：如果是带分叉删除的，把分叉也一起恢复。 */
async function restoreGroup(trashId) {
  const main = await restoreFromTrash(trashId)
  if (!main.ok) return main
  const index = await readIndex()
  const kids = index.entries.filter((e) => e.group === trashId)
  let restoredForks = 0
  for (const k of kids) {
    try {
      const r = await restoreFromTrash(k.trashId)
      if (r.ok) restoredForks += 1
    } catch { /* 单条失败不影响主条目已恢复 */ }
  }
  return { ...main, restoredForks }
}

/** 彻底删除一条：连带同组的分叉与附件释放。 */
async function purgeGroup(trashId) {
  const index = await readIndex()
  const ids = [trashId].concat(index.entries.filter((e) => e.group === trashId).map((e) => e.trashId))
  let purged = 0
  let freedMB = 0
  let freed = 0
  let kept = 0
  const keptBecause = []
  for (const id of ids) {
    const r = await purgeOne(id)
    if (r.ok) {
      purged += 1
      const rel = r.release || {}
      freedMB += Number(rel.freedMB || 0)
      freed += Number(rel.freed || 0)
      kept += Number(rel.kept || 0)
      if (Array.isArray(rel.keptBecause)) keptBecause.push(...rel.keptBecause)
    }
  }
  freedMB = Math.round(freedMB * 10) / 10
  return { ok: purged > 0, purged, release: { freedMB, freed, kept, keptBecause } }
}

export function apply(ctx) {
  ctxRef = ctx
  // 启动体检：workspace.json 结构/时间戳不对就修，避免下次重启时工作区全空
  workspaceHealth().then((h) => {
    if (!h.ok) log('workspace.json 体检异常：', JSON.stringify(h))
  }).catch(() => {})
  // 空闲时先把附件引用索引建好，第一次打开删除确认框就不用等
  setTimeout(() => { attachmentIndex().catch(() => {}) }, 4000)
  // P1-4：启动后先清一次，之后每分钟看一眼（默认 30 分钟一次；0 关闭）
  setTimeout(() => { autoPurgeTick().catch(() => {}) }, 6000)
  const purgeTimer = setInterval(() => { autoPurgeTick().catch(() => {}) }, 60000)
  if (purgeTimer.unref) purgeTimer.unref()
  ctx.effect(() => () => { clearInterval(purgeTimer) })

  const route = (path, handler, mutating) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE + path,
    handler: async (req, res) => {
      try {
        await (mutating ? withOpLock(() => handler(req, res)) : handler(req, res))
      } catch (e) {
        const code = (e && e.code) || null
        const status = code === 'WORKSPACE_STALE' ? 409
          : code === 'TRASH_BUSY' ? 409
          : code === 'COPY_VERIFY_FAILED' ? 500
          : 500
        if (code) log('route error', req.method, req.url, code, String((e && e.message) || e))
        sendJson(res, status, { ok: false, error: String((e && e.message) || e), code })
      }
    },
  }))
  // 会改数据（目录/名单）的接口统一排进同一个写锁，避免并发丢更新
  const routeM = (path, handler) => route(path, handler, true)

  // P2-5：一键诊断包——把排障需要的几样打成一个 JSON 给用户复制/发给别人
  route('/diagnostics', async (req, res) => {
    try {
      await ensureLayout()
      const index = await readIndex()
      const archDoc = await readArchiveDoc()
      const lastExit = await readJson(LAST_EXIT_PATH, null)
      const ws = await workspaceHealth()
      const journalTail = await readJournalTail(200)
      sendJson(res, 200, {
        ok: true,
        generatedAt: nowIso(),
        plugin: { name: 'dsh-session-trash', version: '0.1.7' },
        home: HOME,
        settings: await settingsOf(),
        workspace: ws,
        trash: {
          retentionDays: retentionOf(index),
          count: (index.entries || []).length,
          entries: (index.entries || []).map((e) => ({
            trashId: e.trashId, sessionId: e.sessionId, title: e.title,
            workspaceId: e.workspaceId, orphan: !!e.orphan, deletedAt: e.deletedAt,
            expiresAt: e.expiresAt, withForks: e.withForks || 0,
            attachments: e.attachments ? { count: e.attachments.count, selectedCount: e.attachments.selectedCount } : null,
          })),
        },
        archive: {
          count: (archDoc.entries || []).length,
          totalMB: Number((archiveTotalBytes(archDoc) / 1048576).toFixed(2)),
          maxMB: archiveMaxMB(archDoc),
          entries: (archDoc.entries || []).map((e) => ({
            archiveId: e.archiveId, kind: e.kind, reason: e.reason, sessionId: e.sessionId,
            bytes: e.bytes, createdAt: e.createdAt, expiresAt: e.expiresAt, broken: e.broken || null,
          })),
        },
        lastExit,
        journalTail,
        note: '这是只读诊断信息，可直接发给帮忙排查的人；里面不含对话正文。',
      })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  })

  route('/health', async (req, res) => {
    await ensureLayout()
    const index = await readIndex()
    const settings = await settingsOf()
    const lastExit = await readJson(LAST_EXIT_PATH, null)
    sendJson(res, 200, {
      ok: true,
      version: '0.1.7',
      home: HOME,
      retentionDays: retentionOf(index),
      count: index.entries.length,
      settings,
      precheck: lastExit ? { checkedAt: lastExit.checkedAt, ok: lastExit.ok, problems: (lastExit.problems || []).length } : null,
      workspace: await workspaceHealth(),
      archive: await archiveStats(),
      autoPurge: { minutes: settings.autoPurgeMinutes, lastAt: lastAutoPurge.at, lastPurged: lastAutoPurge.purged },
    })
  })

  route('/list', async (req, res) => {
    const data = await listTrash()
    sendJson(res, 200, { ok: true, ...data })
  })

  route('/analyze', async (req, res) => {
    const body = await readBody(req)
    const sid = String(body.sessionId || '').trim()
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺 sessionId' })
    sendJson(res, 200, await analyze(sid))
  })

  route('/attachments', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const body = req.method === 'POST' ? await readBody(req) : {}
    const sid = String(body.sessionId || url.searchParams.get('sessionId') || '').trim()
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺 sessionId' })
    sendJson(res, 200, await attachmentsOfFull(sid))
  })

  routeM('/delete', async (req, res) => {
    const body = await readBody(req)
    const sid = String(body.sessionId || '').trim()
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺 sessionId' })
    const wantForks = body.includeForks === true
    if (wantForks) {
      const team = await teamOf(ctxRef, sid)
      if (team.inTeam) {
        const label = team.role === 'lead' ? '队长会话' : '团队会话'
        return sendJson(res, 409, { ok: false, code: 'TEAM_NO_CASCADE', error: '这是' + label + '，不支持连带删除分叉；请先单独处理分叉对话' })
      }
    }
    const releaseShas = Array.isArray(body.releaseShas)
      ? body.releaseShas.map(String).filter(Boolean).slice(0, 20000)
      : null
    const r = wantForks
      ? await deleteWithForks(sid, body.title, body.releaseAttachments === true, releaseShas)
      : await moveSessionToTrash(sid, body.title, body.releaseAttachments === true, null, releaseShas)
    if (r.ok && Array.isArray(releaseShas)) {
      const chosen = new Set((r.entry && r.entry.attachments && r.entry.attachments.selected) || [])
      r.ignored = releaseShas.filter((s) => !chosen.has(s))
    }
    sendJson(res, r.ok ? 200 : 409, r)
  })

  routeM('/restore', async (req, res) => {
    const body = await readBody(req)
    const trashId = String(body.trashId || '').trim()
    if (!trashId) return sendJson(res, 400, { ok: false, error: '缺 trashId' })
    const r = await restoreGroup(trashId)
    sendJson(res, r.ok ? 200 : 409, r)
  })

  routeM('/purge', async (req, res) => {
    const body = await readBody(req)
    const trashId = String(body.trashId || '').trim()
    if (!trashId) return sendJson(res, 400, { ok: false, error: '缺 trashId' })
    const r = await purgeGroup(trashId)
    sendJson(res, r.ok ? 200 : 409, r)
  })

  routeM('/config', async (req, res) => {
    await ensureLayout()
    const index = await readIndex()
    const body = await readBody(req)
    index.settings = Object.assign({ exitCheck: true, diagnostics: false }, index.settings || {})
    let changed = false
    const next = Number(body.retentionDays)
    if (next) {
      if (!ALLOWED_RETENTION_DAYS.includes(next)) {
        return sendJson(res, 400, { ok: false, error: '保留期只能是 7 / 30 / 90 天' })
      }
      index.retentionDays = next
      changed = true
    }
    if (typeof body.exitCheck === 'boolean') { index.settings.exitCheck = body.exitCheck; changed = true }
    if (typeof body.diagnostics === 'boolean') { index.settings.diagnostics = body.diagnostics; changed = true }
    if (body.autoPurgeMinutes !== undefined) {
      const m = Number(body.autoPurgeMinutes)
      if (!(m === 0 || (Number.isFinite(m) && m >= 5 && m <= 1440))) {
        return sendJson(res, 400, { ok: false, error: '自动清理间隔只能是 0（关闭）或 5–1440 分钟' })
      }
      index.settings.autoPurgeMinutes = Math.round(m)
      changed = true
    }
    if (changed) {
      await writeJsonAtomic(INDEX_PATH, index)
      await journal({ action: 'config', retentionDays: retentionOf(index), exitCheck: index.settings.exitCheck, diagnostics: index.settings.diagnostics, autoPurgeMinutes: index.settings.autoPurgeMinutes, ok: true })
    }
    sendJson(res, 200, { ok: true, retentionDays: retentionOf(index), allowed: ALLOWED_RETENTION_DAYS, settings: index.settings })
  })

  // 延长保留：给「即将清理」的条目重新计时
  routeM('/extend', async (req, res) => {
    await ensureLayout()
    const body = await readBody(req)
    const index = await readIndex()
    const retention = retentionOf(index)
    const ids = Array.isArray(body.trashIds) && body.trashIds.length
      ? body.trashIds.map(String)
      : index.entries.filter((e) => expiresMs(e.expiresAt) - Date.now() <= 3 * 86400000).map((e) => e.trashId)
    const until = Date.now() + retention * 86400000
    let changed = 0
    for (const e of index.entries) {
      if (!ids.includes(e.trashId)) continue
      e.expiresAt = until
      changed += 1
    }
    await writeJsonAtomic(INDEX_PATH, index)
    await journal({ action: 'extend', count: changed, retentionDays: retention, ok: true })
    sendJson(res, 200, { ok: true, changed, retentionDays: retention })
  })

  routeM('/restore-batch', async (req, res) => {
    const body = await readBody(req)
    const ids = Array.isArray(body.trashIds) ? body.trashIds.map(String) : []
    if (!ids.length) return sendJson(res, 400, { ok: false, error: '没选要恢复的对话' })
    const results = []
    for (const id of ids) {
      const r = await restoreFromTrash(id).catch((e) => ({ ok: false, error: String(e && e.message) }))
      results.push({ trashId: id, ok: r.ok, error: r.error || null })
    }
    const restored = results.filter((r) => r.ok).length
    sendJson(res, 200, { ok: true, restored, failed: results.length - restored, results })
  })

  routeM('/purge-batch', async (req, res) => {
    const body = await readBody(req)
    const ids = Array.isArray(body.trashIds) ? body.trashIds.map(String) : []
    if (!ids.length) return sendJson(res, 400, { ok: false, error: '没选要彻底删除的对话' })
    const results = []
    let freedMB = 0
    for (const id of ids) {
      const r = await purgeOne(id).catch((e) => ({ ok: false, error: String(e && e.message) }))
      if (r.ok) freedMB += (r.release && r.release.freedMB) || 0
      results.push({ trashId: id, ok: r.ok, error: r.error || null })
    }
    sendJson(res, 200, { ok: true, purged: results.filter((r) => r.ok).length, freedMB: Math.round(freedMB * 10) / 10, results })
  })

  // 孤儿附件：对象目录里已经没有任何会话引用的。只统计 / 可选清理，默认不删。
  routeM('/orphans', async (req, res) => {
    const body = await readBody(req)
    const map = await attachmentIndex()
    const stat = await orphanAttachments(map)
    if (body.clean !== true) return sendJson(res, 200, { ok: true, ...stat, cleaned: false })
    attIndex = { at: 0, map: null }
    const fresh = await attachmentIndex()
    let freed = 0
    let bytes = 0
    let dirs = []
    try { dirs = await fsp.readdir(ATT_OBJECTS_DIR) } catch { dirs = [] }
    for (const d of dirs) {
      let files = []
      try { files = await fsp.readdir(join(ATT_OBJECTS_DIR, d)) } catch { continue }
      for (const f of files) {
        if (!/^[0-9a-f]{64}$/.test(f)) continue
        if (fresh.has(f)) continue
        try {
          const st = await fsp.stat(join(ATT_OBJECTS_DIR, d, f))
          bytes += st.size
          await fsp.rm(join(ATT_OBJECTS_DIR, d, f), { force: true })
          freed += 1
        } catch { /* ignore */ }
      }
    }
    await journal({ action: 'purge-orphans', freed, freedMB: Math.round((bytes / 1048576) * 10) / 10, ok: true })
    sendJson(res, 200, { ok: true, ...stat, cleaned: true, freed, freedMB: Math.round((bytes / 1048576) * 10) / 10 })
  })

  // 退出自检：GET 读上次结果与设置；POST 立刻体检（只读，不碰数据）
  route('/precheck', async (req, res) => {
    const settings = await settingsOf()
    if (req.method !== 'POST') {
      const last = await readJson(LAST_EXIT_PATH, null)
      return sendJson(res, 200, { ok: true, enabled: settings.exitCheck, settings, last })
    }
    if (!settings.exitCheck) return sendJson(res, 200, { ok: true, enabled: false, skipped: true })
    const r = await precheckRun()
    sendJson(res, 200, { ok: true, enabled: true, ...r })
  })

  // 崩溃自愈 + 名单对齐（用户点「修复」时调用）
  routeM('/repair', async (req, res) => {
    const r = await repairWorkspaceLists()
    sendJson(res, 200, r)
  })

  // 导出：把一段对话导成 .md（人看）或 .json（可再导入）

  routeM('/orphan-dirs', async (req, res) => {
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const r = await moveOrphanToTrash(body && body.sids)
        return sendJson(res, 200, r)
      }
      const items = await listOrphanDirs()
      const sizeMB = Math.round(items.reduce((a, it) => a + (it.sizeMB || 0), 0) * 10) / 10
      return sendJson(res, 200, { ok: true, count: items.length, sizeMB, items })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e && e.message) })
    }
  })

  route('/archive', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const body = req.method === 'POST' ? await readBody(req) : {}
    const data = await listArchives({ query: body.query || url.searchParams.get('query') || '', kind: body.kind || url.searchParams.get('kind') || 'all' })
    sendJson(res, 200, { ok: true, ...data })
  })

  routeM('/archive/snapshot', async (req, res) => {
    const body = await readBody(req)
    const scope = String(body.scope || 'metadata')
    const sid = String(body.sessionId || '').trim()
    const r = scope === 'session'
      ? await createArchive({ kind: 'predelete', reason: 'manual', scope: 'session', sessionId: sid, title: body.title || '', workspaceId: body.workspaceId || null, workspaceTitle: body.workspaceTitle || '' })
      : await createArchive({ kind: 'boot', reason: 'manual', scope: 'metadata' })
    sendJson(res, r.ok ? 200 : 409, r)
  })

  route('/archive/download', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const archiveId = String(url.searchParams.get('archiveId') || '')
    const doc = await readArchiveDoc()
    const entry = doc.entries.find((e) => e.archiveId === archiveId)
    if (!entry) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '没有这条留档' })
    const file = join(ARCHIVE_DIR, archiveId + '.zst')
    if (!existsSync(file)) return sendJson(res, 404, { ok: false, code: 'FILE_MISSING', error: '留档文件不在了' })
    const safe = String(entry.title || entry.archiveId).replace(/[\\\\/:*?"<>|\\n\\r\\t]/g, '-').slice(0, 80)
    const buf = await fsp.readFile(file)
    res.writeHead(200, {
      'content-type': 'application/zstd',
      'content-disposition': 'attachment; filename="' + encodeURIComponent(safe + '.zst') + '"',
      'content-length': String(buf.length),
    })
    res.end(buf)
  })

  route('/archive/peek', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const archiveId = String(url.searchParams.get('archiveId') || '')
    const r = await readArchivePayload(archiveId)
    if (!r.ok) return sendJson(res, 404, r)
    const { entry, payload } = r
    sendJson(res, 200, { ok: true, entry: { ...entry, files: undefined }, files: (payload.files || []).map((f) => ({ path: f.path, bytes: f.bytes })) })
  })

  routeM('/archive/restore', async (req, res) => {
    const body = await readBody(req)
    const r = await restoreArchive(String(body.archiveId || ''), body.targetWorkspaceId || null)
    if (r.ok) await journal({ action: 'archive-restore', archiveId: body.archiveId, sid: r.sessionId })
    sendJson(res, r.ok ? 200 : 409, r)
  })

  routeM('/archive/purge', async (req, res) => {
    const body = await readBody(req)
    const r = await purgeArchives(Array.isArray(body.archiveIds) ? body.archiveIds : [])
    sendJson(res, 200, r)
  })

  routeM('/archive/purge-expired', async (req, res) => {
    const purged = await pruneExpiredArchives()
    sendJson(res, 200, { ok: true, purged })
  })

  route('/export/stream', async (req, res) => {
  try {
    const url = new URL(req.url || ROUTE, 'http://localhost')
    const sid = String(url.searchParams.get('sessionId') || '')
    const format = String(url.searchParams.get('format') || 'json').toLowerCase()
    if (!sid) return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: '缺少 sessionId' })
    const found = await findSessionDir(sid)
    if (!found || !found.dir) return sendJson(res, 404, { ok: false, code: 'SESSION_NOT_FOUND', error: '找不到这个会话' })
    const { header, events } = readLog(found.dir)
    const title = titleOfEvents(events, '') || titleOf(sid) || sid
    const safe = String(title).replace(/[\\/:*?"<>|\n\r\t]/g, '-').slice(0, 80) || 'session'

    if (format === 'md') {
      const data = await exportSessionData(sid)
      if (!data.ok) return sendJson(res, 500, data)
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="' + encodeURIComponent(safe + '.md') + '"',
      })
      res.end(data.text)
      return
    }

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="' + encodeURIComponent(safe + '.json') + '"',
    })
    res.write('{"kind":"' + EXPORT_KIND + '","schemaVersion":' + EXPORT_SCHEMA + ',"exportedAt":' + JSON.stringify(nowIso()) +
      ',"session":' + JSON.stringify({ id: sid, title, cwd: (header && header.cwd) || '' }) + ',"events":[')
    let first = true
    let buffered = 0
    for (const ev of events) {
      const chunk = (first ? '' : ',') + JSON.stringify(ev)
      first = false
      buffered += chunk.length
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve))
        buffered = 0
      }
      if (buffered > 512 * 1024) { buffered = 0 }
    }
    res.end(']}\n')
  } catch (e) {
    try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch { /* ignore */ }
  }
})

route('/export', async (req, res) => {
    const body = await readBody(req, MAX_IMPORT_BYTES)
    const sid = String(body.sessionId || '').trim()
    if (!sid) return sendJson(res, 400, { ok: false, error: '缺 sessionId' })
    const data = await exportSessionData(sid)
    if (!data.ok) return sendJson(res, 404, data)
    const format = body.format === 'md' ? 'md' : 'json'
    sendJson(res, 200, {
      ok: true,
      format,
      title: data.title,
      messages: data.messages,
      suggestedName: data.suggestedName + (format === 'md' ? '.md' : '.json'),
      text: format === 'md' ? data.md : data.json,
      bytes: Buffer.byteLength(format === 'md' ? data.md : data.json, 'utf8'),
    })
  })

  // 导入第 1 步：只解析，不改任何东西
  route('/import/preview', async (req, res) => {
    const body = await readBody(req, MAX_IMPORT_BYTES)
    const parsed = parseExport(body.text)
    if (!parsed.ok) return sendJson(res, 400, parsed)
    const seat = await importSeat(parsed)
    const skipReasons = []
    if (!parsed.events.length) skipReasons.push('文件里没有可用的消息记录')
    sendJson(res, 200, {
      ok: true,
      schemaVersion: parsed.schemaVersion,
      session: parsed.session,
      messages: parsed.messages,
      events: parsed.events.length,
      seat,
      blocked: parsed.schemaVersion > EXPORT_SCHEMA,
      warnings: skipReasons,
    })
  })

  // 导入第 2 步：真的落地（new / copy / merge / restore）
  routeM('/import/apply', async (req, res) => {
    const body = await readBody(req, MAX_IMPORT_BYTES)
    const parsed = parseExport(body.text)
    if (!parsed.ok) return sendJson(res, 400, parsed)
    const mode = String(body.mode || 'new')
    const seat = await importSeat(parsed)
    let r
    if (mode === 'restore') r = await importRestoreThenMerge(parsed)
    else if (mode === 'merge') {
      const target = String(body.targetSessionId || seat.sessionId || '')
      r = await importMerge(parsed, target)
    } else r = await importAsNew(parsed, { copyTitle: mode === 'copy' })
    if (r && r.ok) {
      await journal({ action: 'import', mode, sessionId: r.sessionId || null, added: r.added || 0, ok: true })
      sendJson(res, 200, { ok: true, mode, ...r })
    } else sendJson(res, 409, r || { ok: false, error: '导入失败' })
  })

  ensureLayout()
    .then(() => reconcileTrash())
    .then((r) => journal({ action: 'boot', ok: true, reconcile: { added: r.added, dropped: r.dropped, broken: r.broken } }))
    .then(() => bootArchiveSnapshot())
    .catch((e) => log('初始化失败：', e && e.message))
}
