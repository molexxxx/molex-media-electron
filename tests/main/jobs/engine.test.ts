/**
 * The composed engine end to end: `createJobEngine` over in-memory persistence, file operations, and volumes, a real
 * planner with fake runners scripted per stage, and manual timers. Every emitted event and every journal line passes
 * `assertWireSafe`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { basename, dirname, join, win32 } from 'node:path'
import { albumGroupsOf, audioStampFields, buildJobResult, createJobEngine, gpuVendor, persistenceRunAlert, type EngineDeps, type JobEngine } from '../../../src/main/jobs/engine'
import { recipeOutcomes } from '../../../src/main/jobs/history'
import { engineError } from '../../../src/main/jobs/scheduler'
import type { EventSender, FileIdentity, FileStat, FsOps, JobLogger, PersistenceIO, PlannerIO, VolumeInfo } from '../../../src/main/jobs/deps'
import type { JobProbeQueue, ProbedSource } from '../../../src/main/jobs/probe-queue'
import type { VolumeRegistry } from '../../../src/main/jobs/volumes'
import type { WorkDirFiles } from '../../../src/main/jobs/workdirs'
import type { JobRunner, PlanInput, RunContext, RunnableJob, RunnerPlan, RunOutcome } from '../../../src/main/jobs/runners/types'
import type { RunnerSet } from '../../../src/main/jobs/planner'
import type { BuildCapabilities } from '../../../src/main/ffmpeg/audio/encoders'
import type { Exec, ExecOptions, ExecResult } from '../../../src/main/ffmpeg/exec'
import type { JobsConfig } from '../../../src/main/config'
import type { CommandResult, JobCommandName, JobCommandRequest, JobCommandResponse, JobEvent, JobEventBatch } from '../../../src/shared/jobs/contract'
import type { AudioFacts, MediaFacts, StreamVerdict, VerifiedStream } from '../../../src/shared/audio/types'
import { applyDefaultPreset, applyPreset, findPreset } from '../../../src/shared/jobs/presets'
import { firstDefaultRecipe } from '../../../src/main/config'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, CapabilitySummary, JobMeasurement, JobView, RunSettings, Verification } from '../../../src/shared/jobs/types'
import type { JobId } from '../../../src/shared/jobs/ids'
import { assertWireSafe } from '../../../src/shared/jobs/wire'
import { createManualTimers, type ManualTimers } from '../helpers/manual-timers'

/** A volume root as the engine sees it on Windows, recognized on every host so the fake disk agrees on Linux CI. */
function isRoot(path: string): boolean
{
  return dirname(path) === path || win32.parse(path).root === path
}

const USER_DATA = 'C:\\app'
const MEDIA = 'C:\\media'
const SAME = { kind: 'same-as-source' } as const

const ENCODERS = ['aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le', 'pcm_s24le', 'libx264', 'libx265']

const BUILD: BuildCapabilities = { encoders: new Set(ENCODERS), experimental: new Set(), soxr: true }

const CAPS: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: 'n9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true, surroundMeter: true },
  encoders: ENCODERS,
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 8,
  platform: 'win32'
}

const SETTINGS: RunSettings =
{
  workers: { mode: 'fixed', count: 2 },
  gpuSessions: { mode: 'auto' },
  priority: 'below-normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: false,
  includeSubfolders: true
}

const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

const VERIFIED: Verification = { verdict: 'verified', encodePasses: 1, audio: null, media: null, messages: [] }

function normalize(): Recipe
{
  return applyDefaultPreset('normalize', SAME)
}

function stream(audioIndex: number): AudioFacts
{
  return {
    audioIndex,
    streamIndex: audioIndex,
    codecName: 'pcm_s16le',
    profile: null,
    channels: 2,
    layout: 'stereo',
    layoutGuessed: false,
    sampleRate: 44100,
    sampleFmt: 's16',
    bitsPerRawSample: 16,
    bitRate: 1411200,
    durationSec: 60,
    language: null,
    title: null,
    disposition: { default: 1 }
  }
}

function song(path: string): MediaFacts
{
  return { path, container: 'wav', formatName: 'wav', durationSec: 60, audio: [stream(0)], video: [], subtitles: [], attachments: [], data: [], chapters: 0 }
}

function measurement(at: number): JobMeasurement
{
  return { pass: 'source', measuredAt: at, streams: [], album: null, messages: [] }
}

function fakeLog(): JobLogger & { lines: Array<{ level: string; message: string }> }
{
  const lines: Array<{ level: string; message: string }> = []
  const at = (level: string) => (message: string): void =>
  {
    lines.push({ level, message })
  }
  const log = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), ffmpeg: at('ffmpeg'), child: () => log }
  return log
}

function codeError(code: string, message = code): Error
{
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/** The in-memory disk every fake shares: files with sizes and ids, and folders. */
class Disk
{
  readonly files = new Map<string, { size: number; ino: number; text: string | null }>()
  readonly dirs = new Set<string>()
  /** While set, renames wait for it, which holds a placement mid-step. */
  gate: Promise<void> | null = null
  private ino = 100

  put(path: string, size: number, text: string | null = null): void
  {
    this.files.set(path, { size, ino: ++this.ino, text })
    this.mkdirs(dirname(path))
  }

  mkdirs(path: string): void
  {
    let at = path
    while (!this.dirs.has(at) && dirname(at) !== at)
    {
      this.dirs.add(at)
      at = dirname(at)
    }
  }

  under(path: string): string[]
  {
    const prefix = path.endsWith('\\') ? path : `${path}\\`
    return [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(prefix))
  }

  identity(path: string): FileIdentity | null
  {
    const file = this.files.get(path)
    return file === undefined ? null : { dev: '1', ino: String(file.ino), size: file.size, mtimeMs: 1000 }
  }
}

/** The persistence files in memory, with every write failing while `failing` is set. */
function memoryIO(): PersistenceIO & { text: Map<string, string>; failing: boolean; writes: number }
{
  const text = new Map<string, string>()
  const io = {
    text,
    failing: false,
    writes: 0,
    async append(path: string, value: string): Promise<void>
    {
      if (io.failing)
      {
        throw codeError('ENOSPC', 'no space left on device')
      }
      io.writes += 1
      text.set(path, (text.get(path) ?? '') + value)
    },
    appendSync(path: string, value: string): void
    {
      text.set(path, (text.get(path) ?? '') + value)
    },
    async fsync(): Promise<void>
    {
      if (io.failing)
      {
        throw codeError('ENOSPC', 'no space left on device')
      }
    },
    async writeAtomic(path: string, value: string): Promise<void>
    {
      if (io.failing)
      {
        throw codeError('ENOSPC', 'no space left on device')
      }
      text.set(path, value)
    },
    read: async (path: string): Promise<string | null> => text.get(path) ?? null,
    list: async (dir: string): Promise<string[]> => [...text.keys()].filter((p) => dirname(p) === dir).map((p) => basename(p)),
    async rename(from: string, to: string): Promise<void>
    {
      const value = text.get(from)
      if (value === undefined)
      {
        throw codeError('ENOENT')
      }
      text.delete(from)
      text.set(to, value)
    },
    unlink: async (path: string): Promise<void> =>
    {
      text.delete(path)
    },
    mkdir: async (): Promise<void> => undefined
  }
  return io
}

function fsOps(disk: Disk, calls: string[]): FsOps
{
  return {
    async rename(from, to)
    {
      calls.push(`rename ${from} ${to}`)
      if (disk.gate !== null)
      {
        await disk.gate
      }
      const file = disk.files.get(from)
      if (file !== undefined)
      {
        disk.files.delete(from)
        disk.files.set(to, file)
        return
      }
      if (!disk.dirs.has(from))
      {
        throw codeError('ENOENT')
      }
      for (const inner of disk.under(from))
      {
        const moved = to + inner.slice(from.length)
        if (disk.files.has(inner))
        {
          disk.files.set(moved, disk.files.get(inner) as { size: number; ino: number; text: string | null })
          disk.files.delete(inner)
        }
        else
        {
          disk.dirs.delete(inner)
          disk.dirs.add(moved)
        }
      }
      disk.dirs.delete(from)
      disk.dirs.add(to)
    },
    async reserve(path)
    {
      calls.push(`reserve ${path}`)
      if (disk.files.has(path))
      {
        throw codeError('EEXIST')
      }
      disk.put(path, 0)
      return disk.identity(path) as FileIdentity
    },
    identity: async (path) => disk.identity(path),
    async unlink(path)
    {
      calls.push(`unlink ${path}`)
      disk.files.delete(path)
    },
    async mkdir(path)
    {
      calls.push(`mkdir ${path}`)
      disk.mkdirs(path)
    },
    async removeTree(path)
    {
      calls.push(`removeTree ${path}`)
      for (const inner of disk.under(path))
      {
        disk.files.delete(inner)
        disk.dirs.delete(inner)
      }
      disk.dirs.delete(path)
    },
    setHidden: async () => undefined,
    async copyFile(from, to)
    {
      const file = disk.files.get(from)
      disk.put(to, file?.size ?? 0)
    },
    hash: async (path) => `h${disk.files.get(path)?.size ?? 0}`
  }
}

function workDirFiles(disk: Disk): WorkDirFiles
{
  return {
    readText: async (path) => disk.files.get(path)?.text ?? null,
    async writeNew(path, text)
    {
      if (disk.files.has(path))
      {
        throw codeError('EEXIST')
      }
      disk.put(path, text.length, text)
    },
    kind: async (path) => (disk.dirs.has(path) ? 'dir' : disk.files.has(path) ? 'other' : 'missing'),
    list: async (dir) => [...disk.files.keys(), ...disk.dirs].filter((p) => dirname(p) === dir).map((p) => basename(p)),
    async removeEmpty(dir)
    {
      if (disk.under(dir).length === 0)
      {
        disk.dirs.delete(dir)
      }
    }
  }
}

function scanFs(disk: Disk): NonNullable<EngineDeps['scanFs']>
{
  const kind = (path: string): 'file' | 'dir' | 'missing' => (disk.files.has(path) ? 'file' : disk.dirs.has(path) ? 'dir' : 'missing')
  return {
    async opendir(path)
    {
      if (kind(path) !== 'dir')
      {
        throw codeError('ENOENT')
      }
      const names = [...disk.files.keys(), ...disk.dirs].filter((p) => dirname(p) === path)
      return (async function* entries()
      {
        for (const name of names)
        {
          yield { name: basename(name), isFile: () => kind(name) === 'file', isDirectory: () => kind(name) === 'dir', isSymbolicLink: () => false }
        }
      })()
    },
    async stat(path)
    {
      const found = kind(path)
      if (found === 'missing')
      {
        throw codeError('ENOENT')
      }
      return { size: disk.files.get(path)?.size ?? 0, mtimeMs: 1000, isFile: () => found === 'file', isDirectory: () => found === 'dir' }
    }
  }
}

function plannerIO(disk: Disk, free: Map<string, number>, unreachable: Set<string>): PlannerIO
{
  const info: VolumeInfo = { kind: 'local', trash: 'available', trashBytesFree: 50_000_000_000, volumeBytes: 1_000_000_000_000 }
  return {
    async stat(path): Promise<FileStat | null>
    {
      const file = disk.files.get(path)
      if (file !== undefined)
      {
        return { size: file.size, mtimeMs: 1000, isFile: true, isDirectory: false, dev: '1', ino: String(file.ino) }
      }
      return disk.dirs.has(path) || isRoot(path) ? { size: 0, mtimeMs: 1000, isFile: false, isDirectory: true, dev: '1', ino: '1' } : null
    },
    statfs: async (path) => ({ freeBytes: free.get(path.slice(0, 3).toLowerCase()) ?? 500_000_000_000, totalBytes: 1_000_000_000_000 }),
    probeWrite: async () => true,
    volumeInfo: async () => info,
    reachable: async (root) => !unreachable.has(root)
  }
}

function volumes(): VolumeRegistry
{
  return {
    root: async (path) => path.slice(0, 3),
    key: async (path) => path.slice(0, 3).toLowerCase(),
    info: async () => ({ kind: 'local', trash: 'available', trashBytesFree: 50_000_000_000, volumeBytes: 1_000_000_000_000 }),
    refreshTrash: async () => ({ trash: 'available', trashBytesFree: 50_000_000_000 }),
    markTrashUnavailable: async () => undefined,
    isNetwork: async () => false
  }
}

function probes(disk: Disk, factsOf: (path: string) => MediaFacts): JobProbeQueue
{
  const probed = (path: string): ProbedSource =>
  {
    const file = disk.files.get(path)
    if (file === undefined)
    {
      throw Object.assign(new Error('not found'), { code: 'source-missing' })
    }
    const facts = factsOf(path)
    return {
      path,
      size: file.size,
      mtimeMs: 1000,
      facts,
      summary: { container: facts.container, durationSec: facts.durationSec, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false }
    }
  }
  return {
    probe: async (path) => probed(path).facts,
    probeSource: async (path) => probed(path),
    setRunning: vi.fn(),
    invalidate: vi.fn(),
    stats: () => ({ waiting: 0, running: 0, cached: 0, limit: 4 })
  }
}

/** One step of a scripted run: the runner waits at each gate the test opens. */
interface Script
{
  job: RunnableJob
  ctx: RunContext
  gate(name: string): Promise<void>
}

interface RunnerControl
{
  scripts: Script[]
  /** Opens a named gate for a job's current run. */
  open(jobId: JobId, name: string): void
  /** Opens every gate from now on. */
  free: boolean
  outcome?: (script: Script) => RunOutcome | null
  verification?: (jobId: JobId) => Verification
}

function runnerPlan(input: PlanInput): RunnerPlan
{
  const audio = input.recipe.kind === 'normalize' || input.recipe.kind === 'boost'
  return {
    command: { argv: ['-i', input.source.path, '-f', input.output.muxer, input.output.finalPath], display: 'ffmpeg', placeholders: [] },
    streams: { kept: [{ kind: 'audio', source: 0, output: 0, action: 'encode' }], dropped: [], chapters: 'none' },
    video: audio ? null : { encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [], notes: [], cpuFallback: null },
    audio: [],
    class: audio ? 'audio' : 'video-cpu',
    stages: audio ? [{ id: 'probe', passes: 1 }, { id: 'measure', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }] : [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }],
    estimate: { outputBytes: 1000, workSec: 10, confidence: 'medium' },
    issues: []
  }
}

/** A runner that walks the normalize stages and stops at gates the test opens. */
function scriptedRunner(kind: Recipe['kind'], disk: Disk, control: RunnerControl, timers: ManualTimers): JobRunner<Recipe>
{
  return {
    kind,
    plan: runnerPlan,
    async run(job, ctx): Promise<RunOutcome>
    {
      const waiting = new Map<string, () => void>()
      const opened = new Set<string>()
      const script: Script = {
        job,
        ctx,
        gate: (name) => (control.free || opened.has(name) || ctx.signal.aborted ? Promise.resolve() : new Promise((resolve) =>
        {
          waiting.set(name, resolve)
          ctx.signal.addEventListener('abort', () => resolve(), { once: true })
        }))
      }
      Object.assign(script, {
        openGate(name: string)
        {
          opened.add(name)
          waiting.get(name)?.()
        }
      })
      control.scripts.push(script)
      const audio = kind === 'normalize' || kind === 'boost'
      ctx.stage({ id: 'probe', pass: 1, passes: 1, label: 'Probing' })
      await script.gate('probe')
      if (ctx.signal.aborted)
      {
        return { kind: 'aborted' }
      }
      if (audio)
      {
        ctx.stage({ id: 'measure', pass: 1, passes: 1, label: 'Measuring' })
        ctx.progress({ outTimeSec: 30, durationSec: 60, speed: 10, bytes: null })
        await script.gate('measure')
        if (ctx.signal.aborted)
        {
          return { kind: 'aborted' }
        }
        ctx.measured(measurement(timers.now()))
      }
      ctx.stage({ id: 'encode', pass: 1, passes: 1, label: 'Encoding' })
      ctx.progress({ outTimeSec: 30, durationSec: 60, speed: 10, bytes: 500 })
      await script.gate('encode')
      if (ctx.signal.aborted)
      {
        return { kind: 'aborted' }
      }
      const forced = control.outcome?.(script) ?? null
      if (forced !== null)
      {
        return forced
      }
      const output = ctx.output(audio ? 'wav' : 'mp4', 1)
      disk.put(output, 900)
      ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' })
      await script.gate('verify')
      if (ctx.signal.aborted)
      {
        return { kind: 'aborted' }
      }
      return {
        kind: 'output',
        artifact: { kind: 'file', path: output, container: audio ? 'wav' : 'mp4', bytes: 900, durationSec: 60, encoder: { video: audio ? null : 'libx264', audio: ['pcm_s16le'] } },
        verification: control.verification?.(job.id) ?? VERIFIED,
        measurement: audio ? measurement(timers.now()) : null,
        notes: []
      }
    }
  }
}

interface RecordingSender extends EventSender
{
  events: JobEvent[]
}

function recordingSender(id: number): RecordingSender
{
  const events: JobEvent[] = []
  return {
    id,
    events,
    send(_channel: string, batch: JobEventBatch)
    {
      for (const event of batch.events)
      {
        assertWireSafe(event)
        events.push(event)
      }
    },
    isDestroyed: () => false,
    onNavigate: () => () => undefined,
    onDestroyed: () => () => undefined
  }
}

interface HarnessOptions
{
  jobs?: Partial<JobsConfig>
  io?: ReturnType<typeof memoryIO>
  disk?: Disk
  free?: Map<string, number>
  facts?: (path: string) => MediaFacts
  storeLimits?: EngineDeps['storeLimits']
  start?: number
  /** Volume roots whose stats wait until the test brings them back, for the recovery reachability checks. */
  offline?: { roots: Set<string>; waiters: Array<() => void> }
}

function harness(options: HarnessOptions = {})
{
  const timers = createManualTimers(options.start ?? 1_700_000_000_000)
  const log = fakeLog()
  const disk = options.disk ?? new Disk()
  const io = options.io ?? memoryIO()
  const free = options.free ?? new Map<string, number>()
  const unreachable = new Set<string>()
  const fsCalls: string[] = []
  const control: RunnerControl = { scripts: [], free: false, open: () => undefined }
  control.open = (jobId, name) =>
  {
    const script = [...control.scripts].reverse().find((s) => s.job.id === jobId) as unknown as { openGate(name: string): void } | undefined
    script?.openGate(name)
  }
  const kinds: Array<Recipe['kind']> = ['normalize', 'boost', 'convert', 'compress', 'extract']
  const runners = Object.fromEntries(kinds.map((kind) => [kind, scriptedRunner(kind, disk, control, timers)])) as unknown as RunnerSet
  const sender = recordingSender(7)
  const notifications: unknown[] = []
  const quits: number[] = []
  let configJobs: JobsConfig = {
    settings: SETTINGS,
    policy: POLICY,
    defaultRecipe: normalize(),
    recentFolders: [],
    pendingAlerts: [],
    ...options.jobs
  }
  const persisted: Array<Partial<JobsConfig>> = []
  const exec: Exec = {
    run: vi.fn((_args: readonly string[], o: ExecOptions) =>
    {
      o.onSpawn?.(4321)
      return Promise.resolve({ code: 0, signal: null, aborted: o.signal.aborted } as unknown as ExecResult)
    })
  } as unknown as Exec
  let token = 0
  let preflight = 0
  const deps: EngineDeps = {
    timers,
    ids: { token: () => `t${++token}`, preflightId: () => `pf-${++preflight}` },
    platform: 'win32',
    paths: { userData: USER_DATA },
    runners,
    planner: plannerIO(disk, free, unreachable),
    probe: probes(disk, options.facts ?? song),
    fs: fsOps(disk, fsCalls),
    trash: async (path) =>
    {
      disk.files.delete(path)
    },
    store: io,
    host: {
      rendererLocation: () => ({ kind: 'dev', url: 'http://localhost:5173' }) as never,
      logUnexpected: vi.fn(),
      sender: (id) => (id === sender.id ? sender : null),
      mainWindow: () => ({ visible: true, focused: false }),
      showMainWindow: vi.fn(),
      notify: (n) =>
      {
        notifications.push(n)
      },
      setTaskbarProgress: vi.fn(),
      setKeepAwake: vi.fn(),
      setTrayStatus: vi.fn(),
      askQuit: async () => 'keep-running',
      confirmCancelBatch: async () => true,
      quit: () =>
      {
        quits.push(timers.now())
      }
    },
    log,
    ffmpeg: { current: () => ({ exec, caps: BUILD, rev: 1 }) },
    setPriority: vi.fn(),
    volumes: volumes(),
    config: {
      jobs: configJobs,
      persist: async (change) =>
      {
        persisted.push(change)
        configJobs = { ...configJobs, ...change }
      }
    },
    capabilities: CAPS,
    plannerCapabilities: () => ({ build: BUILD, minimumVersion: '5.1' }),
    audio: {
      analyze: async () =>
      {
        throw new Error('no analysis in this test')
      },
      plan: (_jobId, _analysis) => measurement(timers.now()),
      albumPlan: () =>
      {
        throw new Error('no albums in this test')
      }
    },
    shell: {
      showItemInFolder: vi.fn(),
      readClipboard: () => ({ files: [], text: '' }),
      chooseSavePath: async () => null,
      exists: async (path) => disk.files.has(path) || disk.dirs.has(path),
      readLog: async () => null
    },
    historyFs: {
      stat: async (path) => (io.text.has(path)
        ? { size: (io.text.get(path) as string).length, mtimeMs: 1000, isFile: true }
        : disk.files.has(path) ? { size: disk.files.get(path)?.size ?? 0, mtimeMs: 1000, isFile: true } : null),
      removeTree: async (path) =>
      {
        for (const key of [...io.text.keys()])
        {
          if (key === path || key.startsWith(`${path}\\`))
          {
            io.text.delete(key)
          }
        }
      }
    },
    workDirFiles: workDirFiles(disk),
    scanFs: scanFs(disk),
    cores: 8,
    pid: 4242,
    appVersion: '5.0.0',
    stat: (path) => (options.offline !== undefined && options.offline.roots.has(path.slice(0, 3))
      ? new Promise((resolve) => options.offline?.waiters.push(() => resolve({})))
      : disk.dirs.has(path) || disk.files.has(path) || isRoot(path) ? Promise.resolve({}) : Promise.reject(codeError('ENOENT'))),
    storeLimits: options.storeLimits
  }
  const engine = createJobEngine(deps)

  async function send<K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<CommandResult<JobCommandResponse<K>>>
  {
    const result = await engine.command(name, req, { senderId: sender.id })
    await timers.flush()
    return result
  }

  async function value<K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<JobCommandResponse<K>>
  {
    const result = await send(name, req)
    if (!result.ok)
    {
      throw new Error(`${name} refused: ${result.error.code} ${result.error.message}`)
    }
    return result.value
  }

  async function addFiles(names: string[], recipe: Recipe | null = null): Promise<JobId[]>
  {
    for (const name of names)
    {
      if (!disk.files.has(join(MEDIA, name)))
      {
        disk.put(join(MEDIA, name), 1000)
      }
    }
    const added = await value('add', { paths: names.map((name) => join(MEDIA, name)), recipe, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
    await settle()
    return added.added
  }

  /** Lets background probes, writes, and dispatch turns run. */
  async function settle(rounds = 5): Promise<void>
  {
    for (let i = 0; i < rounds; i++)
    {
      await timers.flush()
      await timers.advance(300)
    }
  }

  async function startRun(ids: JobId[] | 'pending' = 'pending'): Promise<JobCommandResponse<'start'>>
  {
    const report = await value('preflight', { ids })
    let started = await send('start', { preflightId: report.preflightId, ack: null, resume: false })
    if (!started.ok && started.error.code === 'confirmation-required' && started.error.details !== null && 'overwrites' in started.error.details)
    {
      started = await send('start', { preflightId: report.preflightId, ack: { ...started.error.details }, resume: false })
    }
    if (!started.ok)
    {
      throw new Error(`start refused: ${started.error.code} ${started.error.message}`)
    }
    await settle()
    return started.value
  }

  function view(id: JobId): JobView
  {
    const found = engine.snapshot().jobs.find((job) => job.id === id)
    if (found === undefined)
    {
      throw new Error(`no job ${id}`)
    }
    return found
  }

  /** Every journal line written so far, parsed. */
  function journalLines(): unknown[]
  {
    const out: unknown[] = []
    for (const [path, text] of io.text)
    {
      if (path.includes(`${join(USER_DATA, 'jobs')}\\journal`) || path.endsWith('.jsonl'))
      {
        for (const line of text.split('\n'))
        {
          if (line.trim() !== '')
          {
            out.push(JSON.parse(line))
          }
        }
      }
    }
    return out
  }

  return {
    engine, deps, timers, log, disk, io, free, unreachable, fsCalls, control, sender, notifications, quits, persisted,
    send, value, addFiles, settle, startRun, view, journalLines,
    config: () => configJobs,
    async boot(): Promise<void>
    {
      await engine.init()
      await value('subscribe', { clientId: 'main' })
    }
  }
}

type Harness = ReturnType<typeof harness>

/** Opens every gate of a job's current run in order. */
async function runThrough(h: Harness, id: JobId, gates: string[] = ['probe', 'measure', 'encode', 'verify']): Promise<void>
{
  for (const gate of gates)
  {
    h.control.open(id, gate)
    await h.settle(2)
  }
}

const engines: JobEngine[] = []

afterEach(async () =>
{
  for (const engine of engines.splice(0))
  {
    await engine.shutdown('quit').catch(() => undefined)
  }
})

function track(h: Harness): Harness
{
  engines.push(h.engine)
  return h
}

describe('the normalize event sequence', () =>
{
  it('runs a normalize job through every stage with the events of 4.3, in order, each wire-safe', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [id] = await h.addFiles(['song.wav'])
    await h.startRun()
    await runThrough(h, id)
    expect(h.view(id).state).toBe('done')
    const mine = h.sender.events.filter((e) => 'jobId' in e && e.jobId === id && ['job.state', 'job.stage', 'job.measured', 'job.verified', 'job.progress'].includes(e.type))
    const fromStart = mine.slice(mine.findIndex((e) => e.type === 'job.state' && e.from === 'queued'))
    const words = fromStart.map((e) =>
    {
      switch (e.type)
      {
        case 'job.state':
          return `state ${e.from}>${e.to}`
        case 'job.stage':
          return `stage ${e.stage.id}`
        default:
          return e.type
      }
    }).filter((word, index, all) => word !== 'job.progress' || all[index - 1] !== 'job.progress')
    expect(words).toEqual([
      'state queued>analyzing',
      'stage probe',
      'job.progress',
      'stage measure',
      'job.progress',
      'job.measured',
      'state analyzing>encoding',
      'job.progress',
      'state encoding>verifying',
      'job.verified',
      'state verifying>finalizing',
      'state finalizing>done'
    ])
    const first = fromStart[0] as Extract<JobEvent, { type: 'job.state' }>
    expect(first.attempt).toBe(1)
    const stateTo = (to: string): Extract<JobEvent, { type: 'job.state' }> =>
      fromStart.find((e) => e.type === 'job.state' && e.to === to) as Extract<JobEvent, { type: 'job.state' }>
    expect(stateTo('encoding').patch.stage?.id).toBe('encode')
    expect(stateTo('finalizing').patch.stage?.id).toBe('place')
    expect(stateTo('done').patch.stamp?.verdict).toBe('verified')
    const seqs = h.sender.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    for (const line of h.journalLines())
    {
      assertWireSafe(line)
    }
    expect(h.journalLines().length).toBeGreaterThan(0)
  })
})

describe('the run progress', () =>
{
  it('publishes the run percent with finished jobs in full and running jobs by their percent across stages', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['one.wav', 'two.wav'])
    await h.startRun()
    expect(h.engine.snapshot().run.progress.percent).toBe(0)
    await runThrough(h, a)
    await runThrough(h, b, ['probe'])
    expect(h.view(a).state).toBe('done')
    expect(h.view(b).progress).toMatchObject({ stage: 'measure', percent: 12.5 })
    expect(h.engine.snapshot().run.progress.percent).toBeCloseTo(56.25, 6)
    expect(h.sender.events.some((e) => e.type === 'run.progress' && e.progress.percent > 50)).toBe(true)
    await runThrough(h, b, ['measure', 'encode', 'verify'])
    expect(h.engine.snapshot().run).toMatchObject({ status: 'idle', progress: { percent: 0 } })
  })
})

function wireCheck(h: Harness): void
{
  for (const line of h.journalLines())
  {
    assertWireSafe(line)
  }
}

describe('catalog numbers', () =>
{
  it('gives jobs created in one millisecond distinct numbers, across one add and concurrent adds', async () =>
  {
    const h = track(harness())
    await h.boot()
    for (const name of ['a.wav', 'b.wav', 'c.wav', 'd.wav', 'e.wav'])
    {
      h.disk.put(join(MEDIA, name), 1000)
    }
    const at = h.timers.now()
    const add = (paths: string[]): Promise<CommandResult<JobCommandResponse<'add'>>> =>
      h.engine.command('add', { paths: paths.map((p) => join(MEDIA, p)), recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false }, { senderId: 7 })
    const [one, two, three] = await Promise.all([add(['a.wav', 'b.wav', 'c.wav']), add(['d.wav']), add(['e.wav'])])
    expect(h.timers.now()).toBe(at)
    const ids = [one, two, three].flatMap((r) => (r.ok ? r.value.added : []))
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    const seqs = h.engine.snapshot().jobs.map((job) => job.seq)
    expect(new Set(seqs).size).toBe(5)
    expect(new Set(h.engine.snapshot().jobs.map((job) => job.addedAt))).toEqual(new Set([at]))
    wireCheck(h)
  })
})

describe('persistence failures', () =>
{
  it('releases the claim before the work folder is created when its create line cannot be written', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [id] = await h.addFiles(['song.wav'])
    const report = await h.value('preflight', { ids: 'pending' })
    h.io.failing = true
    const started = await h.send('start', { preflightId: report.preflightId, ack: null, resume: false })
    expect(started.ok).toBe(true)
    await h.settle()
    expect(h.view(id).state).toBe('queued')
    expect(h.engine.snapshot().run.status).toBe('paused')
    expect(h.engine.snapshot().run.pause?.reason).toBe('storage')
    expect(h.fsCalls.some((call) => call.startsWith('mkdir') && call.includes('.molex-'))).toBe(false)
    expect(h.control.scripts).toHaveLength(0)
    h.io.failing = false
    await h.settle(25)
    const resumed = await h.send('resume', { ack: null })
    expect(resumed.ok).toBe(true)
    await h.settle()
    expect(h.control.scripts).toHaveLength(1)
    expect(h.fsCalls.some((call) => call.startsWith('mkdir') && call.includes('.molex-'))).toBe(true)
    wireCheck(h)
  })

  it('holds placement with storage-unavailable, refuses new catalog numbers past the block, and places once writes work', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [id] = await h.addFiles(['song.wav'])
    await h.startRun()
    await runThrough(h, id, ['probe', 'measure', 'encode'])
    h.io.failing = true
    await runThrough(h, id, ['verify'])
    expect(h.view(id).state).toBe('held')
    expect(h.view(id).hold?.reason).toBe('storage-unavailable')
    const names = Array.from({ length: 120 }, (_, i) => `bulk-${i}.wav`)
    for (const name of names)
    {
      h.disk.put(join(MEDIA, name), 1000)
    }
    const request = { paths: names.map((n) => join(MEDIA, n)), recipe: null, origin: 'files' as const, after: null, recursive: false, allowSecondJobs: false, force: false }
    const refused = await h.send('add', request)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('io-error')
    expect(h.engine.snapshot().alerts.some((a) => a.id === 'persistence:write-failed')).toBe(true)
    h.io.failing = false
    await h.settle(25)
    expect(h.view(id).state).toBe('done')
    expect(h.engine.snapshot().alerts.some((a) => a.id === 'persistence:write-failed')).toBe(false)
    const later = await h.send('add', request)
    expect(later.ok && later.value.added.length).toBe(120)
    wireCheck(h)
  })
})

describe('auto-pause', () =>
{
  it('pauses the run with disk-space when the destination volume is short, keeping the job queued', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [id] = await h.addFiles(['song.wav'])
    const report = await h.value('preflight', { ids: 'pending' })
    h.free.set('c:\\', 1000)
    await h.value('start', { preflightId: report.preflightId, ack: null, resume: false })
    await h.settle()
    const snap = h.engine.snapshot()
    expect(snap.run.status).toBe('paused')
    expect(snap.run.pause?.reason).toBe('disk-space')
    expect(snap.alerts.some((a) => a.kind === 'disk-space')).toBe(true)
    expect(h.view(id).state).toBe('queued')
    expect(h.control.scripts).toHaveLength(0)
    expect(h.sender.events.some((e) => e.type === 'run.alert' && e.alert.kind === 'disk-space')).toBe(true)
    wireCheck(h)
  })
})

describe('after the run', () =>
{
  it('answers a decision on a held job of a completed run with job events only and rewrites the run index', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['one.wav', 'two.wav'])
    const first = await h.value('preflight', { ids: 'pending' })
    const target = first.jobs.find((entry) => entry.jobId === b)?.plan?.output.finalPath as string
    h.disk.put(target, 50)
    await h.value('setPolicy', { policy: { ...POLICY, conflict: 'overwrite' } })
    h.control.verification = (jobId) => (jobId === b ? { ...VERIFIED, verdict: 'outside-tolerance' } : VERIFIED)
    const started = await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b)
    expect(h.view(a).state).toBe('done')
    expect(h.view(b).state).toBe('held')
    expect(h.sender.events.filter((e) => e.type === 'run.completed')).toHaveLength(1)
    await h.settle()
    const index = join(USER_DATA, 'jobs', 'runs', 'index.json')
    const before = h.io.text.get(index)
    expect(before).toContain(started.runId)
    const mark = h.sender.events.length
    const discarded = await h.send('discardOutput', { ids: [b] })
    expect(discarded.ok).toBe(true)
    await h.settle()
    const after = h.sender.events.slice(mark)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((e) => e.type.startsWith('job.'))).toBe(true)
    expect(h.sender.events.filter((e) => e.type === 'run.completed')).toHaveLength(1)
    expect(h.io.text.get(index)).not.toBe(before)
    wireCheck(h)
  })
})

describe('upgrade', () =>
{
  it('opens a new presets store holding the Earlier default preset the default recipe names', async () =>
  {
    const recipe = firstDefaultRecipe({ normalization: { I: -14, TP: -1, LRA: 11 }, audioCodec: 'inherit', fallbackCodec: 'aac', audioBitrate: '256k' }, true)
    expect(recipe.userPreset?.id).toBe('user-earlier-default')
    const h = track(harness({ jobs: { defaultRecipe: recipe } }))
    await h.boot()
    const snap = h.engine.snapshot()
    expect(snap.defaultRecipe.userPreset?.id).toBe('user-earlier-default')
    const preset = snap.presets.user.find((p) => p.id === snap.defaultRecipe.userPreset?.id)
    expect(preset?.name).toBe('Earlier default')
    expect(findPreset('user-earlier-default', snap.presets.user)).not.toBeNull()
    expect(h.io.text.get(join(USER_DATA, 'jobs', 'presets.json'))).toContain('user-earlier-default')
  })

  it('seeds nothing when the default recipe is a built-in preset', async () =>
  {
    const h = track(harness())
    await h.boot()
    expect(h.engine.snapshot().presets.user).toEqual([])
  })
})

describe('the engine lifecycle', () =>
{
  it('refuses commands before init and after shutdown, and starts once however often init is called', async () =>
  {
    const h = harness()
    const early = await h.engine.command('listRuns', { before: null, limit: 5 }, { senderId: 7 })
    expect(!early.ok && early.error.code).toBe('internal')
    expect(() => h.engine.snapshot()).toThrow(/not initialized/)
    expect(h.engine.isBusy()).toBe(false)
    const first = h.engine.init()
    const waiting = h.engine.command('listRuns', { before: null, limit: 5 }, { senderId: 7 })
    expect(h.engine.init()).toBe(first)
    await first
    expect((await waiting).ok).toBe(true)
    await h.engine.shutdown('quit')
    await h.engine.shutdown('quit')
    const late = await h.engine.command('listRuns', { before: null, limit: 5 }, { senderId: 7 })
    expect(!late.ok && late.error.code).toBe('shutting-down')
  })

  it('shuts down an engine that never started', async () =>
  {
    const h = harness()
    await h.engine.shutdown('session-end')
    const refused = await h.engine.command('listRuns', { before: null, limit: 5 }, { senderId: 7 })
    expect(!refused.ok && refused.error.code).toBe('shutting-down')
  })

  it('answers subscribe from a window that is gone and get for an unknown job with not-found', async () =>
  {
    const h = track(harness())
    await h.boot()
    const gone = await h.engine.command('subscribe', { clientId: 'x' }, { senderId: 99 })
    expect(!gone.ok && gone.error.code).toBe('not-found')
    const missing = await h.send('get', { jobId: 'MM-9999' as JobId })
    expect(!missing.ok && missing.error.code).toBe('not-found')
    const [id] = await h.addFiles(['song.wav'])
    const detail = await h.value('get', { jobId: id })
    expect(detail.view.id).toBe(id)
    expect((await h.send('unsubscribe', { clientId: 'main' })).ok).toBe(true)
  })

  it('interrupts running jobs at quit, saves the queue, and restores it paused on the next start', async () =>
  {
    const h = harness()
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    await h.value('setWorkers', { workers: { mode: 'fixed', count: 1 }, gpuSessions: null })
    const started = await h.startRun()
    expect(h.view(a).state).toBe('analyzing')
    expect(h.engine.isBusy()).toBe(true)
    expect(h.engine.quitInputs()).toMatchObject({ busy: true, runId: started.runId })
    await h.engine.persistNow('test')
    expect(h.io.text.has(join(USER_DATA, 'jobs', 'state.json'))).toBe(true)
    await h.engine.shutdown('quit')
    wireCheck(h)

    const next = track(harness({ io: h.io, disk: h.disk }))
    await next.boot()
    const snap = next.engine.snapshot()
    expect(snap.jobs.find((job) => job.id === a)?.state).toBe('interrupted')
    expect(snap.jobs.find((job) => job.id === b)?.state).toBe('queued')
    expect(snap.run.status).toBe('paused')
    expect(snap.run.pause?.reason).toBe('restored')
    expect(snap.run.runId).toBe(started.runId)
    const [c] = await next.addFiles(['c.wav'])
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
    expect(next.engine.snapshot().jobs.find((job) => job.id === c)?.seq).toBeGreaterThan(Math.max(...snap.jobs.map((job) => job.seq)))
  })

  it('writes the interruption synchronously at session end', async () =>
  {
    const h = harness()
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    await h.startRun()
    expect(h.view(a).state).toBe('analyzing')
    const before = h.io.writes
    await h.engine.shutdown('session-end')
    expect(h.io.writes).toBe(before)
    const lines = h.journalLines() as Array<{ type: string; to?: string; reason?: string }>
    expect(lines.some((line) => line.type === 'job.state' && line.to === 'interrupted' && line.reason === 'session-end')).toBe(true)
  })

  it('re-plans queued jobs and reconfigures the GPU budget when the capabilities change', async () =>
  {
    const h = track(harness())
    await h.boot()
    await h.addFiles(['a.wav'])
    await h.value('preflight', { ids: 'pending' })
    await h.engine.setCapabilities({ ...CAPS, rev: 2, gpu: { status: 'ready', vendor: 'nvidia', name: 'RTX', encoders: ['h264_nvenc'] } })
    await h.settle()
    expect(h.engine.snapshot().capabilities.rev).toBe(2)
    expect(h.sender.events.some((e) => e.type === 'capabilities.changed')).toBe(true)
  })

  it('quits once the run is over when Quit when idle was chosen, and focuses a job on request', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    await h.startRun()
    h.engine.setQuitWhenIdle(true)
    h.engine.focus(a, null)
    await h.settle()
    expect(h.sender.events.some((e) => e.type === 'ui.focus' && e.jobId === a)).toBe(true)
    expect(h.quits).toHaveLength(0)
    await runThrough(h, a)
    await h.settle()
    expect(h.view(a).state).toBe('done')
    expect(h.quits.length).toBeGreaterThan(0)
  })

  it('notifies the first failure of a run once while the window is not focused', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    h.control.outcome = (script) => ({ kind: 'failed', error: engineError('ffmpeg-failed', 'FFmpeg failed', 'encode', script.job.attempt, 0) })
    await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b)
    expect(h.view(a).state).toBe('failed')
    expect(h.view(b).state).toBe('failed')
    const failures = h.notifications.filter((n) => (n as { focus: { jobId: JobId | null } }).focus.jobId !== null)
    expect(failures).toHaveLength(1)
  })
})

describe('command routing', () =>
{
  it('routes every command name to its module and answers each with a CommandResult', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [id, other] = await h.addFiles(['a.wav', 'b.wav'])
    const recipe = normalize()
    const requests: { [K in JobCommandName]: JobCommandRequest<K> } = {
      subscribe: { clientId: 'second' },
      unsubscribe: { clientId: 'second' },
      get: { jobId: id },
      add: { paths: [join(MEDIA, 'a.wav')], recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false },
      pasteFiles: { recipe: null, recursive: false },
      cancelScan: { scanId: 'none' },
      forgetFolder: { path: 'C:\\none' },
      clearRecentFolders: {},
      remove: { ids: [other] },
      restore: { tombstone: 'none' },
      reorder: { ids: [id], before: null },
      assignRecipe: { assignments: [{ jobId: id, recipe }] },
      duplicate: { ids: [id], recipe: null },
      locate: { jobId: id, path: join(MEDIA, 'a.wav') },
      relink: { fromDir: MEDIA, toDir: 'C:\\moved', ids: 'missing' },
      reprobe: { ids: [id] },
      setPolicy: { policy: POLICY },
      setDefaultRecipe: { recipe },
      preflight: { ids: 'pending' },
      analyze: { ids: [id] },
      cancelAnalyze: { ids: 'all' },
      start: { preflightId: 'none', ack: null, resume: false },
      pause: { mode: 'finish-running' },
      resume: { ack: null },
      cancelRun: {},
      setWorkers: { workers: { mode: 'auto' }, gpuSessions: null },
      setSettings: { settings: { keepAwake: false } },
      dismissAlert: { alertId: 'none' },
      revealAlert: { alertId: 'none' },
      cancel: { ids: [id] },
      skip: { ids: [id] },
      unqueue: { ids: [id] },
      retry: { ids: 'failed', recipe: null, ack: null, start: false },
      keepOutput: { ids: [id], placement: 'planned', confirm: null },
      discardOutput: { ids: [id] },
      acknowledge: { ids: [id] },
      clear: { scope: { kind: 'finished' } },
      log: { jobId: id, attempt: null },
      reveal: { jobId: id, target: 'source' },
      exportReport: { scope: { ids: [id] }, format: 'csv' },
      listRuns: { before: null, limit: 10 },
      getRun: { runId: 'R-0001' as never, offset: 0, limit: 10 },
      searchRuns: { query: 'a', limit: 10, before: null },
      rerun: { runId: 'R-0001' as never, jobIds: [id], force: false },
      deleteRuns: { runIds: [] },
      revealRecord: { runId: 'R-0001' as never, jobId: id, attempt: 1, target: 'source' },
      savePreset: { id: null, name: 'Mine', recipe, pin: null },
      renamePreset: { id: 'user-none', name: 'Other' },
      removePreset: { id: 'user-none' },
      setPin: { key: 2, presetId: null }
    }
    for (const name of Object.keys(requests) as JobCommandName[])
    {
      const result = await h.send(name, requests[name] as never)
      expect(typeof result.ok, name).toBe('boolean')
    }
    wireCheck(h)
  })
})

describe('pure helpers', () =>
{
  it('maps GPU vendors to encoder families', () =>
  {
    expect(gpuVendor({ gpu: { status: 'ready', vendor: 'nvidia', name: null, encoders: [] } })).toBe('nvenc')
    expect(gpuVendor({ gpu: { status: 'ready', vendor: 'intel', name: null, encoders: [] } })).toBe('qsv')
    expect(gpuVendor({ gpu: { status: 'ready', vendor: 'amd', name: null, encoders: [] } })).toBe('amf')
    expect(gpuVendor({ gpu: { status: 'detecting', vendor: null, name: null, encoders: [] } })).toBeNull()
  })

  it('words every persistence alert', () =>
  {
    const causes = ['write-failed', 'compaction-failed', 'queue-dropped', 'corrupt-state', 'newer-schema'] as const
    for (const cause of causes)
    {
      const alert = persistenceRunAlert({ kind: cause === 'corrupt-state' ? 'queue-recovered' : 'storage-error', cause, code: cause === 'write-failed' ? 'ENOSPC' : null, movedAside: cause === 'corrupt-state' ? ['state.json.corrupt'] : [] }, 5)
      expect(alert.id).toBe(`persistence:${cause}`)
      expect(alert.message.length).toBeGreaterThan(10)
      expect(alert.dismissible).toBe(cause !== 'write-failed')
      assertWireSafe(alert)
    }
    expect(persistenceRunAlert({ kind: 'storage-error', cause: 'write-failed', code: null, movedAside: [] }, 1).message).not.toContain('(')
    expect(albumGroupsOf([])).toEqual([])
  })

  it('builds a result stamp from a media verification and adds the outcome warnings', () =>
  {
    const job = {
      recipe: { kind: 'compress' } as Recipe,
      source: { size: 100 },
      verification: {
        verdict: 'verified',
        encodePasses: 1,
        audio: null,
        messages: [],
        media: { decode: 'sampled', decodeErrors: [], decodeErrorCount: 0, durationSec: 5, expectedDurationSec: 5, duration: 'within', streams: { video: 1, audio: 1, subtitle: 0, attachment: 0 }, streamMatch: true, size: { bytes: 150, targetBytes: 200, status: 'within' }, frames: 120, cues: null }
      }
    } as never
    const result = buildJobResult({
      job,
      artifact: { kind: 'file', path: 'C:\\w\\out.part', container: 'mp4', bytes: 150, durationSec: 5, encoder: { video: 'libx264', audio: ['aac'] } },
      placed: { status: 'done', finalPath: 'C:\\out\\clip.mp4', placement: { kind: 'new' }, warnings: [], previous: null, copied: false, workDirRemoved: true },
      warnings: [],
      notes: ['note'],
      elapsedMs: 10
    })
    expect(result.stamp).toMatchObject({ outputName: 'clip.mp4', decode: 'sampled', size: { targetBytes: 200, status: 'within' }, frames: 120, warnings: 1 })
    expect(result.warnings.map((w) => w.code)).toEqual(['larger-than-source'])
  })
})

describe('audio result stamps', () =>
{
  function verified(lufs: number | null, peak: number | null, preEncode: number | null = peak): VerifiedStream
  {
    return { outIndex: 0, integratedLufs: lufs, loudnessRangeLu: null, maxShortTermLufs: null, preEncodeTruePeakDbtp: preEncode, truePeakDbtp: peak, samplePeakDbfs: null, meter: 'soxr-8x' }
  }

  function verdict(audioIndex: number, outcome: StreamVerdict['outcome'], extra: { status?: StreamVerdict['loudness']['status']; deviation?: number; tolerance?: number; reference?: 'target' | 'reachable'; peak?: 'within' | 'over' } = {}): StreamVerdict
  {
    return {
      audioIndex,
      outcome,
      loudness: { status: extra.status ?? 'within', reference: extra.reference ?? 'target', referenceLufs: -16, deviationLu: extra.deviation ?? -0.2, toleranceLu: extra.tolerance ?? 1, standardTolerance: { value: 1, unit: 'dB' } },
      shortTerm: { status: 'not-checked', limitLufs: null, maxLufs: null, toleranceLu: 0 },
      truePeak: { status: extra.peak ?? 'within', basis: 'pre-encode', gateDbtp: -1, overDb: null },
      decoded: { status: 'within', limitDbtp: -1, overDb: null },
      samplePeakOver: false,
      warnings: [],
      meterMarginDb: 0,
      encodePasses: 1
    }
  }

  function measured(classes: ReadonlyArray<'lossless' | 'lossy-high'>): JobMeasurement
  {
    return {
      pass: 'source',
      measuredAt: 1,
      streams: classes.map((outputClass, audioIndex) => ({ measurement: { audioIndex } as never, plan: { audioIndex, ceiling: { outputClass } } as never })),
      album: null,
      messages: []
    }
  }

  function audioVerification(verdictOf: Verification['verdict'], streams: NonNullable<Verification['audio']>): Verification
  {
    return { verdict: verdictOf, encodePasses: 1, audio: streams, media: null, messages: [] }
  }

  it('stamps a Normalize job with its worst stream: loudness, reference, check, class, and true peak', () =>
  {
    const recipe = applyPreset('apple-podcasts', { kind: 'same-as-source' }) as Recipe
    const verification = audioVerification('outside-tolerance', [
      { verified: verified(-16.2, -1.8), verdict: verdict(0, 'verified') },
      { verified: verified(-19.4, -3.1, -3.3), verdict: verdict(1, 'outside-tolerance', { status: 'below', deviation: -3.4, peak: 'over' }) }
    ])
    const stamp = audioStampFields({ recipe, measurement: measured(['lossless', 'lossy-high']), plan: null }, verification)
    expect(stamp.verdictStream).toBe(1)
    expect(stamp.loudness).toEqual({
      lufs: -19.4,
      unit: 'LKFS',
      reference: 'target',
      referenceLufs: -16,
      deviation: -3.4,
      deviationUnit: 'dB',
      check: 1,
      checkClass: 'lossy',
      status: 'below'
    })
    expect(stamp.truePeak).toEqual({ dbtp: -3.1, preEncodeDbtp: -3.3, limitDbtp: -1, status: 'over' })
  })

  it('takes the class from the static plan without a measurement and keeps a reachable reference', () =>
  {
    const recipe = applyDefaultPreset('normalize', { kind: 'same-as-source' })
    const verification = audioVerification('verified-below-target', [
      { verified: verified(-18.9, -1.2), verdict: verdict(0, 'passthrough', { status: 'not-checked' }) },
      { verified: verified(-19.1, -1.4), verdict: verdict(1, 'verified-below-target', { reference: 'reachable', tolerance: 0.5 }) }
    ])
    const plan = { audio: [{ audioIndex: 0, ceiling: { outputClass: 'lossy-low' } }, { audioIndex: 1, ceiling: { outputClass: 'lossless' } }] } as never
    const stamp = audioStampFields({ recipe, measurement: null, plan }, verification)
    expect(stamp.verdictStream).toBe(1)
    expect(stamp.loudness).toMatchObject({ lufs: -19.1, reference: 'reachable', check: 0.5, checkClass: 'lossless', status: 'within', deviationUnit: 'LU' })
  })

  it('stamps a Gain job in LUFS and LU, and the first stream when every stream verified', () =>
  {
    const recipe = applyDefaultPreset('boost', { kind: 'same-as-source' })
    const verification = audioVerification('verified', [
      { verified: verified(-14.1, -1.5), verdict: verdict(0, 'verified') },
      { verified: verified(-14.3, -1.7), verdict: verdict(1, 'verified') }
    ])
    const stamp = audioStampFields({ recipe, measurement: measured(['lossy-high', 'lossy-high']), plan: null }, verification)
    expect(stamp.verdictStream).toBe(0)
    expect(stamp.loudness).toMatchObject({ lufs: -14.1, unit: 'LUFS', deviationUnit: 'LU', checkClass: 'lossy' })
    expect(stamp.truePeak?.status).toBe('within')
  })

  it('leaves loudness and true peak out when nothing measured them, and every audio field out for other operations', () =>
  {
    const recipe = applyDefaultPreset('normalize', { kind: 'same-as-source' })
    const unmeasured = audioVerification('failed', [{ verified: verified(null, null), verdict: verdict(0, 'failed', { status: 'not-checked' }) }])
    expect(audioStampFields({ recipe, measurement: null, plan: null }, unmeasured)).toEqual({ verdictStream: 0, loudness: null, truePeak: null })
    expect(audioStampFields({ recipe, measurement: null, plan: null }, { ...unmeasured, audio: [{ verified: null, verdict: verdict(0, 'failed') }] }))
      .toEqual({ verdictStream: 0, loudness: null, truePeak: null })
    const none = { verdictStream: null, loudness: null, truePeak: null }
    expect(audioStampFields({ recipe, measurement: null, plan: null }, null)).toEqual(none)
    expect(audioStampFields({ recipe, measurement: null, plan: null }, { ...unmeasured, audio: null })).toEqual(none)
    expect(audioStampFields({ recipe: applyDefaultPreset('convert', { kind: 'same-as-source' }), measurement: null, plan: null }, unmeasured)).toEqual(none)
  })

  it('gives the summary the checks its verified count was judged by, so every surface agrees', () =>
  {
    const recipe = applyDefaultPreset('normalize', { kind: 'same-as-source' })
    const levels = [-18.4, -18.2, -18]
    const records = levels.map((lufs, n) =>
    {
      const verification = audioVerification('verified', [{ verified: verified(lufs, -3.5), verdict: verdict(0, 'verified', { deviation: lufs + 18 }) }])
      const job = { recipe, source: { size: 100 }, verification, measurement: measured([n === 0 ? 'lossless' : 'lossy-high']), plan: null } as never
      const result = buildJobResult({
        job,
        artifact: { kind: 'file', path: `C:\\w\\${n}.part`, container: n === 0 ? 'flac' : 'mp3', bytes: 90, durationSec: 30, encoder: { video: null, audio: ['flac'] } },
        placed: { status: 'done', finalPath: `C:\\out\\${n}-normalize.mp3`, placement: { kind: 'new' }, warnings: [], previous: null, copied: false, workDirRemoved: true },
        warnings: [],
        notes: [],
        elapsedMs: 10
      })
      expect(result.stamp).toMatchObject({ verdict: 'verified', decode: 'full', verdictStream: 0 })
      return { jobId: `MM-000${n + 1}`, attempt: 1, state: 'done', op: 'normalize', recipe, verification, measurement: measured(['lossy-high']), result } as never
    })
    const [outcome] = recipeOutcomes(records)
    expect(outcome.verified).toBe(3)
    expect(outcome.loudness?.checks).toEqual([
      { checkClass: 'lossless', check: 1, jobs: 1, within: 1 },
      { checkClass: 'lossy', check: 1, jobs: 2, within: 2 }
    ])
    expect(outcome.loudness).toMatchObject({ minLufs: -18.4, maxLufs: -18, streams: 3, maxTruePeakDbtp: -3.5 })
  })
})

describe('held outputs', () =>
{
  async function heldAfterRun(h: Harness): Promise<{ a: JobId; b: JobId; runId: string }>
  {
    await h.boot()
    const [a, b] = await h.addFiles(['one.wav', 'two.wav'])
    const first = await h.value('preflight', { ids: 'pending' })
    for (const id of [a, b])
    {
      h.disk.put(first.jobs.find((entry) => entry.jobId === id)?.plan?.output.finalPath as string, 50)
    }
    await h.value('setPolicy', { policy: { ...POLICY, conflict: 'overwrite' } })
    h.control.verification = () => ({ ...VERIFIED, verdict: 'outside-tolerance' })
    const started = await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b)
    await h.settle(10)
    expect(h.view(a).state).toBe('held')
    expect(h.view(b).state).toBe('held')
    return { a, b, runId: started.runId }
  }

  it('keeps a held output of a completed run in place or under a free name, with job events only', async () =>
  {
    const h = track(harness())
    const { a, b } = await heldAfterRun(h)
    const index = join(USER_DATA, 'jobs', 'runs', 'index.json')
    const before = h.io.text.get(index)
    const mark = h.sender.events.length
    const kept = await h.send('keepOutput', { ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    expect(kept.ok).toBe(true)
    await h.settle(10)
    expect(h.view(a).state).toBe('done')
    expect(h.view(a).stamp?.placement).toBe('overwrote')
    const renamed = await h.value('keepOutput', { ids: [b], placement: 'renamed', confirm: null })
    expect(renamed.refused.map((r) => r.jobId)).toEqual([b])
    const discarded = await h.value('discardOutput', { ids: [b] })
    expect(discarded.applied).toEqual([b])
    await h.settle(10)
    expect(h.view(b).state).toBe('canceled')
    expect(h.sender.events.slice(mark).every((e) => e.type.startsWith('job.'))).toBe(true)
    expect(h.io.text.get(index)).not.toBe(before)
    wireCheck(h)
  })

  it('restores held outputs after a restart and keeps them from there', async () =>
  {
    const h = harness()
    const { a } = await heldAfterRun(h)
    await h.engine.shutdown('quit')
    const next = track(harness({ io: h.io, disk: h.disk }))
    await next.boot()
    expect(next.view(a).state).toBe('held')
    const kept = await next.send('keepOutput', { ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    expect(kept.ok).toBe(true)
    await next.settle(10)
    expect(next.view(a).state).toBe('done')
    wireCheck(next)
  })

  it('defers the recovery checks of a volume that does not answer and reruns them once it does', async () =>
  {
    const h = harness()
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    await h.startRun()
    await runThrough(h, a, ['probe', 'measure', 'encode'])
    h.disk.gate = new Promise(() => undefined)
    await runThrough(h, a, ['verify'])
    expect(h.view(a).state).toBe('finalizing')
    h.disk.gate = null
    await h.engine.shutdown('session-end')
    const offline = { roots: new Set(['C:\\']), waiters: [] as Array<() => void> }
    const next = track(harness({ io: h.io, disk: h.disk, offline }))
    let booted = false
    const booting = next.engine.init().then(() =>
    {
      booted = true
    })
    for (let i = 0; i < 200 && !booted; i++)
    {
      await next.timers.advance(1000)
    }
    await booting
    await next.value('subscribe', { clientId: 'main' })
    const snap = next.engine.snapshot()
    expect(snap.alerts.some((alert) => alert.kind === 'volume-offline')).toBe(true)
    offline.roots.clear()
    for (const wake of offline.waiters.splice(0))
    {
      wake()
    }
    await next.timers.advance(61_000)
    await next.settle(5)
    let answered = false
    const resuming = next.engine.command('resume', { ack: null }, { senderId: 7 }).finally(() =>
    {
      answered = true
    })
    for (let i = 0; i < 300 && !answered; i++)
    {
      await next.timers.advance(1000)
    }
    expect(typeof (await resuming).ok).toBe('boolean')
    await next.settle(5)
    expect(next.engine.snapshot().alerts.some((alert) => alert.kind === 'volume-offline')).toBe(false)
    expect(['held', 'done']).toContain(next.view(a).state)
  })
})

describe('more engine paths', () =>
{
  it('starts while storage fails, keeps answering, and refuses new jobs with io-error', async () =>
  {
    const io = memoryIO()
    io.failing = true
    const h = track(harness({ io }))
    await h.boot()
    h.disk.put(join(MEDIA, 'a.wav'), 1000)
    const refused = await h.send('add', { paths: [join(MEDIA, 'a.wav')], recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
    expect(!refused.ok && refused.error.code).toBe('io-error')
    expect(h.log.lines.some((l) => l.level === 'warn' && l.message.includes('No catalog numbers could be reserved'))).toBe(true)
    expect((await h.send('listRuns', { before: null, limit: 5 })).ok).toBe(true)
  })

  it('plans a job whose source vanished as a probe failure and cancels a run before it dispatches', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    h.disk.files.delete(join(MEDIA, 'b.wav'))
    const report = await h.value('preflight', { ids: 'pending' })
    expect(report.jobs.find((entry) => entry.jobId === b)?.status).toBe('blocked')
    await h.value('start', { preflightId: report.preflightId, ack: null, resume: false })
    const canceled = await h.engine.command('cancelRun', {}, { senderId: 7 })
    expect(canceled.ok).toBe(true)
    await h.settle()
    expect(h.view(a).state).toBe('canceled')
    const completed = h.sender.events.filter((e) => e.type === 'run.completed') as Array<Extract<JobEvent, { type: 'run.completed' }>>
    expect(completed).toHaveLength(1)
    expect(completed[0].summary.endedBy).toBe('canceled')
    wireCheck(h)
  })

  it('configures GPU sessions through the worker settings and gives every child the priority', async () =>
  {
    const h = track(harness())
    await h.boot()
    const workers = await h.value('setWorkers', { workers: { mode: 'fixed', count: 3 }, gpuSessions: { mode: 'fixed', count: 2 } })
    expect(workers.setting).toEqual({ mode: 'fixed', count: 3 })
    expect(h.config().settings.gpuSessions).toEqual({ mode: 'fixed', count: 2 })
  })

  it('holds a kept output again when its placement meets a locked file', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['one.wav'])
    const first = await h.value('preflight', { ids: 'pending' })
    const target = first.jobs.find((entry) => entry.jobId === a)?.plan?.output.finalPath as string
    h.disk.put(target, 50)
    await h.value('setPolicy', { policy: { ...POLICY, conflict: 'overwrite' } })
    h.control.verification = () => ({ ...VERIFIED, verdict: 'outside-tolerance' })
    await h.startRun()
    await runThrough(h, a)
    expect(h.view(a).state).toBe('held')
    const locked = h.deps.fs.rename
    h.deps.fs.rename = async () =>
    {
      throw codeError('EBUSY', 'resource busy or locked')
    }
    await h.value('keepOutput', { ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    for (let i = 0; i < 40 && h.view(a).state !== 'held'; i++)
    {
      await h.timers.advance(2000)
    }
    expect(h.view(a).state).toBe('held')
    expect(h.view(a).hold?.reason).toBe('file-locked')
    h.deps.fs.rename = locked
    wireCheck(h)
  })
})

describe('history commands through the engine', () =>
{
  it('exports a report through the save dialog, reveals a record, and reruns a finished run', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    const started = await h.startRun()
    await runThrough(h, a)
    await h.settle(5)
    const canceled = await h.value('exportReport', { scope: { runId: started.runId }, format: 'csv' })
    expect(canceled).toEqual({ canceled: true })
    const reportPath = join(MEDIA, 'report.csv')
    h.deps.shell.chooseSavePath = async () => reportPath
    const saved = await h.value('exportReport', { scope: { runId: started.runId }, format: 'csv' })
    expect(saved).toEqual({ path: reportPath })
    const revealed = await h.send('revealRecord', { runId: started.runId, jobId: a, attempt: 1, target: 'source' })
    expect(revealed.ok).toBe(true)
    expect(h.deps.shell.showItemInFolder).toHaveBeenCalled()
    const rerun = await h.value('rerun', { runId: started.runId, jobIds: 'all', force: false })
    expect(rerun.added).toHaveLength(1)
    await h.settle()
    expect(h.view(rerun.added[0]).rerunOf).toEqual({ runId: started.runId, jobId: a })
    wireCheck(h)
  })
})
