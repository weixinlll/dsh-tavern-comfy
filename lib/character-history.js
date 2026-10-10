const TRAIT_FIELDS = new Set(['feature', 'face', 'faceBack', 'bodySFW', 'bodySFWBack', 'lowerSFW', 'lowerSFWBack', 'bodyNSFW', 'bodyNSFWBack', 'lowerNSFW', 'lowerNSFWBack'])
const BASE_TRAIT_FIELDS = new Set([...TRAIT_FIELDS, 'negative'])
const MAX_CHANGES = 120
const MAX_TEXT = 700

function clip(value, max = MAX_TEXT) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) }
function size(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

export function emptyCharacterSnapshot() {
  return { version: 1, characters: {}, changes: [] }
}

export function mergeCharacterUpdates(previous, definitions, updates, meta = {}) {
  const snapshot = previous && typeof previous === 'object' ? structuredClone(previous) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.changes)) snapshot.changes = []
  const characters = Array.isArray(definitions?.characters) ? definitions.characters : []
  const byId = new Map()
  for (const character of characters) {
    if (!character || character.enabled === false || !character.id) continue
    const id = String(character.id)
    byId.set(id, [...(byId.get(id) ?? []), character])
  }
  const changes = []
  const updatedIds = new Set()
  for (const raw of Array.isArray(updates) ? updates : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('角色更新条目格式无效')
    const name = clip(raw.name, 100)
    const hintedId = clip(raw.id, 100)
    const matches = hintedId ? byId.get(hintedId) ?? [] : []
    const character = matches.length === 1 ? matches[0] : null
    if (!character || raw.permanent !== true) throw new Error('角色更新必须指向唯一的已知角色并明确标记 permanent=true')
    if (name && ![character.name, character.match, ...(Array.isArray(character.aliases) ? character.aliases : [])]
      .some(alias => clip(alias, 100).toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('角色更新名称与 stable id 不匹配')
    }
    const id = String(character.id)
    if (updatedIds.has(id)) throw new Error('角色更新中包含重复角色：' + clip(character.name, 100))
    updatedIds.add(id)
    const supplied = raw.fields
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('角色更新 fields 必须是对象')
    const entries = Object.entries(supplied)
    if (!entries.length || entries.some(([key, value]) => !TRAIT_FIELDS.has(key) || typeof value !== 'string' || !clip(value))) {
      throw new Error('角色更新包含无效字段或空描述')
    }
    const fields = entries
    const overlay = snapshot.characters[character.id] ||= { traits: {} }
    overlay.baseTraits ||= Object.fromEntries(Object.entries(character.traits ?? {}).filter(([key, value]) => BASE_TRAIT_FIELDS.has(key) && clip(value)).map(([key, value]) => [key, clip(value)]))
    overlay.identity ||= { name: clip(character.name, 100), match: clip(character.match, 200) }
    overlay.traits ||= {}
    const reason = clip(raw.reason, 240)
    for (const [key, value] of fields) {
      const next = clip(value)
      const before = clip(overlay.traits[key] || character.traits?.[key])
      if (!next || next === before) continue
      overlay.traits[key] = next
      changes.push({
        id, name: clip(character.name, 100), field: key,
        before, after: next, reason: reason || '正文明确叙述永久外貌变化',
        turn: Number(meta.turn) || 0, textVersion: clip(meta.textVersion, 120), at: Number(meta.at) || Date.now(),
      })
    }
  }
  if (changes.length) snapshot.changes.push(...changes)
  snapshot.changes = snapshot.changes.slice(-MAX_CHANGES)
  snapshot.version = 1
  return { snapshot, changes }
}

/** Overlay timeline facts on the untouched user-authored character definitions. */
export function applyCharacterSnapshot(definitions, snapshot) {
  const state = snapshot?.characters && typeof snapshot.characters === 'object' ? snapshot.characters : {}
  return {
    ...(definitions ?? {}),
    characters: (definitions?.characters ?? []).map(character => {
      const overlay = state[String(character?.id)]
      return overlay?.traits || overlay?.baseTraits
        ? { ...character, ...(overlay.identity ?? {}), traits: { ...(overlay.baseTraits ?? character.traits ?? {}), ...(overlay.traits ?? {}) } }
        : character
    }),
  }
}

/** Fit safely under Tavern's 64 KB per-turn snapshot cap; retain newest history. */
export function boundCharacterSnapshot(input, maxBytes = 60 * 1024) {
  const snapshot = input && typeof input === 'object' ? structuredClone(input) : emptyCharacterSnapshot()
  if (!snapshot.characters || typeof snapshot.characters !== 'object') snapshot.characters = {}
  if (!Array.isArray(snapshot.changes)) snapshot.changes = []
  snapshot.changes = snapshot.changes.slice(-MAX_CHANGES)
  for (const id of Object.keys(snapshot.characters)) {
    const source = snapshot.characters[id] ?? {}
    const filterTraits = (traits, allowed) => Object.fromEntries(Object.entries(traits ?? {}).filter(([key, value]) => allowed.has(key) && clip(value)).map(([key, value]) => [key, clip(value)]))
    snapshot.characters[id] = {
      ...(source.identity && typeof source.identity === 'object' ? { identity: { name: clip(source.identity.name, 100), match: clip(source.identity.match, 200) } } : {}),
      baseTraits: filterTraits(source.baseTraits, BASE_TRAIT_FIELDS), traits: filterTraits(source.traits, TRAIT_FIELDS),
    }
  }
  while (snapshot.changes.length && size(snapshot) > maxBytes) snapshot.changes.shift()
  if (size(snapshot) > maxBytes) throw new Error('角色历史数据超出每轮存档限制')
  return snapshot
}

export function characterHistoryChanges(snapshot) { return Array.isArray(snapshot?.changes) ? snapshot.changes.slice(-MAX_CHANGES) : [] }
