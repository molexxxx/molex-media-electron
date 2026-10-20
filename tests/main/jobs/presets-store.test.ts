import { describe, it, expect } from 'vitest'
import type { PersistenceIO } from '../../../src/main/jobs/deps'
import {
  PIN_KEY_LIST, PresetStore, RECENT_LIMIT, USER_PRESET_PREFIX, defaultPresetState, pinKey, pinTo, readPresetFile, sidePath, withRecent,
  type PresetStoreDeps
} from '../../../src/main/jobs/presets-store'
import { DEFAULT_PINS, applyPreset, findPreset } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { PresetState } from '../../../src/shared/jobs/types'
import type { EncoderPolicy } from '../../../src/shared/audio/types'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy
const PATH = 'C:/data/jobs/presets.json'
const SIDE = 'C:/data/jobs/presets.v1.json'
const NOW = 1_700_000_000_000

function recipe(id = 'mp4-h264'): Recipe
{
  return applyPreset(id, OUTPUT) as Recipe
}

interface MemoryIO extends PersistenceIO
{
  files: Map<string, string>
  writes: string[]
  fail: { write: Error | null; rename: Error | null }
  /** Holds every atomic write until `release` runs. */
  gate: Promise<void> | null
}

function memoryIO(initial: Record<string, string> = {}): MemoryIO
{
  const files = new Map(Object.entries(initial))
  const io: MemoryIO =
  {
    files,
    writes: [],
    fail: { write: null, rename: null },
    gate: null,
    append: async (path, text) =>
    {
      files.set(path, (files.get(path) ?? '') + text)
    },
    appendSync: (path, text) =>
    {
      files.set(path, (files.get(path) ?? '') + text)
    },
    fsync: async () => undefined,
    writeAtomic: async (path, text) =>
    {
      if (io.gate !== null)
      {
        await io.gate
      }
      if (io.fail.write !== null)
      {
        throw io.fail.write
      }
      io.writes.push(path)
      files.set(path, text)
    },
    read: async (path) => files.get(path) ?? null,
    list: async () => [...files.keys()],
    rename: async (from, to) =>
    {
      const text = files.get(from)
      if (io.fail.rename !== null || text === undefined)
      {
        throw io.fail.rename ?? new Error('ENOENT')
      }
      files.delete(from)
      files.set(to, text)
    },
    unlink: async (path) =>
    {
      files.delete(path)
    },
    mkdir: async () => undefined
  }
  return io
}

function written(io: MemoryIO, path = PATH): Record<string, unknown>
{
  return JSON.parse(io.files.get(path) as string) as Record<string, unknown>
}

function file(state: Partial<PresetState> & Record<string, unknown>): string
{
  return JSON.stringify({ schema: 1, user: [], pins: {}, recent: [], ...state })
}

interface Opened
{
  store: PresetStore
  io: MemoryIO
  changes: PresetState[]
  clock: { now: number }
}

async function open(initial: Record<string, string> = {}, options: Partial<PresetStoreDeps> = {}): Promise<Opened>
{
  const io = memoryIO(initial)
  const changes: PresetState[] = []
  const clock = { now: NOW }
  let next = 0
  const { store } = await PresetStore.open({
    io,
    path: PATH,
    now: () => clock.now,
    onChange: (state) => changes.push(state),
    newId: () => `${USER_PRESET_PREFIX}${++next}`,
    ...options
  })
  io.writes.length = 0
  return { store, io, changes, clock }
}

describe('PresetStore.open', () =>
{
  it('gives a new install the nine default pins and writes them atomically', async () =>
  {
    const io = memoryIO()
    const { store, load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load).toEqual({ found: 'missing', newer: null, path: PATH, dropped: 0, reason: null, setAside: null, error: null })
    expect(store.state()).toEqual({ user: [], pins: DEFAULT_PINS, recent: [] })
    expect(Object.keys(store.state().pins)).toEqual(PIN_KEY_LIST)
    expect(io.writes).toEqual([PATH])
    expect(written(io)).toEqual({ schema: 1, user: [], pins: DEFAULT_PINS, recent: [] })
    expect(store.path).toBe(PATH)
  })

  it('starts a new store with its seed presets, and never adds them to a store that has a file', async () =>
  {
    const seed = [{ id: 'user-earlier-default', name: 'Earlier default', recipe: recipe(), createdAt: NOW, updatedAt: NOW }]
    const io = memoryIO()
    const { store } = await PresetStore.open({ io, path: PATH, now: () => NOW, seed })
    expect(store.users()).toEqual(seed)
    expect(store.users()[0]).not.toBe(seed[0])
    expect(written(io)).toMatchObject({ user: seed, pins: DEFAULT_PINS })
    const kept = await PresetStore.open({ io: memoryIO({ [PATH]: file({ user: [], pins: {} }) }), path: PATH, now: () => NOW, seed })
    expect(kept.store.users()).toEqual([])
    const broken = await PresetStore.open({ io: memoryIO({ [PATH]: '{' }), path: PATH, now: () => NOW, seed })
    expect(broken.store.users()).toEqual([])
  })

  it('pins nine distinct built-in presets by default', () =>
  {
    const ids = Object.values(defaultPresetState().pins)
    expect(ids).toHaveLength(9)
    expect(new Set(ids).size).toBe(9)
    expect(ids.every((id) => findPreset(id)?.user === false)).toBe(true)
  })

  it('keeps the defaults in memory when the new file cannot be written', async () =>
  {
    const io = memoryIO()
    io.fail.write = new Error('disk full')
    const { store, load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load.error).toBe('disk full')
    expect(store.state().pins).toEqual(DEFAULT_PINS)
    expect(io.files.size).toBe(0)
  })

  it('reads user presets, pins, and recent recipes, and keeps an empty pin set empty', async () =>
  {
    const preset = { id: 'user-a', name: 'Phone video', recipe: recipe(), createdAt: 10, updatedAt: 20 }
    const io = memoryIO({ [PATH]: file({ user: [preset], pins: { '2': 'user-a' }, recent: [recipe('web-1080p')] }) })
    const { store, load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load).toMatchObject({ found: 'ok', dropped: 0, newer: null })
    expect(store.state()).toEqual({ user: [preset], pins: { '2': 'user-a' }, recent: [recipe('web-1080p')] })
    expect(store.users()).toEqual([preset])
    expect(io.writes).toEqual([])
    const empty = await PresetStore.open({ io: memoryIO({ [PATH]: file({}) }), path: PATH, now: () => NOW })
    expect(empty.store.state().pins).toEqual({})
  })

  it('drops invalid entries and counts them', async () =>
  {
    const good = { id: 'user-a', name: '  Phone video  ', recipe: { ...recipe(), userPreset: { id: 'user-z', name: 'Z' } } }
    const user = [
      good,
      { id: 'user-a', name: 'Same id', recipe: recipe(), createdAt: 1, updatedAt: 1 },
      { id: 'mp4-h264', name: 'Built-in id', recipe: recipe() },
      { id: 'custom', name: 'No prefix', recipe: recipe() },
      { id: 'user-b', name: '', recipe: recipe() },
      { id: 'user-c', name: 'x'.repeat(61), recipe: recipe() },
      { id: 'user-d', name: 'Bad recipe', recipe: { kind: 'convert' } },
      { id: 7, name: 'Bad id', recipe: recipe() },
      'not a preset'
    ]
    const pins = { '1': 'ebu-r128', '2': 'ebu-r128', '3': 'gone', '0': 'flac', '10': 'flac', '4': 7, '5': 'user-a' }
    const recent = [recipe('flac'), recipe('flac'), { kind: 'nope' }, ...['mp4-h264', 'web-1080p', 'audio-mp3-320', 'subs-srt', 'ebu-r128', 'spotify', 'gentle-lift', 'apple-podcasts'].map(recipe)]
    const { state, dropped } = readPresetFile({ schema: 1, user, pins, recent }, NOW)
    expect(state.user).toEqual([{ id: 'user-a', name: 'Phone video', recipe: { ...recipe(), userPreset: null }, createdAt: NOW, updatedAt: NOW }])
    expect(state.pins).toEqual({ '1': 'ebu-r128', '5': 'user-a' })
    expect(state.recent).toHaveLength(RECENT_LIMIT)
    expect(state.recent[0]).toEqual(recipe('flac'))
    expect(dropped).toBe(8 + 5 + 3)
  })

  it('reads a file with missing lists as empty', () =>
  {
    expect(readPresetFile({ schema: 1, user: 'x', pins: [], recent: null }, NOW)).toEqual({ state: { user: [], pins: {}, recent: [] }, dropped: 0 })
  })

  it('moves an unreadable file aside and starts from the defaults', async () =>
  {
    const io = memoryIO({ [PATH]: '{ not json' })
    const { store, load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    const aside = `C:/data/jobs/presets.corrupt-${NOW}.json`
    expect(load).toMatchObject({ found: 'corrupt', setAside: aside, error: null, path: PATH })
    expect(load.reason).not.toBeNull()
    expect(io.files.get(aside)).toBe('{ not json')
    expect(written(io)).toEqual({ schema: 1, user: [], pins: DEFAULT_PINS, recent: [] })
    expect(store.state().pins).toEqual(DEFAULT_PINS)
  })

  it('leaves an unreadable file alone when it cannot be moved aside', async () =>
  {
    const io = memoryIO({ [PATH]: JSON.stringify({ user: [] }) })
    io.fail.rename = new Error('locked')
    const { load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load).toMatchObject({ found: 'corrupt', setAside: null, error: 'locked' })
    expect(io.files.get(PATH)).toBe(JSON.stringify({ user: [] }))
    expect(io.writes).toEqual([])
  })

  it('leaves a newer version\'s file untouched and uses its own file beside it', async () =>
  {
    const newer = JSON.stringify({ schema: 2, user: [], pins: {}, recent: [] })
    const io = memoryIO({ [PATH]: newer })
    const { store, load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load).toMatchObject({ found: 'missing', newer: 2, path: SIDE })
    expect(store.path).toBe(SIDE)
    expect(io.files.get(PATH)).toBe(newer)
    expect(written(io, SIDE)).toEqual({ schema: 1, user: [], pins: DEFAULT_PINS, recent: [] })
    await store.setPin(1, 'flac')
    expect(io.files.get(PATH)).toBe(newer)
    expect((written(io, SIDE).pins as PresetState['pins'])['1']).toBe('flac')
    const again = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(again.load).toMatchObject({ found: 'ok', newer: 2, path: SIDE })
    expect(again.store.state().pins['1']).toBe('flac')
  })

  it('moves aside a file beside a newer one that is itself newer', async () =>
  {
    const io = memoryIO({ [PATH]: JSON.stringify({ schema: 3 }), [SIDE]: JSON.stringify({ schema: 2 }) })
    const { load } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    expect(load).toMatchObject({ found: 'corrupt', newer: 3, path: SIDE, setAside: `C:/data/jobs/presets.v1.corrupt-${NOW}.json` })
    expect(load.reason).toContain('newer version')
    expect(written(io, SIDE).pins).toEqual(DEFAULT_PINS)
  })

  it('names this version\'s file beside presets.json', () =>
  {
    expect(sidePath(PATH)).toBe(SIDE)
    expect(sidePath('presets')).toBe('presets.v1.json')
  })
})

describe('PresetStore.save', () =>
{
  it('saves a new user preset with a user id, a trimmed name, and a recipe that names no preset', async () =>
  {
    const { store, io, changes } = await open()
    const named = { ...recipe(), userPreset: { id: 'user-9', name: 'Old' } } as Recipe
    const result = await store.save({ id: null, name: '  Phone video ', recipe: named, pin: null })
    const preset = { id: 'user-1', name: 'Phone video', recipe: { ...recipe(), userPreset: null }, createdAt: NOW, updatedAt: NOW }
    expect(result).toEqual({ ok: true, value: { preset, unpinned: null } })
    expect(store.state().user).toEqual([preset])
    expect(store.state().pins).toEqual(DEFAULT_PINS)
    expect(io.writes).toEqual([PATH])
    expect(written(io).user).toEqual([preset])
    expect(changes).toEqual([store.state()])
  })

  it('pins a saved preset, unpinning the key\'s holder and leaving its own earlier key', async () =>
  {
    const { store } = await open()
    const first = await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: 5 })
    expect(first).toMatchObject({ ok: true, value: { unpinned: 'mp4-h264' } })
    expect(store.state().pins['5']).toBe('user-1')
    const moved = await store.save({ id: 'user-1', name: 'Phone video', recipe: recipe(), pin: 6 })
    expect(moved).toMatchObject({ ok: true, value: { unpinned: 'web-1080p' } })
    expect(store.state().pins['5']).toBeUndefined()
    expect(store.state().pins['6']).toBe('user-1')
    const same = await store.save({ id: 'user-1', name: 'Phone video', recipe: recipe(), pin: 6 })
    expect(same).toMatchObject({ ok: true, value: { unpinned: null } })
  })

  it('replaces an existing preset\'s name and recipe, keeps when it was created, and leaves pins on a null pin', async () =>
  {
    const { store, clock } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: 3 })
    clock.now = NOW + 500
    const result = await store.save({ id: 'user-1', name: 'Tablet video', recipe: recipe('web-1080p'), pin: null })
    expect(result).toEqual({
      ok: true,
      value: { preset: { id: 'user-1', name: 'Tablet video', recipe: recipe('web-1080p'), createdAt: NOW, updatedAt: NOW + 500 }, unpinned: null }
    })
    expect(store.state().user).toHaveLength(1)
    expect(store.state().pins['3']).toBe('user-1')
  })

  it('refuses names outside 1 to 60 characters', async () =>
  {
    const { store, io } = await open()
    for (const name of ['   ', 'x'.repeat(61)])
    {
      const result = await store.save({ id: null, name, recipe: recipe(), pin: null })
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid-payload', issues: [{ path: 'name' }] } })
    }
    expect((await store.save({ id: null, name: 'x'.repeat(60), recipe: recipe(), pin: null })).ok).toBe(true)
    expect(io.writes).toHaveLength(1)
  })

  it('refuses a name another preset of the same operation has, ignoring case', async () =>
  {
    const { store } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    expect(recipe('web-1080p').kind).not.toBe(recipe().kind)
    expect((await store.save({ id: null, name: 'Phone video', recipe: recipe('web-1080p'), pin: null })).ok).toBe(true)
    const taken = await store.save({ id: null, name: 'PHONE VIDEO', recipe: recipe(), pin: null })
    expect(taken).toMatchObject({ ok: false, error: { code: 'invalid-payload', message: 'Another preset for this operation is already named "PHONE VIDEO".', issues: [{ path: 'name' }] } })
    expect((await store.save({ id: null, name: 'Phone video', recipe: recipe('ebu-r128'), pin: null })).ok).toBe(true)
    expect((await store.save({ id: 'user-1', name: 'phone Video', recipe: recipe(), pin: null })).ok).toBe(true)
  })

  it('refuses an invalid recipe with its issues under recipe', async () =>
  {
    const { store } = await open()
    const result = await store.save({ id: null, name: 'Broken', recipe: { kind: 'convert' } as unknown as Recipe, pin: null })
    expect(result.ok).toBe(false)
    if (!result.ok)
    {
      expect(result.error.code).toBe('invalid-payload')
      expect(result.error.issues.length).toBeGreaterThan(0)
      expect(result.error.issues.every((issue) => issue.path === 'recipe' || issue.path.startsWith('recipe.'))).toBe(true)
    }
    const bare = await store.save({ id: null, name: 'Broken', recipe: 'x' as unknown as Recipe, pin: null })
    expect(bare).toMatchObject({ ok: false, error: { code: 'invalid-payload', issues: [{ path: 'recipe' }] } })
  })

  it('refuses a pin that is not a key from 1 to 9', async () =>
  {
    const { store } = await open()
    for (const pin of [0, 10, 1.5])
    {
      const result = await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin })
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid-payload', issues: [{ path: 'pin' }] } })
    }
  })

  it('refuses to change a built-in preset or one that is gone', async () =>
  {
    const { store } = await open()
    expect(await store.save({ id: 'mp4-h264', name: 'Mine', recipe: recipe(), pin: null }))
      .toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'Built-in presets cannot be changed.' } })
    expect(await store.save({ id: 'user-404', name: 'Mine', recipe: recipe(), pin: null }))
      .toMatchObject({ ok: false, error: { code: 'not-found', message: 'That preset no longer exists.' } })
  })

  it('gives random user ids by default', async () =>
  {
    const io = memoryIO()
    const { store } = await PresetStore.open({ io, path: PATH, now: () => NOW })
    const a = await store.save({ id: null, name: 'A', recipe: recipe(), pin: null })
    const b = await store.save({ id: null, name: 'B', recipe: recipe(), pin: null })
    expect(a.ok && a.value.preset.id.startsWith(USER_PRESET_PREFIX)).toBe(true)
    expect(a.ok && b.ok && a.value.preset.id !== b.value.preset.id).toBe(true)
  })
})

describe('PresetStore writes', () =>
{
  it('keeps the committed state and reports io-error when a write fails', async () =>
  {
    const { store, io, changes } = await open()
    io.fail.write = new Error('disk full')
    const result = await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: 1 })
    expect(result).toEqual({ ok: false, error: { code: 'io-error', message: 'molexMedia could not save the presets: disk full', issues: [], details: null } })
    expect(store.state()).toEqual({ user: [], pins: DEFAULT_PINS, recent: [] })
    expect(changes).toEqual([])
    io.fail.write = null
    expect((await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: 1 })).ok).toBe(true)
  })

  it('applies changes one at a time, each on the state the one before committed', async () =>
  {
    const { store, io } = await open()
    let release = (): void => undefined
    io.gate = new Promise<void>((resolve) =>
    {
      release = resolve
    })
    const first = store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    const second = store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    const third = store.setPin(9, 'user-1')
    release()
    expect((await first).ok).toBe(true)
    expect(await second).toMatchObject({ ok: false, error: { code: 'invalid-payload' } })
    expect(await third).toEqual({ ok: true, value: { unpinned: 'subs-srt' } })
    expect(store.state().pins['9']).toBe('user-1')
  })

  it('keeps working after a change throws', async () =>
  {
    const { store } = await open()
    await expect(store.save({ id: null, name: null as unknown as string, recipe: recipe(), pin: null })).rejects.toThrow()
    expect((await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })).ok).toBe(true)
  })

  it('hands out copies, so a caller cannot change the store', async () =>
  {
    const { store } = await open()
    const state = store.state()
    state.pins['1'] = 'flac'
    state.recent.push(recipe())
    expect(store.state()).toEqual({ user: [], pins: DEFAULT_PINS, recent: [] })
  })
})

describe('PresetStore.rename', () =>
{
  it('renames a user preset with a trimmed name', async () =>
  {
    const { store, io, clock } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    clock.now = NOW + 1
    const result = await store.rename('user-1', ' Tablet video ')
    expect(result).toEqual({ ok: true, value: { id: 'user-1', name: 'Tablet video', recipe: recipe(), createdAt: NOW, updatedAt: NOW + 1 } })
    expect((written(io).user as Array<{ name: string }>)[0].name).toBe('Tablet video')
  })

  it('writes nothing when the name is unchanged', async () =>
  {
    const { store, io, changes } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    const result = await store.rename('user-1', 'Phone video ')
    expect(result).toMatchObject({ ok: true, value: { name: 'Phone video', updatedAt: NOW } })
    expect(io.writes).toHaveLength(1)
    expect(changes).toHaveLength(1)
  })

  it('refuses a bad or taken name, a built-in preset, and one that is gone', async () =>
  {
    const { store } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    await store.save({ id: null, name: 'Tablet video', recipe: recipe(), pin: null })
    expect(await store.rename('user-1', '')).toMatchObject({ ok: false, error: { code: 'invalid-payload', issues: [{ path: 'name' }] } })
    expect(await store.rename('user-1', 'tablet video')).toMatchObject({ ok: false, error: { code: 'invalid-payload' } })
    expect(await store.rename('flac', 'Mine')).toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'Built-in presets cannot be renamed.' } })
    expect(await store.rename('user-404', 'Mine')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})

describe('PresetStore.remove', () =>
{
  it('removes a user preset and its pin, and keeps recent recipes that name it', async () =>
  {
    const { store, io } = await open()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: 4 })
    const applied = applyPreset('user-1', OUTPUT, store.users()) as Recipe
    await store.recordRecent([applied])
    expect(await store.remove('user-1')).toEqual({ ok: true, value: null })
    expect(store.state().user).toEqual([])
    expect(store.state().pins['4']).toBeUndefined()
    expect(store.state().pins['1']).toBe('ebu-r128')
    expect(store.state().recent).toEqual([applied])
    expect(written(io).user).toEqual([])
  })

  it('refuses a built-in preset and one that is gone', async () =>
  {
    const { store } = await open()
    expect(await store.remove('ebu-r128')).toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'Built-in presets cannot be removed.' } })
    expect(await store.remove('user-404')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})

describe('PresetStore.setPin', () =>
{
  it('pins any preset, built-in or user, with one key per preset', async () =>
  {
    const { store, io } = await open()
    expect(await store.setPin(1, 'flac')).toEqual({ ok: true, value: { unpinned: 'ebu-r128' } })
    expect(store.state().pins['1']).toBe('flac')
    expect(store.state().pins['8']).toBeUndefined()
    await store.save({ id: null, name: 'Phone video', recipe: recipe(), pin: null })
    expect(await store.setPin(8, 'user-1')).toEqual({ ok: true, value: { unpinned: null } })
    expect(store.state().pins['8']).toBe('user-1')
    expect((written(io).pins as PresetState['pins'])['8']).toBe('user-1')
  })

  it('clears a key and names the preset that held it', async () =>
  {
    const { store } = await open()
    expect(await store.setPin(2, null)).toEqual({ ok: true, value: { unpinned: 'apple-podcasts' } })
    expect(store.state().pins['2']).toBeUndefined()
  })

  it('writes nothing when the pin is already so', async () =>
  {
    const { store, io, changes } = await open()
    expect(await store.setPin(3, 'spotify')).toEqual({ ok: true, value: { unpinned: null } })
    await store.setPin(2, null)
    expect(await store.setPin(2, null)).toEqual({ ok: true, value: { unpinned: null } })
    expect(io.writes).toHaveLength(1)
    expect(changes).toHaveLength(1)
  })

  it('refuses a key outside 1 to 9, Custom, and an unknown preset', async () =>
  {
    const { store } = await open()
    expect(await store.setPin(0, 'flac')).toMatchObject({ ok: false, error: { code: 'invalid-payload', issues: [{ path: 'key' }] } })
    expect(await store.setPin(3, 'custom')).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(await store.setPin(3, 'user-404')).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})

describe('PresetStore.recordRecent', () =>
{
  it('keeps the latest distinct recipes first, at most eight', async () =>
  {
    const { store, io } = await open()
    const ids = ['mp4-h264', 'web-1080p', 'audio-mp3-320', 'flac', 'subs-srt', 'ebu-r128', 'spotify', 'gentle-lift', 'apple-podcasts']
    expect(await store.recordRecent(ids.map(recipe))).toEqual({ ok: true, value: true })
    expect(store.state().recent).toEqual(ids.slice(1).reverse().map(recipe))
    expect(await store.recordRecent([recipe('flac')])).toEqual({ ok: true, value: true })
    expect(store.state().recent[0]).toEqual(recipe('flac'))
    expect(store.state().recent).toHaveLength(RECENT_LIMIT)
    expect(written(io).recent).toEqual(store.state().recent)
  })

  it('writes nothing when the latest recipe is applied again, whatever its key order', async () =>
  {
    const { store, io } = await open()
    await store.recordRecent([recipe()])
    const reordered = Object.fromEntries(Object.entries(recipe()).reverse()) as unknown as Recipe
    expect(await store.recordRecent([reordered])).toEqual({ ok: true, value: false })
    expect(await store.recordRecent([])).toEqual({ ok: true, value: false })
    expect(io.writes).toHaveLength(1)
  })
})

describe('preset store helpers', () =>
{
  it('reads pin keys 1 to 9 only', () =>
  {
    expect(pinKey(1)).toBe('1')
    expect(pinKey(9)).toBe('9')
    expect(pinKey(0)).toBeNull()
    expect(pinKey(2.5)).toBeNull()
  })

  it('moves a pin and names the holder it unpinned', () =>
  {
    expect(pinTo({ '1': 'a', '2': 'b' }, '2', 'a')).toEqual({ pins: { '2': 'a' }, unpinned: 'b' })
    expect(pinTo({ '1': 'a' }, '3', null)).toEqual({ pins: { '1': 'a' }, unpinned: null })
  })

  it('copies recipes into the recent list', () =>
  {
    const applied = recipe()
    const [kept] = withRecent([], [applied])
    expect(kept).toEqual(applied)
    expect(kept).not.toBe(applied)
  })
})
