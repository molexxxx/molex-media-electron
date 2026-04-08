import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn()
}))

import * as fs from 'fs'
import {
  cleanupTemp,
  findMediaFiles,
  safeRename,
  ensureDir,
  validateOutput
} from '../../src/main/ffmpeg/processor'

describe('cleanupTemp', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('deletes the file when it exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    cleanupTemp('/tmp/song_temp.mp3')
    expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/song_temp.mp3')
  })

  it('does nothing when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    cleanupTemp('/tmp/missing.mp3')
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('swallows errors silently', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => cleanupTemp('/tmp/locked.mp3')).not.toThrow()
  })
})

describe('findMediaFiles', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns matching files in a flat directory', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'song.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'video.mp4', isFile: () => true, isDirectory: () => false },
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false }
    ] as unknown as fs.Dirent[])

    const results = findMediaFiles('/music', ['.mp3', '.mp4'])
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('song.mp3')
    expect(results[1]).toContain('video.mp4')
  })

  it('traverses subdirectories recursively', () => {
    vi.mocked(fs.readdirSync).mockImplementation((dir) => {
      if (String(dir).endsWith('music')) {
        return [
          { name: 'sub', isFile: () => false, isDirectory: () => true },
          { name: 'root.mp3', isFile: () => true, isDirectory: () => false }
        ] as unknown as fs.Dirent[]
      }
      return [
        { name: 'nested.mp3', isFile: () => true, isDirectory: () => false }
      ] as unknown as fs.Dirent[]
    })

    const results = findMediaFiles('/music', ['.mp3'])
    expect(results).toHaveLength(2)
  })

  it('returns empty array when no files match', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false }
    ] as unknown as fs.Dirent[])

    expect(findMediaFiles('/empty', ['.mp3'])).toHaveLength(0)
  })

  it('handles readdir errors gracefully', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES') })
    expect(findMediaFiles('/locked', ['.mp3'])).toEqual([])
  })

  it('is case-insensitive on extensions', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'song.MP3', isFile: () => true, isDirectory: () => false },
      { name: 'track.Flac', isFile: () => true, isDirectory: () => false }
    ] as unknown as fs.Dirent[])

    const results = findMediaFiles('/music', ['.mp3', '.flac'])
    expect(results).toHaveLength(2)
  })

  it('returns sorted results', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      { name: 'c.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'a.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'b.mp3', isFile: () => true, isDirectory: () => false }
    ] as unknown as fs.Dirent[])

    const results = findMediaFiles('/music', ['.mp3'])
    const names = results.map((r) => r.split(/[\\/]/).pop())
    expect(names).toEqual(['a.mp3', 'b.mp3', 'c.mp3'])
  })
})

describe('safeRename', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('uses renameSync when same filesystem', () => {
    safeRename('/tmp/src.mp3', '/tmp/dest.mp3')
    expect(fs.renameSync).toHaveBeenCalledWith('/tmp/src.mp3', '/tmp/dest.mp3')
    expect(fs.copyFileSync).not.toHaveBeenCalled()
  })

  it('falls back to copy+delete on EXDEV error', () => {
    const err = new Error('EXDEV') as any
    err.code = 'EXDEV'
    vi.mocked(fs.renameSync).mockImplementation(() => { throw err })
    safeRename('/mnt/a/src.mp3', '/mnt/b/dest.mp3')
    expect(fs.copyFileSync).toHaveBeenCalledWith('/mnt/a/src.mp3', '/mnt/b/dest.mp3')
    expect(fs.unlinkSync).toHaveBeenCalledWith('/mnt/a/src.mp3')
  })

  it('rethrows non-EXDEV errors', () => {
    const err = new Error('EACCES') as any
    err.code = 'EACCES'
    vi.mocked(fs.renameSync).mockImplementation(() => { throw err })
    expect(() => safeRename('/tmp/src.mp3', '/tmp/dest.mp3')).toThrow('EACCES')
  })
})

describe('ensureDir', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creates directory when it does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    ensureDir('/output/new')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/output/new', { recursive: true })
  })

  it('does nothing when directory already exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    ensureDir('/output/existing')
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
})

describe('validateOutput', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('passes when file has non-zero size', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 5000000 } as any)
    expect(() => validateOutput('/tmp/out.mp3', 'Test')).not.toThrow()
  })

  it('throws when file is zero bytes', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any)
    expect(() => validateOutput('/tmp/out.mp3', 'Boost')).toThrow('Boost produced an empty file')
  })

  it('cleans up zero-byte file', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any)
    vi.mocked(fs.existsSync).mockReturnValue(true)
    try { validateOutput('/tmp/out.mp3', 'Test') } catch { /* expected */ }
    expect(fs.unlinkSync).toHaveBeenCalledWith('/tmp/out.mp3')
  })
})
