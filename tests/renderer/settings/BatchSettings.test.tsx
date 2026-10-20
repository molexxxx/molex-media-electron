import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  BatchSettings,
  defaultPolicy,
  DEFAULT_RUN_SETTINGS,
  folderDate,
  formatBytes,
  isPolicyLocked,
  resetBatchDefaults,
  resetMessage,
  usageText,
  type BatchSettingsApi
} from '../../../src/renderer/src/components/settings/tabs/BatchSettings'
import { createJobsStore, useJobsStore, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { useAppStore, type AppConfig } from '../../../src/renderer/src/stores/appStore'
import Settings, { APPLICATION_DEFAULTS } from '../../../src/renderer/src/components/settings/Settings'
import { JOB_STATES } from '../../../src/shared/jobs/types'
import type { BatchPolicy, CapabilitySummary, JobCounts, RecentFolder, RunSettings, RunState } from '../../../src/shared/jobs/types'
import type { CommandResult } from '../../../src/shared/jobs/contract'
import type { StoreApi } from 'zustand'

function counts(overrides: Partial<JobCounts> = {}): JobCounts
{
  const base = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as JobCounts
  return { ...base, ...overrides }
}

function run(overrides: Partial<RunState> = {}): RunState
{
  return {
    status: 'idle',
    runId: null,
    startedAt: null,
    pause: null,
    counts: counts(),
    progress: {} as RunState['progress'],
    workers: { setting: { mode: 'auto' }, limits: { total: 8, videoCpu: 2, gpu: 2 }, active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 } },
    quitWhenIdle: false,
    needsAck: null,
    ...overrides
  }
}

function policy(overrides: Partial<BatchPolicy> = {}): BatchPolicy
{
  return { rev: 3, destination: { mode: 'folder', folder: 'D:\\Out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off', ...overrides }
}

function capabilities(encoders: string[] = []): CapabilitySummary
{
  return {
    rev: 1,
    ffmpeg: { ready: true, version: '9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true, surroundMeter: true },
    encoders: [],
    gpu: { status: 'ready', vendor: encoders.length > 0 ? 'nvidia' : null, name: null, encoders },
    cpuCount: 8,
    platform: 'win32'
  } as CapabilitySummary
}

function ok<T>(value: T, seq = 1): Promise<CommandResult<T>>
{
  return Promise.resolve({ ok: true, value, seq })
}

function refused<T>(message: string): Promise<CommandResult<T>>
{
  return Promise.resolve({ ok: false, error: { code: 'invalid-state', message, issues: [], details: null } })
}

afterEach(() =>
{
  cleanup()
})

describe('isPolicyLocked', () =>
{
  it('is unlocked without a run or while idle', () =>
  {
    expect(isPolicyLocked(null)).toBe(false)
    expect(isPolicyLocked(run({ counts: counts({ queued: 4 }) }))).toBe(false)
  })

  it('locks while the run holds queued or active jobs', () =>
  {
    expect(isPolicyLocked(run({ status: 'running', counts: counts({ queued: 1 }) }))).toBe(true)
    expect(isPolicyLocked(run({ status: 'pausing', counts: counts({ encoding: 1 }) }))).toBe(true)
    expect(isPolicyLocked(run({ status: 'paused', counts: counts({ done: 3, pending: 2 }) }))).toBe(false)
  })
})

describe('usage text', () =>
{
  it('formats bytes by magnitude', () =>
  {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  it('names batches, history, and logs', () =>
  {
    expect(usageText({ runs: 1, historyBytes: 1024, logBytes: 0 })).toBe('1 batch · 1 KB of history · 0 B of logs')
    expect(usageText({ runs: 12, historyBytes: 0, logBytes: 1024 * 1024 })).toBe('12 batches · 0 B of history · 1.0 MB of logs')
  })
})

describe('defaultPolicy', () =>
{
  it('keeps the folder and restores the rest', () =>
  {
    const next = defaultPolicy(policy({ template: '{catalog}', conflict: 'overwrite', displaced: 'keep', gpu: 'require' }), capabilities(['h264_nvenc']), null)
    expect(next).toEqual({ destination: { mode: 'folder', folder: 'D:\\Out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' })
  })

  it('never restores Replace originals', () =>
  {
    const replace = policy({ destination: { mode: 'replace-originals' } })
    expect(defaultPolicy(replace, capabilities(), null).destination).toEqual({ mode: 'next-to-source' })
    expect(defaultPolicy(replace, null, 'C:\\Videos\\MolexMedia')).toMatchObject({ destination: { mode: 'folder', folder: 'C:\\Videos\\MolexMedia' }, template: '{name}', gpu: 'off' })
  })

  it('uses the next-to-source template without a folder', () =>
  {
    expect(defaultPolicy(policy({ destination: { mode: 'next-to-source' } }), capabilities(), null).template).toBe('{name}-{op}')
  })
})

function resetApi()
{
  return {
    setWorkers: vi.fn(() => ok(run().workers, 4)),
    setSettings: vi.fn(() => ok<RunSettings>(DEFAULT_RUN_SETTINGS, 5)),
    setPolicy: vi.fn(() => ok({ policy: policy(), demoted: [] }, 6))
  }
}

describe('resetBatchDefaults', () =>
{
  it('restores workers, run settings, and the policy through their commands', async () =>
  {
    const api = resetApi()
    const outcome = await resetBatchDefaults(api, { policy: policy({ conflict: 'skip' }), run: run(), capabilities: capabilities() })
    expect(api.setWorkers).toHaveBeenCalledWith({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } })
    expect(api.setSettings).toHaveBeenCalledWith({ settings: { priority: 'below-normal', keepAwake: true, verifyVideo: 'full', notify: { completion: true, firstFailure: true }, measureOnReview: true, includeSubfolders: true } })
    expect(api.setPolicy).toHaveBeenCalledWith({ policy: { destination: { mode: 'folder', folder: 'D:\\Out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' } })
    expect(outcome).toEqual({ seq: 6, errors: [], policyLocked: false })
  })

  it('skips an unchanged policy', async () =>
  {
    const api = resetApi()
    await resetBatchDefaults(api, { policy: policy(), run: run(), capabilities: capabilities() })
    expect(api.setPolicy).not.toHaveBeenCalled()
  })

  it('leaves the policy alone while a batch holds jobs and reports refusals', async () =>
  {
    const api = resetApi()
    api.setWorkers.mockImplementation(() => refused('Workers could not change.'))
    api.setSettings.mockImplementation(() => refused('Settings could not change.'))
    const outcome = await resetBatchDefaults(api, { policy: policy({ conflict: 'skip' }), run: run({ status: 'running', counts: counts({ queued: 2 }) }), capabilities: null })
    expect(api.setPolicy).not.toHaveBeenCalled()
    expect(outcome).toEqual({ seq: 0, errors: ['Workers could not change.', 'Settings could not change.'], policyLocked: true })
  })

  it('reports a refused policy', async () =>
  {
    const api = resetApi()
    api.setPolicy.mockImplementation(() => refused('The folder is not available.'))
    const outcome = await resetBatchDefaults(api, { policy: policy({ gpu: 'require' }), run: null, capabilities: null })
    expect(outcome.errors).toEqual(['The folder is not available.'])
    expect(outcome.seq).toBe(5)
  })
})

describe('resetMessage and folderDate', () =>
{
  it('words each reset outcome', () =>
  {
    expect(resetMessage({ seq: 1, errors: [], policyLocked: false })).toBe('Batch settings are back to their defaults.')
    expect(resetMessage({ seq: 1, errors: [], policyLocked: true })).toMatch(/^Workers and run settings are back/)
    expect(resetMessage({ seq: 0, errors: ['No.'], policyLocked: false })).toBe('Some settings were not reset: No.')
  })

  it('shows the month and day', () =>
  {
    expect(folderDate(new Date(2026, 9, 12, 12).getTime())).toBe('Oct 12')
  })
})

const FOLDER: RecentFolder = { path: 'D:\\Rips\\Podcasts', name: 'Podcasts', files: 212, addedAt: new Date(2026, 9, 12, 12).getTime() }

function seeded(overrides: Partial<JobsState> = {}): StoreApi<JobsState>
{
  const store = createJobsStore()
  store.setState({
    seq: 10,
    status: 'hydrated',
    policy: policy(),
    settings: DEFAULT_RUN_SETTINGS,
    run: run(),
    capabilities: capabilities(['h264_nvenc']),
    recentFolders: [FOLDER],
    ...overrides
  })
  return store
}

function fakeApi()
{
  return {
    setPolicy: vi.fn((req: { policy: Omit<BatchPolicy, 'rev'> }) => ok({ policy: { ...req.policy, rev: 4 }, demoted: [] }, 10)),
    setWorkers: vi.fn(() => ok(run().workers, 10)),
    setSettings: vi.fn(() => ok<RunSettings>(DEFAULT_RUN_SETTINGS, 10)),
    listRuns: vi.fn(() => ok({ runs: [], more: false, usage: { runs: 3, historyBytes: 2048, logBytes: 0 } }, 0)),
    deleteRuns: vi.fn(() => ok({ deleted: 3 }, 0)),
    forgetFolder: vi.fn(() => ok(null, 10)),
    clearRecentFolders: vi.fn(() => ok(null, 10))
  }
}

function renderTab(options: { store?: StoreApi<JobsState>; api?: ReturnType<typeof fakeApi>; pickFolder?: () => Promise<string | null> } = {})
{
  const store = options.store ?? seeded()
  const api = options.api ?? fakeApi()
  const pickFolder = options.pickFolder ?? vi.fn(() => Promise.resolve(null))
  render(<BatchSettings api={api as unknown as BatchSettingsApi} store={store} pickFolder={pickFolder} />)
  return { store, api, pickFolder }
}

const saveConfig = vi.fn()

beforeEach(() =>
{
  saveConfig.mockReset()
  vi.stubGlobal('api', { saveConfig })
})

afterEach(() =>
{
  vi.unstubAllGlobals()
})

describe('BatchSettings', () =>
{
  it('waits for the engine snapshot and names a failed connection', () =>
  {
    const store = createJobsStore()
    renderTab({ store })
    expect(screen.getByRole('status')).toHaveTextContent('Loading batch settings…')
    act(() => store.setState({ status: 'error', error: 'no reply' }))
    expect(screen.getByRole('status')).toHaveTextContent('Batch settings are unavailable: no reply.')
  })

  it('never offers Replace originals as a default', () =>
  {
    renderTab()
    const destination = screen.getByRole('radiogroup', { name: 'Destination' })
    expect(within(destination).getAllByRole('radio').map((radio) => radio.getAttribute('value') ?? radio.textContent)).toHaveLength(2)
    expect(screen.queryByRole('radio', { name: /Replace/ })).toBeNull()
    expect(screen.getByText(/Replace originals is chosen per batch/)).toBeInTheDocument()
  })

  it('checks no destination while the current batch replaces originals', () =>
  {
    renderTab({ store: seeded({ policy: policy({ destination: { mode: 'replace-originals' } }) }) })
    const destination = screen.getByRole('radiogroup', { name: 'Destination' })
    expect(within(destination).getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked)).toBe(false)
    expect(screen.getByText(/The current batch replaces its originals/)).toBeInTheDocument()
  })

  it('writes the destination and its default template through jobs:setPolicy', async () =>
  {
    const { api } = renderTab()
    fireEvent.click(screen.getByRole('radio', { name: /Next to each source/ }))
    await waitFor(() => expect(api.setPolicy).toHaveBeenCalledWith({ policy: { destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'off' } }))
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('browses for a folder and commits a typed folder', async () =>
  {
    const pickFolder = vi.fn(() => Promise.resolve('E:\\New'))
    const { api } = renderTab({ pickFolder })
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(api.setPolicy).toHaveBeenCalledWith({ policy: expect.objectContaining({ destination: { mode: 'folder', folder: 'E:\\New' } }) }))
    const folder = screen.getByRole('textbox', { name: 'Output folder' })
    fireEvent.change(folder, { target: { value: '  F:\\Out  ' } })
    fireEvent.keyDown(folder, { key: 'Enter' })
    await waitFor(() => expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: expect.objectContaining({ destination: { mode: 'folder', folder: 'F:\\Out' } }) }))
  })

  it('commits the file name on blur and drops it on Escape', async () =>
  {
    const { api } = renderTab()
    const template = screen.getByRole('textbox', { name: 'File name' })
    fireEvent.change(template, { target: { value: '{catalog} {name}' } })
    fireEvent.keyDown(template, { key: 'Escape' })
    expect(template).toHaveValue('{name}')
    fireEvent.change(template, { target: { value: '{catalog} {name}' } })
    fireEvent.blur(template)
    await waitFor(() => expect(api.setPolicy).toHaveBeenCalledWith({ policy: expect.objectContaining({ template: '{catalog} {name}' }) }))
  })

  it('writes the conflict rule, kept files, and GPU through jobs:setPolicy', async () =>
  {
    const { api } = renderTab()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'When the name is taken' })).getByRole('radio', { name: 'Overwrite it' }))
    await waitFor(() => expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: expect.objectContaining({ conflict: 'overwrite' }) }))
    fireEvent.click(screen.getByRole('switch', { name: 'Keep old files beside the new ones' }))
    await waitFor(() => expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: expect.objectContaining({ displaced: 'keep' }) }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'GPU encoding' })).getByRole('radio', { name: 'When the settings allow' }))
    await waitFor(() => expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: expect.objectContaining({ gpu: 'auto' }) }))
  })

  it('shows a refused policy beside its field', async () =>
  {
    const api = fakeApi()
    api.setPolicy.mockImplementation(() => refused('Choose a folder that exists.'))
    renderTab({ api })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'When the name is taken' })).getByRole('radio', { name: 'Skip the file' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a folder that exists.')
  })

  it('keeps the policy read-only during a run while workers and run settings stay live', async () =>
  {
    const store = seeded({ run: run({ status: 'running', counts: counts({ queued: 2, encoding: 1 }) }) })
    const { api } = renderTab({ store })
    expect(screen.getAllByText(/Locked while the batch runs/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('radio', { name: /Next to each source/ }))
    fireEvent.click(screen.getByRole('switch', { name: 'Keep old files beside the new ones' }))
    expect(screen.getByRole('textbox', { name: 'File name' })).toHaveAttribute('readonly')
    expect(api.setPolicy).not.toHaveBeenCalled()

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Jobs at once' })).getByRole('radio', { name: 'Fixed' }))
    await waitFor(() => expect(api.setWorkers).toHaveBeenCalledWith({ workers: { mode: 'fixed', count: 8 }, gpuSessions: null }))
    fireEvent.click(screen.getByRole('switch', { name: 'Keep the computer awake' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ settings: { keepAwake: false } }))
  })

  it('names the batch that holds the GPU lock', () =>
  {
    renderTab({ store: seeded({ run: run({ status: 'running', runId: 'R31' as RunState['runId'], counts: counts({ queued: 1 }) }) }) })
    expect(screen.getByText(/^GPU encoding is locked while/)).toBeInTheDocument()
  })

  it('writes every run setting through run:setSettings', async () =>
  {
    const { api } = renderTab()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Video verification' })).getByRole('radio', { name: 'Sampled' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { verifyVideo: 'sampled' } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Notify when a batch finishes' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { notify: { completion: false, firstFailure: true } } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Notify on the first returned job' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { notify: { completion: true, firstFailure: false } } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Measure loudness when Review opens' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { measureOnReview: false } }))
    fireEvent.click(screen.getByRole('switch', { name: 'Include subfolders' }))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { includeSubfolders: false } }))
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('shows priority and GPU sessions under More settings', async () =>
  {
    const { api } = renderTab()
    expect(screen.queryByRole('combobox', { name: 'Process priority' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More settings' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Process priority' }), { target: { value: 'normal' } })
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({ settings: { priority: 'normal' } }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'GPU encodes at once' })).getByRole('radio', { name: 'Fixed' }))
    await waitFor(() => expect(api.setWorkers).toHaveBeenLastCalledWith({ workers: { mode: 'auto' }, gpuSessions: { mode: 'fixed', count: 2 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Fewer settings' }))
    expect(screen.queryByRole('combobox', { name: 'Process priority' })).toBeNull()
  })

  it('shows the fixed worker count', () =>
  {
    renderTab({ store: seeded({ settings: { ...DEFAULT_RUN_SETTINGS, workers: { mode: 'fixed', count: 3 } } }) })
    expect(screen.getByRole('spinbutton', { name: 'Fixed workers' })).toBeInTheDocument()
    expect(screen.getByText(/^Up to 3 jobs at once/)).toBeInTheDocument()
  })

  it('shows history usage and clears it through runs:delete', async () =>
  {
    const { api } = renderTab()
    expect(await screen.findByText('3 batches · 2 KB of history · 0 B of logs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    expect(screen.getByRole('group', { name: /Clear every batch from history/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    await waitFor(() => expect(api.deleteRuns).toHaveBeenCalledWith({ runIds: 'all' }))
    expect(await screen.findByText('Cleared 3 batches from history. Their outputs stay on disk.')).toBeInTheDocument()
    expect(api.listRuns).toHaveBeenCalledTimes(2)
  })

  it('keeps history when the confirmation is declined and reports a refused clear', async () =>
  {
    const api = fakeApi()
    api.deleteRuns.mockImplementation(() => refused('The open batch cannot be deleted.'))
    renderTab({ api })
    await screen.findByText(/3 batches/)
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(api.deleteRuns).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The open batch cannot be deleted.')
  })

  it('reports unreadable history', async () =>
  {
    const api = fakeApi()
    api.listRuns.mockImplementation(() => refused('History could not be read.'))
    renderTab({ api })
    expect(await screen.findByRole('alert')).toHaveTextContent('History could not be read.')
  })

  it('lists recent folders with Forget and Clear', async () =>
  {
    const { api } = renderTab()
    expect(screen.getByText('D:\\Rips\\Podcasts · 212 files · Oct 12')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Forget Podcasts' }))
    await waitFor(() => expect(api.forgetFolder).toHaveBeenCalledWith({ path: 'D:\\Rips\\Podcasts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent folders' }))
    await waitFor(() => expect(api.clearRecentFolders).toHaveBeenCalledWith({}))
  })

  it('says when no folders are recent', () =>
  {
    renderTab({ store: seeded({ recentFolders: [] }) })
    expect(screen.getByText(/No recent folders/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear recent folders' })).toBeDisabled()
  })

  it('resets every field through the engine after a confirmation', async () =>
  {
    const store = seeded({ policy: policy({ conflict: 'skip', displaced: 'keep' }), settings: { ...DEFAULT_RUN_SETTINGS, keepAwake: false } })
    const { api } = renderTab({ store })
    fireEvent.click(screen.getByRole('button', { name: 'Reset batch settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(await screen.findByText('Batch settings are back to their defaults.')).toBeInTheDocument()
    expect(api.setWorkers).toHaveBeenCalledWith({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } })
    expect(api.setSettings).toHaveBeenCalledWith({ settings: expect.objectContaining({ keepAwake: true }) })
    expect(api.setPolicy).toHaveBeenCalledWith({ policy: { destination: { mode: 'folder', folder: 'D:\\Out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' } })
    expect(saveConfig).not.toHaveBeenCalled()
  })
})

describe('Settings page', () =>
{
  const config = {
    version: '3.0.0',
    autoUpdate: false,
    showNotifications: true,
    minimizeToTray: true,
    showTrayNotification: true,
    sidebarCollapsed: false,
    interfaceScale: 125,
    announceProgress: true,
    ytdlpBrowser: '',
    ffmpegPath: '',
    ffprobePath: ''
  } as unknown as AppConfig

  function stubWindow(jobs: ReturnType<typeof fakeApi>)
  {
    const save = vi.fn((partial: Partial<AppConfig>) => Promise.resolve({ ...config, ...partial }))
    vi.stubGlobal('api', {
      saveConfig: save,
      jobs,
      selectOutputDir: vi.fn(() => Promise.resolve(null)),
      getInstalledBrowsers: vi.fn(() => Promise.resolve([])),
      getCookieInfo: vi.fn(() => Promise.resolve(null))
    })
    return save
  }

  beforeEach(() =>
  {
    useAppStore.setState({ config })
    useJobsStore.setState({ seq: 10, status: 'hydrated', policy: policy({ conflict: 'skip' }), settings: DEFAULT_RUN_SETTINGS, run: run(), capabilities: capabilities(), recentFolders: [] })
  })

  afterEach(() =>
  {
    useJobsStore.setState({ policy: null, settings: null, run: null, capabilities: null })
  })

  it('opens on Batch beside Presets, FFmpeg, and Application, with no loudness tab', () =>
  {
    stubWindow(fakeApi())
    render(<Settings />)
    const tabs = screen.getByRole('tablist', { name: 'Settings sections' })
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Batch', 'Presets', 'FFmpeg', 'Application'])
    expect(within(tabs).getByRole('tab', { name: 'Batch' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Output' })).toBeInTheDocument()
  })

  it('resets the application keys through config:save and the batch fields through the engine', async () =>
  {
    const jobs = fakeApi()
    const save = stubWindow(jobs)
    render(<Settings />)
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name: 'Application' }))
    fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }))
    await waitFor(() => expect(jobs.setPolicy).toHaveBeenCalled())
    expect(save).toHaveBeenCalledWith(APPLICATION_DEFAULTS)
    expect(Object.keys(save.mock.calls[0][0])).not.toContain('jobs')
    expect(jobs.setWorkers).toHaveBeenCalledWith({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } })
    expect(jobs.setPolicy).toHaveBeenCalledWith({ policy: expect.objectContaining({ conflict: 'rename' }) })
  })
})
