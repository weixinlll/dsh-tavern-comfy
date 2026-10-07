/**
 * 给 Tavern 的正文渲染补丁加一个「卡片工作台」标记。
 *
 * 背景：renderTavernAssistantBlocks 里有两条调用插件渲染器的路径 ——
 *   ① else if (input.htmlSketches)  → input.htmlSketches === (mode === "card")，**只有卡片工作台**走这里
 *   ② else                          → 没有 projection 且不是卡片工作台的其它情况
 * 两条传的 context 一模一样，插件没法区分自己是被谁调用的，于是在卡片工作台里也接管了正文、
 * 把 image### 标记渲染成了图片。这里给 ① 的 context 加 cardBench: true、② 加 cardBench: false，
 * 插件见到 cardBench 就直接交还 Tavern 原生渲染。
 *
 * 幂等：已经打过就跳过。改完必须跑 node bin/build-tavern-client.mjs 重建产物。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('用法: node patch-cardbench.mjs <message-frame.js 绝对路径>'); process.exit(1) }

const text = readFileSync(file, 'utf8')
const lines = text.split('\n')
const total = lines.length
const indentOf = line => (line.match(/^[\t ]*/) || [''])[0]

function insertAfter(startIndex, predicate, newLine, label) {
  const limit = Math.min(startIndex + 14, total)
  for (let i = startIndex; i < limit; i += 1) {
    if (!predicate(lines[i])) continue
    if (lines.slice(i, i + 3).some(l => l.includes('cardBench'))) { console.log(label + '：已存在，跳过'); return }
    lines.splice(i + 1, 0, indentOf(lines[i]) + newLine)
    console.log(label + '：已在第 ' + (i + 2) + ' 行插入')
    return
  }
  throw new Error(label + '：找不到插入点')
}

// ① 卡片工作台分支：唯一特征是 render?.(htmlText, {（注意大写 T，不会误配下面那条）
const hostBranch = lines.findIndex(l => l.includes('render?.(htmlText, {'))
if (hostBranch < 0) throw new Error('找不到 htmlSketches 分支的渲染调用')
insertAfter(hostBranch, l => l.includes('messageId: input.messageId, mentions: input.mentions,'), 'cardBench: true,', '卡片工作台分支')

// ② 非工作台分支：render?.(text, {（小写 t）
const otherBranch = lines.findIndex(l => l.includes('render?.(text, {'))
if (otherBranch < 0) throw new Error('找不到 else 分支的渲染调用')
insertAfter(otherBranch, l => /^\s*mentions: input\.mentions,\s*$/.test(l), 'cardBench: Boolean(input.htmlSketches),', '非工作台分支')

const out = lines.join('\n')
if (out !== text) writeFileSync(file, out, 'utf8')

// 回读校验：两处都必须在，且仍然只有两条 render 调用
const check = readFileSync(file, 'utf8')
const hits = (check.match(/cardBench/g) || []).length
const calls = (check.match(/assistantTextRenderer\?\.render\?\.\(/g) || []).length
console.log('校验：cardBench 出现 ' + hits + ' 次（应为 2），render 调用 ' + calls + ' 处（应为 2 或 3）')
if (hits < 2) { console.error('❌ 打补丁失败'); process.exit(1) }
console.log('✅ 补丁完成')
