/**
 * Button primitive: native semantics, variant and size styling keyed to data attributes, native disabled
 * versus unavailable with a reason, the busy state with its width-locked label, registry icons drawn
 * through Icon in the app's one stroke, ref forwarding, and the class joiner it is built on.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Button, type ButtonVariant } from '../../../src/renderer/src/ui/Button'
import { IconProvider } from '../../../src/renderer/src/ui/Icon'
import { cx } from '../../../src/renderer/src/ui/cx'

function classesOf(element: Element): string[]
{
  return element.className.split(/\s+/).filter(Boolean)
}

function feedbackClasses(element: Element): string[]
{
  return classesOf(element).filter((name) => name.startsWith('hover:') || name.startsWith('active:'))
}

describe('cx', () =>
{
  it('joins truthy fragments with single spaces', () =>
  {
    expect(cx('a', 'b c', 'd')).toBe('a b c d')
  })

  it('skips falsy and empty fragments', () =>
  {
    const off = false
    expect(cx('a', off && 'b', null, undefined, 0, '', 'c')).toBe('a c')
  })

  it('returns an empty string when no fragment is truthy', () =>
  {
    expect(cx(false, null, undefined, '')).toBe('')
  })
})

describe('Button', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('renders a native button of type button with the secondary md defaults', () =>
  {
    render(<Button>Save preset</Button>)
    const button = screen.getByRole('button', { name: 'Save preset' })
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('data-variant', 'secondary')
    expect(button).toHaveAttribute('data-size', 'md')
    expect(classesOf(button)).toEqual(expect.arrayContaining(['h-(--size-control-md)', 'px-3', 'text-control', 'gap-1.5', 'rounded-sm', 'bg-raised', 'text-ink', 'border-line-strong']))
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).not.toHaveAttribute('aria-busy')
    expect(button).not.toHaveAttribute('aria-describedby')
  })

  it('passes an explicit type, native attributes, and a caller class through', () =>
  {
    render(<Button type="submit" id="start" name="action" className="flex-1">Start</Button>)
    const button = screen.getByRole('button', { name: 'Start' })
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toHaveAttribute('id', 'start')
    expect(button).toHaveAttribute('name', 'action')
    expect(classesOf(button)).toContain('flex-1')
  })

  it('draws each variant from its own classes and exposes it as data-variant', () =>
  {
    const expected: Record<ButtonVariant, string[]> = {
      primary: ['bg-accent', 'text-on-accent', 'border-transparent', 'font-semibold', 'hover:bg-accent-hover', 'active:bg-accent-pressed', 'active:inset-shadow-2xs/20'],
      secondary: ['bg-raised', 'text-ink', 'border-line-strong', 'hover:bg-raised-hover', 'active:bg-panel'],
      ghost: ['bg-transparent', 'text-ink-2', 'border-transparent', 'hover:bg-wash-hover', 'hover:text-ink', 'active:bg-wash-pressed'],
      danger: ['bg-raised', 'text-error', 'border-error-fill', 'hover:bg-danger-hover', 'active:bg-danger-pressed']
    }
    for (const variant of Object.keys(expected) as ButtonVariant[])
    {
      render(<Button variant={variant}>{variant}</Button>)
      const button = screen.getByRole('button', { name: variant })
      expect(button).toHaveAttribute('data-variant', variant)
      expect(classesOf(button)).toEqual(expect.arrayContaining(expected[variant]))
      cleanup()
    }
  })

  it('uses the small box with label text, medium weight, and the small gap', () =>
  {
    render(<Button size="sm">Retry</Button>)
    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).toHaveAttribute('data-size', 'sm')
    expect(classesOf(button)).toEqual(expect.arrayContaining(['h-(--size-control-sm)', 'px-2', 'text-label', 'font-medium', 'gap-1']))
    expect(classesOf(button)).not.toContain('text-control')
  })

  it('keeps the semibold accent label weight on a small primary button', () =>
  {
    render(<Button size="sm" variant="primary">Start</Button>)
    const classes = classesOf(screen.getByRole('button', { name: 'Start' }))
    expect(classes).toContain('font-semibold')
    expect(classes).not.toContain('font-medium')
  })

  it('calls onClick when it can act', () =>
  {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Add files</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('blocks activation with native disabled and draws the neutral disabled look', () =>
  {
    const onClick = vi.fn()
    render(<Button variant="primary" disabled onClick={onClick}>Start</Button>)
    const button = screen.getByRole('button', { name: 'Start' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    const classes = classesOf(button)
    expect(classes).toEqual(expect.arrayContaining(['bg-raised', 'text-ink-disabled', 'border-line']))
    expect(classes).not.toContain('bg-accent')
    expect(feedbackClasses(button)).toEqual([])
    expect(button).not.toHaveAttribute('aria-disabled')
  })

  it('draws every disabled variant without its rest fill or feedback', () =>
  {
    for (const variant of ['secondary', 'ghost', 'danger'] as ButtonVariant[])
    {
      render(<Button variant={variant} disabled>{variant}</Button>)
      const button = screen.getByRole('button', { name: variant })
      expect(classesOf(button)).toContain('text-ink-disabled')
      expect(classesOf(button)).not.toContain('text-error')
      expect(feedbackClasses(button)).toEqual([])
      cleanup()
    }
  })

  it('keeps an unavailable button focusable, ignores activation, and describes it with the reason', () =>
  {
    const onClick = vi.fn()
    const { container } = render(<Button variant="primary" unavailableReason="Add files to the queue first" onClick={onClick}>Run batch</Button>)
    const button = screen.getByRole('button', { name: 'Run batch' })
    expect(container.childElementCount).toBe(1)
    expect(button).toHaveAccessibleName('Run batch')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveAccessibleDescription('Add files to the queue first')
    expect(classesOf(button)).toEqual(expect.arrayContaining(['bg-raised', 'text-ink-disabled']))
    expect(feedbackClasses(button)).toEqual([])
  })

  it('lets an unavailable reason win over native disabled so the reason stays reachable', () =>
  {
    render(<Button disabled unavailableReason="Recipe locked while running">Edit</Button>)
    const button = screen.getByRole('button', { name: 'Edit' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription('Recipe locked while running')
  })

  it('treats an empty unavailable reason as available', () =>
  {
    const onClick = vi.fn()
    render(<Button unavailableReason="" onClick={onClick}>Go</Button>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not submit its form while unavailable, and does when it can act', () =>
  {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit" unavailableReason="Nothing to save">Save</Button>
      </form>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).not.toHaveBeenCalled()

    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('merges a caller description with the unavailable reason', () =>
  {
    render(
      <>
        <span id="selection-hint">Two jobs selected</span>
        <Button aria-describedby="selection-hint" unavailableReason="Recipe locked while running">Apply</Button>
      </>
    )
    const button = screen.getByRole('button', { name: 'Apply' })
    expect(button.getAttribute('aria-describedby')?.split(' ')[0]).toBe('selection-hint')
    expect(button).toHaveAccessibleDescription('Two jobs selected Recipe locked while running')
  })

  it('keeps a caller description alone when the button is available', () =>
  {
    render(
      <>
        <span id="hint">Applies to every selected job</span>
        <Button aria-describedby="hint">Apply</Button>
      </>
    )
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveAttribute('aria-describedby', 'hint')
  })

  it('marks a busy button, swaps to the loading label, keeps its look, and ignores activation', () =>
  {
    const onClick = vi.fn()
    render(<Button variant="primary" loading loadingLabel="Starting..." onClick={onClick}>Start</Button>)
    const button = screen.getByRole('button', { name: 'Starting...' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(classesOf(button)).toEqual(expect.arrayContaining(['bg-accent', 'text-on-accent']))
    expect(feedbackClasses(button)).toEqual([])
    const spinner = button.querySelector('svg')
    expect(spinner).toHaveAttribute('aria-hidden', 'true')
    expect(spinner?.getAttribute('class')).toContain('motion-safe:animate-spin')
  })

  it('stacks both labels in one grid cell so the width holds across the state change', () =>
  {
    const { rerender } = render(<Button loading={false} loadingLabel="Starting...">Start</Button>)
    const button = screen.getByRole('button', { name: 'Start' })
    const rows = button.querySelectorAll('.grid > span')
    expect(rows).toHaveLength(2)
    expect(rows[0]).not.toHaveAttribute('aria-hidden')
    expect(classesOf(rows[0])).not.toContain('invisible')
    expect(rows[1]).toHaveAttribute('aria-hidden', 'true')
    expect(classesOf(rows[1])).toContain('invisible')
    expect(rows[1]).toHaveTextContent('Starting...')
    expect(rows[1].querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin')

    rerender(<Button loading loadingLabel="Starting...">Start</Button>)
    expect(screen.getByRole('button', { name: 'Starting...' })).toBe(button)
    expect(rows[0]).toHaveAttribute('aria-hidden', 'true')
    expect(classesOf(rows[0])).toContain('invisible')
    expect(rows[1]).not.toHaveAttribute('aria-hidden')
    expect(classesOf(rows[1])).not.toContain('invisible')
  })

  it('falls back to its children as the loading label', () =>
  {
    render(<Button loading>Exporting</Button>)
    expect(screen.getByRole('button', { name: 'Exporting' })).toHaveAttribute('aria-busy', 'true')
  })

  it('renders no stacked rows when it never loads', () =>
  {
    render(<Button>Close</Button>)
    expect(screen.getByRole('button', { name: 'Close' }).querySelector('.grid')).toBeNull()
  })

  it('draws leading and trailing registry icons hidden from assistive technology at the size icon step', () =>
  {
    render(
      <IconProvider>
        <Button icon="action.export" iconEnd="action.next">Export report</Button>
      </IconProvider>
    )
    const button = screen.getByRole('button', { name: 'Export report' })
    const icons = button.querySelectorAll('svg')
    expect(icons).toHaveLength(2)
    for (const svg of icons)
    {
      expect(svg).toHaveAttribute('aria-hidden', 'true')
      expect(svg).toHaveAttribute('width', '16')
      expect(svg).toHaveAttribute('stroke-width', '2.25')
    }
    expect(icons[0]).toHaveAttribute('data-icon', 'action.export')
    expect(icons[0].getAttribute('class')).toContain('lucide-download')
    expect(icons[1]).toHaveAttribute('data-icon', 'action.next')
    expect(icons[1].getAttribute('class')).toContain('lucide-arrow-right')
    expect(button.firstElementChild).toBe(icons[0])
    expect(button.lastElementChild).toBe(icons[1])
    cleanup()

    render(
      <IconProvider>
        <Button size="sm" icon="action.export">Export</Button>
      </IconProvider>
    )
    const small = screen.getByRole('button', { name: 'Export' }).querySelector('svg')
    expect(small).toHaveAttribute('width', '14')
    expect(Number(small?.getAttribute('stroke-width'))).toBeCloseTo(1.5 * 24 / 14)
  })

  it('draws a trailing icon alone after the label', () =>
  {
    render(<Button iconEnd="action.openMenu">More</Button>)
    const button = screen.getByRole('button', { name: 'More' })
    expect(button.querySelectorAll('svg')).toHaveLength(1)
    expect(button.lastElementChild).toHaveAttribute('data-icon', 'action.openMenu')
  })

  it('swaps the leading icon for the spinner while busy', () =>
  {
    render(<Button icon="action.export" loading loadingLabel="Exporting...">Export</Button>)
    const button = screen.getByRole('button', { name: 'Exporting...' })
    const rows = button.querySelectorAll('.grid > span')
    expect(rows[0].querySelectorAll('svg')).toHaveLength(1)
    expect(rows[0].querySelector('svg')).toHaveAttribute('data-icon', 'action.export')
    expect(rows[1].querySelectorAll('svg')).toHaveLength(1)
    expect(rows[1].querySelector('svg')).toHaveAttribute('data-icon', 'status.active')
    expect(rows[1].querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
  })

  it('forwards its ref to the native button', () =>
  {
    const ref = React.createRef<HTMLButtonElement>()
    render(<Button ref={ref}>Open</Button>)
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Open' }))
  })
})

describe('Button unavailable reason tooltip', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  function keyboardFocus(element: HTMLElement): void
  {
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() =>
    {
      element.focus()
    })
  }

  it('exposes the reason through a tooltip inside the button that describes it', () =>
  {
    const { container } = render(<Button variant="primary" unavailableReason="Add files to the queue first">Run batch</Button>)
    const button = screen.getByRole('button', { name: 'Run batch' })
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(container.childElementCount).toBe(1)
    expect(button).toContainElement(tip)
    expect(tip).toHaveTextContent('Add files to the queue first')
    expect(tip).toHaveAttribute('aria-hidden', 'true')
    expect(button.getAttribute('aria-describedby')).toBe(tip.id)
    expect(button).toHaveAccessibleName('Run batch')
    expect(button).toHaveAccessibleDescription('Add files to the queue first')
  })

  it('shows the reason on keyboard focus and hides it on Escape with focus kept', () =>
  {
    render(<Button unavailableReason="Recipe locked while running">Edit</Button>)
    const button = screen.getByRole('button', { name: 'Edit' })
    const tip = screen.getByRole('tooltip', { hidden: true })
    keyboardFocus(button)
    expect(tip).toHaveAttribute('data-open')
    expect(fireEvent.keyDown(button, { key: 'Escape' })).toBe(false)
    expect(tip).not.toHaveAttribute('data-open')
    expect(document.activeElement).toBe(button)
  })

  it('renders no tooltip while it can act, and keeps the same focused element when the reason clears', () =>
  {
    const { rerender } = render(<Button unavailableReason="Nothing to save">Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    act(() =>
    {
      button.focus()
    })
    rerender(<Button>Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
    expect(button).not.toHaveAttribute('aria-describedby')
    rerender(<Button unavailableReason="Nothing to save">Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBe(button)
    expect(document.activeElement).toBe(button)
  })
})
