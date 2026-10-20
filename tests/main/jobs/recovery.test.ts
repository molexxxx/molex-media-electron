import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import { transitionFor } from '../../../src/shared/jobs/states'
import type { FrozenPolicy, Job, JobHold, JobPlan, JobState, RunAlert, RunState, RunStatus, SourceRef, StateReason } from '../../../src/shared/jobs/types'
import type { Platform } from '../../../src/shared/text/platform'
import { realTimers } from '../../../src/main/timers'
import type { FsOps } from '../../../src/main/jobs/deps'
import { KEPT_BY_POLICY } from '../../../src/main/jobs/finalize'
import type { PlacementEntry, PlacementStep } from '../../../src/main/jobs/finalize'
import { createFsOps } from '../../../src/main/jobs/fsops'
import type { TrashResult, TrashWrapper } from '../../../src/main/jobs/fsops'
import type { JournalEntry } from '../../../src/main/jobs/persistence'
import { JobQueue } from '../../../src/main/jobs/queue'
import type { JobChange } from '../../../src/main/jobs/queue'
import type { WorkDirEntry } from '../../../src/main/jobs/workdirs'
import { volumeLabel } from '../../../src/main/jobs/volumes'
import { interruptReason, isFinished, PlacementCheck, placementSegments, recoverEngine, segmentKey, segmentPaths, VolumeCheck } from '../../../src/main/jobs/recovery'
import type { PlacementSegment, PlacementVerdict, RecoveredPlacement, RecoveryDeps } from '../../../src/main/jobs/recovery'

const hostPlatform: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
const JOB = 'MM-0007' as JobId

function coded(code: string): NodeJS.ErrnoException
{
  return Object.assign(new Error(code), { code })
}

function line(jobId: JobId, execution: number, step: PlacementStep): PlacementEntry
{
  return { type: 'placement', jobId, execution, ...step }
}

function begin(over: Partial<Extract<PlacementStep, { step: 'begin' }>> = {}): Extract<PlacementStep, { step: 'begin' }>
{
  return { step: 'begin', transition: 'T20', verdict: null, mode: 'new', flow: 'file', finalPath: '/out/a.mp4', output: '/out/w/a.part', source: '/src/a.mkv', ...over }
}

let root: string

beforeEach(async () =>
{
  root = await mkdtemp(join(tmpdir(), 'molex-recovery-'))
})

afterEach(async () =>
{
  await rm(root, { recursive: true, force: true })
})

describe('interruptReason', () =>
{
  it('is crash without a clean exit or an interruption line', () =>
  {
    expect(interruptReason({ lines: [], previous: null })).toBe('crash')
    expect(interruptReason({ lines: [], previous: { pid: 1, startedAt: 0, cleanExit: false } })).toBe('crash')
  })

  it('is quit after a clean exit', () =>
  {
    expect(interruptReason({ lines: [], previous: { pid: 1, startedAt: 0, cleanExit: true } })).toBe('quit')
  })

  it('takes the last journaled quit or session-end interruption', () =>
  {
    const lines: JournalEntry[] = [
      { type: 'job.state', to: 'interrupted', reason: 'quit' } as JournalEntry,
      { type: 'job.state', to: 'interrupted', reason: 'session-end' } as JournalEntry,
      { type: 'job.state', to: 'interrupted', reason: 'crash' } as JournalEntry,
      { type: 'job.state', to: 'done', reason: 'engine' } as JournalEntry
    ]
    expect(interruptReason({ lines, previous: null })).toBe('session-end')
    expect(interruptReason({ lines: lines.slice(0, 1), previous: { pid: 1, startedAt: 0, cleanExit: false } })).toBe('quit')
  })
})

describe('placementSegments', () =>
{
  it('groups lines by job and execution and starts a segment at every begin', () =>
  {
    const other = 'MM-0008' as JobId
    const lines: JournalEntry[] = [
      line(JOB, 1, { step: 'reserve', path: '/orphan', role: 'final', identity: { dev: '1', ino: '1', size: 0, mtimeMs: 1 } }),
      line(JOB, 1, begin()),
      { type: 'job.change' } as JournalEntry,
      { type: 'placement', jobId: JOB, execution: 1, step: 'bogus' } as unknown as JournalEntry,
      line(JOB, 1, { step: 'place', from: '/out/w/a.part', to: '/out/a.mp4' }),
      line(other, 2, begin({ finalPath: '/out/b.mp4' })),
      line(JOB, 1, begin({ transition: 'T26' })),
      line(JOB, 1, { step: 'done', finalPath: '/out/a.mp4', placement: { kind: 'new' } })
    ]
    const segments = placementSegments(lines)
    const mine = segments.get(segmentKey(JOB, 1)) ?? []
    expect(mine.map((s) => s.steps.map((x) => x.step))).toEqual([['begin', 'place'], ['begin', 'done']])
    expect(mine.map(isFinished)).toEqual([false, true])
    expect(segments.get(segmentKey(other, 2))?.[0].begin.finalPath).toBe('/out/b.mp4')
  })

  it('lists every path a placement names once', () =>
  {
    const [segment] = placementSegments([
      line(JOB, 1, begin()),
      line(JOB, 1, { step: 'reserve', path: '/out/a (previous).mp4', role: 'displaced', identity: { dev: '1', ino: '2', size: 0, mtimeMs: 1 } }),
      line(JOB, 1, { step: 'displace', from: '/out/a.mp4', to: '/out/a (previous).mp4', identity: null }),
      line(JOB, 1, { step: 'trash', path: '/out/a (previous).mp4', role: 'previous' }),
      line(JOB, 1, { step: 'done', finalPath: '/out/a.mp4', placement: { kind: 'new' } })
    ]).get(segmentKey(JOB, 1)) ?? []
    expect(segmentPaths(segment)).toEqual(['/out/w/a.part', '/out/a.mp4', '/src/a.mkv', '/out/a (previous).mp4'])
  })
})

describe('VolumeCheck', () =>
{
  it('reports nothing for reachable folders and treats a missing folder on a live volume as reachable', async () =>
  {
    const check = new VolumeCheck({ platform: hostPlatform, timers: realTimers, stat, volumes: { root: async () => root, isNetwork: async () => false } })
    expect(await check.offline([join(root, 'a.txt'), join(root, 'gone', 'deeper', 'b.txt')])).toEqual([])
  })

  it('names a root that does not answer and a folder that hangs, and asks each once per pass', async () =>
  {
    const offline = join(root, 'offline')
    const hung = join(root, 'hung')
    const asked: string[] = []
    const check = new VolumeCheck({
      platform: hostPlatform,
      timers: realTimers,
      reachTimeoutMs: 20,
      stat: (path) =>
      {
        asked.push(path)
        if (path === offline)
        {
          return Promise.reject(coded('ENOENT'))
        }
        if (path.startsWith(hung))
        {
          return new Promise(() => undefined)
        }
        return stat(path)
      },
      volumes: { root: async (path) => (path.startsWith(offline) ? offline : root), isNetwork: async (path) => path.startsWith(hung) }
    })
    const paths = [join(offline, 'x', 'a'), join(hung, 'b'), join(root, 'c')]
    expect((await check.offline(paths)).sort()).toEqual([offline, root].sort())
    const count = asked.length
    expect((await check.offline(paths)).sort()).toEqual([offline, root].sort())
    expect(asked.length).toBe(count)
    check.reset()
    await check.offline([join(root, 'c')])
    expect(asked.length).toBeGreaterThan(count)
  })

  it('reports a folder whose stat fails with another error as offline', async () =>
  {
    const check = new VolumeCheck({
      platform: hostPlatform,
      timers: realTimers,
      stat: async (path) =>
      {
        if (path !== root)
        {
          throw coded('EIO')
        }
      },
      volumes: { root: async () => root, isNetwork: async () => false }
    })
    expect(await check.offline([join(root, 'sub', 'a')])).toEqual([root])
  })
})

const quiet = { info: (): void => undefined, warn: (): void => undefined }

interface Disk
{
  out: string
  work: string
  src: string
  bin: string
  fs: FsOps
  trash: TrashWrapper & { refuse: TrashResult | null; error: Error | null; calls: string[] }
  journal: PlacementEntry[]
  failJournal: boolean
}

function disk(): Disk
{
  const out = join(root, 'out')
  const work = join(out, '.molex-MM-0007-a1-x1')
  const src = join(root, 'src')
  const bin = join(root, 'bin')
  for (const dir of [out, work, src, bin])
  {
    mkdirSync(dir, { recursive: true })
  }
  const d: Disk = {
    out,
    work,
    src,
    bin,
    fs: createFsOps({ platform: hostPlatform }),
    journal: [],
    failJournal: false,
    trash: {
      refuse: null,
      error: null,
      calls: [],
      async trash(path: string): Promise<TrashResult>
      {
        d.trash.calls.push(path)
        if (d.trash.error !== null)
        {
          throw d.trash.error
        }
        if (d.trash.refuse !== null)
        {
          return d.trash.refuse
        }
        renameSync(path, join(bin, basename(path)))
        return { status: 'trashed' }
      }
    }
  }
  return d
}

function deps(d: Disk): ConstructorParameters<typeof PlacementCheck>[0]
{
  return {
    fs: d.fs,
    trash: d.trash,
    platform: hostPlatform,
    log: quiet,
    journal: {
      durable: async (entries) =>
      {
        if (d.failJournal)
        {
          throw coded('ENOSPC')
        }
        d.journal.push(...entries)
      }
    }
  }
}

function segmentOf(steps: PlacementStep[], jobId: JobId = JOB, execution = 1): PlacementSegment
{
  const found = placementSegments(steps.map((s) => line(jobId, execution, s))).get(segmentKey(jobId, execution))
  if (found === undefined)
  {
    throw new Error('no segment')
  }
  return found[found.length - 1]
}

function write(path: string, text: string): string
{
  writeFileSync(path, text)
  return path
}

function read(path: string): string | null
{
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

async function settle(d: Disk, steps: PlacementStep[], displaced: 'trash' | 'keep' = 'trash', forward = true): Promise<{ verdict: PlacementVerdict; check: PlacementCheck }>
{
  const check = new PlacementCheck(deps(d), segmentOf(steps), displaced)
  return { verdict: await check.settle({ forward }), check }
}

/** A file flow: the output in the work folder, the planned final path, and the source elsewhere. */
function fileFlow(d: Disk, over: Partial<Extract<PlacementStep, { step: 'begin' }>> = {}): Extract<PlacementStep, { step: 'begin' }>
{
  return begin({ output: join(d.work, 'a.part.mp4'), finalPath: join(d.out, 'a.mp4'), source: join(d.src, 'a.mkv'), ...over })
}

describe('PlacementCheck rows', () =>
{
  it('begin: holds the verified output that is still in its work folder and changes nothing', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const { verdict } = await settle(d, [b])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize', outputPath: b.output, keepRenamed: false })
    expect(read(b.output)).toBe('OUT')
    expect(existsSync(b.finalPath)).toBe(false)
  })

  it('any: an output missing everywhere holds with every path named and nothing deleted', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    const claim = await d.fs.reserve(b.finalPath)
    const { verdict } = await settle(d, [b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }])
    expect(verdict.action).toBe('hold')
    const message = verdict.action === 'hold' ? verdict.message : ''
    for (const path of [b.output, b.finalPath, b.source])
    {
      expect(message).toContain(path)
    }
    expect(existsSync(b.finalPath)).toBe(true)
  })

  it('reserve: deletes a reservation that still has its identity and holds the job', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    const { verdict, check } = await settle(d, [b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize', outputPath: b.output })
    expect(existsSync(b.finalPath)).toBe(false)
    expect(check.deleted).toEqual([b.finalPath])
  })

  it('reserve: leaves another file now at the reserved path and names it', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    await rm(b.finalPath)
    write(b.finalPath, 'A USER FILE RENAMED HERE')
    const { verdict, check } = await settle(d, [b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize', keepRenamed: true })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(b.finalPath)
    expect(read(b.finalPath)).toBe('A USER FILE RENAMED HERE')
    expect(check.deleted).toEqual([])
  })

  it('displace: renames the original back from its displaced name and holds the job', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const parkedClaim = await d.fs.reserve(parked)
    const identity = await d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    const { verdict } = await settle(d, [
      b,
      { step: 'reserve', path: parked, role: 'displaced', identity: parkedClaim },
      { step: 'displace', from: b.finalPath, to: parked, identity }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize', outputPath: b.output })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(b.finalPath)
    expect(read(b.finalPath)).toBe('PREVIOUS')
    expect(existsSync(parked)).toBe(false)
  })

  it('displace: a rename that never ran leaves the original in place and deletes the displaced reservation', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const parkedClaim = await d.fs.reserve(parked)
    const { verdict, check } = await settle(d, [
      b,
      { step: 'reserve', path: parked, role: 'displaced', identity: parkedClaim },
      { step: 'displace', from: b.finalPath, to: parked, identity: await d.fs.identity(b.finalPath) }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize' })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain('Nothing at the destination was changed')
    expect(read(b.finalPath)).toBe('PREVIOUS')
    expect(check.deleted).toEqual([parked])
  })

  it('place: rolls forward an output already at its final path', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    renameSync(b.output, b.finalPath)
    const { verdict } = await settle(d, [b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }, { step: 'place', from: b.output, to: b.finalPath }])
    expect(verdict).toEqual({ action: 'done', placed: { finalPath: b.finalPath, placement: { kind: 'new' }, warnings: [], previous: null, completedBy: 'recovery' } })
    expect(d.journal.map((e) => e.step)).toEqual(['done'])
    expect(d.journal[0]).toMatchObject({ jobId: JOB, execution: 1, finalPath: b.finalPath })
  })

  it('place: a run-time rename records the planned name', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    const taken = join(d.out, 'a (2).mp4')
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(taken)
    renameSync(b.output, taken)
    const { verdict } = await settle(d, [b, { step: 'reserve', path: taken, role: 'final', identity: claim }, { step: 'place', from: b.output, to: taken }])
    expect(verdict).toMatchObject({ action: 'done', placed: { finalPath: taken, placement: { kind: 'renamed', planned: b.finalPath } } })
  })

  it('place: a planned rename counts from the template name', async () =>
  {
    const d = disk()
    const planned = join(d.out, 'a (3).mp4')
    const b = fileFlow(d, { mode: 'renamed', finalPath: planned })
    write(b.output, 'OUT')
    renameSync(b.output, planned)
    const { verdict } = await settle(d, [b, { step: 'place', from: b.output, to: planned }])
    expect(verdict).toMatchObject({ action: 'done', placed: { placement: { kind: 'renamed', planned: join(d.out, 'a.mp4') } } })
  })

  it('place: an output still in the work folder rolls back over the claim and holds', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    const { verdict, check } = await settle(d, [b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }, { step: 'place', from: b.output, to: b.finalPath }])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize', outputPath: b.output })
    expect(existsSync(b.finalPath)).toBe(false)
    expect(check.deleted).toEqual([b.finalPath])
  })

  it('place: a replaced original is renamed back over the engine claim at its own path', async () =>
  {
    const d = disk()
    const source = write(join(d.src, 'song.flac'), 'ORIGINAL')
    const b = begin({ output: write(join(d.work, 'song.part.flac'), 'OUT'), finalPath: source, source, flow: 'replace-same-ext', mode: 'replaced-original' })
    const parked = join(d.src, 'song (original).flac')
    const parkedClaim = await d.fs.reserve(parked)
    const identity = await d.fs.identity(source)
    renameSync(source, parked)
    const claim = await d.fs.reserve(source)
    const { verdict } = await settle(d, [
      b,
      { step: 'reserve', path: parked, role: 'displaced', identity: parkedClaim },
      { step: 'displace', from: source, to: parked, identity },
      { step: 'reserve', path: source, role: 'final', identity: claim },
      { step: 'place', from: b.output, to: source }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize' })
    expect(read(source)).toBe('ORIGINAL')
    expect(existsSync(parked)).toBe(false)
    expect(read(b.output)).toBe('OUT')
  })

  it('rollback: finishes a rollback left halfway and holds as file-locked', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const identity = await d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: b.finalPath, to: parked, identity },
      { step: 'rollback', from: parked, to: b.finalPath }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'file-locked', outputPath: b.output })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain('is back at')
    expect(read(b.finalPath)).toBe('PREVIOUS')
  })

  it('rollback: an original already back at its own path holds as file-locked', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: b.finalPath, to: parked, identity: await d.fs.identity(b.finalPath) },
      { step: 'rollback', from: parked, to: b.finalPath }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'file-locked' })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(`${b.finalPath} was open in another program`)
    expect(read(b.finalPath)).toBe('PREVIOUS')
  })

  it('trash: retries the trash of a displaced file still present, then done', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = write(join(d.out, 'a (previous).mp4'), 'PREVIOUS')
    write(b.finalPath, 'OUT')
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: b.finalPath, to: parked, identity: null },
      { step: 'place', from: b.output, to: b.finalPath },
      { step: 'trash', path: parked, role: 'previous' }
    ])
    expect(verdict).toMatchObject({ action: 'done', placed: { placement: { kind: 'overwrote', previous: { status: 'trashed' } }, warnings: [] } })
    expect(d.trash.calls).toEqual([parked])
    expect(read(join(d.bin, basename(parked)))).toBe('PREVIOUS')
    expect(d.journal.map((e) => e.step)).toEqual(['done'])
  })

  it('trash: a refused retry keeps the file with a warning', async () =>
  {
    const d = disk()
    d.trash.refuse = { status: 'kept', reason: 'bin-full', message: 'The bin is full.' }
    const source = join(d.src, 'song.flac')
    const b = begin({ output: join(d.work, 'song.part.flac'), finalPath: source, source, flow: 'replace-same-ext', mode: 'replaced-original' })
    const parked = write(join(d.src, 'song (original).flac'), 'ORIGINAL')
    write(source, 'OUT')
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: source, to: parked, identity: null },
      { step: 'place', from: b.output, to: source },
      { step: 'trash', path: parked, role: 'original' }
    ])
    expect(verdict).toMatchObject({
      action: 'done',
      placed: { placement: { kind: 'replaced-original', original: { status: 'kept', path: parked, reason: 'The bin is full.' } }, warnings: ['original-kept'] }
    })
    expect(read(parked)).toBe('ORIGINAL')
  })

  it('trash: a displaced file already gone means the trash completed before done', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = join(d.out, 'a (previous).mp4')
    write(b.finalPath, 'OUT')
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: b.finalPath, to: parked, identity: null },
      { step: 'place', from: b.output, to: b.finalPath },
      { step: 'trash', path: parked, role: 'previous' }
    ])
    expect(verdict).toMatchObject({ action: 'done', placed: { placement: { kind: 'overwrote', previous: { status: 'trashed' } } } })
    expect(d.trash.calls).toEqual([])
  })

  it('trash: a displaced file gone while the output is not at its final path holds with every path named', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = join(d.out, 'a (previous).mp4')
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: b.finalPath, to: parked, identity: null },
      { step: 'place', from: b.output, to: b.finalPath },
      { step: 'trash', path: parked, role: 'previous' }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize' })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(parked)
  })

  it('done: takes the journaled placement and its kept warnings', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const placement = { kind: 'overwrote' as const, previous: { status: 'kept' as const, path: 'x', reason: 'The bin is full.' } }
    const { verdict, check } = await settle(d, [b, { step: 'done', finalPath: b.finalPath, placement }])
    expect(check.needsDisk()).toBe(false)
    expect(verdict).toEqual({ action: 'done', placed: { finalPath: b.finalPath, placement, warnings: ['previous-kept'], previous: null, completedBy: 'journal' } })
    const kept = { kind: 'replaced-original' as const, original: { status: 'kept' as const, path: 'x', reason: KEPT_BY_POLICY } }
    expect((await settle(d, [b, { step: 'done', finalPath: b.finalPath, placement: kept }])).verdict).toMatchObject({ placed: { warnings: [] } })
  })

  it('any: an original at its displaced name with another file at its own name moves nothing', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const identity = await d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    write(b.finalPath, 'SOMEONE ELSE')
    const { verdict } = await settle(d, [b, { step: 'displace', from: b.finalPath, to: parked, identity }])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize' })
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(parked)
    expect(read(b.finalPath)).toBe('SOMEONE ELSE')
    expect(read(parked)).toBe('PREVIOUS')
  })

  it('any: an original missing from both names moves nothing', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const identity = await d.fs.identity(b.finalPath)
    await rm(b.finalPath)
    const { verdict } = await settle(d, [b, { step: 'displace', from: b.finalPath, to: parked, identity }])
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(`is no longer at ${b.finalPath} or ${parked}`)
  })
})

interface StateLine
{
  type: 'job.state'
  jobId: JobId
  transition: string
  from: JobState
  to: JobState
  reason: StateReason
}

interface FakeCore extends Omit<RecoveryDeps['core'], 'run'>
{
  run(): RunState
  lines: StateLine[]
  alertList: RunAlert[]
  state: { status: RunStatus; runId: RunId | null; pause: RunState['pause']; needsAck: RunState['needsAck'] }
  mode: 'folder' | 'next-to-source' | 'replace-originals'
}

const RUN = 'R-0001' as RunId

function fakeCore(): FakeCore
{
  let next = 1
  const queue = new JobQueue({ numbers: { available: () => 1000, take: () => next++ }, now: () => 1000 })
  const core: FakeCore = {
    queue,
    lines: [],
    alertList: [],
    mode: 'folder',
    state: { status: 'idle', runId: null, pause: null, needsAck: null },
    now: () => 5000,
    transition(id, expectedFrom, trigger, options = {})
    {
      const job = queue.get(id)
      if (job === undefined || !expectedFrom.includes(job.state))
      {
        return { applied: false, job: job ?? null }
      }
      const row = transitionFor(job, trigger)
      if (row === null || row.to === 'removed')
      {
        return { applied: false, job }
      }
      const reason = options.reason ?? row.reasons[0]
      if (!row.reasons.includes(reason))
      {
        throw new Error(`${reason} is not a reason of ${row.id}`)
      }
      const from = job.state
      const updated = queue.update(id, { ...options.change, state: row.to, reason }) as Readonly<Job>
      core.lines.push({ type: 'job.state', jobId: id, transition: row.id, from, to: row.to, reason })
      return { applied: true, job: updated, row, durable: Promise.resolve(true) }
    },
    update: (id, change) => queue.update(id, change),
    interruptActive(reason)
    {
      for (const job of queue.jobs())
      {
        if (job.state === 'analyzing' || job.state === 'encoding' || job.state === 'verifying')
        {
          core.transition(job.id, ['analyzing', 'encoding', 'verifying'], 'interrupt', { reason })
        }
      }
      return []
    },
    run: () => ({ ...core.state }) as unknown as RunState,
    pauseRun(mode, reason)
    {
      if (core.state.status === 'running')
      {
        core.state = { ...core.state, status: 'paused', pause: { mode, reason, since: 5000 } }
        return true
      }
      return core.state.status === 'pausing' || core.state.status === 'paused'
    },
    setNeedsAck: (value) =>
    {
      core.state = { ...core.state, needsAck: value }
    },
    settle()
    {
      if (core.state.status === 'idle')
      {
        return
      }
      if (queue.count('queued') === 0)
      {
        core.state = { status: 'idle', runId: null, pause: null, needsAck: null }
      }
      else if (core.state.status === 'pausing')
      {
        core.state = { ...core.state, status: 'paused' }
      }
    },
    raiseAlert(alert)
    {
      core.alertList = [...core.alertList.filter((a) => a.id !== alert.id), alert]
    },
    clearAlert(id)
    {
      const had = core.alertList.some((a) => a.id === id)
      core.alertList = core.alertList.filter((a) => a.id !== id)
      return had
    },
    globals: () => ({ policy: { destination: { mode: core.mode } } }) as unknown as ReturnType<RecoveryDeps['core']['globals']>
  }
  return core
}

function source(path: string): SourceRef
{
  return { path, name: basename(path), ext: '', dir: '', size: 1, mtimeMs: 1, origin: 'files', subdir: '' } as SourceRef
}

function addJob(core: FakeCore, change: Omit<JobChange, 'source'> & { source?: string } = {}): Readonly<Job>
{
  const { source: path, ...rest } = change
  const [job] = core.queue.add([{ source: source(path ?? join(root, 'src', 'a.mkv')), recipe: { op: 'convert' } as unknown as Recipe }]) ?? []
  return core.queue.update(job.id, { execution: 1, runId: RUN, ...rest }) as Readonly<Job>
}

function policy(displaced: 'trash' | 'keep'): FrozenPolicy
{
  return { displaced, conflict: 'overwrite' } as FrozenPolicy
}

interface Harness
{
  d: Disk
  core: FakeCore
  deps: RecoveryDeps
  placedCalls: Array<{ jobId: JobId; placed: RecoveredPlacement }>
  protects: boolean[]
  compacts: number
  offline: Set<string>
  entries: WorkDirEntry[]
}

function harness(d: Disk = disk(), core: FakeCore = fakeCore()): Harness
{
  const h: Harness = { d, core, placedCalls: [], protects: [], compacts: 0, offline: new Set(), entries: [], deps: null as unknown as RecoveryDeps }
  const volumeOf = (path: string): string => [...h.offline].find((r) => path.startsWith(r)) ?? root
  h.deps = {
    ...deps(d),
    core,
    volumes: { root: async (path) => volumeOf(path), isNetwork: async () => false },
    stat: (path) => ([...h.offline].some((r) => path.startsWith(r)) ? Promise.reject(coded('ENOENT')) : stat(path)),
    timers: realTimers,
    flush: async () => undefined,
    placed: (job, placed) =>
    {
      h.placedCalls.push({ jobId: job.id, placed })
      return { warnings: [] }
    },
    registry: {
      sweep: async (protect) =>
      {
        h.protects = h.entries.map(protect)
        return { results: [], deleted: 0, pending: 0, kept: 0 }
      }
    },
    compact: async () =>
    {
      h.compacts += 1
    }
  }
  return h
}

function states(core: FakeCore): Record<string, JobState>
{
  return Object.fromEntries(core.queue.jobs().map((job) => [job.id, job.state]))
}

describe('recoverEngine', () =>
{
  it.each([
    ['crash', [] as JournalEntry[], false],
    ['quit', [{ type: 'job.state', to: 'interrupted', reason: 'quit' } as JournalEntry], false],
    ['session-end', [{ type: 'job.state', to: 'interrupted', reason: 'session-end' } as JournalEntry], false],
    ['quit', [] as JournalEntry[], true]
  ] as const)('interrupts running jobs with reason %s', async (reason, lines, cleanExit) =>
  {
    const h = harness()
    const ids = (['analyzing', 'encoding', 'verifying'] as const).map((state) => addJob(h.core, { state }).id)
    const done = addJob(h.core, { state: 'done' }).id
    const recovery = await recoverEngine(h.deps, { lines, previous: { pid: 1, startedAt: 1, cleanExit } })
    expect(recovery.report.reason).toBe(reason)
    expect(recovery.report.interrupted).toEqual(ids)
    expect(h.core.lines.map((l) => [l.jobId, l.transition, l.reason])).toEqual(ids.map((id) => [id, 'T31', reason]))
    expect(states(h.core)[done]).toBe('done')
    expect(h.compacts).toBe(1)
  })

  it('places a finalizing job whose output reached its final path (T32) and journals done', async () =>
  {
    const h = harness()
    const b = fileFlow(h.d)
    write(b.finalPath, 'OUT')
    const job = addJob(h.core, { state: 'finalizing', policy: policy('trash') })
    const recovery = await recoverEngine(h.deps, { lines: [line(job.id, 1, b), line(job.id, 1, { step: 'place', from: b.output, to: b.finalPath })], previous: null })
    expect(recovery.report.placed).toEqual([job.id])
    expect(h.core.lines).toEqual([expect.objectContaining({ jobId: job.id, transition: 'T32', to: 'done' })])
    expect(h.placedCalls).toEqual([{ jobId: job.id, placed: expect.objectContaining({ finalPath: b.finalPath, completedBy: 'recovery' }) }])
    expect(h.d.journal).toEqual([expect.objectContaining({ type: 'placement', jobId: job.id, execution: 1, step: 'done' })])
  })

  it('places a job whose done line was written without reading the disk', async () =>
  {
    const h = harness()
    const b = fileFlow(h.d)
    const job = addJob(h.core, { state: 'finalizing', policy: policy('trash') })
    h.offline.add(join(root, 'out'))
    await recoverEngine(h.deps, { lines: [line(job.id, 1, b), line(job.id, 1, { step: 'done', finalPath: b.finalPath, placement: { kind: 'new' } })], previous: null })
    expect(states(h.core)[job.id]).toBe('done')
    expect(h.placedCalls[0].placed.completedBy).toBe('journal')
  })

  it('skips reading a displaced file at a new name on a volume that does not answer', async () =>
  {
    const h = harness()
    const offline = join(root, 'out')
    const b = fileFlow(h.d, { flow: 'replace-new-ext', mode: 'replaced-original' })
    const job = addJob(h.core, { state: 'finalizing', policy: policy('trash') })
    h.offline.add(offline)
    await recoverEngine(h.deps, {
      lines: [
        line(job.id, 1, b),
        line(job.id, 1, { step: 'displace', from: b.finalPath, to: join(offline, 'a (previous).mp4'), identity: null }),
        line(job.id, 1, { step: 'done', finalPath: b.finalPath, placement: { kind: 'replaced-original', original: { status: 'trashed' } } })
      ],
      previous: null
    })
    expect(h.placedCalls[0].placed.previous).toBeNull()
  })

  it('holds a finalizing job by the table with the hold the row decided (T32)', async () =>
  {
    const h = harness()
    const b = fileFlow(h.d)
    write(b.output, 'OUT')
    const job = addJob(h.core, { state: 'finalizing', policy: policy('trash'), plan: { output: { displaces: '/x' } } as unknown as JobPlan })
    const recovery = await recoverEngine(h.deps, { lines: [line(job.id, 1, b)], previous: null })
    expect(recovery.report.held).toEqual([job.id])
    expect(h.core.queue.get(job.id)).toMatchObject({
      state: 'held',
      reason: 'interrupted-finalize',
      hold: { reason: 'interrupted-finalize', outputPath: b.output, displaces: '/x', actions: ['keep', 'discard', 'retry'], since: 5000 }
    })
  })

  it('holds a finalizing job whose placement lines are gone, changing nothing', async () =>
  {
    const h = harness()
    const job = addJob(h.core, { state: 'finalizing', workDir: h.d.work })
    await recoverEngine(h.deps, { lines: [], previous: null })
    expect(h.core.queue.get(job.id)).toMatchObject({ state: 'held', hold: { outputPath: h.d.work } })
  })

  it('fails a held job whose output is gone from a reachable volume (T33) and keeps one whose output is there', async () =>
  {
    const h = harness()
    const present = write(join(h.d.work, 'kept.part.mp4'), 'OUT')
    const hold = (outputPath: string): JobHold => ({ reason: 'file-locked', message: 'm', outputPath, displaces: null, actions: ['keep'], since: 1 })
    const kept = addJob(h.core, { state: 'held', hold: hold(present) }).id
    const gone = addJob(h.core, { state: 'held', hold: hold(join(h.d.work, 'gone.part.mp4')) }).id
    const bare = addJob(h.core, { state: 'held', hold: null }).id
    const recovery = await recoverEngine(h.deps, { lines: [], previous: null })
    expect(recovery.report.missing).toEqual([gone])
    expect(h.core.queue.get(gone)).toMatchObject({ state: 'failed', hold: null, error: { code: 'held-output-missing', fsError: { path: join(h.d.work, 'gone.part.mp4') } } })
    expect(states(h.core)[kept]).toBe('held')
    expect(states(h.core)[bare]).toBe('held')
  })

  it('keeps jobs on an unreachable volume in their state, raises volume-offline, and rechecks once it answers', async () =>
  {
    const h = harness()
    const offline = join(root, 'out')
    h.offline.add(offline)
    const b = fileFlow(h.d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(h.d.out, 'a (previous).mp4')
    const identity = await h.d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    const fin = addJob(h.core, { state: 'finalizing', policy: policy('trash') })
    const held = addJob(h.core, { state: 'held', hold: { reason: 'file-locked', message: 'm', outputPath: join(offline, 'gone.part.mp4'), displaces: null, actions: ['keep'], since: 1 } })
    const lines = [line(fin.id, 1, b), line(fin.id, 1, { step: 'displace', from: b.finalPath, to: parked, identity })]
    const recovery = await recoverEngine(h.deps, { lines, previous: null })
    expect(h.core.queue.get(fin.id)).toMatchObject({ state: 'held', hold: { reason: 'interrupted-finalize', outputPath: b.output } })
    expect(h.core.queue.get(fin.id)?.hold?.message).toContain(volumeLabel(offline, hostPlatform))
    expect(states(h.core)[held.id]).toBe('held')
    expect(read(parked)).toBe('PREVIOUS')
    expect(recovery.deferred()).toEqual([fin.id, held.id])
    expect(recovery.report.offline).toEqual([{ root: offline, label: volumeLabel(offline, hostPlatform), jobIds: [fin.id, held.id] }])
    expect(h.core.alertList.find((a) => a.kind === 'volume-offline')).toMatchObject({ id: `volume-offline:${offline}`, jobIds: [fin.id, held.id], volume: volumeLabel(offline, hostPlatform) })
    expect(h.compacts).toBe(0)

    expect(await recovery.recheck()).toEqual([])
    h.offline.clear()
    expect(await recovery.recheck([fin.id])).toEqual([fin.id])
    expect(read(b.finalPath)).toBe('PREVIOUS')
    expect(h.core.queue.get(fin.id)).toMatchObject({ state: 'held', hold: { reason: 'interrupted-finalize', since: 5000 } })
    expect(h.core.queue.get(fin.id)?.hold?.message).toContain('is back at')
    expect(h.core.alertList.some((a) => a.kind === 'volume-offline')).toBe(true)
    expect(await recovery.recheck()).toEqual([held.id])
    expect(states(h.core)[held.id]).toBe('failed')
    expect(recovery.deferred()).toEqual([])
    expect(h.core.alertList.some((a) => a.kind === 'volume-offline')).toBe(false)
  })

  it('a recheck finds an output already placed and keeps the job held there', async () =>
  {
    const h = harness()
    const offline = join(root, 'out')
    h.offline.add(offline)
    const b = fileFlow(h.d)
    write(b.finalPath, 'OUT')
    const fin = addJob(h.core, { state: 'finalizing', policy: policy('trash') })
    const recovery = await recoverEngine(h.deps, { lines: [line(fin.id, 1, b), line(fin.id, 1, { step: 'place', from: b.output, to: b.finalPath })], previous: null })
    h.offline.clear()
    await recovery.recheck()
    expect(h.core.queue.get(fin.id)).toMatchObject({ state: 'held', hold: { outputPath: b.finalPath } })
    expect(read(b.finalPath)).toBe('OUT')
  })

  it('drops deferred jobs that were decided before the recheck', async () =>
  {
    const h = harness()
    const offline = join(root, 'out')
    h.offline.add(offline)
    const job = addJob(h.core, { state: 'held', hold: { reason: 'file-locked', message: 'm', outputPath: join(offline, 'x'), displaces: null, actions: ['keep'], since: 1 } })
    const recovery = await recoverEngine(h.deps, { lines: [], previous: null })
    h.core.queue.update(job.id, { state: 'canceled', hold: null })
    expect(await recovery.recheck()).toEqual([])
    expect(recovery.deferred()).toEqual([])
    expect(await recovery.recheck([job.id])).toEqual([])
  })

  it('restores the run as paused with reason restored and raises the restored alerts with counts', async () =>
  {
    const h = harness()
    h.core.state = { status: 'running', runId: RUN, pause: null, needsAck: null }
    h.core.mode = 'replace-originals'
    const present = write(join(h.d.src, 'here.flac'), 'SRC')
    const running = addJob(h.core, { state: 'encoding' }).id
    const queued = addJob(h.core, { state: 'queued', source: present, plan: { output: { resolution: 'replace-original' } } as unknown as JobPlan }).id
    const overwrite = addJob(h.core, { state: 'queued', source: present, plan: { output: { resolution: 'overwrite' } } as unknown as JobPlan }).id
    const missing = addJob(h.core, { state: 'pending', source: join(h.d.src, 'gone.flac'), runId: null, plan: { output: { resolution: 'place' } } as unknown as JobPlan }).id
    const b = fileFlow(h.d)
    write(b.output, 'OUT')
    const fin = addJob(h.core, { state: 'finalizing', policy: policy('trash') }).id
    const recovery = await recoverEngine(h.deps, { lines: [line(fin, 1, b)], previous: null })
    expect(recovery.report.pausedRun).toBe(true)
    expect(h.core.state).toMatchObject({ status: 'paused', pause: { reason: 'restored', mode: 'finish-running' }, needsAck: { originalsAffected: 1, overwrites: 1 } })
    const run = h.core.alertList.find((a) => a.kind === 'restored-run')
    expect(run).toMatchObject({ id: 'restored-run', severity: 'warning', jobIds: [running, fin], counts: { interrupted: 1, decisions: 1, queued: 2, restored: 0, missing: 0 } })
    expect(run?.message).toBe('The run was restored after molexMedia restarted and is paused: 1 job was interrupted, 1 output waits for a decision, and 2 jobs are still queued.')
    const queue = h.core.alertList.find((a) => a.kind === 'restored-queue')
    expect(queue).toMatchObject({ severity: 'warning', jobIds: [missing], counts: { restored: 3, queued: 2, missing: 1 } })
    expect(queue?.message).toBe('3 waiting jobs were restored from the last session. 1 source file is missing.')
    expect(states(h.core)[queued]).toBe('queued')
    expect(states(h.core)[overwrite]).toBe('queued')
    expect(h.core.queue.get(missing)?.plan).toBeNull()
    expect(h.core.queue.get(queued)?.plan).not.toBeNull()
  })

  it('names waiting jobs and leaves a source on an unreachable volume uncounted', async () =>
  {
    const h = harness()
    const offline = join(root, 'net')
    h.offline.add(offline)
    const job = addJob(h.core, { state: 'pending', source: join(offline, 'a.flac') }).id
    await recoverEngine(h.deps, { lines: [], previous: null })
    expect(h.core.alertList).toEqual([expect.objectContaining({ kind: 'restored-queue', severity: 'info', jobIds: [job], counts: expect.objectContaining({ restored: 1, missing: 0 }), message: '1 waiting job was restored from the last session.' })])
  })

  it('completes a restored run with nothing left to run and keeps a paused run as it was', async () =>
  {
    const h = harness()
    h.core.state = { status: 'running', runId: RUN, pause: null, needsAck: null }
    addJob(h.core, { state: 'encoding' })
    const recovery = await recoverEngine(h.deps, { lines: [], previous: null })
    expect(h.core.state.status).toBe('idle')
    expect(recovery.report.pausedRun).toBe(false)
    expect(h.core.alertList).toEqual([])

    const p = harness()
    p.core.state = { status: 'paused', runId: RUN, pause: { mode: 'finish-running', reason: 'user', since: 1 }, needsAck: null }
    addJob(p.core, { state: 'queued' })
    const paused = await recoverEngine(p.deps, { lines: [], previous: null })
    expect(paused.report.pausedRun).toBe(false)
    expect(p.core.state.pause?.reason).toBe('user')
    expect(p.core.alertList.find((a) => a.kind === 'restored-run')).toMatchObject({ severity: 'info', message: 'The run was restored after molexMedia restarted and is paused: 1 job is still queued.' })
  })

  it('deletes journaled reservations of unfinished placements only while they keep their identity', async () =>
  {
    const h = harness()
    const old = join(h.d.out, 'old.mp4')
    const replaced = join(h.d.out, 'replaced.mp4')
    const finished = join(h.d.out, 'finished.mp4')
    const oldClaim = await h.d.fs.reserve(old)
    const replacedClaim = await h.d.fs.reserve(replaced)
    await rm(replaced)
    write(replaced, 'USER')
    const finishedClaim = await h.d.fs.reserve(finished)
    const job = addJob(h.core, { state: 'interrupted' }).id
    const recovery = await recoverEngine(h.deps, {
      lines: [
        line(job, 1, fileFlow(h.d)),
        line(job, 1, { step: 'reserve', path: old, role: 'final', identity: oldClaim }),
        line(job, 1, { step: 'reserve', path: replaced, role: 'displaced', identity: replacedClaim }),
        line(job, 2, fileFlow(h.d)),
        line(job, 2, { step: 'reserve', path: finished, role: 'final', identity: finishedClaim }),
        line(job, 2, { step: 'done', finalPath: finished, placement: { kind: 'new' } })
      ],
      previous: null
    })
    expect(recovery.report.reservationsDeleted).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(read(replaced)).toBe('USER')
    expect(existsSync(finished)).toBe(true)
  })

  it('leaves reservations on an unreachable volume alone', async () =>
  {
    const h = harness()
    const claimPath = join(h.d.out, 'a.mp4')
    const claim = await h.d.fs.reserve(claimPath)
    h.offline.add(h.d.out)
    const job = addJob(h.core, { state: 'interrupted' }).id
    await recoverEngine(h.deps, { lines: [line(job, 1, fileFlow(h.d)), line(job, 1, { step: 'reserve', path: claimPath, role: 'final', identity: claim })], previous: null })
    expect(existsSync(claimPath)).toBe(true)
  })

  it('sweeps with the current execution of held and active jobs protected', async () =>
  {
    const h = harness()
    const held = addJob(h.core, { state: 'held', hold: { reason: 'file-locked', message: 'm', outputPath: write(join(h.d.work, 'o'), 'O'), displaces: null, actions: ['keep'], since: 1 }, execution: 3 }).id
    const done = addJob(h.core, { state: 'done' }).id
    const entry = (jobId: JobId, execution: number): WorkDirEntry => ({ path: join(root, `${jobId}-${execution}`), jobId, attempt: 1, execution, token: 't', at: 1 })
    h.entries = [entry(held, 3), entry(held, 2), entry(done, 1), entry('MM-9999' as JobId, 1)]
    const recovery = await recoverEngine(h.deps, { lines: [], previous: null })
    expect(await recovery.report.sweep).toEqual({ results: [], deleted: 0, pending: 0, kept: 0 })
    expect(h.protects).toEqual([true, false, false, false])
  })

  it('logs a failed sweep, a failed compaction, and a failed flush without stopping', async () =>
  {
    const h = harness()
    const warnings: string[] = []
    h.deps.log = { info: () => undefined, warn: (message: string) => warnings.push(message) }
    h.deps.registry = { sweep: () => Promise.reject(new Error('sweep broke')) }
    h.deps.compact = () => Promise.reject(new Error('compact broke'))
    h.deps.flush = () => Promise.reject(new Error('flush broke'))
    addJob(h.core, { state: 'encoding' })
    const recovery = await recoverEngine(h.deps, { lines: [], previous: null })
    expect(await recovery.report.sweep).toBeNull()
    expect(warnings.join('\n')).toMatch(/flush broke[\s\S]*compact broke[\s\S]*sweep broke|flush broke[\s\S]*sweep broke[\s\S]*compact broke/)
  })

  it('never touches legacy temps beside sources', async () =>
  {
    const h = harness()
    const legacy = [
      write(join(h.d.src, 'a_temp_processing.mkv'), 'L1'),
      write(join(h.d.src, 'a_converting_123.mp4'), 'L2'),
      write(join(h.d.src, 'molex2pass-77-0.log'), 'L3')
    ]
    const b = fileFlow(h.d)
    write(b.output, 'OUT')
    const fin = addJob(h.core, { state: 'finalizing', policy: policy('trash') }).id
    const claim = await h.d.fs.reserve(b.finalPath)
    await recoverEngine(h.deps, { lines: [line(fin, 1, b), line(fin, 1, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim })], previous: null })
    expect(legacy.map(read)).toEqual(['L1', 'L2', 'L3'])
  })
})

function tree(dir: string, prefix = ''): string[]
{
  const out: string[] = []
  for (const name of readdirSync(dir).sort())
  {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
    {
      out.push(...tree(path, `${prefix}${name}/`))
    }
    else
    {
      out.push(`${prefix}${name}=${readFileSync(path, 'utf8')}`)
    }
  }
  return out
}

/** Every recovery row at once: the disk as a crash left it, and the jobs and lines a fresh core is built from. */
async function crashScene(d: Disk): Promise<{ lines: JournalEntry[]; build(core: FakeCore): void }>
{
  const parkedOf = (name: string): string => join(d.out, `${name} (previous).mp4`)
  const flow = (name: string, over: Partial<Extract<PlacementStep, { step: 'begin' }>> = {}): Extract<PlacementStep, { step: 'begin' }> =>
    begin({ output: join(d.work, `${name}.part.mp4`), finalPath: join(d.out, `${name}.mp4`), source: join(d.src, `${name}.mkv`), ...over })
  const lines: JournalEntry[] = []
  const ids = Array.from({ length: 9 }, (_, i) => `MM-000${i + 1}` as JobId)
  const add = (n: number, steps: PlacementStep[]): void =>
  {
    lines.push(...steps.map((s) => line(ids[n], 1, s)))
  }

  const beginOnly = flow('begin-only')
  write(beginOnly.output, 'B')
  add(0, [beginOnly])

  const reserved = flow('reserved')
  write(reserved.output, 'R')
  add(1, [reserved, { step: 'reserve', path: reserved.finalPath, role: 'final', identity: await d.fs.reserve(reserved.finalPath) }])

  const foreign = flow('foreign')
  write(foreign.output, 'F')
  const foreignClaim = await d.fs.reserve(foreign.finalPath)
  await rm(foreign.finalPath)
  write(foreign.finalPath, 'USER')
  add(2, [foreign, { step: 'reserve', path: foreign.finalPath, role: 'final', identity: foreignClaim }])

  const displaced = flow('displaced', { flow: 'overwrite', mode: 'overwrote' })
  write(displaced.output, 'D')
  write(displaced.finalPath, 'D-PREVIOUS')
  const displacedId = await d.fs.identity(displaced.finalPath)
  renameSync(displaced.finalPath, parkedOf('displaced'))
  add(3, [displaced, { step: 'displace', from: displaced.finalPath, to: parkedOf('displaced'), identity: displacedId }])

  const forward = flow('forward', { flow: 'overwrite', mode: 'overwrote' })
  write(parkedOf('forward'), 'F-PREVIOUS')
  write(forward.finalPath, 'F-OUT')
  add(4, [forward, { step: 'displace', from: forward.finalPath, to: parkedOf('forward'), identity: null }, { step: 'place', from: forward.output, to: forward.finalPath }])

  const trashed = flow('trashed', { flow: 'overwrite', mode: 'overwrote' })
  write(trashed.finalPath, 'T-OUT')
  add(5, [trashed, { step: 'displace', from: trashed.finalPath, to: parkedOf('trashed'), identity: null }, { step: 'place', from: trashed.output, to: trashed.finalPath }, { step: 'trash', path: parkedOf('trashed'), role: 'previous' }])

  const rolled = flow('rolled', { flow: 'overwrite', mode: 'overwrote' })
  write(rolled.output, 'RB')
  write(rolled.finalPath, 'RB-PREVIOUS')
  const rolledId = await d.fs.identity(rolled.finalPath)
  renameSync(rolled.finalPath, parkedOf('rolled'))
  add(6, [rolled, { step: 'displace', from: rolled.finalPath, to: parkedOf('rolled'), identity: rolledId }, { step: 'rollback', from: parkedOf('rolled'), to: rolled.finalPath }])

  const lost = flow('lost')
  add(7, [lost])

  const done = flow('done')
  write(done.finalPath, 'DONE')
  add(8, [done, { step: 'done', finalPath: done.finalPath, placement: { kind: 'new' } }])

  write(join(d.src, 'begin-only_temp_processing.mkv'), 'LEGACY')
  return {
    lines,
    build(core: FakeCore): void
    {
      core.state = { status: 'running', runId: RUN, pause: null, needsAck: null }
      for (let i = 0; i < ids.length; i += 1)
      {
        expect(addJob(core, { state: 'finalizing', policy: policy('trash') }).id).toBe(ids[i])
      }
      addJob(core, { state: 'encoding' })
      addJob(core, { state: 'queued' })
    }
  }
}

describe('recoverEngine reruns', () =>
{
  it('settles every row of the table and changes nothing when run again', async () =>
  {
    const h = harness()
    const scene = await crashScene(h.d)
    scene.build(h.core)
    const first = await recoverEngine(h.deps, { lines: scene.lines, previous: null })
    expect(Object.values(states(h.core))).toEqual(['held', 'held', 'held', 'held', 'done', 'done', 'held', 'failed', 'done', 'interrupted', 'queued'])
    expect(h.core.queue.jobs().map((job) => job.hold?.reason ?? null)).toEqual(
      ['interrupted-finalize', 'interrupted-finalize', 'interrupted-finalize', 'interrupted-finalize', null, null, 'file-locked', null, null, null, null]
    )
    expect(first.report.placed).toEqual(['MM-0005', 'MM-0006', 'MM-0009'])
    expect(h.placedCalls.map((c) => c.placed.placement)).toEqual([
      { kind: 'overwrote', previous: { status: 'trashed' } },
      { kind: 'overwrote', previous: { status: 'trashed' } },
      { kind: 'new' }
    ])
    const disk = tree(root)
    expect(disk).toEqual(expect.arrayContaining([
      'out/displaced.mp4=D-PREVIOUS', 'out/foreign.mp4=USER', 'out/forward.mp4=F-OUT', 'out/rolled.mp4=RB-PREVIOUS', 'bin/forward (previous).mp4=F-PREVIOUS',
      'src/begin-only_temp_processing.mkv=LEGACY'
    ]))
    expect(disk.some((f) => f.startsWith('out/reserved.mp4'))).toBe(false)
    expect(first.report.pausedRun).toBe(true)
    const alerts = h.core.alertList

    const lines = [...scene.lines, ...h.d.journal, ...h.core.lines] as JournalEntry[]
    const transitions = h.core.lines.length
    const written = h.d.journal.length
    const trashCalls = h.d.trash.calls.length
    const again = await recoverEngine(h.deps, { lines, previous: { pid: 1, startedAt: 1, cleanExit: false } })
    expect(h.core.lines.length).toBe(transitions)
    expect(h.d.journal.length).toBe(written)
    expect(h.d.trash.calls.length).toBe(trashCalls)
    expect(tree(root)).toEqual(disk)
    expect(again.report).toMatchObject({ interrupted: [], placed: [], held: [], missing: [], reservationsDeleted: [] })
    expect(h.core.alertList).toEqual(alerts)
  })

  it('reruns safely after a crash between the trash and the done line', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = write(join(d.out, 'a (previous).mp4'), 'PREVIOUS')
    write(b.finalPath, 'OUT')
    const job = 'MM-0001' as JobId
    const lines = [line(job, 1, b), line(job, 1, { step: 'displace', from: b.finalPath, to: parked, identity: null }), line(job, 1, { step: 'place', from: b.output, to: b.finalPath })]
    const crashed = harness(d)
    addJob(crashed.core, { state: 'finalizing', policy: policy('trash') })
    let reached: () => void = () => undefined
    const atDone = new Promise<void>((resolve) =>
    {
      reached = resolve
    })
    crashed.deps.journal = {
      durable: (entries) =>
      {
        if (entries.some((e) => e.step === 'done'))
        {
          reached()
          return new Promise(() => undefined)
        }
        d.journal.push(...entries)
        return Promise.resolve()
      }
    }
    void recoverEngine(crashed.deps, { lines, previous: null })
    await atDone
    expect(d.journal.map((e) => e.step)).toEqual(['trash'])
    expect(existsSync(parked)).toBe(false)

    const restarted = harness(d)
    addJob(restarted.core, { state: 'finalizing', policy: policy('trash') })
    await recoverEngine(restarted.deps, { lines: [...lines, ...d.journal], previous: null })
    expect(states(restarted.core)[job]).toBe('done')
    expect(restarted.placedCalls[0].placed.placement).toEqual({ kind: 'overwrote', previous: { status: 'trashed' } })
    expect(d.trash.calls).toEqual([parked])
  })

  it('reruns safely after a crash between renaming an original back and the hold line', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const identity = await d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    const job = 'MM-0001' as JobId
    const lines = [line(job, 1, b), line(job, 1, { step: 'displace', from: b.finalPath, to: parked, identity })]
    const crashed = harness(d)
    addJob(crashed.core, { state: 'finalizing', policy: policy('trash') })
    let reached: () => void = () => undefined
    const atHold = new Promise<void>((resolve) =>
    {
      reached = resolve
    })
    const transition = crashed.core.transition
    crashed.core.transition = (...args) =>
    {
      const result = transition(...args)
      reached()
      return result.applied ? { ...result, durable: new Promise<boolean>(() => undefined) } : result
    }
    void recoverEngine(crashed.deps, { lines, previous: null })
    await atHold
    expect(read(b.finalPath)).toBe('PREVIOUS')

    const restarted = harness(d)
    addJob(restarted.core, { state: 'finalizing', policy: policy('trash') })
    await recoverEngine(restarted.deps, { lines, previous: null })
    expect(restarted.core.queue.get(job)).toMatchObject({ state: 'held', hold: { reason: 'interrupted-finalize', outputPath: b.output } })
    expect(read(b.finalPath)).toBe('PREVIOUS')
    expect(read(b.output)).toBe('OUT')
    expect(existsSync(parked)).toBe(false)
  })
})

describe('PlacementCheck flows', () =>
{
  it('copy: rolls forward a journaled copy already renamed over the claim', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    const copy = write(join(d.out, 'w-a.part.mp4'), 'OUT')
    const copyId = await d.fs.identity(copy)
    renameSync(copy, b.finalPath)
    const { verdict } = await settle(d, [
      b,
      { step: 'reserve', path: b.finalPath, role: 'final', identity: claim },
      { step: 'place', from: b.output, to: b.finalPath },
      { step: 'copy', from: b.output, to: copy },
      { step: 'reserve', path: copy, role: 'copy', identity: copyId as NonNullable<typeof copyId> }
    ])
    expect(verdict).toMatchObject({ action: 'done', placed: { finalPath: b.finalPath, placement: { kind: 'new' } } })
  })

  it('copy: deletes a finished copy not yet renamed and the claim, and holds', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    const copy = write(join(d.out, 'w-a.part.mp4'), 'OUT')
    const copyId = await d.fs.identity(copy)
    const { verdict, check } = await settle(d, [
      b,
      { step: 'reserve', path: b.finalPath, role: 'final', identity: claim },
      { step: 'place', from: b.output, to: b.finalPath },
      { step: 'copy', from: b.output, to: copy },
      { step: 'reserve', path: copy, role: 'copy', identity: copyId as NonNullable<typeof copyId> }
    ])
    expect(verdict).toMatchObject({ action: 'hold', reason: 'interrupted-finalize' })
    expect(check.deleted.sort()).toEqual([b.finalPath, copy].sort())
    expect(read(b.output)).toBe('OUT')
  })

  it('replace with a new extension: trashes the previous file at the new name and the original', async () =>
  {
    const d = disk()
    const source = write(join(d.src, 'song.wav'), 'ORIGINAL')
    const finalPath = join(d.src, 'song.flac')
    const parked = write(join(d.src, 'song (previous).flac'), 'PREVIOUS')
    write(finalPath, 'OUT')
    const b = begin({ output: join(d.work, 'song.part.flac'), finalPath, source, flow: 'replace-new-ext', mode: 'replaced-original' })
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: finalPath, to: parked, identity: null },
      { step: 'place', from: b.output, to: finalPath }
    ])
    expect(verdict).toMatchObject({ action: 'done', placed: { placement: { kind: 'replaced-original', original: { status: 'trashed' } }, previous: { status: 'trashed' }, warnings: [] } })
    expect(d.trash.calls).toEqual([parked, source])
    expect(d.journal.map((e) => e.step)).toEqual(['trash', 'trash', 'done'])
  })

  it('replace with a new extension: a done line reads the previous file at the new name', async () =>
  {
    const d = disk()
    const source = join(d.src, 'song.wav')
    const finalPath = join(d.src, 'song.flac')
    const parked = join(d.src, 'song (previous).flac')
    const b = begin({ output: join(d.work, 'song.part.flac'), finalPath, source, flow: 'replace-new-ext', mode: 'replaced-original' })
    const steps: PlacementStep[] = [
      b,
      { step: 'displace', from: finalPath, to: parked, identity: null },
      { step: 'done', finalPath, placement: { kind: 'replaced-original', original: { status: 'trashed' } } }
    ]
    expect((await settle(d, steps)).verdict).toMatchObject({ placed: { previous: { status: 'trashed' }, warnings: [] } })
    write(parked, 'PREVIOUS')
    expect((await settle(d, steps)).verdict).toMatchObject({ placed: { previous: { status: 'kept', path: parked }, warnings: ['previous-kept'] } })
    expect((await settle(d, steps, 'keep')).verdict).toMatchObject({ placed: { previous: { status: 'kept', reason: KEPT_BY_POLICY }, warnings: [] } })
  })

  it('keep policy: rolls forward without trashing and records the files as kept by policy', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = write(join(d.out, 'a (previous).mp4'), 'PREVIOUS')
    write(b.finalPath, 'OUT')
    const { verdict } = await settle(d, [b, { step: 'displace', from: b.finalPath, to: parked, identity: null }, { step: 'place', from: b.output, to: b.finalPath }], 'keep')
    expect(verdict).toMatchObject({ placed: { placement: { kind: 'overwrote', previous: { status: 'kept', path: parked, reason: KEPT_BY_POLICY } }, warnings: [] } })
    expect(d.trash.calls).toEqual([])
  })

  it('trash: a trash refused before the last step is not retried', async () =>
  {
    const d = disk()
    const source = write(join(d.src, 'song.wav'), 'ORIGINAL')
    const finalPath = join(d.src, 'song.flac')
    const parked = write(join(d.src, 'song (previous).flac'), 'PREVIOUS')
    write(finalPath, 'OUT')
    const b = begin({ output: join(d.work, 'song.part.flac'), finalPath, source, flow: 'replace-new-ext', mode: 'replaced-original' })
    const { verdict } = await settle(d, [
      b,
      { step: 'displace', from: finalPath, to: parked, identity: null },
      { step: 'place', from: b.output, to: finalPath },
      { step: 'trash', path: parked, role: 'previous' },
      { step: 'trash', path: source, role: 'original' }
    ])
    expect(verdict).toMatchObject({ placed: { previous: { status: 'kept', path: parked }, placement: { original: { status: 'trashed' } }, warnings: ['previous-kept'] } })
    expect(d.trash.calls).toEqual([source])
  })

  it('trash: a throwing trash, a bin-less volume, and unsaved lines still finish the placement', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    const parked = write(join(d.out, 'a (previous).mp4'), 'PREVIOUS')
    write(b.finalPath, 'OUT')
    const steps: PlacementStep[] = [b, { step: 'displace', from: b.finalPath, to: parked, identity: null }, { step: 'place', from: b.output, to: b.finalPath }]
    d.trash.error = new Error('shell refused')
    expect((await settle(d, steps)).verdict).toMatchObject({ placed: { placement: { previous: { status: 'kept', reason: 'The file could not be moved to the bin: shell refused' } }, warnings: ['previous-kept'] } })
    d.trash.error = null
    d.trash.refuse = { status: 'kept', reason: 'no-recycle-bin', message: 'This drive has no bin.' }
    expect((await settle(d, steps)).verdict).toMatchObject({ placed: { placement: { previous: { status: 'kept', reason: 'This drive has no bin.' } }, warnings: [] } })
    d.failJournal = true
    expect((await settle(d, steps)).verdict).toMatchObject({ placed: { placement: { previous: { status: 'kept', reason: expect.stringContaining('ENOSPC') } }, warnings: ['previous-kept'] } })
    expect(read(parked)).toBe('PREVIOUS')
    const fresh = fileFlow(d, { finalPath: join(d.out, 'fresh.mp4') })
    write(fresh.finalPath, 'OUT')
    expect((await settle(d, [fresh, { step: 'place', from: fresh.output, to: fresh.finalPath }])).verdict).toMatchObject({ action: 'done', placed: { placement: { kind: 'new' } } })
  })

  it('rollback failures name the paths and keep both files', async () =>
  {
    const d = disk()
    const b = fileFlow(d, { flow: 'overwrite', mode: 'overwrote' })
    write(b.output, 'OUT')
    write(b.finalPath, 'PREVIOUS')
    const parked = join(d.out, 'a (previous).mp4')
    const identity = await d.fs.identity(b.finalPath)
    renameSync(b.finalPath, parked)
    const fs: FsOps = { ...d.fs, rename: () => Promise.reject(coded('EBUSY')) }
    const check = new PlacementCheck({ ...deps(d), fs }, segmentOf([b, { step: 'displace', from: b.finalPath, to: parked, identity }]), 'trash')
    const verdict = await check.settle()
    expect(verdict.action === 'hold' ? verdict.message : '').toContain(`could not be renamed back to ${b.finalPath}`)
    expect(read(parked)).toBe('PREVIOUS')
  })

  it('a reservation that cannot be deleted is logged and left', async () =>
  {
    const d = disk()
    const b = fileFlow(d)
    write(b.output, 'OUT')
    const claim = await d.fs.reserve(b.finalPath)
    const warnings: string[] = []
    const fs: FsOps = { ...d.fs, unlink: () => Promise.reject(coded('EPERM')) }
    const check = new PlacementCheck({ ...deps(d), fs, log: { info: () => undefined, warn: (m: string) => warnings.push(m) } }, segmentOf([b, { step: 'reserve', path: b.finalPath, role: 'final', identity: claim }]), 'trash')
    await check.settle()
    expect(check.deleted).toEqual([])
    expect(warnings).toEqual([expect.stringContaining(b.finalPath)])
    expect(existsSync(b.finalPath)).toBe(true)
  })
})
