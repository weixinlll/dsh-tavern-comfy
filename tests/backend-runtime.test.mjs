import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const PNG = require('../lib/vendor/pngjs/lib/png.js').PNG
const block = (tag, anchor = tag) => `<image><regex>${anchor}</regex><title>画面</title><prompts>${tag}</prompts></image>`
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Load the actual host implementation in an isolated plugin directory so routes,
// persistence and workflow compilation run without changing installed user data.
async function runtime(t, stream, definitions = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-comfy-test-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  await cp(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify(definitions))
  if (options.initialJobs) await writeFile(join(root, 'jobs-store.json'), JSON.stringify(options.initialJobs))
  await writeFile(join(root, 'workflows', 'test.json'), JSON.stringify({
    format: 'dsh-tavern-comfy-v1', outputNode: '2',
    prompt: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
    bindings: { positive: [{ node: '1', input: 'text' }] },
  }))
  const routes = new Map(), disposes = [], events = [], submitted = []
  const firstPrompt = deferred()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (options.fetch && url.hostname === 'image.test') return options.fetch(input, init)
    if (url.pathname === '/prompt') {
      const prompt = JSON.parse(init.body).prompt
      submitted.push(prompt['1'].inputs.text)
      events.push('submit:' + submitted.length); firstPrompt.resolve()
      return new Response(JSON.stringify({ prompt_id: 'comfy-' + submitted.length }), { status: 200 })
    }
    return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), { status: 200 })
  }
  const logger = { info() {}, warn() {}, error() {} }
  const ctx = {
    logger,
    llm: { stream: args => stream(args, { events, submitted, firstPrompt }) },
    ...(options.tavern ? { tavern: options.tavern } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  apply(ctx, { plannerProvider: 'mock', plannerModel: 'mock', plannerCount: 2, ...options.config })
  if (options.tavern) {
    for (let i = 0; i < 100 && !options.tavern.bridgeReady; i++) await delay(5)
    assert.equal(options.tavern.bridgeReady, true, 'Tavern bridge should register through the official API')
  }
  t.after(async () => {
    for (const dispose of disposes.reverse()) dispose()
    globalThis.fetch = originalFetch
    // Pending atomic saves finish before removing this verified temporary fixture.
    await delay(40)
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    assert.ok(basename(root).startsWith('dsh-comfy-test-'))
    await rm(root, { recursive: true, force: true })
  })
  function request(path, body, method = 'POST', headers = {}) {
    return new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: '/plugins/dsh-tavern-comfy/' + path, headers: { host: 'localhost', 'content-type': 'application/json', ...headers } })
      const response = {
        headersSent: false,
        writeHead(status) { this.status = status; this.headersSent = true },
        end(body) { try { resolve({ status: this.status, body: JSON.parse(String(body)) }) } catch (error) { reject(error) } },
      }
      routes.get(req.url.split('?')[0])(req, response)
    })
  }
  return { request, events, submitted, firstPrompt, root }
}

test('host starts the first complete image while the planner stream is still open; duplicate/extra blocks stay capped', async t => {
  const continueStream = deferred()
  const f = await runtime(t, async function* (_args, state) {
    yield { type: 'text-delta', text: '<image><regex>first</regex><prompts>first' }
    await delay(15)
    assert.equal(state.submitted.length, 0, 'unclosed XML must not submit')
    yield { type: 'text-delta', text: '</prompts></image>' }
    await state.firstPrompt.promise
    state.events.push('stream-still-open')
    await continueStream.promise
    yield { type: 'text-delta', text: block('first', 'first') + block('second') + block('third') }
    state.events.push('stream-finished')
  })
  const request = f.request('plan', { text: '正文', messageId: 'message-1', sessionId: 'game', count: 2, manual: true })
  await f.firstPrompt.promise
  await delay(5)
  assert.deepEqual(f.events.slice(0, 2), ['submit:1', 'stream-still-open'])
  continueStream.resolve()
  const result = await request
  assert.equal(result.status, 200)
  assert.equal(result.body.plans.length, 2)
  assert.deepEqual(f.submitted, ['first', 'second'])
  assert.ok(f.events.indexOf('submit:1') < f.events.indexOf('stream-finished'))
  await delay(25)
  const jobs = Object.values(JSON.parse(await readFile(join(f.root, 'jobs-store.json'), 'utf8')))
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every(job => job.workflowId === 'test' && job.outputNode === '2' && job.comfyId?.startsWith('comfy-')))
})

test('a stream error preserves complete submitted images, marks the plan failed, and allows retry without duplicate GPU jobs', async t => {
  let calls = 0
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: block('first') }
    if (++calls === 1) throw new Error('temporary stream failure')
    yield { type: 'text-delta', text: block('second') }
  })
  const input = { text: '正文', messageId: 'retry-message', manual: true }
  const failed = await f.request('plan', input)
  assert.equal(failed.body.plans.length, 1)
  assert.match(failed.body.error, /temporary stream failure/)
  const retried = await f.request('plan', input)
  assert.equal(retried.body.error, null)
  assert.equal(retried.body.plans.length, 2)
  assert.deepEqual(f.submitted, ['first', 'second'])
})

test('empty or incomplete output reports a retryable planning error with no GPU submission', async t => {
  const f = await runtime(t, async function* () { yield { type: 'text-delta', text: '<image><prompts>unfinished' } })
  const result = await f.request('plan', { text: '正文', manual: true })
  assert.equal(result.body.plans.length, 0)
  assert.match(result.body.error, /image/)
  assert.equal(f.submitted.length, 0)
})

test('attach-turn applies a permanent appearance update to this image and reuses it on the next turn', async t => {
  const state = {
    current: { gameId: 'story-game', turn: 1, textVersion: 'text-v1', text: 'Luna cut her hair permanently.', card: { id: 'card-1', name: 'Luna card' } },
    snapshots: [], media: [], systems: [], imageRequests: [],
  }
  let timeline
  let gatedHistoryRead = null
  let historySaves = 0
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} },
    onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged(handler) { timeline = handler; return () => {} },
    onGameRemoved() { return () => {} },
    async getTurn({ turn }) { return state.current.turn === turn ? state.current : null },
    async list() { return state.media },
    async readTurnData({ turn }) {
      const gate = gatedHistoryRead
      if (gate) { gatedHistoryRead = null; gate.started.resolve(); await gate.release.promise }
      return state.snapshots.filter(item => item.turn <= turn).at(-1) ?? null
    },
    async saveTurnData({ turn, textVersion, data }) {
      if (state.current.turn !== turn || state.current.textVersion !== textVersion) throw new Error('stale version')
      historySaves++
      state.snapshots = state.snapshots.filter(item => item.turn !== turn)
      state.snapshots.push({ turn, textVersion, data })
    },
    async attach({ item, textVersion }) {
      const media = { ...item, id: 'media-' + state.media.length, textVersion }
      state.media.push(media); return { id: media.id }
    },
    async update(id, changes) { Object.assign(state.media.find(item => item.id === id), changes) },
    async remove(id) { state.media = state.media.filter(item => item.id !== id) },
  }
  const original = { id: 'role-1', name: 'Luna', match: 'luna', traits: { face: 'black hair, blue eyes' } }
  const f = await runtime(t, async function* (args) {
    state.systems.push(args.system)
    yield { type: 'text-delta', text: '<character_updates>{"updates":[{"id":"role-1","name":"Luna","permanent":true,"fields":{"face":"white hair, blue eyes"},"reason":"正文明确写她永久剪短头发"}]}</character_updates><decision>draw</decision><reason>新的外观变化</reason>' + block('${"name":"Luna","upperBody":"sfw"}$', 'Luna') }
  }, { characters: [original] }, {
    tavern,
    attachments: { async saveImage({ data }) { return { id: 'attachment-' + data.byteLength } } },
    config: {
      imageBackend: 'openai', activeImageChannel: 'primary',
      imageChannels: [{ id: 'primary', provider: 'openai', name: 'Image test', baseUrl: 'https://image.test/v1', model: 'image-model', apiKey: 'test-key', options: {} }],
    },
    fetch: async (url, init) => {
      state.imageRequests.push(JSON.parse(init.body))
      return Response.json({ data: [{ b64_json: png }] })
    },
  })
  const first = await f.request('attach-turn', { gameId: 'story-game', turn: 1 })
  assert.equal(first.body.ok, true)
  assert.equal(first.body.attached, 1)
  assert.match(state.imageRequests[0].prompt, /white hair/)
  assert.match(state.imageRequests[0].prompt, /blue eyes/)
  assert.equal(JSON.parse(await readFile(join(f.root, 'definitions.json'), 'utf8')).characters[0].traits.face, 'black hair, blue eyes')
  assert.equal(state.snapshots[0].data.characters['role-1'].traits.face, 'white hair, blue eyes')

  const turn1 = state.current
  state.current = { ...state.current, turn: 2, textVersion: 'text-v2', text: 'Luna looks at the window.' }
  const second = await f.request('attach-turn', { gameId: 'story-game', turn: 2 })
  assert.equal(second.body.ok, true)
  assert.match(state.systems[1], /white hair, blue eyes/)
  assert.match(state.imageRequests[1].prompt, /white hair/)
  assert.match(state.imageRequests[1].prompt, /blue eyes/)
  assert.equal(state.snapshots.length, 2)
  const history = await f.request('character-history?gameId=story-game', undefined, 'GET')
  assert.equal(history.body.available, true)
  assert.equal(history.body.currentTurn, 2)
  const expectedChange = history.body.snapshot.changes[0]
  const restored = await f.request('character-history', { gameId: 'story-game', changeIndex: 0, expectedChange })
  assert.equal(restored.body.ok, true)
  const currentSnapshot = await tavern.readTurnData({ turn: 2 })
  assert.equal(currentSnapshot.data.characters['role-1'].traits.face, 'black hair, blue eyes')
  assert.equal(currentSnapshot.data.changes.at(-1).reason, '玩家从角色历史手动恢复')
  assert.equal(currentSnapshot.data.changes.at(-1).turn, 2)
  currentSnapshot.data.changes[0] = { ...currentSnapshot.data.changes[0], after: 'different history event' }
  const staleRestore = await f.request('character-history', { gameId: 'story-game', changeIndex: 0, expectedChange })
  assert.equal(staleRestore.status, 400)
  assert.match(staleRestore.body.error, /已变化/)

  state.current = turn1
  timeline({ gameId: 'story-game', kind: 'rollback', turn: 1 })
  const rolledBack = await f.request('character-history?gameId=story-game', undefined, 'GET')
  assert.equal(rolledBack.body.currentTurn, 1)
  assert.equal(rolledBack.body.snapshot.characters['role-1'].traits.face, 'white hair, blue eyes')

  const readGate = { started: deferred(), release: deferred() }
  gatedHistoryRead = readGate
  const saveCount = historySaves
  const restoreAfterTurnChange = f.request('character-history', {
    gameId: 'story-game', changeIndex: 0, expectedChange: rolledBack.body.snapshot.changes[0],
  })
  await readGate.started.promise
  timeline({ gameId: 'story-game', kind: 'edit', turn: 2 })
  readGate.release.resolve()
  const rejectedStaleTurnRestore = await restoreAfterTurnChange
  assert.equal(rejectedStaleTurnRestore.status, 400)
  assert.match(rejectedStaleTurnRestore.body.error, /轮次已变化/)
  assert.equal(historySaves, saveCount, 'a stale-turn restore must not write the old snapshot')
})

test('missing story history output is saved with a visible warning', async t => {
  const state = { current: { gameId: 'warning-game', turn: 1, textVersion: 'warning-v1', text: 'A quiet scene.' }, saved: null }
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} }, onTurnSettled() { this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async attach() { return { id: 'unused' } },
    async getTurn() { return state.current }, async list() { return [] },
    async readTurnData() { return state.saved }, async saveTurnData(input) { state.saved = { turn: input.turn, textVersion: input.textVersion, data: input.data } },
  }
  const f = await runtime(t, async function* () { yield { type: 'text-delta', text: '' } }, {}, { tavern, attachments: { async saveImage() { return { id: 'unused' } } } })
  await f.request('attach-turn', { gameId: 'warning-game', turn: 1 })
  const history = await f.request('character-history?gameId=warning-game', undefined, 'GET')
  assert.match(history.body.snapshot.warning, /缺少角色更新块/)
})

test('smart auto waits for one final decision before submitting or attaching images', async t => {
  const turn = { gameId: 'smart-game', turn: 1, textVersion: 'smart-v1', text: 'A dramatic scene.' }
  const media = []
  let settled, saved = false
  const tavern = {
    apiVersion: 2,
    promptSection() { return () => {} }, onTurnSettled(handler) { settled = handler; this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return turn }, async list() { return media },
    async readTurnData() { return null }, async saveTurnData() { saved = true },
    async attach({ item, textVersion }) { const row = { ...item, id: 'media-' + media.length, textVersion }; media.push(row); return { id: row.id } },
    async update(id, patch) { Object.assign(media.find(item => item.id === id), patch) },
    async remove(id) { const index = media.findIndex(item => item.id === id); if (index >= 0) media.splice(index, 1) },
  }
  let paidCalls = 0
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>first choice</reason>' + block('should never be submitted') }
    yield { type: 'text-delta', text: '<decision>skip</decision><reason>conflicting final choice</reason>' }
  }, {}, {
    tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: imageConfig,
    fetch: async () => { paidCalls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  settled(turn)
  for (let i = 0; i < 100 && !saved; i++) await delay(10)
  await delay(20)
  assert.equal(saved, true)
  assert.equal(paidCalls, 0)
  assert.equal(media.length, 0)
  assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0)
})

test('smart draw text followed by an LLM finish error creates no image jobs', async t => {
  const turn = { gameId: 'smart-error-game', turn: 1, textVersion: 'smart-error-v1', text: 'A dramatic scene.' }
  let settled, saved = false, paidCalls = 0
  const tavern = {
    apiVersion: 2, promptSection() { return () => {} },
    onTurnSettled(handler) { settled = handler; this.bridgeReady = true; return () => {} },
    onTimelineChanged() { return () => {} }, onGameRemoved() { return () => {} },
    async getTurn() { return turn }, async list() { return [] }, async readTurnData() { return null },
    async saveTurnData() { saved = true }, async attach() { throw new Error('must not attach') },
  }
  const f = await runtime(t, async function* () {
    yield { type: 'text-delta', text: '<decision>draw</decision><reason>promising scene</reason>' + block('must not be submitted') }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'planner stream failed' } } }
  }, {}, {
    tavern, attachments: { async saveImage() { return { id: 'unused' } } }, config: imageConfig,
    fetch: async () => { paidCalls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  settled(turn)
  for (let i = 0; i < 100 && !saved; i++) await delay(10)
  await delay(20)
  assert.equal(saved, true)
  assert.equal(paidCalls, 0)
  assert.equal((await f.request('history', undefined, 'GET')).body.jobs.length, 0)
})

test('definitions route preserves omitted clothing/settings/props and retains explicit empty-characters protection', async t => {
  const definitions = {
    characters: [{ id: 'person', name: '旧名字', traits: { face: 'brown hair' } }],
    outfits: [{ id: 'outfit', name: '旧服装', full: 'dress' }],
    settings: [{ id: 'setting', name: '场景', layout: 'room' }],
    props: [{ id: 'prop', name: '道具', appearance: 'book' }],
  }
  const f = await runtime(t, async function* () {}, definitions)
  const saved = await f.request('definitions', { definitions: { characters: [{ ...definitions.characters[0], name: '新名字' }] } })
  assert.equal(saved.body.ok, true)
  const onDisk = JSON.parse(await readFile(join(f.root, 'definitions.json'), 'utf8'))
  assert.equal(onDisk.characters[0].name, '新名字')
  assert.equal(onDisk.outfits[0].name, '旧服装')
  assert.equal(onDisk.settings[0].name, '场景')
  assert.equal(onDisk.props[0].name, '道具')
  const refused = await f.request('definitions', { definitions: { characters: [] } })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.refused, 'would-empty-characters')
})

test('plugin update routes enforce methods and reject cross-origin or non-JSON installation', async t => {
  const f = await runtime(t, async function* () {})
  assert.equal((await f.request('plugin-update', {}, 'POST')).status, 405)
  assert.equal((await f.request('plugin-update/apply', undefined, 'GET')).status, 405)
  assert.equal((await f.request('plugin-update/apply', {}, 'POST', { origin: 'https://example.invalid' })).status, 403)
  assert.equal((await f.request('plugin-update/apply', {}, 'POST', { 'content-type': 'text/plain' })).status, 403)
  const status = await f.request('plugin-update', undefined, 'GET')
  assert.equal(status.status, 200); assert.equal(status.body.supported, false)
  const update = await f.request('plugin-update/apply', { target: 'a'.repeat(40) })
  assert.equal(update.status, 400); assert.match(update.body.error, /先检查更新/)
})

const imageChannel = { id: 'primary', provider: 'openai', name: '测试渠道', baseUrl: 'https://image.test/v1', model: 'gpt-image-1', apiKey: 'fixture-secret', options: {} }
const imageConfig = { imageBackend: 'openai', activeImageChannel: 'primary', imageChannels: [imageChannel], imageConcurrency: 1 }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII='
const pngBytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.from([255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128, 255, 0, 0, 128]) })

test('channel saves preserve omitted credentials, support explicit clearing and never echo secrets', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig })
  const initial = await f.request('state', undefined, 'GET')
  const channel = initial.body.config.imageChannels[0]
  assert.equal(channel.hasApiKey, true)
  assert.equal(JSON.stringify(initial.body).includes('fixture-secret'), false)
  const saved = await f.request('config', { imageChannels: [{ ...channel, name: '新渠道名', apiKey: '' }] })
  assert.equal(saved.body.state.config.imageChannels[0].hasApiKey, true)
  assert.equal(JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8')).imageChannels[0].apiKey, 'fixture-secret')
  await f.request('config', { imageChannels: [{ ...channel, clearApiKey: true }] })
  assert.equal(JSON.parse(await readFile(join(f.root, 'config.json'), 'utf8')).imageChannels[0].apiKey, '')
  const invalid = await f.request('config', { imageBackend: 'novelai' })
  assert.equal(invalid.status, 400)
  assert.equal((await f.request('state', undefined, 'GET')).body.config.imageBackend, 'openai')
})

test('prompt preset config rejects unknown active IDs and reserves built-in IDs for built-ins', async t => {
  const f = await runtime(t, async function* () {})
  const saved = await f.request('config', { config: {
    activePromptPreset: 'missing-profile',
    promptPresets: [{ id: 'portrait-editorial', name: '自定义同名 ID', positive: 'my direction' }],
  } })
  assert.equal(saved.status, 200)
  const state = await f.request('state', undefined, 'GET')
  assert.equal(state.body.config.activePromptPreset, '')
  assert.equal(state.body.config.promptPresets[0].id, 'portrait-editorial-1')
  const valid = await f.request('config', { config: { activePromptPreset: 'portrait-editorial-1' } })
  assert.equal(valid.status, 200)
  assert.equal((await f.request('state', undefined, 'GET')).body.config.activePromptPreset, 'portrait-editorial-1')
})

test('external images return jobs immediately, honor concurrency, deduplicate parallel calls and save bytes', async t => {
  const release = deferred(), requests = []
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async (url, init) => {
    requests.push({ url, init })
    await release.promise
    return Response.json({ data: [{ b64_json: png }] })
  } })
  const input = { tag: 'sky', key: 'same-image', size: '1024x1024' }
  const [a, b] = await Promise.all([f.request('jobs', input), f.request('jobs', input)])
  assert.equal(a.body.id, b.body.id)
  assert.equal(a.body.backend, 'openai')
  const second = await f.request('jobs', { ...input, key: 'next-image' })
  await delay(5)
  assert.equal(requests.length, 1, 'second job must stay in the queue')
  assert.equal((await f.request('jobs?id=' + second.body.id, undefined, 'GET')).body.job.state, 'pending')
  release.resolve()
  let history
  for (let i = 0; i < 30; i++) {
    history = (await f.request('history', undefined, 'GET')).body.jobs
    if (history.every(job => job.state === 'done')) break
    await delay(10)
  }
  assert.equal(requests.length, 2)
  assert.equal(history.filter(job => job.state === 'done').length, 2)
  const bytes = await readFile(join(f.root, 'cache', a.body.id + '.img'))
  assert.equal(bytes.toString('base64'), png)
  await delay(20)
  assert.equal((await readFile(join(f.root, 'jobs-store.json'), 'utf8')).includes('fixture-secret'), false)
})

test('optional JPEG output converts external channel PNGs before caching and reports matching metadata', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: { ...imageConfig, jpegOutput: true, jpegQuality: 87 }, fetch: async () => new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) })
  const started = await f.request('jobs', { tag: 'sky', key: 'jpeg-output', size: '512x512' })
  for (let i = 0; i < 50; i++) {
    const job = (await f.request('jobs?id=' + started.body.id, undefined, 'GET')).body.job
    if (job.state === 'done') {
      assert.equal(job.mediaType, 'image/jpeg')
      const bytes = await readFile(join(f.root, 'cache', started.body.id + '.img'))
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8')
      const metadata = (await f.request('history', undefined, 'GET')).body.jobs.find(item => item.id === started.body.id)
      assert.equal(metadata.byteLength, bytes.length)
      return
    }
    await delay(15)
  }
  assert.fail('external image conversion did not finish')
})

test('optional JPEG output converts ComfyUI /view PNGs and preserves JPEG media metadata', async t => {
  const f = await runtime(t, async function* () {}, {}, {
    config: { imageBackend: 'comfyui', comfyUrl: 'http://image.test', jpegOutput: true },
    fetch: async input => {
      const url = new URL(input)
      if (url.pathname === '/prompt') return Response.json({ prompt_id: 'comfy-jpeg' })
      if (url.pathname === '/history/comfy-jpeg') return Response.json({ 'comfy-jpeg': { status: { completed: true }, outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } })
      if (url.pathname === '/view') return new Response(pngBytes, { headers: { 'content-type': 'image/png' } })
      if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
      throw new Error('unexpected Comfy endpoint ' + url.pathname)
    },
  })
  const started = await f.request('jobs', { tag: 'sky', key: 'comfy-jpeg' })
  for (let i = 0; i < 50; i++) {
    const job = (await f.request('jobs?id=' + started.body.id, undefined, 'GET')).body.job
    if (job.state === 'done') {
      assert.equal(job.mediaType, 'image/jpeg')
      const bytes = await readFile(join(f.root, 'cache', started.body.id + '.img'))
      assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8')
      const metadata = (await f.request('history', undefined, 'GET')).body.jobs.find(item => item.id === started.body.id)
      assert.equal(metadata.byteLength, bytes.length)
      return
    }
    await delay(15)
  }
  assert.fail('Comfy image conversion did not finish')
})

test('cancelling a queued channel job never sends its paid request', async t => {
  const release = deferred(); let calls = 0
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async () => {
    calls++; await release.promise
    return Response.json({ data: [{ b64_json: png }] })
  } })
  await f.request('jobs', { tag: 'one', size: '1024x1024' })
  const queued = await f.request('jobs', { tag: 'two', size: '1024x1024' })
  const cancelled = await f.request('cancel', { id: queued.body.id })
  assert.equal(cancelled.body.ok, true)
  release.resolve()
  await delay(30)
  assert.equal(calls, 1)
  assert.equal((await f.request('jobs?id=' + queued.body.id, undefined, 'GET')).body.job.state, 'cancelled')
})

test('restart marks persisted external requests failed without submitting them again', async t => {
  let calls = 0
  const id = '11111111-1111-4111-8111-111111111111'
  const f = await runtime(t, async function* () {}, {}, {
    config: imageConfig,
    initialJobs: { [id]: { id, state: 'running', percent: 0, createdAt: Date.now(), params: { tag: 'resume me' }, key: 'restart-key', backend: 'openai', channelId: 'primary', channelName: '测试渠道' } },
    fetch: async () => { calls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  await delay(20)
  const state = await f.request('state', undefined, 'GET')
  const restored = state.body.jobs.find(job => job.id === id)
  assert.equal(restored.state, 'failed')
  assert.match(restored.error, /未自动重试/)
  assert.equal(calls, 0, 'startup must never resubmit a potentially billable request')
})

test('an unavailable selected channel creates no job and sends no provider request', async t => {
  let calls = 0
  const f = await runtime(t, async function* () {}, {}, {
    config: { ...imageConfig, activeImageChannel: 'missing' },
    fetch: async () => { calls++; return Response.json({ data: [{ b64_json: png }] }) },
  })
  const response = await f.request('jobs', { tag: 'should not start', key: 'unavailable-channel' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /选择并保存/)
  assert.equal(calls, 0)
  assert.equal((await f.request('state', undefined, 'GET')).body.jobs.length, 0)
})

test('testing a workflow always uses that Comfy workflow even when an external channel is active', async t => {
  const f = await runtime(t, async function* () {}, {}, { config: imageConfig, fetch: async () => { throw new Error('must not use paid channel') } })
  const result = await f.request('workflow-test', { id: 'test', prompt: 'a person, (blue coat:1.2)' })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.job.backend, 'comfyui')
  assert.deepEqual(f.submitted, ['a person, (blue coat:1.2)'])
})

test('graph route saves parameters with revision checking and rejects traversal', async t => {
  const f = await runtime(t, async function* () {})
  const loaded = await f.request('workflow-graph', { file: 'workflows/test.json' })
  assert.equal(loaded.body.ok, true)
  const update = { file: 'test.json', revision: loaded.body.revision, patch: { inputs: { '1': { text: 'edited' } }, positions: { '1': { x: 100, y: 200 } } } }
  assert.equal((await f.request('workflow-graph', update)).body.ok, true)
  assert.equal((await f.request('workflow-graph', update)).status, 400)
  const saved = JSON.parse(await readFile(join(f.root, 'workflows', 'test.json'), 'utf8'))
  assert.equal(saved.prompt['1'].inputs.text, 'edited')
  assert.deepEqual(saved.prompt['2'].inputs.images, ['1', 0])
  assert.equal((await f.request('workflow-graph', { file: '../config.json' })).status, 400)
  assert.equal((await f.request('workflow-graph', {}, 'POST', { origin: 'https://bad.test' })).status, 403)
})
