import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTO_GPU_SESSIONS,
  GPU_RECOVERY_MS,
  GpuBudget,
  MAX_GPU_SESSIONS,
  classifyGpuFailure,
  gpuSessionSetting,
  gpuVendorOf,
  type GpuBudgetOptions
} from '../../../src/main/jobs/gpu-budget'
import type { JobId } from '../../../src/shared/jobs/ids'
import { createManualTimers } from '../helpers/manual-timers'

const FIXTURES = join(__dirname, '..', 'fixtures', 'jobs', 'gpu')
const BUILDS = ['n9.0.2', '2022'] as const
const MINUTE = 60 * 1000

const stderr = (name: string, build: string): string => readFileSync(join(FIXTURES, `${name}-${build}.txt`), 'utf8')
const id = (n: number): JobId => `J${String(n).padStart(4, '0')}` as JobId

function budget(overrides: Partial<GpuBudgetOptions> = {}): { budget: GpuBudget; timers: ReturnType<typeof createManualTimers>; changes: number[] }
{
  const timers = createManualTimers()
  const changes: number[] = []
  const instance = new GpuBudget({
    timers,
    setting: { mode: 'auto' },
    vendor: 'nvenc',
    onChange: (state) => changes.push(state.limit),
    ...overrides
  })
  return { budget: instance, timers, changes }
}

function encodeMany(target: GpuBudget, ids: number[]): void
{
  for (const n of ids) target.lease(id(n), 'h264_nvenc').encoding()
}

describe('gpu vendors and settings', () =>
{
  it('names the family of a hardware encoder', () =>
  {
    expect(gpuVendorOf('h264_nvenc')).toBe('nvenc')
    expect(gpuVendorOf('hevc_nvenc')).toBe('nvenc')
    expect(gpuVendorOf('av1_qsv')).toBe('qsv')
    expect(gpuVendorOf('hevc_amf')).toBe('amf')
    expect(gpuVendorOf('libx264')).toBeNull()
  })

  it('gives Auto 4 NVENC sessions and 2 for QSV and AMF', () =>
  {
    expect(AUTO_GPU_SESSIONS).toEqual({ nvenc: 4, qsv: 2, amf: 2 })
    expect(gpuSessionSetting({ mode: 'auto' }, 'nvenc')).toBe(4)
    expect(gpuSessionSetting({ mode: 'auto' }, 'qsv')).toBe(2)
    expect(gpuSessionSetting({ mode: 'auto' }, 'amf')).toBe(2)
    expect(gpuSessionSetting({ mode: 'auto' }, null)).toBe(2)
  })

  it('clamps a fixed setting to 1 through 16', () =>
  {
    expect(MAX_GPU_SESSIONS).toBe(16)
    expect(gpuSessionSetting({ mode: 'fixed', count: 6 }, 'nvenc')).toBe(6)
    expect(gpuSessionSetting({ mode: 'fixed', count: 0 }, 'qsv')).toBe(1)
    expect(gpuSessionSetting({ mode: 'fixed', count: 40 }, 'amf')).toBe(16)
  })
})

describe('classifyGpuFailure on recorded stderr', () =>
{
  it.each(BUILDS)('reads a refused NVENC session as a session limit (%s)', (build) =>
  {
    const text = stderr('nvenc-session-limit', build)
    expect(text).toContain('OpenEncodeSessionEx failed: incompatible client key')
    expect(text).toContain('No capable devices found')
    expect(classifyGpuFailure(text, 11)).toBe('session-limit')
    expect(classifyGpuFailure(text, 0)).toBe('session-limit')
  })

  it.each(BUILDS)('reads "No capable devices found" by whether other GPU jobs run (%s)', (build) =>
  {
    const text = stderr('nvenc-no-device', build)
    expect(text).not.toContain('OpenEncodeSessionEx')
    expect(classifyGpuFailure(text, 2)).toBe('session-limit')
    expect(classifyGpuFailure(text, 0)).toBe('init-failed')
  })

  it.each(BUILDS)('reads a failed MFX session as an initialization failure (%s)', (build) =>
  {
    const text = stderr('qsv-init', build)
    expect(text).toContain('Error creating a MFX session')
    expect(classifyGpuFailure(text, 0)).toBe('init-failed')
    expect(classifyGpuFailure(text, 3)).toBe('init-failed')
  })

  it.each(BUILDS)('reads a failed AMF device as an initialization failure (%s)', (build) =>
  {
    const text = stderr('amf-init', build)
    expect(text).toContain('AMF failed to initialise')
    expect(classifyGpuFailure(text, 0)).toBe('init-failed')
    expect(classifyGpuFailure(text, 3)).toBe('init-failed')
  })

  it.each(BUILDS)('finds no GPU failure in a clean NVENC encode (%s)', (build) =>
  {
    expect(classifyGpuFailure(stderr('nvenc-ok', build), 3)).toBeNull()
    expect(classifyGpuFailure('Conversion failed!\n', 0)).toBeNull()
  })
})

describe('GpuBudget leases', () =>
{
  it('starts at its setting and counts leases and open sessions', () =>
  {
    const { budget: target } = budget()
    expect(target.limit).toBe(4)
    expect(target.setting).toBe(4)
    const lease = target.lease(id(1), 'h264_nvenc')
    target.lease(id(2), 'h264_nvenc')
    expect(target.state()).toEqual({ setting: 4, limit: 4, leased: 2, encoding: 0 })
    lease.encoding()
    expect(target.state().encoding).toBe(1)
    expect(lease.encoder).toBe('h264_nvenc')
    expect(lease.jobId).toBe(id(1))
  })

  it('gives a job one lease and returns it once', () =>
  {
    const { budget: target, changes } = budget()
    const first = target.lease(id(1), 'h264_nvenc')
    expect(target.lease(id(1), 'h264_nvenc')).toBe(first)
    expect(target.leaseOf(id(1))).toBe(first)
    first.release()
    first.release()
    target.release(id(1))
    expect(target.leaseOf(id(1))).toBeNull()
    expect(changes).toEqual([4])
  })

  it('ignores a stale lease after the job took a new one', () =>
  {
    const { budget: target } = budget()
    const stale = target.lease(id(1), 'h264_nvenc')
    stale.release()
    const fresh = target.lease(id(1), 'h264_nvenc')
    stale.encoding()
    stale.release()
    expect(target.leaseOf(id(1))).toBe(fresh)
    expect(target.state().encoding).toBe(0)
  })

  it('classifies through the lease with the other jobs encoding', () =>
  {
    const { budget: target } = budget()
    const lease = target.lease(id(1), 'h264_nvenc')
    const noDevice = stderr('nvenc-no-device', 'n9.0.2')
    expect(lease.classify(noDevice)).toBe('init-failed')
    target.lease(id(2), 'h264_nvenc')
    expect(lease.classify(noDevice)).toBe('init-failed')
    target.leaseOf(id(2))!.encoding()
    expect(lease.classify(noDevice)).toBe('session-limit')
  })
})

describe('GpuBudget session limits', () =>
{
  it('drops the budget to the other jobs encoding and requeues the job once', () =>
  {
    const { budget: target, changes } = budget()
    encodeMany(target, [1, 2, 3, 4])
    const decision = target.reportFailure(id(4), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(decision).toEqual({ action: 'requeue-gpu', reason: 'requeued-gpu', limit: 3, previousLimit: 4 })
    expect(target.limit).toBe(3)
    expect(changes).toEqual([3])
  })

  it('keeps at least one session when no other job was encoding', () =>
  {
    const { budget: target } = budget({ setting: { mode: 'fixed', count: 8 } })
    target.lease(id(1), 'h264_nvenc').encoding()
    expect(target.reportFailure(id(1), stderr('nvenc-session-limit', '2022'), true)).toMatchObject({ action: 'requeue-gpu', limit: 1 })
    expect(target.limit).toBe(1)
  })

  it('never raises the budget on a failure', () =>
  {
    const { budget: target } = budget()
    encodeMany(target, [1, 2])
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(1)
    encodeMany(target, [3, 4, 5])
    target.reportFailure(id(5), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(1)
  })

  it('fails a job on its second session-limit error', () =>
  {
    const { budget: target } = budget()
    encodeMany(target, [1, 2, 3])
    expect(target.reportFailure(id(3), stderr('nvenc-session-limit', 'n9.0.2'), true)?.action).toBe('requeue-gpu')
    target.release(id(3))
    target.lease(id(3), 'h264_nvenc').encoding()
    expect(target.reportFailure(id(3), stderr('nvenc-session-limit', 'n9.0.2'), true)).toEqual({ action: 'fail', code: 'gpu-session-limit' })
  })

  it('requeues a forgotten job again', () =>
  {
    const { budget: target } = budget()
    encodeMany(target, [1, 2])
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    target.forget(id(2))
    expect(target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)?.action).toBe('requeue-gpu')
  })

  it('treats a lone "No capable devices found" with others encoding as a session limit', () =>
  {
    const { budget: target } = budget()
    encodeMany(target, [1, 2, 3])
    expect(target.reportFailure(id(3), stderr('nvenc-no-device', 'n9.0.2'), true)).toMatchObject({ action: 'requeue-gpu', limit: 2 })
  })

  it('answers null for a failure that is not a GPU failure', () =>
  {
    const { budget: target, changes } = budget()
    encodeMany(target, [1])
    expect(target.reportFailure(id(1), stderr('nvenc-ok', 'n9.0.2'), true)).toBeNull()
    expect(changes).toEqual([])
    expect(target.limit).toBe(4)
  })
})

describe('GpuBudget initialization failures', () =>
{
  it.each(['qsv-init', 'amf-init', 'nvenc-no-device'])('requeues on the CPU fallback under auto (%s)', (name) =>
  {
    const { budget: target, changes } = budget()
    target.lease(id(1), 'h264_qsv').encoding()
    expect(target.reportFailure(id(1), stderr(name, 'n9.0.2'), true)).toEqual({ action: 'requeue-cpu', reason: 'requeued-cpu' })
    expect(target.onCpu(id(1))).toBe(true)
    expect(target.limit).toBe(4)
    expect(changes).toEqual([])
  })

  it('fails the job when its plan has no CPU fallback', () =>
  {
    const { budget: target } = budget()
    target.lease(id(1), 'h264_amf').encoding()
    expect(target.reportFailure(id(1), stderr('amf-init', '2022'), false)).toEqual({ action: 'fail', code: 'gpu-init-failed' })
    expect(target.onCpu(id(1))).toBe(false)
  })

  it('fails a job already moved to the CPU when it fails to start again', () =>
  {
    const { budget: target } = budget()
    target.reportFailure(id(1), stderr('qsv-init', '2022'), true)
    expect(target.reportFailure(id(1), stderr('qsv-init', '2022'), true)).toEqual({ action: 'fail', code: 'gpu-init-failed' })
    target.forget(id(1))
    expect(target.onCpu(id(1))).toBe(false)
  })
})

describe('GpuBudget recovery', () =>
{
  it('rises by one after every 10 quiet minutes up to the setting', async () =>
  {
    const { budget: target, timers, changes } = budget()
    encodeMany(target, [1, 2])
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(1)
    await timers.advance(GPU_RECOVERY_MS - 1)
    expect(target.limit).toBe(1)
    await timers.advance(1)
    expect(target.limit).toBe(2)
    await timers.advance(GPU_RECOVERY_MS)
    expect(target.limit).toBe(3)
    await timers.advance(GPU_RECOVERY_MS)
    expect(target.limit).toBe(4)
    expect(timers.pending()).toBe(0)
    await timers.advance(GPU_RECOVERY_MS)
    expect(target.limit).toBe(4)
    expect(changes).toEqual([1, 2, 3, 4])
  })

  it('restarts the quiet period on every session-limit error', async () =>
  {
    const { budget: target, timers } = budget()
    encodeMany(target, [1, 2, 3])
    target.reportFailure(id(3), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(2)
    target.release(id(3))
    await timers.advance(9 * MINUTE)
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(1)
    await timers.advance(9 * MINUTE)
    expect(target.limit).toBe(1)
    await timers.advance(MINUTE)
    expect(target.limit).toBe(2)
    expect(timers.pending()).toBe(1)
  })

  it('returns to the setting at the start of a run', async () =>
  {
    const { budget: target, timers } = budget()
    encodeMany(target, [1, 2])
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(1)
    target.runStarted()
    expect(target.limit).toBe(4)
    expect(timers.pending()).toBe(0)
    await timers.advance(GPU_RECOVERY_MS)
    expect(target.limit).toBe(4)
  })

  it('stops its timer on dispose', () =>
  {
    const { budget: target, timers } = budget()
    encodeMany(target, [1, 2])
    target.reportFailure(id(2), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(timers.pending()).toBe(1)
    target.dispose()
    target.dispose()
    expect(timers.pending()).toBe(0)
  })
})

describe('GpuBudget settings changes', () =>
{
  it('follows a new setting while the budget is whole', () =>
  {
    const { budget: target, changes } = budget()
    target.configure({ mode: 'fixed', count: 8 }, 'nvenc')
    expect(target.limit).toBe(8)
    target.configure({ mode: 'auto' }, 'qsv')
    expect(target.limit).toBe(2)
    expect(changes).toEqual([8, 2])
  })

  it('keeps a lowered budget lowered, capped by the new setting', async () =>
  {
    const { budget: target, timers } = budget({ setting: { mode: 'fixed', count: 8 } })
    encodeMany(target, [1, 2, 3, 4])
    target.reportFailure(id(4), stderr('nvenc-session-limit', 'n9.0.2'), true)
    expect(target.limit).toBe(3)
    target.configure({ mode: 'fixed', count: 6 }, 'nvenc')
    expect(target.limit).toBe(3)
    expect(target.setting).toBe(6)
    target.configure({ mode: 'fixed', count: 2 }, 'nvenc')
    expect(target.limit).toBe(2)
    expect(timers.pending()).toBe(0)
  })

  it('works without a change listener', () =>
  {
    const timers = createManualTimers()
    const target = new GpuBudget({ timers, setting: { mode: 'auto' }, vendor: null })
    const listener = vi.fn()
    target.lease(id(1), 'h264_amf').release()
    expect(target.limit).toBe(2)
    expect(listener).not.toHaveBeenCalled()
  })
})
