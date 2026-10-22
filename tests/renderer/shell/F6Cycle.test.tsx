/**
 * The shell in App: one notification region inside the work area after the views, the F6 cycle bound to
 * the window (rail, the visible view's regions or one work-area stop, then notifications when not empty,
 * Shift+F6 backward) that leaves a claimed key alone, the close confirmation above the initializing and
 * setup screens, and the zoom keys in the main window and the popout.
 */
import React, { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { useF6Region } from '../../../src/renderer/src/hooks/useF6Region'
import { clearToasts, toast } from '../../../src/renderer/src/ui/Toast'
import App from '../../../src/renderer/src/App'

function StubTitleBar(): React.JSX.Element
{
  return <header>molexMedia</header>
}

function StubSidebar(): React.JSX.Element
{
  return (
    <nav aria-label="Main">
      <button type="button">Batch</button>
      <button type="button" aria-current="page">Dashboard</button>
    </nav>
  )
}

function StubDashboard(): React.JSX.Element
{
  const tools = useRef<HTMLDivElement>(null)
  const recent = useRef<HTMLDivElement>(null)
  useF6Region('dashboard', [{ name: 'tools', ref: tools }, { name: 'recent', ref: recent }])
  return (
    <div>
      <div ref={tools}><button type="button">Normalize</button></div>
      <div ref={recent}><button type="button">Open log</button></div>
    </div>
  )
}

function StubBatch(): React.JSX.Element
{
  return (
    <section onKeyDown={(event) =>
    {
      if (event.key === 'F6')
      {
        event.preventDefault()
      }
    }}
    >
      <button type="button">Start</button>
    </section>
  )
}

function StubLogs(): React.JSX.Element
{
  return <div><button type="button">Filter</button></div>
}

function StubView(): React.JSX.Element
{
  return <div />
}

function StubSetup(): React.JSX.Element
{
  return <div><button type="button">Download FFmpeg</button></div>
}

function StubPopout(): React.JSX.Element
{
  return <div><button type="button">Play</button></div>
}

vi.mock('../../../src/renderer/src/hooks/useIPC', () => ({ useIPC: () => undefined }))
vi.mock('../../../src/renderer/src/components/layout', async () =>
{
  const { CloseConfirmModal } = await import('../../../src/renderer/src/components/layout/CloseConfirmModal')
  return { TitleBar: StubTitleBar, Sidebar: StubSidebar, CloseConfirmModal }
})
vi.mock('../../../src/renderer/src/components/layout/components/PopoutShell', () => ({ PopoutShell: StubPopout }))
vi.mock('../../../src/renderer/src/components/dashboard', () => ({ Dashboard: StubDashboard }))
vi.mock('../../../src/renderer/src/components/batch/BatchPage', () => ({ BatchPage: StubBatch }))
vi.mock('../../../src/renderer/src/components/settings', () => ({ Settings: StubView }))
vi.mock('../../../src/renderer/src/components/logs', () => ({ LogViewer: StubLogs }))
vi.mock('../../../src/renderer/src/components/editor', () => ({ MediaEditor: StubView }))
vi.mock('../../../src/renderer/src/components/player', () => ({ MediaPlayer: StubView }))
vi.mock('../../../src/renderer/src/components/setup', () => ({ SetupWizard: StubSetup }))

let openRequest: (() => void) | null = null
const api = {
  onUpdaterStatus: () => () => undefined,
  getUpdaterStatus: () => Promise.resolve(null),
  getFilePath: () => '',
  showTextContextMenu: vi.fn(),
  onCloseConfirm: (cb: () => void) =>
  {
    openRequest = cb
    return () => undefined
  },
  closeConfirmResponse: vi.fn(),
  zoomIn: vi.fn(() => 1.1),
  zoomOut: vi.fn(() => 0.9),
  setZoomFactor: vi.fn((factor: number) => factor)
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent
{
  const target = document.activeElement ?? document.body
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() =>
  {
    target.dispatchEvent(event)
  })
  return event
}

function focused(): string
{
  const active = document.activeElement as HTMLElement | null
  return active?.getAttribute('aria-label') ?? active?.textContent ?? ''
}

function notifications(): HTMLElement
{
  return screen.getByRole('region', { name: 'Notifications' })
}

beforeEach(() =>
{
  openRequest = null
  api.zoomIn.mockClear()
  api.zoomOut.mockClear()
  api.setZoomFactor.mockClear()
  api.closeConfirmResponse.mockClear()
  ;(window as unknown as { api: unknown }).api = api
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })
  })
  window.location.hash = ''
  useAppStore.setState({ currentView: 'dashboard', showSetup: false, ffmpegChecking: false, config: null })
})

afterEach(() =>
{
  act(() => clearToasts())
  cleanup()
  window.location.hash = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('notification region', () =>
{
  it('is mounted once, inside the work area, after the views', () =>
  {
    render(<App />)
    const regions = document.querySelectorAll('[role="region"][aria-label="Notifications"]')
    expect(regions).toHaveLength(1)
    const main = document.querySelector('main') as HTMLElement
    expect(regions[0].parentElement).toBe(main)
    expect(main.lastElementChild).toBe(regions[0])
    expect(main.children.length).toBeGreaterThan(1)
  })

  it('opens Logs from the line that folds older notifications', () =>
  {
    render(<App />)
    act(() =>
    {
      for (const title of ['One', 'Two', 'Three', 'Four'])
      {
        toast.show({ tone: 'error', title, announce: 'none' })
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /more/ }))
    expect(useAppStore.getState().currentView).toBe('logs')
  })
})

describe('F6 cycle', () =>
{
  it('cycles the rail and the regions the visible view registers, and Shift+F6 runs backward', () =>
  {
    render(<App />)
    expect(press('F6').defaultPrevented).toBe(true)
    expect(focused()).toBe('Dashboard')
    press('F6')
    expect(focused()).toBe('Normalize')
    press('F6')
    expect(focused()).toBe('Open log')
    press('F6')
    expect(focused()).toBe('Dashboard')
    press('F6', { shiftKey: true })
    expect(focused()).toBe('Open log')
    press('F6', { shiftKey: true })
    expect(focused()).toBe('Normalize')
  })

  it('gives a view that registers no regions one work-area stop', () =>
  {
    useAppStore.setState({ currentView: 'logs' })
    render(<App />)
    press('F6')
    expect(focused()).toBe('Dashboard')
    press('F6')
    expect(focused()).toBe('Filter')
    press('F6')
    expect(focused()).toBe('Dashboard')
  })

  it('reaches the notifications only while a toast shows, entering at the newest', () =>
  {
    useAppStore.setState({ currentView: 'logs' })
    render(<App />)
    act(() =>
    {
      toast.show({ tone: 'error', title: 'Disk full', announce: 'none' })
      toast.show({ tone: 'error', title: 'Output folder not writable', announce: 'none' })
    })
    press('F6')
    press('F6')
    expect(focused()).toBe('Filter')
    press('F6')
    expect(notifications().contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toContain('Output folder not writable')
    press('F6')
    expect(focused()).toBe('Dashboard')
    press('F6', { shiftKey: true })
    expect(notifications().contains(document.activeElement)).toBe(true)
  })

  it('leaves F6 alone when the visible view already claimed it', () =>
  {
    useAppStore.setState({ currentView: 'batch' })
    render(<App />)
    const start = screen.getByRole('button', { name: 'Start' })
    start.focus()
    press('F6')
    expect(document.activeElement).toBe(start)
  })

  it('ignores F6 with Ctrl, Alt, or Meta', () =>
  {
    render(<App />)
    expect(press('F6', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press('F6', { altKey: true }).defaultPrevented).toBe(false)
    expect(press('F6', { metaKey: true }).defaultPrevented).toBe(false)
  })

  it('keeps focus in an open modal dialog', () =>
  {
    render(<App />)
    act(() => openRequest?.())
    const minimize = screen.getByRole('button', { name: 'Minimize to tray' })
    expect(minimize).toHaveFocus()
    expect(press('F6').defaultPrevented).toBe(false)
    expect(minimize).toHaveFocus()
  })
})

describe('close confirmation', () =>
{
  it('shows over the initializing screen', () =>
  {
    useAppStore.setState({ ffmpegChecking: true })
    render(<App />)
    expect(screen.getByRole('progressbar', { name: 'Looking for FFmpeg' })).toBeInTheDocument()
    act(() => openRequest?.())
    expect(screen.getByRole('dialog', { name: 'Minimize to tray?' })).toBeInTheDocument()
    expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(true)
  })

  it('shows over the first-run setup and stays open when setup finishes', () =>
  {
    useAppStore.setState({ showSetup: true })
    render(<App />)
    expect(screen.getByRole('button', { name: 'Download FFmpeg' })).toBeInTheDocument()
    act(() => openRequest?.())
    expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(true)
    act(() => useAppStore.setState({ showSetup: false }))
    expect(document.querySelector('main')).not.toBeNull()
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Quit' }))
    expect(api.closeConfirmResponse).toHaveBeenCalledWith('quit', false)
  })
})

describe('zoom keys in both windows', () =>
{
  it('zoom the main window and return to the Interface size', () =>
  {
    useAppStore.setState({ config: { interfaceScale: 175 } as never })
    render(<App />)
    press('=', { ctrlKey: true })
    press('-', { ctrlKey: true })
    press('0', { ctrlKey: true })
    expect(api.zoomIn).toHaveBeenCalledTimes(1)
    expect(api.zoomOut).toHaveBeenCalledTimes(1)
    expect(api.setZoomFactor).toHaveBeenCalledWith(1.75)
  })

  it('zoom the popout too, which has no F6 cycle', () =>
  {
    window.location.hash = '#popout'
    render(<App />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    press('+', { ctrlKey: true })
    expect(api.zoomIn).toHaveBeenCalledTimes(1)
    expect(press('F6').defaultPrevented).toBe(false)
  })
})
