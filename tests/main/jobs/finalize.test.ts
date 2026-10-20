import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { formatCatalog } from '../../../src/shared/jobs/ids'
import type { OutputPlan } from '../../../src/shared/jobs/types'
import type { Platform } from '../../../src/shared/text/platform'
import type { FsOps } from '../../../src/main/jobs/deps'
import { createFsOps, createTrash, LOCK_BUDGET_MS } from '../../../src/main/jobs/fsops'
import type { TrashWrapper } from '../../../src/main/jobs/fsops'
import { chooseFlow, copyTargetPath, createFinalizer, KEPT_BY_POLICY, plannedMode, renameBase } from '../../../src/main/jobs/finalize'
import type { FinalizeResult, PlacementEntry, PlacementRequest, PlacementStep } from '../../../src/main/jobs/finalize'
import { displacedPath, isInsideWorkDir, partOutputName, workDirName } from '../../../src/main/jobs/naming'
import { binFullReason, volumeLabel } from '../../../src/main/jobs/volumes'
import { createManualTimers } from '../helpers/manual-timers'
import type { ManualTimers } from '../helpers/manual-timers'

const hostPlatform: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const JOB = formatCatalog(7)
const SOURCE = 'source bytes that must never change'
const OUTPUT = 'verified output bytes'
const EXISTING = 'a file the user already had'

type OpName = keyof FsOps
type StepName = PlacementStep['step']

function coded(code: string, message: string = code): NodeJS.ErrnoException
{
  return Object.assign(new Error(message), { code })
}

function sha(path: string): string
{
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function text(path: string): string
{
  return readFileSync(path, 'utf8')
}

interface Fault
{
  op: OpName
  code: string
  times: number
  message?: string
  /** Matches the first path argument. */
  path?: string
}

interface Hook
{
  op: OpName
  path?: string
  times: number
  run: () => void | Promise<void>
}

/** Counts file operations still running, so the manual clock only moves while no real I/O is in flight. */
interface Inflight
{
  count: number
}

/** The real file operations with injected failures and hooks, recording every call. */
function faultyFs(real: FsOps, events: string[], inflight: Inflight): {
  fs: FsOps
  fail(fault: Omit<Fault, 'times'> & { times?: number }): void
  hook(hook: Omit<Hook, 'times'> & { times?: number }): void
  calls: Array<{ op: OpName; args: string[] }>
  reserved: Set<string>
  copies: Set<string>
}
{
  const faults: Fault[] = []
  const hooks: Hook[] = []
  const calls: Array<{ op: OpName; args: string[] }> = []
  const reserved = new Set<string>()
  const copies = new Set<string>()

  function wrap(op: OpName): (...args: string[]) => Promise<unknown>
  {
    return async (...args: string[]) =>
    {
      inflight.count++
      try
      {
        return await run(op, args)
      }
      finally
      {
        inflight.count--
      }
    }
  }

  async function run(op: OpName, args: string[]): Promise<unknown>
  {
    calls.push({ op, args })
    if (op !== 'identity' && op !== 'hash')
    {
      events.push(`fs:${op}:${args.map((arg) => basename(arg)).join('>')}`)
    }
    const hook = hooks.find((h) => h.op === op && h.times > 0 && (h.path === undefined || h.path === args[0]))
    if (hook)
    {
      hook.times--
      await hook.run()
    }
    const fault = faults.find((f) => f.op === op && f.times > 0 && (f.path === undefined || f.path === args[0]))
    if (fault)
    {
      fault.times--
      throw coded(fault.code, fault.message)
    }
    const result = await (real[op] as (...a: string[]) => Promise<unknown>)(...args)
    if (op === 'reserve')
    {
      reserved.add(args[0])
    }
    if (op === 'copyFile')
    {
      copies.add(args[1])
    }
    return result
  }

  const fs = {
    rename: wrap('rename'),
    reserve: wrap('reserve'),
    identity: wrap('identity'),
    unlink: wrap('unlink'),
    mkdir: wrap('mkdir'),
    removeTree: wrap('removeTree'),
    setHidden: wrap('setHidden'),
    copyFile: wrap('copyFile'),
    hash: wrap('hash')
  } as unknown as FsOps
  return {
    fs,
    fail: (fault) => faults.push({ times: Infinity, ...fault }),
    hook: (hook) => hooks.push({ times: 1, ...hook }),
    calls,
    reserved,
    copies
  }
}

/** A journal that records durable lines and can refuse a step's line. */
function recordingJournal(events: string[]): {
  journal: { durable(entries: readonly PlacementEntry[]): Promise<unknown> }
  entries: PlacementEntry[]
  fail(step: StepName, times?: number): void
  steps(): StepName[]
}
{
  const failures = new Map<StepName, number>()
  const entries: PlacementEntry[] = []
  return {
    entries,
    fail: (step, times = Infinity) => failures.set(step, times),
    steps: () => entries.map((entry) => entry.step),
    journal: {
      async durable(lines)
      {
        for (const line of lines)
        {
          const left = failures.get(line.step) ?? 0
          if (left > 0)
          {
            failures.set(line.step, left - 1)
            events.push(`journal-failed:${line.step}`)
            throw coded('ENOSPC', 'ENOSPC: no space left on device, write')
          }
        }
        for (const line of lines)
        {
          entries.push(line)
          events.push(`journal:${line.step}`)
        }
        return lines.map((_, i) => i)
      }
    }
  }
}

interface BinState
{
  trash: 'available' | 'unavailable' | 'unknown'
  trashBytesFree: number | null
}

function fakeVolumes(state: BinState, volumeRoot: string = hostPlatform === 'win32' ? 'D:\\' : '/'): {
  root(path: string): Promise<string>
  refreshTrash(path: string): Promise<BinState>
  markTrashUnavailable: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
}
{
  return {
    root: async () => volumeRoot,
    refreshTrash: async () => ({ ...state }),
    markTrashUnavailable: vi.fn(async () =>
    {
      state.trash = 'unavailable'
    })
  }
}

/** Runs a placement to its end, moving the manual clock only while no real I/O is in flight. */
async function drive<T>(timers: ManualTimers, work: Promise<T>, inflight: Inflight): Promise<T>
{
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null
  work.then((value) =>
  {
    outcome = { ok: true, value }
  }, (error: unknown) =>
  {
    outcome = { ok: false, error }
  })
  for (let turn = 0; outcome === null; turn++)
  {
    if (turn > 500000)
    {
      throw new Error('The placement did not settle')
    }
    const next = timers.next()
    if (next === null || inflight.count > 0)
    {
      await new Promise((resolve) => setImmediate(resolve))
      continue
    }
    await timers.advance(Math.max(0, next - timers.now()))
  }
  const settled = outcome as { ok: true; value: T } | { ok: false; error: unknown }
  if (!settled.ok)
  {
    throw settled.error
  }
  return settled.value
}

let root: string
let media: string
let binDir: string
const checks: Array<() => void> = []

beforeEach(async () =>
{
  root = await mkdtemp(join(tmpdir(), 'molex-finalize-'))
  media = join(root, 'media')
  binDir = join(root, 'bin')
  mkdirSync(media)
  mkdirSync(binDir)
})

afterEach(async () =>
{
  for (const check of checks.splice(0))
  {
    check()
  }
  await rm(root, { recursive: true, force: true })
})

interface Scene
{
  source: string
  workDir: string
  outputPath: string
}

/** A source, its work folder, and a verified output inside it. */
function scene(options: { sourceName?: string; ext?: string; folder?: boolean; execution?: number } = {}): Scene
{
  const source = join(media, options.sourceName ?? 'song.wav')
  writeFileSync(source, SOURCE)
  const workDir = join(media, workDirName(JOB, 1, options.execution ?? 1))
  mkdirSync(workDir)
  if (options.folder)
  {
    const outputPath = join(workDir, 'frames.part')
    mkdirSync(outputPath)
    writeFileSync(join(outputPath, 'frame-0001.png'), 'frame one')
    writeFileSync(join(outputPath, 'frame-0002.png'), 'frame two')
    return { source, workDir, outputPath }
  }
  const outputPath = join(workDir, partOutputName(1, options.ext ?? 'mp3'))
  writeFileSync(outputPath, OUTPUT)
  return { source, workDir, outputPath }
}

interface HarnessOptions
{
  trash?: (h: { timers: ManualTimers; host: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>; volumes: ReturnType<typeof fakeVolumes> }) => TrashWrapper
  bin?: BinState
  /** The volume root the fake registry reports. */
  volumeRoot?: string
  removeWorkDir?: (dir: string) => Promise<boolean>
}

function harness(s: Scene, options: HarnessOptions = {})
{
  const events: string[] = []
  const timers = createManualTimers()
  const inflight: Inflight = { count: 0 }
  const faulty = faultyFs(createFsOps({ platform: hostPlatform }), events, inflight)
  const journal = recordingJournal(events)
  let trashed = 0
  const host = vi.fn(async (path: string) =>
  {
    trashed++
    inflight.count++
    try
    {
      await rename(path, join(binDir, `${trashed}-${basename(path)}`))
    }
    finally
    {
      inflight.count--
    }
  })
  const volumes = fakeVolumes(options.bin ?? { trash: 'available', trashBytesFree: null }, options.volumeRoot)
  const trash = options.trash ? options.trash({ timers, host, volumes }) : createTrash({ platform: hostPlatform, timers, trash: host, volumes })
  const removeWorkDir = vi.fn(options.removeWorkDir ?? (async (dir: string) =>
  {
    await faulty.fs.removeTree(dir)
    return true
  }))
  const log = { info: vi.fn(), warn: vi.fn() }
  const finalizer = createFinalizer({ platform: hostPlatform, timers, fs: faulty.fs, trash, journal: journal.journal, removeWorkDir, log })
  const outcomes: Array<{ sourcePresent: boolean; result: FinalizeResult }> = []

  checks.push(() =>
  {
    for (const outcome of outcomes)
    {
      if (outcome.sourcePresent)
      {
        expectSourceSurvives(s, outcome.result)
      }
    }
    for (const call of faulty.calls)
    {
      if (call.op === 'unlink')
      {
        expect(faulty.reserved.has(call.args[0]) || faulty.copies.has(call.args[0]), `unlinked ${call.args[0]}`).toBe(true)
      }
      if (call.op === 'removeTree')
      {
        expect(isInsideWorkDir(call.args[0], hostPlatform), `removed ${call.args[0]}`).toBe(true)
      }
    }
  })

  async function place(output: Partial<PlacementRequest['output']>, request: Partial<PlacementRequest> = {}): Promise<FinalizeResult>
  {
    const sourcePresent = holdsSource(s.source)
    const full: PlacementRequest = {
      jobId: JOB,
      execution: 1,
      transition: 'T20',
      verdict: 'verified',
      output: { kind: 'file', finalPath: join(media, 'song.mp3'), resolution: 'place', renamedTo: null, ...output },
      policy: { conflict: 'rename', displaced: 'trash' },
      source: s.source,
      outputPath: s.outputPath,
      workDir: s.workDir,
      ...request
    }
    const result = await drive(timers, finalizer.place(full), inflight)
    outcomes.push({ sourcePresent, result })
    return result
  }

  return { events, timers, faulty, journal, host, volumes, removeWorkDir, log, place }
}

function done(result: FinalizeResult): Extract<FinalizeResult, { status: 'done' }>
{
  expect(result.status).toBe('done')
  return result as Extract<FinalizeResult, { status: 'done' }>
}

function held(result: FinalizeResult): Extract<FinalizeResult, { status: 'held' }>
{
  expect(result.status).toBe('held')
  return result as Extract<FinalizeResult, { status: 'held' }>
}

/** The verified output still waits in its work folder and the source is byte for byte what it was. */
function expectIntact(s: Scene): void
{
  expect(text(s.outputPath)).toBe(OUTPUT)
  expect(sha(s.source)).toBe(createHash('sha256').update(SOURCE).digest('hex'))
}

function holdsSource(path: string): boolean
{
  return existsSync(path) && statSync(path).isFile() && sha(path) === createHash('sha256').update(SOURCE).digest('hex')
}

/**
 * The source bytes outlive every placement: a held job leaves them at the source path or its displaced
 * name, and a done job leaves them there or in the bin, never deleted.
 */
function expectSourceSurvives(s: Scene, result: FinalizeResult): void
{
  const beside = [s.source, ...[1, 2, 3].map((n) => displacedPath(s.source, 'original', n, hostPlatform))]
  const binned = result.status === 'done' ? readdirSync(binDir).map((name) => join(binDir, name)) : []
  const found = [...beside, ...binned].filter(holdsSource)
  expect(found.length, `the source bytes of ${s.source} are gone after a ${result.status} placement`).toBeGreaterThan(0)
}

function names(): string[]
{
  return readdirSync(media).sort()
}

describe('flow choice', () =>
{
  const cases: Array<[Platform, string, string]> = [
    ['win32', 'D:\\Music\\song.wav', 'D:\\Music\\song.mp3'],
    ['linux', '/music/song.wav', '/music/song.mp3'],
    ['darwin', '/Music/song.wav', '/Music/song.mp3']
  ]

  it.each(cases)('follows the frozen resolution on %s', (platform, source, other) =>
  {
    const plan = (resolution: OutputPlan['resolution'], finalPath: string, kind: OutputPlan['kind'] = 'file'): Pick<OutputPlan, 'kind' | 'finalPath' | 'resolution'> => ({ kind, finalPath, resolution })
    expect(chooseFlow(plan('place', other), source, platform)).toBe('file')
    expect(chooseFlow(plan('rename', other), source, platform)).toBe('file')
    expect(chooseFlow(plan('skip', other), source, platform)).toBe('file')
    expect(chooseFlow(plan('overwrite', other), source, platform)).toBe('overwrite')
    expect(chooseFlow(plan('replace-original', source), source, platform)).toBe('replace-same-ext')
    expect(chooseFlow(plan('replace-original', other), source, platform)).toBe('replace-new-ext')
    expect(chooseFlow(plan('overwrite', other, 'folder'), source, platform)).toBe('folder')
  })

  it('compares the source by the platform path key', () =>
  {
    const plan: Pick<OutputPlan, 'kind' | 'finalPath' | 'resolution'> = { kind: 'file', finalPath: 'D:\\MUSIC\\Song.wav', resolution: 'replace-original' }
    expect(chooseFlow(plan, 'D:\\Music\\song.wav', 'win32')).toBe('replace-same-ext')
    expect(chooseFlow({ ...plan, finalPath: '/music/Song.wav' }, '/music/song.wav', 'linux')).toBe('replace-new-ext')
  })

  it('records the planned placement kind', () =>
  {
    expect(plannedMode('place')).toBe('new')
    expect(plannedMode('rename')).toBe('renamed')
    expect(plannedMode('overwrite')).toBe('overwrote')
    expect(plannedMode('replace-original')).toBe('replaced-original')
    expect(plannedMode('skip')).toBeNull()
  })

  it('finds the template name behind a planned rename', () =>
  {
    expect(renameBase('D:\\Music\\song (2).mp3', 'win32')).toBe('D:\\Music\\song.mp3')
    expect(renameBase('/music/song (2) (14).mp3', 'linux')).toBe('/music/song (2).mp3')
    expect(renameBase('/music/song.mp3', 'linux')).toBe('/music/song.mp3')
    expect(renameBase('/music/frames (3)', 'darwin')).toBe('/music/frames')
  })

  it('names the cross-volume copy beside the final path', () =>
  {
    const workDir = `D:\\Music\\${workDirName(JOB, 1, 2)}`
    const copy = copyTargetPath('D:\\Out\\song.mp3', workDir, `${workDir}\\out-e1.mp3.part`, 'win32')
    expect(copy).toBe(`D:\\Out\\${workDirName(JOB, 1, 2)}-out-e1.mp3.part`)
    expect(isInsideWorkDir(copy, 'win32')).toBe(false)
  })
})

describe('flow A: a new file', () =>
{
  it('writes the begin line before the first step, then reserves, places, and deletes the work folder', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    const result = done(await h.place({}))

    expect(result).toMatchObject({ finalPath: final, placement: { kind: 'new' }, warnings: [], previous: null, copied: false, workDirRemoved: true })
    expect(text(final)).toBe(OUTPUT)
    expect(existsSync(s.workDir)).toBe(false)
    expect(sha(s.source)).toBe(createHash('sha256').update(SOURCE).digest('hex'))
    expect(h.events).toEqual([
      'journal:begin',
      'fs:reserve:song.mp3',
      'journal:reserve',
      'journal:place',
      `fs:rename:${basename(s.outputPath)}>song.mp3`,
      'journal:done',
      `fs:removeTree:${basename(s.workDir)}`
    ])
    const begin = h.journal.entries[0]
    expect(begin).toMatchObject({ type: 'placement', jobId: JOB, execution: 1, step: 'begin', transition: 'T20', verdict: 'verified', mode: 'new', flow: 'file', finalPath: final, output: s.outputPath, source: s.source })
  })

  it('journals the identity of every reservation as exact strings', async () =>
  {
    const s = scene()
    const h = harness(s)
    await h.place({})
    const reserve = h.journal.entries.find((entry) => entry.step === 'reserve')
    expect(reserve).toMatchObject({ step: 'reserve', role: 'final', path: join(media, 'song.mp3') })
    const identity = (reserve as Extract<PlacementEntry, { step: 'reserve' }>).identity
    expect(typeof identity.dev).toBe('string')
    expect(typeof identity.ino).toBe('string')
    expect(identity.size).toBe(0)
  })

  it('places a planned rename at its planned name and reports the template name', async () =>
  {
    const s = scene()
    const h = harness(s)
    writeFileSync(join(media, 'song.mp3'), EXISTING)
    const planned = join(media, 'song (2).mp3')
    const result = done(await h.place({ finalPath: planned, resolution: 'rename', renamedTo: planned }))

    expect(result.placement).toEqual({ kind: 'renamed', planned: join(media, 'song.mp3') })
    expect(text(planned)).toBe(OUTPUT)
    expect(text(join(media, 'song.mp3'))).toBe(EXISTING)
    expect(h.journal.entries[0]).toMatchObject({ mode: 'renamed' })
  })

  it('takes the next free name when a file appeared since the plan, skipping names other jobs hold', async () =>
  {
    const s = scene()
    const h = harness(s)
    writeFileSync(join(media, 'song.mp3'), EXISTING)
    const held2 = join(media, 'song (2).mp3')
    const result = done(await h.place({}, { isReserved: (path) => path === held2 }))

    expect(result.finalPath).toBe(join(media, 'song (3).mp3'))
    expect(result.placement).toEqual({ kind: 'renamed', planned: join(media, 'song.mp3') })
    expect(text(join(media, 'song.mp3'))).toBe(EXISTING)
    expect(existsSync(held2)).toBe(false)
    expect(text(result.finalPath)).toBe(OUTPUT)
  })

  it('holds with destination-appeared under the skip rule and touches nothing', async () =>
  {
    const s = scene()
    const h = harness(s)
    writeFileSync(join(media, 'song.mp3'), EXISTING)
    const result = held(await h.place({}, { policy: { conflict: 'skip', displaced: 'trash' } }))

    expect(result).toMatchObject({ reason: 'destination-appeared', outputPath: s.outputPath, displaces: null, code: 'EEXIST' })
    expect(text(join(media, 'song.mp3'))).toBe(EXISTING)
    expectIntact(s)
    expect(h.faulty.calls.some((call) => call.op === 'unlink' || call.op === 'rename')).toBe(false)
  })

  it('hands a file that appeared to flow C under the overwrite rule', async () =>
  {
    const s = scene()
    const h = harness(s)
    writeFileSync(join(media, 'song.mp3'), EXISTING)
    const result = done(await h.place({}, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'trashed' } })
    expect(text(join(media, 'song.mp3'))).toBe(OUTPUT)
    expect(readdirSync(binDir).map((name) => text(join(binDir, name)))).toEqual([EXISTING])
  })

  it('retries a locked placement on the schedule, shows wait-lock after 2 s, then places', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY', times: 6 })
    const onWaitLock = vi.fn()
    const result = done(await h.place({}, { onWaitLock }))

    expect(result.finalPath).toBe(final)
    expect(onWaitLock).toHaveBeenCalledTimes(1)
    expect(onWaitLock).toHaveBeenCalledWith(final)
    expect(h.timers.now()).toBe(50 + 100 + 200 + 400 + 800 + 1600)
    expect(text(final)).toBe(OUTPUT)
  })

  it('releases its reservation and holds with file-locked once the lock outlasts the budget', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    const result = held(await h.place({}))

    expect(result).toMatchObject({ reason: 'file-locked', code: 'EBUSY', outputPath: s.outputPath })
    expect(result.message).toContain(final)
    expect(h.timers.now()).toBe(LOCK_BUDGET_MS)
    expect(existsSync(final)).toBe(false)
    expectIntact(s)
    expect(h.removeWorkDir).not.toHaveBeenCalled()
  })

  it('holds with storage-unavailable on ENOSPC with the output intact', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'ENOSPC', times: 1 })
    const result = held(await h.place({}))

    expect(result).toMatchObject({ reason: 'storage-unavailable', code: 'ENOSPC' })
    expect(result.message).toContain('full')
    expect(existsSync(join(media, 'song.mp3'))).toBe(false)
    expectIntact(s)
    expect(h.timers.now()).toBe(0)
  })

  it('names any other storage error', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'reserve', code: 'EIO', times: 1 })
    const result = held(await h.place({}))
    expect(result).toMatchObject({ reason: 'storage-unavailable', code: 'EIO' })
    expect(result.message).toContain('EIO')
    expectIntact(s)
  })

  it('holds an unexpected error with its detail for the user to decide', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'reserve', code: 'ENAMETOOLONG', message: 'name too long', times: 1 })
    const result = held(await h.place({}))
    expect(result).toMatchObject({ reason: 'file-locked', code: 'ENAMETOOLONG' })
    expect(result.message).toContain('name too long')
    expectIntact(s)
  })

  it('runs no step when the begin line cannot be made durable', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.journal.fail('begin')
    const result = held(await h.place({}))

    expect(result).toMatchObject({ reason: 'storage-unavailable', code: 'ENOSPC' })
    expect(h.events).toEqual(['journal-failed:begin'])
    expectIntact(s)
  })

  it('releases a reservation whose line cannot be made durable and holds', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.journal.fail('reserve')
    const result = held(await h.place({}))

    expect(result.reason).toBe('storage-unavailable')
    expect(existsSync(join(media, 'song.mp3'))).toBe(false)
    expect(h.faulty.calls.filter((call) => call.op === 'unlink').map((call) => call.args[0])).toEqual([join(media, 'song.mp3')])
    expectIntact(s)
  })

  it('does not place when the place line cannot be made durable', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.journal.fail('place')
    const result = held(await h.place({}))

    expect(result.reason).toBe('storage-unavailable')
    expect(h.events).not.toContain(`fs:rename:${basename(s.outputPath)}>song.mp3`)
    expect(existsSync(join(media, 'song.mp3'))).toBe(false)
    expectIntact(s)
  })

  it('never unlinks a reservation another program replaced, and moves on under the rename rule', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    h.faulty.hook({ op: 'identity', path: final, run: () => writeFileSync(final, EXISTING) })
    const result = done(await h.place({}))

    expect(text(final)).toBe(EXISTING)
    expect(result.finalPath).toBe(join(media, 'song (2).mp3'))
    expect(h.faulty.calls.some((call) => call.op === 'unlink')).toBe(false)
  })

  it('holds when a replaced reservation meets the skip rule', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    h.faulty.hook({ op: 'identity', path: final, run: () => writeFileSync(final, EXISTING) })
    const result = held(await h.place({}, { policy: { conflict: 'skip', displaced: 'trash' } }))

    expect(result.reason).toBe('destination-appeared')
    expect(text(final)).toBe(EXISTING)
    expectIntact(s)
  })

  it('holds once every numbered name is taken', async () =>
  {
    const s = scene()
    const h = harness(s)
    writeFileSync(join(media, 'song.mp3'), EXISTING)
    const result = held(await h.place({}, { isReserved: () => true }))
    expect(result.reason).toBe('destination-appeared')
    expect(result.message).toContain('Every numbered name')
    expectIntact(s)
  })

  it('finishes when the done line waits in the write queue', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.journal.fail('done')
    const result = done(await h.place({}))
    expect(text(result.finalPath)).toBe(OUTPUT)
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('write queue'))
  })

  it('reports a work folder the registry could not delete yet', async () =>
  {
    const s = scene()
    const h = harness(s, { removeWorkDir: async () => false })
    expect(done(await h.place({})).workDirRemoved).toBe(false)

    const t = scene({ sourceName: 'other.wav', execution: 2 })
    const g = harness(t, {
      removeWorkDir: async () =>
      {
        throw coded('EBUSY')
      }
    })
    const result = done(await g.place({ finalPath: join(media, 'other.mp3') }, { source: t.source }))
    expect(result.workDirRemoved).toBe(false)
    expect(g.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not remove'))
  })
})

describe('cross-volume fallback', () =>
{
  it('copies and hashes into a second work name, then renames it into place', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EXDEV', times: 1 })
    const result = done(await h.place({}))
    const copy = copyTargetPath(final, s.workDir, s.outputPath, hostPlatform)

    expect(result.copied).toBe(true)
    expect(text(final)).toBe(OUTPUT)
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(s.workDir)).toBe(false)
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'place', 'copy', 'reserve', 'done'])
    expect(h.journal.entries[4]).toMatchObject({ step: 'reserve', role: 'copy', path: copy })
    expect(h.faulty.calls.filter((call) => call.op === 'copyFile')).toEqual([{ op: 'copyFile', args: [s.outputPath, copy] }])
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('Unexpected cross-volume move'))
  })

  it('holds with the output intact when the copy runs out of space', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EXDEV', times: 1 })
    h.faulty.fail({ op: 'copyFile', code: 'ENOSPC', times: 1 })
    const result = held(await h.place({}))

    expect(result.reason).toBe('storage-unavailable')
    expect(existsSync(join(media, 'song.mp3'))).toBe(false)
    expect(names()).toEqual([basename(s.workDir), 'song.wav'])
    expectIntact(s)
  })

  it('removes its own copy by identity when the copy cannot be renamed into place', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    const copy = copyTargetPath(final, s.workDir, s.outputPath, hostPlatform)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EXDEV', times: 1 })
    h.faulty.fail({ op: 'rename', path: copy, code: 'EIO' })
    const result = held(await h.place({}))

    expect(result).toMatchObject({ reason: 'storage-unavailable', code: 'EIO' })
    expect(existsSync(copy)).toBe(false)
    expect(existsSync(final)).toBe(false)
    expectIntact(s)
  })

  it('holds when the verified copy is missing afterwards', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EXDEV', times: 1 })
    const copy = copyTargetPath(join(media, 'song.mp3'), s.workDir, s.outputPath, hostPlatform)
    h.faulty.hook({ op: 'identity', path: copy, run: () => rm(copy, { force: true }) })
    const result = held(await h.place({}))

    expect(result.reason).toBe('file-locked')
    expect(result.message).toContain('missing')
    expectIntact(s)
  })
})

const SHARING = 'The process cannot access the file because it is being used by another process.'

describe('flow C: overwrite an existing file', () =>
{
  const policy = { conflict: 'overwrite' as const, displaced: 'trash' as const }

  function existing(): { final: string; parked: string }
  {
    const final = join(media, 'song.mp3')
    writeFileSync(final, EXISTING)
    return { final, parked: join(media, 'song (previous).mp3') }
  }

  it('displaces the existing file to (previous), places the output, then trashes the displaced file', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    const result = done(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'trashed' } })
    expect(result.warnings).toEqual([])
    expect(text(final)).toBe(OUTPUT)
    expect(existsSync(parked)).toBe(false)
    expect(readdirSync(binDir).map((name) => text(join(binDir, name)))).toEqual([EXISTING])
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'displace', 'reserve', 'place', 'trash', 'done'])
    expect(h.journal.entries[0]).toMatchObject({ mode: 'overwrote', flow: 'overwrite' })
    expect(h.journal.entries[1]).toMatchObject({ step: 'reserve', role: 'displaced', path: parked })
    expect(h.journal.entries[2]).toMatchObject({ step: 'displace', from: final, to: parked, identity: { size: EXISTING.length } })
    expect(h.journal.entries[3]).toMatchObject({ step: 'reserve', role: 'final', path: final })
    const displaceAt = h.events.indexOf('fs:rename:song.mp3>song (previous).mp3')
    const placeAt = h.events.indexOf(`fs:rename:${basename(s.outputPath)}>song.mp3`)
    expect(displaceAt).toBeGreaterThan(h.events.indexOf('journal:displace'))
    expect(placeAt).toBeGreaterThan(displaceAt)
    expect(h.events.indexOf('journal:trash')).toBeGreaterThan(placeAt)
  })

  it('takes (previous 2) when (previous) is taken', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    writeFileSync(parked, 'an older file')
    const result = done(await h.place({ resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'keep' } }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: join(media, 'song (previous 2).mp3'), reason: KEPT_BY_POLICY } })
    expect(text(parked)).toBe('an older file')
    expect(text(join(media, 'song (previous 2).mp3'))).toBe(EXISTING)
    expect(text(final)).toBe(OUTPUT)
  })

  it('releases the empty reservation and holds with file-locked while the existing file stays open elsewhere', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.fail({ op: 'rename', path: final, code: 'EBUSY' })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result).toMatchObject({ reason: 'file-locked', displaces: final, code: 'EBUSY' })
    expect(h.timers.now()).toBe(LOCK_BUDGET_MS)
    expect(text(final)).toBe(EXISTING)
    expect(existsSync(parked)).toBe(false)
    expectIntact(s)
  })

  it('renames the displaced file back when placing fails, journaled as rollback', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result).toMatchObject({ reason: 'file-locked', displaces: final })
    expect(text(final)).toBe(EXISTING)
    expect(existsSync(parked)).toBe(false)
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'displace', 'reserve', 'place', 'rollback'])
    expect(h.journal.entries[5]).toMatchObject({ step: 'rollback', from: parked, to: final })
    expectIntact(s)
  })

  it('holds with a message naming both paths and deletes nothing when the rollback fails too', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    h.faulty.fail({ op: 'rename', path: parked, code: 'EBUSY' })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.reason).toBe('file-locked')
    expect(result.message).toContain(final)
    expect(result.message).toContain(parked)
    expect(text(parked)).toBe(EXISTING)
    expect(existsSync(final)).toBe(false)
    expectIntact(s)
  })

  it('keeps a displaced file the trash refuses as name (previous).ext with previous-kept', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.host.mockRejectedValue(new Error(SHARING))
    const result = done(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: expect.stringContaining(SHARING) } })
    expect(result.warnings).toEqual(['previous-kept'])
    expect(text(parked)).toBe(EXISTING)
    expect(text(final)).toBe(OUTPUT)
  })

  it('skips the trash step under displaced keep and finishes without a warning', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { parked } = existing()
    const result = done(await h.place({ resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'keep' } }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: KEPT_BY_POLICY } })
    expect(result.warnings).toEqual([])
    expect(h.host).not.toHaveBeenCalled()
    expect(h.journal.steps()).not.toContain('trash')
    expect(text(parked)).toBe(EXISTING)
  })

  it('places the output as new when the file to overwrite has gone since the plan', async () =>
  {
    const s = scene()
    const h = harness(s)
    const result = done(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.placement).toEqual({ kind: 'new' })
    expect(names()).toEqual(['song.mp3', 'song.wav'])
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'reserve', 'place', 'done'])
  })

  it('keeps both files when another file appears at the path right after the displace', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.hook({ op: 'reserve', path: final, run: () => writeFileSync(final, 'a newcomer') })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.reason).toBe('destination-appeared')
    expect(result.message).toContain(parked)
    expect(text(parked)).toBe(EXISTING)
    expect(text(final)).toBe('a newcomer')
    expectIntact(s)
  })

  it('rolls back when the final path cannot be claimed after the displace', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.fail({ op: 'reserve', path: final, code: 'EIO' })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result).toMatchObject({ reason: 'storage-unavailable', code: 'EIO' })
    expect(text(final)).toBe(EXISTING)
    expect(existsSync(parked)).toBe(false)
    expectIntact(s)
  })

  it('releases the reservation when the displace line cannot be made durable', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.journal.fail('displace')
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.reason).toBe('storage-unavailable')
    expect(text(final)).toBe(EXISTING)
    expect(existsSync(parked)).toBe(false)
    expect(h.events.some((event) => event.startsWith('fs:rename'))).toBe(false)
    expectIntact(s)
  })

  it('still restores the name when the rollback line cannot be saved', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final } = existing()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'ENOSPC', times: 1 })
    h.journal.fail('rollback')
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.reason).toBe('storage-unavailable')
    expect(text(final)).toBe(EXISTING)
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('before its rollback line is saved'))
    expectIntact(s)
  })

  it('keeps the displaced file with a warning when its trash line cannot be saved', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { parked } = existing()
    h.journal.fail('trash')
    const result = done(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: expect.stringContaining('could not save') } })
    expect(result.warnings).toEqual(['previous-kept'])
    expect(h.host).not.toHaveBeenCalled()
  })

  it('keeps the displaced file when the trash itself throws', async () =>
  {
    const s = scene()
    const h = harness(s, {
      trash: () => ({
        trash: async () =>
        {
          throw new Error('the bin broke')
        }
      })
    })
    const { parked } = existing()
    const result = done(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: expect.stringContaining('the bin broke') } })
    expect(result.warnings).toEqual(['previous-kept'])
  })

  it('holds once every displaced name is taken', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final } = existing()
    const result = held(await h.place({ resolution: 'overwrite' }, { policy, isReserved: () => true }))

    expect(result.reason).toBe('destination-appeared')
    expect(result.message).toContain('Every displaced name')
    expect(text(final)).toBe(EXISTING)
    expectIntact(s)
  })

  it('releases the reservation when the file to displace cannot be read', async () =>
  {
    const s = scene()
    const h = harness(s)
    const { final, parked } = existing()
    h.faulty.fail({ op: 'identity', path: final, code: 'EACCES' })
    const result = held(await h.place({ resolution: 'overwrite' }, { policy }))

    expect(result.reason).toBe('file-locked')
    expect(existsSync(parked)).toBe(false)
    expect(text(final)).toBe(EXISTING)
    expectIntact(s)
  })
})

describe('flow D: replace the original with the same extension', () =>
{
  function setup(options: HarnessOptions = {}): { s: Scene; h: ReturnType<typeof harness>; parked: string; replace: Partial<PlacementRequest['output']> }
  {
    const s = scene({ ext: 'wav' })
    return { s, h: harness(s, options), parked: join(media, 'song (original).wav'), replace: { finalPath: s.source, resolution: 'replace-original' } }
  }

  function sourceUnchanged(path: string): void
  {
    expect(sha(path)).toBe(createHash('sha256').update(SOURCE).digest('hex'))
  }

  it('renames the source to (original), places the output at its path, then trashes the original', async () =>
  {
    const { s, h, parked, replace } = setup()
    const result = done(await h.place(replace))

    expect(result).toMatchObject({ finalPath: s.source, placement: { kind: 'replaced-original', original: { status: 'trashed' } }, warnings: [], previous: null })
    expect(text(s.source)).toBe(OUTPUT)
    expect(existsSync(parked)).toBe(false)
    expect(readdirSync(binDir).map((name) => text(join(binDir, name)))).toEqual([SOURCE])
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'displace', 'reserve', 'place', 'trash', 'done'])
    expect(h.journal.entries[0]).toMatchObject({ flow: 'replace-same-ext', mode: 'replaced-original' })
    const displaceAt = h.events.indexOf('fs:rename:song.wav>song (original).wav')
    const placeAt = h.events.indexOf(`fs:rename:${basename(s.outputPath)}>song.wav`)
    expect(displaceAt).toBeGreaterThan(-1)
    expect(placeAt).toBeGreaterThan(displaceAt)
    expect(h.events.indexOf('journal:trash')).toBeGreaterThan(placeAt)
    expect(h.host).toHaveBeenCalledTimes(1)
  })

  it('holds with file-locked while a player holds the source, with the source untouched', async () =>
  {
    const { s, h, parked, replace } = setup()
    h.faulty.fail({ op: 'rename', path: s.source, code: 'EPERM' })
    const result = held(await h.place(replace))

    expect(result).toMatchObject({ reason: 'file-locked', displaces: s.source, outputPath: s.outputPath })
    expect(existsSync(parked)).toBe(false)
    expectIntact(s)
  })

  it('renames the original back when placing fails', async () =>
  {
    const { s, h, parked, replace } = setup()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EACCES' })
    const result = held(await h.place(replace))

    expect(result.reason).toBe('file-locked')
    expect(existsSync(parked)).toBe(false)
    expect(h.journal.steps()).toContain('rollback')
    expectIntact(s)
  })

  it('keeps both files and names both paths when the rollback fails too', async () =>
  {
    const { s, h, parked, replace } = setup()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    h.faulty.fail({ op: 'rename', path: parked, code: 'EBUSY' })
    const result = held(await h.place(replace))

    expect(result.message).toContain(s.source)
    expect(result.message).toContain(parked)
    sourceUnchanged(parked)
    expect(text(s.outputPath)).toBe(OUTPUT)
  })

  it('holds with the output intact when placing runs out of space', async () =>
  {
    const { s, h, replace } = setup()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'ENOSPC', times: 1 })
    const result = held(await h.place(replace))

    expect(result.reason).toBe('storage-unavailable')
    expectIntact(s)
  })

  it('keeps an original the trash refuses as name (original).ext with original-kept', async () =>
  {
    const { s, h, parked, replace } = setup()
    h.host.mockRejectedValue(new Error(SHARING))
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: expect.stringContaining(SHARING) } })
    expect(result.warnings).toEqual(['original-kept'])
    sourceUnchanged(parked)
    expect(text(s.source)).toBe(OUTPUT)
  })

  it('never calls the trash on a volume without a bin and keeps the original without a held warning', async () =>
  {
    const { h, parked, replace } = setup({ bin: { trash: 'unavailable', trashBytesFree: null } })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: expect.stringContaining('has no') } })
    expect(result.warnings).toEqual([])
    expect(h.host).not.toHaveBeenCalled()
    sourceUnchanged(parked)
  })

  it('takes no retry for an aborted trash, marks the volume, and keeps the original', async () =>
  {
    const aborted = vi.fn(async (_path: string) =>
    {
      throw new Error('Operation was aborted')
    })
    const { h, parked, replace } = setup({
      volumeRoot: 'D:\\',
      trash: ({ timers, volumes }) => createTrash({ platform: 'win32', timers, trash: aborted, volumes, sizeOf: async () => 1 })
    })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: expect.stringContaining('cannot go to the Recycle Bin') } })
    expect(result.warnings).toEqual(['original-kept'])
    expect(aborted).toHaveBeenCalledTimes(1)
    expect(h.volumes.markTrashUnavailable).toHaveBeenCalledTimes(1)
    expect(h.timers.now()).toBe(0)
    sourceUnchanged(parked)
  })

  it('waits on the lock schedule when the aborted trash is a file open elsewhere, then trashes it', async () =>
  {
    const aborted = vi.fn(async (_path: string): Promise<void> => undefined)
    aborted.mockRejectedValueOnce(new Error('Operation was aborted')).mockRejectedValueOnce(new Error('Operation was aborted'))
    const busy = vi.fn(async (_path: string) => true)
    const { h, replace } = setup({
      volumeRoot: 'D:\\',
      trash: ({ timers, volumes }) => createTrash({ platform: 'win32', timers, trash: aborted, volumes, sizeOf: async () => 1, isBusy: busy })
    })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'trashed' } })
    expect(aborted).toHaveBeenCalledTimes(3)
    expect(busy).toHaveBeenCalledTimes(2)
    expect(h.volumes.markTrashUnavailable).not.toHaveBeenCalled()
    expect(h.timers.now()).toBe(50 + 100)
  })

  it('keeps a file still open elsewhere after the lock budget without marking its volume', async () =>
  {
    const aborted = vi.fn(async (_path: string) =>
    {
      throw new Error('Operation was aborted')
    })
    const { h, parked, replace } = setup({
      volumeRoot: 'D:\\',
      trash: ({ timers, volumes }) => createTrash({ platform: 'win32', timers, trash: aborted, volumes, sizeOf: async () => 1, isBusy: async () => true })
    })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: expect.stringContaining('open in another program') } })
    expect(aborted.mock.calls.length).toBeGreaterThan(3)
    expect(h.volumes.markTrashUnavailable).not.toHaveBeenCalled()
    sourceUnchanged(parked)
  })

  it('retries a sharing violation on the lock schedule, then trashes', async () =>
  {
    const sharing = vi.fn(async (_path: string): Promise<void> => undefined)
    sharing.mockRejectedValueOnce(new Error(SHARING)).mockRejectedValueOnce(new Error(SHARING))
    const { h, replace } = setup({
      volumeRoot: 'D:\\',
      trash: ({ timers, volumes }) => createTrash({ platform: 'win32', timers, trash: sharing, volumes, sizeOf: async () => 1 })
    })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'trashed' } })
    expect(sharing).toHaveBeenCalledTimes(3)
    expect(h.timers.now()).toBe(50 + 100)
  })

  it("keeps an original that does not fit in the bin with the 'bin full' reason", async () =>
  {
    const never = vi.fn(async (_path: string): Promise<void> => undefined)
    const { h, parked, replace } = setup({
      volumeRoot: 'D:\\',
      bin: { trash: 'available', trashBytesFree: 10 },
      trash: ({ timers, volumes }) => createTrash({ platform: 'win32', timers, trash: never, volumes, sizeOf: async () => 1000 })
    })
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: binFullReason(volumeLabel('D:\\', 'win32')) } })
    expect(binFullReason(volumeLabel('D:\\', 'win32'))).toBe('The Recycle Bin on D: is full; moving this file there would delete older items permanently.')
    expect(result.warnings).toEqual(['original-kept'])
    expect(never).not.toHaveBeenCalled()
    sourceUnchanged(parked)
  })

  it('leaves the original at name (original).ext under displaced keep, without a warning or a trash step', async () =>
  {
    const { s, h, parked, replace } = setup()
    const result = done(await h.place(replace, { policy: { conflict: 'rename', displaced: 'keep' } }))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: parked, reason: KEPT_BY_POLICY } })
    expect(result.warnings).toEqual([])
    expect(h.host).not.toHaveBeenCalled()
    expect(h.journal.steps()).not.toContain('trash')
    sourceUnchanged(parked)
    expect(text(s.source)).toBe(OUTPUT)
  })

  it('places the output at the source path when the source has gone since verification', async () =>
  {
    const { s, h, replace } = setup()
    await rm(s.source)
    const result = done(await h.place(replace))

    expect(result).toMatchObject({ finalPath: s.source, placement: { kind: 'new' } })
    expect(text(s.source)).toBe(OUTPUT)
    expect(names()).toEqual(['song.wav'])
  })
})

describe('flow E: replace the original with a new extension', () =>
{
  const replace = { resolution: 'replace-original' as const }

  it('places the output at its new name first, then trashes the original from its own path', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    const result = done(await h.place(replace))

    expect(result).toMatchObject({ finalPath: final, placement: { kind: 'replaced-original', original: { status: 'trashed' } }, previous: null, warnings: [] })
    expect(text(final)).toBe(OUTPUT)
    expect(existsSync(s.source)).toBe(false)
    expect(readdirSync(binDir).map((name) => text(join(binDir, name)))).toEqual([SOURCE])
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'place', 'trash', 'done'])
    expect(h.journal.entries[0]).toMatchObject({ flow: 'replace-new-ext' })
    expect(h.journal.entries[3]).toMatchObject({ step: 'trash', path: s.source, role: 'original' })
    expect(h.events.indexOf('journal:trash')).toBeGreaterThan(h.events.indexOf(`fs:rename:${basename(s.outputPath)}>song.mp3`))
  })

  it('keeps the original at its own path with original-kept when the trash refuses', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.host.mockRejectedValue(new Error(SHARING))
    const result = done(await h.place(replace))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: s.source, reason: expect.stringContaining(SHARING) } })
    expect(result.warnings).toEqual(['original-kept'])
    expect(sha(s.source)).toBe(createHash('sha256').update(SOURCE).digest('hex'))
  })

  it('leaves the original at its own path under displaced keep, with no trash step', async () =>
  {
    const s = scene()
    const h = harness(s)
    const result = done(await h.place(replace, { policy: { conflict: 'rename', displaced: 'keep' } }))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'kept', path: s.source, reason: KEPT_BY_POLICY } })
    expect(result.warnings).toEqual([])
    expect(h.host).not.toHaveBeenCalled()
    expect(h.journal.steps()).toEqual(['begin', 'reserve', 'place', 'done'])
    expectIntact({ ...s, outputPath: join(media, 'song.mp3') })
  })

  it('overwrites a file at the new name through flow C before trashing the original', async () =>
  {
    const s = scene()
    const h = harness(s)
    const final = join(media, 'song.mp3')
    writeFileSync(final, EXISTING)
    const result = done(await h.place(replace, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result.placement).toEqual({ kind: 'replaced-original', original: { status: 'trashed' } })
    expect(result.previous).toEqual({ status: 'trashed' })
    expect(text(final)).toBe(OUTPUT)
    expect(readdirSync(binDir).map((name) => text(join(binDir, name))).sort()).toEqual([EXISTING, SOURCE].sort())
  })

  it('holds with the original untouched when placing fails', async () =>
  {
    const s = scene()
    const h = harness(s)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    const result = held(await h.place(replace))

    expect(result).toMatchObject({ reason: 'file-locked', displaces: s.source })
    expect(h.host).not.toHaveBeenCalled()
    expect(existsSync(join(media, 'song.mp3'))).toBe(false)
    expectIntact(s)
  })
})

describe('flow B: a frames folder', () =>
{
  const folder = { kind: 'folder' as const, finalPath: '' }

  function frames(dir: string): string[]
  {
    return readdirSync(dir).sort()
  }

  function existingFolder(name = 'song_frames', content = 'an old frame'): string
  {
    const path = join(media, name)
    mkdirSync(path)
    writeFileSync(join(path, 'frame-0001.png'), content)
    return path
  }

  it('renames the frames folder into place once the final folder is checked absent', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = join(media, 'song_frames')
    const result = done(await h.place({ ...folder, finalPath: final }))

    expect(result).toMatchObject({ finalPath: final, placement: { kind: 'new' } })
    expect(frames(final)).toEqual(['frame-0001.png', 'frame-0002.png'])
    expect(existsSync(s.workDir)).toBe(false)
    expect(h.journal.steps()).toEqual(['begin', 'place', 'done'])
    expect(h.journal.entries[0]).toMatchObject({ flow: 'folder' })
  })

  it('takes the next name under the rename rule when the folder exists', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    const result = done(await h.place({ ...folder, finalPath: final }))

    expect(result).toMatchObject({ finalPath: join(media, 'song_frames (2)'), placement: { kind: 'renamed', planned: final } })
    expect(text(join(final, 'frame-0001.png'))).toBe('an old frame')
  })

  it('holds under the skip rule', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    const result = held(await h.place({ ...folder, finalPath: final }, { policy: { conflict: 'skip', displaced: 'trash' } }))

    expect(result.reason).toBe('destination-appeared')
    expect(frames(s.outputPath)).toEqual(['frame-0001.png', 'frame-0002.png'])
  })

  it('reads a folder that appeared during the move as appeared, not as a lock', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = join(media, 'song_frames')
    h.faulty.hook({ op: 'rename', path: s.outputPath, run: () => void existingFolder() })
    const result = done(await h.place({ ...folder, finalPath: final }))

    expect(result.finalPath).toBe(join(media, 'song_frames (2)'))
    expect(text(join(final, 'frame-0001.png'))).toBe('an old frame')
    expect(h.timers.now()).toBe(0)
  })

  it('holds with file-locked when the folder stays locked', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    const result = held(await h.place({ ...folder, finalPath: join(media, 'song_frames') }))

    expect(result.reason).toBe('file-locked')
    expect(frames(s.outputPath)).toEqual(['frame-0001.png', 'frame-0002.png'])
  })

  it('displaces an existing folder under the overwrite rule and trashes it', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    const result = done(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'trashed' } })
    expect(frames(final)).toEqual(['frame-0001.png', 'frame-0002.png'])
    expect(text(join(final, 'frame-0001.png'))).toBe('frame one')
    const binned = readdirSync(binDir)
    expect(binned).toHaveLength(1)
    expect(text(join(binDir, binned[0], 'frame-0001.png'))).toBe('an old frame')
    expect(h.journal.steps()).toEqual(['begin', 'displace', 'place', 'trash', 'done'])
  })

  it('keeps the displaced folder beside the output under displaced keep', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    const parked = join(media, 'song_frames (previous)')
    const result = done(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'keep' } }))

    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: KEPT_BY_POLICY } })
    expect(text(join(parked, 'frame-0001.png'))).toBe('an old frame')
  })

  it('renames the displaced folder back when placing it fails', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    h.faulty.fail({ op: 'rename', path: s.outputPath, code: 'EBUSY' })
    const result = held(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result).toMatchObject({ reason: 'file-locked', displaces: final })
    expect(text(join(final, 'frame-0001.png'))).toBe('an old frame')
    expect(existsSync(join(media, 'song_frames (previous)'))).toBe(false)
    expect(h.journal.steps()).toEqual(['begin', 'displace', 'place', 'rollback'])
  })

  it('places as new when the folder to overwrite has gone', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    h.faulty.hook({ op: 'identity', path: join(media, 'song_frames (previous)'), run: () => rm(final, { recursive: true }) })
    const result = done(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result).toMatchObject({ finalPath: final, placement: { kind: 'new' } })
    expect(h.host).not.toHaveBeenCalled()
  })

  it('skips displaced folder names that are taken on disk or appear during the move', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    existingFolder('song_frames (previous)', 'older')
    h.faulty.hook({ op: 'rename', path: final, run: () => void existingFolder('song_frames (previous 2)', 'newer') })
    const result = done(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'keep' } }))

    const parked = join(media, 'song_frames (previous 3)')
    expect(result.placement).toEqual({ kind: 'overwrote', previous: { status: 'kept', path: parked, reason: KEPT_BY_POLICY } })
    expect(text(join(parked, 'frame-0001.png'))).toBe('an old frame')
    expect(text(join(media, 'song_frames (previous)', 'frame-0001.png'))).toBe('older')
    expect(text(join(media, 'song_frames (previous 2)', 'frame-0001.png'))).toBe('newer')
  })

  it('holds when the folder to displace stays locked', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    h.faulty.fail({ op: 'rename', path: final, code: 'EBUSY' })
    const result = held(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'trash' } }))

    expect(result.reason).toBe('file-locked')
    expect(text(join(final, 'frame-0001.png'))).toBe('an old frame')
    expect(frames(s.outputPath)).toEqual(['frame-0001.png', 'frame-0002.png'])
  })

  it('holds once every displaced folder name is taken', async () =>
  {
    const s = scene({ folder: true })
    const h = harness(s)
    const final = existingFolder()
    const result = held(await h.place({ ...folder, finalPath: final, resolution: 'overwrite' }, { policy: { conflict: 'overwrite', displaced: 'trash' }, isReserved: () => true }))

    expect(result.message).toContain('Every displaced name')
  })
})
