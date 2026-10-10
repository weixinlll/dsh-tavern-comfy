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
  let settled, removed, timeline
  const turnData = []
  const config = Object.assign({ plannerEnabled: true, smartImageSelection: true, characterAutoUpdate: true }, options.config)
  const tavern = {
    apiVersion: options.apiVersion ?? 1,
    promptSection() { return () => events.push('off-prompt') },
    onTurnSettled(handler) { settled = handler; return () => events.push('off-settled') },
    onTimelineChanged(handler) { timeline = handler; return () => events.push('off-timeline') },
    onGameRemoved(handler) { removed = handler; return () => events.push('off-removed') },
    async getTurn() { return current },
    async readTurnData({ turn: requested }) {
      return turnData.filter(item => item.turn <= requested).at(-1) ?? null
    },
    async saveTurnData(input) {
      if (input.textVersion && input.textVersion !== current.textVersion) throw new Error('stale textVersion')
      const saved = { turn: input.turn, textVersion: input.textVersion || current.textVersion, data: input.data }
      turnData.push(saved); events.push('turn-data:' + input.turn)
      return { turn: saved.turn, textVersion: saved.textVersion }
    },
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
    tavern, engine, getConfig: () => config,
    attachments: { saveImage: options.saveImage || (async () => ({ id: 'attachment' })) },
    readFileAsBytes: async () => new Uint8Array([1]),
  })
  return { bridge, events, media, turnData, config, setConfig: patch => Object.assign(config, patch), settled: value => settled(value), remove: () => removed({ gameId: 'game' }), change: value => { current = value }, timeline: event => timeline?.({ gameId: 'game', ...event }) }
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

test('an explicit automatic skip is successful and creates no image attachment work', async () => {
  let imagePosts = 0
  let calls = 0
  const f = fixture({ planMessage: async () => { calls++; return { plans: [], skipped: true, reason: '本轮主要是对话，没有新的视觉瞬间' } }, getJob: () => { imagePosts++; return null } })
  try {
    assert.deepEqual(await f.bridge.attachTurn(turn), { attached: 0, total: 0, skipped: true, reason: '本轮主要是对话，没有新的视觉瞬间' })
    assert.deepEqual(await f.bridge.attachTurn(turn), { attached: 0, total: 0, skipped: true, reason: '本轮主要是对话，没有新的视觉瞬间' })
    assert.equal(calls, 1)
    assert.equal(imagePosts, 0)
    assert.equal(f.media.length, 0)
  } finally { f.bridge.dispose() }
})

test('malformed skip results report an error and do not hide it behind skipped=true', async () => {
  const f = fixture({ planMessage: async () => ({ plans: [], skipped: true, error: 'skip decision conflicts with a draw' }), getJob: () => null })
  try {
    const result = await f.bridge.attachTurn(turn)
    assert.match(result.error, /conflicts/)
    assert.equal(result.skipped, undefined)
  } finally { f.bridge.dispose() }
})

test('planner setting changes invalidate a cached automatic skip', async () => {
  let calls = 0
  const f = fixture({ planMessage: async () => { calls++; return { plans: [], skipped: true, reason: 'quiet' } }, getJob: () => null })
  try {
    await f.bridge.attachTurn(turn)
    await f.bridge.attachTurn(turn)
    assert.equal(calls, 1)
    f.setConfig({ plannerCount: 4 })
    await f.bridge.attachTurn(turn)
    assert.equal(calls, 2)
  } finally { f.bridge.dispose() }
})

test('timeline changes abort old image work and invalidate successful empty-plan cache', async () => {
  let calls = 0
  const f = fixture({
    async planMessage() { calls++; if (calls === 1) return { plans: [], skipped: true, reason: 'quiet' }; return { plans: [image('first')] } },
    getJob: () => ({ state: 'pending' }),
  }, { apiVersion: 2 })
  try {
    await f.bridge.attachTurn(turn)
    f.timeline({ kind: 'rollback', turn: 1 })
    const task = f.bridge.attachTurn(turn)
    const rejected = assert.rejects(task, /剧情线已变化/)
    await until(() => f.media.length === 1)
    f.timeline({ kind: 'undo-rollback', turn: 1 })
    await rejected
    assert.equal(calls, 2)
    assert.ok(f.events.includes('remove:media-0'))
  } finally { f.bridge.dispose() }
})

test('manual generation invalidates an automatic skip cache and bypasses smart selection', async () => {
  const requests = []
  const f = fixture({
    async planMessage(input) {
      requests.push(input)
      return input.manual ? { plans: [image('manual')] } : { plans: [], skipped: true, reason: 'quiet' }
    },
    getJob: () => done('manual'),
  })
  try {
    await f.bridge.attachTurn(turn)
    const forced = await f.bridge.attachTurn({ ...turn, manual: true, count: 1 })
    assert.equal(forced.attached, 1)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].smartSelection, false)
    await f.bridge.attachTurn(turn)
    assert.equal(requests.length, 3, 'manual intent clears the prior automatic decision')
  } finally { f.bridge.dispose() }
})

test('same-game turn history reads wait for the preceding planner snapshot save', async () => {
  let releaseFirst
  let firstStarted
  const started = new Promise(resolve => { firstStarted = resolve })
  const gate = new Promise(resolve => { releaseFirst = resolve })
  const requests = []
  const f = fixture({
    async planMessage(input) {
      requests.push(input)
      if (input.turn === 1) { firstStarted(); await gate }
      return { plans: [], characterSnapshot: { version: 1, characters: { role: { traits: { face: 'updated' } } }, changes: [] } }
    },
    getJob: () => null,
  }, { apiVersion: 2 })
  try {
    const first = f.bridge.attachTurn(turn)
    await started
    const second = f.bridge.attachTurn({ ...turn, turn: 2 })
    await delay(10)
    assert.equal(requests.length, 1)
    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(requests[1].historySnapshot.characters.role.traits, { face: 'updated' })
  } finally { releaseFirst(); f.bridge.dispose() }
})

test('API v2 stores character snapshots even when there are no images', async () => {
  let request
  const snapshot = { version: 1, characters: { role1: { traits: { face: 'short hair' } } }, changes: [{ turn: 1 }] }
  const f = fixture({
    async planMessage(input) { request = input; return { plans: [], skipped: true, reason: 'dialogue', characterSnapshot: snapshot } },
    getJob: () => null,
  }, { apiVersion: 2 })
  try {
    const result = await f.bridge.attachTurn(turn)
    assert.equal(result.skipped, true)
    assert.equal(request.characterUpdates, true)
    assert.deepEqual(request.historySnapshot, null)
    assert.equal(f.turnData.length, 1)
    assert.equal(f.turnData[0].textVersion, turn.textVersion)
    assert.deepEqual(f.turnData[0].data, snapshot)
    assert.equal(f.media.length, 0)
  } finally { f.bridge.dispose() }
})

test('manual draw explicitly forces images and never inherits the smart skip option', async () => {
  let request
  const pictures = [image('one'), image('two')]
  const f = fixture({ async planMessage(input) { request = input; return { plans: pictures } }, getJob: id => done(id) })
  try {
    const result = await f.bridge.attachTurn({ ...turn, manual: true, count: 2 })
    assert.equal(request.manual, true)
    assert.equal(request.force, true)
    assert.equal(request.smartSelection, false)
    assert.equal(request.count, 2)
    assert.equal(result.total, 2)
    assert.equal(result.attached, 2)
  } finally { f.bridge.dispose() }
})

test('API v1 reports history unavailable to the planner and never reads or saves snapshots', async () => {
  let request
  const f = fixture({ async planMessage(input) { request = input; return { plans: [] } }, getJob: () => null })
  try {
    await f.bridge.attachTurn(turn)
    assert.equal(request.characterUpdates, false)
    assert.equal(request.historySnapshot, null)
    assert.equal(f.turnData.length, 0)
  } finally { f.bridge.dispose() }
})
