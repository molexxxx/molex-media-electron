/**
 * IconButton: named by its label alone, with the glyph hidden and the tooltip repeating the label out of the
 * accessibility tree; the toggle, shortcut, size, and variant contracts; and the development guard against
 * a missing name.
 */
import React, { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { IconButton, type IconButtonVariant } from '../../../src/renderer/src/ui/IconButton'
import { IconProvider } from '../../../src/renderer/src/ui/Icon'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'

function classesOf(element: Element): string[]
{
  return element.className.split(/\s+/).filter(Boolean)
}

function feedbackClasses(element: Element): string[]
{
  return classesOf(element).filter((name) => name.startsWith('hover:') || name.startsWith('active:'))
}

function keyboardFocus(element: HTMLElement): void
{
  fireEvent.keyDown(document.body, { key: 'Tab' })
  act(() =>
  {
    element.focus()
  })
}

describe('IconButton', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.restoreAllMocks()
  })

  it('is a native button of type button named by its label, with the ghost md defaults', () =>
  {
    render(<IconButton label="Open settings" icon="action.more" />)
    const button = screen.getByRole('button', { name: 'Open settings' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-label', 'Open settings')
    expect(button).toHaveAccessibleName('Open settings')
    expect(button).toHaveAttribute('data-variant', 'ghost')
    expect(button).toHaveAttribute('data-size', 'md')
    expect(button).toHaveClass('ui-icon-button', 'size-(--size-control-md)', 'rounded-sm', 'bg-transparent', 'text-ink-2')
    expect(button).not.toHaveAttribute('aria-pressed')
    expect(button).not.toHaveAttribute('aria-keyshortcuts')
    expect(button).not.toHaveAttribute('data-focus')
  })

  it('hides its glyph from assistive technology', () =>
  {
    render(
      <IconProvider>
        <IconButton label="Close" icon="action.close" />
      </IconProvider>
    )
    const svg = screen.getByRole('button', { name: 'Close' }).querySelector('svg') as SVGElement
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('data-icon', 'action.close')
  })

  it('throws on an empty label in development', () =>
  {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<IconButton label="" icon="action.close" />)).toThrow(/label/)
    expect(() => render(<IconButton label="   " icon="action.close" />)).toThrow(/label/)
  })

  it('sets aria-pressed only when pressed is defined, and draws the pressed frame', () =>
  {
    const { rerender } = render(<IconButton label="Loop" icon="action.more" pressed />)
    const button = screen.getByRole('button', { name: 'Loop' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveClass('border-line-control', 'bg-raised', 'text-ink')
    expect(button).not.toHaveClass('bg-accent')
    rerender(<IconButton label="Loop" icon="action.more" pressed={false} />)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveClass('bg-transparent', 'text-ink-2')
    rerender(<IconButton label="Loop" icon="action.more" />)
    expect(button).not.toHaveAttribute('aria-pressed')
  })

  it('sets aria-keyshortcuts from the shortcut in the platform words', () =>
  {
    const { rerender } = render(
      <PlatformProvider platform="win32">
        <IconButton label="Pause" icon="action.more" shortcut="Mod+P" />
      </PlatformProvider>
    )
    const button = screen.getByRole('button', { name: 'Pause' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+P')
    rerender(
      <PlatformProvider platform="darwin">
        <IconButton label="Pause" icon="action.more" shortcut="Mod+P" />
      </PlatformProvider>
    )
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+P')
  })

  it('shows the tooltip on keyboard focus, repeating the label and shortcut, hidden from assistive technology', () =>
  {
    render(
      <PlatformProvider platform="darwin">
        <IconButton label="Pause" icon="action.more" shortcut="Mod+P" />
      </PlatformProvider>
    )
    const button = screen.getByRole('button', { name: 'Pause' })
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).toHaveAttribute('aria-hidden', 'true')
    expect(button).not.toHaveAttribute('aria-describedby')
    keyboardFocus(button)
    expect(tip).toHaveAttribute('data-open')
    expect(tip).toHaveTextContent('PauseCmd+P')
    expect(button).toHaveAccessibleName('Pause')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('renders no tooltip when tooltip is false', () =>
  {
    render(<IconButton label="Pause" icon="action.more" tooltip={false} />)
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  })

  it('sizes the box from the scale and rings the caption size inward', () =>
  {
    const { rerender } = render(<IconButton label="Close window" icon="window.close" size="sm" />)
    const button = screen.getByRole('button', { name: 'Close window' })
    expect(button).toHaveClass('size-(--size-control-sm)')
    rerender(<IconButton label="Close window" icon="window.close" size="lg" />)
    expect(button).toHaveClass('size-10')
    rerender(<IconButton label="Close window" icon="window.close" size="caption" />)
    expect(button).toHaveAttribute('data-focus', 'inset')
    expect(button).toHaveAttribute('data-size', 'caption')
    expect(button).toHaveClass('h-(--size-titlebar)', 'w-11.5', 'rounded-none')
  })

  it('draws each variant from its own classes', () =>
  {
    const expected: Record<IconButtonVariant, string[]> = {
      ghost: ['bg-transparent', 'text-ink-2', 'hover:bg-wash-hover'],
      secondary: ['bg-raised', 'border-line-strong', 'text-ink', 'hover:bg-raised-hover'],
      danger: ['bg-raised', 'border-error-fill', 'text-error', 'hover:bg-danger-hover'],
      primary: ['bg-accent', 'text-on-accent', 'hover:bg-accent-hover']
    }
    for (const [variant, classes] of Object.entries(expected) as [IconButtonVariant, string[]][])
    {
      const { unmount } = render(<IconButton label="Act" icon="action.more" variant={variant} />)
      const button = screen.getByRole('button', { name: 'Act' })
      expect(button).toHaveAttribute('data-variant', variant)
      expect(classesOf(button)).toEqual(expect.arrayContaining(classes))
      unmount()
    }
  })

  it('draws the window close as a ghost caption that fills with the error fill on hover', () =>
  {
    render(<IconButton label="Close" icon="window.close" size="caption" variant="danger" />)
    const button = screen.getByRole('button', { name: 'Close' })
    expect(button).toHaveClass('bg-transparent', 'text-ink-2', 'hover:bg-error-fill', 'hover:text-ink')
    expect(button).not.toHaveClass('bg-raised')
  })

  it('blocks activation when disabled and drops the feedback classes', () =>
  {
    const onClick = vi.fn()
    render(<IconButton label="Remove" icon="action.close" variant="secondary" disabled onClick={onClick} />)
    const button = screen.getByRole('button', { name: 'Remove' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(button).toHaveClass('text-ink-disabled', 'border-line')
    expect(feedbackClasses(button)).toEqual([])
  })

  it('calls onClick, passes native attributes and a caller class, and forwards its ref', () =>
  {
    const onClick = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    render(<IconButton ref={ref} label="Add files" icon="action.more" onClick={onClick} className="ms-1" data-testid="add" />)
    const button = screen.getByTestId('add')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(button).toHaveClass('ms-1')
    expect(ref.current).toBe(button)
  })
})
