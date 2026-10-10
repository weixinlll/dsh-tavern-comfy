import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('exports.apply = apply', 'exports.apply = apply; exports.__test = { SettingsPanel }')
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const hooks = [], requests = []
  let cursor = 0, effects = [], api
  let state = { config: { comfyMode: 'simple', comfySimple: { template: 'checkpoint', checkpoint: 'local.safetensors', width: 800, height: 600 }, comfyUrl: 'http://comfy.test', plannerEnabled: true }, workflows: [], definitions: { characters: [], outfits: [] }, outfits: [], tasks: [] }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value }] },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] },
    useEffect(effect, deps) { const i = cursor++, old = hooks[i]; if (!old || !deps || deps.some((value, j) => !Object.is(value, old[j]))) effects.push(effect); hooks[i] = deps },
  }
  const info = { ok: true, checkpoints: ['local.safetensors'], unets: ['flux-dev.safetensors', 'anima-preview.safetensors'], fluxUnets: ['flux-dev.safetensors'], animaUnets: ['anima-preview.safetensors'], dualClips1: ['t5xxl_fp16.safetensors'], dualClips2: ['clip_l.safetensors'], clips: ['qwen_3_06b_base.safetensors'], vaes: ['ae.safetensors', 'qwen_image_vae.safetensors'], loras: ['style.safetensors'], samplers: ['euler'], schedulers: ['normal'], templates: { checkpoint: { available: true }, flux: { available: true }, anima: { available: true } } }
  const context = {
    window: { location: { origin: 'http://test.local' }, top: { location: { origin: 'http://test.local' } }, addEventListener() {}, __ModuleLoader__: { load({ factory }) { api = factory(name => { assert.equal(name, 'react'); return React }) } } },
    location: { origin: 'http://test.local', href: 'http://test.local' }, document: { baseURI: 'http://test.local', createElement() { return { click() {} } } },
    confirm: () => true, URL, console, Date, Math, Promise, TypeError, setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout,
    async fetch(url, init = {}) {
      const path = new URL(url).pathname.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null
      requests.push({ path, body })
      if (path === 'state') return { ok: true, status: 200, json: async () => state }
      if (path === 'llm-models') return { ok: true, status: 200, json: async () => ({ providers: [] }) }
      if (path === 'comfy-simple-info') return { ok: true, status: 200, json: async () => info }
      if (path === 'config') { state = { ...state, config: { ...state.config, ...body.config } }; return { ok: true, status: 200, json: async () => ({ ok: true, state }) } }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  }
  vm.runInNewContext(source, context)
  const nodes = root => !root || typeof root !== 'object' ? [] : [root, ...(root.children || []).flatMap(nodes)]
  const text = node => (node?.children || []).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  let tree
  const render = () => { cursor = 0; effects = []; tree = api.__test.SettingsPanel(); effects.forEach(effect => effect()); return tree }
  const find = predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'UI control was not found'); return node }
  const ready = async () => { render(); await flush(); render(); await flush(); render() }
  return { requests, get state() { return state }, get tree() { return tree }, nodes, text, render, find, ready }
}

test('simple-mode panel reads real Comfy model choices and saves selected template without requiring a JSON workflow', async () => {
  const ui = harness()
  await ui.ready()
  assert.match(ui.text(ui.tree), /简单模式/)
  ui.find(item => item.type === 'button' && ui.text(item) === '画风').props.onClick(); ui.render()
  assert.match(ui.text(ui.tree), /简单模式（不需要 JSON）/)
  ui.find(item => item.type === 'button' && ui.text(item) === '刷新模型列表').props.onClick()
  await flush(); ui.render()
  const mode = ui.find(item => item.type === 'select' && item.props.value === 'checkpoint')
  mode.props.onChange({ target: { value: 'flux' } }); ui.render()
  assert.match(ui.text(ui.tree), /双 CLIP（T5 \/ CLIP-L）/)
  await ui.find(item => item.type === 'button' && ui.text(item) === '保存简单模式设置').props.onClick()
  assert.equal(ui.state.config.comfyMode, 'simple')
  assert.equal(ui.state.config.comfySimple.template, 'flux')
  assert.equal(ui.state.config.comfySimple.unet, 'flux-dev.safetensors')
  assert.equal(ui.state.config.comfySimple.clip1, 't5xxl_fp16.safetensors')
  assert.equal(ui.state.config.comfySimple.clip2, 'clip_l.safetensors')
  assert.equal(ui.state.config.comfySimple.vae, 'ae.safetensors')
  assert.equal(ui.requests.filter(item => item.path === 'comfy-simple-info').length, 1)
  assert.equal(ui.requests.some(item => item.path === 'generate'), false)
})
