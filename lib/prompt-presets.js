const MODES = new Set(['auto', 'tags', 'natural', 'mixed'])
const MAX_PRESETS = 60
const MAX_TEXT = 4000

/** Built-in profiles describe visual intent, not a particular model or quality score. */
export const BUILTIN_PROMPT_PRESETS = [
  {
    id: 'portrait-editorial', name: '杂志人像',
    positive: 'intentional portrait framing, expressive but natural pose, readable facial features, soft directional key light with gentle fill, realistic skin and fabric texture, restrained color palette, clean separation from the background',
    tagPositive: 'editorial portrait, intentional framing, natural expressive pose, readable face, soft directional key light, gentle fill light, realistic skin texture, detailed fabric, restrained palette, clean background separation',
    naturalPositive: 'Frame this as an intentional editorial portrait with a natural expressive pose. Keep the face readable, use soft directional key light with gentle fill, show realistic skin and fabric texture, and separate the subject cleanly from a restrained background.',
    mixedPositive: 'An intentional editorial portrait with a natural expressive pose and readable face; soft directional key light, gentle fill, realistic skin and fabric texture, restrained palette, clean background separation.',
    negative: 'unclear face, awkward crop, stiff pose, harsh flash, waxy skin, plastic texture, cluttered background, text, watermark',
  },
  {
    id: 'story-cinematic', name: '电影叙事',
    positive: 'clear story moment, expressive body language, foreground and background depth, cinematic composition, motivated practical lighting, coherent environment details, natural material texture, balanced contrast',
    tagPositive: 'clear story moment, expressive body language, foreground depth, background depth, cinematic composition, motivated practical lighting, coherent environment, natural material texture, balanced contrast',
    naturalPositive: 'Show one clear story moment through expressive body language and a cinematic composition with foreground and background depth. Let practical light sources motivate the lighting, keep environment details coherent, and preserve natural materials and balanced contrast.',
    mixedPositive: 'A clear story moment told through expressive body language and cinematic depth; motivated practical lighting, coherent environment details, natural material texture, balanced contrast.',
    negative: 'ambiguous action, disconnected props, flat lighting, muddy contrast, inconsistent perspective, clutter, text, watermark',
  },
  {
    id: 'anime-character', name: '动漫角色',
    positive: 'polished hand-drawn anime illustration, appealing silhouette, expressive eyes and face, clean intentional linework, layered cel shading, controlled highlights, readable outfit details, complementary colors',
    tagPositive: 'polished hand-drawn anime, appealing silhouette, expressive eyes, clean intentional linework, layered cel shading, controlled highlights, readable outfit details, complementary colors',
    naturalPositive: 'Render the character as a polished hand-drawn anime illustration. Give them an appealing silhouette and expressive face, with clean intentional linework, layered cel shading, controlled highlights, readable outfit details, and complementary colors.',
    mixedPositive: 'A polished hand-drawn anime character with an appealing silhouette and expressive face; clean linework, layered cel shading, controlled highlights, readable outfit details, complementary colors.',
    negative: 'inconsistent linework, muddy shading, distorted face, unreadable outfit, extra limbs, text, watermark',
  },
  {
    id: 'eastern-fantasy', name: '东方幻想',
    positive: 'eastern fantasy visual language, graceful flowing costume shapes, considered ornamental details, atmospheric landscape depth, luminous mist and directional light, tactile silk, lacquer and stone, harmonious restrained palette',
    tagPositive: 'eastern fantasy, graceful flowing costume, considered ornaments, atmospheric landscape depth, luminous mist, directional light, tactile silk, lacquer, stone, harmonious restrained palette',
    naturalPositive: 'Use an eastern fantasy visual language with graceful flowing costume shapes and considered ornamental details. Set the subject in an atmospheric landscape with luminous mist and directional light, and make silk, lacquer, and stone feel tactile within a harmonious restrained palette.',
    mixedPositive: 'Eastern fantasy with graceful flowing costume and considered ornaments; atmospheric landscape depth, luminous mist, directional light, tactile silk, lacquer and stone, harmonious restrained palette.',
    negative: 'generic costume, indiscriminate ornament, muddy atmosphere, flat materials, inconsistent architecture, text, watermark',
  },
  {
    id: 'landscape-atmosphere', name: '氛围场景',
    positive: 'strong landscape silhouette, clear foreground middle ground and distance, atmospheric perspective, natural light direction, varied terrain and material texture, balanced negative space, coherent weather and color',
    tagPositive: 'strong landscape silhouette, clear foreground, middle ground and distance, atmospheric perspective, natural light direction, varied terrain, material texture, balanced negative space, coherent weather and color',
    naturalPositive: 'Build the scene around a strong landscape silhouette with a clear foreground, middle ground, and distance. Use atmospheric perspective and a consistent natural light direction, vary terrain and material texture, and leave balanced negative space with coherent weather and color.',
    mixedPositive: 'A strong landscape silhouette with clear foreground, middle ground and distance; atmospheric perspective, natural light direction, varied terrain and material texture, balanced negative space, coherent weather and color.',
    negative: 'flat depth, featureless terrain, competing focal points, incoherent weather, oversaturated color, text, watermark',
  },
]

const TAG_BACKENDS = new Set(['comfyui', 'novelai', 'stable-diffusion', 'sd', 'sdwebui', 'forge', 'automatic1111'])
const NATURAL_BACKENDS = new Set(['openai', 'gemini', 'gemini-chat', 'grok', 'seedream', 'qwen'])

function clean(value, max = MAX_TEXT) { return String(value ?? '').trim().slice(0, max) }
function id(value) { return clean(value, 80).replace(/[^a-zA-Z0-9_-]/g, '-') }

export function normalizePromptPresets(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set(BUILTIN_PROMPT_PRESETS.map(item => item.id))
  return input.filter(item => item && typeof item === 'object').slice(0, MAX_PRESETS).map((item, index) => {
    let presetId = id(item.id) || `custom-${index + 1}`
    while (seen.has(presetId)) presetId = `${presetId}-${index + 1}`
    seen.add(presetId)
    return {
      id: presetId,
      name: clean(item.name, 80) || `Prompt profile ${index + 1}`,
      positive: clean(item.positive),
      negative: clean(item.negative, 2000),
      // Optional backend-specific text can refine a custom profile without silently setting API parameters.
      tagPositive: clean(item.tagPositive),
      naturalPositive: clean(item.naturalPositive),
      mixedPositive: clean(item.mixedPositive),
      enabled: item.enabled !== false,
    }
  })
}

export function effectivePromptPreset(config = {}) {
  const custom = normalizePromptPresets(config.promptPresets)
  const presets = [...BUILTIN_PROMPT_PRESETS, ...custom]
  const selected = String(config.activePromptPreset ?? '')
  return presets.find(item => item.id === selected && item.enabled !== false) ?? null
}

export function validPromptPresetId(config = {}, value = config.activePromptPreset) {
  const selected = String(value ?? '')
  if (!selected) return ''
  return [...BUILTIN_PROMPT_PRESETS, ...normalizePromptPresets(config.promptPresets)].some(item => item.id === selected && item.enabled !== false) ? selected : ''
}

/** Prompt-mode context follows the image execution path, never stale Comfy settings on another provider. */
export function promptBackendContext(config = {}, workflow = null) {
  const backend = String(config.imageBackend || 'comfyui').toLowerCase()
  if (backend !== 'comfyui') return backend
  return [
    'comfyui',
    config.comfyMode === 'simple' ? config.comfySimple?.template : '',
    workflow?.summary?.model,
    workflow?.label,
  ].filter(Boolean).join(' ')
}

export function resolvePromptMode(config = {}, backend = '') {
  const requested = String(config.promptMode ?? 'auto').toLowerCase()
  if (MODES.has(requested) && requested !== 'auto') return requested
  const name = String(backend ?? config.imageBackend ?? '').toLowerCase()
  const isComfy = /(?:^|\s)comfyui(?:$|\s)/.test(name)
  if (isComfy) {
    if (name.includes('flux') || (config.comfyMode === 'simple' && config.comfySimple?.template === 'flux')) return 'natural'
    if (name.includes('anima') || (config.comfyMode === 'simple' && config.comfySimple?.template === 'anima')) return 'mixed'
    return 'tags'
  }
  if ([...TAG_BACKENDS].some(item => item !== 'comfyui' && (name === item || name.startsWith(item + ' ')))) return 'tags'
  if ([...NATURAL_BACKENDS].some(item => name === item || name.startsWith(item + ' '))) return 'natural'
  if (name === 'flux' || name.startsWith('flux ')) return 'natural'
  if (name === 'anima' || name.startsWith('anima ')) return 'mixed'
  return 'mixed'
}

export function formatPromptForBackend(text, backend = '', mode = 'tags') {
  const name = String(backend ?? '').toLowerCase()
  let out = String(text ?? '')
  if (mode === 'natural' || mode === 'mixed') {
    out = out.replace(/-?\d+(?:\.\d+)?::([^:]+)::/g, '$1').replace(/\(([^()]+):\s*-?\d+(?:\.\d+)?\)/g, '$1').replace(/[{}\[\]]/g, '')
  } else if (name.includes('novelai')) {
    out = out.replace(/\(([^(),]+):\s*(\d+(?:\.\d+)?)\)/g, (_m, tag, weight) => `${Math.max(0.01, Math.min(2, Number(weight))).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}::${tag.trim()}::`)
  }
  return out.replace(/\s*,\s*/g, ', ').replace(/,\s*,+/g, ',').trim()
}

function textForMode(preset, mode) {
  if (!preset) return ''
  if (mode === 'tags') return preset.tagPositive || preset.positive
  if (mode === 'natural') return preset.naturalPositive || preset.positive
  return preset.mixedPositive || preset.naturalPositive || preset.positive
}

/** Returns a short clause for the existing planner call; never performs an extra model call. */
export function getPromptGuidance(config = {}, backend = '') {
  const preset = effectivePromptPreset(config)
  const mode = resolvePromptMode(config, backend)
  const clauses = []
  if (preset) {
    const visual = textForMode(preset, mode)
    clauses.push(`Apply the selected visual profile “${preset.name}”: ${visual}. Keep the scene-specific subject and action from the request; use these as composition, lighting, material, and style guidance.`)
    if (preset.negative) clauses.push(`Avoid these visual problems where applicable: ${preset.negative}.`)
  }
  clauses.push(mode === 'tags'
    ? 'Write positive and negative image prompts as concise comma-separated visual tags. Keep NovelAI/Stable Diffusion weighted-tag syntax only when explicitly requested; do not invent quality scores, artist names, model names, or unsupported parameters.'
    : mode === 'natural'
      ? 'Write positive and negative image prompts as clear natural-language visual descriptions, not comma-separated tag piles. Do not invent quality scores, artist names, model names, or unsupported parameters.'
      : 'Use a readable mixed prompt: a concise natural-language scene description followed by a few useful visual tags. Do not invent quality scores, artist names, model names, or unsupported parameters.')
  return clauses.join('\n')
}

/** Deterministically adds active profile guidance to a finished prompt for both direct and planned jobs. */
export function composePresetText(text, config = {}, backend = '') {
  const preset = effectivePromptPreset(config)
  const addition = textForMode(preset, resolvePromptMode(config, backend))
  const base = clean(text, 12000)
  if (!addition || base.toLowerCase().includes(addition.toLowerCase())) return base
  return [base, addition].filter(Boolean).join(resolvePromptMode(config, backend) === 'tags' ? ', ' : '. ')
}

export function promptPresetNegative(config = {}) {
  return effectivePromptPreset(config)?.negative ?? ''
}
