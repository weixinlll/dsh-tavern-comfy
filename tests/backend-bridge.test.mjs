import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { installTavernBridge } from '../lib/tavern-bridge.js'

const turn = { gameId: 'game', turn: 1, textVersion: 'v1', text: '正文'.repeat(120) }
const image = id => ({ jobId: id, mount: '正文', title: '画面' })
const done = id => ({ state: 'done', file: id + '.png' })
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10)
  assert.ok(predicate(), 'expected observable state before timeout')
}
function fixture(engine, options = {}) {
  const media = []
  const events = []
  let current = turn
  let settled, removed
  const tavern = {
    promptSection() { return () => events.push('off-prompt') },
    onTurnSettled(handler) { settled = handler; return () => events.push('off-settled') },
    onGameRemoved(handler) { removed = handler; return () => events.push('off-removed') },
    async getTurn() { return current },
    async list() { return media },
    async attach(input) {
      const item = { ...input.item, id: 'media-' + media.length, textVersion: input.textVersion }
      media.push(item); events.push('pending:' + item.data.jobId)
      return { id: item.id }
    },
    async update(id, patch) {
      const item = media.find(item => item.id === id)
      Object.assign(item, patch); events.push(patch.status + ':' + item.data.jobId)
    },
    async remove(id) {
      events.push('remove:' + id)
      const index = media.findIndex(item => item.id === id)
      if (index >= 0) media.splice(index, 1)
    },
  }
  const bridge = installTavernBridge({
    tavern, engine, getConfig: () => ({ plannerEnabled: true }),
    attachments: { saveImage: options.saveImage || (async () => ({ id: 'attachment' })) },
    readFileAsBytes: async () => new Uint8Array([1]),
  })
  return { bridge, events, media, settled: value => settled(value), remove: () => removed({ gameId: 'game' }), change: value => { current = value } }
}

test('independent waits show the second completed image before a pending first image; same version deduplicates', async () => {
  const jobs = { first: { state: 'pending' }, second: done('second') }
  let calls = 0
  const f = fixture({
    async planMessage({ onPlan }) { calls++; onPlan(image('first')); onPlan(image('second')); return { plans: [image('first'), image('second')] } },
    getJob: id => jobs[id],
  })
  try {
    const task = f.bridge.attachTurn(turn)
    assert.equal(f.bridge.attachTurn(turn), task)
    await until(() => f.events.includes('ready:second'))
    assert.ok(f.events.includes('pending:first'))
    assert.ok(!f.events.includes('ready:first'))
    jobs.first = done('first')
    assert.deepEqual(await task, { attached: 2, total: 2 })
    await f.bridge.attachTurn(turn)
    assert.equal(calls, 1)
    assert.equal(f.media.length, 2)
  } finally { f.bridge.dispose() }
})

test('automatic settled listener returns immediately without blocking the host', async () => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const f = fixture({ planMessage: async () => { await gate; return { plans: [] } }, getJob: () => null })
  assert.equal(f.settled(turn), undefined)
  f.bridge.dispose(); finish()
  await delay(10)
  assert.equal(f.media.length, 0)
})

test('rewrite during attachment saving prevents ready publication and removes old placeholders', async () => {
  let release, saving = false
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ planMessage: async () => ({ plans: [image('first')] }), getJob: () => done('first') }, {
    saveImage: async () => { saving = true; await gate; return { id: 'attachment' } },
  })
  const task = f.bridge.attachTurn(turn)
  const rejected = assert.rejects(task, /删除或改写/)
  await until(() => saving)
  f.change({ ...turn, textVersion: 'v2' }); release()
  await rejected
  assert.ok(!f.events.includes('ready:first'))
  assert.ok(f.events.includes('remove:media-0'))
  f.bridge.dispose()
})

for (const action of ['delete', 'dispose']) {
  test(action + ' aborts pending waits and stops further media publication', async () => {
    const f = fixture({ planMessage: async () => ({ plans: [image('first')] }), getJob: () => ({ state: 'pending' }) })
    const task = f.bridge.attachTurn(turn)
    const rejected = assert.rejects(task, /删除|卸载/)
    await until(() => f.media.length === 1)
    if (action === 'delete') f.remove(); else f.bridge.dispose()
    await rejected
    assert.ok(!f.events.includes('ready:first'))
    assert.ok(f.events.includes('remove:media-0'))
    f.bridge.dispose()
  })
}

test('failed planning is retryable and retries reuse existing ready official media', async () => {
  let calls = 0
  const f = fixture({
    async planMessage() { if (++calls === 1) throw new Error('temporary planner failure'); return { plans: [image('first')] } },
    getJob: () => done('first'),
  })
  await assert.rejects(f.bridge.attachTurn(turn), /temporary planner failure/)
  f.media.push({ ...image('first'), data: { jobId: 'first' }, id: 'existing', kind: 'dsh-tavern-comfy/image', textVersion: 'v1', status: 'ready', attachment: { id: 'attachment' } })
  assert.deepEqual(await f.bridge.attachTurn(turn), { attached: 1, total: 1 })
  assert.equal(f.media.length, 1)
  assert.equal(calls, 2)
  f.bridge.dispose()
})

test('a version change preserves images already ready while removing unfinished placeholders', async () => {
  const jobs = { first: done('first'), second: { state: 'pending' } }
  const f = fixture({ planMessage: async () => ({ plans: [image('first'), image('second')] }), getJob: id => jobs[id] })
  const task = f.bridge.attachTurn(turn)
  const rejected = assert.rejects(task, /删除或改写/)
  await until(() => f.events.includes('ready:first'))
  f.change({ ...turn, textVersion: 'v2' })
  await rejected
  assert.equal(f.media.length, 1)
  assert.equal(f.media[0].data.jobId, 'first')
  assert.equal(f.media[0].status, 'ready')
  f.bridge.dispose()
})

test('deleted completed media can be restored instead of being blocked by completed cache', async () => {
  let calls = 0
  const f = fixture({ planMessage: async () => { calls++; return { plans: [image('first')] } }, getJob: () => done('first') })
  await f.bridge.attachTurn(turn)
  f.media.splice(0)
  assert.deepEqual(await f.bridge.attachTurn(turn), { attached: 1, total: 1 })
  assert.equal(calls, 2)
  assert.equal(f.media[0].status, 'ready')
  f.bridge.dispose()
})
