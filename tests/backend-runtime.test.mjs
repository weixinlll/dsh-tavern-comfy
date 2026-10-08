import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url))
const block = (tag, anchor = tag) => `<image><regex>${anchor}</regex><title>画面</title><prompts>${tag}</prompts></image>`
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Load the actual host implementation in an isolated plugin directory so routes,
// persistence and workflow compilation run without changing installed user data.
async function runtime(t, stream, definitions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-comfy-test-'))
  await mkdir(join(root, 'lib')); await mkdir(join(root, 'workflows'))
  for (const name of ['index.js', 'planner.js', 'prompts.js', 'tavern-bridge.js']) await copyFile(join(source, 'lib', name), join(root, 'lib', name))
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'worldbook.json'), JSON.stringify({ name: 'test', entries: [] }))
  await writeFile(join(root, 'definitions.json'), JSON.stringify(definitions))
  await writeFile(join(root, 'workflows', 'test.json'), JSON.stringify({
    format: 'dsh-tavern-comfy-v1', outputNode: '2',
    prompt: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
    bindings: { positive: [{ node: '1', input: 'text' }] },
  }))
  const routes = new Map(), disposes = [], events = [], submitted = []
  const firstPrompt = deferred()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(input)
    if (url.pathname === '/prompt') {
      const prompt = JSON.parse(options.body).prompt
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
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } },
    inject(names, install) { if (names.every(name => this[name])) install(this) },
    effect(install) { const off = install(); if (typeof off === 'function') disposes.push(off); return off },
  }
  const { apply } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  apply(ctx, { plannerProvider: 'mock', plannerModel: 'mock', plannerCount: 2 })
  t.after(async () => {
    for (const dispose of disposes.reverse()) dispose()
    globalThis.fetch = originalFetch
    // Pending atomic saves finish before removing this verified temporary fixture.
    await delay(40)
    assert.equal(resolve(root).startsWith(resolve(tmpdir())), true)
    assert.ok(basename(root).startsWith('dsh-comfy-test-'))
    await rm(root, { recursive: true, force: true })
  })
  function request(path, body, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: '/plugins/dsh-tavern-comfy/' + path, headers: { host: 'localhost' } })
      const response = {
        headersSent: false,
        writeHead(status) { this.status = status; this.headersSent = true },
        end(body) { try { resolve({ status: this.status, body: JSON.parse(String(body)) }) } catch (error) { reject(error) } },
      }
      routes.get(req.url)(req, response)
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
