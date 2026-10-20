import { describe, it, expect, vi } from 'vitest'
import type { PersistenceIO } from '../../../src/main/jobs/deps'
import { PresetStore, withRecent, type PresetLoad } from '../../../src/main/jobs/presets-store'
import {
  PRESETS_ALERT_ID, createPresetCommands, openPresetStore, presetLoadAlert, type PresetCommandsDeps
} from '../../../src/main/jobs/commands/presets'
import { DEFAULT_PINS, applyPreset } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { PresetState, RunAlert } from '../../../src/shared/jobs/types'
import type { EncoderPolicy } from '../../../src/shared/audio/types'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy
const PATH = 'C:/data/jobs/presets.json'
const NOW = 1_700_000_000_000

function recipe(id = 'ebu-r128'): Recipe
{
  return applyPreset(id, OUTPUT) as Recipe
}

interface MemoryIO extends PersistenceIO
{
  files: Map<string, string>
  failWrite: Error | null
}

function memoryIO(initial: Record<string, string> = {}): MemoryIO
{
  const files = new Map(Object.entries(initial))
  const io: MemoryIO =
  {
    files,
    failWrite: null,
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
      if (io.failWrite !== null)
      {
        throw io.failWrite
      }
      files.set(path, text)
    },
    read: async (path) => files.get(path) ?? null,
    list: async () => [...files.keys()],
    rename: async (from, to) =>
    {
      const text = files.get(from)
      if (text !== undefined)
      {
        files.set(to, text)
        files.delete(from)
      }
    },
    unlink: async (path) =>
    {
      files.delete(path)
    },
    mkdir: async () => undefined
  }
  return io
}

interface FakeCore
{
  bus: { flush(): number }
  log: { warn: ReturnType<typeof vi.fn>; debug(): void; info(): void; error(): void; ffmpeg(): void; child(): unknown }
  seq: number
}

function fakeCore(): FakeCore
{
  const core: FakeCore =
  {
    seq: 0,
    bus: { flush: () => ++core.seq },
    log: { warn: vi.fn(), debug: () => undefined, info: () => undefined, error: () => undefined, ffmpeg: () => undefined, child: () => core.log }
  }
  return core
}

async function setup(io = memoryIO()): Promise<{ io: MemoryIO; store: PresetStore; core: FakeCore; commands: ReturnType<typeof createPresetCommands>; changes: PresetState[] }>
{
  const changes: PresetState[] = []
  let n = 0
  const { store } = await PresetStore.open({ io, path: PATH, now: () => NOW, onChange: (state) => changes.push(state), newId: () => `user-${++n}` })
  const core = fakeCore()
  const commands = createPresetCommands({ core: core as unknown as PresetCommandsDeps['core'], store })
  return { io, store, core, commands, changes }
}

function errorOf<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): { code: string; message: string }
{
  if (result.ok)
  {
    throw new Error('expected a refusal')
  }
  return result.error
}

describe('savePreset', () =>
{
  it('saves a user preset, replies with the seq of its events, and reports the change', async () =>
  {
    const { commands, store, changes } = await setup()
    const result = await commands.savePreset({ id: null, name: '  Late podcasts  ', recipe: recipe(), pin: null })
    expect(result.ok).toBe(true)
    if (!result.ok)
    {
      return
    }
    expect(result.seq).toBe(1)
    expect(result.value.preset).toMatchObject({ id: 'user-1', name: 'Late podcasts', createdAt: NOW, updatedAt: NOW })
    expect(result.value.unpinned).toBeNull()
    expect(store.users().map((p) => p.name)).toEqual(['Late podcasts'])
    expect(changes).toHaveLength(1)
  })

  it('accepts names of 1 and 60 characters and refuses empty and longer names', async () =>
  {
    const { commands } = await setup()
    expect((await commands.savePreset({ id: null, name: 'A', recipe: recipe(), pin: null })).ok).toBe(true)
    expect((await commands.savePreset({ id: null, name: 'b'.repeat(60), recipe: recipe(), pin: null })).ok).toBe(true)
    expect(errorOf(await commands.savePreset({ id: null, name: '   ', recipe: recipe(), pin: null })).code).toBe('invalid-payload')
    expect(errorOf(await commands.savePreset({ id: null, name: 'c'.repeat(61), recipe: recipe(), pin: null })).code).toBe('invalid-payload')
  })

  it('keeps names unique per operation', async () =>
  {
    const { commands, store } = await setup()
    await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe('ebu-r128'), pin: null })
    const clash = errorOf(await commands.savePreset({ id: null, name: 'late podcasts', recipe: recipe('spotify'), pin: null }))
    expect(clash.code).toBe('invalid-payload')
    expect(clash.message).toContain('already named')
    const otherOp = await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe('mp4-h264'), pin: null })
    expect(otherOp.ok).toBe(true)
    expect(store.users()).toHaveLength(2)
  })

  it('updates a preset in place under its own name', async () =>
  {
    const { commands, store } = await setup()
    const first = await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe('ebu-r128'), pin: null })
    const id = first.ok ? first.value.preset.id : ''
    const updated = await commands.savePreset({ id, name: 'Late podcasts', recipe: recipe('spotify'), pin: null })
    expect(updated.ok).toBe(true)
    expect(store.users()).toHaveLength(1)
    expect(store.users()[0].recipe).toMatchObject({ kind: 'normalize' })
  })

  it('moves a pin from its holder and names the preset it unpinned', async () =>
  {
    const { commands, store } = await setup()
    const result = await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe(), pin: 4 })
    expect(result.ok && result.value.unpinned).toBe(DEFAULT_PINS['4'])
    expect(store.state().pins['4']).toBe('user-1')
  })

  it('refuses a pin key outside 1 to 9', async () =>
  {
    const { commands } = await setup()
    expect(errorOf(await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe(), pin: 10 })).code).toBe('invalid-payload')
  })
})

describe('renamePreset', () =>
{
  it('renames a user preset and refuses a clash or a built-in preset', async () =>
  {
    const { commands } = await setup()
    await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe(), pin: null })
    await commands.savePreset({ id: null, name: 'Morning show', recipe: recipe(), pin: null })
    const renamed = await commands.renamePreset({ id: 'user-1', name: 'Night podcasts' })
    expect(renamed.ok && renamed.value.name).toBe('Night podcasts')
    expect(errorOf(await commands.renamePreset({ id: 'user-2', name: 'Night podcasts' })).message).toContain('already named')
    expect(errorOf(await commands.renamePreset({ id: 'ebu-r128', name: 'Mine' })).code).not.toBe('internal')
  })
})

describe('removePreset', () =>
{
  it('removes a user preset and refuses an unknown one', async () =>
  {
    const { commands, store } = await setup()
    await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe(), pin: 3 })
    const removed = await commands.removePreset({ id: 'user-1' })
    expect(removed.ok && removed.value).toBeNull()
    expect(store.users()).toEqual([])
    expect(store.state().pins['3']).not.toBe('user-1')
    expect(errorOf(await commands.removePreset({ id: 'user-9' })).code).toBe('not-found')
  })
})

describe('setPin', () =>
{
  it('moves a pin to another key and unpins the holder of the new key', async () =>
  {
    const { commands, store } = await setup()
    await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe(), pin: 2 })
    const moved = await commands.setPin({ key: 5, presetId: 'user-1' })
    expect(moved.ok && moved.value.unpinned).toBe(DEFAULT_PINS['5'])
    expect(store.state().pins['5']).toBe('user-1')
    expect(store.state().pins['2']).toBeUndefined()
  })

  it('pins a built-in preset, clears a key, and refuses a bad key', async () =>
  {
    const { commands, store } = await setup()
    const pinned = await commands.setPin({ key: 1, presetId: 'spotify' })
    expect(pinned.ok && pinned.value.unpinned).toBe(DEFAULT_PINS['1'])
    const cleared = await commands.setPin({ key: 1, presetId: null })
    expect(cleared.ok && cleared.value.unpinned).toBe('spotify')
    expect(store.state().pins['1']).toBeUndefined()
    expect(errorOf(await commands.setPin({ key: 0, presetId: null })).code).toBe('invalid-payload')
  })
})

describe('preset changes and jobs', () =>
{
  it('never reaches a job when a preset is updated or removed', async () =>
  {
    const io = memoryIO()
    const { store } = await PresetStore.open({ io, path: PATH, now: () => NOW, newId: () => 'user-1' })
    const touched: string[] = []
    const core = new Proxy(fakeCore(), {
      get(target, key)
      {
        touched.push(String(key))
        return target[key as keyof FakeCore]
      }
    })
    const commands = createPresetCommands({ core: core as unknown as PresetCommandsDeps['core'], store })
    const saved = await commands.savePreset({ id: null, name: 'Late podcasts', recipe: recipe('ebu-r128'), pin: null })
    const preset = saved.ok ? saved.value.preset : null
    const jobRecipe = structuredClone({ ...preset!.recipe, userPreset: { id: preset!.id, name: preset!.name } }) as Recipe
    const before = structuredClone(jobRecipe)
    await commands.savePreset({ id: 'user-1', name: 'Late podcasts', recipe: recipe('spotify'), pin: null })
    await commands.removePreset({ id: 'user-1' })
    expect(jobRecipe).toEqual(before)
    expect([...new Set(touched)]).toEqual(['bus'])
  })
})

describe('recordRecent', () =>
{
  it('keeps the recipes assignments applied, newest first and distinct', async () =>
  {
    const { commands, store } = await setup()
    commands.recordRecent([recipe('ebu-r128'), recipe('spotify')])
    commands.recordRecent([recipe('ebu-r128')])
    await commands.settled()
    const recent = store.state().recent
    expect(recent).toHaveLength(2)
    expect(recent).toEqual(withRecent(withRecent([], [recipe('ebu-r128'), recipe('spotify')]), [recipe('ebu-r128')]))
  })

  it('writes nothing for an empty assignment', async () =>
  {
    const { commands, changes } = await setup()
    commands.recordRecent([])
    await commands.settled()
    expect(changes).toEqual([])
  })

  it('logs a failed write and never throws', async () =>
  {
    const { commands, core, io } = await setup()
    io.failWrite = new Error('disk full')
    commands.recordRecent([recipe()])
    await commands.settled()
    expect(core.log.warn).toHaveBeenCalledWith(expect.stringContaining('io-error'))
  })

  it('logs a store that rejects', async () =>
  {
    const core = fakeCore()
    const store = { recordRecent: () => Promise.reject(new Error('gone')) } as unknown as PresetCommandsDeps['store']
    const commands = createPresetCommands({ core: core as unknown as PresetCommandsDeps['core'], store })
    commands.recordRecent([recipe()])
    await commands.settled()
    expect(core.log.warn).toHaveBeenCalledWith(expect.stringContaining('gone'))
    const other = createPresetCommands({ core: core as unknown as PresetCommandsDeps['core'], store: { recordRecent: () => Promise.reject('plain') } as unknown as PresetCommandsDeps['store'] })
    other.recordRecent([recipe()])
    await other.settled()
    expect(core.log.warn).toHaveBeenCalledWith(expect.stringContaining('plain'))
  })
})

describe('openPresetStore', () =>
{
  function alertCore(): { setPresets: ReturnType<typeof vi.fn>; raiseAlert: ReturnType<typeof vi.fn> }
  {
    return { setPresets: vi.fn(), raiseAlert: vi.fn() }
  }

  it('applies the loaded presets and forwards every change to the core', async () =>
  {
    const core = alertCore()
    const { store, load } = await openPresetStore({ io: memoryIO(), path: PATH, now: () => NOW, newId: () => 'user-1', core })
    expect(load.found).toBe('missing')
    expect(core.setPresets).toHaveBeenCalledTimes(1)
    expect(core.setPresets.mock.calls[0][0].pins).toEqual(DEFAULT_PINS)
    expect(core.raiseAlert).not.toHaveBeenCalled()
    await store.save({ id: null, name: 'Late podcasts', recipe: recipe(), pin: null })
    expect(core.setPresets).toHaveBeenCalledTimes(2)
    expect(core.setPresets.mock.calls[1][0].user[0].name).toBe('Late podcasts')
  })

  it('raises a banner with the set-aside file when presets.json cannot be read', async () =>
  {
    const core = alertCore()
    const { load } = await openPresetStore({ io: memoryIO({ [PATH]: 'not json' }), path: PATH, now: () => NOW, core })
    expect(load.found).toBe('corrupt')
    const alert = core.raiseAlert.mock.calls[0][0] as RunAlert
    expect(alert).toMatchObject({ id: PRESETS_ALERT_ID, kind: 'storage-error', severity: 'warning', path: load.setAside, dismissible: true })
  })
})

describe('presetLoadAlert', () =>
{
  const clean: PresetLoad = { found: 'ok', newer: null, path: PATH, dropped: 0, reason: null, setAside: null, error: null }

  it('is null for a clean load', () =>
  {
    expect(presetLoadAlert(clean, NOW)).toBeNull()
    expect(presetLoadAlert({ ...clean, found: 'missing' }, NOW)).toBeNull()
  })

  it('reports a newer file and a write error', () =>
  {
    expect(presetLoadAlert({ ...clean, newer: 3, path: 'C:/data/jobs/presets.v1.json' }, NOW)).toMatchObject({ severity: 'info', path: 'C:/data/jobs/presets.v1.json', at: NOW })
    const failed = presetLoadAlert({ ...clean, found: 'corrupt', error: 'access denied' }, NOW)
    expect(failed).toMatchObject({ severity: 'error' })
    expect(failed?.message).toContain('access denied')
  })
})
