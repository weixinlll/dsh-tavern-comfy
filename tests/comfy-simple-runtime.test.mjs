import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))
const combo = values => [values, {}]
const node = required => ({ input: { required } })
const objectInfo = {
  CheckpointLoaderSimple: node({ ckpt_name: combo(['local.safetensors']) }),
  CLIPTextEncode: node({ clip: ['CLIP', {}], text: ['STRING', {}] }),
  EmptyLatentImage: node({ width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] }),
  KSampler: node({ model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: combo(['euler']), scheduler: combo(['normal']), denoise: ['FLOAT', {}] }),
  VAEDecode: node({ samples: ['LATENT', {}], vae: ['VAE', {}] }),
  SaveImage: node({ images: ['IMAGE', {}], filename_prefix: ['STRING', {}] }),
}

test('simple mode reads capabilities without generating, then builds a job without importing a workflow', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-simple-runtime-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  for (const name of (await readdir(join(source, 'lib'))).filter(name => name.endsWith('.js'))) await copyFile(join(source, 'lib', name), join(root, 'lib', name))
  await cp(join(source, 'lib', 'vendor'), join(root, 'lib', 'vendor'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify({ characters: [], settings: [], props: [] }))
  await writeFile(join(root, 'workflows', 'custom.json'), JSON.stringify({
    format: 'dsh-tavern-comfy-v1',
    outputNode: '7',
    bindings: { positive: [{ node: '2', input: 'text' }], negative: [{ node: '3', input: 'text' }] },
    prompt: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'custom.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: '' } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 1, steps: 4, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'custom' } },
    },
  }))
  await writeFile(join(root, 'config.json'), JSON.stringify({ comfyUrl: 'http://comfy.test', comfyAuthMode: 'bearer', comfyAuthToken: 'test-token', comfyMode: 'simple', comfySimple: { checkpoint: 'local.safetensors', steps: 9, cfg: 8.25, sampler: 'euler', scheduler: 'normal', width: 1024, height: 640 } }))
  const originalFetch = globalThis.fetch
  const submitted = []
  const inventoryAuth = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (url.pathname === '/object_info') { inventoryAuth.push(init.headers.authorization); return new Response(JSON.stringify(objectInfo)) }
    if (url.pathname === '/prompt') { submitted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ prompt_id: 'simple-test' })) }
    if (url.pathname === '/system_stats') return new Response(JSON.stringify({ system: { comfyui_version: 'test' }, devices: [] }))
    return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }))
  }
  const routes = new Map(), disposes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  try {
    const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    apply(ctx)
    const request = (path, body) => new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))])
      Object.assign(req, { method: 'POST', url: '/plugins/dsh-tavern-image/' + path, headers: { host: 'localhost', 'content-type': 'application/json' } })
      const response = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true }, end(value) { try { resolve({ status: this.status, body: JSON.parse(String(value)) }) } catch (error) { reject(error) } } }
      routes.get(req.url)(req, response)
    })
    const inventory = await request('comfy-simple-info')
    assert.equal(inventory.body.ok, true)
    assert.equal(inventory.body.templates.checkpoint.available, true)
    assert.deepEqual(inventoryAuth, ['Bearer test-token'])
    assert.equal(submitted.length, 0, 'the inventory route must never submit /prompt')
    const generated = await request('generate', { tag: 'simple portrait' })
    assert.equal(generated.status, 200)
    assert.equal(submitted.length, 1)
    const prompt = submitted[0].prompt
    assert.equal(Object.values(prompt).find(item => item.class_type === 'CheckpointLoaderSimple').inputs.ckpt_name, 'local.safetensors')
    assert.deepEqual([Object.values(prompt).find(item => item.class_type === 'EmptyLatentImage').inputs.width, Object.values(prompt).find(item => item.class_type === 'EmptyLatentImage').inputs.height], [1024, 640])
    const sampler = Object.values(prompt).find(item => item.class_type === 'KSampler')
    assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.sampler_name, sampler.inputs.scheduler], [9, 8.25, 'euler', 'normal'])
    const customTest = await request('workflow-test', { file: 'custom.json' })
    assert.equal(customTest.status, 200, customTest.body.error)
    assert.equal(submitted.length, 2)
    assert.equal(Object.values(submitted[1].prompt).find(item => item.class_type === 'CheckpointLoaderSimple').inputs.ckpt_name, 'custom.safetensors', 'the explicit custom-workflow test must bypass simple mode')
  } finally {
    for (const dispose of disposes.reverse()) dispose()
    globalThis.fetch = originalFetch
    await delay(50)
    await rm(root, { recursive: true, force: true })
  }
})
