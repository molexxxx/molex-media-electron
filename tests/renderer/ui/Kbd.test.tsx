/**
 * Kbd: one keycap per key, named in the platform's own words through the shared key mapping, plus the
 * platform context, chord splitting, and the aria-keyshortcuts form of a chord.
 */
import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Kbd, PlatformProvider, ariaKeyShortcuts, detectPlatform, splitChord, usePlatform } from '../../../src/renderer/src/ui/Kbd'
import { formatKeys } from '../../../src/shared/text/platform'

function caps(container: HTMLElement): string[]
{
  return Array.from(container.querySelectorAll('kbd'), (kbd) => kbd.textContent ?? '')
}

function PlatformProbe(): React.ReactElement
{
  return <span data-testid="platform">{usePlatform()}</span>
}

describe('Kbd', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('renders one kbd per key joined by a plus sign in the tertiary ink', () =>
  {
    const { container } = render(<Kbd keys={['Mod', 'Shift', 'P']} platform="win32" />)
    expect(caps(container)).toEqual(['Ctrl', 'Shift', 'P'])
    expect(container.textContent).toBe('Ctrl+Shift+P')
    const separators = Array.from(container.querySelectorAll('span > span'))
    expect(separators).toHaveLength(2)
    for (const separator of separators)
    {
      expect(separator).toHaveTextContent('+')
      expect(separator).toHaveClass('text-ink-3')
    }
  })

  it('maps Mod to Cmd and Alt to Option on macOS through formatKeys', () =>
  {
    const { container } = render(<Kbd keys={['Mod', 'Alt', 'Enter']} platform="darwin" />)
    expect(caps(container)).toEqual(['Cmd', 'Option', 'Enter'])
    expect(container.textContent).toBe(formatKeys(['Mod', 'Alt', 'Enter'], 'darwin'))
  })

  it('maps Mod to Ctrl and keeps Alt on Windows and Linux', () =>
  {
    for (const platform of ['win32', 'linux'] as const)
    {
      const { container, unmount } = render(<Kbd keys={['Mod', 'Alt', 'Enter']} platform={platform} />)
      expect(caps(container)).toEqual(['Ctrl', 'Alt', 'Enter'])
      expect(container.textContent).toBe(formatKeys(['Mod', 'Alt', 'Enter'], platform))
      unmount()
    }
  })

  it('follows the delete chords of the platform', () =>
  {
    const { container, rerender } = render(<Kbd keys={['Shift', 'Delete']} platform="win32" />)
    expect(container.textContent).toBe('Shift+Delete')
    rerender(<Kbd keys={['Shift', 'Delete']} platform="darwin" />)
    expect(container.textContent).toBe('Cmd+Delete')
  })

  it('draws a single key without a separator', () =>
  {
    const { container } = render(<Kbd keys={['Space']} platform="win32" />)
    expect(caps(container)).toEqual(['Space'])
    expect(container.textContent).toBe('Space')
  })

  it('draws keycaps as label text on a raised fill with a strong border and a minimum width', () =>
  {
    const { container } = render(<Kbd keys={['F8']} platform="win32" className="ms-2" />)
    const kbd = container.querySelector('kbd') as HTMLElement
    expect(kbd).toHaveClass('text-label', 'text-ink-2', 'bg-raised', 'border', 'border-line-strong', 'rounded-xs', 'px-1.5', 'min-w-5')
    expect(container.firstElementChild).toHaveClass('ms-2')
  })

  it('reads the platform from the provider when no prop is given', () =>
  {
    const { container } = render(
      <PlatformProvider platform="darwin">
        <Kbd keys={['Mod', 'K']} />
        <PlatformProbe />
      </PlatformProvider>
    )
    expect(caps(container)).toEqual(['Cmd', 'K'])
    expect(screen.getByTestId('platform')).toHaveTextContent('darwin')
  })

  it('lets the prop win over the provider', () =>
  {
    const { container } = render(
      <PlatformProvider platform="darwin">
        <Kbd keys={['Mod', 'K']} platform="linux" />
      </PlatformProvider>
    )
    expect(caps(container)).toEqual(['Ctrl', 'K'])
  })
})

describe('detectPlatform', () =>
{
  it('reads macOS, Windows, and Linux user agents', () =>
  {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36')).toBe('darwin')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('win32')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('linux')
  })

  it('falls back to Windows for an unknown agent and reads the default agent', () =>
  {
    expect(detectPlatform('')).toBe('win32')
    expect(['win32', 'darwin', 'linux']).toContain(detectPlatform())
  })
})

describe('splitChord', () =>
{
  it('splits on plus signs and keeps a trailing plus key', () =>
  {
    expect(splitChord('Mod+Shift+P')).toEqual(['Mod', 'Shift', 'P'])
    expect(splitChord('Mod++')).toEqual(['Mod', '+'])
    expect(splitChord('+')).toEqual(['+'])
    expect(splitChord('F8')).toEqual(['F8'])
  })
})

describe('ariaKeyShortcuts', () =>
{
  it('writes Mod as Control, or Meta on macOS', () =>
  {
    expect(ariaKeyShortcuts(['Mod', 'Enter'], 'win32')).toBe('Control+Enter')
    expect(ariaKeyShortcuts(['Mod', 'Enter'], 'darwin')).toBe('Meta+Enter')
  })

  it('uses KeyboardEvent names for modifiers, arrows, and Escape', () =>
  {
    expect(ariaKeyShortcuts(['Ctrl', 'Alt', 'Up'], 'linux')).toBe('Control+Alt+ArrowUp')
    expect(ariaKeyShortcuts(['Cmd', 'Option', 'Left', 'Right', 'Down', 'Esc'], 'darwin')).toBe('Meta+Alt+ArrowLeft+ArrowRight+ArrowDown+Escape')
    expect(ariaKeyShortcuts(['Shift', 'Delete'], 'win32')).toBe('Shift+Delete')
  })
})
