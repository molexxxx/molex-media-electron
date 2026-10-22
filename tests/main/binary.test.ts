import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}))

const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: any[]) => mockGetConfig(...a),
  getUserDataPath: () => '/mock/userdata'
}))

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a)
}))

const updater = vi.hoisted(() => ({
  ensure: vi.fn(async () => '/mock/userdata/ytdlp-bin/yt-dlp'),
  track: vi.fn(<T,>(run: T) => run)
}))
vi.mock('../../src/main/ytdlp/updater', () => ({ ytDlpUpdater: () => updater }))

const inner = vi.hoisted(() =>
{
  const fn = vi.fn(async () => ({ id: 'x' })) as any
  fn.exec = vi.fn(() => Promise.resolve({ exitCode: 0 }))
  return fn
})
const mockCreateYtDl = vi.fn((_path: string) => inner)
vi.mock('youtube-dl-exec', () => ({
  create: (path: string) => mockCreateYtDl(path)
}))

import { baseFlags, getFFmpegDir, initFFmpegDir, ensureYtDlp, getYtDl, trackRuns } from '../../src/main/ytdlp/binary'

describe('ytdlp/binary', () =>
{
  beforeEach(() =>
  {
    mockGetConfig.mockResolvedValue({ ffmpegPath: '/usr/bin/ffmpeg' })
    mockExistsSync.mockReset()
    updater.track.mockClear()
  })

  describe('baseFlags', () =>
  {
    it('returns common yt-dlp flags', () =>
    {
      const flags = baseFlags()
      expect(flags.noWarnings).toBe(true)
      expect(flags.noCheckCertificates).toBe(true)
    })

    it('includes ffmpegLocation after initFFmpegDir', async () =>
    {
      mockExistsSync.mockReturnValue(true)
      await initFFmpegDir()
      expect(baseFlags().ffmpegLocation).toContain('bin')
    })
  })

  describe('getFFmpegDir', () =>
  {
    it('returns dirname when ffmpegPath exists', async () =>
    {
      mockExistsSync.mockReturnValue(true)
      expect(await getFFmpegDir()).toContain('bin')
    })

    it('returns undefined when ffmpegPath is empty', async () =>
    {
      mockGetConfig.mockResolvedValue({ ffmpegPath: '' })
      expect(await getFFmpegDir()).toBeUndefined()
    })

    it('returns undefined when ffmpeg binary does not exist', async () =>
    {
      mockGetConfig.mockResolvedValue({ ffmpegPath: '/nonexistent/ffmpeg' })
      mockExistsSync.mockReturnValue(false)
      expect(await getFFmpegDir()).toBeUndefined()
    })
  })

  describe('the yt-dlp binary', () =>
  {
    it('comes from the updater, which finds, downloads, and verifies it', async () =>
    {
      await expect(ensureYtDlp()).resolves.toBe('/mock/userdata/ytdlp-bin/yt-dlp')
      expect(updater.ensure).toHaveBeenCalled()
    })

    it('runs through one cached instance whose every run the updater counts', async () =>
    {
      const dl = await getYtDl()
      expect(await getYtDl()).toBe(dl)
      expect(mockCreateYtDl).toHaveBeenCalledTimes(1)
      expect(mockCreateYtDl).toHaveBeenCalledWith('/mock/userdata/ytdlp-bin/yt-dlp')
      await expect(dl('https://youtu.be/x', { dumpSingleJson: true })).resolves.toEqual({ id: 'x' })
      expect(inner).toHaveBeenCalledWith('https://youtu.be/x', { dumpSingleJson: true })
      await dl.exec('https://youtu.be/x', { getUrl: true })
      expect(inner.exec).toHaveBeenCalledWith('https://youtu.be/x', { getUrl: true })
      expect(updater.track).toHaveBeenCalledTimes(2)
    })

    it('makes a new instance when the binary in use changes path', async () =>
    {
      const before = await getYtDl()
      updater.ensure.mockResolvedValueOnce('/usr/local/bin/yt-dlp')
      const after = await getYtDl()
      expect(after).not.toBe(before)
      expect(mockCreateYtDl).toHaveBeenLastCalledWith('/usr/local/bin/yt-dlp')
      expect(await getYtDl()).not.toBe(after)
      expect(mockCreateYtDl).toHaveBeenLastCalledWith('/mock/userdata/ytdlp-bin/yt-dlp')
    })

    it('wraps any instance with the counter it is given', async () =>
    {
      const counted: unknown[] = []
      const wrapped = trackRuns(inner, (run) =>
      {
        counted.push(run)
        return run
      })
      const run = wrapped('u')
      const child = wrapped.exec('u')
      expect(counted).toEqual([run, child])
      await run
      await child
    })
  })
})
