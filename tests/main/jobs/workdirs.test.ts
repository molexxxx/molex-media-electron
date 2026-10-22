import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { Platform } from '../../../src/shared/text/platform'
import type { Timers } from '../../../src/main/timers'
import type { FsOps, PersistenceIO } from '../../../src/main/jobs/deps'
import { createFsOps } from '../../../src/main/jobs/fsops'
import type { ProcessRunner } from '../../../src/main/jobs/fsops'
import { createNodePersistenceIO, jsonLine, parseJsonLines } from '../../../src/main/jobs/persistence'
import {
  WorkDirRegistry,
  createNodeWorkDirFiles,
  parseMarker,
  parseWorkDirLine
} from '../../../src/main/jobs/workdirs'
import type { RegistryWriter, SweepReport, WorkDirEntry, WorkDirFiles, WorkDirRegistryOptions } from '../../../src/main/jobs/workdirs'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) =>
{
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock }
})

const host: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

const A = 'MM-0001' as JobId
const B = 'MM-0002' as JobId

function instantTimers(start = 1_000): Timers & { slept: number[] }
{
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    setTimeout: () => null,
    clearTimeout: () => undefined,
    sleep: async (ms: number): Promise<void> =>
    {
      slept.push(ms)
      now += ms
    }
  }
}

function coded(message: string, code: string): Error
{
  return Object.assign(new Error(message), { code })
}

function fails(message: string, code: string): () => Promise<never>
{
  return () => Promise.reject(coded(message, code))
}

interface TestWriter extends RegistryWriter
{
  failDurable: boolean
  failPlain: boolean
}

function makeWriter(io: PersistenceIO, events: string[]): TestWriter
{
  const writer: TestWriter = {
    failDurable: false,
    failPlain: false,
    async appendLines(path: string, values: readonly unknown[], durable = false): Promise<void>
    {
      if (durable ? writer.failDurable : writer.failPlain)
      {
        events.push('append-failed')
        throw coded('No space left on the device', 'ENOSPC')
      }
      await io.append(path, values.map(jsonLine).join(''))
      if (durable)
      {
        events.push('append')
        await io.fsync(path)
        events.push('fsync')
      }
      else
      {
        events.push('append-plain')
      }
    }
  }
  return writer
}

interface Env
{
  root: string
  registryPath: string
  dest: string
  events: string[]
  io: PersistenceIO
  writer: TestWriter
  run: ReturnType<typeof vi.fn<ProcessRunner>>
  fs: Pick<FsOps, 'mkdir' | 'removeTree' | 'setHidden'>
  timers: ReturnType<typeof instantTimers>
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  tokens: number
}

let env: Env

function makeEnv(): Env
{
  const root = mkdtempSync(join(tmpdir(), 'molex-workdirs-'))
  const jobsDir = join(root, 'jobs')
  const dest = join(root, 'dest')
  mkdirSync(jobsDir)
  mkdirSync(dest)
  const events: string[] = []
  const io = createNodePersistenceIO()
  const run = vi.fn<ProcessRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
  const real = createFsOps({ platform: host, run, systemRoot: 'C:\\Windows' })
  const fs: Env['fs'] = {
    async mkdir(path: string): Promise<void>
    {
      events.push('mkdir')
      await real.mkdir(path)
    },
    removeTree: (path) => real.removeTree(path),
    setHidden(path: string): Promise<void>
    {
      events.push('hide')
      return real.setHidden(path)
    }
  }
  return {
    root,
    registryPath: join(jobsDir, 'workdirs.jsonl'),
    dest,
    events,
    io,
    writer: makeWriter(io, events),
    run,
    fs,
    timers: instantTimers(),
    log: { info: vi.fn(), warn: vi.fn() },
    tokens: 0
  }
}

function makeRegistry(overrides: Partial<WorkDirRegistryOptions> = {}): WorkDirRegistry
{
  return new WorkDirRegistry({
    path: env.registryPath,
    platform: host,
    io: env.io,
    writer: env.writer,
    fs: env.fs,
    timers: env.timers,
    ids: { token: () => (++env.tokens).toString(16).padStart(16, '0') },
    log: env.log,
    ...overrides
  })
}

function folder(jobId: string, attempt: number, execution: number): string
{
  return join(env.dest, `.molex-${jobId}-a${attempt}-x${execution}.partial`)
}

function registryLines(): unknown[]
{
  return existsSync(env.registryPath) ? parseJsonLines(readFileSync(env.registryPath, 'utf8')).values : []
}

function entry(jobId: JobId, attempt: number, execution: number, token: string): WorkDirEntry
{
  return { path: folder(jobId, attempt, execution), jobId, attempt, execution, token, at: 500 }
}

interface Memory
{
  dirs: Set<string>
  texts: Map<string, string>
  files: WorkDirFiles
  fs: Pick<FsOps, 'mkdir' | 'removeTree'> & { setHidden: ReturnType<typeof vi.fn<FsOps['setHidden']>> }
}

function memory(): Memory
{
  const dirs = new Set<string>()
  const texts = new Map<string, string>()
  const files: WorkDirFiles = {
    readText: async (path) => texts.get(path) ?? null,
    async writeNew(path: string, text: string): Promise<void>
    {
      if (texts.has(path))
      {
        throw coded('exists', 'EEXIST')
      }
      texts.set(path, text)
    },
    kind: async (path) => dirs.has(path) ? 'dir' : texts.has(path) ? 'other' : 'missing',
    list: async () => [],
    removeEmpty: async (dir) =>
    {
      dirs.delete(dir)
    }
  }
  const fs: Memory['fs'] = {
    mkdir: async (path) =>
    {
      dirs.add(path)
    },
    removeTree: async (path) =>
    {
      dirs.delete(path)
    },
    setHidden: vi.fn<FsOps['setHidden']>(async () => undefined)
  }
  return { dirs, texts, files, fs }
}

function writeRegistry(lines: readonly unknown[], tail = ''): void
{
  writeFileSync(env.registryPath, lines.map(jsonLine).join('') + tail)
}

beforeEach(() =>
{
  env = makeEnv()
})

afterEach(() =>
{
  rmSync(env.root, { recursive: true, force: true })
})

describe('parseWorkDirLine', () =>
{
  it('reads create and deleted lines', () =>
  {
    const line = { op: 'create', path: '/d/.molex-MM-0001-a1-x1.partial', jobId: A, attempt: 1, execution: 1, token: 'ab', at: 5 }
    expect(parseWorkDirLine(line)).toEqual(line)
    expect(parseWorkDirLine({ op: 'deleted', path: '/d/x' })).toEqual({ op: 'deleted', path: '/d/x' })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing path', { op: 'deleted' }],
    ['an empty path', { op: 'deleted', path: '' }],
    ['an unknown op', { op: 'moved', path: '/d/x' }],
    ['a missing job', { op: 'create', path: '/d/x', attempt: 1, execution: 1, token: 'ab', at: 5 }],
    ['attempt zero', { op: 'create', path: '/d/x', jobId: A, attempt: 0, execution: 1, token: 'ab', at: 5 }],
    ['a fractional execution', { op: 'create', path: '/d/x', jobId: A, attempt: 1, execution: 1.5, token: 'ab', at: 5 }],
    ['an empty token', { op: 'create', path: '/d/x', jobId: A, attempt: 1, execution: 1, token: '', at: 5 }],
    ['a text time', { op: 'create', path: '/d/x', jobId: A, attempt: 1, execution: 1, token: 'ab', at: '5' }],
    ['an infinite time', { op: 'create', path: '/d/x', jobId: A, attempt: 1, execution: 1, token: 'ab', at: Infinity }]
  ])('refuses %s', (_name, value) =>
  {
    expect(parseWorkDirLine(value)).toBeNull()
  })
})

describe('parseMarker', () =>
{
  const marker = { jobId: A, attempt: 1, execution: 2, token: 'ab', source: '/s/a.mkv', finalPath: '/d/a.mp4', createdAt: 5 }

  it('reads a marker', () =>
  {
    expect(parseMarker(JSON.stringify(marker))).toEqual(marker)
  })

  it.each([
    ['text that is not JSON', '{'],
    ['an array', '[]'],
    ['a missing token', JSON.stringify({ ...marker, token: undefined })],
    ['a numeric source', JSON.stringify({ ...marker, source: 1 })],
    ['a missing final path', JSON.stringify({ ...marker, finalPath: undefined })],
    ['a text creation time', JSON.stringify({ ...marker, createdAt: '5' })],
    ['execution zero', JSON.stringify({ ...marker, execution: 0 })]
  ])('refuses %s', (_name, text) =>
  {
    expect(parseMarker(text)).toBeNull()
  })
})

describe('createNodeWorkDirFiles', () =>
{
  const files = createNodeWorkDirFiles()

  it('reads, writes once, lists, and removes empty folders', async () =>
  {
    const dir = join(env.dest, 'box')
    mkdirSync(dir)
    const file = join(dir, 'job.json')
    expect(await files.readText(file)).toBeNull()
    await files.writeNew(file, 'one')
    await expect(files.writeNew(file, 'two')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await files.readText(file)).toBe('one')
    expect(await files.list(dir)).toEqual(['job.json'])
    await expect(files.removeEmpty(dir)).rejects.toBeTruthy()
    rmSync(file)
    await files.removeEmpty(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('tells folders, files, and missing paths apart', async () =>
  {
    const file = join(env.dest, 'a.txt')
    writeFileSync(file, 'x')
    expect(await files.kind(env.dest)).toBe('dir')
    expect(await files.kind(file)).toBe('other')
    expect(await files.kind(join(env.dest, 'none'))).toBe('missing')
    expect(await files.kind(join(file, 'below'))).toBe('missing')
  })

  it('passes other failures on', async () =>
  {
    await expect(files.readText(env.dest)).rejects.toBeTruthy()
    await expect(files.kind(`${env.dest}\0bad`)).rejects.toBeTruthy()
  })
})

describe('load', () =>
{
  it('starts empty without a registry and creates no file', async () =>
  {
    const registry = makeRegistry()
    const loaded = await registry.load()
    expect(loaded).toEqual({ entries: [], kept: [], floors: new Map(), skipped: 0, rewritten: false })
    expect(existsSync(env.registryPath)).toBe(false)
    expect(registry.list()).toEqual([])
    expect(registry.highestExecution(A)).toBe(0)
    expect(registry.nextExecution(A, 0)).toBe(1)
  })

  it('replays the lines and rewrites the live entries with each deleted floor', async () =>
  {
    const a1 = entry(A, 1, 1, 'a1')
    const a2 = entry(A, 1, 2, 'a2')
    const b1 = entry(B, 1, 1, 'b1')
    writeFileSync(env.registryPath, [
      jsonLine({ op: 'create', ...a1 }),
      jsonLine({ op: 'create', ...a2 }),
      jsonLine({ op: 'deleted', path: a2.path }),
      'not json\n',
      jsonLine({ op: 'create', ...b1, attempt: 0 }),
      jsonLine({ op: 'create', ...b1 }),
      '{"op":"create","pa'
    ].join(''))
    const registry = makeRegistry()
    const loaded = await registry.load()
    expect(loaded.entries).toEqual([a1, b1])
    expect(loaded.kept).toEqual([])
    expect(loaded.floors).toEqual(new Map([[A, 2], [B, 1]]))
    expect(loaded.skipped).toBe(3)
    expect(loaded.rewritten).toBe(true)
    expect(registryLines()).toEqual([
      { op: 'create', ...a2 },
      { op: 'deleted', path: a2.path },
      { op: 'create', ...a1 },
      { op: 'create', ...b1 }
    ])
    expect(registry.list()).toEqual([a1, b1])
    expect(registry.highestExecution(A)).toBe(2)
    expect(registry.nextExecution(A, 1)).toBe(3)
    expect(registry.nextExecution(A, 5)).toBe(6)
  })

  it('keeps the floors of known jobs only', async () =>
  {
    const a1 = entry(A, 1, 1, 'a1')
    const b1 = entry(B, 1, 1, 'b1')
    writeRegistry([{ op: 'create', ...a1 }, { op: 'deleted', path: a1.path }, { op: 'create', ...b1 }, { op: 'deleted', path: b1.path }])
    const loaded = await makeRegistry().load({ knownJob: (jobId) => jobId === B })
    expect(loaded.entries).toEqual([])
    expect(loaded.floors).toEqual(new Map([[A, 1], [B, 1]]))
    expect(registryLines()).toEqual([{ op: 'create', ...b1 }, { op: 'deleted', path: b1.path }])
  })

  it('keeps every loaded folder for the session after an empty start', async () =>
  {
    const a1 = entry(A, 1, 1, 'a1')
    writeRegistry([{ op: 'create', ...a1 }])
    const loaded = await makeRegistry().load({ emptyStart: true })
    expect(loaded.kept).toEqual([a1])
  })

  it('ends a torn file with a newline when the rewrite fails', async () =>
  {
    const a1 = entry(A, 1, 1, 'a1')
    writeRegistry([{ op: 'create', ...a1 }], '{"op":"cre')
    const io: PersistenceIO = { ...env.io, writeAtomic: fails('denied', 'EACCES') }
    const registry = makeRegistry({ io })
    const loaded = await registry.load()
    expect(loaded.rewritten).toBe(false)
    expect(loaded.entries).toEqual([a1])
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not rewrite'))
    const b1 = entry(B, 1, 1, 'b1')
    await env.writer.appendLines(env.registryPath, [{ op: 'create', ...b1 }], true)
    expect(registryLines()).toEqual([{ op: 'create', ...a1 }, { op: 'create', ...b1 }])
  })

  it('leaves a whole file alone when the rewrite fails', async () =>
  {
    writeRegistry([{ op: 'create', ...entry(A, 1, 1, 'a1') }])
    const append = vi.fn(async () => undefined)
    const io: PersistenceIO = { ...env.io, append, writeAtomic: fails('denied', 'EACCES') }
    expect((await makeRegistry({ io }).load()).rewritten).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('starts empty and never rewrites a registry it cannot read', async () =>
  {
    const writeAtomic = vi.fn(async () => undefined)
    const io: PersistenceIO = { ...env.io, writeAtomic, read: fails('denied', 'EACCES') }
    const loaded = await makeRegistry({ io }).load()
    expect(loaded.entries).toEqual([])
    expect(loaded.rewritten).toBe(false)
    expect(writeAtomic).not.toHaveBeenCalled()
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not read'))
  })
})

describe('create', () =>
{
  function request(execution = 1, jobId: JobId = A): { jobId: JobId; attempt: number; execution: number; source: string; finalPath: string }
  {
    return { jobId, attempt: 1, execution, source: join(env.root, 'a.mkv'), finalPath: join(env.dest, 'a.mp4') }
  }

  it('makes the create line durable before the folder exists', async () =>
  {
    const path = folder(A, 1, 1)
    const existedAfterSync: boolean[] = []
    const writer: RegistryWriter = {
      async appendLines(target, values, durable): Promise<void>
      {
        await env.writer.appendLines(target, values, durable)
        existedAfterSync.push(existsSync(path))
      }
    }
    const registry = makeRegistry({ writer })
    await registry.load()
    const result = await registry.create(request())
    const created = { path, jobId: A, attempt: 1, execution: 1, token: '0000000000000001', at: 1_000 }
    expect(result).toEqual({ status: 'created', path, entry: created })
    expect(existedAfterSync).toEqual([false])
    expect(env.events.slice(0, 3)).toEqual(['append', 'fsync', 'mkdir'])
    expect(registryLines()).toEqual([{ op: 'create', ...created }])
    expect(JSON.parse(readFileSync(join(path, 'job.json'), 'utf8'))).toEqual({
      jobId: A,
      attempt: 1,
      execution: 1,
      token: '0000000000000001',
      source: join(env.root, 'a.mkv'),
      finalPath: join(env.dest, 'a.mp4'),
      createdAt: 1_000
    })
    expect(registry.list()).toEqual([created])
    expect(registry.highestExecution(A)).toBe(1)
  })

  it('creates no folder when the create line cannot be made durable', async () =>
  {
    const registry = makeRegistry()
    await registry.load()
    env.writer.failDurable = true
    const result = await registry.create(request())
    expect(result).toMatchObject({ status: 'storage-failed', path: folder(A, 1, 1), error: { code: 'ENOSPC' } })
    expect(existsSync(folder(A, 1, 1))).toBe(false)
    expect(env.events).toEqual(['append-failed'])
    expect(registry.list()).toEqual([])
    expect(registry.highestExecution(A)).toBe(1)
    env.writer.failDurable = false
    expect((await registry.create(request(registry.nextExecution(A, 0)))).status).toBe('created')
    expect(existsSync(folder(A, 1, 2))).toBe(true)
  })

  it('refuses a create before the load and an execution that is not above the highest', async () =>
  {
    const registry = makeRegistry()
    await expect(registry.create(request())).rejects.toThrow('loaded')
    await registry.load()
    await registry.create(request(2))
    await expect(registry.create(request(2))).rejects.toBeInstanceOf(RangeError)
    await expect(registry.create(request(1))).rejects.toBeInstanceOf(RangeError)
    expect(registryLines()).toHaveLength(1)
    expect((await registry.create(request(1, B))).status).toBe('created')
  })

  it('uses the token the caller issued', async () =>
  {
    const registry = makeRegistry()
    await registry.load()
    const result = await registry.create({ ...request(), token: 'feedfacecafebeef' })
    expect(result.status === 'created' && result.entry.token).toBe('feedfacecafebeef')
    expect(parseMarker(readFileSync(join(folder(A, 1, 1), 'job.json'), 'utf8'))?.token).toBe('feedfacecafebeef')
  })

  it('keeps the entry registered when the folder cannot be made', async () =>
  {
    const registry = makeRegistry()
    await registry.load()
    const finalPath = join(env.dest, 'missing', 'a.mp4')
    const result = await registry.create({ ...request(), finalPath })
    expect(result).toMatchObject({ status: 'folder-failed', error: { code: 'ENOENT' } })
    expect(registry.list().map((e) => e.path)).toEqual([join(env.dest, 'missing', '.molex-MM-0001-a1-x1.partial')])
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not create'))
  })

  it('removes a folder whose marker cannot be written', async () =>
  {
    const files: WorkDirFiles = { ...createNodeWorkDirFiles(), writeNew: fails('denied', 'EACCES') }
    const registry = makeRegistry({ files })
    await registry.load()
    const result = await registry.create(request())
    expect(result).toMatchObject({ status: 'folder-failed', error: { code: 'EACCES' } })
    expect(existsSync(folder(A, 1, 1))).toBe(false)
    expect(registry.list()).toEqual([])
    expect(registryLines()).toHaveLength(2)
    expect(registryLines()[1]).toEqual({ op: 'deleted', path: folder(A, 1, 1) })
  })

  it('keeps the entry when an unmarked folder cannot be removed', async () =>
  {
    const files: WorkDirFiles = {
      ...createNodeWorkDirFiles(),
      writeNew: fails('denied', 'EACCES'),
      removeEmpty: fails('busy', 'EBUSY')
    }
    const registry = makeRegistry({ files })
    await registry.load()
    expect((await registry.create(request())).status).toBe('folder-failed')
    expect(registry.list()).toHaveLength(1)
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not remove the unmarked'))
  })
})

describe('hidden attribute', () =>
{
  it('runs attrib +h without a shell on win32', async () =>
  {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, done: (err: null, stdout: string, stderr: string) => void) =>
    {
      done(null, '', '')
    })
    const mem = memory()
    mem.fs.setHidden.mockImplementation(createFsOps({ platform: 'win32', systemRoot: 'C:\\Windows' }).setHidden)
    const registry = makeRegistry({ platform: 'win32', fs: mem.fs, files: mem.files })
    await registry.load()
    const result = await registry.create({ jobId: A, attempt: 1, execution: 1, source: 'D:\\media\\a.mkv', finalPath: 'D:\\media\\out\\a.mp4' })
    const path = 'D:\\media\\out\\.molex-MM-0001-a1-x1.partial'
    expect(result.status).toBe('created')
    expect(mem.fs.setHidden).toHaveBeenCalledWith(path)
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\attrib.exe',
      ['+h', path],
      expect.objectContaining({ shell: false, windowsHide: true }),
      expect.any(Function)
    )
    expect(mem.texts.has(`${path}\\job.json`)).toBe(true)
  })

  it.each<Platform>(['linux', 'darwin'])('is never requested on %s', async (platform) =>
  {
    execFileMock.mockReset()
    const mem = memory()
    const registry = makeRegistry({ platform, fs: mem.fs, files: mem.files })
    await registry.load()
    const result = await registry.create({ jobId: A, attempt: 1, execution: 1, source: '/media/a.mkv', finalPath: '/media/out/a.mp4' })
    expect(result.status).toBe('created')
    expect(mem.dirs.has('/media/out/.molex-MM-0001-a1-x1.partial')).toBe(true)
    expect(mem.fs.setHidden).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('logs a failed request and keeps the folder', async () =>
  {
    const mem = memory()
    mem.fs.setHidden.mockRejectedValue(new Error('attrib missing'))
    const registry = makeRegistry({ platform: 'win32', fs: mem.fs, files: mem.files })
    await registry.load()
    const result = await registry.create({ jobId: A, attempt: 1, execution: 1, source: 'D:\\a.mkv', finalPath: 'D:\\out\\a.mp4' })
    expect(result.status).toBe('created')
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('attrib missing'))
  })
})

async function started(overrides: Partial<WorkDirRegistryOptions> = {}): Promise<WorkDirRegistry>
{
  const registry = makeRegistry(overrides)
  await registry.load()
  return registry
}

async function make(registry: WorkDirRegistry, jobId: JobId, execution: number, finalDir = env.dest): Promise<WorkDirEntry>
{
  const result = await registry.create({ jobId, attempt: 1, execution, source: join(env.root, `${jobId}.mkv`), finalPath: join(finalDir, `${jobId}.mp4`) })
  if (result.status !== 'created')
  {
    throw new Error(`Expected a created folder, got ${result.status}`)
  }
  writeFileSync(join(result.path, 'out-e1.mkv.part'), 'partial output')
  return result.entry
}

function protecting(...entries: WorkDirEntry[]): (entry: WorkDirEntry) => boolean
{
  const tokens = new Set(entries.map((e) => e.token))
  return (entry) => tokens.has(entry.token)
}

function outcomes(report: SweepReport): Record<string, string>
{
  return Object.fromEntries(report.results.map((r) => [r.path, r.outcome]))
}

function workFolders(): string[]
{
  return readdirSync(env.dest).filter((name) => name.startsWith('.molex-'))
}

/** The `deleted` lines are on disk by the time a sweep or create resolves, so they are read without waiting. */
function expectDeletedLines(count: number): void
{
  expect(registryLines().filter((line) => (line as { op: string }).op === 'deleted')).toHaveLength(count)
}

const C = 'MM-0003' as JobId
const D = 'MM-0004' as JobId

describe('sweep', () =>
{
  it('deletes only folders whose token is neither active nor held and whose marker matches', async () =>
  {
    const registry = await started()
    const active = await make(registry, A, 1)
    const held = await make(registry, B, 1)
    const ended = await make(registry, C, 1)
    const forged = await make(registry, D, 1)
    const markerFile = join(forged.path, 'job.json')
    writeFileSync(markerFile, JSON.stringify({ ...JSON.parse(readFileSync(markerFile, 'utf8')), token: 'ffffffffffffffff' }))
    const stranger = join(env.dest, '.molex-MM-0009-a1-x1.partial')
    mkdirSync(stranger)
    const report = await registry.sweep(protecting(active, held))
    expect(outcomes(report)).toEqual({ [active.path]: 'protected', [held.path]: 'protected', [ended.path]: 'deleted', [forged.path]: 'mismatch' })
    expect(report).toMatchObject({ deleted: 1, pending: 0, kept: 0 })
    expect(existsSync(ended.path)).toBe(false)
    expect([active.path, held.path, forged.path, stranger].every((path) => existsSync(path))).toBe(true)
    expect(registry.list()).toEqual([active, held, forged])
    expectDeletedLines(1)
    expect(registryLines()).toContainEqual({ op: 'deleted', path: ended.path })
    expect(env.log.info).toHaveBeenCalledWith(expect.stringContaining('Deleted the work folder'))
  })

  it.each([
    ['another job', (marker: Record<string, unknown>): string => JSON.stringify({ ...marker, jobId: 'MM-0042' })],
    ['nothing readable', (): string => '{ not json']
  ])('never touches a folder whose marker names %s', async (_name, rewrite) =>
  {
    const registry = await started()
    const ended = await make(registry, A, 1)
    const markerFile = join(ended.path, 'job.json')
    writeFileSync(markerFile, rewrite(JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>))
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [ended.path]: 'mismatch' })
    expect(existsSync(join(ended.path, 'out-e1.mkv.part'))).toBe(true)
  })

  it('drops folders already gone and keeps those whose parent cannot be reached', async () =>
  {
    const registry = await started()
    const gone = await make(registry, A, 1)
    const sub = join(env.dest, 'sub')
    mkdirSync(sub)
    const offline = await make(registry, B, 1, sub)
    rmSync(gone.path, { recursive: true })
    rmSync(sub, { recursive: true })
    const report = await registry.sweep(() => false)
    expect(outcomes(report)).toEqual({ [gone.path]: 'missing', [offline.path]: 'unreachable' })
    expect(report.deleted).toBe(1)
    expect(registry.list()).toEqual([offline])
  })

  it('deletes an empty folder without a marker and leaves a filled one', async () =>
  {
    const registry = await started()
    const empty = await make(registry, A, 1)
    const filled = await make(registry, B, 1)
    rmSync(join(empty.path, 'job.json'))
    rmSync(join(empty.path, 'out-e1.mkv.part'))
    rmSync(join(filled.path, 'job.json'))
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [empty.path]: 'deleted', [filled.path]: 'mismatch' })
    expect(existsSync(empty.path)).toBe(false)
    expect(existsSync(join(filled.path, 'out-e1.mkv.part'))).toBe(true)
  })

  it('never touches a file at a registered path', async () =>
  {
    const registry = await started()
    const ended = await make(registry, A, 1)
    rmSync(ended.path, { recursive: true })
    writeFileSync(ended.path, 'a user file')
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [ended.path]: 'mismatch' })
    expect(readFileSync(ended.path, 'utf8')).toBe('a user file')
  })

  it('asks protect again right before the deletion', async () =>
  {
    const registry = await started()
    const ended = await make(registry, A, 1)
    const protect = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    expect(outcomes(await registry.sweep(protect))).toEqual({ [ended.path]: 'protected' })
    expect(protect).toHaveBeenCalledTimes(2)
    expect(existsSync(ended.path)).toBe(true)
  })

  it('keeps a folder that cannot be deleted within the cleanup budget pending', async () =>
  {
    let busy = true
    const fs: Env['fs'] = {
      ...env.fs,
      removeTree: async (path) =>
      {
        if (busy)
        {
          throw coded('resource busy', 'EBUSY')
        }
        await env.fs.removeTree(path)
      }
    }
    const registry = await started({ fs })
    const held = await make(registry, A, 1)
    const report = await registry.sweep(() => false)
    expect(report.results).toEqual([{ path: held.path, jobId: A, token: held.token, outcome: 'pending', code: 'EBUSY' }])
    expect(report.pending).toBe(1)
    expect(env.timers.slept.reduce((sum, ms) => sum + ms, 0)).toBe(5_000)
    expect(registry.pendingEntries()).toEqual([held])
    expect(registry.list()).toEqual([held])
    busy = false
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [held.path]: 'deleted' })
    expect(registry.pendingEntries()).toEqual([])
    expect(existsSync(held.path)).toBe(false)
    expectDeletedLines(1)
  })

  it('takes no retry for a failure that is not a lock', async () =>
  {
    const fs: Env['fs'] = { ...env.fs, removeTree: fails('i/o error', 'EIO') }
    const registry = await started({ fs, cleanupBudgetMs: 1_000 })
    await make(registry, A, 1)
    const report = await registry.sweep(() => false)
    expect(report.results[0]).toMatchObject({ outcome: 'pending', code: 'EIO' })
    expect(env.timers.slept).toEqual([])
  })

  it('reports a marker it cannot read as unreachable', async () =>
  {
    const files: WorkDirFiles = { ...createNodeWorkDirFiles(), readText: fails('denied', 'EACCES') }
    const registry = await started({ files })
    const ended = await make(registry, A, 1)
    expect((await registry.sweep(() => false)).results[0]).toMatchObject({ path: ended.path, outcome: 'unreachable', code: 'EACCES' })
    expect(existsSync(ended.path)).toBe(true)
  })

  it('skips a folder whose create is in flight', async () =>
  {
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) =>
    {
      open = resolve
    })
    const fs: Env['fs'] = {
      ...env.fs,
      mkdir: async (path) =>
      {
        await gate
        await env.fs.mkdir(path)
      }
    }
    const registry = await started({ fs })
    const creating = registry.create({ jobId: A, attempt: 1, execution: 1, source: join(env.root, 'a.mkv'), finalPath: join(env.dest, 'a.mp4') })
    await vi.waitFor(() => expect(env.events).toContain('fsync'))
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [folder(A, 1, 1)]: 'creating' })
    open()
    expect((await creating).status).toBe('created')
    expect(existsSync(folder(A, 1, 1))).toBe(true)
  })

  it('runs one sweep at a time and only over the entries asked for', async () =>
  {
    const registry = await started()
    const a = await make(registry, A, 1)
    const b = await make(registry, B, 1)
    const [first, second] = await Promise.all([
      registry.sweep(() => false, (entry) => entry.jobId === A),
      registry.sweep(() => false)
    ])
    expect(outcomes(first)).toEqual({ [a.path]: 'deleted' })
    expect(outcomes(second)).toEqual({ [b.path]: 'deleted' })
    expect(workFolders()).toEqual([])
  })

  it('logs a deleted line that cannot be written', async () =>
  {
    const registry = await started()
    await make(registry, A, 1)
    env.writer.failPlain = true
    expect((await registry.sweep(() => false)).deleted).toBe(1)
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not record the deletion'))
  })
})

describe('across sessions', () =>
{
  it('leaves nothing behind for removed jobs and released claims', async () =>
  {
    const registry = await started()
    const running = await make(registry, A, 1)
    const released = await make(registry, B, 1)
    expect(outcomes(await registry.sweep(protecting(running)))).toEqual({ [running.path]: 'protected', [released.path]: 'deleted' })
    expect(outcomes(await registry.sweep(() => false))).toEqual({ [running.path]: 'deleted' })
    expect(workFolders()).toEqual([])
    expectDeletedLines(2)
    expect((await makeRegistry().load()).entries).toEqual([])
  })

  it('keeps every folder for an empty start and sweeps them from the next start on', async () =>
  {
    const first = await started()
    const a = await make(first, A, 1)
    const b = await make(first, B, 1)

    const empty = makeRegistry()
    const loaded = await empty.load({ emptyStart: true })
    expect(loaded.kept).toEqual([a, b])
    const fresh = await make(empty, C, 1)
    const report = await empty.sweep(() => false)
    expect(outcomes(report)).toEqual({ [a.path]: 'session', [b.path]: 'session', [fresh.path]: 'deleted' })
    expect(report.kept).toBe(2)
    expect(workFolders().sort()).toEqual(['.molex-MM-0001-a1-x1.partial', '.molex-MM-0002-a1-x1.partial'])
    expectDeletedLines(1)

    const next = await started()
    expect(outcomes(await next.sweep(() => false))).toEqual({ [a.path]: 'deleted', [b.path]: 'deleted' })
    expect(workFolders()).toEqual([])
    expectDeletedLines(3)
    expect((await makeRegistry().load()).entries).toEqual([])
  })

  it('keeps execution numbers above the registry highest after a crash', async () =>
  {
    const first = await started()
    await make(first, A, 1)
    await make(first, A, 2)

    const second = makeRegistry()
    const loaded = await second.load()
    expect(loaded.floors.get(A)).toBe(2)
    expect(second.nextExecution(A, 1)).toBe(3)
    await expect(second.create({ jobId: A, attempt: 1, execution: 2, source: 's', finalPath: join(env.dest, 'a.mp4') })).rejects.toBeInstanceOf(RangeError)
    expect((await second.sweep(() => false)).deleted).toBe(2)
    expectDeletedLines(2)

    const third = makeRegistry()
    const reloaded = await third.load({ knownJob: (jobId) => jobId === A })
    expect(reloaded.entries).toEqual([])
    expect(third.nextExecution(A, 1)).toBe(3)
    const next = await make(third, A, third.nextExecution(A, 1))
    expect(next.path).toBe(folder(A, 1, 3))
  })
})
