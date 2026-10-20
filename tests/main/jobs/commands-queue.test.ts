import { describe, it, expect, vi } from 'vitest'
import { win32 } from 'node:path'
import {
  cleanPath,
  createQueueCommands,
  matrixRefusal,
  moreDestructive,
  RECENT_FOLDER_LIMIT,
  refusalMessage,
  textPaths,
  type ClipboardContent,
  type QueueCommandsDeps
} from '../../../src/main/jobs/commands/queue'
import { createEngineCore, type CoreJournal } from '../../../src/main/jobs/core'
import { createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { ProbeFailure, type ProbedSource } from '../../../src/main/jobs/probe-queue'
import { createScanner, type ScanDirent, type ScanFs, type ScanHandle } from '../../../src/main/jobs/scan'
import { Tombstones, RESTORE_EXPIRED_MESSAGE } from '../../../src/main/jobs/tombstones'
import type { FileStat, JobLogger } from '../../../src/main/jobs/deps'
import { applyPreset } from '../../../src/shared/jobs/presets'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { EncoderPolicy, MediaFacts } from '../../../src/shared/audio/types'
import type {
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  Job,
  JobPlan,
  MediaSummary,
  RecentFolder,
  RunSettings,
  WorkersState
} from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

function recipe(id = 'mp4-h264'): Recipe
{
  return applyPreset(id, OUTPUT) as Recipe
}

const SETTINGS: RunSettings =
{
  workers: { mode: 'auto' },
  gpuSessions: { mode: 'auto' },
  priority: 'below-normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: false,
  includeSubfolders: true
}

const CAPS: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: 'n9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true, surroundMeter: true },
  encoders: ['aac', 'libx264'],
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 8,
  platform: 'win32'
}

const WORKERS: WorkersState =
{
  setting: { mode: 'auto' },
  limits: { total: 4, videoCpu: 2, gpu: 0 },
  active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
}

const SUMMARY: MediaSummary =
{
  container: 'mov,mp4',
  durationSec: 10,
  video: null,
  audio: [{ codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 128, language: null, isDefault: true }],
  subtitles: 0,
  attachments: 0,
  chapters: 0,
  cover: false
}

function numbers(block: number): CatalogNumbers
{
  let next = 1
  const last = block
  return {
    available: () => Math.max(0, last - next + 1),
    take: () => (next <= last ? next++ : null)
  }
}

function silentLog(): JobLogger & { warnings: string[] }
{
  const warnings: string[] = []
  const none = (): void => undefined
  const log = { warnings, debug: none, info: none, warn: (message: string) => void warnings.push(message), error: none, ffmpeg: none, child: () => log }
  return log
}

function journal(): CoreJournal
{
  let n = 0
  return {
    append: () => ++n,
    appendDurable: (entries) => Promise.resolve(entries.map(() => ++n))
  } as CoreJournal
}

interface Node
{
  kind: 'file' | 'dir'
  path: string
  size: number
  mtimeMs: number
}

/** An in-memory win32 file system for stat and scans. */
function memoryFs()
{
  const nodes = new Map<string, Node>()
  const key = (path: string): string => win32.resolve(path).toLowerCase()
  function addDir(path: string): void
  {
    const parent = win32.dirname(path)
    if (parent !== path && !nodes.has(key(parent)))
    {
      addDir(parent)
    }
    nodes.set(key(path), { kind: 'dir', path, size: 0, mtimeMs: 0 })
  }
  function file(path: string, size = 1000, mtimeMs = 1_700_000_000_000): void
  {
    addDir(win32.dirname(path))
    nodes.set(key(path), { kind: 'file', path, size, mtimeMs })
  }
  function remove(path: string): void
  {
    nodes.delete(key(path))
  }
  async function stat(path: string): Promise<FileStat | null>
  {
    const node = nodes.get(key(path))
    if (node === undefined)
    {
      return null
    }
    return { size: node.size, mtimeMs: node.mtimeMs, isFile: node.kind === 'file', isDirectory: node.kind === 'dir', dev: '1', ino: '1' }
  }
  const scanFs: ScanFs =
  {
    async opendir(path)
    {
      const parent = key(path)
      if (!nodes.has(parent))
      {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
      const children: ScanDirent[] = [...nodes.values()]
        .filter((node) => key(win32.dirname(node.path)) === parent && key(node.path) !== parent)
        .map((node) => ({ name: win32.basename(node.path), isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir', isSymbolicLink: () => false }))
      return (async function* (): AsyncGenerator<ScanDirent>
      {
        yield* children
      })()
    },
    async stat(path)
    {
      const node = nodes.get(key(path))
      if (node === undefined)
      {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
      return { size: node.size, mtimeMs: node.mtimeMs, isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'dir' }
    }
  }
  return { file, addDir, remove, stat, scanFs, nodes }
}

function planOf(job: Readonly<Job>, resolution: JobPlan['output']['resolution'] = 'place'): JobPlan
{
  return {
    basis: { inputsRev: job.inputsRev, policyRev: 1, capabilitiesRev: 1 },
    fingerprint: `${job.source.path}-${resolution}`,
    source: { path: job.source.path, size: job.source.size, mtimeMs: job.source.mtimeMs },
    output: { kind: 'file', finalPath: `${job.source.path}.out.mp4`, container: 'mp4', muxer: 'mp4', containerChanged: null, conflict: 'none', resolution, renamedTo: null, displaces: null },
    streams: { kept: [], dropped: [], chapters: 'none' },
    video: null,
    audio: [],
    class: 'copy',
    stages: [],
    estimate: { outputBytes: null, reserveBytes: 0, workSec: null, confidence: 'low' },
    album: null,
    command: null
  }
}

interface SetupOptions
{
  policy?: BatchPolicy
  block?: number
  maxJobs?: number
  clipboard?: ClipboardContent | (() => ClipboardContent | Promise<ClipboardContent>)
  quitting?: boolean
  deps?: Partial<QueueCommandsDeps>
  recentFolders?: RecentFolder[]
}

const NEXT_TO_SOURCE: BatchPolicy = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

function setup(options: SetupOptions = {})
{
  const timers = createManualTimers(1_000)
  const log = silentLog()
  const bus = createJobEventBus({ timers, log })
  const emit = vi.spyOn(bus, 'emit')
  const queue = new JobQueue({ numbers: numbers(options.block ?? 1000), now: () => timers.now() })
  const core = createEngineCore({
    queue,
    bus,
    journal: journal(),
    log,
    now: () => timers.now(),
    state: {
      policy: options.policy ?? NEXT_TO_SOURCE,
      settings: SETTINGS,
      defaultRecipe: recipe(),
      capabilities: CAPS,
      workers: WORKERS,
      presets: { user: [], pins: {}, recent: [] },
      recentFolders: options.recentFolders ?? [],
      maxJobs: options.maxJobs
    },
    summarize: () => ({}) as BatchSummary
  })
  const fs = memoryFs()
  const tombstones = new Tombstones({ timers })
  const previous = new Set<string>()
  const probed: string[] = []
  const probeSource = vi.fn(async (path: string): Promise<ProbedSource> =>
  {
    probed.push(path)
    const stat = await fs.stat(path)
    if (stat === null)
    {
      throw new ProbeFailure('source-missing', `No file at ${path}`)
    }
    if (path.includes('notmedia'))
    {
      throw new ProbeFailure('not-media', 'The file is not a media file FFmpeg can read.')
    }
    return { path, size: stat.size, mtimeMs: stat.mtimeMs, facts: {} as MediaFacts, summary: SUMMARY }
  })
  const invalidate = vi.fn()
  const resolutions = new Map<string, JobPlan['output']['resolution'] | null>()
  const replan = vi.fn(async (job: Readonly<Job>): Promise<JobPlan | null> =>
  {
    const resolution = resolutions.get(job.source.path)
    return resolution === null ? null : planOf(job, resolution)
  })
  const handles: ScanHandle[] = []
  const persisted: RecentFolder[][] = []
  const recent: Recipe[][] = []
  const clipboard = options.clipboard ?? { files: [], text: '' }
  const commands = createQueueCommands({
    core,
    tombstones,
    probes: { probeSource, invalidate },
    replan,
    stat: fs.stat,
    platform: 'win32',
    isPreviousOutput: (file) => previous.has(`${file.path}|${file.size}|${file.mtimeMs}`),
    readClipboard: () => typeof clipboard === 'function' ? clipboard() : clipboard,
    scanFs: fs.scanFs,
    createScanner: (hooks) =>
    {
      const scanner = createScanner(hooks)
      return {
        ...scanner,
        start(root, scanOptions)
        {
          const handle = scanner.start(root, scanOptions)
          handles.push(handle)
          return handle
        }
      }
    },
    persistRecentFolders: (folders) =>
    {
      persisted.push(folders)
    },
    recordRecent: (recipes) =>
    {
      recent.push(recipes)
    },
    quitting: () => options.quitting === true,
    ...options.deps
  })
  const drafts = (): DraftEvent[] => emit.mock.calls.map((call) => call[0])
  const mark = (): number => emit.mock.calls.length
  const since = (from: number): DraftEvent[] => drafts().slice(from)
  const types = (from = 0): string[] => since(from).map((event) => event.type)
  const job = (id: JobId): Readonly<Job> => queue.get(id) as Readonly<Job>
  async function scansDone(): Promise<void>
  {
    await Promise.all(handles.map((handle) => handle.done))
    await commands.settled()
  }
  async function addFiles(...names: string[]): Promise<JobId[]>
  {
    for (const name of names)
    {
      fs.file(`C:\\media\\${name}`)
    }
    const result = await commands.add({ paths: names.map((name) => `C:\\media\\${name}`), recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false })
    await commands.settled()
    if (!result.ok)
    {
      throw new Error(result.error.message)
    }
    return result.value.added
  }
  return { core, queue, bus, log, timers, fs, tombstones, previous, probed, probeSource, invalidate, resolutions, replan, handles, persisted, recent, commands, drafts, mark, since, types, job, scansDone, addFiles }
}

function addReq(paths: string[], extra: Partial<Parameters<ReturnType<typeof createQueueCommands>['add']>[0]> = {})
{
  return { paths, recipe: null, origin: 'files' as const, after: null, recursive: false, allowSecondJobs: false, force: false, ...extra }
}

describe('path cleaning', () =>
{
  it('trims spaces and matching quotes from pasted paths', () =>
  {
    expect(cleanPath('  "C:\\media\\a b.mp4"  ')).toBe('C:\\media\\a b.mp4')
    expect(cleanPath('\'C:\\media\\a.mp4\'')).toBe('C:\\media\\a.mp4')
    expect(cleanPath('"C:\\media\\a.mp4')).toBe('"C:\\media\\a.mp4')
    expect(cleanPath('" "')).toBe('')
  })

  it('splits text into one path per line and drops blank lines', () =>
  {
    expect(textPaths('"C:\\a.mp4"\r\n\r\n  C:\\b.mp4 \n')).toEqual(['C:\\a.mp4', 'C:\\b.mp4'])
    expect(textPaths('   \n')).toEqual([])
  })
})

describe('jobs:add', () =>
{
  it('adds picked files as pending jobs with the default recipe and never queues them', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\notes.txt')
    const from = ctx.mark()
    const result = await ctx.commands.add(addReq(['C:\\media\\a.mp4', ' "C:\\media\\notes.txt" ']))
    await ctx.commands.settled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added).toHaveLength(2)
    expect(result.value.refused).toEqual([])
    expect(result.seq).toBeGreaterThan(0)
    for (const id of result.value.added)
    {
      expect(ctx.job(id).state).toBe('pending')
      expect(ctx.job(id).recipe).toEqual(recipe())
    }
    expect(ctx.types(from).filter((type) => type === 'job.added')).toHaveLength(2)
    expect(ctx.types(from)).not.toContain('job.state')
    expect(ctx.job(result.value.added[0]).source).toMatchObject({ name: 'a.mp4', ext: '.mp4', dir: 'C:\\media', origin: 'files', subdir: '' })
    expect(ctx.job(result.value.added[0]).probe).toBe('ok')
    expect(ctx.job(result.value.added[0]).media).toEqual(SUMMARY)
  })

  it('filters dropped files by the shared extension list and refuses missing and invalid paths', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\notes.txt')
    const result = await ctx.commands.add(addReq(['C:\\media\\a.mp4', 'C:\\media\\notes.txt', 'C:\\media\\gone.mp4', 'relative.mp4', '  ', 'C:\\media\\A.MP4'], { origin: 'drop' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added).toHaveLength(1)
    expect(result.value.refused.map((entry) => entry.code)).toEqual(['unsupported', 'source-not-found', 'invalid-path', 'invalid-path'])
    expect(ctx.job(result.value.added[0]).source.origin).toBe('drop')
  })

  it('counts a waiting path as a duplicate whatever its recipe, and adds it as a second job when asked', async () =>
  {
    const ctx = setup()
    const [first] = await ctx.addFiles('a.mp4')
    const again = await ctx.commands.add(addReq(['C:\\media\\a.mp4'], { recipe: recipe('mp3-320') }))
    expect(again.ok && again.value).toMatchObject({ added: [], duplicates: { paths: ['C:\\media\\a.mp4'], jobIds: [first] } })
    const second = await ctx.commands.add(addReq(['C:\\media\\a.mp4'], { allowSecondJobs: true }))
    expect(second.ok && second.value.added).toHaveLength(1)
    expect(ctx.queue.size).toBe(2)
  })

  it('skips a file that matches an earlier output unless forced', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\media\\a-out.mp4', 500, 42)
    ctx.previous.add('C:\\media\\a-out.mp4|500|42')
    const skipped = await ctx.commands.add(addReq(['C:\\media\\a-out.mp4']))
    expect(skipped.ok && skipped.value).toMatchObject({ added: [], previousOutputs: ['C:\\media\\a-out.mp4'] })
    const forced = await ctx.commands.add(addReq(['C:\\media\\a-out.mp4'], { force: true }))
    expect(forced.ok && forced.value.added).toHaveLength(1)
  })

  it('validates a given recipe and refuses an invalid one as a whole', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\media\\a.mp4')
    const bad = await ctx.commands.add(addReq(['C:\\media\\a.mp4'], { recipe: { op: 'nonsense' } as unknown as Recipe }))
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error.code).toBe('invalid-payload')
    const good = await ctx.commands.add(addReq(['C:\\media\\a.mp4'], { recipe: recipe('mp3-320') }))
    expect(good.ok && ctx.job(good.value.added[0]).recipe).toEqual(recipe('mp3-320'))
  })

  it('places new jobs after the given job', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    ctx.fs.file('C:\\media\\c.mp4')
    const result = await ctx.commands.add(addReq(['C:\\media\\c.mp4'], { after: a }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ctx.queue.order()).toEqual([a, result.value.added[0], b])
  })

  it('refuses while quitting, when the queue is full, and beyond its free places', async () =>
  {
    const quitting = setup({ quitting: true })
    expect(await quitting.commands.add(addReq(['C:\\media\\a.mp4']))).toMatchObject({ ok: false, error: { code: 'shutting-down' } })
    const ctx = setup({ maxJobs: 2 })
    await ctx.addFiles('a.mp4')
    ctx.fs.file('C:\\media\\b.mp4')
    ctx.fs.file('C:\\media\\c.mp4')
    const result = await ctx.commands.add(addReq(['C:\\media\\b.mp4', 'C:\\media\\c.mp4']))
    expect(result.ok && result.value.added).toHaveLength(1)
    expect(result.ok && result.value.refused).toEqual([{ path: 'C:\\media\\c.mp4', code: 'queue-full', message: 'The queue is full: C:\\media\\c.mp4' }])
    expect(await ctx.commands.add(addReq(['C:\\media\\c.mp4']))).toMatchObject({ ok: false, error: { code: 'queue-full' } })
  })

  it('refuses with io-error when no catalog number can be reserved', async () =>
  {
    const ctx = setup({ block: 1 })
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\b.mp4')
    expect(await ctx.commands.add(addReq(['C:\\media\\a.mp4', 'C:\\media\\b.mp4']))).toMatchObject({ ok: false, error: { code: 'io-error' } })
  })

  it('refuses a path that is neither a file nor a folder', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\media\\a.mp4')
    const node = ctx.fs.nodes.get('c:\\media\\a.mp4')
    if (node !== undefined) node.kind = 'other' as never
    const result = await ctx.commands.add(addReq(['C:\\media\\a.mp4']))
    expect(result.ok && result.value.refused.map((entry) => entry.code)).toEqual(['not-a-file'])
  })

  it('leaves a file that does not probe as media pending with a failed probe', async () =>
  {
    const ctx = setup()
    const [id] = await ctx.addFiles('notmedia.mp4')
    expect(ctx.job(id)).toMatchObject({ state: 'pending', probe: 'failed', media: null })
  })
})

describe('folder scans and recent folders', () =>
{
  it('scans a folder recursively only when asked, with subdirs, and records it as a recent folder', async () =>
  {
    const ctx = setup()
    ctx.fs.file('C:\\shows\\a.mp4')
    ctx.fs.file('C:\\shows\\notes.txt')
    ctx.fs.file('C:\\shows\\season 1\\b.mkv')
    const flat = await ctx.commands.add(addReq(['C:\\shows'], { origin: 'folder' }))
    expect(flat.ok && flat.value.scanIds).toHaveLength(1)
    await ctx.scansDone()
    expect(ctx.queue.jobs().map((job) => job.source.name)).toEqual(['a.mp4'])
    const deep = await ctx.commands.add(addReq(['C:\\shows'], { origin: 'folder', recursive: true }))
    await ctx.scansDone()
    expect(deep.ok).toBe(true)
    const names = ctx.queue.jobs().map((job) => [job.source.name, job.source.subdir, job.source.origin])
    expect(names).toEqual([['a.mp4', '', 'folder'], ['b.mkv', 'season 1', 'folder']])
    expect(ctx.types()).toContain('scan.progress')
    expect(ctx.types()).toContain('folders.changed')
    const folders = ctx.core.globals().recentFolders
    expect(folders).toEqual([{ path: 'C:\\shows', name: 'shows', files: 1, addedAt: 1_000 }])
    expect(ctx.persisted.at(-1)).toEqual(folders)
    expect(ctx.queue.jobs().every((job) => job.state === 'pending')).toBe(true)
  })

  it('counts waiting paths and earlier outputs inside a scan and adds them when asked', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    ctx.fs.file('C:\\media\\a-out.mp4', 7, 7)
    ctx.previous.add('C:\\media\\a-out.mp4|7|7')
    const first = await ctx.commands.add(addReq(['C:\\media'], { origin: 'folder' }))
    await ctx.scansDone()
    expect(first.ok).toBe(true)
    const scan = ctx.handles[0].state()
    expect(scan.excluded).toMatchObject({ duplicates: 1, previousOutputs: 1 })
    expect(ctx.queue.size).toBe(1)
    await ctx.commands.add(addReq(['C:\\media'], { origin: 'drop', allowSecondJobs: true, force: true, after: a }))
    await ctx.scansDone()
    expect(ctx.queue.jobs().map((job) => [job.source.name, job.source.origin])).toEqual([['a.mp4', 'files'], ['a.mp4', 'drop'], ['a-out.mp4', 'drop']])
  })

  it('excludes the destination folder inside the scanned tree', async () =>
  {
    const ctx = setup({ policy: { ...NEXT_TO_SOURCE, destination: { mode: 'folder', folder: 'C:\\shows\\out' } } })
    ctx.fs.file('C:\\shows\\a.mp4')
    ctx.fs.file('C:\\shows\\out\\a-converted.mp4')
    await ctx.commands.add(addReq(['C:\\shows'], { origin: 'folder', recursive: true }))
    await ctx.scansDone()
    expect(ctx.queue.jobs().map((job) => job.source.name)).toEqual(['a.mp4'])
    expect(ctx.handles[0].state().excluded.outputFolder).toBe(1)
  })

  it('keeps eight recent folders, newest first, and moves a folder added again to the front', async () =>
  {
    const ctx = setup()
    for (let n = 1; n <= RECENT_FOLDER_LIMIT + 1; n++)
    {
      ctx.fs.addDir(`C:\\f${n}`)
      await ctx.timers.advance(1)
      await ctx.commands.add(addReq([`C:\\f${n}`], { origin: 'folder' }))
    }
    await ctx.scansDone()
    let folders = ctx.core.globals().recentFolders
    expect(folders).toHaveLength(RECENT_FOLDER_LIMIT)
    expect(folders[0]).toMatchObject({ path: 'C:\\f9', name: 'f9', files: 0, addedAt: 1_009 })
    expect(folders.map((folder) => folder.path)).not.toContain('C:\\f1')
    await ctx.commands.add(addReq(['c:\\F5'], { origin: 'folder' }))
    await ctx.scansDone()
    folders = ctx.core.globals().recentFolders
    expect(folders[0].path).toBe('c:\\F5')
    expect(folders.filter((folder) => folder.path.toLowerCase() === 'c:\\f5')).toHaveLength(1)
  })

  it('forgets one folder and clears them all, emitting folders.changed only on a change', async () =>
  {
    const ctx = setup({ recentFolders: [{ path: 'C:\\a', name: 'a', files: 3, addedAt: 1 }, { path: 'C:\\b', name: 'b', files: 2, addedAt: 2 }] })
    let from = ctx.mark()
    expect(await ctx.commands.forgetFolder({ path: ' "c:\\A" ' })).toMatchObject({ ok: true, value: null })
    expect(ctx.core.globals().recentFolders.map((folder) => folder.path)).toEqual(['C:\\b'])
    expect(ctx.types(from)).toEqual(['folders.changed'])
    from = ctx.mark()
    await ctx.commands.forgetFolder({ path: 'C:\\unknown' })
    expect(ctx.types(from)).toEqual([])
    await ctx.commands.clearRecentFolders({})
    expect(ctx.core.globals().recentFolders).toEqual([])
    from = ctx.mark()
    await ctx.commands.clearRecentFolders({})
    expect(ctx.types(from)).toEqual([])
    await ctx.commands.settled()
    expect(ctx.persisted).toEqual([[{ path: 'C:\\b', name: 'b', files: 2, addedAt: 2 }], []])
  })

  it('cancels a running scan and refuses unknown and ended scans', async () =>
  {
    const ctx = setup()
    for (let n = 0; n < 600; n++)
    {
      ctx.fs.file(`C:\\big\\${n}.mp4`)
    }
    const result = await ctx.commands.add(addReq(['C:\\big'], { origin: 'folder' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [scanId] = result.value.scanIds
    expect(await ctx.commands.cancelScan({ scanId })).toMatchObject({ ok: true })
    await ctx.scansDone()
    expect(ctx.handles[0].state().status).toBe('canceled')
    expect(await ctx.commands.cancelScan({ scanId })).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(await ctx.commands.cancelScan({ scanId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('logs a scan chunk that finds no free catalog number and adds nothing', async () =>
  {
    const ctx = setup({ block: 1 })
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\b.mp4')
    await ctx.commands.add(addReq(['C:\\media'], { origin: 'folder' }))
    await ctx.scansDone()
    expect(ctx.queue.size).toBe(0)
    expect(ctx.log.warnings).toContain('No catalog number was free for 2 files of the scan of C:\\media')
  })

  it('builds its own scanner by default', async () =>
  {
    const ctx = setup({ deps: { createScanner: undefined } })
    ctx.fs.file('C:\\media\\a.mp4')
    const result = await ctx.commands.add(addReq(['C:\\media'], { origin: 'folder' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const scanId = result.value.scanIds[0]
    for (let turn = 0; turn < 50 && ctx.commands.scanner.get(scanId)?.status !== 'done'; turn++)
    {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await ctx.commands.settled()
    expect(ctx.commands.scanner.get(scanId)?.status).toBe('done')
    expect(ctx.queue.size).toBe(1)
  })
})

describe('jobs:pasteFiles', () =>
{
  it('adds the clipboard file list first', async () =>
  {
    const ctx = setup({ clipboard: { files: ['C:\\media\\a.mp4', ''], text: 'C:\\media\\b.mp4' } })
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\b.mp4')
    const result = await ctx.commands.pasteFiles({ recipe: null, recursive: false })
    expect(result.ok && result.value.source).toBe('file-list')
    expect(ctx.queue.jobs().map((job) => [job.source.name, job.source.origin])).toEqual([['a.mp4', 'files']])
  })

  it('falls back to text lines, quoted as Copy as path writes them', async () =>
  {
    const ctx = setup({ clipboard: async () => ({ files: [], text: '"C:\\media\\a.mp4"\r\n"C:\\media\\b.txt"\r\n' }) })
    ctx.fs.file('C:\\media\\a.mp4')
    ctx.fs.file('C:\\media\\b.txt')
    const result = await ctx.commands.pasteFiles({ recipe: null, recursive: false })
    expect(result.ok && result.value.source).toBe('text')
    expect(result.ok && result.value.added).toHaveLength(2)
  })

  it('reports an empty clipboard, and a clipboard that cannot be read, as empty', async () =>
  {
    const empty = setup({ clipboard: { files: [], text: '  \n' } })
    expect(await empty.commands.pasteFiles({ recipe: null, recursive: false })).toMatchObject({ ok: true, value: { source: 'empty', added: [] } })
    const broken = setup({ clipboard: () =>
    {
      throw new Error('no clipboard')
    } })
    expect(await broken.commands.pasteFiles({ recipe: null, recursive: false })).toMatchObject({ ok: true, value: { source: 'empty' } })
    expect(broken.log.warnings[0]).toContain('no clipboard')
  })

  it('passes a refused add through', async () =>
  {
    const ctx = setup({ clipboard: { files: ['C:\\media\\a.mp4'], text: '' }, quitting: true })
    expect(await ctx.commands.pasteFiles({ recipe: null, recursive: false })).toMatchObject({ ok: false, error: { code: 'shutting-down' } })
  })
})

const RESULT = { outputPath: 'C:\\media\\b-out.mp4', outputKind: 'file', container: 'mp4', inputBytes: 1000, outputBytes: 900, durationSec: 10, elapsedMs: 5, encoder: { video: null, audio: ['aac'] }, placement: {}, stamp: {}, warnings: [], notes: [] } as unknown as Job['result']

const WARNING = { code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'Placed outside the tolerance.' } as unknown as Job['warnings'][number]

type Ctx = ReturnType<typeof setup>

/** Puts a job straight into a state, for the matrix rows; the store takes the state as plain data. */
function put(ctx: Ctx, id: JobId, change: Partial<Job>): void
{
  ctx.queue.update(id, change as never)
}

describe('jobs:remove and jobs:restore', () =>
{
  it('round trips numbers, recipes, results, acknowledgments, and positions within the tombstone window', async () =>
  {
    const ctx = setup()
    const [a, b, c, d] = await ctx.addFiles('a.mp4', 'b.mp4', 'c.mp4', 'd.mp4')
    put(ctx, b, { state: 'done', result: RESULT, warnings: [WARNING], acknowledged: true, recipe: recipe('mp3-320') })
    const before = { b: structuredClone(ctx.job(b)), d: structuredClone(ctx.job(d)) }
    const from = ctx.mark()
    const removed = await ctx.commands.remove({ ids: [b, d, b] })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.value.applied).toEqual([b, d])
    expect(removed.value.refused).toEqual([])
    expect(removed.value.tombstone).not.toBeNull()
    expect(ctx.types(from).filter((type) => type === 'job.removed')).toHaveLength(2)
    expect(ctx.queue.order()).toEqual([a, c])
    await ctx.timers.advance(9 * 60 * 1000)
    const restored = await ctx.commands.restore({ tombstone: removed.value.tombstone as string })
    expect(restored).toMatchObject({ ok: true, value: { applied: [b, d], refused: [] } })
    expect(ctx.queue.order()).toEqual([a, b, c, d])
    expect(ctx.job(b)).toMatchObject({ id: b, state: 'done', result: RESULT, acknowledged: true, recipe: recipe('mp3-320'), warnings: [WARNING] })
    expect(ctx.job(b).seq).toBe(before.b.seq)
    expect(ctx.job(d).recipe).toEqual(before.d.recipe)
    expect(await ctx.commands.restore({ tombstone: removed.value.tombstone as string })).toEqual({ ok: false, error: { code: 'restore-expired', message: RESTORE_EXPIRED_MESSAGE, issues: [], details: null } })
  })

  it('refuses an expired or unknown tombstone with restore-expired', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    const removed = await ctx.commands.remove({ ids: [a] })
    await ctx.timers.advance(10 * 60 * 1000)
    expect(removed.ok && await ctx.commands.restore({ tombstone: removed.value.tombstone as string })).toMatchObject({ ok: false, error: { code: 'restore-expired' } })
    expect(await ctx.commands.restore({ tombstone: 'nope' })).toMatchObject({ ok: false, error: { code: 'restore-expired', message: RESTORE_EXPIRED_MESSAGE } })
  })

  it('names no tombstone when nothing was removed', async () =>
  {
    const ctx = setup()
    expect(await ctx.commands.remove({ ids: ['MM-9999' as JobId] })).toMatchObject({ ok: true, value: { applied: [], tombstone: null, refused: [{ jobId: 'MM-9999', code: 'not-found' }] } })
  })

  it('follows the matrix: refuses running, finalizing, held, and unacknowledged jobs that need attention', async () =>
  {
    const ctx = setup()
    const ids = await ctx.addFiles('1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4', '6.mp4', '7.mp4', '8.mp4', '9.mp4')
    const [pending, queued, encoding, finalizing, held, failed, warned, acknowledged, canceled] = ids
    put(ctx, queued, { state: 'queued' })
    put(ctx, encoding, { state: 'encoding' })
    put(ctx, finalizing, { state: 'finalizing' })
    put(ctx, held, { state: 'held' })
    put(ctx, failed, { state: 'failed' })
    put(ctx, warned, { state: 'done', warnings: [WARNING] })
    put(ctx, acknowledged, { state: 'failed', acknowledged: true })
    put(ctx, canceled, { state: 'canceled' })
    const result = await ctx.commands.remove({ ids })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([pending, queued, acknowledged, canceled])
    expect(result.value.refused.map((refusal) => [refusal.jobId, refusal.code])).toEqual([
      [encoding, 'job-running'], [finalizing, 'job-finalizing'], [held, 'job-held'], [failed, 'needs-attention'], [warned, 'needs-attention']
    ])
    expect(result.value.refused[3].message).toBe(`${failed} needs attention. Acknowledge it before removing it.`)
  })

  it('voids the dispatch claim of a removed queued job', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    put(ctx, a, { state: 'queued' })
    expect(ctx.core.claim(a)).toBe(true)
    await ctx.commands.remove({ ids: [a] })
    expect(ctx.core.isClaimed(a)).toBe(false)
  })

  it('refuses a restored job whose number is in the queue again as a duplicate', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    const tombstone = ctx.tombstones.record('remove', [{ job: structuredClone(ctx.job(a)) as Job, index: 0, after: null }]) as string
    expect(await ctx.commands.restore({ tombstone })).toMatchObject({ ok: true, value: { applied: [], refused: [{ jobId: a, code: 'duplicate', message: `${a} is already in the queue.` }] } })
  })

  it('plans restored pending jobs again when their plan is stale', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    put(ctx, b, { state: 'canceled' })
    const removed = await ctx.commands.remove({ ids: [a, b] })
    ctx.replan.mockClear()
    const restored = await ctx.commands.restore({ tombstone: (removed.ok && removed.value.tombstone) as string })
    expect(restored.ok).toBe(true)
    expect(ctx.replan).toHaveBeenCalledTimes(1)
    expect(ctx.job(a).plan?.basis.inputsRev).toBe(ctx.job(a).inputsRev)
    ctx.replan.mockClear()
    const again = await ctx.commands.remove({ ids: [a] })
    await ctx.commands.restore({ tombstone: (again.ok && again.value.tombstone) as string })
    expect(ctx.replan).not.toHaveBeenCalled()
  })
})

describe('jobs:reorder', () =>
{
  it('moves waiting jobs in their relative order before a job or to the end', async () =>
  {
    const ctx = setup()
    const [a, b, c, d] = await ctx.addFiles('a.mp4', 'b.mp4', 'c.mp4', 'd.mp4')
    put(ctx, c, { state: 'queued' })
    const from = ctx.mark()
    expect(await ctx.commands.reorder({ ids: [d, c], before: a })).toMatchObject({ ok: true, value: { applied: [c, d], refused: [] } })
    expect(ctx.queue.order()).toEqual([c, d, a, b])
    expect(ctx.types(from)).toContain('queue.order')
    await ctx.commands.reorder({ ids: [c], before: null })
    expect(ctx.queue.order()).toEqual([d, a, b, c])
  })

  it('refuses jobs that are not waiting and unknown jobs, and an unknown anchor', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    put(ctx, b, { state: 'done' })
    const result = await ctx.commands.reorder({ ids: [b, 'MM-9999' as JobId], before: a })
    expect(result).toMatchObject({ ok: true, value: { applied: [], refused: [{ jobId: b, code: 'not-movable' }, { jobId: 'MM-9999', code: 'not-found' }] } })
    expect(result.ok && result.value.refused[0].message).toBe(`${b} cannot be moved: only waiting jobs move.`)
    expect(await ctx.commands.reorder({ ids: [a], before: 'MM-9999' as JobId })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})

describe('jobs:assignRecipe', () =>
{
  it('sets a pending job\'s settings and clears its output with one update', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    put(ctx, a, { plan: planOf(ctx.job(a)) })
    const inputsRev = ctx.job(a).inputsRev
    const from = ctx.mark()
    const result = await ctx.commands.assignRecipe({ assignments: [{ jobId: a, recipe: recipe('mp3-320') }, { jobId: a, recipe: recipe() }] })
    expect(result).toMatchObject({ ok: true, value: { applied: [a], refused: [] } })
    expect(ctx.job(a)).toMatchObject({ state: 'pending', recipe: recipe('mp3-320'), plan: null, inputsRev: inputsRev + 1 })
    expect(ctx.types(from)).toEqual(['job.updated'])
    expect(ctx.recent).toEqual([[recipe('mp3-320')]])
    expect(ctx.replan).not.toHaveBeenCalled()
  })

  it('makes a queued job undispatchable in the command\'s turn, voids its claim, and plans it again in place', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    put(ctx, a, { state: 'queued', plan: planOf(ctx.job(a)) })
    expect(ctx.core.claim(a)).toBe(true)
    const inputsRev = ctx.job(a).inputsRev
    const pending = ctx.commands.assignRecipe({ assignments: [{ jobId: a, recipe: recipe('mp3-320') }] })
    expect(ctx.job(a).inputsRev).toBe(inputsRev + 1)
    expect(ctx.core.isClaimed(a)).toBe(false)
    expect(await pending).toMatchObject({ ok: true, value: { applied: [a] } })
    expect(ctx.job(a).state).toBe('queued')
    expect(ctx.job(a).plan?.basis.inputsRev).toBe(inputsRev + 1)
  })

  it('demotes a queued job when the new output is blocked or more destructive', async () =>
  {
    const ctx = setup()
    const [blocked, harsher, failing] = await ctx.addFiles('blocked.mp4', 'harsher.mp4', 'failing.mp4')
    for (const id of [blocked, harsher, failing])
    {
      put(ctx, id, { state: 'queued', plan: planOf(ctx.job(id)) })
    }
    ctx.resolutions.set('C:\\media\\blocked.mp4', null)
    ctx.resolutions.set('C:\\media\\harsher.mp4', 'replace-original')
    ctx.replan.mockImplementation(async (job) =>
    {
      if (job.source.name === 'failing.mp4')
      {
        throw new Error('planner offline')
      }
      const resolution = ctx.resolutions.get(job.source.path)
      return resolution === null ? null : planOf(job, resolution)
    })
    await ctx.commands.assignRecipe({ assignments: [blocked, harsher, failing].map((jobId) => ({ jobId, recipe: recipe('mp3-320') })) })
    expect(ctx.job(blocked)).toMatchObject({ state: 'pending', reason: 'plan-blocked', plan: null })
    expect(ctx.job(harsher)).toMatchObject({ state: 'pending', reason: 'destructive-scope' })
    expect(ctx.job(harsher).plan?.output.resolution).toBe('replace-original')
    expect(ctx.job(failing)).toMatchObject({ state: 'pending', reason: 'plan-blocked' })
    expect(ctx.log.warnings.some((line) => line.includes('planner offline'))).toBe(true)
  })

  it('leaves a queued job alone when it changed while it was planned again', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    put(ctx, a, { state: 'queued', plan: planOf(ctx.job(a)) })
    ctx.replan.mockImplementationOnce(async (job) =>
    {
      ctx.queue.update(a, { recipe: recipe() })
      return planOf(job, 'overwrite')
    })
    await ctx.commands.assignRecipe({ assignments: [{ jobId: a, recipe: recipe('mp3-320') }] })
    expect(ctx.job(a).state).toBe('queued')
    expect(ctx.job(a).plan?.output.resolution).toBe('place')
  })

  it('returns finished jobs to pending on a new attempt (T30), and refuses the rest by the matrix', async () =>
  {
    const ctx = setup()
    const ids = await ctx.addFiles('1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4', '6.mp4', '7.mp4')
    const [failed, placed, done, encoding, finalizing, held, canceled] = ids
    put(ctx, failed, { state: 'failed' })
    put(ctx, placed, { state: 'done', warnings: [WARNING] })
    put(ctx, done, { state: 'done' })
    put(ctx, encoding, { state: 'encoding' })
    put(ctx, finalizing, { state: 'finalizing' })
    put(ctx, held, { state: 'held' })
    put(ctx, canceled, { state: 'canceled' })
    const result = await ctx.commands.assignRecipe({ assignments: [...ids, 'MM-9999' as JobId].map((jobId) => ({ jobId, recipe: recipe('mp3-320') })) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([failed, placed, canceled])
    for (const id of result.value.applied)
    {
      expect(ctx.job(id)).toMatchObject({ state: 'pending', attempt: 2, recipe: recipe('mp3-320'), plan: null })
    }
    expect(result.value.refused.map((refusal) => [refusal.jobId, refusal.code])).toEqual([
      [done, 'job-terminal'], [encoding, 'job-running'], [finalizing, 'job-finalizing'], [held, 'job-held'], ['MM-9999', 'not-found']
    ])
    expect(result.value.refused[0].message).toBe(`${done} has finished. Use Duplicate instead.`)
    expect(result.value.refused[3].message).toBe(`${held} is waiting for a decision on its output.`)
  })

  it('refuses invalid settings per job and records nothing', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    const result = await ctx.commands.assignRecipe({ assignments: [{ jobId: a, recipe: { op: 'nonsense' } as unknown as Recipe }] })
    expect(result).toMatchObject({ ok: true, value: { applied: [], refused: [{ jobId: a, code: 'invalid-recipe', message: `The settings for ${a} are not valid.` }] } })
    expect(ctx.recent).toEqual([])
  })
})

describe('jobs:duplicate', () =>
{
  it('adds new pending jobs with new numbers right after their originals, in any state', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    put(ctx, b, { state: 'encoding', recipe: recipe('mp3-320') })
    ctx.probeSource.mockClear()
    const result = await ctx.commands.duplicate({ ids: [a, b, 'MM-9999' as JobId], recipe: null })
    await ctx.commands.settled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([a, b])
    expect(result.value.refused).toEqual([{ jobId: 'MM-9999', code: 'not-found', message: 'MM-9999 is not in the queue.' }])
    const [a2, b2] = result.value.created
    expect(ctx.queue.order()).toEqual([a, a2, b, b2])
    expect(new Set([a, b, a2, b2]).size).toBe(4)
    expect(ctx.job(a2)).toMatchObject({ state: 'pending', recipe: recipe(), probe: 'ok', media: SUMMARY, source: ctx.job(a).source })
    expect(ctx.job(b2)).toMatchObject({ state: 'pending', recipe: recipe('mp3-320') })
    expect(ctx.probeSource).not.toHaveBeenCalled()
    expect(ctx.recent).toEqual([])
  })

  it('applies the given settings, records them as recent, and probes an unprobed source', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('notmedia.mp4')
    const result = await ctx.commands.duplicate({ ids: [a], recipe: recipe('mp3-320') })
    await ctx.commands.settled()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ctx.job(result.value.created[0])).toMatchObject({ recipe: recipe('mp3-320'), probe: 'failed' })
    expect(ctx.recent).toEqual([[recipe('mp3-320')]])
  })

  it('refuses invalid settings, a full queue, and an exhausted catalog block', async () =>
  {
    const ctx = setup({ maxJobs: 3, block: 3 })
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    expect(await ctx.commands.duplicate({ ids: [a], recipe: { op: 'nonsense' } as unknown as Recipe })).toMatchObject({ ok: false, error: { code: 'invalid-payload', message: 'The settings are not valid.' } })
    expect(await ctx.commands.duplicate({ ids: [a, b], recipe: null })).toMatchObject({ ok: false, error: { code: 'queue-full' } })
    const tight = setup({ block: 2 })
    const [c] = await tight.addFiles('c.mp4')
    const first = await tight.commands.duplicate({ ids: [c], recipe: null })
    expect(first.ok && first.value.created).toHaveLength(1)
    expect(await tight.commands.duplicate({ ids: [c], recipe: null })).toMatchObject({ ok: true, value: { applied: [], created: [], refused: [{ jobId: c, code: 'blocked' }] } })
  })
})

describe('jobs:locate', () =>
{
  it('points a job at the new file, probes it, plans it again, and offers relinking the rest of the folder', async () =>
  {
    const ctx = setup()
    const [a, b, c, d] = await ctx.addFiles('a.mp4', 'b.mp4', 'c.mp4', 'd.mp4')
    put(ctx, d, { state: 'done' })
    ctx.fs.remove('C:\\media\\a.mp4')
    ctx.fs.remove('C:\\media\\b.mp4')
    ctx.fs.remove('C:\\media\\d.mp4')
    ctx.fs.file('C:\\moved\\a.mp4', 2000, 5)
    const inputsRev = ctx.job(a).inputsRev
    ctx.probeSource.mockClear()
    const result = await ctx.commands.locate({ jobId: a, path: ' "C:\\moved\\a.mp4" ' })
    expect(result).toEqual({
      ok: true,
      value: { applied: [a], refused: [], relinkable: { fromDir: 'C:\\media', toDir: 'C:\\moved', ids: [b] } },
      seq: expect.any(Number)
    })
    expect(ctx.job(a).source).toMatchObject({ path: 'C:\\moved\\a.mp4', dir: 'C:\\moved', size: 2000, mtimeMs: 5, origin: 'files' })
    expect(ctx.job(a).inputsRev).toBe(inputsRev + 1)
    expect(ctx.job(a)).toMatchObject({ probe: 'ok', media: SUMMARY })
    expect(ctx.job(a).plan?.basis.inputsRev).toBe(inputsRev + 1)
    expect(ctx.probeSource).toHaveBeenCalledWith('C:\\moved\\a.mp4')
    expect(c).toBeDefined()
  })

  it('offers nothing when the file stays in its folder or no other source is missing', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4', 'b.mp4')
    ctx.fs.file('C:\\media\\a2.mp4')
    expect(await ctx.commands.locate({ jobId: a, path: 'C:\\media\\a2.mp4' })).toMatchObject({ ok: true, value: { applied: [a], relinkable: null } })
    ctx.fs.file('C:\\moved\\a.mp4')
    expect(await ctx.commands.locate({ jobId: a, path: 'C:\\moved\\a.mp4' })).toMatchObject({ ok: true, value: { applied: [a], relinkable: null } })
  })

  it('refuses a missing file, a folder, a relative path, an unknown job, and jobs the matrix refuses', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    put(ctx, b, { state: 'failed' })
    ctx.fs.addDir('C:\\folder')
    for (const path of ['C:\\nowhere\\a.mp4', 'C:\\folder', 'a.mp4'])
    {
      expect(await ctx.commands.locate({ jobId: a, path })).toMatchObject({ ok: true, value: { applied: [], refused: [{ jobId: a, code: 'source-not-found' }], relinkable: null } })
    }
    expect(await ctx.commands.locate({ jobId: 'MM-9999' as JobId, path: 'C:\\media\\a.mp4' })).toMatchObject({ ok: true, value: { refused: [{ code: 'not-found' }] } })
    const terminal = await ctx.commands.locate({ jobId: b, path: 'C:\\media\\a.mp4' })
    expect(terminal).toMatchObject({ ok: true, value: { refused: [{ jobId: b, code: 'job-terminal' }] } })
    expect(terminal.ok && terminal.value.refused[0].message).toBe(`${b} has finished. Use Retry instead.`)
  })

  it('makes a located queued job undispatchable and plans it again in place', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    put(ctx, a, { state: 'queued', plan: planOf(ctx.job(a)) })
    ctx.fs.file('C:\\moved\\a.mp4')
    ctx.resolutions.set('C:\\moved\\a.mp4', 'overwrite')
    await ctx.commands.locate({ jobId: a, path: 'C:\\moved\\a.mp4' })
    expect(ctx.job(a)).toMatchObject({ state: 'pending', reason: 'destructive-scope' })
  })
})

describe('jobs:relink', () =>
{
  it('points every missing source under the old folder at the same relative path under the new one', async () =>
  {
    const ctx = setup()
    const [a, b, c] = await ctx.addFiles('a.mp4', 'b.mp4', 'c.mp4')
    ctx.fs.file('C:\\media\\sub\\d.mp4')
    const added = await ctx.commands.add(addReq(['C:\\media\\sub\\d.mp4']))
    const d = (added.ok && added.value.added[0]) as JobId
    await ctx.commands.settled()
    for (const name of ['a.mp4', 'b.mp4', 'sub\\d.mp4'])
    {
      ctx.fs.remove(`C:\\media\\${name}`)
    }
    ctx.fs.file('D:\\archive\\a.mp4')
    ctx.fs.file('D:\\archive\\sub\\d.mp4', 3000, 9)
    ctx.probeSource.mockClear()
    const result = await ctx.commands.relink({ fromDir: 'C:\\media', toDir: '"D:\\archive"', ids: 'missing' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([a, d])
    expect(result.value.refused).toEqual([{ jobId: b, code: 'source-not-found', message: 'No file was found at D:\\archive\\b.mp4.' }])
    expect(ctx.job(a).source.path).toBe('D:\\archive\\a.mp4')
    expect(ctx.job(d).source).toMatchObject({ path: 'D:\\archive\\sub\\d.mp4', dir: 'D:\\archive\\sub', size: 3000 })
    expect(ctx.job(c).source.path).toBe('C:\\media\\c.mp4')
    expect(ctx.probeSource.mock.calls.map((call) => call[0]).sort()).toEqual(['D:\\archive\\a.mp4', 'D:\\archive\\sub\\d.mp4'])
    expect(ctx.job(d).plan?.basis.inputsRev).toBe(ctx.job(d).inputsRev)
  })

  it('relinks the listed jobs whatever their sources, and refuses jobs outside the old folder', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    ctx.fs.file('C:\\other\\x.mp4')
    const added = await ctx.commands.add(addReq(['C:\\other\\x.mp4']))
    const x = (added.ok && added.value.added[0]) as JobId
    put(ctx, b, { state: 'encoding' })
    ctx.fs.file('E:\\copy\\a.mp4')
    const result = await ctx.commands.relink({ fromDir: 'C:\\media\\', toDir: 'E:\\copy', ids: [a, b, x, 'MM-9999' as JobId] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([a])
    expect(result.value.refused.map((refusal) => [refusal.jobId, refusal.code])).toEqual([[b, 'job-running'], ['MM-9999', 'not-found'], [x, 'source-not-found']])
    expect(result.value.refused[2].message).toBe(`The file of ${x} is not in C:\\media\\.`)
  })

  it('refuses folders that are not full paths', async () =>
  {
    const ctx = setup()
    expect(await ctx.commands.relink({ fromDir: 'media', toDir: 'E:\\copy', ids: 'missing' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } })
    expect(await ctx.commands.relink({ fromDir: 'C:\\media', toDir: '', ids: 'missing' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } })
  })

  it('refuses a job whose source moved while the targets were checked', async () =>
  {
    const ctx = setup()
    const [a] = await ctx.addFiles('a.mp4')
    ctx.fs.file('E:\\copy\\a.mp4')
    const result = ctx.commands.relink({ fromDir: 'C:\\media', toDir: 'E:\\copy', ids: [a] })
    ctx.queue.update(a, { source: { ...ctx.job(a).source, path: 'C:\\media\\renamed.mp4' } })
    expect(await result).toMatchObject({ ok: true, value: { applied: [], refused: [{ jobId: a, code: 'source-not-found' }] } })
  })
})

describe('jobs:reprobe', () =>
{
  it('probes waiting jobs again past the cache, records a changed file, and plans them again', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    put(ctx, b, { state: 'held' })
    ctx.fs.file('C:\\media\\a.mp4', 4321, 77)
    const inputsRev = ctx.job(a).inputsRev
    ctx.probeSource.mockClear()
    const result = await ctx.commands.reprobe({ ids: [a, b] })
    expect(result).toMatchObject({ ok: true, value: { applied: [a], refused: [{ jobId: b, code: 'job-held' }] } })
    expect(ctx.invalidate).toHaveBeenCalledWith('C:\\media\\a.mp4')
    expect(ctx.probeSource).toHaveBeenCalledTimes(1)
    expect(ctx.job(a).source).toMatchObject({ size: 4321, mtimeMs: 77 })
    expect(ctx.job(a).inputsRev).toBe(inputsRev + 2)
    expect(ctx.job(a)).toMatchObject({ probe: 'ok', media: SUMMARY })
    expect(ctx.job(a).plan?.basis.inputsRev).toBe(inputsRev + 2)
  })

  it('records a failed probe, ignores a canceled one, and leaves a job that changed meanwhile alone', async () =>
  {
    const ctx = setup()
    const [a, b, c, d] = await ctx.addFiles('a.mp4', 'b.mp4', 'c.mp4', 'd.mp4')
    ctx.fs.remove('C:\\media\\a.mp4')
    ctx.probeSource.mockImplementationOnce(async () =>
    {
      throw new ProbeFailure('source-missing', 'gone')
    })
    ctx.probeSource.mockImplementationOnce(async () =>
    {
      throw new ProbeFailure('canceled', 'canceled')
    })
    ctx.probeSource.mockImplementationOnce(async (path) =>
    {
      ctx.queue.update(c, { source: { ...ctx.job(c).source, path: 'C:\\media\\c2.mp4' } })
      return { path, size: 1, mtimeMs: 1, facts: {} as MediaFacts, summary: SUMMARY }
    })
    ctx.probeSource.mockImplementationOnce(async () =>
    {
      ctx.queue.update(d, { source: { ...ctx.job(d).source, path: 'C:\\media\\d2.mp4' } })
      throw new Error('ffprobe crashed')
    })
    await ctx.commands.reprobe({ ids: [a, b, c, d] })
    expect(ctx.job(a)).toMatchObject({ probe: 'failed', media: null })
    expect(ctx.job(b).probe).toBe('pending')
    expect(ctx.job(c).probe).toBe('pending')
    expect(ctx.job(d).probe).toBe('pending')
  })

  it('skips a job removed before its probe started or before its plan landed', async () =>
  {
    const ctx = setup()
    const [a, b] = await ctx.addFiles('a.mp4', 'b.mp4')
    ctx.probeSource.mockImplementationOnce(async (path) =>
    {
      await ctx.commands.remove({ ids: [a] })
      return { path, size: 1000, mtimeMs: 1_700_000_000_000, facts: {} as MediaFacts, summary: SUMMARY }
    })
    ctx.replan.mockImplementationOnce(async (job) =>
    {
      await ctx.commands.remove({ ids: [job.id] })
      return planOf(job)
    })
    expect(await ctx.commands.reprobe({ ids: [a, b] })).toMatchObject({ ok: true, value: { applied: [a, b] } })
    expect(ctx.queue.size).toBe(0)
    expect(ctx.replan).toHaveBeenCalledTimes(1)
  })
})

describe('refusal wording', () =>
{
  it('words every code the queue commands use and falls back for the rest', () =>
  {
    const id = 'MM-0001' as JobId
    expect(refusalMessage('job-running', null, id)).toBe('MM-0001 is running.')
    expect(refusalMessage('job-finalizing', null, id)).toBe('MM-0001 is being placed.')
    expect(refusalMessage('source-not-found', null, id)).toBe('No file was found for MM-0001.')
    expect(refusalMessage('not-queued', null, id)).toBe('MM-0001 cannot be changed while it is gone.')
    expect(refusalMessage('not-queued', { state: 'done' } as Job, id)).toBe('MM-0001 cannot be changed while it is done.')
  })

  it('names Discard output for a held job a cancel refuses', () =>
  {
    const job = { id: 'MM-0002', state: 'held', acknowledged: false, warnings: [], analysis: null } as unknown as Job
    expect(matrixRefusal('cancel', job, 'job-held')).toEqual({ jobId: 'MM-0002', code: 'job-held', message: 'MM-0002 is waiting for a decision on its output. Use Discard output instead.' })
  })

  it('ranks overwrites and replacements above placing a new file', () =>
  {
    const job = { source: { path: 'C:\\a.mp4', size: 1, mtimeMs: 1 }, inputsRev: 1 } as unknown as Job
    expect(moreDestructive(planOf(job, 'overwrite'), planOf(job, 'place'))).toBe(true)
    expect(moreDestructive(planOf(job, 'overwrite'), planOf(job, 'replace-original'))).toBe(false)
    expect(moreDestructive(planOf(job, 'rename'), null)).toBe(false)
    expect(moreDestructive(planOf(job, 'replace-original'), null)).toBe(true)
  })
})
