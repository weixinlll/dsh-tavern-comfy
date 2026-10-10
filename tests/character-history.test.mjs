import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCharacterSnapshot, boundCharacterSnapshot, emptyCharacterSnapshot, mergeCharacterUpdates } from '../lib/character-history.js'
import { characterRoster, parsePlannerDecision } from '../lib/planner.js'

const definitions = { characters: [{ id: 'stable-1', name: 'Luna', match: 'luna', traits: { face: 'black hair, green eyes' } }] }

test('only explicit permanent facts for named library roles enter history', () => {
  const { snapshot, changes } = mergeCharacterUpdates(emptyCharacterSnapshot(), definitions, [
    { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'black hair cut short, green eyes' }, reason: '正文明确写她剪短了头发' },
  ], { turn: 9, textVersion: 'v9', at: 123 })
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before, 'black hair, green eyes')
  assert.equal(changes[0].after, 'black hair cut short, green eyes')
  assert.equal(changes[0].turn, 9)
  assert.deepEqual(applyCharacterSnapshot(definitions, snapshot).characters[0].traits, { face: 'black hair cut short, green eyes' })
  assert.equal(definitions.characters[0].traits.face, 'black hair, green eyes')
  assert.throws(() => mergeCharacterUpdates(snapshot, definitions, [
    { id: 'stable-1', name: 'Luna', permanent: false, fields: { face: 'wet hair' } },
  ]), /permanent=true/)
  assert.throws(() => mergeCharacterUpdates(snapshot, definitions, [
    { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: { text: 'not a string' } } },
  ]), /无效字段/)
})

test('updates require one stable role, a matching identity, explicit permanence and valid trait fields', () => {
  const invalid = [
    [{ name: 'Luna', permanent: true, fields: { face: 'new face' } }],
    [{ id: 'stable-1', name: 'Someone else', permanent: true, fields: { face: 'new face' } }],
    [{ id: 'stable-1', name: 'Luna', permanent: false, fields: { face: 'new face' } }],
    [{ id: 'stable-1', name: 'Luna', permanent: true, fields: { unknown: 'value' } }],
    [{ id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'one' } }, { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'two' } }],
  ]
  for (const updates of invalid) assert.throws(() => mergeCharacterUpdates(emptyCharacterSnapshot(), definitions, updates), /角色更新/)
  const ambiguous = { characters: [...definitions.characters, { ...definitions.characters[0], name: 'Duplicate ID' }] }
  assert.throws(() => mergeCharacterUpdates(emptyCharacterSnapshot(), ambiguous, [
    { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'new face' } },
  ]), /唯一/)
})

test('historical role keeps its original traits and display identity after global edits', () => {
  const longFact = 'silver eyes, ' + 'unchanged detail '.repeat(12)
  const original = { characters: [{ id: 'stable-1', name: 'Luna', match: 'luna', traits: { face: longFact, feature: 'scarless' } }] }
  const { snapshot } = mergeCharacterUpdates(emptyCharacterSnapshot(), original, [
    { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'short black hair, silver eyes, unchanged detail' } },
  ])
  const manuallyChanged = { characters: [{ id: 'stable-1', name: 'New Card Name', match: 'new_name', traits: { face: 'blue eyes', feature: 'new global feature' } }] }
  const applied = applyCharacterSnapshot(manuallyChanged, snapshot).characters[0]
  assert.equal(applied.name, 'Luna')
  assert.equal(applied.match, 'luna')
  assert.equal(applied.traits.feature, 'scarless')
  assert.match(applied.traits.face, /short black hair/)
})

test('permanent appearance snapshots preserve the user-authored negative prompt', () => {
  const original = { characters: [{ id: 'stable-1', name: 'Luna', match: 'luna', traits: { face: 'black hair', negative: 'blurry, extra fingers' } }] }
  const { snapshot } = mergeCharacterUpdates(emptyCharacterSnapshot(), original, [
    { id: 'stable-1', name: 'Luna', permanent: true, fields: { face: 'short black hair' } },
  ])
  const bounded = boundCharacterSnapshot(snapshot)
  const editedDefinitions = { characters: [{ ...original.characters[0], traits: { face: 'blue eyes', negative: 'changed card negative' } }] }
  const applied = applyCharacterSnapshot(editedDefinitions, bounded).characters[0]
  assert.equal(applied.traits.face, 'short black hair')
  assert.equal(applied.traits.negative, 'blurry, extra fingers')
  assert.equal(Object.hasOwn(bounded.characters['stable-1'].traits, 'negative'), false, 'the model-owned overlay cannot update negative text')
})

test('history roster includes full bounded traits so unchanged facts survive model rewrites', () => {
  const fact = 'green eyes, ' + 'distinctive unchanged feature '.repeat(8)
  const short = characterRoster({ characters: [{ ...definitions.characters[0], traits: { face: fact } }] })
  const history = characterRoster({ characters: [{ ...definitions.characters[0], traits: { face: fact } }] }, { fullTraits: true })
  assert.ok(short.length < fact.length)
  assert.ok(history.includes(fact.trim()))
})

test('snapshot size pressure trims old event text but never drops appearance state', () => {
  const source = {
    version: 1,
    characters: { roleA: { traits: { face: 'preserve' } } },
    changes: Array.from({ length: 5 }, (_, index) => ({ reason: 'x'.repeat(3000), turn: index + 1 })),
  }
  const bounded = boundCharacterSnapshot(source, 1100)
  assert.equal(bounded.characters.roleA.traits.face, 'preserve')
  assert.ok(bounded.changes.length < source.changes.length)
  assert.throws(() => boundCharacterSnapshot({ characters: { roleA: { traits: { face: 'x'.repeat(3000) } } }, changes: [] }, 200), /存档限制/)
})

test('planner decision parser distinguishes skip from draw and keeps optional story updates', () => {
  assert.deepEqual(parsePlannerDecision('<decision>skip</decision><reason>quiet dialogue</reason><character_updates>{"updates":[]}</character_updates>'), {
    decision: 'skip', reason: 'quiet dialogue', characterUpdates: [], characterUpdatesPresent: true, characterUpdatesValid: true,
  })
  assert.equal(parsePlannerDecision('<decision>draw</decision>').decision, 'draw')
  assert.equal(parsePlannerDecision('<decision>skip</decision><character_updates>broken</character_updates>').characterUpdates.length, 0)
  assert.equal(parsePlannerDecision('<decision>draw</decision><decision>skip</decision>').decision, '')
  assert.equal(parsePlannerDecision('<decision>skip</decision><decision>skip</decision>').decision, '')
})
