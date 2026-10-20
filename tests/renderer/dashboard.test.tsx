import React from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Dashboard, { addFilesWithOperation, ffmpegShortVersion, memoryWords, tileDetail, TILE_OUTPUT, type OperationAddDeps } from '../../src/renderer/src/components/dashboard/Dashboard'
import * as toolCard from '../../src/renderer/src/components/dashboard/components/ToolCard'
import { StatBar } from '../../src/renderer/src/components/dashboard/components/StatCard'
import { RecentActivity } from '../../src/renderer/src/components/dashboard/components/RecentActivity'
import { initialJobsState, useJobsStore } from '../../src/renderer/src/stores/jobs'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import { applyPreset, DEFAULT_PRESETS } from '../../src/shared/jobs/presets'
import { OPERATIONS, type Operation } from '../../src/shared/jobs/recipes'
import type { JobId, RunId } from '../../src/shared/jobs/ids'
import type { JobState, JobView, RunState } from '../../src/shared/jobs/types'

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

function seed(jobs: readonly JobView[], run: RunState | null = null): void
{
  useJobsStore.setState({
    jobs: Object.fromEntries(jobs.map((item) => [item.id, item])) as Record<JobId, JobView>,
    order: jobs.map((item) => item.id as JobId),
    run
  })
}

function stat(label: string): string
{
  return (document.querySelector(`[data-stat="${label}"]`) as HTMLElement).textContent ?? ''
}

const R1 = 'R-0001' as RunId
const R2 = 'R-0002' as RunId

beforeEach(() =>
{
  nextSeq = 1
  useJobsStore.setState(initialJobsState(), true)
})

afterEach(() =>
{
  cleanup()
})

describe('StatBar', () =>
{
  it('counts pending and queued jobs as Waiting and analyzing through finalizing as Active', () =>
  {
    seed([
      job('pending'),
      job('pending'),
      job('queued', { runId: R1 }),
      job('analyzing', { runId: R1 }),
      job('encoding', { runId: R1 }),
      job('verifying', { runId: R1 }),
      job('finalizing', { runId: R1 }),
      job('held', { runId: R1 }),
      job('done', { runId: R1, endedAt: 5 })
    ])
    render(<StatBar />)
    expect(stat('Waiting')).toBe('3')
    expect(stat('Active')).toBe('4')
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('counts Done and Need attention for the last batch only', () =>
  {
    seed([
      job('done', { runId: R1, endedAt: 1 }),
      job('failed', { runId: R1, endedAt: 2 }),
      job('done', { runId: R2, endedAt: 3 }),
      job('done', { runId: R2, endedAt: 4, warnings: [{ code: 'clipped', message: 'Clipped' }] as JobView['warnings'] }),
      job('failed', { runId: R2, endedAt: 5, acknowledged: true }),
      job('interrupted', { runId: R2, endedAt: 6 }),
      job('held', { runId: R2 }),
      job('pending')
    ])
    render(<StatBar />)
    expect(stat('Done')).toBe('2')
    expect(stat('Need attention')).toBe('3')
  })

  it('reads the current run before any older batch', () =>
  {
    seed([
      job('done', { runId: R2, endedAt: 3 }),
      job('done', { runId: R1, endedAt: 2 }),
      job('failed', { runId: R1, endedAt: 2 }),
      job('done', { runId: R1, endedAt: 1 })
    ], { runId: R1 } as RunState)
    render(<StatBar />)
    expect(stat('Done')).toBe('2')
    expect(stat('Need attention')).toBe('1')
  })

  it('shows zeros before any batch', () =>
  {
    seed([job('pending')])
    render(<StatBar />)
    expect(stat('Waiting')).toBe('1')
    expect(stat('Done')).toBe('0')
    expect(stat('Need attention')).toBe('0')
  })
})

describe('RecentActivity', () =>
{
  it('lists the last six settled jobs by endedAt, newest first, with catalog numbers', () =>
  {
    seed([
      job('done', { runId: R1, endedAt: 10 }),
      job('failed', { runId: R1, endedAt: 70 }),
      job('canceled', { runId: R1, endedAt: 30 }),
      job('skipped', { runId: R1, endedAt: 40 }),
      job('interrupted', { runId: R1, endedAt: 50 }),
      job('done', { runId: R1, endedAt: 60 }),
      job('done', { runId: R1, endedAt: 20 }),
      job('held', { runId: R1 }),
      job('encoding', { runId: R1 }),
      job('pending')
    ])
    render(<RecentActivity />)
    const rows = [...document.querySelectorAll('[data-job]')].map((row) => row.getAttribute('data-job'))
    expect(rows).toEqual(['MM-0002', 'MM-0006', 'MM-0005', 'MM-0004', 'MM-0003', 'MM-0007'])
    expect(screen.getByText('MM-0002')).toBeInTheDocument()
    expect(screen.getByText('2', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
  })

  it('words each status through StatusLabel and spells Canceled the American way', () =>
  {
    seed([
      job('canceled', { runId: R1, endedAt: 3 }),
      job('failed', { runId: R1, endedAt: 2 }),
      job('done', { runId: R1, endedAt: 1, recipe: { kind: 'boost' } as JobView['recipe'], recipeLabel: 'Gentle lift' })
    ])
    render(<RecentActivity />)
    expect(screen.getByText('Canceled')).toBeInTheDocument()
    expect(screen.queryByText(/Cancelled/)).toBeNull()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(document.querySelectorAll('.ui-status, [data-status]').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByText(/Gain/)).toBeInTheDocument()
    expect(screen.queryByText(/Boost|Volume/)).toBeNull()
  })

  it('says so when no job has ended', () =>
  {
    seed([job('pending')])
    render(<RecentActivity />)
    expect(screen.getByText('Finished jobs appear here.')).toBeInTheDocument()
    expect(document.querySelector('[data-job]')).toBeNull()
  })
})

type AddRequest = Parameters<OperationAddDeps['add']>[0]
type AddReply = Awaited<ReturnType<OperationAddDeps['add']>>

const REFUSED = { ok: false, error: { code: 'queue-full', message: 'The queue is full.', issues: [], details: null } } as unknown as AddReply

function addDeps(paths: string[] = ['D:\\Rips\\a.wav', 'D:\\Rips\\b.wav'], reply?: AddReply)
{
  const requests: AddRequest[] = []
  const deps = {
    openFiles: vi.fn(async () => paths),
    add: vi.fn(async (request: AddRequest) =>
    {
      requests.push(request)
      return reply ?? ({ ok: true, seq: 4, value: { added: request.paths.map((_, index) => `MM-${String(index + 50).padStart(4, '0')}`) } } as unknown as AddReply)
    }) as unknown as OperationAddDeps['add'],
    showBatch: vi.fn()
  }
  return { deps, requests }
}

describe('addFilesWithOperation', () =>
{
  it.each(OPERATIONS)('adds the picked files with the default preset of %s and then shows Batch', async (op: Operation) =>
  {
    const { deps, requests } = addDeps()
    const outcome = await addFilesWithOperation(op, deps)
    expect(outcome).toEqual({ status: 'added', added: 2 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      paths: ['D:\\Rips\\a.wav', 'D:\\Rips\\b.wav'],
      recipe: applyPreset(DEFAULT_PRESETS[op], TILE_OUTPUT),
      origin: 'files',
      after: null,
      recursive: false,
      allowSecondJobs: false,
      force: false
    })
    expect(requests[0].recipe?.kind).toBe(op)
    expect(deps.showBatch).toHaveBeenCalledTimes(1)
  })

  it('adds nothing and stays when the picker closes empty', async () =>
  {
    const { deps } = addDeps([])
    expect(await addFilesWithOperation('normalize', deps)).toEqual({ status: 'canceled' })
    expect(deps.add).not.toHaveBeenCalled()
    expect(deps.showBatch).not.toHaveBeenCalled()
  })

  it('stays on the Dashboard with the engine message when the add is refused', async () =>
  {
    const { deps } = addDeps(undefined, REFUSED)
    expect(await addFilesWithOperation('convert', deps)).toEqual({ status: 'refused', message: 'The queue is full.' })
    expect(deps.showBatch).not.toHaveBeenCalled()
  })

  it('names each tile by the preset it starts with', () =>
  {
    for (const op of OPERATIONS)
    {
      expect(tileDetail(op)).toMatch(/^Starts with /)
      expect(tileDetail(op)).not.toBe('Starts with the default preset')
    }
  })
})

describe('Dashboard', () =>
{
  afterEach(() =>
  {
    delete (window as unknown as { api?: unknown }).api
  })

  it('offers one "Add files with" row per operation and says Gain, never Boost or Volume', () =>
  {
    const { deps } = addDeps()
    render(<Dashboard deps={deps} />)
    for (const name of ['Normalize', 'Gain', 'Convert', 'Compress', 'Extract'])
    {
      expect(screen.getByRole('button', { name: new RegExp(`^Add files with ${name}…`) })).toBeInTheDocument()
    }
    expect(document.body.textContent).not.toMatch(/Boost|Volume/)
  })

  it('adds only new jobs from a tile and leaves the queue as it was', async () =>
  {
    seed([job('pending', { recipe: { kind: 'convert' } as JobView['recipe'] })])
    const before = useJobsStore.getState().jobs
    const { deps, requests } = addDeps()
    render(<Dashboard deps={deps} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: /^Add files with Gain…/ }))
    })
    await waitFor(() => expect(deps.showBatch).toHaveBeenCalledTimes(1))
    expect(requests).toHaveLength(1)
    expect(requests[0].recipe?.kind).toBe('boost')
    expect(useJobsStore.getState().jobs).toBe(before)
  })

  it('ignores a second tile while the picker is open', async () =>
  {
    let close: (paths: string[]) => void = () => undefined
    const { deps } = addDeps()
    deps.openFiles = vi.fn(() => new Promise<string[]>((resolve) =>
    {
      close = resolve
    }))
    render(<Dashboard deps={deps} />)
    fireEvent.click(screen.getByRole('button', { name: /^Add files with Normalize…/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add files with Convert…/ }))
    expect(deps.openFiles).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /^Add files with Convert…/ })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => close([]))
    expect(screen.getByRole('button', { name: /^Add files with Convert…/ })).not.toHaveAttribute('aria-disabled')
    expect(deps.add).not.toHaveBeenCalled()
  })

  it('shows a refusal in a banner', async () =>
  {
    const { deps } = addDeps(undefined, REFUSED)
    render(<Dashboard deps={deps} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: /^Add files with Extract…/ }))
    })
    expect(await screen.findByText('The queue is full.')).toBeInTheDocument()
    expect(screen.getByText('The files were not added.')).toBeInTheDocument()
  })

  it('opens the Editor and the Player', () =>
  {
    const setView = vi.fn()
    useAppStore.setState({ setView } as never)
    const { deps } = addDeps()
    render(<Dashboard deps={deps} />)
    fireEvent.click(screen.getByRole('button', { name: /^Media Editor/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Media Player/ }))
    expect(setView.mock.calls).toEqual([['editor'], ['player']])
  })

  it('reads the system panel from main', async () =>
  {
    (window as unknown as { api: unknown }).api = {
      getSystemInfo: async () => ({ cpus: 12, cpuModel: 'Test CPU', cpuUsage: 14.2, totalMemory: 32 * 1024 ** 3, freeMemory: 24 * 1024 ** 3, platform: 'win32', arch: 'x64' }),
      getGpuInfo: async () => ({ mode: 'nvenc', label: 'NVENC', vendor: 'nvidia', pending: false, gpuModel: 'Test GPU' }),
      getGpuUsage: async () => ({ usage: 7 })
    }
    useAppStore.setState({ ffmpegVersion: 'ffmpeg version 9.0.2 Copyright (c) 2000-2026' } as never)
    const { deps } = addDeps()
    render(<Dashboard deps={deps} />)
    expect(await screen.findByText('8.0 of 32.0 GB')).toBeInTheDocument()
    expect(screen.getByText('25% used')).toBeInTheDocument()
    expect(screen.getByText('12 cores · 14% load')).toBeInTheDocument()
    expect(await screen.findByText('NVIDIA')).toBeInTheDocument()
    expect(await screen.findByText('Test GPU · 7% load')).toBeInTheDocument()
    expect(screen.getByText('9.0.2')).toBeInTheDocument()
    expect(screen.getByText('Windows x64')).toBeInTheDocument()
  })

  it('keeps the system panel quiet while main does not answer', () =>
  {
    useAppStore.setState({ ffmpegVersion: null } as never)
    const { deps } = addDeps()
    render(<Dashboard deps={deps} />)
    expect(screen.getAllByText('Detecting…').length).toBeGreaterThanOrEqual(4)
  })
})

describe('dashboard helpers', () =>
{
  it('words memory and the FFmpeg version', () =>
  {
    expect(memoryWords(null)).toBeNull()
    expect(memoryWords({ totalMemory: 0, freeMemory: 0 })).toBeNull()
    expect(memoryWords({ totalMemory: 16 * 1024 ** 3, freeMemory: 4 * 1024 ** 3 })).toEqual({ value: '12.0 of 16.0 GB', detail: '75% used' })
    expect(ffmpegShortVersion(null)).toBeNull()
    expect(ffmpegShortVersion('  ')).toBeNull()
    expect(ffmpegShortVersion('ffmpeg version n7.1-12 Copyright')).toBe('n7.1-12')
  })

  it('keeps no animated-background helpers in the tool rows', () =>
  {
    expect(Object.keys(toolCard).sort()).toEqual(['ToolRow'])
  })

  it('reads no old batch field of the app store', () =>
  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src/components/dashboard')
    const files = ['Dashboard.tsx', 'components/RecentActivity.tsx', 'components/StatCard.tsx', 'components/ToolCard.tsx']
    const allowed = new Set(['setView', 'ffmpegVersion', 'setSystemInfo'])
    for (const file of files)
    {
      const text = readFileSync(path.join(root, file), 'utf8')
      expect(text).not.toMatch(/useAppStore\(\s*\)/)
      for (const match of text.matchAll(/useAppStore\(\(s\) => s\.(\w+)\)/g))
      {
        expect(allowed.has(match[1])).toBe(true)
      }
      expect(text).not.toMatch(/\b(tasks|isProcessing|totalProcessed|totalErrors|setOperation|drawBg|drawEditorBg|drawPlayerBg|ToolCardBackground)\b/)
    }
  })
})
