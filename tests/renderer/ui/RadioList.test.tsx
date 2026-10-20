/**
 * RadioList: a vertical group of native radios in label rows, named by its caption, with descriptions
 * linked through aria-describedby, one Tab stop, Up and Down that move and check with wrap, a nested field
 * that is enabled only while its option is checked, and the mixed state with the "Mixed" hint.
 */
import React, { useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RadioList, type RadioListProps, type RadioOption } from '../../../src/renderer/src/ui/RadioList'
import { FieldCaption } from '../../../src/renderer/src/ui/FieldCaption'

type Reach = 'limit' | 'lower' | 'return'

const OPTIONS: ReadonlyArray<RadioOption<Reach>> = [
  {
    value: 'limit',
    label: 'Allow peak limiting up to',
    description: 'Keeps the target and limits peaks by up to the allowance.',
    field: <input type="text" aria-label="Limiting allowance" defaultValue="3" />
  },
  { value: 'lower', label: 'Lower the target', description: 'Keeps peaks clean and lands below the target.' },
  { value: 'return', label: 'Return the job', description: 'Leaves the file untouched and returns the job.' }
]

function Field(props: Partial<RadioListProps<Reach>> & { initial?: Reach | null }): ReactElement
{
  const { initial = 'limit', ...rest } = props
  const [value, setValue] = useState<Reach | null>(initial)
  const hint = value === null ? 'Mixed' : undefined
  return (
    <>
      <FieldCaption id="reach" hint={hint}>When the target is out of reach</FieldCaption>
      <RadioList
        value={value}
        options={OPTIONS}
        labelledBy="reach"
        describedBy={hint ? 'reach-hint' : undefined}
        {...rest}
        onChange={(next) =>
        {
          rest.onChange?.(next)
          setValue(next)
        }}
      />
    </>
  )
}

function radio(name: string): HTMLInputElement
{
  return screen.getByRole('radio', { name }) as HTMLInputElement
}

function tabStops(): HTMLElement[]
{
  return screen.getAllByRole('radio').filter((element) => element.tabIndex === 0)
}

describe('RadioList', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a radiogroup named by its caption, of native radios in label rows', () =>
  {
    render(<Field />)
    const group = screen.getByRole('radiogroup', { name: 'When the target is out of reach' })
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios).toHaveLength(3)
    for (const element of radios)
    {
      expect(group).toContainElement(element)
      expect(element.tagName).toBe('INPUT')
      expect(element).toHaveClass('ui-radio')
      expect(element.closest('label')).toHaveClass('min-h-(--size-target-min)')
      expect(element.name).toBe(radios[0].name)
    }
    expect(radio('Allow peak limiting up to')).toBeChecked()
  })

  it('links each description through aria-describedby and keeps it out of the name', () =>
  {
    render(<Field />)
    const lower = radio('Lower the target')
    expect(lower).toHaveAccessibleDescription('Keeps peaks clean and lands below the target.')
    const description = screen.getByText('Keeps peaks clean and lands below the target.')
    expect(description.closest('label')).toBeNull()
    expect(description).toHaveClass('text-label', 'text-ink-2')
  })

  it('has one Tab stop, on the checked option', () =>
  {
    render(<Field initial="lower" />)
    expect(tabStops()).toEqual([radio('Lower the target')])
  })

  it('moves and checks with Down and Up, wrapping', () =>
  {
    const onChange = vi.fn()
    render(<Field initial="lower" onChange={onChange} />)
    fireEvent.keyDown(radio('Lower the target'), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('return')
    expect(document.activeElement).toBe(radio('Return the job'))
    expect(radio('Return the job')).toBeChecked()
    fireEvent.keyDown(radio('Return the job'), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('limit')
    expect(document.activeElement).toBe(radio('Allow peak limiting up to'))
    fireEvent.keyDown(radio('Allow peak limiting up to'), { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('return')
    expect(tabStops()).toEqual([radio('Return the job')])
  })

  it('also moves with Left and Right, and skips disabled options', () =>
  {
    const onChange = vi.fn()
    const options = OPTIONS.map((option) => option.value === 'lower' ? { ...option, disabled: true } : option)
    render(<Field options={options} onChange={onChange} />)
    fireEvent.keyDown(radio('Allow peak limiting up to'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('return')
    fireEvent.keyDown(radio('Return the job'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('limit')
    expect(radio('Lower the target')).toBeDisabled()
    expect(radio('Lower the target').closest('label')).toHaveClass('text-ink-disabled')
  })

  it('enables the nested field only while its option is checked, after the radio in Tab order', () =>
  {
    render(<Field initial="lower" />)
    const allowance = screen.getByRole('textbox', { name: 'Limiting allowance' })
    expect(allowance).toBeDisabled()
    fireEvent.click(radio('Allow peak limiting up to'))
    expect(radio('Allow peak limiting up to')).toBeChecked()
    expect(allowance).toBeEnabled()
    expect(radio('Allow peak limiting up to').compareDocumentPosition(allowance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.keyDown(radio('Allow peak limiting up to'), { key: 'ArrowDown' })
    expect(allowance).toBeDisabled()
  })

  it('with a null value checks nothing, makes the first enabled option tabbable, and the hint reads Mixed', () =>
  {
    const options = OPTIONS.map((option) => option.value === 'limit' ? { ...option, disabled: true } : option)
    render(<Field initial={null} options={options} />)
    for (const element of screen.getAllByRole('radio'))
    {
      expect(element).not.toBeChecked()
    }
    expect(tabStops()).toEqual([radio('Lower the target')])
    const group = screen.getByRole('radiogroup', { name: 'When the target is out of reach' })
    expect(group).toHaveAccessibleDescription('Mixed')
    expect(document.getElementById('reach-hint')).toHaveTextContent('Mixed')
    expect(screen.getByRole('textbox', { name: 'Limiting allowance' })).toBeDisabled()
  })

  it('checks an option from the mixed state on click', () =>
  {
    const onChange = vi.fn()
    render(<Field initial={null} onChange={onChange} />)
    fireEvent.click(radio('Return the job'))
    expect(onChange).toHaveBeenCalledWith('return')
    expect(radio('Return the job')).toBeChecked()
  })

  it('shows and links the reason of a disabled option', () =>
  {
    const options: ReadonlyArray<RadioOption<Reach>> = [
      OPTIONS[0],
      { value: 'lower', label: 'Lower the target', disabled: true, disabledReason: 'Not available for a fixed preset target.' }
    ]
    render(<Field options={options} />)
    const lower = radio('Lower the target')
    expect(lower).toHaveAccessibleDescription('Not available for a fixed preset target.')
    expect(screen.getByText('Not available for a fixed preset target.')).toHaveClass('text-ink-3')
  })

  it('sets aria-invalid on the group and its radios and describes the group with the error', () =>
  {
    render(<Field error="Choose what happens for every job." />)
    const group = screen.getByRole('radiogroup', { name: 'When the target is out of reach' })
    expect(group).toHaveAttribute('aria-invalid', 'true')
    expect(group).toHaveAccessibleDescription('Choose what happens for every job.')
    expect(radio('Lower the target')).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables every option and field in a disabled group', () =>
  {
    render(<Field disabled />)
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-disabled', 'true')
    for (const element of screen.getAllByRole('radio'))
    {
      expect(element).toBeDisabled()
    }
    expect(tabStops()).toEqual([])
    expect(screen.getByRole('textbox', { name: 'Limiting allowance' })).toBeDisabled()
  })

  it('leaves modified and other keys alone, and stays put without another enabled option', () =>
  {
    const onChange = vi.fn()
    const options: ReadonlyArray<RadioOption<Reach>> = [
      { value: 'limit', label: 'Allow peak limiting up to' },
      { value: 'lower', label: 'Lower the target', disabled: true }
    ]
    render(<Field options={options} onChange={onChange} className="mt-2" />)
    const limit = radio('Allow peak limiting up to')
    expect(fireEvent.keyDown(limit, { key: 'ArrowDown', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(limit, { key: 'Home' })).toBe(true)
    fireEvent.keyDown(limit, { key: 'ArrowDown' })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(limit)
    expect(limit).not.toHaveAttribute('aria-describedby')
    expect(screen.getByRole('radiogroup').parentElement).toHaveClass('mt-2')
  })
})
