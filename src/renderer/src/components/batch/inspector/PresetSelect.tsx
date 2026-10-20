import React, { useEffect, useId, useState } from 'react'
import { isEdited, presetLabel } from '../../../../../shared/jobs/describe'
import { findPreset, presetLookup, type PresetInfo } from '../../../../../shared/jobs/presets'
import type { Operation, Recipe } from '../../../../../shared/jobs/recipes'
import type { JobView, UserPreset } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { keys, presetSavedToast } from '../../../copy/batch'
import
{
  choosePreset,
  distinctText,
  editField,
  presetField,
  resetToPreset,
  splitSelection,
  valueKey,
  type ConsequenceNote,
  type FieldOption,
  type FieldPatch,
  type PresetField,
  type RecipeContext
} from '../../../stores/recipeFields'
import
{
  Button,
  FieldCaption,
  FieldMessage,
  IconButton,
  Menu,
  Select,
  cx,
  toast,
  usePlatform,
  type MenuEntry,
  type MenuLeafItem,
  type SelectGroup,
  type SelectOption
} from '../../../ui'
import { useBatchActions } from '../BatchActionsContext'
import { GOAL_WORDS, GoalFinder, PresetGuideText } from '../../presets/PresetGuide'
import { PIN_KEYS, pinLabel, pinOf, SavePresetRow, type PinKey } from './SavePresetRow'
import { StandardLine } from './StandardLine'

/** The note an update or a delete of a preset carries: jobs hold frozen copies. */
export const KEEP_RECIPES_NOTE = 'Jobs already in the queue keep their settings.'

/** Why Save as preset is unavailable while the selected recipes differ. */
export const SHARE_ONE_REASON = 'Select jobs with the same settings to save them as a preset.'

/** The jobs the Preset select aggregates: the editable ones of the operation, or every one when all are locked. */
export function presetMembers(jobs: readonly JobView[], op: Operation): JobView[]
{
  const { editable, locked } = splitSelection(jobs)
  return (editable.length === 0 ? locked : editable).filter((job) => job.recipe.kind === op)
}

function comparable(recipe: Recipe): Recipe
{
  return recipe.kind === 'normalize' ? { ...recipe, albumGroupId: null } : recipe
}

/** The one recipe every job holds, album letters aside; null when they differ or there are none. */
export function sharedRecipe(jobs: readonly JobView[]): Recipe | null
{
  if (jobs.length === 0)
  {
    return null
  }
  const key = valueKey(comparable(jobs[0].recipe))
  return jobs.every((job) => valueKey(comparable(job.recipe)) === key) ? jobs[0].recipe : null
}

/** A recipe as a preset stores it: no preset reference and no album letter. */
export function presetRecipe(recipe: Recipe): Recipe
{
  const copy = { ...structuredClone(recipe), userPreset: null } as Recipe
  return copy.kind === 'normalize' ? { ...copy, albumGroupId: null } : copy
}

/** A consequence note restated once the change is made: "would be blocked" becomes "now blocked". */
export function nowBlocked(text: string): string
{
  return text
    .replace(/\b(it|It) would be blocked/g, '$1 is now blocked')
    .replace(/\b1 of the selected jobs would be blocked/g, '1 of the selected jobs is now blocked')
    .replace(/would be blocked/g, 'are now blocked')
}

/** The toast body of an applied preset: what the change blocked, or null. */
export function appliedNote(notes: readonly ConsequenceNote[]): string | null
{
  const blocking = notes.filter((note) => note.severity === 'error')
  return blocking.length === 0 ? null : blocking.map((note) => nowBlocked(note.text)).join(' ')
}

function optionLabel(option: FieldOption<string>, platform: Platform): string
{
  return option.group === 'Pinned' && option.description !== null
    ? `${option.label} · ${keys(option.description, platform)}`
    : option.label
}

/** The Preset select's choices: options outside every list first, then each group in the field's order. */
export function presetSelectOptions(field: PresetField, platform: Platform): Array<SelectOption | SelectGroup>
{
  const loose: SelectOption[] = []
  const groups: SelectGroup[] = []
  for (const option of field.options)
  {
    const entry: SelectOption = { value: option.key, label: optionLabel(option, platform), disabled: option.disabled || undefined }
    if (option.group === null)
    {
      loose.push(entry)
      continue
    }
    const last = groups.at(-1)
    if (last !== undefined && last.group === option.group)
    {
      last.options.push(entry)
    }
    else
    {
      groups.push({ group: option.group, options: [entry] })
    }
  }
  return [...loose, ...groups]
}

/** The loudness preset a Normalize selection's standard line names, with the target the jobs share. */
function standardOf(members: readonly JobView[]): { presetId: string; targetLufs: number | null } | null
{
  const recipes = members.map((job) => job.recipe)
  const first = recipes[0]
  if (first === undefined || first.kind !== 'normalize')
  {
    return null
  }
  const presetId = first.presetId ?? 'custom'
  if (!recipes.every((recipe) => (recipe.presetId ?? 'custom') === presetId))
  {
    return null
  }
  const target = first.target.integratedLufs
  const shared = recipes.every((recipe) => recipe.kind === 'normalize' && recipe.target.integratedLufs === target)
  return { presetId, targetLufs: shared ? target : null }
}

/** Whether Save as preset shows, and why it is unavailable: it offers a recipe that is edited, custom, or of a deleted preset. */
export function saveState(field: PresetField, shared: Recipe | null, users: readonly UserPreset[]): { shown: boolean; reason: string | null }
{
  if (shared === null)
  {
    return { shown: true, reason: field.disabled ? field.reason : SHARE_ONE_REASON }
  }
  const named = findPreset(field.value, users)
  return { shown: field.edited > 0 || named === null, reason: field.disabled ? field.reason : null }
}

/** The preset a selection names when it shares one: a built-in or one of the user's, else null. */
export function namedPreset(field: PresetField, users: readonly UserPreset[]): PresetInfo | null
{
  return field.mixed ? null : findPreset(field.value, users)
}

export interface PresetSelectProps
{
  /** The selected jobs. */
  jobs: readonly JobView[]
  /** The operation the Recipe tab shows. */
  op: Operation
  ctx: RecipeContext
  className?: string
}

type Row = 'save' | 'rename'

type Opener = 'button' | 'menu'

/** The Preset select of the Recipe tab with its actions menu, the inline save and rename rows, and the standard line. */
export function PresetSelect({ jobs, op, ctx, className }: PresetSelectProps): React.JSX.Element | null
{
  const actions = useBatchActions()
  const platform = usePlatform()
  const base = useId()
  const selectId = `${base}-select`
  const saveId = `${base}-save`
  const menuId = `${base}-actions`
  const [status, setStatus] = useState<string | null>(null)
  const [row, setRow] = useState<Row | null>(null)
  const [opener, setOpener] = useState<Opener>('button')
  const [focusBack, setFocusBack] = useState<Opener | null>(null)
  const [goalsOpen, setGoalsOpen] = useState(false)
  const goalsId = `${base}-goals`

  useEffect(() =>
  {
    if (row !== null || focusBack === null)
    {
      return
    }
    const target = focusBack === 'button' ? document.getElementById(saveId) ?? document.getElementById(menuId) : document.getElementById(menuId)
    target?.focus()
    setFocusBack(null)
  }, [row, focusBack, saveId, menuId])

  const field = presetField(jobs, op, ctx)
  if (field === null)
  {
    return null
  }
  const current = field
  const members = presetMembers(jobs, op)
  const editable = splitSelection(members).editable
  const users = ctx.presets.user
  const lookup = presetLookup(users)
  const uniform = !field.mixed && field.edited === 0
  const standard = field.mixed ? null : standardOf(members)
  const shared = sharedRecipe(members)
  const save = saveState(field, shared, users)
  const named = namedPreset(field, users)
  const user = named !== null && named.user ? users.find((entry) => entry.id === named.id) ?? null : null
  const name = field.distinct[0].text
  const pinned = named === null ? null : pinOf(ctx.presets.pins, named.id)

  function openRow(kind: Row, from: Opener): void
  {
    setStatus(null)
    setOpener(from)
    setRow(kind)
  }

  function closeRow(): void
  {
    setRow(null)
    setFocusBack(opener)
  }

  async function choose(key: string): Promise<void>
  {
    const option = current.options.find((entry) => entry.key === key)
    if (option === undefined || option.disabled)
    {
      return
    }
    const edit = choosePreset(jobs, op, option.value, ctx)
    const recipe = edit.assignments[0]?.recipe
    if (recipe === undefined)
    {
      return
    }
    setStatus(null)
    const preset = `${presetLabel(recipe, lookup)}${isEdited(recipe, lookup) ? ', edited' : ''}`
    await actions.assignRecipes(edit.assignments, { toast: { kind: 'applied', preset, note: appliedNote(edit.notes) } })
  }

  async function applyTip(patch: FieldPatch, label: string): Promise<void>
  {
    const edit = editField(jobs, patch, ctx)
    if (edit.assignments.length === 0)
    {
      return
    }
    setStatus(null)
    await actions.assignRecipes(edit.assignments, { field: label })
  }

  function chooseGoal(presetId: string): void
  {
    setGoalsOpen(false)
    document.getElementById(`${goalsId}-toggle`)?.focus()
    void choose(presetId)
  }

  async function reset(): Promise<void>
  {
    const edit = resetToPreset(jobs, ctx)
    if (edit.assignments.length === 0)
    {
      return
    }
    setStatus(null)
    await actions.assignRecipes(edit.assignments, { toast: { kind: 'applied', preset: name, note: appliedNote(edit.notes) } })
  }

  async function saveAs(value: { name: string; pin: number | null }): Promise<string | null>
  {
    if (shared === null)
    {
      return SHARE_ONE_REASON
    }
    const outcome = await actions.send('savePreset', { id: null, name: value.name, recipe: presetRecipe(shared), pin: value.pin })
    if (outcome.status !== 'done')
    {
      return outcome.message
    }
    const { preset, unpinned } = outcome.value
    const ref = { id: preset.id, name: preset.name }
    const assignments = editable.map((job) => ({ jobId: job.id, recipe: { ...structuredClone(job.recipe), userPreset: ref } as Recipe }))
    if (assignments.length > 0)
    {
      await actions.assignRecipes(assignments, { field: 'Preset' })
    }
    const displaced = unpinned === null ? null : findPreset(unpinned, [...users, preset])?.label ?? null
    const words = presetSavedToast(preset.name, value.pin !== null && displaced !== null ? { key: value.pin, displaced } : null, platform)
    toast.show({ tone: 'success', title: words.title, body: words.body ?? undefined })
    closeRow()
    return null
  }

  async function rename(value: { name: string }): Promise<string | null>
  {
    if (user === null)
    {
      return null
    }
    const outcome = await actions.send('renamePreset', { id: user.id, name: value.name })
    if (outcome.status !== 'done')
    {
      return outcome.message
    }
    closeRow()
    return null
  }

  async function update(): Promise<void>
  {
    if (user === null || shared === null)
    {
      return
    }
    const outcome = await actions.send('savePreset', {
      id: user.id,
      name: user.name,
      recipe: presetRecipe(shared),
      pin: pinned === null ? null : Number(pinned)
    })
    setStatus(outcome.status === 'done' ? KEEP_RECIPES_NOTE : outcome.message)
  }

  async function remove(): Promise<void>
  {
    if (user === null)
    {
      return
    }
    const outcome = await actions.send('removePreset', { id: user.id })
    setStatus(outcome.status === 'done' ? KEEP_RECIPES_NOTE : outcome.message)
  }

  async function pin(key: PinKey | null): Promise<void>
  {
    const slot = key ?? pinned
    if (named === null || slot === null)
    {
      return
    }
    const outcome = await actions.send('setPin', { key: Number(slot), presetId: key === null ? null : named.id })
    setStatus(outcome.status === 'done' ? null : outcome.message)
  }

  function menuItems(): MenuEntry[]
  {
    const items: MenuEntry[] = []
    if (!current.mixed)
    {
      items.push({ id: 'reset', label: current.reset ?? `Reset to ${name}`, disabled: current.reset === null, onSelect: () => void reset() })
    }
    if (save.shown)
    {
      items.push({
        id: 'save',
        label: 'Save as preset…',
        disabled: save.reason !== null,
        disabledReason: save.reason ?? undefined,
        onSelect: () => openRow('save', 'menu')
      })
    }
    if (user !== null)
    {
      items.push({
        id: 'update',
        label: `Update ${user.name} with these settings`,
        description: KEEP_RECIPES_NOTE,
        disabled: shared === null || current.edited === 0,
        onSelect: () => void update()
      })
      items.push({ id: 'rename', label: `Rename ${user.name}…`, onSelect: () => openRow('rename', 'menu') })
    }
    const keyItems: Array<MenuEntry<MenuLeafItem>> = PIN_KEYS.map((key): MenuLeafItem => ({
      id: `pin-${key}`,
      kind: 'radio',
      group: 'pin',
      checked: named !== null && ctx.presets.pins[key] === named.id,
      label: pinLabel(ctx.presets, key, platform),
      onSelect: () => void pin(key)
    }))
    items.push({
      id: 'pin',
      kind: 'submenu',
      label: 'Pin to number',
      disabled: named === null,
      items: [...keyItems, 'separator', { id: 'unpin', label: 'Unpin', disabled: pinned === null, onSelect: () => void pin(null) }]
    })
    if (user !== null)
    {
      items.push('separator')
      items.push({ id: 'delete', label: `Delete ${user.name}`, description: KEEP_RECIPES_NOTE, danger: true, onSelect: () => void remove() })
    }
    return items
  }

  const describedBy = field.disabled ? `${base}-reason` : field.mixed ? `${base}-mixed` : undefined

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <div className='flex flex-col gap-1'>
        <FieldCaption htmlFor={selectId} hint={field.mixed ? 'Mixed' : undefined}>Preset</FieldCaption>
        <div className='flex items-start gap-1'>
          <Select
            id={selectId}
            value={uniform ? field.value : null}
            nullLabel={field.text}
            onChange={(key) => void choose(key)}
            options={presetSelectOptions(field, platform)}
            disabled={field.disabled}
            describedBy={describedBy}
            className='min-w-0 flex-1'
          />
          <Menu
            label='Preset actions'
            align='end'
            items={menuItems()}
            trigger={<IconButton id={menuId} label='Preset actions' icon='action.more' variant='ghost' tooltip />}
          />
        </div>
        {field.mixed && <FieldMessage id={`${base}-mixed`} tone='note'>{distinctText(field.distinct)}</FieldMessage>}
        {field.reason !== null && (
          <span hidden={splitSelection(jobs).editable.length === 0 || undefined}>
            <FieldMessage id={`${base}-reason`} tone='note'>{field.reason}</FieldMessage>
          </span>
        )}
      </div>
      {!field.mixed && (
        <PresetGuideText
          op={op}
          presetId={field.value}
          onUsePreset={field.disabled ? undefined : (id) => void choose(id)}
          onTip={field.disabled ? undefined : (patch, label) => void applyTip(patch, label)}
        />
      )}
      {!field.disabled && (
        <div className='flex flex-col items-start gap-1'>
          <Button
            id={`${goalsId}-toggle`}
            variant='ghost'
            size='sm'
            icon={goalsOpen ? 'action.collapse' : 'action.expand'}
            aria-expanded={goalsOpen}
            aria-controls={goalsId}
            onClick={() => setGoalsOpen(!goalsOpen)}
            className='-ms-2'
          >
            {GOAL_WORDS.heading}
          </Button>
          <div id={goalsId} hidden={!goalsOpen} className='w-full'>
            {goalsOpen && <GoalFinder op={op} current={field.mixed ? null : field.value} onChoose={chooseGoal} className='-mx-2' />}
          </div>
        </div>
      )}
      {standard !== null && <StandardLine presetId={standard.presetId} targetLufs={standard.targetLufs} />}
      {row === 'save' && (
        <SavePresetRow
          key='save'
          initialName={field.text}
          op={op}
          presets={ctx.presets}
          onSubmit={saveAs}
          onCancel={closeRow}
        />
      )}
      {row === 'rename' && user !== null && (
        <SavePresetRow
          key={`rename-${user.id}`}
          mode='rename'
          initialName={user.name}
          presetId={user.id}
          op={op}
          presets={ctx.presets}
          onSubmit={rename}
          onCancel={closeRow}
        />
      )}
      {row === null && save.shown && (
        <div className='flex flex-col items-start gap-1'>
          <Button
            id={saveId}
            variant='ghost'
            size='sm'
            icon='action.save'
            unavailableReason={save.reason ?? undefined}
            onClick={() => openRow('save', 'button')}
            className='-ms-2'
          >
            Save as preset…
          </Button>
          {save.reason !== null && !field.disabled && <FieldMessage id={`${base}-save-reason`} tone='note'>{save.reason}</FieldMessage>}
        </div>
      )}
      {status !== null && <p role='status' className='text-label text-ink-2'>{status}</p>}
    </div>
  )
}
