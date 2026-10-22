/**
 * The Logs view: the header's summary, the level control, the Sources menu, search, Follow new lines, Copy, Open log
 * folder, Clear with its confirmation, the grid's keys and row menu, the details pane, and the empty states.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import LogViewer, { DETAILS_HEIGHT, DETAILS_HEIGHT_KEY, readDetailsHeight, type LogViewerApi } from '../../../src/renderer/src/components/logs/LogViewer'
import { clockTime, formatLogLines, LOG_WORDS } from '../../../src/renderer/src/components/logs/logModel'
import { useAppStore, type LogEntry } from '../../../src/renderer/src/stores/appStore'
import { clearToasts } from '../../../src/renderer/src/ui/Toast'

const STAMP = '2026-10-20 09:30:00.000'

function entry(id: number, message: string, extra: Partial<LogEntry> = {}): LogEntry
{
  return { id, timestamp: STAMP, level: 'info', message, ...extra }
}

const LINES: LogEntry[] = [
  entry(1, 'molexMedia starting up...'),
  entry(2, 'Disk nearly full', { level: 'warn' }),
  entry(3, '"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac', { kind: 'cmd', jobId: 'MM-0142', runId: 'R-0031', attempt: 1, stage: 'encode' }),
  entry(4, 'Encode failed', { level: 'error', kind: 'event', jobId: 'MM-0142', runId: 'R-0031', details: 'Permission denied\nat write' }),
  entry(5, 'Main window created')
]

function fakeApi(overrides: Partial<LogViewerApi> = {}): LogViewerApi
{
  return {
    getLogBuffer: vi.fn(async () => []),
    clearLogs: vi.fn(async () => undefined),
    openLogDir: vi.fn(async () => undefined),
    showInFolder: vi.fn(async () => undefined),
    ...overrides
  }
}

let writeText: ReturnType<typeof vi.fn>

function setup(props: { onShowJob?: (entry: LogEntry) => void, api?: LogViewerApi } = {}): { api: LogViewerApi }
{
  const api = props.api ?? fakeApi()
  render(<LogViewer api={api} onShowJob={props.onShowJob} />)
  return { api }
}

function row(text: string): HTMLElement
{
  return within(screen.getByRole('grid')).getByText(text).closest('[role="row"]') as HTMLElement
}

function shownMessages(): string[]
{
  return Array.from(document.querySelectorAll('[role="row"][data-row-id] [data-part="message"]')).map((node) => node.textContent ?? '')
}

function summary(): string
{
  return screen.getByRole('heading', { level: 1, name: LOG_WORDS.title }).nextElementSibling?.textContent ?? ''
}

function details(): HTMLElement | null
{
  return document.querySelector<HTMLElement>('[data-part="log-details"]')
}

function menuNamed(name: string): HTMLElement
{
  const menu = screen.getAllByRole('menu', { hidden: true }).find((candidate) => candidate.getAttribute('aria-label') === name)
  if (!menu)
  {
    throw new Error(`No menu labeled "${name}"`)
  }
  return menu
}

beforeEach(() =>
{
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  useAppStore.setState({ logs: [...LINES], currentView: 'logs' })
})

afterEach(() =>
{
  cleanup()
  clearToasts()
  useAppStore.setState(useAppStore.getInitialState(), true)
  localStorage.clear()
})

describe('LogViewer header and toolbar', () =>
{
  it('titles the view with a summary of what it holds', () =>
  {
    setup()
    expect(summary()).toBe('5 lines, 1 FFmpeg command, 1 warning, 1 error')
    expect(shownMessages()).toHaveLength(5)
  })

  it('narrows by level with plain words', () =>
  {
    setup()
    const levels = screen.getByRole('radiogroup', { name: LOG_WORDS.levelLabel })
    expect(within(levels).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['All', 'Info', 'Warnings', 'Errors'])
    fireEvent.click(within(levels).getByRole('radio', { name: 'Errors' }))
    expect(shownMessages()).toEqual(['Encode failed'])
    expect(summary()).toBe('1 of 5 lines shown')
    fireEvent.click(within(levels).getByRole('radio', { name: 'Info' }))
    expect(shownMessages()).toHaveLength(3)
  })

  it('hides and shows sources from the Sources menu', () =>
  {
    setup()
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.allSources }))
    const menu = menuNamed(LOG_WORDS.sources)
    const app = within(menu).getByRole('menuitemcheckbox', { name: 'App (3)', hidden: true })
    expect(app).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'FFmpeg commands (1)', hidden: true })).toBeInTheDocument()
    const every = within(menu).getByRole('menuitem', { name: new RegExp(LOG_WORDS.showEverySource), hidden: true })
    expect(every).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(app)
    expect(shownMessages()).not.toContain('Main window created')
    expect(screen.getByRole('button', { name: '2 of 3 sources' })).toBeInTheDocument()
    fireEvent.click(within(menuNamed(LOG_WORDS.sources)).getByRole('menuitem', { name: new RegExp(LOG_WORDS.showEverySource), hidden: true }))
    expect(shownMessages()).toContain('Main window created')
  })

  it('searches, shows the filtered-empty state, and clears every filter from it', async () =>
  {
    setup()
    fireEvent.change(screen.getByRole('searchbox', { name: LOG_WORDS.searchPlaceholder }), { target: { value: 'permission' } })
    await waitFor(() => expect(shownMessages()).toEqual(['Encode failed']))
    fireEvent.change(screen.getByRole('searchbox', { name: LOG_WORDS.searchPlaceholder }), { target: { value: 'nothing like this' } })
    await waitFor(() => expect(document.querySelector('[data-part="log-empty"]')).not.toBeNull())
    const empty = document.querySelector('[data-part="log-empty"]') as HTMLElement
    expect(within(empty).getByText(LOG_WORDS.noMatchTitle)).toBeInTheDocument()
    fireEvent.click(within(empty).getByRole('button', { name: LOG_WORDS.clearFilters }))
    expect(shownMessages()).toHaveLength(5)
    expect(screen.getByRole('searchbox', { name: LOG_WORDS.searchPlaceholder })).toHaveValue('')
  })

  it('says when nothing is logged and leaves nothing to copy or clear', () =>
  {
    useAppStore.setState({ logs: [] })
    setup()
    const empty = document.querySelector('[data-part="log-empty"]') as HTMLElement
    expect(within(empty).getByText(LOG_WORDS.emptyTitle)).toBeInTheDocument()
    expect(within(empty).queryByRole('button')).toBeNull()
    expect(screen.getByRole('button', { name: LOG_WORDS.copyLines })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: LOG_WORDS.clear })).toHaveAttribute('aria-disabled', 'true')
  })

  it('copies the shown lines and confirms on the button', async () =>
  {
    setup()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: LOG_WORDS.levelLabel })).getByRole('radio', { name: 'Info' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.copyLines })) })
    expect(writeText).toHaveBeenCalledWith(formatLogLines([LINES[0], LINES[2], LINES[4]]))
    expect(screen.getByRole('button', { name: LOG_WORDS.copied })).toBeInTheDocument()
  })

  it('keeps the lines when Clear is not confirmed and clears them when it is', async () =>
  {
    const { api } = setup()
    const clear = screen.getByRole('button', { name: LOG_WORDS.clear })
    clear.focus()
    fireEvent.click(clear)
    expect(screen.getByRole('group', { name: LOG_WORDS.clearQuestion })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.keepLines }))
    expect(useAppStore.getState().logs).toHaveLength(5)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: LOG_WORDS.clear }))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clear }))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clearLines }))
    expect(useAppStore.getState().logs).toEqual([])
    expect(api.clearLogs).toHaveBeenCalledTimes(1)
  })

  it('turns Follow new lines off when the list scrolls up and back on at the bottom', () =>
  {
    setup()
    const follow = screen.getByRole('switch', { name: LOG_WORDS.follow })
    expect(follow).toHaveAttribute('aria-checked', 'true')
    const grid = screen.getByRole('grid')
    Object.defineProperty(grid, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(grid, 'clientHeight', { value: 300, configurable: true })
    grid.scrollTop = 700
    fireEvent.scroll(grid)
    expect(follow).toHaveAttribute('aria-checked', 'true')
    grid.scrollTop = 200
    fireEvent.scroll(grid)
    expect(follow).toHaveAttribute('aria-checked', 'false')
    grid.scrollTop = 700
    fireEvent.scroll(grid)
    expect(follow).toHaveAttribute('aria-checked', 'true')
    expect(grid.scrollTop).toBe(1000)
    fireEvent.click(follow)
    expect(follow).toHaveAttribute('aria-checked', 'false')
    grid.scrollTop = 500
    act(() => useAppStore.getState().addLog(entry(6, 'New line')))
    expect(grid.scrollTop).toBe(500)
    fireEvent.click(follow)
    expect(grid.scrollTop).toBe(1000)
  })

  it('focuses search on Ctrl+F', () =>
  {
    setup()
    fireEvent.keyDown(row('Disk nearly full'), { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: LOG_WORDS.searchPlaceholder }))
  })

  it('moves focus into the list when the view shows', async () =>
  {
    useAppStore.setState({ currentView: 'dashboard' })
    setup()
    act(() => useAppStore.getState().setView('logs'))
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('row'))
  })

  it('starts a new job filter with every level, source, and line shown', () =>
  {
    setup()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: LOG_WORDS.levelLabel })).getByRole('radio', { name: 'Errors' }))
    act(() => useAppStore.getState().showLog({ jobId: 'MM-0142' }))
    expect(within(screen.getByRole('radiogroup', { name: LOG_WORDS.levelLabel })).getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    expect(shownMessages()).toEqual(['"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac', 'Encode failed'])
  })
})

describe('LogViewer list', () =>
{
  it('shows time, level, source, and message, with the error wash on failed lines', () =>
  {
    setup()
    const failed = row('Encode failed')
    expect(failed).toHaveAttribute('data-tone', 'error')
    expect(row('Disk nearly full')).not.toHaveAttribute('data-tone')
    const cells = within(failed).getAllByRole('gridcell')
    expect(cells[0].textContent).toBe(clockTime(LINES[3]))
    expect(cells[1].textContent).toBe('Error')
    expect(cells[2].textContent).toBe('Job engine')
    expect(cells[3].textContent).toContain('MM-0142')
    const command = within(row('"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac')).getAllByRole('gridcell')
    expect(command[2].textContent).toBe('FFmpeg command')
    expect(command[3].querySelector('[data-part="message"]')?.className).toContain('font-mono')
  })

  it("names each line's job until the view shows one job", () =>
  {
    setup()
    expect(within(row('Encode failed')).getByText('MM-0142')).toBeInTheDocument()
    act(() => useAppStore.getState().showLog({ jobId: 'MM-0142' }))
    expect(within(row('Encode failed')).queryByText('MM-0142')).toBeNull()
    act(() => useAppStore.getState().showLog({ runId: 'R-0031' }))
    expect(within(row('Encode failed')).getByText('MM-0142')).toBeInTheDocument()
  })

  it('copies the selected lines with Ctrl+C', async () =>
  {
    setup()
    fireEvent.click(row('molexMedia starting up...'))
    fireEvent.click(row('Disk nearly full'), { ctrlKey: true })
    await act(async () => { fireEvent.keyDown(row('Disk nearly full'), { key: 'c', ctrlKey: true }) })
    expect(writeText).toHaveBeenCalledWith(formatLogLines([LINES[0], LINES[1]]))
  })

  it('copies the focused line with Ctrl+C when nothing is selected', async () =>
  {
    setup()
    await act(async () => { fireEvent.keyDown(row('Main window created'), { key: 'c', ctrlKey: true }) })
    expect(writeText).toHaveBeenCalledWith(formatLogLines([LINES[4]]))
  })

  it('opens a line in full with Enter and closes the details with Escape', () =>
  {
    setup()
    const failed = row('Encode failed')
    fireEvent.click(failed)
    fireEvent.keyDown(failed, { key: 'Enter' })
    const pane = details() as HTMLElement
    expect(within(pane).getByText('Error')).toBeInTheDocument()
    expect(within(pane).getByText('Job engine · MM-0142 · Batch 31')).toBeInTheDocument()
    expect(within(pane).getByText(LOG_WORDS.details)).toBeInTheDocument()
    expect(within(pane).getByText(/Permission denied/).textContent).toBe('Permission denied\nat write')
    fireEvent.keyDown(within(pane).getByRole('button', { name: LOG_WORDS.copyLine }), { key: 'Escape' })
    expect(details()).toBeNull()
  })

  it('opens a command on a double-click, wrapped in mono with Copy command', async () =>
  {
    setup()
    const command = row('"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac')
    fireEvent.click(command)
    fireEvent.doubleClick(within(command).getAllByRole('gridcell')[3])
    const pane = details() as HTMLElement
    const block = within(pane).getByRole('group', { name: LOG_WORDS.command })
    expect(block.querySelector('pre')?.className).toContain('whitespace-pre-wrap')
    expect(within(pane).getByText('FFmpeg command · MM-0142 · Batch 31 · attempt 1 · Encode')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(block).getByRole('button', { name: LOG_WORDS.copyCommand })) })
    expect(writeText).toHaveBeenCalledWith('"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac')
    fireEvent.click(within(pane).getByRole('button', { name: LOG_WORDS.hideDetails }))
    expect(details()).toBeNull()
  })

  it("opens a line's hidden lines from its More lines button", () =>
  {
    setup()
    fireEvent.click(within(row('Encode failed')).getByRole('button', { name: '2 more lines' }))
    expect(row('Encode failed')).toHaveAttribute('aria-selected', 'true')
    expect(within(details() as HTMLElement).getByText(/Permission denied/)).toBeInTheDocument()
  })

  it('reads several selected lines as copy text in the details', async () =>
  {
    setup()
    fireEvent.click(row('molexMedia starting up...'))
    fireEvent.keyDown(row('molexMedia starting up...'), { key: 'Enter' })
    fireEvent.click(row('Disk nearly full'), { ctrlKey: true })
    const pane = details() as HTMLElement
    expect(within(pane).getByText('2 lines selected')).toBeInTheDocument()
    expect(pane.querySelector('pre')?.textContent).toBe(formatLogLines([LINES[0], LINES[1]]))
    await act(async () => { fireEvent.click(within(pane).getByRole('button', { name: 'Copy 2 lines' })) })
    expect(writeText).toHaveBeenCalledWith(formatLogLines([LINES[0], LINES[1]]))
    fireEvent.keyDown(row('Disk nearly full'), { key: 'Escape' })
    expect(within(details() as HTMLElement).getByText(LOG_WORDS.detailsEmpty)).toBeInTheDocument()
  })

  it('offers Copy line, Copy command, Show details, Show job, and a job filter from the row menu', async () =>
  {
    const onShowJob = vi.fn()
    setup({ onShowJob })
    const command = row('"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac')
    fireEvent.contextMenu(command, { button: 2, clientX: 20, clientY: 20 })
    const menu = menuNamed(`Actions for the ${clockTime(LINES[2])} line`)
    const names = within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.querySelector('[data-part="label"]')?.textContent)
    expect(names).toEqual([LOG_WORDS.copyLine, LOG_WORDS.copyCommand, LOG_WORDS.showDetails, 'Show job MM-0142', 'Show only lines for MM-0142'])
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(LOG_WORDS.copyCommand), hidden: true })) })
    expect(writeText).toHaveBeenCalledWith('"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.wav out.flac')

    fireEvent.contextMenu(command, { button: 2, clientX: 20, clientY: 20 })
    fireEvent.click(within(menuNamed(`Actions for the ${clockTime(LINES[2])} line`)).getByRole('menuitem', { name: /Show job MM-0142/, hidden: true }))
    expect(onShowJob).toHaveBeenCalledWith(LINES[2])

    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    fireEvent.contextMenu(command, { button: 2, clientX: 20, clientY: 20 })
    fireEvent.click(within(menuNamed(`Actions for the ${clockTime(LINES[2])} line`)).getByRole('menuitem', { name: /Show only lines for MM-0142/, hidden: true }))
    expect(useAppStore.getState().logFilter).toEqual({ jobId: 'MM-0142' })
  })

  it('names the selection in the row menu and copies it', async () =>
  {
    setup()
    fireEvent.click(row('molexMedia starting up...'))
    fireEvent.click(row('Disk nearly full'), { ctrlKey: true })
    fireEvent.contextMenu(row('Disk nearly full'), { button: 2, clientX: 20, clientY: 20 })
    const menu = menuNamed('Actions for 2 lines')
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: /Copy 2 lines/, hidden: true })) })
    expect(writeText).toHaveBeenCalledWith(formatLogLines([LINES[0], LINES[1]]))
  })

  it('shows the job from the details pane', () =>
  {
    const onShowJob = vi.fn()
    setup({ onShowJob })
    fireEvent.click(row('Encode failed'))
    fireEvent.keyDown(row('Encode failed'), { key: 'Enter' })
    fireEvent.click(within(details() as HTMLElement).getByRole('button', { name: 'Show job MM-0142' }))
    expect(onShowJob).toHaveBeenCalledWith(LINES[3])
  })

  it('sizes the details pane from its splitter and its Pane height menu, and keeps the size', () =>
  {
    setup()
    fireEvent.click(row('Disk nearly full'))
    fireEvent.keyDown(row('Disk nearly full'), { key: 'Enter' })
    const splitter = screen.getByRole('separator', { name: LOG_WORDS.detailsHeight })
    expect(splitter).toHaveAttribute('aria-orientation', 'horizontal')
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAILS_HEIGHT.default))
    fireEvent.keyDown(splitter, { key: 'ArrowUp' })
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAILS_HEIGHT.default + 16))
    expect(localStorage.getItem(DETAILS_HEIGHT_KEY)).toBe(String(DETAILS_HEIGHT.default + 16))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.paneHeight }))
    fireEvent.click(within(menuNamed(LOG_WORDS.paneHeight)).getByRole('menuitemradio', { name: 'Short', hidden: true }))
    expect(splitter).toHaveAttribute('aria-valuenow', String(DETAILS_HEIGHT.short))
    expect((details() as HTMLElement).parentElement?.style.height).toBe(`${DETAILS_HEIGHT.short}px`)
  })
})

describe('readDetailsHeight', () =>
{
  it('reads a kept height and falls back to the default', () =>
  {
    expect(readDetailsHeight({ getItem: () => '300' })).toBe(300)
    expect(readDetailsHeight({ getItem: () => null })).toBe(DETAILS_HEIGHT.default)
    expect(readDetailsHeight({ getItem: () => '40' })).toBe(DETAILS_HEIGHT.default)
    expect(readDetailsHeight({ getItem: () => { throw new Error('blocked') } })).toBe(DETAILS_HEIGHT.default)
    expect(readDetailsHeight(null)).toBe(DETAILS_HEIGHT.default)
  })
})
