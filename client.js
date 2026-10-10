/* dsh-tavern-image 浏览器半边。
 *
 * 正文里的图**不再由插件接管渲染**。Tavern 开放官方插件接口后，宿主侧的
 * tavern.attach 已经能把图片和正文版本绑在一起（回退自动隐藏、切回来又出现），
 * 浏览器这边只负责注册与画界面：
 *   1. tavernUi.registerMediaRenderer  画自定义媒体类型（大图 / 右键改提示词 / 查看器）
 *   2. tavernUi.registerMessageAction  消息下方那颗「🎨 生图」按钮
 *   3. tavernUi.registerTextMarker     正文里模型自己写的 image###...### 标记
 *   4. 设置面板 / 控制台 / 历史图库 / 人物库 / 世界书 —— 插件自己的界面
 *
 * 配置读取失败时安静退化成纯文本，绝不在宿主启动阶段抛错。 */
window.__ModuleLoader__.load({
  // DSH resolves browser registrations by package.json.name. Keep this key
  // during the upgrade bridge; the host/plugin identity is image.
  id: 'dsh-tavern-comfy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    let React = null
    try { React = require('react') } catch (error) {
      try { console.warn('[dsh-tavern-image] React 不可用，浏览器界面已禁用:', error?.message) } catch {}
      exports.apply = () => {}
      exports.inject = []
      return module.exports
    }

    const h = React.createElement
    const { useEffect, useState } = React

    // 插件接口前缀。正文渲染跑在 Tavern 的渲染上下文里（不一定等于插件页面的 base），
// 用相对路径会被解析到错误地址、图片直接加载失败，所以这里必须拼成绝对地址。
const absoluteBase = (() => {
  const candidates = []
  try { if (window.top && window.top.location && window.top.location.origin) candidates.push(window.top.location.origin) } catch {}
  try { if (location.origin) candidates.push(location.origin) } catch {}
  try { if (document.baseURI) candidates.push(new URL(document.baseURI).origin) } catch {}
  const origin = candidates.find(o => o && o !== 'null' && /^https?:/i.test(o))
  return (origin || '') + '/plugins/dsh-tavern-image'
})()
const BASE = absoluteBase

function createHistoryRequestEpoch() {
  let activeGameId = ''
  let generation = 0
  let gameGeneration = 0
  return {
    activate(gameId) {
      const next = String(gameId ?? '')
      if (next !== activeGameId) { activeGameId = next; generation++; gameGeneration++ }
    },
    begin(gameId) { this.activate(gameId); return ++generation },
    isActive(gameId) { return String(gameId ?? '') === activeGameId },
    isCurrent(gameId, token) { return String(gameId ?? '') === activeGameId && token === generation },
    captureGame(gameId) { this.activate(gameId); return gameGeneration },
    isGameCurrent(gameId, token) { return String(gameId ?? '') === activeGameId && token === gameGeneration },
    invalidate(gameId) { if (String(gameId ?? '') === activeGameId) { generation++; gameGeneration++ } },
  }
}

function indexedHistoryChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map((change, index) => ({ change, index })).reverse()
}

// 图像查看器的开启函数：由查看器组件挂载时赋值（见下面的 openImageOverlay = ...）。
// 必须在这里显式声明 —— 它以前是「不带声明的赋值」，靠非严格模式在 window 上造一个
// 隐式全局变量。一旦 bundle 被包进严格模式，那行赋值会直接 ReferenceError，而周围
// 十几处 `if (typeof openImageOverlay === 'function')` 守卫会静默放过，
// 表现成「查看器永远打不开、也没有任何报错」。
let openImageOverlay = null

    // 把浏览器里发生的事发回宿主：前端到底跑没跑、有没有抛错，宿主的 /state 里看得到
    //
    // ⚠ 性能守卫（2026-10-07 加入）：本函数被放在**渲染热路径**上调用
    //   （renderAssistantText 每次渲染 → 'renderer-takeover'；
    //     register 的渲染器每次被调 → 'renderer-calls'）。
    //   原来每次调用都发一个 POST，一个几千条消息的会话每轮重渲染就会打出几千个请求，
    //   连接池打满、事件循环被 fetch/JSON 反复占用 —— 实测导致渲染进程被 DSH 看门狗判为
    //   「页面无响应」并反复终止（minidump 显示主线程持续在 V8 中执行、不 yield）。
    //   现在：按 stage+data 指纹去重，同一指纹只在首次发送；并发与总量各有上限；
    //   热路径上的指纹超预算直接丢弃。冷路径（错误、注册结果等）不受影响。
    const REPORT_CONCURRENCY = 6
    const REPORT_TOTAL_BUDGET = 60
    const seenReports = new Set()
    let reportInFlight = 0
    let reportSent = 0
    // 这些 stage 出现在渲染热路径上，指纹超预算时必须丢弃，不能积压
    const HOT_REPORT_STAGES = new Set(['renderer-takeover', 'renderer-called', 'plannedbody-mounted'])
    // 这些是低频且关键的取证上报：不受总量与并发限制，必须发出去。
    // 2026-10-07：history-fail 曾经一条都收不到 —— 因为聊天渲染的 renderer-called
    // 把 6 个并发槽占满，非热路径的失败上报被静默丢弃，导致无法定位真因。
    const CRITICAL_REPORT_STAGES = new Set([
      'history-fail', 'history-ok', 'fetch-retry', 'state-fail',
      'window-error', 'unhandled-rejection',
      // Tavern 官方接口的注册结果：一次会话只会报一次，而且必须能看到（否则没法判断渲染器到底装没装）
      'tavernui-attached', 'tavernui-missing', 'tavernui-marker-registered', 'tavernui-marker-failed',
      'tavernui-media-registered', 'tavernui-media-failed', 'tavernui-action-failed',
      'apply-start', 'seat-registered', 'seat-failed',
    ])

    function reportFingerprint(stage, data) {
      try { return stage + '|' + JSON.stringify(data ?? null) } catch { return stage + '|' }
    }

    function reportHost(stage, data) {
      try {
        const key = reportFingerprint(stage, data)
        // 同一指纹只报一次（去重：这是原来请求量爆炸的主因）
        if (seenReports.has(key)) return
        if (!CRITICAL_REPORT_STAGES.has(stage)) {
          if (reportSent >= REPORT_TOTAL_BUDGET) {
            if (HOT_REPORT_STAGES.has(stage)) return   // 热路径：直接丢弃
            if (seenReports.size > 2000) seenReports.clear()
          }
          if (reportInFlight >= REPORT_CONCURRENCY) {
            if (HOT_REPORT_STAGES.has(stage)) return   // 热路径：宁可丢也不排队
            return
          }
        }
        seenReports.add(key)
        reportSent += 1
        reportInFlight += 1
        fetch(BASE + '/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, data }),
        }).catch(() => {}).finally(() => { reportInFlight -= 1 })
      } catch { /* 报告本身绝不能影响功能 */ }
    }
    // 客户端版本戳：重启 DSH 后可以在 /state 的 clientReports 里确认加载的是哪一版
    const CLIENT_BUILD = 'client-2026-10-09-multi-provider-graph'
    reportHost('bundle-evaluated', { at: Date.now(), href: String(location?.href ?? '').slice(0, 120), build: CLIENT_BUILD, features: 'character-picker,batch-select,safe-design-save,single-caption,plugin-update,system-option-colors,readable-panel,multi-provider-channels,workflow-graph' })

    try {
      window.addEventListener('error', event => {
        reportHost('window-error', {
          message: String(event?.message ?? '').slice(0, 300),
          source: String(event?.filename ?? '').slice(0, 160),
          line: event?.lineno ?? 0,
          stack: String(event?.error?.stack ?? '').slice(0, 900),
        })
      })
      window.addEventListener('unhandledrejection', event => {
        reportHost('unhandled-rejection', { reason: String(event?.reason?.message ?? event?.reason ?? '').slice(0, 500) })
      })
    } catch { /* 老环境没有这些事件就算了 */ }
    // 当前会话 id：设置页里点「让 agent 设计角色」时要拿它去读卡片设定
    let lastSessionId = ''
    // 每条助手消息的正文（消息下方那个「生图」按钮要用它）
    const textByMessage = new Map()
    const IMAGE_TAG = /image###((?:(?!image###|###)[^\r\n])*?)(?:###|(?=\r?\n)|$)/gi

    function usablePrompt(raw) {
      const prompt = String(raw ?? '').trim()
      return /[^#]/.test(prompt) ? prompt : ''
    }

    /** 把正文切成 text / image 两种段落。
     *  ⚠ 记忆化（2026-10-07）：本函数在渲染热路径上每条消息每次渲染都会被调用，
     *  且正文可能上万字符。按 text 缓存最近一次结果（渲染是顺序的，命中率很高），
     *  避免重复做正则扫描与切片。 */
    let segmentCacheText = null
    let segmentCacheValue = null
    function splitSegments(text) {
      const source = String(text ?? '')
      if (source === segmentCacheText && segmentCacheValue) return segmentCacheValue
      const segments = []
      const regex = new RegExp(IMAGE_TAG.source, IMAGE_TAG.flags)
      let cursor = 0
      for (const match of source.matchAll(regex)) {
        const index = match.index ?? 0
        const prompt = usablePrompt(match[1])
        if (index > cursor) segments.push({ type: 'text', value: source.slice(cursor, index) })
        if (prompt) segments.push({ type: 'image', prompt })
        cursor = index + match[0].length
      }
      if (cursor < source.length) segments.push({ type: 'text', value: source.slice(cursor) })
      segmentCacheText = source
      segmentCacheValue = segments
      return segments
    }

    /** 正文指纹（和 host 侧一致），用来认领"模型主动调工具生成的那一批图"。 */
    function textHash(value) {
      let a = 2166136261
      const source = String(value ?? '')
      for (let i = 0; i < source.length; i++) a = Math.imul(a ^ source.charCodeAt(i), 16777619)
      return (a >>> 0).toString(36)
    }

    /** 内容键：同一段提示词在同一位置只画一次，翻历史、刷新页面都复用。 */
    function contentKey(messageId, turn, index, prompt) {
      const text = `${messageId ?? ''}|${turn ?? ''}|${index}|${prompt}`
      let a = 2166136261
      for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619)
      return 'k' + (a >>> 0).toString(36)
    }

    // 单次请求，不做任何兜底
    function jsonFetchOnce(url, init) {
      return fetch(url, init).then(async response => {
        let data = null
        try { data = await response.json() } catch { data = null }
        if (!response.ok || (data && data.ok === false)) {
          throw new Error((data && data.error) || `HTTP ${response.status}`)
        }
        return data
      })
    }

    /**
     * 带自愈的请求：默认带 cache:'no-store'（避免中间层缓存住状态），
     * 若在网络层直接失败（TypeError: Failed to fetch），退回不带任何 cache 选项重发一次。
     * 2026-10-07 加入：/state 正常而 /history 报 Failed to fetch，用重试兜底并上报取证。
     */
    async function jsonFetch(url, init) {
      // 仅自动重试无副作用的读取请求。POST 等写请求若服务端已执行、但响应丢失，
      // 重发可能重复扣费或重复创建任务，因此网络错误也必须交给调用者处理。
      const method = String(init?.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') return jsonFetchOnce(url, init)
      // 三次尝试：原样 → 去掉 cache 选项 → 再去掉 cache 选项（间隔退避）。
      const attempts = [{ cache: 'no-store', ...(init ?? {}) }, init ?? undefined, init ?? undefined]
      let lastError
      for (let i = 0; i < attempts.length; i += 1) {
        try {
          return await jsonFetchOnce(url, attempts[i])
        } catch (error) {
          lastError = error
          if (!(error instanceof TypeError)) throw error
          if (i === 0) reportHost('fetch-retry', { tail: String(url).slice(-40), msg: String(error.message || '') })
          if (i < attempts.length - 1) await new Promise(resolve => setTimeout(resolve, 300 * (i + 1)))
        }
      }
      throw lastError
    }

    // 正文兜底渲染：模块级常量，保证引用稳定（见 renderAssistantText 里的说明）
    const FALLBACK_RENDER_TEXT = (value, key) => h('span', { key }, String(value ?? ''))

    const wrapStyle = { margin: '14px 0', textAlign: 'center' }
    const imgStyle = { maxWidth: '100%', borderRadius: '10px', cursor: 'zoom-in', background: '#111' }
    const noteStyle = { display: 'inline-block', padding: '10px 16px', borderRadius: '10px', fontSize: '13px',
      color: '#9aa3b2', border: '1px dashed #465365', background: 'rgba(255,255,255,.02)' }
    const buttonStyle = { padding: '8px 16px', borderRadius: '9px', border: '1px solid #566275',
      background: 'rgba(255,255,255,.04)', color: '#e8ebf1', cursor: 'pointer', fontSize: '13px' }

    /** 单张图：占位 → 轮询 → <img>。 */
    function InlineImage(props) {
      const { prompt, imageKey, auto } = props
      const [state, setState] = useState(auto ? 'pending' : 'idle')
      const [error, setError] = useState('')
      const [jobId, setJobId] = useState('')
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        if (!auto && attempt === 0) { setState('idle'); return undefined }
        let cancelled = false
        let timer = null

        function poll(id) {
          jsonFetch(`${BASE}/jobs?id=${encodeURIComponent(id)}`).then(data => {
            if (cancelled) return
            const job = data?.job
            if (!job) { setState('failed'); setError('作业已丢失'); return }
            if (job.status === 'failed') { setState('failed'); setError(job.error || '画失败了'); return }
            if (job.status === 'done') { setJobId(id); setState('done'); return }
            setState(job.status === 'running' ? 'running' : 'pending')
            timer = setTimeout(() => poll(id), 1500)
          }).catch(err => {
            if (cancelled) return
            setState('failed')
            setError(err?.message ?? String(err))
          })
        }

        async function run() {
          setState('pending')
          setError('')
          try {
            const found = await jsonFetch(`${BASE}/jobs?key=${encodeURIComponent(imageKey)}`).catch(() => null)
            if (cancelled) return
            if (found?.job) {
              if (found.job.status === 'done') { setJobId(found.job.id); setState('done'); return }
              if (found.job.status === 'failed') { setState('failed'); setError(found.job.error || '画失败了'); return }
              poll(found.job.id)
              return
            }
            const created = await jsonFetch(`${BASE}/jobs`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tag: prompt, key: imageKey, origin: 'inline' }),
            })
            if (cancelled) return
            if (created?.id) poll(created.id)
            else { setState('failed'); setError(created?.error || '提交失败') }
          } catch (err) {
            if (!cancelled) { setState('failed'); setError(err?.message ?? String(err)) }
          }
        }

        void run()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [imageKey, prompt, auto, attempt])

      if (state === 'done' && jobId) {
        const src = `${BASE}/jobs?id=${encodeURIComponent(jobId)}&image=1`
        return h('div', { style: wrapStyle },
          h('img', { src, loading: 'lazy', decoding: 'async', alt: '插图', title: '点一下在 DSH 里看大图', style: { display: 'block', width: '100%', maxWidth: 'min(660px, 96%)', borderRadius: '10px', cursor: 'zoom-in', background: '#1a1d24', margin: '10px auto' }, onClick: () => viewImage(jobId, '') }))
      }
      if (state === 'failed') {
        return h('div', { style: wrapStyle },
          h('span', { style: noteStyle }, '画这张失败：' + error + ' '),
          h('button', { style: buttonStyle, onClick: () => { setError(''); setAttempt(v => v + 1) } }, '重试'))
      }
      if (state === 'idle') {
        return h('div', { style: wrapStyle },
          h('button', { style: buttonStyle, title: prompt, onClick: () => setAttempt(v => v + 1) }, '🖼 画这张图'))
      }
      return h('div', { style: wrapStyle },
        h('span', { style: noteStyle }, (state === 'running' ? '正在画…' : '排队中…') + ' ' + prompt.slice(0, 40)))
    }

    /** 计划里的一张图：jobId 由 host 建好了，这里只负责等它画完。 */
    function PlanImage(props) {
      const { plan, index } = props
      // 一律先当 pending：宿主给的 status 可能已经过时（图还没真画好），靠轮询拿真实状态
      const [state, setState] = useState('pending')
      const [error, setError] = useState('')
      // 图片自身加载失败 —— 最常见的原因是「作业已报 done，但文件还没写完」，这一小段窗口里
      // 取图会返回 404。所以这里**自动重试**，别一失败就给用户看"取不到"。
      const [imgError, setImgError] = useState('')
      const [imgNonce, setImgNonce] = useState(0)
      const [imgRetry, setImgRetry] = useState(0)

      useEffect(() => {
        if (!plan.jobId || state === 'done') return undefined
        let cancelled = false
        let timer = null
        function poll() {
          jsonFetch(BASE + '/jobs?id=' + encodeURIComponent(plan.jobId)).then(data => {
            if (cancelled) return
            const job = data?.job
            if (!job) { timer = setTimeout(poll, 2000); return }
            if (job.status === 'failed') { setState('failed'); setError(job.error || '画失败了'); return }
            if (job.status === 'done') { setState('done'); return }
            timer = setTimeout(poll, 1500)
          }).catch(err => { if (!cancelled) { setState('failed'); setError(err?.message ?? String(err)) } })
        }
        poll()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [plan.jobId])

      // 取图失败自动重试：最多 20 次 / 约 30 秒，之后才把「重试」按钮交给用户
      useEffect(() => {
        if (!imgError || imgRetry >= 20) return undefined
        const timer = setTimeout(() => { setImgError(''); setImgRetry(n => n + 1); setImgNonce(x => x + 1) }, 1500)
        return () => clearTimeout(timer)
      }, [imgError, imgRetry])

      if (state === 'done') {
        const src = BASE + '/jobs?id=' + encodeURIComponent(plan.jobId) + '&image=1'
        // 自动重试用尽后才显示"取不到"
        if (imgError && imgRetry >= 20) {
          return h('div', { style: wrapStyle },
            h('span', { style: noteStyle }, '第 ' + (index + 1) + ' 张图取不到（' + imgError + '）　'),
            h('button', {
              type: 'button',
              style: { fontSize: '12px', padding: '3px 12px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'transparent', color: '#dbe3ee', cursor: 'pointer' },
              onClick: () => { setImgError(''); setImgRetry(0); setImgNonce(x => x + 1) },
            }, '重试'),
          )
        }
        // 正在自动重试中：给个安静的状态，不要露出破图
        if (imgError) {
          return h('div', { style: wrapStyle },
            h('span', { style: noteStyle }, '🎨 第 ' + (index + 1) + ' 张正在取回…（第 ' + imgRetry + ' 次）'))
        }
        return h('div', { style: wrapStyle },
          h('img', { key: 'img-' + imgNonce, src, loading: 'lazy', decoding: 'async', alt: plan.title || '插图',
            onError: () => setImgError('加载失败'), title: '点一下在 DSH 里看大图', style: { display: 'block', width: '100%', maxWidth: 'min(660px, 96%)', borderRadius: '10px', cursor: 'zoom-in', background: '#1a1d24', margin: '10px auto' }, onClick: () => viewImage(plan.jobId, plan.title), onContextMenu: (event) => { event.preventDefault(); openEditorFor(plan.jobId, plan.title) }, onMouseDown: () => beginPress(plan.jobId, plan.title), onMouseUp: cancelPress, onMouseLeave: cancelPress, onTouchStart: () => beginPress(plan.jobId, plan.title), onTouchEnd: cancelPress, onTouchMove: cancelPress }))
      }
      if (state === 'failed') {
        return h('div', { style: wrapStyle },
          h('span', { style: noteStyle }, '第 ' + (index + 1) + ' 张画失败：' + error + ' '))
      }
      return h('div', { style: wrapStyle },
        h('span', { style: noteStyle }, '🎨 正在画第 ' + (index + 1) + ' 张…' + (plan.title ? '「' + plan.title + '」' : '')))
    }


    /** 官方接口下的插图（kind = dsh-tavern-image/image）。
     *  item.data 里带着 jobId —— 所以放大、右键看提示词、长按、重画全都照用。
     *  官方内置的 image 类型做不到这些（尺寸和交互由 Tavern 固定，插件插不进手）。 */
    function OfficialImage(props) {
      const { item } = props
      const jobId = String(item && item.data && item.data.jobId || '')
      const title = String(item && item.caption || '')
      const [imgError, setImgError] = useState('')
      const [imgNonce, setImgNonce] = useState(0)
      const [imgRetry, setImgRetry] = useState(0)

      // 取图失败自动重试：宿主报 ready 之后文件可能还在写，这段窗口会 404
      useEffect(() => {
        if (!imgError || imgRetry >= 20) return undefined
        const timer = setTimeout(() => { setImgError(''); setImgRetry(n => n + 1); setImgNonce(x => x + 1) }, 1500)
        return () => clearTimeout(timer)
      }, [imgError, imgRetry])

      if (item && item.status === 'failed') {
        return h('div', { style: wrapStyle },
          h('span', { style: noteStyle }, '配图失败：' + String(item.error || '未知原因').slice(0, 120)))
      }
      const src = String(item && item.url || '') || (jobId ? BASE + '/jobs?id=' + encodeURIComponent(jobId) + '&image=1' : '')
      if (!src || (item && item.status === 'pending')) {
        return h('div', { style: wrapStyle },
          h('span', { style: noteStyle }, '🎨 正在画…' + (title ? '「' + title + '」' : '')))
      }
      if (imgError && imgRetry >= 20) {
        return h('div', { style: wrapStyle },
          h('span', { style: noteStyle }, '图取不到（' + imgError + '）　'),
          h('button', {
            type: 'button',
            style: { fontSize: '12px', padding: '3px 12px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'transparent', color: '#dbe3ee', cursor: 'pointer' },
            onClick: () => { setImgError(''); setImgRetry(0); setImgNonce(x => x + 1) },
          }, '重试'))
      }
      if (imgError) {
        return h('div', { style: wrapStyle }, h('span', { style: noteStyle }, '🎨 正在取回…（第 ' + imgRetry + ' 次）'))
      }
      // TavernPluginMediaItem 会统一追加 figcaption；这里保留 alt 和预览标题即可。
      return h('div', { style: wrapStyle },
        h('img', {
          key: 'official-img-' + imgNonce, src, loading: 'lazy', decoding: 'async', alt: title || '插图',
          onError: () => setImgError('加载失败'),
          title: '点一下看大图 · 右键或长按改提示词 / 重画',
          // 覆盖 tavern.css 的 .dsh-tavern-illustration img 限制（320x240）：
          // 行内 style 优先级高于 CSS 类，所以这里写死 width/maxWidth/maxHeight 三件套。
          style: { display: 'block', width: 'auto', height: 'auto', maxWidth: 'min(660px, 96vw)', maxHeight: 'none', borderRadius: '10px', cursor: 'zoom-in', background: '#1a1d24', margin: '10px 0' },
          onClick: () => viewImage(jobId, title),
          onContextMenu: event => { event.preventDefault(); openEditorFor(jobId, title) },
          onMouseDown: () => beginPress(jobId, title),
          onMouseUp: cancelPress, onMouseLeave: cancelPress,
          onTouchStart: () => beginPress(jobId, title),
          onTouchEnd: cancelPress, onTouchMove: cancelPress,
        }))
    }

    /** 段落：只渲染正文，不再带「画这段」按钮（生图入口统一在消息下方）。 */
    function Segment(props) {
      try {
        return props.renderText(props.value, props.keyName || ('seg-' + props.index))
      } catch (error) {
        return h('span', null, String(props.value ?? ''))
      }
    }

    /** 切段：每个非空行当成一段。 */
    function paragraphsOf(text) {
      return String(text ?? '').split(/\n+/).filter(line => line.trim())
    }

    /** 按 agent 给的挂载句把正文切开，在每句之后插一张图；每一段都带"画这段"按钮。 */
    function splitByPlan(text, plans, renderText, info) {
      const source = String(text ?? '')
      const points = []
      for (const plan of plans) {
        const mount = String(plan.mount ?? '').trim()
        if (!mount) continue
        const at = source.indexOf(mount)
        points.push({ plan, at: at < 0 ? source.length : at + mount.length })
      }
      points.sort((a, b) => a.at - b.at)
      const nodes = []
      let cursor = 0
      points.forEach((point, i) => {
        if (point.at > cursor) {
          nodes.push(h(Segment, {
            key: 'plan-seg-' + i, value: source.slice(cursor, point.at), index: i,
            renderText, keyName: 'plan-text-' + i, ...info,
          }))
          cursor = point.at
        }
        nodes.push(h(PlanImage, { key: 'plan-img-' + i, plan: point.plan, index: i }))
      })
      if (cursor < source.length) {
        nodes.push(h(Segment, { key: 'plan-tail', value: source.slice(cursor), index: points.length, renderText, keyName: 'plan-tail', ...info }))
      }
      return nodes
    }

    /**
     * 正文渲染：默认什么都不做，只在末尾放一个「生图」按钮。
     * 点了才去规划 —— 这样不会因为你翻历史就一排后台任务堆起来。
     */
    /**
     * 整段正文 + 末尾一个「生图」按钮。正文整段交给宿主渲染一次（切段会让界面卡死）。
     */
    /**
     * 长按 / 右键图片：打开编辑器，并把这张图的提示词读出来。
     */
    function openEditorFor(jobId, title) {
      try {
        if (!jobId || typeof openPromptEditor !== 'function') return
        openPromptEditor({ open: true, jobId: String(jobId), prompt: '', negative: '', instruction: '', note: '正在读取提示词…', busy: '' })
        jsonFetch(BASE + '/job-detail?id=' + encodeURIComponent(String(jobId)), { cache: 'no-store' })
          .then(r => {
            if (!r?.ok || !r.job) { openPromptEditor({ note: '读不到提示词：' + (r?.error || '') }); return }
            // 显示"展开前"的原始提示词：能一眼看出调用了哪些角色 / 服装
            openPromptEditor({
              prompt: String(r.job.rawPrompt || r.job.tag || r.job.prompt || ''),
              negative: String(r.job.negative || ''),
              note: '',
              rawPrompt: String(r.job.rawPrompt || ''),
              finalPrompt: String(r.job.prompt || ''),
            })
          })
          .catch(error => openPromptEditor({ note: '读取失败：' + (error?.message ?? error) }))
      } catch (error) {
        reportHost('editor-open-failed', { message: String(error?.message ?? error).slice(0, 200) })
      }
    }

    /** 长按计时器（按住 0.55 秒算长按） */
    let pressTimer = null
    function beginPress(jobId, title) {
      cancelPress()
      pressTimer = setTimeout(() => { pressTimer = null; openEditorFor(jobId, title) }, 550)
    }
    function cancelPress() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
    }

    /** 显示一条浮层提示（z-index 拉满，盖在设置面板上面） */
    let showToast = null

    function Toast() {
      const [msg, setMsg] = React.useState(null)
      showToast = (text, kind) => {
        setMsg({ text: String(text ?? ''), kind: kind || 'ok', at: Date.now() })
        setTimeout(() => setMsg(cur => (cur && Date.now() - cur.at >= 3000 ? null : cur)), 3200)
      }
      if (!msg) return null
      const ok = msg.kind !== 'fail'
      return React.createElement('div', {
        style: {
          position: 'fixed', left: '50%', bottom: '64px', transform: 'translateX(-50%)',
          zIndex: 2147483004, padding: '14px 26px', borderRadius: '12px',
          background: ok ? 'linear-gradient(180deg,#2a9d63,#1f7d4c)' : 'linear-gradient(180deg,#c9484b,#a53a3d)',
          color: '#fff', fontSize: '15px', fontWeight: 600, letterSpacing: '.3px',
          boxShadow: '0 12px 40px rgba(0,0,0,.55)', border: '1px solid rgba(255,255,255,.22)',
          pointerEvents: 'none', maxWidth: '80vw', textAlign: 'center',
        },
      }, (ok ? '✅ ' : '❌ ') + msg.text)
    }

    /** 右键菜单：跟着鼠标出现的小浮层。z-index 拉满，盖在设置面板上面。 */
    let openContextMenu = null

    function ContextMenu() {
      const [menu, setMenu] = React.useState(null)
      openContextMenu = (next) => setMenu(next)
      React.useEffect(() => {
        if (!menu) return undefined
        const close = () => setMenu(null)
        const onKey = (e) => { if (e.key === 'Escape') close() }
        window.addEventListener('mousedown', close)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey) }
      }, [menu])
      if (!menu) return null
      const items = Array.isArray(menu.items) ? menu.items : []
      const w = 176
      const left = Math.min(menu.x, Math.max(8, (window.innerWidth || 1200) - w - 8))
      const top = Math.min(menu.y, Math.max(8, (window.innerHeight || 800) - items.length * 36 - 16))
      return h('div', {
        style: {
          position: 'fixed', left: left + 'px', top: top + 'px', width: w + 'px',
          zIndex: 2147483005, padding: '6px', borderRadius: '10px',
          background: '#1d222b', border: '1px solid rgba(150,170,200,.3)',
          boxShadow: '0 12px 36px rgba(0,0,0,.6)', fontSize: '13px',
        },
        onMouseDown: (e) => e.stopPropagation(),
      },
        items.map((item, i) => h('div', {
          key: i,
          onClick: () => { setMenu(null); try { item.onClick?.() } catch {} },
          style: {
            padding: '8px 10px', borderRadius: '7px', cursor: 'pointer',
            color: item.danger ? '#f2686b' : '#dbe3ee',
            display: 'flex', alignItems: 'center', gap: '8px',
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(255,255,255,.08)' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
        }, h('span', null, item.icon || ''), h('span', null, item.label || ''))),
      )
    }

    /** 打开卡片选择弹窗（人物库里的"绑定卡片"用） */
    let openCardPicker = null

    function CardPicker() {
      const [view, setView] = React.useState({ open: false, all: [], picked: [], index: -1, loading: false })
      openCardPicker = (next) => setView(cur => Object.assign({}, cur, next))
      if (!view.open) return null
      const close = () => openCardPicker({ open: false })
      const toggle = (path) => {
        const picked = view.picked.includes(path) ? view.picked.filter(x => x !== path) : view.picked.concat([path])
        openCardPicker({ picked })
      }
      const confirm = () => {
        try { if (typeof onCardPick === 'function') onCardPick(view.picked, view.index) } catch {}
        close()
      }
      return React.createElement('div', {
        style: { position: 'fixed', inset: '0', zIndex: 2147483003, background: 'rgba(0,0,0,.72)', overflowY: 'auto', padding: '52px 20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' },
        onClick: close,
      }, React.createElement('div', {
        style: { width: '520px', maxWidth: '100%', background: 'linear-gradient(180deg,#1b2029,#161a21)', border: '1px solid rgba(120,140,170,.3)', borderRadius: '16px', padding: '22px 24px', boxShadow: '0 20px 60px rgba(0,0,0,.5)' },
        onClick: (e) => e.stopPropagation(),
      },
        React.createElement('div', { style: { fontSize: '16px', fontWeight: 600, color: '#e8eef8', marginBottom: '4px' } }, '🔗 绑定卡片'),
        React.createElement('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '14px' } }, '选中的卡片才会用这个角色的设定。都不选 = 所有卡都能用。'),
        React.createElement('div', { style: { maxHeight: '46vh', overflowY: 'auto', border: '1px solid rgba(120,140,170,.2)', borderRadius: '12px', padding: '6px' } },
          view.all.length
            ? view.all.map(item => React.createElement('label', {
                key: item.path,
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderRadius: '9px', cursor: 'pointer', background: view.picked.includes(item.path) ? 'rgba(106,168,255,.14)' : 'transparent' },
              },
                React.createElement('input', { type: 'checkbox', checked: view.picked.includes(item.path), onChange: () => toggle(item.path) }),
                React.createElement('span', { style: { fontSize: '13px', color: '#dbe3ee' } }, item.name),
              ))
            : React.createElement('div', { style: { padding: '18px', fontSize: '13px', color: '#6b7480', textAlign: 'center' } }, '没读到卡片'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '18px' } },
          React.createElement('button', { type: 'button', onClick: () => openCardPicker({ picked: [] }), style: { padding: '8px 18px', fontSize: '13px', borderRadius: '9px', border: '1px solid rgba(120,140,170,.45)', background: 'transparent', color: '#9aa3b2', cursor: 'pointer' } }, '清空'),
          React.createElement('button', { type: 'button', onClick: close, style: { padding: '8px 22px', fontSize: '13px', borderRadius: '9px', border: '1px solid rgba(120,140,170,.45)', background: 'transparent', color: '#dbe3ee', cursor: 'pointer' } }, '取消'),
          React.createElement('button', { type: 'button', onClick: confirm, style: { padding: '8px 22px', fontSize: '13px', borderRadius: '9px', border: '1px solid rgba(230,160,60,.7)', background: 'linear-gradient(180deg,#f0a63c,#e0861f)', color: '#1a1206', fontWeight: 600, cursor: 'pointer' } }, '确定'),
        ),
      ))
    }

    /** 设计完成后通知设置页刷新 */
    let onCardPick = null

    /** 打开设计角色弹窗 */
    let openDesignDialog = null
    /** 设计完成后通知设置页刷新（peopleTab 挂载时设置） */
    let onDesignResult = null

    /**
     * 角色与服装设计：说需求、给一张参考图，让后台按规范设计。
     */
    function DesignDialog(props) {
      const [view, setView] = React.useState({ open: false, brief: '', photo: '', photoName: '', preview: '', busy: '', note: '' })
      openDesignDialog = (next) => setView(cur => Object.assign({}, cur, next))
      if (!view.open) return null

      const close = () => openDesignDialog({ open: false, busy: '', note: '', brief: '', photo: '', preview: '', photoName: '' })

      function pickFile(event) {
        const file = event?.target?.files && event.target.files[0]
        if (!file) return
        if (file.size > 12 * 1024 * 1024) { openDesignDialog({ note: '图片太大了（上限 12MB）' }); return }
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          const base64 = result.includes(',') ? result.split(',')[1] : result
          openDesignDialog({ photo: base64, photoName: file.name, preview: result, note: '' })
        }
        reader.onerror = () => openDesignDialog({ note: '读图失败' })
        reader.readAsDataURL(file)
      }

      async function run() {
        if (view.busy) return
        const brief = String(view.brief || '').trim()
        if (!brief) { openDesignDialog({ note: '先说说想要什么角色或服装' }); return }
        openDesignDialog({ busy: 'working', note: '设计需要十几秒，请稍等…' })
        try {
          const payload = { brief, sessionId: String(lastSessionId || '') }
          if (view.photo) { payload.data = view.photo; payload.mediaType = 'image/png'; payload.name = view.photoName || 'ref.png' }
          const r = await jsonFetch(BASE + '/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          if (!r?.ok) { openDesignDialog({ note: '设计失败：' + (r?.error || ''), busy: '' }); return }
          const people = r.people || []
          if (!people.length) { openDesignDialog({ note: '模型没产出可用的人物，换个说法再试', busy: '' }); return }
          // 宿主需要完整的 definitions（不是增量），所以先取当前的再合并
          const cur = await jsonFetch(BASE + '/state').catch(() => null)
          const defs = cur?.definitions ?? { characters: [], outfits: [] }
          const merged = Object.assign({}, defs, {
            characters: (defs.characters ?? []).concat(people),
            outfits: defs.outfits ?? [],
          })
          await jsonFetch(BASE + '/definitions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ definitions: merged }),
          })
          try { if (typeof onDesignResult === 'function') onDesignResult(people) } catch {}
          openDesignDialog({ note: '已加入 ' + people.length + ' 位角色', busy: '' })
          setTimeout(close, 1200)
        } catch (error) {
          openDesignDialog({ note: '失败：' + (error?.message ?? error), busy: '' })
        }
      }

      const label = { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' }
      const area = {
        width: '100%', minHeight: '110px', boxSizing: 'border-box', background: '#11141a',
        color: '#dbe3ee', border: '1px solid rgba(200,140,60,.55)', borderRadius: '12px',
        padding: '12px 14px', fontSize: '13px', lineHeight: '1.6', fontFamily: 'inherit', resize: 'vertical',
      }
      const btn = (text, onClick, primary, extra) => React.createElement('button', {
        type: 'button', onClick, disabled: Boolean(view.busy),
        style: Object.assign({
          padding: '9px 26px', fontSize: '14px', borderRadius: '10px', cursor: view.busy ? 'default' : 'pointer',
          border: primary ? '1px solid rgba(230,160,60,.7)' : '1px solid rgba(120,140,170,.45)',
          background: primary ? 'linear-gradient(180deg,#f0a63c,#e0861f)' : 'transparent',
          color: primary ? '#1a1206' : '#dbe3ee', fontWeight: primary ? 600 : 400,
        }, extra || {}),
      }, view.busy && primary ? '设计中…' : text)

      return React.createElement('div', {
        style: { position: 'fixed', inset: '0', zIndex: 2147483002, background: 'rgba(0,0,0,.72)', overflowY: 'auto', padding: '40px 20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' },
        onClick: close,
      }, React.createElement('div', {
        style: { width: '520px', maxWidth: '100%', background: 'linear-gradient(180deg,#1b2029,#161a21)', border: '1px solid rgba(120,140,170,.3)', borderRadius: '16px', padding: '24px 26px', boxShadow: '0 20px 60px rgba(0,0,0,.5)' },
        onClick: (event) => event.stopPropagation(),
      },
        React.createElement('div', { style: { textAlign: 'center', fontSize: '17px', fontWeight: 600, color: '#e8eef8', marginBottom: '6px' } }, '🎨 输入生成需求'),
        React.createElement('div', { style: { height: '1px', background: 'rgba(120,140,170,.2)', margin: '14px 0 18px' } }),
        React.createElement('div', { style: { textAlign: 'center', fontSize: '13px', color: '#9aa3b2', marginBottom: '12px' } }, '请描述您希望生成的角色或服装的具体需求'),
        React.createElement('textarea', {
          value: view.brief,
          placeholder: '例如：生成一个穿着古风汉服的少女角色，温柔可爱…',
          style: area,
          onChange: (e) => openDesignDialog({ brief: e.target.value }),
        }),
        React.createElement('div', { style: { marginTop: '18px', padding: '14px', borderRadius: '12px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.18)' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            React.createElement('span', { style: Object.assign({}, label, { marginBottom: 0 }) }, '📎 参考图片（可选）'),
            React.createElement('label', {
              style: { padding: '7px 16px', fontSize: '13px', borderRadius: '9px', border: '1px solid rgba(230,160,60,.6)', color: '#f0b45c', cursor: 'pointer', background: 'rgba(240,166,60,.08)' },
            },
              '＋ 添加图片',
              React.createElement('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: pickFile }),
            ),
          ),
          view.preview
            ? React.createElement('img', { src: view.preview, style: { display: 'block', maxWidth: '150px', borderRadius: '10px', margin: '12px auto 0' } })
            : React.createElement('div', { style: { textAlign: 'center', fontSize: '12px', color: '#6b7480', marginTop: '12px' } }, '点击上方按钮添加参考图片'),
        ),
        view.note ? React.createElement('div', { style: { fontSize: '12px', color: view.note.indexOf('失败') >= 0 || view.note.indexOf('太大') >= 0 ? '#f2686b' : '#9aa3b2', marginTop: '14px', textAlign: 'center' } }, view.note) : null,
        React.createElement('div', { style: { display: 'flex', gap: '14px', justifyContent: 'center', marginTop: '22px' } },
          btn('取消', close),
          btn('确定生成', run, true),
        ),
        React.createElement('div', { style: { fontSize: '11px', color: '#6b7480', marginTop: '14px', textAlign: 'center' } }, '会按「角色与服装设计规范」产出人物与服装，并自动加进人物库'),
      ))
    }

    /** 重画后：旧作业 id → 新作业 id（同一条消息里就地换图） */
    // 重画版本链：旧 jobId → 新 jobId。持久化到 localStorage，刷新后还能翻历史版本。
const REDRAW_KEY = 'dsh-tavern-image-redraw-versions'
const LEGACY_REDRAW_KEY = 'rphub-comfy-redraw-versions'
const redrawnJobs = (() => {
  const map = new Map()
  try {
    const raw = localStorage.getItem(REDRAW_KEY) || localStorage.getItem(LEGACY_REDRAW_KEY)
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) map.set(String(k), String(v))
  } catch {}
  return map
})()
function persistRedraw() {
  try {
    localStorage.setItem(REDRAW_KEY, JSON.stringify(Object.fromEntries([...redrawnJobs].slice(-200))))
  } catch {}
}
/** 给定某个 jobId，返回它所在的整条版本链（最旧 → 最新）。 */
function versionsOf(jobId) {
  const id = String(jobId)
  const ids = [id]
  const guard = new Set([id])
  let cur = id
  while (redrawnJobs.has(cur)) {
    const next = redrawnJobs.get(cur)
    if (!next || guard.has(next)) break
    guard.add(next)
    ids.push(next)
    cur = next
  }
  cur = id
  while (true) {
    let prev = null
    for (const [k, v] of redrawnJobs) { if (v === cur) { prev = k; break } }
    if (!prev || guard.has(prev)) break
    guard.add(prev)
    ids.unshift(prev)
    cur = prev
  }
  return ids
}
    /** 打开提示词编辑器（由长按触发） */
    let openPromptEditor = null

    /**
     * 长按 / 右键图片 → 打开编辑器：看提示词、改、让后台改、用新提示词重画。
     */
    function PromptEditor() {
      const [view, setView] = React.useState({ open: false, jobId: '', prompt: '', negative: '', instruction: '', note: '', busy: '', loading: false })
      openPromptEditor = (next) => setView(cur => Object.assign({}, cur, next))
      if (!view.open) return null

      const close = () => openPromptEditor({ open: false, busy: '', note: '', instruction: '' })
      const say = (text) => openPromptEditor({ note: text })

      async function improve() {
        openPromptEditor({ busy: 'improve', note: '后台正在改…' })
        try {
          const r = await jsonFetch(BASE + '/improve-prompt', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: view.jobId, prompt: view.prompt, instruction: view.instruction }),
          })
          if (!r?.ok || !r.prompt) { say('没改成：' + (r?.error || '模型没返回')); return }
          openPromptEditor({ prompt: r.prompt, note: '已按你的要求改写，可以直接重画', busy: '' })
        } catch (error) {
          say('失败：' + (error?.message ?? error))
        } finally {
          openPromptEditor({ busy: '' })
        }
      }

      async function redraw() {
        openPromptEditor({ busy: 'redraw', note: '正在重画…' })
        try {
          const r = await jsonFetch(BASE + '/redraw', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: view.jobId, prompt: view.prompt, negative: view.negative }),
          })
          if (!r?.ok || !r.jobId) { say('重画失败：' + (r?.error || '没拿到新作业')); return }
          redrawnJobs.set(view.jobId, r.jobId)
          persistRedraw()
          try { window.dispatchEvent(new CustomEvent('dsh-tavern-image:planned', { detail: { messageId: String(lastSessionId || '') } })) } catch {}
          close()
          if (typeof openImageOverlay === 'function') (() => {
                  const chain = versionsOf(r.jobId)
                  openImageOverlay({ open: true, jobIds: chain, versions: chain, versionAt: chain.length - 1, note: '重画完成（下方可对比历史版本）', working: false, index: chain.length - 1 })
                })()
        } catch (error) {
          say('失败：' + (error?.message ?? error))
        } finally {
          openPromptEditor({ busy: '' })
        }
      }

      const area = {
        width: '100%', minHeight: '110px', boxSizing: 'border-box',
        background: '#12151b', color: '#dbe3ee', border: '1px solid rgba(120,140,170,.4)',
        borderRadius: '10px', padding: '10px 12px', fontSize: '13px', lineHeight: '1.5',
        fontFamily: 'inherit', resize: 'vertical',
      }
      const btn = (label, onClick, primary) => React.createElement('button', {
        type: 'button', onClick, disabled: Boolean(view.busy),
        style: {
          padding: '6px 16px', fontSize: '13px', borderRadius: '9px', cursor: view.busy ? 'default' : 'pointer',
          border: '1px solid ' + (primary ? 'rgba(106,168,255,.6)' : 'rgba(120,140,170,.45)'),
          background: primary ? 'rgba(106,168,255,.18)' : 'transparent',
          color: '#dbe3ee',
        },
      }, label)

      return React.createElement('div', {
        style: { position: 'fixed', inset: '0', zIndex: 2147483001, background: 'rgba(0,0,0,.78)', overflowY: 'auto', padding: '48px 24px', backdropFilter: 'blur(3px)' },
        onClick: close,
      }, React.createElement('div', {
        style: { maxWidth: '760px', margin: '0 auto', background: '#171a21', border: '1px solid rgba(120,140,170,.25)', borderRadius: '14px', padding: '20px 22px' },
        onClick: (event) => event.stopPropagation(),
      },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' } },
          React.createElement('div', { style: { color: '#e6ecf5', fontSize: '15px' } }, '🖼 这张图的提示词'),
          React.createElement('button', { type: 'button', onClick: close, style: { padding: '5px 14px', fontSize: '13px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'transparent', color: '#dbe3ee', cursor: 'pointer' } }, '关闭'),
        ),
        React.createElement('img', { src: BASE + '/jobs?id=' + encodeURIComponent(view.jobId) + '&image=1', style: { display: 'block', maxWidth: '260px', borderRadius: '10px', margin: '0 auto 16px', background: '#1a1d24' } }),
        React.createElement('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '6px' } }, '正向提示词（可直接改，然后重画）'),
        React.createElement('textarea', {
          value: view.prompt,
          style: area,
          onChange: (e) => openPromptEditor({ prompt: e.target.value }),
        }),
        React.createElement('div', { style: { fontSize: '12px', color: '#9aa3b2', margin: '12px 0 6px' } }, '反向提示词'),
        React.createElement('textarea', {
          value: view.negative,
          style: Object.assign({}, area, { minHeight: '54px' }),
          onChange: (e) => openPromptEditor({ negative: e.target.value }),
        }),
        React.createElement('div', { style: { fontSize: '12px', color: '#9aa3b2', margin: '12px 0 6px' } }, '让后台帮你改（说要求，例如「她自己头发」/「改成白天」/「多加细节」）'),
        React.createElement('input', {
          value: view.instruction,
          placeholder: '想怎么改？',
          style: Object.assign({}, area, { minHeight: '0', height: '36px' }),
          onChange: (e) => openPromptEditor({ instruction: e.target.value }),
        }),
        React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '16px', flexWrap: 'wrap' } },
          btn('🤖 让后台改', improve),
          btn('👁 看展开结果', () => {
            if (!view.finalPrompt) { say('这张图没有记录展开结果'); return }
            openPromptEditor({ prompt: view.finalPrompt, rawPrompt: view.prompt, note: '这是展开后的最终提示词（点关闭后回到原始）' })
          }),
          btn(view.busy === 'redraw' ? '🎨 重画中…' : '🎨 用这段重画', redraw, true),
          view.note ? React.createElement('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, view.note) : null,
        ),
        React.createElement('div', { style: { fontSize: '11px', color: '#6b7480', marginTop: '14px' } }, '提示：改完提示词点「用这段重画」，会在同一条消息里换成新图。'),
      ))
    }

    /**
     * 在 DSH 内部的全屏浮层里看某张图（不开浏览器标签）。
     */
    async function viewImage(jobId, title) {
      try {
        if (!jobId) return
        if (typeof openImageOverlay !== 'function') return
        const id = String(jobId)
        const label = String(title || '插图')
        // 这张图自己的重画版本链（独立于整场翻页）
        const chain = versionsOf(id)

        // 主翻页列表：整场对话里出过图的作业（旧 → 新）。拿不到就退回版本链。
        let list = []
        try {
          const r = await jsonFetch(BASE + '/history')
          const history = (r && Array.isArray(r.jobs)) ? r.jobs : []
          list = history
            .filter(job => job && job.id && (job.hasImage || job.byteLength))
            .map(job => String(job.id))
            .reverse()
        } catch { /* 拿不到历史就退回版本链 */ }
        if (!list.includes(id)) list = chain

        const at = Math.max(0, list.indexOf(id))
        const versionAt = Math.max(0, chain.indexOf(id))
        openImageOverlay({
          open: true,
          jobIds: list,
          index: at,
          versions: chain,
          versionAt: versionAt,
          working: false,
          note: label
            + (list.length > 1 ? '　第 ' + (at + 1) + ' / ' + list.length + ' 张' : '')
            + (chain.length > 1 ? '　（这张有 ' + chain.length + ' 个重画版本）' : ''),
        })
      } catch { /* 看图失败不影响正文 */ }
    }

    function PlannedBody(props) {
      const { text, messageId, turn, sessionId, renderText } = props
      const [plans, setPlans] = React.useState(null)
      const [jobIds, setJobIds] = React.useState([])
      const [state, setState] = React.useState('idle')
      const [note, setNote] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const [progress, setProgress] = React.useState(0)

      React.useEffect(() => {
        // 恢复已有计划：切换页面 / 重新渲染 / 滚动回来时，宿主里可能早就存过这条的计划了。
        // 之前只在"收到事件"时才查，所以一离开页面图就没了。
        if (messageId) {
          jsonFetch(BASE + '/plans?messageId=' + encodeURIComponent(String(messageId)))
            .then(found => {
              const list = found?.plans ?? []
              if (!list.length) return
              reportHost('inline-restored', { messageId: String(messageId).slice(0, 14), plans: list.length })
              setPlans(list)
              setJobIds(list.map(p => p.jobId).filter(Boolean))
              setState('done')
            })
            .catch(() => {})
        }

        const handler = (event) => {
          const target = event && event.detail ? String(event.detail.messageId ?? '') : ''
          reportHost('inline-event', { target, mine: String(messageId ?? ''), match: target === String(messageId ?? '') })
          // 只有被点的那一条才处理（广播会给所有消息，这里必须筛掉）
          if (!messageId || !target || target !== String(messageId)) return
          jsonFetch(BASE + '/plans?messageId=' + encodeURIComponent(String(messageId)))
            .then(found => {
              const list = found?.plans ?? []
              reportHost('inline-fetched', { messageId: String(messageId ?? ''), got: list.length, mounts: list.map(p => String(p.mount ?? '').slice(0, 20)) })
              if (list.length) { setPlans(list); setJobIds(list.map(p => p.jobId).filter(Boolean)); setState('done') }
            })
            .catch(() => {})
        }
        window.addEventListener('dsh-tavern-image:planned', handler)
        return () => window.removeEventListener('dsh-tavern-image:planned', handler)
      }, [messageId])

      // 只有出过图才轮询进度，平时一声不响
      React.useEffect(() => {
        if (!jobIds.length) return
        let alive = true
        const timer = setInterval(async () => {
          if (!alive) return
          let done = 0
          for (const id of jobIds) {
            const r = await jsonFetch(BASE + '/jobs?id=' + encodeURIComponent(id)).catch(() => null)
            if (r?.job?.status === 'done') done += 1
          }
          if (!alive) return
          setProgress(done)
          if (done >= jobIds.length) clearInterval(timer)
        }, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [jobIds])

      async function generate() {
        if (state === 'working') return
        setState('working')
        setNote('')
        setJobIds([])
        try {
          const r = await jsonFetch(BASE + '/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId, turn, text, sessionId, manual: true }),
          })
          const list = r.plans ?? []
          if (!list.length) { setState('failed'); setNote(r.error || '没有产出画面'); return }
          setState('done')
          setPlans(list)
          setJobIds(list.map(item => item.jobId).filter(Boolean))
        } catch (error) {
          setState('failed')
          setNote(error && error.message ? error.message : String(error))
        }
      }

      // 已经有图：按 host 给的「挂载句」把图插进正文对应位置
      if (plans && plans.length) {
        reportHost('inline-splitting', { messageId: String(messageId ?? ''), plans: plans.length, textLen: String(text ?? '').length })
        return h(React.Fragment, null,
          splitByPlan(text, plans, renderText, { messageId, turn, sessionId }),
        )
      }

      // 没有计划：先看正文里有没有模型自己写的 image###Tag### 标记（自动生图开的那个通道）。
      // 有就按标记切段、就地出图 —— 只按标记切（通常 4 段以内），不是按行切，不会把 markdown 渲染几十次。
      // 宿主按 key 去重，同一条消息的同一个位置永远只画一次，翻历史、刷新页面都复用同一张。
      const segments = splitSegments(text)
      let markerCount = 0
      for (const segment of segments) if (segment.type === 'image') markerCount += 1
      if (markerCount) {
        const owner = String(messageId ?? 'x')
        reportHost('inline-markers', { messageId: owner.slice(0, 14), markers: markerCount, textLen: String(text ?? '').length })
        return h(React.Fragment, null, segments.map((segment, index) => (
          segment.type === 'image'
            ? h(InlineImage, {
              key: 'marker-img-' + index,
              prompt: segment.prompt,
              imageKey: contentKey(messageId, turn, index, segment.prompt),
              auto: true,
            })
            : h(Segment, {
              key: 'marker-text-' + index,
              value: segment.value,
              index,
              renderText,
              keyName: 'marker-text-' + owner + '-' + index,
              messageId, turn, sessionId,
            })
        )))
      }

      // 没有计划、也没有待显示的图：正文照常渲染出来，不要返回 null。
      // ⚠️ 宿主（message-frame.js 的 renderTavernProjection）只检查渲染器**函数**的返回值：
      //    不是 null/undefined 就直接采用，不会再回落原生渲染。所以"返回 null 交回宿主"
      //    只在 renderAssistantText 那一层成立，在 PlannedBody 这一层不成立 —— 在这里
      //    返回 null 会让整段正文空白（2026-10-07 踩过）。
      if (!jobIds.length) {
        return h(Segment, {
          key: 'rphub-plain',
          value: text,
          index: 0,
          renderText,
          keyName: 'rphub-plain-' + String(messageId ?? 'x'),
          messageId, turn, sessionId,
        })
      }
      const body = renderText(text, 'rphub-body-' + String(messageId ?? 'x'))
      return h(React.Fragment, null,
        body,
        h('div', { style: { margin: '6px 0 12px' } },
          jobIds.map(id => h('img', {
            key: id,
            src: BASE + '/jobs?id=' + encodeURIComponent(id) + '&image=1',
            style: { display: 'block', width: '100%', maxWidth: '520px', borderRadius: '10px', margin: '8px 0' },
            onClick: () => viewImage(id, ''),
          })),
          progress < jobIds.length ? h('div', { style: { fontSize: '11px', color: '#9aa3b2' } }, '画好了 ' + progress + ' / ' + jobIds.length) : null,
        ),
      )
    }

    /** 渲染器：有 image### 标记就走标记；没有就用 agent 规划。都没命中就返回 null。 */
    /** 已经主动规划过的消息，避免重复调模型 */
    const planEnsured = new Set()
    /**
     * 「自动生图」只认最新一轮，而且**要等渲染稳定下来**再动手。
     *
     * 为什么必须防抖：打开一个长会话时，历史消息是逐条渲染的，每一步的 turn 都比上一步大。
     * 如果"见到更大的 turn 就规划"，一屏历史能一口气排出一串后台任务 —— 这个坑第一次上线就踩了
     * （重启后冒出几十张图）。所以这里只记下见过的最大轮次，等 1.2 秒不再有更新的轮次出现，
     * 它才真的是"最新一轮"，那时才去规划。
     * turn 拿不到就什么都不做：宁可不自动，也不要乱触发。
     */
    let autoPlanSession = ''
    let autoPlanTurn = -1
    let autoPlanTimer = null
    let autoPlanPending = null
    function scheduleAutoPlan(sessionId, turn, messageId, text) {
      const sid = String(sessionId ?? '')
      if (sid !== autoPlanSession) { autoPlanSession = sid; autoPlanTurn = -1 }
      const t = Number(turn)
      if (!Number.isFinite(t) || t <= 0) return
      if (t <= autoPlanTurn) return        // 比已见过的更旧：一定是历史消息，不规划
      autoPlanTurn = t
      autoPlanPending = { messageId, text, sessionId: sid, turn: t }
      if (autoPlanTimer) clearTimeout(autoPlanTimer)
      autoPlanTimer = setTimeout(() => {
        autoPlanTimer = null
        const job = autoPlanPending
        autoPlanPending = null
        // 期间又出现了更新的轮次 → 那一次会重新排，这次作废
        if (!job || job.turn !== autoPlanTurn) return
        ensurePlanFor(job.messageId, job.text, job.sessionId, job.turn)
      }, 1200)
    }
    /**
     * 渲染器一被调用就主动去要计划 —— 不等 React 组件挂载。
     * （React 那边会不会挂载取决于宿主，不能把规划押在它身上。）
     */
    function ensurePlanFor(messageId, text, sessionId, turn) {
      try {
        if (!messageId) return
        if (planEnsured.has(messageId)) return
        planEnsured.add(messageId)
        jsonFetch(BASE + '/plans?messageId=' + encodeURIComponent(messageId)).then(found => {
          if (found?.plans?.length) return null
          reportHost('plan-request', { messageId, textLen: String(text ?? '').length, source: 'renderer' })
          return jsonFetch(BASE + '/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId, turn, text, sessionId }),
          }).then(response => {
            const got = (response?.plans ?? []).length
            reportHost('plan-response', { ok: response?.ok, plans: got, error: response?.error ?? '' })
            if (got) {
              try { window.dispatchEvent(new CustomEvent('dsh-tavern-image:planned', { detail: { messageId } })) } catch {}
            }
            return null
          })
        }).catch(error => {
          reportHost('plan-threw', { messageId, message: String(error?.message ?? error).slice(0, 400) })
        })
      } catch (error) {
        reportHost('plan-ensure-failed', { message: String(error?.message ?? error).slice(0, 300) })
      }
    }

    /**
     * 正文渲染：整段交给宿主的渲染器（**不切段** —— 切段会让 markdown 渲染几十次、界面卡死），
     * 末尾跟一个「生图」按钮。只在游玩时的回复里出现（那种消息带着 turn）。
     */
    function renderAssistantText(text, context, options) {
      try {
        if (context?.sessionId) lastSessionId = String(context.sessionId)
        // ⚠️ 这是 v1.0「打补丁时代」的遗留函数，**当前没有任何地方注册它**，留着只为备查。
        //    正文渲染已经交回 Tavern 原生：图由宿主侧 tavern.attach 按 anchor 挂上，
        //    Tavern 自己渲染、自己跟 textVersion 绑定。
        //    不要再注册它 —— 一旦注册，会和 attach 挂的图重复渲染。
        if (context?.streaming) return null
        const renderText = typeof context?.renderText === 'function' ? context.renderText : null
        if (!renderText) return null
        // 卡片工作台（Tavern 的 mode === "card"）不生成插图、也不接管正文：
        // 这里是"改卡"的地方，正文里出现的 image### 标记不该在这里被画成图。
        // 判定来自 Tavern 侧渲染补丁给出的 cardBench 字段（见 message-frame.js）。
        // 注意：Tavern 宿主已经对"消息级动作"做了 isPlayMode 判定，所以「🎨 生图」按钮
        // 本来就不在工作台出现，这里补的是正文渲染这一条路径。
        if (context?.cardBench) {
          // 卡片工作台：绝不出图。
          // 正常情况这里没有任何标记，直接返回 null 让 Tavern 原生渲染，零影响；
          // 万一模型还是写了 image### 标记（自动生图规则会跟到所有请求），就把它清掉再渲染，
          // 免得工作台的正文里露出一串标记。
          const original = String(text ?? '')
          const cleaned = original.replace(new RegExp(IMAGE_TAG.source, 'gi'), '').replace(/\n{3,}/g, '\n\n').trim()
          if (cleaned === original.trim()) return null
          reportHost('cardbench-stripped', { messageId: String(context?.messageId ?? '').slice(0, 14), removed: original.length - cleaned.length })
          return h(React.Fragment, null, renderText(cleaned, 'card-bench-' + String(context?.messageId ?? 'x')))
        }
        // 不再依赖 turn：Tavern 的渲染链路只服务游玩对话，工作台/设置页不走这里，
        // 所以"只在游玩时出现"是天然成立的（之前按 turn 判定导致按钮永不出现）。
        reportHost('renderer-takeover', { messageId: String(context?.messageId ?? ''), turn: context?.turn, cardBench: Boolean(context?.cardBench), textLen: String(text ?? '').length })
        // 「自动生图」：生图规划开着时，正文渲染稳定后替**最新一轮**要一次计划，不用点按钮。
        //   短消息（工具回执、寒暄）不配图；历史消息不规划；连续渲染时只认最后停下来的那一轮。
        // 「🎨 生图」按钮完全不受影响 —— 点它依然是对那一条消息单独生图、重新生图。
        // 自动配图已由**宿主侧**的 Tavern 官方接口桥接管（tavern.onTurnSettled → 规划 → attach），
        // 图由 Tavern 自己按 anchor 渲染并与正文版本绑定。前端不再在渲染时发起规划 ——
        // 否则同一条正文会被规划两次、出两批图。手动按钮不受影响，仍然可用。
        return h(PlannedBody, {
          text: String(text ?? ''),
          messageId: context?.messageId,
          turn: context?.turn,
          sessionId: context?.sessionId,
          renderText,
        })
      } catch (error) {
        reportHost('render-error', { message: String(error?.message ?? error).slice(0, 300) })
        return null
      }
    }

    /**
     * 消息级生图：挂在整条消息容器里（Tavern 的 extensionActions 通道），
     * 不管这条消息是纯文本还是 HTML 面板卡，都能看到。图直接显示在消息下方。
     */
    function MessageImageButton(props) {
      const { text, messageId, turn, sessionId } = props
      const [plans, setPlans] = React.useState(null)
      const [state, setState] = React.useState('idle')
      const [note, setNote] = React.useState('')
      const [hover, setHover] = React.useState(false)
      const [progress, setProgress] = React.useState(0)

      React.useEffect(() => {
        if (!plans || !plans.length) return
        let alive = true
        const timer = setInterval(async () => {
          if (!alive) return
          let done = 0
          for (const p of plans) {
            const r = await jsonFetch(BASE + '/jobs?id=' + encodeURIComponent(p.jobId)).catch(() => null)
            if (r?.job?.status === 'done') done += 1
          }
          if (!alive) return
          setProgress(done)
          if (done >= plans.length) clearInterval(timer)
        }, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [plans])

      async function generate() {
        if (state === 'working') return
        setState('working')
        setNote('')
        setPlans(null)
        reportHost('plan-request', { messageId: String(messageId ?? ''), textLen: String(text ?? '').length, source: 'message-action' })
        try {
          const r = await jsonFetch(BASE + '/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId, turn, text, sessionId, manual: true }),
          })
          const list = r.plans ?? []
          reportHost('plan-response', { ok: r?.ok, plans: list.length, error: r?.error ?? '' })
          if (!list.length) { setState('failed'); setNote(r.error || '没有产出画面'); return }
          setState('done')
          setPlans(list)
          try {
            reportHost('inline-dispatch', { messageId: String(messageId ?? ''), textLen: String(text ?? '').length, plans: list.length })
            window.dispatchEvent(new CustomEvent('dsh-tavern-image:planned', { detail: { messageId: String(messageId ?? '') } }))
          } catch (error) { reportHost('inline-dispatch-failed', { message: String(error?.message ?? error) }) }
        } catch (error) {
          reportHost('plan-threw', { message: String(error?.message ?? error).slice(0, 300) })
          setState('failed')
          setNote(error && error.message ? error.message : String(error))
        }
      }

      const busy = state === 'working'
      return React.createElement('div', { style: { margin: '6px 0 10px' } },
        React.createElement('div', { style: { textAlign: 'right' } },
          React.createElement('button', {
            type: 'button',
            disabled: busy,
            onClick: generate,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            title: '按这一整段回复生成插图',
            style: {
              padding: '3px 12px', fontSize: '12px', borderRadius: '8px',
              border: '1px solid rgba(120,140,170,.5)',
              background: hover ? 'rgba(106,168,255,.16)' : 'rgba(106,168,255,.06)',
              color: state === 'failed' ? '#f2686b' : '#b9c3d1',
              cursor: busy ? 'default' : 'pointer',
            },
          }, busy ? '🎨 生成中…' : state === 'failed' ? '🎨 重试' : state === 'done' ? '🎨 重新生图' : '🎨 生图'),
          note ? React.createElement('span', { style: { fontSize: '11px', color: '#f2686b', marginLeft: '8px' } }, note) : null,
        ),
        // 图只显示在正文里（这里不再重复显示），按钮留着触发
      )
    }

    function ImageOverlay() {
      const [view, setView] = React.useState({ open: false, jobIds: [], note: '', working: false, index: 0 })
      // 缩放与平移：滚轮缩放、按住拖动（触摸同样支持）
      const [zoom, setZoom] = React.useState(1)
      const [pos, setPos] = React.useState({ x: 0, y: 0 })
      const [dragging, setDragging] = React.useState(false)
      const [imageWarning, setImageWarning] = React.useState('')
      const dragRef = React.useRef(null)
      const onWheel = React.useCallback(event => {
        event.preventDefault()
        setZoom(z => Math.max(0.2, Math.min(8, z * (event.deltaY > 0 ? 0.9 : 1.1))))
      }, [])
      const onDragStart = React.useCallback(event => {
        event.preventDefault()
        dragRef.current = { x: event.clientX - pos.x, y: event.clientY - pos.y }
        setDragging(true)
      }, [pos.x, pos.y])
      const onDragMove = React.useCallback(event => {
        if (!dragRef.current) return
        setPos({ x: event.clientX - dragRef.current.x, y: event.clientY - dragRef.current.y })
      }, [])
      const onDragEnd = React.useCallback(() => { dragRef.current = null; setDragging(false) }, [])
      const onTouchStart = React.useCallback(event => {
        const touch = event.touches && event.touches[0]
        if (!touch) return
        dragRef.current = { x: touch.clientX - pos.x, y: touch.clientY - pos.y }
        setDragging(true)
      }, [pos.x, pos.y])
      const onTouchMove = React.useCallback(event => {
        const touch = event.touches && event.touches[0]
        if (!dragRef.current || !touch) return
        event.preventDefault()
        setPos({ x: touch.clientX - dragRef.current.x, y: touch.clientY - dragRef.current.y })
      }, [])
      openImageOverlay = (next) => setView(current => Object.assign({}, current, next && next.open ? Object.assign({ index: 0, versionAt: 0 }, next) : next))
      const close = () => openImageOverlay({ open: false, jobIds: [], versions: [], versionAt: 0, note: '', working: false, index: 0 })
      const total = view.jobIds.length
      const at = total ? Math.max(0, Math.min(total - 1, Number(view.index) || 0)) : 0
      // 当前这张图自己的重画版本链（与整场翻页互不影响）
      const versions = Array.isArray(view.versions) ? view.versions : []
      const vTotal = versions.length
      const vAt = vTotal ? Math.max(0, Math.min(vTotal - 1, Number(view.versionAt) || 0)) : 0
      // 真正显示的那张：有版本链就用版本链的当前版，否则用主列表的当前张
      const shownId = vTotal ? versions[vAt] : view.jobIds[at]
      React.useEffect(() => {
        let alive = true
        setImageWarning('')
        if (view.open && shownId) jsonFetch(BASE + '/jobs?id=' + encodeURIComponent(shownId)).then(result => {
          if (alive) setImageWarning(String(result?.job?.imageOutputWarning || ''))
        }).catch(() => {})
        return () => { alive = false }
      }, [view.open, shownId])
      const go = (delta) => {
        if (total < 2) return
        // 翻整场的时候把版本链清掉，免得两张图的版本串在一起
        openImageOverlay({ index: (at + delta + total) % total, versions: [], versionAt: 0 })
      }
      const goVersion = (delta) => {
        if (vTotal < 2) return
        openImageOverlay({ versionAt: (vAt + delta + vTotal) % vTotal })
      }
      React.useEffect(() => {
        if (!view.open || total < 2) return undefined
        const onKey = (event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1) }
          else if (event.key === 'ArrowRight') { event.preventDefault(); go(1) }
          else if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [view.open, at, total])
      // 切图或重新打开时复位缩放与位移
      React.useEffect(() => { setZoom(1); setPos({ x: 0, y: 0 }); dragRef.current = null }, [view.open, at])
      if (!view.open) return null
      const goPrev = () => go(-1)
      const goNext = () => go(1)
      return React.createElement('div', {
        style: {
          position: 'fixed', inset: '0', zIndex: 2147483000, background: 'rgba(0,0,0,.82)',
          overflowY: 'auto', padding: '16px 20px 40px', boxSizing: 'border-box', backdropFilter: 'blur(3px)',
        },
        onClick: close,
      }, React.createElement('div', {
        style: { maxWidth: '1240px', margin: '0 auto' },
        onClick: event => event.stopPropagation(),
      },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '12px' } },
          React.createElement('div', { style: { color: '#e6ecf5', fontSize: '15px', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            view.working ? '正在生成…' : (view.note || '插图')),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 } },
            total > 1 ? React.createElement('button', {
              type: 'button', onClick: goPrev, title: '上一张（←）',
              style: { padding: '5px 14px', fontSize: '14px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'rgba(255,255,255,.06)', color: '#dbe3ee', cursor: 'pointer' },
            }, '◀') : null,
            total > 1 ? React.createElement('span', { style: { fontSize: '12px', color: '#9aa3b2', minWidth: '44px', textAlign: 'center' } }, (at + 1) + ' / ' + total) : null,
            total > 1 ? React.createElement('button', {
              type: 'button', onClick: goNext, title: '下一张（→）',
              style: { padding: '5px 14px', fontSize: '14px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'rgba(255,255,255,.06)', color: '#dbe3ee', cursor: 'pointer' },
            }, '▶') : null,
            React.createElement('button', {
              type: 'button', onClick: close,
              style: { padding: '5px 16px', fontSize: '13px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'transparent', color: '#dbe3ee', cursor: 'pointer' },
            }, '关闭'),
          ),
        ),
        view.working ? React.createElement('div', { style: { color: '#9aa3b2', fontSize: '14px', padding: '30px 0', textAlign: 'center' } }, '规划中，通常十几秒…') : null,
        imageWarning ? React.createElement('div', { role: 'status', style: { color: '#e2b93b', fontSize: '12px', textAlign: 'center', padding: '8px 10px', marginBottom: '8px', background: 'rgba(226,185,59,.1)', borderRadius: '8px' } }, imageWarning) : null,
        React.createElement('div', {
          style: view.jobIds.length > 1
            ? { display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', alignItems: 'flex-start' }
            : { display: 'flex', justifyContent: 'center' },
        },
          // 左右两侧的大按钮（图很大时也好点）
          total > 1 ? React.createElement('button', {
            type: 'button', onClick: (e) => { e.stopPropagation(); goPrev() }, title: '上一张（←）',
            style: {
              position: 'fixed', left: '18px', top: '50%', transform: 'translateY(-50%)',
              zIndex: 2147483006, width: '64px', height: '120px', borderRadius: '14px',
              border: '1px solid rgba(255,255,255,.22)', background: 'rgba(20,24,30,.72)',
              color: '#e9eef6', fontSize: '34px', lineHeight: 1, cursor: 'pointer',
              backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
          }, '‹') : null,
          total > 1 ? React.createElement('button', {
            type: 'button', onClick: (e) => { e.stopPropagation(); goNext() }, title: '下一张（→）',
            style: {
              position: 'fixed', right: '18px', top: '50%', transform: 'translateY(-50%)',
              zIndex: 2147483006, width: '64px', height: '120px', borderRadius: '14px',
              border: '1px solid rgba(255,255,255,.22)', background: 'rgba(20,24,30,.72)',
              color: '#e9eef6', fontSize: '34px', lineHeight: 1, cursor: 'pointer',
              backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
          }, '›') : null,
          // 一次只显示当前这张，左右按钮切换
          // 一次只显示当前这张；可拖动平移、滚轮缩放
          // 只显示当前这一张（shownId：有重画版本就用版本里的当前版）
          [shownId].filter(Boolean).map(id => React.createElement('img', {
            key: id,
            src: BASE + '/jobs?id=' + encodeURIComponent(id) + '&image=1',
            alt: view.note || '插图',
            draggable: false,
            onWheel: onWheel, onMouseDown: onDragStart, onMouseMove: onDragMove, onMouseUp: onDragEnd,
            onMouseLeave: onDragEnd, onTouchStart: onTouchStart, onTouchMove: onTouchMove, onTouchEnd: onDragEnd,
            style: {
              display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 200px)', width: 'auto', height: 'auto',
              objectFit: 'contain', borderRadius: '12px', background: '#1a1d24',
              cursor: zoom > 1 ? 'grab' : 'default', userSelect: 'none', touchAction: 'none',
              transform: 'translate(' + pos.x + 'px,' + pos.y + 'px) scale(' + zoom + ')',
              transition: dragging ? 'none' : 'transform .12s',
            },
          })),
          // 这张图自己的重画版本（跟上面"整场翻页"是两回事），只有多于 1 版才显示
          vTotal > 1 ? React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginTop: '12px', position: 'relative', zIndex: 2147483006 },
            onClick: event => event.stopPropagation(),
          },
            React.createElement('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '重画版本'),
            React.createElement('button', {
              type: 'button', onClick: () => goVersion(-1), title: '上一个版本',
              style: { padding: '3px 12px', fontSize: '13px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'rgba(255,255,255,.06)', color: '#dbe3ee', cursor: 'pointer' },
            }, '◀'),
            React.createElement('span', { style: { fontSize: '12px', color: '#c8d2e0', minWidth: '40px', textAlign: 'center' } }, (vAt + 1) + ' / ' + vTotal),
            React.createElement('button', {
              type: 'button', onClick: () => goVersion(1), title: '下一个版本',
              style: { padding: '3px 12px', fontSize: '13px', borderRadius: '8px', border: '1px solid rgba(160,180,210,.5)', background: 'rgba(255,255,255,.06)', color: '#dbe3ee', cursor: 'pointer' },
            }, '▶'),
          ) : null,
        ),
        view.jobIds.length ? React.createElement('div', { style: { color: '#8b95a5', fontSize: '12px', textAlign: 'center', paddingBottom: '20px' } }, '点空白处关闭' + (total > 1 ? '　也可以点两侧的 ‹ › 或按 ← → 切换' : '')) : null,
      ))
    }

    function DockImageButton(props) {
      const [working, setWorking] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      async function run() {
        if (working) return
        setWorking(true)
        try {
          if (openImageOverlay) openImageOverlay({ open: true, jobIds: [], note: '', working: true })
          const r = await jsonFetch(BASE + '/plan', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: String(props?.sessionId ?? lastSessionId ?? ''), turn: 0, manual: true }),
          })
          const ids = (r.plans || []).map(p => p.jobId).filter(Boolean)
          if (openImageOverlay) openImageOverlay({ open: true, jobIds: ids, note: ids.length ? ('本轮 ' + ids.length + ' 张') : (r.error || '没产出画面'), working: false })
        } catch (error) {
          if (openImageOverlay) openImageOverlay({ open: true, jobIds: [], note: '生成失败：' + (error && error.message ? error.message : error), working: false })
        } finally {
          setWorking(false)
        }
      }
      return React.createElement('button', {
        type: 'button',
        title: '按最新一段正文生成插图',
        disabled: working,
        onClick: run,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          padding: '4px 12px', fontSize: '13px', borderRadius: '8px',
          border: '1px solid rgba(120,140,170,.55)',
          background: hover ? 'rgba(106,168,255,.16)' : 'rgba(106,168,255,.07)',
          color: '#dbe3ee', cursor: working ? 'default' : 'pointer', whiteSpace: 'nowrap',
        },
      }, working ? '🎨 生成中…' : '🎨 生图')
    }

    // ================= 助手消息下方的「生图」按钮（保留，万一以后能用） =================
    /** 点了之后就地规划这一条消息的正文，并通知正文里的图重新取一次计划。 */
    function ImageActionButton(props) {
      const messageId = String(props?.messageId ?? '')
      const sessionId = String(props?.sessionId ?? '')
      const [state, setState] = React.useState('idle')
      const [note, setNote] = React.useState('')
      // 正文由宿主自己从会话里读（不依赖前端的渲染钩子）；这里只在已知太短时藏掉按钮
      const cached = textByMessage.get(messageId)
      const usable = cached === undefined ? true : cached.trim().length >= 12
      const [jobIds, setJobIds] = React.useState([])

      async function generate() {
        if (state === 'working' || !usable) return
        setState('working')
        setNote('')
        try {
          const r = await jsonFetch(BASE + '/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId, turn: props?.turn, sessionId, manual: true }),
          })
          const list = r.plans || []
          if (!list.length) {
            setState('failed')
            setNote(r.error || '规划没产出画面')
            return
          }
          setState('done')
          setNote('已生成 ' + list.length + ' 张')
          setJobIds(list.map(item => item.jobId).filter(Boolean))
          // 正文里那套渲染是另一个组件，靠这个事件让它去取新计划并插图
          try { window.dispatchEvent(new CustomEvent('dsh-tavern-image:planned', { detail: { messageId } })) } catch {}
        } catch (error) {
          setState('failed')
          setNote(error && error.message ? error.message : String(error))
        }
      }

      if (!usable) return null
      const label = state === 'working' ? '🎨 生成中…' : state === 'done' ? '🎨 重新生图' : state === 'failed' ? '🎨 重试生图' : '🎨 生图'
      const images = state === 'done' && jobIds.length
        ? React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px', width: '100%' } },
          jobIds.map(id => React.createElement('img', {
            key: id,
            src: BASE + '/jobs?id=' + encodeURIComponent(id) + '&image=1',
            title: '点开看大图',
            style: { width: '150px', borderRadius: '10px', cursor: 'pointer', display: 'block' },
            onClick: () => viewImage(id, ''),
          })))
        : null
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button',
          title: '按这条正文生成插图（插在正文对应句子后面）',
          disabled: state === 'working',
          onClick: generate,
          style: {
            padding: '4px 14px', fontSize: '13px', borderRadius: '8px',
            border: '1px solid rgba(120,140,170,.6)',
            background: state === 'done' ? 'rgba(78,201,138,.16)' : 'rgba(106,168,255,.1)',
            color: state === 'failed' ? '#f2686b' : '#dbe3ee',
            cursor: state === 'working' ? 'default' : 'pointer',
            whiteSpace: 'nowrap',
          },
        }, label),
        note ? React.createElement('span', { style: { fontSize: '11px', color: state === 'failed' ? '#f2686b' : '#9aa3b2' } }, note) : null,
        images,
      )
    }

    // ================= 设置面板（设置 → 本地生图） =================
    const S = {
      surface: { background: '#0f131a', color: '#e8edf5' },
      row: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' },
      label: { fontSize: '13px', color: '#b2bdcc', minWidth: '92px' },
      input: { background: '#1a2029', color: '#e8edf5', border: '1px solid #566275', borderRadius: '7px', padding: '6px 9px', fontSize: '13px' },
      card: { border: '1px solid #465365', borderRadius: '10px', padding: '12px 14px', margin: '10px 0', background: 'rgba(255,255,255,.025)' },
      tab: (on) => ({ padding: '5px 13px', borderRadius: '8px', border: '1px solid ' + (on ? '#79aaff' : '#566275'), background: on ? 'rgba(106,168,255,.2)' : 'rgba(255,255,255,.035)', color: on ? '#f2f6ff' : '#c5cedb', cursor: 'pointer', fontSize: '13px' }),
      badge: (ok) => ({ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: ok ? '#4ec98a' : '#f2686b', marginRight: '6px' }),
    }

    function WorkflowGraphEditor(props) {
      const file = String(props?.file || '')
      const post = props?.post
      const [raw, setRaw] = React.useState(null)
      const [revision, setRevision] = React.useState('')
      const [draft, setDraft] = React.useState({})
      const [positions, setPositions] = React.useState({})
      const [selected, setSelected] = React.useState('')
      const [view, setView] = React.useState({ x: 36, y: 36, scale: 1 })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [drag, setDrag] = React.useState(null)
      const canvasRef = React.useRef(null)
      const initialPositions = React.useRef({})
      const nodeWidth = 280
      const colors = { prompt: '#54c6eb', sampler: '#ec8c42', model: '#b87bec', image: '#59cf8a', decode: '#66a9f5', other: '#d5ac5b' }

      React.useEffect(() => {
        let alive = true
        setRaw(null); setError(''); setSelected(''); setDraft({}); setPositions({})
        Promise.resolve(post('/workflow-graph', { file })).then(result => {
          if (!alive) return
          if (!result?.ok || !result?.workflow?.prompt) throw new Error(result?.error || '工作流格式不正确')
          const workflow = result.workflow
          const ids = Object.keys(workflow.prompt)
          const stored = workflow.graphPositions && typeof workflow.graphPositions === 'object' ? workflow.graphPositions : {}
          const depth = Object.fromEntries(ids.map(id => [id, 0]))
          const indegree = Object.fromEntries(ids.map(id => [id, 0]))
          const outgoing = Object.fromEntries(ids.map(id => [id, []]))
          for (const target of ids) for (const value of Object.values(workflow.prompt[target]?.inputs || {})) {
            if (Array.isArray(value) && value.length >= 2 && Object.hasOwn(workflow.prompt, String(value[0]))) {
              const source = String(value[0]); outgoing[source].push(target); indegree[target] += 1
            }
          }
          const queue = ids.filter(id => indegree[id] === 0)
          for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const source = queue[cursor]
            for (const target of outgoing[source]) {
              depth[target] = Math.max(depth[target], depth[source] + 1)
              indegree[target] -= 1
              if (indegree[target] === 0) queue.push(target)
            }
          }
          const maxDepth = Math.max(0, ...Object.values(depth))
          const layerOrder = {}
          for (const id of ids) {
            const layer = indegree[id] > 0 ? maxDepth + 1 + (ids.indexOf(id) % 2) : depth[id]
            ;(layerOrder[layer] ||= []).push(id)
          }
          const layout = {}
          const defaultPositions = {}
          for (const [layer, layerIds] of Object.entries(layerOrder)) layerIds.forEach((id, row) => {
            defaultPositions[id] = { x: 80 + Number(layer) * 370, y: 70 + row * 245 }
          })
          ids.forEach(id => {
            const position = stored[id]
            layout[id] = position && Number.isFinite(position.x) && Number.isFinite(position.y)
              ? { x: position.x, y: position.y }
              : defaultPositions[id]
          })
          initialPositions.current = JSON.parse(JSON.stringify(layout))
          setPositions(layout)
          setRevision(String(result.revision || ''))
          setRaw(workflow)
          setView({ x: 36, y: 36, scale: 1 })
        }).catch(e => { if (alive) setError('工作流读取失败：' + String(e?.message ?? e)) })
        return () => { alive = false }
      }, [file])

      const nodes = raw?.prompt || {}
      const ids = Object.keys(nodes)
      const links = []
      ids.forEach(targetId => Object.entries(nodes[targetId]?.inputs || {}).forEach(([field, value]) => {
        if (Array.isArray(value) && value.length >= 2 && Object.hasOwn(nodes, String(value[0]))) links.push({ source: String(value[0]), target: targetId, field })
      }))
      function nodeColor(classType) {
        const name = String(classType || '').toLowerCase()
        if (/clip|text|prompt|conditioning/.test(name)) return colors.prompt
        if (/sampler|scheduler/.test(name)) return colors.sampler
        if (/checkpoint|lora|model/.test(name)) return colors.model
        if (/save|preview|image|latent/.test(name)) return colors.image
        if (/decode|vae/.test(name)) return colors.decode
        return colors.other
      }
      function inputValue(nodeId, field, value) {
        const draftValue = draft[nodeId]?.[field]
        return draftValue === undefined ? String(value ?? '') : String(draftValue)
      }
      function isDirty() {
        if (!raw) return false
        for (const id of ids) {
          for (const [field, value] of Object.entries(nodes[id]?.inputs || {})) {
            if (Array.isArray(value) || (value !== null && typeof value === 'object')) continue
            const changed = draft[id]?.[field]
            if (changed !== undefined && String(changed) !== String(value ?? '')) return true
          }
          const original = initialPositions.current[id]
          const current = positions[id]
          if (original && current && (original.x !== current.x || original.y !== current.y)) return true
        }
        return false
      }
      function close() {
        if (busy) return
        if (isDirty() && !confirm('有未保存的工作流修改，确定关闭吗？')) return
        props?.onClose?.()
      }
      function setField(nodeId, field, value) {
        if (busy) return
        setDraft(current => Object.assign({}, current, { [nodeId]: Object.assign({}, current[nodeId], { [field]: value }) }))
      }
      function changeZoom(amount) {
        setView(current => Object.assign({}, current, { scale: Math.max(0.2, Math.min(2.5, current.scale + amount)) }))
      }
      function resetView() {
        setView({ x: 36, y: 36, scale: 1 })
      }
      function fitView() {
        const box = canvasRef.current
        if (!box || !ids.length) { resetView(); return }
        const xs = ids.map(id => positions[id]?.x ?? 0), ys = ids.map(id => positions[id]?.y ?? 0)
        const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys)
        const scale = Math.max(0.2, Math.min(1.4, Math.min((box.clientWidth - 70) / (maxX - minX + nodeWidth + 80), (box.clientHeight - 70) / (maxY - minY + 180))))
        setView({ x: 35 - minX * scale, y: 35 - minY * scale, scale })
      }
      function beginDrag(event, id) {
        if (busy) return
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault?.()
        setSelected(id)
        setDrag({ kind: 'node', id, startX: event.clientX, startY: event.clientY, origin: positions[id] || { x: 0, y: 0 } })
      }
      function beginPan(event) {
        if (event.target !== event.currentTarget || (event.button !== undefined && event.button !== 0)) return
        setDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, origin: { x: view.x, y: view.y } })
      }
      function movePointer(event) {
        if (busy || !drag) return
        const dx = (event.clientX - drag.startX) / (drag.kind === 'node' ? view.scale : 1)
        const dy = (event.clientY - drag.startY) / (drag.kind === 'node' ? view.scale : 1)
        if (drag.kind === 'node') setPositions(current => Object.assign({}, current, { [drag.id]: { x: Math.max(-100000, Math.min(100000, drag.origin.x + dx)), y: Math.max(-100000, Math.min(100000, drag.origin.y + dy)) } }))
        else setView(current => Object.assign({}, current, { x: drag.origin.x + dx, y: drag.origin.y + dy }))
      }
      function save() {
        if (!raw || busy) return
        const inputs = {}
        for (const [id, fields] of Object.entries(draft)) {
          for (const [field, typed] of Object.entries(fields)) {
            const original = nodes[id]?.inputs?.[field]
            if (typeof original === 'string') {
              if (String(typed) !== original) (inputs[id] ||= {})[field] = String(typed)
            } else if (typeof original === 'number') {
              if (String(typed).trim() === '') { setError('数字参数不能为空。'); return }
              const number = Number(typed)
              if (Number.isFinite(number) && number !== original) (inputs[id] ||= {})[field] = number
              else if (!Number.isFinite(number)) { setError('请输入有效数字后再保存。'); return }
            } else if (typeof original === 'boolean') {
              const bool = typed === true || typed === 'true'
              if (bool !== original) (inputs[id] ||= {})[field] = bool
            }
          }
        }
        const moved = {}
        for (const [id, position] of Object.entries(positions)) {
          const before = initialPositions.current[id]
          if (!before || before.x !== position.x || before.y !== position.y) moved[id] = { x: position.x, y: position.y }
        }
        setBusy(true); setError('')
        Promise.resolve(post('/workflow-graph', { file, patch: { inputs, positions: moved }, revision })).then(result => {
          if (!result?.ok) throw new Error(result?.error || '保存失败')
          const workflow = result.workflow || raw
          setRaw(workflow); setRevision(String(result.revision || revision)); setDraft({})
          initialPositions.current = JSON.parse(JSON.stringify(positions))
          props?.onSaved?.(workflow)
        }).catch(e => setError('保存失败：' + String(e?.message ?? e))).finally(() => setBusy(false))
      }
      const chosen = nodes[selected]
      const primitiveFields = chosen ? Object.entries(chosen.inputs || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value) || value === null) : []
      const typeStyle = type => ({ borderLeft: '4px solid ' + nodeColor(type) })
      const button = { background: '#171e29', color: '#fff', border: '1px solid #718097', borderRadius: '7px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px' }
      return h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '工作流可视化编辑器', style: { position: 'fixed', inset: 0, zIndex: 2147483200, display: 'flex', flexDirection: 'column', background: '#080d14', color: '#f4f7fb', fontFamily: 'system-ui, sans-serif' } },
        h('header', { style: { minHeight: '58px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderBottom: '1px solid #384455', background: '#101722' } },
          h('strong', { style: { fontSize: '15px', flex: 1 } }, '节点工作流 · ' + file.split(/[\\/]/).pop()),
          h('span', { role: 'status', style: { color: isDirty() ? '#ffd166' : '#9eacbd', fontSize: '12px' } }, isDirty() ? '● 有未保存修改' : (raw ? ids.length + ' 节点 · ' + links.length + ' 连线' : '读取中…')),
          h('button', { type: 'button', 'aria-label': '缩小', disabled: busy, style: button, onClick: () => changeZoom(-0.15) }, '−'),
          h('button', { type: 'button', 'aria-label': '放大', disabled: busy, style: button, onClick: () => changeZoom(0.15) }, '+'),
          h('button', { type: 'button', 'aria-label': '适配画布', disabled: busy, style: button, onClick: fitView }, '适配'),
          h('button', { type: 'button', 'aria-label': '重置视图', disabled: busy, style: button, onClick: resetView }, '重置'),
          h('button', { type: 'button', 'aria-label': '保存工作流图', disabled: !raw || !isDirty() || busy, style: Object.assign({}, button, { background: '#17684d', borderColor: '#4ed4a2', opacity: !raw || !isDirty() || busy ? 0.55 : 1 }), onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', 'aria-label': '关闭工作流图', disabled: busy, style: Object.assign({}, button, { borderColor: '#b56f78', opacity: busy ? 0.55 : 1 }), onClick: close }, '关闭 ×'),
        ),
          h('div', { style: { minHeight: 0, flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 28vw)' } },
          h('div', { ref: canvasRef, role: 'application', 'aria-label': '工作流节点画布', onMouseDown: event => { if (!busy) beginPan(event) }, onMouseMove: movePointer, onMouseUp: () => setDrag(null), onMouseLeave: () => setDrag(null), onWheel: event => { event.preventDefault?.(); if (!busy) changeZoom(event.deltaY < 0 ? 0.08 : -0.08) }, style: { position: 'relative', overflow: 'hidden', cursor: drag?.kind === 'pan' ? 'grabbing' : 'grab', backgroundColor: '#0b111a', backgroundImage: 'radial-gradient(#344153 1px, transparent 1px)', backgroundSize: '22px 22px' } },
            error ? h('div', { role: 'alert', style: { position: 'absolute', zIndex: 4, top: '12px', left: '12px', color: '#ff9a9e', background: '#21141a', border: '1px solid #854650', borderRadius: '7px', padding: '8px 12px', fontSize: '12px' } }, error) : null,
            raw ? h('div', { style: { position: 'absolute', left: 0, top: 0, transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')', transformOrigin: '0 0' } },
              h('svg', { 'aria-hidden': 'true', width: 1, height: 1, style: { position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' } },
                h('defs', null, h('marker', { id: 'workflow-graph-arrow', markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' }, h('path', { d: 'M0,0 L0,6 L7,3 z', fill: '#91a8c1' }))),
                links.map((link, index) => {
                  const from = positions[link.source] || { x: 0, y: 0 }, to = positions[link.target] || { x: 0, y: 0 }
                  const x1 = from.x + nodeWidth, y1 = from.y + 56, x2 = to.x, y2 = to.y + 56, curve = Math.max(50, Math.abs(x2 - x1) * 0.45)
                  return h('path', { key: index, d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve) + ' ' + y1 + ', ' + (x2 - curve) + ' ' + y2 + ', ' + x2 + ' ' + y2, fill: 'none', stroke: '#91a8c1', strokeWidth: 2.2, opacity: 0.9, markerEnd: 'url(#workflow-graph-arrow)' })
                })),
              ids.map((id, index) => {
                const node = nodes[id], position = positions[id] || { x: 0, y: 0 }, classType = node.class_type || '未知节点'
                const primitiveCount = Object.values(node.inputs || {}).filter(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)).length
                return h('div', { key: id, role: 'button', tabIndex: 0, 'aria-label': '节点 ' + id + ' ' + classType, onClick: () => setSelected(id), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault?.(); setSelected(id) } }, onMouseDown: event => { if (!busy) beginDrag(event, id) }, onMouseMove: movePointer, onMouseUp: () => setDrag(null), style: { position: 'absolute', left: position.x, top: position.y, width: nodeWidth, boxSizing: 'border-box', border: '1px solid ' + (selected === id ? '#fff' : nodeColor(classType)), borderRadius: '9px', background: '#151e2a', boxShadow: selected === id ? '0 0 0 2px rgba(255,255,255,.28), 0 8px 24px #0009' : '0 6px 18px #0008', overflow: 'hidden', cursor: drag?.id === id ? 'grabbing' : 'grab' } },
                  h('div', { style: Object.assign({ padding: '9px 11px', background: '#222d3b', fontWeight: 650, fontSize: '12px', display: 'flex', justifyContent: 'space-between', gap: '8px' }, typeStyle(classType)) }, h('span', null, classType), h('span', { style: { color: '#acb9c9', fontWeight: 400 } }, '#' + id)),
                  h('div', { style: { padding: '8px 11px', color: '#bfccdb', fontSize: '11px', lineHeight: '1.5' } }, primitiveCount ? primitiveCount + ' 个可编辑参数' : '参数由连线提供', node._meta?.title ? h('div', { style: { marginTop: '3px', color: '#97a8ba' } }, node._meta.title) : null),
                )
              }),
            ) : h('div', { style: { padding: '24px', color: '#c1cfdf', fontSize: '13px' } }, error || '正在读取工作流…'),
          ),
          h('aside', { style: { overflowY: 'auto', borderLeft: '1px solid #384455', background: '#101722', padding: '16px', color: '#f4f7fb' } },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '12px' } }, chosen ? '节点检查器' : '选择一个节点'),
            chosen ? h('div', null,
              h('div', { style: { padding: '10px', borderRadius: '8px', background: '#192331', borderLeft: '4px solid ' + nodeColor(chosen.class_type), marginBottom: '12px' } },
                h('div', { style: { fontSize: '13px', fontWeight: 650 } }, chosen._meta?.title || chosen.class_type || '未知节点'),
                h('div', { style: { fontSize: '11px', color: '#b8c5d3', marginTop: '4px' } }, '节点 #' + selected + ' · ' + Object.keys(chosen.inputs || {}).length + ' 个输入')),
              h('div', { style: { fontSize: '11px', lineHeight: 1.5, color: '#f0cc84', background: '#282116', padding: '8px', borderRadius: '7px', marginBottom: '12px' } }, '提示：绑定的正面、负面、种子和尺寸会被生成设置覆盖。'),
              primitiveFields.length ? primitiveFields.map(([field, value]) => h('label', { key: field, style: { display: 'block', margin: '0 0 12px', fontSize: '11px', color: '#d4deea' } },
                h('span', { style: { display: 'block', marginBottom: '5px', color: '#b8c5d3' } }, field + ' · ' + (typeof value === 'boolean' ? '布尔' : typeof value === 'number' ? '数字' : '文本')),
                value === null ? h('div', { style: { color: '#9eacbd', fontStyle: 'italic' } }, '空值（只读）') : typeof value === 'boolean'
                  ? h('input', { type: 'checkbox', disabled: busy, 'aria-label': field, checked: draft[selected]?.[field] === undefined ? value : (draft[selected][field] === true || draft[selected][field] === 'true'), onChange: event => setField(selected, field, event.target.checked) })
                  : h(typeof value === 'string' && value.length > 100 ? 'textarea' : 'input', { type: typeof value === 'number' ? 'number' : 'text', disabled: busy, 'aria-label': field, value: inputValue(selected, field, value), onChange: event => setField(selected, field, event.target.value), style: { width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: '6px', border: '1px solid #66778d', background: busy ? '#151b24' : '#0c121b', color: '#fff', fontSize: '12px', minHeight: typeof value === 'string' && value.length > 100 ? '84px' : '34px' } }),
              )) : h('div', { style: { color: '#b8c5d3', fontSize: '12px' } }, '此节点没有可编辑的普通参数。'),
              h('div', { style: { borderTop: '1px solid #384455', paddingTop: '12px', marginTop: '10px', fontSize: '11px', color: '#b8c5d3' } },
                '已有连线（只读）',
                links.filter(link => link.target === selected || link.source === selected).map((link, i) => h('div', { key: i, style: { marginTop: '6px', color: '#d7e2ee' } }, link.source + ' → ' + link.target + ' · ' + link.field))),
            ) : h('div', { style: { color: '#b8c5d3', fontSize: '12px', lineHeight: 1.6 } }, '点选画布中的节点查看参数。可拖动节点调整布局，滚轮缩放，拖动画布空白处平移。'),
            error ? h('div', { role: 'alert', style: { color: '#ff9a9e', fontSize: '12px', marginTop: '12px' } }, error) : null,
          ),
        ),
      )
    }

    function SettingsPanel() {
      const [data, setDataState] = React.useState(null)
      // 让定时器/异步回调读到"最新的" data，而不用把它写进 effect 依赖
      const dataRef = React.useRef(null)
      dataRef.current = data
      const libraryDirty = React.useRef(false)
      const libraryRevision = React.useRef(0)
      const librarySaveQueue = React.useRef(Promise.resolve())
      function setData(update) {
        const next = typeof update === 'function' ? update(dataRef.current) : update
        dataRef.current = next
        setDataState(next)
      }
      function receiveState(next, requestRevision) {
        if (!next) return
        const current = dataRef.current
        setData((libraryDirty.current || (typeof requestRevision === 'number' && requestRevision !== libraryRevision.current)) && current
          ? Object.assign({}, next, { definitions: current.definitions, outfits: current.outfits })
          : next)
      }
      function setLibraryData(update) {
        libraryDirty.current = true
        libraryRevision.current += 1
        setData(update)
        setSaveState('')
      }
      const [tab, setTab] = React.useState('plan')
      const [pluginUpdateLocal, setPluginUpdateLocal] = React.useState(null)
      const [pluginUpdateCheck, setPluginUpdateCheck] = React.useState(null)
      const [pluginUpdateNote, setPluginUpdateNote] = React.useState('')
      const [pluginUpdatePending, setPluginUpdatePending] = React.useState('')
      const pluginUpdateLocalAttempted = React.useRef(false)
      const pluginUpdateLocalInFlight = React.useRef(false)
      const pluginUpdatePendingRef = React.useRef('')
      const pluginUpdateView = React.useRef(0)
      const pluginUpdateTabRef = React.useRef(tab)
      const pluginUpdateMounted = React.useRef(true)
      pluginUpdateTabRef.current = tab
      const [note, setNote] = React.useState('')
      const [planText, setPlanText] = React.useState('')
      const [planRows, setPlanRows] = React.useState(null)
      // 哪一行正在展开"选择绑定卡片"（-1 = 都没展开）；内联展开，不用浮层
      const [cardPickerFor, setCardPickerFor] = React.useState(-1)
      const [cardList, setCardList] = React.useState([])
      const [peopleSearch, setPeopleSearch] = React.useState('')
      const [peopleActiveId, setPeopleActiveId] = React.useState('')
      const [peopleEditorOpen, setPeopleEditorOpen] = React.useState(true)
      const [peoplePicked, setPeoplePicked] = React.useState({})
      const [peopleBatchOpen, setPeopleBatchOpen] = React.useState(false)
      const [peopleBatchField, setPeopleBatchField] = React.useState('feature')
      const [peopleBatchMode, setPeopleBatchMode] = React.useState('replace')
      const [peopleBatchValue, setPeopleBatchValue] = React.useState('')
      const [peopleBatchCards, setPeopleBatchCards] = React.useState([])
      const [peopleBatchNote, setPeopleBatchNote] = React.useState('')
      // 设计角色：内联展开（不用浮层，设置面板层级更高会挡住）
      const [designOpen, setDesignOpen] = React.useState(false)
      const [designBrief, setDesignBrief] = React.useState('')
      const [designPhoto, setDesignPhoto] = React.useState('')
      const [designPreview, setDesignPreview] = React.useState('')
      const [designName, setDesignName] = React.useState('')
      const [designNote, setDesignNote] = React.useState('')
      const [designBusy, setDesignBusy] = React.useState(false)
      const [designPanelBusy, setDesignPanelBusy] = React.useState(false)
      const designInFlight = React.useRef(false)
      // 改进模式：记录角色 id（空 = 新建），不受删除、排序影响。
      const [improveTarget, setImproveTarget] = React.useState('')
      // 设计完成后的醒目提醒（未保存）
      const [designDone, setDesignDone] = React.useState('')
      // 用稳定 id 保存改进草稿；删除前面的角色不会让草稿移到另一位身上。
      const [improveDraft, setImproveDraft] = React.useState({})
      // 正在跑的改进任务（按角色 id 去重，不妨碍连续生成别的）
      const improveInFlight = React.useRef({})
      // 保存状态：'' 空闲 / 'saving' / 'saved' / 'failed:原因'
      const [saveState, setSaveState] = React.useState('')
      // 历史图库
      const [historyJobs, setHistoryJobs] = React.useState([])
      const [historyNote, setHistoryNote] = React.useState('')
      // 历史图的重载信号：切 tab 与点「刷新」都靠它真正重跑一次拉取。
      // 原来「刷新」是 setTab('plan') + setTimeout(setTab('gallery'))，依赖 [tab] 时
      // 在 React 批处理下常常不产生两次真实变化，effect 不重跑 —— 界面就一直停在
      // 上次失败的「读不到: Failed to fetch」，点多少次刷新都不会更新。
      const [historyTick, setHistoryTick] = React.useState(0)
      // 历史图：批量选择模式
      const [gallerySelect, setGallerySelect] = React.useState(false)
      const [galleryPicked, setGalleryPicked] = React.useState({})
      // 世界书：正在编辑的条目（-1 = 没在编辑）/ 导入面板 / 粘贴内容
      const [wbEditing, setWbEditing] = React.useState(-1)
      const [wbImportOpen, setWbImportOpen] = React.useState(false)
      const [wbPaste, setWbPaste] = React.useState('')
      const [wbNote, setWbNote] = React.useState('')
      // 工作流：展开哪张 / 它的详情 / 导入面板 / ComfyUI 已装的 LoRA
      const [wfOpen, setWfOpen] = React.useState('')
      const [wfGraphFile, setWfGraphFile] = React.useState('')
      const [wfDetail, setWfDetail] = React.useState(null)
      const [wfImportOpen, setWfImportOpen] = React.useState(false)
      const [wfPaste, setWfPaste] = React.useState('')
      const [wfNote, setWfNote] = React.useState('')
      const [loraList, setLoraList] = React.useState([])
      const [simpleInfo, setSimpleInfo] = React.useState(null)
      const [simpleLoading, setSimpleLoading] = React.useState(false)
      const [simpleNote, setSimpleNote] = React.useState('')
      const [simpleConfigDraft, setSimpleConfigDraft] = React.useState(null)
      // 可选的 provider / model（从 DSH 的 llm 服务拉）
      const [llmProviders, setLlmProviders] = React.useState([])
      const [llmModels, setLlmModels] = React.useState({})     // provider → [{id,name,vision}]
      const [llmReasoning, setLlmReasoning] = React.useState({}) // provider/model → {efforts,defaultEffort}
      const [llmNote, setLlmNote] = React.useState('')
      const [comfyStatus, setComfyStatus] = React.useState(null)
      // API secrets stay in local input drafts; /state returns only hasApiKey/hasPassword flags.
      const [channelSecretDrafts, setChannelSecretDrafts] = React.useState({})
      const [channelTestStatuses, setChannelTestStatuses] = React.useState({})
      const channelDraftRevisions = React.useRef({})
      const [wfTestNote, setWfTestNote] = React.useState('')
      const [wfTestJob, setWfTestJob] = React.useState('')
      const [wfNoop, setWfNoop] = React.useState(false)
      // 简单编辑：这张工作流的参数值（打开详情时读一次）
      const [wfValues, setWfValues] = React.useState(null)
      // 世界书编辑防抖：别每敲一个字就写一次盘（会和上一次写入撞车，报 EPERM）
      const wbTimer = React.useRef(null)
      const wbSeq = React.useRef(0)

      // 防重入：上一轮 /state 还没回来就不再发（慢网络下会堆请求）
      const refreshInFlight = React.useRef(false)
      function refresh() {
        if (refreshInFlight.current) return Promise.resolve()
        refreshInFlight.current = true
        const revision = libraryRevision.current
        return jsonFetch(BASE + '/state').then(next => receiveState(next, revision)).catch(e => {
          setNote('读不到状态：' + (e && e.message ? e.message : e))
          reportHost('state-fail', { msg: String(e?.message ?? e), base: BASE })
        }).finally(() => { refreshInFlight.current = false })
      }
      React.useEffect(() => { refresh() }, [])
      React.useEffect(() => { loadProviders() }, [])
      // 等 /state 到位再测 ComfyUI：那时才拿得到 comfyUrl，也避开首次渲染的 config TDZ
      React.useEffect(() => { if (data?.config?.imageBackend === 'comfyui') loadComfyStatus() }, [data?.config?.imageBackend])
      const channelTestsInFlight = React.useRef({})
      React.useEffect(() => {
        const view = ++pluginUpdateView.current
        if (tab === 'plugin-update' && !pluginUpdateLocalAttempted.current) {
          pluginUpdateLocalAttempted.current = true
          void loadPluginUpdateLocal()
        }
        return () => {
          if (pluginUpdateView.current === view) pluginUpdateView.current += 1
        }
      }, [tab])
      React.useEffect(() => {
        pluginUpdateMounted.current = true
        return () => { pluginUpdateMounted.current = false; pluginUpdateView.current += 1 }
      }, [])
      // 任务轮询：依赖写成 [] 并在内部读最新数据（原来依赖 data，
      // 每轮 refresh 都会让 effect 重建，慢的时候会叠起一堆请求）
      React.useEffect(() => {
        const timer = setInterval(() => {
          const tasks = (dataRef.current?.tasks || [])
          if (tasks.some(t => t.state === 'running')) refresh()
        }, 3000)
        return () => clearInterval(timer)
      }, [])
      React.useEffect(() => {
        if (tab !== 'gallery') return undefined
        let alive = true
        setHistoryNote('读取中…')
        jsonFetch(BASE + '/history', { cache: 'no-store' }).then(r => {
          if (!alive) return
          const list = r?.jobs ?? []
          setHistoryJobs(list)
          setHistoryNote(list.length ? '' : '还没有生成过图片')
          reportHost('history-ok', { jobs: list.length })
        }).catch(error => {
          if (!alive) return
          setHistoryNote('读不到：' + (error?.message ?? error))
          reportHost('history-fail', {
            name: String(error?.name ?? ''),
            msg: String(error?.message ?? error),
            stack: String(error?.stack ?? '').slice(0, 400),
            url: BASE + '/history',
          })
        })
        return () => { alive = false }
      }, [tab, historyTick])

      function post(pathname, body) {
        return jsonFetch(BASE + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      }
      function mergePluginUpdateLocalStatus(status) {
        setPluginUpdateLocal(current => {
          const next = Object.assign({}, current, {
            currentVersion: status?.currentVersion ?? current?.currentVersion,
            restartRequired: status?.restartRequired ?? current?.restartRequired,
            directoryMigrationRequired: status?.directoryMigrationRequired ?? current?.directoryMigrationRequired,
            directoryMigrationMessage: status?.directoryMigrationMessage ?? current?.directoryMigrationMessage,
          })
          if (typeof status?.supported === 'boolean') {
            next.supported = status.supported
            next.reason = status.reason || ''
          } else if (status?.reason) next.reason = status.reason
          return next
        })
      }
      async function loadPluginUpdateLocal() {
        if (pluginUpdatePendingRef.current || pluginUpdateLocalInFlight.current) return
        pluginUpdateLocalInFlight.current = true
        pluginUpdatePendingRef.current = 'local'
        setPluginUpdatePending('local')
        setPluginUpdateNote('读取本地插件状态…')
        const view = pluginUpdateView.current
        try {
          const status = await jsonFetch(BASE + '/plugin-update')
          if (view !== pluginUpdateView.current || pluginUpdateTabRef.current !== 'plugin-update') return
          setPluginUpdateLocal(status)
          setPluginUpdateNote(status?.supported === false
            ? (status.reason || '当前安装方式暂不支持自动更新。')
            : status?.restartRequired
              ? '插件需要完整重启 DSH 后生效。'
              : status?.directoryMigrationRequired ? status.directoryMigrationMessage : '')
        } catch (error) {
          if (view !== pluginUpdateView.current || pluginUpdateTabRef.current !== 'plugin-update') return
          setPluginUpdateNote('读取本地插件状态失败：' + (error?.message ?? error))
        } finally {
          pluginUpdateLocalInFlight.current = false
          if (pluginUpdatePendingRef.current === 'local') {
            pluginUpdatePendingRef.current = ''
            if (pluginUpdateMounted.current) setPluginUpdatePending('')
          }
        }
      }
      async function checkPluginUpdate() {
        if (pluginUpdatePendingRef.current || pluginUpdateLocal?.supported !== true) return
        pluginUpdatePendingRef.current = 'check'
        setPluginUpdatePending('check')
        setPluginUpdateNote('正在检查插件更新…')
        const view = pluginUpdateView.current
        try {
          const status = await post('/plugin-update/check', {})
          if (view !== pluginUpdateView.current || pluginUpdateTabRef.current !== 'plugin-update') return
          setPluginUpdateCheck(status)
          mergePluginUpdateLocalStatus(status)
          const supported = status?.supported ?? pluginUpdateLocal?.supported
          const reason = status?.reason ?? (status?.supported === false ? '' : pluginUpdateLocal?.reason)
          setPluginUpdateNote(supported === false
            ? (reason || '当前安装方式暂不支持自动更新。')
            : status?.restartRequired
              ? (status.message && status.message.includes('完整重启 DSH') ? status.message : [status.message, '插件已更新，需要完整重启 DSH 才会生效。'].filter(Boolean).join(' '))
              : status?.directoryMigrationRequired
                ? [status?.available ? '发现可用更新。' : '', status.directoryMigrationMessage].filter(Boolean).join(' ')
                : reason
                  ? reason
                  : status?.available
                    ? (status?.canUpdate ? '发现可用更新。' : (status?.reason || '发现新版本，但当前无法自动更新。'))
                    : '当前已是最新版本。')
        } catch (error) {
          if (view !== pluginUpdateView.current || pluginUpdateTabRef.current !== 'plugin-update') return
          setPluginUpdateNote('检查更新失败：' + (error?.message ?? error))
        } finally {
          if (pluginUpdatePendingRef.current === 'check') {
            pluginUpdatePendingRef.current = ''
            if (pluginUpdateMounted.current) setPluginUpdatePending('')
          }
        }
      }
      async function applyPluginUpdate() {
        if (pluginUpdatePendingRef.current || !pluginUpdateLocal?.supported || !pluginUpdateCheck?.available || !pluginUpdateCheck?.canUpdate || pluginUpdateCheck?.restartRequired || pluginUpdateLocal?.restartRequired) return
        if (libraryDirty.current) {
          setPluginUpdateNote('请先保存人物库，再更新插件。')
          return
        }
        pluginUpdatePendingRef.current = 'apply'
        setPluginUpdatePending('apply')
        setPluginUpdateNote('正在更新插件…')
        const view = pluginUpdateView.current
        try {
          const status = await post('/plugin-update/apply', { target: pluginUpdateCheck.target })
          if (!pluginUpdateMounted.current) return
          const completedStatus = Object.assign({}, status, { restartRequired: true })
          setPluginUpdateCheck(completedStatus)
          mergePluginUpdateLocalStatus(completedStatus)
          setPluginUpdateNote(status?.message && status.message.includes('完整重启 DSH')
            ? status.message
            : [status?.message, '插件更新完成，请完整重启 DSH 后生效。'].filter(Boolean).join(' '))
        } catch (error) {
          if (view !== pluginUpdateView.current || pluginUpdateTabRef.current !== 'plugin-update') return
          setPluginUpdateNote('更新插件失败：' + (error?.message ?? error))
        } finally {
          if (pluginUpdatePendingRef.current === 'apply') {
            pluginUpdatePendingRef.current = ''
            if (pluginUpdateMounted.current) setPluginUpdatePending('')
          }
        }
      }
      async function save(patch) {
        setNote('保存中…')
        const revision = libraryRevision.current
        try {
          const r = await post('/config', { config: patch })
          receiveState(r.state, revision)
          setNote('已保存')
          return r
        } catch (e) { setNote('保存失败：' + (e && e.message ? e.message : e)); return null }
      }

      if (!data) return h('div', { style: Object.assign({}, S.surface, { padding: '18px', fontSize: '13px' }) }, note || '正在读取…')
      const config = data.config || {}
      const workflows = data.workflows || []
      const effective = config.plannerEffective || {}

      // ---- 顶部状态 ----
      // ---- 顶部状态 ----
      const imageBackend = String(config.imageBackend || 'comfyui')
      const providers = Array.isArray(data.imageProviders) ? data.imageProviders : []
      const selectedChannel = (Array.isArray(config.imageChannels) ? config.imageChannels : []).find(channel => channel.id === config.activeImageChannel && channel.provider === imageBackend)
      const comfyOnline = imageBackend === 'comfyui' && Boolean(data.comfy && data.comfy.ok)
      const externalStatus = selectedChannel ? channelTestStatuses[selectedChannel.id] : null
      const externalConnected = Boolean(externalStatus?.ok && externalStatus.status === 'reachable')
      const backendLabel = imageBackend === 'comfyui'
        ? 'ComfyUI'
        : ((providers.find(item => item.id === imageBackend) || {}).label || imageBackend)
      const head = h('div', { style: S.card },
        h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: imageBackend === 'comfyui' ? S.badge(comfyOnline) : Object.assign({}, S.badge(externalConnected), (!externalStatus || externalStatus.status === 'configured') ? { background: '#8491a2' } : {}) }),
          h('span', null, imageBackend === 'comfyui'
            ? (comfyOnline ? ('ComfyUI 在线' + (data.comfy.version ? ' ' + data.comfy.version : '') + (data.comfy.device ? '　' + data.comfy.device : '')) : ('ComfyUI 没开' + (data.comfy && data.comfy.error ? '：' + data.comfy.error : '')))
            : (backendLabel + (selectedChannel ? ' · ' + selectedChannel.name : ' · 尚未选择渠道') + (externalStatus?.checking ? ' · 检测中…' : externalConnected ? ' · 连接可用' : externalStatus?.status === 'configured' ? ' · 已配置，尚未验证' : externalStatus ? ' · 连接失败' : selectedChannel ? ' · 已配置，尚未验证' : ''))),
          imageBackend === 'comfyui' ? h('button', {
            style: { fontSize: '11px', padding: '3px 10px', borderRadius: '7px', border: '1px solid rgba(150,170,200,.45)', background: 'transparent', color: '#9aa3b2', cursor: 'pointer' },
            onClick: loadComfyStatus,
          }, comfyStatus?.checking ? '检测中…' : '测试连接') : null,
          imageBackend === 'comfyui' && comfyStatus && !comfyStatus.checking ? h('span', { style: { fontSize: '11px', color: comfyStatus.ok ? '#8bd48b' : '#f2686b' } },
            comfyStatus.ok ? ('✓ ' + (comfyStatus.ms || 0) + 'ms') : ('✗ ' + String(comfyStatus.error || '').slice(0, 60))) : null,
        ),
        imageBackend === 'comfyui' ? h('div', { style: { fontSize: '12px', color: '#9aa3b2' } },
          '当前画风：' + (config.comfyMode === 'simple'
            ? ('简单模式 · ' + ({ checkpoint: 'Checkpoint（SD / SDXL）', flux: 'Flux', anima: 'Anima' }[config.comfySimple?.template] || 'Checkpoint') + ' · ' + (config.comfySimple?.template === 'checkpoint' ? (config.comfySimple?.checkpoint || '未选模型') : (config.comfySimple?.unet || '未选模型')))
            : ((workflows.find(w => w.id === config.defaultWorkflow) || {}).label || '（没选）'))) : null,
        h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '4px' } },
          config.plannerEnabled ? ('规划模型：' + effective.provider + ' / ' + effective.model + (effective.fromTavern ? '（跟随 Tavern）' : '')) : '（规划已关）',
        ),
        note ? h('div', { style: { fontSize: '12px', marginTop: '6px', color: '#6aa8ff' } }, note) : null,
      )

      // ---- 手动生图（安全版：只读写自己的数据，不接管宿主渲染）----
      function ManualCard() {
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState('')
        async function run() {
          if (busy) return
          setBusy(true)
          setNote('正在按最新一条回复规划…')
          try {
            const r = await post('/plan', { sessionId: lastSessionId, manual: true })
            const ids = (r.plans || []).map(p => p.jobId).filter(Boolean)
            if (!ids.length) { setNote('没有产出画面：' + (r.error || '模型没返回 <image> 块')); return }
            setNote('已提交 ' + ids.length + ' 张，正在画…')
            if (typeof openImageOverlay === 'function') openImageOverlay({ open: true, jobIds: ids, note: '本轮 ' + ids.length + ' 张', working: false })
          } catch (error) {
            setNote('失败：' + (error && error.message ? error.message : error))
          } finally {
            setBusy(false)
          }
        }
        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '手动生图'),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } }, '按当前会话最新一条回复的正文生成插图。会弹出全屏看图。'),
          h('div', { style: S.row },
            h('button', { style: Object.assign({}, buttonStyle, { padding: '5px 16px', fontSize: '13px' }), disabled: busy, onClick: run },
              busy ? '🎨 生成中…' : '🎨 给最新一条回复生图'),
            note ? h('span', { style: { fontSize: '12px', color: note.startsWith('失败') || note.startsWith('没有') ? '#f2686b' : '#9aa3b2' } }, note) : null,
          ),
        )
      }

      // ---- 后台任务（正在跑什么、能不能取消）----
      function taskPanel() {
        const list = data.tasks || []
        const running = list.filter(t => t.state === 'running')
        if (!list.length) return null
        const rows = list.slice(0, 6).map(t => {
          const seconds = Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000)
          const label = t.kind + '：' + t.label
          if (t.state === 'running') {
            return h('div', { key: t.id, style: { fontSize: '12px', margin: '3px 0' } },
              h('span', { style: { color: '#6aa8ff' } }, '● ' + label + '（后台进行中，' + seconds + 's）'),
              h('button', { style: Object.assign({}, buttonStyle, { marginLeft: '8px', padding: '1px 9px', fontSize: '11px' }), onClick: async () => { await post('/cancel', { id: t.id }); refresh() } }, '取消'),
            )
          }
          return h('div', { key: t.id, style: { fontSize: '12px', margin: '3px 0', color: '#9aa3b2' } },
            (t.state === 'done' ? '✓ ' : t.state === 'cancelled' ? '⊗ ' : '✗ ') + label + '　' + seconds + 's' + (t.error ? '　' + t.error : ''))
        })
        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '后台任务' + (running.length ? '（' + running.length + ' 个在跑）' : '')),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '6px' } }, '规划、设计、看图都在后台跑，不占用前台写作；这里能看到进度，卡住可以取消。'),
          rows,
        )
      }

      // ---- 规划页 ----
      /** 生图后端（ComfyUI 地址与鉴权）—— 标签在上、控件全宽。 */
      function ComfyBackendCard() {
        const optStyle = { color: '#12161c', background: '#e9eef6' }
        const providerOptions = providers.length ? providers : [
          ['novelai', 'NovelAI'], ['openai', 'OpenAI 兼容'], ['gemini', 'Gemini'], ['gemini-chat', 'Gemini Chat'],
          ['grok', 'Grok'], ['seedream', 'Seedream'], ['qwen', 'Qwen'], ['sdwebui', 'Stable Diffusion WebUI'],
        ].map(([id, label]) => ({ id, label }))
        const backend = imageBackend
        const channels = Array.isArray(config.imageChannels) ? config.imageChannels : []
        const channel = selectedChannel
        const channelDraft = channel ? (channelSecretDrafts[channel.id] || { apiKey: '', password: '' }) : { apiKey: '', password: '' }
        const localFields = channel ? (channelDraft.fields || channel) : {}
        const full = (extra) => Object.assign({}, S.input, { width: '100%', boxSizing: 'border-box', colorScheme: 'dark' }, extra || {})
        const label = (text, hint) => h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '5px' } },
          text, hint ? h('span', { style: { color: '#9aa3b2', marginLeft: '6px' } }, hint) : null)
        const setCfg = (patch) => setData(Object.assign({}, data, { config: Object.assign({}, config, patch) }))
        const nextId = (provider) => provider + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        const defaultChannel = provider => {
          const preset = providerOptions.find(item => item.id === provider) || {}
          return { id: nextId(provider), name: (preset.label || provider) + ' 渠道', provider, baseUrl: preset.baseUrl || '', model: preset.model || '', authMode: 'bearer', username: '', options: {}, hasApiKey: false, hasPassword: false }
        }
        const persistChannelSelection = (nextChannels, provider, activeId) => {
          setCfg({ imageChannels: nextChannels, imageBackend: provider, activeImageChannel: activeId })
          save({ imageChannels: nextChannels, imageBackend: provider, activeImageChannel: activeId })
        }
        const editChannel = patch => {
          if (!channel) return
          const next = Object.assign({}, localFields, patch)
          setChannelSecretDrafts(current => Object.assign({}, current, { [channel.id]: Object.assign({}, current[channel.id], { fields: next }) }))
          channelDraftRevisions.current[channel.id] = (channelDraftRevisions.current[channel.id] || 0) + 1
          setChannelTestStatuses(current => { const statuses = Object.assign({}, current); delete statuses[channel.id]; return statuses })
        }
        const markSecretEdited = id => {
          channelDraftRevisions.current[id] = (channelDraftRevisions.current[id] || 0) + 1
          setChannelTestStatuses(current => { const statuses = Object.assign({}, current); delete statuses[id]; return statuses })
        }
        const updateOption = (key, value) => editChannel({ options: Object.assign({}, localFields.options || {}, { [key]: value }) })
        const field = (fieldName, caption, placeholder, type = 'text') => h('div', { style: { marginBottom: '10px' } },
          label(caption), h('input', { 'aria-label': caption, type, value: String(localFields[fieldName] ?? ''), placeholder: placeholder || '', style: full(), onChange: e => editChannel({ [fieldName]: e.target.value }) }))
        const optionField = (key, caption, placeholder, type = 'text') => h('div', { style: { marginBottom: '10px' } },
          label(caption), h('input', { 'aria-label': caption, type, value: String((localFields.options || {})[key] ?? ''), placeholder: placeholder || '', style: full(), onChange: e => updateOption(key, type === 'number' ? Number(e.target.value) : e.target.value) }))
        const modelSuggestions = channel ? [...new Set([
          providers.find(item => item.id === backend)?.model,
          ...(channelTestStatuses[channel.id]?.models || []),
        ].filter(Boolean).map(String))] : []
        const modelInput = channel ? h('div', { style: { marginBottom: '10px' } },
          label('模型'), h('input', { 'aria-label': '模型', list: 'image-models-' + channel.id, type: 'text', value: String(localFields.model ?? ''), placeholder: '选择建议模型或填写自定义模型 ID', style: full(), onChange: e => editChannel({ model: e.target.value }) }),
          modelSuggestions.length ? h('datalist', { id: 'image-models-' + channel.id }, modelSuggestions.map(model => h('option', { key: model, value: model }))) : null) : null
        const generatePathPlaceholder = ({ novelai: '/ai/generate-image', openai: '/images/generations', 'gemini-chat': '/chat/completions', grok: '/images/generations', seedream: '/images/generations', qwen: '/services/aigc/multimodal-generation/generation', sdwebui: '/sdapi/v1/txt2img' })[backend]
        const authMode = String(config.comfyAuthMode ?? 'none')
        const saveComfy = () => save({
          comfyUrl: config.comfyUrl || '', comfyAuthMode: authMode,
          comfyAuthToken: config.comfyAuthToken || '', comfyAuthUser: config.comfyAuthUser || '', comfyAuthPass: config.comfyAuthPass || '',
        })
        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '10px' } }, '生图后端'),
          h('div', { style: { marginBottom: '12px' } },
            label('提供商'),
            h('select', { 'aria-label': '生图提供商', value: backend, style: full(), onChange: e => {
              const provider = e.target.value
              if (provider === 'comfyui') { save({ imageBackend: provider }); setCfg({ imageBackend: provider }); return }
              let selected = channels.find(item => item.provider === provider)
              let next = channels
              if (!selected) { selected = defaultChannel(provider); next = channels.concat(selected) }
              persistChannelSelection(next, provider, selected.id)
            } },
              h('option', { value: 'comfyui', style: optStyle }, 'ComfyUI'),
              providerOptions.map(item => h('option', { key: item.id, value: item.id, style: optStyle }, item.label + (item.id !== item.label ? '（' + item.id + '）' : ''))),
            ),
          ),
          backend === 'comfyui' ? h('div', null,
            h('div', { style: { marginBottom: '12px' } },
              label('API 根地址'),
              h('input', { type: 'text', value: config.comfyUrl || '', placeholder: 'http://127.0.0.1:8188', style: full(), onChange: e => setCfg({ comfyUrl: e.target.value }) }),
            ),
            h('div', { style: { marginBottom: '12px' } },
              label('服务鉴权'),
              h('select', { value: authMode, style: full(), onChange: e => { const v = e.target.value; setCfg({ comfyAuthMode: v }); save({ comfyAuthMode: v }) } },
                h('option', { value: 'none', style: optStyle }, '无需鉴权'), h('option', { value: 'bearer', style: optStyle }, 'Bearer Token'), h('option', { value: 'basic', style: optStyle }, 'Basic（用户名 / 密码）')),
            ),
            authMode === 'bearer' ? h('div', { style: { marginBottom: '12px' } }, label('Token'), h('input', { type: 'password', value: config.comfyAuthToken || '', placeholder: '粘贴 token', style: full(), onChange: e => setCfg({ comfyAuthToken: e.target.value }) })) : null,
            authMode === 'basic' ? h('div', { style: { marginBottom: '12px' } },
              label('用户名'), h('input', { type: 'text', value: config.comfyAuthUser || '', style: Object.assign(full(), { marginBottom: '8px' }), onChange: e => setCfg({ comfyAuthUser: e.target.value }) }),
              label('密码'), h('input', { type: 'password', value: config.comfyAuthPass || '', style: full(), onChange: e => setCfg({ comfyAuthPass: e.target.value }) })) : null,
            h('button', { style: Object.assign({}, buttonStyle, { fontWeight: 600 }), onClick: async () => {
              await saveComfy(); setComfyStatus({ checking: true })
              const r = await post('/comfy-test', { url: config.comfyUrl || '', authMode, authToken: config.comfyAuthToken || '', authUser: config.comfyAuthUser || '', authPass: config.comfyAuthPass || '' }).catch(e => ({ ok: false, error: String(e?.message ?? e) }))
              setComfyStatus(r)
            } }, comfyStatus?.checking ? '测试中…' : '测试连接与鉴权'),
            comfyStatus?.checking ? h('span', { style: { fontSize: '12px', color: '#9aa3b2', marginLeft: '10px' } }, '正在连接…') : null,
            comfyStatus && !comfyStatus.checking ? h('span', { style: { fontSize: '12px', color: comfyStatus.ok ? '#8bd48b' : '#f2686b', marginLeft: '10px' } }, comfyStatus.ok ? ('● 在线' + (comfyStatus.version ? ' ' + comfyStatus.version : '') + (comfyStatus.device ? '　' + comfyStatus.device : '') + (comfyStatus.vram ? '　' + comfyStatus.vram : '') + '　✓ ' + (comfyStatus.ms || 0) + 'ms') : ('● 离线：' + String(comfyStatus.error || '未知原因'))) : null,
          ) : channel ? h('div', null,
            h('div', { style: S.row },
              h('select', { 'aria-label': '生图渠道', value: channel.id, style: Object.assign({}, full(), { flex: 1, minWidth: '180px' }), onChange: e => { setCfg({ activeImageChannel: e.target.value }); save({ activeImageChannel: e.target.value }) } },
                channels.filter(item => item.provider === backend).map(item => h('option', { key: item.id, value: item.id, style: optStyle }, item.name))),
              h('button', { style: buttonStyle, onClick: () => { const created = defaultChannel(backend); persistChannelSelection(channels.concat(created), backend, created.id) } }, '新增渠道'),
              h('button', { style: buttonStyle, onClick: () => { const created = Object.assign({}, channel, localFields, { id: nextId(backend), name: localFields.name + ' 副本', hasApiKey: false, hasPassword: false }); delete created.apiKey; delete created.password; persistChannelSelection(channels.concat(created), backend, created.id) } }, '复制渠道'),
              h('button', { style: Object.assign({}, buttonStyle, { color: '#f28b8b' }), onClick: () => {
                if (!confirm('删除渠道「' + channel.name + '」？已保存的密钥也会删除。')) return
                const next = channels.filter(item => item.id !== channel.id)
                const fallback = next.find(item => item.provider === backend)
                if (fallback) persistChannelSelection(next, backend, fallback.id)
                else { setChannelSecretDrafts(current => { const drafts = Object.assign({}, current); delete drafts[channel.id]; return drafts }); persistChannelSelection(next, 'comfyui', '') }
              } }, '删除渠道'),
            ),
            field('name', '渠道名称', '例如：个人 API / 公司中转'),
            field('baseUrl', 'API 根地址', 'https://api.example.com/v1'),
            modelInput,
            h('div', { style: { marginBottom: '10px' } }, label('鉴权方式'), h('select', { 'aria-label': '鉴权方式', value: localFields.authMode || 'bearer', style: full(), onChange: e => editChannel({ authMode: e.target.value }) },
              h('option', { value: 'bearer', style: optStyle }, 'Bearer API Key'), h('option', { value: 'none', style: optStyle }, '无需鉴权'), h('option', { value: 'basic', style: optStyle }, 'Basic 用户名 / 密码'))),
            localFields.authMode === 'basic' ? h('div', null,
              field('username', '用户名', '用户名'),
              h('div', { style: { marginBottom: '10px' } }, label('密码', channel.hasPassword ? '已保存；留空保留原密码' : ''),
                h('input', { 'aria-label': '渠道密码', type: 'password', value: channelDraft.password || '', placeholder: channel.hasPassword ? '已保存，留空可保留' : '输入密码', style: full(), onChange: e => { setChannelSecretDrafts(current => Object.assign({}, current, { [channel.id]: Object.assign({}, current[channel.id], { password: e.target.value, clearPassword: false }) })); markSecretEdited(channel.id) } }),
                channel.hasPassword ? h('button', { style: buttonStyle, onClick: () => { setChannelSecretDrafts(current => Object.assign({}, current, { [channel.id]: Object.assign({}, current[channel.id], { clearPassword: true, password: '' }) })); markSecretEdited(channel.id) } }, '清除已保存密码') : null)) : null,
            localFields.authMode !== 'none' && localFields.authMode !== 'basic' ? h('div', { style: { marginBottom: '10px' } },
              label('API Key', channel.hasApiKey ? '已保存；留空保留原 Key' : ''),
              h('input', { 'aria-label': '渠道 API Key', type: 'password', value: channelDraft.apiKey || '', placeholder: channel.hasApiKey ? '已保存，留空可保留' : '粘贴 API Key', style: full(), onChange: e => { setChannelSecretDrafts(current => Object.assign({}, current, { [channel.id]: Object.assign({}, current[channel.id], { apiKey: e.target.value, clearApiKey: false }) })); markSecretEdited(channel.id) } }),
              channel.hasApiKey ? h('button', { style: buttonStyle, onClick: () => { setChannelSecretDrafts(current => Object.assign({}, current, { [channel.id]: Object.assign({}, current[channel.id], { clearApiKey: true, apiKey: '' }) })); markSecretEdited(channel.id) } }, '清除已保存 Key') : null) : null,
            ['novelai', 'sdwebui'].includes(backend) ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '8px' } },
              optionField('steps', '步数', backend === 'novelai' ? '28' : '20', 'number'), optionField('cfg', 'CFG', backend === 'novelai' ? '5' : '7', 'number'), optionField('sampler', '采样器', backend === 'novelai' ? 'k_euler_ancestral' : 'Euler a')) : null,
            backend === 'novelai' ? optionField('noiseSchedule', 'Noise schedule', 'karras') : null,
            backend === 'openai' ? optionField('quality', '质量', 'auto') : null,
            ['openai', 'novelai', 'sdwebui', 'qwen'].includes(backend) ? optionField('size', '尺寸覆盖（可选）', '例如：1024x1536') : null,
            backend === 'seedream' ? optionField('size', '输出尺寸（可选）', '1K、1.5K、2K 或 2048x2048') : null,
            backend === 'gemini' ? optionField('imageSize', '输出分辨率（可选）', '1K、2K 或 4K') : null,
            ['gemini', 'novelai', 'sdwebui', 'qwen'].includes(backend) ? optionField('aspectRatio', '画面比例覆盖（可选）', '例如：2:3') : null,
            generatePathPlaceholder ? optionField('generatePath', '生成接口路径（高级）', generatePathPlaceholder) : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '12px' } },
              h('button', { style: Object.assign({}, buttonStyle, { fontWeight: 600 }), disabled: Boolean(channelTestsInFlight.current[channel.id]), onClick: async () => {
                if (channelTestsInFlight.current[channel.id]) return
                channelTestsInFlight.current[channel.id] = true
                const editRevision = channelDraftRevisions.current[channel.id] || 0
                const secrets = channelSecretDrafts[channel.id] || {}
                const payload = Object.assign({}, localFields, { id: channel.id, provider: backend,
                  ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}), ...(secrets.password ? { password: secrets.password } : {}),
                  ...(secrets.clearApiKey ? { clearApiKey: true } : {}), ...(secrets.clearPassword ? { clearPassword: true } : {}),
                })
                const nextChannels = channels.map(item => item.id === channel.id ? payload : item)
                if (!nextChannels.some(item => item.id === channel.id)) nextChannels.push(payload)
                try {
                  const saved = await save({ imageBackend: backend, activeImageChannel: channel.id, imageChannels: nextChannels })
                  if (!saved) return
                  setChannelSecretDrafts(current => {
                    const latest = current[channel.id] || {}
                    const cleaned = Object.assign({}, latest)
                    if (latest.apiKey === secrets.apiKey) { cleaned.apiKey = ''; delete cleaned.clearApiKey }
                    if (latest.password === secrets.password) { cleaned.password = ''; delete cleaned.clearPassword }
                    return Object.assign({}, current, { [channel.id]: cleaned })
                  })
                  setChannelTestStatuses(current => Object.assign({}, current, { [channel.id]: { checking: true } }))
                  const result = await post('/image-channel-test', { id: channel.id }).catch(error => ({ ok: false, status: 0, message: String(error?.message ?? error) }))
                  if ((channelDraftRevisions.current[channel.id] || 0) === editRevision) setChannelTestStatuses(current => Object.assign({}, current, { [channel.id]: result }))
                  else setChannelTestStatuses(current => { const statuses = Object.assign({}, current); delete statuses[channel.id]; return statuses })
                } finally { delete channelTestsInFlight.current[channel.id] }
              } }, channelTestStatuses[channel.id]?.checking ? '测试中…' : '保存并测试连接'),
              h('span', { role: 'status', 'aria-live': 'polite', style: { fontSize: '12px', color: channelTestStatuses[channel.id]?.status === 'reachable' && channelTestStatuses[channel.id]?.ok ? '#8bd48b' : channelTestStatuses[channel.id]?.status === 'configured' ? '#9aa3b2' : channelTestStatuses[channel.id] ? '#f2686b' : '#9aa3b2' } },
                channelTestStatuses[channel.id]?.checking ? '正在探测渠道…' : channelTestStatuses[channel.id]?.status === 'reachable' && channelTestStatuses[channel.id]?.ok ? ('连接可用' + (channelTestStatuses[channel.id].message ? '：' + channelTestStatuses[channel.id].message : '')) : channelTestStatuses[channel.id]?.status === 'configured' ? ('已配置，尚未验证：' + (channelTestStatuses[channel.id].message || '此服务没有可安全探测的接口。')) : channelTestStatuses[channel.id] ? ('无法连接：' + (channelTestStatuses[channel.id].message || channelTestStatuses[channel.id].error || '检查地址与鉴权')) : (channel.hasApiKey || channel.hasPassword ? '已配置，尚未验证' : '填写地址和鉴权后保存并测试')),
            ),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '8px', lineHeight: 1.55 } },
              backend === 'novelai' ? 'NovelAI 使用 API Key，不需要账户 OAuth 登录；密钥可从官方账户获取。' : backend === 'openai' ? '支持 OpenAI 图片 API 和兼容中转；建议模型 ID 来自服务端模型列表，兼容中转可修改生成路径。' : backend === 'grok' ? 'Grok 当前由服务端模型决定尺寸和比例；插件不会发送尺寸覆盖参数。' : backend === 'qwen' ? '百炼 API 根地址必须匹配账号所在地域和控制台提供的工作空间地址；请从平台控制台复制完整区域端点。' : '可填写服务商或自建中转的完整 API 根地址；测试只检查连接与模型信息，不会付费生成图片。复制渠道会复制参数，但需要重新填写密钥。'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
              h('label', { style: { fontSize: '12px', color: '#b2bdcc' } }, '同时生成', h('input', { 'aria-label': '同时生成', type: 'number', min: 1, max: 4, value: Number(config.imageConcurrency || 2), style: Object.assign({}, S.input, { width: '70px', marginLeft: '8px' }), onChange: e => setCfg({ imageConcurrency: Math.max(1, Math.min(4, Number(e.target.value) || 1)) }) })),
              h('button', { style: buttonStyle, onClick: () => save({ imageConcurrency: Math.max(1, Math.min(4, Number(config.imageConcurrency || 2))) }) }, '保存并发设置'),
              h('span', { style: { fontSize: '11px', color: '#9aa3b2' } }, '1–4 个任务；并发提高速度，也会增加服务端额度消耗。'),
            ),
          ) : h('div', { style: { color: '#9aa3b2', fontSize: '12px' } }, '此提供商还没有渠道。'),
        )
      }


      function planTab() {
        const entries = data.worldbook || []
        const chosen = Array.isArray(config.plannerEntries) ? config.plannerEntries : []
        const active = new Set(chosen.length ? chosen : entries.filter(e => e.index <= 19 || e.index === 142).map(e => e.index))
        return h('div', null,
          ComfyBackendCard(),
          h('div', { style: S.card },
            h('div', { style: S.row },
              h('label', { style: S.row },
                h('input', { type: 'checkbox', checked: config.plannerEnabled !== false, onChange: e => save({ plannerEnabled: e.target.checked }) }),
                h('span', { style: { fontSize: '13px' } }, '每轮自动规划配图（前台只写正文）'),
              ),
            ),
            h('div', { style: S.row },
              h('label', { style: S.row },
                h('input', { type: 'checkbox', checked: config.smartImageSelection !== false, onChange: e => save({ smartImageSelection: e.target.checked }) }),
                h('span', { style: { fontSize: '13px' } }, '智能决定是否配图（不合适时跳过并说明原因）'),
              ),
            ),
            h('div', { style: S.row },
              h('label', { style: S.row },
                h('input', { type: 'checkbox', checked: config.characterAutoUpdate !== false, disabled: Number(config.tavernApi?.apiVersion) < 2, onChange: e => save({ characterAutoUpdate: e.target.checked }) }),
                h('span', { style: { fontSize: '13px', opacity: Number(config.tavernApi?.apiVersion) < 2 ? .65 : 1 } }, Number(config.tavernApi?.apiVersion) < 2 ? '自动记录明确的永久外貌变化（需要 Tavern API v2）' : '自动记录明确的永久外貌变化'),
              ),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, '一轮几张'),
              h('input', { type: 'number', min: 1, max: 8, value: config.plannerCount || 3, style: Object.assign({}, S.input, { width: '78px' }), onChange: e => save({ plannerCount: Number(e.target.value) || 3 }) }),
              h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '本地出图慢，建议 2-3'),
            ),
            h('div', { style: S.row },
              h('span', { style: S.label }, '人物块'),
              h('select', { value: config.traitMode || 'auto', style: S.input, onChange: e => save({ traitMode: e.target.value }) },
                h('option', { value: 'auto', style: { color: '#12161c', background: '#e9eef6' } }, '自动（画面露才带露出版本）'),
                h('option', { value: 'sfw', style: { color: '#12161c', background: '#e9eef6' } }, '只带常规版本'),
                h('option', { value: 'all', style: { color: '#12161c', background: '#e9eef6' } }, '全都带上'),
              ),
            ),
            h(ModelPicker, {
              label: '规划模型', providerKey: 'plannerProvider', modelKey: 'plannerModel', effortKey: 'plannerEffort',
              hint: '不选 = 跟随 Tavern 后台模型',
            }),
            h(ModelPicker, {
              label: '看图模型', providerKey: 'visionProvider', modelKey: 'visionModel', effortKey: 'visionEffort',
              onlyVision: true, hint: '只列支持看图的模型；设计角色读参考图时用它',
            }),
          ),
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', marginBottom: '4px' } },
              (function () {
                const all = data.worldbook || []
                // 自己算，不依赖宿主新加的字段（避免"没重启就显示 0"）
                const on = all.filter(e => e.enabled !== false && String(e.content ?? '').trim()).length
                return '世界书（' + all.length + ' 条，已启用 ' + on + ' 条）'
              })()),
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } },
              '启用的条目会作为「画图规则」发给规划模型。开关和内容都在「世界书」标签页里改。'),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, onClick: () => setTab('worldbook') }, '📖 去世界书里勾选 / 编辑'),
              h('button', { style: buttonStyle, onClick: () => { setTab('worldbook'); setWbImportOpen(true) } }, '📥 导入世界书'),
            ),
          ),
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', marginBottom: '6px' } }, '试规划（贴一段正文，看 agent 产出）'),
            h('textarea', { value: planText, onChange: e => setPlanText(e.target.value), placeholder: '把一段正文贴在这里…', style: Object.assign({}, S.input, { width: '100%', minHeight: '80px', fontFamily: 'inherit' }) }),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, onClick: async () => {
                if (!planText.trim()) { setNote('先贴一段正文'); return }
                setNote('规划中…（要读规则 + 写提示词）')
                setPlanRows(null)
                try {
                  const r = await post('/plan', { messageId: 'panel-' + Date.now(), turn: 0, text: planText, manual: true })
                  setPlanRows(r.plans || [])
                  setNote(r.plans && r.plans.length ? ('规划出 ' + r.plans.length + ' 张，正在画…') : ('没产出：' + (r.error || '模型没按格式返回')))
                } catch (e) { setNote('失败：' + (e && e.message ? e.message : e)) }
              } }, '让 agent 规划'),
            ),
            planRows ? planRows.map((p, i) => h('div', { key: i, style: { marginTop: '8px', fontSize: '12px' } },
              h('div', { style: { fontWeight: 600 } }, (i + 1) + '. ' + (p.title || '(无标题)') + '　' + (p.sizeText || p.size || '')),
              h('div', { style: { color: '#9aa3b2' } }, '插在这句之后：' + (p.mount || '（没给挂载句）')),
              h('div', { style: { color: '#9aa3b2', wordBreak: 'break-all' } }, String(p.prompts || '').slice(0, 260)),
              p.jobId ? h('img', { src: BASE + '/jobs?id=' + encodeURIComponent(p.jobId) + '&image=1', style: { maxWidth: '300px', borderRadius: '8px', marginTop: '6px' } }) : null,
            )) : null,
          ),
        )
      }

      // ---- 人物库（人物设计）----
      function peopleTab() {
        const characters = (data.definitions && data.definitions.characters) || []
        const picked = characters.filter(character => peoplePicked[character.id])
        const search = peopleSearch.trim().toLocaleLowerCase()
        const filteredCharacters = (search
          ? characters.filter(character => [character.name, character.match].some(value => String(value || '').toLocaleLowerCase().includes(search)))
          : characters).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
        const activeCharacter = filteredCharacters.find(character => character.id === peopleActiveId) || filteredCharacters[0] || null
        const activeIndex = activeCharacter ? characters.findIndex(character => character.id === activeCharacter.id) : -1
        const batchFields = [
          ['feature', '角色特征'], ['face', '五官外貌'], ['faceBack', '五官外貌背面'],
          ['bodySFW', '上半身SFW'], ['bodySFWBack', '上半身SFW背面'], ['lowerSFW', '下半身SFW'], ['lowerSFWBack', '下半身SFW背面'],
          ['bodyNSFW', '上半身NSFW'], ['bodyNSFWBack', '上半身NSFW背面'], ['lowerNSFW', '下半身NSFW'], ['lowerNSFWBack', '下半身NSFW背面'],
          ['negative', '负面'], ['match', '英文触发名'], ['continuity', '状态与变化'], ['note', '备注'], ['enabled', '启用状态'], ['cards', '绑定卡片'],
        ]

        function applyBatch() {
          const selected = new Set(picked.map(character => character.id))
          if (!selected.size) { setPeopleBatchNote('请先选择角色'); return }
          if (peopleBatchMode === 'append' && peopleBatchField !== 'enabled' && !peopleBatchValue.trim() && (peopleBatchField !== 'cards' || !peopleBatchCards.length)) {
            setPeopleBatchNote('先填写要追加的内容'); return
          }
          setCharacters(current => current.map(character => {
            if (!selected.has(character.id)) return character
            if (peopleBatchField === 'enabled') return Object.assign({}, character, { enabled: peopleBatchValue !== 'false' })
            if (peopleBatchField === 'cards') return Object.assign({}, character, { cards: peopleBatchMode === 'append' ? [...new Set([...(character.cards || []), ...peopleBatchCards])] : peopleBatchCards.slice() })
            const topLevel = ['match', 'continuity', 'note'].includes(peopleBatchField)
            const previous = String((topLevel ? character[peopleBatchField] : character.traits?.[peopleBatchField]) || '')
            const value = peopleBatchMode === 'append' && previous.trim()
              ? previous + (['continuity', 'note'].includes(peopleBatchField) ? '\n' : ', ') + peopleBatchValue.trim()
              : peopleBatchValue
            return topLevel
              ? Object.assign({}, character, { [peopleBatchField]: value })
              : Object.assign({}, character, { traits: Object.assign({}, character.traits, { [peopleBatchField]: value }) })
          }))
          setPeopleBatchNote('已修改 ' + selected.size + ' 位角色，请点「保存人物库」')
        }

        function batchPanel() {
          if (!peopleBatchOpen) return null
          return h('div', { style: Object.assign({}, S.card, { margin: '8px 0 12px', background: 'rgba(106,168,255,.04)' }) },
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '6px' } }, '选择要批量修改的角色（列表按上方搜索筛选；已选 ' + picked.length + ' 位，包含隐藏角色）'),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, disabled: !filteredCharacters.length, onClick: () => setPeoplePicked(current => Object.assign({}, current, Object.fromEntries(filteredCharacters.map(character => [character.id, true])))) }, '全选当前筛选'),
              h('button', { style: buttonStyle, onClick: () => setPeoplePicked({}) }, '清除选择'),
            ),
            h('div', { style: { maxHeight: '150px', overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: '10px' } },
              filteredCharacters.length ? filteredCharacters.map(character => h('label', { key: character.id, style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px' } },
                h('input', { type: 'checkbox', 'aria-label': '批量选择角色 ' + (character.name || '未命名'), checked: Boolean(peoplePicked[character.id]), onChange: event => { const checked = event.target.checked; setPeoplePicked(current => Object.assign({}, current, { [character.id]: checked })) } }),
                character.name || '（未命名角色）',
              )) : h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '没有匹配的角色')),
            h('div', { style: S.row },
              h('span', { style: S.label }, '批量编辑'),
              h('select', { 'aria-label': '批量编辑字段', value: peopleBatchField, style: S.input, onChange: async event => {
                const field = event.target.value
                setPeopleBatchField(field)
                setPeopleBatchValue(field === 'enabled' ? 'true' : '')
                setPeopleBatchNote('')
                if (field === 'cards') {
                  try { const r = await jsonFetch(BASE + '/cards'); setCardList(r?.cards || []) } catch { setPeopleBatchNote('读取卡片失败，请重新选择「绑定卡片」') }
                }
              } }, batchFields.map(([key, label]) => h('option', { key, value: key }, label))),
              peopleBatchField === 'enabled' ? null : h('select', { 'aria-label': '批量编辑方式', value: peopleBatchMode, style: S.input, onChange: event => setPeopleBatchMode(event.target.value) },
                h('option', { value: 'replace' }, '覆盖'), h('option', { value: 'append' }, '追加')),
              h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '只修改选中的 ' + picked.length + ' 位角色'),
            ),
            peopleBatchField === 'enabled'
              ? h('select', { 'aria-label': '批量启用状态', value: peopleBatchValue === 'false' ? 'false' : 'true', style: S.input, onChange: event => setPeopleBatchValue(event.target.value) }, h('option', { value: 'true' }, '启用'), h('option', { value: 'false' }, '禁用'))
              : peopleBatchField === 'cards'
                ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', maxHeight: '180px', overflowY: 'auto' } },
                  cardList.length ? cardList.map(card => h('label', { key: card.path, style: { fontSize: '12px' } },
                    h('input', { type: 'checkbox', checked: peopleBatchCards.includes(card.path), onChange: event => { const checked = event.target.checked; setPeopleBatchCards(current => checked ? [...new Set([...current, card.path])] : current.filter(path => path !== card.path)) } }), ' ' + card.name))
                    : h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '暂无卡片可选'),
                )
                : h('textarea', { 'aria-label': '批量编辑内容', value: peopleBatchValue, placeholder: '填写要应用到所选角色的内容', rows: 3, style: Object.assign({}, S.input, { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }), onChange: event => setPeopleBatchValue(event.target.value) }),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, disabled: !picked.length, onClick: applyBatch }, '应用到所选角色'),
              h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, peopleBatchField === 'cards' && peopleBatchMode === 'replace' && !peopleBatchCards.length ? '未选卡片时清除绑定，所有卡片都能使用' : peopleBatchMode === 'replace' && peopleBatchField !== 'enabled' ? '覆盖会替换原内容；文本留空会清空该字段' : '应用后点保存即可写入人物库'),
            ),
            peopleBatchNote ? h('div', { role: 'status', style: { fontSize: '12px', color: '#9aa3b2' } }, peopleBatchNote) : null,
          )
        }

        function blankCharacter() {
          const traits = {}
          for (const key of ["feature","face","faceBack","bodySFW","bodySFWBack","lowerSFW","lowerSFWBack","bodyNSFW","bodyNSFWBack","lowerNSFW","lowerNSFWBack","negative"]) traits[key] = ''
          return { id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), name: '', match: '', enabled: true, continuity: '', note: '', inject: {}, cards: [], outfitRefs: [], traits,
            outfits: [{ id: 'o' + Date.now(), name: '常服', upper: '', lower: '', shoes: '', accessory: '', full: '', back: '', negative: '', enabled: true, default: true }] }
        }
        function addCharacter() {
          const person = blankCharacter()
          setCharacters(current => current.concat([person]))
          setPeopleSearch('')
          setPeopleActiveId(person.id)
          setPeopleEditorOpen(true)
        }
        function copyCharacter(person) {
          if (!person) return
          const copy = Object.assign({}, person, {
            id: 'c' + Date.now() + Math.random().toString(36).slice(2, 8),
            name: (person.name || '未命名角色') + '（副本）',
            traits: Object.assign({}, person.traits),
            inject: Object.assign({}, person.inject),
            cards: (person.cards || []).slice(),
            outfitRefs: (person.outfitRefs || []).slice(),
            outfits: (person.outfits || []).map(outfit => Object.assign({}, outfit, { id: 'o' + Date.now() + Math.random().toString(36).slice(2, 8) })),
          })
          setCharacters(current => current.concat([copy]))
          setPeopleSearch('')
          setPeopleActiveId(copy.id)
          setPeopleEditorOpen(true)
        }
        function patchIdentity(index, changes) {
          const person = characters[index]
          if (!person) return
          const next = Object.assign({}, person, changes)
          const query = peopleSearch.trim().toLocaleLowerCase()
          const stillMatches = [next.name, next.match].some(value => String(value || '').toLocaleLowerCase().includes(query))
          setPeopleActiveId(person.id)
          if (query && !stillMatches) setPeopleSearch('')
          patch(index, changes)
        }
        // 注意：peopleTab 是被调用的普通函数，不能用 hooks（会让 SettingsPanel 的 hooks 数不稳定）
        onDesignResult = () => { refresh() }
        function setCharacters(update) {
          const current = dataRef.current
          const before = current?.definitions?.characters || []
          const next = typeof update === 'function' ? update(before) : update
          setLibraryData(Object.assign({}, current, { definitions: Object.assign({}, current.definitions, { characters: next }) }))
          return next
        }
        function patch(index, changes) {
          const id = characters[index]?.id
          setCharacters(current => current.map(person => person.id === id ? Object.assign({}, person, typeof changes === 'function' ? changes(person) : changes) : person))
        }
        function patchTraits(index, key, value) {
          patch(index, person => ({ traits: Object.assign({}, person.traits, { [key]: value }) }))
        }
        function patchOutfit(index, position, changes) {
          const outfitId = characters[index]?.outfits?.[position]?.id
          patch(index, person => ({ outfits: (person.outfits || []).map(outfit => outfit.id === outfitId ? Object.assign({}, outfit, changes) : outfit) }))
        }
        function commit(silent) {
          // 排队写入，并在真正开始时读取最新草稿；并行设计完成不会互相覆盖整库。
          const pending = librarySaveQueue.current.then(async () => {
            const current = dataRef.current
            const revision = libraryRevision.current
            const defs = Object.assign({}, current.definitions, { outfits: current.outfits ?? current.definitions?.outfits ?? [] })
            setSaveState('saving')
            if (!silent) setNote('保存中…')
            reportHost('save-start', { characters: (defs.characters || []).length, outfits: defs.outfits.length })
            try {
              const r = await post('/definitions', { definitions: defs })
              if (!r?.ok || !r.state) throw new Error(r?.error || '服务器没有确认保存')
              reportHost('save-ok', { ok: true })
              if (libraryRevision.current === revision) libraryDirty.current = false
              receiveState(r.state)
              libraryRevision.current += 1
              setSaveState(libraryDirty.current ? '' : 'saved')
              if (!silent) setNote(libraryDirty.current ? '已保存提交的内容；还有新修改，请再保存' : '人物库已保存')
              return true
            } catch (e) {
              const msg = e && e.message ? e.message : String(e)
              reportHost('save-failed', { message: msg.slice(0, 200) })
              if (typeof showToast === 'function') showToast('写入角色库失败：' + msg.slice(0, 60), 'fail')
              setNote('保存失败：' + msg)
              setSaveState('failed:' + msg.slice(0, 60))
              return false
            }
          })
          librarySaveQueue.current = pending.then(() => undefined, () => undefined)
          return pending
        }

        function mergeDesign(original, designed, current) {
          const next = Object.assign({}, current)
          for (const key of ['name', 'match', 'note']) {
            if (current[key] === original[key] && designed[key]) next[key] = designed[key]
          }
          next.traits = Object.assign({}, current.traits)
          for (const [key, value] of Object.entries(designed.traits || {})) {
            if (current.traits?.[key] === original.traits?.[key]) next.traits[key] = value
          }
          if ((designed.outfits || []).length && JSON.stringify(current.outfits) === JSON.stringify(original.outfits)) {
            next.outfits = designed.outfits.map(outfit => Object.assign({ id: 'o' + Date.now() + Math.random().toString(36).slice(2, 6), enabled: true, default: false }, outfit))
          }
          return next
        }

        /** 让 agent 按「角色与服装设计规范」产出人物（可以顺带读当前卡片的设定）。 */
        async function designPeople() {
          // 展开内联的设计面板（不再弹浮层）
          setDesignOpen(true)
          setDesignNote('')
          setDesignDone('')
          setImproveTarget('')
          return
        }

        /** 直接改进某个角色：不开面板，拿当前这条输入框的要求跑一次改进 */
        async function sendImprove(index) {
          const person = characters[index]
          if (!person) return
          const id = person.id
          const draft = String(improveDraft[id] || '')
          const ask = draft.trim()
          if (!ask) { setDesignNote('先写要改什么'); return }
          // 不锁：生成完一个可以接着生成下一个（同一条防重复点）
          if (improveInFlight.current[id]) return
          improveInFlight.current[id] = true
          setDesignBusy(true)
          setDesignNote('正在改进「' + (person.name || '未命名') + '」…')
          reportHost('improve-click', { index, name: String(person.name || ''), via: 'inline' })
          try {
            const payload = { brief: ask, sessionId: String(lastSessionId || ''), current: person }
            const r = await post('/design', payload)
            if (!r?.ok) { setDesignNote('改进失败：' + (r?.error || '')); return }
            const people = r.people || []
            if (!people.length) { setDesignNote('没产出人物。模型原文：' + String(r.raw || '').slice(0, 140)); return }
            const current = dataRef.current?.definitions?.characters || []
            if (!current.some(character => character.id === id)) { setDesignNote('角色已删除，已忽略改进结果'); return }
            const next = setCharacters(current.map(character => character.id === id ? mergeDesign(person, people[0], character) : character))
            setImproveDraft(drafts => drafts[id] === draft ? Object.assign({}, drafts, { [id]: '' }) : drafts)
            setDesignDone('')
            const saved = await commit(true)
            if (saved && typeof showToast === 'function') showToast('已改进「' + next.find(character => character.id === id).name + '」，并写入角色库')
            setDesignNote(saved ? '' : '改进结果已保留，请点「保存人物库」重试保存')
          } catch (error) {
            setDesignNote('改进失败：' + (error?.message ?? error))
          } finally {
            delete improveInFlight.current[id]
            setDesignBusy(Object.keys(improveInFlight.current).length > 0)
          }
        }

        /** 内联的设计面板：需求 + 参考图 + 确定生成 */
        function designPanel() {
          if (!designOpen) return null
          function pickDesignFile(event) {
            const file = event?.target?.files && event.target.files[0]
            if (!file) return
            if (file.size > 12 * 1024 * 1024) { setDesignNote('图片太大了（上限 12MB）'); return }
            const reader = new FileReader()
            reader.onload = () => {
              const result = String(reader.result || '')
              setDesignPhoto(result.includes(',') ? result.split(',')[1] : result)
              setDesignPreview(result)
              setDesignName(file.name)
              setDesignNote('')
            }
            reader.onerror = () => setDesignNote('读图失败')
            reader.readAsDataURL(file)
          }
          async function runDesign() {
            if (designInFlight.current) return
            const brief = String(designBrief || '').trim()
            if (!brief) { setDesignNote('先说说想要什么角色或服装'); return }
            const target = characters.find(character => character.id === improveTarget)
            designInFlight.current = true
            setDesignPanelBusy(true)
            setDesignNote('设计需要十几秒，请稍等…')
            try {
              const payload = { brief, sessionId: String(lastSessionId || '') }
              reportHost('improve-run', { improveTarget, hasChar: Boolean(target) })
              if (target) payload.current = target
              if (designPhoto) { payload.data = designPhoto; payload.mediaType = 'image/png'; payload.name = designName || 'ref.png' }
              const r = await post('/design', payload)
              if (!r?.ok) { setDesignNote('设计失败：' + (r?.error || '')); return }
              const people = r.people || []
              if (!people.length) { setDesignNote('没产出人物。模型原文：' + String(r.raw || '').slice(0, 160)); return }
              const next = (dataRef.current?.definitions?.characters || []).slice()
              // 改进模式：原地替换那个角色；新建模式：追加
              if (target) {
                const index = next.findIndex(character => character.id === target.id)
                if (index < 0) { setDesignNote('角色已删除，已忽略改进结果'); return }
                next[index] = mergeDesign(target, people[0], next[index])
                setCharacters(next)
                setDesignDone('')
                const saved = await commit(true)
                if (saved && typeof showToast === 'function') showToast('已改进「' + next[index].name + '」，并写入角色库')
                setDesignNote(saved ? '改进完成，已保存' : '改进结果已保留，请点「保存人物库」重试保存')
                // 面板保持打开
                setDesignBrief(current => current === designBrief ? '' : current)
                setDesignPhoto(current => current === designPhoto ? '' : current)
                setDesignPreview(current => current === designPreview ? '' : current)
                setDesignName(current => current === designName ? '' : current)
                setImproveTarget(current => current === improveTarget ? '' : current)
                return
              }
              for (const person of people) {
                next.push({
                  id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
                  name: person.name || '未命名', match: person.match || '', enabled: true,
                  continuity: '', note: person.note || '', inject: {}, cards: [], outfitRefs: [],
                  traits: Object.assign({ feature: '', face: '', faceBack: '', bodySFW: '', bodySFWBack: '', lowerSFW: '', lowerSFWBack: '', bodyNSFW: '', bodyNSFWBack: '', lowerNSFW: '', lowerNSFWBack: '', negative: '' }, person.traits || {}),
                  outfits: (person.outfits || []).map(o => Object.assign({ id: 'o' + Date.now() + Math.random().toString(36).slice(2, 6), enabled: true, default: false }, o)),
                })
              }
              setCharacters(next)
              setPeopleSearch('')
              setPeopleActiveId(next[next.length - people.length]?.id || '')
              setPeopleEditorOpen(true)
              setDesignDone('')
              const saved = await commit(true)
              if (saved && typeof showToast === 'function') showToast('已生成 ' + people.length + ' 个角色，并写入角色库')
              setDesignNote(saved ? '已生成 ' + people.length + ' 位角色并保存' : '生成结果已保留，请点「保存人物库」重试保存')
              // 面板保持打开，让「保存人物库」提醒可见
              setDesignBrief(current => current === designBrief ? '' : current)
              setDesignPhoto(current => current === designPhoto ? '' : current)
              setDesignPreview(current => current === designPreview ? '' : current)
              setDesignName(current => current === designName ? '' : current)
            } catch (error) {
              setDesignNote('失败：' + (error?.message ?? error))
            } finally {
              designInFlight.current = false
              setDesignPanelBusy(false)
            }
          }
          const area = { width: '100%', minHeight: '96px', boxSizing: 'border-box', background: '#11141a', color: '#dbe3ee', border: '1px solid rgba(200,140,60,.55)', borderRadius: '12px', padding: '12px 14px', fontSize: '13px', lineHeight: '1.6', fontFamily: 'inherit', resize: 'vertical' }
          return h('div', { style: { margin: '10px 0 4px', padding: '16px', borderRadius: '12px', background: 'linear-gradient(180deg,#1b2029,#161a21)', border: '1px solid rgba(230,160,60,.4)' } },
            h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } },
              characters.find(character => character.id === improveTarget)
                ? ('✏️ 改进「' + (characters.find(character => character.id === improveTarget).name || '未命名') + '」')
                : '🎨 输入生成需求'),
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } }, '请描述您希望生成的角色或服装的具体需求'),
            h('textarea', { value: designBrief, placeholder: '例如：生成一个穿着古风汉服的少女角色，温柔可爱…', style: area, onChange: e => setDesignBrief(e.target.value) }),
            h('div', { style: { marginTop: '12px', padding: '12px', borderRadius: '10px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.18)' } },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '📎 参考图片（可选）'),
                h('label', { style: { padding: '6px 14px', fontSize: '12px', borderRadius: '8px', border: '1px solid rgba(230,160,60,.6)', color: '#f0b45c', cursor: 'pointer', background: 'rgba(240,166,60,.08)' } },
                  '＋ 添加图片',
                  h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: pickDesignFile }),
                ),
              ),
              designPreview ? h('img', { src: designPreview, style: { display: 'block', maxWidth: '140px', borderRadius: '10px', margin: '10px auto 0' } }) : h('div', { style: { textAlign: 'center', fontSize: '12px', color: '#9aa3b2', marginTop: '10px' } }, '点击上方按钮添加参考图片'),
            ),
            designNote ? h('div', { style: { fontSize: '12px', color: /失败|太大|没产出/.test(designNote) ? '#f2686b' : '#9aa3b2', marginTop: '10px' } }, designNote) : null,
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '14px' } },
              h('button', { style: buttonStyle, onClick: () => { setDesignOpen(false); setDesignNote(''); setDesignDone(''); setImproveTarget('') } }, '收起'),
              h('button', { disabled: designPanelBusy, style: Object.assign({}, buttonStyle, { borderColor: 'rgba(230,160,60,.7)', background: 'rgba(240,166,60,.15)', color: '#f0b45c' }), onClick: runDesign }, designPanelBusy ? '正在生成…' : '确定生成'),
            ),
          )
        }

        /** 选一张本地图片，交给模型拆成各个可见块。 */
        function pickPhoto(person) {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = 'image/png,image/jpeg,image/webp,image/gif'
          input.onchange = () => {
            const file = input.files && input.files[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = async () => {
              setNote('正在看图…（要几十秒）')
              try {
                const r = await post('/vision', {
                  data: String(reader.result),
                  mediaType: file.type,
                  name: file.name,
                })
                if (!r.traits) { setNote('模型没按格式返回，原文：' + String(r.raw || '').slice(0, 200)); return }
                const current = dataRef.current?.definitions?.characters || []
                if (!current.some(character => character.id === person.id)) { setNote('角色已删除，已忽略识图结果'); return }
                const traits = Object.assign({}, r.traits, { lowerSFW: r.traits.fullSFW || r.traits.lowerSFW, lowerNSFW: r.traits.fullNSFW || r.traits.lowerNSFW })
                for (const key of Object.keys(traits)) if (!traits[key]) delete traits[key]
                setCharacters(current.map(character => character.id === person.id ? mergeDesign(person, { traits }, character) : character))
                setNote('已按照片填好各块（' + (r.size || '') + '），核对一下再保存')
              } catch (e) {
                setNote('看图失败：' + (e && e.message ? e.message : e))
              }
            }
            reader.readAsDataURL(file)
          }
          input.click()
        }

        function area(label, why, value, onChange, rows) {
          return h('div', { style: { margin: '6px 0' } },
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '2px' } }, label + (why ? '　' + why : '')),
            h('textarea', { value: value || '', onChange: e => onChange(e.target.value),
              style: Object.assign({}, S.input, { width: '100%', minHeight: ((rows || 2) * 20) + 'px', fontFamily: 'inherit', lineHeight: '1.5' }) }),
          )
        }

        function characterBlock(c, i) {
          const traits = c.traits || {}
          const outfits = c.outfits || []
          const filled = ["feature","face","faceBack","bodySFW","bodySFWBack","lowerSFW","lowerSFWBack","bodyNSFW","bodyNSFWBack","lowerNSFW","lowerNSFWBack","negative"].filter(k => String(traits[k] || '').trim()).length
          const title = (c.name || '（未命名角色）') + '　' + filled + '/12 块　' + (outfits.length ? outfits.length + ' 套服装' : '没有服装')
          const grouped = (list) => list.map(([key, label, why, rows, folded]) => area(label, why, traits[key], v => patchTraits(i, key, v), rows))
          return h('details', { key: c.id, open: peopleEditorOpen, onToggle: event => {
            const open = event.currentTarget.open
            setPeopleEditorOpen(current => current === open ? current : open)
          }, style: { border: '1px solid #3a4150', borderRadius: '10px', padding: '10px 12px', margin: '8px 0' } },
            h('summary', { style: { cursor: 'pointer', fontSize: '13px', fontWeight: 600 } }, title),
            h('div', { style: S.row },
              h('input', { type: 'text', placeholder: '角色名', value: c.name || '', style: Object.assign({}, S.input, { width: '140px' }), onChange: e => patchIdentity(i, { name: e.target.value }) }),
              h('input', { type: 'text', placeholder: '英文名（逗号分隔，用来触发）', value: c.match || '', style: Object.assign({}, S.input, { flex: 1, minWidth: '180px' }), onChange: e => patchIdentity(i, { match: e.target.value }) }),
              h('label', { style: S.row }, h('input', { type: 'checkbox', checked: c.enabled !== false, onChange: e => patch(i, { enabled: e.target.checked }) }), h('span', { style: { fontSize: '12px' } }, '启用')),
              h('button', { style: buttonStyle, onClick: () => { if (!confirm('删掉「' + (c.name || '未命名') + '」？')) return; setCharacters(current => current.filter(character => character.id !== c.id)) } }, '删除角色'),
            ),
            // 常驻的改进行：直接写要求 → 点改进，不用先展开面板
            h('div', { style: S.row },
              h('span', { style: S.label }, '改这个角色'),
              h('input', {
                type: 'text',
                placeholder: '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点',
                value: improveDraft[c.id] || '',
                style: Object.assign({}, S.input, { flex: 1, minWidth: '220px' }),
                onChange: e => { const value = e.target.value; setImproveDraft(current => Object.assign({}, current, { [c.id]: value })) },
                onKeyDown: e => { if (e.key === 'Enter' && (improveDraft[c.id] || '').trim()) sendImprove(i) },
              }),
              h('button', { style: buttonStyle, disabled: designBusy && Boolean(improveInFlight.current[c.id]), onClick: () => sendImprove(i) }, improveInFlight.current[c.id] ? '正在改进…' : '✏️ 改进'),
            ),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '-4px' } }, '直接写要求点改进即可（回车也行），不用先打开面板'),

            h('div', { style: S.row },
              h('span', { style: S.label }, '绑定卡片'),
              h('button', {
                style: Object.assign({}, buttonStyle, { flex: 1, minWidth: '200px', textAlign: 'left' }),
                onClick: async () => {
                  const open = cardPickerFor === c.id
                  setCardPickerFor(open ? -1 : c.id)
                  if (open) return
                  try {
                    const r = await jsonFetch(BASE + '/cards', { cache: 'no-store' })
                    setCardList(r?.cards ?? [])
                  } catch { setCardList([]) }
                },
              }, (c.cards || []).length ? ('已绑定 ' + (c.cards || []).length + ' 张：' + (c.cards || []).map(p => String(p).replace(/^cards\//, '').replace(/\.json$/, '')).join('、').slice(0, 26) + '（点击修改）') : '点这里选择要绑定的卡片（不选 = 所有卡都能用）'),
            ),
            cardPickerFor === c.id ? h('div', { style: { marginTop: '8px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.2)' } },
              h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } }, '勾选要绑定的卡片（可多选）'),
              h('div', { style: { maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } },
                cardList.length
                  ? cardList.map(item => h('label', {
                      key: item.path,
                      style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', borderRadius: '8px', cursor: 'pointer', background: (c.cards || []).includes(item.path) ? 'rgba(106,168,255,.14)' : 'transparent' },
                    },
                      h('input', {
                        type: 'checkbox',
                        checked: (c.cards || []).includes(item.path),
                        onChange: (e) => {
                          const set = new Set(c.cards || [])
                          if (e.target.checked) set.add(item.path); else set.delete(item.path)
                          patch(i, { cards: [...set] })
                        },
                      }),
                      h('span', { style: { fontSize: '13px' } }, item.name),
                    ))
                  : h('div', { style: { fontSize: '12px', color: '#9aa3b2', padding: '8px' } }, '没读到卡片（检查设置页顶部的 ComfyUI 状态）'),
              ),
              h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
                h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: () => patch(i, { cards: [] }) }, '清空'),
                h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: () => setCardPickerFor(-1) }, '收起'),
              ),
            ) : null,
            (data.outfits || []).length ? h('div', { style: S.row },
              h('span', { style: S.label }, '可穿通用'),
              (data.outfits || []).map(o => h('label', { key: o.id, style: { fontSize: '12px', marginRight: '10px' } },
                h('input', { type: 'checkbox', checked: (c.outfitRefs || []).includes(o.id), onChange: e => {
                  const refs = new Set(c.outfitRefs || [])
                  if (e.target.checked) refs.add(o.id); else refs.delete(o.id)
                  patch(i, { outfitRefs: [...refs] })
                } }),
                ' ' + (o.name || o.id),
              )),
            ) : null,
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '10px' } }, '外貌（正面与背面互斥：背面不放眼睛/胸部；SFW 块不放裸露词，否则衣服画不出来）'),
            grouped([["feature","角色特征","气质属性，只写与绘图有关的（innocent / seductive / cold / gentle）",2,false],["face","五官外貌","【正面】发型、发色、瞳色、脸型、肤色、年龄段 —— 不写表情",3,false],["faceBack","五官外貌背面","【背面】发型背面、后脑勺、脖子后面、耳背 —— 不能写眼睛鼻子嘴巴",2,true]]),
            h('details', { style: { marginTop: '4px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: '#9aa3b2' } }, '穿衣身体块（上半身 / 下半身，正背面）'),
              grouped([["bodySFW","上半身SFW","穿衣可见的上半身正面：体型、胸部轮廓、肩宽 —— 禁裸露词",2,false],["bodySFWBack","上半身SFW背面","穿衣可见的背面：肩膀轮廓、腰部线条 —— 不写胸部",2,true],["lowerSFW","下半身SFW","穿衣可见的下半身正面：腿型 —— 禁裸露词",2,true],["lowerSFWBack","下半身SFW背面","臀部轮廓、腿部背面",2,true]]),
            ),
            h('details', { style: { marginTop: '4px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: '#9aa3b2' } }, '赤裸身体块（只在 NSFW 画面用）'),
              grouped([["bodyNSFW","上半身NSFW","赤裸才可见：胸部详细、乳头、正面纹身伤疤",2,true],["bodyNSFWBack","上半身NSFW背面","bare back、背部线条、肩胛骨 —— 不写胸和乳头",2,true],["lowerNSFW","下半身NSFW","赤裸才可见：生殖器官、正面纹身痣",2,true],["lowerNSFWBack","下半身NSFW背面","臀部详细、肛门 —— 不写正面生殖器",2,true]]),
            ),
            h('details', { style: { marginTop: '4px' } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: '#9aa3b2' } }, '负面 / 状态'),
              grouped([["negative","负面","这张脸/身体不该出现的特征（进负向提示词）",2,true]]),
              area('状态与变化', '随剧情改，默认不注入', c.continuity, v => patch(i, { continuity: v }), 2),
            ),
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '12px', fontWeight: 600 } }, '服装库'),
            outfits.map((o, j) => h('div', { key: o.id || j, style: { borderTop: '1px solid #3a4150', marginTop: '8px', paddingTop: '6px' } },
              h('div', { style: S.row },
                h('input', { type: 'text', placeholder: '服装名（常服 / 居家 / 内衣…）', value: o.name || '', style: Object.assign({}, S.input, { width: '170px' }), onChange: e => patchOutfit(i, j, { name: e.target.value }) }),
                h('label', { style: S.row }, h('input', { type: 'radio', name: 'default-outfit-' + i, checked: o.default === true, onChange: () => patch(i, { outfits: outfits.map((x, k) => Object.assign({}, x, { default: k === j })) }) }), h('span', { style: { fontSize: '12px' } }, '常穿')),
                h('label', { style: S.row }, h('input', { type: 'checkbox', checked: o.enabled !== false, onChange: e => patchOutfit(i, j, { enabled: e.target.checked }) }), h('span', { style: { fontSize: '12px' } }, '启用')),
                h('button', { style: buttonStyle, onClick: () => { const next = outfits.slice(); next.splice(j, 1); patch(i, { outfits: next }) } }, '删'),
              ),
              area('上衣', '', o.upper, v => patchOutfit(i, j, { upper: v }), 2),
              area('下装', '', o.lower, v => patchOutfit(i, j, { lower: v }), 2),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
                h('input', { type: 'text', placeholder: '鞋袜', value: o.shoes || '', style: S.input, onChange: e => patchOutfit(i, j, { shoes: e.target.value }) }),
                h('input', { type: 'text', placeholder: '配饰', value: o.accessory || '', style: S.input, onChange: e => patchOutfit(i, j, { accessory: e.target.value }) }),
                h('input', { type: 'text', placeholder: '整体印象（formal / casual…）', value: o.full || '', style: S.input, onChange: e => patchOutfit(i, j, { full: e.target.value }) }),
                h('input', { type: 'text', placeholder: '背面细节', value: o.back || '', style: S.input, onChange: e => patchOutfit(i, j, { back: e.target.value }) }),
              ),
              area('负面', '', o.negative, v => patchOutfit(i, j, { negative: v }), 2),
            )),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, onClick: () => patch(i, { outfits: outfits.concat([{ id: 'o' + Date.now(), name: '新服装', upper: '', lower: '', shoes: '', accessory: '', full: '', back: '', negative: '', enabled: true, default: outfits.length === 0 }]) }) }, '新增服装'),
            ),
          )
        }
        return h('div', null,
          // 设计完成的提醒：放在 tab 顶部，面板关着也看得见
          designDone ? h('div', { style: { margin: '0 0 10px', padding: '14px 16px', borderRadius: '12px', background: 'linear-gradient(180deg,rgba(240,166,60,.22),rgba(240,166,60,.12))', border: '1px solid rgba(240,166,60,.65)', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '14px', color: saveState.startsWith('failed') ? '#f2686b' : '#f5c078', fontWeight: 600, flex: 1, minWidth: '180px' } },
              saveState === 'saving' ? '⏳ 正在保存…'
                : saveState === 'saved' ? '💾 已保存到 definitions.json'
                : saveState.startsWith('failed') ? ('❌ 保存失败：' + saveState.slice(7))
                : ('✅ ' + designDone)),
            h('button', { style: Object.assign({}, buttonStyle, { borderColor: 'rgba(240,166,60,.8)', background: 'linear-gradient(180deg,#f0a63c,#e0861f)', color: '#1a1206', fontWeight: 600, padding: '8px 22px', fontSize: '14px' }), onClick: () => { commit(true).then(saved => { if (saved) setDesignDone('') }) } }, '💾 保存人物库'),
            h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: () => setDesignDone('') }, '知道了'),
        ) : null,
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '人物设计（' + characters.length + ' 个角色）'),
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } }, '填了名字 + 五官 + 体态的角色，会作为「可用角色清单」交给规划模型；正文里出现这个名字时，这些内容会自动补齐，所以不会换脸。'),
          h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
            h('input', { type: 'search', 'aria-label': '搜索角色', value: peopleSearch, placeholder: '搜索中文名或英文触发名', style: Object.assign({}, S.input, { flex: '1 1 220px', minWidth: '180px' }), onChange: event => setPeopleSearch(event.target.value) }),
            h('select', { 'aria-label': '当前角色', value: activeCharacter?.id || '', style: Object.assign({}, S.input, { flex: '1 1 220px', minWidth: '180px' }), onChange: event => { setPeopleActiveId(event.target.value); setPeopleEditorOpen(true) } },
              activeCharacter ? filteredCharacters.map(character => h('option', { key: character.id, value: character.id, style: { color: 'CanvasText', backgroundColor: 'Canvas' } }, (character.name || '（未命名角色）') + (character.match ? ' · ' + character.match : ''))) : h('option', { value: '', style: { color: 'CanvasText', backgroundColor: 'Canvas' } }, '没有匹配的角色'),
            ),
            h('button', { style: buttonStyle, onClick: () => setPeopleEditorOpen(open => !open) }, peopleEditorOpen ? '收起编辑' : '展开编辑'),
          ),
          h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
            h('button', { style: buttonStyle, onClick: addCharacter }, '新增角色'),
            h('button', { style: buttonStyle, disabled: !activeCharacter, onClick: () => copyCharacter(activeCharacter) }, '复制当前角色'),
            h('button', { style: buttonStyle, disabled: !activeCharacter, onClick: () => activeCharacter && pickPhoto(activeCharacter) }, '从照片识别'),
            h('button', { style: buttonStyle, onClick: designPeople }, '让 agent 设计角色'),
            h('button', { style: buttonStyle, disabled: saveState === 'saving', onClick: () => commit(false) }, saveState === 'saving' ? '正在保存…' : '保存人物库'),
            h('button', { style: buttonStyle, onClick: () => setPeopleBatchOpen(current => !current) }, peopleBatchOpen ? '收起批量编辑' : '批量编辑'),
            h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, '已选 ' + picked.length + ' / ' + characters.length + ' 位'),
          ),
          designPanel(),
          batchPanel(),
          !designOpen && designNote ? h('div', { role: 'status', style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } }, designNote) : null,
          characters.length && !activeCharacter ? h('div', { role: 'status', style: { fontSize: '12px', color: '#9aa3b2', padding: '10px 0' } }, '没有匹配的角色，请调整搜索词。') : null,
          !characters.length ? h('div', { style: { fontSize: '12px', color: '#9aa3b2' } }, '还没有角色，点上方「新增角色」。') : null,
          activeCharacter ? characterBlock(activeCharacter, activeIndex) : null,
          h('div', { style: S.row },
            h('span', { role: 'status', style: { fontSize: '12px', color: saveState.startsWith('failed') ? '#f2686b' : '#9aa3b2' } }, saveState.startsWith('failed') ? '保存失败，请重试' : libraryDirty.current ? '有未保存修改' : saveState === 'saved' ? '人物库已保存' : '改完记得点保存'),
          ),
          ),
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '通用服装库（可跨角色复用）'),
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } }, '这里放"办公室职业装""居家睡衣"这类通用套装；在角色那边勾上，他就能穿。'),
            (data.outfits || []).map((o, j) => h('div', { key: o.id || j, style: { borderTop: '1px solid #3a4150', marginTop: '8px', paddingTop: '6px' } },
              h('div', { style: S.row },
                h('input', { type: 'text', placeholder: '套装名', value: o.name || '', style: Object.assign({}, S.input, { width: '190px' }), onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { name: e.target.value }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }),
                h('label', { style: S.row }, h('input', { type: 'checkbox', checked: o.enabled !== false, onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { enabled: e.target.checked }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }), h('span', { style: { fontSize: '12px' } }, '启用')),
                h('button', { style: buttonStyle, onClick: () => { const next = (data.outfits || []).slice(); next.splice(j, 1); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }, '删除'),
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '6px' } },
                h('input', { type: 'text', placeholder: '上衣', value: o.upper || o.body || '', style: S.input, onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { upper: e.target.value }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }),
                h('input', { type: 'text', placeholder: '下装', value: o.lower || '', style: S.input, onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { lower: e.target.value }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }),
                h('input', { type: 'text', placeholder: '鞋袜', value: o.shoes || '', style: S.input, onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { shoes: e.target.value }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }),
                h('input', { type: 'text', placeholder: '整体', value: o.full || '', style: S.input, onChange: e => { const next = (data.outfits || []).slice(); next[j] = Object.assign({}, o, { full: e.target.value }); setLibraryData(Object.assign({}, dataRef.current, { outfits: next })) } }),
              ),
            )),
            h('div', { style: S.row },
              h('button', { style: buttonStyle, onClick: () => setLibraryData(Object.assign({}, dataRef.current, { outfits: (data.outfits || []).concat([{ id: 'of' + Date.now(), name: '新套装', upper: '', lower: '', shoes: '', accessory: '', full: '', back: '', negative: '', enabled: true }]) })) }, '新增套装'),
              h('button', { style: buttonStyle, onClick: () => commit() }, '保存服装库'),
            ),
          ),
        )
      }
      /** 批量删除历史图。 */
      async function deleteJobBatch(ids) {
        const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
        if (!list.length) { if (typeof showToast === 'function') showToast('没有选中任何图', 'fail'); return }
        if (!confirm('删除选中的 ' + list.length + ' 张图？缓存文件也会一起删掉。')) return
        let ok = 0
        for (const id of list) {
          try {
            const r = await post('/delete-job', { jobId: String(id) })
            if (r?.ok) ok++
          } catch {}
        }
        const gone = new Set(list)
        setHistoryJobs(cur => (cur || []).filter(j => !gone.has(String(j.id))))
        setGalleryPicked({})
        if (typeof showToast === 'function') showToast('已删除 ' + ok + ' / ' + list.length + ' 张' + (ok === list.length ? '' : '（有些没删掉）'), ok === list.length ? 'ok' : 'fail')
      }

      /** 删除一张历史图（连带缓存文件与计划里的引用）。 */
      async function deleteJob(jobId) {
        if (!jobId) return
        if (!confirm('删除这张图？缓存文件也会一起删掉。')) return
        try {
          const r = await post('/delete-job', { jobId: String(jobId) })
          if (!r?.ok) { if (typeof showToast === 'function') showToast('删除失败：' + (r?.error || ''), 'fail'); return }
          setHistoryJobs(list => (list || []).filter(j => String(j.id) !== String(jobId)))
          if (typeof showToast === 'function') showToast('已删除')
        } catch (error) {
          if (typeof showToast === 'function') showToast('删除失败：' + (error?.message ?? error), 'fail')
        }
      }

      /** 工作流：导入、查看、LoRA 管理。 */
      function workflowCard() {
        const list = data.workflows || []
        const simple = Object.assign({ template: 'checkpoint', checkpoint: '', unet: '', clip1: '', clip2: '', vae: '', loras: [], steps: 24, cfg: 7, sampler: 'euler', scheduler: 'normal', width: 832, height: 1216, seed: '' }, config.comfySimple || {})
        function updateSimple(patch) {
          const next = Object.assign({}, simpleDraft || simple, patch)
          if (patch.template === 'flux' && simpleInfo) {
            if (!simpleInfo.fluxUnets?.includes(next.unet)) next.unet = simpleInfo.fluxUnets?.[0] || ''
            next.clip1 = next.clip1 || simpleInfo.dualClips1?.find(name => /t5/i.test(name)) || ''
            next.clip2 = next.clip2 || simpleInfo.dualClips2?.find(name => /clip[_ -]?l/i.test(name)) || ''
            if (!next.vae) next.vae = simpleInfo.vaes?.find(name => /(?:^|[\\/])ae(?:[._-]|$)/i.test(name)) || ''
          }
          if (patch.template === 'anima' && simpleInfo) {
            if (!simpleInfo.animaUnets?.includes(next.unet)) next.unet = simpleInfo.animaUnets?.[0] || ''
            next.clip1 = next.clip1 || simpleInfo.clips?.find(name => /qwen/i.test(name)) || ''
            if (!next.vae) next.vae = simpleInfo.vaes?.find(name => /qwen[_ -]?image[_ -]?vae/i.test(name)) || ''
          }
          setSimpleConfigDraft(next)
        }
        async function refreshSimpleInfo() {
          setSimpleLoading(true); setSimpleNote('正在读取 ComfyUI 节点和模型列表…')
          try {
            const info = await post('/comfy-simple-info', {})
            if (!info?.ok) throw new Error(info?.error || 'ComfyUI 没有返回节点信息')
            setSimpleInfo(info)
            const draft = simpleConfigDraft || simple
            const next = Object.assign({}, draft)
            if (!next.checkpoint && info.checkpoints?.length) next.checkpoint = info.checkpoints[0]
            if (draft.template === 'anima') {
              if (!info.animaUnets?.includes(next.unet)) next.unet = info.animaUnets?.[0] || ''
            } else if (draft.template === 'flux') {
              if (!info.fluxUnets?.includes(next.unet)) next.unet = info.fluxUnets?.[0] || ''
            } else if (!next.unet && info.unets?.length) next.unet = info.unets[0]
            if (!next.clip1 && draft.template === 'flux') next.clip1 = info.dualClips1?.find(name => /t5/i.test(name)) || ''
            if (!next.clip2 && draft.template === 'flux') next.clip2 = info.dualClips2?.find(name => /clip[_ -]?l/i.test(name)) || ''
            if (!next.clip1 && draft.template === 'anima') next.clip1 = info.clips?.find(name => /qwen/i.test(name)) || ''
            if (!next.vae && draft.template === 'flux') next.vae = info.vaes?.find(name => /(?:^|[\\/])ae(?:[._-]|$)/i.test(name)) || ''
            if (!next.vae && draft.template === 'anima') next.vae = info.vaes?.find(name => /qwen[_ -]?image[_ -]?vae/i.test(name)) || ''
            setSimpleConfigDraft(next); setSimpleNote('已读取；模型列表来自当前 ComfyUI')
            setLoraList(Array.isArray(info.loras) ? info.loras : [])
          } catch (e) { setSimpleNote('读取失败：' + (e?.message ?? e)) }
          finally { setSimpleLoading(false) }
        }
        const simpleDraft = simpleConfigDraft || simple
        const setTemplate = value => { updateSimple({ template: value }); save({ comfyMode: 'simple', comfySimple: Object.assign({}, simpleDraft, { template: value }) }) }
        const simpleSupport = simpleInfo?.templates?.[simpleDraft.template]
        const options = (values, value, onChange, placeholder) => h('select', { value: value || '', style: Object.assign({}, S.input, { minWidth: '180px', flex: 1 }), onChange: e => onChange(e.target.value) },
          !values?.length ? h('option', { value: '' }, placeholder || '先刷新模型列表') : null,
          (values || []).map(item => h('option', { key: item, value: item }, item)))
        // 判定"读到的详情是不是当前这张"：file 或 id 任一匹配即可（file 由前端补进来）
        const detail = (wfDetail && (String(wfDetail.file ?? '') === String(wfOpen) || String(wfDetail.__id ?? '') === String(wfOpen))) ? wfDetail : null

        async function openWorkflow(file, force = false) {
          if (!force && wfOpen === file) { setWfOpen(''); setWfDetail(null); return }
          setWfOpen(file); setWfDetail(null); setWfNote('读取中…')
          try {
            const r = await post('/workflow-bindings', { file })
            if (!r?.ok) { setWfNote('读失败：' + (r?.error || '')); return }
            // 工作流对象本身没有 file 字段，判定"读的是哪张"要靠它，补进来
            setWfDetail(Object.assign({}, r.workflow, { file }))
            setWfNote('')
            // 读出这张工作流的可编辑参数（失败要把原因显示出来，不能静默）
            const baseName = String(file).split(/[\\/]/).pop()
            try {
              const v = await post('/workflow-values', { file: baseName })
              if (v?.ok) setWfValues(Object.assign({}, v.values, { __file: baseName }))
              else setWfValues({ __file: baseName, __error: String(v?.error || '接口没返回数据') })
            } catch (e) {
              setWfValues({ __file: baseName, __error: String(e?.message ?? e) })
            }
            // 顺手把 ComfyUI 的 LoRA 名单拉一次，展开后下拉框直接可选
            jsonFetch(BASE + '/loras-available', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              .then(x => { if (x?.ok && (x.loras || []).length) setLoraList(x.loras) })
              .catch(() => {})
          } catch (e) { setWfNote('读失败：' + (e?.message ?? e)) }
        }

        async function patchLora(node, patch) {
          if (!detail) return
          const loras = (detail.bindings?.loras ?? []).map(x => String(x.node) === String(node) ? Object.assign({}, x, patch) : x)
          setWfDetail(Object.assign({}, detail, { file: detail.file, bindings: Object.assign({}, detail.bindings, { loras }) }))
          try {
            const r = await post('/workflow-bindings', { file: detail.file ?? wfOpen, patch: { loras: [{ node, ...patch }] } })
            if (!r?.ok) setWfNote('保存失败：' + (r?.error || ''))
            else setWfNote('已保存')
          } catch (e) { setWfNote('保存失败：' + (e?.message ?? e)) }
        }

        /** 保存简单编辑的参数值。 */
        async function saveWfValues() {
          if (!wfValues) return
          const v = wfValues
          const payload = {}
          if (v.positive !== undefined) payload.positive = String(v.positive)
          if (v.negative !== undefined) payload.negative = String(v.negative)
          const w = Number(v.width), hgt = Number(v.height), st = Number(v.steps), cf = Number(v.cfg)
          if (Number.isFinite(w)) payload.width = w
          if (Number.isFinite(hgt)) payload.height = hgt
          if (Number.isFinite(st)) payload.steps = st
          if (Number.isFinite(cf)) payload.cfg = cf
          if (v.model !== undefined) payload.model = String(v.model)
          try {
            const r = await post('/workflow-values', { file: v.__file, values: payload })
            if (!r?.ok) { setWfNote('保存失败：' + (r?.error || '')); return }
            setWfNote('✓ 已保存（' + (r.changed || []).join('、') + '）')
            if (typeof showToast === 'function') showToast('工作流参数已保存')
            const st2 = await jsonFetch(BASE + '/state', { cache: 'no-store' }).catch(() => null)
            if (st2) receiveState(st2)
          } catch (e) { setWfNote('保存失败：' + (e?.message ?? e)) }
        }

        /** 试跑一张：真正调 ComfyUI 跑一次，这是"能不能用"最直接的验证。 */
        async function testWorkflow(wf) {
          setWfTestNote('正在跑…（大约 10~60 秒）')
          setWfTestJob('')
          try {
            const r = await post('/workflow-test', { file: wf.file, id: wf.id })
            if (!r?.ok) { setWfTestNote('✗ 跑不了：' + (r?.error || '')); return }
            setWfTestJob(r.jobId)
            setWfTestNote('已提交，正在等出图…')
            // 轮询到出图为止
            const t0 = Date.now()
            while (Date.now() - t0 < 180000) {
              await new Promise(res => setTimeout(res, 2500))
              const s = await jsonFetch(BASE + '/jobs?id=' + encodeURIComponent(r.jobId), { cache: 'no-store' }).catch(() => null)
              const st = s?.job?.status
              if (st === 'done') {
                setWfTestNote('✓ 这张工作流可用！')
                if (typeof showToast === 'function') showToast('✓ 工作流可用，已出图')
                if (typeof openImageOverlay === 'function') openImageOverlay({ open: true, jobIds: [r.jobId], note: '试跑：' + (wf.label || wf.id), working: false })
                break
              }
              if (st === 'failed') { setWfTestNote('✗ 出图失败：' + String(s?.job?.error || '未知原因').slice(0, 300)); return }
              setWfTestNote('正在画… ' + String(s?.job?.percent ?? '') + '%')
            }
          } catch (e) { setWfTestNote('✗ 出错：' + (e?.message ?? e)) }
        }

        /** 改一条绑定（正面/负面/尺寸/步数/底模 用哪个节点）。 */
        async function patchBind(key, node, input) {
          if (!detail) return
          const next = Object.assign({}, detail.bindings, { [key]: node ? [{ node: String(node), input: String(input ?? 'text') }] : [] })
          setWfDetail(Object.assign({}, detail, { file: detail.file, bindings: next }))
          try {
            const r = await post('/workflow-bindings', { file: detail.file ?? wfOpen, patch: { bindings: { [key]: node ? [{ node: String(node), input: String(input ?? 'text') }] : [] } } })
            setWfNote(r?.ok ? '绑定已保存' : ('保存失败：' + (r?.error || '')))
          } catch (e) { setWfNote('保存失败：' + (e?.message ?? e)) }
        }

        async function loadLoraNames() {
          const r = await jsonFetch(BASE + '/loras-available', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
          if (r?.ok) { setLoraList(r.loras ?? []); setWfNote(r.loras?.length ? ('读到 ' + r.loras.length + ' 个已安装的 LoRA') : '没读到 LoRA 列表（ComfyUI 开了吗）') }
        }

        async function doImport(text) {
          try {
            let payload = text
            try { payload = JSON.parse(text) } catch { setWfNote('不是合法 JSON'); return }
            const r = await post('/workflow-import', { workflow: payload, name: '' })
            if (!r?.ok) { setWfNote('导入失败：' + (r?.error || '')); return }
            setWfNote('✓ 已导入《' + r.name + '》节点 ' + r.nodes + ' 个，识别到：正面 ' + r.bindings.positive + ' / 负面 ' + r.bindings.negative + ' / 尺寸 ' + r.bindings.size + ' / 步数 ' + r.bindings.steps + ' / 底模 ' + r.bindings.model + ' / LoRA ' + r.bindings.loras)
            setWfImportOpen(false); setWfPaste('')
            const st = await jsonFetch(BASE + '/state', { cache: 'no-store' }).catch(() => null)
            if (st) receiveState(st)
            if (typeof showToast === 'function') showToast('已导入工作流《' + r.name + '》，识别到 ' + r.bindings.loras + ' 个 LoRA')
          } catch (e) { setWfNote('导入失败：' + (e?.message ?? e)) }
        }
        function pickWfFile(event) {
          const file = event?.target?.files && event.target.files[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => doImport(String(reader.result || ''))
          reader.onerror = () => setWfNote('读文件失败')
          reader.readAsText(file)
        }

        const ta = Object.assign({}, S.input, { width: '100%', minHeight: '110px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', lineHeight: '1.5', resize: 'vertical', boxSizing: 'border-box' })

        return h('div', { style: S.card },
          h('div', { style: { padding: '12px', marginBottom: '12px', borderRadius: '10px', background: 'rgba(106,168,255,.08)', border: '1px solid rgba(106,168,255,.35)' } },
            h('div', { style: { fontSize: '14px', fontWeight: 700, marginBottom: '8px' } }, 'ComfyUI 生成方式'),
            h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
              h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '模式'),
              h('select', { value: config.comfyMode === 'simple' ? 'simple' : 'workflow', style: Object.assign({}, S.input, { minWidth: '220px', flex: 1 }), onChange: e => save({ comfyMode: e.target.value }) },
                h('option', { value: 'workflow' }, '工作流模式（当前默认）'), h('option', { value: 'simple' }, '简单模式（不需要 JSON）'))),
            config.comfyMode === 'simple' ? h('div', { style: { marginTop: '10px' } },
              h('div', { style: { fontSize: '12px', color: '#d6deea', marginBottom: '8px' } }, '从 ComfyUI 读取实际可用的模型与节点；此操作只读取信息，不会提交生成任务。'),
              h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '模板'),
                h('select', { value: simpleDraft.template || 'checkpoint', style: Object.assign({}, S.input, { minWidth: '220px', flex: 1 }), onChange: e => updateSimple({ template: e.target.value }) },
                  h('option', { value: 'checkpoint' }, 'Checkpoint（SD / SDXL）'), h('option', { value: 'flux' }, 'Flux'), h('option', { value: 'anima' }, 'Anima')),
                h('button', { style: buttonStyle, onClick: refreshSimpleInfo, disabled: simpleLoading }, simpleLoading ? '读取中…' : '刷新模型列表'),
                h('button', { style: Object.assign({}, buttonStyle, { borderColor: 'rgba(139,212,139,.65)', color: '#8bd48b', fontWeight: 600 }), onClick: async () => { const r = await save({ comfyMode: 'simple', comfySimple: simpleDraft }); if (r) { setSimpleConfigDraft(null); setSimpleNote('简单模式设置已保存') } } }, '保存简单模式设置')),
              simpleNote ? h('div', { style: { fontSize: '12px', color: /失败|不可用/.test(simpleNote) ? '#ff8d8d' : '#b5c6dc', marginTop: '7px' } }, simpleNote) : null,
              simpleSupport?.reason ? h('div', { role: 'status', style: { marginTop: '8px', padding: '9px 10px', color: '#ffd08a', background: 'rgba(255,190,90,.10)', border: '1px solid rgba(255,190,90,.35)', borderRadius: '8px', fontSize: '12px', lineHeight: 1.5 } }, simpleSupport.reason) : null,
              ['checkpoint', 'flux', 'anima'].includes(simpleDraft.template) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } },
                simpleDraft.template === 'checkpoint'
                  ? h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) }, h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, 'Checkpoint'),
                      simpleInfo?.checkpoints?.length ? options(simpleInfo.checkpoints, simpleDraft.checkpoint, value => updateSimple({ checkpoint: value })) : h('input', { style: Object.assign({}, S.input, { flex: 1 }), value: simpleDraft.checkpoint || '', placeholder: '刷新列表后选择', onChange: e => updateSimple({ checkpoint: e.target.value }) }))
                  : h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) }, h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, simpleDraft.template === 'anima' ? 'Anima 扩散模型' : 'Flux UNet'),
                      (simpleDraft.template === 'anima' ? simpleInfo?.animaUnets : (simpleDraft.template === 'flux' ? simpleInfo?.fluxUnets : simpleInfo?.unets))?.length ? options(simpleDraft.template === 'anima' ? simpleInfo.animaUnets : (simpleDraft.template === 'flux' ? simpleInfo.fluxUnets : simpleInfo.unets), simpleDraft.unet, value => updateSimple({ unet: value })) : h('input', { style: Object.assign({}, S.input, { flex: 1 }), value: simpleDraft.unet || '', placeholder: '刷新列表后选择', onChange: e => updateSimple({ unet: e.target.value }) })),
                simpleDraft.template === 'flux' ? h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '双 CLIP（T5 / CLIP-L）'),
                  options(simpleInfo?.dualClips1, simpleDraft.clip1, value => updateSimple({ clip1: value }), '选择 T5-XXL'),
                  options(simpleInfo?.dualClips2, simpleDraft.clip2, value => updateSimple({ clip2: value }), '选择 CLIP-L')) : null,
                simpleDraft.template === 'checkpoint' ? h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '外置 VAE（可选）'),
                  h('select', { value: simpleDraft.vae || '', style: Object.assign({}, S.input, { minWidth: '180px', flex: 1 }), onChange: e => updateSimple({ vae: e.target.value }) },
                    h('option', { value: '' }, '使用 Checkpoint 内置 VAE'), (simpleInfo?.vaes || []).map(item => h('option', { key: item, value: item }, item)))) : null,
                simpleDraft.template === 'anima' ? h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, 'Anima Qwen CLIP'),
                  simpleInfo?.clips?.length ? options(simpleInfo.clips, simpleDraft.clip1, value => updateSimple({ clip1: value })) : h('input', { style: Object.assign({}, S.input, { flex: 1 }), value: simpleDraft.clip1 || '', placeholder: '刷新列表后选择', onChange: e => updateSimple({ clip1: e.target.value }) })) : null,
                ['flux', 'anima'].includes(simpleDraft.template) ? h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, 'VAE'),
                  simpleInfo?.vaes?.length ? h('select', { value: simpleDraft.vae || '', style: Object.assign({}, S.input, { minWidth: '180px', flex: 1 }), onChange: e => updateSimple({ vae: e.target.value }) },
                    h('option', { value: '' }, simpleDraft.template === 'anima' ? '自动选择 qwen_image_vae' : '自动选择 ae.safetensors'), simpleInfo.vaes.map(item => h('option', { key: item, value: item }, item))) : h('input', { style: Object.assign({}, S.input, { flex: 1 }), value: simpleDraft.vae || '', placeholder: '刷新列表后选择', onChange: e => updateSimple({ vae: e.target.value }) })) : null,
                h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '步数 / CFG'),
                  h('input', { type: 'number', min: 1, max: 200, value: simpleDraft.steps ?? 24, style: Object.assign({}, S.input, { width: '90px' }), onChange: e => updateSimple({ steps: e.target.value }) }),
                  h('input', { type: 'number', step: '0.1', min: 0, max: 100, value: simpleDraft.cfg ?? (simpleDraft.template === 'flux' ? 3.5 : 7), style: Object.assign({}, S.input, { width: '90px' }), onChange: e => updateSimple({ cfg: e.target.value }) }),
                  h('label', { style: { fontSize: '12px', fontWeight: 600, paddingTop: '7px' } }, '采样器'), options(simpleInfo?.samplers, simpleDraft.sampler, value => updateSimple({ sampler: value }))),
                h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '调度器 / 尺寸'), options(simpleInfo?.schedulers, simpleDraft.scheduler, value => updateSimple({ scheduler: value })),
                  h('input', { type: 'number', min: 64, max: 8192, step: 8, value: simpleDraft.width ?? 832, 'aria-label': '宽度', style: Object.assign({}, S.input, { width: '82px' }), onChange: e => updateSimple({ width: e.target.value }) }),
                  h('span', { style: { paddingTop: '7px' } }, '×'),
                  h('input', { type: 'number', min: 64, max: 8192, step: 8, value: simpleDraft.height ?? 1216, 'aria-label': '高度', style: Object.assign({}, S.input, { width: '82px' }), onChange: e => updateSimple({ height: e.target.value }) })),
                h('div', { style: { fontSize: '11px', color: '#bac7d7', paddingLeft: '92px' } }, '宽高按 8 像素倍数生效（其他数值自动取最近值）；简单模式固定输出 ' + (simpleDraft.width || 832) + ' × ' + (simpleDraft.height || 1216) + ' 像素，工作流模式的画幅设置不会覆盖它。'),
                h('div', { style: Object.assign({}, S.row, { alignItems: 'stretch' }) },
                  h('label', { style: { fontSize: '12px', fontWeight: 600, minWidth: '92px', paddingTop: '7px' } }, '固定种子'),
                  h('input', { type: 'number', min: 0, max: 140737488355327, value: simpleDraft.seed ?? '', placeholder: '留空则每张随机', style: Object.assign({}, S.input, { width: '220px' }), onChange: e => updateSimple({ seed: e.target.value }) }),
                  h('span', { style: { fontSize: '11px', color: '#bac7d7', paddingTop: '7px' } }, '只读取已保存的固定种子；默认每张随机')),
                h('div', { style: { padding: '9px', border: '1px solid rgba(120,140,170,.3)', borderRadius: '8px' } },
                  h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '7px' } }, 'LoRA（按当前模板的模型路径连接）'),
                  (simpleDraft.loras || []).map((lora, index) => h('div', { key: index, style: Object.assign({}, S.row, { marginBottom: '6px' }) },
                    h('input', { type: 'checkbox', checked: lora.enabled !== false, 'aria-label': '启用 LoRA', onChange: e => updateSimple({ loras: simpleDraft.loras.map((item, i) => i === index ? Object.assign({}, item, { enabled: e.target.checked }) : item) }) }),
                    simpleInfo?.loras?.length ? options(simpleInfo.loras, lora.name, value => updateSimple({ loras: simpleDraft.loras.map((item, i) => i === index ? Object.assign({}, item, { name: value }) : item) }), '刷新列表后选择') : h('input', { style: Object.assign({}, S.input, { flex: 1 }), value: lora.name || '', placeholder: 'LoRA 名称', onChange: e => updateSimple({ loras: simpleDraft.loras.map((item, i) => i === index ? Object.assign({}, item, { name: e.target.value }) : item) }) }),
                    h('input', { type: 'number', step: '0.05', value: lora.strengthModel ?? 1, 'aria-label': 'LoRA 模型权重', style: Object.assign({}, S.input, { width: '80px' }), onChange: e => updateSimple({ loras: simpleDraft.loras.map((item, i) => i === index ? Object.assign({}, item, { strengthModel: Number(e.target.value), strengthClip: Number(e.target.value) }) : item) }) }),
                    h('button', { style: buttonStyle, onClick: () => updateSimple({ loras: simpleDraft.loras.filter((_, i) => i !== index) }) }, '移除'))),
                  h('button', { style: buttonStyle, onClick: () => updateSimple({ loras: [...(simpleDraft.loras || []), { name: '', strengthModel: 1, strengthClip: 1, enabled: true }] }) }, '＋ 添加 LoRA'))
              ) : null,
            ) : null,
          ),
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '工作流（' + list.length + ' 张）'),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } },
            '从 ComfyUI 导出「API 格式」的 JSON 就能导进来，插件会自动认出正负面提示词、尺寸、步数、底模和 LoRA。',
            h('div', { style: { fontSize: '12px', color: '#8fbcff', marginBottom: '10px' } },
              '导入后点它右边的「设为默认」，之后生成就用这张了。当前：' + (function () {
                const cur = (data.workflows || []).find(w => w.current)
                return cur ? '《' + (cur.label || cur.id) + '》' : '（没选，用第一张可用的）'
              })())),
          h('div', { style: S.row },
            h('button', { style: buttonStyle, onClick: () => setWfImportOpen(v => !v) }, wfImportOpen ? '✖ 收起导入' : '📥 导入工作流'),
            h('button', { style: buttonStyle, onClick: async () => { const r = await post('/reload', {}); if (r?.state) receiveState(r.state); setWfNote('已重新扫描') } }, '🔄 重新扫描'),
            h('button', { style: buttonStyle, onClick: loadLoraNames }, '🧩 读 ComfyUI 的 LoRA 列表'),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#9aa3b2' } },
              h('input', { type: 'checkbox', checked: Boolean(config.lockWorkflow), onChange: e => save({ lockWorkflow: e.target.checked }) }),
              '锁定（不管别处选什么都用这张）'),
            wfNote ? h('span', { style: { fontSize: '12px', color: /失败|不是/.test(wfNote) ? '#f2686b' : '#9aa3b2' } }, wfNote) : null,
          ),

          wfImportOpen ? h('div', { style: { marginTop: '10px', padding: '12px', borderRadius: '10px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.22)' } },
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } },
              '在 ComfyUI 里用「工作流 → 导出（API）」，或用 Save (API Format) 得到 JSON；也可以直接把 JSON 粘在下面。'),
            h('div', { style: S.row },
              h('label', { style: { padding: '6px 14px', fontSize: '12px', borderRadius: '8px', border: '1px solid rgba(106,168,255,.6)', color: '#8fbcff', cursor: 'pointer', background: 'rgba(106,168,255,.1)' } },
                '📁 选 JSON 文件',
                h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: pickWfFile }),
              ),
            ),
            h('textarea', { value: wfPaste, placeholder: '粘贴 ComfyUI 的 API 格式 JSON…', style: Object.assign({}, ta, { marginTop: '8px' }), onChange: e => setWfPaste(e.target.value) }),
            h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
              h('button', { style: buttonStyle, onClick: () => doImport(wfPaste) }, '导入这段 JSON'),
              h('button', { style: buttonStyle, onClick: () => { setWfPaste(''); setWfNote('') } }, '清空'),
            ),
          ) : null,

          h('div', { style: { marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
            list.length ? list.map(wf => {
              const isOpen = String(wf.file ?? '') === String(wfOpen)
              const sum = wf.summary || {}
              return h('div', { key: wf.id, style: { borderRadius: '10px', border: isOpen ? '1px solid rgba(106,168,255,.7)' : '1px solid rgba(120,140,170,.22)', background: 'rgba(255,255,255,.03)', padding: '10px 12px' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
                  h('span', { style: { fontSize: '13px', fontWeight: 600, flex: 1, minWidth: '140px' } },
                    wf.label || wf.id || '(无名)',
                    wf.current ? h('span', { style: { fontSize: '11px', color: '#8bd48b', marginLeft: '8px' } }, '← 正在使用') : null,
                    wf.error ? h('span', { style: { fontSize: '11px', color: '#f2686b', marginLeft: '8px' } }, '（不可用）') : null),
                  wf.current
                    ? h('span', { style: { fontSize: '11px', color: '#8bd48b', padding: '3px 8px', borderRadius: '7px', background: 'rgba(139,212,139,.12)' } }, '✓ 正在用这张')
                    : h('button', {
                        style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 12px', borderColor: 'rgba(139,212,139,.6)', color: '#8bd48b' }),
                        title: '之后的生成都用这张工作流',
                        onClick: async () => {
                          if (wf.error) { if (typeof showToast === 'function') showToast('这张工作流不可用：' + wf.error, 'fail'); return }
                          await save({ defaultWorkflow: wf.id, lockWorkflow: true })
                          if (typeof showToast === 'function') showToast('已切换：之后的生成用《' + (wf.label || wf.id) + '》')
                        },
                      }, '设为默认'),
                  h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 12px' }), onClick: () => openWorkflow(wf.file) }, isOpen ? '△ 收起' : '✏️ 编辑 / LoRA'),
                  h('button', { type: 'button', 'aria-label': '可视化编辑 ' + (wf.label || wf.id), style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 12px', borderColor: 'rgba(106,168,255,.7)', color: '#a8caff' }), onClick: () => setWfGraphFile(wf.file) }, '可视化编辑'),
                  h('button', {
                    style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 12px' }),
                    title: '重命名这张',
                    onClick: async () => {
                      const name = prompt('这张工作流叫什么？', wf.label || wf.id)
                      if (name === null) return
                      try {
                        const r = await post('/workflow', { id: wf.id, label: String(name).slice(0, 80) })
                        if (r?.state) receiveState(r.state)
                        if (typeof showToast === 'function') showToast('已改名')
                      } catch (e) { if (typeof showToast === 'function') showToast('改名失败：' + (e?.message ?? e), 'fail') }
                    },
                  }, '改名'),
                  h('button', {
                    style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 12px', borderColor: 'rgba(242,104,107,.6)', color: '#f2686b' }),
                    title: '从列表移除（不删文件）',
                    onClick: async () => {
                      if (!confirm('把《' + (wf.label || wf.id) + '》从列表移除？只移除条目，磁盘 JSON 不删。')) return
                      try {
                        const r = await post('/workflow', { id: wf.id, remove: true })
                        if (r?.state) receiveState(r.state)
                        if (typeof showToast === 'function') showToast('已移除')
                      } catch (e) { if (typeof showToast === 'function') showToast('移除失败：' + (e?.message ?? e), 'fail') }
                    },
                  }, '移除'),
                ),
                h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '4px' } },
                  (sum.model ? '底模 ' + sum.model + '　' : '') +
                  (sum.base ? '尺寸 ' + sum.base + '　' : '') +
                  (sum.nodeCount ? sum.nodeCount + ' 节点　' : '') +
                  ((sum.loras || []).length ? (sum.loras || []).length + ' 个 LoRA' : '')),
                (sum.positivePeek || sum.negativePeek) ? h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '3px', fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                  (sum.positivePeek ? '＋ ' + sum.positivePeek : '') + (sum.negativePeek ? '　－ ' + sum.negativePeek : '')) : null,
                h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '3px' } },
                  '点右边的「✏️ 编辑 / LoRA」可以改提示词、尺寸、步数、底模和 LoRA。'),
                wf.error ? h('div', { style: { fontSize: '12px', color: '#f2686b', marginTop: '4px' } }, wf.error) : null,

                isOpen ? h('div', { style: { marginTop: '10px', borderTop: '1px solid rgba(120,140,170,.25)', paddingTop: '10px' } },
                  !detail
                    ? h('div', { style: { fontSize: '12px', color: '#9aa3b2' } }, '读取中…')
                    : h('div', null,
                        h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } },
                          '输出节点 ' + (detail.outputNode || '?') +
                          '　正面 ' + (detail.bindings?.positive?.length ?? 0) +
                          '　负面 ' + (detail.bindings?.negative?.length ?? 0) +
                          '　尺寸 ' + (detail.bindings?.size?.length ?? 0) +
                          '　步数 ' + (detail.bindings?.steps?.length ?? 0)),

                        // 试跑 + 编辑绑定
                        h('div', { style: Object.assign({}, S.row, { marginBottom: '10px' }) },
                          h('button', {
                            style: Object.assign({}, buttonStyle, { borderColor: 'rgba(139,212,139,.6)', color: '#8bd48b', fontWeight: 600 }),
                            onClick: () => testWorkflow(wf),
                            title: '用这张工作流真的画一张，验证它能不能跑通',
                          }, '⚡ 试跑一张'),

                          wfTestNote ? h('span', { style: { fontSize: '12px', color: /✗/.test(wfTestNote) ? '#f2686b' : (/✓/.test(wfTestNote) ? '#8bd48b' : '#9aa3b2') } }, wfTestNote) : null,
                        ),

                        // 简单编辑：直接改参数值（不用理解节点）
                        wfValues && !wfValues.__error ? h('div', { style: { marginBottom: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.22)' } },
                          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } },
                            '这张工作流的参数。改完点「💾 保存参数」立刻生效，之后生成就用这些值。'),
                          h('div', { style: Object.assign({}, S.row, { alignItems: 'flex-start' }) },
                            h('span', { style: Object.assign({}, S.label, { minWidth: '74px', paddingTop: '6px' }) }, '正面提示词'),
                            h('textarea', {
                              value: wfValues.positive ?? '', style: Object.assign({}, S.input, { flex: 1, minWidth: '200px', minHeight: '54px', fontSize: '12px', fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical', boxSizing: 'border-box' }),
                              onChange: e => setWfValues(Object.assign({}, wfValues, { positive: e.target.value })),
                            }),
                          ),
                          h('div', { style: Object.assign({}, S.row, { alignItems: 'flex-start' }) },
                            h('span', { style: Object.assign({}, S.label, { minWidth: '74px', paddingTop: '6px' }) }, '负面提示词'),
                            h('textarea', {
                              value: wfValues.negative ?? '', style: Object.assign({}, S.input, { flex: 1, minWidth: '200px', minHeight: '54px', fontSize: '12px', fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical', boxSizing: 'border-box' }),
                              onChange: e => setWfValues(Object.assign({}, wfValues, { negative: e.target.value })),
                            }),
                          ),
                          h('div', { style: S.row },
                            h('span', { style: Object.assign({}, S.label, { minWidth: '74px' }) }, '尺寸'),
                            h('input', { type: 'number', value: wfValues.width ?? '', placeholder: '宽', style: Object.assign({}, S.input, { width: '88px' }), onChange: e => setWfValues(Object.assign({}, wfValues, { width: e.target.value })) }),
                            h('span', { style: { color: '#9aa3b2' } }, '×'),
                            h('input', { type: 'number', value: wfValues.height ?? '', placeholder: '高', style: Object.assign({}, S.input, { width: '88px' }), onChange: e => setWfValues(Object.assign({}, wfValues, { height: e.target.value })) }),
                            h('span', { style: { fontSize: '11px', color: '#9aa3b2', marginLeft: '8px' } }, '这里只是这张工作流的上限参考，实际尺寸由生成时的画幅决定'),
                          ),
                          h('div', { style: S.row },
                            h('span', { style: Object.assign({}, S.label, { minWidth: '74px' }) }, '步数'),
                            h('input', { type: 'number', value: wfValues.steps ?? '', placeholder: '步数', style: Object.assign({}, S.input, { width: '88px' }), onChange: e => setWfValues(Object.assign({}, wfValues, { steps: e.target.value })) }),
                            h('span', { style: Object.assign({}, S.label, { minWidth: '46px', marginLeft: '12px' }) }, 'CFG'),
                            h('input', { type: 'number', step: '0.1', value: wfValues.cfg ?? '', placeholder: 'CFG', style: Object.assign({}, S.input, { width: '88px' }), onChange: e => setWfValues(Object.assign({}, wfValues, { cfg: e.target.value })) }),
                          ),
                          h('div', { style: S.row },
                            h('span', { style: Object.assign({}, S.label, { minWidth: '74px' }) }, '底模'),
                            h('input', {
                              type: 'text', value: wfValues.model ?? '', placeholder: '比如 anima-turbo-v1.safetensors',
                              style: Object.assign({}, S.input, { flex: 1, minWidth: '200px' }),
                              onChange: e => setWfValues(Object.assign({}, wfValues, { model: e.target.value })),
                            }),
                          ),
                          h('div', { style: S.row },
                            h('button', { style: Object.assign({}, buttonStyle, { borderColor: 'rgba(106,168,255,.6)', color: '#8fbcff', fontWeight: 600 }), onClick: saveWfValues }, '💾 保存参数'),
                            h('button', { style: buttonStyle, onClick: async () => {
                              const v = await post('/workflow-values', { file: wfValues.__file }).catch(() => null)
                              if (v?.ok) setWfValues(Object.assign({}, v.values, { __file: wfValues.__file }))
                              setWfNote('已重新读取')
                            } }, '↻ 重新读取'),
                          ),
                        ) : wfValues && wfValues.__error
                          ? h('div', { style: { fontSize: '12px', color: '#f2686b', marginBottom: '10px' } },
                              '读参数失败：' + wfValues.__error + '　（多半是宿主没重启，重启 DSH 后再试）')
                          : h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } }, '读取参数中…'),

                        h('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
                          'LoRA（' + (detail.bindings?.loras?.length ?? 0) + ' 个）'),
                        (detail.bindings?.loras ?? []).length
                          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                              (detail.bindings.loras).map(lora => h('div', { key: lora.node, style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '6px 8px', borderRadius: '8px', background: lora.enabled === false ? 'rgba(0,0,0,.2)' : 'rgba(106,168,255,.07)' } },
                                h('input', { type: 'checkbox', checked: lora.enabled !== false, title: '启用 / 停用这个 LoRA', onChange: e => patchLora(lora.node, { enabled: e.target.checked }) }),
                                loraList.length
                                  ? h('select', { value: lora.name || '', style: Object.assign({}, S.input, { flex: 1, minWidth: '170px', fontSize: '12px' }), onChange: e => patchLora(lora.node, { name: e.target.value }) },
                                      h('option', { value: lora.name || '', style: { color: '#12161c', background: '#e9eef6' } }, lora.name || '（未选）'),
                                      loraList.filter(n => n !== lora.name).map(n => h('option', { key: n, value: n, style: { color: '#12161c', background: '#e9eef6' } }, n)))
                                  : h('input', { type: 'text', value: lora.name || '', placeholder: 'lora 文件名', style: Object.assign({}, S.input, { flex: 1, minWidth: '170px', fontSize: '12px' }), onChange: e => patchLora(lora.node, { name: e.target.value }) }),
                                h('span', { style: { fontSize: '11px', color: '#9aa3b2' } }, '权重'),
                                h('input', { type: 'number', step: '0.05', value: lora.strengthModel ?? 1, style: Object.assign({}, S.input, { width: '76px', fontSize: '12px' }), onChange: e => patchLora(lora.node, { strengthModel: Number(e.target.value), strengthClip: Number(e.target.value) }) }),
                                h('span', { style: { fontSize: '11px', color: '#9aa3b2' } }, '节点 ' + lora.node),
                              )))
                          : h('div', { style: { fontSize: '12px', color: '#9aa3b2' } }, '这张工作流里没有 LoRA 节点（没有 LoraLoader）'),
                      ),
                ) : null,
              )
            }) : h('div', { style: { fontSize: '12px', color: '#9aa3b2', padding: '12px' } }, '还没有工作流。点「📥 导入工作流」或往插件目录的 workflows/ 里丢 JSON 再点重新扫描。'),
          ),
        )
      }

      // ---- 世界书 ----
      function worldbookTab() {
        const list = data.worldbook || []
        const onCount = list.filter(e => e.enabled !== false).length

        async function refreshWb() {
          const r = await jsonFetch(BASE + '/state', { cache: 'no-store' }).catch(() => null)
          if (r) receiveState(r)
        }
        async function patchEntry(index, patch, remove, tip) {
          try {
            const r = await post('/worldbook-entry', remove ? { index, remove: true } : { index, patch })
            if (!r?.ok) { setWbNote((tip || '改') + '失败：' + (r?.error || '')); return }
            setWbNote(tip ? (tip + '已保存') : '')
            await refreshWb()
          } catch (e) { setWbNote((tip || '改') + '失败：' + (e?.message ?? e)) }
        }
        /** 打字时用这个：停 700ms 才真正提交，避免每敲一个字写一次盘。 */
        function patchEntrySoon(index, patch, tip) {
          setWbNote('输入中…')
          if (wbTimer.current) clearTimeout(wbTimer.current)
          const seq = ++wbSeq.current
          wbTimer.current = setTimeout(() => {
            if (seq !== wbSeq.current) return
            patchEntry(index, patch, false, tip)
          }, 700)
        }
        async function addEntry() {
          try {
            const r = await post('/worldbook-add', { comment: '新条目', content: '' })
            if (!r?.ok) { setWbNote('加失败：' + (r?.error || '')); return }
            await refreshWb()
            setWbEditing(typeof r.index === 'number' ? r.index : -1)
          } catch (e) { setWbNote('加失败：' + (e?.message ?? e)) }
        }
        async function importFrom(text, label) {
          try {
            let payload = text
            try { payload = JSON.parse(text) } catch { /* 当纯文本 */ }
            const r = await post('/worldbook-import', { worldbook: payload })
            if (!r?.ok) { setWbNote('导入失败：' + (r?.error || '没读出条目')); return }
            setWbNote('✓ 已导入《' + r.name + '》' + r.count + ' 条')
            setWbImportOpen(false)
            setWbPaste('')
            await refreshWb()
            if (typeof showToast === 'function') showToast('已导入 ' + r.count + ' 条世界书条目')
          } catch (e) { setWbNote('导入失败：' + (e?.message ?? e)) }
        }
        function pickWbFile(event) {
          const file = event?.target?.files && event.target.files[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => importFrom(String(reader.result || ''), file.name)
          reader.onerror = () => setWbNote('读文件失败')
          reader.readAsText(file)
        }
        async function exportWb() {
          const r = await jsonFetch(BASE + '/worldbook-export', { cache: 'no-store' }).catch(() => null)
          if (!r?.ok) { setWbNote('导出失败'); return }
          const text = JSON.stringify(r.worldbook, null, 2)
          try {
            await navigator.clipboard.writeText(text)
            if (typeof showToast === 'function') showToast('世界书 JSON 已复制到剪贴板，粘给别人就能导入')
          } catch {
            setWbPaste(text)
            setWbImportOpen(true)
            setWbNote('复制失败，内容已放到下面的框里，手动复制即可')
          }
        }

        const ta = Object.assign({}, S.input, { width: '100%', minHeight: '130px', fontFamily: 'inherit', lineHeight: '1.6', resize: 'vertical', boxSizing: 'border-box' })

        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } },
            '生图世界书' + (data.worldbookName ? '《' + data.worldbookName + '》' : '') + '（' + onCount + ' / ' + list.length + ' 条启用）'),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } },
            '这几条会作为「画图规则」发给规划模型。可以自己导入世界书、逐条开关、改内容。'),
          h('div', { style: S.row },
            h('button', { style: buttonStyle, onClick: () => setWbImportOpen(v => !v) }, wbImportOpen ? '✖ 收起导入' : '📥 导入世界书'),
            h('button', { style: buttonStyle, onClick: addEntry }, '➕ 新条目'),
            h('button', { style: buttonStyle, onClick: exportWb }, '📤 导出（复制 JSON）'),
            h('button', { style: buttonStyle, onClick: refreshWb }, '🔄 刷新'),
            wbNote ? h('span', { style: { fontSize: '12px', color: /失败/.test(wbNote) ? '#f2686b' : '#8bd48b' } }, wbNote) : null,
          ),

          wbImportOpen ? h('div', { style: { marginTop: '10px', padding: '12px', borderRadius: '10px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(120,140,170,.22)' } },
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '8px' } },
              '可以直接导入 SillyTavern 的世界书 JSON（选文件），也可以把 JSON / 纯文本粘在下面。纯文本会按空行切成条目。'),
            h('div', { style: S.row },
              h('label', { style: { padding: '6px 14px', fontSize: '12px', borderRadius: '8px', border: '1px solid rgba(106,168,255,.6)', color: '#8fbcff', cursor: 'pointer', background: 'rgba(106,168,255,.1)' } },
                '📁 选文件（.json / .txt）',
                h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', style: { display: 'none' }, onChange: pickWbFile }),
              ),
            ),
            h('textarea', { value: wbPaste, placeholder: '把世界书 JSON 或纯文本粘在这里…', style: Object.assign({}, ta, { marginTop: '8px' }), onChange: e => setWbPaste(e.target.value) }),
            h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
              h('button', { style: buttonStyle, onClick: () => importFrom(wbPaste) }, '导入这段内容'),
              h('button', { style: buttonStyle, onClick: () => { setWbPaste(''); setWbNote('') } }, '清空'),
            ),
          ) : null,

          h('div', { style: { marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' } },
            list.length ? list.map(entry => h('div', {
              key: entry.index,
              style: { borderRadius: '10px', border: '1px solid rgba(120,140,170,.2)', background: entry.enabled === false ? 'rgba(255,255,255,.015)' : 'rgba(255,255,255,.04)', padding: '9px 11px' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                h('input', {
                  type: 'checkbox', checked: entry.enabled !== false,
                  title: '启用 / 停用这条',
                  onChange: e => patchEntry(entry.index, { enabled: e.target.checked }),
                }),
                h('span', { style: { flex: 1, minWidth: 0, fontSize: '13px', color: entry.enabled === false ? '#9aa3b2' : '#dbe3ee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  String(entry.index + 1) + '. ' + (entry.comment || '未命名')),
                h('span', { style: { fontSize: '11px', color: '#9aa3b2', flexShrink: 0 } }, entry.length + ' 字'),
                h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 10px' }), onClick: () => setWbEditing(wbEditing === entry.index ? -1 : entry.index) }, wbEditing === entry.index ? '收起' : '编辑'),
                h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 10px', borderColor: 'rgba(242,104,107,.6)', color: '#f2686b' }), onClick: () => { if (confirm('删除这条世界书条目？')) patchEntry(entry.index, null, true) } }, '删'),
              ),
              wbEditing === entry.index ? h('div', { style: { marginTop: '8px' } },
                h('input', {
                  type: 'text', value: entry.comment || '', placeholder: '条目标题',
                  style: Object.assign({}, S.input, { width: '100%', marginBottom: '6px' }),
                  onChange: e => patchEntrySoon(entry.index, { comment: e.target.value }, '标题'),
                }),
                h('textarea', {
                  value: entry.content || '', placeholder: '条目内容（作为画图规则发给模型）',
                  style: ta,
                  onChange: e => patchEntrySoon(entry.index, { content: e.target.value }, '内容'),
                }),
                h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '4px' } }, '改动即时保存。'),
              ) : null,
            )) : h('div', { style: { fontSize: '12px', color: '#9aa3b2', padding: '12px' } },
              '还没有条目。可以点「📥 导入世界书」，或「➕ 新条目」自己写。'),
          ),
        )
      }

      // ---- 历史图 ----
      function galleryTab() {
        const done = historyJobs.filter(function (job) { return job.hasImage })
        const tiles = done.map(function (job) {
          return h('div', {
            key: job.id,
            style: {
              position: 'relative', borderRadius: '10px', overflow: 'hidden',
              background: 'rgba(255,255,255,.03)',
              border: gallerySelect && galleryPicked[job.id] ? '2px solid #6aa8ff' : '1px solid rgba(120,140,170,.2)',
              boxShadow: gallerySelect && galleryPicked[job.id] ? '0 0 0 3px rgba(106,168,255,.25)' : 'none',
            },
          },
            h('img', {
              src: BASE + '/jobs?id=' + encodeURIComponent(job.id) + '&image=1',
              loading: 'lazy',
              decoding: 'async',
              alt: job.label || '图',
              title: '左键看大图　右键出菜单',
              style: { display: 'block', width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', cursor: 'zoom-in', background: '#1a1d24' },
              // 左键：批量模式下 = 勾选；平时 = 看大图（带上整库，能左右翻）
              onClick: function () {
                if (gallerySelect) { setGalleryPicked(cur => Object.assign({}, cur, { [job.id]: !cur[job.id] })); return }
                if (typeof openImageOverlay !== 'function') return
                // 用「所有历史图」作为翻页列表，并定位到点的这一张 —— 这样打开第一张就能一路翻到最后
                const all = done.map(function (j) { return j.id })
                const at = Math.max(0, all.indexOf(job.id))
                openImageOverlay({ open: true, jobIds: all.length ? all : [job.id], note: '历史图（' + (at + 1) + '/' + all.length + '）', working: false, index: at })
              },
              // 右键：出菜单
              onContextMenu: function (event) {
                event.preventDefault()
                if (typeof openContextMenu !== 'function') return
                openContextMenu({
                  x: event.clientX, y: event.clientY,
                  items: [
                    { icon: '🖼', label: '查看大图', onClick: function () {
                        const all = done.map(function (j) { return j.id })
                        const at = Math.max(0, all.indexOf(job.id))
                        openImageOverlay({ open: true, jobIds: all.length ? all : [job.id], note: '历史图（' + (at + 1) + '/' + all.length + '）', working: false, index: at })
                      } },
                    { icon: '✏️', label: '改提示词重画', onClick: function () {
                        if (typeof openEditorFor === 'function') openEditorFor(job.id, job.label)
                      } },
                    { icon: '📋', label: '复制提示词', onClick: async function () {
                        const r = await jsonFetch(BASE + '/job-detail?id=' + encodeURIComponent(job.id), { cache: 'no-store' }).catch(function () { return null })
                        const text = String(r?.job?.rawPrompt || r?.job?.prompt || '')
                        if (!text) { if (typeof showToast === 'function') showToast('这张图没记录提示词', 'fail'); return }
                        try { await navigator.clipboard.writeText(text); if (typeof showToast === 'function') showToast('提示词已复制') }
                        catch { if (typeof showToast === 'function') showToast('复制失败', 'fail') }
                      } },
                    { icon: '🗑', label: '删除这张', danger: true, onClick: function () { deleteJob(job.id) } },
                  ],
                })
              },
            }),
            gallerySelect ? h('div', {
              style: { position: 'absolute', top: '6px', left: '6px', width: '24px', height: '24px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.5)', background: galleryPicked[job.id] ? '#6aa8ff' : 'rgba(0,0,0,.5)', color: '#fff', fontSize: '15px', lineHeight: '22px', textAlign: 'center' },
            }, galleryPicked[job.id] ? '✓' : '') : null,
            !gallerySelect ? h('button', {
              type: 'button',
              title: '删除这张（连带缓存）',
              onClick: function (e) { e.stopPropagation(); deleteJob(job.id) },
              style: {
                position: 'absolute', top: '6px', right: '6px', width: '26px', height: '26px',
                borderRadius: '7px', border: '1px solid rgba(255,255,255,.25)',
                background: 'rgba(0,0,0,.55)', color: '#ffb3b5', cursor: 'pointer',
                fontSize: '13px', lineHeight: 1, padding: 0,
              },
            }, '🗑') : null,
            h('div', { style: { padding: '6px 8px', fontSize: '11px', color: '#9aa3b2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              (job.label || '未命名') + ' · ' + (job.size || '')),
          )
        })
        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } }, '历史图片（' + done.length + ' / ' + historyJobs.length + ' 张）'),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } }, '左键看大图（可以左右翻整个历史库），右键出菜单，鼠标移到图上右上角能直接删。'),
          h('div', { style: S.row },
            h('button', { style: buttonStyle, onClick: function () { setHistoryNote('读取中…'); setHistoryTick(n => n + 1) } }, '🔄 刷新'),
            h('button', { style: buttonStyle, onClick: function () {
              if (typeof openImageOverlay === 'function' && done.length) openImageOverlay({ open: true, jobIds: done.map(function (job) { return job.id }), note: '全部历史（◀ ▶ 翻页）', working: false, index: 0 })
            } }, '🖼 全部打开'),
            h('button', { style: buttonStyle, onClick: function () {
              setGallerySelect(v => !v); setGalleryPicked({})
            } }, gallerySelect ? '✖ 退出批量' : '☑ 批量选择'),
            gallerySelect ? h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: function () {
              const next = {}
              for (const job of done) next[job.id] = true
              setGalleryPicked(next)
            } }, '全选') : null,
            gallerySelect ? h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: function () { setGalleryPicked({}) } }, '取消全选') : null,
            gallerySelect ? h('button', {
              style: Object.assign({}, buttonStyle, { borderColor: 'rgba(242,104,107,.7)', color: '#f2686b' }),
              onClick: function () { deleteJobBatch(Object.keys(galleryPicked).filter(k => galleryPicked[k])) },
            }, '🗑 删除选中（' + Object.keys(galleryPicked).filter(k => galleryPicked[k]).length + '）') : null,
            historyNote ? h('span', { style: { fontSize: '12px', color: '#9aa3b2' } }, historyNote) : null,
          ),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px', marginTop: '12px' } },
            tiles.length ? tiles : h('div', { style: { fontSize: '12px', color: '#9aa3b2', padding: '14px' } }, historyNote || '还没有图片')),
        )
      }

      /**
       * 画风预设（参考 st-chatu8 的「提示词预设」）。
       * 一套 = 名字 + 正面画师串/风格词 + 这套自带的负面固定词 + 放前面还是后面。
       * 选中的那套生成时自动拼进提示词；不选就用下面的默认值。
       */
      /** 测 ComfyUI 连接。 */
      async function loadComfyStatus() {
        setComfyStatus({ checking: true })
        // ⚠ 这里不能用 config：data 为空时组件在第 1346 行提前 return，同作用域的
        //   `const config = data.config || {}` 从未执行，直接读会抛
        //   ReferenceError: Cannot access 'config' before initialization（TDZ）。
        //   走 dataRef 取最新值，既避开 TDZ，也拿到真正加载完的配置。
        const url = String(dataRef.current?.config?.comfyUrl ?? '')
        const r = await post('/comfy-test', { url }).catch(e => ({ ok: false, error: String(e?.message ?? e) }))
        setComfyStatus(r)
      }

      /** 拉 provider 列表（和某个 provider 的模型列表）。 */
      async function loadProviders() {
        const r = await post('/llm-models', {}).catch(() => null)
        if (r?.providers?.length) { setLlmProviders(r.providers); setLlmNote('') }
        else setLlmNote('读不到 provider 列表（DSH 的 llm 服务不可用？可以先手动填）')
      }
      async function loadModels(provider) {
        if (!provider) return
        const r = await post('/llm-models', { provider }).catch(() => null)
        if (r?.models?.length) {
          setLlmModels(m => Object.assign({}, m, { [provider]: r.models }))
          if (r.error) setLlmNote(r.error)
          else setLlmNote('')
        } else setLlmNote(r?.error || '这个 provider 下列不出模型')
      }
      async function loadReasoning(provider, model) {
        if (!provider || !model) return
        const key = provider + '/' + model
        if (llmReasoning[key]) return
        const r = await post('/llm-models', { provider, model }).catch(() => null)
        if (r?.reasoning) setLlmReasoning(m => Object.assign({}, m, { [key]: r.reasoning }))
      }

      /**
       * 模型选择器：provider 下拉 → model 下拉 → 推理等级下拉。
       * onlyVision=true 时只列能看图的模型（看图模型用）。
       */
      function ModelPicker(props) {
        const { label, providerKey, modelKey, effortKey, onlyVision, hint } = props
        const pv = String(config[providerKey] || '')
        const md = String(config[modelKey] || '')
        const ef = String(config[effortKey] || '')
        const models = (llmModels[pv] || []).filter(m => !onlyVision || m.vision)
        const reason = llmReasoning[pv + '/' + md]
        const optStyle = { color: '#12161c', background: '#e9eef6' }
        const set = (patch) => setData(Object.assign({}, data, { config: Object.assign({}, config, patch) }))
        return h('div', { style: { marginBottom: '8px' } },
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.label, { minWidth: '86px' }) }, label),
            h('select', {
              value: pv, style: Object.assign({}, S.input, { flex: 1, minWidth: '150px' }),
              onChange: e => { const v = e.target.value; set({ [providerKey]: v, [modelKey]: '' }); save({ [providerKey]: v, [modelKey]: '' }); loadModels(v) },
            },
              h('option', { value: '', style: optStyle }, '（不指定，跟随 Tavern 后台模型）'),
              llmProviders.map(p => h('option', { key: p.id, value: p.id, style: optStyle }, p.name + '（' + p.id + '）')),
              pv && !llmProviders.some(p => p.id === pv) ? h('option', { value: pv, style: optStyle }, pv + '（当前值）') : null,
            ),
            h('select', {
              value: md, style: Object.assign({}, S.input, { flex: 1, minWidth: '150px' }),
              onChange: e => { const v = e.target.value; set({ [modelKey]: v }); save({ [modelKey]: v }); if (v) loadReasoning(pv, v) },
              disabled: !pv,
            },
              h('option', { value: '', style: optStyle }, pv ? '（选一个模型）' : '（先选提供商）'),
              models.map(m => h('option', { key: m.id, value: m.id, style: optStyle }, m.name + (onlyVision ? (m.vision ? '　👁' : '') : '') + (m.id !== m.name ? '　' + m.id : ''))),
              md && !models.some(m => m.id === md) ? h('option', { value: md, style: optStyle }, md + '（当前值）') : null,
            ),
          ),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.label, { minWidth: '86px' }) }, '推理等级'),
            h('select', {
              value: ef, style: Object.assign({}, S.input, { width: '170px' }),
              onChange: e => { set({ [effortKey]: e.target.value }); save({ [effortKey]: e.target.value }) },
              disabled: !reason,
            },
              h('option', { value: '', style: optStyle }, reason ? '默认' : '（选模型后可选）'),
              (reason?.efforts || []).map(x => h('option', { key: x.id, value: x.id, style: optStyle }, x.name + (x.id !== x.name ? '　' + x.id : ''))),
            ),
            hint ? h('span', { style: { fontSize: '11px', color: '#9aa3b2' } }, hint) : null,
          ),
        )
      }

      /**
       * 首次配置引导：新装的人打开设置页，按三步走就能用。
       * 三件都办好了就自己消失。
       */
      function SetupGuide() {
        const external = imageBackend !== 'comfyui'
        const hasUrl = external ? Boolean(String(selectedChannel?.baseUrl ?? '').trim()) : Boolean(String(config.comfyUrl ?? '').trim())
        const online = external ? externalConnected : Boolean(comfyStatus?.ok)
        const simpleMode = !external && config.comfyMode === 'simple'
        const simple = config.comfySimple || {}
        const simpleTemplate = String(simple.template || 'checkpoint')
        const simpleModel = simpleTemplate === 'checkpoint' ? simple.checkpoint : simple.unet
        const simpleCapability = simpleInfo?.templates?.[simpleTemplate]
        const simpleReady = Boolean(String(simpleModel || '').trim()) && (!simpleCapability || simpleCapability.available === true)
        const hasWorkflow = external || (simpleMode ? simpleReady : (data.workflows ?? []).some(w => !w.error))
        const hasModel = Boolean(config.plannerEnabled !== false)
        // 前两步没做完才显示
        if (hasUrl && online && hasWorkflow) return null
        if (external && hasUrl && hasWorkflow && hasModel && (!externalStatus || externalStatus.status === 'configured' || externalConnected)) return null
        const step = (n, text, done, hint) => h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' } },
          h('span', {
            style: {
              flexShrink: 0, width: '18px', height: '18px', borderRadius: '50%', fontSize: '11px', lineHeight: '18px', textAlign: 'center',
              background: done ? 'rgba(139,212,139,.2)' : 'rgba(226,185,59,.18)',
              color: done ? '#8bd48b' : '#e2b93b',
            },
          }, done ? '✓' : String(n)),
          h('div', null,
            h('div', { style: { fontSize: '13px', color: done ? '#8bd48b' : '#dfe4ec' } }, text),
            hint ? h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '2px' } }, hint) : null,
          ),
        )
        return h('div', { style: Object.assign({}, S.card, { border: '1px solid rgba(226,185,59,.45)' }) },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: '#e2b93b' } }, '还没配置好 —— 三步就能用'),
          step(1, external ? '配置图像提供商渠道' : '填 ComfyUI 地址并测试连接', external ? hasUrl : hasUrl && online,
            external ? (online ? '渠道探测成功。' : externalStatus?.checking ? '正在探测渠道…' : externalStatus?.status === 'configured' ? ('已配置但无法安全探测：' + (externalStatus.message || '请在服务商侧确认模型与权限。')) : externalStatus ? ('探测未通过：' + (externalStatus.message || externalStatus.error || '检查地址和鉴权。')) : '在「生图规划」标签页选择提供商，填写 API 地址、模型和鉴权，然后保存并测试。') : (online ? ('已连上 ' + (comfyStatus?.version ? 'ComfyUI ' + comfyStatus.version : 'ComfyUI')) : '在「生图规划」标签页上面的「生图后端」里填，然后点「测试连接与鉴权」')),
          external ? null : simpleMode
            ? step(2, '选择简单模式模板和模型', simpleReady,
                simpleCapability?.reason || '在「画风」标签页打开简单模式、刷新模型列表并选择模型；不需要导入 JSON。')
            : step(2, '导入一个工作流并设为默认', hasWorkflow,
                '在「画风」标签页里，点「📥 导入工作流」，选 ComfyUI 用 API 格式导出的 JSON；也可以切换到简单模式而不导入 JSON。'),
          step(external ? 2 : 3, '选规划模型（不选就跟随 Tavern 后台模型）', hasModel,
            '在「生图规划」标签页的「规划模型」下拉里选；想画 NSFW 就选自己的渠道模型'),
        )
      }

      function stylePresetCard() {
        const presets = Array.isArray(config.stylePresets) ? config.stylePresets : []
        const active = String(config.activePreset ?? '')
        const activeName = (presets.find(p => String(p.id) === active) || {}).name

        const savePresets = (next) => save({ stylePresets: next })
        const patch = (i, patchObj) => {
          const next = presets.slice()
          next[i] = Object.assign({}, next[i], patchObj)
          savePresets(next)
        }
        const add = () => {
          const next = presets.concat([{
            id: 'p' + Date.now(), name: '画风 ' + (presets.length + 1),
            artist: '', negative: '', position: 'prefix', enabled: true,
          }])
          savePresets(next)
          save({ activePreset: next[next.length - 1].id })
        }
        const remove = (i) => {
          if (!confirm('删除这套画风？')) return
          const next = presets.slice()
          const gone = next.splice(i, 1)[0]
          savePresets(next)
          if (gone && String(gone.id) === active) save({ activePreset: '' })
        }
        const ta = (hgt) => Object.assign({}, S.input, {
          width: '100%', minHeight: hgt, fontFamily: 'ui-monospace, Consolas, monospace',
          lineHeight: '1.6', resize: 'vertical', boxSizing: 'border-box', fontSize: '12px',
        })
        const optStyle = { color: '#12161c', background: '#e9eef6' }

        return h('div', { style: S.card },
          h('div', { style: { fontSize: '13px', marginBottom: '4px' } },
            '画风预设（' + presets.length + ' 套）' + (activeName ? '　当前：' + activeName : '　当前：默认')),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '10px' } },
            '每套可以带自己的画师串、风格词和负面词。点左边圆点选中，生成时就用那套；一套都不选就用下面的默认。'),
          h('div', { style: S.row },
            h('button', { style: buttonStyle, onClick: add }, '➕ 新增一套'),
            h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px' }), onClick: () => save({ activePreset: '' }) }, '不用预设（回默认）'),
          ),
          presets.length ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            presets.map((p, i) => h('div', {
              key: p.id || i,
              style: {
                borderRadius: '10px', padding: '10px 12px',
                border: String(p.id) === active ? '1px solid rgba(106,168,255,.75)' : '1px solid rgba(120,140,170,.22)',
                background: String(p.id) === active ? 'rgba(106,168,255,.1)' : 'rgba(255,255,255,.03)',
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' } },
                h('input', { type: 'radio', name: 'rphub-preset', checked: String(p.id) === active, title: '用这一套', onChange: () => save({ activePreset: String(p.id) }) }),
                h('input', {
                  type: 'text', value: p.name || '', placeholder: '这套叫什么（古风写实 / 二次元厚涂…）',
                  style: Object.assign({}, S.input, { flex: 1, minWidth: '140px' }),
                  onChange: e => patch(i, { name: e.target.value }),
                }),
                h('select', {
                  value: p.position === 'suffix' ? 'suffix' : 'prefix',
                  style: Object.assign({}, S.input, { width: '126px' }),
                  onChange: e => patch(i, { position: e.target.value }),
                  title: '这套词放在提示词的最前还是最后',
                },
                  h('option', { value: 'prefix', style: optStyle }, '放在最前面'),
                  h('option', { value: 'suffix', style: optStyle }, '放在最后面'),
                ),
                h('button', { style: Object.assign({}, buttonStyle, { fontSize: '12px', padding: '3px 10px', borderColor: 'rgba(242,104,107,.6)', color: '#f2686b' }), onClick: () => remove(i) }, '删'),
              ),
              h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginBottom: '4px' } }, '正面：画师串 / 风格词'),
              h('textarea', {
                value: p.artist || '', placeholder: '(@artist_a:1.1), (@artist_b:1.0), masterpiece, best quality',
                style: ta('72px'),
                onChange: e => patch(i, { artist: e.target.value }),
              }),
              h('div', { style: { fontSize: '11px', color: '#9aa3b2', margin: '6px 0 4px' } }, '这套的负面固定词（会并进负面）'),
              h('textarea', {
                value: p.negative || '', placeholder: 'worst quality, low quality, bad hands',
                style: ta('46px'),
                onChange: e => patch(i, { negative: e.target.value }),
              }),
            )),
          ) : h('div', { style: { fontSize: '12px', color: '#9aa3b2', padding: '10px 0' } }, '还没有画风预设。点「➕ 新增一套」开始。'),

          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '14px', borderTop: '1px solid rgba(120,140,170,.2)', paddingTop: '12px', marginBottom: '6px' } }, '没选预设时用的默认值'),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.label, { minWidth: '86px' }) }, '默认画师串'),
            h('input', {
              type: 'text', value: config.styleArtists || '', placeholder: '比如 (@artist_x:1.1), masterpiece',
              style: Object.assign({}, S.input, { flex: 1, minWidth: '180px' }),
              onChange: e => setData(Object.assign({}, data, { config: Object.assign({}, config, { styleArtists: e.target.value }) })),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: Object.assign({}, S.label, { minWidth: '86px' }) }, '默认负面'),
            h('input', {
              type: 'text', value: config.styleNegative || '', placeholder: 'worst quality, low quality',
              style: Object.assign({}, S.input, { flex: 1, minWidth: '180px' }),
              onChange: e => setData(Object.assign({}, data, { config: Object.assign({}, config, { styleNegative: e.target.value }) })),
            }),
            h('button', { style: buttonStyle, onClick: () => save({ styleArtists: config.styleArtists || '', styleNegative: config.styleNegative || '' }) }, '保存'),
          ),
        )
      }

      function PromptPresetCard() {
        const optStyle = { color: '#12161c', background: '#e9eef6' }
        const library = Array.isArray(config.promptPresetLibrary) ? config.promptPresetLibrary : []
        const saved = Array.isArray(config.promptPresets) ? config.promptPresets : []
        const draftStorageKey = 'dsh-tavern-image-prompt-draft-v1'
        const legacyDraftStorageKey = 'dsh-tavern-comfy-prompt-draft-v1'
        const readDraft = () => {
          try {
            const cached = JSON.parse(window.localStorage?.getItem(draftStorageKey) || window.localStorage?.getItem(legacyDraftStorageKey) || 'null')
            return Array.isArray(cached) && cached.length <= 60 ? cached : saved
          } catch { return saved }
        }
        const [draft, setDraftState] = React.useState(readDraft)
        const setDraft = next => {
          const value = typeof next === 'function' ? next(draft) : next
          setDraftState(value)
          try { window.localStorage?.setItem(draftStorageKey, JSON.stringify(value)) } catch {}
        }
        const [importText, setImportText] = React.useState('')
        const [message, setMessage] = React.useState('')
        const [manualPositive, setManualPositive] = React.useState(config.promptManualPositive || '')
        const [manualNegative, setManualNegative] = React.useState(config.promptManualNegative || '')
        const [quality, setQuality] = React.useState(Number(config.jpegQuality || 88))
        const [background, setBackground] = React.useState(config.jpegBackground || '#ffffff')
        const activeId = String(config.activePromptPreset || '')
        const active = library.concat(draft).find(item => String(item.id) === activeId)
        const edit = (i, key, value) => setDraft(draft.map((item, n) => n === i ? Object.assign({}, item, { [key]: value }) : item))
        const addCopy = profile => {
          const next = draft.concat([{ id: 'custom-' + Date.now(), name: (profile?.name || '提示词预设') + ' 副本', positive: profile?.positive || '', negative: profile?.negative || '', enabled: true }])
          setDraft(next); save({ promptPresets: next, activePromptPreset: next[next.length - 1].id }); setMessage('副本已创建，可继续编辑。')
        }
        const addBlank = () => {
          const next = draft.concat([{ id: 'custom-' + Date.now(), name: '自定义提示词', positive: '', negative: '', enabled: true }])
          setDraft(next); save({ promptPresets: next, activePromptPreset: next[next.length - 1].id }); setMessage('已创建空白预设。')
        }
        const importPresets = () => {
          try {
            const parsed = JSON.parse(importText), incoming = Array.isArray(parsed) ? parsed : [parsed]
            if (!incoming.length || incoming.length > 60 || incoming.some(p => !p || typeof p !== 'object' || Array.isArray(p))) throw new Error('需提供 1–60 个预设对象')
            const next = draft.concat(incoming.map((p, i) => Object.assign({}, p, { id: 'import-' + Date.now() + '-' + i }))).slice(0, 60)
            setDraft(next); setImportText(''); setMessage('导入完成，请保存预设。')
          } catch (error) { setMessage('导入失败：' + (error?.message || 'JSON 格式不正确')) }
        }
        const exportPresets = () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }))
          const link = document.createElement('a'); link.href = url; link.download = 'dsh-prompt-presets.json'; link.click(); URL.revokeObjectURL(url)
        }
        const area = height => Object.assign({}, S.input, { width: '100%', minHeight: height, boxSizing: 'border-box', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', lineHeight: '1.5', resize: 'vertical' })
        return h('div', { style: S.card },
          h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '5px' } }, '专业提示词预设'),
          h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginBottom: '9px' } }, '按后端使用标签、自然语言或混合格式；预设包含构图、光线、材质与风格指导。脸部一致性需要参考图，预设本身不保证跨图一致。'),
          h('div', { style: S.row },
            h('label', { style: S.label }, '提示词格式'),
            h('select', { value: config.promptMode || 'auto', style: S.input, onChange: e => save({ promptMode: e.target.value }) },
              h('option', { value: 'auto', style: optStyle }, '自动'), h('option', { value: 'tags', style: optStyle }, '标签'), h('option', { value: 'natural', style: optStyle }, '自然语言'), h('option', { value: 'mixed', style: optStyle }, '混合')),
            h('span', { style: { fontSize: '11px', color: '#9aa3b2' } }, '当前：' + (config.promptEffectiveFormat || 'mixed')),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } }, library.map(profile => h('button', { key: profile.id, style: Object.assign({}, buttonStyle, { borderColor: activeId === profile.id ? '#6aa8ff' : undefined }), onClick: () => save({ activePromptPreset: profile.id }) }, (activeId === profile.id ? '● ' : '○ ') + profile.name))),
          h('div', { style: Object.assign({}, S.row, { marginTop: '7px' }) }, h('button', { style: buttonStyle, disabled: draft.length >= 60, onClick: addBlank }, '新建空白预设'), h('button', { style: buttonStyle, onClick: () => save({ activePromptPreset: '' }) }, '不使用预设')),
          draft.map((p, i) => h('div', { key: p.id || i, style: { padding: '9px', marginTop: '8px', border: '1px solid rgba(120,140,170,.25)', borderRadius: '8px' } },
            h('div', { style: S.row }, h('input', { type: 'radio', name: 'dsh-prompt-preset', checked: activeId === String(p.id), onChange: () => save({ activePromptPreset: String(p.id) }) }), h('input', { value: p.name || '', style: Object.assign({}, S.input, { flex: 1 }), onChange: e => edit(i, 'name', e.target.value) }), h('button', { style: buttonStyle, onClick: () => { const next = draft.filter((_, n) => n !== i); setDraft(next); save({ promptPresets: next, activePromptPreset: activeId === String(p.id) ? '' : activeId }) } }, '删除')),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2', margin: '5px 0 3px' } }, '正面指导'), h('textarea', { 'aria-label': '预设正面指导 ' + (p.name || i + 1), value: p.positive || '', style: area('60px'), onChange: e => edit(i, 'positive', e.target.value) }),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2', margin: '5px 0 3px' } }, '负面指导'), h('textarea', { 'aria-label': '预设负面指导 ' + (p.name || i + 1), value: p.negative || '', style: area('42px'), onChange: e => edit(i, 'negative', e.target.value) }),
          )),
          h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
            h('button', { style: buttonStyle, onClick: () => addCopy(active || library[1]) }, '复制当前预设'),
            h('button', { style: buttonStyle, onClick: async () => {
              const result = await save({ promptPresets: draft })
              if (result) { try { window.localStorage?.removeItem(draftStorageKey) } catch {}; setMessage('预设已保存。') }
              else setMessage('保存失败。')
            } }, '保存预设'),
            h('button', { style: buttonStyle, onClick: exportPresets }, '导出 JSON')),
          h('textarea', { value: importText, placeholder: '粘贴单个预设对象或 JSON 数组', style: Object.assign({}, area('48px'), { marginTop: '7px' }), onChange: e => setImportText(e.target.value) }),
          h('button', { style: Object.assign({}, buttonStyle, { marginTop: '5px' }), onClick: importPresets }, '导入 JSON'),
          active ? h('div', { style: { marginTop: '8px', padding: '8px', background: 'rgba(255,255,255,.035)', borderRadius: '7px', fontSize: '12px' } },
            h('div', { style: { color: '#9aa3b2' } }, '正面预览'), h('div', { style: { whiteSpace: 'pre-wrap' } }, config.promptPreviewPositive || active.positive || ''),
            h('div', { style: { color: '#9aa3b2', marginTop: '5px' } }, '负面预览'), h('div', { style: { whiteSpace: 'pre-wrap' } }, config.promptPreviewNegative || active.negative || '')) : null,
          h('div', { style: { borderTop: '1px solid rgba(120,140,170,.2)', marginTop: '10px', paddingTop: '9px' } },
            h('div', { style: { fontSize: '12px', marginBottom: '4px' } }, '手动提示词覆盖'),
            h('textarea', { value: manualPositive, placeholder: '附加到所有正面提示词', style: area('42px'), onChange: e => setManualPositive(e.target.value) }),
            h('textarea', { value: manualNegative, placeholder: '附加到所有负面提示词', style: Object.assign({}, area('38px'), { marginTop: '4px' }), onChange: e => setManualNegative(e.target.value) }),
            h('button', { style: Object.assign({}, buttonStyle, { marginTop: '5px' }), onClick: () => save({ promptManualPositive: manualPositive, promptManualNegative: manualNegative }) }, '保存手动覆盖')),
          h('div', { style: { borderTop: '1px solid rgba(120,140,170,.2)', marginTop: '10px', paddingTop: '9px' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px' } }, h('input', { type: 'checkbox', checked: config.jpegOutput === true, onChange: e => save({ jpegOutput: e.target.checked }) }), '将 PNG 转为 JPEG（有损压缩）'),
            h('div', { style: S.row }, h('label', { style: S.label }, '质量 50–100'), h('input', { type: 'number', min: 50, max: 100, value: quality, style: Object.assign({}, S.input, { width: '75px' }), onChange: e => setQuality(e.target.value) }), h('label', { style: S.label }, '透明底色'), h('input', { type: 'color', value: background, onChange: e => setBackground(e.target.value) }), h('button', { style: buttonStyle, onClick: () => save({ jpegQuality: quality, jpegBackground: background }) }, '保存')),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2' } }, '仅转换 PNG；GIF/WebP 或转换失败时保留原图并显示提示。')),
          message ? h('div', { style: { fontSize: '12px', marginTop: '7px', color: '#6aa8ff' } }, message) : null,
        )
      }

      // ---- 工作流 ----
      function flowTab() {
        return h('div', null,
          stylePresetCard(),
          h(PromptPresetCard),
          workflowCard(),
        )
      }

      function pluginUpdateTab() {
        const supported = pluginUpdateLocal?.supported === true
        const version = value => value ? String(value) : '暂无结果'
        const restartNeeded = pluginUpdateCheck?.restartRequired === true || pluginUpdateLocal?.restartRequired === true
        const canUpdate = supported && pluginUpdateCheck?.available === true && pluginUpdateCheck?.canUpdate === true && !restartNeeded
        const latestConfirmed = pluginUpdateCheck?.available === false && pluginUpdateCheck?.restartRequired !== true && pluginUpdateCheck?.supported !== false && pluginUpdateLocal?.supported !== false && !pluginUpdateCheck?.reason && !pluginUpdateLocal?.reason
        const migrationNeeded = pluginUpdateLocal?.directoryMigrationRequired === true && pluginUpdateLocal?.supported !== false
        return h('div', null,
          h('div', { style: S.card },
            h('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '8px' } }, '插件更新'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(120px, auto) 1fr', gap: '6px 12px', fontSize: '13px' } },
              h('span', { style: S.label }, '当前版本'), h('span', null, version(pluginUpdateLocal?.currentVersion)),
              h('span', { style: S.label }, '远端版本'), h('span', null, version(pluginUpdateCheck?.latestVersion)),
            ),
            latestConfirmed ? h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '8px' } }, '当前已是最新版本。') : null,
            pluginUpdateLocal?.supported === false ? h('a', { href: 'https://github.com/weixinlll/dsh-tavern-image', target: '_blank', rel: 'noopener noreferrer', style: { display: 'inline-block', marginTop: '8px', color: '#8bb8ff' } }, '打开插件 GitHub 页面手动下载') : null,
            h('div', { style: S.row },
              h('button', { style: buttonStyle, disabled: !supported || Boolean(pluginUpdatePending), onClick: () => { setPluginUpdateCheck(null); void checkPluginUpdate() } }, pluginUpdatePending === 'check' ? '正在检查…' : '检查更新'),
              h('button', { style: buttonStyle, disabled: !canUpdate || Boolean(pluginUpdatePending), onClick: applyPluginUpdate }, pluginUpdatePending === 'apply' ? '正在更新…' : '更新插件'),
              !pluginUpdateLocal && pluginUpdatePending !== 'local' ? h('button', { style: buttonStyle, disabled: Boolean(pluginUpdatePending), onClick: () => { pluginUpdateLocalAttempted.current = true; void loadPluginUpdateLocal() } }, '重试读取本地状态') : null,
            ),
            h('div', { role: 'status', 'aria-live': 'polite', style: { minHeight: '18px', fontSize: '12px', color: restartNeeded || migrationNeeded ? '#f0b45c' : '#9aa3b2', marginTop: '8px' } },
              pluginUpdateNote || (pluginUpdatePending === 'local' ? '读取本地插件状态…' : ''),
            ),
            migrationNeeded ? h('div', { role: 'note', style: { fontSize: '12px', color: '#f0b45c', marginTop: '8px', lineHeight: 1.55 } }, pluginUpdateLocal.directoryMigrationMessage) : null,
            h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '8px', lineHeight: 1.55 } }, '只更新插件代码；配置和人物库会保留。更新完成后请完整重启 DSH 才会生效。'),
          ),
        )
      }

      const tabs = [['plan', '生图规划'], ['people', '人物库'], ['gallery', '历史图'], ['worldbook', '世界书'], ['flow', '画风'], ['plugin-update', '插件更新']]
      return h('div', { style: Object.assign({}, S.surface, { padding: '4px 2px 20px', fontSize: '13px' }) },
        h(SetupGuide),
        head,
        h(ManualCard),
        taskPanel(),
        h('div', { style: S.row }, tabs.map(([key, label]) => h('button', { key, style: S.tab(tab === key), onClick: () => setTab(key) }, label))),
        tab === 'plan' ? planTab() : null,
        tab === 'people' ? peopleTab() : null,
        tab === 'flow' ? flowTab() : null,
        tab === 'gallery' ? galleryTab() : null,
        tab === 'worldbook' ? worldbookTab() : null,
        tab === 'plugin-update' ? pluginUpdateTab() : null,
        h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '14px' } }, '人物与服装修改后请点「保存人物库」。'),
        wfGraphFile ? h(WorkflowGraphEditor, { file: wfGraphFile, post, onClose: () => setWfGraphFile(''), onSaved: () => { void openWorkflow(wfGraphFile, true) } }) : null,
      )
    }
    // ─────────────────────────────────────────────────────────────
    // 控制台浮层：把整套设置界面搬到「主窗口」显示
    // DSH 的「设置」是独立渲染上下文，访问 127.0.0.1 会被拒（fetch/XHR 都失败），
    // 所以设置页里的面板读不到数据；主窗口正常，这里提供一个等效入口。
    // ─────────────────────────────────────────────────────────────
    function ConsoleOverlay() {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        const onOpen = () => setOpen(true)
        const onKey = event => { if (event.key === 'Escape') setOpen(false) }
        try {
          window.addEventListener('dsh-tavern-image:open-console', onOpen)
          window.addEventListener('keydown', onKey)
        } catch {}
        return () => {
          try {
            window.removeEventListener('dsh-tavern-image:open-console', onOpen)
            window.removeEventListener('keydown', onKey)
          } catch {}
        }
      }, [])
      // 收起时不渲染任何东西：入口在左侧栏底部（见 ConsoleLauncher），
      // 不再在右下角浮一个常驻按钮 —— 那个位置会盖住正文和面板。
      if (!open) return null
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 2147483100,
          background: 'rgba(6,9,14,.86)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: '18px',
        },
        onClick: event => { if (event.target === event.currentTarget) setOpen(false) },
      }, h('div', {
        style: {
          width: 'min(1180px, 96vw)', height: 'min(86vh, 900px)', overflow: 'auto',
          background: '#0f131a', color: '#e8edf5', border: '1px solid rgba(255,255,255,.18)',
          borderRadius: '14px', padding: '16px',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
          h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '🎨 本地生图控制台'),
          h('button', {
            style: { background: 'transparent', color: '#dfe4ec', border: '1px solid rgba(255,255,255,.2)', borderRadius: '8px', padding: '4px 12px', cursor: 'pointer' },
            onClick: () => setOpen(false),
          }, '关闭 ✕'),
        ),
        h(SettingsPanel),
      ))
    }

    /**
     * 侧栏底部的入口按钮 —— 和「卡片更新器」「错题库」排在一起（sidebar.footer.action，
     * 即"设置"按钮旁边的动作区）。窄栏（56px 轨道，wide=false）时只留图标。
     */
    function ConsoleLauncher(props) {
      const wide = props?.wide !== false
      const [hover, setHover] = React.useState(false)
      const open = () => { try { window.dispatchEvent(new CustomEvent('dsh-tavern-image:open-console')) } catch {} }
      return h('button', {
        type: 'button',
        title: '本地生图控制台（人物库 / 历史图 / 世界书 / 画风）',
        'aria-label': '本地生图',
        onClick: open,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', alignItems: 'center', gap: '8px',
          justifyContent: wide ? 'flex-start' : 'center',
          width: '100%', margin: '2px 0',
          background: hover ? 'rgba(255,255,255,.07)' : 'transparent',
          border: 'none', color: 'inherit', cursor: 'pointer',
          padding: wide ? '8px 10px' : '8px 0', borderRadius: '8px',
          fontSize: '13px', textAlign: 'left',
        },
      },
        h('span', { style: { fontSize: '15px', lineHeight: 1 } }, '🎨'),
        wide ? h('span', null, '本地生图') : null,
      )
    }

    function apply(ctx) {
      // 诊断：证明 apply 被调到，并看清 ctx 上到底有什么
      try {
        let keys = null
        try { keys = Object.keys(ctx ?? {}).slice(0, 40) } catch { keys = null }
        // 只探测公开服务。不再去问 Tavern 的补丁服务在不在 —— 补丁方案已废弃，
        // 那个字段既没有意义，也把插件和 Tavern 的内部实现绑在一起。
        let hasTavernUi = null
        try { hasTavernUi = Boolean(ctx && typeof ctx.get === 'function' && ctx.get('tavernUi')) } catch { hasTavernUi = 'threw' }
        reportHost('apply-start', {
          hasSlots: Boolean(ctx && ctx.slots),
          hasGet: Boolean(ctx && typeof ctx.get === 'function'),
          hasEffect: Boolean(ctx && typeof ctx.effect === 'function'),
          hasTavernUi,
          ctxKeys: keys,
        })
      } catch (error) { reportHost('apply-report-failed', { message: String(error && error.message) }) }
      try {
        // 默认：标记通道按配置走；规划通道读不到配置就先不开（免得每轮白跑一次模型）
        // 默认先按「开」处理：渲染器可能在配置读回来之前就被调用，第一次太保守会整条消息都不接管
        const settings = { autoImageGen: true, plannerEnabled: true, smartImageSelection: true }
        jsonFetch(`${BASE}/state`).then(state => {
          if (state?.config) {
            settings.autoImageGen = state.config.autoImageGen !== false
            settings.plannerEnabled = state.config.plannerEnabled !== false
            settings.smartImageSelection = state.config.smartImageSelection !== false
          }
        }).catch(() => { /* 拿不到配置就安静退化成只在有标记时出图 */ })

        // ★ 控制台浮层（主窗口，网络可用）
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-console',
            order: 95,
          }, ConsoleOverlay))
          reportHost('seat-registered', { seat: 'shell.overlay.console' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'shell.overlay.console', error: String(error?.message ?? error).slice(0, 120) })
        }

        // ★ 侧栏底部入口：和「卡片更新器」「错题库」并排（设置按钮旁边那一排）
        try {
          ctx.slots?.inject?.('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-tavern-image-launcher',
            order: 48,
            label: '本地生图',
          }, ConsoleLauncher))
          reportHost('seat-registered', { seat: 'sidebar.footer.action' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'sidebar.footer.action', error: String(error?.message ?? error).slice(0, 120) })
        }

        // 全屏看图浮层
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-overlay',
            order: 90,
          }, ImageOverlay))
          reportHost('seat-registered', { seat: 'shell.overlay' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'shell.overlay', error: String(error?.message ?? error) })
        }

        // 提示词编辑浮层（长按图片打开）
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-prompt-editor',
            order: 91,
          }, PromptEditor))
          reportHost('seat-registered', { seat: 'shell.overlay.prompt-editor' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'prompt-editor', error: String(error?.message ?? error) })
        }


        // 卡片选择弹窗
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-cardpicker',
            order: 93,
          }, CardPicker))
          reportHost('seat-registered', { seat: 'shell.overlay.cardpicker' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'cardpicker', error: String(error?.message ?? error) })
        }

        // 浮层提示
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-toast',
            order: 99,
          }, Toast))
          reportHost('seat-registered', { seat: 'shell.overlay.toast' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'toast', error: String(error?.message ?? error) })
        }

        // 右键菜单
        try {
          ctx.slots?.inject?.('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-tavern-image-contextmenu',
            order: 100,
          }, ContextMenu))
          reportHost('seat-registered', { seat: 'shell.overlay.contextmenu' })
        } catch (error) {
          reportHost('seat-failed', { seat: 'design', error: String(error?.message ?? error) })
        }

        // 助手消息下方的动作（和 Tavern 的分叉、场景生图同一排）
        try {
          const ok = ctx.slots?.inject?.('conversation.chat.assistant-actions', () => ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'dsh-tavern-image',
            order: 30,
            inject: (sessionId) => ({ sessionId }),
          }, ImageActionButton))
          reportHost('seat-registered', { seat: 'assistant-actions', injectReturned: ok !== undefined })
        } catch (error) {
          reportHost('seat-failed', { seat: 'assistant-actions', error: String(error?.message ?? error) })
          console.warn('[dsh-tavern-image] 生图按钮未注册:', error?.message)
        }

        // 设置 → 本地生图（与「错题库」「卡片更新器」同一层）
        try {
          reportHost('seat-registered', { seat: 'settings.section' })
          ctx.slots?.inject?.('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-tavern-image',
            order: 47,
            label: () => '本地生图',
          }, SettingsPanel))
        } catch (error) {
          console.warn('[dsh-tavern-image] 设置页面未注册:', error?.message)
        }

        // ===== Tavern 官方浏览器接口（tavernUi，接口版本 1）=====
        // 以前这里是打在 Tavern 上的补丁造出来的 tavernAssistantTextRenderer / registerActions，
        // Tavern 一更新补丁被冲掉，正文里的图和按钮就会一起消失。
        // 现在全部走正门：
        //   · 正文 —— 不再接管，交回 Tavern 原生渲染
        //   · 图   —— 由宿主侧用 tavern.attach 挂到正文的挂载句后面（Tavern 自己渲染、自己管版本）
        //   · 按钮 —— tavernUi.registerMessageAction
        ctx.inject?.(['tavernUi'], owner => {
          const ui = owner.tavernUi
          if (!ui || ui.apiVersion < 1) {
            reportHost('tavernui-missing', { got: Boolean(ui) })
            try { console.warn('[dsh-tavern-image] 当前 Tavern 没有 tavernUi 接口，生图按钮不可用') } catch {}
            return
          }
          reportHost('tavernui-attached', { apiVersion: ui.apiVersion })
          if (ui.apiVersion >= 2 && typeof ui.registerPanel === 'function') {
            function CharacterHistoryPanel({ gameId }) {
              const [history, setHistory] = React.useState({ loading: true, snapshot: null })
              const [busy, setBusy] = React.useState(false)
              const [notice, setNotice] = React.useState('')
              const requestEpoch = React.useRef(null)
              if (!requestEpoch.current) requestEpoch.current = createHistoryRequestEpoch()
              requestEpoch.current.activate(gameId)
              React.useEffect(() => { setBusy(false); setNotice('') }, [gameId])
              const refresh = React.useCallback(async () => {
                if (!requestEpoch.current.isActive(gameId)) return
                if (!gameId) { setHistory({ loading: false, snapshot: null, loadedGameId: '' }); return }
                const token = requestEpoch.current.begin(gameId)
                setHistory(current => Object.assign({}, current, { loading: true }))
                try {
                  const result = await jsonFetch(BASE + '/character-history?gameId=' + encodeURIComponent(gameId))
                  if (requestEpoch.current.isCurrent(gameId, token)) setHistory(Object.assign({}, result, { loading: false, loadedGameId: gameId }))
                } catch (error) {
                  if (requestEpoch.current.isCurrent(gameId, token)) setHistory({ loading: false, error: String(error?.message ?? error), loadedGameId: gameId })
                }
              }, [gameId])
              React.useEffect(() => {
                void refresh()
                return () => requestEpoch.current.invalidate(gameId)
              }, [refresh, gameId])
              const historyMatchesGame = history.loadedGameId === String(gameId ?? '')
              const canRestore = historyMatchesGame && Number(history.currentTurn) > 0
              const restore = async (index, expectedChange) => {
                if (!canRestore || !requestEpoch.current.isActive(gameId)) return
                const gameToken = requestEpoch.current.captureGame(gameId)
                requestEpoch.current.begin(gameId)
                setBusy(true); setNotice('')
                try {
                  await jsonFetch(BASE + '/character-history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId, changeIndex: index, expectedChange }) })
                  if (!requestEpoch.current.isGameCurrent(gameId, gameToken)) return
                  setNotice('已在当前正文版本记录恢复结果。')
                  await refresh()
                } catch (error) {
                  if (requestEpoch.current.isGameCurrent(gameId, gameToken)) setNotice(String(error?.message ?? error))
                } finally {
                  if (requestEpoch.current.isGameCurrent(gameId, gameToken)) setBusy(false)
                }
              }
              if (history.loading || !historyMatchesGame) return h('div', { style: { padding: '16px', color: '#9aa3b2' } }, '正在读取当前剧情线的角色历史…')
              if (history.available === false) return h('div', { style: { padding: '16px', color: '#9aa3b2', lineHeight: 1.6 } }, history.reason || '角色历史需要 Tavern 插件接口 v2。')
              const changes = Array.isArray(history.snapshot?.changes) ? history.snapshot.changes : []
              return h('div', { style: { padding: '14px', color: '#e8edf5', overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '12px' } },
                  h('div', null,
                    h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '角色视觉历史'),
                    h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '4px' } }, '当前剧情线 · 最新快照' + (history.turn ? ' · 第 ' + history.turn + ' 轮' : '')),
                  ),
                  h('button', { type: 'button', onClick: refresh, style: { background: 'transparent', color: 'inherit', border: '1px solid rgba(255,255,255,.2)', borderRadius: '7px', padding: '5px 9px', cursor: 'pointer' } }, '刷新'),
                ),
                notice ? h('div', { role: 'status', style: { padding: '8px', marginBottom: '10px', borderRadius: '7px', background: 'rgba(84,198,235,.1)', color: '#bfeafa', fontSize: '12px' } }, notice) : null,
                history.error ? h('div', { role: 'alert', style: { color: '#ff9b9b', fontSize: '12px' } }, history.error) : null,
                !canRestore ? h('div', { style: { padding: '8px', marginBottom: '10px', borderRadius: '7px', background: 'rgba(255,212,128,.08)', color: '#ffd480', fontSize: '12px', lineHeight: 1.5 } }, '请先完成一轮结算或点击当前消息的生图按钮，确认轮次后再恢复。') : null,
                !changes.length ? h('div', { style: { color: '#9aa3b2', fontSize: '12px', lineHeight: 1.6 } }, '当前剧情线还没有明确的永久外貌变化记录。') : indexedHistoryChanges(changes).map(({ change, index }) => {
                  return h('article', { key: change.id + ':' + change.turn + ':' + index, style: { padding: '10px', marginBottom: '8px', border: '1px solid rgba(255,255,255,.12)', borderRadius: '9px', background: 'rgba(255,255,255,.025)' } },
                    h('div', { style: { fontSize: '12px', fontWeight: 600 } }, (change.name || '角色') + ' · ' + (change.field || '外貌') + ' · 第 ' + (change.turn || '?') + ' 轮'),
                    change.before ? h('div', { style: { fontSize: '12px', color: '#9aa3b2', marginTop: '6px' } }, '之前：' + change.before) : null,
                    h('div', { style: { fontSize: '12px', marginTop: '5px' } }, '之后：' + (change.after || '已清除')),
                    h('div', { style: { fontSize: '11px', color: '#9aa3b2', marginTop: '6px', lineHeight: 1.5 } }, (change.reason || '剧情明确变化') + (change.at ? ' · ' + new Date(change.at).toLocaleString() : '')),
                    h('button', { type: 'button', disabled: busy || !canRestore, onClick: () => restore(index, change), style: { marginTop: '8px', background: 'transparent', color: '#bfeafa', border: '1px solid rgba(84,198,235,.35)', borderRadius: '7px', padding: '5px 9px', cursor: busy || !canRestore ? 'default' : 'pointer', opacity: busy || !canRestore ? .45 : 1 } }, '恢复到变化前'),
                  )
                }),
                history.snapshot?.warning ? h('div', { style: { marginTop: '10px', color: '#ffd480', fontSize: '11px' } }, history.snapshot.warning) : null,
              )
            }
            try {
              const off = ui.registerPanel({ id: 'character-history', title: '角色历史', render: ({ gameId }) => h(CharacterHistoryPanel, { gameId }) })
              owner.effect?.(() => off, 'dsh-tavern-image: character history panel')
            } catch (error) { reportHost('character-history-panel-failed', { error: String(error?.message ?? error).slice(0, 160) }) }
          }
          try {
            const off = ui.registerMessageAction({
              id: 'dsh-tavern-image-draw',
              label: '🎨 生图',
              when: context => Boolean(context && context.gameId) && Number(context.turn) > 0,
              run: async context => {
                const r = await jsonFetch(BASE + '/attach-turn', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ gameId: context.gameId, turn: context.turn }),
                }).catch(error => ({ ok: false, error: String(error && error.message || error) }))
                reportHost('attach-turn', {
                  gameId: String(context && context.gameId || '').slice(0, 12), turn: context && context.turn,
                  ok: Boolean(r && r.ok), attached: r && r.attached, error: String(r && r.error || '').slice(0, 160),
                })
                if (typeof showToast === 'function') {
                  if (r && r.ok && r.attached) {
                    showToast('已提交 ' + r.attached + ' 张，出图后自动插进正文')
                  } else if (r && r.ok && r.skipped) {
                    showToast('本轮自动跳过配图：' + (r.reason || '没有合适的画面'))
                  } else {
                    showToast('生图没出画面：' + ((r && r.error) || '规划没有产出画面'))
                  }
                }
              },
            })
            owner.effect?.(() => off, 'dsh-tavern-image: message action')

          // 正文里的 image###英文Tag### 标记：就地画一张图。
          // 自动配图走的是宿主侧 tavern.attach（Tavern 自己渲染、跟正文版本绑定）；
          // 这一条是"模型自己在正文里写了标记"时的通道，两条互不干扰。
          try {
            const offMarker = ui.registerTextMarker({
              // 传一份**新的**正则实例：IMAGE_TAG 带 /g，共享同一个对象时 lastIndex
              // 会被上一次匹配带着走，容易漏掉标记。
              pattern: new RegExp(IMAGE_TAG.source, IMAGE_TAG.flags),
              render: ({ groups, gameId, turn, streaming }) => {
                try {
                  if (streaming) return null            // 生成中不画，免得画出半句话
                  if (settings.smartImageSelection) return h('span', { style: { display: 'none' } })
                  const prompt = String((groups && groups[0]) || '').trim()
                  if (!prompt) return null
                  return h(InlineImage, {
                    prompt,
                    imageKey: contentKey(String(gameId || ''), turn, 0, prompt),
                    auto: true,
                  })
                } catch (error) {
                  reportHost('marker-render-failed', { message: String(error && error.message || error).slice(0, 200) })
                  return null
                }
              },
            })
            owner.effect?.(() => offMarker, 'dsh-tavern-image: text marker')
            reportHost('tavernui-marker-registered', { ok: true })

          // 给自己的媒体类型定显示方式：大图 + 点开放大 + 右键/长按改提示词重画
          for (const mediaKind of ['dsh-tavern-image/image', 'dsh-tavern-comfy/image']) {
            try {
              const offMedia = ui.registerMediaRenderer(mediaKind, args => h(OfficialImage, { item: args && args.item }))
              owner.effect?.(() => offMedia, 'dsh-tavern-image: media renderer ' + mediaKind)
              reportHost('tavernui-media-registered', { ok: true, mediaKind })
            } catch (error) {
              reportHost('tavernui-media-failed', { mediaKind, message: String(error && error.message || error).slice(0, 200) })
            }
          }
          } catch (error) {
            reportHost('tavernui-marker-failed', { message: String(error && error.message || error).slice(0, 200) })
          }
          } catch (error) {
            reportHost('tavernui-action-failed', { message: String(error && error.message || error).slice(0, 200) })
          }
        })
      } catch (error) {
        console.warn('[dsh-tavern-image] 浏览器半边启动失败:', error?.message)
      }
    }

    exports.name = 'dsh-tavern-image'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
