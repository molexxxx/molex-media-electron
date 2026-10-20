/**
 * The preset commands: save, rename, and remove user presets and move the pins 1 to 9, all kept by the preset store
 * in `presets.json`, plus the recent recipes recorded from assignments. A preset change never touches a job, because
 * every job holds a frozen copy of its recipe.
 */

import type { CommandResult, JobCommandMap } from '../../../shared/jobs/contract'
import type { Recipe } from '../../../shared/jobs/recipes'
import type { PresetState, RunAlert } from '../../../shared/jobs/types'
import type { EngineCore } from '../core'
import { PresetStore, type PresetLoad, type PresetResult, type PresetStoreDeps } from '../presets-store'

/** The preset command names. */
export type PresetCommandName = 'savePreset' | 'renamePreset' | 'removePreset' | 'setPin'

/** What the preset commands are built from. */
export interface PresetCommandsDeps
{
  core: Pick<EngineCore, 'bus' | 'log'>
  store: Pick<PresetStore, 'save' | 'rename' | 'remove' | 'setPin' | 'recordRecent'>
}

/** One handler per preset command, the recent-recipe hook for assignments, and a wait for its writes. */
export type PresetCommands =
  { [K in PresetCommandName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }
  & {
    /** Keeps recipes applied by `jobs:assignRecipe` and `jobs:duplicate`, in order; a failed write is only logged. */
    recordRecent(recipes: readonly Recipe[]): void
    /** Resolves once every recent-recipe write has settled. */
    settled(): Promise<void>
  }

/** The id of the alert a preset file problem raises. */
export const PRESETS_ALERT_ID = 'presets-load'

/** The banner for what opening `presets.json` found, or null when it was read or created cleanly. */
export function presetLoadAlert(load: PresetLoad, at: number): RunAlert | null
{
  const base = { id: PRESETS_ALERT_ID, kind: 'storage-error' as const, at, volume: null, jobIds: [], counts: null, dismissible: true }
  if (load.error !== null)
  {
    return { ...base, severity: 'error', path: load.setAside, message: `Presets could not be saved: ${load.error}. Changes to presets may not be kept.` }
  }
  if (load.found === 'corrupt')
  {
    return { ...base, severity: 'warning', path: load.setAside, message: 'Saved presets could not be read, so the built-in presets are in use. The unreadable file was set aside.' }
  }
  if (load.newer !== null)
  {
    return { ...base, severity: 'info', path: load.path, message: 'Presets were saved by a newer version of molexMedia. This version keeps its own presets file beside them.' }
  }
  return null
}

/**
 * Opens the preset store for the engine: every committed change reaches the snapshot and `presets.changed` through
 * the core, the loaded state is applied at once, and a file problem raises its banner.
 */
export async function openPresetStore(
  deps: Omit<PresetStoreDeps, 'onChange'> & { core: Pick<EngineCore, 'setPresets' | 'raiseAlert'> }
): Promise<{ store: PresetStore; load: PresetLoad }>
{
  const { core, ...storeDeps } = deps
  const opened = await PresetStore.open({ ...storeDeps, onChange: (state: PresetState) => core.setPresets(state) })
  core.setPresets(opened.store.state())
  const alert = presetLoadAlert(opened.load, deps.now())
  if (alert !== null)
  {
    core.raiseAlert(alert)
  }
  return opened
}

/** Builds the preset command handlers over the store. */
export function createPresetCommands(deps: PresetCommandsDeps): PresetCommands
{
  const { core, store } = deps
  const pending = new Set<Promise<void>>()

  function reply<T>(result: PresetResult<T>): CommandResult<T>
  {
    if (!result.ok)
    {
      return result
    }
    return { ok: true, value: result.value, seq: core.bus.flush() }
  }

  function recordRecent(recipes: readonly Recipe[]): void
  {
    if (recipes.length === 0)
    {
      return
    }
    const write = store.recordRecent(recipes).then(
      (result) =>
      {
        if (!result.ok)
        {
          core.log.warn(`Recent presets were not saved (${result.error.code}): ${result.error.message}`)
        }
      },
      (err: unknown) =>
      {
        core.log.warn(`Recent presets were not saved (io-error): ${err instanceof Error ? err.message : String(err)}`)
      }
    )
    pending.add(write)
    void write.finally(() => pending.delete(write))
  }

  return {
    savePreset: async (req) => reply(await store.save(req)),
    renamePreset: async (req) => reply(await store.rename(req.id, req.name)),
    removePreset: async (req) => reply(await store.remove(req.id)),
    setPin: async (req) => reply(await store.setPin(req.key, req.presetId)),
    recordRecent,
    settled: async () =>
    {
      while (pending.size > 0)
      {
        await Promise.all([...pending])
      }
    }
  }
}
