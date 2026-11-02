import { resolve, sep, isAbsolute } from 'node:path'

/**
 * target 是否在 base 内部（含 base 本身）。
 * 先 resolve 再按分隔符比较，避免 `C:\a\bc` 被当成 `C:\a\b` 的子路径。
 */
export function pathInside(base, target) {
  const b = resolve(base)
  const p = resolve(target)
  return p === b || p.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * 把记录里的相对路径拼到 base 下，并保证结果不越界。
 * 拒绝：空串、绝对路径、盘符开头、`..` 逃逸。
 */
export function safeJoinInside(base, rel) {
  const raw = rel == null ? '' : String(rel)
  if (!raw.trim()) return { ok: false, code: 'BAD_PATH', error: '路径为空' }
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, code: 'BAD_PATH', error: '不允许绝对路径：' + raw }
  }
  const dest = resolve(base, raw)
  if (!pathInside(base, dest)) return { ok: false, code: 'BAD_PATH', error: '路径越界：' + raw }
  return { ok: true, dest }
}
