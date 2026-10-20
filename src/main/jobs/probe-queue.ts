/**
 * Bounded, cached, de-duplicated probing of job sources. Four probes run at once while idle and two during a run;
 * a network share runs one probe at a time; a source identity (path, size, modification time) has at most one probe
 * in flight and is probed once until it changes or is invalidated.
 */

import type { MediaFacts } from '../../shared/audio/types'
import type { MediaSummary } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import { toMediaFacts, type ProbeJson as FactsProbeJson } from '../ffmpeg/audio/facts'
import { PROBE_TIMEOUT_MS, bitDepth, type Probe, type ProbeJson, type ProbeStream } from '../ffmpeg/probe'
import type { Timers } from '../timers'
import type { ProbeQueue } from './deps'
import { defaultPathKey } from './scan'

/** Probes running at once while no run is active. */
export const IDLE_CONCURRENCY = 4
/** Probes running at once during a run, so encodes keep the disk and the CPU. */
export const RUN_CONCURRENCY = 2
/** Cached probes kept, twice the queue limit. */
export const CACHE_LIMIT = 20_000

/** Why a source could not be probed; the row reads Missing, Unreadable, or Not media from it. */
export type ProbeFailureCode = 'source-missing' | 'source-unreadable' | 'not-media' | 'probe-failed' | 'canceled'

/** The rejection of every failed or canceled probe. */
export class ProbeFailure extends Error
{
  readonly code: ProbeFailureCode

  constructor(code: ProbeFailureCode, message: string)
  {
    super(message)
    this.name = code === 'canceled' ? 'AbortError' : 'ProbeFailure'
    this.code = code
  }
}

/** One probed source: its identity, the planners' facts, and the row's summary. */
export interface ProbedSource
{
  path: string
  size: number
  mtimeMs: number
  facts: MediaFacts
  summary: MediaSummary
}

/** What the queue needs from outside. */
export interface ProbeQueueDeps
{
  /** `createProbe(ffprobePath)`; the signal kills ffprobe. */
  probe: Probe
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>
  platform: Platform
  /** The network share a path lives on, or null for a local volume; defaults to the UNC share root on win32. */
  shareRoot?: (path: string) => string | null
  pathKey?: (path: string) => string
  timeoutMs?: number
  cacheLimit?: number
}

/** The engine's probe queue: the `ProbeQueue` seam plus the row summary and its counters. */
export interface JobProbeQueue extends ProbeQueue
{
  /** Rejects with a `ProbeFailure`; cached by path, size, and modification time. */
  probeSource(path: string, options?: { signal?: AbortSignal }): Promise<ProbedSource>
  stats(): { waiting: number; running: number; cached: number; limit: number }
}

const UNC_ROOT = /^(?:\\\\\?\\UNC\\|[\\/]{2})([^\\/]+)[\\/]+([^\\/]+)/i

/** The share root of a UNC path, `\\server\share` in lowercase, or null for any other path. */
export function uncShareRoot(path: string): string | null
{
  if (path.startsWith('\\\\?\\') && !/^\\\\\?\\UNC\\/i.test(path)) return null
  const m = UNC_ROOT.exec(path)
  return m === null ? null : `\\\\${m[1]}\\${m[2]}`.toLowerCase()
}

function frameRate(text: string | undefined): number | null
{
  const [num, den] = (text ?? '').split('/').map(Number)
  const fps = den === undefined ? num : num / den
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null
}

function rotationOf(stream: ProbeStream): number
{
  const side = (stream as { side_data_list?: unknown }).side_data_list
  if (Array.isArray(side))
  {
    for (const entry of side)
    {
      const value = (entry as { rotation?: unknown } | null)?.rotation
      if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value
    }
  }
  const tagged = Number.parseFloat(stream.tags?.rotate ?? '')
  return Number.isFinite(tagged) && tagged !== 0 ? -tagged : 0
}

function factsInput(json: ProbeJson): FactsProbeJson
{
  return {
    streams: json.streams.map((s) => ({ ...s, codec_type: s.codec_type ?? 'unknown' })),
    format: { ...json.format, format_name: json.format?.format_name ?? '' },
    chapters: json.chapters.map((c) => ({ id: c.id, start_time: c.start_time ?? '', end_time: c.end_time ?? '', tags: c.tags }))
  }
}

/** The row summary of one probe; every audio stream's `isDefault` is its `disposition.default`. */
export function toMediaSummary(json: ProbeJson, facts: MediaFacts): MediaSummary
{
  const byIndex = new Map(json.streams.map((s) => [s.index, s]))
  const picture = json.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  return {
    container: facts.container,
    durationSec: Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null,
    video: picture === undefined ? null : {
      codec: picture.codec_name ?? 'unknown',
      width: Number(picture.width) || 0,
      height: Number(picture.height) || 0,
      rotation: rotationOf(picture),
      fps: frameRate((picture as { avg_frame_rate?: string }).avg_frame_rate) ?? frameRate(picture.r_frame_rate)
    },
    audio: facts.audio.map((a) =>
    {
      const raw = byIndex.get(a.streamIndex)
      return {
        codec: a.codecName,
        channels: a.channels,
        layout: a.layout,
        sampleRate: a.sampleRate,
        bitsPerSample: raw === undefined ? a.bitsPerRawSample : bitDepth(raw),
        bitrateKbps: a.bitRate === null ? null : Math.round(a.bitRate / 1000),
        language: a.language,
        isDefault: a.disposition.default === 1
      }
    }),
    subtitles: facts.subtitles.length,
    attachments: facts.attachments.length,
    chapters: facts.chapters,
    cover: facts.video.some((v) => v.cover)
  }
}

const ACCESS_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM'])
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

function errorCode(err: unknown): string
{
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function canceled(): ProbeFailure
{
  return new ProbeFailure('canceled', 'The probe was canceled')
}

function statFailure(path: string, err: unknown): ProbeFailure
{
  const code = errorCode(err)
  if (MISSING_CODES.has(code)) return new ProbeFailure('source-missing', `The source is missing: ${path}`)
  if (ACCESS_CODES.has(code)) return new ProbeFailure('source-unreadable', `The source could not be read (access denied): ${path}`)
  return new ProbeFailure('source-unreadable', `The source could not be read: ${errorText(err)}`)
}

/** Maps an ffprobe rejection to a failure code by FFmpeg's error strings (av_strerror). */
export function probeFailure(err: unknown): ProbeFailure
{
  if (err instanceof ProbeFailure) return err
  const text = errorText(err)
  if (!text.startsWith('ffprobe exited with')) return new ProbeFailure('probe-failed', text)
  if (/Invalid data found when processing input/i.test(text)) return new ProbeFailure('not-media', 'The file is not a media file FFmpeg can read.')
  if (/Permission denied/i.test(text)) return new ProbeFailure('source-unreadable', text)
  if (/No such file or directory/i.test(text)) return new ProbeFailure('source-missing', text)
  return new ProbeFailure('probe-failed', text)
}

interface Waiter
{
  resolve(source: ProbedSource): void
  reject(err: ProbeFailure): void
  detach(): void
}

interface Task
{
  identity: string
  pathKey: string
  path: string
  size: number
  mtimeMs: number
  share: string | null
  controller: AbortController
  waiters: Set<Waiter>
  started: boolean
  timedOut: boolean
}

/** Turns a successful probe into a probed source, or rejects a file with neither audio nor a picture. */
export function toProbedSource(json: ProbeJson, source: { path: string; size: number; mtimeMs: number }): ProbedSource
{
  const facts = toMediaFacts(factsInput(json), source.path)
  if (facts.audio.length === 0 && !facts.video.some((v) => !v.cover))
  {
    throw new ProbeFailure('not-media', 'The file has no audio or video stream.')
  }
  return { ...source, facts, summary: toMediaSummary(json, facts) }
}

/** The engine's probe queue over one ffprobe. */
export function createProbeQueue(deps: ProbeQueueDeps): JobProbeQueue
{
  const key = deps.pathKey ?? defaultPathKey(deps.platform)
  const shareRoot = deps.shareRoot ?? ((path: string) => (deps.platform === 'win32' ? uncShareRoot(path) : null))
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const cacheLimit = Math.max(1, deps.cacheLimit ?? CACHE_LIMIT)
  const cache = new Map<string, ProbedSource>()
  const identities = new Map<string, Set<string>>()
  const inflight = new Map<string, Task>()
  const waiting: Task[] = []
  const busyShares = new Set<string>()
  let running = 0
  let limit = IDLE_CONCURRENCY

  function forget(identity: string): void
  {
    const source = cache.get(identity)
    if (source === undefined) return
    cache.delete(identity)
    const pathKey = key(source.path)
    const set = identities.get(pathKey)
    set?.delete(identity)
    if (set?.size === 0) identities.delete(pathKey)
  }

  function remember(task: Task, source: ProbedSource): void
  {
    forget(task.identity)
    cache.set(task.identity, source)
    const set = identities.get(task.pathKey) ?? new Set<string>()
    set.add(task.identity)
    identities.set(task.pathKey, set)
    while (cache.size > cacheLimit) forget(cache.keys().next().value as string)
  }

  function settle(task: Task, outcome: { source: ProbedSource } | { error: ProbeFailure }): void
  {
    const waiters = [...task.waiters]
    task.waiters.clear()
    for (const waiter of waiters)
    {
      waiter.detach()
      if ('source' in outcome) waiter.resolve(outcome.source)
      else waiter.reject(outcome.error)
    }
  }

  function run(task: Task): void
  {
    task.started = true
    running++
    if (task.share !== null) busyShares.add(task.share)
    const timer = deps.timers.setTimeout(() =>
    {
      task.timedOut = true
      task.controller.abort()
    }, timeoutMs)
    deps.probe(task.path, task.controller.signal)
      .then((json) => ({ source: toProbedSource(json, task) }))
      .catch((err: unknown) =>
      {
        if (task.timedOut) return { error: new ProbeFailure('probe-failed', `ffprobe did not finish within ${Math.round(timeoutMs / 1000)} s`) }
        return { error: task.controller.signal.aborted ? canceled() : probeFailure(err) }
      })
      .then((outcome) =>
      {
        deps.timers.clearTimeout(timer)
        running--
        if (task.share !== null) busyShares.delete(task.share)
        if (inflight.get(task.identity) === task) inflight.delete(task.identity)
        if ('source' in outcome && !task.controller.signal.aborted) remember(task, outcome.source)
        settle(task, outcome)
        pump()
      })
  }

  function pump(): void
  {
    while (running < limit)
    {
      const index = waiting.findIndex((task) => task.share === null || !busyShares.has(task.share))
      if (index < 0) return
      run(waiting.splice(index, 1)[0])
    }
  }

  function drop(task: Task): void
  {
    if (inflight.get(task.identity) === task) inflight.delete(task.identity)
    if (!task.started)
    {
      const index = waiting.indexOf(task)
      if (index >= 0) waiting.splice(index, 1)
    }
    task.controller.abort()
  }

  function attach(task: Task, signal: AbortSignal | undefined): Promise<ProbedSource>
  {
    return new Promise((resolve, reject) =>
    {
      const onAbort = (): void =>
      {
        task.waiters.delete(waiter)
        if (task.waiters.size === 0) drop(task)
        reject(canceled())
      }
      const waiter: Waiter = {
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort)
      }
      task.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function probeSource(path: string, options: { signal?: AbortSignal } = {}): Promise<ProbedSource>
  {
    const { signal } = options
    if (signal?.aborted) throw canceled()
    let info: { size: number; mtimeMs: number; isFile(): boolean }
    try
    {
      info = await deps.stat(path)
    }
    catch (err)
    {
      throw statFailure(path, err)
    }
    if (signal?.aborted) throw canceled()
    if (!info.isFile()) throw new ProbeFailure('not-media', `Not a file: ${path}`)
    const pathKey = key(path)
    const identity = `${pathKey}\u0000${info.size}\u0000${info.mtimeMs}`
    const hit = cache.get(identity)
    if (hit !== undefined)
    {
      cache.delete(identity)
      cache.set(identity, hit)
      return hit
    }
    let task = inflight.get(identity)
    if (task === undefined)
    {
      task = {
        identity,
        pathKey,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        share: shareRoot(path),
        controller: new AbortController(),
        waiters: new Set(),
        started: false,
        timedOut: false
      }
      inflight.set(identity, task)
      waiting.push(task)
    }
    const result = attach(task, signal)
    pump()
    return result
  }

  return {
    probeSource,
    async probe(path, options)
    {
      return (await probeSource(path, options)).facts
    },
    setRunning(active)
    {
      limit = active ? RUN_CONCURRENCY : IDLE_CONCURRENCY
      pump()
    },
    invalidate(path)
    {
      for (const identity of [...(identities.get(key(path)) ?? [])]) forget(identity)
    },
    stats()
    {
      return { waiting: waiting.length, running, cached: cache.size, limit }
    }
  }
}
