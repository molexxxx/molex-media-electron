/**
 * GPU encoder sessions: the session budget, the leases GPU jobs take with their dispatch claims, the classification
 * of a failed GPU encode's stderr, the budget's drop after a session-limit error, and its recovery.
 */

import type { JobId } from '../../shared/jobs/ids'
import type { RunSettings } from '../../shared/jobs/types'
import type { GpuLease, TimerHandle, Timers } from './deps'

/** A hardware encoder family. */
export type GpuVendor = 'nvenc' | 'qsv' | 'amf'

/** Sessions the Auto setting allows per encoder family. */
export const AUTO_GPU_SESSIONS: Readonly<Record<GpuVendor, number>> = Object.freeze({ nvenc: 4, qsv: 2, amf: 2 })

/** Highest fixed GPU session setting. */
export const MAX_GPU_SESSIONS = 16

/** Quiet time after a session-limit error before the budget rises by one. */
export const GPU_RECOVERY_MS = 10 * 60 * 1000

/** The encoder family of a hardware encoder name such as hevc_nvenc; null for a software encoder. */
export function gpuVendorOf(encoder: string): GpuVendor | null
{
  const match = /_(nvenc|qsv|amf)$/.exec(encoder)
  return match === null ? null : (match[1] as GpuVendor)
}

/**
 * The session count a setting gives. Auto with no known family takes the smallest family default, so a GPU job is
 * never refused a session outright.
 */
export function gpuSessionSetting(setting: RunSettings['gpuSessions'], vendor: GpuVendor | null): number
{
  if (setting.mode === 'fixed') return Math.min(MAX_GPU_SESSIONS, Math.max(1, Math.floor(setting.count)))
  return vendor === null ? Math.min(...Object.values(AUTO_GPU_SESSIONS)) : AUTO_GPU_SESSIONS[vendor]
}

/** Why a GPU encode failed to start. */
export type GpuFailureKind = 'session-limit' | 'init-failed'

const SESSION_LIMIT_LINES = [/OpenEncodeSessionEx failed/, /incompatible client key/]
const INIT_FAILED_LINES = [/Error creating a MFX session/, /AMF failed to initiali[sz]e/]
const NO_DEVICE_LINE = /No capable devices found/

/**
 * Classifies a failed GPU encode's stderr. NVENC prints "No capable devices found" after a refused session as well,
 * so that line means a session limit only while other GPU jobs are encoding.
 */
export function classifyGpuFailure(stderr: string, othersEncoding: number): GpuFailureKind | null
{
  if (SESSION_LIMIT_LINES.some((line) => line.test(stderr))) return 'session-limit'
  if (INIT_FAILED_LINES.some((line) => line.test(stderr))) return 'init-failed'
  if (NO_DEVICE_LINE.test(stderr)) return othersEncoding > 0 ? 'session-limit' : 'init-failed'
  return null
}

/** What the engine does with a GPU job whose encode failed to start. */
export type GpuFailureDecision =
  | { action: 'requeue-gpu'; reason: 'requeued-gpu'; limit: number; previousLimit: number }
  | { action: 'requeue-cpu'; reason: 'requeued-cpu' }
  | { action: 'fail'; code: 'gpu-session-limit' | 'gpu-init-failed' }

/** The budget as the run header and the dispatch limits read it. */
export interface GpuBudgetState
{
  /** Sessions the setting allows. */
  setting: number
  /** Sessions dispatch may use now; below the setting after a session-limit error. */
  limit: number
  leased: number
  encoding: number
}

/** A GPU job's session lease. */
export interface GpuJobLease extends GpuLease
{
  readonly jobId: JobId
  /** Marks the job's encoder session as open, from its encode spawn on. */
  encoding(): void
  /** Returns the session; a second call does nothing. */
  release(): void
}

/** What a GPU budget is built with. */
export interface GpuBudgetOptions
{
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>
  setting: RunSettings['gpuSessions']
  vendor: GpuVendor | null
  /** Called when the limit changes or a session is returned, so dispatch can run again. */
  onChange?(state: GpuBudgetState): void
}

interface LeaseRecord
{
  lease: GpuJobLease
  encoding: boolean
}

/** The session budget and the leases held against it. */
export class GpuBudget
{
  private readonly timers: GpuBudgetOptions['timers']
  private readonly onChange: (state: GpuBudgetState) => void
  private readonly leases = new Map<JobId, LeaseRecord>()
  private readonly requeued = new Set<JobId>()
  private readonly cpu = new Set<JobId>()
  private settingValue: number
  private limitValue: number
  private recovery: TimerHandle | null = null

  constructor(options: GpuBudgetOptions)
  {
    this.timers = options.timers
    this.onChange = options.onChange ?? ((): void => undefined)
    this.settingValue = gpuSessionSetting(options.setting, options.vendor)
    this.limitValue = this.settingValue
  }

  /** Sessions dispatch may use now. */
  get limit(): number
  {
    return this.limitValue
  }

  /** Sessions the setting allows. */
  get setting(): number
  {
    return this.settingValue
  }

  state(): GpuBudgetState
  {
    let encoding = 0
    for (const record of this.leases.values()) if (record.encoding) encoding += 1
    return { setting: this.settingValue, limit: this.limitValue, leased: this.leases.size, encoding }
  }

  /** Applies a new setting or encoder family; a lowered budget stays lowered up to the new setting. */
  configure(setting: RunSettings['gpuSessions'], vendor: GpuVendor | null): void
  {
    const degraded = this.limitValue < this.settingValue
    this.settingValue = gpuSessionSetting(setting, vendor)
    const limit = degraded ? Math.min(this.limitValue, this.settingValue) : this.settingValue
    if (limit >= this.settingValue) this.stopRecovery()
    this.setLimit(limit)
  }

  /** Takes a session for a GPU job with its dispatch claim; a job holds at most one. */
  lease(jobId: JobId, encoder: string): GpuJobLease
  {
    const existing = this.leases.get(jobId)
    if (existing !== undefined) return existing.lease
    const record: LeaseRecord = {
      encoding: false,
      lease: {
        jobId,
        encoder,
        classify: (stderrTail) => classifyGpuFailure(stderrTail, this.othersEncoding(jobId)),
        encoding: () =>
        {
          if (this.leases.get(jobId) === record) record.encoding = true
        },
        release: () =>
        {
          if (this.leases.get(jobId) === record) this.release(jobId)
        }
      }
    }
    this.leases.set(jobId, record)
    return record.lease
  }

  /** The job's lease, or null. */
  leaseOf(jobId: JobId): GpuJobLease | null
  {
    return this.leases.get(jobId)?.lease ?? null
  }

  /** Returns the job's session when it leaves the active states or its claim is released. */
  release(jobId: JobId): void
  {
    if (!this.leases.delete(jobId)) return
    this.onChange(this.state())
  }

  /** True when the job's next execution runs its plan's CPU fallback as class video-cpu. */
  onCpu(jobId: JobId): boolean
  {
    return this.cpu.has(jobId)
  }

  /** Drops what the budget remembers about a job: its requeue and its CPU fallback. */
  forget(jobId: JobId): void
  {
    this.requeued.delete(jobId)
    this.cpu.delete(jobId)
  }

  /**
   * Decides what a failed GPU encode leads to; null when its stderr names no GPU failure. A session limit lowers the
   * budget to the other jobs encoding (at least 1) and requeues the job at the head once; an initialization failure
   * requeues it on its CPU fallback when the plan has one.
   */
  reportFailure(jobId: JobId, stderrTail: string, fallback: boolean): GpuFailureDecision | null
  {
    const kind = classifyGpuFailure(stderrTail, this.othersEncoding(jobId))
    if (kind === null) return null
    if (kind === 'init-failed')
    {
      if (!fallback || this.cpu.has(jobId)) return { action: 'fail', code: 'gpu-init-failed' }
      this.cpu.add(jobId)
      return { action: 'requeue-cpu', reason: 'requeued-cpu' }
    }
    const previousLimit = this.limitValue
    const limit = Math.min(previousLimit, Math.max(1, this.othersEncoding(jobId)))
    this.startRecovery()
    this.setLimit(limit)
    if (this.requeued.has(jobId)) return { action: 'fail', code: 'gpu-session-limit' }
    this.requeued.add(jobId)
    return { action: 'requeue-gpu', reason: 'requeued-gpu', limit, previousLimit }
  }

  /** A run starts: the budget returns to its setting. */
  runStarted(): void
  {
    this.stopRecovery()
    this.setLimit(this.settingValue)
  }

  /** Stops the recovery timer. */
  dispose(): void
  {
    this.stopRecovery()
  }

  private othersEncoding(jobId: JobId): number
  {
    let count = 0
    for (const [id, record] of this.leases) if (id !== jobId && record.encoding) count += 1
    return count
  }

  private setLimit(limit: number): void
  {
    if (limit === this.limitValue) return
    this.limitValue = limit
    this.onChange(this.state())
  }

  private startRecovery(): void
  {
    this.stopRecovery()
    this.recovery = this.timers.setTimeout(() => this.recover(), GPU_RECOVERY_MS)
  }

  private stopRecovery(): void
  {
    if (this.recovery === null) return
    this.timers.clearTimeout(this.recovery)
    this.recovery = null
  }

  private recover(): void
  {
    this.recovery = null
    this.setLimit(Math.min(this.settingValue, this.limitValue + 1))
    if (this.limitValue < this.settingValue) this.startRecovery()
  }
}
