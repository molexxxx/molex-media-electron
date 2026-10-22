/**
 * The player channels for live and HLS-only links, with yt-dlp and FFmpeg stubbed: `ytdlp:getStreamUrl` answers
 * that a link streams instead of downloading it, `player:linkStream` turns yt-dlp's reading into one FFmpeg
 * session with its sound and picture URLs, and `player:pictureUrl` draws a picture subtitle on the decode route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app') },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn) }
}))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn(), ffmpeg: vi.fn() } }))

const config = vi.hoisted(() => ({ ffmpeg: { ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe' } }))
vi.mock('../../src/main/config', () => ({ getConfig: vi.fn(async () => config), addUrlHistory: vi.fn(async () => undefined) }))

const runs = vi.hoisted(() => ({ result: { code: 0, stdout: '', stderr: '', killed: false } }))
vi.mock('../../src/main/ffmpeg/runner', () => ({ runCommand: vi.fn(() => ({ promise: Promise.resolve(runs.result), process: { kill: vi.fn() } })) }))
vi.mock('../../src/main/ffmpeg/gpu', async () =>
{
  const actual = await vi.importActual<typeof import('../../src/main/ffmpeg/gpu')>('../../src/main/ffmpeg/gpu')
  return { ...actual, detectGpuMode: vi.fn(async () => 'off') }
})

const ytdlp = vi.hoisted(() => ({ reading: null as unknown, calls: 0 }))
vi.mock('../../src/main/ytdlp/binary', () => ({
  getYtDl: vi.fn(async () => async () =>
  {
    ytdlp.calls += 1
    return ytdlp.reading
  }),
  baseFlags: vi.fn(() => ({}))
}))
vi.mock('../../src/main/ytdlp/cookies', () => ({
  withCookieRetry: vi.fn(async (fn: (flags: Record<string, unknown>) => Promise<unknown>) => fn({})),
  getInstalledBrowsers: vi.fn(() => []),
  setBrowserAndExport: vi.fn(async () => true),
  clearCookies: vi.fn(async () => undefined),
  getCookieInfo: vi.fn(() => ({ exists: false, age: null, browser: '' }))
}))

const server = vi.hoisted(() => ({
  sessions: [] as Array<{ command: string, args: string[], outputs: string[] }>,
  live: [] as Array<{ command: string, args: string[] }>
}))
vi.mock('../../src/main/preview-server', () => ({
  startPreviewServer: vi.fn(async () => 'http://127.0.0.1:9'),
  registerLiveSession: vi.fn((session: { command: string, args: string[], outputs: string[] }) =>
  {
    server.sessions.push(session)
    return session.outputs.map((_, i) => `m${server.sessions.length}${i}`)
  }),
  registerLiveStream: vi.fn((stream: { command: string, args: string[] }) =>
  {
    server.live.push(stream)
    return 'l1'
  }),
  registerPreviewPath: vi.fn(() => 'p1'),
  registerStreamProxy: vi.fn(() => 's1')
}))

const { registerPlayerIPC, pictureSubtitleOf } = await import('../../src/main/ipc/player')
const { registerMediaIPC } = await import('../../src/main/ipc/media')
registerPlayerIPC()
registerMediaIPC()

function handler(channel: string): (...args: unknown[]) => Promise<any>
{
  const fn = electron.handlers.get(channel)
  if (!fn)
  {
    throw new Error(`no handler for ${channel}`)
  }
  return (...args: unknown[]) => fn({ sender: { isDestroyed: () => false, send: vi.fn() } }, ...args) as Promise<any>
}

const headers = { 'User-Agent': 'UA' }
const live = {
  title: 'Live radio',
  is_live: true,
  live_status: 'is_live',
  formats: [
    { format_id: '234', url: 'https://m/a234.m3u8', protocol: 'm3u8_native', vcodec: 'none', resolution: 'audio only', http_headers: headers },
    { format_id: '232', url: 'https://m/v232.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.4D401F', acodec: 'none', height: 720, fps: 30, http_headers: headers },
    { format_id: '270', url: 'https://m/v270.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30, http_headers: headers }
  ]
}

const request = { at: null, sound: true, picture: true, soundQuality: 'best', maxHeight: 1080, codecs: ['avc1', 'bogus'], display: { width: 2560, height: 1440 } }

describe('player IPC: live and HLS-only links', () =>
{
  beforeEach(() =>
  {
    server.sessions.length = 0
    server.live.length = 0
    ytdlp.calls = 0
    ytdlp.reading = live
  })

  it('answers that a live link streams instead of giving a URL, and refuses to download it', async () =>
  {
    const result = await handler('ytdlp:getStreamUrl')('https://www.youtube.com/watch?v=L0', 'best')
    expect(result).toEqual({ success: true, streamed: true, live: true, title: 'Live radio', duration: null })
    const download = await handler('ytdlp:getStreamUrl')('https://www.youtube.com/watch?v=L0', 'best', { download: true })
    expect(download).toEqual({ success: false, error: 'A live stream cannot be downloaded' })
  })

  it('opens one FFmpeg session for a live link with its sound and picture URLs on the stream\'s clock', async () =>
  {
    const result = await handler('player:linkStream')('https://www.youtube.com/watch?v=L1', request)
    expect(result).toEqual({
      ok: true,
      stream: {
        live: true,
        sound: 'http://127.0.0.1:9/m10',
        picture: { url: 'http://127.0.0.1:9/m11', live: true, offset: 0, encoder: null, shared: true },
        hasPicture: true,
        duration: null
      }
    })
    const session = server.sessions[0]
    expect(session.command).toBe('/bin/ffmpeg')
    expect(session.outputs).toEqual(['audio/mp4', 'video/mp4'])
    expect(session.args).toEqual(expect.arrayContaining(['-copyts', 'https://m/v270.m3u8', 'https://m/a234.m3u8', 'pipe:1', 'pipe:3']))
    const again = await handler('player:linkStream')('https://www.youtube.com/watch?v=L1', { ...request, picture: false })
    expect(again.stream).toMatchObject({ sound: 'http://127.0.0.1:9/m20', picture: null, hasPicture: true })
    expect(ytdlp.calls).toBe(1)
    await handler('player:linkStream')('https://www.youtube.com/watch?v=L1', { ...request, fresh: true })
    expect(ytdlp.calls).toBe(2)
  })

  it('restarts the picture alone from a point on the clock, and fills in odd requests with defaults', async () =>
  {
    const result = await handler('player:linkStream')('https://www.youtube.com/watch?v=L2', { at: 7662.5, sound: false, picture: true })
    expect(result.stream).toMatchObject({ sound: null, picture: { url: 'http://127.0.0.1:9/m10' } })
    expect(server.sessions[0].outputs).toEqual(['video/mp4'])
    expect(server.sessions[0].args).toEqual(expect.arrayContaining(['-ss', '7662.500', '-output_ts_offset', '7662.500', 'https://m/v270.m3u8']))
  })

  it('reports a link without sound in words the renderer maps, and opens nothing', async () =>
  {
    ytdlp.reading = { is_live: true, formats: [{ url: 'https://m/v.m3u8', vcodec: 'avc1', acodec: 'none', height: 720 }] }
    const result = await handler('player:linkStream')('https://www.youtube.com/watch?v=L3', request)
    expect(result).toEqual({ ok: false, error: 'No sound format the player can stream' })
    ytdlp.reading = { formats: [] }
    const empty = await handler('player:linkStream')('https://www.youtube.com/watch?v=L4', { ...request, sound: false })
    expect(empty).toEqual({ ok: false, error: 'No picture format the player can stream' })
    expect(server.sessions).toHaveLength(0)
  })

  it('probes a format that may carry sound before FFmpeg runs: copies the sound it finds, and reports a silent one', async () =>
  {
    const saved = runs.result
    try
    {
      ytdlp.reading = { duration: 90, formats: [{ url: 'https://c/v.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.4d401f', height: 720 }] }
      runs.result = { ...saved, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }] }) }
      const heard = await handler('player:linkStream')('https://example.com/clip', { ...request, at: 30 })
      expect(heard).toMatchObject({ ok: true, stream: { live: false, duration: 90 } })
      expect(server.sessions[0].args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']))
      expect(server.sessions[0].args).not.toContain('0:a:0?')
      runs.result = { ...saved, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }] }) }
      const silent = await handler('player:linkStream')('https://example.com/clip', { ...request, fresh: true })
      expect(silent).toEqual({ ok: false, error: 'No sound format the player can stream' })
      expect(server.sessions).toHaveLength(1)
    }
    finally
    {
      runs.result = saved
    }
  })

  it('draws a picture subtitle on the decode route, keeping only well-formed subtitle requests', async () =>
  {
    const result = await handler('player:pictureUrl')('C:/m/a.mkv', 0, 'convert', 12, { width: 1920, height: 1080, subtitle: { streamIndex: 2, scaleTo: { width: 1920.4, height: 800 } } })
    expect(result).toMatchObject({ ok: true, picture: { url: 'http://127.0.0.1:9/l1', live: true, offset: 12 } })
    expect(server.live[0].args[server.live[0].args.indexOf('-filter_complex') + 1]).toContain('[0:2]scale=1920:800[sub]')
    expect(pictureSubtitleOf(null)).toBeNull()
    expect(pictureSubtitleOf({ streamIndex: -1 })).toBeNull()
    expect(pictureSubtitleOf({ streamIndex: 1.5 })).toBeNull()
    expect(pictureSubtitleOf({ streamIndex: 3 })).toEqual({ streamIndex: 3, scaleTo: null })
    expect(pictureSubtitleOf({ streamIndex: 3, scaleTo: { width: 0, height: 10 } })).toEqual({ streamIndex: 3, scaleTo: null })
  })
})
