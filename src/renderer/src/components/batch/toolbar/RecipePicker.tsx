import { useCallback, useId, useImperativeHandle, useMemo, useState, type FormEvent, type ReactElement, type Ref } from 'react'
import { keys, recipeAppliedToast } from '../../../copy/batch'
import type { BatchActions } from '../../../stores/batchActions'
import { Button } from '../../../ui/Button'
import { Combobox, type ComboboxGroup, type ComboboxModifiers, type ComboboxOption } from '../../../ui/Combobox'
import { cx } from '../../../ui/cx'
import { Icon } from '../../../ui/Icon'
import { ariaKeyShortcuts, usePlatform } from '../../../ui/Kbd'
import { useBatchActions } from '../BatchActionsContext'
import type { EncoderPolicy } from '../../../../../shared/audio/types'
import { applicability, factsFromSummary, type Applicability } from '../../../../../shared/jobs/applicability'
import
{
  audioCodecLabel,
  describeRecipe,
  isEdited,
  operationLabel,
  presetLabel,
  recipeLabel,
  recipeOperationName,
  type PresetLookup
} from '../../../../../shared/jobs/describe'
import { BUILTIN_PRESETS, PRESET_GROUPS, USER_PRESET_GROUP, applyPreset, findPreset, presetLookup } from '../../../../../shared/jobs/presets'
import type { Operation, Recipe, StreamPick } from '../../../../../shared/jobs/recipes'
import type { JobView, PresetState } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { splitSelection } from '../../../stores/recipeFields'

/** The output policy Normalize and Gain presets apply with when the caller names none. */
const SAME_AS_SOURCE: EncoderPolicy = { kind: 'same-as-source' }

/** The operation groups of the picker, in the order it lists them. */
const OPERATION_ORDER: readonly Operation[] = ['convert', 'normalize', 'boost', 'compress', 'extract']

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/** How many recently used recipes the picker lists. */
const RECENT_LIMIT = 8

/** One recipe the picker offers, with what choosing it applies. */
export interface RecipeEntry
{
  option: ComboboxOption
  recipe: Recipe
  /** The preset's own name, as toasts say it ("Web 1080p"). */
  preset: string
  /** Lowercased text the query matches: label, description, preset group, and the recipe's codec and format values. */
  search: string
}

/** The picker's groups and the entry behind each option id. */
export interface RecipeCatalog
{
  groups: ComboboxGroup[]
  entries: ReadonlyMap<string, RecipeEntry>
}

/** Folds case, minus signs, and dashes, so "-14" finds a target written with a minus sign. */
function foldCase(text: string): string
{
  return text.toLowerCase().replace(/[‐-―−]/g, '-')
}

/** Search text with a dotless copy of each dotted word, so "h264" finds "H.264". */
function fold(text: string): string
{
  const lower = foldCase(text)
  const dotless = lower.split(/\s+/).filter((word) => word.includes('.')).map((word) => word.replace(/\./g, ''))
  return dotless.length > 0 ? `${lower} ${dotless.join(' ')}` : lower
}

/** The string values of a recipe (container, encoders, codecs, formats), which the query also matches. */
function recipeWords(value: unknown, words: string[] = []): string[]
{
  if (typeof value === 'string')
  {
    words.push(value)
  }
  else if (Array.isArray(value))
  {
    value.forEach((item) => recipeWords(item, words))
  }
  else if (value !== null && typeof value === 'object')
  {
    Object.values(value).forEach((item) => recipeWords(item, words))
  }
  return words
}

/** Whether every word of a query appears in an entry's search text. */
export function matchesQuery(search: string, query: string): boolean
{
  return foldCase(query).split(/\s+/).filter(Boolean).every((word) => search.includes(word) || search.includes(word.replace(/\./g, '')))
}

/** The pinned key of each pinned preset id; the lowest key wins when one preset holds two. */
function pinKeys(pins: PresetState['pins']): Map<string, string>
{
  const keys = new Map<string, string>()
  for (const key of PIN_KEYS)
  {
    const id = pins[key]
    if (id && !keys.has(id))
    {
      keys.set(id, key)
    }
  }
  return keys
}

/** The preset id a recipe came from: its user preset, else its built-in preset. */
function sourcePresetId(recipe: Recipe): string | null
{
  return recipe.userPreset?.id ?? recipe.presetId
}

function entryFor(id: string, recipe: Recipe, lookup: PresetLookup, group: string, shortcut: string | null): RecipeEntry
{
  const label = recipeLabel(recipe, lookup)
  const description = describeRecipe(recipe)
  const option: ComboboxOption = shortcut ? { id, label, description, shortcut } : { id, label, description }
  const search = fold([label, description, group, operationLabel(recipe.kind), ...recipeWords(recipe)].join(' '))
  return { option, recipe, preset: presetLabel(recipe, lookup), search }
}

/**
 * The picker's list: "Pinned" with their keys, "Recently used" (eight), one group per operation in the order Convert,
 * Normalize, Gain, Compress, Extract (each in its preset groups' order), then "Your presets". Every option reads
 * "{operation} · {preset}" with the description its values give and, when pinned, its key.
 */
export function recipeCatalog(presets: PresetState, output: EncoderPolicy = SAME_AS_SOURCE): RecipeCatalog
{
  const users = presets.user
  const lookup = presetLookup(users)
  const keys = pinKeys(presets.pins)
  const entries = new Map<string, RecipeEntry>()
  const groups: ComboboxGroup[] = []

  const add = (groupId: string, groupLabel: string, list: RecipeEntry[]): void =>
  {
    if (list.length === 0)
    {
      return
    }
    list.forEach((entry) => entries.set(entry.option.id, entry))
    groups.push({ id: groupId, label: groupLabel, options: list.map((entry) => entry.option) })
  }

  const shortcutOf = (presetId: string | null): string | null =>
  {
    const key = presetId === null ? undefined : keys.get(presetId)
    return key ? `Alt+${key}` : null
  }

  add('pinned', 'Pinned', PIN_KEYS.flatMap((key) =>
  {
    const id = presets.pins[key]
    const info = id ? findPreset(id, users) : null
    const recipe = info ? applyPreset(info.id, output, users) : null
    return info && recipe ? [entryFor(`pin:${key}`, recipe, lookup, info.group, `Alt+${key}`)] : []
  }))

  add('recent', 'Recently used', presets.recent.slice(0, RECENT_LIMIT).map((recipe, index) =>
  {
    const presetId = sourcePresetId(recipe)
    const shortcut = isEdited(recipe, lookup) ? null : shortcutOf(presetId)
    const group = presetId ? findPreset(presetId, users)?.group ?? '' : ''
    return entryFor(`recent:${index}`, structuredClone(recipe), lookup, group, shortcut)
  }))

  for (const op of OPERATION_ORDER)
  {
    const order = PRESET_GROUPS[op]
    const infos = BUILTIN_PRESETS
      .filter((info) => info.op === op)
      .map((info, index) => ({ info, rank: order.indexOf(info.group) * 1000 + index }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ info }) => info)
    add(op, operationLabel(op), infos.map((info) =>
      entryFor(`preset:${info.id}`, applyPreset(info.id, output, users) as Recipe, lookup, info.group, shortcutOf(info.id))))
  }

  add('user', USER_PRESET_GROUP, users.map((user) =>
    entryFor(`user:${user.id}`, applyPreset(user.id, output, users) as Recipe, lookup, USER_PRESET_GROUP, shortcutOf(user.id))))

  return { groups, entries }
}

/** What the picker reads of a selected job: its catalog number, whether it is locked, and its streams. */
export type PickerJob = Pick<JobView, 'id' | 'state' | 'media'>

/** One line of the picker's footer: a stream rule the highlighted recipe meets, or the locked jobs it skips. */
export interface FooterLine
{
  code: Applicability['code'] | 'locked'
  severity: 'error' | 'info'
  /** Selected jobs the line counts. */
  count: number
  text: string
  /** The reason a toast gives once the jobs are blocked: "Compress needs a video stream". */
  reason: string | null
}

const SUBTITLE_FORMATS: Readonly<Record<string, string>> = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' }

/** The popover's name: "Set operation for 38 selected jobs", or "Set operation for MM-0137" for one. */
export function pickerLabel(jobs: readonly PickerJob[]): string
{
  if (jobs.length === 0)
  {
    return 'Set operation'
  }
  return jobs.length === 1 ? `Set operation for ${jobs[0].id}` : `Set operation for ${jobs.length} selected jobs`
}

/** The footer's scope sentence: the jobs Enter changes, and when every selected job is locked, why none. */
export function scopeText(jobs: readonly PickerJob[]): string
{
  const { editable } = splitSelection(jobs)
  if (jobs.length === 0)
  {
    return 'Select jobs in the table to set their operation.'
  }
  if (editable.length === 0)
  {
    return jobs.length === 1
      ? `${jobs[0].id} keeps its settings: it is queued, running, or finished.`
      : 'These jobs keep their settings: they are queued, running, or finished.'
  }
  if (jobs.length === 1)
  {
    return `Applies to ${jobs[0].id}.`
  }
  return editable.length === jobs.length
    ? `Applies to the ${jobs.length} selected jobs.`
    : `Applies to ${editable.length} of the ${jobs.length} selected jobs.`
}

/** What a source lacks when a stream pick finds nothing: "no subtitle stream in fre", "fewer than 2 audio streams". */
function missingWords(kind: string, pick: StreamPick): string
{
  if (pick.by === 'language')
  {
    return `no ${kind} stream in ${pick.language}`
  }
  return pick.by === 'ordinal' ? `fewer than ${pick.ordinal} ${kind} streams` : `no ${kind} stream`
}

/**
 * The footer's sentence for a rule met by `count` of the `total` selected jobs, worded from the shared rule:
 * "8 of 38 have no video stream; Compress needs one, so they would be blocked." A single selected job is named.
 */
function ruleLine(rule: Applicability, recipe: Recipe, count: number, total: number, only: string | null): FooterLine
{
  const one = count === 1
  const subject = only ?? `${count} of ${total}`
  const have = one ? 'has' : 'have'
  const would = one ? 'it would be blocked' : 'they would be blocked'
  const line = (text: string, reason: string | null): FooterLine =>
    ({ code: rule.code, severity: rule.severity, count, text, reason })

  switch (rule.code)
  {
    case 'no-video-stream':
      return line(`${subject} ${have} no video stream; ${rule.operation} needs one, so ${would}.`, `${rule.operation} needs a video stream`)
    case 'no-audio-stream':
      return line(`${subject} ${have} no audio stream; ${rule.operation} needs one, so ${would}.`, `${rule.operation} needs an audio stream`)
    case 'audio-only-output':
      return line(`${subject} ${have} no video stream; ${one ? 'its output' : 'their outputs'} will be audio only.`, null)
    case 'too-many-channels':
    {
      const codec = audioCodecLabel(rule.codec)
      return line(`${subject} ${have} more channels than ${codec} holds; ${would}.`, `${codec} holds at most ${rule.maxChannels} channels`)
    }
    case 'stream-not-found':
    {
      const missing = missingWords(rule.kind, rule.pick)
      const needs = rule.pick.by === 'default' ? `; ${recipeOperationName(recipe)} needs one, so ${would}.` : `; ${would}.`
      return line(`${subject} ${have} ${missing}${needs}`, missing)
    }
    default:
    {
      const format = SUBTITLE_FORMATS[rule.format] ?? rule.format.toUpperCase()
      return line(`${subject} ${one ? 'picks' : 'pick'} a bitmap subtitle, which cannot become ${format}; ${would}.`,
        `bitmap subtitles cannot become ${format}`)
    }
  }
}

/**
 * The footer's applicability lines for a recipe over the selection, counted with the shared `applicability` rule
 * the planner reports, so the footer and the plan agree: blocking rules first, then notes, then the locked jobs
 * that keep their recipes. Jobs whose probe has not finished are not counted.
 */
export function applicabilityLines(recipe: Recipe, jobs: readonly PickerJob[]): FooterLine[]
{
  const { editable, locked } = splitSelection(jobs)
  const total = jobs.length
  const only = total === 1 ? jobs[0].id : null
  const counts = new Map<Applicability['code'], { rule: Applicability; count: number }>()
  for (const job of editable)
  {
    if (job.media === null)
    {
      continue
    }
    const seen = new Set<Applicability['code']>()
    for (const rule of applicability(recipe, factsFromSummary(job.media)))
    {
      if (seen.has(rule.code))
      {
        continue
      }
      seen.add(rule.code)
      const counted = counts.get(rule.code)
      counts.set(rule.code, { rule: counted?.rule ?? rule, count: (counted?.count ?? 0) + 1 })
    }
  }
  const lines = [...counts.values()].map(({ rule, count }) => ruleLine(rule, recipe, count, total, only))
  const ordered = [...lines.filter((line) => line.severity === 'error'), ...lines.filter((line) => line.severity === 'info')]
  if (locked.length > 0 && editable.length > 0)
  {
    const one = locked.length === 1
    ordered.push({
      code: 'locked',
      severity: 'info',
      count: locked.length,
      text: `${locked.length} of ${total} ${one ? 'is' : 'are'} queued, running, or finished; ${one ? 'it keeps its settings' : 'they keep their settings'}.`,
      reason: null
    })
  }
  return ordered
}

/** The editable selected jobs a recipe would block, by the shared rule; jobs still being probed are not counted. */
export function blockedJobs(recipe: Recipe, jobs: readonly PickerJob[]): number
{
  return splitSelection(jobs).editable.filter((job) =>
    job.media !== null && applicability(recipe, factsFromSummary(job.media)).some((rule) => rule.severity === 'error')).length
}

/** The applied toast's note: "8 are now blocked: Compress needs a video stream.", or null when nothing is blocked. */
export function blockedNote(recipe: Recipe, jobs: readonly PickerJob[]): string | null
{
  const count = blockedJobs(recipe, jobs)
  if (count === 0)
  {
    return null
  }
  const reasons = applicabilityLines(recipe, jobs).flatMap((line) => line.severity === 'error' && line.reason !== null ? [line.reason] : [])
  return recipeAppliedToast('', count, { count, reason: reasons.join('; ') }).body
}

/** The batch actions that applying a recipe calls. */
export type RecipeActions = Pick<BatchActions, 'assignRecipes' | 'duplicate'>

/** What applying a recipe did: the jobs it changed or added, or the status words when it changed nothing. */
export type ApplyResult =
  | { kind: 'applied'; count: number }
  | { kind: 'added'; count: number }
  | { kind: 'none'; status: string }

/** The status words when no selected job can take a recipe. */
function unchangedStatus(jobs: readonly PickerJob[]): string
{
  return jobs.length === 0
    ? 'Select jobs in the table to set their operation.'
    : 'These jobs keep their settings: they are queued, running, or finished.'
}

/**
 * Gives a recipe to the selected jobs not in a batch, each a whole copy with an Undo toast that says what it
 * blocked; with `add`, adds a second job with the recipe for each of their sources instead.
 */
export async function applyRecipe(actions: RecipeActions, jobs: readonly PickerJob[], entry: RecipeEntry, add: boolean): Promise<ApplyResult>
{
  const { editable } = splitSelection(jobs)
  if (editable.length === 0)
  {
    return { kind: 'none', status: unchangedStatus(jobs) }
  }
  if (add)
  {
    await actions.duplicate(editable.map((job) => job.id), { recipe: structuredClone(entry.recipe), preset: entry.preset })
    return { kind: 'added', count: editable.length }
  }
  const assignments = editable.map((job) => ({ jobId: job.id, recipe: structuredClone(entry.recipe) }))
  await actions.assignRecipes(assignments, { toast: { kind: 'applied', preset: entry.preset, note: blockedNote(entry.recipe, editable) } })
  return { kind: 'applied', count: editable.length }
}

/** A pinned key, Alt+1 to Alt+9. */
export type PinKey = (typeof PIN_KEYS)[number]

/** A pinned-recipe chord: Alt with a digit applies the pin; Alt+Shift with a digit adds second jobs with it. */
export interface PinChord
{
  key: PinKey
  add: boolean
}

/** The modifier and position fields of a key event, from the DOM or from React. */
export interface ChordEvent
{
  code: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * The pinned-recipe chord of a key event, or null. It reads the key's position (`code`), so the character Option
 * types on macOS does not matter; bare digits are never a chord, since they belong to typeahead.
 */
export function pinChord(event: ChordEvent): PinChord | null
{
  if (!event.altKey || event.ctrlKey || event.metaKey)
  {
    return null
  }
  const match = /^Digit([1-9])$/.exec(event.code)
  return match === null ? null : { key: match[1] as PinKey, add: event.shiftKey }
}

/** The picker entry pinned to a key, or null when nothing is pinned there. */
export function pinnedEntry(presets: PresetState, key: PinKey, output: EncoderPolicy = SAME_AS_SOURCE): RecipeEntry | null
{
  return recipeCatalog(presets, output).entries.get(`pin:${key}`) ?? null
}

/**
 * Runs a pinned-recipe chord on the selection: applies the pinned recipe, or adds second jobs with it on
 * Alt+Shift. An empty pin and a selection of locked jobs change nothing and return their status words.
 */
export async function runPinChord(actions: RecipeActions, presets: PresetState, jobs: readonly PickerJob[], chord: PinChord,
  platform: Platform, output: EncoderPolicy = SAME_AS_SOURCE): Promise<ApplyResult>
{
  const entry = pinnedEntry(presets, chord.key, output)
  if (entry === null)
  {
    return { kind: 'none', status: `Nothing is pinned to ${keys(`Alt+${chord.key}`, platform)}. Pin a preset from the preset menu.` }
  }
  return applyRecipe(actions, jobs, entry, chord.add)
}

/** The footer's line of keys. */
export const PICKER_KEYS = 'Enter applies. Shift+Enter adds a second job for each source.'

/** The search field's placeholder. */
export const PICKER_PLACEHOLDER = 'Type an operation, preset, codec, or target'

/** What the picker says when nothing matches the query. */
export function noMatchText(query: string): string
{
  return `Nothing matches “${query}”.`
}

/** Opens the picker from a key command. */
export interface RecipePickerHandle
{
  /** Opens the picker, as Ctrl+K does; focus moves to its search field. */
  open: () => void
}

/** Props for {@link RecipePicker}. */
export interface RecipePickerProps
{
  /** The selected jobs, in table order; Enter and Shift+Enter act on those not in a batch. */
  jobs: readonly PickerJob[]
  presets: PresetState
  /** The output policy Normalize and Gain presets apply with. */
  output?: EncoderPolicy
  /** The table, which takes focus back when the picker closes. */
  returnFocus?: () => HTMLElement | null
  ref?: Ref<RecipePickerHandle>
}

function PickerFooter({ scope, lines }: { scope: string; lines: readonly FooterLine[] }): ReactElement
{
  return (
    <div className="flex flex-col gap-1">
      <p>{scope}</p>
      {lines.map((line) => (
        <p key={line.code} data-severity={line.severity} className="flex items-start gap-1.5">
          <span className={cx('flex h-4 shrink-0 items-center', line.severity === 'error' ? 'text-warning' : 'text-ink-3')}>
            <Icon name={line.severity === 'error' ? 'status.warning' : 'action.info'} size="sm" />
          </span>
          <span>{line.text}</span>
        </p>
      ))}
      <p className="text-ink-3">{PICKER_KEYS}</p>
    </div>
  )
}

/**
 * The toolbar's "Set operation" button and the picker it opens over the table, also on Ctrl+K through `ref`: a
 * search field over the groups of {@link recipeCatalog}, filtered by name, operation, codec, or target, and a
 * footer that states the scope and the highlighted recipe's applicability by the shared rule. Enter gives the
 * recipe to the selected jobs not in a batch, Shift+Enter adds a second job for each of their sources, and
 * closing returns focus to the table. With no job that can take a recipe, every option stays browsable but
 * choosing one does nothing, and the footer says why.
 */
export function RecipePicker({ jobs, presets, output, returnFocus, ref }: RecipePickerProps): ReactElement
{
  const actions = useBatchActions()
  const platform = usePlatform()
  const triggerId = useId()
  const [query, setQuery] = useState('')
  const catalog = useMemo(() => recipeCatalog(presets, output), [presets, output])
  const editable = splitSelection(jobs).editable.length

  const groups = useMemo((): ComboboxGroup[] => editable > 0
    ? catalog.groups
    : catalog.groups.map((group) => ({ ...group, options: group.options.map((option) => ({ ...option, disabled: true })) })),
  [catalog, editable])

  const filter = useCallback((needle: string, option: ComboboxOption): boolean =>
    matchesQuery(catalog.entries.get(option.id)?.search ?? '', needle), [catalog])

  const linesFor = useMemo(() =>
  {
    const cache = new Map<string, FooterLine[]>()
    return (id: string): FooterLine[] =>
    {
      const entry = catalog.entries.get(id)
      if (entry === undefined)
      {
        return []
      }
      const cached = cache.get(id) ?? applicabilityLines(entry.recipe, jobs)
      cache.set(id, cached)
      return cached
    }
  }, [catalog, jobs])

  useImperativeHandle(ref, () => ({
    open: () =>
    {
      const trigger = document.getElementById(triggerId)
      if (trigger !== null && trigger.getAttribute('aria-expanded') !== 'true')
      {
        trigger.click()
      }
    }
  }), [triggerId])

  const handleInput = (event: FormEvent<HTMLSpanElement>): void =>
  {
    if (event.target instanceof HTMLInputElement && event.target.getAttribute('role') === 'combobox')
    {
      setQuery(event.target.value)
    }
  }

  const handleOpenChange = (open: boolean): void =>
  {
    if (open)
    {
      return
    }
    setQuery('')
    const trigger = document.getElementById(triggerId)
    if (trigger !== null && document.activeElement === trigger)
    {
      returnFocus?.()?.focus()
    }
  }

  const handleChoose = (id: string, { shift }: ComboboxModifiers): void =>
  {
    const entry = catalog.entries.get(id)
    if (entry !== undefined)
    {
      void applyRecipe(actions, jobs, entry, shift)
    }
  }

  return (
    <span className="contents" onChange={handleInput}>
      <Combobox
        trigger={<Button id={triggerId} aria-keyshortcuts={ariaKeyShortcuts(['Mod', 'K'], platform)}>Set operation</Button>}
        label={pickerLabel(jobs)}
        groups={groups}
        filter={filter}
        onChoose={handleChoose}
        footer={(active) => <PickerFooter scope={scopeText(jobs)} lines={active === null ? [] : linesFor(active.id)} />}
        emptyText={noMatchText(query.trim())}
        placeholder={PICKER_PLACEHOLDER}
        onOpenChange={handleOpenChange}
        className="min-w-md"
      />
    </span>
  )
}
