import { IMAGE_PROVIDERS } from './image-providers.js'

const providerIds = new Set(IMAGE_PROVIDERS.map(item => item.id))
const text = (value, limit = 1000) => String(value ?? '').trim().slice(0, limit)

export function normalizeChannels(value, previous = []) {
  if (!Array.isArray(value) || value.length > 60) throw new Error('生图渠道必须是数组，最多保存 60 个')
  const seen = new Set()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('生图渠道格式不正确')
    const id = text(raw.id, 100)
    if (!/^[\w-]+$/.test(id) || seen.has(id)) throw new Error('生图渠道编号缺失或重复')
    seen.add(id)
    const provider = text(raw.provider, 30)
    if (!providerIds.has(provider)) throw new Error('不支持的生图渠道类型')
    const prior = previous.find(item => item.id === id && item.provider === provider)
    const baseUrl = text(raw.baseUrl, 2000).replace(/\/+$/, '')
    if (baseUrl) {
      let url
      try { url = new URL(baseUrl) } catch { throw new Error('渠道地址必须是完整的 http:// 或 https:// 地址') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('渠道地址请只填写 HTTP(S) 服务地址，鉴权信息填在下方')
    }
    const secret = (field, clear) => raw[clear] === true ? '' : text(raw[field], 8192) || prior?.[field] || ''
    const options = {}
    for (const [key, item] of Object.entries(raw.options ?? {})) {
      if (!/^[a-zA-Z][\w]{0,50}$/.test(key)) continue
      if (typeof item === 'string') options[key] = item.slice(0, 1000)
      if (typeof item === 'number' && Number.isFinite(item)) options[key] = item
      if (typeof item === 'boolean') options[key] = item
    }
    return { id, provider, name: text(raw.name, 100) || IMAGE_PROVIDERS.find(item => item.id === provider).label,
      baseUrl, model: text(raw.model, 300), authMode: ['none', 'basic'].includes(raw.authMode) ? raw.authMode : 'bearer',
      username: text(raw.username, 300), apiKey: secret('apiKey', 'clearApiKey'), password: secret('password', 'clearPassword'), options }
  })
}

export function publicChannels(channels) {
  return channels.map(({ apiKey, password, ...item }) => ({ ...item, hasApiKey: Boolean(apiKey), hasPassword: Boolean(password) }))
}

export function activeChannel(config) {
  if (!config.imageBackend || config.imageBackend === 'comfyui') return null
  const channel = config.imageChannels.find(item => item.id === config.activeImageChannel && item.provider === config.imageBackend)
  if (!channel) throw new Error('请先选择并保存一个生图渠道')
  return structuredClone(channel)
}

export function channelConfigPatch(config, patch) {
  const next = {
    imageBackend: patch.imageBackend ?? config.imageBackend ?? 'comfyui',
    activeImageChannel: text(patch.activeImageChannel ?? config.activeImageChannel, 100),
    imageChannels: patch.imageChannels === undefined ? config.imageChannels : normalizeChannels(patch.imageChannels, config.imageChannels),
  }
  if (next.imageBackend !== 'comfyui' && !providerIds.has(next.imageBackend)) throw new Error('不支持的生图后端')
  activeChannel(next)
  return next
}
