import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import LogViewer, {
  FullOutputPanel,
  LOG_FILTER_WORDS,
  logFilterLabel,
  matchesLogFilter,
  mergeLogEntries,
  visibleLogEntries,
  windowLogApi,
  type JobLogResult,
  type LogViewerApi
} from '../../src/renderer/src/components/logs/LogViewer'
import { LOG_WORDS, NO_NARROWING } from '../../src/renderer/src/components/logs/logModel'
import { useAppStore, type LogEntry } from '../../src/renderer/src/stores/appStore'
import type { CommandResult } from '../../src/shared/jobs/contract'
import type { JobId } from '../../src/shared/jobs/ids'

function entry(id: number | undefined, message: string, extra: Partial<LogEntry> = {}): LogEntry
{
  return { id, timestamp: '2026-10-20 09:30:00.000', level: 'info', message, ...extra }
}

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

function okLog(value: JobLogResult): CommandResult<JobLogResult>
{
  return { ok: true, value, seq: 0 }
}

const JOB = 'MM-0142' as JobId

afterEach(() =>
{
  cleanup()
  useAppStore.setState(useAppStore.getInitialState())
  vi.unstubAllGlobals()
})

describe('logFilterLabel', () =>
{
  it('reads the catalog number for a job and the batch label for a run', () =>
  {
    expect(logFilterLabel({ jobId: 'MM-0142' })).toBe('MM-0142')
    expect(logFilterLabel({ runId: 'R-0031' })).toBe('Batch 31')
  })

  it('falls back to the raw id for a run id it cannot read', () =>
  {
    expect(logFilterLabel({ runId: 'unknown' })).toBe('unknown')
  })
})

describe('matchesLogFilter', () =>
{
  const line = entry(1, 'Dispatched', { jobId: 'MM-0142', runId: 'R-0031' })

  it('matches everything without a filter', () =>
  {
    expect(matchesLogFilter(entry(2, 'app'), null)).toBe(true)
  })

  it('matches by job', () =>
  {
    expect(matchesLogFilter(line, { jobId: 'MM-0142' })).toBe(true)
    expect(matchesLogFilter(line, { jobId: 'MM-0143' })).toBe(false)
    expect(matchesLogFilter(entry(3, 'app'), { jobId: 'MM-0142' })).toBe(false)
  })

  it('matches by run', () =>
  {
    expect(matchesLogFilter(line, { runId: 'R-0031' })).toBe(true)
    expect(matchesLogFilter(line, { runId: 'R30' })).toBe(false)
  })
})

describe('mergeLogEntries', () =>
{
  const filter = { jobId: 'MM-0001' }
  const live = [
    entry(4, 'older live', { jobId: 'MM-0001' }),
    entry(5, 'other job', { jobId: 'MM-0002' }),
    entry(6, 'newer live', { jobId: 'MM-0001' }),
    entry(undefined, 'local line', { jobId: 'MM-0001' })
  ]

  it('returns the matching live entries without a fetched list', () =>
  {
    expect(mergeLogEntries(null, live, filter).map((e) => e.message)).toEqual(['older live', 'newer live', 'local line'])
    expect(mergeLogEntries(null, live, null)).toHaveLength(4)
  })

  it('appends live entries newer than the fetched list', () =>
  {
    const fetched = [entry(2, 'from main', { jobId: 'MM-0001' }), entry(4, 'older live', { jobId: 'MM-0001' })]
    expect(mergeLogEntries(fetched, live, filter).map((e) => e.message)).toEqual(['from main', 'older live', 'newer live'])
  })

  it('treats a fetched list without ids as older than every live entry', () =>
  {
    const fetched = [entry(undefined, 'unnumbered', { jobId: 'MM-0001' })]
    expect(mergeLogEntries(fetched, live, filter).map((e) => e.message)).toEqual(['unnumbered', 'older live', 'newer live'])
  })
})

describe('visibleLogEntries', () =>
{
  const entries = [
    entry(1, 'Encoding started'),
    entry(2, 'Disk nearly full', { level: 'warn' }),
    entry(3, 'size=100kB', { level: 'ffmpeg' })
  ]

  it('narrows by level and by case-insensitive search', () =>
  {
    expect(visibleLogEntries(entries, NO_NARROWING)).toHaveLength(3)
    expect(visibleLogEntries(entries, { ...NO_NARROWING, level: 'warning' }).map((e) => e.id)).toEqual([2])
    expect(visibleLogEntries(entries, { ...NO_NARROWING, search: 'ENCODING' }).map((e) => e.id)).toEqual([1])
    expect(visibleLogEntries(entries, { ...NO_NARROWING, level: 'info', search: 'disk' })).toEqual([])
  })
})

describe('windowLogApi', () =>
{
  it('calls through the preload bridge and passes the query', async () =>
  {
    const bridge = {
      getLogBuffer: vi.fn(async () => [entry(1, 'a')]),
      clearLogs: vi.fn(async () => undefined),
      openLogDir: vi.fn(async () => undefined),
      showInFolder: vi.fn(async () => undefined),
      jobs: { log: vi.fn(async () => okLog({ lines: ['x'], truncated: false, file: null })) }
    }
    vi.stubGlobal('api', bridge)
    const api = windowLogApi()
    expect(await api.getLogBuffer({ jobId: 'MM-0001' })).toHaveLength(1)
    expect(bridge.getLogBuffer).toHaveBeenCalledWith({ jobId: 'MM-0001' })
    await api.clearLogs()
    await api.openLogDir()
    await api.showInFolder('C:/logs/R1/MM-0001-a1.log')
    expect(bridge.clearLogs).toHaveBeenCalled()
    expect(bridge.openLogDir).toHaveBeenCalled()
    expect(bridge.showInFolder).toHaveBeenCalledWith('C:/logs/R1/MM-0001-a1.log')
    await api.jobLog?.({ jobId: JOB, attempt: null })
    expect(bridge.jobs.log).toHaveBeenCalledWith({ jobId: JOB, attempt: null })
  })

  it('has no job log before the window exposes the jobs API', () =>
  {
    vi.stubGlobal('api', { getLogBuffer: vi.fn(), clearLogs: vi.fn(), openLogDir: vi.fn(), showInFolder: vi.fn() })
    expect(windowLogApi().jobLog).toBeUndefined()
  })
})

describe('LogViewer with a job or batch filter', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ logs: [entry(10, 'App started'), entry(11, 'Dispatched', { jobId: 'MM-0142', runId: 'R-0031' })] })
  })

  it('shows every entry and no chip without a filter', () =>
  {
    const api = fakeApi()
    render(React.createElement(LogViewer, { api }))
    expect(screen.getByText('App started')).toBeInTheDocument()
    expect(screen.getByText('Dispatched')).toBeInTheDocument()
    expect(screen.queryByText(LOG_FILTER_WORDS.filteredTo)).toBeNull()
    expect(screen.queryByText(LOG_FILTER_WORDS.fullOutput)).toBeNull()
    expect(api.getLogBuffer).not.toHaveBeenCalled()
  })

  it('shows the catalog number chip and the job lines main returns', async () =>
  {
    const api = fakeApi({
      getLogBuffer: vi.fn(async () => [
        entry(3, 'Measured -23.1 LUFS', { jobId: 'MM-0142' }),
        entry(4, 'Unrelated', { jobId: 'MM-0007' })
      ])
    })
    useAppStore.setState({ logFilter: { jobId: 'MM-0142' } })
    render(React.createElement(LogViewer, { api }))
    expect(api.getLogBuffer).toHaveBeenCalledWith({ jobId: 'MM-0142' })
    const chip = document.querySelector('[data-part="log-filter"]') as HTMLElement
    expect(chip.textContent).toContain(`${LOG_FILTER_WORDS.filteredTo} MM-0142`)
    expect(await screen.findByText('Measured -23.1 LUFS')).toBeInTheDocument()
    expect(screen.getByText('Dispatched')).toBeInTheDocument()
    expect(screen.queryByText('Unrelated')).toBeNull()
    expect(screen.queryByText('App started')).toBeNull()
  })

  it('clears the filter from the chip and moves focus to search', () =>
  {
    useAppStore.setState({ logFilter: { jobId: 'MM-0142' } })
    render(React.createElement(LogViewer, { api: fakeApi() }))
    fireEvent.click(screen.getByRole('button', { name: LOG_FILTER_WORDS.clear }))
    expect(useAppStore.getState().logFilter).toBeNull()
    expect(document.activeElement).toBe(screen.getByPlaceholderText(LOG_WORDS.searchPlaceholder))
    expect(screen.getByText('App started')).toBeInTheDocument()
  })

  it('labels a batch filter and offers no full output', async () =>
  {
    const api = fakeApi()
    useAppStore.setState({ logFilter: { runId: 'R-0031' } })
    render(React.createElement(LogViewer, { api }))
    await waitFor(() => expect(api.getLogBuffer).toHaveBeenCalledWith({ runId: 'R-0031' }))
    expect(document.querySelector('[data-part="log-filter"]')?.textContent).toContain('Batch 31')
    expect(screen.queryByText(LOG_FILTER_WORDS.fullOutput)).toBeNull()
  })

  it('keeps the live lines when main cannot be read', async () =>
  {
    const api = fakeApi({ getLogBuffer: vi.fn(async () => { throw new Error('gone') }) })
    useAppStore.setState({ logFilter: { jobId: 'MM-0142' } })
    render(React.createElement(LogViewer, { api }))
    await waitFor(() => expect(api.getLogBuffer).toHaveBeenCalled())
    expect(screen.getByText('Dispatched')).toBeInTheDocument()
  })

  it('says when a job has no lines yet', async () =>
  {
    useAppStore.setState({ logFilter: { jobId: 'MM-0999' } })
    render(React.createElement(LogViewer, { api: fakeApi() }))
    const empty = await waitFor(() => document.querySelector('[data-part="log-empty"]') as HTMLElement)
    expect(within(empty).getByText('No lines for MM-0999 yet')).toBeInTheDocument()
  })

  it('empties a filtered view on Clear', async () =>
  {
    const api = fakeApi({ getLogBuffer: vi.fn(async () => [entry(3, 'Older job line', { jobId: 'MM-0142' })]) })
    useAppStore.setState({ logFilter: { jobId: 'MM-0142' } })
    render(React.createElement(LogViewer, { api }))
    expect(await screen.findByText('Older job line')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clear }))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clearLines }))
    expect(screen.queryByText('Older job line')).toBeNull()
    expect(screen.queryByText('Dispatched')).toBeNull()
    expect(api.clearLogs).toHaveBeenCalled()
  })

  it('clears an unfiltered view and opens the log folder', () =>
  {
    const api = fakeApi()
    render(React.createElement(LogViewer, { api }))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.openFolder }))
    expect(api.openLogDir).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clear }))
    fireEvent.click(screen.getByRole('button', { name: LOG_WORDS.clearLines }))
    expect(useAppStore.getState().logs).toEqual([])
    expect(api.getLogBuffer).not.toHaveBeenCalled()
  })
})

describe('FullOutputPanel', () =>
{
  function renderPanel(api: LogViewerApi): void
  {
    render(React.createElement(FullOutputPanel, { jobId: JOB, api }))
  }

  function toggle(): void
  {
    fireEvent.click(screen.getByRole('button', { name: /^(Show|Hide) output$/ }))
  }

  it('reads the job log once when it first opens', async () =>
  {
    const jobLog = vi.fn(async () => okLog({ lines: ['Input #0, flac', 'Output #0, flac'], truncated: true, file: 'C:/logs/R-0031/MM-0142-a1.log' }))
    const api = fakeApi({ jobLog })
    renderPanel(api)
    const button = screen.getByRole('button', { name: LOG_FILTER_WORDS.showOutput })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    toggle()
    expect(screen.getByRole('status')).toHaveTextContent(LOG_FILTER_WORDS.reading)
    const region = await screen.findByRole('region', { name: LOG_FILTER_WORDS.fullOutput })
    expect(region.textContent).toBe('Input #0, flac\nOutput #0, flac')
    expect(region).toHaveAttribute('tabindex', '0')
    expect(jobLog).toHaveBeenCalledWith({ jobId: JOB, attempt: null })
    expect(screen.getByText(LOG_FILTER_WORDS.truncated)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LOG_FILTER_WORDS.showFile }))
    expect(api.showInFolder).toHaveBeenCalledWith('C:/logs/R-0031/MM-0142-a1.log')
    toggle()
    expect(screen.getByRole('button', { name: LOG_FILTER_WORDS.showOutput })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: LOG_FILTER_WORDS.fullOutput })).toBeNull()
    toggle()
    expect(await screen.findByRole('region', { name: LOG_FILTER_WORDS.fullOutput })).toBeInTheDocument()
    expect(jobLog).toHaveBeenCalledTimes(1)
  })

  it('copies the output and confirms it', async () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderPanel(fakeApi({ jobLog: vi.fn(async () => okLog({ lines: ['line 1'], truncated: false, file: null })) }))
    toggle()
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.queryByText(LOG_FILTER_WORDS.truncated)).toBeNull()
    expect(screen.queryByRole('button', { name: LOG_FILTER_WORDS.showFile })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: LOG_FILTER_WORDS.copy })) })
    expect(writeText).toHaveBeenCalledWith('line 1')
    expect(screen.getByRole('button', { name: LOG_FILTER_WORDS.copied })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(screen.getByRole('button', { name: LOG_FILTER_WORDS.copy })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('stays quiet when the clipboard refuses', async () =>
  {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    renderPanel(fakeApi({ jobLog: vi.fn(async () => okLog({ lines: ['line 1'], truncated: false, file: null })) }))
    toggle()
    const copy = await screen.findByRole('button', { name: LOG_FILTER_WORDS.copy })
    await act(async () => { fireEvent.click(copy) })
    expect(screen.queryByRole('button', { name: LOG_FILTER_WORDS.copied })).toBeNull()
  })

  it('shows an empty output and disables copying', async () =>
  {
    renderPanel(fakeApi({ jobLog: vi.fn(async () => okLog({ lines: [], truncated: false, file: null })) }))
    toggle()
    expect(await screen.findByText(LOG_FILTER_WORDS.emptyOutput)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: LOG_FILTER_WORDS.copy })).toBeDisabled()
  })

  it('explains when the jobs API is missing', () =>
  {
    renderPanel(fakeApi())
    toggle()
    expect(screen.getByRole('alert')).toHaveTextContent(LOG_FILTER_WORDS.unavailable)
  })

  it('shows a refusal and reads again on Try again', async () =>
  {
    const jobLog = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'not-found', message: 'MM-0142 has no output yet.', issues: [], details: null } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: '', issues: [], details: null } })
      .mockResolvedValueOnce(okLog({ lines: ['recovered'], truncated: false, file: null }))
    renderPanel(fakeApi({ jobLog }))
    toggle()
    expect(await screen.findByRole('alert')).toHaveTextContent('MM-0142 has no output yet.')
    fireEvent.click(screen.getByRole('button', { name: LOG_FILTER_WORDS.tryAgain }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(LOG_FILTER_WORDS.failed))
    toggle()
    toggle()
    expect(await screen.findByText('recovered')).toBeInTheDocument()
    expect(jobLog).toHaveBeenCalledTimes(3)
  })

  it('reports a failed call', async () =>
  {
    renderPanel(fakeApi({ jobLog: vi.fn(async () => { throw new Error('ipc closed') }) }))
    toggle()
    expect(await screen.findByRole('alert')).toHaveTextContent(LOG_FILTER_WORDS.failed)
  })

  it('ignores a reply that arrives after the panel closed for good', async () =>
  {
    let resolve: (value: CommandResult<JobLogResult>) => void = () => undefined
    const jobLog = vi.fn(() => new Promise<CommandResult<JobLogResult>>((r) => { resolve = r }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderPanel(fakeApi({ jobLog }))
    toggle()
    cleanup()
    await act(async () => { resolve(okLog({ lines: ['late'], truncated: false, file: null })) })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
