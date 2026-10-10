import test from 'node:test'
import assert from 'node:assert/strict'
import { patchWorkflowGraph, workflowRevision } from '../lib/workflow-graph.js'

const sample = () => ({
  format: 'dsh-tavern-comfy-v1', custom: { preserve: true }, outputNode: '3',
  prompt: { '1': { class_type: 'Loader', inputs: { model: 'base', strength: 0.5, enabled: true } },
    '2': { class_type: 'LoraLoader', inputs: { lora_name: 'old', strength_model: 0.8, model: ['1', 0] } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } },
  bindings: { loras: [{ node: '2', name: 'old', strengthModel: 0.8 }] },
})

test('graph edits retain links, extension metadata and sync generation LoRA bindings', () => {
  const raw = sample()
  const next = patchWorkflowGraph(raw, { inputs: { '2': { lora_name: 'new', strength_model: 0.3 }, '1': { enabled: false } }, positions: { '2': { x: 123, y: -40 } } }, workflowRevision(raw))
  assert.deepEqual(next.prompt['2'].inputs.model, ['1', 0])
  assert.deepEqual(next.custom, raw.custom)
  assert.equal(next.bindings.loras[0].name, 'new')
  assert.equal(next.bindings.loras[0].strengthModel, 0.3)
  assert.deepEqual(next.graphPositions['2'], { x: 123, y: -40 })
  assert.equal(raw.prompt['2'].inputs.lora_name, 'old')
})

test('stale saves, new fields, links, invalid types and excessive coordinates are rejected', () => {
  const raw = sample(), revision = workflowRevision(raw)
  assert.throws(() => patchWorkflowGraph(raw, {}, 'outdated'), /重新打开/)
  for (const patch of [{ inputs: { '2': { model: 'oops' } } }, { inputs: { '1': { model: 123 } } },
    { inputs: { '1': { added: 1 } } }, { inputs: { unknown: {} } }, { inputs: { '1': { strength: Infinity } } },
    { positions: { '2': { x: 1e10, y: 0 } } }, { positions: { unknown: { x: 0, y: 0 } } }]) {
    assert.throws(() => patchWorkflowGraph(raw, patch, revision))
  }
})
