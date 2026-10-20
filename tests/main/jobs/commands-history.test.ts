import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHistoryCommands, pageLimit, recordTarget, type HistoryCommandsDeps } from '../../../src/main/jobs/commands/history'
import { createEngineCore, type CoreJournal } from '../../../src/main/jobs/core'
import { createJobEventBus } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { RUN_PAGE_LIMIT, RunHistory, buildBatchSummary, createNodeHistoryFs, type RunFacts } from '../../../src/main/jobs/history'
import { createNodePersistenceIO, jobsPaths, jsonLine } from '../../../src/main/jobs/persistence'
import type { FileStat, JobLogger } from '../../../src/main/jobs/deps'
import { applyPreset, presetLookup } from '../../../src/shared/jobs/presets'
import { formatCatalog, formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type {
  BatchPolicy, BatchSummary, CapabilitySummary, FrozenPolicy, HistoryRecord, Placement, RunSettings, WorkersState
} from '../../../src/shared/jobs/types'
import type { Platform } from '../../../src/shared/text/platform'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy
const PLATFORM: Platform = process.platform === 'win32' ? 'win32' : 'linux'
const RUN = formatRunId(31)
const OTHER = formatRunId(32)

function recipe(id = 'ebu-r128'): Recipe
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

const NEXT_TO_SOURCE = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' } as BatchPolicy

function numbers(block: number): CatalogNumbers
{
  let next = 1
  return {
    available: () => Math.max(0, block - next + 1),
    take: () => (next <= block ? next++ : null)
  }
}

function silentLog(): JobLogger
{
  const none = (): void => undefined
  const log: JobLogger = { debug: none, info: none, warn: none, error: none, ffmpeg: none, child: () => log }
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

function frozen(destination: BatchPolicy['destination']): FrozenPolicy
{
  return { ...NEXT_TO_SOURCE, destination, template: '{name}', frozenAt: 1, date: '2026-10-18' } as FrozenPolicy
}

async function statOf(path: string): Promise<FileStat | null>
{
  try
  {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile(), isDirectory: info.isDirectory() } as FileStat
  }
  catch
  {
    return null
  }
}

interface RecordOptions
{
  seq: number
  source: { path: string; size: number; mtimeMs: number }
  runId?: RunId
  state?: HistoryRecord['state']
  attempt?: number
  output?: HistoryRecord['output']
  placement?: Placement | null
  recipe?: Recipe
  logFile?: string | null
  attempts?: HistoryRecord['attempts']
}

function record(opts: RecordOptions): HistoryRecord
{
  const r = opts.recipe ?? recipe()
  return {
    type: 'record',
    schema: 1,
    runId: opts.runId ?? RUN,
    jobId: formatCatalog(opts.seq),
    attempt: opts.attempt ?? 1,
    op: r.kind,
    source: opts.source,
    recipe: r,
    recipeLabel: 'Normalize · EBU R 128',
    state: opts.state ?? 'done',
    startedAt: 1000,
    endedAt: 2000 + opts.seq,
    output: opts.output ?? null,
    placement: opts.placement ?? null,
    plan: null,
    measurement: null,
    verification: null,
    result: null,
    error: null,
    warnings: [],
    attempts: opts.attempts ?? [],
    rerunOf: null,
    logFile: opts.logFile ?? null
  }
}

const temps: string[] = []

afterEach(async () =>
{
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface SetupOptions
{
  block?: number
  maxJobs?: number
  quitting?: boolean
  deps?: Partial<HistoryCommandsDeps>
}

async function setup(options: SetupOptions = {})
{
  const tmp = await mkdtemp(join(tmpdir(), 'mm-history-'))
  temps.push(tmp)
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
      policy: NEXT_TO_SOURCE,
      settings: SETTINGS,
      defaultRecipe: recipe(),
      capabilities: CAPS,
      workers: WORKERS,
      presets: { user: [], pins: {}, recent: [] },
      recentFolders: [],
      maxJobs: options.maxJobs
    },
    summarize: () => ({}) as BatchSummary
  })
  const io = createNodePersistenceIO()
  const paths = jobsPaths(join(tmp, 'jobs'))
  let open: RunId | null = null
  const history = new RunHistory({
    io,
    fs: createNodeHistoryFs(),
    paths,
    store: {
      appendLines: async (path, values) =>
      {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, values.map((value) => jsonLine(value)).join(''))
      }
    },
    openRun: () => open
  })
  await history.load()
  const probe = vi.fn()
  const showItemInFolder = vi.fn()
  const chooseSavePath = vi.fn(async (defaultPath: string) => defaultPath as string | null)
  const commands = createHistoryCommands({
    core,
    history,
    paths,
    platform: PLATFORM,
    stat: statOf,
    presetLookup: () => presetLookup(),
    chooseSavePath,
    probe,
    showItemInFolder,
    quitting: () => options.quitting === true,
    now: () => 9_000,
    ...options.deps
  })

  async function file(name: string, bytes = 1000): Promise<{ path: string; size: number; mtimeMs: number }>
  {
    const path = join(tmp, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.alloc(bytes, 1))
    const info = await stat(path)
    return { path, size: info.size, mtimeMs: info.mtimeMs }
  }

  async function writeRun(runId: RunId, records: HistoryRecord[], policy: FrozenPolicy | null = frozen({ mode: 'next-to-source' })): Promise<void>
  {
    open = runId
    await history.startRun(runId, 1000)
    for (const entry of records)
    {
      await history.appendRecord(entry)
    }
    if (policy !== null)
    {
      const facts: RunFacts = { runId, startedAt: 1000, endedAt: 61000, endedBy: 'completed', interruptions: 0, policy, ffmpeg: { version: '9.0.2', source: 'bundled' }, appVersion: '5.0.0' }
      await history.completeRun(buildBatchSummary(facts, records))
      open = null
    }
  }

  return { tmp, core, queue, emit, history, paths, commands, probe, showItemInFolder, chooseSavePath, file, writeRun, setOpen: (runId: RunId | null) => (open = runId) }
}

function errorOf(result: { ok: boolean; error?: { code: string; message: string } }): { code: string; message: string }
{
  if (result.ok || !result.error)
  {
    throw new Error('expected a refusal')
  }
  return result.error
}

describe('pageLimit', () =>
{
  it('keeps a page within 1 and the reply limit', () =>
  {
    expect(pageLimit(0)).toBe(1)
    expect(pageLimit(12.7)).toBe(12)
    expect(pageLimit(100_000)).toBe(RUN_PAGE_LIMIT)
    expect(pageLimit(Number.NaN)).toBe(RUN_PAGE_LIMIT)
  })
})

describe('rerun', () =>
{
  async function threeRecords(ctx: Awaited<ReturnType<typeof setup>>)
  {
    const kept = await ctx.file('Audio/kept.wav')
    const gone = await ctx.file('Audio/gone.wav')
    const replaced = await ctx.file('Audio/replaced.m4a', 1000)
    const failed = await ctx.file('Audio/failed.wav')
    const records = [
      record({ seq: 131, source: kept, output: { path: join(ctx.tmp, 'Audio/kept-normalize.wav'), bytes: 900, container: 'wav' } }),
      record({ seq: 132, source: gone }),
      record({ seq: 133, source: { ...replaced, size: 2000 }, recipe: recipe('spotify'), output: { path: replaced.path, bytes: 1000, container: 'm4a' }, placement: { kind: 'replaced-original', original: { status: 'trashed' } } }),
      record({ seq: 134, source: failed, state: 'failed' })
    ]
    await ctx.writeRun(RUN, records)
    await unlink(gone.path)
    return { kept, gone, replaced, failed, records }
  }

  it('adds pending jobs with new numbers, the recorded sources and recipes, and rerunOf', async () =>
  {
    const ctx = await setup()
    const { kept, gone, replaced, failed, records } = await threeRecords(ctx)
    const result = await ctx.commands.rerun({ runId: RUN, jobIds: 'all', force: false })
    expect(result.ok).toBe(true)
    if (!result.ok)
    {
      return
    }
    expect(result.value.added).toHaveLength(2)
    const jobs = result.value.added.map((id) => ctx.queue.get(id)!)
    expect(jobs.map((job) => job.state)).toEqual(['pending', 'pending'])
    expect(jobs.map((job) => job.source.path)).toEqual([kept.path, failed.path])
    expect(jobs[0].source).toMatchObject({ size: kept.size, mtimeMs: kept.mtimeMs, origin: 'files', subdir: '', name: 'kept.wav', ext: '.wav' })
    expect(jobs.map((job) => job.recipe)).toEqual([records[0].recipe, records[3].recipe])
    expect(jobs.map((job) => job.rerunOf)).toEqual([{ runId: RUN, jobId: records[0].jobId }, { runId: RUN, jobId: records[3].jobId }])
    expect(result.value.added.every((id) => !records.some((r) => r.jobId === id))).toBe(true)
    expect(new Set(result.value.added).size).toBe(2)
    expect(result.value.missing).toEqual([{ jobId: records[1].jobId, path: gone.path }])
    expect(result.value.holdsOutput).toEqual([{ jobId: records[2].jobId, path: replaced.path, originalTrashed: true }])
    expect(ctx.probe).toHaveBeenCalledWith(result.value.added)
    expect(ctx.emit.mock.calls.filter(([event]) => event.type === 'job.added')).toHaveLength(2)
    expect(result.seq).toBeGreaterThan(0)
  })

  it('adds a source that holds its own output only with force', async () =>
  {
    const ctx = await setup()
    const { replaced, records } = await threeRecords(ctx)
    const result = await ctx.commands.rerun({ runId: RUN, jobIds: [records[2].jobId], force: true })
    expect(result.ok && result.value.holdsOutput).toEqual([])
    const id = result.ok ? result.value.added[0] : null
    expect(ctx.queue.get(id as JobId)?.source.path).toBe(replaced.path)
    expect(ctx.queue.get(id as JobId)?.recipe).toEqual(recipe('spotify'))
  })

  it('reruns only the returned jobs', async () =>
  {
    const ctx = await setup()
    const { failed } = await threeRecords(ctx)
    const result = await ctx.commands.rerun({ runId: RUN, jobIds: 'returned', force: false })
    expect(result.ok && result.value.added.map((id) => ctx.queue.get(id)?.source.path)).toEqual([failed.path])
  })

  it('reports a source that disappears before it is added as missing', async () =>
  {
    const ctx = await setup({ deps: { stat: async () => null } })
    const { kept, records } = await threeRecords(ctx)
    const result = await ctx.commands.rerun({ runId: RUN, jobIds: [records[0].jobId], force: false })
    expect(result.ok && result.value).toEqual({ added: [], missing: [{ jobId: records[0].jobId, path: kept.path }], holdsOutput: [] })
    expect(ctx.probe).not.toHaveBeenCalled()
  })

  it('refuses while quitting, for an unknown run, and for a bad job list', async () =>
  {
    const quitting = await setup({ quitting: true })
    expect(errorOf(await quitting.commands.rerun({ runId: RUN, jobIds: 'all', force: false })).code).toBe('shutting-down')
    const ctx = await setup()
    const unknown = errorOf(await ctx.commands.rerun({ runId: OTHER, jobIds: 'all', force: false }))
    expect(unknown).toMatchObject({ code: 'not-found', message: 'Batch 32 is no longer in history.' })
    expect(errorOf(await ctx.commands.rerun({ runId: 'x' as RunId, jobIds: 'all', force: false })).code).toBe('invalid-payload')
    await threeRecords(ctx)
    expect(errorOf(await ctx.commands.rerun({ runId: RUN, jobIds: ['nope' as JobId], force: false })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.rerun({ runId: RUN, jobIds: 'some' as 'all', force: false })).code).toBe('invalid-payload')
  })

  it('refuses when the queue has no room or no catalog number is free', async () =>
  {
    const full = await setup({ maxJobs: 1 })
    await threeRecords(full)
    expect(errorOf(await full.commands.rerun({ runId: RUN, jobIds: 'all', force: false })).code).toBe('queue-full')
    const blocked = await setup({ block: 0 })
    await threeRecords(blocked)
    expect(errorOf(await blocked.commands.rerun({ runId: RUN, jobIds: 'all', force: false })).code).toBe('io-error')
  })
})

describe('exportReport', () =>
{
  it('writes CSV through the save dialog at the destination folder with the batch name', async () =>
  {
    const ctx = await setup()
    const exports = join(ctx.tmp, 'Exports')
    await mkdir(exports)
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source })], frozen({ mode: 'folder', folder: exports }))
    const origin = { senderId: 7 }
    const result = await ctx.commands.exportReport({ scope: { runId: RUN }, format: 'csv' }, origin)
    const expected = join(exports, 'molexMedia Batch 31 report.csv')
    expect(ctx.chooseSavePath).toHaveBeenCalledWith(expected, origin)
    expect(result.ok ? result.value : result.error).toEqual({ path: expected })
    const text = await readFile(expected, 'utf8')
    expect(text.split(/\r?\n/)[0]).toContain(',')
    expect(text).toContain('a.wav')
  })

  it('writes JSON in the first source folder of a next-to-source batch', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source })])
    const result = await ctx.commands.exportReport({ scope: { runId: RUN }, format: 'json' })
    const expected = join(ctx.tmp, 'Audio', 'molexMedia Batch 31 report.json')
    expect(ctx.chooseSavePath).toHaveBeenCalledWith(expected, { senderId: null })
    expect(result.ok ? result.value : result.error).toEqual({ path: expected })
    const parsed = JSON.parse(await readFile(expected, 'utf8'))
    expect(JSON.stringify(parsed)).toContain(formatCatalog(131))
  })

  it('reports jobs by number and refuses jobs that have not finished', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source })])
    const written = await ctx.commands.exportReport({ scope: { ids: [formatCatalog(131)] }, format: 'csv' })
    expect(written.ok ? written.value : written.error).toEqual({ path: join(ctx.tmp, 'Audio', 'molexMedia Batch 31 report.csv') })
    expect(errorOf(await ctx.commands.exportReport({ scope: { ids: [formatCatalog(500)] }, format: 'csv' })).code).toBe('not-found')
  })

  it('replies canceled when the dialog is closed', async () =>
  {
    const ctx = await setup({ deps: { chooseSavePath: async () => null } })
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source })])
    const result = await ctx.commands.exportReport({ scope: { runId: RUN }, format: 'csv' })
    expect(result.ok && result.value).toEqual({ canceled: true })
  })

  it('refuses a bad format, scope, or run, and reports a failed write', async () =>
  {
    const ctx = await setup()
    expect(errorOf(await ctx.commands.exportReport({ scope: { runId: RUN }, format: 'xml' as 'csv' })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.exportReport({ scope: null as unknown as { runId: RunId }, format: 'csv' })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.exportReport({ scope: { ids: [] }, format: 'csv' })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.exportReport({ scope: { runId: RUN }, format: 'csv' })).code).toBe('not-found')
    const failing = await setup({ deps: { chooseSavePath: async () => { throw new Error('dialog failed') } } })
    const source = await failing.file('Audio/a.wav')
    await failing.writeRun(RUN, [record({ seq: 131, source })])
    const error = errorOf(await failing.commands.exportReport({ scope: { runId: RUN }, format: 'csv' }))
    expect(error).toMatchObject({ code: 'io-error' })
    expect(error.message).toContain('dialog failed')
  })
})

describe('listRuns, getRun, and searchRuns', () =>
{
  async function twoRuns()
  {
    const ctx = await setup()
    const a = await ctx.file('Audio/interview.wav')
    const b = await ctx.file('Audio/music.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source: a }), record({ seq: 132, source: b })])
    await ctx.writeRun(OTHER, [record({ seq: 133, runId: OTHER, source: b })])
    return ctx
  }

  it('lists runs newest first in pages with the storage usage', async () =>
  {
    const ctx = await twoRuns()
    const first = await ctx.commands.listRuns({ before: null, limit: 0 })
    expect(first.ok && first.value.runs.map((run) => run.runId)).toEqual([OTHER])
    expect(first.ok && first.value.more).toBe(true)
    expect(first.ok && first.value.usage.runs).toBe(2)
    const next = await ctx.commands.listRuns({ before: OTHER, limit: 50 })
    expect(next.ok && next.value.runs.map((run) => run.runId)).toEqual([RUN])
    expect(errorOf(await ctx.commands.listRuns({ before: 'R-x' as RunId, limit: 5 })).code).toBe('invalid-payload')
  })

  it('reads one run in pages and refuses unknown runs and bad offsets', async () =>
  {
    const ctx = await twoRuns()
    const page = await ctx.commands.getRun({ runId: RUN, offset: 1, limit: 10 })
    expect(page.ok && page.value.total).toBe(2)
    expect(page.ok && page.value.records.map((r) => r.jobId)).toEqual([formatCatalog(132)])
    expect(page.ok && page.value.summary).not.toBeNull()
    expect(errorOf(await ctx.commands.getRun({ runId: formatRunId(40), offset: 0, limit: 10 })).message).toBe('Batch 40 is no longer in history.')
    expect(errorOf(await ctx.commands.getRun({ runId: RUN, offset: -1, limit: 10 })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.getRun({ runId: RUN, offset: 0.5, limit: 10 })).code).toBe('invalid-payload')
  })

  it('searches kept runs by file name and refuses bad pages', async () =>
  {
    const ctx = await twoRuns()
    const found = await ctx.commands.searchRuns({ query: '  interview ', limit: 10, before: null })
    expect(found.ok && found.value.matches.map((m) => [m.runId, m.jobId])).toEqual([[RUN, formatCatalog(131)]])
    expect(errorOf(await ctx.commands.searchRuns({ query: 3 as unknown as string, limit: 10, before: null })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.searchRuns({ query: 'a', limit: 10, before: { runId: RUN, jobId: 'x' as JobId } })).code).toBe('invalid-payload')
    const paged = await ctx.commands.searchRuns({ query: 'music', limit: 10, before: { runId: OTHER, jobId: formatCatalog(133) } })
    expect(paged.ok && paged.value.matches.map((m) => m.jobId)).toEqual([formatCatalog(132)])
  })
})

describe('deleteRuns', () =>
{
  it('deletes named runs and leaves outputs on disk', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    const output = await ctx.file('Audio/a-normalize.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source, output: { path: output.path, bytes: output.size, container: 'wav' } })])
    await ctx.writeRun(OTHER, [record({ seq: 132, runId: OTHER, source })])
    const result = await ctx.commands.deleteRuns({ runIds: [RUN] })
    expect(result.ok && result.value).toEqual({ deleted: 1 })
    expect(ctx.history.entries().map((entry) => entry.runId)).toEqual([OTHER])
    expect(await statOf(output.path)).not.toBeNull()
  })

  it('clears every run but the open one', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [record({ seq: 131, source })])
    await ctx.writeRun(OTHER, [record({ seq: 132, runId: OTHER, source })], null)
    const result = await ctx.commands.deleteRuns({ runIds: 'all' })
    expect(result.ok && result.value).toEqual({ deleted: 1 })
    expect(ctx.history.entries().map((entry) => entry.runId)).toEqual([OTHER])
  })

  it('refuses the open run and bad ids, and reports a failed delete', async () =>
  {
    const ctx = await setup()
    const open = await setup({ deps: { core: { ...ctx.core, run: () => ({ ...ctx.core.run(), status: 'running', runId: OTHER }) } } })
    const refused = errorOf(await open.commands.deleteRuns({ runIds: [RUN, OTHER] }))
    expect(refused).toMatchObject({ code: 'invalid-state' })
    expect(refused.message).toContain('Batch 32 is still open')
    expect(errorOf(await ctx.commands.deleteRuns({ runIds: ['R-1' as RunId] })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.deleteRuns({ runIds: 'some' as 'all' })).code).toBe('invalid-payload')
    const idle = await setup({ deps: { core: { ...ctx.core, run: () => ({ ...ctx.core.run(), status: 'idle', runId: OTHER }) } } })
    expect((await idle.commands.deleteRuns({ runIds: [OTHER] })).ok).toBe(true)
    const failing = await setup({ deps: { history: { ...ctx.history, entries: () => [], delete: async () => { throw new Error('locked') } } as unknown as HistoryCommandsDeps['history'] } })
    const error = errorOf(await failing.commands.deleteRuns({ runIds: 'all' }))
    expect(error).toMatchObject({ code: 'io-error' })
    expect(error.message).toContain('locked')
  })
})

describe('revealRecord', () =>
{
  it('shows the source, output, held output, kept original, and attempt logs of a record', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    const output = await ctx.file('Audio/a-normalize.wav')
    const held = await ctx.file('Work/b.wav')
    const kept = await ctx.file('Audio/c.original.wav')
    const log = await ctx.file('logs/c.log')
    const earlier = ctx.paths.attemptLog(RUN, formatCatalog(133), 1)
    await mkdir(dirname(earlier), { recursive: true })
    await writeFile(earlier, 'ffmpeg output')
    await ctx.writeRun(RUN, [
      record({ seq: 131, source, output: { path: output.path, bytes: output.size, container: 'wav' } }),
      record({ seq: 132, source, state: 'held', output: { path: held.path, bytes: 0, container: 'wav' } }),
      record({
        seq: 133,
        source,
        attempt: 2,
        logFile: log.path,
        placement: { kind: 'replaced-original', original: { status: 'kept', path: kept.path, reason: 'bin unavailable' } },
        attempts: [{ attempt: 1, runId: null, state: 'failed' } as unknown as HistoryRecord['attempts'][number]]
      })
    ])
    const reveal = async (seq: number, attempt: number, target: Parameters<typeof ctx.commands.revealRecord>[0]['target']) =>
      ctx.commands.revealRecord({ runId: RUN, jobId: formatCatalog(seq), attempt, target })
    expect((await reveal(131, 1, 'source')).ok).toBe(true)
    expect((await reveal(131, 1, 'output')).ok).toBe(true)
    expect((await reveal(132, 1, 'held-output')).ok).toBe(true)
    expect((await reveal(133, 2, 'kept-original')).ok).toBe(true)
    expect((await reveal(133, 2, 'log')).ok).toBe(true)
    expect((await reveal(133, 1, 'log')).ok).toBe(true)
    expect(ctx.showItemInFolder.mock.calls.map(([path]) => path)).toEqual([source.path, output.path, held.path, kept.path, log.path, earlier])
  })

  it('refuses a missing file, a target the record lacks, an unknown attempt, and a bad request', async () =>
  {
    const ctx = await setup()
    const source = await ctx.file('Audio/a.wav')
    await ctx.writeRun(RUN, [
      record({ seq: 131, source, output: { path: join(ctx.tmp, 'gone.wav'), bytes: 1, container: 'wav' } }),
      record({ seq: 132, source, state: 'failed' })
    ])
    const reveal = async (seq: number, attempt: number, target: Parameters<typeof ctx.commands.revealRecord>[0]['target']) =>
      ctx.commands.revealRecord({ runId: RUN, jobId: formatCatalog(seq), attempt, target })
    expect(errorOf(await reveal(131, 1, 'output')).message).toContain('no longer at')
    expect(errorOf(await reveal(132, 1, 'output')).message).toContain('no such file')
    expect(errorOf(await reveal(132, 1, 'held-output')).code).toBe('not-found')
    expect(errorOf(await reveal(132, 1, 'kept-original')).code).toBe('not-found')
    expect(errorOf(await reveal(131, 3, 'source')).message).toBe(`${formatCatalog(131)} has no attempt 3 in Batch 31.`)
    expect(errorOf(await reveal(131, 3, 'log')).code).toBe('not-found')
    expect(errorOf(await reveal(131, 0, 'source')).code).toBe('invalid-payload')
    expect(errorOf(await reveal(131, 1, 'desktop' as 'source')).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.revealRecord({ runId: RUN, jobId: 'x' as JobId, attempt: 1, target: 'source' })).code).toBe('invalid-payload')
    expect(errorOf(await ctx.commands.revealRecord({ runId: OTHER, jobId: formatCatalog(131), attempt: 1, target: 'source' })).code).toBe('not-found')
    expect(ctx.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('recordTarget', () =>
{
  const paths = { attemptLog: (runId: RunId, jobId: JobId, attempt: number) => `logs/${runId}/${jobId}-a${attempt}.log` }
  const source = { path: 'D:/a.wav', size: 1, mtimeMs: 1 }

  it('names a kept file an overwrite displaced', () =>
  {
    const overwrote = record({ seq: 1, source, placement: { kind: 'overwrote', previous: { status: 'kept', path: 'D:/a (previous).wav', reason: 'keep' } } })
    expect(recordTarget(overwrote, 1, 'kept-original', paths)).toBe('D:/a (previous).wav')
    const trashed = record({ seq: 1, source, placement: { kind: 'overwrote', previous: { status: 'trashed' } } })
    expect(recordTarget(trashed, 1, 'kept-original', paths)).toBeNull()
  })

  it('finds an attempt log from an earlier run and falls back to the record run', () =>
  {
    const rec = record({ seq: 1, source, attempt: 3, attempts: [{ attempt: 1, runId: OTHER } as unknown as HistoryRecord['attempts'][number]] })
    expect(recordTarget(rec, 1, 'log', paths)).toBe(`logs/${OTHER}/${formatCatalog(1)}-a1.log`)
    expect(recordTarget(rec, 3, 'log', paths)).toBe(`logs/${RUN}/${formatCatalog(1)}-a3.log`)
    expect(recordTarget({ ...rec, state: 'done', output: null }, 3, 'output', paths)).toBeNull()
  })
})
