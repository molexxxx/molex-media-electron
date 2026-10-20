/**
 * Volumes as the engine sees them: the root and key of the volume that holds a path, its kind and Recycle Bin, the
 * room left in that bin, the bytes running jobs have committed on it, and whether its root answers in time.
 */

import { posix, win32 } from 'node:path'
import type { VolumeKind } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { Timers } from '../timers'
import type { VolumeInfo } from './deps'

export const MIB = 1024 * 1024
export const GIB = 1024 * MIB
/** Kept free on every destination volume while jobs run. */
export const DISK_MARGIN_BYTES = 256 * MIB
/** Kept free on the volume that holds userData, so the queue can always be saved. */
export const USER_DATA_MARGIN_BYTES = GIB
/** A job starts only when the free space covers this multiple of its reserve, plus the margin. */
export const RESERVE_FACTOR = 1.1
/** The share of free space a volume's estimates may fill before it reads `tight`. */
export const TIGHT_SHARE = 0.8
/** With an unreadable bin on Windows, displaced files above this share of the volume block the run. */
export const UNREADABLE_BIN_SHARE = 0.05
/** How long a volume root or folder has to answer a stat before recovery treats it as offline. */
export const REACHABLE_TIMEOUT_MS = 5000

const LONG_PREFIX = /^[\\/]{2}[?.][\\/]/
const LONG_UNC_PREFIX = /^[\\/]{2}[?.][\\/]UNC[\\/]/i
const DRIVE = /^([a-zA-Z]):(?:[\\/]|$)/
const UNC = /^[\\/]{2}([^\\/?.][^\\/]*|\.[^\\/]+)[\\/]+([^\\/]+)/

/** A mounted file system on macOS or Linux. */
export interface MountEntry
{
  /** The mount point, an absolute POSIX path. */
  root: string
  fsType: string
  source: string
}

function stripLongPrefix(target: string): string
{
  if (LONG_UNC_PREFIX.test(target))
  {
    return `\\\\${target.replace(LONG_UNC_PREFIX, '')}`
  }
  return LONG_PREFIX.test(target) ? target.replace(LONG_PREFIX, '') : target
}

/** Whether a path names a network share by its UNC name (`\\server\share`), which Windows gives no Recycle Bin. */
export function isUncPath(target: string, platform: Platform): boolean
{
  return platform === 'win32' && UNC.test(stripLongPrefix(target))
}

function windowsRoot(target: string): string
{
  const bare = stripLongPrefix(target)
  const unc = UNC.exec(bare)
  if (unc)
  {
    return `\\\\${unc[1]}\\${unc[2]}\\`
  }
  const drive = DRIVE.exec(bare)
  if (drive)
  {
    return `${drive[1].toUpperCase()}:\\`
  }
  return win32.parse(win32.resolve(bare)).root
}

/** The mount that holds a POSIX path: the longest mount point that is the path or one of its parents. */
export function mountOf(target: string, mounts: readonly MountEntry[]): MountEntry | null
{
  const resolved = posix.resolve(target)
  let best: MountEntry | null = null
  for (const mount of mounts)
  {
    const root = mount.root === '/' ? '/' : mount.root.replace(/\/+$/, '')
    const inside = root === '/' || resolved === root || resolved.startsWith(`${root}/`)
    if (inside && (best === null || root.length > best.root.replace(/\/+$/, '').length))
    {
      best = mount
    }
  }
  return best
}

/** The root of the volume that holds a path: `C:\`, `\\server\share\`, or the mount point on macOS and Linux. */
export function volumeRoot(target: string, platform: Platform, mounts: readonly MountEntry[] = []): string
{
  if (platform === 'win32')
  {
    return windowsRoot(target)
  }
  return mountOf(target, mounts)?.root ?? '/'
}

/** The key volumes are compared and grouped by; Windows roots compare without case. */
export function volumeKey(target: string, platform: Platform, mounts: readonly MountEntry[] = []): string
{
  const root = volumeRoot(target, platform, mounts)
  return platform === 'win32' ? root.toLowerCase() : root
}

/** How a volume is named in messages: `D:`, `\\nas\media`, or the mount point. */
export function volumeLabel(root: string, platform: Platform): string
{
  if (platform !== 'win32')
  {
    return root
  }
  return root.replace(/[\\/]+$/, '')
}

/** One claimed or active job's hold on its destination volume. */
export interface VolumeCommitment
{
  jobId: string
  volume: string
  reserveBytes: number
  /** `total_size` from the current encode pass's progress; null before the first sample and for passes that write nothing. */
  bytesWritten: number | null
}

function finiteOrZero(value: number | null | undefined): number
{
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** What a job still holds back on its volume: its reserve less what the current pass has written, never below 0. */
export function jobCommitment(reserveBytes: number, bytesWritten: number | null): number
{
  return Math.max(0, finiteOrZero(reserveBytes) - Math.max(0, finiteOrZero(bytesWritten)))
}

/** The bytes the other jobs on a volume have committed; `exceptJobId` leaves out the job being checked. */
export function committedBytes(commitments: Iterable<VolumeCommitment>, volume: string, exceptJobId: string | null = null): number
{
  let total = 0
  for (const c of commitments)
  {
    if (c.volume === volume && c.jobId !== exceptJobId)
    {
      total += jobCommitment(c.reserveBytes, c.bytesWritten)
    }
  }
  return total
}

/** The space kept free on a volume: 1 GiB where userData lives, so the queue can always be saved, else 256 MiB. */
export function volumeMargin(volume: string, userDataVolume: string): number
{
  return volume === userDataVolume ? USER_DATA_MARGIN_BYTES : DISK_MARGIN_BYTES
}

/** Whether a job may start: `free - committed >= 1.1 * reserve + margin`. */
export function fitsOnVolume(check: { freeBytes: number; committedBytes: number; reserveBytes: number; marginBytes: number }): boolean
{
  return check.freeBytes - check.committedBytes >= RESERVE_FACTOR * Math.max(0, check.reserveBytes) + check.marginBytes
}

/**
 * A volume's preflight status: `insufficient` when one job's estimate exceeds the free space, `tight` when the sum
 * reaches 80 percent of it, `unknown` when the free space could not be read.
 */
export function volumeStatus(estimates: readonly number[], freeBytes: number | null): 'ok' | 'tight' | 'insufficient' | 'unknown'
{
  if (freeBytes === null || !Number.isFinite(freeBytes))
  {
    return 'unknown'
  }
  let sum = 0
  for (const bytes of estimates)
  {
    if (bytes > freeBytes)
    {
      return 'insufficient'
    }
    sum += Math.max(0, bytes)
  }
  return sum >= TIGHT_SHARE * freeBytes ? 'tight' : 'ok'
}

/**
 * Whether the files a report would send to one volume's bin need more room than it has. Only Windows bins purge by
 * size: an unreadable bin blocks once the files pass 5 percent of the volume, and a volume whose bin is unavailable
 * sends nothing there.
 */
export function trashTooSmall(neededBytes: number, info: { trash: string; trashBytesFree: number | null; volumeBytes: number | null }, platform: Platform): boolean
{
  if (platform !== 'win32' || neededBytes <= 0 || info.trash === 'unavailable')
  {
    return false
  }
  if (info.trashBytesFree !== null)
  {
    return neededBytes > info.trashBytesFree
  }
  return info.volumeBytes !== null && neededBytes > UNREADABLE_BIN_SHARE * info.volumeBytes
}

/** Whether one file still fits in the room a bin has left; an unknown room never refuses. */
export function fitsInTrash(sizeBytes: number, trashBytesFree: number | null): boolean
{
  return trashBytesFree === null || sizeBytes <= trashBytesFree
}

/** The reason a file stays beside its output because the bin is full. */
export function binFullReason(label: string): string
{
  return `The Recycle Bin on ${label} is full; moving this file there would delete older items permanently.`
}

/**
 * The one-shot Windows query: every drive from `[System.IO.DriveInfo]::GetDrives()` (its `DriveType` names do not
 * depend on the display language), and for ready fixed drives the bin's BitBucket `MaxCapacity` and `NukeOnDelete`
 * under the volume GUID plus its current size from `SHQueryRecycleBin`. Network drives skip `IsReady`, which can
 * stall on a disconnected share. Prints one line of JSON.
 */
export const WINDOWS_VOLUME_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$ProgressPreference = "SilentlyContinue"',
  '$native = $true',
  'try',
  '{',
  '  Add-Type -Namespace MolexMedia -Name VolumeQuery -MemberDefinition "[StructLayout(LayoutKind.Sequential)] public struct BinInfo { public int cbSize; public long i64Size; public long i64NumItems; } [DllImport(""shell32.dll"", CharSet = CharSet.Unicode)] public static extern int SHQueryRecycleBin(string root, ref BinInfo info); [DllImport(""kernel32.dll"", CharSet = CharSet.Unicode)] public static extern bool GetVolumeNameForVolumeMountPoint(string mountPoint, System.Text.StringBuilder name, int size);"',
  '}',
  'catch',
  '{',
  '  $native = $false',
  '}',
  '$noRecycle = $false',
  'foreach ($hive in "HKLM", "HKCU")',
  '{',
  '  $policy = Get-Item -LiteralPath ($hive + ":\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer") -ErrorAction SilentlyContinue',
  '  if ($policy -and $policy.GetValue("NoRecycleFiles") -eq 1) { $noRecycle = $true }',
  '}',
  '$bins = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\"',
  '$drives = @()',
  'foreach ($d in [System.IO.DriveInfo]::GetDrives())',
  '{',
  '  $o = [ordered]@{ name = $d.Name; type = [string]$d.DriveType; ready = $false; totalBytes = $null; freeBytes = $null; volume = $null; binMaxMiB = $null; binNuke = $null; binBytes = $null }',
  '  if ($o.type -ne "Network")',
  '  {',
  '    try',
  '    {',
  '      if ($d.IsReady) { $o.ready = $true; $o.totalBytes = $d.TotalSize; $o.freeBytes = $d.AvailableFreeSpace }',
  '    }',
  '    catch { }',
  '  }',
  '  if ($native -and $o.ready -and $o.type -eq "Fixed")',
  '  {',
  '    try',
  '    {',
  '      $name = New-Object System.Text.StringBuilder 64',
  '      if ([MolexMedia.VolumeQuery]::GetVolumeNameForVolumeMountPoint($d.Name, $name, 64)) { $o.volume = $name.ToString() }',
  '      if ($o.volume -match "\\{[0-9A-Fa-f-]+\\}")',
  '      {',
  '        $bin = Get-Item -LiteralPath ($bins + $Matches[0]) -ErrorAction SilentlyContinue',
  '        if ($bin) { $o.binMaxMiB = $bin.GetValue("MaxCapacity"); $o.binNuke = $bin.GetValue("NukeOnDelete") }',
  '      }',
  '      $info = New-Object MolexMedia.VolumeQuery+BinInfo',
  '      $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)',
  '      if ([MolexMedia.VolumeQuery]::SHQueryRecycleBin($d.Name, [ref]$info) -eq 0) { $o.binBytes = $info.i64Size }',
  '    }',
  '    catch { }',
  '  }',
  '  $drives += [pscustomobject]$o',
  '}',
  'ConvertTo-Json -InputObject ([pscustomobject]@{ noRecycle = $noRecycle; drives = $drives }) -Compress -Depth 3'
].join('\n')

/** The arguments that run a script in Windows PowerShell with no profile and no prompts; the script travels as UTF-16LE base64. */
export function powershellArgs(script: string): string[]
{
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** Windows PowerShell by its full path under SystemRoot, so a program on the PATH cannot stand in for it. */
export function powershellPath(systemRoot: string | undefined): string
{
  return win32.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** One drive as the Windows query reports it. */
export interface WindowsDrive
{
  name: string
  type: string
  ready: boolean
  totalBytes: number | null
  freeBytes: number | null
  volume: string | null
  binMaxMiB: number | null
  binNuke: number | null
  binBytes: number | null
}

/** The Windows query's result. */
export interface WindowsVolumeQuery
{
  /** The NoRecycleFiles policy, which deletes every file at once. */
  noRecycle: boolean
  drives: WindowsDrive[]
}

function numberOrNull(value: unknown): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null
{
  return typeof value === 'string' && value !== '' ? value : null
}

function toDrive(value: unknown): WindowsDrive | null
{
  if (typeof value !== 'object' || value === null)
  {
    return null
  }
  const v = value as Record<string, unknown>
  const name = stringOrNull(v.name)
  if (name === null || !DRIVE.test(name))
  {
    return null
  }
  return {
    name: `${name[0].toUpperCase()}:\\`,
    type: stringOrNull(v.type) ?? 'Unknown',
    ready: v.ready === true,
    totalBytes: numberOrNull(v.totalBytes),
    freeBytes: numberOrNull(v.freeBytes),
    volume: stringOrNull(v.volume),
    binMaxMiB: numberOrNull(v.binMaxMiB),
    binNuke: numberOrNull(v.binNuke),
    binBytes: numberOrNull(v.binBytes)
  }
}

/** Parses the Windows query's output; null when it is not the expected JSON. */
export function parseWindowsVolumeQuery(stdout: string): WindowsVolumeQuery | null
{
  let parsed: unknown
  try
  {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  }
  catch
  {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('drives' in parsed))
  {
    return null
  }
  const raw = (parsed as { drives: unknown }).drives
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw]
  const drives = list.map(toDrive).filter((d): d is WindowsDrive => d !== null)
  return { noRecycle: (parsed as { noRecycle?: unknown }).noRecycle === true, drives }
}

/** What `DriveType` says about a drive's kind; the names are the same in every display language. */
export function driveTypeKind(type: string): VolumeKind
{
  switch (type)
  {
    case 'Fixed':
    case 'Ram':
      return 'local'
    case 'Removable':
    case 'CDRom':
      return 'removable'
    case 'Network':
      return 'network'
    default:
      return 'unknown'
  }
}

const UNKNOWN_VOLUME: VolumeInfo = { kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null }
const NETWORK_SHARE: VolumeInfo = { kind: 'network', trash: 'unavailable', trashBytesFree: null, volumeBytes: null }

/** The room a ready fixed drive's bin has left: its maximum less its size, null when either is unknown. */
export function binRoom(drive: WindowsDrive): number | null
{
  if (drive.binMaxMiB === null || drive.binBytes === null)
  {
    return null
  }
  return Math.max(0, drive.binMaxMiB * MIB - drive.binBytes)
}

/**
 * A Windows volume's kind and bin from the query. Network, removable, and optical drives have no Recycle Bin; a fixed
 * drive's bin is unavailable when its volume or the policy deletes files at once.
 */
export function windowsVolumeInfo(root: string, query: WindowsVolumeQuery | null): VolumeInfo
{
  if (UNC.test(stripLongPrefix(root)))
  {
    return NETWORK_SHARE
  }
  const name = windowsRoot(root)
  const drive = query?.drives.find((d) => d.name === name)
  if (!drive)
  {
    return UNKNOWN_VOLUME
  }
  const kind = driveTypeKind(drive.type)
  const volumeBytes = drive.ready ? drive.totalBytes : null
  if (kind === 'network' || kind === 'removable')
  {
    return { kind, trash: 'unavailable', trashBytesFree: null, volumeBytes }
  }
  if (drive.type !== 'Fixed' || !drive.ready)
  {
    return { kind, trash: 'unknown', trashBytesFree: null, volumeBytes }
  }
  if (query?.noRecycle || drive.binNuke === 1)
  {
    return { kind, trash: 'unavailable', trashBytesFree: null, volumeBytes }
  }
  return { kind, trash: 'available', trashBytesFree: binRoom(drive), volumeBytes }
}

/** File system types that live on another machine. */
export const NETWORK_FS_TYPES: ReadonlySet<string> = new Set([
  'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'afpfs', 'webdav', 'davfs', 'fuse.davfs', 'sshfs', 'fuse.sshfs', 'ncpfs',
  'ceph', 'glusterfs', 'fuse.glusterfs', 'fuse.rclone', 'afs', 'lustre'
])

function unescapeMountField(field: string): string
{
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** Parses Linux `/proc/mounts`, whose fields escape spaces, tabs, newlines, and backslashes as octal. */
export function parseProcMounts(text: string): MountEntry[]
{
  const mounts: MountEntry[] = []
  for (const line of text.split(/\r?\n/))
  {
    const fields = line.trim().split(/\s+/)
    if (fields.length >= 3 && fields[1].startsWith('/'))
    {
      mounts.push({ source: unescapeMountField(fields[0]), root: unescapeMountField(fields[1]), fsType: fields[2] })
    }
  }
  return mounts
}

const MAC_MOUNT_LINE = /^(.+?) on (\/.*) \(([^,)]+)[^)]*\)\s*$/

/** Parses the macOS `mount` listing: `<source> on <mount point> (<type>, <options>)`. */
export function parseMountOutput(text: string): MountEntry[]
{
  const mounts: MountEntry[] = []
  for (const line of text.split(/\r?\n/))
  {
    const match = MAC_MOUNT_LINE.exec(line)
    if (match)
    {
      mounts.push({ source: match[1], root: match[2], fsType: match[3].trim() })
    }
  }
  return mounts
}

/** A macOS or Linux volume: `network` under a known network mount, else `unknown`; the trash itself decides there. */
export function posixVolumeInfo(target: string, mounts: readonly MountEntry[]): VolumeInfo
{
  const mount = mountOf(target, mounts)
  return mount !== null && NETWORK_FS_TYPES.has(mount.fsType) ? { ...UNKNOWN_VOLUME, kind: 'network' } : UNKNOWN_VOLUME
}

/** The platform queries a registry runs; the real ones spawn PowerShell or read the mount table. */
export interface VolumeQueries
{
  /** Output of `WINDOWS_VOLUME_SCRIPT`; rejects when PowerShell cannot run. */
  windows(): Promise<string>
  /** `/proc/mounts` on Linux or the `mount` listing on macOS; null when unreadable. */
  mounts(): Promise<string | null>
}

/** Volume facts for one session: kinds and bins cached per volume, bin room read fresh on request. */
export interface VolumeRegistry
{
  /** The root of the volume that holds a path. */
  root(path: string): Promise<string>
  /** The key volumes are grouped by. */
  key(path: string): Promise<string>
  info(path: string): Promise<VolumeInfo>
  /**
   * The bin read again now, before every trash step and destructive retry: Windows runs the query again (a bin set to
   * delete at once turns `unavailable`); elsewhere the cached answer stands. The room is null when unreadable.
   */
  refreshTrash(path: string): Promise<Pick<VolumeInfo, 'trash' | 'trashBytesFree'>>
  /** After the trash aborted an item that cannot be recycled, the volume reads `unavailable` for the rest of the session. */
  markTrashUnavailable(path: string): Promise<void>
  /** Whether a path lies on a network volume this session knows of, without running a query. */
  isNetwork(path: string): Promise<boolean>
}

/** A registry over the given queries; `log` hears about queries that fail. */
export function createVolumeRegistry(options: { platform: Platform; queries: VolumeQueries; log?: (message: string) => void }): VolumeRegistry
{
  const { platform, queries } = options
  const cache = new Map<string, VolumeInfo>()
  let windowsRun: Promise<WindowsVolumeQuery | null> | null = null
  let mountTable: Promise<MountEntry[]> | null = null

  function runWindowsQuery(): Promise<WindowsVolumeQuery | null>
  {
    windowsRun ??= queries.windows().then(
      (stdout) =>
      {
        const parsed = parseWindowsVolumeQuery(stdout)
        if (parsed === null)
        {
          options.log?.('The drive query returned output that could not be read')
        }
        return parsed
      },
      (err: unknown) =>
      {
        options.log?.(`The drive query failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    ).finally(() =>
    {
      windowsRun = null
    })
    return windowsRun
  }

  function loadMounts(): Promise<MountEntry[]>
  {
    mountTable ??= queries.mounts().then(
      (text) => text === null ? [] : platform === 'darwin' ? parseMountOutput(text) : parseProcMounts(text),
      () => []
    )
    return mountTable
  }

  async function root(path: string): Promise<string>
  {
    return platform === 'win32' ? volumeRoot(path, platform) : volumeRoot(path, platform, await loadMounts())
  }

  async function key(path: string): Promise<string>
  {
    return platform === 'win32' ? volumeKey(path, platform) : volumeKey(path, platform, await loadMounts())
  }

  async function info(path: string): Promise<VolumeInfo>
  {
    const k = await key(path)
    const cached = cache.get(k)
    if (cached)
    {
      return cached
    }
    if (platform !== 'win32')
    {
      const result = posixVolumeInfo(path, await loadMounts())
      cache.set(k, result)
      return result
    }
    if (isUncPath(path, platform))
    {
      cache.set(k, NETWORK_SHARE)
      return NETWORK_SHARE
    }
    const query = await runWindowsQuery()
    if (query === null)
    {
      const failed = cache.get(k) ?? UNKNOWN_VOLUME
      cache.set(k, failed)
      return failed
    }
    for (const drive of query.drives)
    {
      const driveKey = drive.name.toLowerCase()
      if (!cache.has(driveKey))
      {
        cache.set(driveKey, windowsVolumeInfo(drive.name, query))
      }
    }
    return cache.get(k) ?? UNKNOWN_VOLUME
  }

  async function refreshTrash(path: string): Promise<Pick<VolumeInfo, 'trash' | 'trashBytesFree'>>
  {
    const k = await key(path)
    const before = cache.get(k)
    const current = await info(path)
    if (before === undefined || platform !== 'win32' || current.trash === 'unavailable' || current.kind === 'network')
    {
      return { trash: current.trash, trashBytesFree: current.trashBytesFree }
    }
    const query = await runWindowsQuery()
    if (query === null)
    {
      return { trash: current.trash, trashBytesFree: null }
    }
    const fresh = windowsVolumeInfo(volumeRoot(path, platform), query)
    const latest = cache.get(k) ?? current
    const merged = latest.trash === 'unavailable' ? latest : { ...latest, trash: fresh.trash, trashBytesFree: fresh.trashBytesFree }
    cache.set(k, merged)
    return { trash: merged.trash, trashBytesFree: merged.trashBytesFree }
  }

  async function markTrashUnavailable(path: string): Promise<void>
  {
    const k = await key(path)
    const cached = cache.get(k) ?? UNKNOWN_VOLUME
    cache.set(k, { ...cached, trash: 'unavailable', trashBytesFree: null })
  }

  async function isNetwork(path: string): Promise<boolean>
  {
    if (isUncPath(path, platform))
    {
      return true
    }
    const k = await key(path)
    const cached = cache.get(k)
    if (cached)
    {
      return cached.kind === 'network'
    }
    return platform !== 'win32' && posixVolumeInfo(path, await loadMounts()).kind === 'network'
  }

  return { root, key, info, refreshTrash, markTrashUnavailable, isNetwork }
}

/** Errors that still prove the volume answered. */
const ANSWERED_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM'])

/** Checks that volume roots and folders answer a stat in time. */
export interface Reachability
{
  /**
   * Whether `path` answers a stat within `timeoutMs`. A stat still running from an earlier check on the same path is
   * joined rather than repeated, so a hung share never piles up blocked stats.
   */
  reachable(path: string, timeoutMs: number): Promise<boolean>
}

/** Reachability over an injected stat and timers. */
export function createReachability(options: { stat(path: string): Promise<unknown>; timers: Pick<Timers, 'setTimeout' | 'clearTimeout'> }): Reachability
{
  const inFlight = new Map<string, Promise<boolean>>()

  function attempt(path: string): Promise<boolean>
  {
    let pending = inFlight.get(path)
    if (!pending)
    {
      pending = Promise.resolve()
        .then(() => options.stat(path))
        .then(
          () => true,
          (err: unknown) => ANSWERED_CODES.has((err as NodeJS.ErrnoException | null)?.code ?? '')
        )
        .finally(() => inFlight.delete(path))
      inFlight.set(path, pending)
    }
    return pending
  }

  return {
    reachable(path: string, timeoutMs: number): Promise<boolean>
    {
      return new Promise((resolve) =>
      {
        const handle = options.timers.setTimeout(() => resolve(false), timeoutMs)
        void attempt(path).then((ok) =>
        {
          options.timers.clearTimeout(handle)
          resolve(ok)
        })
      })
    }
  }
}

/** Checks several roots: local ones together, network ones one at a time, each with its own timeout. */
export async function checkRoots(roots: ReadonlyArray<{ root: string; network: boolean }>, reach: Reachability, timeoutMs: number = REACHABLE_TIMEOUT_MS): Promise<Map<string, boolean>>
{
  const results = new Map<string, boolean>()
  const local = Promise.all(roots.filter((r) => !r.network).map(async (r) =>
  {
    results.set(r.root, await reach.reachable(r.root, timeoutMs))
  }))
  for (const r of roots.filter((n) => n.network))
  {
    results.set(r.root, await reach.reachable(r.root, timeoutMs))
  }
  await local
  return results
}
