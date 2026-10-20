import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import
{
  DISK_MARGIN_BYTES,
  GIB,
  MIB,
  REACHABLE_TIMEOUT_MS,
  USER_DATA_MARGIN_BYTES,
  WINDOWS_VOLUME_SCRIPT,
  binFullReason,
  binRoom,
  checkRoots,
  committedBytes,
  createReachability,
  createVolumeRegistry,
  driveTypeKind,
  fitsInTrash,
  fitsOnVolume,
  isUncPath,
  jobCommitment,
  mountOf,
  parseMountOutput,
  parseProcMounts,
  parseWindowsVolumeQuery,
  posixVolumeInfo,
  powershellArgs,
  powershellPath,
  trashTooSmall,
  volumeKey,
  volumeLabel,
  volumeMargin,
  volumeRoot,
  volumeStatus,
  windowsVolumeInfo
} from '../../../src/main/jobs/volumes'
import type { MountEntry, VolumeCommitment, VolumeQueries } from '../../../src/main/jobs/volumes'
import { createManualTimers } from '../helpers/manual-timers'

const GB = 1000 * 1000 * 1000

function fixture(name: string): string
{
  return readFileSync(fileURLToPath(new URL(`../fixtures/jobs/volumes/${name}`, import.meta.url)), 'utf8')
}

describe('volume roots and keys', () =>
{
  it.each([
    ['C:\\Music\\song.wav', 'C:\\'],
    ['c:/Music/song.wav', 'C:\\'],
    ['D:', 'D:\\'],
    ['\\\\nas\\media\\Season 1\\a.mkv', '\\\\nas\\media\\'],
    ['//nas/media/a.mkv', '\\\\nas\\media\\'],
    ['\\\\?\\C:\\very\\long\\path.wav', 'C:\\'],
    ['\\\\?\\UNC\\nas\\media\\a.mkv', '\\\\nas\\media\\'],
    ['\\\\.\\E:\\clip.mp4', 'E:\\']
  ])('finds the Windows root of %s', (target, root) =>
  {
    expect(volumeRoot(target, 'win32')).toBe(root)
  })

  it('compares Windows roots without case', () =>
  {
    expect(volumeKey('C:\\a', 'win32')).toBe(volumeKey('c:\\b', 'win32'))
    expect(volumeKey('\\\\NAS\\Media\\a', 'win32')).toBe(volumeKey('\\\\nas\\media\\b', 'win32'))
    expect(volumeKey('\\\\nas\\media\\a', 'win32')).not.toBe(volumeKey('\\\\nas\\other\\a', 'win32'))
    expect(volumeKey('C:\\a', 'win32')).not.toBe(volumeKey('D:\\a', 'win32'))
  })

  const mounts: MountEntry[] = [
    { root: '/', fsType: 'ext4', source: '/dev/sda1' },
    { root: '/mnt/nas', fsType: 'cifs', source: '//nas/media' },
    { root: '/mnt/nas/deep', fsType: 'nfs4', source: 'nas:/deep' },
    { root: '/Volumes/Media/', fsType: 'smbfs', source: '//tony@nas/media' }
  ]

  it.each(['linux', 'darwin'] as const)('takes the longest mount point on %s', (platform) =>
  {
    expect(volumeRoot('/mnt/nas/deep/x/a.mkv', platform, mounts)).toBe('/mnt/nas/deep')
    expect(volumeRoot('/mnt/nas/a.mkv', platform, mounts)).toBe('/mnt/nas')
    expect(volumeRoot('/mnt/nasty/a.mkv', platform, mounts)).toBe('/')
    expect(volumeRoot('/home/a.mkv', platform)).toBe('/')
    expect(volumeKey('/Volumes/Media/a.mkv', platform, mounts)).toBe('/Volumes/Media/')
  })

  it('matches a mount point itself and ignores unrelated mounts', () =>
  {
    expect(mountOf('/mnt/nas', mounts)?.fsType).toBe('cifs')
    expect(mountOf('/srv/a', mounts.slice(1))).toBeNull()
  })

  it('detects UNC paths on Windows only', () =>
  {
    expect(isUncPath('\\\\nas\\media\\a.mkv', 'win32')).toBe(true)
    expect(isUncPath('//nas/media/a.mkv', 'win32')).toBe(true)
    expect(isUncPath('\\\\?\\UNC\\nas\\media\\a.mkv', 'win32')).toBe(true)
    expect(isUncPath('\\\\?\\C:\\a.mkv', 'win32')).toBe(false)
    expect(isUncPath('\\\\.\\C:\\a.mkv', 'win32')).toBe(false)
    expect(isUncPath('C:\\a.mkv', 'win32')).toBe(false)
    expect(isUncPath('\\\\nas', 'win32')).toBe(false)
    expect(isUncPath('//nas/media/a.mkv', 'linux')).toBe(false)
    expect(isUncPath('//nas/media/a.mkv', 'darwin')).toBe(false)
  })

  it('labels volumes for messages', () =>
  {
    expect(volumeLabel('D:\\', 'win32')).toBe('D:')
    expect(volumeLabel('\\\\nas\\media\\', 'win32')).toBe('\\\\nas\\media')
    expect(volumeLabel('/mnt/nas', 'linux')).toBe('/mnt/nas')
  })
})

describe('committed bytes and margins', () =>
{
  it('commits the reserve less what the current pass has written', () =>
  {
    expect(jobCommitment(5 * GB, null)).toBe(5 * GB)
    expect(jobCommitment(5 * GB, 0)).toBe(5 * GB)
    expect(jobCommitment(5 * GB, 2 * GB)).toBe(3 * GB)
    expect(jobCommitment(5 * GB, 7 * GB)).toBe(0)
    expect(jobCommitment(5 * GB, Number.NaN)).toBe(5 * GB)
    expect(jobCommitment(5 * GB, -10)).toBe(5 * GB)
    expect(jobCommitment(Number.POSITIVE_INFINITY, null)).toBe(0)
  })

  it('sums the other jobs on the same volume from their total_size', () =>
  {
    const commitments: VolumeCommitment[] = [
      { jobId: 'a', volume: 'd:\\', reserveBytes: 5 * GB, bytesWritten: 1 * GB },
      { jobId: 'b', volume: 'd:\\', reserveBytes: 5 * GB, bytesWritten: null },
      { jobId: 'c', volume: 'e:\\', reserveBytes: 5 * GB, bytesWritten: null },
      { jobId: 'd', volume: 'd:\\', reserveBytes: 1 * GB, bytesWritten: 3 * GB }
    ]
    expect(committedBytes(commitments, 'd:\\')).toBe(9 * GB)
    expect(committedBytes(commitments, 'd:\\', 'b')).toBe(4 * GB)
    expect(committedBytes(commitments, 'f:\\')).toBe(0)
  })

  it('keeps 1 GiB free on the userData volume and 256 MiB elsewhere', () =>
  {
    expect(USER_DATA_MARGIN_BYTES).toBe(GIB)
    expect(DISK_MARGIN_BYTES).toBe(256 * MIB)
    expect(volumeMargin('c:\\', 'c:\\')).toBe(GIB)
    expect(volumeMargin('d:\\', 'c:\\')).toBe(256 * MIB)
  })

  it('starts at most nine of sixteen 5 GB jobs on 50 GB free', () =>
  {
    const commitments: VolumeCommitment[] = []
    let started = 0
    for (let i = 0; i < 16; i++)
    {
      const fits = fitsOnVolume({
        freeBytes: 50 * GB,
        committedBytes: committedBytes(commitments, 'd:\\'),
        reserveBytes: 5 * GB,
        marginBytes: volumeMargin('d:\\', 'c:\\')
      })
      if (fits)
      {
        commitments.push({ jobId: `j${i}`, volume: 'd:\\', reserveBytes: 5 * GB, bytesWritten: null })
        started++
      }
    }
    expect(started).toBeLessThanOrEqual(9)
    expect(started).toBe(9)
  })

  it('lets a job start once the others have written their outputs', () =>
  {
    const commitments: VolumeCommitment[] = [{ jobId: 'a', volume: 'd:\\', reserveBytes: 40 * GB, bytesWritten: 39 * GB }]
    expect(fitsOnVolume({ freeBytes: 11 * GB, committedBytes: committedBytes(commitments, 'd:\\'), reserveBytes: 5 * GB, marginBytes: DISK_MARGIN_BYTES })).toBe(true)
    expect(fitsOnVolume({ freeBytes: 6 * GB, committedBytes: 0, reserveBytes: 5 * GB, marginBytes: GIB })).toBe(false)
    expect(fitsOnVolume({ freeBytes: 0, committedBytes: 0, reserveBytes: -1, marginBytes: 0 })).toBe(true)
  })

  it('rates a volume ok, tight, insufficient, or unknown', () =>
  {
    expect(volumeStatus([1 * GB, 2 * GB], 10 * GB)).toBe('ok')
    expect(volumeStatus([4 * GB, 4 * GB], 10 * GB)).toBe('tight')
    expect(volumeStatus([11 * GB], 10 * GB)).toBe('insufficient')
    expect(volumeStatus([], 0)).toBe('tight')
    expect(volumeStatus([1], null)).toBe('unknown')
    expect(volumeStatus([1], Number.NaN)).toBe('unknown')
    expect(volumeStatus([-5, 1 * GB], 10 * GB)).toBe('ok')
  })
})

describe('Recycle Bin room', () =>
{
  const bin = { trash: 'available', trashBytesFree: 10 * GB, volumeBytes: 1000 * GB }

  it('blocks when the displaced files need more than the bin has left', () =>
  {
    expect(trashTooSmall(11 * GB, bin, 'win32')).toBe(true)
    expect(trashTooSmall(10 * GB, bin, 'win32')).toBe(false)
    expect(trashTooSmall(0, bin, 'win32')).toBe(false)
  })

  it('falls back to 5 percent of the volume when the bin is unreadable', () =>
  {
    const unreadable = { ...bin, trashBytesFree: null }
    expect(trashTooSmall(51 * GB, unreadable, 'win32')).toBe(true)
    expect(trashTooSmall(50 * GB, unreadable, 'win32')).toBe(false)
    expect(trashTooSmall(50 * GB, { ...unreadable, volumeBytes: null }, 'win32')).toBe(false)
  })

  it('never blocks outside Windows or where nothing goes to the bin', () =>
  {
    expect(trashTooSmall(11 * GB, bin, 'darwin')).toBe(false)
    expect(trashTooSmall(11 * GB, bin, 'linux')).toBe(false)
    expect(trashTooSmall(11 * GB, { ...bin, trash: 'unavailable' }, 'win32')).toBe(false)
  })

  it('checks one file against the room left before a trash step', () =>
  {
    expect(fitsInTrash(5, 5)).toBe(true)
    expect(fitsInTrash(6, 5)).toBe(false)
    expect(fitsInTrash(6, null)).toBe(true)
    expect(binFullReason('D:')).toBe('The Recycle Bin on D: is full; moving this file there would delete older items permanently.')
  })
})

describe('the Windows drive query', () =>
{
  it('runs PowerShell by full path with the script encoded', () =>
  {
    expect(powershellPath('C:\\WINDOWS')).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(powershellPath(undefined)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const args = powershellArgs(WINDOWS_VOLUME_SCRIPT)
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toBe(WINDOWS_VOLUME_SCRIPT)
    expect(WINDOWS_VOLUME_SCRIPT).toContain('[System.IO.DriveInfo]::GetDrives()')
    expect(WINDOWS_VOLUME_SCRIPT).toContain('SHQueryRecycleBin')
    expect(WINDOWS_VOLUME_SCRIPT).toContain('NukeOnDelete')
  })

  it('parses the recorded output', () =>
  {
    const query = parseWindowsVolumeQuery(fixture('windows-drives.json'))
    expect(query?.noRecycle).toBe(false)
    expect(query?.drives.map((d) => d.name)).toEqual(['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\'])
    expect(query?.drives.every((d) => d.type === 'Fixed' && d.ready)).toBe(true)
    const c = windowsVolumeInfo('C:\\', query)
    expect(c).toEqual({ kind: 'local', trash: 'available', trashBytesFree: 49710 * MIB - 44902572, volumeBytes: 1999202414592 })
    expect(windowsVolumeInfo('d:\\Video\\a.mkv', query)).toEqual({ kind: 'local', trash: 'available', trashBytesFree: 478923 * MIB, volumeBytes: 10000812470272 })
    expect(windowsVolumeInfo('Q:\\a.mkv', query)).toEqual({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null })
  })

  it('maps every drive type to a kind and a bin', () =>
  {
    const query = parseWindowsVolumeQuery(fixture('windows-drives-edited.json'))
    const info = (root: string): ReturnType<typeof windowsVolumeInfo> => windowsVolumeInfo(root, query)
    expect(info('D:\\')).toMatchObject({ kind: 'local', trash: 'available', trashBytesFree: 0 })
    expect(info('E:\\')).toEqual({ kind: 'removable', trash: 'unavailable', trashBytesFree: null, volumeBytes: 62008590336 })
    expect(info('F:\\')).toMatchObject({ kind: 'local', trash: 'unavailable', trashBytesFree: null })
    expect(info('G:\\')).toMatchObject({ kind: 'local', trash: 'available', trashBytesFree: null, volumeBytes: 2000263573504 })
    expect(info('R:\\')).toEqual({ kind: 'removable', trash: 'unavailable', trashBytesFree: null, volumeBytes: null })
    expect(info('S:\\')).toEqual({ kind: 'local', trash: 'unknown', trashBytesFree: null, volumeBytes: 4294967296 })
    expect(info('X:\\')).toEqual({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null })
    expect(info('Z:\\')).toEqual({ kind: 'network', trash: 'unavailable', trashBytesFree: null, volumeBytes: null })
    expect(info('\\\\nas\\media\\')).toEqual({ kind: 'network', trash: 'unavailable', trashBytesFree: null, volumeBytes: null })
    expect(windowsVolumeInfo('\\\\nas\\media\\a.mkv', null).kind).toBe('network')
    expect(windowsVolumeInfo('C:\\', null).kind).toBe('unknown')
  })

  it('reads every bin as unavailable under the NoRecycleFiles policy', () =>
  {
    const query = parseWindowsVolumeQuery(fixture('windows-drives.json').replace('"noRecycle":false', '"noRecycle":true'))
    expect(windowsVolumeInfo('C:\\', query)).toMatchObject({ kind: 'local', trash: 'unavailable', trashBytesFree: null })
  })

  it.each(['Fixed', 'Ram', 'Removable', 'CDRom', 'Network', 'NoRootDirectory', 'Unknown', 'Something'])('maps DriveType %s', (type) =>
  {
    const expected: Record<string, string> = { Fixed: 'local', Ram: 'local', Removable: 'removable', CDRom: 'removable', Network: 'network' }
    expect(driveTypeKind(type)).toBe(expected[type] ?? 'unknown')
  })

  it('rejects output that is not the query JSON', () =>
  {
    expect(parseWindowsVolumeQuery('')).toBeNull()
    expect(parseWindowsVolumeQuery('Add-Type : Cannot add type.')).toBeNull()
    expect(parseWindowsVolumeQuery('null')).toBeNull()
    expect(parseWindowsVolumeQuery('{"noRecycle":false}')).toBeNull()
    expect(parseWindowsVolumeQuery('{"drives":null}')).toEqual({ noRecycle: false, drives: [] })
  })

  it('accepts a single drive, a byte order mark, and drops malformed entries', () =>
  {
    const one = '\uFEFF{"noRecycle":false,"drives":{"name":"c:\\\\","type":"Fixed","ready":true,"totalBytes":100,"freeBytes":50,"volume":"","binMaxMiB":"7","binNuke":0,"binBytes":null}}\r\n'
    const parsed = parseWindowsVolumeQuery(one)
    expect(parsed?.drives).toEqual([{ name: 'C:\\', type: 'Fixed', ready: true, totalBytes: 100, freeBytes: 50, volume: null, binMaxMiB: null, binNuke: 0, binBytes: null }])
    expect(parseWindowsVolumeQuery('{"drives":[null,7,{"name":"nope"},{"name":"D:\\\\"}]}')?.drives).toEqual([
      { name: 'D:\\', type: 'Unknown', ready: false, totalBytes: null, freeBytes: null, volume: null, binMaxMiB: null, binNuke: null, binBytes: null }
    ])
  })

  it('never reports negative room in a bin past its maximum', () =>
  {
    const drive = { name: 'C:\\', type: 'Fixed', ready: true, totalBytes: 1, freeBytes: 1, volume: null, binMaxMiB: 1, binNuke: 0, binBytes: 2 * MIB }
    expect(binRoom(drive)).toBe(0)
    expect(binRoom({ ...drive, binBytes: null })).toBeNull()
  })
})

describe('mount tables', () =>
{
  it('parses the recorded Linux table with its octal escapes', () =>
  {
    const mounts = parseProcMounts(fixture('linux-proc-mounts.txt'))
    expect(mounts.find((m) => m.root === '/')).toEqual({ source: '/dev/sdd', root: '/', fsType: 'ext4' })
    expect(mounts.find((m) => m.root === '/mnt/host/c')).toEqual({ source: 'C:\\', root: '/mnt/host/c', fsType: '9p' })
    expect(posixVolumeInfo('/mnt/host/c/Music/a.flac', mounts)).toEqual({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null })
    expect(volumeRoot('/mnt/host/d/a.mkv', 'linux', mounts)).toBe('/mnt/host/d')
  })

  it('finds network mounts on Linux', () =>
  {
    const mounts = parseProcMounts(fixture('linux-proc-mounts-network.txt'))
    expect(posixVolumeInfo('/mnt/nas/Season 1/a.mkv', mounts).kind).toBe('network')
    expect(posixVolumeInfo('/mnt/nfs video/a.mkv', mounts).kind).toBe('network')
    expect(volumeRoot('/mnt/nfs video/a.mkv', 'linux', mounts)).toBe('/mnt/nfs video')
    expect(posixVolumeInfo('/home/tony/remote/a.mkv', mounts).kind).toBe('network')
    expect(posixVolumeInfo('/media/tony/USB Stick/a.mkv', mounts).kind).toBe('unknown')
    expect(posixVolumeInfo('/home/tony/a.mkv', mounts).kind).toBe('unknown')
  })

  it('parses the macOS mount listing', () =>
  {
    const mounts = parseMountOutput(fixture('macos-mount.txt'))
    expect(mounts).toHaveLength(9)
    expect(mounts.find((m) => m.root === '/Volumes/USB Stick')?.fsType).toBe('msdos')
    expect(posixVolumeInfo('/Volumes/Media/a.mkv', mounts).kind).toBe('network')
    expect(posixVolumeInfo('/Volumes/video/a.mkv', mounts).kind).toBe('network')
    expect(posixVolumeInfo('/Volumes/Archive/a.mkv', mounts).kind).toBe('network')
    expect(posixVolumeInfo('/Users/tony/a.mkv', mounts).kind).toBe('unknown')
    expect(parseMountOutput('garbage\n\n')).toEqual([])
  })
})

function windowsQueries(outputs: Array<string | Error>): VolumeQueries & { calls: number }
{
  const queries = {
    calls: 0,
    windows: async (): Promise<string> =>
    {
      const next = outputs[Math.min(queries.calls, outputs.length - 1)]
      queries.calls++
      if (next instanceof Error)
      {
        throw next
      }
      return next
    },
    mounts: async (): Promise<string | null> => null
  }
  return queries
}

describe('the volume registry', () =>
{
  it('caches every drive of one query for the session', async () =>
  {
    const queries = windowsQueries([fixture('windows-drives.json')])
    const registry = createVolumeRegistry({ platform: 'win32', queries })
    const [c, d] = await Promise.all([registry.info('C:\\Music\\a.wav'), registry.info('D:\\b.wav')])
    expect(c.kind).toBe('local')
    expect(d.trashBytesFree).toBe(478923 * MIB)
    await registry.info('H:\\c.wav')
    await registry.info('c:\\other.wav')
    expect(queries.calls).toBe(1)
    expect(await registry.key('C:\\a')).toBe('c:\\')
    expect(await registry.root('c:\\a')).toBe('C:\\')
  })

  it('answers UNC paths without a query and asks again for a drive the query did not list', async () =>
  {
    const queries = windowsQueries([fixture('windows-drives.json')])
    const registry = createVolumeRegistry({ platform: 'win32', queries })
    expect(await registry.info('\\\\nas\\media\\a.mkv')).toMatchObject({ kind: 'network', trash: 'unavailable' })
    expect(await registry.isNetwork('\\\\nas\\media\\a.mkv')).toBe(true)
    expect(queries.calls).toBe(0)
    expect((await registry.info('Q:\\a.mkv')).kind).toBe('unknown')
    expect((await registry.info('Q:\\b.mkv')).kind).toBe('unknown')
    expect(queries.calls).toBe(2)
    expect(await registry.isNetwork('Q:\\b.mkv')).toBe(false)
  })

  it('keeps a failed query as unknown for the session and logs it', async () =>
  {
    const log = vi.fn()
    const queries = windowsQueries([new Error('powershell.exe not found'), fixture('windows-drives.json')])
    const registry = createVolumeRegistry({ platform: 'win32', queries, log })
    expect(await registry.info('C:\\a.wav')).toEqual({ kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null })
    expect(await registry.info('C:\\b.wav')).toMatchObject({ kind: 'unknown' })
    expect(queries.calls).toBe(1)
    expect(log).toHaveBeenCalledWith('The drive query failed: powershell.exe not found')
    const garbled = createVolumeRegistry({ platform: 'win32', queries: windowsQueries(['not json']), log })
    expect((await garbled.info('C:\\a.wav')).kind).toBe('unknown')
    expect(log).toHaveBeenCalledWith('The drive query returned output that could not be read')
    const quiet = createVolumeRegistry({ platform: 'win32', queries: windowsQueries([new Error('x'), 'x']) })
    expect((await quiet.info('C:\\a.wav')).kind).toBe('unknown')
    expect((await quiet.info('D:\\a.wav')).kind).toBe('unknown')
  })

  it('reads the bin room again on every refresh', async () =>
  {
    const first = fixture('windows-drives.json')
    const fuller = first.replace('"binBytes":44902572', `"binBytes":${49000 * MIB}`)
    const nuked = first.replace('"binMaxMiB":49710,"binNuke":0', '"binMaxMiB":49710,"binNuke":1')
    const queries = windowsQueries([first, fuller, new Error('busy'), nuked, first])
    const registry = createVolumeRegistry({ platform: 'win32', queries })
    expect(await registry.refreshTrash('C:\\a.wav')).toEqual({ trash: 'available', trashBytesFree: 49710 * MIB - 44902572 })
    expect(queries.calls).toBe(1)
    expect(await registry.refreshTrash('C:\\a.wav')).toEqual({ trash: 'available', trashBytesFree: 710 * MIB })
    expect((await registry.info('C:\\b.wav')).trashBytesFree).toBe(710 * MIB)
    expect(await registry.refreshTrash('C:\\a.wav')).toEqual({ trash: 'available', trashBytesFree: null })
    expect(await registry.refreshTrash('C:\\a.wav')).toEqual({ trash: 'unavailable', trashBytesFree: null })
    expect(await registry.refreshTrash('C:\\a.wav')).toEqual({ trash: 'unavailable', trashBytesFree: null })
    expect(queries.calls).toBe(4)
  })

  it('keeps a volume marked after an aborted trash for the rest of the session', async () =>
  {
    const queries = windowsQueries([fixture('windows-drives.json')])
    const registry = createVolumeRegistry({ platform: 'win32', queries })
    await registry.info('D:\\a.wav')
    await registry.markTrashUnavailable('D:\\a.wav')
    expect(await registry.info('D:\\b.wav')).toMatchObject({ kind: 'local', trash: 'unavailable', trashBytesFree: null })
    expect(await registry.refreshTrash('D:\\b.wav')).toEqual({ trash: 'unavailable', trashBytesFree: null })
    await registry.markTrashUnavailable('Y:\\a.wav')
    expect(await registry.info('Y:\\b.wav')).toMatchObject({ kind: 'unknown', trash: 'unavailable' })
    expect(await registry.refreshTrash('\\\\nas\\media\\a.wav')).toEqual({ trash: 'unavailable', trashBytesFree: null })
    expect(queries.calls).toBe(1)
  })

  it('keeps a mark that lands while a refresh is reading the bin', async () =>
  {
    let release: (value: string) => void = () => undefined
    const text = fixture('windows-drives.json')
    let calls = 0
    const queries: VolumeQueries = {
      windows: () =>
      {
        calls++
        return calls === 1 ? Promise.resolve(text) : new Promise((resolve) =>
        {
          release = resolve
        })
      },
      mounts: async () => null
    }
    const registry = createVolumeRegistry({ platform: 'win32', queries })
    await registry.info('C:\\a.wav')
    const refreshing = registry.refreshTrash('C:\\a.wav')
    await new Promise((resolve) => setImmediate(resolve))
    await registry.markTrashUnavailable('C:\\a.wav')
    release(text)
    expect(await refreshing).toEqual({ trash: 'unavailable', trashBytesFree: null })
  })

  it('reads the mount table once on macOS and Linux and never runs the Windows query', async () =>
  {
    const mounts = vi.fn(async () => fixture('macos-mount.txt'))
    const windows = vi.fn(async () => '')
    const registry = createVolumeRegistry({ platform: 'darwin', queries: { windows, mounts } })
    expect(await registry.info('/Volumes/Media/a.mkv')).toMatchObject({ kind: 'network', trash: 'unknown' })
    expect(await registry.info('/Volumes/Media/b.mkv')).toMatchObject({ kind: 'network' })
    expect(await registry.key('/Volumes/Media/a.mkv')).toBe('/Volumes/Media')
    expect(await registry.root('/Users/tony/a.mkv')).toBe('/')
    expect(await registry.isNetwork('/Volumes/video/a.mkv')).toBe(true)
    expect(await registry.isNetwork('/Volumes/Media/a.mkv')).toBe(true)
    expect(await registry.isNetwork('/Users/tony/a.mkv')).toBe(false)
    expect(await registry.refreshTrash('/Users/tony/a.mkv')).toEqual({ trash: 'unknown', trashBytesFree: null })
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(windows).not.toHaveBeenCalled()

    const linux = createVolumeRegistry({ platform: 'linux', queries: { windows, mounts: async () => fixture('linux-proc-mounts-network.txt') } })
    expect(await linux.info('/mnt/nas/a.mkv')).toMatchObject({ kind: 'network' })
    const unreadable = createVolumeRegistry({ platform: 'linux', queries: { windows, mounts: async () => Promise.reject(new Error('EACCES')) } })
    expect(await unreadable.key('/mnt/nas/a.mkv')).toBe('/')
    expect(await unreadable.info('/mnt/nas/a.mkv')).toMatchObject({ kind: 'unknown' })
    const empty = createVolumeRegistry({ platform: 'linux', queries: { windows, mounts: async () => null } })
    expect(await empty.root('/mnt/nas/a.mkv')).toBe('/')
  })
})

describe('reachability', () =>
{
  it('times out each root on its own', async () =>
  {
    const timers = createManualTimers()
    const stat = vi.fn((path: string) => path === '\\\\nas\\media\\' ? new Promise(() => undefined) : Promise.resolve({}))
    const reach = createReachability({ stat, timers })
    const share = reach.reachable('\\\\nas\\media\\', REACHABLE_TIMEOUT_MS)
    const local = reach.reachable('C:\\', REACHABLE_TIMEOUT_MS)
    await timers.flush()
    expect(await local).toBe(true)
    let settled = false
    void share.then(() =>
    {
      settled = true
    })
    await timers.advance(REACHABLE_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await timers.advance(1)
    expect(await share).toBe(false)
    expect(timers.pending()).toBe(0)
  })

  it('joins a stat still running instead of starting another', async () =>
  {
    const timers = createManualTimers()
    let answer: () => void = () => undefined
    const stat = vi.fn(() => new Promise<void>((resolve) =>
    {
      answer = resolve
    }))
    const reach = createReachability({ stat, timers })
    const first = reach.reachable('\\\\nas\\media\\', 5000)
    await timers.advance(5000)
    expect(await first).toBe(false)
    const second = reach.reachable('\\\\nas\\media\\', 5000)
    await timers.flush()
    expect(stat).toHaveBeenCalledTimes(1)
    answer()
    expect(await second).toBe(true)
    const third = reach.reachable('\\\\nas\\media\\', 5000)
    await timers.flush()
    answer()
    expect(await third).toBe(true)
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('counts an access error as an answer and a missing root as offline', async () =>
  {
    const timers = createManualTimers()
    const error = (code: string): Error => Object.assign(new Error(code), { code })
    const stat = vi.fn(async (path: string) =>
    {
      throw error(path === 'D:\\' ? 'EACCES' : path === 'E:\\' ? 'EPERM' : 'ENOENT')
    })
    const reach = createReachability({ stat, timers })
    expect(await reach.reachable('D:\\', 5000)).toBe(true)
    expect(await reach.reachable('E:\\', 5000)).toBe(true)
    expect(await reach.reachable('Q:\\', 5000)).toBe(false)
    const throwing = createReachability({
      stat: () =>
      {
        throw null
      },
      timers
    })
    expect(await throwing.reachable('Q:\\', 5000)).toBe(false)
  })

  it('checks network roots one at a time and local roots together', async () =>
  {
    const timers = createManualTimers()
    const order: string[] = []
    let active = 0
    let most = 0
    const stat = async (path: string): Promise<void> =>
    {
      order.push(`start ${path}`)
      if (path.startsWith('\\\\'))
      {
        active++
        most = Math.max(most, active)
        await timers.sleep(path === '\\\\slow\\share\\' ? 10000 : 100)
        active--
      }
      order.push(`end ${path}`)
    }
    const reach = createReachability({ stat, timers })
    const checking = checkRoots([
      { root: '\\\\slow\\share\\', network: true },
      { root: 'C:\\', network: false },
      { root: '\\\\nas\\media\\', network: true },
      { root: 'D:\\', network: false }
    ], reach)
    await timers.runAll()
    const results = await checking
    expect(results.get('\\\\slow\\share\\')).toBe(false)
    expect(results.get('\\\\nas\\media\\')).toBe(true)
    expect(results.get('C:\\')).toBe(true)
    expect(results.get('D:\\')).toBe(true)
    expect(order.indexOf('start \\\\nas\\media\\')).toBeGreaterThan(order.indexOf('start \\\\slow\\share\\'))
    expect(most).toBeLessThanOrEqual(2)
  })
})
