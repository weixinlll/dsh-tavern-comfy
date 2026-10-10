import test from 'node:test'
import assert from 'node:assert/strict'
import { buildComfySimpleWorkflow, inspectComfySimple, normalizeComfySimpleConfig } from '../lib/comfy-simple.js'
import { compileJob } from '../lib/index.js'

const node = (required, optional = {}) => ({ input: { required, optional } })
const combo = values => [values, {}]
function objectInfo() {
  return {
    CheckpointLoaderSimple: node({ ckpt_name: combo(['sdxl.safetensors']) }),
    UNETLoader: node({ unet_name: combo(['flux.safetensors', 'anima-preview.safetensors']), weight_dtype: combo(['default', 'fp8_e4m3fn']) }),
    DualCLIPLoader: node({ clip_name1: combo(['t5xxl_fp16.safetensors', 'clip_l.safetensors']), clip_name2: combo(['t5xxl_fp16.safetensors', 'clip_l.safetensors']), type: combo(['sdxl', 'flux']) }),
    CLIPLoader: node({ clip_name: combo(['qwen_3_06b_base.safetensors']), type: combo(['stable_diffusion']) }),
    VAELoader: node({ vae_name: combo(['ae.safetensors', 'qwen_image_vae.safetensors']) }),
    ModelSamplingAuraFlow: node({ model: ['MODEL', {}], shift: ['FLOAT', {}] }),
    CLIPTextEncode: node({ clip: ['CLIP', {}], text: ['STRING', {}] }),
    EmptyLatentImage: node({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }),
    EmptySD3LatentImage: node({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }),
    FluxGuidance: node({ conditioning: ['CONDITIONING', {}], guidance: ['FLOAT', {}] }),
    KSampler: node({ model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: combo(['euler', 'dpmpp_2m']), scheduler: combo(['normal', 'karras']), denoise: ['FLOAT', {}] }),
    VAEDecode: node({ samples: ['LATENT', {}], vae: ['VAE', {}] }),
    SaveImage: node({ images: ['IMAGE', {}], filename_prefix: ['STRING', {}] }),
    LoraLoader: node({ model: ['MODEL', {}], clip: ['CLIP', {}], lora_name: combo(['style.safetensors']), strength_model: ['FLOAT', {}], strength_clip: ['FLOAT', {}] }),
    LoraLoaderModelOnly: node({ model: ['MODEL', {}], lora_name: combo(['style.safetensors']), strength_model: ['FLOAT', {}] }),
  }
}

test('simple config is bounded', () => {
  const value = normalizeComfySimpleConfig({ steps: 999, width: 10000, loras: Array.from({ length: 20 }, (_, i) => ({ name: `lora-${i}` })) })
  assert.equal(value.steps, 200)
  assert.equal(value.width, 8192)
  assert.equal(value.loras.length, 12)
  assert.equal(normalizeComfySimpleConfig().template, 'checkpoint')
  assert.equal(normalizeComfySimpleConfig({ width: 801, height: 1001 }).width, 800)
  assert.equal(normalizeComfySimpleConfig({ width: 801, height: 1001 }).height, 1000)
})

test('object_info only enables templates when their real nodes and inputs are present', () => {
  const info = inspectComfySimple(objectInfo())
  assert.equal(info.templates.checkpoint.available, true)
  assert.equal(info.templates.flux.available, true)
  assert.equal(info.templates.anima.available, true)
  const noAuraFlow = objectInfo(); delete noAuraFlow.ModelSamplingAuraFlow
  assert.equal(inspectComfySimple(noAuraFlow).templates.anima.available, true)
  const noQwen = objectInfo(); noQwen.CLIPLoader.input.required.type = combo(['stable_diffusion'])
  noQwen.CLIPLoader.input.required.clip_name = combo(['clip_l.safetensors'])
  assert.equal(inspectComfySimple(noQwen).templates.anima.available, false)
  assert.match(inspectComfySimple(noQwen).templates.anima.reason, /Qwen/)
  const noFluxClips = objectInfo(); noFluxClips.DualCLIPLoader.input.required.clip_name2 = combo(['t5xxl_fp16.safetensors'])
  assert.equal(inspectComfySimple(noFluxClips).templates.flux.available, false)
  assert.match(inspectComfySimple(noFluxClips).templates.flux.reason, /CLIP-L/)
  const noAnima = objectInfo(); noAnima.UNETLoader.input.required.unet_name = combo(['flux.safetensors'])
  assert.equal(inspectComfySimple(noAnima).templates.anima.available, false)
  assert.match(inspectComfySimple(noAnima).templates.anima.reason, /Anima 扩散模型/)
  const noCheckpoints = objectInfo(); noCheckpoints.CheckpointLoaderSimple.input.required.ckpt_name = combo([])
  assert.equal(inspectComfySimple(noCheckpoints).templates.checkpoint.available, false)
  assert.match(inspectComfySimple(noCheckpoints).templates.checkpoint.reason, /Checkpoint 模型/)
  const noFluxAssets = objectInfo(); noFluxAssets.UNETLoader.input.required.unet_name = combo(['anima-preview.safetensors']); noFluxAssets.VAELoader.input.required.vae_name = combo([])
  assert.equal(inspectComfySimple(noFluxAssets).templates.flux.available, false)
  assert.match(inspectComfySimple(noFluxAssets).templates.flux.reason, /Flux 模型/)
})

test('compiled checkpoint graph uses selected values, dimensions, and a fresh seed by default', () => {
  const built = buildComfySimpleWorkflow({ checkpoint: 'sdxl.safetensors', steps: 31, cfg: 6.25, sampler: 'dpmpp_2m', scheduler: 'karras', width: 1024, height: 768 }, objectInfo())
  const compiled = compileJob({ workflow: built.workflow, params: { tag: 'a castle', size: '竖图' }, config: { weightMode: 'none', negativeMode: 'plugin', artistPosition: 'prefix', overrideSteps: true, sizes: { 竖图: { width: 512, height: 768 } } }, definitions: {} })
  const prompt = compiled.prompt
  const checkpoint = Object.values(prompt).find(item => item.class_type === 'CheckpointLoaderSimple')
  const latent = Object.values(prompt).find(item => item.class_type === 'EmptyLatentImage')
  const sampler = Object.values(prompt).find(item => item.class_type === 'KSampler')
  assert.equal(checkpoint.inputs.ckpt_name, 'sdxl.safetensors')
  assert.deepEqual([latent.inputs.width, latent.inputs.height], [1024, 768])
  assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.sampler_name, sampler.inputs.scheduler], [31, 6.25, 'dpmpp_2m', 'karras'])
  assert.equal(sampler.inputs.seed, compiled.seed)
  assert.ok(compiled.seed >= 0)
  const fixed = buildComfySimpleWorkflow({ checkpoint: 'sdxl.safetensors', seed: 0 }, objectInfo())
  const fixedCompiled = compileJob({ workflow: fixed.workflow, params: { tag: 'a castle', size: '竖图' }, config: { weightMode: 'none', negativeMode: 'plugin', artistPosition: 'prefix', overrideSteps: true }, definitions: {} })
  assert.equal(fixedCompiled.seed, 0)
})

test('Flux and Anima use their correct loaders, conditioning and model-only LoRA paths', () => {
  const built = buildComfySimpleWorkflow({ template: 'flux', unet: 'flux.safetensors', clip1: 't5xxl_fp16.safetensors', clip2: 'clip_l.safetensors', vae: 'ae.safetensors', cfg: 4.2, loras: [{ name: 'style.safetensors', strengthModel: 0.7 }] }, objectInfo())
  const classes = Object.values(built.workflow.prompt).map(item => item.class_type)
  assert.ok(classes.includes('DualCLIPLoader'))
  assert.ok(classes.includes('FluxGuidance'))
  assert.ok(classes.includes('LoraLoaderModelOnly'))
  const fluxLora = Object.values(built.workflow.prompt).find(item => item.class_type === 'LoraLoaderModelOnly')
  assert.deepEqual(fluxLora.inputs.model, ['1', 0])
  assert.equal('clip' in fluxLora.inputs, false)
  assert.equal(Object.values(built.workflow.prompt).find(item => item.class_type === 'FluxGuidance').inputs.guidance, 4.2)
  const anima = buildComfySimpleWorkflow({ template: 'anima', unet: 'anima-preview.safetensors', clip1: 'qwen_3_06b_base.safetensors', loras: [{ name: 'style.safetensors' }] }, objectInfo())
  const animaClasses = Object.values(anima.workflow.prompt).map(item => item.class_type)
  assert.ok(animaClasses.includes('CLIPLoader'))
  assert.ok(animaClasses.includes('EmptyLatentImage'))
  assert.equal(Object.values(anima.workflow.prompt).find(item => item.class_type === 'CLIPLoader').inputs.type, 'stable_diffusion')
  const animaUnet = Object.entries(anima.workflow.prompt).find(([, item]) => item.class_type === 'UNETLoader')[0]
  const animaLora = Object.values(anima.workflow.prompt).find(item => item.class_type === 'LoraLoaderModelOnly')
  assert.deepEqual(animaLora.inputs.model, [animaUnet, 0])
  assert.equal(Object.values(anima.workflow.prompt).find(item => item.class_type === 'VAELoader').inputs.vae_name, 'qwen_image_vae.safetensors')
  assert.equal(animaClasses.includes('ModelSamplingAuraFlow'), false)
  assert.ok(animaClasses.includes('LoraLoaderModelOnly'))
  const animaBase = buildComfySimpleWorkflow({ template: 'anima', unet: 'anima-preview.safetensors', clip1: 'qwen_3_06b_base.safetensors' }, objectInfo())
  assert.deepEqual(Object.values(animaBase.workflow.prompt).find(item => item.class_type === 'KSampler').inputs.model, [animaUnet, 0])
  const noKnownAnimaVae = objectInfo(); noKnownAnimaVae.VAELoader.input.required.vae_name = combo(['ae.safetensors'])
  assert.throws(() => buildComfySimpleWorkflow({ template: 'anima', unet: 'anima-preview.safetensors', clip1: 'qwen_3_06b_base.safetensors' }, noKnownAnimaVae), /未识别到标准 Anima VAE/)
  assert.throws(() => buildComfySimpleWorkflow({ template: 'flux', unet: 'flux.safetensors', clip1: 'clip_l.safetensors', clip2: 't5xxl_fp16.safetensors', vae: 'ae.safetensors' }, objectInfo()), /第一个编码器必须是 T5-XXL/)
  assert.throws(() => buildComfySimpleWorkflow({ template: 'flux', unet: 'flux.safetensors', clip1: 't5xxl_fp16.safetensors', clip2: 't5xxl_fp16.safetensors', vae: 'ae.safetensors' }, objectInfo()), /第二个编码器必须是 CLIP-L/)
  assert.throws(() => buildComfySimpleWorkflow({ template: 'anima', unet: 'anima-preview.safetensors', clip1: 'some-other-clip.safetensors', vae: 'ae.safetensors' }, objectInfo()), /Qwen CLIP/)
})
