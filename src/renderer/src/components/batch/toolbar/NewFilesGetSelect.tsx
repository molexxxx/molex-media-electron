/**
 * The operation and preset files added next receive, chosen from the same presets as the operation picker and
 * grouped by operation. Main persists the choice; jobs already in the queue keep theirs. Narrow views move the
 * choice into the Add menu as a submenu.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Menu, type MenuEntry, type MenuSubmenuItem, type SelectGroup } from '../../../ui'
import { TooltipButton } from '../header/TooltipButton'
import type { EncoderPolicy } from '../../../../../shared/audio/types'
import { operationLabel, presetLabel } from '../../../../../shared/jobs/describe'
import { applyPreset, BUILTIN_PRESETS, PRESET_GROUPS, presetLookup, USER_PRESET_GROUP } from '../../../../../shared/jobs/presets'
import { OPERATIONS, type Operation, type Recipe } from '../../../../../shared/jobs/recipes'
import type { PresetState } from '../../../../../shared/jobs/types'
import { presetKey } from '../../../stores/recipeFields'

/** The caption beside the choice and the Add menu's submenu label. */
export const NEW_FILES_GET_CAPTION = 'New files'

/** The accessible name of the choice. */
export const NEW_FILES_GET_LABEL = 'Operation for new files'

/** The tooltip and description of the choice. */
export const NEW_FILES_GET_TOOLTIP = 'Files you add next get this operation and preset. Jobs already in the queue keep theirs.'

/** What the choice reads before main has sent it. */
export const NEW_FILES_LOADING = 'Loading presets'

/** The radio group of the Add menu's "New files get" submenu. */
export const NEW_FILES_MENU_GROUP = 'new-files-get'

const SAME_AS_SOURCE: EncoderPolicy = Object.freeze({ kind: 'same-as-source' })

/** A recipe's choice value, unique across operations: "normalize:ebu-r128"; null before main sent one. */
export function newFilesValue(recipe: Recipe | null): string | null
{
  return recipe === null ? null : `${recipe.kind}:${presetKey(recipe)}`
}

/** An option's text, which names the operation so the closed select reads alone: "Normalize · Podcast (Apple Podcasts)". */
export function newFilesOptionLabel(op: Operation, label: string): string
{
  return `${operationLabel(op)} · ${label}`
}

/**
 * The choices, one group per operation in the picker's order, then "Your presets". A current recipe no group
 * lists, such as Custom loudness, leads its operation's group so the select can show it.
 */
export function newFilesGroups(presets: PresetState | null, current: Recipe | null): SelectGroup[]
{
  const users = presets?.user ?? []
  const groups: SelectGroup[] = OPERATIONS.map((op) =>
  {
    const order = PRESET_GROUPS[op]
    const options = BUILTIN_PRESETS
      .filter((info) => info.op === op)
      .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
      .map((info) => ({ value: `${op}:${info.id}`, label: newFilesOptionLabel(op, info.label) }))
    return { group: operationLabel(op), options }
  })
  if (users.length > 0)
  {
    groups.push({
      group: USER_PRESET_GROUP,
      options: users.map((user) => ({ value: `${user.recipe.kind}:${user.id}`, label: newFilesOptionLabel(user.recipe.kind, user.name) }))
    })
  }
  const value = newFilesValue(current)
  if (current !== null && value !== null && !groups.some((group) => group.options.some((option) => option.value === value)))
  {
    const own = groups[OPERATIONS.indexOf(current.kind)]
    own.options.unshift({ value, label: newFilesOptionLabel(current.kind, presetLabel(current, presetLookup(users))) })
  }
  return groups
}

/** The label of a choice among the groups, or null. */
export function newFilesLabel(groups: readonly SelectGroup[], value: string | null): string | null
{
  for (const group of groups)
  {
    const option = group.options.find((entry) => entry.value === value)
    if (option !== undefined)
    {
      return option.label
    }
  }
  return null
}

/**
 * The whole recipe a choice gives new files, or null when it is the current choice or names nothing. Normalize
 * and Gain presets keep the output policy of the current recipe when it has one.
 */
export function newFilesRecipe(value: string, current: Recipe | null, presets: PresetState | null): Recipe | null
{
  if (value === newFilesValue(current))
  {
    return null
  }
  const id = value.slice(value.indexOf(':') + 1)
  const output = current !== null && (current.kind === 'normalize' || current.kind === 'boost') ? current.output : SAME_AS_SOURCE
  return applyPreset(id, output, presets?.user ?? [])
}

/** The Add menu's "New files get" submenu: the same choices as radio items, with the current one as its description. */
export function newFilesSubmenu(groups: readonly SelectGroup[], value: string | null, choose: (value: string) => void): MenuSubmenuItem
{
  const current = newFilesLabel(groups, value)
  return {
    kind: 'submenu',
    id: NEW_FILES_MENU_GROUP,
    label: NEW_FILES_GET_CAPTION,
    ...(current === null ? {} : { description: current }),
    items: groups.map((group) => ({
      group: group.group,
      items: group.options.map((option) => ({
        kind: 'radio' as const,
        group: NEW_FILES_MENU_GROUP,
        id: option.value,
        label: option.label,
        checked: option.value === value,
        onSelect: () => choose(option.value)
      }))
    }))
  }
}

/** What the toolbar reads to show and change the choice. */
export interface NewFilesChoice
{
  groups: SelectGroup[]
  /** The choice shown: the one just made until main confirms it, else main's. */
  value: string | null
  choose(value: string): void
}

/**
 * The choice with its groups. `onChoose` sends the recipe to main and resolves true when main took it; the
 * choice shows at once and stays until main's recipe arrives, or snaps back when main refuses it.
 */
export function useNewFilesChoice(recipe: Recipe | null, presets: PresetState | null, onChoose: (recipe: Recipe) => Promise<boolean>): NewFilesChoice
{
  const current = newFilesValue(recipe)
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() =>
  {
    setChosen(null)
  }, [current])
  const groups = useMemo(() => newFilesGroups(presets, recipe), [presets, recipe])
  const choose = useCallback((value: string): void =>
  {
    const next = newFilesRecipe(value, recipe, presets)
    if (next === null)
    {
      return
    }
    setChosen(value)
    void onChoose(next).then((taken) =>
    {
      if (!taken)
      {
        setChosen(null)
      }
    })
  }, [recipe, presets, onChoose])
  return { groups, value: chosen ?? current, choose }
}

/** The choices as radio items, one group per operation. */
export function newFilesEntries(groups: readonly SelectGroup[], value: string | null, choose: (value: string) => void): MenuEntry[]
{
  return groups.map((group) => ({
    group: group.group,
    items: group.options.map((option) => ({
      kind: 'radio' as const,
      group: NEW_FILES_MENU_GROUP,
      id: option.value,
      label: option.label,
      checked: option.value === value,
      onSelect: () => choose(option.value)
    }))
  }))
}

/** Props of NewFilesGetSelect. */
export interface NewFilesGetSelectProps
{
  choice: NewFilesChoice
  disabled?: boolean
  className?: string
}

/**
 * The toolbar's "New files" caption and its menu button, one line at every width: the current choice ends in an
 * ellipsis and reads in full in the tooltip. The caption hides below 1180 px of view; the name stays.
 */
export function NewFilesGetSelect({ choice, disabled = false, className }: NewFilesGetSelectProps): React.JSX.Element
{
  const current = newFilesLabel(choice.groups, choice.value) ?? NEW_FILES_LOADING
  const unavailable = disabled || choice.value === null
  return (
    <div className={className ?? 'flex min-w-0 shrink items-center gap-2'}>
      <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-label text-ink-3 @max-[1179px]:hidden">
        {NEW_FILES_GET_CAPTION}
      </span>
      <Menu
        label={NEW_FILES_GET_LABEL}
        items={newFilesEntries(choice.groups, choice.value, choice.choose)}
        trigger={(
          <TooltipButton
            tip={`${current}. ${NEW_FILES_GET_TOOLTIP}`}
            aria-label={`${NEW_FILES_GET_LABEL}: ${current}`}
            iconEnd="action.openMenu"
            disabled={unavailable}
            className="w-64 min-w-40 shrink justify-between @max-[1179px]:w-52"
          >
            <span className="min-w-0 flex-1 truncate text-start" data-part="new-files-value">{current}</span>
          </TooltipButton>
        )}
      />
    </div>
  )
}
