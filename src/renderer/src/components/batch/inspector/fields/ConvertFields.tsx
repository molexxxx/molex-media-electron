/**
 * The Convert fields of the Recipe tab, and the field renderer the video operations share: each field draws the
 * state the recipe field model gives it (one value, or "Mixed" with the distinct values and their counts, disabled
 * with its reason, an error) and sends one patch per gesture.
 */
import { useCallback, useId, useState, type ReactElement, type ReactNode } from 'react'
import { valueKey, type FieldKey, type FieldOption, type FieldPatch, type FieldState } from '../../../../stores/recipeFields'
import { Button } from '../../../../ui/Button'
import { Checkbox } from '../../../../ui/Checkbox'
import { FieldCaption } from '../../../../ui/FieldCaption'
import { FieldMessage, MIXED_LABEL, NumberField } from '../../../../ui/NumberField'
import { SegmentedControl, type SegmentOption } from '../../../../ui/SegmentedControl'
import { Select, type SelectGroup, type SelectOption } from '../../../../ui/Select'

/** Sends one field edit; a returned promise keeps the committed value shown until it settles. */
export type PatchHandler = (patch: FieldPatch) => void | PromiseLike<unknown>

/** Props of the operation field groups. */
export interface VideoFieldsProps
{
  /** The operation's fields for the selected jobs, as the recipe field model states them. */
  fields: readonly FieldState[]
  /** Receives one patch per gesture. */
  onPatch: PatchHandler
}

function patchOf(field: FieldState, value: unknown): FieldPatch
{
  return { field: field.key, value } as FieldPatch
}

function sentence(text: string): string
{
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * The line under a field that explains it: its hint, why it cannot be edited, and why any of its options cannot be
 * chosen ("Theora: not in MP4."). A checkbox states its own reason, so it is left out there.
 */
export function fieldHint(field: FieldState): string | null
{
  const parts: string[] = []
  if (field.hint)
  {
    parts.push(field.hint)
  }
  if (field.disabled && field.reason && field.kind !== 'checkbox')
  {
    parts.push(field.reason)
  }
  for (const option of field.options ?? [])
  {
    if (option.disabled && option.reason)
    {
      parts.push(option.reason)
    }
  }
  const unique = [...new Set(parts.map(sentence))]
  return unique.length > 0 ? unique.join(' ') : null
}

function selectOptions(options: readonly FieldOption[]): Array<SelectOption | SelectGroup>
{
  const out: Array<SelectOption | SelectGroup> = []
  for (const option of options)
  {
    const entry: SelectOption = { value: option.key, label: option.label, disabled: option.disabled }
    const last = out[out.length - 1]
    if (option.group === null)
    {
      out.push(entry)
    }
    else if (last !== undefined && 'group' in last && last.group === option.group)
    {
      last.options.push(entry)
    }
    else
    {
      out.push({ group: option.group, options: [entry] })
    }
  }
  return out
}

function optionDescription(option: FieldOption): string | undefined
{
  const text = [option.description, option.note].filter((part): part is string => part !== null && part !== '').join(' ')
  return text === '' ? undefined : text
}

/** The key of the option holding the field's shared value, or null while mixed or when no option holds it. */
function currentKey(field: FieldState): string | null
{
  if (field.mixed)
  {
    return null
  }
  const key = valueKey(field.value)
  return (field.options ?? []).some((option) => option.key === key) ? key : null
}

/**
 * What choosing another option would block among the selected jobs, before anything is applied: one line per option
 * whose consequence differs from the current value's ("MP3: 3 of the selected jobs have 7.1 audio and would be
 * blocked."). Disabled options and a disabled field have none.
 */
export function optionNotes(field: FieldState): string[]
{
  if (field.disabled)
  {
    return []
  }
  const options = field.options ?? []
  const current = currentKey(field)
  const base = options.find((option) => option.key === current)?.note ?? null
  return options
    .filter((option) => !option.disabled && option.note !== null && option.note !== '' && option.key !== current && option.note !== base)
    .map((option) => `${option.label}: ${sentence(option.note as string)}`)
}

interface FieldIds
{
  control: string
  caption: string
  captionHint: string
  mixed: string
  hint: string
  note: string
  consequences: string
  locked: string
  error: string
}

function describedBy(field: FieldState, ids: FieldIds, hint: string | null, consequences: boolean, extra: string[] = []): string | undefined
{
  const list = [
    ...extra,
    field.mixed && field.mixedText ? ids.mixed : null,
    hint ? ids.hint : null,
    field.note ? ids.note : null,
    consequences ? ids.consequences : null,
    field.lockedNote ? ids.locked : null
  ].filter((id): id is string => id !== null)
  return list.length > 0 ? list.join(' ') : undefined
}

interface ControlProps
{
  field: FieldState
  ids: FieldIds
  describedBy: string | undefined
  onPatch: PatchHandler
}

function SelectControl({ field, ids, describedBy: described, onPatch }: ControlProps): ReactElement
{
  const options = field.options ?? []
  return (
    <Select
      id={ids.control}
      value={currentKey(field)}
      onChange={(key) =>
      {
        const option = options.find((entry) => entry.key === key)
        if (option !== undefined)
        {
          void onPatch(patchOf(field, option.value))
        }
      }}
      options={selectOptions(options)}
      describedBy={described}
      disabled={field.disabled}
      error={field.error ?? undefined}
      nullLabel={field.mixed ? MIXED_LABEL : field.text}
      className="w-full"
    />
  )
}

function SegmentedField({ field, ids, describedBy: described, onPatch }: ControlProps): ReactElement
{
  const options = field.options ?? []
  const current = currentKey(field)
  const segments: SegmentOption<string>[] = options.map((option) => ({
    value: option.key,
    label: option.label,
    disabled: option.disabled,
    description: optionDescription(option)
  }))
  return (
    <SegmentedControl
      value={current}
      onChange={(key) =>
      {
        const option = options.find((entry) => entry.key === key)
        if (option !== undefined && key !== current)
        {
          void onPatch(patchOf(field, option.value))
        }
      }}
      options={segments}
      labelledBy={ids.caption}
      describedBy={described}
      disabled={field.disabled}
      error={field.error ?? undefined}
    />
  )
}

/**
 * A number, or the field's empty choice ("Auto", "Source width", "To the end") when it has one: the empty choice
 * reads as the field's placeholder and is a pressed toggle beside it, which a typed number releases.
 */
function NumberControl({ field, ids, describedBy: described, onPatch }: ControlProps): ReactElement
{
  const empty = (field.options ?? []).find((option) => option.value === null)
  const isEmpty = !field.mixed && field.value === null
  const input = (
    <NumberField
      id={ids.control}
      value={field.mixed ? null : (field.value as number | null)}
      onCommit={(value) => onPatch(patchOf(field, value))}
      step={field.range?.step ?? 1}
      min={field.range?.min}
      max={field.range?.max ?? undefined}
      unit={field.unit ?? undefined}
      valueText={field.key === 'crf' ? (value) => `CRF ${value}` : undefined}
      describedBy={described}
      nullLabel={field.mixed ? MIXED_LABEL : empty?.label}
      disabled={field.disabled}
      error={field.error ?? undefined}
      className="w-full min-w-0 flex-1"
    />
  )
  if (empty === undefined)
  {
    return input
  }
  return (
    <div className="flex items-start gap-2">
      {input}
      <Button
        variant="ghost"
        aria-pressed={isEmpty}
        aria-describedby={ids.caption}
        disabled={field.disabled}
        onClick={() =>
        {
          if (!isEmpty)
          {
            void onPatch(patchOf(field, null))
          }
        }}
      >
        {empty.label}
      </Button>
    </div>
  )
}

/** A short text value, such as a stream language: committed on Enter or blur, reverted by Escape. */
function TextControl({ field, ids, describedBy: described, onPatch }: ControlProps): ReactElement
{
  const committed = field.mixed ? '' : String(field.value ?? '')
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void =>
  {
    if (draft === null)
    {
      return
    }
    const next = draft.trim()
    setDraft(null)
    if (next !== '' && (field.mixed || next !== committed))
    {
      void onPatch(patchOf(field, next))
    }
  }
  return (
    <span className="flex flex-col gap-1">
      <input
        id={ids.control}
        type="text"
        value={draft ?? committed}
        placeholder={field.mixed ? MIXED_LABEL : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) =>
        {
          if (event.key === 'Enter')
          {
            event.preventDefault()
            commit()
          }
          else if (event.key === 'Escape' && draft !== null)
          {
            event.preventDefault()
            setDraft(null)
          }
        }}
        aria-describedby={[described, field.error ? ids.error : null].filter(Boolean).join(' ') || undefined}
        aria-invalid={field.error ? true : undefined}
        disabled={field.disabled}
        autoComplete="off"
        spellCheck={false}
        className={TEXT_FRAME}
      />
      {field.error ? <FieldMessage id={ids.error}>{field.error}</FieldMessage> : null}
    </span>
  )
}

const TEXT_FRAME = [
  'h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 text-body tabular-nums text-ink',
  'placeholder:text-ink-3 transition-colors duration-fast ease-out',
  'enabled:not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill',
  'disabled:border-line disabled:text-ink-disabled'
].join(' ')

/** Props of {@link RecipeField}. */
export interface RecipeFieldProps
{
  field: FieldState
  onPatch: PatchHandler
}

/**
 * One recipe field: its caption, the control its kind calls for, the distinct values behind "Mixed", the hint, the
 * consequence note, what locked jobs keep, and the field inside the checked option.
 */
export function RecipeField({ field, onPatch }: RecipeFieldProps): ReactElement
{
  const base = useId()
  const ids: FieldIds =
  {
    control: `${base}control`,
    caption: `${base}caption`,
    captionHint: `${base}caption-hint`,
    mixed: `${base}mixed`,
    hint: `${base}hint`,
    note: `${base}note`,
    consequences: `${base}consequences`,
    locked: `${base}locked`,
    error: `${base}error`
  }
  const hint = fieldHint(field)
  const consequences = optionNotes(field)
  const groupMixed = field.mixed && field.kind === 'segmented'
  const described = describedBy(field, ids, hint, consequences.length > 0, groupMixed ? [ids.captionHint] : [])
  const props: ControlProps = { field, ids, describedBy: described, onPatch }

  let control: ReactElement
  if (field.kind === 'checkbox')
  {
    control = (
      <Checkbox
        id={ids.control}
        checked={!field.mixed && field.value === true}
        indeterminate={field.mixed}
        onChange={(event) => void onPatch(patchOf(field, event.currentTarget.checked))}
        disabled={field.disabled && !field.reason}
        unavailableReason={field.disabled && field.reason ? field.reason : undefined}
        describedBy={described}
        error={field.error ?? undefined}
      >
        {field.label}
      </Checkbox>
    )
  }
  else if (field.kind === 'segmented' && field.options !== null)
  {
    control = <SegmentedField {...props} />
  }
  else if (field.kind === 'number')
  {
    control = <NumberControl {...props} />
  }
  else if (field.kind === 'input')
  {
    control = <TextControl {...props} />
  }
  else if (field.options !== null && field.kind !== 'text')
  {
    control = <SelectControl {...props} />
  }
  else
  {
    control = <p id={ids.control} aria-describedby={described} className="text-body tabular-nums text-ink">{field.text}</p>
  }

  return (
    <div className="flex min-w-0 flex-col" data-field={field.key}>
      {field.kind === 'checkbox'
        ? null
        : (
            <FieldCaption
              htmlFor={field.kind === 'segmented' || field.kind === 'text' ? undefined : ids.control}
              id={ids.caption}
              hint={groupMixed ? MIXED_LABEL : undefined}
              hintId={ids.captionHint}
            >
              {field.label}
            </FieldCaption>
          )}
      {control}
      <div className="mt-1.5 flex flex-col gap-1 empty:hidden">
        {field.mixed && field.mixedText
          ? <p id={ids.mixed} className="text-label tabular-nums text-ink-3">{field.mixedText}</p>
          : null}
        {hint ? <FieldMessage id={ids.hint} tone="note">{hint}</FieldMessage> : null}
        {field.note ? <FieldMessage id={ids.note} tone="note">{field.note}</FieldMessage> : null}
        {consequences.length > 0
          ? (
              <ul id={ids.consequences} className="flex flex-col gap-1 text-label text-ink-2">
                {consequences.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )
          : null}
        {field.lockedNote ? <FieldMessage id={ids.locked} tone="note">{field.lockedNote}</FieldMessage> : null}
      </div>
      {field.nested
        ? (
            <div className="mt-3 border-s border-line ps-3">
              <RecipeField field={field.nested} onPatch={onPatch} />
            </div>
          )
        : null}
    </div>
  )
}

function storageKey(scope: string): string
{
  return `molexMedia.recipe.moreSettings.${scope}`
}

function readOpen(scope: string): boolean
{
  try
  {
    return window.localStorage.getItem(storageKey(scope)) === 'open'
  }
  catch
  {
    return false
  }
}

function writeOpen(scope: string, open: boolean): void
{
  try
  {
    window.localStorage.setItem(storageKey(scope), open ? 'open' : 'closed')
  }
  catch
  {
    return
  }
}

/**
 * Whether a scope's "More settings" disclosure is open. The choice outlives the inspector and the session where the
 * browser keeps storage; without storage it holds for as long as the fields stay mounted.
 */
export function useMoreSettings(scope: string): [boolean, (open: boolean) => void]
{
  const [state, setState] = useState(() => ({ scope, open: readOpen(scope) }))
  const open = state.scope === scope ? state.open : readOpen(scope)
  const setOpen = useCallback((next: boolean) =>
  {
    writeOpen(scope, next)
    setState({ scope, open: next })
  }, [scope])
  return [open, setOpen]
}

/** Props of {@link MoreSettings}. */
export interface MoreSettingsProps
{
  /** Names the remembered state; one per operation. */
  scope: string
  children: ReactNode
}

/** The "More settings" disclosure: fields most recipes leave alone, open or closed as the user last left it. */
export function MoreSettings({ scope, children }: MoreSettingsProps): ReactElement
{
  const [open, setOpen] = useMoreSettings(scope)
  const regionId = useId()
  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="sm"
        icon={open ? 'action.collapse' : 'action.expand'}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className="-ms-2 self-start"
      >
        {open ? 'Fewer settings' : 'More settings'}
      </Button>
      <div id={regionId} hidden={!open} className={open ? 'flex flex-col gap-4' : undefined}>
        {open ? children : null}
      </div>
    </div>
  )
}

/** Props of {@link FieldStack}. */
export interface FieldStackProps extends VideoFieldsProps
{
  /** Names the remembered "More settings" state. */
  scope: string
  /** Fields shown behind "More settings" besides those the model marks; a field with an error is never hidden. */
  more: ReadonlySet<FieldKey>
}

/** An operation's fields in the model's order, the rarely changed ones behind "More settings". */
export function FieldStack({ fields, onPatch, scope, more }: FieldStackProps): ReactElement
{
  const rare = (field: FieldState): boolean => (field.more || more.has(field.key)) && field.error === null
  const hidden = fields.filter(rare)
  return (
    <div className="flex flex-col gap-4">
      {fields.filter((field) => !rare(field)).map((field) => <RecipeField key={field.key} field={field} onPatch={onPatch} />)}
      {hidden.length > 0
        ? (
            <MoreSettings scope={scope}>
              {hidden.map((field) => <RecipeField key={field.key} field={field} onPatch={onPatch} />)}
            </MoreSettings>
          )
        : null}
    </div>
  )
}

/** Convert fields most recipes leave alone, shown behind "More settings". */
export const CONVERT_MORE: ReadonlySet<FieldKey> = new Set<FieldKey>(['fps', 'pixelFormat', 'channels'])

/** The Convert fields of the Recipe tab: container, video, and audio, with frame rate, pixel format, and channels behind "More settings". */
export function ConvertFields({ fields, onPatch }: VideoFieldsProps): ReactElement
{
  return <FieldStack fields={fields} onPatch={onPatch} scope="convert" more={CONVERT_MORE} />
}
