import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { treeStats } from '../lib/tree.mjs'

async function makeFixture() {
  const root = join(tmpdir(), 'session-trash-tree-' + Date.now() + '-' + Math.random().toString(16).slice(2))
  await fsp.mkdir(join(root, 'sub'), { recursive: true })
  await fsp.writeFile(join(root, 'a.bin'), Buffer.alloc(10, 1))
  await fsp.writeFile(join(root, 'sub', 'b.bin'), Buffer.alloc(25, 2))
  return root
}

test('treeStats: 统计文件数与总字节', async () => {
  const root = await makeFixture()
  try {
    const st = await treeStats(root)
    assert.equal(st.files, 2)
    assert.equal(st.bytes, 35)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('treeStats: 复制后两份一致', async () => {
  const root = await makeFixture()
  const copy = root + '-copy'
  try {
    await fsp.cp(root, copy, { recursive: true })
    const a = await treeStats(root)
    const b = await treeStats(copy)
    assert.deepEqual(a, b)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(copy, { recursive: true, force: true })
  }
})

test('treeStats: 目标缺文件时能看出不一致（copyThenVerify 的判据）', async () => {
  const root = await makeFixture()
  const copy = root + '-copy2'
  try {
    await fsp.cp(root, copy, { recursive: true })
    await fsp.rm(join(copy, 'sub', 'b.bin'))
    const a = await treeStats(root)
    const b = await treeStats(copy)
    assert.notDeepEqual(a, b)
    assert.equal(b.files, 1)
    assert.equal(b.bytes, 10)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(copy, { recursive: true, force: true })
  }
})
