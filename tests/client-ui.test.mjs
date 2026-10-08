import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.__test = { SettingsPanel, OfficialImage }')
const flush = () => new Promise(resolve => setImmediate(resolve))
const copy = value => JSON.parse(JSON.stringify(value))
const person = (id, name) => ({ id, name, match: '', note: '', continuity: '', enabled: true, cards: [], outfitRefs: [], traits: { feature: 'gentle', face: 'black hair' }, outfits: [] })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness(extra = {}) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let api
  let tree
  let state = { config: {}, workflows: [], outfits: [], definitions: { characters: [person('a', '甲'), person('b', '乙')], outfits: [] }, tasks: [{ id: 'task', state: 'running', startedAt: Date.now() }] }
  const requests = []
  const intervals = []
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], update => { hooks[index] = typeof update === 'function' ? update(hooks[index]) : update }]
    },
    useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index] },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) pendingEffects.push(effect)
      hooks[index] = deps
    },
  }
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, addEventListener() {}, __ModuleLoader__: { load({ factory }) { api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' },
    document: { baseURI: 'http://test.local', createElement() { return { files: [{ type: 'image/png', name: 'ref.png' }], click() { this.onchange() } } } },
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,test'; this.onload() } },
    confirm: () => true,
    URL, console, Date, Math, Promise, TypeError,
    setInterval(callback) { intervals.push(callback); return intervals.length }, clearInterval() {},
    setTimeout() { return 1 }, clearTimeout() {},
    async fetch(url, init = {}) {
      const path = new URL(url).pathname.split('/').at(-1)
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ path, body })
      let result
      if (extra[path]) result = await extra[path]({ body, state, setState: next => { state = next } })
      else if (path === 'state') result = copy(state)
      else if (path === 'definitions') { state = { ...state, definitions: copy(body.definitions), outfits: copy(body.definitions.outfits) }; result = { ok: true, state: copy(state) } }
      else if (path === 'cards') result = { ok: true, cards: [{ path: 'cards/story.json', name: '故事卡' }] }
      else result = { ok: true }
      return { ok: true, status: 200, json: async () => result }
    },
  }
  vm.runInNewContext(source, context)
  const nodes = root => {
    if (!root || typeof root !== 'object') return []
    return [root, ...(root.children || []).flatMap(nodes)]
  }
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  function render() {
    cursor = 0
    pendingEffects = []
    tree = api.__test.SettingsPanel()
    pendingEffects.forEach(effect => effect())
    return tree
  }
  function find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, '找不到 UI 元素'); return node }
  function button(label) { return find(node => node.type === 'button' && text(node) === label) }
  function input(label) { return find(node => node.props['aria-label'] === label) }
  function role(id) { return find(node => node.type === 'details' && node.props.key === id) }
  function roleInput(id, placeholder) { return nodes(role(id)).find(node => node.props.placeholder === placeholder) }
  async function ready() {
    render(); await flush(); render()
    button('人物库').props.onClick(); render(); await flush(); render()
  }
  return { React, api, ready, render, button, input, role, roleInput, nodes, text, intervals, requests, get state() { return state } }
}

test('图片说明交由 Tavern 渲染，插件保留 alt 且不重复显示 caption', () => {
  const ui = harness()
  const image = ui.api.__test.OfficialImage({ item: { status: 'ready', caption: '[客籍关前验魂灰]', url: '/image.png', data: { jobId: 'j1' } } })
  assert.equal(ui.nodes(image).filter(node => node.type === 'img')[0].props.alt, '[客籍关前验魂灰]')
  assert.equal(ui.text(image), '')
})

test('全部展开/折叠保留草稿；批量覆盖/追加只作用于所选角色，手动保存才写入', async () => {
  const ui = harness()
  await ui.ready()
  ui.button('全部展开').props.onClick(); ui.render()
  assert.equal(ui.role('a').props.open, true)
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '甲改名' } }); ui.render()
  ui.button('全部折叠').props.onClick(); ui.render()
  assert.equal(ui.role('a').props.open, false)
  assert.equal(ui.roleInput('a', '角色名').props.value, '甲改名')
  ui.input('选择角色 甲改名').props.onChange({ target: { checked: true } }); ui.render()
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: 'cold' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'definitions').length, 0)
  ui.input('批量编辑方式').props.onChange({ target: { value: 'append' } }); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: 'elegant' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.definitions.characters[0].traits.feature, 'cold, elegant')
  assert.equal(ui.state.definitions.characters[1].traits.feature, 'gentle')
  assert.equal(ui.state.definitions.characters[0].name, '甲改名')
})

test('批量绑定卡片和启用状态按选择应用', async () => {
  const ui = harness()
  await ui.ready()
  ui.button('全选角色').props.onClick(); ui.render()
  ui.button('批量编辑').props.onClick(); ui.render()
  await ui.input('批量编辑字段').props.onChange({ target: { value: 'cards' } }); ui.render()
  const story = ui.nodes(ui.render()).find(node => node.type === 'label' && ui.text(node) === ' 故事卡')
  story.children[0].props.onChange({ target: { checked: true } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.input('批量编辑字段').props.onChange({ target: { value: 'enabled' } }); ui.render()
  ui.input('批量启用状态').props.onChange({ target: { value: 'false' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  for (const character of ui.state.definitions.characters) { assert.equal(character.enabled, false); assert.deepEqual(character.cards, ['cards/story.json']) }
})

test('后台刷新防止重复请求，保留人物与服装未保存草稿', async () => {
  let reads = 0
  const waiting = deferred()
  const ui = harness({ state: ({ state }) => ++reads === 1 ? copy(state) : waiting.promise })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '未保存' } }); ui.render()
  ui.button('新增套装').props.onClick(); ui.render()
  ui.intervals[0](); ui.intervals[0](); await flush()
  assert.equal(reads, 2)
  waiting.resolve(copy(ui.state)); await flush(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '未保存')
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.outfits.length, 1)
})

test('并发改进按稳定 id 合并最新内容；期间手改字段和改进草稿均保留', async () => {
  const waiting = { a: deferred(), b: deferred() }
  const ui = harness({ design: ({ body }) => waiting[body.current.id].promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '改甲' } }); ui.render()
  ui.roleInput('b', placeholder).props.onChange({ target: { value: '改乙' } }); ui.render()
  const aButton = ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const bButton = ui.nodes(ui.role('b')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const pendingA = aButton.props.onClick()
  const pendingB = bButton.props.onClick()
  waiting.b.resolve({ ok: true, people: [{ traits: { feature: 'bold' } }] }); await pendingB; ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '甲手改' } }); ui.render()
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '下一次改甲' } }); ui.render()
  waiting.a.resolve({ ok: true, people: [{ name: '甲生成', traits: { face: 'silver hair' } }] }); await pendingA; ui.render()
  assert.equal(ui.state.definitions.characters[0].name, '甲手改')
  assert.equal(ui.state.definitions.characters[0].traits.face, 'silver hair')
  assert.equal(ui.state.definitions.characters[1].traits.feature, 'bold')
  assert.equal(ui.roleInput('a', placeholder).props.value, '下一次改甲')
})

test('删掉前一位角色不会将改进结果或草稿移到错误角色；删掉目标时忽略结果', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('b', placeholder).props.onChange({ target: { value: '乙改发色' } }); ui.render()
  const pending = ui.nodes(ui.role('b')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进').props.onClick()
  ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '删除角色').props.onClick(); ui.render()
  assert.equal(ui.roleInput('b', placeholder).props.value, '乙改发色')
  waiting.resolve({ ok: true, people: [{ traits: { face: 'red hair' } }] }); await pending; ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.face]), [['b', 'red hair']])

  const deleted = deferred()
  const other = harness({ design: () => deleted.promise })
  await other.ready()
  other.roleInput('a', placeholder).props.onChange({ target: { value: '改甲' } }); other.render()
  const lost = other.nodes(other.role('a')).find(node => node.type === 'button' && other.text(node) === '✏️ 改进').props.onClick()
  other.nodes(other.role('a')).find(node => node.type === 'button' && other.text(node) === '删除角色').props.onClick(); other.render()
  deleted.resolve({ ok: true, people: [{ traits: { face: 'red hair' } }] }); await lost; other.render()
  assert.equal(other.requests.filter(request => request.path === 'definitions').length, 0)
  assert.equal(other.roleInput('b', '角色名').props.value, '乙')
})

test('照片识别绑定点击时的角色，后台返回不会覆盖期间的手改字段', async () => {
  const waiting = deferred()
  const ui = harness({ vision: () => waiting.promise })
  await ui.ready()
  ui.nodes(ui.role('b')).find(node => node.type === 'button' && ui.text(node) === '📷 从照片识别').props.onClick()
  ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '删除角色').props.onClick(); ui.render()
  ui.nodes(ui.role('b')).find(node => node.type === 'textarea' && node.props.value === 'black hair').props.onChange({ target: { value: '手动发色' } }); ui.render()
  waiting.resolve({ traits: { face: 'green hair', feature: 'bold' } }); await flush(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.face, character.traits.feature]), [['b', '手动发色', 'bold']])
})

test('保存等待期间的新修改不被响应覆盖；保存失败保留草稿且显示失败', async () => {
  const waiting = deferred()
  const ui = harness({ definitions: () => waiting.promise })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '第一次' } }); ui.render()
  const saving = ui.button('保存人物库').props.onClick(); await flush(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '第二次' } }); ui.render()
  const submitted = ui.requests.find(request => request.path === 'definitions').body.definitions
  waiting.resolve({ ok: true, state: { ...copy(ui.state), definitions: submitted } }); await saving; ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '第二次')
  assert.match(ui.text(ui.render()), /有未保存修改/)

  const failed = harness({ definitions: () => ({ ok: false, error: 'disk unavailable' }) })
  await failed.ready()
  failed.roleInput('a', '角色名').props.onChange({ target: { value: '草稿' } }); failed.render()
  assert.equal(await failed.button('保存人物库').props.onClick(), false)
  failed.render()
  assert.equal(failed.roleInput('a', '角色名').props.value, '草稿')
  assert.match(failed.text(failed.render()), /保存失败/)
})

test('新建设计面板防重复提交，回包追加到最新人物库，保留下一份需求草稿', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  await ui.button('✨ 让 agent 设计角色').props.onClick(); ui.render()
  const prompt = '例如：生成一个穿着古风汉服的少女角色，温柔可爱…'
  ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.onChange({ target: { value: '新角色一' } }); ui.render()
  const submit = ui.button('确定生成').props.onClick
  const pending = submit()
  await submit()
  ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'design').length, 1)
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙手改' } }); ui.render()
  ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.onChange({ target: { value: '新角色二' } }); ui.render()
  waiting.resolve({ ok: true, people: [{ name: '生成角色', traits: { face: 'silver hair' } }] }); await pending; ui.render()
  assert.equal(ui.state.definitions.characters.length, 3)
  assert.equal(ui.state.definitions.characters[1].name, '乙手改')
  assert.equal(ui.nodes(ui.render()).find(node => node.props.placeholder === prompt).props.value, '新角色二')
  assert.match(ui.text(ui.render()), /已生成 1 位角色并保存/)
})

test('保存串行排队读取最新草稿，过期后台刷新不会撤销已保存修改', async () => {
  const pendingRefresh = deferred()
  const firstSave = deferred()
  let reads = 0
  let saves = 0
  const ui = harness({
    state: ({ state }) => ++reads === 1 ? copy(state) : pendingRefresh.promise,
    definitions: ({ body, state, setState }) => {
      saves += 1
      const next = { ...state, definitions: copy(body.definitions) }
      if (saves === 1) return firstSave.promise.then(() => { setState(next); return { ok: true, state: copy(next) } })
      setState(next)
      return { ok: true, state: copy(next) }
    },
  })
  await ui.ready()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '保存前' } }); ui.render()
  ui.intervals[0](); await flush()
  const staleState = copy(ui.state)
  const first = ui.button('保存人物库').props.onClick(); await flush(); ui.render()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '排队新修改' } }); ui.render()
  const second = ui.button('保存人物库').props.onClick(); await flush()
  assert.equal(saves, 1)
  firstSave.resolve(); await Promise.all([first, second]); ui.render()
  assert.equal(saves, 2)
  pendingRefresh.resolve(staleState); await flush(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '保存前')
  assert.equal(ui.roleInput('b', '角色名').props.value, '排队新修改')
})
