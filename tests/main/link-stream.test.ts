/**
 * Live and HLS-only links streamed through FFmpeg, with yt-dlp and FFmpeg stubbed: yt-dlp's reading becomes a
 * plan of inputs and parts, the plan becomes one FFmpeg command whose sound and picture share the stream's clock,
 * and nothing tries to download a live link. Picture subtitles are drawn by the decode route's overlay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn(), ffmpeg: vi.fn() } }))

const config = vi.hoisted(() => ({ ffmpeg: { source: 'path', buildId: null, ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe', selfTest: null } as Record<string, unknown> }))
vi.mock('../../src/main/config', () => ({ getConfig: vi.fn(async () => config) }))

const runs = vi.hoisted(() => ({ calls: [] as Array<[string, string[]]>, result: { code: 0, stdout: '', stderr: '', killed: false } }))
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: vi.fn((command: string, args: string[]) =>
  {
    runs.calls.push([command, args])
    return { promise: Promise.resolve(runs.result), process: { kill: vi.fn() } }
  })
}))

const gpu = vi.hoisted(() => ({ mode: 'off' as string }))
vi.mock('../../src/main/ffmpeg/gpu', async () =>
{
  const actual = await vi.importActual<typeof import('../../src/main/ffmpeg/gpu')>('../../src/main/ffmpeg/gpu')
  return {
    ...actual,
    detectGpuMode: vi.fn(async () => gpu.mode),
    resolveGpuCodec: vi.fn(async (_: string, soft: string, mode: string) => mode === 'nvenc' ? { codec: 'h264_nvenc', activeMode: 'nvenc', isGpu: true } : { codec: soft, activeMode: 'off', isGpu: false })
  }
})

const ytdlp = vi.hoisted(() => ({ dl: null as null | ((url: string, flags: Record<string, unknown>) => Promise<unknown>) }))
vi.mock('../../src/main/ytdlp/binary', () => ({ getYtDl: vi.fn(async () => ytdlp.dl), baseFlags: vi.fn(() => ({})) }))
vi.mock('../../src/main/ytdlp/cookies', () => ({ withCookieRetry: vi.fn(async (fn: (flags: Record<string, unknown>) => Promise<unknown>) => fn({})) }))

import {
  audioCodecName,
  audioPresence,
  codecFamily,
  downloadLinkVideo,
  getAudioFile,
  getAudioStreamUrl,
  getLinkData,
  isLiveData,
  knownLive,
  LINK_DATA_TTL_MS,
  LIVE_DOWNLOAD_ERROR,
  pickPictureFormat,
  pickSoundFormat,
  planLinkStream,
  rememberLinkData,
  streamFormats,
  videoPresence,
  withProbedFormats,
  withProbedSound,
  type LinkStreamWant
} from '../../src/main/ytdlp/resolver'
import {
  copiesPicture,
  linkStreamArgs,
  linkStreamCommand,
  opusPlaybackArgs,
  parseStreamProbe,
  pictureDecodeArgs,
  pictureDecodeCommand,
  probeStreamInput,
  SOFTWARE_DISPLAY_ENCODER,
  streamHeaderArgs,
  streamProbeArgs,
  subtitleOverlayGraph,
  SUBTITLE_PREROLL
} from '../../src/main/ffmpeg/playback'
import {
  imageSubtitles,
  isImageSubtitle,
  mediaWithSubtitles,
  pictureWithSubtitles,
  shownSubtitles,
  toPlayerStream,
  type PlayerMedia
} from '../../src/shared/player/media'

const headers = { 'User-Agent': 'UA', Accept: '*/*', Host: 'manifest.googlevideo.com' }

/** yt-dlp's reading of a YouTube live stream: audio-only and video-only HLS renditions, and storyboards. */
function liveReading(): Record<string, unknown>
{
  return {
    id: 'L1',
    title: 'Live radio',
    is_live: true,
    live_status: 'is_live',
    duration: null,
    formats: [
      { format_id: 'sb0', url: 'https://i.ytimg.com/sb', protocol: 'mhtml', vcodec: 'none', acodec: 'none' },
      { format_id: '233', url: 'https://m/a233.m3u8', protocol: 'm3u8_native', vcodec: 'none', resolution: 'audio only', http_headers: headers },
      { format_id: '234', url: 'https://m/a234.m3u8', protocol: 'm3u8_native', vcodec: 'none', resolution: 'audio only', http_headers: headers },
      { format_id: '269', url: 'https://m/v269.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.42C00B', acodec: 'none', height: 144, fps: 15, tbr: 269, http_headers: headers },
      { format_id: '232', url: 'https://m/v232.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.4D401F', acodec: 'none', height: 720, fps: 30, tbr: 2447, http_headers: headers },
      { format_id: '270', url: 'https://m/v270.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30, tbr: 4561, http_headers: headers }
    ]
  }
}

const want = (over: Partial<LinkStreamWant> = {}): LinkStreamWant => ({ sound: true, picture: true, soundQuality: 'best', maxHeight: 1080, codecs: ['avc1'], ...over })

describe('link streams: reading yt-dlp', () =>
{
  it('knows a live link from is_live or live_status, and a finished broadcast as a recording', () =>
  {
    expect(isLiveData({ is_live: true })).toBe(true)
    expect(isLiveData({ live_status: 'is_live' })).toBe(true)
    expect(isLiveData({ live_status: 'post_live', is_live: false })).toBe(false)
    expect(isLiveData({ live_status: 'was_live' })).toBe(false)
    expect(isLiveData(null)).toBe(false)
  })

  it('reads which formats carry a picture and sound, and names their codecs as FFmpeg does', () =>
  {
    const reading = liveReading()
    expect(streamFormats(reading).map((f) => f.format_id)).toEqual(['233', '234', '269', '232', '270'])
    expect(streamFormats({ url: 'https://x/live.m3u8', protocol: 'm3u8_native' })).toHaveLength(1)
    expect(streamFormats({ formats: [{ url: 'https://x/seg', protocol: 'http_dash_segments' }, { protocol: 'https' }] })).toHaveLength(0)
    const [a233, , v269] = streamFormats(reading)
    expect([videoPresence(a233), audioPresence(a233)]).toEqual(['no', 'yes'])
    expect([videoPresence(v269), audioPresence(v269)]).toEqual(['yes', 'no'])
    expect([videoPresence({ url: 'u' }), audioPresence({ url: 'u' })]).toEqual(['maybe', 'maybe'])
    expect(videoPresence({ height: 480 })).toBe('yes')
    expect(videoPresence({ video_ext: 'none' })).toBe('no')
    expect(audioPresence({ acodec: 'mp4a.40.2', vcodec: 'avc1' })).toBe('yes')
    expect(audioPresence({ acodec: 'mp4a.40.2', vcodec: 'avc1.64001f', audio_ext: 'none', video_ext: 'mp4' })).toBe('yes')
    expect(['mp4a.40.2', 'mp4a.40.5', 'aac', 'mp4a.40.34', 'mp3', 'opus', 'flac', 'vorbis', 'ac-3', 'ec-3', 'eac3', 'alac'].map(audioCodecName))
      .toEqual(['aac', 'aac', 'aac', 'mp3', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'eac3', 'alac'])
    expect([audioCodecName(undefined), audioCodecName('none'), audioCodecName('')]).toEqual([null, null, null])
    expect([codecFamily('h264'), codecFamily('avc3.640028'), codecFamily('vp9'), codecFamily('av1'), codecFamily('hevc')]).toEqual(['avc1', 'avc1', 'vp9', 'av01', null])
  })

  it('chooses the sound by quality: audio-only renditions first in yt-dlp order, then the lightest format with sound', () =>
  {
    const formats = streamFormats(liveReading())
    expect(pickSoundFormat(formats, 'best')?.format_id).toBe('234')
    expect(pickSoundFormat(formats, 'good')?.format_id).toBe('234')
    expect(pickSoundFormat(formats, 'low')?.format_id).toBe('233')
    const muxed = [
      { format_id: 'm1080', url: 'a', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 1080, abr: 256 },
      { format_id: 'm720', url: 'b', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 720, abr: 256 },
      { format_id: 'm360', url: 'c', vcodec: 'avc1', acodec: 'mp4a.40.2', height: 360, abr: 128 },
      { format_id: 'm144', url: 'd', vcodec: 'avc1', acodec: 'mp4a.40.5', height: 144, abr: 48 }
    ]
    expect(pickSoundFormat(muxed, 'best')?.format_id).toBe('m720')
    expect(pickSoundFormat(muxed, 'good')?.format_id).toBe('m360')
    expect(pickSoundFormat(muxed, 'low')?.format_id).toBe('m144')
    expect(pickSoundFormat([{ url: 'x' }], 'best')?.url).toBe('x')
    expect(pickSoundFormat([{ url: 'v', vcodec: 'avc1', acodec: 'none' }], 'best')).toBeNull()
  })

  it('chooses the tallest picture under the cap, preferring one Chromium decodes as it is', () =>
  {
    const pictures = streamFormats(liveReading()).filter((f) => videoPresence(f) === 'yes')
    expect(pickPictureFormat(pictures, 1080, ['avc1'])?.format_id).toBe('270')
    expect(pickPictureFormat(pictures, 720, ['avc1'])?.format_id).toBe('232')
    expect(pickPictureFormat(pictures, 100, ['avc1'])?.format_id).toBe('269')
    const mixed = [
      { format_id: 'hevc', url: 'h', vcodec: 'hvc1.1.6.L120', height: 1080 },
      { format_id: 'h264', url: 'a', vcodec: 'avc1.4d401f', height: 720 },
      { format_id: 'vp9', url: 'v', vcodec: 'vp09.00.40.08', height: 1080 }
    ]
    expect(pickPictureFormat(mixed, 1080, ['avc1'])?.format_id).toBe('h264')
    expect(pickPictureFormat(mixed, 1080, ['avc1', 'vp9'])?.format_id).toBe('vp9')
    expect(pickPictureFormat([mixed[0]], 1080, ['avc1'])?.format_id).toBe('hevc')
    expect(pickPictureFormat([], 1080, ['avc1'])).toBeNull()
  })

  it('plans a live stream with separate renditions as two inputs, and the sound alone for the visualization', () =>
  {
    const plan = planLinkStream(liveReading(), want())
    expect(plan).toEqual({
      live: true,
      duration: null,
      inputs: [{ url: 'https://m/v270.m3u8', headers: { 'User-Agent': 'UA', Accept: '*/*' } }, { url: 'https://m/a234.m3u8', headers: { 'User-Agent': 'UA', Accept: '*/*' } }],
      sound: { input: 1, codec: null, channels: null, sampleRate: null, optional: false },
      picture: { input: 0, codec: 'avc1.640028', family: 'avc1', fps: 30 },
      hasPicture: true
    })
    const soundOnly = planLinkStream(liveReading(), want({ picture: false, soundQuality: 'low' }))
    expect(soundOnly.inputs.map((input) => input.url)).toEqual(['https://m/a233.m3u8'])
    expect(soundOnly).toMatchObject({ picture: null, hasPicture: true, sound: { input: 0 } })
    const pictureOnly = planLinkStream(liveReading(), want({ sound: false, maxHeight: 720 }))
    expect(pictureOnly).toMatchObject({ sound: null, inputs: [{ url: 'https://m/v232.m3u8' }] })
  })

  it('plans a recording whose formats carry both from one input, and a bare playlist with maybe sound', () =>
  {
    const recording = { duration: 300.5, formats: [{ url: 'https://c/av.m3u8', protocol: 'm3u8', vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2', height: 720, audio_channels: 2, asr: 44100 }] }
    expect(planLinkStream(recording, want())).toMatchObject({ live: false, duration: 300.5, inputs: [{ url: 'https://c/av.m3u8' }], sound: { input: 0, codec: 'aac', channels: 2, sampleRate: 44100 }, picture: { input: 0 } })
    const variants = {
      duration: 634,
      formats: [
        { format_id: '240', url: 'https://mux/240.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.42000d', acodec: 'mp4a.40.5', height: 184, tbr: 246, audio_ext: 'none', video_ext: 'mp4' },
        { format_id: '720', url: 'https://mux/720.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.64001f', acodec: 'mp4a.40.2', height: 720, tbr: 2149, audio_ext: 'none', video_ext: 'mp4' },
        { format_id: '1080', url: 'https://mux/1080.m3u8', protocol: 'm3u8_native', vcodec: 'avc1.640028', acodec: 'mp4a.40.2', height: 1080, tbr: 6221, audio_ext: 'none', video_ext: 'mp4' }
      ]
    }
    expect(planLinkStream(variants, want({ maxHeight: 720 }))).toMatchObject({ inputs: [{ url: 'https://mux/720.m3u8' }], sound: { input: 0, codec: 'aac' }, picture: { input: 0 } })
    expect(planLinkStream(variants, want({ picture: false, soundQuality: 'low' })).inputs).toEqual([{ url: 'https://mux/240.m3u8', headers: {} }])
    expect(planLinkStream(variants, want({ picture: false })).inputs).toEqual([{ url: 'https://mux/720.m3u8', headers: {} }])
    expect(planLinkStream(variants, want({ picture: false, soundQuality: 'good' })).inputs).toEqual([{ url: 'https://mux/720.m3u8', headers: {} }])
    const bare = planLinkStream({ url: 'https://c/index.m3u8', protocol: 'm3u8_native', duration: 0 }, want())
    expect(bare).toMatchObject({ duration: null, picture: null, hasPicture: false, sound: { input: 0, optional: true } })
  })

  it('fills in what yt-dlp could not say from a probe, and leaves a format as it was when the probe fails', async () =>
  {
    const bare = { url: 'https://tv/index.m3u8', protocol: 'm3u8_native' }
    const probe = vi.fn(async () => ({ video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac', channels: 2, sampleRate: 48000 } }))
    const filled = await withProbedFormats(bare, probe)
    expect(probe).toHaveBeenCalledWith({ url: 'https://tv/index.m3u8', headers: {} })
    expect(planLinkStream(filled, want())).toMatchObject({ picture: { family: 'avc1' }, sound: { codec: 'aac', optional: false } })
    const listed = { formats: [bare, { url: 'https://tv/a.m3u8', vcodec: 'none', acodec: 'mp4a.40.2' }] }
    const radio = await withProbedFormats(listed, async () => ({ video: null, audio: { codec: 'mp3', channels: null, sampleRate: null } }))
    expect(radio.formats[0]).toMatchObject({ vcodec: 'none', acodec: 'mp3' })
    expect(radio.formats[1]).toBe(listed.formats[1])
    expect(await withProbedFormats(bare, async () => null)).toBe(bare)
    expect(await withProbedFormats(bare, async () => { throw new Error('timeout') })).toBe(bare)
    const known = liveReading()
    const unused = vi.fn()
    expect(await withProbedFormats(known, unused)).toBe(known)
    expect(unused).not.toHaveBeenCalled()
  })

  it('settles a sound that may be missing by probing its format, so FFmpeg never gets an empty optional map', async () =>
  {
    const plan = planLinkStream({ formats: [{ url: 'https://c/v.m3u8', vcodec: 'avc1.4d401f', height: 720 }] }, want())
    expect(plan).toMatchObject({ sound: { input: 0, codec: null, optional: true }, picture: { input: 0 } })
    const probe = vi.fn(async () => ({ video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac', channels: 2, sampleRate: 48000 } }))
    const heard = await withProbedSound(plan, probe)
    expect(probe).toHaveBeenCalledWith({ url: 'https://c/v.m3u8', headers: {} })
    expect(heard.sound).toEqual({ input: 0, codec: 'aac', channels: 2, sampleRate: 48000, optional: false })
    expect(linkStreamArgs(heard, { at: null, copyFamilies: [], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1280, height: 720 }).args).toEqual(expect.arrayContaining(['0:a:0', '-c:a', 'copy']))
    const partial = await withProbedSound(plan, async () => ({ video: null, audio: { codec: 'mp3', channels: null, sampleRate: null } }))
    expect(partial.sound).toMatchObject({ codec: 'mp3', channels: null, sampleRate: null, optional: false })
    const silent = await withProbedSound(plan, async () => ({ video: { codec: 'h264', width: 1280, height: 720 }, audio: null }))
    expect(silent).toMatchObject({ sound: null, picture: { input: 0 } })
    expect(await withProbedSound(plan, async () => null)).toBe(plan)
    expect(await withProbedSound(plan, async () => { throw new Error('timeout') })).toBe(plan)
    const known = planLinkStream(liveReading(), want())
    const unused = vi.fn()
    expect(await withProbedSound(known, unused)).toBe(known)
    const pictureOnly = planLinkStream(liveReading(), want({ sound: false }))
    expect(await withProbedSound(pictureOnly, unused)).toBe(pictureOnly)
    expect(unused).not.toHaveBeenCalled()
  })
})

describe('link streams: yt-dlp runs and downloads', () =>
{
  beforeEach(() =>
  {
    ytdlp.dl = null
  })

  afterEach(() =>
  {
    vi.restoreAllMocks()
  })

  it('reads a live link once, answers stream instead of a URL, and refuses to download it', async () =>
  {
    const calls: Array<Record<string, unknown>> = []
    ytdlp.dl = vi.fn(async (_url: string, flags: Record<string, unknown>) =>
    {
      calls.push(flags)
      return { ...liveReading(), url: 'https://direct/a.m4a', protocol: 'https' }
    })
    const track = await getAudioStreamUrl('https://www.youtube.com/watch?v=L1')
    expect(track).toEqual({ audioUrl: '', title: 'Live radio', duration: null, httpHeaders: {}, stream: { live: true } })
    expect(calls).toHaveLength(1)
    expect(String(calls[0].format)).toMatch(/\/bestaudio\/best$/)
    expect(knownLive('https://www.youtube.com/watch?v=L1')).toBe(true)
    await expect(getAudioFile('https://www.youtube.com/watch?v=L1')).rejects.toThrow(LIVE_DOWNLOAD_ERROR)
    await expect(downloadLinkVideo('https://www.youtube.com/watch?v=L1', 720, vi.fn())).rejects.toThrow(LIVE_DOWNLOAD_ERROR)
    await getAudioStreamUrl('https://www.youtube.com/watch?v=L2', 'low')
    expect(String(calls[1].format)).toMatch(/\/worstaudio\/worst$/)
  })

  it('reuses a link\'s reading while it is fresh, and asks yt-dlp again when asked or when it is old', async () =>
  {
    const dl = vi.fn(async () => liveReading())
    ytdlp.dl = dl
    const url = 'https://www.youtube.com/watch?v=cache'
    expect(await getLinkData(url)).toMatchObject({ id: 'L1' })
    expect(await getLinkData(url)).toMatchObject({ id: 'L1' })
    expect(dl).toHaveBeenCalledTimes(1)
    expect(dl.mock.calls[0][1]).toMatchObject({ dumpSingleJson: true, noPlaylist: true })
    await getLinkData(url, true)
    expect(dl).toHaveBeenCalledTimes(2)
    rememberLinkData(url, { id: 'old', is_live: true })
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + LINK_DATA_TTL_MS + 1)
    expect(knownLive(url)).toBe(false)
    expect(await getLinkData(url)).toMatchObject({ id: 'L1' })
    expect(dl).toHaveBeenCalledTimes(3)
  })
})

describe('link streams: the FFmpeg command', () =>
{
  beforeEach(() =>
  {
    runs.calls.length = 0
    runs.result = { code: 0, stdout: '', stderr: '', killed: false }
    gpu.mode = 'off'
  })

  it('writes request headers as one -headers value, without Host or broken lines', () =>
  {
    expect(streamHeaderArgs({ 'User-Agent': 'UA', Host: 'h', Accept: '*/*', Bad: 'a\r\nInjected: 1', Empty: '' })).toEqual(['-headers', 'User-Agent: UA\r\nAccept: */*\r\n'])
    expect(streamHeaderArgs({})).toEqual([])
    expect(copiesPicture('avc1', [])).toBe(true)
    expect(copiesPicture('vp9', ['avc1'])).toBe(false)
    expect(copiesPicture('vp9', ['avc1', 'vp9'])).toBe(true)
    expect(copiesPicture(null, ['avc1'])).toBe(false)
  })

  it('keeps a live stream\'s own clock: sound on stdout, the picture copied on pipe:3, each track\'s true start kept', () =>
  {
    const plan = planLinkStream(liveReading(), want())
    const { args, outputs, encoder } = linkStreamArgs(plan, { at: null, copyFamilies: ['avc1'], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1920, height: 1080 })
    expect(outputs).toEqual(['sound', 'picture'])
    expect(encoder).toBeNull()
    expect(args.slice(0, 5)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-copyts'])
    expect(args).not.toContain('-start_at_zero')
    expect(args).not.toContain('-ss')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2)
    const first = args.indexOf('https://m/v270.m3u8')
    expect(args.slice(first - 5, first + 1)).toEqual(['-headers', 'User-Agent: UA\r\nAccept: */*\r\n', '-rw_timeout', '15000000', '-i', 'https://m/v270.m3u8'])
    expect(args.indexOf('https://m/a234.m3u8')).toBeGreaterThan(first)
    const sound = args.slice(args.indexOf('1:a:0') - 1, args.indexOf('pipe:1') + 1)
    expect(sound.slice(0, 2)).toEqual(['-map', '1:a:0'])
    expect(sound).toEqual(expect.arrayContaining(['-vn', '-c:a:0', 'libopus', '-movflags', 'empty_moov+delay_moov+default_base_moof', '-frag_duration', '500000']))
    const picture = args.slice(args.indexOf('pipe:1') + 1)
    expect(picture).toEqual(['-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:3'])
  })

  it('restarts a live picture on its own, trimmed to the sound\'s clock and keeping it', () =>
  {
    const plan = planLinkStream(liveReading(), want({ sound: false }))
    const { args, outputs } = linkStreamArgs(plan, { at: 7662.5, copyFamilies: ['avc1'], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1920, height: 1080 })
    expect(outputs).toEqual(['picture'])
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'))
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v:0', '-ss', '7662.500', '-output_ts_offset', '7662.500', 'pipe:1']))
    expect(args).not.toContain('pipe:3')
  })

  it('starts a recording at the seek point on content time, copying AAC and decoding a picture Chromium cannot', () =>
  {
    const recording = { duration: 300, formats: [{ url: 'https://c/av.m3u8', protocol: 'm3u8', vcodec: 'hvc1.1.6.L120', acodec: 'mp4a.40.2', height: 1080, fps: 24, http_headers: { 'User-Agent': 'UA' } }] }
    const plan = planLinkStream(recording, want())
    const { args, encoder } = linkStreamArgs(plan, { at: 42, copyFamilies: ['avc1'], encoder: { mode: 'nvenc', codec: 'h264_nvenc' }, width: 2560, height: 1440 })
    expect(encoder).toBe('h264_nvenc')
    expect(args.slice(4, 6)).toEqual(['-copyts', '-start_at_zero'])
    expect(args.slice(args.indexOf('-i') - 4, args.indexOf('-i') + 2)).toEqual(['-hwaccel', 'cuda', '-ss', '42.000', '-i', 'https://c/av.m3u8'])
    expect(args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-ss', '42.000', '-output_ts_offset', '42.000', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']))
    const picture = args.slice(args.indexOf('pipe:1') + 1)
    expect(picture).toEqual(expect.arrayContaining(['-map', '0:v:0', '-vf', '-c:v:0', 'h264_nvenc', 'pipe:3']))
    expect(picture[picture.indexOf('-vf') + 1]).toContain('format=yuv420p')
    const mp3 = linkStreamArgs(planLinkStream({ formats: [{ url: 'r', vcodec: 'none', acodec: 'mp3' }] }, want()), { at: 0, copyFamilies: [], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1, height: 1 })
    expect(mp3.args).toEqual(expect.arrayContaining(['-c:a', 'copy']))
    expect(mp3.args).not.toContain('-bsf:a')
    expect(mp3.args).not.toContain('-ss')
    expect(mp3.outputs).toEqual(['sound'])
    const ac3 = linkStreamArgs(planLinkStream({ formats: [{ url: 'r', vcodec: 'none', acodec: 'ac-3', audio_channels: 6, asr: 48000 }] }, want()), { at: null, copyFamilies: [], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1, height: 1 })
    expect(ac3.args).toEqual(expect.arrayContaining(opusPlaybackArgs({ codec: 'ac3', channels: 6, sampleRate: 48000 }).args))
    const maybe = linkStreamArgs(planLinkStream({ url: 'https://c/index.m3u8' }, want()), { at: null, copyFamilies: [], encoder: SOFTWARE_DISPLAY_ENCODER, width: 1, height: 1 })
    expect(maybe.args).toContain('0:a:0?')
  })

  it('uses the computer\'s hardware encoder only when the picture is decoded, and software when asked', async () =>
  {
    gpu.mode = 'nvenc'
    const hevc = planLinkStream({ formats: [{ url: 'h', vcodec: 'hev1.1.6.L120', acodec: 'mp4a.40.2', height: 1080 }] }, want())
    expect(await linkStreamCommand(hevc, { at: null, copyFamilies: ['avc1'], width: 1920, height: 1080, software: false })).toMatchObject({ command: '/bin/ffmpeg', encoder: 'h264_nvenc' })
    expect((await linkStreamCommand(hevc, { at: null, copyFamilies: ['avc1'], width: 1920, height: 1080, software: true })).encoder).toBe('libx264')
    expect((await linkStreamCommand(planLinkStream(liveReading(), want()), { at: null, copyFamilies: ['avc1'], width: 1920, height: 1080, software: false })).encoder).toBeNull()
  })

  it('probes a stream URL with its headers and reads the first picture and sound', async () =>
  {
    const input = { url: 'https://tv/index.m3u8', headers: { 'User-Agent': 'UA' } }
    expect(streamProbeArgs(input)).toEqual(['-v', 'error', '-headers', 'User-Agent: UA\r\n', '-rw_timeout', '15000000', '-show_entries', 'stream=codec_type,codec_name,width,height,channels,sample_rate', '-of', 'json', 'https://tv/index.m3u8'])
    const json = JSON.stringify({ streams: [{ codec_type: 'data', codec_name: 'timed_id3' }, { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }, { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }] })
    expect(parseStreamProbe(json)).toEqual({ video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac', channels: 2, sampleRate: 48000 } })
    expect(parseStreamProbe(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }))).toEqual({ video: null, audio: { codec: 'mp3', channels: null, sampleRate: null } })
    expect(parseStreamProbe('not json')).toBeNull()
    expect(parseStreamProbe('{}')).toBeNull()
    runs.result = { code: 0, stdout: json, stderr: '', killed: false }
    expect(await probeStreamInput(input)).toMatchObject({ video: { codec: 'h264' } })
    expect(runs.calls[0][0]).toBe('/bin/ffprobe')
    runs.result = { code: 1, stdout: '', stderr: 'HTTP error 403', killed: false }
    expect(await probeStreamInput(input)).toBeNull()
    const saved = config.ffmpeg
    config.ffmpeg = { ...saved, ffprobePath: '' }
    expect(await probeStreamInput(input)).toBeNull()
    config.ffmpeg = saved
  })
})

describe('picture subtitles on the decode route', () =>
{
  const pgs = toPlayerStream({ index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', width: 1920, height: 1080, tags: { language: 'eng' } })
  const srt = toPlayerStream({ index: 3, codec_type: 'subtitle', codec_name: 'subrip' })
  const dvd = toPlayerStream({ index: 4, codec_type: 'subtitle', codec_name: 'dvd_subtitle' })
  const closed = toPlayerStream({ index: 5, codec_type: 'subtitle', codec_name: 'eia_608' })
  const video = toPlayerStream({ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 800, disposition: { default: 1 } })
  const media: PlayerMedia = { path: 'C:/m/a.mkv', container: 'matroska,webm', containerName: null, duration: 60, startTime: 0, bitRate: null, size: null, streams: [video, pgs, srt, dvd, closed], picture: { route: 'direct', streamIndex: 0, reason: null }, sound: [] }

  it('knows the picture subtitle codecs and lists every subtitle the player can show', () =>
  {
    expect(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'subrip'].map(isImageSubtitle)).toEqual([true, true, true, false])
    expect(imageSubtitles(media.streams).map((s) => s.index)).toEqual([2, 4])
    expect(shownSubtitles(media.streams).map((s) => s.index)).toEqual([2, 3, 4])
  })

  it('moves the picture to the decode route for a picture subtitle and back to the cheapest route without one', () =>
  {
    expect(pictureWithSubtitles(media.picture, media.streams, 2)).toEqual({ route: 'convert', streamIndex: 0, reason: 'subtitles', subtitleIndex: 2 })
    expect(pictureWithSubtitles(media.picture, media.streams, 3)).toBe(media.picture)
    expect(pictureWithSubtitles(media.picture, media.streams, null)).toBe(media.picture)
    expect(pictureWithSubtitles(media.picture, media.streams, 0)).toBe(media.picture)
    expect(pictureWithSubtitles(null, media.streams, 2)).toBeNull()
    expect(mediaWithSubtitles(media, 4).picture).toMatchObject({ route: 'convert', subtitleIndex: 4 })
    expect(mediaWithSubtitles(media, null)).toBe(media)
  })

  it('draws the subtitle onto the picture before fitting it, scaling a canvas of another size', () =>
  {
    const fit = ['scale=w=1', 'format=yuv420p']
    expect(subtitleOverlayGraph(0, { streamIndex: 2, scaleTo: null }, fit)).toBe('[0:0][0:2]overlay=eof_action=pass,scale=w=1,format=yuv420p[pic]')
    expect(subtitleOverlayGraph(0, { streamIndex: 2, scaleTo: { width: 1920, height: 800 } }, [])).toBe('[0:2]scale=1920:800[sub];[0:0][sub]overlay=eof_action=pass[pic]')
  })

  it('starts a few seconds early so a subtitle already showing is drawn, decoding in software', () =>
  {
    const encoder = { mode: 'nvenc' as const, codec: 'h264_nvenc' }
    const args = pictureDecodeArgs('C:/m/a.mkv', 0, 12.5, { encoder, width: 1920, height: 1080, fps: 24, subtitle: { streamIndex: 2, scaleTo: null } })
    expect(args).not.toContain('-hwaccel')
    expect(args.slice(4, 8)).toEqual(['-ss', (12.5 - SUBTITLE_PREROLL).toFixed(3), '-i', 'C:/m/a.mkv'])
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph.startsWith('[0:0][0:2]overlay=eof_action=pass,')).toBe(true)
    expect(graph.endsWith('format=yuv420p[pic]')).toBe(true)
    expect(args.slice(args.indexOf('[pic]') - 1, args.indexOf('[pic]') + 6)).toEqual(['-map', '[pic]', '-an', '-sn', '-dn', '-ss', '5.000'])
    expect(args).not.toContain('-vf')
    expect(args).toContain('h264_nvenc')
    const early = pictureDecodeArgs('C:/m/a.mkv', 0, 3, { encoder, width: 1920, height: 1080, fps: 24, subtitle: { streamIndex: 2, scaleTo: null } })
    expect(early.slice(4, 6)).toEqual(['-i', 'C:/m/a.mkv'])
    expect(early).toEqual(expect.arrayContaining(['-ss', '3.000']))
    const start = pictureDecodeArgs('C:/m/a.mkv', 0, 0, { encoder, width: 1920, height: 1080, fps: 24, subtitle: { streamIndex: 2, scaleTo: null } })
    expect(start).not.toContain('-ss')
    const plain = pictureDecodeArgs('C:/m/a.mkv', 0, 12.5, { encoder, width: 1920, height: 1080, fps: 24, subtitle: null })
    expect(plain).toEqual(expect.arrayContaining(['-hwaccel', 'cuda', '-ss', '12.500', '-vf']))
    expect(plain).not.toContain('-filter_complex')
  })

  it('passes the subtitle through the decode command', async () =>
  {
    const { args } = await pictureDecodeCommand('C:/m/a.mkv', 0, 0, { width: 1920, height: 1080, fps: null, software: true, subtitle: { streamIndex: 4, scaleTo: { width: 720, height: 576 } } })
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[0:4]scale=720:576[sub]')
  })
})
