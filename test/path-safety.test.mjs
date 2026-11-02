import test from 'node:test'
import assert from 'node:assert/strict'
import { pathInside, safeJoinInside } from '../lib/path-safety.mjs'

const ROOT = process.platform === 'win32' ? 'C:\\data\\root' : '/data/root'

test('pathInside: 同一目录算内部', () => {
  assert.equal(pathInside(ROOT, ROOT), true)
})

test('pathInside: 子目录算内部', () => {
  assert.equal(pathInside(ROOT, ROOT + (process.platform === 'win32' ? '\\a\\b' : '/a/b')), true)
})

test('pathInside: 前缀相同的兄弟目录不算内部', () => {
  const sibling = ROOT + (process.platform === 'win32' ? 'evil' : 'evil')
  assert.equal(pathInside(ROOT, sibling), false)
})

test('pathInside: 上级目录不算内部', () => {
  const parent = process.platform === 'win32' ? 'C:\\data' : '/data'
  assert.equal(pathInside(ROOT, parent), false)
})

test('safeJoinInside: 普通相对路径通过', () => {
  const r = safeJoinInside(ROOT, 'a/b.txt')
  assert.equal(r.ok, true)
  assert.ok(r.dest.endsWith(process.platform === 'win32' ? 'a\\b.txt' : 'a/b.txt'))
})

test('safeJoinInside: 空串拒绝', () => {
  const r = safeJoinInside(ROOT, '')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BAD_PATH')
})

test('safeJoinInside: .. 逃逸拒绝', () => {
  const r = safeJoinInside(ROOT, '../../etc/passwd')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BAD_PATH')
})

test('safeJoinInside: 绝对路径拒绝（POSIX 风格）', () => {
  const r = safeJoinInside(ROOT, '/etc/passwd')
  assert.equal(r.ok, false)
})

test('safeJoinInside: 盘符开头拒绝', () => {
  const r = safeJoinInside(ROOT, 'C:\\Windows\\System32\\x.dll')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'BAD_PATH')
})

test('safeJoinInside: 相对路径中段 .. 但仍落在内部时通过', () => {
  const r = safeJoinInside(ROOT, 'a/../b.txt')
  assert.equal(r.ok, true)
})

test('safeJoinInside: 反斜杠越界同样拒绝', () => {
  const r = safeJoinInside(ROOT, '..\\..\\x')
  assert.equal(r.ok, false)
})

test('safeJoinInside: null 拒绝', () => {
  const r = safeJoinInside(ROOT, null)
  assert.equal(r.ok, false)
})
