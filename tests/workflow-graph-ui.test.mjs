import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.__graphTest = WorkflowGraphEditor')
const flush = () => new Promise(resolve => setImmediate(resolve))
const workflow = () => ({
  prompt: {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'positive', clip: ['1', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 7, positive: ['2', 0], enabled: true, empty: null } },
    '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  },
  graphPositions: {},
})
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function harness({ answer, confirm = () => true } = {}) {
  const hooks = []
  let cursor = 0
  let effects = []
  let tree
  const requests = []
  const React = {
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
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous[i]))) effects.push(effect)
      hooks[index] = deps
    },
  }
  let api
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, addEventListener() {}, __ModuleLoader__: { load({ factory }) { api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' }, document: { baseURI: 'http://test.local' },
    confirm, URL, console, Date, Math, Promise, TypeError, setTimeout, clearTimeout,
  }
  vm.runInNewContext(source, context)
  const component = api.__graphTest
  const props = {
    file: 'workflows/demo.json',
    async post(path, body) {
      requests.push({ path, body })
      if (answer) return answer(path, body)
      if (!body.patch) return { ok: true, workflow: workflow(), revision: 'revision-1' }
      return { ok: true, workflow: workflow(), revision: 'revision-2' }
    },
    onClose() { props.closed = (props.closed || 0) + 1 },
    onSaved() { props.saved = (props.saved || 0) + 1 },
  }
  const nodes = root => !root || typeof root !== 'object' ? [] : [root, ...(root.children || []).flatMap(nodes)]
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  function render() {
    cursor = 0; effects = []
    tree = component(props)
    effects.forEach(effect => effect())
    return tree
  }
  function find(predicate, root = tree) { const node = nodes(root).find(predicate); assert.ok(node, '找不到 UI 元素'); return node }
  function button(label) { return find(node => node.type === 'button' && text(node) === label) }
  function input(label) { return find(node => node.props['aria-label'] === label) }
  return { render, find, button, input, nodes, text, requests, props, get tree() { return tree } }
}

test('graph canvas displays dependency links, layered nodes, zoom controls and typed inspector fields', async () => {
  const ui = harness()
  ui.render(); await flush(); ui.render()
  assert.match(ui.text(ui.tree), /4 节点 · 3 连线/)
  assert.equal(ui.find(node => node.type === 'svg').props.width, 1)
  assert.ok(ui.nodes(ui.tree).some(node => node.type === 'marker'))
  const node1 = ui.find(node => node.props['aria-label'] === '节点 1 CheckpointLoaderSimple')
  const node2 = ui.find(node => node.props['aria-label'] === '节点 2 CLIPTextEncode')
  const node3 = ui.find(node => node.props['aria-label'] === '节点 3 KSampler')
  assert.ok(node1.props.style.left < node2.props.style.left && node2.props.style.left < node3.props.style.left, 'acyclic graph is laid out by dependency depth')
  assert.ok(ui.button('保存').props.disabled)
  assert.equal(ui.find(node => node.props['aria-label'] === '放大').type, 'button')
  node3.props.onKeyDown({ key: 'Enter', preventDefault() {} }); ui.render()
  assert.equal(ui.input('seed').props.value, '42')
  assert.equal(ui.input('enabled').props.checked, true)
  assert.match(ui.text(ui.tree), /只读/)
  assert.match(ui.text(ui.tree), /会被生成设置覆盖/)
})

test('save sends only primitive edits and persisted node positions while preserving graph links', async () => {
  const ui = harness()
  ui.render(); await flush(); ui.render()
  const sampler = ui.find(node => node.props['aria-label'] === '节点 3 KSampler')
  sampler.props.onClick(); ui.render()
  ui.input('steps').props.onChange({ target: { value: '31' } }); ui.render()
  ui.input('enabled').props.onChange({ target: { checked: false } }); ui.render()
  const movedSampler = ui.find(node => node.props['aria-label'] === '节点 3 KSampler')
  movedSampler.props.onMouseDown({ button: 0, clientX: 10, clientY: 20, preventDefault() {} }); ui.render()
  const canvas = ui.find(node => node.props['aria-label'] === '工作流节点画布')
  canvas.props.onMouseMove({ clientX: 50, clientY: 60 }); ui.render()
  assert.match(ui.text(ui.tree), /有未保存修改/)
  await ui.button('保存').props.onClick(); await flush(); ui.render()
  const save = ui.requests.find(request => request.body.patch)
  assert.deepEqual(JSON.parse(JSON.stringify(save.body.patch.inputs)), { '3': { steps: 31, enabled: false } })
  assert.ok(save.body.patch.positions['3'].x > 80)
  assert.equal(save.body.revision, 'revision-1')
  assert.equal(ui.props.saved, 1)
  assert.ok(ui.button('保存').props.disabled)
  assert.match(ui.text(ui.tree), /4 节点 · 3 连线/)
})

test('empty numeric input is rejected; dirty close confirms and saving locks edits and close', async () => {
  let confirmed = false
  const pending = deferred()
  const ui = harness({ confirm: () => confirmed, answer: async (path, body) => {
    if (!body.patch) return { ok: true, workflow: workflow(), revision: 'revision-1' }
    return pending.promise
  } })
  ui.render(); await flush(); ui.render()
  ui.find(node => node.props['aria-label'] === '节点 3 KSampler').props.onClick(); ui.render()
  ui.input('seed').props.onChange({ target: { value: '' } }); ui.render()
  await ui.button('保存').props.onClick(); ui.render()
  assert.match(ui.text(ui.tree), /数字参数不能为空/)
  assert.equal(ui.requests.filter(request => request.body.patch).length, 0)
  ui.input('seed').props.onChange({ target: { value: '43' } }); ui.render()
  ui.button('关闭 ×').props.onClick(); ui.render()
  assert.equal(ui.props.closed || 0, 0)
  confirmed = true
  ui.button('保存').props.onClick(); ui.render()
  assert.equal(ui.button('关闭 ×').props.disabled, true)
  assert.equal(ui.input('seed').props.disabled, true)
  ui.input('seed').props.onChange({ target: { value: '99' } }); ui.render()
  assert.equal(ui.input('seed').props.value, '43')
  pending.resolve({ ok: true, workflow: workflow(), revision: 'revision-2' })
  await flush(); ui.render()
  assert.equal(ui.props.saved, 1)
})
