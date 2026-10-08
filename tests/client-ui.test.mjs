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

function harness(extra = {}, characters = [person('a', '甲'), person('b', '乙')]) {
  const hooks = []
  let cursor = 0
  let pendingEffects = []
  let api
  let tree
  let state = { config: {}, workflows: [], outfits: [], definitions: { characters: copy(characters), outfits: [] }, tasks: [{ id: 'task', state: 'running', startedAt: Date.now() }] }
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
      const parsedUrl = new URL(url)
      const path = parsedUrl.pathname.split('/').at(-1)
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ path, pathname: parsedUrl.pathname, method: init.method || 'GET', body })
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
  function selectRole(id) {
    const selector = find(node => node.type === 'select' && node.props['aria-label'] === '当前角色')
    if (selector.props.value !== id) {
      selector.props.onChange({ target: { value: id } })
      render()
    }
  }
  function role(id) {
    selectRole(id)
    return find(node => node.type === 'details' && node.props.key === id)
  }
  function rolePanels() { return nodes(tree).filter(node => node.type === 'details' && node.props.key != null) }
  function roleInput(id, placeholder) {
    return nodes(role(id)).find(node => node.props.placeholder === placeholder)
  }
  async function ready() {
    render(); await flush(); render()
    button('人物库').props.onClick(); render(); await flush(); render()
  }
  async function openPluginUpdate() {
    await ready()
    button('插件更新').props.onClick(); render(); await flush(); render()
  }
  return { React, api, ready, openPluginUpdate, render, button, input, role, roleInput, rolePanels, nodes, text, intervals, requests, get state() { return state } }
}

test('图片说明交由 Tavern 渲染，插件保留 alt 且不重复显示 caption', () => {
  const ui = harness()
  const image = ui.api.__test.OfficialImage({ item: { status: 'ready', caption: '[客籍关前验魂灰]', url: '/image.png', data: { jobId: 'j1' } } })
  assert.equal(ui.nodes(image).filter(node => node.type === 'img')[0].props.alt, '[客籍关前验魂灰]')
  assert.equal(ui.text(image), '')
})

test('当前角色折叠/展开与切换保留草稿；批量覆盖/追加只作用于所选角色，手动保存才写入', async () => {
  const ui = harness()
  await ui.ready()
  assert.equal(ui.rolePanels().length, 1)
  assert.equal(ui.role('a').props.open, true)
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '甲改名' } }); ui.render()
  ui.button('收起编辑').props.onClick(); ui.render()
  assert.equal(ui.role('a').props.open, false)
  assert.equal(ui.roleInput('a', '角色名').props.value, '甲改名')
  ui.button('展开编辑').props.onClick(); ui.render()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙草稿' } }); ui.render()
  ui.roleInput('a', '角色名')
  assert.equal(ui.roleInput('a', '角色名').props.value, '甲改名')
  assert.equal(ui.roleInput('b', '角色名').props.value, '乙草稿')
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.input('批量选择角色 甲改名').props.onChange({ target: { checked: true } }); ui.render()
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
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.button('全选当前筛选').props.onClick(); ui.render()
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
  ui.role('b')
  ui.button('从照片识别').props.onClick()
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
  await ui.button('让 agent 设计角色').props.onClick(); ui.render()
  ui.input('搜索角色').props.onChange({ target: { value: '乙' } }); ui.render()
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
  assert.equal(ui.input('搜索角色').props.value, '')
  const generatedId = ui.state.definitions.characters[2].id
  assert.equal(ui.input('当前角色').props.value, generatedId)
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), [generatedId])
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

test('搜索按角色名和英文触发名过滤；无匹配空态不删除角色', async () => {
  const chars = [person('a', '甲主角'), Object.assign(person('b', '乙主角'), { match: 'yiren' }), person('c', '丙配角')]
  const ui = harness({}, chars)
  await ui.ready()
  const original = copy(ui.state.definitions.characters)
  const search = ui.input('搜索角色')

  search.props.onChange({ target: { value: '乙主' } }); ui.render()
  let selector = ui.input('当前角色')
  assert.deepEqual(selector.children.map(option => option.props.value), ['b'])
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  ui.input('搜索角色').props.onChange({ target: { value: 'yiren' } }); ui.render()
  selector = ui.input('当前角色')
  assert.deepEqual(selector.children.map(option => option.props.value), ['b'])
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  ui.input('搜索角色').props.onChange({ target: { value: '不存在' } }); ui.render()
  assert.equal(ui.rolePanels().length, 0)
  assert.match(ui.text(ui.render()), /没有匹配的角色/)
  assert.deepEqual(ui.state.definitions.characters, original)
})

test('删除当前角色后切换到可用角色；新增角色后自动选中新增项', async () => {
  const removed = harness()
  await removed.ready()
  removed.nodes(removed.role('a')).find(node => node.type === 'button' && removed.text(node) === '删除角色').props.onClick()
  removed.render()
  assert.equal(removed.input('当前角色').props.value, 'b')
  assert.deepEqual(removed.rolePanels().map(panel => panel.props.key), ['b'])
  assert.equal(removed.roleInput('b', '角色名').props.value, '乙')

  const added = harness()
  await added.ready()
  added.input('搜索角色').props.onChange({ target: { value: '乙' } }); added.render()
  added.button('新增角色').props.onClick(); added.render()
  assert.equal(added.input('搜索角色').props.value, '')
  await added.button('保存人物库').props.onClick(); added.render()
  const characters = added.state.definitions.characters
  const created = characters.at(-1)
  assert.equal(added.input('当前角色').props.value, created.id)
  assert.deepEqual(added.rolePanels().map(panel => panel.props.key), [created.id])
  assert.equal(added.roleInput(created.id, '角色名').props.value, '')
})

test('过滤后全选只勾当前可见角色，隐藏的已选角色仍参与批量更改', async () => {
  const ui = harness({}, [person('a', '甲'), person('b', '乙'), person('c', '丙')])
  await ui.ready()
  ui.button('批量编辑').props.onClick(); ui.render()
  ui.input('批量选择角色 丙').props.onChange({ target: { checked: true } }); ui.render()
  ui.input('搜索角色').props.onChange({ target: { value: '甲' } }); ui.render()
  ui.button('全选当前筛选').props.onClick(); ui.render()
  assert.equal(ui.input('批量选择角色 甲').props.checked, true)

  ui.input('搜索角色').props.onChange({ target: { value: '' } }); ui.render()
  assert.equal(ui.input('批量选择角色 甲').props.checked, true)
  assert.equal(ui.input('批量选择角色 乙').props.checked, false)
  assert.equal(ui.input('批量选择角色 丙').props.checked, true)
  assert.match(ui.text(ui.render()), /已选 2 \/ 3 位/)

  await ui.input('批量编辑字段').props.onChange({ target: { value: 'feature' } }); ui.render()
  ui.input('批量编辑内容').props.onChange({ target: { value: '仅作用于选中项' } }); ui.render()
  ui.button('应用到所选角色').props.onClick(); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.traits.feature]), [
    ['a', '仅作用于选中项'], ['b', 'gentle'], ['c', '仅作用于选中项'],
  ])
})

test('初始角色改名改变排序后仍保留同一当前角色', async () => {
  const ui = harness()
  await ui.ready()
  assert.equal(ui.input('当前角色').props.value, 'a')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['a'])

  const name = ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '角色名')
  name.props.onChange({ target: { value: '龟' } }); ui.render()
  assert.equal(ui.input('当前角色').props.value, 'a')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['a'])
  assert.equal(ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '角色名').props.value, '龟')
})

test('通过英文触发名筛选后修改触发名会清空筛选并保留当前角色', async () => {
  const ui = harness({}, [person('a', '甲'), Object.assign(person('b', '乙'), { match: 'yiren' })])
  await ui.ready()
  ui.input('搜索角色').props.onChange({ target: { value: 'yiren' } }); ui.render()
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])

  const match = ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '英文名（逗号分隔，用来触发）')
  match.props.onChange({ target: { value: 'newname' } }); ui.render()
  assert.equal(ui.input('搜索角色').props.value, '')
  assert.equal(ui.input('当前角色').props.value, 'b')
  assert.deepEqual(ui.rolePanels().map(panel => panel.props.key), ['b'])
  assert.equal(ui.nodes(ui.rolePanels()[0]).find(node => node.props.placeholder === '英文名（逗号分隔，用来触发）').props.value, 'newname')
})

test('切换当前角色后异步改进仍合并到发起时的稳定 id', async () => {
  const waiting = deferred()
  const ui = harness({ design: () => waiting.promise })
  await ui.ready()
  const placeholder = '要改什么？例如：头发改成银白 / 加一套睡衣 / 胸再大一点'
  ui.roleInput('a', placeholder).props.onChange({ target: { value: '改甲发色' } }); ui.render()
  const improve = ui.nodes(ui.role('a')).find(node => node.type === 'button' && ui.text(node) === '✏️ 改进')
  const pending = improve.props.onClick()
  ui.roleInput('b', '角色名').props.onChange({ target: { value: '乙手改' } }); ui.render()
  waiting.resolve({ ok: true, people: [{ traits: { face: 'silver hair' } }] }); await pending; ui.render()
  assert.equal(ui.input('当前角色').props.value, 'b')
  assert.deepEqual(ui.state.definitions.characters.map(character => [character.id, character.name, character.traits.face]), [
    ['a', '甲', 'silver hair'], ['b', '乙手改', 'black hair'],
  ])
})

test('复制当前角色生成唯一角色与服装 id，保留绑定并允许副本独立编辑', async () => {
  const original = Object.assign(person('a', '甲'), {
    cards: ['cards/story.json'], outfitRefs: ['global-1'],
    outfits: [{ id: 'outfit-a', name: '原套装', upper: '白衬衫', lower: '长裙', enabled: true, default: true }],
  })
  const ui = harness({}, [original])
  await ui.ready()
  ui.input('搜索角色').props.onChange({ target: { value: '甲' } }); ui.render()
  ui.button('复制当前角色').props.onClick(); ui.render()

  assert.equal(ui.input('搜索角色').props.value, '')
  assert.equal(ui.input('当前角色').props.value === 'a', false)
  assert.match(ui.text(ui.render()), /有未保存修改/)
  await ui.button('保存人物库').props.onClick(); ui.render()
  const [source, duplicate] = ui.state.definitions.characters
  assert.equal(duplicate.name, '甲（副本）')
  assert.notEqual(duplicate.id, source.id)
  assert.notEqual(duplicate.outfits[0].id, source.outfits[0].id)
  assert.deepEqual(duplicate.cards, source.cards)
  assert.deepEqual(duplicate.outfitRefs, source.outfitRefs)
  assert.deepEqual(duplicate.traits, source.traits)
  assert.equal(ui.input('当前角色').props.value, duplicate.id)

  const panel = ui.role(duplicate.id)
  ui.nodes(panel).find(node => node.type === 'textarea' && node.props.value === 'gentle').props.onChange({ target: { value: '副本特征' } }); ui.render()
  ui.roleInput(duplicate.id, '服装名（常服 / 居家 / 内衣…）').props.onChange({ target: { value: '副本套装' } }); ui.render()
  await ui.button('保存人物库').props.onClick(); ui.render()
  assert.equal(ui.state.definitions.characters[0].traits.feature, 'gentle')
  assert.equal(ui.state.definitions.characters[0].outfits[0].name, '原套装')
  assert.equal(ui.state.definitions.characters[1].traits.feature, '副本特征')
  assert.equal(ui.state.definitions.characters[1].outfits[0].name, '副本套装')
})

test('插件更新检查与安装分离，重复点击合并请求，成功后提示重启并禁止再次安装', async () => {
  const checking = deferred()
  const installing = deferred()
  let checkCalls = 0
  let applyCalls = 0
  const ui = harness({
    state: ({ state, setState }) => {
      const next = Object.assign({}, state, { config: { apiToken: 'secret-must-not-be-sent' } })
      setState(next)
      return copy(next)
    },
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: ({ body }) => { checkCalls++; return checking.promise },
    apply: ({ body }) => { applyCalls++; return installing.promise },
  })
  await ui.openPluginUpdate()
  const stateReads = ui.requests.filter(request => request.path === 'state').length
  assert.ok(ui.requests.some(request => request.pathname === '/plugins/dsh-tavern-comfy/plugin-update' && request.method === 'GET'))

  const check = ui.button('检查更新').props.onClick
  const firstCheck = check()
  const duplicateCheck = check()
  await flush()
  assert.equal(checkCalls, 1)
  assert.equal(applyCalls, 0)
  checking.resolve({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' })
  await Promise.all([firstCheck, duplicateCheck]); await flush(); ui.render()
  const checkRequest = ui.requests.find(request => request.pathname === '/plugins/dsh-tavern-comfy/plugin-update/check')
  assert.equal(checkRequest.method, 'POST')
  assert.deepEqual(checkRequest.body, {})
  assert.match(ui.text(ui.render()), /1\.3\.0/)
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)

  const apply = ui.button('更新插件').props.onClick
  const firstApply = apply()
  const duplicateApply = apply()
  await flush()
  assert.equal(applyCalls, 1)
  const applyRequest = ui.requests.find(request => request.pathname === '/plugins/dsh-tavern-comfy/plugin-update/apply')
  assert.equal(applyRequest.method, 'POST')
  assert.deepEqual(applyRequest.body, { target: 'v1.3.0' })
  installing.resolve({ ok: true, currentVersion: '1.3.0', latestVersion: '1.3.0', available: false, canUpdate: false, restartRequired: true, message: '插件更新完成，请完整重启 DSH 后生效。' })
  await Promise.all([firstApply, duplicateApply]); await flush(); ui.render()
  assert.match(ui.text(ui.render()), /完整重启 DSH/)
  const updateButton = ui.nodes(ui.render()).find(node => node.type === 'button' && ui.text(node) === '更新插件')
  assert.ok(!updateButton || updateButton.props.disabled)
  assert.equal(applyCalls, 1)
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)
})

test('插件更新检查失败后可重试', async () => {
  let checkCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ++checkCalls === 1
      ? ({ ok: false, error: 'temporary update lookup failure' })
      : ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  assert.match(ui.text(ui.render()), /检查更新失败/)
  assert.equal(checkCalls, 1)

  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  assert.equal(checkCalls, 2)
  assert.equal(ui.button('更新插件').props.disabled, false)
  assert.equal(ui.requests.filter(request => request.pathname === '/plugins/dsh-tavern-comfy/plugin-update/apply').length, 0)
})

test('人物草稿未保存时阻止插件安装并保留草稿', async () => {
  let applyCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
    apply: () => { applyCalls++; return { ok: true, currentVersion: '1.3.0', restartRequired: true } },
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()

  ui.button('人物库').props.onClick(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '未保存角色名' } }); ui.render()
  ui.button('插件更新').props.onClick(); ui.render()
  ui.button('更新插件').props.onClick(); ui.render()
  assert.equal(applyCalls, 0)
  assert.match(ui.text(ui.render()), /先保存人物库/)

  ui.button('人物库').props.onClick(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '未保存角色名')
  assert.equal(ui.requests.filter(request => request.pathname === '/plugins/dsh-tavern-comfy/plugin-update/apply').length, 0)
})

test('更新请求跨页成功后保留重启状态并保留人物页新草稿', async () => {
  const installing = deferred()
  let applyCalls = 0
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', latestVersion: '1.3.0', available: true, canUpdate: true, target: 'v1.3.0' }),
    apply: () => { applyCalls++; return installing.promise },
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  const stateReads = ui.requests.filter(request => request.path === 'state').length
  const pending = ui.button('更新插件').props.onClick()
  await flush()
  assert.equal(applyCalls, 1)

  ui.button('人物库').props.onClick(); ui.render()
  ui.roleInput('a', '角色名').props.onChange({ target: { value: '跨页期间的草稿' } }); ui.render()
  installing.resolve({ ok: true, currentVersion: '1.3.0', available: false, canUpdate: false, restartRequired: true, message: '插件文件已更新。' })
  await pending; await flush(); ui.render()
  assert.equal(ui.requests.filter(request => request.path === 'state').length, stateReads)

  ui.button('插件更新').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /完整重启 DSH/)
  const updateButton = ui.nodes(ui.render()).find(node => node.type === 'button' && ui.text(node) === '更新插件')
  assert.ok(!updateButton || updateButton.props.disabled)
  assert.equal(applyCalls, 1)

  ui.button('人物库').props.onClick(); ui.render()
  assert.equal(ui.roleInput('a', '角色名').props.value, '跨页期间的草稿')
})

test('检查结果标记不支持时显示原因且不误报已是最新', async () => {
  const ui = harness({
    'plugin-update': () => ({ ok: true, currentVersion: '1.2.1', supported: true }),
    check: () => ({ ok: true, currentVersion: '1.2.1', available: false, supported: false, reason: '源不支持' }),
  })
  await ui.openPluginUpdate()
  ui.button('检查更新').props.onClick(); await flush(); ui.render()
  const status = ui.nodes(ui.render()).find(node => node.props.role === 'status' && node.props['aria-live'] === 'polite')
  assert.ok(status)
  assert.match(ui.text(status), /源不支持/)
  assert.doesNotMatch(ui.text(ui.render()), /当前已是最新版本/)
  assert.equal(ui.button('更新插件').props.disabled, true)
})
