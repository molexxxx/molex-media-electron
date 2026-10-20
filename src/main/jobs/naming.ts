/**
 * Names the engine gives to files and folders it creates beside a user's files: execution work folders, partial
 * outputs, displaced files, and renamed outputs, plus the path keys used to compare paths per platform.
 */

import { posix, win32 } from 'node:path'
import { truncateSegment } from '../../shared/jobs/template'
import type { Platform } from '../../shared/text/platform'

/** Every work folder name starts with this prefix and ends with `WORK_DIR_SUFFIX`. */
export const WORK_DIR_PREFIX = '.molex-'
export const WORK_DIR_SUFFIX = '.partial'
/** The marker file inside every work folder. */
export const MARKER_FILE = 'job.json'
/** The subfolder a frames output is written into before it is renamed out. */
export const FRAMES_PART_DIR = 'frames.part'
/** The two-pass log prefix inside the work folder (`-passlogfile <work>/pass`). */
export const PASS_LOG_NAME = 'pass'
/** The non-media suffix of every encode output inside the work folder. */
export const PART_SUFFIX = '.part'
/** Rename numbering starts here. */
export const RENAME_FIRST = 2
/** Rename numbering stops here; past it the name is an error. */
export const RENAME_LAST = 9999
/** Paths longer than this on Windows get a warning. */
export const WINDOWS_PATH_LIMIT = 259
/** The longest file name component, in UTF-8 bytes, a displaced or numbered name may reach. */
export const MAX_NAME_BYTES = 255

const WORK_DIR_PATTERN = /^\.molex-(.+)-a(\d+)-x(\d+)\.partial$/i

/** What a displaced name says about the file: an overwritten output or a replaced original. */
export type DisplacedKind = 'previous' | 'original'

/** A work folder name taken apart. */
export interface WorkDirName
{
  catalog: string
  attempt: number
  execution: number
}

/** The path functions of a platform, so callers never read the host platform. */
export function pathApi(platform: Platform): typeof win32
{
  return platform === 'win32' ? win32 : posix
}

function assertCount(value: number, name: string): void
{
  if (!Number.isInteger(value) || value < 1)
  {
    throw new RangeError(`${name} must be a positive integer, got ${value}`)
  }
}

/** The folder name of one execution, for example `.molex-MM-0142-a1-x2.partial`. */
export function workDirName(catalog: string, attempt: number, execution: number): string
{
  assertCount(attempt, 'attempt')
  assertCount(execution, 'execution')
  return `${WORK_DIR_PREFIX}${catalog}-a${attempt}-x${execution}${WORK_DIR_SUFFIX}`
}

/** Parses a work folder name; null for any other name. */
export function parseWorkDirName(name: string): WorkDirName | null
{
  const match = WORK_DIR_PATTERN.exec(name)
  if (!match)
  {
    return null
  }
  const attempt = Number(match[2])
  const execution = Number(match[3])
  if (attempt < 1 || execution < 1 || !Number.isSafeInteger(attempt) || !Number.isSafeInteger(execution))
  {
    return null
  }
  return { catalog: match[1], attempt, execution }
}

/** Whether a folder name is a work folder, which folder scans skip. */
export function isWorkDirName(name: string): boolean
{
  return name.length > WORK_DIR_PREFIX.length + WORK_DIR_SUFFIX.length &&
    name.toLowerCase().startsWith(WORK_DIR_PREFIX) &&
    name.toLowerCase().endsWith(WORK_DIR_SUFFIX)
}

/** The work folder of one execution, beside the final path. */
export function workDirPath(finalPath: string, catalog: string, attempt: number, execution: number, platform: Platform): string
{
  const p = pathApi(platform)
  return p.join(p.dirname(finalPath), workDirName(catalog, attempt, execution))
}

/** Whether a path is a work folder or lies inside one. */
export function isInsideWorkDir(target: string, platform: Platform): boolean
{
  const p = pathApi(platform)
  const segments = p.resolve(target).split(platform === 'win32' ? /[\\/]/ : '/')
  return segments.some(isWorkDirName)
}

/** The name of one encode pass's output, for example `out-e1.mkv.part`. */
export function partOutputName(encodePass: number, ext: string): string
{
  assertCount(encodePass, 'encodePass')
  const bare = ext.startsWith('.') ? ext.slice(1) : ext
  if (bare === '')
  {
    throw new RangeError('A partial output needs an extension')
  }
  return `out-e${encodePass}.${bare}${PART_SUFFIX}`
}

/** The path of one encode pass's output inside a work folder. */
export function partOutputPath(workDir: string, encodePass: number, ext: string, platform: Platform): string
{
  return pathApi(platform).join(workDir, partOutputName(encodePass, ext))
}

/** The frames subfolder inside a work folder. */
export function framesPartPath(workDir: string, platform: Platform): string
{
  return pathApi(platform).join(workDir, FRAMES_PART_DIR)
}

/** The two-pass log prefix inside a work folder. */
export function passLogPath(workDir: string, platform: Platform): string
{
  return pathApi(platform).join(workDir, PASS_LOG_NAME)
}

/** The marker file inside a work folder. */
export function markerPath(workDir: string, platform: Platform): string
{
  return pathApi(platform).join(workDir, MARKER_FILE)
}

/** Splits a file name at its last dot; a leading dot belongs to the stem, and `ext` keeps its dot. */
export function splitName(fileName: string): { stem: string; ext: string }
{
  const ext = posix.extname(fileName)
  return { stem: fileName.slice(0, fileName.length - ext.length), ext }
}

function utf8Bytes(text: string): number
{
  return new TextEncoder().encode(text).length
}

function withSuffix(fileName: string, suffix: string): string
{
  const { stem, ext } = splitName(fileName)
  const room = MAX_NAME_BYTES - utf8Bytes(suffix) - utf8Bytes(ext)
  const kept = utf8Bytes(stem) > room ? truncateSegment(stem, room) : stem
  return `${kept}${suffix}${ext}`
}

/** `song.wav` as `song (previous).wav`, then `song (previous 2).wav`; originals read `(original)`. */
export function displacedName(fileName: string, kind: DisplacedKind, n: number = 1): string
{
  assertCount(n, 'n')
  return withSuffix(fileName, n === 1 ? ` (${kind})` : ` (${kind} ${n})`)
}

/** The displaced name of a file in its own folder. */
export function displacedPath(filePath: string, kind: DisplacedKind, n: number, platform: Platform): string
{
  const p = pathApi(platform)
  return p.join(p.dirname(filePath), displacedName(p.basename(filePath), kind, n))
}

/** The first displaced path that `isTaken` does not claim; null once the numbering passes `RENAME_LAST`. */
export function nextFreeDisplacedPath(filePath: string, kind: DisplacedKind, isTaken: (candidate: string) => boolean, platform: Platform): { path: string; n: number } | null
{
  for (let n = 1; n <= RENAME_LAST; n++)
  {
    const candidate = displacedPath(filePath, kind, n, platform)
    if (!isTaken(candidate))
    {
      return { path: candidate, n }
    }
  }
  return null
}

/** `song.wav` numbered as `song (2).wav`. */
export function numberedName(fileName: string, n: number): string
{
  if (!Number.isInteger(n) || n < RENAME_FIRST || n > RENAME_LAST)
  {
    throw new RangeError(`Rename numbers run from ${RENAME_FIRST} to ${RENAME_LAST}, got ${n}`)
  }
  return withSuffix(fileName, ` (${n})`)
}

/**
 * The rename rule: the first numbered path from 2 that `isTaken` does not claim (a file exists there or another job
 * reserved it); null when every number up to `RENAME_LAST` is taken.
 */
export function nextRenamedPath(filePath: string, isTaken: (candidate: string) => boolean, platform: Platform): { path: string; n: number } | null
{
  const p = pathApi(platform)
  const dir = p.dirname(filePath)
  const base = p.basename(filePath)
  for (let n = RENAME_FIRST; n <= RENAME_LAST; n++)
  {
    const candidate = p.join(dir, numberedName(base, n))
    if (!isTaken(candidate))
    {
      return { path: candidate, n }
    }
  }
  return null
}

/**
 * The key two paths are compared by. Windows: the resolved path, lowercased and NFC. macOS: NFC and lowercased,
 * since APFS defaults to case- and normalization-insensitive. Linux: the resolved path as is.
 */
export function pathKey(target: string, platform: Platform): string
{
  if (platform === 'win32')
  {
    return win32.resolve(target).toLowerCase().normalize('NFC')
  }
  const resolved = posix.resolve(target)
  return platform === 'darwin' ? resolved.normalize('NFC').toLowerCase().normalize('NFC') : resolved
}

/** Whether two paths name the same file under the platform's comparison rules. */
export function samePath(a: string, b: string, platform: Platform): boolean
{
  return pathKey(a, platform) === pathKey(b, platform)
}

/** Whether a path is long enough on Windows that some programs cannot open it. */
export function exceedsPathLimit(target: string, platform: Platform): boolean
{
  return platform === 'win32' && target.length > WINDOWS_PATH_LIMIT
}
