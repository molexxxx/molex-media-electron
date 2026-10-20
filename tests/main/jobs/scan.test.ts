import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  QUEUE_LIMIT,
  SCAN_CHUNK,
  copyScanState,
  createScanner,
  defaultPathKey,
  emptyScanState,
  isWorkName,
  realScanFs,
  startScan,
  type ScanDeps,
  type ScanDirent,
  type ScanFs,
  type ScanOptions,
  type ScannedFile
} from '../../../src/main/jobs/scan'
import type { ScanState } from '../../../src/shared/jobs/types'
import type { Platform } from '../../../src/shared/text/platform'

const platform = process.platform as Platform

let root: string

function touch(rel: string, bytes = 4): string
{
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, 1))
  return path
}

function errno(code: string): NodeJS.ErrnoException
{
  const err = new Error(`${code}: injected`) as NodeJS.ErrnoException
  err.code = code
  return err
}

interface Harness
{
  deps: ScanDeps
  files: ScannedFile[]
  chunks: ScannedFile[][]
  progress: ScanState[]
}

function harness(over: Partial<ScanDeps> = {}): Harness
{
  const files: ScannedFile[] = []
  const chunks: ScannedFile[][] = []
  const progress: ScanState[] = []
  const deps: ScanDeps = {
    platform,
    capacity: () => QUEUE_LIMIT - files.length,
    isWaiting: () => false,
    isPreviousOutput: () => false,
    onFiles: (found) =>
    {
      chunks.push(found)
      files.push(...found)
    },
    onProgress: (state) => progress.push(state),
    ...over
  }
  return { deps, files, chunks, progress }
}

function options(over: Partial<ScanOptions> = {}): ScanOptions
{
  return { recursive: true, outputFolder: null, allowSecondJobs: false, force: false, ...over }
}

function names(files: ScannedFile[]): string[]
{
  return files.map((f) => f.path.slice(root.length + 1).replace(/\\/g, '/')).sort()
}

function wrapFs(over: Partial<ScanFs>): ScanFs
{
  return { ...realScanFs, ...over }
}

beforeEach(() =>
{
  root = mkdtempSync(join(tmpdir(), 'molex-scan-'))
})

afterEach(() =>
{
  rmSync(root, { recursive: true, force: true })
})

describe('startScan on real folders', () =>
{
  it('walks subfolders when recursive and records each subdir', async () =>
  {
    touch('a.mp3')
    touch('notes.txt')
    touch(join('sub', 'b.FLAC'))
    touch(join('sub', 'deep', 'c.mkv'))
    const h = harness()
    const final = await startScan(root, options(), h.deps).done
    expect(final.status).toBe('done')
    expect(final.error).toBeNull()
    expect(names(h.files)).toEqual(['a.mp3', 'sub/b.FLAC', 'sub/deep/c.mkv'])
    expect(final.added).toBe(3)
    expect(final.visited).toBe(4)
    expect(final.excluded.unsupported).toBe(1)
    const subdirs = Object.fromEntries(h.files.map((f) => [names([f])[0], f.subdir.replace(/\\/g, '/')]))
    expect(subdirs).toEqual({ 'a.mp3': '', 'sub/b.FLAC': 'sub', 'sub/deep/c.mkv': 'sub/deep' })
    const c = h.files.find((f) => f.path.endsWith('c.mkv')) as ScannedFile
    expect(c.size).toBe(4)
    expect(c.mtimeMs).toBe(statSync(c.path).mtimeMs)
    expect(h.progress.at(-1)).toEqual(final)
  })

  it('stays in the folder when not recursive', async () =>
  {
    touch('a.wav')
    touch(join('sub', 'b.mp3'))
    const h = harness()
    const final = await startScan(root, options({ recursive: false }), h.deps).done
    expect(names(h.files)).toEqual(['a.wav'])
    expect(final.visited).toBe(1)
  })

  it('skips folder links and counts them', async () =>
  {
    const target = mkdtempSync(join(tmpdir(), 'molex-scan-target-'))
    try
    {
      writeFileSync(join(target, 'linked.mp3'), 'x')
      symlinkSync(target, join(root, 'folder-link'), 'junction')
      touch('real.mp3')
      const h = harness()
      const final = await startScan(root, options(), h.deps).done
      expect(names(h.files)).toEqual(['real.mp3'])
      expect(final.excluded.links).toBe(1)
    }
    finally
    {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('skips file links when the platform allows creating them', async () =>
  {
    const target = touch('target.mp3')
    try
    {
      symlinkSync(target, join(root, 'file-link.mp3'), 'file')
    }
    catch
    {
      return
    }
    const h = harness()
    const final = await startScan(root, options(), h.deps).done
    expect(names(h.files)).toEqual(['target.mp3'])
    expect(final.excluded.links).toBe(1)
  })

  it('counts folders that cannot be read and keeps going', async () =>
  {
    touch(join('locked', 'hidden.mp3'))
    touch(join('open', 'seen.mp3'))
    const locked = join(root, 'locked')
    const fs = wrapFs({ opendir: (p) => (p === locked ? Promise.reject(errno('EACCES')) : realScanFs.opendir(p)) })
    const h = harness({ fs })
    const final = await startScan(root, options(), h.deps).done
    expect(final.status).toBe('done')
    expect(final.excluded.unreadable).toBe(1)
    expect(names(h.files)).toEqual(['open/seen.mp3'])
  })

  it('counts a subfolder that vanished while the root is still there', async () =>
  {
    touch(join('gone', 'x.mp3'))
    touch('kept.mp3')
    const gone = join(root, 'gone')
    const fs = wrapFs({ opendir: (p) => (p === gone ? Promise.reject(errno('ENOENT')) : realScanFs.opendir(p)) })
    const h = harness({ fs })
    const final = await startScan(root, options(), h.deps).done
    expect(final.status).toBe('done')
    expect(final.excluded.unreadable).toBe(1)
  })

  it('excludes the engine work folders and partial outputs', async () =>
  {
    touch(join('.molex-MM-0142-a1-x2.partial', 'out.part.mp3'))
    touch('.molex-MM-0001-a1-x1.partial')
    touch('song.mp3')
    const h = harness()
    const final = await startScan(root, options(), h.deps).done
    expect(names(h.files)).toEqual(['song.mp3'])
    expect(final.excluded.workFiles).toBe(2)
  })

  it('skips the destination folder when it lies inside the tree', async () =>
  {
    touch(join('Exports', 'old.mp3'))
    touch('new.mp3')
    const h = harness()
    const output = platform === 'win32' ? join(root, 'exports') + '\\' : join(root, 'Exports') + '/'
    const final = await startScan(root, options({ outputFolder: output }), h.deps).done
    expect(names(h.files)).toEqual(['new.mp3'])
    expect(final.excluded.outputFolder).toBe(1)
  })

  it('still scans a root that is itself the destination folder', async () =>
  {
    touch('a.mp3')
    const h = harness()
    const final = await startScan(root, options({ outputFolder: root }), h.deps).done
    expect(final.added).toBe(1)
    expect(final.excluded.outputFolder).toBe(0)
  })

  it('counts waiting sources as duplicates unless second jobs are allowed', async () =>
  {
    const waiting = touch('waiting.mp3')
    touch('fresh.mp3')
    const isWaiting = (p: string): boolean => p === waiting
    const h = harness({ isWaiting })
    const final = await startScan(root, options(), h.deps).done
    expect(names(h.files)).toEqual(['fresh.mp3'])
    expect(final.excluded.duplicates).toBe(1)
    const again = harness({ isWaiting })
    const second = await startScan(root, options({ allowSecondJobs: true }), again.deps).done
    expect(second.added).toBe(2)
    expect(second.excluded.duplicates).toBe(0)
  })

  it('matches previous outputs by path, size, and modification time unless forced', async () =>
  {
    const output = touch('output.mp3', 10)
    touch('source.mp3', 10)
    const when = new Date('2026-01-02T03:04:05Z')
    utimesSync(output, when, when)
    const recorded = { path: output, size: 10, mtimeMs: statSync(output).mtimeMs }
    const isPreviousOutput = vi.fn((f: { path: string; size: number; mtimeMs: number }) =>
      f.path === recorded.path && f.size === recorded.size && f.mtimeMs === recorded.mtimeMs)
    const h = harness({ isPreviousOutput })
    const final = await startScan(root, options(), h.deps).done
    expect(names(h.files)).toEqual(['source.mp3'])
    expect(final.excluded.previousOutputs).toBe(1)
    writeFileSync(output, Buffer.alloc(11, 1))
    const changed = harness({ isPreviousOutput })
    expect((await startScan(root, options(), changed.deps).done).added).toBe(2)
    utimesSync(output, when, when)
    writeFileSync(output, Buffer.alloc(10, 1))
    utimesSync(output, when, when)
    const forced = harness({ isPreviousOutput })
    const all = await startScan(root, options({ force: true }), forced.deps).done
    expect(all.added).toBe(2)
    expect(all.excluded.previousOutputs).toBe(0)
  })

  it('admits files only up to the queue limit and counts the rest', async () =>
  {
    for (let i = 0; i < 5; i++) touch(`f${i}.mp3`)
    let queued = QUEUE_LIMIT - 3
    const h = harness({
      capacity: () => QUEUE_LIMIT - queued,
      onFiles: (found) =>
      {
        queued += found.length
        h.files.push(...found)
      }
    })
    const final = await startScan(root, options(), h.deps).done
    expect(final.added).toBe(3)
    expect(final.excluded.overLimit).toBe(2)
    expect(queued).toBe(QUEUE_LIMIT)
  })

  it('counts every file over the limit without reading it once the queue is full', async () =>
  {
    const waiting = touch('waiting.mp3')
    touch('a.mp3')
    touch('b.mp3')
    const stat = vi.fn(realScanFs.stat)
    const h = harness({ capacity: () => 0, isWaiting: (p) => p === waiting, fs: wrapFs({ stat }) })
    const final = await startScan(root, options(), h.deps).done
    expect(final.added).toBe(0)
    expect(final.excluded.overLimit).toBe(2)
    expect(final.excluded.duplicates).toBe(1)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('delivers files in chunks and yields between them, never in the starting turn', async () =>
  {
    for (let i = 0; i < 5; i++) touch(`f${i}.mp3`)
    const yieldTurn = vi.fn(() => new Promise<void>((resolve) => setImmediate(resolve)))
    const h = harness({ chunkSize: 2, yieldTurn })
    const handle = startScan(root, options(), h.deps)
    expect(h.chunks).toHaveLength(0)
    expect(handle.state().status).toBe('scanning')
    const final = await handle.done
    expect(final.added).toBe(5)
    expect(h.chunks.map((c) => c.length)).toEqual([2, 2, 1])
    expect(yieldTurn).toHaveBeenCalledTimes(3)
    expect(h.progress.map((p) => p.added)).toEqual([2, 4, 5, 5])
    expect(h.progress.at(-1)?.status).toBe('done')
    expect(SCAN_CHUNK).toBeGreaterThan(1)
  })

  it('stops on cancel and keeps what was already added', async () =>
  {
    for (let i = 0; i < 6; i++) touch(`f${i}.mp3`)
    let handle: ReturnType<typeof startScan> | null = null
    const h = harness({ chunkSize: 2 })
    const deliver = h.deps.onFiles
    h.deps.onFiles = (found, state) =>
    {
      void deliver(found, state)
      handle?.cancel()
    }
    handle = startScan(root, options(), h.deps)
    const final = await handle.done
    expect(final.status).toBe('canceled')
    expect(final.added).toBe(2)
    expect(h.files).toHaveLength(2)
    expect(h.progress.at(-1)?.status).toBe('canceled')
  })

  it('does not deliver a chunk whose stats finish after a cancel', async () =>
  {
    touch('a.mp3')
    const controller = new AbortController()
    const fs = wrapFs({
      stat: async (p) =>
      {
        const info = await realScanFs.stat(p)
        if (p !== root) controller.abort()
        return info
      }
    })
    const h = harness({ fs })
    const final = await startScan(root, options({ signal: controller.signal }), h.deps).done
    expect(final.status).toBe('canceled')
    expect(h.files).toHaveLength(0)
  })

  it('honors an already aborted signal', async () =>
  {
    touch('a.mp3')
    const h = harness()
    const final = await startScan(root, options({ signal: AbortSignal.abort() }), h.deps).done
    expect(final.status).toBe('canceled')
    expect(final.added).toBe(0)
  })

  it('skips a file that vanished between listing and stat', async () =>
  {
    const vanished = touch('vanished.mp3')
    touch('kept.mp3')
    const fs = wrapFs({ stat: (p) => (p === vanished ? Promise.reject(errno('ENOENT')) : realScanFs.stat(p)) })
    const h = harness({ fs })
    const final = await startScan(root, options(), h.deps).done
    expect(names(h.files)).toEqual(['kept.mp3'])
    expect(final.visited).toBe(2)
  })

  it('ignores entries that are neither files, folders, nor links', async () =>
  {
    touch('a.mp3')
    const odd: ScanDirent = { name: 'pipe.mp3', isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }
    const fs = wrapFs({
      opendir: async (p) =>
      {
        const real = await realScanFs.opendir(p)
        return (async function* ()
        {
          yield odd
          yield* real
        })()
      }
    })
    const h = harness({ fs })
    const final = await startScan(root, options(), h.deps).done
    expect(final.added).toBe(1)
    expect(final.visited).toBe(1)
  })
})

describe('startScan failures', () =>
{
  it('fails when the root does not exist', async () =>
  {
    const missing = join(root, 'missing')
    const h = harness()
    const final = await startScan(missing, options(), h.deps).done
    expect(final).toMatchObject({ status: 'failed', error: `${missing} is not available.` })
  })

  it('fails when the root is a file', async () =>
  {
    const file = touch('a.mp3')
    const final = await startScan(file, options(), harness().deps).done
    expect(final).toMatchObject({ status: 'failed', error: `${file} is not a folder.` })
  })

  it('fails with access denied when the root cannot be read', async () =>
  {
    const fs = wrapFs({ opendir: () => Promise.reject(errno('EPERM')) })
    const final = await startScan(root, options(), harness({ fs }).deps).done
    expect(final).toMatchObject({ status: 'failed', error: `${root} could not be read (access denied).` })
    const denied = wrapFs({ stat: () => Promise.reject(errno('EACCES')) })
    const early = await startScan(root, options(), harness({ fs: denied }).deps).done
    expect(early.error).toBe(`${root} could not be read (access denied).`)
  })

  it('fails when the root goes away mid-scan and keeps the files found before', async () =>
  {
    touch('first.mp3')
    touch(join('sub', 'second.mp3'))
    const sub = join(root, 'sub')
    let gone = false
    const fs = wrapFs({
      opendir: (p) =>
      {
        if (p === sub)
        {
          gone = true
          return Promise.reject(errno('EIO'))
        }
        return realScanFs.opendir(p)
      },
      stat: (p) => (gone && p === root ? Promise.reject(errno('ENOENT')) : realScanFs.stat(p))
    })
    const h = harness({ fs, chunkSize: 1 })
    const final = await startScan(root, options(), h.deps).done
    expect(final).toMatchObject({ status: 'failed', error: `${root} is no longer available.` })
    expect(names(h.files)).toEqual(['first.mp3'])
    expect(h.progress.at(-1)?.status).toBe('failed')
  })

  it('fails when reading the root breaks off and counts a subfolder that breaks off', async () =>
  {
    touch(join('sub', 'a.mp3'))
    const sub = join(root, 'sub')
    const broken = (async function* (): AsyncGenerator<ScanDirent>
    {
      throw errno('EIO')
    })
    const subBreaks = wrapFs({ opendir: (p) => (p === sub ? Promise.resolve(broken()) : realScanFs.opendir(p)) })
    const counted = await startScan(root, options(), harness({ fs: subBreaks }).deps).done
    expect(counted.status).toBe('done')
    expect(counted.excluded.unreadable).toBe(1)
    const rootBreaks = wrapFs({ opendir: (p) => (p === root ? Promise.resolve(broken()) : realScanFs.opendir(p)) })
    const failed = await startScan(root, options(), harness({ fs: rootBreaks }).deps).done
    expect(failed).toMatchObject({ status: 'failed', error: `${root} is no longer available.` })
  })

  it('fails with the error when adding a chunk throws', async () =>
  {
    touch('a.mp3')
    const h = harness({ onFiles: () => { throw new Error('catalog unavailable') } })
    const final = await startScan(root, options(), h.deps).done
    expect(final).toMatchObject({ status: 'failed', error: 'catalog unavailable' })
    const rejects = harness({ onFiles: () => Promise.reject('plain reason') })
    expect((await startScan(root, options(), rejects.deps).done).error).toBe('plain reason')
  })

  it('resolves even when the final progress listener throws', async () =>
  {
    touch('a.mp3')
    const h = harness({
      onProgress: (state) =>
      {
        if (state.status !== 'scanning') throw new Error('listener')
      }
    })
    const final = await startScan(root, options(), h.deps).done
    expect(final.status).toBe('done')
  })
})

describe('createScanner', () =>
{
  it('tracks running scans, cancels by id, and keeps finished states', async () =>
  {
    touch('a.mp3')
    let n = 0
    const h = harness({ id: () => `scan-${++n}` })
    const scanner = createScanner(h.deps, 1)
    const first = scanner.start(root, options())
    expect(first.scanId).toBe('scan-1')
    expect(scanner.running().map((s) => s.scanId)).toEqual(['scan-1'])
    expect(scanner.get('scan-1')?.status).toBe('scanning')
    expect(scanner.cancel('scan-1')).toBe(true)
    const final = await first.done
    await Promise.resolve()
    expect(final.status).toBe('canceled')
    expect(scanner.running()).toEqual([])
    expect(scanner.get('scan-1')?.status).toBe('canceled')
    expect(scanner.cancel('scan-1')).toBe(false)
    expect(scanner.cancel('unknown')).toBe(false)
    expect(scanner.get('unknown')).toBeNull()
    await scanner.start(root, options()).done
    await Promise.resolve()
    expect(scanner.get('scan-2')?.status).toBe('done')
    expect(scanner.get('scan-1')).toBeNull()
  })

  it('does not cancel a scan that already ended but is not yet settled', async () =>
  {
    const answers: boolean[] = []
    const scanner = createScanner(harness({
      id: () => 'x',
      onProgress: (state) => answers.push(scanner.cancel(state.scanId))
    }).deps)
    const final = await scanner.start(join(root, 'missing'), options()).done
    expect(final.status).toBe('failed')
    expect(answers).toEqual([false])
  })

  it('uses random ids by default', () =>
  {
    const scanner = createScanner(harness().deps)
    const handle = scanner.start(root, options())
    expect(handle.scanId).toMatch(/^[0-9a-f-]{36}$/)
    return handle.done
  })
})

describe('scan helpers', () =>
{
  it('recognizes work names', () =>
  {
    expect(isWorkName('.molex-MM-0142-a1-x2.partial')).toBe(true)
    expect(isWorkName('.MOLEX-anything.PARTIAL')).toBe(true)
    expect(isWorkName('molex-MM-0142.partial')).toBe(false)
    expect(isWorkName('.molex-MM-0142.part')).toBe(false)
  })

  it('builds path keys per platform', () =>
  {
    const win = defaultPathKey('win32')
    expect(win('D:\\Rips\\Exports\\')).toBe(win('d:\\rips\\exports'))
    expect(win('D:\\')).toBe('d:\\')
    const mac = defaultPathKey('darwin')
    expect(mac('/Volumes/Media/Out/')).toBe('/volumes/media/out')
    expect(mac('/Users/caf\u0065\u0301')).toBe(mac('/Users/caf\u00e9'))
    const linux = defaultPathKey('linux')
    expect(linux('/srv/Media/')).toBe('/srv/Media')
    expect(linux('/')).toBe('/')
  })

  it('copies states so listeners cannot change the scan', () =>
  {
    const state = emptyScanState('s', '/root')
    const copy = copyScanState(state)
    copy.excluded.links = 9
    expect(state.excluded.links).toBe(0)
  })
})
