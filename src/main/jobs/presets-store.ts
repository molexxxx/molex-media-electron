/**
 * User presets, the pinned keys 1 to 9, and the last eight distinct recipes applied to jobs, kept in
 * `presets.json` apart from the app config so a Settings save never overwrites them. Each change is computed from
 * the committed state, written atomically through PersistenceIO, and committed only once the write succeeded, one
 * change at a time.
 */
import { randomUUID } from 'node:crypto'
import type { CommandError, CommandErrorCode, CommandIssue } from '../../shared/jobs/contract'
import { BUILTIN_PRESETS, DEFAULT_PINS, findPreset } from '../../shared/jobs/presets'
import type { Recipe } from '../../shared/jobs/recipes'
import type { PresetState, UserPreset } from '../../shared/jobs/types'
import { PIN_KEYS, PRESET_NAME_LENGTH, validateRecipe } from '../../shared/jobs/validate'
import type { PersistenceIO } from './deps'
import { PERSISTENCE_SCHEMA, PRESETS_MIGRATIONS, readVersioned, writeVersioned, type VersionedRead } from './persistence'
import { canonicalJson } from './queue'

/** How many distinct recently applied recipes are kept. */
export const RECENT_LIMIT = 8

/** The prefix of every user preset id, so a user preset id never equals a built-in one. */
export const USER_PRESET_PREFIX = 'user-'

/** A pinned key. */
export type PinKey = keyof PresetState['pins']

/** The pinned keys in order. */
export const PIN_KEY_LIST: readonly PinKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** What the store needs from the engine. */
export interface PresetStoreDeps
{
  io: PersistenceIO
  /** `presets.json`, as `jobsPaths(dir).presets` gives it. */
  path: string
  /** Milliseconds since the Unix epoch. */
  now(): number
  /** Called after every committed change with the new state, for `presets.changed`. */
  onChange?: (state: PresetState) => void
  /** A new user preset id with the user prefix; random by default. */
  newId?: () => string
  /** User presets a new store starts with, such as the one an upgrade makes from the old global settings. */
  seed?: readonly UserPreset[]
}

/** A store reply: the value, or the refusal the command returns. */
export type PresetResult<T> = { ok: true; value: T } | { ok: false; error: CommandError }

/** What `open` found and did. */
export interface PresetLoad
{
  /** Presets read, no file (a new install, given the nine default pins), or a file that could not be read. */
  found: 'ok' | 'missing' | 'corrupt'
  /** The schema of a newer version's `presets.json`, left untouched while this version uses its own file. */
  newer: number | null
  /** The file this session reads and writes. */
  path: string
  /** Presets, pins, and recent recipes dropped because they were invalid or named a preset that is gone. */
  dropped: number
  /** Why the file could not be read, or null. */
  reason: string | null
  /** Where an unreadable file was moved, or null. */
  setAside: string | null
  /** Why the file could not be set aside or written, or null. */
  error: string | null
}

type Computed<T> = { ok: true; next: PresetState | null; value: T } | { ok: false; error: CommandError }

const NAME_MESSAGE = `Must be a name of ${PRESET_NAME_LENGTH.min} to ${PRESET_NAME_LENGTH.max} characters.`
const PIN_MESSAGE = `Must be a whole number from ${PIN_KEYS.min} to ${PIN_KEYS.max}.`
const GONE_MESSAGE = 'That preset no longer exists.'

function refuse(code: CommandErrorCode, message: string, issues: CommandIssue[] = []): { ok: false; error: CommandError }
{
  return { ok: false, error: { code, message, issues, details: null } }
}

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBuiltin(id: string): boolean
{
  return BUILTIN_PRESETS.some((entry) => entry.id === id)
}

function nameFits(name: string): boolean
{
  return name.length >= PRESET_NAME_LENGTH.min && name.length <= PRESET_NAME_LENGTH.max
}

/** The key for a pin number, or null when it is not a whole number from 1 to 9. */
export function pinKey(key: number): PinKey | null
{
  return Number.isInteger(key) && key >= PIN_KEYS.min && key <= PIN_KEYS.max ? String(key) as PinKey : null
}

/** The new-install state: no user presets, the nine default pins, and no recent recipes. */
export function defaultPresetState(): PresetState
{
  return { user: [], pins: { ...DEFAULT_PINS }, recent: [] }
}

/** `presets.v1.json` beside `presets.json`: this version's file while a newer version's file is left untouched. */
export function sidePath(path: string): string
{
  return `${path.replace(/\.json$/i, '')}.v${PERSISTENCE_SCHEMA}.json`
}

/**
 * Pins `id` to `key`, or clears the key when `id` is null. One key per preset: the preset leaves any other key, and
 * the key's earlier holder is unpinned and named.
 */
export function pinTo(pins: PresetState['pins'], key: PinKey, id: string | null): { pins: PresetState['pins']; unpinned: string | null }
{
  const holder = pins[key] ?? null
  const next: PresetState['pins'] = {}
  for (const other of PIN_KEY_LIST)
  {
    const value = pins[other]
    if (value !== undefined && other !== key && value !== id)
    {
      next[other] = value
    }
  }
  if (id !== null)
  {
    next[key] = id
  }
  return { pins: next, unpinned: holder !== null && holder !== id ? holder : null }
}

/** The recent recipes with `applied` added, latest first, distinct by value, and at most eight. */
export function withRecent(recent: readonly Recipe[], applied: readonly Recipe[]): Recipe[]
{
  let next = [...recent]
  for (const recipe of applied)
  {
    const text = canonicalJson(recipe)
    next = [structuredClone(recipe), ...next.filter((entry) => canonicalJson(entry) !== text)]
  }
  return next.slice(0, RECENT_LIMIT)
}

function stamp(value: unknown, fallback: number): number
{
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function readUserPreset(entry: unknown, kept: readonly UserPreset[], now: number): UserPreset | null
{
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string')
  {
    return null
  }
  const id = entry.id
  const name = entry.name.trim()
  if (!id.startsWith(USER_PRESET_PREFIX) || isBuiltin(id) || kept.some((preset) => preset.id === id) || !nameFits(name))
  {
    return null
  }
  const checked = validateRecipe(entry.recipe)
  if (!checked.ok)
  {
    return null
  }
  return { id, name, recipe: { ...checked.value, userPreset: null }, createdAt: stamp(entry.createdAt, now), updatedAt: stamp(entry.updatedAt, now) }
}

/**
 * The state a migrated `presets.json` holds. Invalid entries are dropped and counted: user presets that fail
 * validation or repeat an id, pins on unknown keys or on presets that are gone or already pinned, and recent recipes
 * that fail validation, repeat, or exceed eight.
 */
export function readPresetFile(file: Record<string, unknown>, now: number): { state: PresetState; dropped: number }
{
  let dropped = 0
  const user: UserPreset[] = []
  for (const entry of Array.isArray(file.user) ? file.user : [])
  {
    const preset = readUserPreset(entry, user, now)
    if (preset === null)
    {
      dropped += 1
    }
    else
    {
      user.push(preset)
    }
  }
  const pins: PresetState['pins'] = {}
  const stored = isRecord(file.pins) ? file.pins : {}
  const pinned = new Set<string>()
  for (const [key, value] of Object.entries(stored))
  {
    const known = PIN_KEY_LIST.includes(key as PinKey) && typeof value === 'string' && findPreset(value, user) !== null
    if (known && !pinned.has(value))
    {
      pins[key as PinKey] = value
      pinned.add(value)
    }
    else
    {
      dropped += 1
    }
  }
  const recent: Recipe[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(file.recent) ? file.recent : [])
  {
    const checked = validateRecipe(entry)
    const text = checked.ok ? canonicalJson(checked.value) : ''
    if (checked.ok && !seen.has(text) && recent.length < RECENT_LIMIT)
    {
      recent.push(checked.value)
      seen.add(text)
    }
    else
    {
      dropped += 1
    }
  }
  return { state: { user, pins, recent }, dropped }
}

function findUser(state: PresetState, id: string, verb: string): { ok: true; preset: UserPreset } | { ok: false; error: CommandError }
{
  const preset = state.user.find((entry) => entry.id === id)
  if (preset !== undefined)
  {
    return { ok: true, preset }
  }
  return isBuiltin(id) ? refuse('invalid-state', `Built-in presets cannot be ${verb}.`) : refuse('not-found', GONE_MESSAGE)
}

function nameInUse(user: readonly UserPreset[], name: string, kind: Recipe['kind'], except: string | null): boolean
{
  const folded = name.toLowerCase()
  return user.some((entry) => entry.id !== except && entry.recipe.kind === kind && entry.name.toLowerCase() === folded)
}

function badName(): { ok: false; error: CommandError }
{
  return refuse('invalid-payload', NAME_MESSAGE, [{ path: 'name', message: NAME_MESSAGE }])
}

function takenName(name: string): { ok: false; error: CommandError }
{
  const message = `Another preset for this operation is already named "${name}".`
  return refuse('invalid-payload', message, [{ path: 'name', message }])
}

/** User presets, pins, and recent recipes, read from and written to `presets.json`. */
export class PresetStore
{
  private readonly deps: PresetStoreDeps
  private readonly target: string
  private current: PresetState
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(deps: PresetStoreDeps, target: string, state: PresetState)
  {
    this.deps = deps
    this.target = target
    this.current = state
  }

  /**
   * Reads `presets.json`, migrated, and returns the ready store with what was found. A missing file is a new
   * install, written with the nine default pins and the seed presets. An unreadable file is moved aside and replaced by the defaults. A
   * newer version's file is left untouched while this version reads and writes `presets.v1.json` beside it.
   */
  static async open(deps: PresetStoreDeps): Promise<{ store: PresetStore; load: PresetLoad }>
  {
    const now = deps.now()
    let path = deps.path
    let newer: number | null = null
    let read: VersionedRead = await readVersioned(deps.io, path, PRESETS_MIGRATIONS)
    if (read.status === 'newer')
    {
      newer = read.schema
      path = sidePath(deps.path)
      read = await readVersioned(deps.io, path, PRESETS_MIGRATIONS)
      if (read.status === 'newer')
      {
        read = { status: 'corrupt', reason: `written by a newer version (schema ${read.schema})` }
      }
    }
    const load: PresetLoad = { found: 'missing', newer, path, dropped: 0, reason: null, setAside: null, error: null }
    if (read.status === 'ok')
    {
      const { state, dropped } = readPresetFile(read.value, now)
      return { store: new PresetStore(deps, path, state), load: { ...load, found: 'ok', dropped } }
    }
    const initial = defaultPresetState()
    const store = new PresetStore(deps, path, read.status === 'missing' ? { ...initial, user: [...initial.user, ...structuredClone(deps.seed ?? [])] } : initial)
    if (read.status === 'corrupt')
    {
      load.found = 'corrupt'
      load.reason = read.reason
      const aside = `${path.replace(/\.json$/i, '')}.corrupt-${now}.json`
      try
      {
        await deps.io.rename(path, aside)
        load.setAside = aside
      }
      catch (err)
      {
        load.error = messageOf(err)
        return { store, load }
      }
    }
    try
    {
      await writeVersioned(deps.io, path, store.current)
    }
    catch (err)
    {
      load.error = messageOf(err)
    }
    return { store, load }
  }

  /** The file this session reads and writes. */
  get path(): string
  {
    return this.target
  }

  /** A copy of the state, for the snapshot and `presets.changed`. */
  state(): PresetState
  {
    return structuredClone(this.current)
  }

  /** The user presets, for preset lookups in main; replaced on every change, never changed in place. */
  users(): readonly UserPreset[]
  {
    return this.current.user
  }

  /**
   * Saves a new user preset (`id` null) or replaces an existing one's name and recipe, and pins it to `pin` when one
   * is given; a null pin leaves the pins as they are. Names are trimmed, 1 to 60 characters, and unique among the user
   * presets of the recipe's operation, ignoring case. The stored recipe names no preset. Built-in presets cannot be
   * changed.
   */
  save(request: { id: string | null; name: string; recipe: Recipe; pin: number | null }): Promise<PresetResult<{ preset: UserPreset; unpinned: string | null }>>
  {
    return this.change((state) =>
    {
      const name = request.name.trim()
      if (!nameFits(name))
      {
        return badName()
      }
      const checked = validateRecipe(request.recipe)
      if (!checked.ok)
      {
        const issues = checked.issues.map((issue) => ({ path: issue.path ? `recipe.${issue.path}` : 'recipe', message: issue.message }))
        return refuse('invalid-payload', 'The recipe is not valid.', issues)
      }
      const key = request.pin === null ? null : pinKey(request.pin)
      if (request.pin !== null && key === null)
      {
        return refuse('invalid-payload', PIN_MESSAGE, [{ path: 'pin', message: PIN_MESSAGE }])
      }
      let existing: UserPreset | null = null
      if (request.id !== null)
      {
        const found = findUser(state, request.id, 'changed')
        if (!found.ok)
        {
          return found
        }
        existing = found.preset
      }
      const recipe = { ...checked.value, userPreset: null } as Recipe
      if (nameInUse(state.user, name, recipe.kind, existing?.id ?? null))
      {
        return takenName(name)
      }
      const now = this.deps.now()
      const preset: UserPreset = existing === null
        ? { id: this.newId(), name, recipe, createdAt: now, updatedAt: now }
        : { ...existing, name, recipe, updatedAt: now }
      const user = existing === null ? [...state.user, preset] : state.user.map((entry) => (entry.id === preset.id ? preset : entry))
      const pinned = key === null ? { pins: state.pins, unpinned: null } : pinTo(state.pins, key, preset.id)
      return { ok: true, next: { ...state, user, pins: pinned.pins }, value: { preset: structuredClone(preset), unpinned: pinned.unpinned } }
    })
  }

  /** Renames a user preset under the name rules of `save`; built-in presets cannot be renamed. */
  rename(id: string, name: string): Promise<PresetResult<UserPreset>>
  {
    return this.change((state) =>
    {
      const trimmed = name.trim()
      if (!nameFits(trimmed))
      {
        return badName()
      }
      const found = findUser(state, id, 'renamed')
      if (!found.ok)
      {
        return found
      }
      if (nameInUse(state.user, trimmed, found.preset.recipe.kind, id))
      {
        return takenName(trimmed)
      }
      if (found.preset.name === trimmed)
      {
        return { ok: true, next: null, value: structuredClone(found.preset) }
      }
      const preset: UserPreset = { ...found.preset, name: trimmed, updatedAt: this.deps.now() }
      return { ok: true, next: { ...state, user: state.user.map((entry) => (entry.id === id ? preset : entry)) }, value: structuredClone(preset) }
    })
  }

  /** Removes a user preset and any pin on it; jobs and recent recipes keep their frozen copies of its recipe. */
  remove(id: string): Promise<PresetResult<null>>
  {
    return this.change((state) =>
    {
      const found = findUser(state, id, 'removed')
      if (!found.ok)
      {
        return found
      }
      const pins: PresetState['pins'] = {}
      for (const key of PIN_KEY_LIST)
      {
        const value = state.pins[key]
        if (value !== undefined && value !== id)
        {
          pins[key] = value
        }
      }
      return { ok: true, next: { ...state, user: state.user.filter((entry) => entry.id !== id), pins }, value: null }
    })
  }

  /**
   * Pins a built-in or user preset to a key 1 to 9, or clears the key when `presetId` is null. Moving a pin unpins
   * its holder, named in `unpinned`. Custom names no preset, so it cannot be pinned.
   */
  setPin(key: number, presetId: string | null): Promise<PresetResult<{ unpinned: string | null }>>
  {
    return this.change((state) =>
    {
      const pin = pinKey(key)
      if (pin === null)
      {
        return refuse('invalid-payload', PIN_MESSAGE, [{ path: 'key', message: PIN_MESSAGE }])
      }
      if (presetId !== null && findPreset(presetId, state.user) === null)
      {
        return refuse('not-found', GONE_MESSAGE)
      }
      const pinned = pinTo(state.pins, pin, presetId)
      const changed = canonicalJson(pinned.pins) !== canonicalJson(state.pins)
      return { ok: true, next: changed ? { ...state, pins: pinned.pins } : null, value: { unpinned: pinned.unpinned } }
    })
  }

  /**
   * Records recipes applied through `jobs:assignRecipe` and `jobs:duplicate`, in the order applied, as the recent
   * recipes; `value` says whether the list changed.
   */
  recordRecent(recipes: readonly Recipe[]): Promise<PresetResult<boolean>>
  {
    return this.change((state) =>
    {
      const recent = withRecent(state.recent, recipes)
      const changed = canonicalJson(recent) !== canonicalJson(state.recent)
      return { ok: true, next: changed ? { ...state, recent } : null, value: changed }
    })
  }

  private newId(): string
  {
    return this.deps.newId?.() ?? `${USER_PRESET_PREFIX}${randomUUID()}`
  }

  private change<T>(compute: (state: PresetState) => Computed<T>): Promise<PresetResult<T>>
  {
    const run = async (): Promise<PresetResult<T>> =>
    {
      const computed = compute(this.current)
      if (!computed.ok)
      {
        return computed
      }
      if (computed.next === null)
      {
        return { ok: true, value: computed.value }
      }
      try
      {
        await writeVersioned(this.deps.io, this.target, computed.next)
      }
      catch (err)
      {
        return refuse('io-error', `molexMedia could not save the presets: ${messageOf(err)}`)
      }
      this.current = computed.next
      this.deps.onChange?.(this.state())
      return { ok: true, value: computed.value }
    }
    const result = this.tail.then(run)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
