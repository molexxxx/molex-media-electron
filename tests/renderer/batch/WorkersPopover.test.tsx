/**
 * The Workers popover: Auto states the effective limits in words, Fixed sends a count of 1 to 64, worker changes
 * stay live during a run while GPU encoding locks, the GPU choice is Off or "When the recipe allows" (disabled with
 * the reason when no encoder is found), and the detection line names the adapter.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { formatRunId } from '../../../src/shared/jobs/ids'
import type { BatchPolicy, CapabilitySummary, RunSettings, WorkersState } from '../../../src/shared/jobs/types'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import
{
  autoLimitsSentence,
  detectionLine,
  encoderFamily,
  fixedLimitsSentence,
  gpuLockedMessage,
  gpuUnavailable,
  WORKERS_COPY,
  WorkersPanel,
  WorkersPopover,
  workersText
} from '../../../src/renderer/src/components/batch/header/WorkersPopover'

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

function workers(over: Partial<WorkersState> = {}): WorkersState
{
  return {
    setting: { mode: 'auto' },
    limits: { total: 16, videoCpu: 2, gpu: 2 },
    active: { total: 6, videoCpu: 2, gpu: 1, analysis: 0, starting: 0 },
    ...over
  }
}

function settings(over: Partial<RunSettings> = {}): RunSettings
{
  return {
    workers: { mode: 'auto' },
    gpuSessions: { mode: 'auto' },
    priority: 'below-normal',
    keepAwake: true,
    verifyVideo: 'full',
    notify: { completion: true, firstFailure: true },
    measureOnReview: true,
    includeSubfolders: true,
    ...over
  }
}

function gpu(over: Partial<CapabilitySummary['gpu']> = {}): CapabilitySummary['gpu']
{
  return { status: 'ready', vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', encoders: ['h264_nvenc', 'hevc_nvenc'], ...over }
}

function capabilities(over: Partial<CapabilitySummary['gpu']> = {}): CapabilitySummary
{
  return {
    rev: 1,
    ffmpeg: { ready: true, version: '9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
    encoders: [],
    gpu: gpu(over),
    cpuCount: 16,
    platform: 'win32'
  }
}

function policy(over: Partial<BatchPolicy> = {}): BatchPolicy
{
  return { rev: 1, destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto', ...over }
}

function refused(message: string): { ok: false; error: { code: 'invalid-state'; message: string; issues: never[]; details: null } }
{
  return { ok: false, error: { code: 'invalid-state', message, issues: [], details: null } }
}

interface PanelOptions
{
  workers?: WorkersState | null
  settings?: RunSettings | null
  capabilities?: CapabilitySummary | null
  policy?: BatchPolicy | null
  running?: boolean
  onOpenSettings?: () => void
  setWorkers?: ReturnType<typeof vi.fn>
  setPolicy?: ReturnType<typeof vi.fn>
}

function panel(options: PanelOptions = {}): { setWorkers: ReturnType<typeof vi.fn>; setPolicy: ReturnType<typeof vi.fn> }
{
  const setWorkers = options.setWorkers ?? vi.fn(async () => ({ ok: true, value: workers(), seq: 1 }))
  const setPolicy = options.setPolicy ?? vi.fn(async (req: { policy: Omit<BatchPolicy, 'rev'> }) => ({ ok: true, value: { policy: { ...req.policy, rev: 2 }, demoted: [] }, seq: 1 }))
  render(
    <TestBatchActionsProvider api={{ setWorkers, setPolicy } as never}>
      <WorkersPanel
        workers={options.workers === undefined ? workers() : options.workers}
        settings={options.settings === undefined ? settings() : options.settings}
        capabilities={options.capabilities === undefined ? capabilities() : options.capabilities}
        policy={options.policy === undefined ? policy() : options.policy}
        runId={options.running === true ? formatRunId(31) : null}
        onOpenSettings={options.onOpenSettings}
      />
    </TestBatchActionsProvider>
  )
  return { setWorkers, setPolicy }
}

describe('worker sentences', () =>
{
  it('states Auto\'s effective limits in words', () =>
  {
    expect(autoLimitsSentence({ total: 16, videoCpu: 2, gpu: 3 }))
      .toBe('Auto runs up to 16 jobs at once on this computer, of which at most 2 are CPU video encodes and 3 are GPU encodes.')
    expect(autoLimitsSentence({ total: 4, videoCpu: 1, gpu: 1 }))
      .toBe('Auto runs up to 4 jobs at once on this computer, of which at most 1 is a CPU video encode and 1 is a GPU encode.')
    expect(autoLimitsSentence({ total: 1, videoCpu: 1, gpu: 0 }))
      .toBe('Auto runs up to 1 job at once on this computer, of which at most 1 is a CPU video encode.')
  })

  it('states a fixed count and its value text', () =>
  {
    expect(fixedLimitsSentence(4)).toBe('Up to 4 jobs at once, including up to 4 video encodes that each use every core. Auto is faster for video.')
    expect(fixedLimitsSentence(1)).toBe('Up to 1 job at once, including up to 1 video encode that uses every core. Auto is faster for video.')
    expect(workersText(1)).toBe('1 worker')
    expect(workersText(16)).toBe('16 workers')
  })

  it('names the encoder family from the vendor or the encoder names', () =>
  {
    expect(encoderFamily(gpu())).toBe('NVENC')
    expect(encoderFamily(gpu({ vendor: 'intel' }))).toBe('Quick Sync')
    expect(encoderFamily(gpu({ vendor: null, encoders: ['h264_amf'] }))).toBe('AMF')
    expect(encoderFamily(gpu({ vendor: null, encoders: ['hevc_videotoolbox'] }))).toBe('VideoToolbox')
    expect(encoderFamily(gpu({ vendor: null, encoders: ['h264_vaapi'] }))).toBe('VA-API')
    expect(encoderFamily(gpu({ vendor: null, encoders: ['h264_qsv'] }))).toBe('Quick Sync')
    expect(encoderFamily(gpu({ vendor: null, encoders: ['h264_other'] }))).toBeNull()
  })

  it('names the adapter in the detection line', () =>
  {
    expect(detectionLine(capabilities())).toBe('Detected: NVIDIA GeForce RTX 4070, NVENC.')
    expect(detectionLine(capabilities({ name: null, vendor: 'amd', encoders: ['h264_amf'] }))).toBe('Detected: an AMD GPU, AMF.')
    expect(detectionLine(capabilities({ name: null, vendor: null, encoders: ['h264_vaapi'] }))).toBe('Detected: a GPU, VA-API.')
    expect(detectionLine(capabilities({ name: 'Mystery Card', vendor: null, encoders: ['h264_other'] }))).toBe('Detected: Mystery Card.')
    expect(detectionLine(capabilities({ status: 'detecting' }))).toBe('Checking the GPU…')
    expect(detectionLine(null)).toBe('Checking the GPU…')
    expect(detectionLine(capabilities({ encoders: [] }))).toBeNull()
  })

  it('treats a finished detection without encoders as unavailable', () =>
  {
    expect(gpuUnavailable(capabilities({ encoders: [] }))).toBe(true)
    expect(gpuUnavailable(capabilities({ status: 'detecting', encoders: [] }))).toBe(false)
    expect(gpuUnavailable(null)).toBe(false)
    expect(gpuLockedMessage(formatRunId(31))).toBe('GPU encoding is locked while Batch 31 runs.')
  })
})

describe('WorkersPanel', () =>
{
  it('shows Auto with its limits, the GPU choice, the detection line, and the session budget', () =>
  {
    panel()
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeInTheDocument()
    const auto = screen.getByRole('radiogroup', { name: 'Jobs at once' })
    expect(auto).toHaveAccessibleDescription('Auto runs up to 16 jobs at once on this computer, of which at most 2 are CPU video encodes and 2 are GPU encodes.')
    expect(screen.getAllByRole('radio', { name: 'Auto' })[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'When the settings allow' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'When the settings allow' })).toBeEnabled()
    expect(screen.getByText('Detected: NVIDIA GeForce RTX 4070, NVENC.')).toBeInTheDocument()
    expect(screen.getByText(WORKERS_COPY.consequence)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Auto (2)' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(WORKERS_COPY.sessionsHint)).toBeInTheDocument()
    expect(screen.queryByText(WORKERS_COPY.live)).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByRole('button', { name: WORKERS_COPY.settingsLink })).toBeNull()
  })

  it('switches to Fixed at the current total', async () =>
  {
    const { setWorkers } = panel()
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[0])
    })
    expect(setWorkers).toHaveBeenCalledWith({ workers: { mode: 'fixed', count: 16 }, gpuSessions: null })
  })

  it('commits a fixed count from the range field with its value text and hint', async () =>
  {
    const { setWorkers } = panel({ workers: workers({ setting: { mode: 'fixed', count: 4 }, limits: { total: 4, videoCpu: 4, gpu: 2 } }) })
    expect(screen.getByRole('slider', { name: 'Fixed workers' })).toHaveAttribute('aria-valuetext', '4 workers')
    expect(screen.getByText(fixedLimitsSentence(4))).toBeInTheDocument()
    const exact = screen.getByRole('spinbutton', { name: 'Fixed workers exact value' })
    fireEvent.change(exact, { target: { value: '8' } })
    await act(async () =>
    {
      fireEvent.keyDown(exact, { key: 'Enter' })
    })
    expect(setWorkers).toHaveBeenCalledWith({ workers: { mode: 'fixed', count: 8 }, gpuSessions: null })
  })

  it('returns to Auto', async () =>
  {
    const { setWorkers } = panel({ workers: workers({ setting: { mode: 'fixed', count: 4 } }) })
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Auto' })[0])
    })
    expect(setWorkers).toHaveBeenCalledWith({ workers: { mode: 'auto' }, gpuSessions: null })
  })

  it('stays live during a run and locks GPU encoding with the reason', async () =>
  {
    const { setWorkers, setPolicy } = panel({ running: true })
    expect(screen.getByText(WORKERS_COPY.live)).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Jobs at once' })).toHaveAccessibleDescription(expect.stringContaining(WORKERS_COPY.live))
    expect(screen.getByText('GPU encoding is locked while Batch 31 runs.')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'GPU encoding' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    })
    expect(setPolicy).not.toHaveBeenCalled()
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[0])
    })
    expect(setWorkers).toHaveBeenCalledTimes(1)
  })

  it('sends the GPU choice through the output policy and shows a refusal inline', async () =>
  {
    const setPolicy = vi.fn(async () => refused('Output settings are locked while a batch runs.'))
    panel({ setPolicy })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    })
    expect(setPolicy).toHaveBeenCalledWith({ policy: { destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' } })
    expect(screen.getByText('Output settings are locked while a batch runs.')).toBeInTheDocument()
  })

  it('shows a required GPU as allowed and Off as off', () =>
  {
    panel({ policy: policy({ gpu: 'require' }) })
    expect(screen.getByRole('radio', { name: 'When the settings allow' })).toHaveAttribute('aria-checked', 'true')
    cleanup()
    panel({ policy: policy({ gpu: 'off' }) })
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  })

  it('disables "When the recipe allows" with the reason when no encoder is found', () =>
  {
    panel({ capabilities: capabilities({ name: null, vendor: null, encoders: [] }), policy: policy({ gpu: 'off' }) })
    const allowed = screen.getByRole('radio', { name: 'When the settings allow' })
    expect(allowed).toBeDisabled()
    expect(allowed).toHaveAccessibleDescription(WORKERS_COPY.noEncoder)
    expect(screen.getAllByText(WORKERS_COPY.noEncoder).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^Detected:/)).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'GPU encodes at once' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('says it is checking the GPU while detection runs', () =>
  {
    panel({ capabilities: capabilities({ status: 'detecting', name: null, encoders: [] }) })
    expect(screen.getByText('Checking the GPU…')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'When the settings allow' })).toBeEnabled()
  })

  it('shows a worker refusal inline', async () =>
  {
    const setWorkers = vi.fn(async () => refused('The worker count must be 1 to 64.'))
    panel({ setWorkers })
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[0])
    })
    expect(screen.getByText('The worker count must be 1 to 64.')).toBeInTheDocument()
  })

  it('fixes and edits the GPU session budget', async () =>
  {
    const { setWorkers } = panel()
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[1])
    })
    expect(setWorkers).toHaveBeenCalledWith({ workers: { mode: 'auto' }, gpuSessions: { mode: 'fixed', count: 2 } })
    cleanup()
    const next = panel({ settings: settings({ gpuSessions: { mode: 'fixed', count: 3 } }), workers: workers({ setting: { mode: 'fixed', count: 6 } }) })
    expect(screen.getAllByRole('radio', { name: 'Auto' })[1]).toHaveAttribute('aria-checked', 'false')
    const field = screen.getByRole('spinbutton', { name: 'Fixed GPU encodes' })
    expect(field).toHaveValue('3')
    fireEvent.change(field, { target: { value: '5' } })
    await act(async () =>
    {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    expect(next.setWorkers).toHaveBeenCalledWith({ workers: { mode: 'fixed', count: 6 }, gpuSessions: { mode: 'fixed', count: 5 } })
    await act(async () =>
    {
      fireEvent.click(screen.getAllByRole('radio', { name: 'Auto' })[1])
    })
    expect(next.setWorkers).toHaveBeenLastCalledWith({ workers: { mode: 'fixed', count: 6 }, gpuSessions: { mode: 'auto' } })
  })

  it('links to Settings when the page supplies it', () =>
  {
    const onOpenSettings = vi.fn()
    panel({ onOpenSettings })
    fireEvent.click(screen.getByRole('button', { name: WORKERS_COPY.settingsLink }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('says it is loading before the first snapshot', () =>
  {
    panel({ workers: null })
    expect(screen.getByText('Loading the worker settings…')).toBeInTheDocument()
  })

  it('leaves the GPU choice unchecked and inert without a policy', async () =>
  {
    const { setPolicy } = panel({ policy: null })
    expect(screen.getByRole('radiogroup', { name: 'GPU encoding' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    })
    expect(setPolicy).not.toHaveBeenCalled()
  })
})

describe('WorkersPopover', () =>
{
  it('renders the header\'s trigger and the panel in a dialog named Workers', () =>
  {
    render(
      <TestBatchActionsProvider>
        <WorkersPopover
          control={{ label: '16 workers · 6 active', tooltip: 'Jobs at once and GPU encoding', locked: false }}
          workers={workers()}
          settings={settings()}
          capabilities={capabilities()}
          policy={policy()}
          runId={null}
        />
      </TestBatchActionsProvider>
    )
    const trigger = screen.getByRole('button', { name: '16 workers · 6 active' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(dialog).toHaveAttribute('aria-label', 'Workers')
    expect(dialog).toHaveTextContent(WORKERS_COPY.sessionsHint)
  })
})
