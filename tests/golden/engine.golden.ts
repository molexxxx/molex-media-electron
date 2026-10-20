import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { CommandResult, JobCommandName, JobCommandRequest, JobCommandResponse } from '../../src/shared/jobs/contract'
import type { JobId } from '../../src/shared/jobs/ids'
import type { ConvertRecipe, Recipe } from '../../src/shared/jobs/recipes'
import { TERMINAL_STATES, type BatchPolicy, type CapabilitySummary, type JobDetail, type JobState, type JobView, type RunSettings } from '../../src/shared/jobs/types'
import type { JobsConfig } from '../../src/main/config'
import type { BuildCapabilities } from '../../src/main/ffmpeg/audio/encoders'
import { createExec, type Exec } from '../../src/main/ffmpeg/exec'
import { createProbe } from '../../src/main/ffmpeg/probe'
import type { EventSender, FsOps, JobLogger } from '../../src/main/jobs/deps'
import { createJobEngine, type EngineDeps, type JobEngine } from '../../src/main/jobs/engine'
import { createFsOps } from '../../src/main/jobs/fsops'
import { createNodeHistoryFs } from '../../src/main/jobs/history'
import { displacedPath, isWorkDirName, PART_SUFFIX, partOutputName } from '../../src/main/jobs/naming'
import { createNodePersistenceIO } from '../../src/main/jobs/persistence'
import { createPlannerIO, createVolumeQueries } from '../../src/main/jobs/planner-io'
import { createProbeQueue } from '../../src/main/jobs/probe-queue'
import { createCompressRunner, PASSLOG_SHORT_DIR, passLogPrefix } from '../../src/main/jobs/runners/compress'
import { createConvertRunner, pathExists } from '../../src/main/jobs/runners/convert'
import { createExtractRunner, makeFrameFolder } from '../../src/main/jobs/runners/extract'
import { createBoostRunner, createNormalizeRunner } from '../../src/main/jobs/runners/audio'
import { containerLabel, sourceContainerLabel } from '../../src/shared/jobs/describe'
import { CONTAINER_ROWS } from '../../src/main/ffmpeg/audio/containers'
import { createVolumeRegistry } from '../../src/main/jobs/volumes'
import { createNodeWorkDirFiles } from '../../src/main/jobs/workdirs'
import { realTimers } from '../../src/main/timers'
import { createOracle, runTool } from './oracle'

const golden = inject('golden')
const runnable = !golden.skip && golden.meetsMinimum
const isWindows = process.platform === 'win32'

const SETTINGS: RunSettings =
{
  workers: { mode: 'fixed', count: 1 },
  gpuSessions: { mode: 'auto' },
  priority: 'normal',
  keepAwake: false,
  verifyVideo: 'full',
  notify: { completion: false, firstFailure: false },
  measureOnReview: false,
  includeSubfolders: false
}

const NEXT_TO_SOURCE: Omit<BatchPolicy, 'rev'> = { destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'off' }

/** A Convert recipe with x264 video, or none, and a chosen audio codec. */
function convert(container: string, audio: ConvertRecipe['audio'], video: ConvertRecipe['video'] = null): ConvertRecipe
{
  return { kind: 'convert', presetId: null, userPreset: null, container, video, audio, channels: 'keep', subtitles: 'keep' }
}

const X264: NonNullable<ConvertRecipe['video']> = { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p' }

/** The build's capabilities as the planner and runners see them. */
function buildCaps(): BuildCapabilities
{
  return { encoders: new Set(golden.encoders), experimental: new Set(golden.experimental), soxr: golden.soxr }
}

function capabilities(): CapabilitySummary
{
  return {
    rev: 1,
    ffmpeg: { ready: true, version: golden.versionString, source: 'custom', meetsMinimum: true, selfTest: 'passed', soxr: golden.soxr },
    encoders: [...golden.encoders],
    gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
    cpuCount: 4,
    platform: isWindows ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  }
}

async function sha256(file: string): Promise<string>
{
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** A logger that keeps every line, so a failure can print what the engine said. */
function memoryLog(lines: string[]): JobLogger
{
  const log: JobLogger = {
    debug: (m) => void lines.push(`debug ${m}`),
    info: (m) => void lines.push(`info ${m}`),
    warn: (m) => void lines.push(`warn ${m}`),
    error: (m) => void lines.push(`error ${m}`),
    ffmpeg: (m) => void lines.push(`ffmpeg ${m}`),
    child: () => log
  }
  return log
}

function quietSender(id: number): EventSender
{
  return {
    id,
    send: () => undefined,
    isDestroyed: () => false,
    onNavigate: () => () => undefined,
    onDestroyed: () => () => undefined
  }
}

interface HarnessOptions
{
  policy?: Omit<BatchPolicy, 'rev'>
  /** Runs before every FFmpeg spawn the engine makes, with its argv. */
  beforeRun?: (args: readonly string[]) => void | Promise<void>
  /** Wraps the Node file operations the engine uses. */
  fs?: (ops: FsOps) => FsOps
  workers?: number
}

interface Harness
{
  engine: JobEngine
  /** Every FFmpeg argv the engine ran, in order. */
  calls: string[][]
  lines: string[]
  root: string
  media: string
  trashDir: string
  /** Files the injected trash moved, as [from, to]. */
  trashed: Array<[string, string]>
  value<K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<JobCommandResponse<K>>
  send<K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<CommandResult<JobCommandResponse<K>>>
  add(paths: string[], recipe: Recipe): Promise<JobId[]>
  start(ids?: JobId[] | 'pending'): Promise<void>
  view(id: JobId): JobView
  waitFor(id: JobId, states: readonly JobState[], timeoutMs?: number): Promise<JobView>
  detail(id: JobId): Promise<JobDetail>
}

const SENDER = 7
const harnesses: Harness[] = []
let scratch = ''
/** A 30 s 720p MPEG-4 source, slow enough to x264 that a cancel lands mid-encode. */
let longSource = ''

function pause(ms: number): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Builds an engine over temp folders, the real exec and probe, Node file operations, and a trash folder. */
async function harness(options: HarnessOptions = {}, mediaName = 'media'): Promise<Harness>
{
  const root = await mkdtemp(join(scratch, 'h-'))
  const userData = join(root, 'userData')
  const media = join(root, mediaName)
  const trashDir = join(root, 'trash')
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(media, { recursive: true }), mkdir(trashDir, { recursive: true })])
  const platform = capabilities().platform
  const timers = realTimers
  const lines: string[] = []
  const log = memoryLog(lines)
  const calls: string[][] = []
  const trashed: Array<[string, string]> = []
  const real = createExec(golden.ffmpeg, { timers })
  const exec: Exec = {
    async run(args, o)
    {
      calls.push([...args])
      await options.beforeRun?.(args)
      return real.run(args, o)
    }
  }
  const caps = buildCaps()
  const volumes = createVolumeRegistry({ platform, queries: createVolumeQueries({ platform }), log: (m) => log.warn(m) })
  const probe = createProbe(golden.ffprobe)
  const probes = createProbeQueue({ probe, stat: (file) => stat(file), timers, platform })
  const buildId = (): string => golden.buildId
  const audioDeps = (parts: Parameters<Extract<EngineDeps['runners'], (...a: never[]) => unknown>>[0]): Parameters<typeof createNormalizeRunner>[0] => ({
    platform,
    buildId,
    exists: pathExists,
    remove: (file) => rm(file, { force: true }),
    size: async (file) => (await stat(file)).size,
    analyses: parts.analyses
  })
  let jobs: JobsConfig = {
    settings: { ...SETTINGS, workers: { mode: 'fixed', count: options.workers ?? 1 } },
    policy: { rev: 1, ...(options.policy ?? NEXT_TO_SOURCE) },
    defaultRecipe: convert('mkv', { kind: 'same-as-source' }),
    recentFolders: [],
    pendingAlerts: []
  }
  let tokens = 0
  const deps: EngineDeps = {
    timers,
    ids: { token: () => `${randomBytes(6).toString('hex')}${++tokens}`, preflightId: () => randomUUID() },
    platform,
    paths: { userData },
    runners: (parts) => ({
      normalize: createNormalizeRunner(audioDeps(parts)),
      boost: createBoostRunner(audioDeps(parts)),
      convert: createConvertRunner({ exists: pathExists, verifyVideo: () => 'full', platform }),
      compress: createCompressRunner({ exists: pathExists, verifyVideo: () => 'full', platform }),
      extract: createExtractRunner({ exists: pathExists, makeFolder: makeFrameFolder, verifyVideo: () => 'full', platform })
    }),
    planner: createPlannerIO({ platform, timers, volumes, log }),
    probe: probes,
    fs: options.fs ? options.fs(createFsOps({ platform, log })) : createFsOps({ platform, log }),
    trash: async (file) =>
    {
      const to = join(trashDir, `${trashed.length + 1}-${basename(file)}`)
      await rename(file, to)
      trashed.push([file, to])
    },
    store: createNodePersistenceIO(),
    host: {
      rendererLocation: () => ({ kind: 'dev', url: 'http://localhost:5173' }) as never,
      logUnexpected: (name, err) => log.error(`${name}: ${String(err)}`),
      sender: (id) => (id === SENDER ? quietSender(id) : null),
      mainWindow: () => ({ visible: true, focused: false }),
      showMainWindow: () => undefined,
      notify: () => undefined,
      setTaskbarProgress: () => undefined,
      setKeepAwake: () => undefined,
      setTrayStatus: () => undefined,
      askQuit: async () => 'keep-running',
      confirmCancelBatch: async () => true,
      quit: () => undefined
    },
    log,
    ffmpeg: { current: () => ({ exec, caps, rev: 1 }) },
    setPriority: () => undefined,
    volumes,
    config: {
      jobs,
      persist: async (change) =>
      {
        jobs = { ...jobs, ...change }
      }
    },
    capabilities: capabilities(),
    plannerCapabilities: () => ({ build: caps, minimumVersion: '5.1' }),
    audio: {
      analyze: async () =>
      {
        throw new Error('Previews are not measured here')
      },
      plan: () =>
      {
        throw new Error('Previews are not measured here')
      },
      albumPlan: () =>
      {
        throw new Error('Album groups are not measured here')
      }
    },
    shell: {
      showItemInFolder: () => undefined,
      readClipboard: () => ({ files: [], text: '' }),
      chooseSavePath: async () => null,
      exists: pathExists,
      readLog: async (file) => readFile(file, 'utf8').catch(() => null)
    },
    historyFs: createNodeHistoryFs(),
    workDirFiles: createNodeWorkDirFiles(),
    cores: 4,
    pid: process.pid,
    appVersion: '0.0.0-golden',
    stat: (file) => stat(file)
  }
  const engine = createJobEngine(deps)

  const send = <K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<CommandResult<JobCommandResponse<K>>> =>
    engine.command(name, req, { senderId: SENDER })

  const value = async <K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<JobCommandResponse<K>> =>
  {
    const result = await send(name, req)
    if (!result.ok)
    {
      throw new Error(`${name} refused: ${result.error.code} ${result.error.message}`)
    }
    return result.value
  }

  const view = (id: JobId): JobView =>
  {
    const found = engine.snapshot().jobs.find((job) => job.id === id)
    if (!found)
    {
      throw new Error(`No job ${id}`)
    }
    return found
  }

  const waitFor = async (id: JobId, states: readonly JobState[], timeoutMs = 120_000): Promise<JobView> =>
  {
    const until = Date.now() + timeoutMs
    for (;;)
    {
      const current = view(id)
      if (states.includes(current.state))
      {
        return current
      }
      if (Date.now() > until)
      {
        throw new Error(`Job ${id} stayed ${current.state} (waiting for ${states.join(', ')}):\n${lines.slice(-40).join('\n')}`)
      }
      await pause(20)
    }
  }

  const h: Harness = {
    engine, calls, lines, root, media, trashDir, trashed, value, send, view, waitFor,
    async add(paths, recipe)
    {
      const added = await value('add', { paths, recipe, origin: 'files', after: null, recursive: false, allowSecondJobs: true, force: true })
      for (const id of added.added)
      {
        const until = Date.now() + 30_000
        while (view(id).probe === null || view(id).media === null)
        {
          if (Date.now() > until || view(id).error !== null)
          {
            break
          }
          await pause(20)
        }
      }
      return added.added
    },
    async start(ids = 'pending')
    {
      const report = await value('preflight', { ids })
      const blocked = report.jobs.filter((j) => j.status !== 'ready')
      if (blocked.length > 0)
      {
        throw new Error(`Preflight blocked: ${blocked.map((j) => `${j.jobId} ${j.status} ${j.issues.map((i) => i.message).join('; ')}`).join(' | ')}`)
      }
      let started = await send('start', { preflightId: report.preflightId, ack: null, resume: false })
      if (!started.ok && started.error.code === 'confirmation-required' && started.error.details !== null && 'overwrites' in started.error.details)
      {
        started = await send('start', { preflightId: report.preflightId, ack: { ...started.error.details }, resume: false })
      }
      if (!started.ok)
      {
        throw new Error(`start refused: ${started.error.code} ${started.error.message}`)
      }
    },
    detail: (id) => value('get', { jobId: id })
  }
  await engine.init()
  await value('subscribe', { clientId: 'golden' })
  harnesses.push(h)
  return h
}

/** Copies a corpus file into a folder under a new name, so nothing in the corpus is touched. */
async function copyIn(name: string, folder: string, as: string = name): Promise<string>
{
  const from = golden.corpus[name]
  if (!from)
  {
    throw new Error(`${name} is not in the corpus`)
  }
  const to = join(folder, as)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  return to
}

/** Work folders left in a folder. */
async function workDirsIn(folder: string): Promise<string[]>
{
  return (await readdir(folder)).filter((name) => isWorkDirName(name))
}

/** Waits until a predicate holds, polling every 20 ms. */
async function until(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void>
{
  const end = Date.now() + timeoutMs
  while (!(await predicate()))
  {
    if (Date.now() > end)
    {
      throw new Error(`Timed out waiting for ${what}`)
    }
    await pause(20)
  }
}

/** Generates the long source once per run. */
async function makeLongSource(folder: string): Promise<string>
{
  const file = join(folder, 'long-source.mkv')
  const made = await runTool(golden.ffmpeg, [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'pcm_s16le', '-f', 'matroska', file
  ])
  if (made.code !== 0)
  {
    throw new Error(`Could not make the long source: ${made.stderr.slice(-400)}`)
  }
  return file
}

/** Makes an audio source in a codec no Convert codec writes, for the containers that only copy it. */
async function makeAudioSource(folder: string, name: string, codec: string): Promise<string>
{
  const file = join(folder, name)
  const made = await runTool(golden.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', golden.corpus['music4410.flac'], '-t', '5', '-c:a', codec, file])
  if (made.code !== 0)
  {
    throw new Error(`Could not make ${name}: ${made.stderr.slice(-400)}`)
  }
  return file
}

/** The demuxer ffprobe names for each muxer's output; MPEG audio layer II reads back through the mp3 demuxer. */
const DEMUXER: Readonly<Record<string, string>> =
{
  matroska: 'matroska', webm: 'webm', mp4: 'mp4', ipod: 'm4a', mov: 'mov', mpegts: 'mpegts', avi: 'avi', asf: 'asf', mp3: 'mp3', mp2: 'mp3',
  flac: 'flac', ogg: 'ogg', oga: 'ogg', opus: 'ogg', wav: 'wav', aiff: 'aiff', ac3: 'ac3', eac3: 'eac3', adts: 'aac', wv: 'wv', gif: 'gif'
}

type CaseCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'alac' | 'ac3' | 'eac3' | 'pcm' | 'wmav2'

/** The audio codec each container's case writes and the encoder it needs; null copies a source made in that codec. */
const AUDIO_OUT: Readonly<Record<string, { codec: CaseCodec | null; encoder: string }>> =
{
  mkv: { codec: 'aac', encoder: 'aac' }, mka: { codec: 'aac', encoder: 'aac' }, mp4: { codec: 'aac', encoder: 'aac' }, m4v: { codec: 'aac', encoder: 'aac' },
  mov: { codec: 'aac', encoder: 'aac' }, m4a: { codec: 'alac', encoder: 'alac' }, webm: { codec: 'opus', encoder: 'libopus' }, ts: { codec: 'aac', encoder: 'aac' },
  m2ts: { codec: 'ac3', encoder: 'ac3' }, mts: { codec: 'aac', encoder: 'aac' }, avi: { codec: 'mp3', encoder: 'libmp3lame' }, mp3: { codec: 'mp3', encoder: 'libmp3lame' },
  flac: { codec: 'flac', encoder: 'flac' }, ogg: { codec: 'vorbis', encoder: 'libvorbis' }, oga: { codec: 'opus', encoder: 'libopus' }, opus: { codec: 'opus', encoder: 'libopus' },
  wav: { codec: 'pcm', encoder: 'pcm_s16le' }, aiff: { codec: 'pcm', encoder: 'pcm_s16be' }, aif: { codec: 'pcm', encoder: 'pcm_s16be' }, ac3: { codec: 'ac3', encoder: 'ac3' },
  eac3: { codec: 'eac3', encoder: 'eac3' }, wma: { codec: 'wmav2', encoder: 'wmav2' }, asf: { codec: 'wmav2', encoder: 'wmav2' }, wmv: { codec: 'wmav2', encoder: 'wmav2' },
  aac: { codec: 'aac', encoder: 'aac' }, mp2: { codec: null, encoder: 'mp2' }, wv: { codec: null, encoder: 'wavpack' }, gif: { codec: null, encoder: 'gif' }
}

/** Holds a file open with FileShare.None in Windows PowerShell until `release` is called. */
async function holdLocked(file: string): Promise<{ release(): Promise<void> }>
{
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$f = [System.IO.File]::Open($env:MOLEX_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    '[Console]::Out.WriteLine("open")',
    '[Console]::Out.Flush()',
    '[void][Console]::In.ReadLine()',
    '$f.Close()'
  ].join('\n')
  const shell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, MOLEX_LOCK_FILE: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  await new Promise<void>((resolve, reject) =>
  {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) =>
    {
      out += chunk.toString()
      if (out.includes('open'))
      {
        resolve()
      }
    })
    void closed.then((code) => reject(new Error(`The lock holder exited ${code} before opening ${file}`)))
  })
  return {
    async release()
    {
      child.stdin.end('\n')
      await closed
    }
  }
}

/** The output argument of an FFmpeg argv: its last argument. */
function outputOf(args: readonly string[]): string
{
  return args[args.length - 1]
}

describe.skipIf(!runnable)('the job engine on real FFmpeg', () =>
{
  const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })

  beforeAll(async () =>
  {
    await mkdir(golden.outDir, { recursive: true })
    scratch = await mkdtemp(join(golden.outDir, 'engine-'))
    longSource = await makeLongSource(scratch)
  })

  afterEach(async () =>
  {
    for (const h of harnesses.splice(0))
    {
      await h.engine.shutdown('quit').catch(() => undefined)
    }
  })

  afterAll(async () =>
  {
    if (!golden.keep && scratch !== '')
    {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('converts a temp copy end to end, leaves the source byte-identical, and removes its work folder', async () =>
  {
    const h = await harness()
    const source = await copyIn('video_multi.mkv', h.media, 'clip.mkv')
    const before = await sha256(source)
    const [id] = await h.add([source], convert('mp4', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, X264))
    await h.start()
    const done = await h.waitFor(id, TERMINAL_STATES)
    expect(done.state, h.lines.slice(-30).join('\n')).toBe('done')
    const detail = await h.detail(id)
    const output = detail.result?.outputPath ?? ''
    expect(output).toBe(join(h.media, 'clip-convert.mp4'))
    expect(await sha256(source)).toBe(before)
    expect(await workDirsIn(h.media)).toEqual([])
    expect((await oracle.decodeCheck(output)).errors).toEqual([])
    const encode = h.calls.find((args) => outputOf(args).endsWith(PART_SUFFIX))
    expect(encode).toBeDefined()
    expect(isWorkDirName(basename(dirname(outputOf(encode ?? []))))).toBe(true)
    expect(encode?.[(encode?.lastIndexOf('-f') ?? 0) + 1]).toBe('mp4')
  })

  it('cancels mid-encode with no work folder left, no output, and the source byte-identical', async () =>
  {
    const h = await harness()
    const source = join(h.media, 'long.mkv')
    await copyFile(longSource, source)
    const before = await sha256(source)
    const [id] = await h.add([source], convert('mkv', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, X264))
    await h.start()
    await h.waitFor(id, ['encoding'])
    await until('encode progress', () => (h.view(id).progress?.percent ?? 0) > 0 || h.view(id).state !== 'encoding')
    expect(h.view(id).state).toBe('encoding')
    expect((await workDirsIn(h.media)).length).toBe(1)
    await h.value('cancel', { ids: [id] })
    const ended = await h.waitFor(id, TERMINAL_STATES)
    expect(ended.state).toBe('canceled')
    await until('the work folder to go', async () => (await workDirsIn(h.media)).length === 0, 20_000)
    expect(await readdir(h.media)).toEqual(['long.mkv'])
    expect(await sha256(source)).toBe(before)
  })

  it('cancels a two-pass encode in its second pass and removes the pass logs, beside the work folder or in the short folder', async () =>
  {
    const h = await harness()
    const source = join(h.media, 'long.mkv')
    await copyFile(longSource, source)
    const before = await sha256(source)
    const recipe: Recipe = {
      kind: 'compress', presetId: null, userPreset: null, target: { mode: 'size', targetBytes: 4_000_000, twoPass: true }, encoder: 'libx264', speed: 'medium',
      pixelFormat: 'yuv420p', tune: null, fit: null, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, container: 'mkv'
    }
    const [id] = await h.add([source], recipe)
    await h.start()
    await until('the second pass', () => (h.view(id).stage?.id === 'encode' && h.view(id).stage?.pass === 2) || TERMINAL_STATES.includes(h.view(id).state), 120_000)
    expect(h.view(id).state).toBe('encoding')
    const [work] = await workDirsIn(h.media)
    expect(work).toBeDefined()
    const passArgs = h.calls.find((args) => args.some((a) => a.startsWith('-passlogfile')))
    const passLog = passArgs?.[(passArgs?.findIndex((a) => a.startsWith('-passlogfile')) ?? 0) + 1] ?? ''
    expect(passLog).toBe(passLogPrefix(join(h.media, work), id, join(tmpdir(), PASSLOG_SHORT_DIR)))
    const logsOf = async (): Promise<string[]> => (await readdir(dirname(passLog)).catch(() => [] as string[])).filter((name) => name.startsWith(basename(passLog)))
    expect((await logsOf()).length).toBeGreaterThan(0)
    await h.value('cancel', { ids: [id] })
    expect((await h.waitFor(id, TERMINAL_STATES)).state).toBe('canceled')
    await until('the work folder to go', async () => (await workDirsIn(h.media)).length === 0, 20_000)
    expect(await readdir(h.media)).toEqual(['long.mkv'])
    expect(await logsOf()).toEqual([])
    expect((await readdir(process.cwd())).filter((name) => name.startsWith('ffmpeg2pass'))).toEqual([])
    expect(await sha256(source)).toBe(before)
  })

  it('writes frames into a folder whose path contains %', async () =>
  {
    const h = await harness({}, 'shots 50% %d %%')
    const source = await copyIn('video_multi.mkv', h.media, 'clip.mkv')
    const before = await sha256(source)
    const recipe: Recipe = { kind: 'extract', presetId: null, userPreset: null, mode: 'frames', sampling: { by: 'count', count: 4 }, format: 'png', jpgQuality: null, range: null }
    const [id] = await h.add([source], recipe)
    await h.start()
    const done = await h.waitFor(id, TERMINAL_STATES)
    expect(done.state, h.lines.slice(-30).join('\n')).toBe('done')
    const detail = await h.detail(id)
    expect(detail.result?.outputKind).toBe('folder')
    const folder = detail.result?.outputPath ?? ''
    expect(dirname(folder)).toBe(h.media)
    const frames = await readdir(folder)
    expect(frames).toHaveLength(4)
    expect(frames.every((name) => name.endsWith('.png') && !name.includes('%'))).toBe(true)
    for (const frame of frames)
    {
      expect((await oracle.probe(join(folder, frame))).streams[0]?.codec).toBe('png')
    }
    expect((await readdir(h.media)).sort()).toEqual([basename(folder), 'clip.mkv'].sort())
    expect(await sha256(source)).toBe(before)
  })

  it('replaces originals with the same and a new extension, moving each original into the trash', async () =>
  {
    const h = await harness({ policy: { ...NEXT_TO_SOURCE, destination: { mode: 'replace-originals' }, template: '{name}' } })
    const same = await copyIn('music4410.flac', h.media, 'same.flac')
    const other = await copyIn('loudmaster.wav', h.media, 'other.wav')
    const sameHash = await sha256(same)
    const otherHash = await sha256(other)
    const [a] = await h.add([same], convert('flac', { kind: 'codec', codec: 'flac', kbpsPerPair: null }))
    const [b] = await h.add([other], convert('mp3', { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }))
    await h.start()
    expect((await h.waitFor(a, TERMINAL_STATES)).state, h.lines.slice(-30).join('\n')).toBe('done')
    expect((await h.waitFor(b, TERMINAL_STATES)).state, h.lines.slice(-30).join('\n')).toBe('done')
    const [ra, rb] = [(await h.detail(a)).result, (await h.detail(b)).result]
    expect(ra?.outputPath).toBe(same)
    expect(ra?.placement.kind).toBe('replaced-original')
    expect(rb?.outputPath).toBe(join(h.media, 'other.mp3'))
    expect(rb?.placement.kind).toBe('replaced-original')
    expect((await readdir(h.media)).sort()).toEqual(['other.mp3', 'same.flac'])
    const displaced = displacedPath(same, 'original', 1, capabilities().platform)
    expect(h.trashed.map(([from]) => from).sort()).toEqual([other, displaced].sort())
    const inTrash = new Map(await Promise.all(h.trashed.map(async ([from, to]) => [from, await sha256(to)] as const)))
    expect(inTrash.get(displaced)).toBe(sameHash)
    expect(inTrash.get(other)).toBe(otherHash)
    expect((await oracle.decodeCheck(same)).errors).toEqual([])
    expect((await oracle.probe(join(h.media, 'other.mp3'))).format).toContain('mp3')
  })

  it('overwrites an existing output by trashing it, and keeps an original beside its replacement when told to', async () =>
  {
    const over = await harness({ policy: { ...NEXT_TO_SOURCE, conflict: 'overwrite' } })
    const source = await copyIn('music4410.flac', over.media, 'song.flac')
    const previous = await copyIn('brace.mp3', over.media, 'song-convert.mp3')
    const previousHash = await sha256(previous)
    const [id] = await over.add([source], convert('mp3', { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }))
    await over.start()
    expect((await over.waitFor(id, TERMINAL_STATES)).state, over.lines.slice(-30).join('\n')).toBe('done')
    const placed = (await over.detail(id)).result
    expect(placed?.outputPath).toBe(previous)
    expect(placed?.placement.kind).toBe('overwrote')
    expect(over.trashed).toHaveLength(1)
    expect(over.trashed[0][0]).toBe(displacedPath(previous, 'previous', 1, capabilities().platform))
    expect(await sha256(over.trashed[0][1])).toBe(previousHash)
    expect(await sha256(previous)).not.toBe(previousHash)

    const keep = await harness({ policy: { ...NEXT_TO_SOURCE, destination: { mode: 'replace-originals' }, template: '{name}', displaced: 'keep' } })
    const original = await copyIn('music4410.flac', keep.media, 'kept.flac')
    const originalHash = await sha256(original)
    const [k] = await keep.add([original], convert('flac', { kind: 'codec', codec: 'flac', kbpsPerPair: null }))
    await keep.start()
    expect((await keep.waitFor(k, TERMINAL_STATES)).state, keep.lines.slice(-30).join('\n')).toBe('done')
    expect(keep.trashed).toEqual([])
    const names = (await readdir(keep.media)).sort()
    expect(names).toHaveLength(2)
    const beside = names.find((name) => name !== 'kept.flac') ?? ''
    expect(await sha256(join(keep.media, beside))).toBe(originalHash)
    expect((await keep.detail(k)).result?.outputPath).toBe(original)
  })

  it('converts a source whose path is 316 characters long', async () =>
  {
    const h = await harness()
    const name = 'clip.mkv'
    let folder = h.media
    const target = 316 - name.length - 1
    while (folder.length < target)
    {
      const room = target - folder.length - 1
      folder = join(folder, 'deep-folder-segment-of-a-long-path'.slice(0, Math.min(34, room)).replace(/-$/, 'x'))
    }
    const source = join(folder, name)
    expect(source.length).toBe(316)
    await mkdir(folder, { recursive: true })
    await copyFile(golden.corpus['video_multi.mkv'], source)
    const before = await sha256(source)
    const [id] = await h.add([source], convert('mkv', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, X264))
    await h.start()
    const done = await h.waitFor(id, TERMINAL_STATES)
    expect(done.state, h.lines.slice(-30).join('\n')).toBe('done')
    const output = (await h.detail(id)).result?.outputPath ?? ''
    expect(output).toBe(join(folder, 'clip-convert.mkv'))
    expect((await oracle.decodeCheck(output)).errors).toEqual([])
    expect(await workDirsIn(folder)).toEqual([])
    expect(await sha256(source)).toBe(before)
  })

  it('writes .part outputs with -f that decode and probe as the planned container, for every container in the table', async () =>
  {
    const h = await harness({ workers: 3 })
    const video = await copyIn('video_multi.mkv', h.media, 'clip.mkv')
    const audio = await copyIn('music4410.flac', h.media, 'song.flac')
    const copies: Record<string, string> = { mp2: await makeAudioSource(h.media, 'layer2.mp2', 'mp2'), wv: await makeAudioSource(h.media, 'pack.wv', 'wavpack') }
    const containers = CONTAINER_ROWS.flatMap((row) => row.names.map((name) => ({ name, row })))
    const skipped: string[] = []
    const jobs: Array<{ id: JobId; name: string; muxer: string }> = []
    for (const { name, row } of containers)
    {
      const out = AUDIO_OUT[name]
      expect(out, `no case for ${name}`).toBeDefined()
      const needs = [out.encoder, ...(row.video && name !== 'gif' ? [name === 'webm' ? 'libvpx-vp9' : 'libx264'] : [])]
      if (needs.some((encoder) => !golden.encoders.includes(encoder)))
      {
        skipped.push(name)
        continue
      }
      let recipe: Recipe
      let source: string
      if (name === 'gif')
      {
        recipe = { kind: 'extract', presetId: null, userPreset: null, mode: 'gif', fps: 10, width: 160, dither: 'sierra2_4a', plays: 'infinite', range: { startSec: 0, durationSec: 2 } }
        source = video
      }
      else if (out.codec === null)
      {
        recipe = convert(name, { kind: 'same-as-source' })
        source = copies[name]
      }
      else
      {
        const lossless = out.codec === 'pcm' || out.codec === 'flac' || out.codec === 'alac'
        const picture = row.video ? (name === 'webm' ? { ...X264, encoder: 'libvpx-vp9' as const } : X264) : null
        recipe = { ...convert(name, { kind: 'codec', codec: out.codec, kbpsPerPair: lossless ? null : 192 }, picture), channels: 'stereo' }
        source = row.video ? video : audio
      }
      const [id] = await h.add([source], recipe)
      jobs.push({ id, name, muxer: row.muxer })
    }
    expect(skipped).toEqual([])
    await h.start()
    for (const job of jobs)
    {
      const ended = await h.waitFor(job.id, TERMINAL_STATES, 180_000)
      const detail = await h.detail(job.id)
      expect(ended.state, `${job.name}: ${detail.error?.message ?? ''} ${detail.stderrTail?.slice(-300) ?? ''}`).toBe('done')
      expect(detail.plan?.output.container, job.name).toBe(job.name)
      expect(detail.plan?.output.muxer, job.name).toBe(job.muxer)
      const part = partOutputName(1, job.name)
      const encode = h.calls.find((args) => basename(outputOf(args)) === part && args.includes(ended.source.path))
      expect(encode, `${job.name}: no FFmpeg run wrote ${part}`).toBeDefined()
      const args = encode ?? []
      expect(isWorkDirName(basename(dirname(outputOf(args)))), job.name).toBe(true)
      expect(args[args.lastIndexOf('-f') + 1], job.name).toBe(job.muxer)
      const output = detail.result?.outputPath ?? ''
      expect(output.endsWith(`.${job.name}`), output).toBe(true)
      if (job.name === 'gif')
      {
        const decoded = await runTool(golden.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', output, '-map', '0:v', '-f', 'null', '-'])
        expect([decoded.code, decoded.stderr.trim()], job.name).toEqual([0, ''])
      }
      else
      {
        expect((await oracle.decodeCheck(output)).errors, job.name).toEqual([])
      }
      const probed = await oracle.probe(output)
      expect(probed.format.split(','), `${job.name} probes as ${probed.format}`).toContain(DEMUXER[job.muxer])
      if (job.muxer !== 'mp2')
      {
        expect(sourceContainerLabel(probed.format, output), job.name).toBe(containerLabel(job.name))
      }
    }
    expect(await workDirsIn(h.media)).toEqual([])
  })

  it('catches an output planted in the work folder before FFmpeg is spawned, since -n exits 0 on newer builds', async () =>
  {
    const planted = partOutputName(1, 'mkv')
    let plantedAt = ''
    const h = await harness({
      fs: (ops) => ({
        ...ops,
        async mkdir(path)
        {
          await ops.mkdir(path)
          if (isWorkDirName(basename(path)))
          {
            plantedAt = join(path, planted)
            await writeFile(plantedAt, 'planted')
          }
        }
      })
    })
    const source = await copyIn('video_multi.mkv', h.media, 'clip.mkv')
    const before = await sha256(source)
    const [id] = await h.add([source], convert('mkv', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, X264))
    await h.start()
    const ended = await h.waitFor(id, TERMINAL_STATES)
    expect(plantedAt).not.toBe('')
    expect(ended.state).toBe('failed')
    expect(ended.error?.short).toBe('Work file exists')
    expect(ended.error?.message).toContain(plantedAt)
    expect(h.calls.some((args) => args.includes(plantedAt) || basename(outputOf(args)) === planted)).toBe(false)
    expect(await sha256(source)).toBe(before)
    expect((await readdir(h.media)).filter((name) => !isWorkDirName(name))).toEqual(['clip.mkv'])

    const existing = join(h.root, 'existing.mkv')
    await writeFile(existing, 'planted')
    const refused = await runTool(golden.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-f', 'lavfi', '-i', 'sine=duration=1', '-f', 'matroska', existing])
    expect(refused.stderr).toContain('already exists')
    expect(await readFile(existing, 'utf8')).toBe('planted')
    expect(refused.code).toBe(golden.versionString.startsWith('n9.') ? 0 : 1)
  })

  it.runIf(isWindows)('places over a file another process holds open without sharing once it closes', async () =>
  {
    const h = await harness({ policy: { ...NEXT_TO_SOURCE, conflict: 'overwrite' } })
    const source = await copyIn('music4410.flac', h.media, 'song.flac')
    const previous = await copyIn('brace.mp3', h.media, 'song-convert.mp3')
    const previousHash = await sha256(previous)
    const lock = await holdLocked(previous)
    let released = false
    try
    {
      const [id] = await h.add([source], convert('mp3', { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }))
      await h.start()
      await h.waitFor(id, ['finalizing', ...TERMINAL_STATES])
      await pause(1500)
      expect(h.view(id).state).toBe('finalizing')
      await lock.release()
      released = true
      const ended = await h.waitFor(id, TERMINAL_STATES)
      expect(ended.state, h.lines.slice(-30).join('\n')).toBe('done')
      expect((await h.detail(id)).result?.placement.kind).toBe('overwrote')
      expect(h.trashed).toHaveLength(1)
      expect(await sha256(h.trashed[0][1])).toBe(previousHash)
      expect(await sha256(previous)).not.toBe(previousHash)
      expect(await workDirsIn(h.media)).toEqual([])
    }
    finally
    {
      if (!released)
      {
        await lock.release()
      }
    }
  })
})
