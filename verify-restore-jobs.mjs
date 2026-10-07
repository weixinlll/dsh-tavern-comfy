/**
 * 模拟引擎启动时的 restoreJobs()，验证「重启后有多少张历史图能真正打开」。
 * 只读：不写任何文件。逻辑与 lib/index.js 的 restoreJobs 保持一致（含 state 修正与 byKey 重建）。
 */
import { readFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = process.env.COMFY_ROOT
const config = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'))
const cacheDir = join(ROOT, String(config.cacheDir || 'cache'))
const saved = JSON.parse(await readFile(join(ROOT, 'jobs-store.json'), 'utf8'))
const exists = async p => { try { await stat(p); return true } catch { return false } }

let total = 0, pathFixed = 0, byteFixed = 0, stateFixed = 0, canOpen = 0, noFile = 0, byKey = 0
const jobs = new Map()

for (const item of Object.values(saved)) {
  if (!item || !item.id) continue
  total += 1
  const job = { ...item, params: item.params ?? {} }
  if (!job.file || !(await exists(job.file))) {
    for (const ext of ['.img', '.png', '.jpg', '.jpeg', '.webp']) {
      const guess = join(cacheDir, String(job.id) + ext)
      if (await exists(guess)) { job.file = guess; pathFixed += 1; break }
    }
  }
  if (job.file) {
    try {
      const info = await stat(job.file)
      if (info.size) {
        job.byteLength = info.size
        byteFixed += 1
        if (job.state !== 'done') { job.state = 'done'; job.percent = 100; stateFixed += 1 }
      }
    } catch { /* 保持原样 */ }
  }
  if (!job.file) noFile += 1
  if (job.key) byKey += 1
  jobs.set(String(item.id), job)
}
for (const job of jobs.values()) if (job.state === 'done' && job.byteLength) canOpen += 1

// cache 兜底：有文件但没记录的，会被补成 done
const names = await readdir(cacheDir).catch(() => [])
const known = new Set([...jobs.keys()])
const orphans = names.filter(n => /^[0-9a-f-]{36}\.(?:img|png|jpe?g|webp)$/i.test(n) && !known.has(n.split('.')[0]))
const files = names.filter(n => /^[0-9a-f-]{36}\.(?:img|png|jpe?g|webp)$/i.test(n))

console.log('落盘记录                    :', total)
console.log('路径修正回 cache            :', pathFixed)
console.log('byteLength 补正             :', byteFixed)
console.log('  其中状态 pending→done 修正 :', stateFixed)
console.log('文件彻底找不到              :', noFile)
console.log('带 key（可重建去重索引）     :', byKey)
console.log('cache 里的图片文件           :', files.length)
console.log('cache 里有文件但无记录       :', orphans.length)
console.log('→ 重启后能打开的图           :', canOpen + orphans.length, '/', total + orphans.length)
