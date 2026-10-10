import test from 'node:test'
import assert from 'node:assert/strict'
import { IMAGE_PROVIDERS, generateImage, testImageChannel } from '../lib/image-providers.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const b64 = png.toString('base64')
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const image = value => new Response(value, { headers: { 'content-type': 'image/png' } })
const channel = (provider, extra = {}) => ({ provider, baseUrl: 'https://provider.test/v1', model: '', apiKey: 'top-secret', authMode: 'bearer', options: {}, ...extra })
const request = { positive: 'A blue bird', negative: 'blur', width: 512, height: 768, seed: 9, steps: 22, cfg: 6 }

function storedZip(name, contents) {
  const file = Buffer.from(name), crc = 0, size = contents.length
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(file.length, 26)
  const localRecord = Buffer.concat([local, file, contents])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(file.length, 28)
  const centralRecord = Buffer.concat([central, file])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralRecord.length, 12); end.writeUInt32LE(localRecord.length, 16)
  return Buffer.concat([localRecord, centralRecord, end])
}
function mockFetch(fn) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), ...init }); return fn(String(url), init, calls.length) }
  return { fetchImpl, calls }
}

test('exports all requested providers with stable ids and localized labels', () => {
  assert.deepEqual(IMAGE_PROVIDERS.map(x => x.id), ['novelai', 'openai', 'gemini', 'gemini-chat', 'grok', 'seedream', 'qwen', 'sdwebui'])
  assert.equal(IMAGE_PROVIDERS.find(x => x.id === 'qwen').model, 'qwen-image-3.0')
})

test('NovelAI sends separate positive/negative prompts and extracts a bounded ZIP image', async () => {
  const zip = storedZip('result.png', png), { fetchImpl, calls } = mockFetch(() => new Response(zip))
  const out = await generateImage(channel('novelai', { baseUrl: 'https://image.test' }), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://image.test/ai/generate-image')
  assert.equal(body.input, request.positive)
  assert.equal(body.parameters.negative_prompt, request.negative)
  assert.equal(body.parameters.steps, request.steps)
  assert.equal(body.parameters.scale, request.cfg)
  assert.deepEqual(body.parameters.v4_prompt, { caption: { base_caption: request.positive, char_captions: [] }, use_coords: false, use_order: true })
  assert.deepEqual(body.parameters.v4_negative_prompt, { caption: { base_caption: request.negative, char_captions: [] }, legacy_uc: false })
  assert.equal(out.mediaType, 'image/png')
  assert.deepEqual(out.bytes, png)
})

test('NovelAI option CFG, steps, and explicit dimensions override request defaults', async () => {
  const zip = storedZip('result.png', png), { fetchImpl, calls } = mockFetch(() => new Response(zip))
  await generateImage(channel('novelai', { baseUrl: 'https://image.test', options: { cfg: 4.5, steps: 31, size: '1024x1536' } }), { ...request, cfg: undefined, steps: undefined }, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.parameters.scale, 4.5)
  assert.equal(body.parameters.steps, 31)
  assert.equal(body.parameters.width, 1024)
  assert.equal(body.parameters.height, 1536)
})

test('OpenAI Images uses an orientation size and returns validated base64 image bytes', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  const out = await generateImage(channel('openai'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal(body.size, '1024x1536')
  assert.equal(body.quality, 'medium')
  assert.deepEqual(out.bytes, png)
})

test('blank OpenAI size option is ignored and supported explicit size is honored', async () => {
  const first = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('openai', { options: { size: '' } }), request, { fetchImpl: first.fetchImpl })
  assert.equal(JSON.parse(first.calls[0].body).size, '1024x1536')
  const second = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('openai', { options: { size: '1024x1024' } }), request, { fetchImpl: second.fetchImpl })
  assert.equal(JSON.parse(second.calls[0].body).size, '1024x1024')
})

test('Gemini native uses documented generateContent route and x-goog-api-key auth', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }] } }] }))
  await generateImage(channel('gemini'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.match(calls[0].url, /\/models\/gemini-3\.1-flash-image:generateContent$/)
  assert.equal(calls[0].headers['x-goog-api-key'], 'top-secret')
  assert.equal(calls[0].headers.authorization, undefined)
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE'])
  assert.equal(body.contents[0].parts[0].text, 'A blue bird\n\nAvoid: blur')
})

test('Gemini chat parses markdown image URLs and never forwards credentials to the image host', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ choices: [{ message: { content: 'Rendered: ![image](https://cdn.test/out.png)' } }] }) : image(png))
  const out = await generateImage(channel('gemini-chat'), request, { fetchImpl })
  assert.deepEqual(out.bytes, png)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://cdn.test/out.png')
  assert.deepEqual(calls[1].headers, {})
  assert.equal(calls[0].redirect, 'error')
})

test('Gemini chat extracts inline data URLs from OpenRouter-style content parts', async () => {
  const { fetchImpl } = mockFetch(() => json({ choices: [{ message: { content: [{ type: 'text', text: 'done' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] } }] }))
  const out = await generateImage(channel('gemini-chat'), request, { fetchImpl })
  assert.deepEqual(out.bytes, png)
})

test('Grok uses its documented image endpoint without unsupported dimension parameters', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('grok'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal('size' in body, false)
})

test('Seedream uses the OpenAI-compatible Ark images route', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('seedream'), request, { fetchImpl })
  assert.equal(calls[0].url, 'https://provider.test/v1/images/generations')
  assert.equal(JSON.parse(calls[0].body).model, 'doubao-seedream-5-0-pro-260628')
  assert.equal(JSON.parse(calls[0].body).size, '2K')
})

test('Seedream honors valid size tier overrides', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ data: [{ b64_json: b64 }] }))
  await generateImage(channel('seedream', { options: { size: '1.5K' } }), request, { fetchImpl })
  assert.equal(JSON.parse(calls[0].body).size, '1.5K')
})

test('Qwen-Image uses current sync multimodal-generation schema without async header', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${b64}` }] } }] } }))
  const out = await generateImage(channel('qwen'), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.match(calls[0].url, /multimodal-generation\/generation$/)
  assert.equal(body.model, 'qwen-image-3.0')
  assert.equal(body.input.messages[0].content[0].text, request.positive)
  assert.equal(body.parameters.negative_prompt, request.negative)
  assert.equal(body.parameters.seed, request.seed)
  assert.equal(calls[0].headers['X-DashScope-Async'], undefined)
  assert.deepEqual(out.bytes, png)
})

test('Qwen-Image normalizes a 32-bit plugin seed to documented signed range', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${b64}` }] } }] } }))
  await generateImage(channel('qwen'), { ...request, seed: 0xffffffff }, { fetchImpl })
  assert.equal(JSON.parse(calls[0].body).parameters.seed, 2147483647)
})

test('legacy DashScope async task path polls without retrying generation', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ output: { task_id: 'task-1', task_status: 'PENDING' } }) : n === 2 ? json({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.test/qwen.png' }] } }) : image(png))
  const out = await generateImage(channel('qwen', { options: { apiMode: 'async', pollIntervalMs: 1 } }), request, { fetchImpl })
  assert.equal(calls.length, 3)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['X-DashScope-Async'], 'enable')
  assert.equal(calls[1].method, 'GET')
  assert.deepEqual(calls[2].headers, {})
  assert.deepEqual(out.bytes, png)
})

test('SD WebUI uses its txt2img API and keeps positive and negative prompts separate', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ images: [b64] }))
  await generateImage(channel('sdwebui', { baseUrl: 'http://forge.test:7860' }), request, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(calls[0].url, 'http://forge.test:7860/sdapi/v1/txt2img')
  assert.equal(body.prompt, request.positive)
  assert.equal(body.negative_prompt, request.negative)
  assert.equal(body.steps, request.steps)
})

test('SD WebUI honors option steps, CFG, explicit size, and aspect ratio', async () => {
  const { fetchImpl, calls } = mockFetch(() => json({ images: [b64] }))
  await generateImage(channel('sdwebui', { baseUrl: 'http://forge.test:7860', options: { steps: 33, cfg: 8.5, size: '1024x1024', aspectRatio: '2:3' } }), { ...request, cfg: undefined, steps: undefined }, { fetchImpl })
  const body = JSON.parse(calls[0].body)
  assert.equal(body.steps, 33)
  assert.equal(body.cfg_scale, 8.5)
  assert.equal(body.width, 840)
  assert.equal(body.height, 1256)
})

test('rejects non-HTTP endpoints, absolute override paths, invalid images, and oversized bytes', async () => {
  await assert.rejects(generateImage(channel('openai', { baseUrl: 'file:///tmp' }), request, { fetchImpl: async () => json({}) }), /HTTP\(S\)/)
  await assert.rejects(generateImage(channel('openai', { options: { generatePath: 'https://steal.test/generate' } }), request, { fetchImpl: async () => json({}) }), /relative|相对/)
  const bad = mockFetch(() => json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }))
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: bad.fetchImpl }), /受支持的图片格式|不是有效图片/)
  const large = mockFetch(() => json({ data: [{ b64_json: Buffer.alloc(5000).toString('base64') }] }))
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl: large.fetchImpl, maxImageBytes: 1024 }), /过大|size|limit/i)
})

test('errors redact secrets and generation requests are never retried', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ error: { message: `invalid key top-secret` } }), { status: 401 }) }
  await assert.rejects(generateImage(channel('openai'), request, { fetchImpl }), error => !error.message.includes('top-secret') && /redacted/.test(error.message))
  assert.equal(calls, 1)
})

test('testImageChannel uses only a safe read-only model probe and generation-free configured result otherwise', async () => {
  const safe = mockFetch(() => json({ data: [{ id: 'img-model' }] }))
  const result = await testImageChannel(channel('openai'), { fetchImpl: safe.fetchImpl })
  assert.equal(result.status, 'reachable')
  assert.deepEqual(result.models, ['img-model'])
  assert.equal(safe.calls[0].method, 'GET')
  const configured = await testImageChannel(channel('novelai'), { fetchImpl: async () => { throw new Error('must not call') } })
  assert.equal(configured.status, 'configured')
})

test('external image URLs receive neither bearer nor Basic credentials', async () => {
  const { fetchImpl, calls } = mockFetch((_url, _init, n) => n === 1 ? json({ data: [{ url: 'https://cdn.test/image.png' }] }) : image(png))
  await generateImage(channel('openai', { authMode: 'basic', username: 'user', password: 'secret-pass' }), request, { fetchImpl })
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('user:secret-pass').toString('base64')}`)
  assert.deepEqual(calls[1].headers, {})
})

test('abort signal stops a pending provider request', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  const pending = generateImage(channel('openai'), request, { fetchImpl, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending)
})
