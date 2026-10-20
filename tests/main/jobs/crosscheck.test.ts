/**
 * The crosscheck additions over the composed engine: restore windows, locate and relink, rerun and history search,
 * policy changes and the Replace reset, retries, removal guards, duplicate detection, offline volumes, kept files,
 * the per-recipe summary, and the preset and folder events. In-memory persistence, file operations, and volumes, a
 * real planner, fake runners scripted per stage, and manual timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { basename, dirname, join, win32 } from 'node:path'
import { createJobEngine, type EngineDeps, type JobEngine } from '../../../src/main/jobs/engine'
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
import type { AudioFacts, MediaFacts } from '../../../src/shared/audio/types'
import { applyDefaultPreset, applyPreset } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, CapabilitySummary, JobErrorCode, JobMeasurement, JobView, RunSettings, Verification } from '../../../src/shared/jobs/types'
import type { JobId } from '../../../src/shared/jobs/ids'
import { engineError } from '../../../src/main/jobs/scheduler'
import { assertWireSafe } from '../../../src/shared/jobs/wire'
import { createManualTimers, type ManualTimers } from '../helpers/manual-timers'

const USER_DATA = 'C:\\app'
const MEDIA = 'C:\\media'
const SAME = { kind: 'same-as-source' } as const

const ENCODERS = ['aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le', 'pcm_s24le', 'libx264', 'libx265']

const BUILD: BuildCapabilities = { encoders: new Set(ENCODERS), experimental: new Set(), soxr: true }

const CAPS: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: 'n9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
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

function movie(path: string): MediaFacts
{
  return { ...song(path), container: 'mp4', formatName: 'mov,mp4,m4a,3gp,3g2,mj2', video: [{ streamIndex: 1, codecName: 'h264', cover: false }] }
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
  private ino = 100

  put(path: string, size: number, text: string | null = null): void
  {
    this.files.set(path, { size, ino: ++this.ino, text })
    this.mkdirs(win32.dirname(path))
  }

  mkdirs(path: string): void
  {
    let at = path
    while (!this.dirs.has(at) && win32.dirname(at) !== at)
    {
      this.dirs.add(at)
      at = win32.dirname(at)
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
    list: async (dir) => [...disk.files.keys(), ...disk.dirs].filter((p) => win32.dirname(p) === dir).map((p) => win32.basename(p)),
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
      const names = [...disk.files.keys(), ...disk.dirs].filter((p) => win32.dirname(p) === path)
      return (async function* entries()
      {
        for (const name of names)
        {
          yield { name: win32.basename(name), isFile: () => kind(name) === 'file', isDirectory: () => kind(name) === 'dir', isSymbolicLink: () => false }
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
      return disk.dirs.has(path) || win32.dirname(path) === path ? { size: 0, mtimeMs: 1000, isFile: false, isDirectory: true, dev: '1', ino: '1' } : null
    },
    statfs: async (path) => ({ freeBytes: free.get(path.slice(0, 3).toLowerCase()) ?? 500_000_000_000, totalBytes: 1_000_000_000_000 }),
    probeWrite: async () => true,
    volumeInfo: async () => info,
    reachable: async (root) => !unreachable.has(root)
  }
}

function volumes(bin: { free: number | null }): VolumeRegistry
{
  return {
    root: async (path) => path.slice(0, 3),
    key: async (path) => path.slice(0, 3).toLowerCase(),
    info: async () => ({ kind: 'local', trash: 'available', trashBytesFree: bin.free, volumeBytes: 1_000_000_000_000 }),
    refreshTrash: async () => ({ trash: 'available', trashBytesFree: bin.free }),
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
}

function harness(options: HarnessOptions = {})
{
  const timers = createManualTimers(options.start ?? 1_700_000_000_000)
  const log = fakeLog()
  const disk = options.disk ?? new Disk()
  const io = options.io ?? memoryIO()
  const free = options.free ?? new Map<string, number>()
  const unreachable = new Set<string>()
  const bin: { free: number | null } = { free: 50_000_000_000 }
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
    probe: probes(disk, options.facts ?? ((path) => (path.endsWith('.mp4') ? movie(path) : song(path)))),
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
    volumes: volumes(bin),
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
    stat: async (path) => (disk.dirs.has(path) || disk.files.has(path) || win32.dirname(path) === path ? {} : Promise.reject(codeError('ENOENT'))),
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
      if (!disk.files.has(win32.join(MEDIA, name)))
      {
        disk.put(win32.join(MEDIA, name), 1000)
      }
    }
    const added = await value('add', { paths: names.map((name) => win32.join(MEDIA, name)), recipe, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
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
    engine, deps, timers, log, disk, io, free, unreachable, bin, fsCalls, control, sender, notifications, quits, persisted,
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
  await h.settle(10)
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

function wireCheck(h: Harness): void
{
  for (const line of h.journalLines())
  {
    assertWireSafe(line)
  }
}

function convert(): Recipe
{
  return applyPreset('mp4-h264', SAME) as Recipe
}

describe('jobs:restore', () =>
{
  it('restores removed jobs within 10 minutes and refuses after 10 minutes or 50 later operations', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b, c] = await h.addFiles(['a.wav', 'b.wav', 'c.wav'])
    const first = await h.value('remove', { ids: [a] })
    expect(first.tombstone).not.toBeNull()
    await h.timers.advance(9 * 60 * 1000)
    const back = await h.value('restore', { tombstone: first.tombstone as string })
    expect(back.applied).toEqual([a])
    expect(h.engine.snapshot().order).toContain(a)

    const late = await h.value('remove', { ids: [b] })
    await h.timers.advance(10 * 60 * 1000 + 1)
    const expired = await h.send('restore', { tombstone: late.tombstone as string })
    expect(!expired.ok && expired.error.code).toBe('restore-expired')

    const buried = await h.value('remove', { ids: [c] })
    for (let i = 0; i < 50; i++)
    {
      const [extra] = await h.addFiles(['x-' + i + '.wav'])
      await h.value('remove', { ids: [extra] })
    }
    const pushedOut = await h.send('restore', { tombstone: buried.tombstone as string })
    expect(!pushedOut.ok && pushedOut.error.code).toBe('restore-expired')
    wireCheck(h)
  })
})

describe('jobs:locate and jobs:relink', () =>
{
  it('points jobs at moved sources and plans them again', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b, c] = await h.addFiles(['a.wav', 'b.wav', 'c.wav'])
    await h.value('preflight', { ids: 'pending' })
    for (const name of ['a.wav', 'b.wav', 'c.wav'])
    {
      h.disk.files.delete(win32.join(MEDIA, name))
      h.disk.put(win32.join('C:\\moved', name), 1000)
    }
    const located = await h.value('locate', { jobId: a, path: win32.join('C:\\moved', 'a.wav') })
    expect(located.applied).toEqual([a])
    await h.settle()
    expect(h.view(a).source.path).toBe(win32.join('C:\\moved', 'a.wav'))
    expect(located.relinkable?.ids.sort()).toEqual([b, c].sort())
    const relinked = await h.value('relink', { fromDir: MEDIA, toDir: 'C:\\moved', ids: [b, c] })
    expect(relinked.applied.sort()).toEqual([b, c].sort())
    await h.settle()
    const report = await h.value('preflight', { ids: 'pending' })
    for (const id of [a, b, c])
    {
      expect(h.view(id).source.dir).toBe('C:\\moved')
      expect(report.jobs.find((entry) => entry.jobId === id)?.plan?.output.finalPath.startsWith('C:\\moved\\')).toBe(true)
    }
    wireCheck(h)
  })
})

describe('jobs:setPolicy', () =>
{
  it('is refused while queued or active jobs exist and accepted once the run is over', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    await h.value('setWorkers', { workers: { mode: 'fixed', count: 1 }, gpuSessions: null })
    await h.startRun()
    expect(h.view(a).state).toBe('analyzing')
    expect(h.view(b).state).toBe('queued')
    const refused = await h.send('setPolicy', { policy: { ...POLICY, conflict: 'skip' } })
    expect(!refused.ok && refused.error.code).toBe('invalid-state')
    await runThrough(h, a)
    await runThrough(h, b)
    const accepted = await h.send('setPolicy', { policy: { ...POLICY, conflict: 'skip' } })
    expect(accepted.ok && accepted.value.policy.conflict).toBe('skip')
    expect(h.persisted.some((change) => change.policy?.conflict === 'skip')).toBe(true)
  })

  it('returns a Replace policy to the saved default when its run completes or is canceled', async () =>
  {
    const h = track(harness())
    await h.boot()
    const replace = { ...POLICY, destination: { mode: 'replace-originals' as const } }
    const [a] = await h.addFiles(['a.wav'])
    await h.value('setPolicy', { policy: replace })
    expect(h.engine.snapshot().policy.destination.mode).toBe('replace-originals')
    expect(h.persisted.some((change) => change.policy?.destination.mode === 'replace-originals')).toBe(false)
    await h.startRun()
    await runThrough(h, a)
    expect(h.view(a).state).toBe('done')
    await h.settle()
    expect(h.engine.snapshot().policy.destination.mode).toBe('next-to-source')

    const [b] = await h.addFiles(['b.wav'])
    await h.value('setPolicy', { policy: replace })
    await h.startRun()
    expect(h.view(b).state).toBe('analyzing')
    await h.value('cancelRun', {})
    await h.settle()
    expect(h.view(b).state).toBe('canceled')
    expect(h.engine.snapshot().policy.destination.mode).toBe('next-to-source')
    wireCheck(h)
  })
})

describe('presets and folders', () =>
{
  it('emits presets.changed for a saved preset and folders.changed for a scanned folder', async () =>
  {
    const h = track(harness())
    await h.boot()
    const saved = await h.value('savePreset', { id: null, name: 'Loud podcast', recipe: normalize(), pin: 3 })
    const presets = h.sender.events.filter((e) => e.type === 'presets.changed')
    expect(presets.length).toBeGreaterThan(0)
    const last = presets[presets.length - 1] as Extract<JobEvent, { type: 'presets.changed' }>
    expect(last.presets.user.map((p) => p.id)).toContain(saved.preset.id)
    expect(h.engine.snapshot().presets.pins['3']).toBe(saved.preset.id)
    h.disk.put(win32.join('C:\\album', 'one.wav'), 1000)
    h.disk.put(win32.join('C:\\album', 'two.wav'), 1000)
    const added = await h.value('add', { paths: ['C:\\album'], recipe: null, origin: 'folder', after: null, recursive: true, allowSecondJobs: false, force: false })
    await h.settle()
    expect(added.scanIds.length).toBe(1)
    const folders = h.sender.events.filter((e) => e.type === 'folders.changed') as Array<Extract<JobEvent, { type: 'folders.changed' }>>
    expect(folders.length).toBeGreaterThan(0)
    expect(folders[folders.length - 1].recentFolders.map((f) => f.path)).toContain('C:\\album')
    expect(h.persisted.some((change) => change.recentFolders !== undefined)).toBe(true)
    expect(h.engine.snapshot().jobs).toHaveLength(2)
    wireCheck(h)
  })
})

describe('duplicates', () =>
{
  it('finds a waiting path whatever its recipe, adds a second job when asked, and skips previous outputs unless forced', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    const again = await h.value('add', { paths: [win32.join(MEDIA, 'a.wav')], recipe: convert(), origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
    expect(again.added).toEqual([])
    expect(again.duplicates.jobIds).toEqual([a])
    const second = await h.value('add', { paths: [win32.join(MEDIA, 'a.wav')], recipe: convert(), origin: 'files', after: null, recursive: false, allowSecondJobs: true, force: false })
    expect(second.added).toHaveLength(1)
    await h.value('remove', { ids: second.added })
    await h.startRun([a])
    await runThrough(h, a)
    expect(h.view(a).state).toBe('done')
    const output = h.engine.snapshot().jobs.find((job) => job.id === a)?.stamp?.outputName as string
    const outputPath = win32.join(MEDIA, output)
    expect(h.disk.files.has(outputPath)).toBe(true)
    const previous = await h.value('add', { paths: [outputPath], recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
    expect(previous.added).toEqual([])
    expect(previous.previousOutputs).toEqual([outputPath])
    const forced = await h.value('add', { paths: [outputPath], recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: true })
    expect(forced.added).toHaveLength(1)
    wireCheck(h)
  })
})

function failWith(code: JobErrorCode, ids: JobId[]): RunnerControl['outcome']
{
  return (script) => (ids.includes(script.job.id) ? { kind: 'failed', error: engineError(code, 'FFmpeg could not decode the source.', 'encode', script.job.attempt, 0) } : null)
}

describe('history', () =>
{
  it('runs:rerun refuses a source path that now holds its own output and reports missing sources', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    await h.value('setPolicy', { policy: { ...POLICY, destination: { mode: 'replace-originals' } } })
    const started = await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b)
    expect(h.view(a).state).toBe('done')
    expect(h.view(b).state).toBe('done')
    expect(h.disk.files.get(win32.join(MEDIA, 'a.wav'))?.size).toBe(900)
    await h.settle()
    h.disk.files.delete(win32.join(MEDIA, 'b.wav'))
    const rerun = await h.value('rerun', { runId: started.runId, jobIds: 'all', force: false })
    expect(rerun.added).toEqual([])
    expect(rerun.holdsOutput.map((entry) => entry.jobId)).toEqual([a])
    expect(rerun.missing).toEqual([{ jobId: b, path: win32.join(MEDIA, 'b.wav') }])
    wireCheck(h)
  })

  it('runs:search finds records across runs and runs:delete removes a run', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['alpha-one.wav'])
    const first = await h.startRun()
    await runThrough(h, a)
    await h.settle()
    const [b] = await h.addFiles(['alpha-two.wav'])
    const second = await h.startRun()
    await runThrough(h, b)
    await h.settle()
    expect(first.runId).not.toBe(second.runId)
    const found = await h.value('searchRuns', { query: 'alpha', limit: 50, before: null })
    expect(found.runs).toBe(2)
    expect(new Set(found.matches.map((m) => m.runId))).toEqual(new Set([first.runId, second.runId]))
    const listed = await h.value('listRuns', { before: null, limit: 50 })
    expect(listed.runs.map((r) => r.runId)).toEqual([second.runId, first.runId])
    const deleted = await h.value('deleteRuns', { runIds: [first.runId] })
    expect(deleted.deleted).toBe(1)
    const after = await h.value('listRuns', { before: null, limit: 50 })
    expect(after.runs.map((r) => r.runId)).toEqual([second.runId])
    expect(h.io.text.has(join(USER_DATA, 'jobs', 'runs', first.runId + '.jsonl'))).toBe(false)
    const run = await h.value('getRun', { runId: second.runId, offset: 0, limit: 50 })
    expect(run.records.map((r) => r.jobId)).toEqual([b])
    wireCheck(h)
  })
})

describe('retry', () =>
{
  it('queues a retry whose plan is unchanged and returns a changed plan as changed', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    h.control.outcome = failWith('ffmpeg-failed', [a, b])
    const report = await h.value('preflight', { ids: 'pending' })
    await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b)
    expect(h.view(a).state).toBe('failed')
    expect(h.view(b).state).toBe('failed')
    h.control.outcome = undefined
    const unchanged = await h.value('retry', { ids: [a], recipe: null, ack: null, start: true })
    expect(unchanged.queued).toEqual([a])
    expect(h.view(a).attempt).toBe(2)
    const target = report.jobs.find((entry) => entry.jobId === b)?.plan?.output.finalPath as string
    h.disk.put(target, 10)
    const changed = await h.value('retry', { ids: [b], recipe: null, ack: null, start: true })
    expect(changed.changed).toEqual([b])
    expect(h.view(b).state).toBe('pending')
    wireCheck(h)
  })

  it('retries a done job placed outside tolerance', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    h.control.verification = () => ({ ...VERIFIED, verdict: 'outside-tolerance' })
    await h.startRun()
    await runThrough(h, a)
    expect(h.view(a).state).toBe('done')
    expect(h.view(a).warnings.map((w) => w.code)).toContain('outside-tolerance-placed')
    h.control.verification = undefined
    const retried = await h.value('retry', { ids: 'failed', recipe: null, ack: null, start: true })
    expect(new Set([...retried.queued, ...retried.pending, ...retried.changed])).toEqual(new Set([a]))
    expect(h.view(a).attempt).toBe(2)
    wireCheck(h)
  })
})

describe('jobs:remove', () =>
{
  it('refuses a job that needs attention until it is acknowledged', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    h.control.outcome = failWith('ffmpeg-failed', [a])
    await h.startRun()
    await runThrough(h, a)
    expect(h.view(a).state).toBe('failed')
    const refused = await h.value('remove', { ids: [a] })
    expect(refused.applied).toEqual([])
    expect(refused.refused.map((r) => r.code)).toEqual(['needs-attention'])
    await h.value('acknowledge', { ids: [a] })
    const removed = await h.value('remove', { ids: [a] })
    expect(removed.applied).toEqual([a])
    wireCheck(h)
  })
})

describe('offline volumes', () =>
{
  it('pauses the run with destination-unavailable when the destination stops answering', async () =>
  {
    const h = track(harness())
    await h.boot()
    h.disk.mkdirs('D:\\out')
    await h.value('setPolicy', { policy: { ...POLICY, destination: { mode: 'folder', folder: 'D:\\out' }, template: '{name}' } })
    const [a] = await h.addFiles(['a.wav'])
    const report = await h.value('preflight', { ids: 'pending' })
    h.unreachable.add('D:\\')
    await h.value('start', { preflightId: report.preflightId, ack: null, resume: false })
    await h.settle()
    const snap = h.engine.snapshot()
    expect(snap.run.status).toBe('paused')
    expect(snap.run.pause?.reason).toBe('destination-unavailable')
    expect(snap.alerts.some((alert) => alert.kind === 'destination-unavailable')).toBe(true)
    expect(h.view(a).state).toBe('queued')
    wireCheck(h)
  })

  it('names a decode failure source-offline when the source volume no longer answers', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a, b] = await h.addFiles(['a.wav', 'b.wav'])
    h.control.outcome = (script) =>
    {
      if (script.job.id === a)
      {
        h.unreachable.add('C:\\')
      }
      return failWith('ffmpeg-failed', [a, b])?.(script) ?? null
    }
    await h.startRun()
    await runThrough(h, a)
    await h.settle()
    expect(h.view(a).state).toBe('failed')
    expect(h.view(a).error?.code).toBe('source-offline')
    h.unreachable.clear()
    await runThrough(h, b)
    await h.settle()
    expect(h.view(b).error?.code).toBe('ffmpeg-failed')
    wireCheck(h)
  })
})

describe('displaced files', () =>
{
  it("keeps the displaced file under displaced: 'keep', and keeps it with a warning when the bin is full", async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['a.wav'])
    const first = await h.value('preflight', { ids: 'pending' })
    const target = first.jobs.find((entry) => entry.jobId === a)?.plan?.output.finalPath as string
    h.disk.put(target, 50)
    await h.value('setPolicy', { policy: { ...POLICY, conflict: 'overwrite', displaced: 'keep' } })
    await h.startRun()
    await runThrough(h, a)
    expect(h.view(a).state).toBe('done')
    expect(h.view(a).stamp?.placement).toBe('overwrote')
    const detail = await h.value('get', { jobId: a })
    const placement = detail.result?.placement
    expect(placement?.kind === 'overwrote' && placement.previous.status).toBe('kept')
    expect(h.disk.files.get(target)?.size).toBe(900)
    expect([...h.disk.files.values()].some((file) => file.size === 50)).toBe(true)

    const [b] = await h.addFiles(['b.wav'])
    const second = await h.value('preflight', { ids: 'pending' })
    const otherTarget = second.jobs.find((entry) => entry.jobId === b)?.plan?.output.finalPath as string
    h.disk.put(otherTarget, 60)
    await h.value('setPolicy', { policy: { ...POLICY, conflict: 'overwrite', displaced: 'trash' } })
    h.bin.free = 0
    await h.startRun()
    await runThrough(h, b)
    expect(h.view(b).state).toBe('done')
    expect(h.view(b).warnings.map((w) => w.code)).toContain('previous-kept')
    expect([...h.disk.files.values()].some((file) => file.size === 60)).toBe(true)
    wireCheck(h)
  })
})

describe('the run summary', () =>
{
  it('counts outcomes per recipe in run.completed', async () =>
  {
    const h = track(harness())
    await h.boot()
    const [a] = await h.addFiles(['song.wav'])
    const [b] = await h.addFiles(['clip.mp4'], convert())
    await h.startRun()
    await runThrough(h, a)
    await runThrough(h, b, ['probe', 'encode', 'verify'])
    const completed = h.sender.events.filter((e) => e.type === 'run.completed') as Array<Extract<JobEvent, { type: 'run.completed' }>>
    expect(completed).toHaveLength(1)
    const recipes = completed[0].summary.recipes
    expect(recipes.map((r) => r.op).sort()).toEqual(['convert', 'normalize'])
    expect(recipes.every((r) => r.jobs === 1 && r.verified === 1)).toBe(true)
    expect(completed[0].summary.counts.done).toBe(2)
    expect(h.notifications.length).toBeGreaterThan(0)
    wireCheck(h)
  })
})

