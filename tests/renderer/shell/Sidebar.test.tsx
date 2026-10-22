/**
 * The navigation rail: registry glyphs, the Batch item's percent and need-attention count from the job
 * engine (never a file count), its extended accessible name, the named collapse toggle, tooltips in the
 * collapsed rail, the current page's selected look, the still update mark, and the rail as the first F6 stop.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import Sidebar, { attentionWords, batchItemName, batchItemTip, NAV_SECTIONS, RAIL_AUTO_COLLAPSE_QUERY, railPercent } from '../../../src/renderer/src/components/layout/Sidebar'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import { f6Order, focusNextRegion } from '../../../src/renderer/src/hooks/useF6Region'
import { ICONS } from '../../../src/renderer/src/ui/icons'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { JobState, JobView, RunState } from '../../../src/shared/jobs/types'

function jobView(id: string, extra: Partial<JobView> = {}): JobView
{
  return {
    id,
    seq: Number(id.slice(3)),
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.mkv`, name: `${id}.mkv`, ext: 'mkv', dir: 'D:\\Rips', size: 1000, mtimeMs: 1, origin: 'files', subdir: '' },
    recipe: { kind: 'normalize' },
    recipeLabel: 'EBU R 128',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'ok',
    plan: null,
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: 1,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...extra
  } as JobView
}

let nextSeq = 1

function job(state: JobState, extra: Partial<JobView> = {}): JobView
{
  const id = `MM-${String(nextSeq).padStart(4, '0')}`
  nextSeq += 1
  return jobView(id, { state, ...extra })
}

const R1 = 'R-0001' as RunId
const R2 = 'R-0002' as RunId

function run(percent: number, status: RunState['status'] = 'running'): RunState
{
  return {
    status,
    runId: R2,
    startedAt: 1,
    pause: null,
    counts: {},
    progress: { percent, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 },
    workers: { setting: { mode: 'auto' }, limits: { total: 4, videoCpu: 2, gpu: 1 }, taken: 0 },
    quitWhenIdle: false,
    needsAck: null
  } as unknown as RunState
}

function seed(jobs: readonly JobView[], current: RunState | null = null): void
{
  useJobsStore.setState({
    jobs: Object.fromEntries(jobs.map((item) => [item.id, item])) as Record<JobId, JobView>,
    order: jobs.map((item) => item.id as JobId),
    run: current
  })
}

function navButton(id: string): HTMLButtonElement
{
  return document.querySelector(`[data-nav="${id}"]`) as HTMLButtonElement
}

function openTip(): HTMLElement | null
{
  return document.querySelector('[role="tooltip"][data-open]')
}

const initialApp = useAppStore.getState()
const saveConfig = vi.fn(() => Promise.resolve())

beforeEach(() =>
{
  nextSeq = 1
  vi.useRealTimers()
  useJobsStore.setState(initialJobsState(), true)
  useAppStore.setState({ ...initialApp, currentView: 'dashboard', sidebarCollapsed: false, logs: [], lastSeenErrorCount: 0, updateStatus: 'idle', config: null }, true)
  ;(window as unknown as { api: unknown }).api = { saveConfig }
  saveConfig.mockClear()
})

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
})

describe('the Batch item words', () =>
{
  it('floors the percent into 0 to 100 so a run never reads done early', () =>
  {
    expect(railPercent(46.9)).toBe(46)
    expect(railPercent(99.99)).toBe(99)
    expect(railPercent(-3)).toBe(0)
    expect(railPercent(140)).toBe(100)
    expect(railPercent(Number.NaN)).toBe(0)
  })

  it('agrees the attention verb with the count', () =>
  {
    expect(attentionWords(1)).toBe('1 needs attention')
    expect(attentionWords(2)).toBe('2 need attention')
  })

  it('extends the accessible name with the percent and the attention count', () =>
  {
    expect(batchItemName(null, 0)).toBe('Batch')
    expect(batchItemName(46.2, 0)).toBe('Batch, 46 percent')
    expect(batchItemName(null, 1)).toBe('Batch, 1 needs attention')
    expect(batchItemName(46.2, 2)).toBe('Batch, 46 percent, 2 need attention')
  })

  it('writes the collapsed tooltip with a percent sign', () =>
  {
    expect(batchItemTip(null, 0)).toBe('Batch')
    expect(batchItemTip(46, 2)).toBe('Batch, 46%, 2 need attention')
  })
})

describe('Sidebar', () =>
{
  it('renders every item from the icon registry, Batch in place of Processor', () =>
  {
    render(<Sidebar />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const ids = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.id))
    expect(ids).toEqual(['dashboard', 'batch', 'editor', 'player', 'settings', 'logs'])
    for (const section of NAV_SECTIONS)
    {
      for (const item of section.items)
      {
        expect(item.icon in ICONS).toBe(true)
        const glyph = navButton(item.id).querySelector('svg')
        expect(glyph?.getAttribute('data-icon')).toBe(item.icon)
        expect(glyph?.getAttribute('aria-hidden')).toBe('true')
      }
    }
    expect(within(nav).getByRole('button', { name: 'Batch' })).toBeInTheDocument()
    expect(within(nav).queryByText('Processor')).toBeNull()
    expect(within(nav).getByRole('group', { name: 'Tools' })).toBeInTheDocument()
    expect(within(nav).getByRole('group', { name: 'System' })).toBeInTheDocument()
    expect(nav.querySelectorAll('svg:not([data-icon])')).toHaveLength(0)
  })

  it('shows the run percent and the octagon with the attention count over every job', () =>
  {
    seed([
      job('failed', { runId: R1 }),
      job('held', { runId: R1, acknowledged: true }),
      job('done', { runId: R2, warnings: [{ code: 'clip', message: 'Clipped' }] as unknown as JobView['warnings'] }),
      job('failed', { runId: R2, acknowledged: true }),
      job('encoding', { runId: R2 }),
      job('pending')
    ], run(46.4))
    render(<Sidebar />)
    const batch = screen.getByRole('button', { name: 'Batch, 46 percent, 3 need attention' })
    expect(batch.querySelector('[data-part="percent"]')?.textContent).toBe('46%')
    const attention = batch.querySelector('[data-part="attention"]') as HTMLElement
    expect(attention.textContent).toBe('3')
    expect(attention.querySelector('svg')?.getAttribute('data-icon')).toBe('status.failed')
    expect(attention.className).toContain('text-error')
  })

  it('names the item Batch, 46 percent, 2 need attention during a run with two returned jobs', () =>
  {
    seed([job('failed', { runId: R1 }), job('interrupted', { runId: R2 }), job('encoding', { runId: R2 })], run(46))
    render(<Sidebar />)
    expect(navButton('batch').getAttribute('aria-label')).toBe('Batch, 46 percent, 2 need attention')
  })

  it('never shows a file count on the Batch item', () =>
  {
    seed([job('pending'), job('pending'), job('pending'), job('queued')])
    useAppStore.setState({ files: [{ path: 'a' }, { path: 'b' }] as unknown as ReturnType<typeof useAppStore.getState>['files'] })
    render(<Sidebar />)
    const batch = navButton('batch')
    expect(batch.getAttribute('aria-label')).toBe('Batch')
    expect(batch.textContent).toBe('Batch')
  })

  it('drops the percent when the run ends and keeps the attention count', () =>
  {
    seed([job('failed', { runId: R2 })], run(80))
    render(<Sidebar />)
    expect(navButton('batch').querySelector('[data-part="percent"]')).not.toBeNull()
    act(() => useJobsStore.setState({ run: { ...run(100), status: 'idle' } }))
    expect(navButton('batch').querySelector('[data-part="percent"]')).toBeNull()
    expect(navButton('batch').getAttribute('aria-label')).toBe('Batch, 1 needs attention')
  })

  it('caps a large attention count in the badge but not in the name', () =>
  {
    seed(Array.from({ length: 120 }, () => job('failed')))
    render(<Sidebar />)
    expect(navButton('batch').querySelector('[data-part="attention"]')?.textContent).toBe('99+')
    expect(navButton('batch').getAttribute('aria-label')).toBe('Batch, 120 need attention')
  })

  it('marks the current page as wash-selected with a primary frame and a primary glyph', () =>
  {
    useAppStore.setState({ currentView: 'batch' })
    render(<Sidebar />)
    const active = navButton('batch')
    expect(active.getAttribute('aria-current')).toBe('page')
    expect(active.className).toContain('bg-wash-selected')
    expect(active.className).toContain('border-accent')
    expect(active.querySelector('svg')?.getAttribute('class')).toContain('text-accent-ink')
    const idle = navButton('editor')
    expect(idle.hasAttribute('aria-current')).toBe(false)
    expect(idle.className).toContain('border-transparent')
    expect(idle.className).not.toContain('bg-wash-selected')
    expect(idle.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('text-accent-ink')
    expect(active.querySelector('.bg-accent-ink')).toBeNull()
  })

  it('navigates on click and keeps focus rings inside the rail', () =>
  {
    render(<Sidebar />)
    fireEvent.click(navButton('logs'))
    expect(useAppStore.getState().currentView).toBe('logs')
    for (const button of document.querySelectorAll('[data-nav]'))
    {
      expect(button.getAttribute('data-focus')).toBe('inset')
      expect(button.getAttribute('type')).toBe('button')
    }
  })

  it('names the collapse toggle and flips it to expand', () =>
  {
    render(<Sidebar />)
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.querySelector('svg')?.getAttribute('data-icon')).toBe('rail.collapse')
    fireEvent.click(collapse)
    expect(useAppStore.getState().sidebarCollapsed).toBe(true)
    expect(saveConfig).toHaveBeenCalledWith({ sidebarCollapsed: true })
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    expect(expand.querySelector('svg')?.getAttribute('data-icon')).toBe('rail.expand')
  })

  it('hides labels in the collapsed rail and shows each item as a tooltip', () =>
  {
    vi.useFakeTimers()
    seed([job('failed'), job('held')], run(46))
    useAppStore.setState({ sidebarCollapsed: true })
    render(<Sidebar />)
    const batch = navButton('batch')
    expect(batch.getAttribute('aria-label')).toBe('Batch, 46 percent, 2 need attention')
    expect(batch.textContent).toBe('')
    expect(batch.querySelector('[data-part="meter"]')).not.toBeNull()
    expect(batch.querySelector('[data-part="attention"] svg')?.getAttribute('data-icon')).toBe('status.failed')
    expect(screen.queryByText('Tools')).toBeNull()
    fireEvent.pointerEnter(batch)
    act(() =>
    {
      vi.advanceTimersByTime(600)
    })
    expect(openTip()?.textContent).toBe('Batch, 46%, 2 need attention')
    expect(openTip()?.getAttribute('data-placement')).toBe('end')
    fireEvent.pointerLeave(batch)
    fireEvent.pointerEnter(navButton('editor'))
    act(() =>
    {
      vi.advanceTimersByTime(600)
    })
    expect(openTip()?.textContent).toBe('Editor')
  })

  it('shows tooltips only in the collapsed rail', () =>
  {
    vi.useFakeTimers()
    render(<Sidebar />)
    fireEvent.pointerEnter(navButton('editor'))
    act(() =>
    {
      vi.advanceTimersByTime(600)
    })
    expect(document.querySelector('[role="tooltip"][data-placement="end"]')).toBeNull()
    expect(openTip()).toBeNull()
  })

  it('draws the update mark still, named through the Settings item', () =>
  {
    useAppStore.setState({ updateStatus: 'downloaded' })
    const { rerender } = render(<Sidebar />)
    const settings = screen.getByRole('button', { name: 'Settings, update available' })
    const mark = settings.querySelector('[data-part="update"]') as HTMLElement
    expect(mark.querySelector('svg')?.getAttribute('data-icon')).toBe('update.available')
    const classes = [mark, ...mark.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').join(' ')
    expect(classes).not.toMatch(/animate-|transition|motion-safe/)
    act(() => useAppStore.setState({ sidebarCollapsed: true }))
    rerender(<Sidebar />)
    expect(navButton('settings').querySelector('[data-part="update"]')?.className).toContain('absolute')
  })

  it('keeps the Logs error badge and names its count', () =>
  {
    useAppStore.setState({
      logs: [
        { level: 'error', message: 'a' },
        { level: 'info', message: 'b' },
        { level: 'error', message: 'c' }
      ] as unknown as ReturnType<typeof useAppStore.getState>['logs'],
      lastSeenErrorCount: 0
    })
    render(<Sidebar />)
    expect(navButton('logs').getAttribute('aria-label')).toBe('Logs, 2 new errors')
    const badge = navButton('logs').querySelector('[data-part="errors"]') as HTMLElement
    expect(badge.textContent).toBe('2')
    expect(badge.className).toContain('text-error')
    expect(badge.querySelector('svg')).not.toBeNull()
    act(() => useAppStore.setState({ lastSeenErrorCount: 1 }))
    expect(navButton('logs').getAttribute('aria-label')).toBe('Logs, 1 new error')
    act(() => useAppStore.setState({ sidebarCollapsed: true }))
    const mark = navButton('logs').querySelector('[data-part="errors"]') as HTMLElement
    expect(mark.className).toContain('absolute')
    expect(mark.className).toContain('text-error')
  })

  it('is the first F6 stop and enters at the current page', () =>
  {
    useAppStore.setState({ currentView: 'player' })
    render(
      <>
        <Sidebar />
        <main><button type="button">Play</button></main>
      </>
    )
    const stops = f6Order()
    expect(stops[0].kind).toBe('rail')
    expect(stops[0].element).toBe(screen.getByRole('navigation', { name: 'Main' }))
    act(() =>
    {
      screen.getByRole('button', { name: 'Play' }).focus()
    })
    act(() =>
    {
      focusNextRegion('next')
    })
    expect(document.activeElement).toBe(navButton('player'))
  })

  it('collapses for the session on a narrow window and restores the saved choice when wide', () =>
  {
    const listeners: ((event: MediaQueryListEvent) => void)[] = []
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query === RAIL_AUTO_COLLAPSE_QUERY,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.push(listener),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
    try
    {
      useAppStore.setState({ config: { sidebarCollapsed: false } as ReturnType<typeof useAppStore.getState>['config'] })
      const { unmount } = render(<Sidebar />)
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
      expect(saveConfig).not.toHaveBeenCalled()
      act(() => listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent)))
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
      act(() => listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent)))
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
      unmount()
    }
    finally
    {
      window.matchMedia = original
    }
  })
})
