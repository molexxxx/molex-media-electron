import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import type { BigIntStats, StatsFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import
{
  CLEANUP_BUDGET_MS,
  CLEANUP_CODES,
  LOCK_BUDGET_MS,
  POSIX_TRASH_RETRY_MS,
  WAIT_LOCK_AFTER_MS,
  createFsOps,
  createTrash,
  errorCode,
  isAbortedTrash,
  lockDelay,
  msFromNs,
  runProcess,
  sameFile,
  sameReservation,
  toIdentity,
  withLockRetries
} from '../../../src/main/jobs/fsops'
import type { ProcessRunner } from '../../../src/main/jobs/fsops'
import { workDirName } from '../../../src/main/jobs/naming'
import
{
  LINUX_MOUNTS_PATH,
  MAC_MOUNT_PATH,
  PLANNER_IO_CONCURRENCY,
  PROBE_FILE_PREFIX,
  VOLUME_QUERY_TIMEOUT_MS,
  createLanes,
  createLimiter,
  createPlannerIO,
  createVolumeQueries,
  nodePlannerFs
} from '../../../src/main/jobs/planner-io'
import type { PlannerFs } from '../../../src/main/jobs/planner-io'
import { MIB, WINDOWS_VOLUME_SCRIPT, createVolumeRegistry, powershellArgs } from '../../../src/main/jobs/volumes'
import type { VolumeQueries, VolumeRegistry } from '../../../src/main/jobs/volumes'
import type { Platform } from '../../../src/shared/text/platform'
import { createManualTimers } from '../helpers/manual-timers'

function coded(code: string, message: string = code): NodeJS.ErrnoException
{
  return Object.assign(new Error(message), { code })
}

/** An operation that fails with the given codes in order, then runs `then`. */
function failing<T>(codes: string[], then: () => Promise<T>): { op: () => Promise<T>; calls: () => number }
{
  let calls = 0
  return {
    op: async () =>
    {
      const code = codes[calls++]
      if (code !== undefined)
      {
        throw coded(code)
      }
      return then()
    },
    calls: () => calls
  }
}

let dir = ''

beforeEach(() =>
{
  dir = mkdtempSync(join(tmpdir(), 'molex-fsops-'))
})

afterEach(() =>
{
  rmSync(dir, { recursive: true, force: true })
})

describe('lock retries', () =>
{
  it('waits 50, 100, 200, 400, 800, 1600 ms, then every 2000 ms', () =>
  {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(lockDelay)).toEqual([50, 100, 200, 400, 800, 1600, 2000, 2000, 2000])
  })

  it('renames a real file once injected EBUSY and EPERM clear', async () =>
  {
    const timers = createManualTimers()
    const fs = createFsOps({ platform: 'linux' })
    writeFileSync(join(dir, 'out-e1.mkv.part'), 'NEW')
    const rename = failing(['EBUSY', 'EPERM', 'EBUSY'], () => fs.rename(join(dir, 'out-e1.mkv.part'), join(dir, 'final.mkv')))
    const delays: number[] = []
    const placing = withLockRetries(rename.op, { timers, onRetry: (_err, _retry, delay) => delays.push(delay) })
    await timers.runAll()
    await placing
    expect(rename.calls()).toBe(4)
    expect(delays).toEqual([50, 100, 200])
    expect(timers.now()).toBe(350)
    expect(readFileSync(join(dir, 'final.mkv'), 'utf8')).toBe('NEW')
    expect(existsSync(join(dir, 'out-e1.mkv.part'))).toBe(false)
  })

  it('gives up at exactly 30 s and throws the last failure', async () =>
  {
    const timers = createManualTimers()
    const locked = failing(Array.from({ length: 100 }, () => 'EPERM'), async () => 'never')
    const placing = withLockRetries(locked.op, { timers })
    const outcome = placing.then(() => null, (err: unknown) => err)
    await timers.runAll()
    expect(errorCode(await outcome)).toBe('EPERM')
    expect(timers.now()).toBe(LOCK_BUDGET_MS)
    expect(locked.calls()).toBe(21)
    expect(timers.pending()).toBe(0)
  })

  it('reports the wait-lock stage once after 2 s of waiting', async () =>
  {
    const timers = createManualTimers()
    const onWaiting = vi.fn()
    const busy = failing(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'], async () => 'placed')
    const placing = withLockRetries(busy.op, { timers, onWaiting })
    await timers.advance(WAIT_LOCK_AFTER_MS - 1)
    expect(onWaiting).not.toHaveBeenCalled()
    await timers.advance(1)
    expect(onWaiting).toHaveBeenCalledTimes(1)
    await timers.runAll()
    expect(await placing).toBe('placed')
    expect(onWaiting).toHaveBeenCalledTimes(1)
  })

  it('never reports wait-lock when the lock clears early', async () =>
  {
    const timers = createManualTimers()
    const onWaiting = vi.fn()
    const placing = withLockRetries(failing(['EACCES'], async () => 'placed').op, { timers, onWaiting })
    await timers.runAll()
    expect(await placing).toBe('placed')
    expect(onWaiting).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it.each(['ENOSPC', 'EXDEV', 'EEXIST', 'ENOENT'])('does not retry %s', async (code) =>
  {
    const timers = createManualTimers()
    const op = failing([code], async () => 'never')
    await expect(withLockRetries(op.op, { timers })).rejects.toMatchObject({ code })
    expect(op.calls()).toBe(1)
    expect(timers.now()).toBe(0)
  })

  it('retries ENOTEMPTY on the cleanup budget of 5 s', async () =>
  {
    const timers = createManualTimers()
    const op = failing(Array.from({ length: 50 }, () => 'ENOTEMPTY'), async () => 'never')
    const deleting = withLockRetries(op.op, { timers, codes: CLEANUP_CODES, budgetMs: CLEANUP_BUDGET_MS }).then(() => null, (err: unknown) => err)
    await timers.runAll()
    expect(errorCode(await deleting)).toBe('ENOTEMPTY')
    expect(timers.now()).toBe(CLEANUP_BUDGET_MS)
  })

  it('stops waiting when the signal aborts', async () =>
  {
    const timers = createManualTimers()
    const controller = new AbortController()
    const op = failing(['EBUSY', 'EBUSY', 'EBUSY'], async () => 'never')
    const placing = withLockRetries(op.op, { timers, signal: controller.signal }).then(() => null, (err: unknown) => err)
    await timers.advance(60)
    controller.abort()
    expect(errorCode(await placing)).toBe('EBUSY')
    expect(op.calls()).toBe(2)
    const aborted = failing(['EBUSY'], async () => 'never')
    await expect(withLockRetries(aborted.op, { timers, signal: controller.signal })).rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('reads codes only from errors that carry one', () =>
  {
    expect(errorCode(coded('EBUSY'))).toBe('EBUSY')
    expect(errorCode(new Error('x'))).toBeNull()
    expect(errorCode(null)).toBeNull()
    expect(errorCode({ code: 5 })).toBeNull()
  })
})

describe('file identities', () =>
{
  function bigStats(ino: bigint): BigIntStats
  {
    return { dev: 3n, ino, size: 10n, mtimeNs: 1_700_000_000_123_456_789n } as unknown as BigIntStats
  }

  it('keeps file ids above 2^53 exact, where numbers would make neighbors equal', () =>
  {
    const top = 2n ** 53n
    expect(Number(top + 1n)).toBe(Number(top))
    const a = toIdentity(bigStats(top))
    const b = toIdentity(bigStats(top + 1n))
    expect(a.ino).toBe('9007199254740992')
    expect(b.ino).toBe('9007199254740993')
    expect(sameFile(a, b)).toBe(false)
    expect(sameFile(a, toIdentity(bigStats(top)))).toBe(true)
  })

  it('turns nanosecond times into the milliseconds a plain stat reports, before 1970 as well', () =>
  {
    expect(msFromNs(1_000_500_000n)).toBe(1000.5)
    expect(msFromNs(1_700_000_000_123_456_789n)).toBe(1_700_000_000 * 1000 + 123_456_789 / 1_000_000)
    expect(msFromNs(-1n)).toBe(-1 * 1000 + 999_999_999 / 1_000_000)
    expect(msFromNs(-2_000_000_000n)).toBe(-2000)
    const file = join(dir, 'clock.wav')
    writeFileSync(file, 'abc')
    expect(msFromNs(statSync(file, { bigint: true }).mtimeNs)).toBe(statSync(file).mtimeMs)
  })
})

describe('reservations', () =>
{
  it('claims a free name with wx and returns the identity of the file it created', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const path = join(dir, 'song.m4a')
    const reserved = await fs.reserve(path)
    const stats = lstatSync(path, { bigint: true })
    expect(reserved).toEqual({ dev: stats.dev.toString(), ino: stats.ino.toString(), size: 0, mtimeMs: lstatSync(path).mtimeMs })
    expect(await fs.identity(path)).toEqual(reserved)
    await expect(fs.reserve(path)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('lets a rename replace the reservation', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const finalPath = join(dir, 'song.m4a')
    await fs.reserve(finalPath)
    writeFileSync(join(dir, 'out-e1.m4a.part'), 'NEW')
    await fs.rename(join(dir, 'out-e1.m4a.part'), finalPath)
    expect(readFileSync(finalPath, 'utf8')).toBe('NEW')
  })

  it('tells a user file renamed over the reservation from the reservation itself', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const displaced = join(dir, 'song (original).wav')
    const reserved = await fs.reserve(displaced)
    writeFileSync(join(dir, 'empty.wav'), '')
    renameSync(join(dir, 'empty.wav'), displaced)
    const now = await fs.identity(displaced)
    expect(now?.size).toBe(0)
    expect(sameFile(reserved, now as NonNullable<typeof now>)).toBe(false)
    expect(sameFile(reserved, reserved)).toBe(true)
    expect(sameReservation(reserved, now)).toBe(false)
  })

  it('accepts only the untouched reservation for deletion', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const path = join(dir, 'song (previous).wav')
    const reserved = await fs.reserve(path)
    expect(sameReservation(reserved, await fs.identity(path))).toBe(true)
    expect(sameReservation(reserved, null)).toBe(false)
    expect(sameReservation(reserved, { ...reserved, size: 3 })).toBe(false)
    expect(sameReservation(reserved, { ...reserved, mtimeMs: reserved.mtimeMs + 1 })).toBe(false)
    expect(sameReservation(reserved, { ...reserved, ino: (BigInt(reserved.ino) + 1n).toString() })).toBe(false)
    writeFileSync(path, 'external writer')
    expect(sameReservation(reserved, await fs.identity(path))).toBe(false)
  })

  it('reads no identity where nothing is', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    writeFileSync(join(dir, 'file'), 'x')
    expect(await fs.identity(join(dir, 'missing.wav'))).toBeNull()
    expect(await fs.identity(join(dir, 'file', 'below.wav'))).toBeNull()
    await expect(fs.identity(join(dir, 'bad\u0000name'))).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('does not reserve inside a missing folder', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    await expect(fs.reserve(join(dir, 'missing', 'a.wav'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('folders and files', () =>
{
  it('creates one folder level and refuses an existing one', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const work = join(dir, workDirName('MM-0142', 1, 2))
    await fs.mkdir(work)
    expect(lstatSync(work).isDirectory()).toBe(true)
    await expect(fs.mkdir(work)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(fs.mkdir(join(dir, 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a work folder with everything in it and nothing else', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const work = join(dir, workDirName('MM-0142', 1, 1))
    mkdirSync(join(work, 'frames.part'), { recursive: true })
    writeFileSync(join(work, 'out-e1.mkv.part'), 'x')
    writeFileSync(join(work, 'frames.part', 'frame_0001.png'), 'x')
    await fs.removeTree(`${work}/`)
    expect(existsSync(work)).toBe(false)
    await fs.removeTree(work)
    const userFolder = join(dir, 'Season 1')
    mkdirSync(userFolder)
    await expect(fs.removeTree(userFolder)).rejects.toMatchObject({ code: 'EINVAL' })
    expect(existsSync(userFolder)).toBe(true)
  })

  it('passes on other removal failures', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    await expect(fs.removeTree(join(dir, 'bad\u0000name', workDirName('MM-0001', 1, 1)))).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('unlinks a file', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    writeFileSync(join(dir, 'a'), 'x')
    await fs.unlink(join(dir, 'a'))
    expect(existsSync(join(dir, 'a'))).toBe(false)
  })
})

describe('the hidden attribute', () =>
{
  it('runs attrib +h by full path on Windows', async () =>
  {
    const run = vi.fn<ProcessRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    const fs = createFsOps({ platform: 'win32', run, systemRoot: 'C:\\WINDOWS' })
    await fs.setHidden('D:/Music/.molex-MM-0142-a1-x1.partial')
    expect(run).toHaveBeenCalledWith('C:\\WINDOWS\\System32\\attrib.exe', ['+h', 'D:\\Music\\.molex-MM-0142-a1-x1.partial'], { timeoutMs: 10000 })
    const fallback = vi.fn<ProcessRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    await createFsOps({ platform: 'win32', run: fallback }).setHidden('D:\\a')
    expect(fallback.mock.calls[0][0]).toBe('C:\\Windows\\System32\\attrib.exe')
  })

  it('logs a failure and carries on', async () =>
  {
    const log = { warn: vi.fn() }
    const exits = createFsOps({ platform: 'win32', run: async () => ({ code: 1, stdout: 'Access denied - D:\\a', stderr: '' }), log })
    await exits.setHidden('D:\\a')
    expect(log.warn).toHaveBeenCalledWith('Could not hide D:\\a: attrib exited with 1 Access denied - D:\\a')
    const throws = createFsOps({ platform: 'win32', run: async () => Promise.reject(new Error('spawn ENOENT')), log })
    await throws.setHidden('D:\\b')
    expect(log.warn).toHaveBeenCalledWith('Could not hide D:\\b: spawn ENOENT')
    const odd = createFsOps({ platform: 'win32', run: async () => Promise.reject('gone') })
    await expect(odd.setHidden('D:\\c')).resolves.toBeUndefined()
  })

  it.each(['linux', 'darwin'] as const)('does nothing on %s', async (platform) =>
  {
    const run = vi.fn<ProcessRunner>()
    await createFsOps({ platform, run }).setHidden('/home/a/.molex-MM-0001-a1-x1.partial')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the cross-volume copy', () =>
{
  function bytes(size: number): Buffer
  {
    const data = Buffer.alloc(size)
    for (let i = 0; i < size; i++)
    {
      data[i] = (i * 31 + 7) % 251
    }
    return data
  }

  it('copies in chunks and checks size and SHA-256 against a re-read', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    const data = bytes(2.5 * 1024 * 1024)
    writeFileSync(join(dir, 'out-e1.mkv.part'), data)
    await fs.copyFile(join(dir, 'out-e1.mkv.part'), join(dir, 'copy.part'))
    expect(readFileSync(join(dir, 'copy.part')).equals(data)).toBe(true)
    const expected = createHash('sha256').update(data).digest('hex')
    expect(await fs.hash(join(dir, 'copy.part'))).toBe(expected)
    expect(await fs.hash(join(dir, 'out-e1.mkv.part'))).toBe(expected)
  })

  it('removes its own copy when reading the source fails', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    mkdirSync(join(dir, 'folder'))
    await expect(fs.copyFile(join(dir, 'folder'), join(dir, 'copy.part'))).rejects.toBeTruthy()
    expect(existsSync(join(dir, 'copy.part'))).toBe(false)
  })

  it('never writes over an existing file', async () =>
  {
    const fs = createFsOps({ platform: 'linux' })
    writeFileSync(join(dir, 'a'), 'source')
    writeFileSync(join(dir, 'b'), 'user file')
    await expect(fs.copyFile(join(dir, 'a'), join(dir, 'b'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('user file')
  })

  it('removes its own copy when the check fails', async () =>
  {
    const fs = createFsOps({ platform: 'linux', verify: async () => ({ hash: 'different', bytes: 6 }) })
    writeFileSync(join(dir, 'a'), 'source')
    await expect(fs.copyFile(join(dir, 'a'), join(dir, 'b'))).rejects.toMatchObject({ code: 'EIO' })
    expect(existsSync(join(dir, 'b'))).toBe(false)
  })

  it('runs one copy at a time and keeps going after a failure', async () =>
  {
    let active = 0
    let most = 0
    const fs = createFsOps({
      platform: 'linux',
      verify: async (path) =>
      {
        active++
        most = Math.max(most, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        const data = readFileSync(path)
        return { hash: createHash('sha256').update(data).digest('hex'), bytes: data.length }
      }
    })
    writeFileSync(join(dir, 'a'), 'one')
    const copies = [
      fs.copyFile(join(dir, 'missing'), join(dir, 'x')),
      fs.copyFile(join(dir, 'a'), join(dir, 'b')),
      fs.copyFile(join(dir, 'a'), join(dir, 'c'))
    ]
    const results = await Promise.allSettled(copies)
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(most).toBe(1)
    expect(existsSync(join(dir, 'x'))).toBe(false)
    expect(readFileSync(join(dir, 'c'), 'utf8')).toBe('one')
  })
})

describe('the process runner', () =>
{
  it('resolves with the exit code and output', async () =>
  {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("warn"); process.exit(3)'], { timeoutMs: 10000 })
    expect(result).toEqual({ code: 3, stdout: 'ok', stderr: 'warn' })
    expect((await runProcess(process.execPath, ['-e', ''], { timeoutMs: 10000 })).code).toBe(0)
  })

  it('rejects when the program cannot start or runs past the timeout', async () =>
  {
    await expect(runProcess(join(dir, 'missing-program'), [], { timeoutMs: 10000 })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 })).rejects.toBeTruthy()
  })
})

const DRIVES = readFileSync(fileURLToPath(new URL('../fixtures/jobs/volumes/windows-drives.json', import.meta.url)), 'utf8')
const EDITED = readFileSync(fileURLToPath(new URL('../fixtures/jobs/volumes/windows-drives-edited.json', import.meta.url)), 'utf8')
const ABORTED = 'Operation was aborted'
const SHARING = 'The process cannot access the file because it is being used by another process.'

function windowsVolumes(outputs: string[] = [DRIVES]): { registry: ReturnType<typeof createVolumeRegistry>; queries: () => number }
{
  let calls = 0
  const queries: VolumeQueries = {
    windows: async () => outputs[Math.min(calls++, outputs.length - 1)],
    mounts: async () => null
  }
  return { registry: createVolumeRegistry({ platform: 'win32', queries }), queries: () => calls }
}

/** A trash that rejects with the given messages in order, then resolves. */
function scriptedTrash(messages: string[]): ReturnType<typeof vi.fn<(path: string) => Promise<void>>>
{
  let calls = 0
  return vi.fn(async () =>
  {
    const message = messages[calls++]
    if (message !== undefined)
    {
      throw new Error(message)
    }
  })
}

describe('the trash wrapper', () =>
{
  it('recognizes the abort Windows reports for an item that cannot be recycled', () =>
  {
    expect(isAbortedTrash(new Error(ABORTED))).toBe(true)
    expect(isAbortedTrash('operation was aborted')).toBe(true)
    expect(isAbortedTrash(new Error(SHARING))).toBe(false)
  })

  it('takes no retry after an abort and keeps later files on that volume without calling the trash', async () =>
  {
    const timers = createManualTimers()
    const volumes = windowsVolumes()
    const log = { warn: vi.fn() }
    const trash = scriptedTrash([ABORTED])
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: volumes.registry, sizeOf: async () => 10, log })
    expect(await wrapper.trash('D:/Music/song (original).wav')).toEqual({
      status: 'kept',
      reason: 'cannot-recycle',
      message: 'Files on D: cannot go to the Recycle Bin, so the file stays where it is.'
    })
    expect(trash).toHaveBeenCalledTimes(1)
    expect(trash).toHaveBeenCalledWith('D:\\Music\\song (original).wav')
    expect(timers.pending()).toBe(0)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(await volumes.registry.info('D:\\other.wav')).toMatchObject({ trash: 'unavailable' })
    expect(await wrapper.trash('D:\\Music\\later (previous).wav')).toEqual({
      status: 'kept',
      reason: 'no-recycle-bin',
      message: 'D: has no Recycle Bin, so the file stays where it is.'
    })
    expect(trash).toHaveBeenCalledTimes(1)
  })

  it('retries a sharing violation on the lock schedule', async () =>
  {
    const timers = createManualTimers()
    const trash = scriptedTrash([SHARING, SHARING])
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: windowsVolumes().registry, sizeOf: async () => 10 })
    const trashing = wrapper.trash('C:\\Music\\song (previous).wav')
    await timers.runAll()
    expect(await trashing).toEqual({ status: 'trashed' })
    expect(trash).toHaveBeenCalledTimes(3)
    expect(timers.now()).toBe(150)
  })

  it('keeps the file after 30 s of refusals', async () =>
  {
    const timers = createManualTimers()
    const log = { warn: vi.fn() }
    const trash = scriptedTrash(Array.from({ length: 100 }, () => SHARING))
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: windowsVolumes().registry, sizeOf: async () => 10, log })
    const trashing = wrapper.trash('C:\\Music\\song (previous).wav')
    await timers.runAll()
    expect(await trashing).toEqual({ status: 'kept', reason: 'refused', message: `The file could not be moved to the Recycle Bin: ${SHARING}` })
    expect(timers.now()).toBe(LOCK_BUDGET_MS)
    expect(trash).toHaveBeenCalledTimes(21)
    expect(log.warn).toHaveBeenCalledWith(`Could not move C:\\Music\\song (previous).wav to the Recycle Bin: ${SHARING}`)
  })

  it('never calls the trash on a volume without a bin', async () =>
  {
    const timers = createManualTimers()
    const trash = scriptedTrash([])
    const volumes = windowsVolumes([EDITED])
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: volumes.registry })
    expect(await wrapper.trash('\\\\nas\\media\\song (original).wav')).toMatchObject({ status: 'kept', reason: 'no-recycle-bin', message: '\\\\nas\\media has no Recycle Bin, so the file stays where it is.' })
    expect(await wrapper.trash('E:\\song (original).wav')).toMatchObject({ status: 'kept', reason: 'no-recycle-bin' })
    expect(await wrapper.trash('Z:\\song (original).wav')).toMatchObject({ status: 'kept', reason: 'no-recycle-bin' })
    expect(await wrapper.trash('F:\\song (original).wav')).toMatchObject({ status: 'kept', reason: 'no-recycle-bin' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('keeps a file the bin has no room for, reading the room again before each step', async () =>
  {
    const timers = createManualTimers()
    const trash = scriptedTrash([])
    const fuller = DRIVES.replace('"binBytes":44902572', `"binBytes":${49700 * MIB}`)
    const volumes = windowsVolumes([DRIVES, fuller])
    const sizes: Record<string, number> = { 'C:\\big.wav': 20 * MIB, 'C:\\small.wav': 1 * MIB }
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: volumes.registry, sizeOf: async (path) => sizes[path] ?? null })
    expect(await wrapper.trash('C:\\small.wav')).toEqual({ status: 'trashed' })
    expect(await wrapper.trash('C:\\big.wav')).toEqual({
      status: 'kept',
      reason: 'bin-full',
      message: 'The Recycle Bin on C: is full; moving this file there would delete older items permanently.'
    })
    expect(await wrapper.trash('C:\\unknown-size.wav')).toEqual({ status: 'trashed' })
    expect(volumes.queries()).toBe(3)
    expect(trash).toHaveBeenCalledTimes(2)
  })

  it('reads the size of a real file for the room check', async () =>
  {
    const timers = createManualTimers()
    const trash = scriptedTrash([])
    const full = DRIVES.replace('"binBytes":44902572', `"binBytes":${49710 * MIB}`)
    const volumes = windowsVolumes([full])
    writeFileSync(join(dir, 'previous.wav'), 'x')
    const wrapper = createTrash({ platform: 'win32', timers, trash, volumes: volumes.registry })
    const outcome = await wrapper.trash(join(dir, 'previous.wav'))
    const onC = /^[cC]:/.test(join(dir, 'previous.wav'))
    expect(outcome.status).toBe(onC ? 'kept' : 'trashed')
    expect(await wrapper.trash('C:\\missing-file.wav')).toEqual({ status: 'trashed' })
  })

  it('retries once after 1 s on macOS and Linux, then keeps the file', async () =>
  {
    for (const platform of ['darwin', 'linux'] as const)
    {
      const timers = createManualTimers()
      const registry = createVolumeRegistry({ platform, queries: { windows: async () => '', mounts: async () => null } })
      const once = scriptedTrash(['Trash is busy'])
      const retried = createTrash({ platform, timers, trash: once, volumes: registry })
      const first = retried.trash('/home/tony/song (previous).wav')
      await timers.advance(POSIX_TRASH_RETRY_MS - 1)
      expect(once).toHaveBeenCalledTimes(1)
      await timers.advance(1)
      expect(await first).toEqual({ status: 'trashed' })
      expect(once).toHaveBeenCalledWith('/home/tony/song (previous).wav')

      const refusedTimers = createManualTimers()
      const twice = scriptedTrash(['no trash here', 'no trash here', 'never'])
      const refused = createTrash({ platform, timers: refusedTimers, trash: twice, volumes: registry })
      const pending = refused.trash('/mnt/usb/song (original).wav')
      await refusedTimers.runAll()
      expect(await pending).toEqual({ status: 'kept', reason: 'refused', message: 'The file could not be moved to the Trash: no trash here' })
      expect(twice).toHaveBeenCalledTimes(2)
      expect(refusedTimers.now()).toBe(POSIX_TRASH_RETRY_MS)
    }
  })

  it('reports a refusal that is not an Error', async () =>
  {
    const timers = createManualTimers()
    const registry = createVolumeRegistry({ platform: 'linux', queries: { windows: async () => '', mounts: async () => null } })
    const wrapper = createTrash({ platform: 'linux', timers, trash: async () => Promise.reject('gio: not supported'), volumes: registry })
    const pending = wrapper.trash('/home/tony/a.wav')
    await timers.runAll()
    expect(await pending).toMatchObject({ status: 'kept', reason: 'refused', message: 'The file could not be moved to the Trash: gio: not supported' })
  })
})

const hostPlatform: Platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

function quietRegistry(platform: Platform, windowsStdout: string = '{"noRecycle":false,"drives":[]}'): VolumeRegistry
{
  return createVolumeRegistry({ platform, queries: { windows: async () => windowsStdout, mounts: async () => '' } })
}

function fakeStats(kind: 'file' | 'dir' | 'link', size: number = 0): BigIntStats
{
  return {
    size: BigInt(size),
    mtimeNs: 1_000_500_000n,
    mtimeMs: 1000n,
    dev: 7n,
    ino: 42n,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link'
  } as unknown as BigIntStats
}

function fakeFs(overrides: Partial<PlannerFs>): PlannerFs
{
  return {
    stat: async () => fakeStats('file'),
    lstat: async () => fakeStats('file'),
    statfs: async () => ({ bavail: 10, bsize: 4096, blocks: 100 }) as unknown as StatsFs,
    create: async () => undefined,
    unlink: async () => undefined,
    ...overrides
  }
}

/** Lets every queued promise continuation run. */
function settle(): Promise<void>
{
  return new Promise((resolve) => setImmediate(resolve))
}

/** A read that waits until the test releases it, recording which paths are running. */
function gatedReads(): { read: (path: string) => Promise<BigIntStats>; running: string[]; started: string[]; release(path: string, err?: unknown): void }
{
  const gates = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>()
  const running: string[] = []
  const started: string[] = []
  return {
    running,
    started,
    read: (path) =>
    {
      running.push(path)
      started.push(path)
      return new Promise<BigIntStats>((resolve, reject) =>
      {
        gates.set(path, {
          resolve: () => resolve(fakeStats('file', path.length)),
          reject
        })
      }).finally(() => running.splice(running.indexOf(path), 1))
    },
    release(path, err)
    {
      const gate = gates.get(path)
      gates.delete(path)
      if (err === undefined)
      {
        gate?.resolve()
      }
      else
      {
        gate?.reject(err)
      }
    }
  }
}

describe('planner IO on real folders', () =>
{
  it('stats files and folders with the numbers a plain stat gives, and null where nothing is', async () =>
  {
    const io = createPlannerIO({ platform: hostPlatform, timers: createManualTimers(), volumes: quietRegistry(hostPlatform) })
    const file = join(dir, 'song.wav')
    writeFileSync(file, 'abc')
    const plain = statSync(file)
    const exact = statSync(file, { bigint: true })
    expect(await io.stat(file)).toEqual({ size: 3, mtimeMs: plain.mtimeMs, isFile: true, isDirectory: false, dev: exact.dev.toString(), ino: exact.ino.toString() })
    expect(await io.stat(dir)).toMatchObject({ isFile: false, isDirectory: true })
    expect(await io.stat(join(dir, 'missing.wav'))).toBeNull()
    expect(await io.stat(join(file, 'inside.wav'))).toBeNull()
  })

  it('reads free and total bytes, from the nearest folder that exists when the destination is new', async () =>
  {
    const io = createPlannerIO({ platform: hostPlatform, timers: createManualTimers(), volumes: quietRegistry(hostPlatform) })
    const space = await io.statfs(join(dir, 'Season 1', 'Extras'))
    const plain = statfsSync(dir)
    expect(space.totalBytes).toBe(plain.blocks * plain.bsize)
    expect(space.freeBytes).toBeGreaterThan(0)
    expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes)
  })

  it('probes a folder with an empty file and leaves nothing behind', async () =>
  {
    const tokens = ['0123456789abcdef']
    const io = createPlannerIO({ platform: hostPlatform, timers: createManualTimers(), volumes: quietRegistry(hostPlatform), token: () => tokens[0] })
    expect(await io.probeWrite(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    expect(await io.probeWrite(join(dir, 'missing'))).toBe(false)
  })

  it('takes another probe name when one is taken, and gives up after three', async () =>
  {
    const taken = `${PROBE_FILE_PREFIX}aa.tmp`
    writeFileSync(join(dir, taken), 'user file')
    const names = ['aa', 'aa', 'bb']
    const io = createPlannerIO({ platform: hostPlatform, timers: createManualTimers(), volumes: quietRegistry(hostPlatform), token: () => names.shift() ?? 'aa' })
    expect(await io.probeWrite(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([taken])
    expect(readFileSync(join(dir, taken), 'utf8')).toBe('user file')
    expect(await io.probeWrite(dir)).toBe(false)
    expect(readdirSync(dir)).toEqual([taken])
  })

  it('creates only where nothing is', async () =>
  {
    const target = join(dir, 'probe.tmp')
    await nodePlannerFs.create(target)
    expect(statSync(target).size).toBe(0)
    await expect(nodePlannerFs.create(target)).rejects.toMatchObject({ code: 'EEXIST' })
    await nodePlannerFs.unlink(target)
    expect(existsSync(target)).toBe(false)
  })
})

describe('planner IO reads', () =>
{
  it('keeps the name of a link whose target is missing and follows a link that resolves', async () =>
  {
    const dangling = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ lstat: async () => fakeStats('link'), stat: async () => Promise.reject(coded('ENOENT')) })
    })
    expect(await dangling.stat('/music/gone.wav')).toEqual({ size: 0, mtimeMs: 1000.5, isFile: false, isDirectory: false, dev: '7', ino: '42' })

    const resolved = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ lstat: async () => fakeStats('link'), stat: async () => fakeStats('file', 99) })
    })
    expect(await resolved.stat('/music/link.wav')).toMatchObject({ size: 99, isFile: true })
  })

  it('passes on stat failures other than a missing path', async () =>
  {
    const denied = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ lstat: async () => Promise.reject(coded('EACCES')) })
    })
    await expect(denied.stat('/private/a.wav')).rejects.toMatchObject({ code: 'EACCES' })

    const deniedTarget = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ lstat: async () => fakeStats('link'), stat: async () => Promise.reject(coded('EACCES')) })
    })
    await expect(deniedTarget.stat('/music/link.wav')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('walks up to the nearest folder for the volume space and stops at the root', async () =>
  {
    const asked: string[] = []
    const io = createPlannerIO({
      platform: 'win32',
      timers: createManualTimers(),
      volumes: quietRegistry('win32'),
      fs: fakeFs({
        statfs: async (path) =>
        {
          asked.push(path)
          if (path !== 'D:\\')
          {
            throw coded('ENOENT')
          }
          return { bavail: 25, bsize: 4096, blocks: 100 } as unknown as StatsFs
        }
      })
    })
    expect(await io.statfs('D:\\Out\\Season 1')).toEqual({ freeBytes: 25 * 4096, totalBytes: 100 * 4096 })
    expect(asked).toEqual(['D:\\Out\\Season 1', 'D:\\Out', 'D:\\'])

    const nowhere = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ statfs: async () => Promise.reject(coded('ENOENT')) })
    })
    await expect(nowhere.statfs('/missing/out')).rejects.toMatchObject({ code: 'ENOENT' })

    const denied = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      fs: fakeFs({ statfs: async () => Promise.reject(coded('EACCES')) })
    })
    await expect(denied.statfs('/private/out')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('answers false when the probe cannot be created', async () =>
  {
    const io = createPlannerIO({
      platform: 'win32',
      timers: createManualTimers(),
      volumes: quietRegistry('win32'),
      fs: fakeFs({ create: async () => Promise.reject(coded('EPERM')) })
    })
    expect(await io.probeWrite('C:\\Program Files')).toBe(false)
  })

  it('names the probe in the folder it checks, with 64 random bits by default', async () =>
  {
    const created: string[] = []
    const io = createPlannerIO({
      platform: 'win32',
      timers: createManualTimers(),
      volumes: quietRegistry('win32'),
      fs: fakeFs({ create: async (path) => void created.push(path) })
    })
    expect(await io.probeWrite('D:\\Out')).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatch(/^D:\\Out\\\.molex-probe-[0-9a-f]{16}\.tmp$/)
  })

  it('retries removing the probe on the cleanup schedule and logs one it could not remove', async () =>
  {
    const timers = createManualTimers()
    const unlink = failing(['EBUSY', 'EBUSY'], async () => undefined)
    const io = createPlannerIO({ platform: 'win32', timers, volumes: quietRegistry('win32'), token: () => 'ab', fs: fakeFs({ unlink: unlink.op }) })
    const probing = io.probeWrite('D:\\Out')
    await timers.runAll()
    expect(await probing).toBe(true)
    expect(unlink.calls()).toBe(3)
    expect(timers.now()).toBe(150)

    const stuckTimers = createManualTimers()
    const warn = vi.fn()
    const stuck = createPlannerIO({
      platform: 'win32',
      timers: stuckTimers,
      volumes: quietRegistry('win32'),
      token: () => 'cd',
      log: { warn },
      fs: fakeFs({ unlink: async () => Promise.reject(coded('EPERM', 'EPERM: operation not permitted')) })
    })
    const held = stuck.probeWrite('D:\\Out')
    await stuckTimers.runAll()
    expect(await held).toBe(true)
    expect(stuckTimers.now()).toBe(CLEANUP_BUDGET_MS)
    expect(warn).toHaveBeenCalledWith('Could not remove the write check D:\\Out\\.molex-probe-cd.tmp: EPERM: operation not permitted')

    const oddWarn = vi.fn()
    const odd = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      log: { warn: oddWarn },
      fs: fakeFs({ unlink: async () => Promise.reject('refused') })
    })
    expect(await odd.probeWrite('/out')).toBe(true)
    expect(oddWarn).toHaveBeenCalledWith(expect.stringMatching(/^Could not remove the write check \/out\/\.molex-probe-[0-9a-f]{16}\.tmp: refused$/))

    const vanished = vi.fn()
    const removedElsewhere = createPlannerIO({
      platform: 'linux',
      timers: createManualTimers(),
      volumes: quietRegistry('linux'),
      log: { warn: vanished },
      fs: fakeFs({ unlink: async () => Promise.reject(coded('ENOENT')) })
    })
    expect(await removedElsewhere.probeWrite('/out')).toBe(true)
    expect(vanished).not.toHaveBeenCalled()
  })

  it('takes volume kinds and bins from the registry it shares with the trash wrapper', async () =>
  {
    let queries = 0
    const drives = JSON.stringify({
      noRecycle: false,
      drives: [{ name: 'D:\\', type: 'Fixed', ready: true, totalBytes: 4000, freeBytes: 1000, volume: '\\\\?\\Volume{0f1e2d3c-0000-1111-2222-333344445555}\\', binMaxMiB: 10, binNuke: 0, binBytes: MIB }]
    })
    const volumes = createVolumeRegistry({
      platform: 'win32',
      queries:
      {
        windows: async () =>
        {
          queries++
          return drives
        },
        mounts: async () => null
      }
    })
    const io = createPlannerIO({ platform: 'win32', timers: createManualTimers(), volumes })
    expect(await io.volumeInfo('D:\\Music\\a.wav')).toEqual({ kind: 'local', trash: 'available', trashBytesFree: 9 * MIB, volumeBytes: 4000 })
    expect(await io.volumeInfo('d:\\Video\\b.mkv')).toEqual({ kind: 'local', trash: 'available', trashBytesFree: 9 * MIB, volumeBytes: 4000 })
    expect(queries).toBe(1)
    await volumes.markTrashUnavailable('D:\\Music\\a (previous).wav')
    expect(await io.volumeInfo('D:\\Music\\c.wav')).toMatchObject({ kind: 'local', trash: 'unavailable', trashBytesFree: null })
    expect(await io.volumeInfo('\\\\nas\\media\\a.wav')).toEqual({ kind: 'network', trash: 'unavailable', trashBytesFree: null, volumeBytes: null })
    expect(queries).toBe(1)
  })
})

describe('planner IO queues', () =>
{
  it('runs at most the configured number of local reads at once, in arrival order', async () =>
  {
    const gated = gatedReads()
    const io = createPlannerIO({ platform: 'linux', timers: createManualTimers(), volumes: quietRegistry('linux'), concurrency: 2, fs: fakeFs({ lstat: gated.read }) })
    const reads = Promise.allSettled(['/a.wav', '/b.wav', '/c.wav', '/d.wav'].map((path) => io.stat(path)))
    await settle()
    expect(gated.running).toEqual(['/a.wav', '/b.wav'])
    gated.release('/b.wav')
    await settle()
    expect(gated.running).toEqual(['/a.wav', '/c.wav'])
    gated.release('/a.wav', coded('EACCES'))
    await settle()
    expect(gated.running).toEqual(['/c.wav', '/d.wav'])
    gated.release('/c.wav')
    gated.release('/d.wav')
    expect((await reads).map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
    expect(PLANNER_IO_CONCURRENCY).toBe(3)
  })

  it('reads one request at a time per network share root while other shares and local reads move', async () =>
  {
    const gated = gatedReads()
    const io = createPlannerIO({ platform: 'win32', timers: createManualTimers(), volumes: quietRegistry('win32'), concurrency: 4, fs: fakeFs({ lstat: gated.read }) })
    const reads = Promise.allSettled([
      io.stat('\\\\nas\\media\\a.wav'),
      io.stat('\\\\NAS\\Media\\b.wav'),
      io.stat('\\\\other\\share\\c.wav'),
      io.stat('C:\\Music\\d.wav'),
      io.stat('C:\\Music\\e.wav')
    ])
    await settle()
    expect([...gated.running].sort()).toEqual(['C:\\Music\\d.wav', 'C:\\Music\\e.wav', '\\\\nas\\media\\a.wav', '\\\\other\\share\\c.wav'])
    gated.release('\\\\nas\\media\\a.wav', coded('ETIMEDOUT'))
    await settle()
    expect(gated.running).toContain('\\\\NAS\\Media\\b.wav')
    for (const path of [...gated.running])
    {
      gated.release(path)
    }
    expect((await reads).map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  })

  it('does not count share reads against the local slots', async () =>
  {
    const gated = gatedReads()
    const io = createPlannerIO({ platform: 'win32', timers: createManualTimers(), volumes: quietRegistry('win32'), concurrency: 1, fs: fakeFs({ lstat: gated.read }) })
    const reads = [io.stat('\\\\nas\\media\\a.wav'), io.stat('\\\\other\\share\\b.wav'), io.stat('C:\\c.wav')]
    await settle()
    expect([...gated.running].sort()).toEqual(['C:\\c.wav', '\\\\nas\\media\\a.wav', '\\\\other\\share\\b.wav'])
    for (const path of [...gated.running])
    {
      gated.release(path)
    }
    await Promise.all(reads)
  })

  it('answers false in time for a share whose lane a hung read blocks, and true once it answers', async () =>
  {
    const timers = createManualTimers()
    const gated = gatedReads()
    const stats: string[] = []
    const io = createPlannerIO({
      platform: 'win32',
      timers,
      volumes: quietRegistry('win32'),
      fs: fakeFs({
        lstat: gated.read,
        stat: async (path) =>
        {
          stats.push(path)
          return fakeStats('dir')
        }
      })
    })
    const hung = io.stat('\\\\nas\\media\\a.wav')
    await settle()
    const answer = io.reachable('\\\\nas\\media\\', 5000)
    await settle()
    expect(stats).toEqual([])
    await timers.advance(4999)
    await settle()
    await timers.advance(1)
    expect(await answer).toBe(false)
    gated.release('\\\\nas\\media\\a.wav')
    await hung
    await settle()
    expect(stats).toEqual(['\\\\nas\\media\\'])
    expect(await io.reachable('\\\\nas\\media\\', 5000)).toBe(true)
  })

  it('never queues a local reachability check behind local reads', async () =>
  {
    const gated = gatedReads()
    const io = createPlannerIO({
      platform: 'win32',
      timers: createManualTimers(),
      volumes: quietRegistry('win32'),
      concurrency: 1,
      fs: fakeFs({ lstat: gated.read, stat: async () => fakeStats('dir') })
    })
    const busy = io.stat('C:\\Music\\a.wav')
    await settle()
    expect(await io.reachable('C:\\', 5000)).toBe(true)
    gated.release('C:\\Music\\a.wav')
    await busy
  })

  it('answers reachability for a real folder and a missing one', async () =>
  {
    const io = createPlannerIO({ platform: hostPlatform, timers: createManualTimers(), volumes: quietRegistry(hostPlatform) })
    expect(await io.reachable(dir, 5000)).toBe(true)
    expect(await io.reachable(join(dir, 'missing'), 5000)).toBe(false)
  })

  it('keeps arrival order in the limiter and clamps a limit below one', async () =>
  {
    const limit = createLimiter(0)
    const order: number[] = []
    let release: () => void = () => undefined
    const first = limit(() => new Promise<void>((resolve) =>
    {
      release = resolve
    }).then(() => void order.push(1)))
    const second = limit(async () => void order.push(2))
    const third = limit(async () => void order.push(3))
    await settle()
    expect(order).toEqual([])
    release()
    await Promise.all([first, second, third])
    expect(order).toEqual([1, 2, 3])
  })

  it('runs a lane one task at a time and keeps going after a failure', async () =>
  {
    const lanes = createLanes()
    const order: string[] = []
    const failed = lanes('nas', async () =>
    {
      order.push('a')
      throw coded('EIO')
    })
    const next = lanes('nas', async () =>
    {
      order.push('b')
      return 'b'
    })
    const other = lanes('other', async () =>
    {
      order.push('c')
      return 'c'
    })
    await expect(failed).rejects.toMatchObject({ code: 'EIO' })
    expect(await next).toBe('b')
    expect(await other).toBe('c')
    expect(order).toEqual(['a', 'c', 'b'])
    expect(await lanes('nas', async () => 'later')).toBe('later')
  })
})

describe('the volume queries', () =>
{
  it('runs Windows PowerShell by its full path with no profile and no prompts', async () =>
  {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = []
    const run: ProcessRunner = async (file, args, options) =>
    {
      calls.push({ file, args, timeoutMs: options.timeoutMs })
      return { code: 0, stdout: '{"noRecycle":false,"drives":[]}', stderr: '' }
    }
    const queries = createVolumeQueries({ platform: 'win32', run, systemRoot: 'D:\\Windows' })
    expect(await queries.windows()).toBe('{"noRecycle":false,"drives":[]}')
    expect(calls).toEqual([{
      file: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: powershellArgs(WINDOWS_VOLUME_SCRIPT),
      timeoutMs: VOLUME_QUERY_TIMEOUT_MS
    }])
    expect(calls[0].args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(await queries.mounts()).toBeNull()
  })

  it('rejects when PowerShell fails, so the registry reads the volume as unknown', async () =>
  {
    const failingQuery = createVolumeQueries({ platform: 'win32', run: async () => ({ code: 1, stdout: '', stderr: 'Add-Type failed\r\n' }), timeoutMs: 50 })
    await expect(failingQuery.windows()).rejects.toThrow('PowerShell exited with 1: Add-Type failed')
    const silent = createVolumeQueries({ platform: 'win32', run: async () => ({ code: 3, stdout: '', stderr: '' }) })
    await expect(silent.windows()).rejects.toThrow(/^PowerShell exited with 3$/)

    const volumes = createVolumeRegistry({ platform: 'win32', queries: failingQuery })
    expect(await volumes.info('D:\\a.wav')).toEqual({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null })
  })

  it('reads the Linux mount table and the macOS mount listing, null when either fails', async () =>
  {
    const read: string[] = []
    const linux = createVolumeQueries({
      platform: 'linux',
      readText: async (path) =>
      {
        read.push(path)
        return 'nas:/media /mnt/media nfs4 rw 0 0\n'
      }
    })
    expect(await linux.mounts()).toBe('nas:/media /mnt/media nfs4 rw 0 0\n')
    expect(read).toEqual([LINUX_MOUNTS_PATH])
    expect(await createVolumeQueries({ platform: 'linux', readText: async () => Promise.reject(coded('ENOENT')) }).mounts()).toBeNull()

    const ran: Array<{ file: string; args: readonly string[] }> = []
    const mac = createVolumeQueries({
      platform: 'darwin',
      run: async (file, args) =>
      {
        ran.push({ file, args })
        return { code: 0, stdout: '//tony@nas/media on /Volumes/media (smbfs, nodev, nosuid, mounted by tony)\n', stderr: '' }
      }
    })
    expect(await mac.mounts()).toContain('smbfs')
    expect(ran).toEqual([{ file: MAC_MOUNT_PATH, args: [] }])
    expect(await createVolumeQueries({ platform: 'darwin', run: async () => ({ code: 1, stdout: '', stderr: 'mount: busy' }) }).mounts()).toBeNull()
    expect(await createVolumeQueries({ platform: 'darwin', run: async () => Promise.reject(coded('ENOENT')) }).mounts()).toBeNull()

    const volumes = createVolumeRegistry({ platform: 'linux', queries: linux })
    expect(await volumes.info('/mnt/media/a.wav')).toMatchObject({ kind: 'network' })
  })

  it('reads the real Linux mount table by default', async () =>
  {
    const linux = createVolumeQueries({ platform: 'linux' })
    const text = await linux.mounts()
    if (process.platform === 'linux')
    {
      expect(text).toContain(' / ')
    }
    else
    {
      expect(text).toBeNull()
    }
  })
})
