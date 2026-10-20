/**
 * Select: a native select drawn as a customizable select. It is found by its caption, renders groups and
 * options as plain text, reports changes, carries disabled, error, and merged descriptions, and renders a
 * null value as a selected, unchoosable "Mixed" option instead of presenting one job's value as shared.
 */
import React, { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { Select, type SelectProps } from '../../../src/renderer/src/ui/Select'

const OPTIONS: SelectProps['options'] = [
  { value: 'normalize', label: 'Normalize' },
  { value: 'boost', label: 'Boost' },
  {
    group: 'Video',
    options: [
      { value: 'convert', label: 'Convert' },
      { value: 'compress', label: 'Compress, CRF 23' },
      { value: 'gif', label: 'GIF', disabled: true }
    ]
  }
]

function renderSelect(props: Partial<SelectProps> = {}): { onChange: ReturnType<typeof vi.fn>, select: HTMLSelectElement, container: HTMLElement }
{
  const onChange = vi.fn()
  const { container } = render(
    <>
      <label htmlFor="operation">Operation</label>
      <span id="operation-hint">Applies to 3 jobs</span>
      <Select id="operation" value="boost" onChange={onChange} options={OPTIONS} {...props} />
    </>
  )
  return { onChange, select: screen.getByRole('combobox', { name: 'Operation' }) as HTMLSelectElement, container }
}

function optionTexts(select: HTMLSelectElement): string[]
{
  return Array.from(select.options).map((option) => option.text)
}

describe('Select', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a native combobox found by its caption label', () =>
  {
    const { select } = renderSelect()
    expect(select.tagName).toBe('SELECT')
    expect(select).toHaveClass('ui-select')
    expect(select).toHaveAttribute('data-size', 'md')
    expect(select).not.toHaveAttribute('size')
    expect(select).toHaveDisplayValue('Boost')
    expect(select.value).toBe('boost')
  })

  it('renders groups and options as plain text', () =>
  {
    const { select } = renderSelect()
    const group = select.querySelector('optgroup') as HTMLOptGroupElement
    expect(group).toHaveAttribute('label', 'Video')
    expect(within(group).getAllByRole('option').map((option) => option.textContent)).toEqual(['Convert', 'Compress, CRF 23', 'GIF'])
    expect(optionTexts(select)).toEqual(['Normalize', 'Boost', 'Convert', 'Compress, CRF 23', 'GIF'])
    for (const option of Array.from(select.options))
    {
      expect(Array.from(option.childNodes).every((node) => node.nodeType === Node.TEXT_NODE)).toBe(true)
    }
    expect(screen.getByRole('option', { name: 'GIF' })).toBeDisabled()
  })

  it('calls onChange with the chosen value', () =>
  {
    const { select, onChange } = renderSelect()
    fireEvent.change(select, { target: { value: 'convert' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('convert')
  })

  it('never reports the placeholder value', () =>
  {
    const { select, onChange } = renderSelect({ value: null })
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables the select natively', () =>
  {
    const { select } = renderSelect({ disabled: true })
    expect(select).toBeDisabled()
  })

  it('marks an error and describes the select with its message', () =>
  {
    const { select } = renderSelect({ error: 'Choose an operation for these jobs.' })
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select).toHaveAccessibleDescription('Choose an operation for these jobs.')
    expect(screen.getByText('Choose an operation for these jobs.')).toBeVisible()
  })

  it('merges describedBy with its own error id', () =>
  {
    const { select } = renderSelect({ describedBy: 'operation-hint', error: 'Choose an operation for these jobs.' })
    const ids = (select.getAttribute('aria-describedby') as string).split(' ')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('operation-hint')
    expect(select).toHaveAccessibleDescription('Applies to 3 jobs Choose an operation for these jobs.')
  })

  it('passes describedBy alone and stays valid without an error', () =>
  {
    const { select } = renderSelect({ describedBy: 'operation-hint' })
    expect(select).toHaveAttribute('aria-describedby', 'operation-hint')
    expect(select).not.toHaveAttribute('aria-invalid')
    expect(select).toHaveAccessibleDescription('Applies to 3 jobs')
  })

  it('renders a null value as a selected, disabled first option reading "Mixed" and no job\'s value', () =>
  {
    const { select } = renderSelect({ value: null })
    const first = select.options[0]
    expect(first.text).toBe('Mixed')
    expect(first.value).toBe('')
    expect(first).toBeDisabled()
    expect(first.selected).toBe(true)
    expect(select.value).toBe('')
    expect(select).toHaveDisplayValue('Mixed')
    expect(Array.from(select.options).filter((option) => option.selected)).toEqual([first])
  })

  it('reads the nullLabel while nothing is chosen yet', () =>
  {
    const { select } = renderSelect({ value: null, nullLabel: 'Choose a preset' })
    expect(select).toHaveDisplayValue('Choose a preset')
    expect(select.options[0]).toBeDisabled()
  })

  it('shows loading as a disabled select whose null label names it', () =>
  {
    const { select } = renderSelect({ value: null, nullLabel: 'Loading presets', disabled: true })
    expect(select).toBeDisabled()
    expect(select).toHaveDisplayValue('Loading presets')
  })

  it('renders no placeholder option for a real value', () =>
  {
    const { select } = renderSelect({ value: 'compress' })
    expect(select.options).toHaveLength(5)
    expect(optionTexts(select)).not.toContain('Mixed')
    expect(Array.from(select.options).some((option) => option.value === '')).toBe(false)
    expect(select).toHaveDisplayValue('Compress, CRF 23')
  })

  it('shows a value missing from the options instead of presenting the first option', () =>
  {
    const { select } = renderSelect({ value: 'retired-preset' })
    expect(select).toHaveDisplayValue('retired-preset')
    expect(select.options[0]).toBeDisabled()
    expect(select.options[0].selected).toBe(true)
    expect(select.options[1].selected).toBe(false)
  })

  it('names a select without a caption through label', () =>
  {
    render(<Select label="New files get" value="normalize" onChange={() => {}} options={OPTIONS} />)
    expect(screen.getByRole('combobox', { name: 'New files get' })).toHaveDisplayValue('Normalize')
  })

  it('takes its name from labelledBy', () =>
  {
    render(
      <>
        <span id="preset-caption">Preset</span>
        <Select labelledBy="preset-caption" value="boost" onChange={() => {}} options={OPTIONS} />
      </>
    )
    expect(screen.getByRole('combobox', { name: 'Preset' })).toBeInTheDocument()
  })

  it('sets the small size through data-size, never the native size attribute', () =>
  {
    const { select } = renderSelect({ size: 'sm' })
    expect(select).toHaveAttribute('data-size', 'sm')
    expect(select).not.toHaveAttribute('size')
  })

  it('puts className on the outer box and forwards the ref to the select', () =>
  {
    const ref = createRef<HTMLSelectElement>()
    const { select } = renderSelect({ className: 'w-48', ref })
    expect(ref.current).toBe(select)
    expect(select.parentElement).toHaveClass('w-48')
  })
})
