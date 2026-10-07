// 角色库恢复脚本（放在插件目录，数据丢了就跑它）
// 用法：node recover-definitions.mjs
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFS = join(HERE, 'definitions.json')
// 只认插件目录自己那份 backups/。以前这里还写死过一个绝对路径（开发机上的备份目录），
// 对别人毫无意义，已去掉 —— 想额外扫别的目录，用环境变量 DEFINITIONS_BACKUP_DIRS 指定。
const BACKUP_DIRS = [
  join(HERE, 'backups'),
  ...String(process.env.DEFINITIONS_BACKUP_DIRS ?? '')
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean),
]

// 找一个角色最多的备份
let best = null
for (const dir of BACKUP_DIRS) {
  let files = []
  try { files = await readdir(dir) } catch { continue }
  for (const f of files) {
    if (!/^definitions.*\.json$/i.test(f)) continue
    try {
      const j = JSON.parse(await readFile(join(dir, f), 'utf8'))
      const n = (j.characters ?? []).length
      if (!best || n > best.n) best = { n, path: join(dir, f), j }
    } catch {}
  }
}

const cur = await readFile(DEFS, 'utf8').then(JSON.parse).catch(() => ({ characters: [] }))
console.log('当前 definitions.json：' + (cur.characters ?? []).length + ' 个角色')
if (!best) { console.log('✗ 找不到任何备份'); process.exit(1) }
console.log('最好的备份：' + best.path + '（' + best.n + ' 个角色）')

if ((cur.characters ?? []).length >= best.n) {
  console.log('✓ 当前数据不比备份差，不用恢复')
  process.exit(0)
}

console.log('角色：' + (best.j.characters ?? []).map(c => c.name).join('、'))
// 恢复前先把当前状态留一份
await writeFile(DEFS + '.before-recover-' + Date.now(), JSON.stringify(cur, null, 2), 'utf8')
await writeFile(DEFS, JSON.stringify(best.j, null, 2), 'utf8')
console.log('✓ 已恢复。重启 DSH 或调用 POST /reload 生效。')
