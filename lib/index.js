/**
 * dsh-tavern-comfy —— 本地 ComfyUI 场景生图插件（host 半边）。
 *
 * 它把三件事合成一个插件：
 *   1. 出图：把模型写在正文里的 `image###英文Tag###` 标记变成真正的图，交给本地 ComfyUI 画；
 *   2. 提示词：往系统提示词里注入"自动生图规则"，让模型知道该在哪、怎么写这些标记；
 *   3. 控制台：工作流库 / 人物库 / 生成记录 / 测试生成，一个网页搞定。
 *
 * 路由都挂在宿主自己的 web 服务上（同源，浏览器直接访问）：
 *   GET  /plugins/dsh-tavern-comfy/console           控制台页面
 *   GET  /plugins/dsh-tavern-comfy/state             控制台状态
 *   POST /plugins/dsh-tavern-comfy/config            保存设置
 *   POST /plugins/dsh-tavern-comfy/workflow          改一条工作流
 *   POST /plugins/dsh-tavern-comfy/reload            重扫 workflows/
 *   POST /plugins/dsh-tavern-comfy/definitions       保存人物库
 *   POST /plugins/dsh-tavern-comfy/generate          控制台里的"试一张"
 *   POST /plugins/dsh-tavern-comfy/jobs              建作业（浏览器渲染器用）
 *   GET  /plugins/dsh-tavern-comfy/jobs?id=&image=1  查作业 / 取图
 */
import { randomUUID, randomInt } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAutoImageGenPrompt } from './prompts.js'
import { installTavernBridge } from './tavern-bridge.js'
import { createPluginUpdater } from './updater.js'
import { IMAGE_PROVIDERS, generateImage, testImageChannel } from './image-providers.js'
import { normalizeChannels, publicChannels, activeChannel, channelConfigPatch } from './image-channels.js'
import { patchWorkflowGraph, workflowRevision } from './workflow-graph.js'
import { worldbookEntries, rulesFromEntries, parseImagePlan, parsePlannerDecision, characterRoster, buildPlannerSystem, runPlanner, normalizePrompts, parseDesign } from './planner.js'
import { applyCharacterSnapshot, boundCharacterSnapshot, emptyCharacterSnapshot, mergeCharacterUpdates } from './character-history.js'
import { getPromptGuidance } from './prompt-presets.js'
import { BUILTIN_PROMPT_PRESETS, normalizePromptPresets, resolvePromptMode, composePresetText, promptPresetNegative, effectivePromptPreset, formatPromptForBackend, validPromptPresetId, promptBackendContext } from './prompt-presets.js'
import { transcodeImageOutputAsync } from './image-output.js'
import { buildComfySimpleWorkflow, inspectComfySimple, normalizeComfySimpleConfig } from './comfy-simple.js'

export const name = 'dsh-tavern-comfy'
export const inject = ['webServer']

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Tavern 的数据根目录（data/），用来读它设置里的「默认后台模型」
const TAVERN_DATA = dirname(dirname(ROOT))
const TAVERN_SETTINGS = join(TAVERN_DATA, 'tavern-settings.json')
const BASE = '/plugins/dsh-tavern-comfy'
const CONFIG_PATH = join(ROOT, 'config.json')
const DEFS_PATH = join(ROOT, 'definitions.json')
const WORKFLOW_DIR = join(ROOT, 'workflows')
const CONSOLE_PATH = join(ROOT, 'console.html')
const AUTO_SECTION = 'rphub-comfy:auto-image'
const AUTO_SECTION_ORDER = 10150

const DEFAULTS = {
  imageBackend: 'comfyui',
  imageChannels: [],
  activeImageChannel: '',
  imageConcurrency: 2,
  comfyUrl: 'http://127.0.0.1:8188',
  comfyMode: 'workflow',
  comfySimple: normalizeComfySimpleConfig(),
  // 服务鉴权：none / bearer / basic
  comfyAuthMode: 'none',
  comfyAuthToken: '',
  comfyAuthUser: '',
  comfyAuthPass: '',
  defaultWorkflow: '',
  lockWorkflow: false,
  autoImageGen: false,
  imageGenCount: 2,
  smartImageSelection: true,
  characterAutoUpdate: true,
  // 画师串 / 风格：浏览器半边不传 artist 时用它（对应原来插件的「自定义画师串」）
  styleArtists: '',
  // 画风预设（参考 st-chatu8 的「提示词预设」）：
  //   每套 { id, name, artist, negative, position, enabled }
  //   artist  = 画师串 / 风格词（拼进正面）
  //   negative = 这套自带的负面固定词（会并进负面）
  stylePresets: [],
  // 当前用的预设 id（'' = 用下面的默认值）
  activePreset: '',
  // 默认负面固定词（没选预设时用）
  styleNegative: '',
  promptPresets: [],
  activePromptPreset: '',
  promptMode: 'auto',
  jpegOutput: false,
  jpegQuality: 88,
  jpegBackground: '#ffffff',
  // 默认画幅：竖图 / 横图 / 方图（规划模型给出 WxH 时优先用它的）
  imageSize: '竖图',
  // ---- 生图规划（agent 生图）：另起一次模型调用，决定配几张、插在哪、提示词怎么写 ----
  plannerEnabled: true,
  plannerProvider: '',
  plannerModel: '',
  // 看图（参考图 / 照片识别）用的模型：必须是支持视觉的模型
  visionProvider: '',
  // 推理等级（模型的 reasoning effort）
  plannerEffort: '',
  visionEffort: '',
  visionModel: '',
  plannerCount: 3,
  plannerTemperature: 1,
  plannerExtra: '',
  // 世界书里哪几条进规划提示词；空数组 = 用默认的任务规则区
  plannerEntries: [],
  artistPosition: 'prefix',
  weightMode: 'convert',
  negativeMode: 'plugin',
  overrideSteps: false,
  injectWeight: 1.1,
  // 人物可见块怎么带：'auto' 按画面是否 NSFW 决定 / 'sfw' 永远只带常规块 / 'all' 全带
  traitMode: 'auto',
  queryThrottleMs: 400,
  cacheDir: 'cache',
  maxImageBytes: 32 * 1024 * 1024,
  workflows: [],
  sizes: { 竖图: { width: 512, height: 768 }, 横图: { width: 768, height: 512 }, 方图: { width: 640, height: 640 } },
}

/** 人物库三类定义。continuity 默认不注入（它随剧情变）。 */
const DEFINITION_KINDS = {
  characters: { label: '人物', fields: ['name', 'match', 'appearance', 'outfit', 'continuity'] },
  settings: { label: '场景', fields: ['name', 'match', 'layout', 'materials', 'lighting', 'continuity'] },
  props: { label: '物件', fields: ['name', 'match', 'appearance', 'continuity'] },
}
const DEFAULT_OFF_FIELDS = new Set(['continuity'])

/**
 * 人物的"可见块"划分（借用 st-chatu8 的思路）：按看得见什么、什么视角、穿不穿，
 * 分别写。镜头切到哪一块就带哪一块，避免把全身细节全塞进一张近景。
 */
const CHARACTER_TRAITS = [
  ['feature', '角色特征'],
  ['face', '五官外貌'],
  ['faceBack', '五官外貌背面'],
  ['bodySFW', '上半身SFW'],
  ['bodySFWBack', '上半身SFW背面'],
  ['lowerSFW', '下半身SFW'],
  ['lowerSFWBack', '下半身SFW背面'],
  ['bodyNSFW', '上半身NSFW'],
  ['bodyNSFWBack', '上半身NSFW背面'],
  ['lowerNSFW', '下半身NSFW'],
  ['lowerNSFWBack', '下半身NSFW背面'],
  ['negative', '负面'],
]
/** 旧版字段名 → 新版，读老数据时用。 */
const LEGACY_TRAITS = { fullSFW: 'lowerSFW', fullNSFW: 'lowerNSFW', faceBack: 'faceBack' }
/** 出图时按 POV / 景别 / 穿不穿挑块（正面背面互斥）。 */
const BACK_VIEW = /\b(from behind|from back|back view|seen from behind|from the back|backside|doggystyle|reversed)\b/i
const FULL_FRAME = /\b(full body|cowboy shot|wide shot|feet|foot|legs|thighs|lower body|hips|ass|butt|pussy|kneel|sitting|lying|on back|on stomach)\b/i
/** 提示词里出现这些词，就认为这张是露的，带上 NSFW 块。 */
const NSFW_HINT = /\b(nsfw|nude|naked|topless|nipples?|pussy|cum|sex|penetration|penis|lingerie|underwear|bra|panties|undressed)\b/i

/** 通用服装库的字段（跨角色复用的一套衣服）。 */
const OUTFIT_FIELDS = ['body', 'full', 'bodyBack', 'fullBack', 'negative']

export function normalizeOutfit(raw, index) {
  const item = {
    id: String(raw?.id ?? `outfit-${index + 1}`),
    name: String(raw?.name ?? `通用服装 ${index + 1}`),
    enabled: raw?.enabled !== false,
  }
  for (const key of OUTFIT_FIELDS) item[key] = String(raw?.[key] ?? '')
  return item
}

/** 看照片写 tag 时用的规则。 */
const VISION_SYSTEM = [
  '你是视觉提示词助手。看用户给的图片，把这个人的外貌写成绘图模型能用的 tag（danbooru 风格英文标签，逗号分隔）。',
  '按可见部位分块返回，只输出 JSON，不要解释：',
  '{"face":"脸、发色发型、瞳色","faceBack":"后脑/颈背","bodySFW":"胸型腰背等上半身体态","fullSFW":"身高腿型臀脚","bodyNSFW":"上半身裸露特征，若是穿着正常的图就留空","fullNSFW":"全身裸露特征，同上","negative":"这张图里明显不该出现的特征，例如画成小孩"}',
  '规则：只写看得到的；宁可少写也别编；不确定的留空字符串；尺度不限，图里是什么就写什么，不要回避、不要审查。',
].join('\n')

/**
 * 角色 / 服装调用宏（st-chatu8 那种"名字→tag"的机制）：
 *   ${"name":"xiao yu","angle":"from front","upperBody":"sfw"}$
 *
 * 挑块规则（人物的稳定 DNA）：按规范挑块 —— 正面与背面互斥；穿衣服时只用 SFW 块
 * （NSFW 块会让衣服画不出来）；近景只带上半身，出现腿/脚/全身等词才带下半身。
 * 会去人物库找这个人，按 angle / upperBody 选出对应的外貌与服装 tag 展开；
 * 找不到人就退回原名，不会让提示词变空。
 */
export function expandRosterCalls(text, scoped, mode) {
      return String(text ?? '').replace(/\$\{([\s\S]*?)\}\$/g, (_match, body) => {
        const source = String(body ?? '').trim()
        if (!source) return ''
        let parsed = null
        try { parsed = JSON.parse('{' + source + '}') } catch { return '' }
        if (!parsed || typeof parsed !== 'object') return ''
        const asked = String(parsed.name ?? parsed['名称'] ?? parsed['角色'] ?? '').trim()
        if (!asked) return ''
        const norm = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-.'"（）()]+/g, '')
        const key = norm(asked)
        const bits = []

        // ① 人物库
        const person = (scoped?.characters ?? []).find((ch) => {
          const nick = norm(ch.name)
          const alias = norm(String(ch.match ?? '').split(',')[0])
          return nick === key || alias === key || (alias && alias.includes(key)) || (key && key.includes(alias))
        })
        if (person) {
          const angle = String(parsed.angle ?? '').trim()
          const back = /back|behind|背面|背后/i.test(angle)
          const upper = String(parsed.upperBody ?? parsed.body ?? '').toLowerCase()
          const lower = String(parsed.lowerBody ?? '').toLowerCase()
          const nsfw = upper === 'nsfw' || lower === 'nsfw' || mode === 'all'
          const outfitName = String(parsed.outfit ?? parsed.clothes ?? parsed['服装'] ?? '').trim()
          const picked = characterTags(person, {
            nsfw,
            back,
            mode,
            outfitName: outfitName || undefined,
          })
          if (picked.tags.length) bits.push(...picked.tags)
          if (angle && /front|back|side|behind|left|right|from/i.test(angle)) bits.push(angle)
        }

        // ② 通用服装库（名字对得上就展开成服装 tag）
        if (!person) {
          const outfit = (scoped?.outfits ?? []).find((o) => norm(o.name) === key || norm(o.id) === key)
          if (outfit) {
            for (const field of ['upper', 'lower', 'shoes', 'accessory', 'full', 'back']) {
              const value = String(outfit[field] ?? '').trim()
              if (value) bits.push(value)
            }
          }
        }

        // ③ 都没有：保留原名（总比空着好）
        if (!bits.length) bits.push(asked)
        return bits.join(', ')
      })
    }

function characterTags(character, options = {}) {
  if (!character || character.enabled === false) return { tags: [], negative: [] }
  const traits = character.traits ?? {}
  const back = options.back === true
  const nsfw = options.nsfw === true || options.mode === 'all'
  const full = options.full !== false
  const keys = ['feature', back ? 'faceBack' : 'face']
  if (nsfw) {
    keys.push(back ? 'bodyNSFWBack' : 'bodyNSFW')
    if (full) keys.push(back ? 'lowerNSFWBack' : 'lowerNSFW')
  } else {
    keys.push(back ? 'bodySFWBack' : 'bodySFW')
    if (full) keys.push(back ? 'lowerSFWBack' : 'lowerSFW')
  }
  const tags = []
  const negative = []
  const negativeRaw = String(traits.negative ?? '').trim()
  if (negativeRaw) negative.push(negativeRaw)
  for (const key of keys) {
    const value = String(traits[key] ?? '').trim()
    if (value) tags.push(value)
  }
  for (const outfit of character.outfits ?? []) {
    if (outfit?.enabled === false) continue
    const isDefault = outfit.default === true
    if (options.outfitId) { if (outfit.id !== options.outfitId) continue }
    else if (!isDefault && (character.outfits ?? []).some(o => o.default && o.enabled !== false)) continue
    if (options.outfitName && outfit.name !== options.outfitName) continue
    for (const key of ['upper', 'lower', 'shoes', 'accessory', 'full']) {
      const value = String(outfit[key] ?? '').trim()
      if (value) tags.push(value)
    }
    if (options.back === true && String(outfit.back ?? '').trim()) tags.push(String(outfit.back).trim())
    if (outfit.negative) negative.push(String(outfit.negative).trim())
    break
  }
  return { tags, negative }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const deps = { llm: null, attachments: null, subagents: null, sessions: null }
  // 诊断用：DSH 往 index.html 注入的 script 行，就是客户端模块的加载清单
  const indexTap = { rows: null, at: 0, htmlLength: 0 }
  deps.indexTap = indexTap
  let runtime = null
  const ready = () => (runtime ??= createRuntime(ctx, config, logger, deps))

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], scoped => {
      const web = scoped.webServer
      if (!web || typeof web.tapIndex !== 'function') return
      const install = () => web.tapIndex(html => {
        try {
          const all = String(html).match(/<script[^>]*>/gi) || []
          indexTap.rows = all.filter(row => /rphub|wrongbook|client|module/i.test(row)).slice(0, 40)
          if (!indexTap.rows.length) indexTap.rows = all.slice(0, 25)
          indexTap.at = Date.now()
          indexTap.htmlLength = String(html).length
        } catch { /* 诊断失败不影响页面 */ }
        return html
      })
      if (typeof scoped.effect === 'function') scoped.effect(install, 'rphub-comfy: index tap (diagnostic)')
      else install()
    })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], scoped => { deps.llm = scoped.llm })
    // 上传照片要先把图片存成附件，模型才收得到
    ctx.inject(['attachments'], scoped => { deps.attachments = scoped.attachments })
    ctx.inject(['subagents'], scoped => { deps.subagents = scoped.subagents })
    // 正文由宿主直接读：这样不依赖任何前端的渲染钩子
  // runtime 懒建：第一次用到才创建（createRuntime 是函数声明，已提升，这里提前引用安全）

    ctx.inject(['sessions'], scoped => { deps.sessions = scoped.sessions })
    // Tavern 官方插件接口（宿主侧）：轮次事件、读正文与设定、挂媒体、提示词段落
    // Tavern 官方插件接口（宿主侧）：轮次事件、读正文与设定、挂媒体、提示词段落。
    // 装桥放在这里 —— 服务一到就装。不能放进 createRuntime：runtime 是懒建且只建一次的，
    // 服务没就绪时创建过那一次，之后桥就永远装不上了（2026-10-07 就是这么坏的）。
    ctx.inject(['tavern'], scoped => {
      const tavern = scoped.tavern
      deps.tavern = tavern
      if (!tavern || typeof tavern.attach !== 'function' || typeof tavern.promptSection !== 'function') {
        logger.warn?.('dsh-tavern-comfy: 当前 Tavern 没有插件接口（tavern.attach），生图链路退回旧方式')
        return
      }
      const install = () => {
        let disposed = false
        // ready() 是异步的：createRuntime 内部是 async IIFE，返回 Promise，必须 await。
        const boot = async () => {
          const engine = await ready()
          if (disposed) return
          try { logger.info?.('dsh-tavern-comfy: 官方桥 engine 导出键 = ' + Object.keys(engine ?? {}).join(',')) } catch {}
          deps.bridge = installTavernBridge({
            tavern,
            attachments: deps.attachments,
            engine: { planMessage: engine.planMessage, getJob: id => engine.getJob(id) },
            getConfig: () => engine.currentConfig(),
            logger,
            readFileAsBytes: async file => new Uint8Array(await readFile(file)),
            // 每轮结算时把「哪张卡、第几轮」记下来（官方接口给的 card，不用自己翻会话目录）
            onTurn: turn => deps.rememberTurn?.(turn?.gameId, turn?.turn, turn?.card),
            onTimeline: event => deps.rememberTimeline?.(event),
          })
          logger.info?.('dsh-tavern-comfy: Tavern 官方接口桥已安装')
        }
        boot().catch(error => logger.warn?.('dsh-tavern-comfy: 官方接口桥安装失败 ' + (error?.message ?? error)))
        // ctx.effect 只接受同步返回的清理函数，所以这里同步返回
        return () => { disposed = true; try { deps.bridge?.dispose?.() } catch {} }
      }
      if (typeof scoped.effect === 'function') scoped.effect(install, 'dsh-tavern-comfy: Tavern 官方接口桥')
      else { try { install() } catch (error) { logger.warn?.('dsh-tavern-comfy: 官方接口桥安装失败 ' + (error?.message ?? error)) } }
    })
  }

  const route = (path, handler) => {
    const install = () => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
        Promise.resolve(ready().then(engine => handler(request, response, url, engine)))
          .catch(error => {
            logger.error?.(`dsh-tavern-comfy: ${error?.message ?? error}`)
            if (!response.headersSent) sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
            else response.end()
          })
      },
    })
    if (typeof ctx.effect === 'function') ctx.effect(install, `dsh-tavern-comfy: ${path}`)
    else install()
  }

  route(`${BASE}/console`, serveConsole)
  route(`${BASE}/state`, (request, response, url, engine) => engine.handleConsole('state', request, response, url))
  route(`${BASE}/plugin-update`, (request, response, url, engine) => engine.handleConsole('plugin-update', request, response, url))
  route(`${BASE}/plugin-update/check`, (request, response, url, engine) => engine.handleConsole('plugin-update-check', request, response, url))
  route(`${BASE}/plugin-update/apply`, (request, response, url, engine) => engine.handleConsole('plugin-update-apply', request, response, url))
  route(`${BASE}/config`, (request, response, url, engine) => engine.handleConsole('config', request, response, url))
  route(`${BASE}/workflow`, (request, response, url, engine) => engine.handleConsole('workflow', request, response, url))
  route(`${BASE}/reload`, (request, response, url, engine) => engine.handleConsole('reload', request, response, url))
  route(`${BASE}/definitions`, (request, response, url, engine) => engine.handleConsole('definitions', request, response, url))
  route(`${BASE}/generate`, (request, response, url, engine) => engine.handleConsole('generate', request, response, url))
  route(`${BASE}/history`, (request, response, url, engine) => engine.handleConsole('history', request, response, url))
  route(`${BASE}/character-history`, (request, response, url, engine) => engine.handleConsole('character-history', request, response, url))
  route(`${BASE}/plan`, (request, response, url, engine) => engine.handleConsole('plan', request, response, url))
  route(`${BASE}/plans`, (request, response, url, engine) => engine.handleConsole('plans', request, response, url))
  route(`${BASE}/vision`, (request, response, url, engine) => engine.handleConsole('vision', request, response, url))
  route(`${BASE}/design`, (request, response, url, engine) => engine.handleConsole('design', request, response, url))
  route(`${BASE}/cancel`, (request, response, url, engine) => engine.handleConsole('cancel', request, response, url))
  route(`${BASE}/report`, (request, response, url, engine) => engine.handleConsole('report', request, response, url))
  route(`${BASE}/img`, (request, response, url, engine) => engine.handleConsole('img', request, response, url))
  route(`${BASE}/cards`, (request, response, url, engine) => engine.handleConsole('cards', request, response, url))
  route(`${BASE}/delete-job`, (request, response, url, engine) => engine.handleConsole('delete-job', request, response, url))
  route(`${BASE}/worldbook-import`, (request, response, url, engine) => engine.handleConsole('worldbook-import', request, response, url))
  route(`${BASE}/worldbook-entry`, (request, response, url, engine) => engine.handleConsole('worldbook-entry', request, response, url))
  route(`${BASE}/worldbook-add`, (request, response, url, engine) => engine.handleConsole('worldbook-add', request, response, url))
  route(`${BASE}/worldbook-export`, (request, response, url, engine) => engine.handleConsole('worldbook-export', request, response, url))
  route(`${BASE}/workflow-import`, (request, response, url, engine) => engine.handleConsole('workflow-import', request, response, url))
  route(`${BASE}/workflow-bindings`, (request, response, url, engine) => engine.handleConsole('workflow-bindings', request, response, url))
  route(`${BASE}/workflow-test`, (request, response, url, engine) => engine.handleConsole('workflow-test', request, response, url))
  route(`${BASE}/workflow-values`, (request, response, url, engine) => engine.handleConsole('workflow-values', request, response, url))
  route(`${BASE}/workflow-graph`, (request, response, url, engine) => engine.handleConsole('workflow-graph', request, response, url))
  route(`${BASE}/image-channel-test`, (request, response, url, engine) => engine.handleConsole('image-channel-test', request, response, url))
  route(`${BASE}/llm-models`, (request, response, url, engine) => engine.handleConsole('llm-models', request, response, url))
  route(`${BASE}/comfy-test`, (request, response, url, engine) => engine.handleConsole('comfy-test', request, response, url))
  route(`${BASE}/comfy-simple-info`, (request, response, url, engine) => engine.handleConsole('comfy-simple-info', request, response, url))
  route(`${BASE}/loras-available`, (request, response, url, engine) => engine.handleConsole('loras-available', request, response, url))
  route(`${BASE}/job-detail`, (request, response, url, engine) => engine.handleConsole('job-detail', request, response, url))
  route(`${BASE}/redraw`, (request, response, url, engine) => engine.handleConsole('redraw', request, response, url))
  route(`${BASE}/improve-prompt`, (request, response, url, engine) => engine.handleConsole('improve-prompt', request, response, url))
  route(`${BASE}/jobs`, (request, response, url, engine) => handleJobs(request, response, url, engine))
  // 手动配图：浏览器侧「🎨 生图」按钮走这条，链路和自动配图完全一致
  route(`${BASE}/attach-turn`, handleAttachTurn)

  registerImageTool(ctx, ready)
  // 已停用（改用 Tavern 官方 promptSection + attach 链路）：installImageToolHint(ctx)
  // 已停用（改用 Tavern 官方 promptSection + attach 链路）：installAutoImagePrompt(ctx, ready)
  logger.info?.('dsh-tavern-comfy: 已加载（控制台 ' + BASE + '/console）')
}

// =====================================================================
// 路由：控制台页面 / 作业
// =====================================================================

async function serveConsole(request, response, _url, engine) {
  if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  const html = await engine.consoleHtml()
  if (!html) { sendJson(response, 404, { ok: false, error: 'console.html 不存在' }); return }
  const body = Buffer.from(html, 'utf8')
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.byteLength, 'cache-control': 'no-store' })
  response.end(body)
}

/** 手动配图：把某一轮交给官方桥（规划 → 出图 → attach 进正文）。 */
async function handleAttachTurn(request, response, _url, engine) {
  if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  try {
    const body = await engine.readBody(request)
    const gameId = String(body?.gameId ?? '')
    const turn = Number(body?.turn ?? 0)
    if (!gameId || !Number.isFinite(turn) || turn < 1) { sendJson(response, 400, { ok: false, error: '需要 gameId 与 turn' }); return }
    const result = await engine.attachTurn({ gameId, turn })
    sendJson(response, 200, { ok: true, ...result })
  } catch (error) {
    sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
  }
}

async function handleJobs(request, response, url, engine) {
  if (request.method === 'POST') {
    const body = await engine.readBody(request)
    sendJson(response, 200, await engine.startJob(body, { label: String(body?.origin ?? '') }))
    return
  }
  if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
  const id = String(url.searchParams.get('id') ?? '')
  const key = String(url.searchParams.get('key') ?? '')
  let job = id ? engine.getJob(id) : engine.findJob(key)
  if (job) await engine.refresh(job)
  if (!job) { sendJson(response, 404, { ok: false, error: 'job-not-found' }); return }
  if (url.searchParams.get('image') === '1') { engine.sendImage(response, job, request.headers.range); return }
  sendJson(response, 200, { ok: true, job: engine.publicJob(job) })
}

// =====================================================================
// 生图工具：让前台模型写完正文后主动调一次
// =====================================================================

const TOOL_NAME = 'generate_scene_images'

function registerImageTool(ctx, ready) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['tools'], scoped => {
    const tools = scoped.tools
    const diag = { hasService: Boolean(tools), hasRegister: typeof tools?.register === 'function' }
    if (typeof globalThis !== 'undefined') globalThis.__rphubToolsDiag = diag
    if (!tools || typeof tools.register !== 'function') {
      diag.error = '没有 tools 服务'
      scoped.logger?.warn?.('dsh-tavern-comfy: 当前 DSH 没有 tools 服务，生图工具未注册')
      return
    }
    const definition = {
      name: TOOL_NAME,
      description: '为刚刚写好的这一轮正文生成插图。写完正文后调用一次，把正文原文原样传进来；'
        + '插件会在后台按当前卡片的设定与世界书规划画面、调用已配置的生图渠道，并把图插到正文对应句子后面。'
        + '没有开启生图或不需要配图时不要调用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '刚写好的正文原文（完整，不要摘要、不要改写）' },
          count: { type: 'number', description: '这一轮想要几张，留空则按插件设置' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            generated: { type: 'number' },
            note: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: String(value && value.note ? value.note : '已处理配图请求') }],
      },
      async execute(args, exec) {
        const engine = await ready()
        const input = args && typeof args === 'object' ? args : {}
        const body = String(input.text ?? '').trim()
        if (!body) return { ok: false, generated: 0, note: '没收到正文，无法配图' }
        const result = await engine.planFromTool({
          text: body,
          count: input.count,
          sessionId: exec?.agent?.id ? String(exec.agent.id) : '',
        })
        return result
      },
    }
    const install = () => {
      try {
        const dispose = tools.register(definition)
        diag.registered = true
        try {
          const found = typeof tools.get === 'function' ? tools.get(TOOL_NAME) : undefined
          diag.visible = Boolean(found)
        } catch (error) { diag.getError = String(error?.message ?? error) }
        try {
          if (typeof tools.schemas === 'function') {
            const names = (tools.schemas() ?? []).map(s => String(s?.name ?? ''))
            diag.totalTools = names.length
            diag.foundInSchemas = names.includes(TOOL_NAME)
          }
        } catch (error) { diag.schemasError = String(error?.message ?? error) }
        return dispose
      } catch (error) {
        diag.registerError = String(error?.message ?? error)
        throw error
      }
    }
    if (typeof scoped.effect === 'function') scoped.effect(install, 'dsh-tavern-comfy: ' + TOOL_NAME)
    else install()
  })
}

/** 告诉前台模型：写完正文后请调用生图工具。 */
function installImageToolHint(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['systemPrompt'], scoped => {
    const systemPrompt = scoped.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const register = () => systemPrompt.section({
      name: 'rphub-comfy:image-tool-hint',
      order: AUTO_SECTION_ORDER + 1,
      text: () => [
        '## 配图',
        '写这一轮正文**之前**，先把准备写的正文原文传给 ' + TOOL_NAME + ' 工具（参数 text）。',
        '工具会返回若干插图标记（形如 [[img:xxxxxxxx]]），每条都写明该插在哪句话之后。',
        '你把标记**原样**插进正文对应句子之后，再输出正文。标记会由界面渲染成图片。',
        '标记的写法一个字都不能改（不要加空格、不要翻译、不要解释它），也不要自己编造新的标记。',
        '正文其余部分照常写，不需要描述画面。',
      ].join('\n'),
    })
    if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-tavern-comfy: image tool hint')
    else register()
  })
}

// =====================================================================
// 自动生图提示词注入
// =====================================================================

function installAutoImagePrompt(ctx, ready) {
  if (typeof ctx.inject !== 'function') return
  // 拿到的就是运行时那个 config 对象本身，所以控制台一改开关，下一次装配立刻生效。
  let configRef = null
  ready()
    .then(engine => { configRef = engine.currentConfig() })
    .catch(error => ctx.logger?.warn?.('dsh-tavern-comfy: 自动生图规则未就绪：' + (error?.message ?? error)))
  ctx.inject(['systemPrompt'], scoped => {
    const systemPrompt = scoped.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      scoped.logger?.warn?.('dsh-tavern-comfy: 当前 DSH 没有 systemPrompt.section，自动生图规则未注入')
      return
    }
    const register = () => systemPrompt.section({
      name: AUTO_SECTION,
      order: AUTO_SECTION_ORDER,
      text: () => (configRef?.autoImageGen ? buildAutoImageGenPrompt(configRef.imageGenCount) : ''),
    })
    if (typeof scoped.effect === 'function') scoped.effect(register, 'dsh-tavern-comfy: auto image section')
    else register()
  })
}

// =====================================================================
// 引擎
// =====================================================================

function createRuntime(ctx, overrides, logger, deps) {
  const updater = createPluginUpdater({ root: ROOT })
  return (async () => {
    const config = await loadConfig(overrides)
    config.workflows = await scanWorkflows(config)
    let definitions = await loadDefinitions()
    let workflows = []
    const jobs = new Map()
    const byKey = new Map()

    // ---- 作业落盘：图文件本来就在 cache/ 里，缺的是这份元数据 ----
    const JOBS_STORE = join(ROOT, 'jobs-store.json')
    function restoreJobs() {
      return (async () => {
        try {
          const saved = await readJson(JOBS_STORE, null)
          if (saved && typeof saved === 'object') {
            const fileExists = async p => { try { await stat(p); return true } catch { return false } }
            for (const item of Object.values(saved)) {
              if (!item || !item.id) continue
              const job = Object.assign({}, item, { params: item.params ?? {} })
              // 老记录有两处会让取图永久 404，这里在内存里补正（不写回盘，每次启动重算）：
              //   ① file 指着改名前的 cache 目录（…\tools\rphub-comfy\cache\…），文件其实已搬到 dsh-tavern-comfy；
              //   ② byteLength 被早期兜底恢复写成了 0，而取图门槛正是 `if (!job.file || !job.byteLength)`。
              if (!job.file || !(await fileExists(job.file))) {
                for (const ext of ['.img', '.png', '.jpg', '.jpeg', '.webp']) {
                  const guess = join(cacheRoot(config), String(job.id) + ext)
                  if (await fileExists(guess)) { job.file = guess; break }
                }
              }
              if (job.file) {
                try {
                  const info = await stat(job.file)
                  if (info.size) {
                    job.byteLength = info.size
                    // 文件在就说明这一张已经画完了。重启后内存里不可能还留着真正在跑的作业，
                    // 而落盘时残留的 pending 会让 hasImage 判成 false —— 历史图列表里
                    // 明明有图却显示「没有」，缩略图也出不来。以文件为准修正状态。
                    if (job.state !== 'done') {
                      job.state = 'done'
                      job.percent = 100
                      job.error = undefined
                    }
                  }
                } catch { /* 文件真的不在就保持原样 */ }
              }
              if (!job.mediaType) {
                try { job.mediaType = imageMediaTypeFromBytes(await readFile(job.file)) || 'image/png' }
                catch { job.mediaType = 'image/png' }
              }
              if (job.backend && job.backend !== 'comfyui' && ['pending', 'running'].includes(job.state)) {
                job.state = 'failed'
                job.error = '插件重启中断了此渠道的请求，请手动重绘；未自动重试，以免重复计费'
              }
              // byKey 只在 startJob 里写过，重启后是空的 —— 而"同一个 key 只画一次"的去重
              // （InlineImage 先查 /jobs?key=、startJob 里 findJob(key)）全靠它。
              // 不重建的话，重启后同一段正文会被重复提交、重复作画。
              if (job.key) byKey.set(String(job.key), String(item.id))
              jobs.set(String(item.id), job)
            }
          }
        } catch { /* 读不到就当没有 */ }
        // 兜底：cache 目录里有图但没记录的，按"已完成"补回来
        try {
          const dir = cacheRoot(config)
          const names = await readdir(dir).catch(() => [])
          let added = 0
          for (const name of names) {
            const hit = /^([0-9a-f-]{36})\.(?:img|png|jpe?g|webp)$/i.exec(name)
            if (!hit) continue
            const id = hit[1]
            if (jobs.has(id)) continue
            let size = null
            // byteLength 必须填成文件的真实字节数：取图路由的门槛是 `if (!job.file || !job.byteLength)`，
            // 填 0 会让这个作业永远被判成「图片还没生成好」而返回 404 —— 列表里明明有图却打不开。
            let bytes = 0
            try {
              const buf = await readFile(join(dir, name))
              bytes = buf.length
              if (buf.length > 24 && buf[1] === 0x50 && buf[2] === 0x4e) size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
            } catch { /* 读不到尺寸就算了 */ }
            const cached = await readFile(join(dir, name)).catch(() => Buffer.alloc(0))
            jobs.set(id, { id, state: 'done', percent: 100, createdAt: Date.now(), file: join(dir, name), size, params: {}, label: '历史图片', byteLength: bytes, mediaType: imageMediaTypeFromBytes(cached) || (/\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png') })
            added++
          }
          if (added) logger.info?.('dsh-tavern-comfy: 从 cache 补回 ' + added + ' 张历史图片')
        } catch { /* 忽略 */ }
        if (jobs.size) logger.info?.('dsh-tavern-comfy: 作业记录共 ' + jobs.size + ' 条')
      })()
    }
    let jobsDirty = false
    let jobsWritePromise = Promise.resolve()
    function persistJobs() {
      jobsDirty = true
      jobsWritePromise = jobsWritePromise.then(async () => {
        if (!jobsDirty) return
        jobsDirty = false
        try {
          const entries = [...jobs.entries()].slice(-150)
          const plain = {}
          for (const [id, job] of entries) {
            plain[id] = {
              id: job.id, state: job.state, percent: job.percent ?? 0, createdAt: job.createdAt,
              workflowId: job.workflowId, outputNode: job.outputNode,
              file: job.file, size: job.size ?? null, params: job.params ?? {}, label: job.label ?? '',
              positive: job.positive ?? '', negative: job.negative ?? '',
              byteLength: job.byteLength ?? 0, mediaType: job.mediaType ?? '', seed: job.seed ?? null,
              error: job.error ?? undefined,
              // 落盘 key，重启后才能重建 byKey（见 restoreJobs）
              key: job.key ?? '',
              // 落盘 ComfyUI 作业号：重启后后台轮询才能接着把这批图取回来。
              // 不存的话，重启后这条作业永远停在 pending，图留在 ComfyUI 里没人认领。
              comfyId: job.comfyId ?? null,
              backend: job.backend ?? 'comfyui', channelId: job.channelId ?? '', channelName: job.channelName ?? '',
              imageOutputWarning: job.imageOutputWarning ?? '',
            }
          }
          await writeJsonAtomic(JOBS_STORE, plain)
        } catch { /* 落盘失败不影响生成 */ }
      })
      return jobsWritePromise
    }

    await mkdir(cacheRoot(config), { recursive: true })
    await restoreJobs()

    /** 一次性修复：插件目录里的数据文件如果带着只读属性，去掉它。 */
    async function fixReadonlyOnce() {
      const targets = ['worldbook.json', 'definitions.json', 'config.json', 'jobs-store.json', 'plans-store.json', 'characters.json']
      for (const name of targets) {
        const p = join(ROOT, name)
        try {
          const s = await stat(p)
          if (!(s.mode & 0o200)) {
            await chmod(p, 0o644)
            logger.info?.('dsh-tavern-comfy: 去掉了 ' + name + ' 的只读属性')
          }
        } catch { /* 文件不存在就跳过 */ }
      }
    }
    await fixReadonlyOnce().catch(() => {})

    async function loadAllWorkflows() {
      const loaded = []
      for (const entry of config.workflows) {
        try {
          const raw = await readJson(join(ROOT, String(entry.file)), null)
          if (!raw) throw new Error('文件不存在')
          if (raw.format !== 'dsh-tavern-comfy-v1') throw new Error('不是 dsh-tavern-comfy-v1 格式')
          if (!raw.prompt || !raw.outputNode || !raw.prompt[raw.outputNode]) throw new Error('缺少 prompt 或 outputNode')
          // 补全 bindings：老格式的工作流只绑了正负面，尺寸/步数/CFG/底模/LoRA 都要能读能改。
          // 用自动识别补齐缺的那几类，已有的不动（尊重手工设置）。
          try {
            const auto = detectWorkflow(raw.prompt).bindings
            const b = Object.assign({}, raw.bindings)
            for (const key of ['positive', 'negative', 'seed', 'batch', 'size', 'steps', 'cfg', 'model', 'loras']) {
              const has = Array.isArray(b[key]) ? b[key].length : 0
              const got = Array.isArray(auto[key]) ? auto[key].length : 0
              if (!has && got) b[key] = auto[key]
            }
            raw.bindings = b
          } catch { /* 补不了就算了，用原来的 */ }
          if (!(raw.bindings?.positive ?? []).length) throw new Error('没有 positive 映射，无法替换画面提示词')
          loaded.push({
            id: String(entry.id), label: entry.label || entry.id, match: Array.isArray(entry.match) ? entry.match : [],
            sizes: entry.sizes ?? null, enabled: entry.enabled !== false, file: String(entry.file),
            prompt: raw.prompt, bindings: raw.bindings ?? {}, outputNode: raw.outputNode, digest: raw.digest ?? '',
            summary: workflowSummary(raw), error: null,
          })
        } catch (error) {
          loaded.push({
            id: String(entry.id), label: entry.label || entry.id, match: Array.isArray(entry.match) ? entry.match : [],
            sizes: entry.sizes ?? null, enabled: entry.enabled !== false, file: String(entry.file),
            error: error?.message ?? String(error),
          })
        }
      }
      workflows = loaded
    }
    await loadAllWorkflows()

    if (!config.defaultWorkflow || !workflows.some(wf => wf.id === config.defaultWorkflow && !wf.error)) {
      const first = workflows.find(wf => !wf.error)
      if (first) config.defaultWorkflow = first.id
    }
    logger.info?.(`dsh-tavern-comfy: ${workflows.filter(wf => !wf.error).length} 份工作流可用，默认 ${config.defaultWorkflow || '（无）'}`)

    const usable = () => workflows.filter(wf => !wf.error && wf.enabled)

    async function comfyJson(pathname, init) {
      const response = await fetch(`${config.comfyUrl}${pathname}`, {
        ...init,
        headers: Object.assign({}, init?.headers ?? {}, comfyHeaders(config)),
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`ComfyUI ${pathname} → HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`)
      }
      return response.json()
    }

    let simpleObjectInfo = null
    let simpleObjectInfoAt = 0
    async function getSimpleObjectInfo(force = false) {
      if (!force && simpleObjectInfo && Date.now() - simpleObjectInfoAt < 15000) return simpleObjectInfo
      const result = await comfyJson('/object_info')
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ComfyUI /object_info 返回格式不正确')
      simpleObjectInfo = result
      simpleObjectInfoAt = Date.now()
      return result
    }

    async function submitToComfy(compiled) {
      const result = await comfyJson('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: compiled.prompt, prompt_id: randomUUID(), client_id: randomUUID() }),
      })
      if (result?.error || !result?.prompt_id) {
        const detail = result?.error ? JSON.stringify(result.error).slice(0, 600) : '未返回 prompt_id'
        throw new Error(`ComfyUI 拒绝了这个工作流：${detail}`)
      }
      return result.prompt_id
    }

    let refreshSeq = Promise.resolve()
    async function refresh(job) {
      if (['done', 'failed', 'cancelled'].includes(job.state)) return
      // 没有 ComfyUI 作业号的记录（老数据，或提交还没返回就重载了）不能去查：
      // /history/null 会 404，下面的 catch 会把这条作业误判成 failed。
      if (!job.comfyId) return
      const now = Date.now()
      if (now - job.queryAt < config.queryThrottleMs) return
      job.queryAt = now
      refreshSeq = refreshSeq.then(async () => {
        if (job.state === 'done' || job.state === 'failed') return
        try {
          const history = await comfyJson(`/history/${encodeURIComponent(job.comfyId)}`)
          const hit = history?.[job.comfyId]
          if (hit) {
            if (hit.status?.status_str === 'error') {
              job.state = 'failed'
              job.error = 'ComfyUI 执行失败，请检查服务器日志与工作流节点'
              return
            }
            if (hit.status?.completed || hit.status?.status_str === 'success') {
              const images = hit.outputs?.[job.outputNode]?.images
              if (!Array.isArray(images) || !images.length) {
                job.state = 'failed'
                job.error = '工作流没有在指定输出节点返回图片'
                return
              }
              const image = images[0]
              const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
              const response = await fetch(`${config.comfyUrl}/view?${params}`, { signal: AbortSignal.timeout(120000), headers: Object.assign({}, comfyHeaders(config)) })
              if (!response.ok) throw new Error(`ComfyUI /view → HTTP ${response.status}`)
              const bytes = Buffer.from(await response.arrayBuffer())
              if (!bytes.byteLength) throw new Error('ComfyUI 返回了空图片')
              if (bytes.byteLength > config.maxImageBytes) throw new Error('图片超过大小上限')
              const sourceType = response.headers.get('content-type')?.split(';')[0] || (/\.jpe?g$/i.test(image.filename) ? 'image/jpeg' : 'image/png')
              const signal = job.controller?.signal
              const output = await transcodeImageOutputAsync(bytes, sourceType, config, { maxOutputBytes: config.maxImageBytes, signal })
              if (signal?.aborted || job.state === 'cancelled') return
              job.mediaType = output.mediaType
              job.imageOutputWarning = output.warning || ''
              job.file = join(cacheRoot(config), `${job.id}.img`)
              await writeFile(job.file, output.bytes)
              if (signal?.aborted || job.state === 'cancelled') { await rm(job.file, { force: true }); return }
              job.byteLength = output.bytes.byteLength
              job.percent = 100
              job.state = 'done'
              job.completedAt = Date.now()
              if (output.warning) logger.warn?.(`dsh-tavern-comfy: 作业 ${job.id.slice(0, 8)} ${output.warning}`)
              logger.info?.(`dsh-tavern-comfy: 作业 ${job.id.slice(0, 8)} 完成（${job.workflowId}，${output.bytes.byteLength} 字节，seed ${job.seed}）`)
              return
            }
          }
          const queue = await comfyJson('/queue')
          const running = Array.isArray(queue?.queue_running) ? queue.queue_running : []
          const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : []
          const position = pending.findIndex(item => Array.isArray(item) && item[1] === job.comfyId)
          if (running.some(item => Array.isArray(item) && item[1] === job.comfyId)) { job.state = 'running'; job.queuePosition = 0 }
          else if (position >= 0) { job.state = 'pending'; job.queuePosition = position; job.queuedCount = pending.length }
          else job.state = 'running'
        } catch (error) {
          job.state = 'failed'
          job.error = error?.message ?? String(error)
        } finally {
          persistJobs()
        }
      }).catch(() => {})
      await refreshSeq
    }

    // ── 后台轮询 ──────────────────────────────────────────────────────
    // refresh() 原来只在"前端来查 /jobs?id="时被动跑一次（handleJobs 里那一处）。
    // 后果：用户一切走画面、刷新界面、或插件重载，就再没人去问 ComfyUI ——
    // 作业永远停在 pending，而图其实已经画好、躺在 ComfyUI 的 output 目录里没人取。
    // 这里补一个后台扫描：每 3 秒把所有"还没结束且知道 ComfyUI 作业号"的作业刷一遍。
    function startJobSweeper() {
      const timer = setInterval(() => {
        for (const job of jobs.values()) {
          if ((job.state === 'pending' || job.state === 'running') && job.comfyId) {
            refresh(job).catch(() => {})
          }
        }
      }, 3000)
      return () => clearInterval(timer)
    }
    if (typeof ctx.effect === 'function') ctx.effect(startJobSweeper, 'dsh-tavern-comfy: job sweeper')
    else startJobSweeper()

    let lastSessionId = ''
    const startingJobs = new Map()
    const imageQueue = []
    let imageRunning = 0
    let imageDisposed = false
    if (typeof ctx.effect === 'function') ctx.effect(() => () => {
      imageDisposed = true
      for (const job of jobs.values()) if (job.backend !== 'comfyui' && ['pending', 'running'].includes(job.state)) job.controller?.abort()
    }, 'dsh-tavern-comfy: image channels')

    function drainImages() {
      while (!imageDisposed && imageRunning < config.imageConcurrency && imageQueue.length) {
        const { job, channel, compiled, maxImageBytes } = imageQueue.shift()
        if (job.controller.signal.aborted || !jobs.has(job.id)) continue
        imageRunning++
        job.state = 'running'
        persistJobs()
        ;(async () => {
          try {
            const result = await generateImage(channel, {
              positive: compiled.positive, negative: compiled.negative, seed: compiled.seed,
              width: compiled.size.width, height: compiled.size.height, steps: job.params.steps, cfg: job.params.cfg,
            }, { signal: job.controller.signal, maxImageBytes })
            job.controller.signal.throwIfAborted()
            if (!jobs.has(job.id)) return
            const output = await transcodeImageOutputAsync(result.bytes, result.mediaType, config, { maxOutputBytes: maxImageBytes, signal: job.controller.signal })
            job.controller.signal.throwIfAborted()
            const file = join(cacheRoot(config), `${job.id}.img`)
            await writeFile(file, output.bytes)
            if (job.controller.signal.aborted || !jobs.has(job.id)) { await rm(file, { force: true }); return }
            Object.assign(job, { file, mediaType: output.mediaType, byteLength: output.bytes.length, imageOutputWarning: output.warning || '', percent: 100, state: 'done', completedAt: Date.now() })
            if (output.warning) logger.warn?.(`dsh-tavern-comfy: 作业 ${job.id.slice(0, 8)} ${output.warning}`)
          } catch (error) {
            if (job.controller.signal.aborted) { job.state = 'cancelled'; job.error = '请求已停止；平台可能已开始生成，请在平台确认用量' }
            else { job.state = 'failed'; job.error = error?.message ?? '生图渠道请求失败' }
          } finally {
            imageRunning--
            persistJobs()
            drainImages()
          }
        })()
      }
    }

    function startJob(rawParams, options = {}) {
      const key = typeof rawParams?.key === 'string' ? rawParams.key.slice(0, 4000) : ''
      if (key && startingJobs.has(key)) return startingJobs.get(key)
      const pending = createJob(rawParams, options)
      if (key) {
        startingJobs.set(key, pending)
        pending.finally(() => { if (startingJobs.get(key) === pending) startingJobs.delete(key) }).catch(() => {})
      }
      return pending
    }

    async function createJob(rawParams, { label = '', forceWorkflow = null } = {}) {
      // 浏览器半边只传 tag 和 key，其余（画师串、画幅）由控制台配置兜底。
      const params = {
        tag: String(rawParams?.tag ?? ''),
        // 展开前的原始提示词（含 ${...}$ 宏），编辑器里显示这个 —— 一眼能看出调用了谁
        rawTag: String(rawParams?.rawTag ?? rawParams?.tag ?? ''),
        artist: rawParams?.artist ? String(rawParams.artist) : activeArtistText(config).text,
        artistPosition: rawParams?.artist ? undefined : activeArtistText(config).position,
        negative: String(rawParams?.negative ?? ''),
        size: String(rawParams?.size || config.imageSize || '竖图'),
        model: String(rawParams?.model ?? ''),
        steps: rawParams?.steps,
        cfg: rawParams?.cfg,
      }
      if (rawParams?.sessionId) lastSessionId = String(rawParams.sessionId)
      const key = typeof rawParams?.key === 'string' ? rawParams.key.slice(0, 4000) : ''
      if (key) {
        const existing = findJob(key)
        if (existing && (existing.state === 'pending' || existing.state === 'running' || existing.state === 'done')) return publicJob(existing)
      }
      const channel = forceWorkflow ? null : activeChannel(config)
      let workflow = forceWorkflow || (!channel && config.comfyMode === 'simple' ? null : (!channel ? pickWorkflow(usable(), config, params.model) : null))
      let simpleBuild = null
      if (!channel && !forceWorkflow && config.comfyMode === 'simple') {
        simpleBuild = buildComfySimpleWorkflow(config.comfySimple, await getSimpleObjectInfo())
        workflow = simpleBuild.workflow
        // Simple mode owns its dimensions. Keep the old default size dropdown from rewriting them.
        params.size = `${simpleBuild.config.width}x${simpleBuild.config.height}`
      }
      if (!channel && !workflow) throw new Error('没有可用的工作流（检查控制台「画风」页）')
      const defsForTurn = applyCharacterSnapshot(definitions, rawParams?.characterSnapshot)
      const card = await currentCard(rawParams?.sessionId || lastSessionId, rawParams?.turn)
      const scopedDefs = card
        ? { ...defsForTurn, characters: (defsForTurn.characters ?? []).filter(character => usableOnCard(character, card)) }
        : defsForTurn
        // 这里可以打日志（runtime 里能拿到 logger）
      const compileConfig = forceWorkflow
        ? { ...config, imageBackend: 'comfyui', comfyMode: 'workflow' }
        : (simpleBuild ? { ...config, overrideSteps: false } : config)
      const compiled = workflow ? compileJob({ workflow, params, config: compileConfig, definitions: scopedDefs })
        : compileChannelJob({ params, config, definitions: scopedDefs })

      // 这里在 runtime 内，可以打日志
      if (compiled?.loras?.length) {
        logger.info?.('dsh-tavern-comfy: 本张用了 ' + compiled.loras.length + ' 个 LoRA：' +
          compiled.loras.map(x => x.name + (x.off ? '(关)' : '(' + (Number.isFinite(x.model) ? x.model : 1) + ')')).join('、'))
      }
      const control = new AbortController()
      const job = {
        id: randomUUID(), comfyId: null, workflowId: workflow?.id ?? '', outputNode: workflow?.outputNode,
        backend: channel?.provider ?? 'comfyui', channelId: channel?.id ?? '', channelName: channel?.name ?? '',
        state: 'pending', percent: 0, seed: compiled.seed, createdAt: Date.now(), queryAt: 0,
        params: { ...params }, key, size: compiled.size, hits: compiled.hits,
        // 记住这张用了哪些 LoRA —— 事后在历史里能查
        loras: Array.isArray(compiled.loras) ? compiled.loras : [],
        positive: compiled.positive, negative: compiled.negative, label, controller: control,
      }
      jobs.set(job.id, job)
    try { persistJobs() } catch {}
      if (key) byKey.set(key, job.id)
      if (channel) {
        imageQueue.push({ job, channel, compiled, maxImageBytes: config.maxImageBytes })
        drainImages()
        sweep()
        return publicJob(job)
      }
      try {
        job.comfyId = await submitToComfy(compiled)
        logger.info?.(`dsh-tavern-comfy: 已提交 ${job.id.slice(0, 8)}（${workflow.id}${compiled.size ? `，${compiled.size.width}x${compiled.size.height}` : ''}，seed ${compiled.seed}${compiled.hits.length ? `，人物库 ${compiled.hits.join('/')}` : ''}）`)
      } catch (error) {
        job.state = 'failed'
        job.error = error?.message ?? String(error)
        logger.error?.(`dsh-tavern-comfy: 提交失败 ${job.id.slice(0, 8)}：${job.error}`)
      }
      // 提交返回后的 ComfyUI 作业号也要保存，重载后后台扫描才能认领队列结果。
      persistJobs()
      sweep()
      return publicJob(job)
    }

    function findJob(key) {
      if (!key) return null
      const id = byKey.get(key)
      return id ? jobs.get(id) ?? null : null
    }

    function getJob(id) { return jobs.get(id) ?? null }

    // ---- 生图规划：agent 生图 ----
    // 规划默认跟随 Tavern 的「默认后台模型」（和 MVU 结算共用一套配置）；
    // 控制台里填了 provider/model 就用填的那个。
    //
    // 这里以前是直接读 data/tavern-settings.json 里的 defaultBackgroundModel。
    // 现在走官方接口 tavern.backgroundModel({ gameId }) —— 不碰 Tavern 的数据文件，
    // Tavern 以后调整存储结构也不会影响这里。
    async function backgroundModel(gameId) {
      const id = String(gameId ?? '').trim()
      if (!id) return null
      if (!deps.tavern || typeof deps.tavern.backgroundModel !== 'function') return null
      try {
        const picked = await deps.tavern.backgroundModel({ gameId: id })
        if (picked && picked.provider && picked.model) {
          return { provider: String(picked.provider), model: String(picked.model), source: 'tavern' }
        }
      } catch { /* 拿不到就当没有，让调用方去用插件自己配的模型 */ }
      return null
    }

    // ---- 当前会话用的是哪张卡（角色可以按卡过滤）----
    //
    // 这里以前是遍历 data/resources/.tavern/sessions/*/context.json 去找卡。
    // 现在只用官方接口给的东西：onTurnSettled / getTurn 的回调里本来就带
    // card: { id, name }，每轮结算时顺手记下来就够了 —— 每一轮都会刷新它，
    // 所以「当前卡」总是跟着最新一轮走，不用自己去翻别人的会话目录。
    const cardCache = new Map()   // gameId → { path, name }
    const lastTurn = new Map()    // gameId → 最近一轮的轮次号

    /** 记住一轮的卡与轮次（tavern-bridge 在每轮结算时调用）。 */
    function rememberTurn(gameId, turn, card) {
      const id = String(gameId ?? '').trim()
      if (!id) return
      const t = Number(turn)
      if (Number.isSafeInteger(t) && t > 0) lastTurn.set(id, t)
      if (card && (card.id || card.name)) {
        cardCache.set(id, { path: String(card.id ?? ''), name: String(card.name ?? '') })
      }
      // 只留最近的会话，换卡很频繁时不会一直涨
      if (cardCache.size > 30) {
        for (const k of cardCache.keys()) { cardCache.delete(k); if (cardCache.size <= 20) break }
      }
    }
    // 挂到 deps 上再给外面用：installTavernBridge 是在 createRuntime **之外**装配的
    // （ctx.inject 的回调里），那边直接引用这个函数会是 ReferenceError，而且会被
    // bridge 的 try/catch 静默吞掉 —— 表现成「功能不工作但没有任何报错」。
    deps.rememberTurn = rememberTurn

    /** Timeline events invalidate stale card/turn observations; a supplied turn is the only safe new anchor. */
    function rememberTimeline(event) {
      const id = String(event?.gameId ?? '').trim()
      if (!id) return
      cardCache.delete(id)
      lastTurn.delete(id)
      const turn = Number(event?.turn)
      if (Number.isSafeInteger(turn) && turn > 0) lastTurn.set(id, turn)
    }
    deps.rememberTimeline = rememberTimeline

    /** 拿这一轮（不传就用最近一轮）的卡；只认官方接口，拿不到就返回 null。 */
    async function currentCard(sessionId, turn) {
      const id = String(sessionId ?? '').trim()
      if (!id) return null
      const want = Number(turn)
      const known = lastTurn.get(id)
      // 没要求换一轮时，缓存就够用（省掉一次 getTurn）
      if (!(Number.isSafeInteger(want) && want > 0 && want !== known)) {
        const cached = cardCache.get(id)
        if (cached) return cached
      }
      const target = (Number.isSafeInteger(want) && want > 0) ? want : known
      if (target && deps.tavern && typeof deps.tavern.getTurn === 'function') {
        try {
          const snapshot = await deps.tavern.getTurn({ gameId: id, turn: target })
          if (snapshot?.card && (snapshot.card.id || snapshot.card.name)) {
            const found = { path: String(snapshot.card.id ?? ''), name: String(snapshot.card.name ?? '') }
            cardCache.set(id, found)
            return found
          }
        } catch { /* 这一轮拿不到就退回缓存 */ }
      }
      return cardCache.get(id) ?? null
    }

    /** 这个角色在这张卡下可用吗（没绑卡的全局角色一直可用）。 */
    function usableOnCard(character, card) {
      const cards = character.cards ?? []
      if (!cards.length) return true
      // 拿不到"当前卡"时不过滤 —— 否则绑过卡的角色会全军覆没（曾经因此整库失效）
      if (!card) return true
      const path = String(card.path ?? '')
      const name = String(card.name ?? '')
      const bare = path.replace(/^.*\//, '').replace(/\.json$/i, '')
      return cards.some(entry => {
        if (!entry) return false
        const e = String(entry)
        const eBare = e.replace(/^.*\//, '').replace(/\.json$/i, '')
        if (path.endsWith(e) || e.endsWith(path) || path.includes(e) || e.includes(path)) return true
        // 卡名匹配：会话里的 name 和绑定项里的文件名算同一个人
        // （例如会话叫《某卡》，绑定项写的是《某卡_MVU版本》）
        if (name && (name === e || eBare === name || eBare.includes(name) || name.includes(eBare))) return true
        if (bare && (bare === e || eBare === bare || eBare.includes(bare) || bare.includes(eBare))) return true
        return false
      })
    }

    /**
     * 当前卡的设定 + 这一轮真正绑定的世界书条目 —— 走 Tavern 官方接口。
     *
     * 这里以前是自己读卡文件（readCardData）+ 拿正文去**猜**哪几条世界书该命中
     * （关键词包含 + 常驻标记），还要自己剥托管格式的两层包装。
     * 现在交给 tavern.getCardContext({ gameId, turn })：
     *   · description / personality / scenario 已经做过度宏投影
     *   · lore 是 Tavern 自己按这一轮算出来的绑定结果
     * 比插件手写的关键词匹配准，而且不碰用户的任何卡片文件。
     *
     * 拿不到轮次（比如刚从控制台点进来、这一局还没聊过）就返回 null。
     */
    async function cardContextRaw(sessionId, turn) {
      const id = String(sessionId ?? '').trim()
      if (!id || !deps.tavern || typeof deps.tavern.getCardContext !== 'function') return null
      const want = Number(turn)
      const target = (Number.isSafeInteger(want) && want > 0) ? want : lastTurn.get(id)
      if (!target) return null
      try { return await deps.tavern.getCardContext({ gameId: id, turn: target }) } catch { return null }
    }

    // 世界书的写操作排队执行：调试时每次按键都会触发保存，串起来就不会互相 rename 撞车
    let worldbookWriteChain = Promise.resolve()
    function queueWorldbookWrite(task) {
      const next = worldbookWriteChain.then(task, task)
      worldbookWriteChain = next.catch(() => {})
      return next
    }

    /** 读世界书文件（保留 enabled 标记），返回 { name, entries }。 */
    async function loadWorldbook() {
      let raw = await readJson(join(ROOT, 'worldbook.json'), null)
      // 首次运行：worldbook.json 是使用者自己的数据，不进公开仓库。
      // 仓库另外带了一份「通用生图规则」当种子 —— 只在 worldbook.json
      // 不存在时生成一次，之后永不覆盖（用户改过的条目必须原样留住）。
      if (!raw) {
        const seed = await readJson(join(ROOT, '世界书-通用生图规则.json'), null)
        const seeded = seed ? normalizeWorldbook(seed) : null
        if (seeded && seeded.entries.length) {
          raw = seeded
          try {
            await writeJsonSafe(join(ROOT, 'worldbook.json'), seeded, join(ROOT, 'backups'))
            logger.info?.('dsh-tavern-comfy: 首次运行，已用通用规则生成默认世界书（' + seeded.entries.length + ' 条）')
          } catch (error) {
            logger.warn?.('dsh-tavern-comfy: 默认世界书落盘失败 ' + (error?.message ?? error))
          }
        }
      }
      const norm = raw ? normalizeWorldbook(raw) : null
      return norm ?? { name: '生图世界书', entries: [] }
    }

    let worldbookCache = null
    async function worldbook() {
      if (!worldbookCache) {
        const wb = await loadWorldbook()
        // 统一成 worldbookEntries 的形状（index / comment / content / length）
        worldbookCache = wb.entries.map((e, index) => ({
          index, comment: e.comment, content: e.content, length: e.content.length,
          enabled: e.enabled !== false,
        }))
      }
      return worldbookCache
    }

    const plansByMessage = new Map()
    // 计划落盘：重启 DSH 之后已经生成过的插图位置还能恢复
    const PLANS_STORE = join(ROOT, 'plans-store.json')
    try {
      const saved = await readJson(PLANS_STORE, null)
      if (saved && typeof saved === 'object') {
        for (const [key, value] of Object.entries(saved)) plansByMessage.set(key, value)
        logger.info?.('dsh-tavern-comfy: 恢复了 ' + plansByMessage.size + ' 条插图计划')
      }
    } catch { /* 读不到就当没有 */ }
    // 串行写盘：写完一条再写下一条，进程退出前也能落住（之前用 setTimeout 延迟写，结果文件根本没生成）
    let plansWriteChain = Promise.resolve()
    let plansDirty = false
    function persistPlans() {
      plansDirty = true
      plansWriteChain = plansWriteChain.then(async () => {
        if (!plansDirty) return
        plansDirty = false
        try {
          const entries = [...plansByMessage.entries()]
            .filter(([, value]) => value && Array.isArray(value.plans) && value.plans.length)
            .slice(-80)
          await writeJsonAtomic(PLANS_STORE, Object.fromEntries(entries))
          logger.info?.('dsh-tavern-comfy: 插图计划已落盘（' + entries.length + ' 条）')
        } catch (error) {
          logger.warn?.('dsh-tavern-comfy: 插图计划落盘失败 ' + (error?.message ?? error))
        }
      })
      return plansWriteChain
    }

    // ---- 后台任务表：让界面看得见"正在后台跑什么"，并且能取消 ----
    // 浏览器半边发回来的执行报告（诊断用：前端到底跑没跑、错在哪）
    const clientReports = []
    // 高频上报（每条消息渲染都会来一次）不写日志，只在有意义的阶段写
    const QUIET_STAGES = new Set(['renderer-takeover', 'host-plans-query', 'bundle-evaluated', 'seat-registered'])
    function addClientReport(entry) {
      const stage = String(entry?.stage ?? '')
      const isFail = /-fail$/.test(stage)
      clientReports.push(entry)
      if (clientReports.length > 80) clientReports.shift()
      // 失败类永远写日志（不受高频静音影响，也不怕被 80 条上限挤掉）
      if (isFail) {
        logger.warn?.('dsh-tavern-comfy: [client-fail] ' + stage + ' ' + JSON.stringify(entry.data ?? {}).slice(0, 900))
        return
      }
      if (QUIET_STAGES.has(stage)) return
      logger.info?.('dsh-tavern-comfy: [client] ' + stage + ' ' + JSON.stringify(entry.data ?? {}).slice(0, 400))
    }

    const tasks = new Map()
    function beginTask(kind, label) {
      const task = { id: randomUUID(), kind, label, startedAt: Date.now(), state: 'running', controller: new AbortController() }
      tasks.set(task.id, task)
      if (tasks.size > 40) {
        for (const [id, item] of tasks) {
          if (tasks.size <= 40) break
          if (item.state !== 'running') tasks.delete(id)
        }
      }
      return task
    }
    function finishTask(task, error) {
      if (task.state === 'cancelled') return
      task.state = error ? 'failed' : 'done'
      task.error = error ? String(error?.message ?? error) : ''
      task.finishedAt = Date.now()
    }
    function cancelTask(id) {
      const task = tasks.get(String(id))
      if (!task || task.state !== 'running') return false
      task.state = 'cancelled'
      task.error = '已取消'
      task.finishedAt = Date.now()
      try { task.controller.abort(new Error('用户取消')) } catch {}
      return true
    }
    function publicTasks() {
      return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(task => ({
        id: task.id, kind: task.kind, label: task.label, state: task.state,
        startedAt: task.startedAt, finishedAt: task.finishedAt ?? null, error: task.error ?? '',
      }))
    }

    async function planMessage({ text, messageId, turn, textVersion, count, sessionId, manual, force, smartSelection, imageGeneration = true, characterUpdates = false, historySnapshot, signal, onPlan, reusePlan }) {
      signal?.throwIfAborted()
      if (config.plannerEnabled === false && !manual && !characterUpdates) throw new Error('生图规划没打开（控制台 → 高级设置）')
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务，无法做生图规划')
      const fallback = await backgroundModel(sessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      if (!provider || !model) throw new Error('规划用的模型没定：Tavern 设置里的「默认后台模型」是空的，或者在本插件设置里单独指定一个')
      const body = String(text ?? '').trim()
      if (!body) throw new Error('正文是空的')

      const entries = await worldbook()
      const rules = rulesFromEntries(entries, config.plannerEntries)
      const card = await currentCard(sessionId, turn)
      const timelineDefinitions = applyCharacterSnapshot(definitions, historySnapshot)
      let visualSnapshot = historySnapshot ?? emptyCharacterSnapshot()
      const scoped = {
        ...timelineDefinitions,
        characters: (timelineDefinitions.characters ?? []).filter(character => usableOnCard(character, card)),
      }
      const roster = characterRoster(scoped, { fullTraits: characterUpdates })
      const want = imageGeneration ? Math.max(1, Math.min(8, Number(count) || config.plannerCount || 3)) : 0
      const smart = Boolean(imageGeneration && smartSelection && !force)
      // 生图只依赖两样：正文本身，和「生成图片的世界书」+ 人物库。
      // 卡片自己的世界书是给叙事用的（NPC生成/宗门生成那类规则），掺进画面提示词只会带偏。
      const guidanceWorkflow = config.imageBackend === 'comfyui' && config.comfyMode !== 'simple'
        ? usable().find(item => item.id === config.defaultWorkflow)
        : null
      const guidanceBackend = promptBackendContext(config, guidanceWorkflow)
      const guidance = getPromptGuidance(config, guidanceBackend)
      const system = buildPlannerSystem({ rules, roster, count: want, extra: [config.plannerExtra, guidance].filter(Boolean).join('\n\n'), smartSelection: smart, characterUpdates, force: Boolean(force || manual) })

      const task = beginTask('规划', imageGeneration ? '正文配图 · 最多 ' + want + ' 张' : '角色视觉历史更新')
      const abort = () => task.controller.abort(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const started = Date.now()
      logger.info?.('dsh-tavern-comfy: 开始规划（' + provider + '/' + model + (config.plannerProvider ? '，插件指定' : '，跟随 Tavern 后台模型') + '，规则 ' + rules.length + ' 字）')
      const plans = []
      const seen = new Set()
      let submitChain = Promise.resolve()
      let submitError = null
      let streamed = ''
      let streamDecision = ''
      let historyWarning = ''
      let storyApplied = !characterUpdates
      const applyStoryBlock = source => {
        const parsedStory = parsePlannerDecision(source)
        if (!parsedStory.characterUpdatesPresent) return false
        storyApplied = true
        if (!parsedStory.characterUpdatesValid) {
          historyWarning = '角色更新 JSON 无法解析；本轮沿用之前的外貌快照'
          visualSnapshot = { ...visualSnapshot, warning: historyWarning }
        } else {
          try {
            const merged = mergeCharacterUpdates(visualSnapshot, scoped, parsedStory.characterUpdates, { turn, textVersion, at: Date.now() })
            visualSnapshot = boundCharacterSnapshot({ ...merged.snapshot, gameId: String(sessionId ?? ''), turn: Number(turn) || 0, textVersion: String(textVersion ?? '') })
          } catch (error) {
            historyWarning = String(error?.message ?? error)
            visualSnapshot = { ...visualSnapshot, warning: historyWarning }
            try { visualSnapshot = boundCharacterSnapshot({ ...visualSnapshot, gameId: String(sessionId ?? ''), turn: Number(turn) || 0, textVersion: String(textVersion ?? '') }) } catch {}
          }
          const updated = applyCharacterSnapshot(definitions, visualSnapshot)
          scoped.characters = updated.characters.filter(character => usableOnCard(character, card))
        }
        return true
      }
      // 只提交已经闭合的 <image> 块；提交仍排队，ComfyUI 保持自己的 GPU 执行队列。
      // 第一张可以在模型继续规划后续画面时开画，无需等整份规划结束。
      const submitImages = images => {
        for (const image of images) {
          if (smart && streamDecision !== 'draw') continue
          const identity = JSON.stringify([image.mount, image.prompts])
          if (seen.has(identity) || seen.size >= want) continue
          seen.add(identity)
          submitChain = submitChain.then(async () => {
            task.controller.signal.throwIfAborted()
            const key = ('plan|' + (messageId ?? '') + '|' + image.mount + '|' + image.prompts).slice(0, 3800)
            const job = await startJob({
              tag: normalizePrompts(expandRosterCalls(image.prompts, scoped, config.traitMode), scoped),
              rawTag: image.prompts, size: image.size, key, sessionId, turn, textVersion, characterSnapshot: visualSnapshot,
            }, { label: 'agent 规划' })
            const item = { ...image, jobId: job.id, status: job.status, sizeText: job.size ? job.size.width + 'x' + job.size.height : '' }
            plans.push(item)
            task.controller.signal.throwIfAborted()
            onPlan?.(item)
          }).catch(error => { submitError ||= error })
        }
      }
      let result = { text: '', usage: null, failure: null }
      let failure = null
      try {
        const cached = reusePlan && !smart && !characterUpdates && messageId ? plansByMessage.get(String(messageId)) : null
        if (cached?.plans?.length && !cached.error) {
          submitImages(cached.plans)
        } else result = await runPlanner(deps.llm, {
          provider,
          model,
          system,
          text: body,
          temperature: Number(config.plannerTemperature) || 1,
          signal: task.controller.signal,
          onDelta: delta => {
            streamed += delta
            if (characterUpdates && !storyApplied && /<\/character_updates>/i.test(streamed)) applyStoryBlock(streamed)
            if (smart) streamDecision = parsePlannerDecision(streamed).decision
            // Smart automatic plans may incur a paid request, so wait until the
            // complete response has one valid decision before submitting any image.
            if (!smart && (!characterUpdates || storyApplied)) submitImages(parseImagePlan(streamed))
          },
        })
      } catch (error) {
        failure = error
      }
      const plannerOutput = result.text || streamed
      const parsed = parsePlannerDecision(plannerOutput)
      if (characterUpdates && !storyApplied) {
        if (parsed.characterUpdatesPresent) applyStoryBlock(result.text || streamed)
        else {
          storyApplied = true
          historyWarning = '规划结果缺少角色更新块；本轮沿用之前的外貌快照'
          visualSnapshot = { ...visualSnapshot, warning: historyWarning }
        }
      }
      let skipped = false
      if (smart && !['draw', 'skip'].includes(parsed.decision)) failure ||= new Error('规划结果缺少明确的 draw/skip 决定')
      const plannedImages = parseImagePlan(plannerOutput)
      if (smart && !parsed.reason) failure ||= new Error('智能配图决定必须说明原因')
      if (smart && parsed.decision === 'skip' && plannedImages.length) failure ||= new Error('skip 决定与 image 块冲突，未提交图片')
      if (smart && parsed.decision === 'draw' && !plannedImages.length) failure ||= new Error('选择配图后没有返回可用的 <image> 块')
      streamDecision = parsed.decision
      if (smart) {
        if (parsed.decision === 'skip' && !failure && !result.failure) skipped = true
        if (parsed.decision === 'draw' && !failure && !result.failure) submitImages(plannedImages)
      } else if (imageGeneration) submitImages(plannedImages)
      await submitChain
      signal?.removeEventListener('abort', abort)
      failure ||= submitError || (result.failure ? new Error(result.failure) : null)
      if (task.controller.signal.aborted) {
        const error = task.controller.signal.reason || new Error('规划被取消')
        finishTask(task, error)
        throw error
      }
      if (imageGeneration && !skipped && !plans.length) failure ||= new Error('模型没有返回可用的 <image> 块')
      if (smart && parsed.decision === 'draw' && !plans.length) failure ||= new Error('选择配图后没有返回可用的 <image> 块')
      finishTask(task, failure)
      logger.info?.('dsh-tavern-comfy: 规划用了 ' + ((Date.now() - started) / 1000).toFixed(1) + 's，已提交 ' + plans.length + ' 张'
        + (result.usage ? '（token ' + result.usage.inputTokens + '+' + result.usage.outputTokens + '）' : ''))

      const characterSnapshot = characterUpdates ? visualSnapshot : null
      const plan = { messageId: String(messageId ?? ''), turn, at: Date.now(), plans, skipped, reason: parsed.reason, characterSnapshot, historyWarning, raw: plans.length ? '' : String(result.text || streamed).slice(0, 4000), card: card?.name ?? null }
      if (failure) plan.error = String(failure?.message ?? failure)
      if (messageId) plansByMessage.set(String(messageId), plan)
        persistPlans()
      try { addClientReport({ at: Date.now(), stage: 'host-plans-store', data: { id: String(messageId).slice(0, 14), plans: plan.plans ? plan.plans.length : 0, mapSize: plansByMessage.size } }) } catch {}
      return plan
    }

    // 这里以前有个 ensureInlineRegex()：每次规划都往「用户正在玩的那张卡」的
    // regex_scripts 里塞一条把 [[img:key]] 换成 <img> 的显示正则。
    //
    // 现在整块删掉了，原因有两个：
    //   1. 图由 Tavern 官方的 tavern.attach 渲染（宿主侧按 anchor 挂、跟正文版本绑定），
    //      插件这边不再需要任何显示正则；
    //   2. 直接改用户的卡文件会绕过 Tavern 的卡片管理与备份 —— 那是别人的数据，
    //      插件没有理由去写它。

    /** 从会话里读某条消息的正文（不传 messageId 就取最后一条助手消息）。 */
    function messageTextFrom(sessionId, messageId) {
      try {
        const session = deps.sessions?.get?.(sessionId)
        if (!session || typeof session.deriveMessages !== 'function') return ''
        const messages = session.deriveMessages() ?? []
        let target = null
        if (messageId) target = messages.find(item => String(item?.id) === String(messageId)) ?? null
        if (!target) {
          const assistants = messages.filter(item => item?.role === 'assistant')
          target = assistants[assistants.length - 1] ?? messages[messages.length - 1] ?? null
        }
        if (!target) return ''
        return (target.content ?? [])
          .filter(block => block && block.type === 'text')
          .map(block => String(block.text ?? ''))
          .join('')
      } catch (error) {
        logger.warn?.('dsh-tavern-comfy: 读消息正文失败 ' + (error?.message ?? error))
        return ''
      }
    }

    /** 用「角色与服装设计规范」让 agent 产出 <人物> / <服装>。 */
    async function designCharacters({ brief, sessionId, useCard, photo, current }) {
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务')
      const rules = await readFile(join(ROOT, 'design-rules.md'), 'utf8').catch(() => '')
      if (!rules) throw new Error('读不到 design-rules.md')
      const fallback = await backgroundModel(sessionId)
      const provider = config.plannerProvider || fallback?.provider || ''
      const model = config.plannerModel || fallback?.model || ''
      if (!provider || !model) throw new Error('没定用哪个模型（Tavern 后台模型是空的，就来本插件设置里指定一个）')

      let context = ''
      if (useCard !== false) {
        const card = await currentCard(sessionId)
        // 卡设定走官方接口（已做宏投影），不再自己读卡文件
        const data = await cardContextRaw(sessionId)
        if (data) {
          context = [
            '【当前卡】' + (card?.name ?? ''),
            String(data.description ?? '').slice(0, 4000),
            String(data.personality ?? '').slice(0, 1200),
            String(data.scenario ?? '').slice(0, 1500),
          ].filter(Boolean).join('\n')
        }
      }

      // 有参考图就先让视觉模型描述它，作为设计依据
      let photoNote = ''
      if (photo?.data) {
        try {
          const seen = await describePhoto({ data: photo.data, mediaType: photo.mediaType, name: photo.name, sessionId })
          // describePhoto 返回的是 { ok, raw, traits, size } —— traits 是分块的 tag，不是一整段文字。
          // 之前这里写成 seen.description / seen.text（不存在的字段），所以参考图描述永远是空的。
          const blocks = seen?.traits && typeof seen.traits === 'object' ? seen.traits : null
          const desc = blocks
            ? [
                blocks.face ? '正面：' + blocks.face : '',
                blocks.faceBack ? '背面：' + blocks.faceBack : '',
                blocks.bodySFW ? '上半身（穿衣）：' + blocks.bodySFW : '',
                blocks.fullSFW ? '全身（穿衣）：' + blocks.fullSFW : '',
                blocks.bodyNSFW ? '上半身（赤裸）：' + blocks.bodyNSFW : '',
                blocks.fullNSFW ? '全身（赤裸）：' + blocks.fullNSFW : '',
                blocks.negative ? '不应出现：' + blocks.negative : '',
              ].filter(Boolean).join('\n')
            : String(seen?.raw ?? '').slice(0, 2000)
          if (desc) {
            photoNote = [
              '【参考图（最高优先级）】',
              '用户上传了一张参考图，下面是这张图的实际内容（由视觉模型读出来的）：',
              desc.slice(0, 2500),
              '硬性要求：角色的外貌、发型、瞳色、体型、服装样式必须以上面这份描述为准。',
              '卡片设定只用来补年代背景和世界观，绝不能覆盖参考图里的外貌特征。',
            ].join('\n')
          }
          logger.info?.('dsh-tavern-comfy: 参考图描述 ' + desc.length + ' 字')
        } catch (error) {
          logger.warn?.('dsh-tavern-comfy: 参考图描述失败 ' + (error?.message ?? error))
          photoNote = '（参考图读取失败，请检查设置页的看图模型：' + String(error?.message ?? error).slice(0, 80) + '）'
        }
      }

      // 改进模式：带上现有角色，要求保持中英文名不变、只改要改的部分
      let improveNote = ''
      if (current && typeof current === 'object' && current.name) {
        const slim = {
          name: current.name,
          match: current.match ?? '',
          note: current.note ?? '',
          traits: current.traits ?? {},
          outfits: (current.outfits ?? []).map(o => ({
            name: o.name ?? '', upper: o.upper ?? '', lower: o.lower ?? '', shoes: o.shoes ?? '',
            accessory: o.accessory ?? '', full: o.full ?? '', back: o.back ?? '', negative: o.negative ?? '',
          })),
        }
        improveNote = [
          '【这是改进任务，不是新建】',
          '下面是已有的角色设定，请在它基础上按用户要求修改：',
          JSON.stringify(slim, null, 1),
          '硬性要求：',
          '1. 中文名称与英文名称必须和上面完全一致，一个字都不能改；',
          '2. 只输出这一个人物（以及他的全部服装），不要输出别的角色；',
          '3. 用户没提到要改的字段，原样保留原值，不要自行"优化"；',
          '4. 负面字段依然绝对不能出现年龄、体型、身高类词。',
        ].join('\n')
      }

      const ask = [
        // 有参考图时它排第一：模型对靠前的内容权重更高
        photoNote,
        improveNote,
        brief ? '用户的要求：' + brief : '',
        photoNote
          ? '（上面的参考图描述是外貌与服装的唯一依据；下面这段卡片设定只用来看年代背景和世界观）'
          : '',
        context ? (photoNote ? '以下是背景资料（当前卡片的设定）：\n' + context : '以下是参考资料（当前卡片的设定，请从这里提取角色外貌与年代背景）：\n' + context) : '',
        !brief && !photoNote ? '用户没有额外要求，请按参考资料的设定设计主要角色（2-3 位）以及每人 2-3 套服装。' : '',
        '严格按规范输出 <人物> 块，每个 <人物> 里可以嵌若干 <服装>。只输出这些块。',
      ].filter(Boolean).join('\n\n')

      const task = beginTask('设计', '角色与服装设计')
      logger.info?.('dsh-tavern-comfy: 开始设计角色（' + provider + '/' + model + '，规范 ' + rules.length + ' 字）')
      let result
      try {
        result = await runPlanner(deps.llm, { provider, model, system: rules, text: ask, temperature: 0.85, maxTokens: 12000, signal: task.controller.signal })
        finishTask(task)
      } catch (error) {
        finishTask(task, error)
        throw error
      }
      const people = parseDesign(result.text)
      logger.info?.('dsh-tavern-comfy: 设计完成，解析出 ' + people.length + ' 个人物')
      return { people, raw: people.length ? '' : String(result.text ?? '').slice(0, 4000) }
    }

    /** 上传的照片 → 按可见块拆好的 tag。 */
    async function describePhoto({ data, mediaType, name, sessionId }) {
      if (!deps.attachments?.saveImage) throw new Error('当前 DSH 没有 attachments 服务，收不了图片')
      if (!deps.llm) throw new Error('当前 DSH 没有 llm 服务')
      const bytes = Buffer.from(String(data ?? '').replace(/^data:[^,]+,/, ''), 'base64')
      if (!bytes.byteLength) throw new Error('图片是空的')
      const kind = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(mediaType)) ? String(mediaType) : 'image/png'
      const ref = await deps.attachments.saveImage({ data: new Uint8Array(bytes), mediaType: kind, name: String(name || 'photo') })

      const fallback = await backgroundModel(sessionId)
      const provider = config.visionProvider || config.plannerProvider || fallback?.provider || ''
      const model = config.visionModel || config.plannerModel || fallback?.model || ''
      if (!provider || !model) throw new Error('没定看图用哪个模型（Tavern 后台模型是空的，就来本插件设置里指定一个）')


      const task = beginTask('看图', '照片 → tag')
      logger.info?.('dsh-tavern-comfy: 看图写 tag（看图模型=' + provider + '/' + model + '，附件 ' + ref.width + 'x' + ref.height + '，attachmentId=' + String(ref.attachmentId ?? ref.id ?? '无').slice(0, 12) + '）')
      let result
      try {
        result = await runPlanner(deps.llm, {
        signal: task.controller.signal,
        provider, model, system: VISION_SYSTEM,
        text: '把这张图里的人物写成 tag，按约定返回 JSON。',
        images: [ref],
        temperature: 0.4,
        maxTokens: 2000,
        })
        finishTask(task)
      } catch (error) {
        finishTask(task, error)
        throw error
      }
      try {
        globalThis.__rphubLastVision = {
          at: Date.now(),
          provider, model,
          imageCount: 1,
          raw: String(result.text ?? '').slice(0, 1500),
        }
      } catch {}
      const raw = String(result.text ?? '').trim()
      const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
      let parsed = null
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(cleaned.slice(start, end + 1)) } catch { parsed = null }
      }
      if (!parsed) return { ok: true, raw, traits: null }
      const traits = {}
      for (const key of ['face', 'faceBack', 'bodySFW', 'fullSFW', 'bodyNSFW', 'fullNSFW', 'negative']) {
        traits[key] = typeof parsed[key] === 'string' ? parsed[key].trim() : ''
      }
      return { ok: true, raw, traits, size: ref.width + 'x' + ref.height }
    }

    let lastPlan = null
    /** 正文指纹：工具那条路没有消息 id，用它跟正文对上。 */
    function hashText(value) {
      let a = 2166136261
      const source = String(value ?? '')
      for (let i = 0; i < source.length; i++) a = Math.imul(a ^ source.charCodeAt(i), 16777619)
      return (a >>> 0).toString(36)
    }

    function plansFor(messageId) {
      return messageId ? plansByMessage.get(String(messageId)) ?? null : null
    }

    /**
     * 前台模型调用工具时走这条路：它在 agent 链里，能拿到发起者身份，
     * 所以这里的规划是"带着卡片上下文"跑的，和后台自动规划共用同一套规划逻辑。
     */
    async function planFromTool({ text, count, sessionId }) {
      try {
        const plan = await planMessage({
          text,
          messageId: 'tool-' + Date.now(),
          turn: 0,
          count,
          sessionId,
          manual: true,
        })
        if (!plan || !plan.plans || !plan.plans.length) {
          return { ok: false, generated: 0, note: '配图没产出：' + (plan?.error || '模型没有返回可用的 <image> 块') }
        }
        lastPlan = plan
        lastPlan.textHash = hashText(text)
        const marks = plan.plans.map(item => {
          const key = String(item.jobId ?? '').slice(0, 8)
          const where = String(item.mount ?? '').replace(/\s+/g, ' ').slice(0, 42)
          const what = String(item.title ?? '').slice(0, 20)
          return '- 在「' + where + '」这一句之后插入 [[img:' + key + ']]' + (what ? '（' + what + '）' : '')
        }).join('\n')
        return {
          ok: true,
          generated: plan.plans.length,
          note: '已提交 ' + plan.plans.length + ' 张插图，正在后台绘制。\n'
            + '现在请输出这一轮的正文，并在下面这些位置原样插入标记（标记不要改动、不要解释）：\n' + marks,
        }
      } catch (error) {
        return { ok: false, generated: 0, note: '配图失败：' + (error?.message ?? String(error)) }
      }
    }

    function sweep() {
      if (jobs.size <= 200) return
      const ordered = [...jobs.values()].filter(job => !['pending', 'running'].includes(job.state)).sort((a, b) => a.createdAt - b.createdAt)
      for (const job of ordered.slice(0, jobs.size - 200)) {
        jobs.delete(job.id)
        if (job.key) byKey.delete(job.key)
      }
    }

    function publicJob(job) {
      return {
        id: job.id, status: job.state, state: job.state, percent: job.percent ?? 0,
        queuePosition: job.queuePosition ?? 0, queuedCount: job.queuedCount ?? 0,
        seed: job.seed, workflow: job.workflowId, error: job.error ?? undefined, createdAt: job.createdAt,
        backend: job.backend ?? 'comfyui', channelName: job.channelName ?? '',
        mediaType: job.mediaType ?? '', imageOutputWarning: job.imageOutputWarning ?? '',
        size: job.size ? job.size.width + 'x' + job.size.height : '',
      }
    }

    function consoleJob(job) {
      return {
      workflowId: job.workflowId ?? '', workflowLabel: job.workflowLabel ?? '', loras: Array.isArray(job.loras) ? job.loras : [],
        ...publicJob(job),
        prompt: job.positive ?? '', negative: job.negative ?? '', tag: job.params?.tag ?? '',
        rawPrompt: job.params?.rawTag || job.params?.tag || job.positive || '',
        artist: job.params?.artist ?? '', size: job.size ? `${job.size.width}x${job.size.height}` : '',
        hits: job.hits ?? [], hasImage: job.state === 'done' && Boolean(job.byteLength), label: job.label ?? '',
        byteLength: job.byteLength ?? 0, mediaType: job.mediaType ?? '', completedAt: job.completedAt ?? null,
        imageOutputWarning: job.imageOutputWarning ?? '',
      }
    }

    function sendImage(response, job, rangeHeader) {
      const total = job.byteLength
      if (!job.file || !total) { sendJson(response, 404, { ok: false, error: '图片还没生成好' }); return }
      const type = job.mediaType || 'image/png'
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? '').trim())
      if (match) {
        let start = match[1] === '' ? null : Number(match[1])
        let end = match[2] === '' ? null : Number(match[2])
        if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1 }
        else { start = start ?? 0; end = end === null ? total - 1 : Math.min(end, total - 1) }
        if (!Number.isFinite(start) || start > end || start >= total) {
          response.writeHead(416, { 'content-range': `bytes */${total}` })
          response.end()
          return
        }
        response.writeHead(206, {
          'content-type': type, 'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=1800',
        })
        createReadStream(job.file, { start, end }).pipe(response)
        return
      }
      response.writeHead(200, { 'content-type': type, 'content-length': total, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=1800' })
      createReadStream(job.file).pipe(response)
    }

    async function readBody(request, limit = 4 * 1024 * 1024) {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > limit) throw new Error('请求过大')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return {}
      if (String(request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text))
      try { return JSON.parse(text) } catch { throw new Error('请求体不是有效 JSON') }
    }

    let consoleCache = null
    async function consoleHtml() {
      const info = await stat(CONSOLE_PATH).catch(() => null)
      if (!info) return null
      if (!consoleCache || consoleCache.mtime !== info.mtimeMs) consoleCache = { mtime: info.mtimeMs, html: await readFile(CONSOLE_PATH, 'utf8') }
      return consoleCache.html
    }

    /** 诊断用：记录最近的模型调用，只留最近 60 条（不清理会一直涨）。 */
    function pushLlmDiag(entry) {
      try {
        const list = globalThis.__rphubLlmCalls ?? (globalThis.__rphubLlmCalls = [])
        list.push(entry)
        if (list.length > 60) list.splice(0, list.length - 60)
      } catch {}
    }

    /** 一次性诊断：DSH 到底认不认这个包、客户端模块表里有没有它。 */
    async function diagnose() {
      const out = { name: 'dsh-tavern-comfy' }
      try {
        const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
        if (loader && typeof loader.entries === 'function') {
          const names = []
          for (const entry of loader.entries()) names.push(String(entry?.options?.name ?? entry?.name ?? '?'))
          out.loaderCount = names.length
          out.loaderHit = names.filter(n => /rphub|wrongbook|tavern-plugin/i.test(n))
        } else {
          out.loaderError = '拿不到 loader'
        }
      } catch (error) { out.loaderError = String(error?.message ?? error) }
      try {
        const registry = typeof ctx.get === 'function' ? (ctx.get('clientModules') ?? ctx.get('client-module-registry')) : undefined
        if (registry && registry.table && typeof registry.table.keys === 'function') {
          out.clientTable = [...registry.table.keys()]
          // 已登记的 bundle URL 清单（含修订号）——这才是浏览器真正会去取的东西
          try {
            if (registry.responses && typeof registry.responses.keys === 'function') {
              out.responseCount = registry.responses.size
              const keys = [...registry.responses.keys()]
              out.responseKeys = keys.filter(u => /rphub|wrongbook|slots|tavern-plugin/i.test(u)).slice(0, 20)
              out.responseSample = keys.slice(0, 3)
              out.myBundle = keys.filter(u => /rphub/i.test(u))
            }
          } catch (error) { out.responseError = String(error?.message ?? error) }
          // 我自己的 entry 在表里长什么样
          try {
            const record = registry.table.get('dsh-tavern-comfy')
            if (record) {
              out.myRecord = {
                id: record.entry?.id,
                rev: record.entry?.rev ?? record.rev ?? null,
                url: record.entry?.url ?? null,
                clientPath: record.meta?.clientPath ?? null,
                hasBundle: Boolean(record.bundle),
                inject: record.meta?.inject ?? null,
                baseline: record.baseline ? 'yes' : 'no',
              }
            } else out.myRecord = 'not-in-table'
          } catch (error) { out.myRecordError = String(error?.message ?? error) }
          const mine = out.clientTable.filter(n => /rphub/i.test(String(n)))
          out.clientHasMine = mine
          out.clientError = registry.sources ? null : null
          try {
            registry.resolveMeta && (out.meta = null)
          } catch {}
        } else {
          out.clientTable = 'no-registry'
        }
      } catch (error) { out.clientError = String(error?.message ?? error) }

      // 顺手复刻一次扫描判定
      try {
        const { createRequire } = await import('node:module')
        const require2 = createRequire(TAVERN_SETTINGS)
        const pkgPath = require2.resolve('dsh-tavern-comfy/package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        out.scan = {
          resolved: pkgPath.replace(/\\/g, '/'),
          platform: pkg.dsh?.client?.platform ?? null,
          clientExport: pkg.exports?.['./client'] ?? null,
          inject: pkg.dsh?.client?.inject ?? null,
        }
      } catch (error) { out.scanError = String(error?.message ?? error) }
      return out
    }

    async function comfyHealth() {
      try {
        const response = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(4000), headers: Object.assign({}, comfyHeaders(config)) })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const data = await response.json().catch(() => ({}))
        return { ok: true, version: data?.system?.comfyui_version ?? '' }
      } catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    }

    async function consoleState() {
    const worldbookList = await worldbook().catch(() => [])
      return {
        ok: true,
        base: BASE,
        imageProviders: IMAGE_PROVIDERS,
        // 条目要带 enabled 和 content —— 前台要靠它们显示开关与编辑框
        worldbook: worldbookList.map(entry => ({
          index: entry.index,
          comment: entry.comment,
          length: entry.length,
          enabled: entry.enabled !== false,
          content: String(entry.content ?? ''),
        })),
        // 顺手把当前世界书的名字也带上
        worldbookName: String((await loadWorldbook().catch(() => ({ name: '' }))).name ?? ''),
        // 启用条数：生图规划 tab 用它显示"几条第几条在生效"
        worldbookEnabledCount: worldbookList.filter(e => e.enabled !== false && String(e.content ?? '').trim()).length,
        config: {
          imageBackend: config.imageBackend,
          activeImageChannel: config.activeImageChannel,
          imageChannels: publicChannels(config.imageChannels),
          imageConcurrency: config.imageConcurrency,
          comfyUrl: config.comfyUrl,
          comfyMode: config.comfyMode === 'simple' ? 'simple' : 'workflow',
          comfySimple: normalizeComfySimpleConfig(config.comfySimple),
          comfyAuthMode: String(config.comfyAuthMode ?? 'none'),
          comfyAuthToken: String(config.comfyAuthToken ?? ''),
          comfyAuthUser: String(config.comfyAuthUser ?? ''),
          comfyAuthPass: String(config.comfyAuthPass ?? ''),
          defaultWorkflow: config.defaultWorkflow, lockWorkflow: config.lockWorkflow,
          autoImageGen: config.autoImageGen, imageGenCount: config.imageGenCount,
          smartImageSelection: config.smartImageSelection !== false,
          characterAutoUpdate: config.characterAutoUpdate !== false,
          styleArtists: config.styleArtists ?? '', imageSize: config.imageSize ?? '竖图',
          stylePresets: Array.isArray(config.stylePresets) ? config.stylePresets : [],
          activePreset: String(config.activePreset ?? ''),
          styleNegative: String(config.styleNegative ?? ''),
          promptPresets: normalizePromptPresets(config.promptPresets),
          promptPresetLibrary: BUILTIN_PROMPT_PRESETS,
          activePromptPreset: String(config.activePromptPreset ?? ''),
          promptMode: ['auto', 'tags', 'natural', 'mixed'].includes(config.promptMode) ? config.promptMode : 'auto',
          promptEffectiveFormat: resolvePromptMode(config, config.imageBackend),
          promptEffectiveName: effectivePromptPreset(config)?.name ?? '',
          promptPreviewPositive: composePresetText(String(config.promptManualPositive ?? ''), config, config.imageBackend),
          promptPreviewNegative: [activeArtistText(config).negative, promptPresetNegative(config), String(config.promptManualNegative ?? '')].filter(Boolean).join(', '),
          promptManualPositive: String(config.promptManualPositive ?? ''),
          promptManualNegative: String(config.promptManualNegative ?? ''),
          jpegOutput: config.jpegOutput === true,
          jpegQuality: Math.max(50, Math.min(100, Number(config.jpegQuality) || 88)),
          jpegBackground: String(config.jpegBackground ?? '#ffffff'),
          artistSets: Array.isArray(config.artistSets) ? config.artistSets : [],
          activeArtistSet: String(config.activeArtistSet ?? ''),
          artistPosition: config.artistPosition, weightMode: config.weightMode, negativeMode: config.negativeMode,
          overrideSteps: config.overrideSteps, injectWeight: config.injectWeight, cacheDir: config.cacheDir,
          traitMode: config.traitMode ?? 'auto',
          diag: await diagnose().catch(error => ({ error: String(error?.message ?? error) })),
          indexTap: deps.indexTap ?? null,
          // Tavern 官方接口桥的自检：装了没、Tavern 给了哪些能力
          tavernBridge: deps.bridge ? { installed: true, exports: Object.keys(deps.bridge) } : { installed: false },
          tavernApi: deps.tavern ? { apiVersion: deps.tavern.apiVersion, hasAttach: typeof deps.tavern.attach === 'function', hasPromptSection: typeof deps.tavern.promptSection === 'function', hasGetTurn: typeof deps.tavern.getTurn === 'function', hasOnTurnSettled: typeof deps.tavern.onTurnSettled === 'function', hasTurnData: typeof deps.tavern.readTurnData === 'function' } : null,
          toolName: TOOL_NAME,
          toolsDiag: (() => { try { return globalThis.__rphubToolsDiag ?? null } catch { return null } })(),
          plannerEnabled: config.plannerEnabled !== false, plannerProvider: config.plannerProvider ?? '',
          visionProvider: config.visionProvider ?? '',
          plannerEffort: String(config.plannerEffort ?? ''),
          visionEffort: String(config.visionEffort ?? ''), visionModel: config.visionModel ?? '',
          llmDiag: (() => { try { return globalThis.__rphubLastLlmCall ?? null } catch { return null } })(),
          llmDiagList: (() => { try { return (globalThis.__rphubLlmCalls ?? []).slice(-60) } catch { return [] } })(),
          visionDiag: (() => { try { return globalThis.__rphubLastVision ?? null } catch { return null } })(),
          plannerModel: config.plannerModel ?? '', plannerCount: config.plannerCount ?? 3,
          plannerTemperature: config.plannerTemperature ?? 1, plannerExtra: config.plannerExtra ?? '',
          plannerEntries: Array.isArray(config.plannerEntries) ? config.plannerEntries : [],
          plannerEffective: await backgroundModel(lastSessionId).then(fb => ({
            provider: config.plannerProvider || fb?.provider || '',
            model: config.plannerModel || fb?.model || '',
            fromTavern: !config.plannerProvider && Boolean(fb),
          })).catch(() => ({ provider: config.plannerProvider || '', model: config.plannerModel || '', fromTavern: false })),
        },
        sizes: config.sizes ?? {},
        workflows: workflows.map(wf => ({
          id: wf.id, label: wf.label, file: wf.file, match: wf.match, sizes: wf.sizes, enabled: wf.enabled,
          error: wf.error, digest: wf.digest ?? '', summary: wf.summary ?? null, current: wf.id === config.defaultWorkflow,
        })),
        definitions,
        outfits: definitions.outfits ?? [],
        kinds: DEFINITION_KINDS,
        jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map(consoleJob),
        tasks: publicTasks(),
        clientReports: clientReports.slice(-40),
      }
    }

    let graphWrite = Promise.resolve()
    async function handleConsole(action, request, response, _url) {
      if (action === 'character-history') {
        const tavern = deps.tavern
        const api2 = Number(tavern?.apiVersion) >= 2 && typeof tavern?.readTurnData === 'function'
        if (!api2) { sendJson(response, 200, { ok: true, available: false, reason: '当前 Tavern 插件接口为 v1，角色历史需要 v2' }); return }
        try {
          if (request.method === 'GET') {
            const gameId = String(_url?.searchParams?.get('gameId') ?? '')
            if (!gameId) throw new Error('需要当前 gameId')
            const requestedTurn = Number(_url?.searchParams?.get('turn'))
            const seenTurn = Number(lastTurn.get(gameId))
            const turn = Number.isSafeInteger(requestedTurn) && requestedTurn > 0
              ? requestedTurn
              : Number.isSafeInteger(seenTurn) && seenTurn > 0 ? seenTurn : Number.MAX_SAFE_INTEGER
            const saved = await tavern.readTurnData({ gameId, turn })
            sendJson(response, 200, { ok: true, available: true, turn: saved?.turn ?? null, currentTurn: lastTurn.get(gameId) ?? null, textVersion: saved?.textVersion ?? null, snapshot: saved?.data ?? emptyCharacterSnapshot() })
            return
          }
          if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
          const origin = request.headers.origin
          if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作角色历史。' }); return
          }
          const body = await readBody(request, 12 * 1024)
          const gameId = String(body?.gameId ?? '')
          const changeIndex = Number(body?.changeIndex)
          if (!gameId || !Number.isSafeInteger(changeIndex) || changeIndex < 0) throw new Error('需要有效的 gameId 和历史记录编号')
          const currentTurn = Number(lastTurn.get(gameId))
          if (!Number.isSafeInteger(currentTurn) || currentTurn < 1) throw new Error('还没有获得当前轮次信息；请先等一轮结算或从消息下方打开生图按钮，再刷新角色历史')
          const assertCurrentTurn = () => {
            if (Number(lastTurn.get(gameId)) !== currentTurn) throw new Error('恢复期间当前轮次已变化，请刷新后重试')
          }
          const restore = async () => {
            // The request may have waited behind another same-game planner in the history lock.
            assertCurrentTurn()
            const latest = await tavern.readTurnData({ gameId, turn: currentTurn })
            assertCurrentTurn()
            const changes = Array.isArray(latest?.data?.changes) ? latest.data.changes : []
            const change = changes[changeIndex]
            if (!latest || !change) throw new Error('这条角色历史已不在当前剧情线上，请刷新后重试')
            const expected = body?.expectedChange
            const identityFields = ['id', 'field', 'turn', 'textVersion', 'at', 'before', 'after']
            if (!expected || typeof expected !== 'object' || identityFields.some(key =>
              !Object.prototype.hasOwnProperty.call(expected, key) || String(expected[key] ?? '') !== String(change[key] ?? '')
            )) throw new Error('角色历史记录已变化，请刷新后重试')
            const current = await tavern.getTurn?.({ gameId, turn: currentTurn })
            if (!current) throw new Error('当前轮次正文不可用，请等结算完成后重试')
            const character = definitions.characters.find(item => String(item?.id) === String(change.id))
            if (!character || !String(change.field ?? '')) throw new Error('角色已删除或历史字段无效')
            const snapshot = structuredClone(latest.data)
            snapshot.characters ||= {}
            const overlay = snapshot.characters[String(character.id)] ||= { traits: {} }
            overlay.traits ||= {}
            const before = String(overlay.traits[change.field] ?? character.traits?.[change.field] ?? '')
            const after = String(change.before ?? '')
            if (after) overlay.traits[change.field] = after
            else delete overlay.traits[change.field]
            snapshot.turn = currentTurn
            snapshot.textVersion = current.textVersion
            snapshot.changes.push({ id: String(character.id), name: String(character.name ?? ''), field: String(change.field), before, after, reason: '玩家从角色历史手动恢复', turn: currentTurn, textVersion: current.textVersion, at: Date.now() })
            snapshot.changes = snapshot.changes.slice(-120)
            const bounded = boundCharacterSnapshot(snapshot)
            const verify = await tavern.getTurn?.({ gameId, turn: currentTurn })
            assertCurrentTurn()
            if (!verify || verify.textVersion !== current.textVersion) throw new Error('恢复期间正文已变化，请刷新后重试')
            await tavern.saveTurnData({ gameId, turn: currentTurn, textVersion: current.textVersion, data: bounded })
          }
          if (typeof deps.bridge?.withHistoryLock === 'function') await deps.bridge.withHistoryLock(gameId, restore)
          else await restore()
          sendJson(response, 200, { ok: true, available: true, turn: currentTurn })
          return
        } catch (error) { sendJson(response, 400, { ok: false, error: String(error?.message ?? error) }); return }
      }
      if (['workflow-graph', 'image-channel-test'].includes(action)) {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
        const origin = request.headers.origin
        if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作' }); return
        }
        try {
          const body = await readBody(request)
          if (action === 'image-channel-test') {
            const channel = config.imageChannels.find(item => item.id === body?.id)
            if (!channel) throw new Error('请先保存渠道配置')
            const result = await testImageChannel(structuredClone(channel))
            sendJson(response, 200, result.ok ? result : { ...result, error: result.message || '渠道连接失败' })
          } else {
            const file = String(body?.file ?? '').replace(/^workflows[\\/]/, '')
            if (!file || /[\\/]/.test(file) || !/\.json$/i.test(file) || file.includes('..')) throw new Error('工作流文件名不正确')
            const operation = graphWrite.then(async () => {
              const path = join(WORKFLOW_DIR, file)
              let raw = await readJson(path, null)
              if (!raw?.prompt) throw new Error('找不到可编辑的 API 工作流')
              if (body.patch !== undefined) {
                raw = patchWorkflowGraph(raw, body.patch, body.revision)
                await writeJsonSafe(path, raw, join(ROOT, 'backups'))
                config.workflows = await scanWorkflows(config)
                await loadAllWorkflows()
              }
              return { ok: true, workflow: raw, revision: workflowRevision(raw) }
            })
            graphWrite = operation.catch(() => {})
            sendJson(response, 200, await operation)
          }
        } catch (error) { sendJson(response, 400, { ok: false, error: error.message }) }
        return
      }
      if (action.startsWith('plugin-update')) {
        const method = action === 'plugin-update' ? 'GET' : 'POST'
        if (request.method !== method) { sendJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (method === 'POST') {
          const origin = request.headers.origin
          if ((origin && origin !== _url.origin) || !String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            sendJson(response, 403, { ok: false, error: '请从 DSH Tavern 插件面板操作更新。' }); return
          }
        }
        try {
          if (action === 'plugin-update') sendJson(response, 200, await updater.status())
          else if (action === 'plugin-update-check') { await readBody(request, 4096); sendJson(response, 200, await updater.check()) }
          else { const body = await readBody(request, 4096); sendJson(response, 200, await updater.apply(body?.target)) }
        } catch (error) { sendJson(response, 400, { ok: false, error: error.message }) }
        return
      }
      if (request.method === 'GET') {
        if (action === 'state') {
          const health = config.imageBackend === 'comfyui' ? await comfyHealth() : null
          sendJson(response, 200, { ...(await consoleState()), comfy: health })
          return
        }
        if (action === 'history') {
          sendJson(response, 200, { ok: true, jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map(consoleJob) })
          return
        }
        if (action === 'plans') {
          const messageId = String(_url?.searchParams?.get('messageId') ?? '')
          let plan = plansFor(messageId)
          try {
            addClientReport({
              at: Date.now(),
              stage: 'host-plans-query',
              data: { ask: messageId.slice(0, 14) || '(空)', hit: plan ? (plan.plans ? plan.plans.length : 0) : 0, mapSize: plansByMessage.size, keys: [...plansByMessage.keys()].map(k => String(k).slice(0, 10)).slice(0, 6), fallback: String(_url?.searchParams?.get('fallback') ?? '') },
            })
          } catch {}
          // 工具那条路是模型主动调的，对不上消息 id；正文里如果出现了那次的挂载句，就用最近一次
          if (!plan && lastPlan && _url?.searchParams?.get('fallback') === '1') {
            const wanted = String(_url?.searchParams?.get('hash') ?? '')
            if (wanted && lastPlan.textHash === wanted) plan = lastPlan
          }
          sendJson(response, 200, { ok: true, plan, plans: plan ? plan.plans : null })
          return
        }
        // GET 版：卡片列表（前端用 GET 取，避免 method 不匹配）
        if (action === 'cards') {
          try {
            const dir = join(TAVERN_DATA, 'resources', 'cards')
            const names = await readdir(dir).catch(() => [])
            const cards = names
              .filter(name => /\.json$/i.test(name))
              .map(name => ({ path: 'cards/' + name, name: name.replace(/\.json$/i, '') }))
              .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
            sendJson(response, 200, { ok: true, cards })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }
        // GET 版：单张图的详情（提示词）
        if (action === 'job-detail') {
          const job = getJob(String(_url?.searchParams?.get('id') ?? ''))
          if (!job) { sendJson(response, 404, { ok: false, error: '没有这个作业' }); return }
          sendJson(response, 200, { ok: true, job: consoleJob(job) })
          return
        }
        // GET 版：卡片显示正则用的插图。
        // 浏览器 <img src> 只会发 GET，所以这条**必须**在 GET 分支里有（2026-10-07 修：
        // 之前只挂在 POST 分支下，导致卡里 [[img:xxx]] 渲染出来的图永远 405 取不到）。
        if (action === 'img') {
          try {
            const key = String(_url?.searchParams?.get('key') ?? '').toLowerCase()
            let hit = null
            for (const job of jobs.values()) {
              if (String(job.id).toLowerCase().startsWith(key) && key.length >= 6) { hit = job; break }
            }
            if (!hit) { sendJson(response, 404, { ok: false, error: '没有这个插图' }); return }
            if (hit.state !== 'done' || !hit.byteLength) { sendJson(response, 404, { ok: false, error: '这张还没画好' }); return }
            sendImage(response, hit, request.headers.range)
          } catch (error) {
            sendJson(response, 404, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const body = await readBody(request)

        // ---- 列出可用的 LLM provider / model（给设置页做下拉框，不用手打）----
        if (action === 'llm-models') {
          try {
            const llm = deps?.llm ?? deps?.ctx?.get?.('llm')
            if (!llm || typeof llm.listProviders !== 'function') {
              sendJson(response, 200, { ok: true, providers: [], models: [], error: '当前 DSH 没有可用的 llm 服务' })
              return
            }
            const providers = (llm.listProviders() ?? []).map(p => ({ id: String(p.id), name: String(p.name ?? p.id) }))
            const wantProvider = String(body?.provider ?? '')
            if (!wantProvider) {
              sendJson(response, 200, { ok: true, providers, models: [] })
              return
            }
            const models = []
            try {
              const list = await llm.listModels(wantProvider)
              for (const m of (list ?? [])) {
                const mods = Array.isArray(m.inputModalities) ? m.inputModalities.map(String) : []
                models.push({
                  id: String(m.id),
                  name: String(m.name ?? m.id),
                  description: String(m.description ?? ''),
                  // 能看图 = inputModalities 里有 image
                  vision: mods.includes('image'),
                })
              }
            } catch (error) {
              sendJson(response, 200, { ok: true, providers, models: [], error: '列模型失败：' + String(error?.message ?? error) })
              return
            }
            // 如果指定了具体模型，顺便把它的推理等级也带上
            let reasoning = null
            const wantModel = String(body?.model ?? '')
            if (wantModel) {
              try {
                const info = await llm.resolveModelInfo(wantProvider, wantModel)
                if (info?.reasoning?.efforts?.length) {
                  reasoning = {
                    efforts: info.reasoning.efforts.map(e => ({ id: String(e.id), name: String(e.name ?? e.id) })),
                    defaultEffort: info.reasoning.defaultEffort ? String(info.reasoning.defaultEffort) : '',
                  }
                }
              } catch { /* 拿不到就算了 */ }
            }
            sendJson(response, 200, { ok: true, providers, models, reasoning })
          } catch (error) {
            sendJson(response, 200, { ok: true, providers: [], models: [], error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 测 ComfyUI 连接（返回在线状态与版本）----
        if (action === 'comfy-test') {
          const base = String(body?.url || config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
          const started = Date.now()
          try {
            const headers = comfyHeaders({ comfyAuthMode: body?.authMode ?? config.comfyAuthMode, comfyAuthToken: body?.authToken ?? config.comfyAuthToken, comfyAuthUser: body?.authUser ?? config.comfyAuthUser, comfyAuthPass: body?.authPass ?? config.comfyAuthPass })
            let info = null
            let status = 0
            try {
              const res = await fetch(base + '/system_stats', { headers, signal: AbortSignal.timeout(8000) })
              status = res.status
              if (res.ok) info = await res.json()
            } catch (error) {
              sendJson(response, 200, { ok: false, url: base, ms: Date.now() - started, error: '连不上：' + String(error?.message ?? error).slice(0, 120) })
              return
            }
            const ok = Boolean(info)
            const version = String(info?.system?.comfyui_version ?? info?.system?.comfy_version ?? '')
            sendJson(response, 200, {
              ok, url: base, ms: Date.now() - started, version,
              device: String(info?.devices?.[0]?.name ?? ''),
              vram: info?.devices?.[0]?.vram_total ? Math.round(info.devices[0].vram_total / 1024 / 1024 / 1024) + 'GB' : '',
              status,
              error: ok ? '' : (status === 401 || status === 403 ? '鉴权失败（HTTP ' + status + '）—— 检查服务鉴权设置' : '连不上（ComfyUI 没开，或地址不对）HTTP ' + status),
            })
          } catch (error) {
            sendJson(response, 200, { ok: false, url: base, ms: Date.now() - started, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- Read-only model/node inventory for the built-in simple mode ----
        if (action === 'comfy-simple-info') {
          try {
            const objectInfo = await getSimpleObjectInfo(true)
            sendJson(response, 200, { ok: true, ...inspectComfySimple(objectInfo) })
          } catch (error) {
            sendJson(response, 200, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 简单编辑：直接读/写工作流里的参数值（正面/负面/宽高/步数/CFG/底模）----
        if (action === 'workflow-values') {
          try {
            const file = String(body?.file ?? '').replace(/^.*[\\\\/]/, '')
            if (!file) { sendJson(response, 400, { ok: false, error: '缺少文件名' }); return }
            const path = join(ROOT, 'workflows', file)
            const raw = await readJson(path, null)
            if (!raw) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            const prompt = raw.prompt ?? {}
            const b = raw.bindings ?? {}
            const nodeOf = (key) => { const it = (b[key] ?? [])[0]; return it ? prompt[it.node] : null }
            const inputOf = (key, fallback) => { const it = (b[key] ?? [])[0]; return it ? it.input : fallback }

            const readValue = (key, fallbackInput) => {
              const n = nodeOf(key)
              if (!n || !n.inputs) return undefined
              return n.inputs[inputOf(key, fallbackInput)]
            }
            // 尺寸：宽高分别取
            const sizeNode = nodeOf('size')
            const values = {
              positive: String(readValue('positive', 'text') ?? ''),
              negative: String(readValue('negative', 'text') ?? ''),
              width: sizeNode?.inputs?.width,
              height: sizeNode?.inputs?.height,
              steps: readValue('steps', 'steps'),
              cfg: readValue('cfg', 'cfg') ?? readValue('guidance', 'guidance'),
              model: String(readValue('model', 'ckpt_name') ?? ''),
            }

            if (body?.values && typeof body.values === 'object') {
              const v = body.values
              const setIn = (key, fallbackInput, value) => {
                const it = (b[key] ?? [])[0]
                if (!it) return false
                const n = prompt[it.node]
                if (!n || !n.inputs) return false
                const input = it.input || fallbackInput
                if (!Object.hasOwn(n.inputs, input)) return false
                n.inputs[input] = value
                return true
              }
              const done = []
              if (typeof v.positive === 'string') { setIn('positive', 'text', v.positive); done.push('正面') }
              if (typeof v.negative === 'string') { setIn('negative', 'text', v.negative); done.push('负面') }
              if (Number.isFinite(Number(v.width)) || Number.isFinite(Number(v.height))) {
                const n = nodeOf('size')
                if (n && n.inputs) {
                  if (Number.isFinite(Number(v.width))) n.inputs.width = Math.round(Number(v.width))
                  if (Number.isFinite(Number(v.height))) n.inputs.height = Math.round(Number(v.height))
                  done.push('尺寸')
                }
              }
              if (Number.isFinite(Number(v.steps))) { if (setIn('steps', 'steps', Math.round(Number(v.steps)))) done.push('步数') }
              if (Number.isFinite(Number(v.cfg))) {
                if (setIn('cfg', 'cfg', Number(v.cfg)) || setIn('guidance', 'guidance', Number(v.cfg))) done.push('CFG')
              }
              if (typeof v.model === 'string' && v.model.trim()) { if (setIn('model', 'ckpt_name', v.model)) done.push('底模') }
              await writeJsonSafe(path, raw, join(ROOT, 'backups'))
              logger.info?.('dsh-tavern-comfy: 改了工作流《' + (raw.name ?? file) + '》的 ' + done.join('、'))
              config.workflows = await scanWorkflows(config)
              await loadAllWorkflows()
              sendJson(response, 200, { ok: true, changed: done, values })
              return
            }
            sendJson(response, 200, { ok: true, values })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 试跑一张：用指定的工作流生成一张测试图，确认它能用 ----
        if (action === 'workflow-test') {
          try {
            const file = String(body?.file ?? '')
            const id = String(body?.id ?? '')
            const wf = workflows.find(w => (file && String(w.file).endsWith(file)) || (id && String(w.id) === id))
            if (!wf) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            if (wf.error) { sendJson(response, 400, { ok: false, error: '这张工作流不可用：' + wf.error }); return }
            const prompt = String(body?.prompt ?? '').trim() ||
              '1girl, solo, upper body, simple background, looking at viewer, best quality'
            const job = await startJob({
              tag: prompt,
              rawTag: prompt,
              size: String(body?.size || '方图'),
              model: String(wf.id),      // pickWorkflow 按 id 匹配 → 就用这张
            }, { label: '试跑：' + (wf.label || wf.id), forceWorkflow: wf })
            logger.info?.('dsh-tavern-comfy: 试跑《' + (wf.label || wf.id) + '》→ ' + job.id.slice(0, 8))
            sendJson(response, 200, { ok: true, jobId: job.id, job: consoleJob(getJob(job.id)), workflow: String(wf.label || wf.id) })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error).slice(0, 400) })
          }
          return
        }

        // ---- 导入工作流（ComfyUI API JSON 或已带 bindings 的格式）----
        if (action === 'workflow-import') {
          try {
            let src = body?.workflow
            if (typeof src === 'string') {
              try { src = JSON.parse(src) } catch { sendJson(response, 400, { ok: false, error: '不是合法的 JSON' }); return }
            }
            const norm = normalizeWorkflow(src, String(body?.name ?? '').trim() || undefined)
            if (!norm) { sendJson(response, 400, { ok: false, error: '没找到 ComfyUI 节点（需要 API 格式的 JSON）' }); return }
            const safe = String(norm.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'imported'
            const file = join(ROOT, 'workflows', safe + '.tavern-comfy-v1.json')
            await writeJsonAtomic(file, norm)
            config.workflows = await scanWorkflows(config)
            await loadAllWorkflows()
            logger.info?.('dsh-tavern-comfy: 已导入工作流《' + norm.name + '》节点 ' + Object.keys(norm.prompt).length + ' 个')
            sendJson(response, 200, {
              ok: true, name: norm.name, file: safe + '.tavern-comfy-v1.json',
              nodes: Object.keys(norm.prompt).length,
              bindings: {
                positive: norm.bindings.positive.length, negative: norm.bindings.negative.length,
                seed: norm.bindings.seed.length, size: norm.bindings.size.length,
                steps: norm.bindings.steps.length, cfg: norm.bindings.cfg.length,
                model: norm.bindings.model.length, loras: norm.bindings.loras.length,
              },
            })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 读/改某张工作流的 bindings 与 LoRA ----
        if (action === 'workflow-bindings') {
          try {
            const file = String(body?.file ?? '')
            if (!file) { sendJson(response, 400, { ok: false, error: '缺少文件名' }); return }
            const path = join(ROOT, 'workflows', file.replace(/^.*[\\/]/, ''))
            const raw = await readJson(path, null)
            if (!raw) { sendJson(response, 404, { ok: false, error: '找不到这张工作流' }); return }
            if (body?.patch && typeof body.patch === 'object') {
              // 改 LoRA 的启用与权重（按节点 id）
              // 改各类绑定：{ positive: [{node,input}], negative: [...], size/steps/cfg/model/seed 同理 }
              const patchBindings = body.patch.bindings && typeof body.patch.bindings === 'object' ? body.patch.bindings : null
              if (patchBindings) {
                for (const key of ['positive', 'negative', 'seed', 'batch', 'size', 'steps', 'cfg', 'guidance', 'model']) {
                  if (!Array.isArray(patchBindings[key])) continue
                  raw.bindings = raw.bindings ?? {}
                  raw.bindings[key] = patchBindings[key]
                    .filter(x => x && x.node !== undefined)
                    .map(x => ({ node: String(x.node), input: String(x.input ?? 'text') }))
                }
              }
              const patchLoras = Array.isArray(body.patch.loras) ? body.patch.loras : null
              if (patchLoras) {
                const map = new Map(patchLoras.map(x => [String(x.node), x]))
                for (const lora of raw.bindings?.loras ?? []) {
                  const p = map.get(String(lora.node))
                  if (!p) continue
                  if (typeof p.enabled === 'boolean') lora.enabled = p.enabled
                  if (typeof p.name === 'string') lora.name = p.name
                  if (Number.isFinite(Number(p.strengthModel))) lora.strengthModel = Number(p.strengthModel)
                  if (Number.isFinite(Number(p.strengthClip))) lora.strengthClip = Number(p.strengthClip)
                }
              }
              await writeJsonAtomic(path, raw)
            }
            sendJson(response, 200, { ok: true, workflow: raw })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- ComfyUI 里有哪些 LoRA（给导入时选名字用）----
        if (action === 'loras-available') {
          try {
            const base = String(config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
            const r = await fetch(base + '/object_info/LoraLoader', { headers: comfyHeaders(config) }).then(x => x.json()).catch(() => null)
            const names = r?.LoraLoader?.input?.required?.lora_name?.[0] ?? []
            sendJson(response, 200, { ok: true, loras: Array.isArray(names) ? names : [] })
          } catch (error) {
            sendJson(response, 200, { ok: true, loras: [], error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 删除一张历史图 ----
        if (action === 'delete-job') {
          try {
            const id = String(body?.jobId ?? '')
            if (!id) { sendJson(response, 400, { ok: false, error: '缺少 jobId' }); return }
            const job = jobs.get(id)
            job?.controller?.abort()
            if (job?.file) await rm(job.file, { force: true }).catch(() => {})
            // 接住返回值：不存在的话就是 0，别报假成功
            const existed = jobs.delete(id) ? 1 : 0
            persistJobs()
            // 从所有计划里摘掉这个 jobId（重画版本链也要清）
            let touched = 0
            for (const [key, plan] of plansByMessage) {
              const list = plan?.plans
              if (!Array.isArray(list)) continue
              const kept = list.filter(item => String(item.jobId) !== id)
              if (kept.length !== list.length) { plansByMessage.set(key, Object.assign({}, plan, { plans: kept })); touched++ }
            }
            if (touched) persistPlans()
            logger.info?.('dsh-tavern-comfy: 已删除历史图 ' + id.slice(0, 8))
            sendJson(response, 200, { ok: true, removed: existed, existed: Boolean(existed) })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 导入世界书（接受 ST 格式 / 本插件格式 / 数组 / 纯文本）----
        if (action === 'worldbook-import') {
          try {
            let src = body?.worldbook
            if (typeof src === 'string') {
              try { src = JSON.parse(src) } catch { /* 当纯文本处理 */ }
            }
            const norm = normalizeWorldbook(src)
            if (!norm || !norm.entries.length) { sendJson(response, 400, { ok: false, error: '没能从这份内容里读出任何条目' }); return }
            // 导入前备份旧的
            try {
              const old = await readJson(join(ROOT, 'worldbook.json'), null)
              if (old) {
                const dir = join(ROOT, 'backups'); await mkdir(dir, { recursive: true })
                await copyFile(join(ROOT, 'worldbook.json'), join(dir, 'worldbook-' + Date.now() + '.json'))
              }
            } catch {}
            await queueWorldbookWrite(() => writeJsonSafe(join(ROOT, 'worldbook.json'), norm, join(ROOT, 'backups')))
            worldbookCache = null
            logger.info?.('dsh-tavern-comfy: 已导入世界书《' + norm.name + '》' + norm.entries.length + ' 条')
            sendJson(response, 200, { ok: true, name: norm.name, count: norm.entries.length })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 改一条世界书条目（开关 / 改标题 / 改内容 / 删除）----
        if (action === 'worldbook-entry') {
          try {
            const wb = await loadWorldbook()
            const index = Number(body?.index)
            const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {}
            if (!Number.isInteger(index) || index < 0 || index >= wb.entries.length) { sendJson(response, 400, { ok: false, error: '条目不存在' }); return }
            if (body?.remove === true) wb.entries.splice(index, 1)
            else {
              const e = wb.entries[index]
              if (typeof patch.comment === 'string') e.comment = patch.comment
              if (typeof patch.content === 'string') e.content = patch.content
              if (typeof patch.enabled === 'boolean') e.enabled = patch.enabled
            }
            await queueWorldbookWrite(() => writeJsonSafe(join(ROOT, 'worldbook.json'), wb, join(ROOT, 'backups')))
            worldbookCache = null
            sendJson(response, 200, { ok: true, count: wb.entries.length })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 新增一条空条目 ----
        if (action === 'worldbook-add') {
          try {
            const wb = await loadWorldbook()
            wb.entries.push({ comment: String(body?.comment ?? '新条目'), content: String(body?.content ?? ''), enabled: true })
            await queueWorldbookWrite(() => writeJsonRetry(join(ROOT, 'worldbook.json'), wb))
            worldbookCache = null
            sendJson(response, 200, { ok: true, count: wb.entries.length, index: wb.entries.length - 1 })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

        // ---- 导出当前世界书 ----
        if (action === 'worldbook-export') {
          try {
            const wb = await loadWorldbook()
            sendJson(response, 200, { ok: true, worldbook: wb })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
          }
          return
        }

      if (action === 'config') {
        const patch = body?.config ?? body ?? {}
        try { Object.assign(config, channelConfigPatch(config, patch)) }
        catch (error) { sendJson(response, 400, { ok: false, error: error.message }); return }
        if (patch.imageConcurrency !== undefined) config.imageConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(patch.imageConcurrency)) || 2))
        for (const key of ['comfyUrl', 'defaultWorkflow', 'artistPosition', 'weightMode', 'negativeMode', 'styleArtists', 'imageSize', 'plannerProvider', 'plannerModel', 'plannerExtra', 'traitMode', 'visionProvider', 'visionModel', 'plannerEffort', 'visionEffort', 'comfyAuthMode', 'comfyAuthToken', 'comfyAuthUser', 'comfyAuthPass', 'promptManualPositive', 'promptManualNegative']) {
          if (typeof patch[key] === 'string') config[key] = key === 'comfyUrl' ? patch[key].replace(/\/+$/, '') : patch[key]
        }
        for (const key of ['lockWorkflow', 'overrideSteps', 'autoImageGen', 'plannerEnabled', 'jpegOutput', 'smartImageSelection', 'characterAutoUpdate']) if (typeof patch[key] === 'boolean') config[key] = patch[key]
        if (typeof patch.promptMode === 'string' && ['auto', 'tags', 'natural', 'mixed'].includes(patch.promptMode)) config.promptMode = patch.promptMode
        if (typeof patch.activePromptPreset === 'string') config.activePromptPreset = patch.activePromptPreset.slice(0, 80)
        if (Array.isArray(patch.promptPresets)) config.promptPresets = normalizePromptPresets(patch.promptPresets)
        config.activePromptPreset = validPromptPresetId(config)
        if (patch.jpegQuality !== undefined) config.jpegQuality = Math.max(50, Math.min(100, Math.round(Number(patch.jpegQuality) || 88)))
        if (typeof patch.jpegBackground === 'string') config.jpegBackground = /^#?[0-9a-f]{6}$/i.test(patch.jpegBackground.trim()) ? (patch.jpegBackground.trim().startsWith('#') ? patch.jpegBackground.trim() : '#' + patch.jpegBackground.trim()) : '#ffffff'
        for (const key of ['promptManualPositive', 'promptManualNegative']) if (typeof patch[key] === 'string') config[key] = patch[key].slice(0, 4000)
        if (patch.comfyMode === 'simple' || patch.comfyMode === 'workflow') config.comfyMode = patch.comfyMode
        if (patch.comfySimple && typeof patch.comfySimple === 'object' && !Array.isArray(patch.comfySimple)) config.comfySimple = normalizeComfySimpleConfig({ ...config.comfySimple, ...patch.comfySimple })
        if (typeof patch.traitMode === 'string' && ['auto', 'sfw', 'all'].includes(patch.traitMode)) config.traitMode = patch.traitMode
        // 兼容旧字段名（画师串多套）
        if (Array.isArray(patch.artistSets)) {
          config.artistSets = patch.artistSets.filter(x => x && typeof x === 'object').slice(0, 60).map((x, i) => ({
            id: String(x.id ?? ('set' + i)), name: String(x.name ?? ('画师串 ' + (i + 1))).slice(0, 60),
            text: String(x.text ?? '').slice(0, 4000),
            position: x.position === 'suffix' ? 'suffix' : 'prefix',
            enabled: x.enabled !== false,
          }))
        }
        if (typeof patch.activeArtistSet === 'string') config.activeArtistSet = patch.activeArtistSet.slice(0, 60)
        if (Array.isArray(patch.styleArtists)) config.styleArtists = String(patch.styleArtists[0] ?? '')
        if (patch.plannerCount !== undefined) config.plannerCount = Math.max(1, Math.min(8, Number(patch.plannerCount) || 3))
        if (patch.plannerTemperature !== undefined) config.plannerTemperature = Number(patch.plannerTemperature) || 1
        if (Array.isArray(patch.plannerEntries)) config.plannerEntries = patch.plannerEntries.map(Number)
        // 画风预设（数组，要单独处理 —— 上面的 string/boolean 白名单收不了）
        if (Array.isArray(patch.stylePresets)) {
          config.stylePresets = patch.stylePresets
            .filter(x => x && typeof x === 'object')
            .slice(0, 60)
            .map((x, i) => ({
              id: String(x.id ?? ('preset' + i)),
              name: String(x.name ?? ('画风 ' + (i + 1))).slice(0, 60),
              artist: String(x.artist ?? '').slice(0, 4000),
              negative: String(x.negative ?? '').slice(0, 2000),
              position: x.position === 'suffix' ? 'suffix' : 'prefix',
              enabled: x.enabled !== false,
            }))
        }
        if (typeof patch.activePreset === 'string') config.activePreset = patch.activePreset.slice(0, 60)
        if (typeof patch.styleNegative === 'string') config.styleNegative = patch.styleNegative.slice(0, 2000)
        if (patch.imageGenCount !== undefined) config.imageGenCount = Math.max(1, Math.min(6, Number(patch.imageGenCount) || 2))
        if (patch.injectWeight !== undefined) config.injectWeight = Number(patch.injectWeight) || 0
        if (patch.sizes && typeof patch.sizes === 'object') config.sizes = patch.sizes
        await saveConfig(config)
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'workflow') {
        const id = String(body?.id ?? '')
        const target = config.workflows.find(item => String(item.id) === id)
        if (!target) { sendJson(response, 404, { ok: false, error: '没有这个工作流条目' }); return }
        if (body.label !== undefined) target.label = String(body.label)
        if (body.match !== undefined) target.match = Array.isArray(body.match) ? body.match.map(String) : splitTags(String(body.match))
        if (body.sizes !== undefined) target.sizes = body.sizes && typeof body.sizes === 'object' ? body.sizes : null
        if (body.enabled !== undefined) target.enabled = Boolean(body.enabled)
        if (body.remove === true) config.workflows = config.workflows.filter(item => String(item.id) !== id)
        await saveConfig(config)
        await loadAllWorkflows()
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'reload') {
        config.workflows = await scanWorkflows(config)
        await loadAllWorkflows()
        definitions = await loadDefinitions()
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'definitions') {
        const next = body?.definitions ?? {}
        // ⚠ 防护（2026-10-07）：曾经有一次前端/脚本带着空数组调用这个接口，
        //   把用户辛苦建的角色一次性清光。现在：新数据为空而现有数据非空时直接拒绝。
        const curChars = Array.isArray(definitions?.characters) ? definitions.characters : []
        const curOutfits = Array.isArray(definitions?.outfits) ? definitions.outfits : []
        // 缺省字段保留旧库；只有显式数组才替换，兼容只编辑人物的客户端。
        const nextChars = Array.isArray(next.characters) ? next.characters : curChars
        const nextOutfits = Array.isArray(next.outfits) ? next.outfits : curOutfits
        if (nextChars.length === 0 && curChars.length > 0) {
          sendJson(response, 200, {
            ok: false,
            error: '拒绝把 ' + curChars.length + ' 个角色清空（提交里 characters 为空）。若确实要清空，请先删到只剩 1 个。',
            refused: 'would-empty-characters',
          })
          return
        }
        if (nextOutfits.length === 0 && curOutfits.length > 0 && nextChars.length === 0) {
          sendJson(response, 200, {
            ok: false,
            error: '拒绝清空服装库（提交里 outfits 为空且没有携带角色数据）。',
            refused: 'would-empty-outfits',
          })
          return
        }
        definitions = {
          version: 3,
          characters: nextChars.map((item, i) => normalizeDefinition('characters', item, i)),
          settings: (Array.isArray(next.settings) ? next.settings : definitions.settings).map((item, i) => normalizeDefinition('settings', item, i)),
          props: (Array.isArray(next.props) ? next.props : definitions.props).map((item, i) => normalizeDefinition('props', item, i)),
          outfits: nextOutfits.map((item, i) => normalizeOutfit(item, i)),
        }
        await saveDefinitions(definitions)
        sendJson(response, 200, { ok: true, state: await consoleState() })
        return
      }

      if (action === 'img') {
        // 给卡里的显示正则用：/img?key=<jobId 前 8 位>
        try {
          const key = String(_url?.searchParams?.get('key') ?? '').toLowerCase()
          let hit = null
          for (const job of jobs.values()) {
            if (String(job.id).toLowerCase().startsWith(key) && key.length >= 6) { hit = job; break }
          }
          if (!hit) { sendJson(response, 404, { ok: false, error: '没有这个插图' }); return }
          if (hit.state !== 'done' || !hit.byteLength) { sendJson(response, 404, { ok: false, error: '这张还没画好' }); return }
          sendImage(response, hit, request.headers.range)
        } catch (error) {
          sendJson(response, 404, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'cards') {
        try {
          const dir = join(TAVERN_DATA, 'resources', 'cards')
          const names = await readdir(dir).catch(() => [])
          const cards = names
            .filter(name => /\.json$/i.test(name))
            .map(name => ({ path: 'cards/' + name, name: name.replace(/\.json$/i, '') }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
          sendJson(response, 200, { ok: true, cards })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'job-detail') {
        const job = getJob(String(_url?.searchParams?.get('id') ?? ''))
        if (!job) { sendJson(response, 404, { ok: false, error: '没有这个作业' }); return }
        sendJson(response, 200, { ok: true, job: consoleJob(job) })
        return
      }

      if (action === 'redraw') {
        try {
          const src = getJob(String(body?.jobId ?? ''))
          if (!src) { sendJson(response, 404, { ok: false, error: '找不到原图' }); return }
          const card = await currentCard(String(body?.sessionId ?? lastSessionId ?? ''))
          const defs = { ...definitions, characters: (definitions.characters ?? []).filter(character => usableOnCard(character, card)) }
          const askedRaw = String(body?.prompt ?? src.params?.rawTag ?? src.params?.tag ?? '')
          const fresh = await startJob({
            tag: normalizePrompts(expandRosterCalls(askedRaw, defs, config.traitMode), defs),
            rawTag: askedRaw,
            artist: src.params?.artist,
            negative: String(body?.negative ?? src.params?.negative ?? ''),
            model: src.workflowId,
          }, { label: '重画' })
          logger.info?.('dsh-tavern-comfy: 重画 ' + src.id.slice(0, 8) + ' → ' + fresh.id.slice(0, 8))
          sendJson(response, 200, { ok: true, jobId: fresh.id, job: consoleJob(fresh) })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'improve-prompt') {
        try {
          const src = getJob(String(body?.jobId ?? ''))
          const current = String(body?.prompt ?? src?.positive ?? '')
          const instruction = String(body?.instruction ?? '')
          // 和 planMessage 一样：没单独指定就跟随 Tavern 的默认后台模型
          const fallback = await backgroundModel(body?.sessionId ?? lastSessionId)
          const provider = String(config.plannerProvider || fallback?.provider || '')
          const model = String(config.plannerModel || fallback?.model || '')
          if (!provider || !model) { sendJson(response, 400, { ok: false, error: '还没选规划用的模型，且 Tavern 设置里也没有「默认后台模型」（设置页 → 规划）' }); return }
          const system = [
            '你是绘图提示词编辑。',
            '只输出修改后的英文 Tag 串，一行，不要解释、不要加引号、不要换行。',
            '保留原有的人物身份与画风 Tag，只按用户要求增删调整。',
          ].join('\n')
          const ask = [
            '现有提示词：',
            current,
            '',
            '用户要求：' + (instruction || '让画面更贴合剧情、细节更丰富'),
            '',
            '只输出修改后的提示词。',
          ].join('\n')
          const out = await runPlanner(deps.llm, { provider, model, system, text: ask, maxTokens: 1200, temperature: 0.7 })
          const next = String(out?.text ?? '').split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
          if (!next) { sendJson(response, 400, { ok: false, error: '模型没返回内容' }); return }
          sendJson(response, 200, { ok: true, prompt: next })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      if (action === 'report') {
        try {
          addClientReport({
            at: Date.now(),
            stage: String(body?.stage ?? 'unknown').slice(0, 80),
            data: body?.data ?? null,
          })
        } catch { /* 报告失败不影响前端 */ }
        sendJson(response, 200, { ok: true })
        return
      }

      if (action === 'cancel') {
        const job = jobs.get(String(body?.id ?? ''))
        if (job && job.backend && job.backend !== 'comfyui' && ['pending', 'running'].includes(job.state)) {
          job.controller?.abort()
          job.state = 'cancelled'
          persistJobs()
          sendJson(response, 200, { ok: true })
        } else sendJson(response, 200, { ok: cancelTask(String(body?.id ?? '')) })
        return
      }

      if (action === 'design') {
        try {
          try { addClientReport({ at: Date.now(), stage: 'design-received', data: { hasCurrent: Boolean(body?.current), name: String(body?.current?.name ?? ''), briefLen: String(body?.brief ?? '').length } }) } catch {}
          const designed = await designCharacters({
            brief: String(body?.brief ?? ''),
            sessionId: String(body?.sessionId ?? lastSessionId ?? ''),
            useCard: body?.useCard !== false,
            photo: body?.data ? { data: body.data, mediaType: body.mediaType, name: body.name } : null,
            current: body?.current && typeof body.current === 'object' ? body.current : null,
          })
          sendJson(response, 200, { ok: true, people: designed.people, raw: designed.raw })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'vision') {
        try {
          const described = await describePhoto({
            data: body?.data, mediaType: body?.mediaType, name: body?.name, sessionId: body?.sessionId,
          })
          sendJson(response, 200, described)
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'plan') {
        if (!String(body?.text ?? '').trim() && body?.sessionId) {
          const fromSession = messageTextFrom(String(body.sessionId), String(body?.messageId ?? ''))
          if (fromSession) body.text = fromSession
        }
        try {
          const plan = await planMessage({
            text: String(body?.text ?? ''),
            messageId: String(body?.messageId ?? ''),
            turn: body?.turn,
            count: body?.count,
            sessionId: String(body?.sessionId ?? lastSessionId ?? ''),
            manual: body?.manual === true,
          })
          sendJson(response, 200, { ok: true, plan, plans: plan.plans, raw: plan.raw ?? '', error: plan.error ?? null })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      if (action === 'generate') {
        try {
          const job = await startJob({
            tag: String(body?.tag ?? ''), artist: String(body?.artist ?? ''), negative: String(body?.negative ?? ''),
            size: String(body?.size ?? '竖图'), model: String(body?.workflow ?? ''),
          }, { label: '控制台试画' })
          sendJson(response, 200, { ok: true, jobId: job.id, job })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error?.message ?? String(error) })
        }
        return
      }

      sendJson(response, 404, { ok: false, error: 'not-found' })
    }



    return {
      consoleHtml, consoleState, handleConsole, readBody, sendImage,
      startJob, refresh, getJob: id => (id ? getJob(id) : null), findJob, publicJob,
      planFromTool, planMessage,
      currentConfig: () => config,
      // 手动配图：读这一轮的 textVersion 与正文，再交给官方桥 attach
      attachTurn: async ({ gameId, turn }) => {
        // 桥是异步装配的（要等 runtime 起来），用户手快时它可能还没就绪 —— 最多等 20 秒
        for (let waited = 0; !deps.bridge?.attachTurn && waited < 20000; waited += 200) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        if (!deps.bridge?.attachTurn) return { attached: 0, error: 'Tavern 官方接口桥未安装（当前 Tavern 可能没有插件接口）' }
        if (!deps.tavern || typeof deps.tavern.getTurn !== 'function') return { attached: 0, error: '当前 Tavern 没有 tavern.getTurn' }
        const settled = await deps.tavern.getTurn({ gameId, turn })
        if (!settled) return { attached: 0, error: '读不到这一轮（可能还没结算完，或轮次号不对）' }
        // 手动这条路也把「哪张卡」记下来（和自动那条共用一个缓存）
        rememberTurn(gameId, turn, settled.card)
        return deps.bridge.attachTurn({ gameId, turn, textVersion: settled.textVersion, text: settled.text, manual: true })
      },
    }
  })()
}

// =====================================================================
// 配置 / 工作流库 / 人物库
// =====================================================================

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`${path} 读取失败：${error.message}`)
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function cacheRoot(config) { return join(ROOT, String(config.cacheDir || DEFAULTS.cacheDir)) }

function imageMediaTypeFromBytes(bytes) {
  if (!bytes || bytes.length < 4) return ''
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return ''
}

/** 按配置生成 ComfyUI 的鉴权头。 */
function comfyHeaders(config) {
  const mode = String(config?.comfyAuthMode ?? 'none')
  if (mode === 'bearer' && config?.comfyAuthToken) return { authorization: 'Bearer ' + String(config.comfyAuthToken) }
  if (mode === 'basic' && config?.comfyAuthUser) {
    const raw = String(config.comfyAuthUser) + ':' + String(config.comfyAuthPass ?? '')
    return { authorization: 'Basic ' + Buffer.from(raw, 'utf8').toString('base64') }
  }
  return {}
}

/**
 * 取当前启用的画师串。多套里选一套（activeArtistSet 指向它），
 * 没选就用默认的 styleArtists；每套自己带 position（放最前 / 放最后）。
 */
function activeArtistText(config) {
  const fallback = { text: String(config?.styleArtists ?? ''), position: 'prefix', name: '默认', negative: String(config?.styleNegative ?? '') }
  const id = String(config?.activePreset ?? config?.activeArtistSet ?? '')
  if (!id) return fallback
  // 新版：画风预设
  const presets = Array.isArray(config?.stylePresets) ? config.stylePresets : []
  const p = presets.find(s => s && String(s.id) === id && s.enabled !== false)
  if (p && String(p.artist ?? '').trim()) {
    return { text: String(p.artist), position: p.position === 'suffix' ? 'suffix' : 'prefix', name: String(p.name ?? ''), negative: String(p.negative ?? '') }
  }
  // 兼容旧版：画师串多套
  const sets = Array.isArray(config?.artistSets) ? config.artistSets : []
  const hit = sets.find(s => s && String(s.id) === id && s.enabled !== false)
  if (hit && String(hit.text ?? '').trim()) {
    return { text: String(hit.text), position: hit.position === 'suffix' ? 'suffix' : 'prefix', name: String(hit.name ?? ''), negative: String(config?.styleNegative ?? '') }
  }
  return fallback
}

/** 扫描 workflows/ 目录，把配置里没有的文件补成条目（配置里的既有条目优先）。 */
async function scanWorkflows(config) {
  const configured = Array.isArray(config.workflows) ? config.workflows : []
  const byFile = new Map()
  for (const item of configured) if (item?.file) byFile.set(String(item.file).replace(/\\/g, '/'), item)
  const files = await readdir(WORKFLOW_DIR).catch(() => [])
  const merged = []
  for (const file of files.filter(item => item.toLowerCase().endsWith('.json')).sort()) {
    const rel = `workflows/${file}`
    const existing = byFile.get(rel) ?? byFile.get(file)
    merged.push(existing
      ? { ...existing, file: rel }
      : { id: file.replace(/\.json$/i, ''), label: file.replace(/\.json$/i, ''), file: rel, match: [], sizes: null })
  }
  for (const item of configured) {
    if (!item?.file) continue
    const rel = String(item.file).replace(/\\/g, '/')
    if (!merged.some(entry => entry.file === rel)) merged.push({ ...item, file: rel, missing: true })
  }
  return merged
}

async function loadConfig(overrides) {
  const file = await readJson(CONFIG_PATH, {})
  const config = { ...DEFAULTS, ...file, ...(overrides ?? {}) }
  config.comfyUrl = String(config.comfyUrl || DEFAULTS.comfyUrl).replace(/\/+$/, '')
  config.comfyMode = config.comfyMode === 'simple' ? 'simple' : 'workflow'
  config.comfySimple = normalizeComfySimpleConfig(config.comfySimple)
  config.promptPresets = normalizePromptPresets(config.promptPresets)
  if (!['auto', 'tags', 'natural', 'mixed'].includes(config.promptMode)) config.promptMode = 'auto'
  config.activePromptPreset = validPromptPresetId(config, String(config.activePromptPreset ?? '').slice(0, 80))
  config.promptManualPositive = String(config.promptManualPositive ?? '').slice(0, 4000)
  config.promptManualNegative = String(config.promptManualNegative ?? '').slice(0, 4000)
  config.jpegOutput = config.jpegOutput === true
  config.jpegQuality = Math.max(50, Math.min(100, Math.round(Number(config.jpegQuality) || 88)))
  config.jpegBackground = /^#?[0-9a-f]{6}$/i.test(String(config.jpegBackground ?? '')) ? ('#' + String(config.jpegBackground).replace(/^#/, '')) : '#ffffff'
  config.injectWeight = Number(config.injectWeight) || 0
  config.imageGenCount = Math.max(1, Math.min(6, Number(config.imageGenCount) || 2))
  config.imageChannels = normalizeChannels(config.imageChannels)
  config.imageConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(config.imageConcurrency)) || 2))
  return config
}

async function saveConfig(config) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = config[key]
  out.workflows = (config.workflows ?? []).map(item => {
    const copy = { ...item }
    delete copy.discovered
    delete copy.error
    delete copy.summary
    return copy
  })
  await writeJsonAtomic(CONFIG_PATH, out)
}

function normalizeCharacter(raw, index) {
  const item = {
    id: String(raw?.id ?? `characters-${index + 1}`),
    enabled: raw?.enabled !== false,
    name: String(raw?.name ?? ''),
    match: Array.isArray(raw?.match) ? raw.match.join(', ') : String(raw?.match ?? ''),
    continuity: String(raw?.continuity ?? ''),
    note: String(raw?.note ?? ''),
    inject: raw?.inject && typeof raw.inject === 'object' ? { ...raw.inject } : {},
    // 绑定到哪些卡（空 = 所有卡都能用）；可复用的通用服装 id
    cards: Array.isArray(raw?.cards) ? raw.cards.map(String) : splitTags(raw?.cards),
    outfitRefs: Array.isArray(raw?.outfitRefs) ? raw.outfitRefs.map(String) : splitTags(raw?.outfitRefs),
  }
  const traits = raw?.traits && typeof raw.traits === 'object' ? { ...raw.traits } : {}
  // 兼容最老的单字段写法
  if (!traits.face && raw?.appearance) traits.face = String(raw.appearance)
  for (const [oldKey, newKey] of Object.entries(LEGACY_TRAITS)) {
    if (traits[oldKey] && !traits[newKey]) traits[newKey] = traits[oldKey]
  }
  item.traits = {}
  for (const [key] of CHARACTER_TRAITS) item.traits[key] = String(traits[key] ?? '')
  const outfits = Array.isArray(raw?.outfits) ? raw.outfits.slice() : []
  if (!outfits.length && raw?.outfit) outfits.push({ id: 'o1', name: '常服', body: String(raw.outfit), default: true })
  item.outfits = outfits.map((outfit, j) => ({
    id: String(outfit?.id ?? `outfit-${index + 1}-${j + 1}`),
    name: String(outfit?.name ?? `服装 ${j + 1}`),
    upper: String(outfit?.upper ?? outfit?.body ?? ''),
    lower: String(outfit?.lower ?? ''),
    shoes: String(outfit?.shoes ?? ''),
    accessory: String(outfit?.accessory ?? outfit?.bodyBack ?? ''),
    full: String(outfit?.full ?? ''),
    back: String(outfit?.back ?? outfit?.fullBack ?? ''),
    negative: String(outfit?.negative ?? ''),
    enabled: outfit?.enabled !== false,
    default: outfit?.default === true,
  }))
  return item
}

function normalizeDefinition(kind, raw, index) {
  if (kind === 'characters') return normalizeCharacter(raw, index)
  const item = { id: String(raw?.id ?? `${kind}-${index + 1}`), enabled: raw?.enabled !== false }
  for (const field of DEFINITION_KINDS[kind].fields) {
    const value = raw?.[field]
    item[field] = typeof value === 'string' ? value : (Array.isArray(value) ? value.join(', ') : '')
  }
  item.inject = raw?.inject && typeof raw.inject === 'object' ? { ...raw.inject } : {}
  return item
}

async function loadDefinitions() {
  const raw = await readJson(DEFS_PATH, null)
  const source = raw ?? {}
  return {
    version: 3,
    characters: (source.characters ?? []).map((item, i) => normalizeDefinition('characters', item, i)),
    settings: (source.settings ?? []).map((item, i) => normalizeDefinition('settings', item, i)),
    props: (source.props ?? []).map((item, i) => normalizeDefinition('props', item, i)),
    outfits: (source.outfits ?? []).map((item, i) => normalizeOutfit(item, i)),
  }
}

/** 保存前先备份：万一某次保存把角色写少了，还能从 backups/ 捞回来。 */
async function backupDefinitions() {
  try {
    const current = await readJson(DEFS_PATH, null)
    if (!current || !Array.isArray(current.characters) || !current.characters.length) return
    const dir = join(ROOT, 'backups')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await writeJsonAtomic(join(dir, 'definitions-' + stamp + '.json'), current)
    const files = (await readdir(dir).catch(() => [])).filter(n => /^definitions-/.test(n)).sort()
    for (const old of files.slice(0, Math.max(0, files.length - 12))) {
      await rm(join(dir, old), { force: true }).catch(() => {})
    }
  } catch { /* 备份失败不能挡住保存 */ }
}

/** 完全空的角色（没名字、没外貌、没任何字段）不能入库 —— 曾经因为解析失败写进过两个空白条目。 */
function isEmptyCharacter(character) {
  if (!character || typeof character !== 'object') return true
  if (String(character.name ?? '').trim()) return false
  if (String(character.traits?.face ?? '').trim()) return false
  return !Object.values(character.traits ?? {}).some(v => String(v ?? '').trim())
}


// =====================================================================
// 世界书：导入 / 导出 / 条目开关
// =====================================================================

/** 世界书文件在磁盘上统一存成 { name, entries: [{ comment, content, enabled }] } */
function normalizeWorldbook(raw) {
  if (!raw || typeof raw !== 'object') return null
  // ① 已经是本插件格式
  if (Array.isArray(raw.entries)) {
    return {
      name: String(raw.name ?? '生图世界书'),
      entries: raw.entries.map((e, i) => ({
        comment: String(e?.comment ?? e?.name ?? ('条目 ' + (i + 1))),
        content: String(e?.content ?? ''),
        enabled: e?.enabled !== false,
      })),
    }
  }
  // ② SillyTavern 世界书：{ entries: { "0": {...}, ... } } 或 { "名字": { entries: [...] } }
  const inner = typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    ? raw.entries
    : (Object.values(raw)[0] && typeof Object.values(raw)[0] === 'object' && (Object.values(raw)[0].entries)
        ? Object.values(raw)[0].entries
        : null)
  if (inner) {
    const list = Array.isArray(inner) ? inner : Object.values(inner)
    const entries = list
      .filter(e => e && typeof e === 'object')
      .map((e, i) => ({
        comment: String(e.comment ?? e.name ?? ('条目 ' + (i + 1))),
        content: String(e.content ?? ''),
        enabled: e.enabled !== false && e.disable !== true,
      }))
      .filter(e => e.content.trim())
    if (entries.length) return { name: String(raw.name ?? Object.keys(raw)[0] ?? '导入的世界书'), entries }
  }
  // ③ 纯数组
  if (Array.isArray(raw)) {
    const entries = raw
      .filter(e => e && typeof e === 'object')
      .map((e, i) => ({ comment: String(e.comment ?? e.name ?? ('条目 ' + (i + 1))), content: String(e.content ?? ''), enabled: e.enabled !== false }))
      .filter(e => e.content.trim())
    if (entries.length) return { name: '导入的世界书', entries }
  }
  // ④ 纯文本：按空行切成条目
  if (typeof raw === 'string' && raw.trim()) {
    const chunks = raw.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    return { name: '导入的世界书', entries: chunks.map((c, i) => ({ comment: '条目 ' + (i + 1), content: c, enabled: true })) }
  }
  return null
}

/**
 * 原子写 + 重试。Windows 上两个写入同时 rename 同一个目标会抛 EPERM，
 * 重试几次就过去了（那个抢占的写入通常几毫秒就结束）。
 */
/**
 * 直接覆盖写（不经过 rename）。
 *
 * 这个目录里 rename 覆盖已存在的文件会被系统拒绝（EPERM: operation not permitted），
 * 所以这里放弃"原子替换"，改成「先把旧内容存一份备份 → 直接写目标文件」。
 * 对世界书这种几 MB 以内的文件足够安全。
 */
async function writeJsonSafe(path, value, backupDir) {
  const text = JSON.stringify(value, null, 2)
  // 先备份旧的（失败不影响写入）
  try {
    const old = await readFile(path, 'utf8')
    if (old && backupDir) {
      await mkdir(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      await writeFile(join(backupDir, path.split(/[\\/]/).pop().replace(/\.json$/, '') + '-' + stamp + '.json'), old, 'utf8')
    }
  } catch { /* 没有旧文件就没得备份 */ }

  let lastError = null
  for (let i = 0; i < 6; i++) {
    try {
      // 目标可能是只读的（打包时带的 0444 权限）——直接写会被系统拒绝（EPERM），先去掉只读
      await chmod(path, 0o644).catch(() => {})
      await writeFile(path, text, 'utf8')
      return true
    } catch (error) {
      lastError = error
      // 还是不行就删掉重写（目录本身是可写的，删得掉）
      if (i === 3) {
        try {
          const { rm } = await import('node:fs/promises')
          await rm(path, { force: true })
        } catch {}
      }
      await new Promise(r => setTimeout(r, 50 * (i + 1)))
    }
  }
  throw lastError ?? new Error('写入失败')
}

async function writeJsonRetry(path, value, tries = 6) {
  let lastError = null
  for (let i = 0; i < tries; i++) {
    try {
      await writeJsonAtomic(path, value)
      return true
    } catch (error) {
      lastError = error
      await new Promise(r => setTimeout(r, 40 * (i + 1)))
    }
  }
  throw lastError ?? new Error('写入失败')
}

async function saveDefinitions(definitions) {
  // ═══ 防清空闸门（2026-10-07）═══
  // 事故：有脚本带着空 body 调用 definitions 接口，把用户 5 个角色 + 4 套服装
  //       一次性覆盖成空。这里是最底层的写入口，所有路径都经过它，所以闸门放这。
  try {
    const before = await readJson(DEFS_PATH, null)
    const beforeChars = Array.isArray(before?.characters) ? before.characters.length : 0
    const nextChars = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (beforeChars > 0 && nextChars === 0) {
      throw new Error('refused: would empty ' + beforeChars + ' characters')
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('refused:')) {
      // 记一笔到 backups（模块级没有 logger）
      try {
        const dir = join(ROOT, 'backups')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'refused-empty-' + Date.now() + '.txt'),
          '已拒绝清空角色库：' + String(error.message) + '\n')
      } catch {}
      return false
    }
    // 读磁盘失败不该阻断正常保存
  }
  // 双保险：前端万一漏了，这里再挡一次
  if (Array.isArray(definitions?.characters)) {
    const kept = definitions.characters.filter(ch => !isEmptyCharacter(ch))
    if (kept.length !== definitions.characters.length) {
      /* 拦下空角色（模块级没日志器，静默处理） */
      definitions = Object.assign({}, definitions, { characters: kept })
    }
  }
  // 这里不能打日志：saveDefinitions 是模块级函数，logger / addClientReport 在 runtime 闭包里
  try {
    const before = await readJson(DEFS_PATH, null)
    // 只在"角色数变少"时留痕（那是需要事后追查的情况），且走文件而不是 logger
    const wasCount = Array.isArray(before?.characters) ? before.characters.length : 0
    const nowCount = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (wasCount > nowCount) {
      const dir = join(ROOT, 'backups')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'characters-dropped-' + Date.now() + '.txt'),
        '角色数从 ' + wasCount + ' 减到 ' + nowCount + '\n' +
        '原来：' + (before.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n' +
        '现在：' + (definitions.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n', 'utf8')
    }
  } catch {}
  // 角色数变少时先备份并记一笔，方便事后追查
  try {
    const before = await readJson(DEFS_PATH, null)
    const wasCount = Array.isArray(before?.characters) ? before.characters.length : 0
    const nowCount = Array.isArray(definitions?.characters) ? definitions.characters.length : 0
    if (nowCount) {
      await backupDefinitions()
      if (wasCount > nowCount) {
        try {
          const dir = join(ROOT, 'backups')
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'characters-dropped-' + Date.now() + '.txt'),
            '角色数从 ' + wasCount + ' 减到 ' + nowCount + '\n' +
            '原来：' + (before.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n' +
            '现在：' + (definitions.characters ?? []).map(c => c.name || '(无名)').join('、') + '\n', 'utf8')
        } catch {}
      }
    }
  } catch {}
  await writeJsonSafe(DEFS_PATH, {
    version: 3,
    characters: definitions.characters ?? [],
    settings: definitions.settings ?? [],
    props: definitions.props ?? [],
    outfits: definitions.outfits ?? [],
  }, join(ROOT, 'backups'))
}

/** 从工作流里读几个"人看得懂"的事实：用了哪个底模、挂了哪些 LoRA、多少节点。 */

// =====================================================================
// 工作流：导入（ComfyUI API JSON）与节点自动识别
// =====================================================================

/**
 * 从 ComfyUI 的 API 格式 JSON 里认出一张工作流的"可调参数"。
 * 正/负面靠"谁连到采样器的 positive / negative 输入"判断，这是唯一可靠的办法。
 */
function detectWorkflow(nodes) {
  const bind = { positive: [], negative: [], seed: [], batch: [], size: [], steps: [], cfg: [], model: [], loras: [], sampler: [] }
  const list = Object.entries(nodes ?? {}).map(([id, node]) => ({ id, node }))
  const byType = (t) => list.filter(x => x.node?.class_type === t)

  // 采样器（各种 KSampler 变体）
  const samplers = list.filter(x => /^KSampler/i.test(String(x.node?.class_type ?? '')))
  for (const { id, node } of samplers) {
    const inp = node.inputs ?? {}
    // 正/负面：采样器的 positive / negative 指向的节点
    for (const [role, key] of [['positive', 'positive'], ['negative', 'negative']]) {
      const link = inp[key]
      const srcId = Array.isArray(link) ? String(link[0]) : (typeof link === 'string' ? link : '')
      if (srcId && nodes[srcId]) {
        bind[role].push({ node: srcId, input: 'text' })
      }
    }
    if (typeof inp.noise_seed === 'number' || 'noise_seed' in inp) bind.seed.push({ node: id, input: 'noise_seed' })
    if (typeof inp.seed === 'number' || 'seed' in inp) bind.seed.push({ node: id, input: 'seed' })
    if ('steps' in inp) bind.steps.push({ node: id, input: 'steps' })
    if ('cfg' in inp) bind.cfg.push({ node: id, input: 'cfg' })
    if ('sampler_name' in inp || 'scheduler' in inp) bind.sampler.push({ node: id })
  }

  // 正/负面兜底：没找到连接关系时，按 CLIPTextEncode 出现顺序（第一个正面、第二个负面）
  if (!bind.positive.length || !bind.negative.length) {
    const encodes = list.filter(x => /CLIPTextEncode|TextEncode/i.test(String(x.node?.class_type ?? '')))
      .filter(x => typeof x.node?.inputs?.text === 'string')
    if (encodes.length) {
      if (!bind.positive.length) bind.positive.push({ node: encodes[0].id, input: 'text' })
      if (!bind.negative.length && encodes.length > 1) bind.negative.push({ node: encodes[1].id, input: 'text' })
    }
  }

  // 尺寸：EmptyLatentImage / 任何带 width+height 的节点
  const sizeNode = list.find(x => typeof x.node?.inputs?.width === 'number' && typeof x.node?.inputs?.height === 'number')
  if (sizeNode) bind.size.push({ node: sizeNode.id, input: 'width' })

  // batch
  const batchNode = list.find(x => 'batch_size' in (x.node?.inputs ?? {}))
  if (batchNode) bind.batch.push({ node: batchNode.id, input: 'batch_size' })

  // 底模
  for (const { id, node } of list) {
    const t = String(node?.class_type ?? '')
    const inp = node?.inputs ?? {}
    if (/CheckpointLoaderSimple|CheckpointLoader/i.test(t) && typeof inp.ckpt_name === 'string') bind.model.push({ node: id, input: 'ckpt_name' })
    else if (/UNETLoader/i.test(t) && typeof inp.unet_name === 'string') bind.model.push({ node: id, input: 'unet_name' })
    else if (/AnimaBoosterLoader/i.test(t) && typeof inp.model_name === 'string') bind.model.push({ node: id, input: 'model_name' })
  }

  // LoRA：每一个 LoraLoader 都列出来（用户可以在界面上改权重 / 停用）
  for (const { id, node } of byType('LoraLoader')) {
    const inp = node.inputs ?? {}
    bind.loras.push({
      node: id,
      input: 'lora_name',
      name: String(inp.lora_name ?? ''),
      strengthModel: Number(inp.strength_model ?? 1),
      strengthClip: Number(inp.strength_clip ?? inp.strength_model ?? 1),
      enabled: true,
    })
  }

  // 输出节点：SaveImage / PreviewImage 优先
  const out = list.find(x => /SaveImage|PreviewImage/i.test(String(x.node?.class_type ?? '')))
  return { bindings: bind, outputNode: out ? out.id : '' }
}

/** 把外部 JSON 规范成插件的工作流格式。接受 ComfyUI API JSON、已带 bindings 的、或裸节点表。 */
function normalizeWorkflow(raw, fallbackName) {
  if (!raw || typeof raw !== 'object') return null
  // 已经是插件的格式
  if (raw.bindings && raw.prompt) {
    return {
      format: 'dsh-tavern-comfy-v1',
      name: String(raw.name ?? fallbackName ?? '导入的工作流'),
      prompt: raw.prompt,
      outputNode: String(raw.outputNode ?? ''),
      bindings: raw.bindings,
      digest: String(raw.digest ?? ''),
    }
  }
  // ComfyUI API JSON：{ "3": {...}, "4": {...} } 或 { prompt: {...} }
  const nodes = raw.prompt && typeof raw.prompt === 'object' ? raw.prompt : (raw.workflow && typeof raw.workflow === 'object' ? raw.workflow : raw)
  const realNodes = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue
    if (typeof node.class_type !== 'string') continue
    realNodes[id] = node
  }
  if (!Object.keys(realNodes).length) return null
  const { bindings, outputNode } = detectWorkflow(realNodes)
  return {
    format: 'dsh-tavern-comfy-v1',
    name: String(raw.name ?? fallbackName ?? '导入的工作流'),
    prompt: realNodes,
    outputNode,
    bindings,
    digest: '',
  }
}

function workflowSummary(raw) {
  const nodes = Object.values(raw?.prompt ?? {})
  const pick = (types, keys) => {
    for (const node of nodes) {
      if (!types.includes(node.class_type)) continue
      for (const key of keys) if (typeof node.inputs?.[key] === 'string') return node.inputs[key]
    }
    return ''
  }
  const sizeNode = nodes.find(node => typeof node.inputs?.width === 'number' && typeof node.inputs?.height === 'number')
  // 正负面的摘要：卡片上直接显示，一眼能看出这张给模型灌了什么
  const peek = (arr) => {
    const it = Array.isArray(arr) ? arr[0] : null
    if (!it) return ''
    const text = nodes.find(n => String(n.__id) === String(it.node))?.inputs?.[it.input || 'text']
    const raw = (raw0 && raw0.prompt && raw0.prompt[it.node] && raw0.prompt[it.node].inputs && raw0.prompt[it.node].inputs[it.input || 'text'])
    const v = raw ?? text ?? ''
    return String(v).replace(/\s+/g, ' ').slice(0, 60)
  }
  const raw0 = raw
  const positivePeek = peek(raw0?.bindings?.positive)
  const negativePeek = peek(raw0?.bindings?.negative)
  return {
    positivePeek,
    negativePeek,
    model: pick(['UNETLoader', 'CheckpointLoaderSimple', 'AnimaBoosterLoader'], ['unet_name', 'ckpt_name', 'model_name']),
    clip: pick(['CLIPLoader', 'DualCLIPLoader'], ['clip_name', 'clip_name1']),
    loras: nodes.filter(node => node.class_type === 'LoraLoader').map(node => node.inputs?.lora_name).filter(Boolean),
    base: sizeNode ? `${sizeNode.inputs.width}x${sizeNode.inputs.height}` : '',
    nodeCount: nodes.length,
  }
}

// =====================================================================
// 提示词处理
// =====================================================================

/** NovelAI 的 {}/[]/n::tag:: 权重语法 → SD 的 (tag:n)。 */
export function convertWeights(text) {
  let out = String(text ?? '')
  out = out.replace(/(-?\d+(?:\.\d+)?)::([^:]+)::/g, (_m, weight, tag) => {
    const value = Number(weight)
    if (!Number.isFinite(value)) return tag.trim()
    if (value <= 0) return `(${tag.trim()}:0.5)`
    return `(${tag.trim()}:${String(Math.min(2, Math.max(0.5, value))).slice(0, 5)})`
  })
  out = out.replace(/(\{+)([^{}]+)(\}+)/g, (_m, open, body, close) => {
    const depth = Math.min(4, Math.min(open.length, close.length))
    return `(${body.trim()}:${[0, 1.05, 1.1, 1.15, 1.2][depth]})`
  })
  // 方括号只剥括号保留内容：NAI 的 [[[artist:x]]] 在 SD 系里不该被当成降权
  out = out.replace(/(\[+)([^[\]]+)(\]+)/g, (_m, _open, body) => body.trim())
  return tidyTags(out)
}

export function stripWeights(text) {
  return tidyTags(String(text ?? '')
    .replace(/-?\d+(?:\.\d+)?::([^:]+)::/g, '$1')
    .replace(/[{}[\]]/g, ''))
}

function tidyTags(text) {
  return String(text).split(',').map(part => part.trim()).filter(Boolean).join(', ')
}

function splitTags(text) {
  return String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)
}

/** 拆出"已经出现过的 tag"集合，用于避免重复注入。 */
function tagSet(text) {
  const set = new Set()
  const lower = String(text).toLowerCase().replace(/:\s*[\d.]+\s*(?=[,)]|$)/g, '')
  for (const part of lower.split(',')) {
    const tag = part.trim().replace(/^[([]+/, '').replace(/[)\]]+$/, '').trim()
    if (!tag) continue
    set.add(tag)
    const colon = tag.indexOf(':')
    if (colon >= 0) {
      const tail = tag.slice(colon + 1).trim()
      if (tail) set.add(tail)
    }
  }
  return set
}

function applyWeights(text, mode) {
  return mode === 'strip' ? stripWeights(text) : convertWeights(text)
}

/** 人物库注入：提示词里出现某个定义的名字（或触发词）时，把它的稳定 tag 补齐。 */
export function injectDefinitions(text, definitions, config = {}) {
  const source = String(text ?? '')
  if (!source || !definitions) return { text: source, hits: [] }
  const have = tagSet(source)
  const added = []
  const hits = []
  const negatives = []
  const weight = Number(config.injectWeight) || 0
  const nsfw = NSFW_HINT.test(source)
  const back = BACK_VIEW.test(source)
  const full = FULL_FRAME.test(source)
  for (const character of definitions.characters ?? []) {
    if (!character || character.enabled === false) continue
    const keys = splitTags(character.match).length ? splitTags(character.match) : [character.name].filter(Boolean)
    if (!keys.some(key => key && source.includes(key))) continue
    hits.push(character.name || character.id)
    const picked = characterTags(character, { nsfw, back, full, mode: config.traitMode })
    for (const raw of picked.tags) {
      for (const tag of splitTags(raw)) {
        const key = tag.toLowerCase()
        if (!key || have.has(key)) continue
        have.add(key)
        added.push(weight > 0 && weight !== 1 ? `(${tag}:${weight})` : tag)
      }
    }
    // 人物的负面词（例如"不要画成小孩"）走负向通道，绝不进正向提示词
    for (const raw of picked.negative) {
      for (const tag of splitTags(raw)) {
        const key = tag.toLowerCase()
        if (!key || negatives.includes(tag)) continue
        negatives.push(tag)
      }
    }
  }
  for (const kind of ['settings', 'props']) {
    for (const def of definitions[kind] ?? []) {
      if (!def || def.enabled === false) continue
      const keys = splitTags(def.match).length ? splitTags(def.match) : [def.name].filter(Boolean)
      if (!keys.some(key => key && source.includes(key))) continue
      hits.push(def.name || def.id)
      for (const field of DEFINITION_KINDS[kind].fields) {
        if (field === 'name' || field === 'match') continue
        const enabled = def.inject?.[field]
        if (enabled === false) continue
        if (DEFAULT_OFF_FIELDS.has(field) && enabled !== true) continue
        const value = String(def[field] ?? '').trim()
        if (!value) continue
        for (const tag of splitTags(value)) {
          const key = tag.toLowerCase()
          if (!key || have.has(key)) continue
          have.add(key)
          added.push(weight > 0 && weight !== 1 ? `(${tag}:${weight})` : tag)
        }
      }
    }
  }
  return { text: added.length ? `${source}, ${added.join(', ')}` : source, hits, negatives }
}

// =====================================================================
// 编译工作流
// =====================================================================

function setBinding(prompt, items, value) {
  for (const item of items ?? []) {
    const node = prompt[item.node]
    if (node && Object.hasOwn(node.inputs, item.input)) node.inputs[item.input] = value
  }
}

function applySize(prompt, size, sizes) {
  let target = sizes?.[size] ?? null
  if (!target) {
    // 规划模型给的"832x1216"这类像素尺寸直接用
    const hit = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(size ?? '').trim())
    if (hit) target = { width: Number(hit[1]), height: Number(hit[2]) }
  }
  if (!target) return null
  const nodes = Object.values(prompt).filter(node => typeof node.inputs?.width === 'number' && typeof node.inputs?.height === 'number')
  if (!nodes.length) return null
  for (const node of nodes) { node.inputs.width = target.width; node.inputs.height = target.height }
  return target
}

function prepareImagePrompt({ workflow, params, config, definitions }) {
  const tag = String(params.tag ?? '').trim()
  const artist = String(params.artist ?? '').trim()
  const backend = promptBackendContext(config, workflow)
  const mode = resolvePromptMode(config, backend)

  const rawBase = (params.artistPosition ?? config.artistPosition) === 'suffix'
    ? [tag, artist].filter(Boolean).join(', ')
    : [artist, tag].filter(Boolean).join(', ')
  const base = composePresetText([rawBase, String(config.promptManualPositive ?? '')].filter(Boolean).join(mode === 'tags' ? ', ' : '. '), config, backend)
  const injected = injectDefinitions(base, definitions, config)
  const positive = formatPromptForBackend(applyWeights(injected.text, config.weightMode), backend, mode)

  const workflowNegative = String(
    workflow?.bindings.negative?.length
      ? workflow.prompt[workflow.bindings.negative[0].node]?.inputs?.[workflow.bindings.negative[0].input] ?? ''
      : '',
  )
  const pluginNegative = [activeArtistText(config).negative, promptPresetNegative(config), config.promptManualNegative, String(params.negative ?? '')].filter(Boolean).join(', ')
  const baseNegative = workflow ? ({
    plugin: pluginNegative,
    workflow: workflowNegative,
    merge: [workflowNegative, pluginNegative].filter(Boolean).join(', '),
  }[config.negativeMode] ?? pluginNegative) : pluginNegative
  const negative = formatPromptForBackend([baseNegative, ...(injected.negatives ?? [])].filter(Boolean).join(', '), backend, mode)
  return { positive, negative, hits: injected.hits }
}

export function compileChannelJob({ params, config, definitions }) {
  const prepared = prepareImagePrompt({ params, config, definitions })
  const dimensions = config.sizes?.[params.size]
  const pixels = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(params.size ?? ''))
  const size = pixels ? { width: Number(pixels[1]), height: Number(pixels[2]) } : dimensions || { width: 832, height: 1216 }
  if (![size.width, size.height].every(value => Number.isInteger(value) && value >= 64 && value <= 8192)) throw new Error('图片尺寸需在 64–8192 像素之间')
  return { ...prepared, seed: randomInt(0, 2 ** 32), size, loras: [] }
}

export function compileJob({ workflow, params, config, definitions }) {
  const prompt = structuredClone(workflow.prompt)
  const { positive, negative, hits } = prepareImagePrompt({ workflow, params, config, definitions })

  setBinding(prompt, workflow.bindings.positive, positive)
  if (workflow.bindings.negative?.length) setBinding(prompt, workflow.bindings.negative, applyWeights(negative, config.weightMode))

  const seed = Number.isSafeInteger(workflow.fixedSeed) && workflow.fixedSeed >= 0
    ? workflow.fixedSeed
    : randomInt(0, 2 ** 47)
  if (workflow.bindings.seed?.length) setBinding(prompt, workflow.bindings.seed, seed)

  for (const node of Object.values(prompt)) {
    if (Object.hasOwn(node.inputs ?? {}, 'batch_size') && typeof node.inputs.batch_size === 'number') node.inputs.batch_size = 1
  }

  // 应用 LoRA：按工作流自己的 LoRA 列表（在「画风」页里改）写回节点。
  // 停用一条 = 把两个权重都设 0（ComfyUI 里 0 就等于不生效），而不是删节点，保证连线不坏。
  const loraApplied = []
  for (const lora of workflow.bindings.loras ?? []) {
    const node = prompt[lora.node]
    if (!node || !node.inputs) continue
    if (lora.enabled === false) {
      if (Object.hasOwn(node.inputs, 'strength_model')) node.inputs.strength_model = 0
      if (Object.hasOwn(node.inputs, 'strength_clip')) node.inputs.strength_clip = 0
      loraApplied.push({ name: lora.name || ('节点 ' + lora.node), off: true })
      continue
    }
    if (lora.name && Object.hasOwn(node.inputs, 'lora_name')) node.inputs.lora_name = String(lora.name)
    const sm = Number(lora.strengthModel)
    const sc = Number(lora.strengthClip)
    if (Number.isFinite(sm) && Object.hasOwn(node.inputs, 'strength_model')) node.inputs.strength_model = sm
    if (Number.isFinite(sc) && Object.hasOwn(node.inputs, 'strength_clip')) node.inputs.strength_clip = sc
    loraApplied.push({ name: lora.name || ('节点 ' + lora.node), model: sm, clip: sc })
  }
  // 注意：这里不能打日志 —— compileJob 是模块级导出函数，拿不到 runtime 的日志器。

  if (config.overrideSteps) {
    if (params.steps !== undefined && params.steps !== '') setBinding(prompt, workflow.bindings.steps, Number(params.steps))
    // cfg 在有些工作流里绑成 guidance
    const cfgValue = Number(params.cfg)
    if (params.cfg !== undefined && params.cfg !== '' && Number.isFinite(cfgValue)) {
      if ((workflow.bindings.guidance ?? []).length) setBinding(prompt, workflow.bindings.guidance, cfgValue)
      if ((workflow.bindings.cfg ?? []).length) setBinding(prompt, workflow.bindings.cfg, cfgValue)
    }
  }

  const size = applySize(prompt, params.size, workflow.sizes ?? config.sizes ?? null)
  return { prompt, seed, positive, negative, size, hits, workflowId: workflow.id, loras: loraApplied }
}

/** 挑工作流：先看锁定 / 默认，再按外部传来的 model 匹配 id / label / match。 */
function pickWorkflow(workflows, config, model) {
  const key = String(model ?? '').trim()
  if (!config.lockWorkflow && key) {
    for (const wf of workflows) {
      if (wf.id === key || wf.label === key || (wf.match ?? []).includes(key)) return wf
    }
  }
  return workflows.find(wf => wf.id === config.defaultWorkflow)
    ?? workflows.find(wf => !wf.error)
    ?? workflows[0]
    ?? null
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (response.headersSent || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.byteLength, 'cache-control': 'no-store' })
  response.end(body)
}
