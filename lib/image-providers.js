import { inflateRawSync } from 'node:zlib'

const DEFAULT_MAX = 32 * 1024 * 1024
const DEFAULT_TIMEOUT = 300_000
const PROVIDERS = {
  novelai: ['NovelAI / 同协议第三方', 'https://image.novelai.net', 'nai-diffusion-4-5-full'],
  openai: ['OpenAI / Images 兼容中转', 'https://api.openai.com/v1', 'gpt-image-2.5-flare'],
  gemini: ['Google Gemini 原生', 'https://generativelanguage.googleapis.com/v1', 'gemini-3.1-flash-image'],
  'gemini-chat': ['Banana / Gemini 聊天兼容中转', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash-image'],
  grok: ['Grok Images', 'https://api.x.ai/v1', 'grok-imagine-image-2.0'],
  seedream: ['Seedream / 火山方舟', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-5-0-pro-260628'],
  qwen: ['百炼 Qwen-Image', 'https://dashscope-intl.aliyuncs.com/api/v1', 'qwen-image-3.0'],
  sdwebui: ['Stable Diffusion WebUI / Forge', 'http://127.0.0.1:7860', '']
}

export const IMAGE_PROVIDERS = Object.entries(PROVIDERS).map(([id, [label, baseUrl, model]]) => ({ id, label, baseUrl, model }))

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const secretValues = channel => [channel?.apiKey, channel?.password].filter(Boolean).map(String)
function redact(text, channel) {
  let out = String(text ?? '').replace(/[\r\n\t]+/g, ' ')
  const secrets = secretValues(channel).flatMap(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]')
  return out.slice(0, 500)
}
function validateBase(channel) {
  let url
  try { url = new URL(channel?.baseUrl || PROVIDERS[channel?.provider]?.[1]) } catch { throw new Error('生图渠道地址必须是完整的 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('生图渠道地址必须是干净的 HTTP(S) 服务地址')
  return url.href.replace(/\/+$/, '')
}
function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path) || String(path).startsWith('//')) throw new Error('接口路径必须是相对路径')
  return `${base.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
}
function checkedRemoteUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('服务返回了无效的图片地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('服务返回了不安全的图片地址')
  return url.href
}
function authHeaders(channel, json = true) {
  const headers = json ? { 'content-type': 'application/json' } : {}
  if (channel.authMode === 'none') return headers
  if (channel.authMode === 'basic') {
    if (channel.username || channel.password) headers.authorization = `Basic ${Buffer.from(`${channel.username || ''}:${channel.password || ''}`).toString('base64')}`
    return headers
  }
  if (channel.apiKey) headers.authorization = `Bearer ${channel.apiKey}`
  return headers
}
function requestHeaders(channel, provider) {
  const headers = authHeaders(channel)
  if (provider === 'gemini' && channel.authMode !== 'none' && channel.authMode !== 'basic' && channel.apiKey) {
    delete headers.authorization
    headers['x-goog-api-key'] = channel.apiKey
  }
  return headers
}
function bounded(value, min = 1, max = DEFAULT_MAX) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : max
}
function clampedNumber(value, min, max, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}
function imageType(bytes, declared = '') {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (declared && imageTypes.has(declared.toLowerCase().split(';')[0].trim())) throw new Error('服务返回的数据不是有效图片')
  throw new Error('服务没有返回受支持的图片格式')
}
async function readLimited(response, limit) {
  const size = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(size) && size > limit) throw new Error('服务响应超过允许大小')
  const reader = response.body?.getReader?.()
  if (reader) {
    const parts = []; let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) { await reader.cancel().catch(() => {}); throw new Error('服务响应超过允许大小') }
        parts.push(Buffer.from(value))
      }
    } finally { reader.releaseLock?.() }
    return Buffer.concat(parts, total)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > limit) throw new Error('服务响应超过允许大小')
  return data
}
function abortScope(signal, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
  timer.unref?.()
  return { signal: controller.signal, close() { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
}
async function fetchBytes(fetchImpl, url, init, max, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  if (!response.ok) {
    const raw = await readLimited(response, Math.min(max, 64 * 1024)).catch(() => Buffer.alloc(0))
    let message = raw.toString('utf8')
    try { const j = JSON.parse(message); message = j.error?.message || j.message || j.detail || message } catch {}
    throw new Error(`生图服务 HTTP ${response.status}${message ? `：${redact(message, channel)}` : ''}`)
  }
  const bytes = await readLimited(response, max)
  const type = imageType(bytes, response.headers?.get?.('content-type') || '')
  return { bytes, mediaType: type }
}
async function fetchJson(fetchImpl, url, init, limit, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  const bytes = await readLimited(response, limit)
  if (!response.ok) {
    let message = bytes.toString('utf8')
    try { const j = JSON.parse(message); message = j.error?.message || j.message || j.detail || message } catch {}
    throw new Error(`生图服务 HTTP ${response.status}${message ? `：${redact(message, channel)}` : ''}`)
  }
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('生图服务返回了无效 JSON') }
}
function combinedPrompt(request) {
  const prompt = String(request.positive ?? '').trim()
  const negative = String(request.negative ?? '').trim()
  return negative ? `${prompt}\n\nAvoid: ${negative}` : prompt
}
function dims(request) {
  const width = bounded(request.width ?? 1024, 64, 8192), height = bounded(request.height ?? 1024, 64, 8192)
  return { width, height }
}
function option(channel, name, fallback) {
  const value = channel.options?.[name]
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) ? fallback : value
}
function findImage(value, max) {
  if (typeof value !== 'string' || !value) return null
  const data = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/i)
  if (data) return decodeBase64(data[2], max, data[1])
  const md = value.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)
  if (md) return { url: md[1] }
  const embedded = value.match(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+/i)
  if (embedded) return findImage(embedded[0], max)
  if (/^https?:\/\//i.test(value)) return { url: value }
  if (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value) && value.length > 100) return decodeBase64(value, max)
  return null
}
async function fetchRaw(fetchImpl, url, init, max, signal, channel) {
  const response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  if (!response.ok) {
    const raw = await readLimited(response, Math.min(max, 64 * 1024)).catch(() => Buffer.alloc(0))
    throw new Error(`生图服务 HTTP ${response.status}${raw.length ? `：${redact(raw.toString('utf8'), channel)}` : ''}`)
  }
  return readLimited(response, max)
}
function decodeBase64(value, max, declared = '') {
  const clean = String(value).replace(/\s/g, '')
  if (clean.length > Math.ceil(max * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) throw new Error('服务返回的图片编码无效或过大')
  const bytes = Buffer.from(clean, 'base64')
  if (!bytes.length || bytes.length > max) throw new Error('服务返回的图片超过允许大小')
  return { bytes, mediaType: imageType(bytes, declared) }
}
async function fromDataObject(data, fetchImpl, max, signal, channel) {
  const item = Array.isArray(data) ? data[0] : data
  if (!item) throw new Error('生图服务没有返回图片')
  for (const key of ['b64_json', 'base64', 'image', 'data']) {
    if (typeof item[key] === 'string' && !/^https?:\/\//.test(item[key])) return decodeBase64(item[key], max, item.mime_type || item.mimeType || '')
  }
  const url = item.url || item.image_url?.url || item.image_url
  if (url) return fetchBytes(fetchImpl, checkedRemoteUrl(url), { method: 'GET', headers: {} }, max, signal, channel)
  throw new Error('生图服务没有返回可用图片数据')
}
function zipImage(bytes, max) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('NovelAI 返回了无效 ZIP 图片')
  let eocd = -1
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 22; i++) if (bytes.readUInt32LE(i) === 0x06054b50) eocd = i
  if (eocd < 0) throw new Error('NovelAI ZIP 缺少目录')
  const count = bytes.readUInt16LE(eocd + 10), offset = bytes.readUInt32LE(eocd + 16)
  let cursor = offset
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('NovelAI ZIP 目录无效')
    const method = bytes.readUInt16LE(cursor + 10), packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24)
    const nameLen = bytes.readUInt16LE(cursor + 28), extraLen = bytes.readUInt16LE(cursor + 30), commentLen = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
      if (unpacked > max || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('NovelAI 图片超过允许大小或 ZIP 无效')
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      if (start + packed > bytes.length) throw new Error('NovelAI ZIP 图片数据损坏')
      let output
      try { output = method === 0 ? bytes.subarray(start, start + packed) : method === 8 ? inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: max }) : null } catch { throw new Error('NovelAI ZIP 图片无法解压') }
      if (!output) throw new Error('NovelAI ZIP 使用了不支持的压缩格式')
      if (output.length > max || (unpacked && output.length !== unpacked)) throw new Error('NovelAI ZIP 图片大小校验失败')
      const image = Buffer.from(output)
      return { bytes: image, mediaType: imageType(image) }
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('NovelAI ZIP 中没有图片')
}
function endpointFromOption(channel, key, fallback) { return String(option(channel, key, fallback)) }

async function generateNovelai(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch } = ctx
  const { width, height } = requestedDims(ch, request)
  const positive = String(request.positive || ''), negative = String(request.negative || '')
  const payload = { input: String(request.positive || ''), model: ch.model || PROVIDERS.novelai[2], action: 'generate', parameters: {
    width, height, seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : Math.floor(Math.random() * 2 ** 32),
    steps: bounded(request.steps ?? option(ch, 'steps', 28), 1, 100), scale: clampedNumber(request.cfg ?? option(ch, 'cfg', option(ch, 'scale', 5)), 0, 30, 5), n_samples: 1,
    negative_prompt: negative, sampler: option(ch, 'sampler', 'k_euler_ancestral'), noise_schedule: option(ch, 'noiseSchedule', 'karras'),
    qualityToggle: true, ucPreset: 3, sm: false, dynamic_thresholding: false, params_version: 3,
    v4_prompt: { caption: { base_caption: positive, char_captions: [] }, use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false },
    add_original_image: true, legacy: false, legacy_uc: false, controlnet_strength: 1
  } }
  const bytes = await fetchRaw(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/ai/generate-image')), { method: 'POST', headers: requestHeaders(ch, 'novelai'), body: JSON.stringify(payload) }, Math.min(max + 1024 * 1024, 129 * 1024 * 1024), signal, ch)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return zipImage(bytes, max)
  return { bytes, mediaType: imageType(bytes) }
}

async function generateOpenai(channel, request, ctx, provider) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = requestedDims(ch, request)
  const path = endpointFromOption(ch, 'generatePath', '/images/generations')
  const orientationSize = width > height * 1.15 ? '1536x1024' : height > width * 1.15 ? '1024x1536' : '1024x1024'
  const size = provider === 'seedream' ? option(ch, 'size', '2K') : option(ch, 'size', orientationSize)
  const payload = { model: ch.model || PROVIDERS[provider][2], prompt: combinedPrompt(request), size, n: 1 }
  if (provider === 'openai') {
    if (payload.model.startsWith('gpt-image-')) {
      payload.quality = option(ch, 'quality', 'medium')
      payload.output_format = option(ch, 'outputFormat', 'png')
    }
  }
  if (provider === 'grok') delete payload.size
  const data = await fetchJson(fetchImpl, joinUrl(base, path), { method: 'POST', headers: requestHeaders(ch, provider), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  return fromDataObject(data.data, fetchImpl, max, signal, ch)
}

async function generateGemini(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const model = encodeURIComponent(ch.model || PROVIDERS.gemini[2])
  const { width, height } = dims(request)
  const ratio = option(ch, 'aspectRatio', closestRatio(width, height))
  let imageSize = option(ch, 'imageSize', option(ch, 'size', sizeLabel(width, height)))
  const sizePixels = String(imageSize).match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  if (sizePixels) imageSize = sizeLabel(Number(sizePixels[1]), Number(sizePixels[2]))
  const payload = { contents: [{ parts: [{ text: combinedPrompt(request) }] }], generationConfig: {
    responseModalities: ['IMAGE'], responseFormat: { image: { aspectRatio: ratio, imageSize } }
  } }
  const data = await fetchJson(fetchImpl, joinUrl(base, `/models/${model}:generateContent`), { method: 'POST', headers: requestHeaders(ch, 'gemini'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  const parts = data.candidates?.flatMap(candidate => candidate.content?.parts || []) || []
  for (const part of parts) if (part.inlineData?.data || part.inline_data?.data) {
    const blob = part.inlineData || part.inline_data
    return decodeBase64(blob.data, max, blob.mimeType || blob.mime_type || '')
  }
  throw new Error('Gemini 没有返回图片内容')
}
function closestRatio(w, h) {
  const ratios = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9']
  return ratios.reduce((best, ratio) => Math.abs(Math.log(w / h / ratio.split(':').map(Number).reduce((a, b) => a / b))) < Math.abs(Math.log(w / h / best.split(':').map(Number).reduce((a, b) => a / b))) ? ratio : best, ratios[0])
}
function sizeLabel(w, h) { const pixels = w * h; return pixels > 7_000_000 ? '4K' : pixels > 2_000_000 ? '2K' : '1K' }
function requestedDims(channel, request) {
  let { width, height } = dims(request)
  const rawSize = String(option(channel, 'size', '')).trim()
  const match = rawSize.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i)
  if (match) { width = bounded(match[1], 64, 8192); height = bounded(match[2], 64, 8192) }
  else {
    const tier = rawSize.match(/^(1|1\.5|2|4)\s*k$/i)
    if (tier) width = height = Number(tier[1]) * 1024
  }
  const ratio = String(option(channel, 'aspectRatio', '')).trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (ratio) {
    const area = width * height, value = Number(ratio[1]) / Number(ratio[2])
    if (value > 0 && Number.isFinite(value)) {
      const unit = channel.provider === 'sdwebui' ? 8 : 64
      width = Math.max(64, Math.round(Math.sqrt(area * value) / unit) * unit)
      height = Math.max(64, Math.round(Math.sqrt(area / value) / unit) * unit)
    }
  }
  return { width, height }
}
async function generateGeminiChat(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const payload = { model: ch.model || PROVIDERS['gemini-chat'][2], messages: [{ role: 'user', content: combinedPrompt(request) }], n: 1 }
  const data = await fetchJson(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/chat/completions')), { method: 'POST', headers: requestHeaders(ch, 'gemini-chat'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  const message = data.choices?.[0]?.message || data
  const contents = [message.content, ...(Array.isArray(message.images) ? message.images.map(x => x.image_url?.url || x.url || x) : [])]
  for (const content of contents) {
    const parts = Array.isArray(content) ? content : [content]
    for (const part of parts) {
      const value = typeof part === 'string' ? part : (part.image_url?.url || part.url || part.text || part.image?.url || '')
      const found = findImage(value, max)
      if (found?.bytes) return found
      if (found?.url) return fetchBytes(fetchImpl, checkedRemoteUrl(found.url), { method: 'GET', headers: {} }, max, signal, ch)
    }
  }
  throw new Error('聊天兼容服务没有返回图片或图片地址')
}
async function generateQwen(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = dims(request)
  const legacyAsync = option(ch, 'apiMode', 'sync') === 'async'
  const payload = legacyAsync ? {
    model: ch.model || 'wanx-v1', input: { prompt: String(request.positive || '') }, parameters: { negative_prompt: String(request.negative || ''), size: `${width}*${height}`, n: 1 }
  } : {
    model: ch.model || PROVIDERS.qwen[2], input: { messages: [{ role: 'user', content: [{ text: String(request.positive || '') }] }] }, parameters: {
      negative_prompt: String(request.negative || ''), size: `${width}*${height}`, n: 1,
      ...(Number.isFinite(Number(request.seed)) ? { seed: ((Math.trunc(Number(request.seed)) % 2147483648) + 2147483648) % 2147483648 } : {})
    }
  }
  const path = endpointFromOption(ch, 'generatePath', legacyAsync ? '/services/aigc/text2image/image-synthesis' : '/services/aigc/multimodal-generation/generation')
  const headers = requestHeaders(ch, 'qwen')
  if (legacyAsync) headers['X-DashScope-Async'] = 'enable'
  const response = await fetchJson(fetchImpl, joinUrl(base, path), { method: 'POST', headers, body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  if (!legacyAsync) {
    const content = response.output?.choices?.[0]?.message?.content || []
    const image = content.find?.(part => part.image)?.image
    if (image) {
      const embedded = findImage(image, max)
      if (embedded?.bytes) return embedded
      return fetchBytes(fetchImpl, checkedRemoteUrl(embedded?.url || image), { method: 'GET', headers: {} }, max, signal, ch)
    }
    throw new Error(redact(response.message || response.code || 'Qwen-Image 没有返回图片', ch))
  }
  const taskId = response.output?.task_id
  if (!taskId) {
    const image = response.output?.choices?.[0]?.message?.content?.find?.(item => item.image)?.image
    if (image) return fetchBytes(fetchImpl, checkedRemoteUrl(image), { method: 'GET', headers: {} }, max, signal, ch)
    throw new Error(redact(response.message || response.code || 'DashScope 没有返回任务编号', ch))
  }
  const pollPath = endpointFromOption(ch, 'taskPath', '/tasks/')
  const deadline = Date.now() + bounded(option(ch, 'pollTimeoutMs', 240000), 1000, 600000)
  while (Date.now() < deadline) {
    await wait(bounded(option(ch, 'pollIntervalMs', 1500), 1, 30_000), signal)
    const task = await fetchJson(fetchImpl, joinUrl(base, `${pollPath.replace(/\/?$/, '/')}${encodeURIComponent(taskId)}`), { method: 'GET', headers: requestHeaders(ch, 'qwen', false) }, jsonLimit, signal, ch)
    const output = task.output || task
    if (['SUCCEEDED', 'succeeded', 'done', 'completed'].includes(output.task_status || output.status)) {
      const urls = output.results?.map(item => item.url) || output.choices?.flatMap(choice => choice.message?.content?.map(part => part.image).filter(Boolean) || []) || []
      if (urls[0]) return fetchBytes(fetchImpl, checkedRemoteUrl(urls[0]), { method: 'GET', headers: {} }, max, signal, ch)
      throw new Error('DashScope 任务完成但没有返回图片地址')
    }
    if (['FAILED', 'failed', 'CANCELED', 'cancelled'].includes(output.task_status || output.status)) throw new Error(redact(task.message || output.message || 'DashScope 生图任务失败', ch))
  }
  throw new Error('DashScope 生图任务等待超时')
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('请求已取消'))
    const timer = setTimeout(done, ms)
    function done() { signal.removeEventListener('abort', abort); resolve() }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason || new Error('请求已取消')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
async function generateSdwebui(channel, request, ctx) {
  const { base, fetchImpl, signal, max, channel: ch, jsonLimit } = ctx
  const { width, height } = requestedDims(ch, request)
  const payload = { prompt: String(request.positive || ''), negative_prompt: String(request.negative || ''), width, height,
    steps: bounded(request.steps ?? option(ch, 'steps', 20), 1, 200), cfg_scale: clampedNumber(request.cfg ?? option(ch, 'cfg', 7), 0, 50, 7), seed: Number.isFinite(Number(request.seed)) ? Number(request.seed) : -1, sampler_name: option(ch, 'sampler', 'Euler a'), batch_size: 1 }
  const data = await fetchJson(fetchImpl, joinUrl(base, endpointFromOption(ch, 'generatePath', '/sdapi/v1/txt2img')), { method: 'POST', headers: requestHeaders(ch, 'sdwebui'), body: JSON.stringify(payload) }, jsonLimit, signal, ch)
  if (!Array.isArray(data.images) || !data.images[0]) throw new Error('SD WebUI 没有返回图片')
  return decodeBase64(String(data.images[0]).replace(/^data:image\/[^;]+;base64,/i, ''), max)
}

export async function generateImage(channel, request, { signal, fetchImpl = globalThis.fetch, maxImageBytes = DEFAULT_MAX } = {}) {
  if (!channel || !PROVIDERS[channel.provider]) throw new Error('不支持的生图渠道')
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的网络请求功能')
  const base = validateBase(channel), max = bounded(maxImageBytes, 1024, 128 * 1024 * 1024)
  const jsonLimit = Math.min(192 * 1024 * 1024, max * 2 + 1024 * 1024)
  const scope = abortScope(signal, bounded(channel.options?.timeoutMs, 1000, 600_000))
  const ctx = { base, fetchImpl, signal: scope.signal, max, jsonLimit, channel }
  try {
    if (channel.provider === 'novelai') return await generateNovelai(channel, request, ctx)
    if (channel.provider === 'openai' || channel.provider === 'grok' || channel.provider === 'seedream') return await generateOpenai(channel, request, ctx, channel.provider)
    if (channel.provider === 'gemini') return await generateGemini(channel, request, ctx)
    if (channel.provider === 'gemini-chat') return await generateGeminiChat(channel, request, ctx)
    if (channel.provider === 'qwen') return await generateQwen(channel, request, ctx)
    return await generateSdwebui(channel, request, ctx)
  } catch (error) {
    if (scope.signal.aborted && !signal?.aborted) throw new Error('生图请求超时')
    if (signal?.aborted) throw error
    if (/^(?:生图服务 HTTP|NovelAI|Gemini|聊天兼容|DashScope|SD WebUI|服务|生图渠道)/.test(error.message || '')) throw error
    throw new Error(redact(error.message || '生图请求失败', channel))
  } finally { scope.close() }
}

export async function testImageChannel(channel, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!channel || !PROVIDERS[channel.provider]) throw new Error('不支持的生图渠道')
  const base = validateBase(channel)
  const safePaths = { openai: '/models', grok: '/models', 'gemini-chat': '/models', gemini: '/models', sdwebui: '/sdapi/v1/sd-models' }
  const path = safePaths[channel.provider] && endpointFromOption(channel, 'testPath', safePaths[channel.provider])
  if (!path) return { ok: true, status: 'configured', message: '地址和渠道参数已配置；此服务没有可安全探测的无计费接口。' }
  const scope = abortScope(signal, 8000)
  try {
    const headers = requestHeaders(channel, channel.provider)
    const response = await fetchImpl(joinUrl(base, path), { method: 'GET', headers, redirect: 'error', signal: scope.signal })
    if (!response.ok) return { ok: false, status: 'reachable', message: `服务已响应 HTTP ${response.status}` }
    const bytes = await readLimited(response, 2 * 1024 * 1024)
    let parsed = null; try { parsed = JSON.parse(bytes.toString('utf8')) } catch {}
    if (!parsed) return { ok: false, status: 'reachable', message: '服务已响应，但返回内容不是有效 JSON。' }
    const models = channel.provider === 'sdwebui' ? (Array.isArray(parsed) ? parsed.map(x => x.model_name).filter(Boolean) : []) : (parsed?.data || parsed?.models || []).map(x => x.id || x.name).filter(Boolean)
    return { ok: true, status: 'reachable', message: '连接正常。', ...(models.length ? { models: models.slice(0, 200) } : {}) }
  } catch (error) {
    if (signal?.aborted) throw error
    return { ok: false, status: 'configured', message: redact(error.message || '连接失败', channel) }
  } finally { scope.close() }
}
