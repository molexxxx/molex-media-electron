/**
 * The Normalize fields of the Recipe tab, and the loudness field rows Normalize and Gain share: a RangeField for the
 * target or the gain, NumberFields in dBTP and dB that hand their draft to the page before a primary action, the
 * out-of-reach policy as a RadioList whose nested allowance is enabled only while its option is checked, and the
 * mono, downmix, short-form, album, and output fields.
 */
import { createContext, useContext, useEffect, useId, useRef, type FocusEvent, type ReactElement } from 'react'
import { formatNumber, formatSigned, type FieldKey, type FieldPatch, type FieldState } from '../../../../stores/recipeFields'
import { FieldCaption } from '../../../../ui/FieldCaption'
import { FieldMessage, MIXED_LABEL, NumberField, type CommitDraftResult, type NumberFieldHandle } from '../../../../ui/NumberField'
import { RadioList, type RadioOption } from '../../../../ui/RadioList'
import { RangeField, type RangeFieldHandle } from '../../../../ui/RangeField'
import { fieldHint, MoreSettings, optionNotes, RecipeField, type PatchHandler, type VideoFieldsProps } from './ConvertFields'

/** Receives the focused draft field, so a primary action commits what the field shows before it runs. */
export interface DraftRegistry
{
  /** Registers the focused field's commit under its caption; the returned function releases it. */
  register(label: string, commitDraft: () => Promise<CommitDraftResult>): () => void
}

/** The Recipe tab's draft registry; a field outside one commits on blur and Enter only. */
export const DraftRegistryContext = createContext<DraftRegistry | null>(null)

function isThenable(value: unknown): value is PromiseLike<unknown>
{
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/** What a draft field row wires into its control: the commit it sends, and the focus handlers of its box. */
export interface DraftField
{
  send(value: number): void | PromiseLike<unknown>
  onFocus(): void
  onBlur(event: FocusEvent<HTMLElement>): void
}

/**
 * Registers a draft field with the Recipe tab while focus is inside its box. Focus leaving the box releases it once
 * the commit the blur sent has settled, so a primary action pressed with the pointer still waits for that commit.
 */
export function useDraftField(field: FieldState, onPatch: PatchHandler, commitDraft: () => Promise<CommitDraftResult>): DraftField
{
  const registry = useContext(DraftRegistryContext)
  const release = useRef<(() => void) | null>(null)
  const flight = useRef<PromiseLike<unknown> | null>(null)
  const commitRef = useRef(commitDraft)
  useEffect(() =>
  {
    commitRef.current = commitDraft
  })
  useEffect(() => () =>
  {
    release.current?.()
    release.current = null
  }, [])
  return {
    send(value: number)
    {
      const result = onPatch({ field: field.key, value } as FieldPatch)
      if (isThenable(result))
      {
        flight.current = result
      }
      return result
    },
    onFocus()
    {
      if (registry !== null && release.current === null)
      {
        release.current = registry.register(field.label, () => commitRef.current())
      }
    },
    onBlur(event: FocusEvent<HTMLElement>)
    {
      const next = event.relatedTarget as Node | null
      if (next !== null && event.currentTarget.contains(next))
      {
        return
      }
      const stop = release.current
      release.current = null
      if (stop === null)
      {
        return
      }
      setTimeout(() =>
      {
        const pending = flight.current
        if (pending === null)
        {
          stop()
          return
        }
        pending.then(stop, stop)
      }, 0)
    }
  }
}

/** The spoken and shown text of a value in a field's unit: "−16.0 LUFS", "+6.0 dB". */
export function valueText(field: Pick<FieldState, 'key' | 'unit' | 'range'>, value: number): string
{
  const decimals = decimalsOf(field.range?.step ?? 0.1)
  const number = field.key === 'gain' ? formatSigned(value, decimals) : formatNumber(value, decimals)
  return field.unit ? `${number} ${field.unit}` : number
}

function decimalsOf(step: number): number
{
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/** Props of the field rows. */
export interface FieldRowProps
{
  field: FieldState
  onPatch: PatchHandler
}

interface MessageIds
{
  mixed: string
  hint: string
  note: string
  consequences: string
  locked: string
}

function messageIds(base: string): MessageIds
{
  return { mixed: `${base}mixed`, hint: `${base}hint`, note: `${base}note`, consequences: `${base}consequences`, locked: `${base}locked` }
}

function describedIds(field: FieldState, ids: MessageIds, hint: string | null, consequences: boolean): string | undefined
{
  const parts = [
    field.mixed && field.mixedText ? ids.mixed : null,
    hint ? ids.hint : null,
    field.note ? ids.note : null,
    consequences ? ids.consequences : null,
    field.lockedNote ? ids.locked : null
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' ') : undefined
}

function FieldLines({ field, ids, hint, consequences }: { field: FieldState; ids: MessageIds; hint: string | null; consequences: string[] }): ReactElement
{
  return (
    <div className='mt-1.5 flex flex-col gap-1 empty:hidden'>
      {field.mixed && field.mixedText
        ? <p id={ids.mixed} className='text-label tabular-nums text-ink-3'>{field.mixedText}</p>
        : null}
      {hint ? <FieldMessage id={ids.hint} tone='note'>{hint}</FieldMessage> : null}
      {field.note ? <FieldMessage id={ids.note} tone='note'>{field.note}</FieldMessage> : null}
      {consequences.length > 0
        ? (
            <ul id={ids.consequences} className='flex flex-col gap-1 text-label text-ink-2'>
              {consequences.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )
        : null}
      {field.lockedNote ? <FieldMessage id={ids.locked} tone='note'>{field.lockedNote}</FieldMessage> : null}
    </div>
  )
}

function ValueRow({ field }: { field: FieldState }): ReactElement
{
  const base = useId()
  const ids = messageIds(base)
  const hint = fieldHint(field)
  return (
    <div className='flex min-w-0 flex-col' data-field={field.key}>
      <FieldCaption id={`${base}caption`}>{field.label}</FieldCaption>
      <p aria-labelledby={`${base}caption`} aria-describedby={describedIds(field, ids, hint, false)} className='text-body tabular-nums text-ink'>
        {field.text}
      </p>
      <FieldLines field={field} ids={ids} hint={hint} consequences={[]} />
    </div>
  )
}

/** A RangeField row: one slider gesture or one typed value is one patch, and its draft commits before a primary action. */
export function RangeRow({ field, onPatch }: FieldRowProps): ReactElement
{
  const handle = useRef<RangeFieldHandle>(null)
  const draft = useDraftField(field, onPatch, () => handle.current?.commitDraft() ?? Promise.resolve('unchanged'))
  const base = useId()
  const ids = messageIds(base)
  const range = field.range
  if (range === null || range.max === null)
  {
    return <ValueRow field={field} />
  }
  const hint = fieldHint(field)
  return (
    <div className='flex min-w-0 flex-col' data-field={field.key} onFocus={draft.onFocus} onBlur={draft.onBlur}>
      <RangeField
        ref={handle}
        id={`${base}control`}
        label={field.label}
        hint={hint ?? undefined}
        value={field.mixed ? null : field.value as number}
        mixedValue={field.mixed ? field.value as number : undefined}
        onCommit={(value) => draft.send(value)}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={field.unit ?? undefined}
        valueText={(value) => valueText(field, value)}
        describedBy={describedIds({ ...field, note: field.note }, ids, null, false)}
        disabled={field.disabled}
        error={field.error ?? undefined}
      />
      <FieldLines field={field} ids={ids} hint={null} consequences={[]} />
    </div>
  )
}

/** A NumberField row in its unit; its draft commits before a primary action. */
export function NumberRow({ field, onPatch }: FieldRowProps): ReactElement
{
  const handle = useRef<NumberFieldHandle>(null)
  const draft = useDraftField(field, onPatch, () => handle.current?.commitDraft() ?? Promise.resolve('unchanged'))
  const base = useId()
  const ids = messageIds(base)
  const hint = fieldHint(field)
  const range = field.range
  return (
    <div className='flex min-w-0 flex-col' data-field={field.key} onFocus={draft.onFocus} onBlur={draft.onBlur}>
      <FieldCaption htmlFor={`${base}control`} id={`${base}caption`}>{field.label}</FieldCaption>
      <NumberField
        ref={handle}
        id={`${base}control`}
        value={field.mixed ? null : field.value as number}
        nullLabel={field.mixed ? MIXED_LABEL : undefined}
        onCommit={(value) => draft.send(value)}
        step={range?.step ?? 0.1}
        min={range?.min}
        max={range?.max ?? undefined}
        unit={field.unit ?? undefined}
        valueText={(value) => valueText(field, value)}
        describedBy={describedIds(field, ids, hint, false)}
        disabled={field.disabled}
        error={field.error ?? undefined}
        className='w-36'
      />
      <FieldLines field={field} ids={ids} hint={hint} consequences={[]} />
    </div>
  )
}

/** Which option of a radio field holds its nested field. */
const NESTED_OWNER: Partial<Record<FieldKey, unknown>> = { allowance: 'peak-limit' }

/**
 * A RadioList row: each option with its description, and the nested field inside the option that owns it, enabled
 * only while that option is checked. A mixed value checks nothing and the caption's hint reads "Mixed".
 */
export function RadioRow({ field, onPatch }: FieldRowProps): ReactElement
{
  const base = useId()
  const ids = messageIds(base)
  const hint = fieldHint(field)
  const consequences = optionNotes(field)
  const options = field.options ?? []
  const nested = field.nested
  const checked = field.mixed ? null : options.find((option) => option.value === field.value)?.key ?? null
  const radio: RadioOption<string>[] = options.map((option) =>
  {
    const owns = nested !== null && NESTED_OWNER[nested.key] === option.value
    return {
      value: option.key,
      label: option.label,
      description: option.description ?? undefined,
      disabled: option.disabled,
      disabledReason: option.disabled ? option.reason ?? undefined : undefined,
      field: owns ? <NestedRow field={nested as FieldState} onPatch={onPatch} /> : undefined
    }
  })
  const described = [field.mixed ? `${base}caption-hint` : null, describedIds(field, ids, hint, consequences.length > 0) ?? null]
    .filter((part): part is string => part !== null).join(' ')
  return (
    <div className='flex min-w-0 flex-col' data-field={field.key}>
      <FieldCaption id={`${base}caption`} hint={field.mixed ? MIXED_LABEL : undefined} hintId={`${base}caption-hint`}>{field.label}</FieldCaption>
      <RadioList
        value={checked}
        onChange={(key) =>
        {
          const option = options.find((entry) => entry.key === key)
          if (option !== undefined)
          {
            void onPatch({ field: field.key, value: option.value } as FieldPatch)
          }
        }}
        options={radio}
        labelledBy={`${base}caption`}
        describedBy={described === '' ? undefined : described}
        disabled={field.disabled}
        error={field.error ?? undefined}
      />
      <FieldLines field={field} ids={ids} hint={hint} consequences={consequences} />
    </div>
  )
}

function NestedRow({ field, onPatch }: FieldRowProps): ReactElement
{
  return field.kind === 'number' ? <NumberRow field={field} onPatch={onPatch} /> : <RecipeField field={field} onPatch={onPatch} />
}

/**
 * One loudness field drawn by its kind: RangeField, NumberField, and RadioList rows here, every other kind through the
 * shared recipe field renderer. A segmented field states its checked option's description under it.
 */
export function AudioField({ field, onPatch }: FieldRowProps): ReactElement
{
  if (field.kind === 'range')
  {
    return <RangeRow field={field} onPatch={onPatch} />
  }
  if (field.kind === 'number')
  {
    return <NumberRow field={field} onPatch={onPatch} />
  }
  if (field.kind === 'radio' && field.options !== null)
  {
    return <RadioRow field={field} onPatch={onPatch} />
  }
  return <RecipeField field={withCheckedHint(field)} onPatch={onPatch} />
}

/** A segmented field with its checked option's description as its hint, so a choice says what it does. */
export function withCheckedHint(field: FieldState): FieldState
{
  if (field.kind !== 'segmented' || field.mixed || field.hint !== null)
  {
    return field
  }
  const description = field.options?.find((option) => option.value === field.value)?.description ?? null
  return description === null ? field : { ...field, hint: description }
}

/** A heading over a group of fields. */
export interface FieldGroup
{
  heading: string
  keys: readonly FieldKey[]
}

/** The Normalize groups in page order; fields the model leaves out are skipped, and empty groups are not drawn. */
export const NORMALIZE_GROUPS: readonly FieldGroup[] =
[
  { heading: 'Loudness', keys: ['target', 'truePeak'] },
  { heading: 'Output format', keys: ['output', 'bitrate'] }
]

/** Normalize fields most recipes leave alone, shown behind "More settings". */
export const NORMALIZE_MORE: ReadonlySet<FieldKey> = new Set<FieldKey>(['cinematic', 'policy', 'shortForm', 'mono', 'downmix', 'album'])

/** Props of {@link GroupedFields}. */
export interface GroupedFieldsProps extends VideoFieldsProps
{
  groups: readonly FieldGroup[]
  /** Names the remembered "More settings" state. */
  scope: string
  more: ReadonlySet<FieldKey>
  /** Rows drawn after a field, such as the predicted peak limiting line under Gain. */
  after?: Partial<Record<FieldKey, ReactElement | null>>
}

/** Fields under sentence-case headings in the groups' order, the rare ones behind "More settings". */
export function GroupedFields({ fields, onPatch, groups, scope, more, after = {} }: GroupedFieldsProps): ReactElement
{
  const rare = (field: FieldState): boolean => (field.more || more.has(field.key)) && field.error === null
  const placed = new Set<FieldKey>(groups.flatMap((group) => group.keys))
  const sections = groups
    .map((group) => ({ heading: group.heading, fields: group.keys.map((key) => fields.find((field) => field.key === key)).filter((field): field is FieldState => field !== undefined && !rare(field)) }))
    .filter((section) => section.fields.length > 0)
  const loose = fields.filter((field) => !placed.has(field.key) && !rare(field))
  const hidden = fields.filter(rare)
  const row = (field: FieldState): ReactElement => (
    <div key={field.key} className='flex flex-col gap-3'>
      <AudioField field={field} onPatch={onPatch} />
      {after[field.key] ?? null}
    </div>
  )
  return (
    <div className='flex flex-col gap-6'>
      {sections.map((section) => (
        <section key={section.heading} className='flex flex-col gap-4'>
          <h3 className='type-legend text-accent-ink'>{section.heading}</h3>
          {section.fields.map(row)}
        </section>
      ))}
      {loose.length > 0 ? <div className='flex flex-col gap-4'>{loose.map(row)}</div> : null}
      {hidden.length > 0
        ? (
            <MoreSettings scope={scope}>
              {hidden.map(row)}
            </MoreSettings>
          )
        : null}
    </div>
  )
}

/** The Normalize fields of the Recipe tab: loudness, channels, output, and album, with cinematic content behind "More settings". */
export function NormalizeFields({ fields, onPatch }: VideoFieldsProps): ReactElement
{
  return <GroupedFields fields={fields} onPatch={onPatch} groups={NORMALIZE_GROUPS} scope='normalize' more={NORMALIZE_MORE} />
}
