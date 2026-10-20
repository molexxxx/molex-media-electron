import { useId, type ChangeEvent, type ReactElement, type Ref } from 'react'
import { cx } from './cx'
import { FieldMessage, MIXED_LABEL } from './NumberField'

/** One choice of a {@link Select}. The label is plain text: secondary facts belong in it or in a hint. */
export interface SelectOption
{
  /** Never the empty string, which the placeholder option holds. */
  value: string
  label: string
  disabled?: boolean
}

/** A run of options under a caption, drawn as an `optgroup`. */
export interface SelectGroup
{
  group: string
  options: SelectOption[]
}

/** Props for {@link Select}. */
export interface SelectProps
{
  /** The chosen value; null while the selected jobs disagree or before a first choice. */
  value: string | null
  /** Receives the chosen value; the placeholder option can never be chosen back. */
  onChange(value: string): void
  options: Array<SelectOption | SelectGroup>
  id?: string
  /** An accessible name for a select without a visible caption. */
  label?: string
  labelledBy?: string
  describedBy?: string
  /** `md` is 32 px tall, `sm` 24 px. */
  size?: 'sm' | 'md'
  disabled?: boolean
  error?: string
  /** The selected, unchoosable first option while `value` is null, such as "Choose a preset" or "Loading presets". */
  nullLabel?: string
  /** Classes for the outer box that holds the select and its message; set the width here. */
  className?: string
  ref?: Ref<HTMLSelectElement>
}

function isGroup(entry: SelectOption | SelectGroup): entry is SelectGroup
{
  return 'group' in entry
}

function renderOption(option: SelectOption): ReactElement
{
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  )
}

/**
 * A native select drawn as a customizable select, with native keyboard, typeahead, and combobox semantics.
 * A null value renders a selected, disabled first option reading `nullLabel` ("Mixed"), so no one job's
 * value reads as shared; a value missing from the options shows itself the same way instead of the first
 * option. Options and groups are plain text, as the select's content model requires.
 */
export function Select({
  value,
  onChange,
  options,
  id,
  label,
  labelledBy,
  describedBy,
  size = 'md',
  disabled,
  error,
  nullLabel = MIXED_LABEL,
  className,
  ref
}: SelectProps): ReactElement
{
  const errorId = useId()
  const selected = value !== null && options.some((entry) => isGroup(entry)
    ? entry.options.some((option) => option.value === value)
    : entry.value === value)
    ? value
    : null
  const placeholder = selected === null ? value ?? nullLabel : null

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void =>
  {
    const next = event.currentTarget.value
    if (next !== '')
    {
      onChange(next)
    }
  }

  return (
    <span className={cx('inline-flex flex-col gap-1', className)}>
      <select
        ref={ref}
        id={id}
        value={selected ?? ''}
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={cx(describedBy, error && errorId) || undefined}
        aria-invalid={Boolean(error) || undefined}
        data-size={size}
        className="ui-select w-full"
        onChange={handleChange}
      >
        {placeholder !== null && <option value="" disabled>{placeholder}</option>}
        {options.map((entry) => isGroup(entry)
          ? (
            <optgroup key={`group:${entry.group}`} label={entry.group}>
              {entry.options.map(renderOption)}
            </optgroup>
          )
          : renderOption(entry))}
      </select>
      {error && <FieldMessage id={errorId}>{error}</FieldMessage>}
    </span>
  )
}
