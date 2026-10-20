/**
 * Settings, Application: the Accessibility group with Interface size (90 to 200 percent, written as
 * `interfaceScale`) and the opt-in "Announce batch progress every 30 seconds" switch (`announceProgress`,
 * off by default), both named by their row labels and described by their hints.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import {
  ApplicationSettings,
  INTERFACE_SIZES,
  interfaceSizeOptions
} from '../../../src/renderer/src/components/settings/tabs/ApplicationSettings'
import type { AppConfig } from '../../../src/renderer/src/stores/types'

function config(overrides: Partial<AppConfig> = {}): AppConfig
{
  return {
    autoUpdate: true,
    minimizeToTray: true,
    showTrayNotification: true,
    sidebarCollapsed: false,
    showNotifications: true,
    ffmpegPath: '',
    ffprobePath: '',
    ytdlpBrowser: '',
    interfaceScale: 100,
    announceProgress: false,
    ...overrides
  } as AppConfig
}

function renderTab(overrides: Partial<AppConfig> = {}, partial = false): ReturnType<typeof vi.fn>
{
  const onUpdate = vi.fn()
  const value = config(overrides)
  if (partial)
  {
    delete (value as Partial<AppConfig>).interfaceScale
    delete (value as Partial<AppConfig>).announceProgress
  }
  render(<ApplicationSettings config={value} onUpdate={onUpdate} onResetDefaults={() => undefined} />)
  return onUpdate
}

function group(): HTMLElement
{
  return screen.getByRole('region', { name: 'Accessibility' })
}

beforeEach(() =>
{
  ;(window as unknown as { api: unknown }).api = {
    checkForUpdates: vi.fn(),
    openExternal: vi.fn()
  }
})

afterEach(() =>
{
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('interfaceSizeOptions', () =>
{
  it('offers 90, 100, 110, 125, 150, 175, and 200 percent', () =>
  {
    expect([...INTERFACE_SIZES]).toEqual([90, 100, 110, 125, 150, 175, 200])
    expect(interfaceSizeOptions(100).map((o) => o.label)).toEqual(['90%', '100%', '110%', '125%', '150%', '175%', '200%'])
  })

  it('keeps a stored size outside the list as its own choice, in order', () =>
  {
    expect(interfaceSizeOptions(130).map((o) => o.value)).toEqual(['90', '100', '110', '125', '130', '150', '175', '200'])
    expect(interfaceSizeOptions(Number.NaN)).toHaveLength(7)
  })
})

describe('Accessibility group', () =>
{
  it('sits in the Application tab under a brass legend', () =>
  {
    renderTab()
    const heading = within(group()).getByRole('heading', { name: 'Accessibility' })
    expect(heading).toHaveClass('type-legend', 'text-brass')
  })

  it('shows the Interface size setting and writes interfaceScale in percent', () =>
  {
    const onUpdate = renderTab({ interfaceScale: 125 })
    const size = within(group()).getByRole('combobox', { name: 'Interface size' }) as HTMLSelectElement
    expect(size.value).toBe('125')
    expect(size).toHaveAccessibleDescription(/Ctrl\+0 returns to this size/)
    fireEvent.change(size, { target: { value: '175' } })
    expect(onUpdate).toHaveBeenCalledWith('interfaceScale', 175)
  })

  it('offers the progress digest switch, off by default, and writes announceProgress', () =>
  {
    const onUpdate = renderTab({}, true)
    const digest = within(group()).getByRole('switch', { name: 'Announce batch progress every 30 seconds' })
    expect(digest).toHaveAttribute('aria-checked', 'false')
    expect(digest).toHaveAccessibleDescription(/focus is in Batch/)
    fireEvent.click(digest)
    expect(onUpdate).toHaveBeenCalledWith('announceProgress', true)
    expect((within(group()).getByRole('combobox', { name: 'Interface size' }) as HTMLSelectElement).value).toBe('100')
  })

  it('shows the digest on when the config has it on and turns it off', () =>
  {
    const onUpdate = renderTab({ announceProgress: true })
    const digest = within(group()).getByRole('switch', { name: 'Announce batch progress every 30 seconds' })
    expect(digest).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(digest)
    expect(onUpdate).toHaveBeenCalledWith('announceProgress', false)
  })

  it('keeps the rest of the tab in place', () =>
  {
    renderTab()
    for (const title of ['Updates', 'Window Behavior', 'Notifications', 'Paths', 'About'])
    {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
  })
})
