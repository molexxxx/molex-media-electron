import React, { useEffect, useId, useRef, useState } from 'react'
import { findPreset } from '../../../../../shared/jobs/presets'
import type { Operation } from '../../../../../shared/jobs/recipes'
import type { PresetState, UserPreset } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { keys } from '../../../copy/batch'
import { Button, FieldCaption, FieldMessage, Select, cx, usePlatform, type SelectOption } from '../../../ui'

/** The longest preset name, in characters. */
export const PRESET_NAME_MAX = 60

/** The keys a preset can be pinned to: Alt+1 to Alt+9. */
export const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/** A pin key. */
export type PinKey = typeof PIN_KEYS[number]

/** The pin choice that pins nothing. */
export const NO_PIN = 'none'

export const NAME_LENGTH_ERROR = 'Enter a name of 1 to 60 characters.'

/** Why a preset name cannot be used, or null: 1 to 60 characters, unique among the user's presets of the operation. */
export function presetNameError(name: string, op: Operation, users: readonly UserPreset[], exceptId: string | null = null): string | null
{
  const trimmed = name.trim()
  const length = Array.from(trimmed).length
  if (length < 1 || length > PRESET_NAME_MAX)
  {
    return NAME_LENGTH_ERROR
  }
  const folded = trimmed.toLocaleLowerCase()
  const clash = users.some((user) => user.id !== exceptId && user.recipe.kind === op && user.name.trim().toLocaleLowerCase() === folded)
  return clash ? `A preset named ${trimmed} already exists. Choose another name, or update it from the preset menu.` : null
}

/** The display name of the preset a key holds; null for a free key or one whose preset no longer exists. */
export function pinHolder(pins: PresetState['pins'], key: PinKey, users: readonly UserPreset[]): string | null
{
  const id = pins[key]
  return id === undefined ? null : findPreset(id, users)?.label ?? null
}

/** The key a preset is pinned to, or null. */
export function pinOf(pins: PresetState['pins'], presetId: string): PinKey | null
{
  return PIN_KEYS.find((key) => pins[key] === presetId) ?? null
}

/** A pin key as the platform words it, with the preset that holds it: "Alt+4 (Gentle lift)". */
export function pinLabel(presets: PresetState, key: PinKey, platform: Platform): string
{
  const holder = pinHolder(presets.pins, key, presets.user)
  const chord = keys(`Alt+${key}`, platform)
  return holder === null ? chord : `${chord} (${holder})`
}

/** The "Pin to number" choices: None, then every key, a taken key naming its holder. */
export function pinOptions(presets: PresetState, platform: Platform): SelectOption[]
{
  return [
    { value: NO_PIN, label: 'None' },
    ...PIN_KEYS.map((key): SelectOption => ({ value: key, label: pinLabel(presets, key, platform) }))
  ]
}

const INPUT = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken ps-2 pe-2 text-body text-ink',
  'transition-colors duration-fast ease-out select-text',
  'not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill'
].join(' ')

export interface SavePresetRowProps
{
  /** `save` names a new preset and offers a pin key; `rename` changes the name of a user preset. */
  mode?: 'save' | 'rename'
  /** The name the field starts with, such as "Streaming (EBU R 128 s2), edited". */
  initialName: string
  /** Names are unique per operation. */
  op: Operation
  presets: PresetState
  /** The preset being renamed, which may keep its own name. */
  presetId?: string | null
  /** Saves the name and pin; resolves to a message to show inline, or null once saved. */
  onSubmit(value: { name: string; pin: number | null }): Promise<string | null>
  /** Escape and Cancel; the owner returns focus to the control that opened the row. */
  onCancel(): void
  className?: string
}

/** The inline row that names a preset: Enter saves, Escape cancels, and a name problem shows under the field. */
export function SavePresetRow({
  mode = 'save',
  initialName,
  op,
  presets,
  presetId = null,
  onSubmit,
  onCancel,
  className
}: SavePresetRowProps): React.JSX.Element
{
  const platform = usePlatform()
  const base = useId()
  const nameId = `${base}-name`
  const errorId = `${base}-error`
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initialName)
  const [pin, setPin] = useState<string>(NO_PIN)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() =>
  {
    input.current?.focus()
    input.current?.select()
  }, [])

  function change(next: string): void
  {
    setName(next)
    if (error !== null)
    {
      setError(presetNameError(next, op, presets.user, presetId))
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void>
  {
    event.preventDefault()
    if (busy)
    {
      return
    }
    const problem = presetNameError(name, op, presets.user, presetId)
    if (problem !== null)
    {
      setError(problem)
      input.current?.focus()
      return
    }
    setBusy(true)
    const refused = await onSubmit({ name: name.trim(), pin: mode === 'save' && pin !== NO_PIN ? Number(pin) : null })
    if (refused !== null)
    {
      setBusy(false)
      setError(refused)
      input.current?.focus()
    }
  }

  function keyDown(event: React.KeyboardEvent<HTMLFormElement>): void
  {
    if (event.key === 'Escape')
    {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <form
      aria-label={mode === 'save' ? 'Save as preset' : 'Rename preset'}
      noValidate
      onSubmit={(event) => void submit(event)}
      onKeyDown={keyDown}
      className={cx('flex flex-col gap-3', className)}
    >
      <div className='flex flex-col gap-1'>
        <FieldCaption htmlFor={nameId}>Preset name</FieldCaption>
        <input
          ref={input}
          id={nameId}
          type='text'
          autoComplete='off'
          spellCheck={false}
          value={name}
          onChange={(event) => change(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          className={INPUT}
        />
        {error !== null && <FieldMessage id={errorId}>{error}</FieldMessage>}
      </div>
      {mode === 'save' && (
        <div className='flex flex-col gap-1'>
          <FieldCaption htmlFor={`${base}-pin`}>Pin to number</FieldCaption>
          <Select id={`${base}-pin`} value={pin} onChange={setPin} options={pinOptions(presets, platform)} />
        </div>
      )}
      <div className='flex items-center gap-2'>
        <Button type='submit' variant='secondary' size='sm' loading={busy} loadingLabel='Saving'>
          {mode === 'save' ? 'Save preset' : 'Rename preset'}
        </Button>
        <Button type='button' variant='ghost' size='sm' onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
