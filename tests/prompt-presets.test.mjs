import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_PROMPT_PRESETS, composePresetText, effectivePromptPreset, formatPromptForBackend, getPromptGuidance, normalizePromptPresets, promptBackendContext, resolvePromptMode, validPromptPresetId } from '../lib/prompt-presets.js'
import { compileChannelJob } from '../lib/index.js'

test('automatic format follows native backend styles including Comfy simple templates', () => {
  assert.equal(resolvePromptMode({ promptMode: 'auto' }, 'novelai'), 'tags')
  assert.equal(resolvePromptMode({ promptMode: 'auto' }, 'openai'), 'natural')
  assert.equal(resolvePromptMode({ promptMode: 'auto' }, 'gemini-chat'), 'natural')
  for (const backend of ['openai', 'gemini', 'gemini-chat', 'grok', 'seedream', 'qwen']) assert.equal(resolvePromptMode({ promptMode: 'auto' }, backend), 'natural')
  for (const backend of ['novelai', 'sdwebui', 'forge']) assert.equal(resolvePromptMode({ promptMode: 'auto' }, backend), 'tags')
  assert.equal(resolvePromptMode({ promptMode: 'auto', comfyMode: 'simple', comfySimple: { template: 'flux' } }, 'comfyui'), 'natural')
  assert.equal(resolvePromptMode({ promptMode: 'auto', comfyMode: 'simple', comfySimple: { template: 'anima' } }, 'comfyui'), 'mixed')
  assert.equal(resolvePromptMode({ promptMode: 'auto', comfyMode: 'simple', comfySimple: { template: 'checkpoint' } }, 'comfyui'), 'tags')
})

test('external providers ignore stale Comfy templates and default workflow model hints', () => {
  const staleFlux = { imageBackend: 'novelai', comfyMode: 'simple', comfySimple: { template: 'flux' } }
  const staleAnima = { imageBackend: 'openai', comfyMode: 'simple', comfySimple: { template: 'anima' } }
  const naiContext = promptBackendContext(staleFlux, { summary: { model: 'Anima checkpoint' }, label: 'Flux workflow' })
  const openaiContext = promptBackendContext(staleAnima)
  assert.equal(naiContext, 'novelai')
  assert.equal(openaiContext, 'openai')
  assert.equal(resolvePromptMode(staleFlux, naiContext), 'tags')
  assert.equal(resolvePromptMode(staleAnima, openaiContext), 'natural')
  assert.match(getPromptGuidance(staleFlux, naiContext), /comma-separated visual tags/)
  assert.match(getPromptGuidance(staleAnima, openaiContext), /natural-language/)
  const comfy = { imageBackend: 'comfyui', comfyMode: 'simple', comfySimple: { template: 'flux' } }
  assert.equal(resolvePromptMode(comfy, promptBackendContext(comfy)), 'natural')
})

test('built-in profiles guide the existing planner and deterministic prompt composition', () => {
  assert.ok(BUILTIN_PROMPT_PRESETS.length >= 5)
  const config = { promptMode: 'auto', imageBackend: 'openai', activePromptPreset: 'portrait-editorial', promptPresets: [] }
  assert.match(getPromptGuidance(config, 'openai'), /natural-language/)
  assert.match(getPromptGuidance(config, 'openai'), /构图|portrait/i)
  const text = composePresetText('person in a room', config, 'openai')
  assert.match(text, /person in a room/)
  assert.match(text, /editorial portrait/)
})

test('custom profiles are bounded and keep positive and negative guidance separate', () => {
  const custom = normalizePromptPresets([{ id: '../bad name', name: 'Custom', positive: 'soft side light', negative: 'watermark', tagPositive: 'side lighting' }])
  assert.equal(custom.length, 1)
  assert.equal(custom[0].id.includes('/'), false)
  assert.equal(custom[0].positive, 'soft side light')
  assert.equal(custom[0].negative, 'watermark')
  assert.equal(normalizePromptPresets(Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` }))).length, 60)
})

test('built-in ids are reserved and active preset selection accepts only enabled profiles', () => {
  const profiles = normalizePromptPresets([
    { id: 'portrait-editorial', name: 'Collision', positive: 'custom visual direction' },
    { id: 'custom', name: 'First' },
    { id: 'custom', name: 'Second', enabled: false },
  ])
  assert.notEqual(profiles[0].id, 'portrait-editorial')
  assert.notEqual(profiles[0].id, profiles[1].id)
  const config = { promptPresets: profiles }
  assert.equal(validPromptPresetId(config, 'portrait-editorial'), 'portrait-editorial')
  assert.equal(validPromptPresetId(config, profiles[0].id), profiles[0].id)
  assert.equal(validPromptPresetId(config, profiles[2].id), '')
  assert.equal(validPromptPresetId(config, 'missing'), '')
  assert.equal(effectivePromptPreset({ ...config, activePromptPreset: profiles[0].id }).name, 'Collision')
})

test('built-in visual profiles provide distinct tag, natural, and mixed prompt forms', () => {
  for (const preset of BUILTIN_PROMPT_PRESETS) {
    assert.ok(preset.tagPositive?.length)
    assert.ok(preset.naturalPositive?.length)
    assert.ok(preset.mixedPositive?.length)
  }
})

test('tag weighting is retained for NovelAI syntax and removed for natural-language backends', () => {
  assert.equal(formatPromptForBackend('(blue coat:1.2)', 'novelai', 'tags'), '1.2::blue coat::')
  assert.equal(formatPromptForBackend('(blue coat:1.2)', 'openai', 'natural'), 'blue coat')
  assert.match(getPromptGuidance({ promptMode: 'auto' }, 'openai'), /natural-language/)
  assert.match(getPromptGuidance({ promptMode: 'auto' }, 'novelai'), /comma-separated visual tags/)
})

test('compiled prompts apply profiles to both tag and natural-language image providers', () => {
  const params = { tag: 'traveler in a room, (blue coat:1.2)', negative: 'blurry', size: '方图' }
  const common = { activePromptPreset: 'story-cinematic', promptMode: 'auto', weightMode: 'convert', negativeMode: 'plugin', stylePresets: [], activePreset: '', sizes: { 方图: { width: 640, height: 640 } } }
  const sd = compileChannelJob({ params, config: { ...common, imageBackend: 'sdwebui' }, definitions: {} })
  assert.match(sd.positive, /\(blue coat:1\.2\)/)
  assert.match(sd.positive, /clear story moment/)
  const natural = compileChannelJob({ params, config: { ...common, imageBackend: 'openai' }, definitions: {} })
  assert.match(natural.positive, /clear story moment/)
  assert.match(natural.positive, /blue coat/)
  assert.doesNotMatch(natural.positive, /\(blue coat:1\.2\)/)
  assert.match(natural.negative, /ambiguous action/)
  const nai = compileChannelJob({ params, config: { ...common, imageBackend: 'novelai' }, definitions: {} })
  assert.match(nai.positive, /1\.2::blue coat::/)
})

test('compiled external prompts retain provider format when stale Comfy templates are configured', () => {
  const params = { tag: 'traveler, (blue coat:1.2)', negative: '', size: '方图' }
  const common = { promptMode: 'auto', weightMode: 'convert', negativeMode: 'plugin', stylePresets: [], activePreset: '', sizes: { 方图: { width: 640, height: 640 } } }
  const nai = compileChannelJob({ params, config: { ...common, imageBackend: 'novelai', comfyMode: 'simple', comfySimple: { template: 'flux' } }, definitions: {} })
  assert.match(nai.positive, /1\.2::blue coat::/)
  const openai = compileChannelJob({ params, config: { ...common, imageBackend: 'openai', comfyMode: 'simple', comfySimple: { template: 'anima' } }, definitions: {} })
  assert.match(openai.positive, /blue coat/)
  assert.doesNotMatch(openai.positive, /1\.2::|\(blue coat:1\.2\)/)
})
