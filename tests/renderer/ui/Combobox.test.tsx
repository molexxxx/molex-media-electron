/**
 * Combobox: the APG combobox inside a popover, with its expanded state and active descendant, filtering
 * across captioned groups, Up and Down across groups, Enter and Shift+Enter carrying the modifier, Escape
 * closing back to the trigger, keycaps for option shortcuts, and the footer linked by aria-describedby.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { Combobox, type ComboboxGroup, type ComboboxOption, type ComboboxProps } from '../../../src/renderer/src/ui/Combobox'
import { Button } from '../../../src/renderer/src/ui/Button'
import * as primitives from '../../../src/renderer/src/ui'
import { ConfirmPopover } from '../../../src/renderer/src/ui/ConfirmPopover'
import { InlineConfirm } from '../../../src/renderer/src/ui/InlineConfirm'
import { SplitButton } from '../../../src/renderer/src/ui/SplitButton'

const GROUPS: ComboboxGroup[] = [
  {
    id: 'pinned',
    label: 'Pinned',
    options: [
      { id: 'ebu', label: 'EBU R 128 broadcast', description: 'Normalize to -23 LUFS', shortcut: 'Alt+1' },
      { id: 'podcast', label: 'Podcast loudness', description: 'Normalize to -16 LUFS', shortcut: 'Alt+2' }
    ]
  },
  {
    id: 'recent',
    label: 'Recently used',
    options: [
      { id: 'h264', label: 'Convert to H.264 MP4' },
      { id: 'gain', label: 'Gain +3 dB', disabled: true }
    ]
  },
  {
    id: 'presets',
    label: 'Your presets',
    options: [{ id: 'archive', label: 'Archive loudness check', shortcut: 'Alt+6' }]
  }
]

function byLabel(query: string, option: ComboboxOption): boolean
{
  return option.label.toLowerCase().includes(query.toLowerCase())
}

function footerFor(active: ComboboxOption | null): string
{
  return active ? `Applies to the 8 selected jobs: ${active.label}` : 'Nothing highlighted'
}

function setup(props: Partial<ComboboxProps> = {}): { trigger: HTMLElement, onChoose: ReturnType<typeof vi.fn> }
{
  const onChoose = vi.fn()
  render(
    <>
      <Combobox
        trigger={<Button>Set operation</Button>}
        label="Recipe"
        groups={GROUPS}
        filter={byLabel}
        onChoose={onChoose}
        emptyText="Nothing matches."
        footer={footerFor}
        {...props}
      />
      <button type="button">After</button>
    </>
  )
  return { trigger: screen.getByRole('button', { name: 'Set operation' }), onChoose }
}

function combobox(): HTMLInputElement
{
  return screen.getByRole('combobox', { hidden: true }) as HTMLInputElement
}

function open(trigger: HTMLElement): HTMLInputElement
{
  trigger.focus()
  fireEvent.click(trigger)
  return combobox()
}

function option(name: string): HTMLElement
{
  return screen.getByRole('option', { hidden: true, name })
}

function optionNames(): string[]
{
  return screen.queryAllByRole('option', { hidden: true }).map((element) => element.querySelector('span > span')?.textContent ?? '')
}

function activeName(input: HTMLInputElement): string | null
{
  const id = input.getAttribute('aria-activedescendant')
  return id ? document.getElementById(id)?.querySelector('span > span')?.textContent ?? null : null
}

function type(input: HTMLInputElement, value: string): void
{
  fireEvent.change(input, { target: { value } })
}

describe('Combobox', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a combobox input that controls a grouped listbox inside a popover', () =>
  {
    const onOpenChange = vi.fn()
    const { trigger } = setup({ onOpenChange, placeholder: 'Find a recipe', placement: 'end', className: 'w-96' })
    expect(combobox()).toHaveAttribute('aria-expanded', 'false')
    expect(combobox()).not.toHaveAttribute('aria-activedescendant')
    const input = open(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(input)
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-label', 'Recipe')
    expect(input).toHaveAttribute('placeholder', 'Find a recipe')
    const listbox = document.getElementById(input.getAttribute('aria-controls') as string) as HTMLElement
    expect(listbox).toHaveAttribute('role', 'listbox')
    expect(listbox).toHaveAttribute('aria-label', 'Recipe')
    const groups = within(listbox).getAllByRole('group', { hidden: true })
    expect(groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby') as string)?.textContent)).toEqual(['Pinned', 'Recently used', 'Your presets'])
    expect(within(groups[0]).getAllByRole('option', { hidden: true })).toHaveLength(2)
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(dialog).toHaveAttribute('data-placement', 'end')
    expect(dialog).toHaveClass('w-96')
    expect(dialog.contains(listbox)).toBe(true)
  })

  it('highlights the first enabled option through aria-activedescendant', () =>
  {
    const { trigger } = setup()
    const input = open(trigger)
    expect(activeName(input)).toBe('EBU R 128 broadcast')
    expect(option('EBU R 128 broadcast')).toHaveAttribute('aria-selected', 'true')
    expect(option('EBU R 128 broadcast')).toHaveAttribute('data-highlighted')
    expect(option('EBU R 128 broadcast')).toHaveClass('bg-wash-hover')
    expect(option('Podcast loudness')).toHaveAttribute('aria-selected', 'false')
    expect(option('Podcast loudness')).not.toHaveAttribute('data-highlighted')
    expect(option('EBU R 128 broadcast')).toHaveAccessibleDescription('Normalize to -23 LUFS')
  })

  it('starts on the first enabled match when the first match is disabled', () =>
  {
    const { trigger } = setup()
    const input = open(trigger)
    type(input, 'gain')
    expect(optionNames()).toEqual(['Gain +3 dB'])
    expect(activeName(input)).toBe('Gain +3 dB')
    type(input, '+3 dB')
    expect(activeName(input)).toBe('Gain +3 dB')
    type(input, 'a')
    expect(activeName(input)).toBe('EBU R 128 broadcast')
  })

  it('filters across groups as the user types and drops groups without matches', () =>
  {
    const filter = vi.fn(byLabel)
    const { trigger } = setup({ filter })
    const input = open(trigger)
    type(input, '  loudness ')
    expect(filter).toHaveBeenCalledWith('loudness', expect.objectContaining({ id: 'ebu' }))
    expect(optionNames()).toEqual(['Podcast loudness', 'Archive loudness check'])
    const captions = screen.getAllByRole('group', { hidden: true }).map((group) => document.getElementById(group.getAttribute('aria-labelledby') as string)?.textContent)
    expect(captions).toEqual(['Pinned', 'Your presets'])
    expect(activeName(input)).toBe('Podcast loudness')
    type(input, '')
    expect(optionNames()).toHaveLength(5)
  })

  it('moves the highlight across groups with Up and Down, wrapping at both ends', () =>
  {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { trigger } = setup()
    const input = open(trigger)
    const visited: Array<string | null> = []
    for (let step = 0; step < 5; step++)
    {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      visited.push(activeName(input))
    }
    expect(visited).toEqual(['Podcast loudness', 'Convert to H.264 MP4', 'Gain +3 dB', 'Archive loudness check', 'EBU R 128 broadcast'])
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeName(input)).toBe('Archive loudness check')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeName(input)).toBe('Gain +3 dB')
    expect(option('Gain +3 dB')).toHaveAttribute('aria-disabled', 'true')
    scroll.mockRestore()
  })

  it('leaves modified arrows and caret keys to the input', () =>
  {
    const { trigger } = setup()
    const input = open(trigger)
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(true)
    expect(activeName(input)).toBe('EBU R 128 broadcast')
  })

  it('chooses with Enter, closes, and returns focus to the trigger', () =>
  {
    const { trigger, onChoose } = setup()
    const input = open(trigger)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(onChoose).toHaveBeenCalledWith('ebu', { shift: false })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('chooses with the shift modifier on Shift+Enter', () =>
  {
    const { trigger, onChoose } = setup()
    const input = open(trigger)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onChoose).toHaveBeenCalledWith('podcast', { shift: true })
    expect(document.activeElement).toBe(trigger)
  })

  it('does not choose a disabled option', () =>
  {
    const { trigger, onChoose } = setup()
    const input = open(trigger)
    type(input, 'gain')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(option('Gain +3 dB'))
    expect(onChoose).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes on Escape, returns focus to the trigger, and starts over on the next open', () =>
  {
    const onOpenChange = vi.fn()
    const { trigger, onChoose } = setup({ onOpenChange })
    let input = open(trigger)
    type(input, 'pod')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onChoose).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
    input = open(trigger)
    expect(input.value).toBe('')
    expect(optionNames()).toHaveLength(5)
    expect(activeName(input)).toBe('EBU R 128 broadcast')
  })

  it('links the footer through aria-describedby and keeps it on the highlighted option', () =>
  {
    const { trigger } = setup()
    const input = open(trigger)
    const footer = document.getElementById(input.getAttribute('aria-describedby') as string) as HTMLElement
    expect(footer).toHaveAttribute('aria-live', 'polite')
    expect(footer).toHaveTextContent('Applies to the 8 selected jobs: EBU R 128 broadcast')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(footer).toHaveTextContent('Applies to the 8 selected jobs: Podcast loudness')
  })

  it('takes a static footer, and links nothing without one', () =>
  {
    const { trigger } = setup({ footer: 'Applies to the selection' })
    const input = open(trigger)
    expect(document.getElementById(input.getAttribute('aria-describedby') as string)).toHaveTextContent('Applies to the selection')
    cleanup()
    const second = setup({ footer: undefined })
    expect(open(second.trigger)).not.toHaveAttribute('aria-describedby')
  })

  it('shows the empty text when nothing matches', () =>
  {
    const { trigger, onChoose } = setup()
    const input = open(trigger)
    type(input, 'zzz')
    expect(optionNames()).toEqual([])
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(document.getElementById(input.getAttribute('aria-controls') as string)).toHaveAttribute('hidden')
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('Nothing matches.')
    expect(document.getElementById(input.getAttribute('aria-describedby') as string)).toHaveTextContent('Nothing highlighted')
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('keeps the status empty while options match', () =>
  {
    const { trigger } = setup()
    open(trigger)
    expect(screen.getByRole('status', { hidden: true })).toBeEmptyDOMElement()
  })

  it('shows option keys as keycaps and exposes them as aria-keyshortcuts', () =>
  {
    const { trigger } = setup()
    open(trigger)
    const archive = option('Archive loudness check')
    expect(archive).toHaveAttribute('aria-keyshortcuts', 'Alt+6')
    const caps = Array.from(archive.querySelectorAll('kbd')).map((cap) => cap.textContent)
    expect(caps).toEqual(['Alt', '6'])
    expect(archive.querySelector('kbd')?.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(option('Convert to H.264 MP4')).not.toHaveAttribute('aria-keyshortcuts')
    expect(option('Convert to H.264 MP4').querySelector('kbd')).toBeNull()
  })

  it('chooses with a click, carrying Shift, and follows the pointer', () =>
  {
    const { trigger, onChoose } = setup()
    const input = open(trigger)
    const listbox = document.getElementById(input.getAttribute('aria-controls') as string) as HTMLElement
    expect(fireEvent.mouseDown(option('Convert to H.264 MP4'))).toBe(false)
    expect(fireEvent.mouseDown(document.getElementById(input.getAttribute('aria-describedby') as string) as HTMLElement)).toBe(false)
    expect(fireEvent.mouseDown(input)).toBe(true)
    expect(listbox.contains(option('Convert to H.264 MP4'))).toBe(true)
    fireEvent.pointerMove(option('Convert to H.264 MP4'))
    expect(activeName(input)).toBe('Convert to H.264 MP4')
    fireEvent.click(option('Convert to H.264 MP4'), { shiftKey: true })
    expect(onChoose).toHaveBeenCalledWith('h264', { shift: true })
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the highlight on the same option when the groups rerender', () =>
  {
    const onChoose = vi.fn()
    const { rerender } = render(
      <Combobox trigger={<Button>Set operation</Button>} label="Recipe" groups={GROUPS} filter={byLabel} onChoose={onChoose} emptyText="Nothing matches." />
    )
    const input = open(screen.getByRole('button', { name: 'Set operation' }))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    rerender(<Combobox trigger={<Button>Set operation</Button>} label="Recipe" groups={[...GROUPS]} filter={byLabel} onChoose={onChoose} emptyText="Nothing matches." />)
    expect(activeName(combobox())).toBe('Podcast loudness')
  })
})

/** One export of every primitive module, from the class helper to the batch page's additions. */
const PRIMITIVE_EXPORTS = [
  'cx', 'showPopover', 'readToken', 'ICONS', 'Icon', 'Button', 'IconButton', 'SegmentedControl', 'Select', 'Slider',
  'NumberField', 'RangeField', 'Switch', 'Checkbox', 'Tooltip', 'Popover', 'Menu', 'Dialog', 'ToastRegion', 'Banner',
  'ProgressBar', 'DataGrid', 'useGridSelection', 'Tabs', 'Kbd', 'FieldCaption', 'CatalogNumber', 'StatusLabel',
  'StageTrack', 'Stamp', 'VisuallyHidden', 'CapsText', 'LiveRegion', 'RadioList', 'SplitButton', 'InlineConfirm',
  'ConfirmPopover', 'Splitter', 'Combobox'
] as const

describe('primitive barrel', () =>
{
  it.each(PRIMITIVE_EXPORTS)('re-exports %s', (name) =>
  {
    expect((primitives as Record<string, unknown>)[name]).toBeDefined()
  })

  it('re-exports the batch page primitives as the modules define them', () =>
  {
    expect(primitives.Combobox).toBe(Combobox)
    expect(primitives.ConfirmPopover).toBe(ConfirmPopover)
    expect(primitives.InlineConfirm).toBe(InlineConfirm)
    expect(primitives.SplitButton).toBe(SplitButton)
  })
})
