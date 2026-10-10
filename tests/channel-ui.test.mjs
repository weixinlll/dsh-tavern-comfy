import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.apply = apply', 'exports.apply = apply; exports.__test = { SettingsPanel, jsonFetch }')
const clone = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(initialState, fetchFailure, channelTestResult = { ok: true, status: 'reachable', message: '模型列表可读', models: ['image-model-a'] }, storage = new Map()) {
  const hooks = []
  let cursor = 0
  let effects = []
  let api
  let tree
  let state = clone(initialState)
  const requests = []
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      if (typeof type === 'function' && type.name === 'PromptPresetCard') return type(props || {})
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
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
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, addEventListener() {}, __ModuleLoader__: { load({ factory }) { api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' },
    document: { baseURI: 'http://test.local', createElement() { return { click() {} } } },
    confirm: () => true, URL, console, Date, Math, Promise, TypeError,
    setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout,
    async fetch(url, init = {}) {
      if (fetchFailure) return fetchFailure(url, init)
      const parsed = new URL(url)
      const path = parsed.pathname.split('/').at(-1)
      const body = init.body ? JSON.parse(init.body) : null
      requests.push({ path, method: init.method || 'GET', body })
      let result
      if (path === 'state') result = clone(state)
      else if (path === 'llm-models') result = { providers: [] }
      else if (path === 'config') {
        const patch = body.config
        const previous = state.config
        const oldById = new Map((previous.imageChannels || []).map(channel => [channel.id, channel]))
        const incoming = patch.imageChannels === undefined ? previous.imageChannels : patch.imageChannels
        const imageChannels = (incoming || []).map(channel => {
          const old = oldById.get(channel.id) || {}
          const apiKey = channel.clearApiKey ? '' : (channel.apiKey || old.apiKey || '')
          const password = channel.clearPassword ? '' : (channel.password || old.password || '')
          const safe = { ...channel, hasApiKey: Boolean(apiKey), hasPassword: Boolean(password) }
          delete safe.apiKey; delete safe.password; delete safe.clearApiKey; delete safe.clearPassword
          return safe
        })
        state = { ...state, config: { ...previous, ...patch, imageChannels } }
        result = { ok: true, state: clone(state) }
      } else if (path === 'image-channel-test') result = clone(channelTestResult)
      else result = { ok: true }
      return { ok: true, status: 200, json: async () => result }
    },
  }
  vm.runInNewContext(source, context)
  const nodes = root => !root || typeof root !== 'object' ? [] : [root, ...(root.children || []).flatMap(nodes)]
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  function render() {
    cursor = 0; effects = []
    tree = api.__test.SettingsPanel()
    effects.forEach(effect => effect())
    return tree
  }
  function find(predicate, root = tree) { const node = nodes(root).find(predicate); assert.ok(node, 'UI control was not found'); return node }
  async function ready() { render(); await flush(); render(); await flush(); render() }
  return { api, render, find, nodes, text, ready, requests, storage, get state() { return state }, get tree() { return tree } }
}

const providers = [
  { id: 'openai', label: 'OpenAI / Images 兼容中转', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-flare' },
  { id: 'novelai', label: 'NovelAI / 同协议第三方', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full' },
]

function externalState() {
  return {
    imageProviders: providers,
    config: {
      imageBackend: 'openai', activeImageChannel: 'openai-a', imageConcurrency: 2, plannerEnabled: true,
      imageChannels: [
        { id: 'openai-a', name: '主站', provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'image-model-a', authMode: 'bearer', options: {}, hasApiKey: false, hasPassword: false },
        { id: 'openai-b', name: '备用', provider: 'openai', baseUrl: 'https://relay.example.com/v1', model: 'image-model-b', authMode: 'bearer', options: {}, hasApiKey: true, hasPassword: false },
      ],
    },
    workflows: [], definitions: { characters: [], outfits: [] }, outfits: [], tasks: [],
  }
}

test('渠道草稿按 id 保留，密码框不回显服务端密钥，保存保留其他渠道并在保存后探测', async () => {
  const ui = harness(externalState())
  await ui.ready()
  const getInput = label => ui.find(node => node.type === 'input' && node.props['aria-label'] === label)
  const channelPicker = ui.find(node => node.type === 'select' && node.props['aria-label'] === '生图渠道')
  assert.equal(getInput('渠道 API Key').props.value, '')
  assert.match(ui.text(ui.tree), /已配置，尚未验证/)
  assert.doesNotMatch(ui.text(ui.tree), /导入一个工作流/)
  assert.doesNotMatch(ui.text(ui.tree), /连接可用/)

  getInput('渠道 API Key').props.onChange({ target: { value: 'secret-draft' } }); ui.render()
  getInput('渠道名称').props.onChange({ target: { value: '主站未保存草稿' } }); ui.render()
  getInput('尺寸覆盖（可选）').props.onChange({ target: { value: '1536x1024' } }); ui.render()
  channelPicker.props.onChange({ target: { value: 'openai-b' } }); ui.render()
  assert.equal(getInput('渠道 API Key').props.value, '')
  assert.equal(getInput('渠道名称').props.value, '备用')
  ui.find(node => node.type === 'select' && node.props['aria-label'] === '生图渠道').props.onChange({ target: { value: 'openai-a' } }); ui.render()
  assert.equal(getInput('渠道 API Key').props.value, 'secret-draft')
  assert.equal(getInput('渠道名称').props.value, '主站未保存草稿')
  assert.equal(getInput('尺寸覆盖（可选）').props.value, '1536x1024')

  const saveButton = ui.find(node => node.type === 'button' && ui.text(node) === '保存并测试连接')
  await Promise.all([saveButton.props.onClick(), saveButton.props.onClick()])
  const configWrite = ui.requests.find(request => request.path === 'config' && request.body.config.imageChannels)
  assert.equal(configWrite.body.config.imageChannels.length, 2)
  assert.equal(configWrite.body.config.imageChannels.find(channel => channel.id === 'openai-a').apiKey, 'secret-draft')
  assert.equal(configWrite.body.config.imageChannels.find(channel => channel.id === 'openai-a').options.size, '1536x1024')
  assert.equal(ui.state.config.imageChannels.length, 2)
  assert.equal(ui.state.config.imageChannels.find(channel => channel.id === 'openai-a').apiKey, undefined)
  assert.equal(ui.requests.filter(request => request.path === 'image-channel-test').length, 1)
  assert.equal(ui.requests.find(request => request.path === 'image-channel-test').body.id, 'openai-a')
})

test('清除密钥后输入替换值会取消清除标记；渠道并发有边界', async () => {
  const ui = harness(externalState())
  await ui.ready()
  ui.find(node => node.type === 'select' && node.props['aria-label'] === '生图渠道').props.onChange({ target: { value: 'openai-b' } }); ui.render()
  const clear = ui.find(node => node.type === 'button' && ui.text(node) === '清除已保存 Key')
  clear.props.onClick(); ui.render()
  ui.find(node => node.type === 'input' && node.props['aria-label'] === '渠道 API Key').props.onChange({ target: { value: 'replacement-key' } }); ui.render()
  await ui.find(node => node.type === 'button' && ui.text(node) === '保存并测试连接').props.onClick()
  const channel = ui.requests.find(request => request.path === 'config' && request.body.config.imageChannels).body.config.imageChannels.find(item => item.id === 'openai-b')
  assert.equal(channel.apiKey, 'replacement-key')
  assert.equal(Boolean(channel.clearApiKey), false)

  const concurrency = ui.find(node => node.type === 'input' && node.props['aria-label'] === '同时生成')
  concurrency.props.onChange({ target: { value: '99' } }); ui.render()
  assert.equal(ui.find(node => node.type === 'input' && node.props['aria-label'] === '同时生成').props.value, 4)
})

test('configured 探测结果只显示已配置，不误标成连接可用', async () => {
  const ui = harness(externalState(), null, { ok: true, status: 'configured', message: '此服务没有可安全探测的接口。' })
  await ui.ready()
  await ui.find(node => node.type === 'button' && ui.text(node) === '保存并测试连接').props.onClick()
  ui.render()
  assert.match(ui.text(ui.tree), /已配置，尚未验证/)
  assert.doesNotMatch(ui.text(ui.tree), /连接可用/)
})

test('Grok 不显示服务端忽略的尺寸和比例覆盖', async () => {
  const state = externalState()
  state.imageProviders.push({ id: 'grok', label: 'Grok Images', baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image-2.0' })
  state.config.imageBackend = 'grok'
  state.config.activeImageChannel = 'grok-main'
  state.config.imageChannels = [{ id: 'grok-main', name: 'Grok', provider: 'grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image-2.0', authMode: 'bearer', options: {}, hasApiKey: false, hasPassword: false }]
  const ui = harness(state)
  await ui.ready()
  assert.equal(ui.nodes(ui.tree).some(node => node.type === 'input' && /尺寸|比例/.test(node.props['aria-label'] || '')), false)
  assert.match(ui.text(ui.tree), /Grok 当前由服务端模型决定尺寸和比例/)
})

test('提示词预设编辑草稿保存在本地并在重新打开控制台后恢复', async () => {
  const state = externalState()
  state.config.promptPresets = [{ id: 'draft-1', name: '我的预设', positive: 'soft light', negative: 'watermark', enabled: true }]
  const first = harness(state)
  await first.ready()
  first.find(node => node.type === 'button' && first.text(node) === '画风').props.onClick(); first.render()
  const input = first.find(node => node.type === 'textarea' && node.props['aria-label'] === '预设正面指导 我的预设')
  input.props.onChange({ target: { value: 'soft light, careful composition' } }); first.render()
  assert.match(first.storage.get('dsh-tavern-comfy-prompt-draft-v1'), /careful composition/)

  const reopened = harness(state, null, undefined, first.storage)
  await reopened.ready()
  reopened.find(node => node.type === 'button' && reopened.text(node) === '画风').props.onClick(); reopened.render()
  assert.equal(reopened.find(node => node.type === 'textarea' && node.props['aria-label'] === '预设正面指导 我的预设').props.value, 'soft light, careful composition')
})

test('JSON 网络错误时 POST 只发送一次，避免重复创建或扣费', async () => {
  let calls = 0
  const ui = harness(externalState(), async () => { calls += 1; throw new TypeError('Failed to fetch') })
  await ui.ready()
  calls = 0
  await assert.rejects(ui.api.__test.jsonFetch('http://test.local/api/generate', { method: 'POST', body: '{}' }), /Failed to fetch/)
  assert.equal(calls, 1)
})
