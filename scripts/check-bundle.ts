import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'cdt-bundle-'))
function size(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const file = join(path, entry.name)
    // Source maps 和 Wrangler 的输出说明不属于执行包体。
    if (entry.name.endsWith('.map') || entry.name === 'README.md') return total
    return total + (entry.isDirectory() ? size(file) : statSync(file).size)
  }, 0)
}
try {
  const result = spawnSync('bun', ['x', 'wrangler', 'deploy', '--dry-run', '--outdir', directory], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Worker 打包校验失败')
  const bytes = size(directory)
  console.log(`Worker 包体（未压缩）：${(bytes / 1024 / 1024).toFixed(2)} MiB`)
  if (bytes > 64 * 1024 * 1024) throw new Error('Worker 包体超过 64 MiB')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
