/**
 * The Presets section of Settings: the user's presets by operation with their values in plain words, Rename and
 * Delete, the pinned keys 1 to 9, and the built-in presets, read-only, each loudness preset with its standard and
 * sources. Every change goes through the job engine's preset commands; the list follows its presets.changed events.
 */
import { useId, useRef, useState, type ReactElement } from 'react'
import { GAIN_PRESETS, LOUDNESS_PRESETS, type LoudnessPreset } from '../../../../../shared/audio/presets'
import type { JobsApi } from '../../../../../shared/jobs/contract'
import { describeRecipe, operationLabel } from '../../../../../shared/jobs/describe'
import
{
  BUILTIN_PRESETS,
  EARLIER_DEFAULT_PRESET,
  MEDIA_CATALOGS,
  PRESET_GROUPS,
  USER_PRESET_GROUP,
  type BuiltinPreset
} from '../../../../../shared/jobs/presets'
import { OPERATIONS, type Operation, type Recipe } from '../../../../../shared/jobs/recipes'
import type { PresetState, UserPreset } from '../../../../../shared/jobs/types'
import { PART_SEPARATOR, formatTarget, formatTruePeak, keys } from '../../../copy/batch'
import { useJobsStore } from '../../../stores/jobs'
import { Button } from '../../../ui/Button'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import { Kbd, usePlatform } from '../../../ui/Kbd'
import { FieldMessage } from '../../../ui/NumberField'
import type { Platform } from '../../../../../shared/text/platform'
import { SegmentedControl } from '../../../ui/SegmentedControl'
import { Select, type SelectGroup, type SelectOption } from '../../../ui/Select'
import { StandardLine } from '../../batch/inspector/StandardLine'
import { NO_PIN, PIN_KEYS, pinOf, presetNameError, type PinKey } from '../../batch/inspector/SavePresetRow'

/** The words of the Presets section. */
export const PRESET_WORDS = {
  yours: 'Your presets',
  yoursIntro: 'Presets you saved from the Batch inspector. Rename or delete them here; applying one to jobs happens in Batch.',
  empty: 'You have no presets of your own yet.',
  emptyHow: 'In Batch, select jobs, adjust their settings in the inspector, then choose Save as preset from the preset menu.',
  earlierDefault: 'Carried over from the loudness and codec settings of an earlier version.',
  loading: 'Presets appear when the job engine connects.',
  rename: 'Rename',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Delete',
  keep: 'Keep',
  nameLabel: 'Preset name',
  pins: 'Pinned keys',
  noPin: 'None',
  builtIn: 'Built-in presets',
  builtInIntro: 'Built-in presets are read-only. To start from one, apply it in Batch, change its settings in the inspector, and save it as a preset of your own.',
  operation: 'Operation',
  notStandard: 'Not a standard'
} as const

/** The engine's jobs surface from the preload, or null while there is none. */
export function windowJobs(): JobsApi | null
{
  const api = (window as unknown as { api?: { jobs?: JobsApi } }).api
  return api?.jobs ?? null
}

/** The user's presets grouped by operation, in operation order, each group sorted by name; empty groups left out. */
export function presetsByOperation(users: readonly UserPreset[]): Array<{ op: Operation; presets: UserPreset[] }>
{
  return OPERATIONS
    .map((op) => ({ op, presets: users.filter((preset) => preset.recipe.kind === op).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((group) => group.presets.length > 0)
}

/** The question Delete asks, naming the key it frees when the preset is pinned. */
export function deleteQuestion(preset: UserPreset, pin: PinKey | null, chord: string): string
{
  const base = `Delete ${preset.name}? Jobs that use it keep their settings.`
  return pin === null ? base : `${base} ${chord} is no longer pinned.`
}

/** A command's failure as one sentence for the section's status line, or null when it succeeded. */
export function commandFailure(result: { ok: true } | { ok: false; error: { message: string } }): string | null
{
  return result.ok ? null : result.error.message
}

const LEGEND = 'type-legend text-brass'

const INPUT = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken ps-2 pe-2 text-body text-ink',
  'transition-colors duration-fast ease-out select-text',
  'not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill'
].join(' ')

interface RowProps
{
  preset: UserPreset
  users: readonly UserPreset[]
  pin: PinKey | null
  onCommand: (run: (api: JobsApi) => Promise<{ ok: true } | { ok: false; error: { message: string } }>) => Promise<boolean>
}

/** One user preset: its name, its values in plain words, its pinned key, and Rename and Delete. */
function UserPresetRow({ preset, users, pin, onCommand }: RowProps): ReactElement
{
  const platform = usePlatform()
  const nameId = useId()
  const errorId = useId()
  const renameButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view')
  const [name, setName] = useState(preset.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chord = pin === null ? '' : `Alt+${pin}`

  function startRename(): void
  {
    setName(preset.name)
    setError(null)
    setMode('rename')
  }

  async function saveName(): Promise<void>
  {
    const issue = presetNameError(name, preset.recipe.kind, users, preset.id)
    if (issue !== null)
    {
      setError(issue)
      return
    }
    if (name.trim() === preset.name)
    {
      setMode('view')
      return
    }
    setBusy(true)
    const done = await onCommand((api) => api.renamePreset({ id: preset.id, name: name.trim() }))
    setBusy(false)
    if (done)
    {
      setMode('view')
      requestAnimationFrame(() => renameButton.current?.focus())
    }
  }

  async function resolveDelete(confirmed: boolean): Promise<void>
  {
    setMode('view')
    if (confirmed)
    {
      await onCommand((api) => api.removePreset({ id: preset.id }))
    }
  }

  return (
    <li className='flex flex-col gap-2 border-b border-line py-2 last:border-b-0' data-preset={preset.id}>
      {mode === 'rename'
        ? (
          <form
            className='flex flex-wrap items-start gap-2'
            onSubmit={(event) =>
            {
              event.preventDefault()
              void saveName()
            }}
          >
            <div className='flex min-w-48 flex-1 flex-col gap-1'>
              <label htmlFor={nameId} className='text-label text-ink-2'>{PRESET_WORDS.nameLabel}</label>
              <input
                id={nameId}
                type='text'
                autoComplete='off'
                spellCheck={false}
                autoFocus
                value={name}
                onChange={(event) =>
                {
                  setName(event.target.value)
                  setError(null)
                }}
                onKeyDown={(event) =>
                {
                  if (event.key === 'Escape')
                  {
                    event.preventDefault()
                    setMode('view')
                    requestAnimationFrame(() => renameButton.current?.focus())
                  }
                }}
                aria-invalid={error !== null}
                aria-describedby={error === null ? undefined : errorId}
                className={INPUT}
              />
              {error !== null && <FieldMessage id={errorId}>{error}</FieldMessage>}
            </div>
            <div className='flex gap-2 pt-5'>
              <Button type='submit' size='sm' variant='primary' loading={busy}>{PRESET_WORDS.save}</Button>
              <Button type='button' size='sm' variant='ghost' onClick={() => setMode('view')}>{PRESET_WORDS.cancel}</Button>
            </div>
          </form>
        )
        : (
          <div className='grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4'>
            <div className='flex min-w-0 flex-col'>
              <span className='flex items-center gap-2'>
                <span className='truncate text-body text-ink'>{preset.name}</span>
                {pin !== null && <Kbd keys={['Alt', pin]} platform={platform} />}
              </span>
              <span className='text-label text-ink-2'>{describeRecipe(preset.recipe)}</span>
              {preset.id === EARLIER_DEFAULT_PRESET.id && <span className='text-label text-ink-3'>{PRESET_WORDS.earlierDefault}</span>}
            </div>
            <div className='flex items-center gap-1'>
              <Button ref={renameButton} size='sm' variant='ghost' icon='action.edit' aria-label={`${PRESET_WORDS.rename} ${preset.name}`} onClick={startRename}>
                {PRESET_WORDS.rename}
              </Button>
              <Button ref={deleteButton} size='sm' variant='ghost' icon='action.trash' aria-label={`${PRESET_WORDS.remove} ${preset.name}`} onClick={() => setMode('delete')}>
                {PRESET_WORDS.remove}
              </Button>
            </div>
          </div>
        )}
      {mode === 'delete' && (
        <InlineConfirm
          question={deleteQuestion(preset, pin, chord)}
          safeLabel={PRESET_WORDS.keep}
          confirmLabel={PRESET_WORDS.remove}
          danger
          size='sm'
          opener={deleteButton.current}
          onResolve={(confirmed) => void resolveDelete(confirmed)}
        />
      )}
    </li>
  )
}

/** The user's presets by operation, or the empty state that says how to save one. */
function UserPresets({ presets, onCommand }: { presets: PresetState; onCommand: RowProps['onCommand'] }): ReactElement
{
  const headingId = useId()
  const groups = presetsByOperation(presets.user)
  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <h2 id={headingId} className={LEGEND}>{PRESET_WORDS.yours}</h2>
        <p className='text-body text-ink-2'>{PRESET_WORDS.yoursIntro}</p>
      </div>
      {groups.length === 0
        ? (
          <div className='flex flex-col gap-1 rounded-sm border border-line bg-panel px-3 py-3'>
            <p className='text-body text-ink'>{PRESET_WORDS.empty}</p>
            <p className='text-body text-ink-2'>{PRESET_WORDS.emptyHow}</p>
          </div>
        )
        : groups.map((group) => (
          <div key={group.op} className='flex flex-col'>
            <h3 className='text-label font-semibold text-ink-2'>{operationLabel(group.op)}</h3>
            <ul aria-label={`${operationLabel(group.op)} presets`} className='flex flex-col'>
              {group.presets.map((preset) => (
                <UserPresetRow key={preset.id} preset={preset} users={presets.user} pin={pinOf(presets.pins, preset.id)} onCommand={onCommand} />
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}

/** The choices of one pinned key: none, the user's presets, then each operation's built-in presets. */
export function pinChoices(users: readonly UserPreset[]): Array<SelectOption | SelectGroup>
{
  const yours: SelectGroup[] = users.length === 0
    ? []
    : [{
      group: USER_PRESET_GROUP,
      options: [...users]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((preset) => ({ value: preset.id, label: `${preset.name}${PART_SEPARATOR}${operationLabel(preset.recipe.kind)}` }))
    }]
  const builtIn = OPERATIONS.map((op): SelectGroup => ({
    group: operationLabel(op),
    options: BUILTIN_PRESETS.filter((preset) => preset.op === op).map((preset) => ({ value: preset.id, label: preset.label }))
  }))
  return [{ value: NO_PIN, label: PRESET_WORDS.noPin }, ...yours, ...builtIn]
}

/** The pinned keys 1 to 9, each with the preset it applies; any built-in or user preset can hold a key. */
function PinnedKeys({ presets, onCommand }: { presets: PresetState; onCommand: RowProps['onCommand'] }): ReactElement
{
  const platform = usePlatform()
  const headingId = useId()
  const introId = useId()
  const choices = pinChoices(presets.user)

  function choose(key: PinKey, value: string): void
  {
    void onCommand((api) => api.setPin({ key: Number(key), presetId: value === NO_PIN ? null : value }))
  }

  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <h2 id={headingId} className={LEGEND}>{PRESET_WORDS.pins}</h2>
        <p id={introId} className='text-body text-ink-2'>{pinsIntro(platform)}</p>
      </div>
      <ul className='grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-x-6 gap-y-2'>
        {PIN_KEYS.map((key) => (
          <li key={key} className='grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2'>
            <Kbd keys={['Alt', key]} platform={platform} />
            <Select
              size='sm'
              value={presets.pins[key] ?? NO_PIN}
              options={choices}
              label={`${keys(`Alt+${key}`, platform)} applies`}
              describedBy={introId}
              onChange={(value) => choose(key, value)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The pinned keys' introduction, with the platform's modifier word. */
export function pinsIntro(platform: Platform): string
{
  return `${keys('Alt+1', platform)} to ${keys('Alt+9', platform)} apply these presets to the selected jobs in Batch. Choosing a key that holds another preset moves the key.`
}

/** The visible values of a built-in loudness preset: its target and true-peak maximum. */
export function loudnessValues(preset: LoudnessPreset): string
{
  const target = formatTarget(preset.target.integratedLufs, preset.target.unit, preset.id)
  return `${target}, true peak at most ${formatTruePeak(preset.target.maxTruePeakDbtp)}`
}

/** A built-in preset row: its label, a metadata line, and its values in plain words. */
function BuiltinRow({ label, meta, values, children }: { label: string; meta: string | null; values: string; children?: ReactElement | null }): ReactElement
{
  return (
    <li className='flex flex-col gap-0.5 border-b border-line py-2 last:border-b-0'>
      <span className='flex flex-wrap items-baseline gap-x-2'>
        <span className='text-body text-ink'>{label}</span>
        {meta !== null && <span className='text-label text-ink-3'>{meta}</span>}
      </span>
      <span className='text-label text-ink-2'>{values}</span>
      {children}
    </li>
  )
}

/** One operation's built-in presets: loudness presets with their standard, gain presets, or a media catalog by group. */
function BuiltinList({ op }: { op: Operation }): ReactElement
{
  const name = `Built-in ${operationLabel(op)} presets`
  if (op === 'normalize')
  {
    return (
      <ul aria-label={name} className='flex flex-col'>
        {LOUDNESS_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => (
          <BuiltinRow key={preset.id} label={preset.label} meta={preset.standardName ?? PRESET_WORDS.notStandard} values={loudnessValues(preset)}>
            <StandardLine presetId={preset.id} className='pt-1' />
          </BuiltinRow>
        ))}
      </ul>
    )
  }
  if (op === 'boost')
  {
    return (
      <ul aria-label={name} className='flex flex-col'>
        {GAIN_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => (
          <BuiltinRow key={preset.id} label={preset.label} meta={null} values={describeRecipe({ ...preset.recipe, userPreset: null } as Recipe)} />
        ))}
      </ul>
    )
  }
  const catalog: readonly BuiltinPreset[] = MEDIA_CATALOGS[op]
  return (
    <div aria-label={name} role='group' className='flex flex-col gap-3'>
      {PRESET_GROUPS[op].filter((group) => catalog.some((preset) => preset.group === group)).map((group) => (
        <div key={group} className='flex flex-col'>
          <h3 className='text-label font-semibold text-ink-2'>{group}</h3>
          <ul aria-label={`${group} presets`} className='flex flex-col'>
            {catalog.filter((preset) => preset.group === group).map((preset) => (
              <BuiltinRow key={preset.id} label={preset.label} meta={null} values={preset.description} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** The built-in presets of the operation chosen above the list, read-only. */
function BuiltinPresets(): ReactElement
{
  const headingId = useId()
  const [op, setOp] = useState<Operation>('normalize')
  return (
    <section aria-labelledby={headingId} className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <h2 id={headingId} className={LEGEND}>{PRESET_WORDS.builtIn}</h2>
        <p className='text-body text-ink-2'>{PRESET_WORDS.builtInIntro}</p>
      </div>
      <SegmentedControl
        size='sm'
        value={op}
        onChange={(value) => setOp(value as Operation)}
        label={PRESET_WORDS.operation}
        options={OPERATIONS.map((value) => ({ value, label: operationLabel(value) }))}
        className='self-start'
      />
      <BuiltinList op={op} />
    </section>
  )
}

/** Settings, Presets: the user's presets, the pinned keys, and the built-in presets. */
export function PresetSettings(): ReactElement
{
  const presets = useJobsStore((state) => state.presets)
  const [failure, setFailure] = useState<string | null>(null)

  async function onCommand(run: Parameters<RowProps['onCommand']>[0]): Promise<boolean>
  {
    const api = windowJobs()
    if (api === null)
    {
      setFailure(PRESET_WORDS.loading)
      return false
    }
    const message = commandFailure(await run(api))
    setFailure(message)
    return message === null
  }

  return (
    <div className='flex flex-col gap-8'>
      <p role='status' className='text-body text-error empty:hidden'>{failure ?? ''}</p>
      {presets === null
        ? <p className='text-body text-ink-3'>{PRESET_WORDS.loading}</p>
        : (
          <>
            <UserPresets presets={presets} onCommand={onCommand} />
            <PinnedKeys presets={presets} onCommand={onCommand} />
          </>
        )}
      <BuiltinPresets />
    </div>
  )
}
