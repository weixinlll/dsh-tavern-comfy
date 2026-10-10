import { randomInt } from 'node:crypto'

const TEMPLATE_LABELS = { checkpoint: 'Checkpoint（SD / SDXL）', flux: 'Flux', anima: 'Anima' }

export function normalizeComfySimpleConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const template = ['checkpoint', 'flux', 'anima'].includes(value.template) ? value.template : 'checkpoint'
  const numeric = (v, fallback, min, max, whole = false) => {
    const number = Number(v)
    const safe = Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
    return whole ? Math.round(safe) : safe
  }
  const loras = Array.isArray(value.loras) ? value.loras.slice(0, 12).map(item => ({
    name: String(item?.name ?? '').slice(0, 500),
    strengthModel: numeric(item?.strengthModel, 1, -10, 10),
    strengthClip: numeric(item?.strengthClip, 1, -10, 10),
    enabled: item?.enabled !== false,
  })) : []
  const seedText = String(value.seed ?? '').trim()
  const seedNumber = seedText === '' ? null : Number(seedText)
  return {
    template,
    checkpoint: String(value.checkpoint ?? '').slice(0, 500),
    unet: String(value.unet ?? '').slice(0, 500),
    clip1: String(value.clip1 ?? '').slice(0, 500),
    clip2: String(value.clip2 ?? '').slice(0, 500),
    vae: String(value.vae ?? '').slice(0, 500),
    loras,
    steps: numeric(value.steps, 24, 1, 200, true),
    cfg: numeric(value.cfg, template === 'flux' ? 3.5 : (template === 'anima' ? 4 : 7), 0, 100),
    sampler: String(value.sampler ?? 'euler').slice(0, 80),
    scheduler: String(value.scheduler ?? 'normal').slice(0, 80),
    // ComfyUI latent dimensions are rounded down to multiples of eight. Keep
    // the saved settings and displayed/job dimensions in sync with the graph.
    width: Math.round(numeric(value.width, 832, 64, 8192, true) / 8) * 8,
    height: Math.round(numeric(value.height, 1216, 64, 8192, true) / 8) * 8,
    seed: Number.isSafeInteger(seedNumber) && seedNumber >= 0 && seedNumber <= 2 ** 47 - 1 ? seedNumber : null,
  }
}

function inputNames(node) {
  return new Set([
    ...Object.keys(node?.input?.required ?? {}),
    ...Object.keys(node?.input?.optional ?? {}),
  ])
}

function choices(node, input) {
  const entry = node?.input?.required?.[input] ?? node?.input?.optional?.[input]
  return Array.isArray(entry?.[0]) ? entry[0].map(String) : []
}

function nodeSupports(objectInfo, name, requiredInputs = []) {
  const node = objectInfo?.[name]
  if (!node) return false
  const names = inputNames(node)
  return requiredInputs.every(input => names.has(input))
}

function missingNodeInputs(objectInfo, requirements) {
  const missing = []
  for (const [name, inputs] of requirements) {
    if (!objectInfo?.[name]) { missing.push(name); continue }
    const names = inputNames(objectInfo[name])
    for (const input of inputs) if (!names.has(input)) missing.push(`${name}.${input}`)
  }
  return missing
}

const isT5 = name => /(?:t5|umt5)/i.test(String(name))
const isClipL = name => /clip[_ -]?l(?:\.|[_ -]|$)/i.test(String(name))

export function inspectComfySimple(objectInfo = {}) {
  const samplerNames = choices(objectInfo.KSampler, 'sampler_name')
  const schedulerNames = choices(objectInfo.KSampler, 'scheduler')
  const checkpoint = nodeSupports(objectInfo, 'CheckpointLoaderSimple', ['ckpt_name'])
  const checkpointRequirements = [
    ['CLIPTextEncode', ['clip', 'text']], ['EmptyLatentImage', ['width', 'height', 'batch_size']],
    ['KSampler', ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']],
    ['VAEDecode', ['samples', 'vae']], ['SaveImage', ['images', 'filename_prefix']],
  ]
  const checkpoints = choices(objectInfo?.CheckpointLoaderSimple, 'ckpt_name')
  const checkpointMissing = [...(!checkpoint ? ['CheckpointLoaderSimple'] : []), ...missingNodeInputs(objectInfo, checkpointRequirements)]
  if (checkpoint && !checkpoints.length) checkpointMissing.push('CheckpointLoaderSimple.ckpt_name 中的 Checkpoint 模型')
  const checkpointCore = checkpointMissing.length === 0
  const checkpointHasLora = nodeSupports(objectInfo, 'LoraLoader', ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'])
  const fluxRequirements = [
    ['UNETLoader', ['unet_name', 'weight_dtype']], ['DualCLIPLoader', ['clip_name1', 'clip_name2', 'type']],
    ['VAELoader', ['vae_name']], ['EmptySD3LatentImage', ['width', 'height', 'batch_size']],
    ['CLIPTextEncode', ['clip', 'text']], ['FluxGuidance', ['conditioning', 'guidance']],
    ['KSampler', ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']],
    ['VAEDecode', ['samples', 'vae']], ['SaveImage', ['images', 'filename_prefix']],
  ]
  const fluxMissing = missingNodeInputs(objectInfo, fluxRequirements)
  if (objectInfo?.DualCLIPLoader && !choices(objectInfo.DualCLIPLoader, 'type').includes('flux')) fluxMissing.push('DualCLIPLoader.type=flux')
  if (objectInfo?.UNETLoader && !choices(objectInfo.UNETLoader, 'weight_dtype').length) fluxMissing.push('UNETLoader.weight_dtype 选项')
  const fluxClip1 = choices(objectInfo?.DualCLIPLoader, 'clip_name1')
  const fluxClip2 = choices(objectInfo?.DualCLIPLoader, 'clip_name2')
  const fluxUnets = choices(objectInfo?.UNETLoader, 'unet_name').filter(name => /flux/i.test(name))
  const vaes = choices(objectInfo?.VAELoader, 'vae_name')
  if (objectInfo?.UNETLoader && !fluxUnets.length) fluxMissing.push('UNETLoader.unet_name 中的 Flux 模型')
  if (objectInfo?.VAELoader && !vaes.length) fluxMissing.push('VAELoader.vae_name 中的 Flux VAE')
  if (objectInfo?.DualCLIPLoader && !fluxClip1.some(isT5)) fluxMissing.push('DualCLIPLoader.clip_name1 中的 T5-XXL 模型')
  if (objectInfo?.DualCLIPLoader && !fluxClip2.some(isClipL)) fluxMissing.push('DualCLIPLoader.clip_name2 中的 CLIP-L 模型')
  const flux = fluxMissing.length === 0
  const fluxHasLora = nodeSupports(objectInfo, 'LoraLoaderModelOnly', ['model', 'lora_name', 'strength_model'])
  const animaRequirements = [
    ['UNETLoader', ['unet_name', 'weight_dtype']], ['CLIPLoader', ['clip_name', 'type']],
    ['VAELoader', ['vae_name']],
    ['EmptyLatentImage', ['width', 'height', 'batch_size']], ['CLIPTextEncode', ['clip', 'text']],
    ['KSampler', ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']],
    ['VAEDecode', ['samples', 'vae']], ['SaveImage', ['images', 'filename_prefix']],
  ]
  const animaMissing = missingNodeInputs(objectInfo, animaRequirements)
  if (objectInfo?.CLIPLoader && !choices(objectInfo.CLIPLoader, 'type').includes('stable_diffusion')) animaMissing.push('CLIPLoader.type=stable_diffusion（Anima Qwen 文本编码器类型）')
  if (objectInfo?.UNETLoader && !choices(objectInfo.UNETLoader, 'weight_dtype').length) animaMissing.push('UNETLoader.weight_dtype 选项')
  const animaClips = choices(objectInfo?.CLIPLoader, 'clip_name')
  if (objectInfo?.CLIPLoader && !animaClips.some(name => /qwen/i.test(name))) animaMissing.push('CLIPLoader.clip_name 中的 Qwen 模型')
  const animaUnets = choices(objectInfo?.UNETLoader, 'unet_name').filter(name => /anima/i.test(name))
  if (objectInfo?.UNETLoader && !animaUnets.length) animaMissing.push('UNETLoader.unet_name 中的 Anima 扩散模型')
  if (objectInfo?.VAELoader && !vaes.length) animaMissing.push('VAELoader.vae_name 中的 Anima VAE')
  const anima = animaMissing.length === 0

  const templates = {
    checkpoint: { available: checkpointCore && samplerNames.length > 0 && schedulerNames.length > 0, label: TEMPLATE_LABELS.checkpoint,
      reason: !checkpointCore ? `Checkpoint 模板缺少 ComfyUI 接口：${checkpointMissing.join('、')}。` : (!samplerNames.length || !schedulerNames.length ? 'KSampler 没有可用的采样器或调度器列表。' : ''), lora: checkpointHasLora },
    flux: { available: flux && samplerNames.length > 0 && schedulerNames.length > 0, label: TEMPLATE_LABELS.flux,
      reason: !flux ? `Flux 模板缺少 ComfyUI 接口或模型类型：${fluxMissing.join('、')}。` : (!samplerNames.length || !schedulerNames.length ? 'KSampler 没有可用的采样器或调度器列表。' : ''), lora: fluxHasLora },
    anima: { available: anima && samplerNames.length > 0 && schedulerNames.length > 0, label: TEMPLATE_LABELS.anima,
      reason: !anima ? `Anima 模板缺少 ComfyUI 接口或模型类型：${animaMissing.join('、')}。请更新 ComfyUI；若缺模型，请安装对应模型后刷新列表。` : (!samplerNames.length || !schedulerNames.length ? 'KSampler 没有可用的采样器或调度器列表。' : ''), lora: fluxHasLora },
  }
  const list = (name, key) => choices(objectInfo?.[name], key)
  return {
    templates,
    checkpoints: list('CheckpointLoaderSimple', 'ckpt_name'),
    unets: list('UNETLoader', 'unet_name'),
    fluxUnets,
    animaUnets,
    clips: list('CLIPLoader', 'clip_name'),
    dualClips: list('DualCLIPLoader', 'clip_name1'),
    dualClips1: list('DualCLIPLoader', 'clip_name1'),
    dualClips2: list('DualCLIPLoader', 'clip_name2'),
    vaes,
    loras: list('LoraLoader', 'lora_name').length ? list('LoraLoader', 'lora_name') : list('LoraLoaderModelOnly', 'lora_name'),
    samplers: samplerNames,
    schedulers: schedulerNames,
  }
}

function fail(reason) { throw new Error(reason) }

/** Build an API-format prompt after checking that the connected ComfyUI exposes every node and input. */
export function buildComfySimpleWorkflow(rawConfig, objectInfo) {
  const config = normalizeComfySimpleConfig(rawConfig)
  const inventory = inspectComfySimple(objectInfo)
  const support = inventory.templates[config.template]
  if (!support?.available) fail(support?.reason || '这个简单模式模板当前不可用。')
  const prompt = {}
  const bindings = { positive: [], negative: [], seed: [], batch: [], size: [], steps: [], cfg: [], guidance: [], model: [], loras: [], sampler: [] }
  let serial = 1
  const id = () => String(serial++)
  const add = (class_type, inputs) => { const node = id(); prompt[node] = { class_type, inputs }; return node }
  const link = (node, slot = 0) => [String(node), slot]
  const pick = (requested, values, label) => {
    if (!values.length) fail(`ComfyUI 没有可用的${label}列表。`)
    if (requested && !values.includes(requested)) fail(`已选择的${label}「${requested}」不在 ComfyUI 当前列表中，请刷新列表后重新选择。`)
    return requested || values[0]
  }
  const sampler = pick(config.sampler, inventory.samplers, '采样器')
  const scheduler = pick(config.scheduler, inventory.schedulers, '调度器')

  let model, clip, vae
  if (config.template === 'checkpoint') {
    const ckptName = pick(config.checkpoint, inventory.checkpoints, 'Checkpoint')
    const checkpoint = add('CheckpointLoaderSimple', { ckpt_name: ckptName })
    model = link(checkpoint, 0); clip = link(checkpoint, 1); vae = link(checkpoint, 2)
    if (config.vae) {
      const vaeName = pick(config.vae, inventory.vaes, 'VAE')
      vae = link(add('VAELoader', { vae_name: vaeName }))
    }
  } else {
    const selectedUnets = config.template === 'flux' ? inventory.fluxUnets : inventory.animaUnets
    const unetName = pick(config.unet, selectedUnets, config.template === 'flux' ? 'Flux UNet' : 'Anima 扩散模型')
    const dtypes = choices(objectInfo.UNETLoader, 'weight_dtype')
    const dtype = dtypes.includes('default') ? 'default' : dtypes[0]
    const modelNode = add('UNETLoader', { unet_name: unetName, weight_dtype: dtype })
    model = link(modelNode)
    if (config.template === 'flux') {
      const clips = choices(objectInfo.DualCLIPLoader, 'clip_name1')
      const clips2 = choices(objectInfo.DualCLIPLoader, 'clip_name2')
      const clip1Default = clips.find(isT5) || ''
      const clip2Default = clips2.find(isClipL) || ''
      if (!(config.clip1 || clip1Default)) fail('请选择 Flux 的 T5-XXL 编码器（DualCLIPLoader 的 clip_name1）。')
      if (!(config.clip2 || clip2Default)) fail('请选择 Flux 的 CLIP-L 编码器（DualCLIPLoader 的 clip_name2）。')
      const clip1 = pick(config.clip1 || clip1Default, clips, 'Flux T5-XXL（DualCLIPLoader 的 clip_name1）')
      const clip2 = pick(config.clip2 || clip2Default, clips2, 'Flux CLIP-L（DualCLIPLoader 的 clip_name2）')
      if (!isT5(clip1)) fail(`Flux 的第一个编码器必须是 T5-XXL；「${clip1}」看起来不是 T5 模型。`)
      if (!isClipL(clip2)) fail(`Flux 的第二个编码器必须是 CLIP-L；「${clip2}」看起来不是 CLIP-L 模型。`)
      if (clip1 === clip2) fail('Flux 的 T5-XXL 与 CLIP-L 不能使用同一个文件；请分别选择两个文本编码器。')
      const devices = choices(objectInfo.DualCLIPLoader, 'device')
      const clipNode = add('DualCLIPLoader', { clip_name1: clip1, clip_name2: clip2, type: 'flux', ...(devices.length ? { device: devices.includes('default') ? 'default' : devices[0] } : {}) })
      clip = link(clipNode)
    } else {
      if (!/anima/i.test(unetName)) fail(`Anima 模板需要 Anima 扩散模型；「${unetName}」名称无法识别为 Anima。请刷新列表并选择 Anima 模型。`)
      const animaClips = choices(objectInfo.CLIPLoader, 'clip_name')
      const qwenDefault = animaClips.find(name => /qwen/i.test(name)) || ''
      if (!(config.clip1 || qwenDefault)) fail('请选择 Anima 使用的 Qwen CLIP（例如 qwen_3_06b_base）。')
      const clipName = pick(config.clip1 || qwenDefault, animaClips, 'Anima Qwen CLIP')
      clip = link(add('CLIPLoader', { clip_name: clipName, type: 'stable_diffusion' }))
    }
    const recommendedVae = config.template === 'flux'
      ? inventory.vaes.find(name => /(?:^|[\\/])ae(?:[._-]|$)/i.test(name))
      : inventory.vaes.find(name => /qwen[_ -]?image[_ -]?vae/i.test(name))
    if (!config.vae && !recommendedVae) {
      fail(config.template === 'flux'
        ? '未识别到标准 Flux VAE（ae.safetensors）；请在简单模式中明确选择 Flux VAE。'
        : '未识别到标准 Anima VAE（qwen_image_vae.safetensors）；请在简单模式中明确选择 Anima VAE。')
    }
    const vaeName = pick(config.vae || recommendedVae, inventory.vaes, 'VAE')
    vae = link(add('VAELoader', { vae_name: vaeName }))
  }

  // LoRA nodes are chained into the correct model path. Flux/Anima touch MODEL; checkpoints pass MODEL and CLIP.
  for (const lora of config.loras.filter(item => item.enabled && item.name)) {
    const names = inventory.loras
    pick(lora.name, names, 'LoRA')
    if (config.template !== 'checkpoint') {
      if (!support.lora) fail('当前 ComfyUI 缺少 LoraLoaderModelOnly，不能安全地把 LoRA 接到 Flux 模型。')
      const node = add('LoraLoaderModelOnly', { model, lora_name: lora.name, strength_model: lora.strengthModel })
      model = link(node)
    } else {
      if (!support.lora) fail('当前 ComfyUI 缺少 LoraLoader，不能安全地把 LoRA 接到 Checkpoint 模型。')
      const node = add('LoraLoader', { model, clip, lora_name: lora.name, strength_model: lora.strengthModel, strength_clip: lora.strengthClip })
      model = link(node, 0); clip = link(node, 1)
    }
    bindings.loras.push({ node: String(serial - 1), name: lora.name, enabled: true, strengthModel: lora.strengthModel, strengthClip: lora.strengthClip })
  }

  const posNode = add('CLIPTextEncode', { clip, text: '' })
  const negNode = add('CLIPTextEncode', { clip, text: '' })
  bindings.positive.push({ node: posNode, input: 'text' })
  bindings.negative.push({ node: negNode, input: 'text' })
  let positive = link(posNode)
  if (config.template === 'flux') {
    const guidance = add('FluxGuidance', { conditioning: positive, guidance: config.cfg })
    positive = link(guidance)
    bindings.guidance.push({ node: guidance, input: 'guidance' })
  }

  const latent = add(config.template === 'flux' ? 'EmptySD3LatentImage' : 'EmptyLatentImage', { width: config.width, height: config.height, batch_size: 1 })
  bindings.size.push({ node: latent, input: 'width' }, { node: latent, input: 'height' })
  const sample = add('KSampler', {
    model, positive, negative: link(negNode), latent_image: link(latent),
    seed: config.seed ?? randomInt(0, 2 ** 47), steps: config.steps,
    cfg: config.template === 'flux' ? 1 : config.cfg,
    sampler_name: sampler, scheduler, denoise: 1,
  })
  bindings.seed.push({ node: sample, input: 'seed' })
  bindings.steps.push({ node: sample, input: 'steps' })
  if (config.template !== 'flux') bindings.cfg.push({ node: sample, input: 'cfg' })
  bindings.sampler.push({ node: sample, input: 'sampler_name' }, { node: sample, input: 'scheduler' })
  const decoded = add('VAEDecode', { samples: link(sample), vae })
  const outputNode = add('SaveImage', { images: link(decoded), filename_prefix: 'dsh-tavern' })
  return {
    workflow: { id: `simple-${config.template}`, label: `简单模式 · ${support.label}`, prompt, bindings, outputNode, sizes: { '竖图': { width: config.width, height: config.height }, '横图': { width: config.width, height: config.height }, '方图': { width: config.width, height: config.height } }, fixedSeed: config.seed },
    config,
    inventory,
  }
}
