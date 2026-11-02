import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** 递归统计目录下的文件数与总字节数（跨盘复制后用来核对） */
export async function treeStats(root) {
  let files = 0
  let bytes = 0
  async function walk(dir) {
    const list = await fsp.readdir(dir, { withFileTypes: true })
    for (const it of list) {
      const p = join(dir, it.name)
      if (it.isDirectory()) await walk(p)
      else if (it.isFile()) {
        const st = await fsp.stat(p)
        files += 1
        bytes += st.size
      }
    }
  }
  await walk(root)
  return { files, bytes }
}
