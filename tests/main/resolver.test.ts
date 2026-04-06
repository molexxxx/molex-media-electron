import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}))

const mockExistsSync = vi.fn()
const mockReaddirSync = vi.fn()
const mockStatSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockMkdirSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a),
  readdirSync: (...a: any[]) => mockReaddirSync(...a),
  statSync: (...a: any[]) => mockStatSync(...a),
  unlinkSync: (...a: any[]) => mockUnlinkSync(...a),
  mkdirSync: (...a: any[]) => mockMkdirSync(...a)
}))

const mockGetYtDl = vi.fn()
const mockBaseFlags = vi.fn(() => ({ noWarnings: true }))
vi.mock('../../src/main/ytdlp/binary', () => ({
  getYtDl: (...a: any[]) => mockGetYtDl(...a),
  baseFlags: (...a: any[]) => mockBaseFlags(...a)
}))

const mockWithCookieRetry = vi.fn(async (fn: Function) => fn({}))
vi.mock('../../src/main/ytdlp/cookies', () => ({
  withCookieRetry: (...a: any[]) => mockWithCookieRetry(...a)
}))

import { cleanupAudioCache, resolvePlaylist, getAudioStreamUrl } from '../../src/main/ytdlp/resolver'

describe('ytdlp/resolver', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('cleanupAudioCache', () => {
    it('does nothing when cache dir does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      cleanupAudioCache()
      expect(mockReaddirSync).not.toHaveBeenCalled()
    })

    it('removes files older than max age', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['old-file.opus', 'new-file.opus'])
      mockStatSync
        .mockReturnValueOnce({ mtimeMs: Date.now() - 48 * 60 * 60 * 1000 }) // old
        .mockReturnValueOnce({ mtimeMs: Date.now() - 1000 }) // new

      cleanupAudioCache()

      expect(mockUnlinkSync).toHaveBeenCalledTimes(1)
    })

    it('keeps files within max age', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['recent.opus'])
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 1000 })

      cleanupAudioCache()

      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })

    it('uses custom max age', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['file.opus'])
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 5000 })

      cleanupAudioCache(3000) // 3 second max age

      expect(mockUnlinkSync).toHaveBeenCalledTimes(1)
    })

    it('handles stat errors gracefully', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['bad-file.opus'])
      mockStatSync.mockImplementation(() => { throw new Error('permission denied') })

      // Should not throw
      expect(() => cleanupAudioCache()).not.toThrow()
    })

    it('handles readdir errors gracefully', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockImplementation(() => { throw new Error('readdir error') })

      expect(() => cleanupAudioCache()).not.toThrow()
    })

    it('removes multiple old files', () => {
      mockExistsSync.mockReturnValue(true)
      mockReaddirSync.mockReturnValue(['a.opus', 'b.opus', 'c.opus'])
      const oldTime = Date.now() - 48 * 60 * 60 * 1000
      mockStatSync.mockReturnValue({ mtimeMs: oldTime })

      cleanupAudioCache()

      expect(mockUnlinkSync).toHaveBeenCalledTimes(3)
    })
  })

  describe('resolvePlaylist', () => {
    it('resolves single video URL', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'abc123',
        title: 'Test Video',
        webpage_url: 'https://www.youtube.com/watch?v=abc123',
        duration: 300
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/watch?v=abc123')
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('abc123')
      expect(entries[0].title).toBe('Test Video')
      expect(entries[0].duration).toBe(300)
    })

    it('resolves youtu.be short URL as single video', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'short1',
        title: 'Short URL Video',
        webpage_url: 'https://youtu.be/short1',
        duration: 120
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://youtu.be/short1')
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('short1')
    })

    it('resolves playlist URL with multiple entries', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        entries: [
          { id: 'v1', title: 'Video 1', url: 'https://youtube.com/watch?v=v1', duration: 100 },
          { id: 'v2', title: 'Video 2', url: 'https://youtube.com/watch?v=v2', duration: 200 }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/playlist?list=PLxyz')
      expect(entries).toHaveLength(2)
      expect(entries[0].title).toBe('Video 1')
      expect(entries[1].title).toBe('Video 2')
    })

    it('handles single video response without entries', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'solo',
        title: 'Solo',
        duration: 60
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/watch?v=solo')
      expect(entries).toHaveLength(1)
      expect(entries[0].title).toBe('Solo')
    })

    it('filters null/empty entries from playlist', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        entries: [
          { id: 'v1', title: 'Video 1' },
          null,
          { id: '', url: '' },
          { id: 'v3', title: 'Video 3' }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/playlist?list=PLxyz')
      expect(entries).toHaveLength(2)
    })

    it('resolves shorts URL as single video', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'short1',
        title: 'A Short',
        duration: 30
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/shorts/short1')
      expect(entries).toHaveLength(1)
    })

    it('treats non-YouTube URL as single video', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'ext1',
        title: 'External',
        url: 'https://example.com/video',
        duration: 500
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://example.com/video')
      expect(entries).toHaveLength(1)
    })
  })

  describe('getAudioStreamUrl', () => {
    it('returns direct audio URL when available', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Test Song',
        duration: 180,
        url: 'https://cdn.example.com/audio.m4a',
        protocol: 'https',
        ext: 'm4a'
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toBe('https://cdn.example.com/audio.m4a')
      expect(track.title).toBe('Test Song')
      expect(track.duration).toBe(180)
    })

    it('picks audio from requested_formats when top-level is HLS', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Test',
        duration: 120,
        url: 'https://cdn.example.com/manifest.m3u8',
        protocol: 'm3u8',
        requested_formats: [
          { acodec: 'opus', url: 'https://cdn.example.com/audio.webm', protocol: 'https', ext: 'webm' },
          { acodec: 'none', vcodec: 'vp9', url: 'https://cdn.example.com/video.webm', protocol: 'https' }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toBe('https://cdn.example.com/audio.webm')
    })

    it('picks best audio from formats list when requested_formats is HLS', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Test',
        duration: 120,
        url: 'https://cdn.example.com/manifest.m3u8',
        protocol: 'm3u8',
        requested_formats: [
          { acodec: 'opus', url: 'https://cdn.example.com/hls-audio.m3u8', protocol: 'm3u8' }
        ],
        formats: [
          { acodec: 'opus', vcodec: 'none', url: 'https://cdn.example.com/audio-128.webm', protocol: 'https', abr: 128 },
          { acodec: 'opus', vcodec: 'none', url: 'https://cdn.example.com/audio-64.webm', protocol: 'https', abr: 64 }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toBe('https://cdn.example.com/audio-128.webm')
    })

    it('uses a/v format when no audio-only direct URL', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Test',
        duration: 120,
        url: 'https://cdn.example.com/manifest.m3u8',
        protocol: 'm3u8',
        formats: [
          { acodec: 'aac', vcodec: 'h264', url: 'https://cdn.example.com/av.mp4', protocol: 'https', abr: 128 }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toBe('https://cdn.example.com/av.mp4')
    })

    it('retries without format filter when first attempt fails', async () => {
      const mockDl = vi.fn()
        .mockRejectedValueOnce(new Error('format not available'))
        .mockResolvedValueOnce({
          title: 'Fallback',
          duration: 90,
          url: 'https://cdn.example.com/audio.m4a',
          protocol: 'https'
        })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toBe('https://cdn.example.com/audio.m4a')
      expect(mockDl).toHaveBeenCalledTimes(2)
    })

    it('downloads to temp file when all formats are HLS', async () => {
      // Control the id generation
      const mockNow = vi.spyOn(Date, 'now').mockReturnValue(99999)
      const mockRandom = vi.spyOn(Math, 'random').mockReturnValue(0.5)

      const mockDl = vi.fn()
        .mockResolvedValueOnce({
          title: 'HLS Only',
          duration: 120,
          url: 'https://cdn.example.com/manifest.m3u8',
          protocol: 'm3u8_native',
          formats: [
            { acodec: 'aac', vcodec: 'none', url: 'https://cdn.example.com/hls.m3u8', protocol: 'm3u8' }
          ]
        })
        // downloadAudioToFile calls dl again
        .mockResolvedValueOnce(undefined)

      mockGetYtDl.mockResolvedValue(mockDl)
      mockMkdirSync.mockReturnValue(undefined)
      // The id will be molex-99999-i (0.5.toString(36) = "0.i" -> slice(2,6) = "i")
      mockReaddirSync.mockReturnValue(['molex-99999-i.opus'])

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      expect(track.audioUrl).toContain('file:///')
      expect(track.title).toBe('HLS Only')

      mockNow.mockRestore()
      mockRandom.mockRestore()
    })

    it('uses "good" quality format string', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Good Quality',
        duration: 120,
        url: 'https://cdn.example.com/audio.m4a',
        protocol: 'https'
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc', 'good')
      expect(track.title).toBe('Good Quality')
      // Verify format string was passed
      const callArgs = mockDl.mock.calls[0][1]
      expect(callArgs.format).toContain('abr<=160')
    })

    it('uses "low" quality format string', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'Low Quality',
        duration: 120,
        url: 'https://cdn.example.com/audio.m4a',
        protocol: 'https'
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=abc', 'low')
      expect(track.title).toBe('Low Quality')
      const callArgs = mockDl.mock.calls[0][1]
      expect(callArgs.format).toContain('worstaudio')
    })

    it('passes ffmpegLocation when baseFlags includes it', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        title: 'FF',
        duration: 60,
        url: 'https://cdn.example.com/audio.m4a',
        protocol: 'https'
      })
      mockGetYtDl.mockResolvedValue(mockDl)
      mockBaseFlags.mockReturnValue({ noWarnings: true, ffmpegLocation: '/app/bin' })

      await getAudioStreamUrl('https://www.youtube.com/watch?v=abc')
      const callArgs = mockDl.mock.calls[0][1]
      expect(callArgs.ffmpegLocation).toBe('/app/bin')
    })

    it('handles video data with missing title and duration', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        id: 'notitle',
        url: 'https://cdn.example.com/audio.m4a',
        protocol: 'https'
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=notitle')
      expect(track.title).toBe('notitle')
      expect(track.duration).toBeNull()
    })
  })

  describe('parsePlaylistData edge cases', () => {
    it('handles playlist entries with minimal data', async () => {
      const mockDl = vi.fn().mockResolvedValue({
        entries: [
          { id: 'v1' },
          { url: 'https://example.com/v2' }
        ]
      })
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/playlist?list=PLxyz')
      expect(entries).toHaveLength(2)
      expect(entries[0].title).toBe('v1')
      expect(entries[0].url).toContain('youtube.com/watch?v=v1')
      expect(entries[0].duration).toBeNull()
      expect(entries[1].url).toBe('https://example.com/v2')
    })

    it('handles single video response with missing fields', async () => {
      const mockDl = vi.fn().mockResolvedValue({})
      mockGetYtDl.mockResolvedValue(mockDl)

      const entries = await resolvePlaylist('https://www.youtube.com/watch?v=x')
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('unknown')
      expect(entries[0].title).toBe('Unknown')
    })
  })
})
