import { describe, it, expect } from 'vitest'
import { posix, win32 } from 'node:path'
import {
  FRAMES_PART_DIR,
  MARKER_FILE,
  MAX_NAME_BYTES,
  PART_SUFFIX,
  PASS_LOG_NAME,
  RENAME_FIRST,
  RENAME_LAST,
  WINDOWS_PATH_LIMIT,
  WORK_DIR_PREFIX,
  WORK_DIR_SUFFIX,
  displacedName,
  displacedPath,
  exceedsPathLimit,
  framesPartPath,
  isInsideWorkDir,
  isWorkDirName,
  markerPath,
  nextFreeDisplacedPath,
  nextRenamedPath,
  numberedName,
  parseWorkDirName,
  partOutputName,
  partOutputPath,
  passLogPath,
  pathApi,
  pathKey,
  samePath,
  splitName,
  workDirName,
  workDirPath
} from '../../../src/main/jobs/naming'
import type { Platform } from '../../../src/shared/text/platform'

const bytes = (text: string): number => new TextEncoder().encode(text).length

describe('pathApi', () =>
{
  it('returns the path functions of the requested platform', () =>
  {
    expect(pathApi('win32')).toBe(win32)
    expect(pathApi('darwin')).toBe(posix)
    expect(pathApi('linux')).toBe(posix)
  })
})

describe('execution folder names', () =>
{
  it('names each execution with its attempt and execution number', () =>
  {
    expect(workDirName('MM-0142', 1, 2)).toBe('.molex-MM-0142-a1-x2.partial')
    expect(workDirName('MM-0142', 3, 17)).toBe('.molex-MM-0142-a3-x17.partial')
    expect(workDirName('MM-0001', 1, 1).startsWith(WORK_DIR_PREFIX)).toBe(true)
    expect(workDirName('MM-0001', 1, 1).endsWith(WORK_DIR_SUFFIX)).toBe(true)
  })

  it('gives every execution of one attempt its own folder', () =>
  {
    const names = new Set([1, 2, 3].map((execution) => workDirName('MM-0142', 1, execution)))
    expect(names.size).toBe(3)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s as an attempt or execution', (value) =>
  {
    expect(() => workDirName('MM-0001', value, 1)).toThrow(RangeError)
    expect(() => workDirName('MM-0001', 1, value)).toThrow(RangeError)
  })

  it('parses a folder name back into its parts', () =>
  {
    expect(parseWorkDirName('.molex-MM-0142-a1-x2.partial')).toEqual({ catalog: 'MM-0142', attempt: 1, execution: 2 })
    expect(parseWorkDirName('.molex-MM-10000-a12-x340.partial')).toEqual({ catalog: 'MM-10000', attempt: 12, execution: 340 })
    expect(parseWorkDirName('.MOLEX-MM-0142-A1-X2.PARTIAL')).toEqual({ catalog: 'MM-0142', attempt: 1, execution: 2 })
  })

  it('round trips every name it builds', () =>
  {
    for (const [attempt, execution] of [[1, 1], [2, 9], [10, 100]])
    {
      expect(parseWorkDirName(workDirName('MM-0007', attempt, execution))).toEqual({ catalog: 'MM-0007', attempt, execution })
    }
  })

  it.each([
    'song.wav',
    '.molex-MM-0142-a1.partial',
    '.molex-MM-0142-a1-x2.part',
    'molex-MM-0142-a1-x2.partial',
    '.molex-MM-0142-a0-x1.partial',
    '.molex-MM-0142-a1-x0.partial',
    '.molex-MM-0142-a99999999999999999999-x1.partial',
    '.molex--a1-x1.partial'
  ])('parses %s as no folder of an execution', (name) =>
  {
    expect(parseWorkDirName(name)).toBeNull()
  })

  it('recognizes work folders for folder scans to skip', () =>
  {
    expect(isWorkDirName('.molex-MM-0142-a1-x2.partial')).toBe(true)
    expect(isWorkDirName('.Molex-anything.Partial')).toBe(true)
    expect(isWorkDirName('.molex-.partial')).toBe(false)
    expect(isWorkDirName('molex-MM-0142.partial')).toBe(false)
    expect(isWorkDirName('.molex-MM-0142-a1-x2.part')).toBe(false)
    expect(isWorkDirName('Season 1')).toBe(false)
  })

  it('places the work folder beside the final path', () =>
  {
    expect(workDirPath('C:\\Music\\out\\song.flac', 'MM-0001', 1, 2, 'win32')).toBe('C:\\Music\\out\\.molex-MM-0001-a1-x2.partial')
    expect(workDirPath('/home/u/out/song.flac', 'MM-0001', 2, 3, 'linux')).toBe('/home/u/out/.molex-MM-0001-a2-x3.partial')
    expect(workDirPath('/Users/u/out/clip.mp4', 'MM-0009', 1, 1, 'darwin')).toBe('/Users/u/out/.molex-MM-0009-a1-x1.partial')
  })

  it('tells whether a path is a work folder or lies inside one', () =>
  {
    expect(isInsideWorkDir('C:\\Music\\.molex-MM-1-a1-x1.partial\\out-e1.mkv.part', 'win32')).toBe(true)
    expect(isInsideWorkDir('C:/Music/.molex-MM-1-a1-x1.partial/frames.part/frame_0001.png', 'win32')).toBe(true)
    expect(isInsideWorkDir('C:\\Music\\.molex-MM-1-a1-x1.partial', 'win32')).toBe(true)
    expect(isInsideWorkDir('C:\\Music\\song.mkv', 'win32')).toBe(false)
    expect(isInsideWorkDir('/music/.molex-MM-1-a1-x1.partial/pass-0.log', 'linux')).toBe(true)
    expect(isInsideWorkDir('/music/.molex-notes/song.mkv', 'darwin')).toBe(false)
    expect(isInsideWorkDir('/music/song.mkv', 'linux')).toBe(false)
  })
})

describe('partial outputs', () =>
{
  it('gives every encode output a non-media suffix', () =>
  {
    expect(partOutputName(1, 'mkv')).toBe('out-e1.mkv.part')
    expect(partOutputName(2, '.mp4')).toBe('out-e2.mp4.part')
    expect(partOutputName(1, 'opus').endsWith(PART_SUFFIX)).toBe(true)
  })

  it('refuses an output without an extension or a pass number below 1', () =>
  {
    expect(() => partOutputName(1, '')).toThrow(RangeError)
    expect(() => partOutputName(1, '.')).toThrow(RangeError)
    expect(() => partOutputName(0, 'mkv')).toThrow(RangeError)
  })

  it('builds the paths inside a work folder per platform', () =>
  {
    const winWork = 'D:\\Out\\.molex-MM-0001-a1-x1.partial'
    const posixWork = '/out/.molex-MM-0001-a1-x1.partial'
    expect(partOutputPath(winWork, 1, 'mkv', 'win32')).toBe(`${winWork}\\out-e1.mkv.part`)
    expect(partOutputPath(posixWork, 3, 'flac', 'linux')).toBe(`${posixWork}/out-e3.flac.part`)
    expect(framesPartPath(winWork, 'win32')).toBe(`${winWork}\\${FRAMES_PART_DIR}`)
    expect(framesPartPath(posixWork, 'darwin')).toBe(`${posixWork}/frames.part`)
    expect(passLogPath(winWork, 'win32')).toBe(`${winWork}\\${PASS_LOG_NAME}`)
    expect(passLogPath(posixWork, 'linux')).toBe(`${posixWork}/pass`)
    expect(markerPath(winWork, 'win32')).toBe(`${winWork}\\${MARKER_FILE}`)
    expect(markerPath(posixWork, 'linux')).toBe(`${posixWork}/job.json`)
  })
})

describe('splitName', () =>
{
  it.each([
    ['song.wav', 'song', '.wav'],
    ['archive.tar.gz', 'archive.tar', '.gz'],
    ['README', 'README', ''],
    ['.hidden', '.hidden', ''],
    ['take 1.final.mkv', 'take 1.final', '.mkv']
  ])('splits %s into %s and %s', (name, stem, ext) =>
  {
    expect(splitName(name)).toEqual({ stem, ext })
  })
})

describe('displaced names', () =>
{
  it('names an overwritten output and a replaced original', () =>
  {
    expect(displacedName('song.wav', 'previous')).toBe('song (previous).wav')
    expect(displacedName('song.wav', 'previous', 2)).toBe('song (previous 2).wav')
    expect(displacedName('song.wav', 'original')).toBe('song (original).wav')
    expect(displacedName('song.wav', 'original', 12)).toBe('song (original 12).wav')
    expect(displacedName('README', 'previous')).toBe('README (previous)')
  })

  it('refuses a number below 1', () =>
  {
    expect(() => displacedName('song.wav', 'previous', 0)).toThrow(RangeError)
  })

  it('keeps a long name within the file name limit and keeps its extension', () =>
  {
    const name = `${'a'.repeat(300)}.flac`
    const displaced = displacedName(name, 'previous', 12)
    expect(bytes(displaced)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(displaced.endsWith(' (previous 12).flac')).toBe(true)
  })

  it('truncates a multi-byte name on a character boundary', () =>
  {
    const name = `${'\u00e9'.repeat(200)}.wav`
    const displaced = displacedName(name, 'original')
    expect(bytes(displaced)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(displaced).not.toContain('\ufffd')
    expect(new TextDecoder().decode(new TextEncoder().encode(displaced))).toBe(displaced)
    expect(displaced.endsWith(' (original).wav')).toBe(true)
  })

  it('builds the displaced path in the folder that holds the file', () =>
  {
    expect(displacedPath('C:\\Music\\song.wav', 'original', 1, 'win32')).toBe('C:\\Music\\song (original).wav')
    expect(displacedPath('/music/song.wav', 'previous', 3, 'linux')).toBe('/music/song (previous 3).wav')
  })

  it('takes the first displaced name nothing claims', () =>
  {
    const taken = new Set(['/m/song (previous).wav', '/m/song (previous 2).wav'])
    expect(nextFreeDisplacedPath('/m/song.wav', 'previous', (p) => taken.has(p), 'linux')).toEqual({ path: '/m/song (previous 3).wav', n: 3 })
    expect(nextFreeDisplacedPath('/m/song.wav', 'original', (p) => taken.has(p), 'linux')).toEqual({ path: '/m/song (original).wav', n: 1 })
  })

  it('gives up once every displaced number is taken', () =>
  {
    let calls = 0
    const result = nextFreeDisplacedPath('C:\\m\\song.wav', 'previous', () =>
    {
      calls++
      return true
    }, 'win32')
    expect(result).toBeNull()
    expect(calls).toBe(RENAME_LAST)
  })
})

describe('rename numbering', () =>
{
  it('numbers from 2 to 9999', () =>
  {
    expect(RENAME_FIRST).toBe(2)
    expect(RENAME_LAST).toBe(9999)
    expect(numberedName('song.wav', 2)).toBe('song (2).wav')
    expect(numberedName('song.wav', 9999)).toBe('song (9999).wav')
    expect(numberedName('notes', 3)).toBe('notes (3)')
  })

  it.each([1, 0, 10000, 2.5, Number.NaN])('refuses %s as a rename number', (n) =>
  {
    expect(() => numberedName('song.wav', n)).toThrow(RangeError)
  })

  it('keeps a long numbered name within the file name limit', () =>
  {
    const numbered = numberedName(`${'b'.repeat(260)}.mkv`, 9999)
    expect(bytes(numbered)).toBeLessThanOrEqual(MAX_NAME_BYTES)
    expect(numbered.endsWith(' (9999).mkv')).toBe(true)
  })

  it('fills the first gap in the numbering', () =>
  {
    const taken = new Set(['/out/song (2).wav', '/out/song (4).wav'])
    expect(nextRenamedPath('/out/song.wav', (p) => taken.has(p), 'linux')).toEqual({ path: '/out/song (3).wav', n: 3 })
    expect(nextRenamedPath('/out/song.wav', () => false, 'linux')).toEqual({ path: '/out/song (2).wav', n: 2 })
  })

  it('reaches the last number and stops after it', () =>
  {
    const last = 'D:\\out\\song (9999).wav'
    expect(nextRenamedPath('D:\\out\\song.wav', (p) => p !== last, 'win32')).toEqual({ path: last, n: RENAME_LAST })
    expect(nextRenamedPath('D:\\out\\song.wav', () => true, 'win32')).toBeNull()
  })
})

describe('path keys', () =>
{
  const composed = 'Caf\u00e9.wav'
  const decomposed = 'Cafe\u0301.wav'

  it('compares Windows paths resolved, lowercased, and composed', () =>
  {
    expect(pathKey('C:\\Music\\Song.WAV', 'win32')).toBe(pathKey('c:/music/song.wav', 'win32'))
    expect(pathKey('C:\\Music\\a\\..\\Song.wav', 'win32')).toBe(pathKey('C:\\Music\\song.wav', 'win32'))
    expect(pathKey(`C:\\Music\\${decomposed}`, 'win32')).toBe(pathKey(`C:\\music\\${composed}`, 'win32'))
    expect(pathKey('C:\\Music\\Song.wav', 'win32')).toBe('c:\\music\\song.wav')
  })

  it('compares macOS paths composed and lowercased', () =>
  {
    expect(pathKey('/Users/u/Song.wav', 'darwin')).toBe(pathKey('/users/u/song.wav', 'darwin'))
    expect(pathKey(`/Users/u/${decomposed}`, 'darwin')).toBe(pathKey(`/Users/u/${composed}`, 'darwin'))
    expect(pathKey('/Users/u/x/../Song.wav', 'darwin')).toBe('/users/u/song.wav')
  })

  it('compares Linux paths exactly after resolving', () =>
  {
    expect(pathKey('/home/u/Song.wav', 'linux')).not.toBe(pathKey('/home/u/song.wav', 'linux'))
    expect(pathKey(`/home/u/${decomposed}`, 'linux')).not.toBe(pathKey(`/home/u/${composed}`, 'linux'))
    expect(pathKey('/home/u/./x/../Song.wav', 'linux')).toBe('/home/u/Song.wav')
  })

  it.each<[Platform, string, string, boolean]>([
    ['win32', 'C:\\A\\b.mkv', 'c:\\a\\B.MKV', true],
    ['darwin', '/A/b.mkv', '/a/B.mkv', true],
    ['linux', '/A/b.mkv', '/a/B.mkv', false],
    ['linux', '/a/b.mkv', '/a/b.mkv', true]
  ])('on %s treats %s and %s as the same file: %s', (platform, a, b, same) =>
  {
    expect(samePath(a, b, platform)).toBe(same)
  })
})

describe('long paths', () =>
{
  it('warns about Windows paths over 259 characters only', () =>
  {
    const at = `C:\\${'a'.repeat(WINDOWS_PATH_LIMIT - 3)}`
    expect(at.length).toBe(WINDOWS_PATH_LIMIT)
    expect(exceedsPathLimit(at, 'win32')).toBe(false)
    expect(exceedsPathLimit(`${at}b`, 'win32')).toBe(true)
    expect(exceedsPathLimit(`/${'a'.repeat(400)}`, 'linux')).toBe(false)
    expect(exceedsPathLimit(`/${'a'.repeat(400)}`, 'darwin')).toBe(false)
  })
})
