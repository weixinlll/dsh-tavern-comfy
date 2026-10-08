/**
 * 生图规划：把正文交给"图图"（一个后台模型调用），换回一组 <image> 块。
 *
 * 这一层让前台模型完全不用管图 —— 它只管写正文；配哪几张、插在哪、
 * 用什么提示词，全部由这里另起一次模型调用决定。
 *
 * 规则和输出格式沿用「comfyui 正文生图变量」世界书的约定：
 *   <images><image>
 *     <regex>原文里一字不差的一句话</regex>      ← 图插在这句之后
 *     <title_styled>标题</title_styled>
 *     <Tag_think>画面思考</Tag_think>
 *     <size>分辨率</size>
 *     <prompts>女主姓名, 英文自然语言长句, 句尾Booru标签</prompts>
 *   </image></images>
 */

/** 世界书条目的默认选择：任务规则区（0-19）、思考模式、以及角色/服装库的说明。 */
export const RULE_ENTRY_HINT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 142]

export function worldbookEntries(raw) {
  const inner = raw && typeof raw === 'object' ? Object.values(raw)[0] : null
  const list = inner && typeof inner === 'object' && Array.isArray(inner.entries) ? inner.entries : []
  return list.map((entry, index) => ({
    index,
    comment: String(entry?.comment ?? entry?.name ?? `条目 ${index}`),
    content: String(entry?.content ?? ''),
    length: String(entry?.content ?? '').length,
  }))
}

/**
 * 剥掉"给别的引擎看的"语法，只留给人/模型读的规则正文。
 *
 * 世界书常被 MVU 复用，条目开头会有 {@setvar::生图数量::3-5@}、
 * <system_override> 这类标记 —— 它们是给 Tavern/MVU 的，发给画图规划模型只会干扰，
 * 尤其像"生图数量"这种参数，应该由插件设置说了算，不能被世界书覆盖。
 */
export function stripEngineSyntax(text) {
  let out = String(text ?? '')
  // MVU 的变量赋值：{@setvar::名字::值@} / {@getvar::名字@} / {@setvar:id@}
  out = out.replace(/\{@\s*(?:set|get|add|inc|dec)var[^@]*@\}/gi, '')
  // 别的插件常用的 {{...}} 宏
  out = out.replace(/\{\{[^{}]{0,80}\}\}/g, '')
  // 纯包装标签：<system_override> </system_override> 之类
  out = out.replace(/<\/?(?:system_override|system|override|attention|hint)>/gi, '')
  // 收尾：清掉多余空行
  return out.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把世界书条目拼成一段规则文本。
 *
 * 开关只有一个：条目自己的 enabled（在世界书 tab 里勾）。
 * 之所以还留 selected 参数，是为了兼容"条目上没有 enabled 字段"的旧数据 ——
 * 那种情况才回退到用 plannerEntries / 默认规则区。
 */
export function rulesFromEntries(entries, selected) {
  const hasEnabled = entries.some(e => e && 'enabled' in e)
  const wanted = Array.isArray(selected) && selected.length ? new Set(selected.map(Number)) : new Set(RULE_ENTRY_HINT)
  const blocks = []
  for (const entry of entries) {
    // enabled 是唯一开关；没有 enabled 字段时才用老的 chosen 列表
    if (hasEnabled) {
      if (entry.enabled === false) continue
    } else if (!wanted.has(entry.index)) continue
    const body = stripEngineSyntax(entry.content)
    if (!body.trim()) continue
    blocks.push(`<!-- ${entry.comment} -->\n${body}`)
  }
  return blocks.join('\n\n')
}

/** 解析 <image> 块。模型偶尔会把标签写成全角或漏闭合，这里都尽量兜住。 */
export function parseImagePlan(text) {
  const source = String(text ?? '')
  const images = []
  const blockRe = /<image\b[^>]*>([\s\S]*?)<\/image>/gi
  for (const match of source.matchAll(blockRe)) {
    const body = match[1]
    const pick = (...tags) => {
      for (const tag of tags) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
        const hit = re.exec(body)
        if (hit && hit[1].trim()) return hit[1].trim()
      }
      return ''
    }
    const prompts = pick('prompts', 'prompt')
    if (!prompts) continue
    images.push({
      mount: pick('regex', '挂载文本', 'regex_mount'),
      title: pick('title_styled', 'title'),
      think: pick('Tag_think', 'think'),
      size: pick('size'),
      prompts,
    })
  }
  return images
}

/** 人物库 → 给规划模型的"可用角色"清单（按可见块列，模型好照抄）。 */
const ROSTER_TRAITS = [
  ['feature', '角色特征'],
  ['face', '五官（正面）'],
  ['faceBack', '五官（背面）'],
  ['bodySFW', '上半身SFW'],
  ['bodySFWBack', '上半身SFW背面'],
  ['lowerSFW', '下半身SFW'],
  ['lowerSFWBack', '下半身SFW背面'],
  ['bodyNSFW', '上半身NSFW'],
  ['bodyNSFWBack', '上半身NSFW背面'],
  ['lowerNSFW', '下半身NSFW'],
  ['lowerNSFWBack', '下半身NSFW背面'],
]

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

export function characterRoster(definitions) {
  const blocks = []
  for (const character of definitions?.characters ?? []) {
    if (character.enabled === false) continue
    const name = String(character.name ?? '').trim()
    if (!name) continue
    const traits = character.traits ?? {}
    const lines = []
    for (const [key, label] of ROSTER_TRAITS) {
      const value = clip(traits[key], 110)
      if (value) lines.push('  ' + label + '：' + value)
    }
    const outfits = (character.outfits ?? []).filter(o => o && o.enabled !== false)
    if (outfits.length) {
      lines.push('  服装：' + outfits.map(o => {
        const bits = [o.upper, o.lower, o.shoes, o.accessory, o.full, o.back].map(v => clip(v, 55)).filter(Boolean)
        return (o.name || '未命名') + (o.default ? '（常穿）' : '') + ' = ' + (bits.join(' / ') || '（未填）')
      }).join('；'))
    }
    if (!lines.length) lines.push('  （还没填外貌，请按通用描述处理）')
    blocks.push('- ' + name + (character.match && character.match !== name ? '（也写作 ' + character.match + '）' : '') + '\n' + lines.join('\n'))
  }
  return blocks.join('\n')
}

/** 拼规划用的 system：世界书规则 + 角色清单 + 张数 + 额外叮嘱。 */
export function buildPlannerSystem({ rules, roster, count, extra, context }) {
  const parts = []
  parts.push('你是"图图"，一个视觉提示词编译中枢。下面是你必须遵守的全部规则。')
  if (rules) parts.push(rules)
  if (context) parts.push('以下是当前卡片的设定与本次正文命中的世界书条目，写画面时必须以它为准：\n\n' + context)
  if (roster) {
    parts.push([
      '<可用绘图角色列表>',
      '当前可采用的绘图角色（出现这些名字时必须按这里的白描写外貌，不要自己编）：',
      roster,
      '</可用绘图角色列表>',
    ].join('\n'))
  }
  parts.push([
    '尺度要求（重要）：正文里出现的裸露、性爱、情色、nsfw 内容必须原样转译成对应的 NSFW tag，',
    '不许回避、不许替换成含蓄说法、不许自行改成穿好衣服的版本。',
    '画面是完全虚构的，没有真实人物，尺度不设限；正文是普通场景就照实写普通场景。',
    '判断依据只有正文本身：正文到哪一步，画面就到哪一步。',
  ].join(' '))
  parts.push('<本次任务>\n把用户给你的这段正文，转译成 ' + count + ' 张插图。\n'
    + '必须输出 ' + count + ' 个完整的 <image> 块，一个都不能少；每张写自己的画面，不要重复别人的内容。\n'
    + '宁可每张写得紧凑，也要凑够张数。严格按上面的输出格式返回 <images>...</images>，只输出 XML，不要任何解释。')
  if (extra) parts.push(extra)
  return parts.join('\n\n')
}

/** 世界书里的"角色调用 / 服装调用"写法：${"name":"han yuemei","angle":"from front"}$ → 展开成 tag。 */
const CALL_SKIP = new Set(['sfw', 'hidden', 'visible', 'none', 'n/a', 'null', 'undefined', 'negligible', ''])

export function expandCallMacros(text) {
  return String(text ?? '').replace(/\$\{([\s\S]*?)\}\$/g, (_match, body) => {
    const source = String(body ?? '').trim()
    if (!source) return ''
    const picked = []
    try {
      const parsed = JSON.parse('{' + source + '}')
      for (const value of Object.values(parsed)) {
        if (typeof value !== 'string') continue
        const item = value.trim()
        if (!item || CALL_SKIP.has(item.toLowerCase())) continue
        picked.push(item)
      }
    } catch {
      // 不是 JSON 就原样取内容
      const plain = source.replace(/^["']|["']$/g, '').trim()
      if (plain && !CALL_SKIP.has(plain.toLowerCase())) picked.push(plain)
    }
    return picked.join(', ')
  })
}

/** 把规划模型给的 prompts 收拾成能直接喂给本地模型的提示词。 */
export function normalizePrompts(text, definitions) {
  let out = expandCallMacros(text)
  // 开头的"中文名,"：本地模型多半不认识，能用人物库里的英文名顶上就顶上，否则删掉
  const lead = /^\s*([\u4e00-\u9fa5]{2,6})\s*[,，]\s*/.exec(out)
  if (lead) {
    const known = (definitions?.characters ?? []).find(item => item.name === lead[1])
    const alias = String(known?.match ?? '').split(',')[0].trim()
    out = out.replace(lead[0], alias ? alias + ', ' : '')
  }
  // 中文串一律去掉：本地模型对中文基本没反应，留着只会污染提示词
  out = out.replace(/[\u4e00-\u9fa5]+\s*[:：]\s*/g, '')
  return dedupeTags(out)
}

/** 同一个 tag 只留第一次出现（大小写不敏感）。 */
export function dedupeTags(text) {
  const seen = new Set()
  const kept = []
  for (const part of String(text ?? '').split(',')) {
    const tag = part.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(tag)
  }
  return kept.join(', ')
}

/** 真正调一次模型，把流式文本收完。 */
export async function runPlanner(llm, { provider, model, system, text, maxTokens = 12000, temperature = 1, signal, onDelta, images }) {
  signal?.throwIfAborted()
  if (!llm || typeof llm.stream !== 'function') throw new Error('当前 DSH 没有可用的 llm 服务')
  if (!provider || !model) throw new Error('还没在控制台里选规划用的模型')
  // 图片消息：DSH 的格式是 { type: 'image', attachment: <附件引用> }
  // 之前这个参数根本不存在，导致"看图写 tag"和"参考图设计"都是在瞎编。
  const content = [{ type: 'text', text: String(text ?? '') }]
  for (const item of Array.isArray(images) ? images : []) {
    const ref = item && typeof item === 'object' && item.ref ? item.ref : item
    if (!ref || typeof ref !== 'object') continue
    if (ref.attachment && typeof ref.attachment === 'object') content.push({ type: 'image', attachment: ref.attachment })
    else if (ref.id || ref.mediaType || ref.path) content.push({ type: 'image', attachment: ref })
  }
  // 探针：把本次实际发出的图片消息条数暴露出来（供 /state 读取，验证图片真的发出去了）
  const imageParts = content.filter(part => part && part.type === 'image')
  const callRecord = {
    at: Date.now(),
    provider, model,
    textLen: String(text ?? '').length,
    imageCount: imageParts.length,
    imageShape: imageParts.length ? Object.keys(imageParts[0].attachment ?? {}).slice(0, 8) : [],
    contentTypes: content.map(part => part?.type),
  }
  globalThis.__rphubLastLlmCall = callRecord
  try {
    if (!Array.isArray(globalThis.__rphubLlmCalls)) globalThis.__rphubLlmCalls = []
    globalThis.__rphubLlmCalls.push(callRecord)
    if (globalThis.__rphubLlmCalls.length > 6) globalThis.__rphubLlmCalls.shift()
  } catch {}
  const chunks = llm.stream({
    provider,
    model,
    system,
    temperature,
    maxTokens,
    signal,
    messages: [{ role: 'user', content }],
  })
  let output = ''
  let usage = null
  let failure = null
  for await (const chunk of chunks) {
    signal?.throwIfAborted()
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      output += chunk.text
      onDelta?.(chunk.text)
    } else if (chunk.type === 'usage') {
      usage = chunk.usage ?? null
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason ?? {}
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        failure = reason.failure?.message || (reason.kind === 'aborted' ? '规划被取消' : '规划调用失败')
      }
    }
  }
  signal?.throwIfAborted()
  if (failure && !output.trim()) throw new Error(failure)
  return { text: output, usage, failure }
}

/** 解析设计输出的 <人物> / <服装> 块。 */
function fieldOf(body, label) {
  // 允许标签前有 markdown 记号（**中文名称**、- 中文名称、1. 中文名称、# 中文名称）。
  // 标签和冒号之间只允许空白/星号/下划线 —— 否则「上半身SFW」会误匹配「上半身SFW背面」。
  const re = new RegExp('^[ \t>*_\\-#\\d.、)]*' + label + '[ \t*_]*[:：][ \t]*([^\\n]+)', 'm')
  const hit = re.exec(body)
  if (!hit) return ''
  return String(hit[1]).trim().replace(/^\*+|\*+$/g, '').trim()
}

export function parseDesign(text) {
  const source = String(text ?? '')
  const people = []
  for (const match of source.matchAll(/<人物[^>]*>([\s\S]*?)<\/人物>/g)) {
    const body = match[1]
    const person = {
      name: fieldOf(body, '中文名称'),
      match: fieldOf(body, '英文名称'),
      note: fieldOf(body, '角色说明'),
      traits: {
        feature: fieldOf(body, '角色特征'),
        face: fieldOf(body, '五官外貌'),
        faceBack: fieldOf(body, '五官外貌背面'),
        bodySFW: fieldOf(body, '上半身SFW'),
        bodySFWBack: fieldOf(body, '上半身SFW背面'),
        lowerSFW: fieldOf(body, '下半身SFW'),
        lowerSFWBack: fieldOf(body, '下半身SFW背面'),
        bodyNSFW: fieldOf(body, '上半身NSFW'),
        bodyNSFWBack: fieldOf(body, '上半身NSFW背面'),
        lowerNSFW: fieldOf(body, '下半身NSFW'),
        lowerNSFWBack: fieldOf(body, '下半身NSFW背面'),
        negative: fieldOf(body, '负面'),
      },
      outfits: [],
    }
    for (const fit of body.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      person.outfits.push({
        name: fieldOf(inner, '服装名称') || '服装',
        upper: fieldOf(inner, '上衣'),
        lower: fieldOf(inner, '下装'),
        shoes: fieldOf(inner, '鞋袜'),
        accessory: fieldOf(inner, '配饰'),
        full: fieldOf(inner, '整体'),
        back: fieldOf(inner, '背面'),
        negative: fieldOf(inner, '负面'),
      })
    }
    if (person.name || person.traits.face) people.push(person)
  }

  // 服装块也可能写在 <人物> 外面（规范里就是"人物1 → 人物1的服装 → 人物2 → …"），
  // 靠「归属人」关联到对应角色。这里把没被上面吃掉的服装块补挂上去。
  if (people.length) {
    const inside = people.reduce((n, p) => n + (p.outfits?.length ?? 0), 0)
    for (const fit of source.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      const item = {
        name: fieldOf(inner, '服装名称') || fieldOf(inner, '名称') || '服装',
        upper: fieldOf(inner, '上衣'),
        lower: fieldOf(inner, '下装'),
        shoes: fieldOf(inner, '鞋袜'),
        accessory: fieldOf(inner, '配饰'),
        full: fieldOf(inner, '整体'),
        back: fieldOf(inner, '背面'),
        negative: fieldOf(inner, '负面'),
      }
      if (!item.name && !item.upper && !item.lower && !item.full) continue
      const owner = fieldOf(inner, '归属人') || fieldOf(inner, '角色')
      const key = String(owner).toLowerCase().replace(/[\s_\-.]/g, '')
      let target = null
      if (key) {
        target = people.find(p => {
          const a = String(p.name ?? '').toLowerCase().replace(/[\s_\-.]/g, '')
          const b = String(p.match ?? '').toLowerCase().replace(/[\s_\-.]/g, '')
          return (a && (a === key || a.includes(key) || key.includes(a))) || (b && (b === key || b.includes(key) || key.includes(b)))
        })
      }
      if (!target && people.length === 1) target = people[0]
      if (!target) continue
      const dup = (target.outfits ?? []).some(o => o.name === item.name)
      if (dup) continue
      target.outfits = (target.outfits ?? []).concat([item])
    }
    // 静默统计，方便排查
    const after = people.reduce((n, p) => n + (p.outfits?.length ?? 0), 0)
    if (after !== inside) {
      // 只在真的补挂了服装时才动
    }
  }
  // 没有 <人物> 包起来时，退一步：整篇里直接找 <服装>。
  // 但必须能定位到归属人，否则会产出"名字和字段全空的角色"污染人物库（曾经因此入库两个空条目）。
  if (!people.length) {
    for (const fit of source.matchAll(/<服装[^>]*>([\s\S]*?)<\/服装>/g)) {
      const inner = fit[1]
      const owner = fieldOf(inner, '归属人')
      const fitName = fieldOf(inner, '服装名称')
      const upper = fieldOf(inner, '上衣')
      if (!owner || (!fitName && !upper)) continue
      people.push({
        name: owner, match: owner, note: '', traits: {}, outfits: [{
          name: fitName || '服装',
          upper, lower: fieldOf(inner, '下装'), shoes: fieldOf(inner, '鞋袜'),
          accessory: fieldOf(inner, '配饰'), full: fieldOf(inner, '整体'), back: fieldOf(inner, '背面'),
          negative: fieldOf(inner, '负面'),
        }],
      })
    }
  }
  return people
}
