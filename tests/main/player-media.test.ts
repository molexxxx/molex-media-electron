import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  audioTracks,
  CHROMIUM_AUDIO_CODECS,
  codecName,
  containerPlays,
  hdrOf,
  isTextSubtitle,
  parseRate,
  pictureStream,
  planPicture,
  summarizeProbe,
  textSubtitles,
  toPlayerStream,
  type PlayerStream
} from '../../src/shared/player/media'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/test-app') } }))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn(), ffmpeg: vi.fn() } }))

const config = vi.hoisted(() => ({ ffmpeg: { source: 'path', buildId: null, ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe', selfTest: null } }))
vi.mock('../../src/main/config', () => ({ getConfig: vi.fn(async () => config) }))

const runs = vi.hoisted(() => ({ calls: [] as string[][], result: { code: 0, stdout: 'WEBVTT\n', stderr: '', killed: false } }))
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: vi.fn((_: string, args: string[]) =>
  {
    runs.calls.push(args)
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

const probe = vi.hoisted(() => ({ json: { streams: [] as Array<Record<string, unknown>>, format: {} as Record<string, unknown>, chapters: [] } }))
vi.mock('../../src/main/ffmpeg/probe', () => ({ createProbe: vi.fn(() => async () => probe.json) }))

const cookies = vi.hoisted(() => ({ withCookieRetry: vi.fn(async (fn: (flags: Record<string, unknown>) => Promise<unknown>) => fn({ cookies: 'C:/cookies.txt' })) }))
vi.mock('../../src/main/ytdlp/cookies', () => ({ withCookieRetry: cookies.withCookieRetry }))
vi.mock('../../src/main/ytdlp/binary', () => ({ getYtDl: vi.fn(), baseFlags: vi.fn(() => ({})) }))

vi.mock('fs', async () =>
{
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn(() => false), statSync: vi.fn(() => ({ size: 1 })), readdirSync: vi.fn(() => []), unlinkSync: vi.fn(), rmdirSync: vi.fn() }
})

import {
  DEFAULT_DISPLAY_BOX,
  displayEncoderArgs,
  displayGop,
  extractSubtitles,
  inspectForPlayback,
  pictureDecodeArgs,
  pictureDecodeCommand,
  pictureRemuxArgs,
  playerMediaOf,
  prepareRemuxedPicture,
  SOFTWARE_DISPLAY_ENCODER,
  soundPlanFor,
  subtitleArgs
} from '../../src/main/ffmpeg/playback'
import { codecFamily, cookieFreeFirst, mergedFormatSelector, needsCookies, parseDownloadProgress, pickLinkVideo, videoFormatSelector } from '../../src/main/ytdlp/resolver'
import { PROXY_DEFAULT_USER_AGENT, proxyRequestHeaders, proxyResponseHeaders } from '../../src/main/preview-server'

const h264 = { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001', r_frame_rate: '30/1', bit_rate: '5000000', disposition: { default: 1 } }
const aac = { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, channel_layout: 'stereo', sample_rate: '48000', bit_rate: '160000', tags: { language: 'eng', title: 'English' }, disposition: { default: 1 } }
const ac3 = { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', tags: { language: 'ger' } }
const srt = { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }
const cover = { index: 4, codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }

function stream(over: Partial<PlayerStream>): PlayerStream
{
  return toPlayerStream({ ...h264, ...over })
}

describe('shared/player/media', () =>
{
  it('reads a stream with its plain facts, the default flag, and the cover art kind', () =>
  {
    const video = toPlayerStream(h264)
    expect(video).toMatchObject({ index: 0, kind: 'video', codec: 'h264', profile: 'High', level: 40, width: 1920, height: 1080, pixelFormat: 'yuv420p', isDefault: true, bitRate: 5000000, hdr: null })
    expect(video.frameRate).toBeCloseTo(29.97, 2)
    expect(toPlayerStream(aac)).toMatchObject({ kind: 'audio', language: 'eng', title: 'English', channels: 2, layout: 'stereo', sampleRate: 48000, bitRate: 160000 })
    expect(toPlayerStream(cover).kind).toBe('cover')
    expect(toPlayerStream({ index: 7, codec_type: 'data', codec_name: 'bin_data' })).toMatchObject({ kind: 'data', codec: 'bin_data', language: null, frameRate: null })
    expect(toPlayerStream({ index: 8, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' })).toMatchObject({ bitDepth: 10, hdr: 'pq' })
    expect(toPlayerStream({ index: 9, codec_type: 'audio', codec_name: 'flac', bits_per_raw_sample: '24', tags: { BPS: '900000' } })).toMatchObject({ bitDepth: 24, bitRate: 900000 })
  })

  it('reads rates, HDR transfers, and codec names', () =>
  {
    expect(parseRate('24000/1001')).toBeCloseTo(23.976, 3)
    expect(parseRate('0/0')).toBeNull()
    expect(parseRate(25)).toBe(25)
    expect(parseRate('abc')).toBeNull()
    expect(hdrOf('arib-std-b67')).toBe('hlg')
    expect(hdrOf('bt709')).toBeNull()
    expect(codecName('ac3')).toBe('Dolby Digital (AC-3)')
    expect(codecName('pcm_s24le')).toBe('PCM (uncompressed)')
    expect(codecName('hevc')).toBe('HEVC (H.265)')
    expect(codecName('subrip')).toBe('SubRip (SRT)')
    expect(codecName('toString')).toBe('toString')
    expect(codecName('mystery')).toBe('mystery')
  })

  it('knows the containers and audio codecs Chromium reads, and text subtitles', () =>
  {
    expect(containerPlays('matroska,webm')).toBe(true)
    expect(containerPlays('mov,mp4,m4a,3gp,3g2,mj2')).toBe(true)
    expect(containerPlays('mpegts')).toBe(false)
    expect(containerPlays('')).toBe(false)
    expect(CHROMIUM_AUDIO_CODECS.has('aac')).toBe(true)
    expect(CHROMIUM_AUDIO_CODECS.has('ac3')).toBe(false)
    expect(isTextSubtitle('mov_text')).toBe(true)
    expect(isTextSubtitle('hdmv_pgs_subtitle')).toBe(false)
  })

  it('picks the default picture over the first and never cover art, and lists tracks', () =>
  {
    const streams = [toPlayerStream(cover), toPlayerStream({ ...h264, index: 5, disposition: {} }), toPlayerStream(h264), toPlayerStream(aac), toPlayerStream(ac3), toPlayerStream(srt)]
    expect(pictureStream(streams)?.index).toBe(0)
    expect(pictureStream([toPlayerStream(cover)])).toBeNull()
    expect(audioTracks(streams).map((s) => s.index)).toEqual([1, 2])
    expect(textSubtitles(streams).map((s) => s.index)).toEqual([3])
  })

  it('plans the picture from the renderer verdict and the container', () =>
  {
    const streams = [toPlayerStream(h264)]
    expect(planPicture(streams, 'matroska,webm', 'decodes')).toEqual({ route: 'direct', streamIndex: 0, reason: null })
    expect(planPicture(streams, 'mpegts', 'decodes')).toEqual({ route: 'remux', streamIndex: 0, reason: 'container' })
    expect(planPicture(streams, 'mpegts', 'no-decoder')).toEqual({ route: 'convert', streamIndex: 0, reason: 'codec' })
    expect(planPicture(streams, 'mov,mp4', 'not-here')).toEqual({ route: 'convert', streamIndex: 0, reason: 'machine' })
    expect(planPicture([toPlayerStream(aac)], 'mov,mp4', 'decodes')).toBeNull()
  })

  it('summarizes a probe with the container, duration, and size', () =>
  {
    const summary = summarizeProbe({ streams: [h264, aac], format: { format_name: 'matroska,webm', format_long_name: 'Matroska / WebM', duration: '30.5', start_time: '0.0', bit_rate: '6000000', size: '22875000' } }, 'C:/clips/a.mkv')
    expect(summary).toMatchObject({ path: 'C:/clips/a.mkv', container: 'matroska,webm', containerName: 'Matroska / WebM', duration: 30.5, startTime: 0, bitRate: 6000000, size: 22875000 })
    expect(summary.streams).toHaveLength(2)
    expect(summarizeProbe({ streams: [], format: null }, 'x')).toMatchObject({ container: '', duration: null, startTime: 0 })
  })
})

describe('playback: sound plans and the player media', () =>
{
  const file = 'C:/clips/Two tracks.mkv'

  it('plays a plain audio file and a sole native track directly, repackages a native codec among several, and decodes the rest', () =>
  {
    const mkv = { container: 'matroska,webm', audioCount: 2 }
    expect(soundPlanFor('C:/music/a.mp3', toPlayerStream({ ...aac, codec_name: 'mp3' }), 0, { container: 'mp3', audioCount: 1 }).route).toBe('direct')
    expect(soundPlanFor('C:/clips/a.mp4', toPlayerStream(aac), 0, { container: 'mov,mp4,m4a,3gp,3g2,mj2', audioCount: 1 }).route).toBe('direct')
    expect(soundPlanFor(file, toPlayerStream(aac), 0, mkv)).toEqual({ route: 'remux', audioIndex: 0, streamIndex: 1, target: null, remappedTo: null })
    expect(soundPlanFor(file, toPlayerStream(ac3), 1, mkv)).toEqual({ route: 'convert', audioIndex: 1, streamIndex: 2, target: 'opus', remappedTo: '5.1' })
    expect(soundPlanFor('C:/clips/a.ts', toPlayerStream(aac), 0, { container: 'mpegts', audioCount: 1 }).route).toBe('remux')
    expect(soundPlanFor('C:/clips/a.mkv', toPlayerStream({ ...aac, channels: undefined, channel_layout: undefined, sample_rate: undefined, codec_name: 'dts' }), 0, { container: 'matroska,webm', audioCount: 1 })).toMatchObject({ route: 'convert', target: 'opus' })
  })

  it('builds the player media with no picture plan and one sound plan per track', () =>
  {
    const media = playerMediaOf({ streams: [h264, aac, ac3, srt], format: { format_name: 'matroska,webm', duration: '30' } }, file)
    expect(media.picture).toBeNull()
    expect(media.sound.map((plan) => plan.route)).toEqual(['remux', 'convert'])
    expect(media.streams.map((s) => s.kind)).toEqual(['video', 'audio', 'audio', 'subtitle'])
  })

  it('inspects a file with the configured ffprobe and refuses without one', async () =>
  {
    probe.json = { streams: [h264, aac], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '20' }, chapters: [] }
    const media = await inspectForPlayback('C:/clips/a.mp4')
    expect(media.sound[0].route).toBe('direct')
    const saved = config.ffmpeg
    config.ffmpeg = { ...saved, ffprobePath: '' }
    await expect(inspectForPlayback('C:/clips/a.mp4')).rejects.toThrow('ffprobe not configured')
    config.ffmpeg = saved
  })
})

describe('playback: pictures decoded by FFmpeg', () =>
{
  beforeEach(() =>
  {
    runs.calls.length = 0
    runs.result = { code: 0, stdout: 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n', stderr: '', killed: false }
    gpu.mode = 'off'
  })

  it('keeps about a second between keyframes', () =>
  {
    expect(displayGop(null)).toBe(30)
    expect(displayGop(23.976)).toBe(24)
    expect(displayGop(120)).toBe(60)
    expect(displayGop(5)).toBe(12)
  })

  it('encodes for latency: x264 ultrafast with the zero-latency tune, or the hardware encoder without B-frames', () =>
  {
    expect(displayEncoderArgs(SOFTWARE_DISPLAY_ENCODER, 30)).toEqual(['-c:v:0', 'libx264', '-crf:v:0', '23', '-preset:v:0', 'ultrafast', '-tune:v:0', 'zerolatency', '-g:v:0', '30'])
    expect(displayEncoderArgs({ mode: 'nvenc', codec: 'h264_nvenc' }, 24)).toEqual(['-c:v:0', 'h264_nvenc', '-preset', 'p1', '-rc', 'constqp', '-qp', '23', '-bf:v:0', '0', '-g:v:0', '24'])
    expect(displayEncoderArgs({ mode: 'qsv', codec: 'h264_qsv' }, 24)).toContain('-global_quality')
    expect(displayEncoderArgs({ mode: 'amf', codec: 'h264_amf' }, 24)).toContain('-quality')
  })

  it('seeks before the input, fits the display without scaling up, strips sound, and streams fragmented MP4 on stdout', () =>
  {
    const args = pictureDecodeArgs('C:/clips/old.ts', 0, 12.5, { encoder: SOFTWARE_DISPLAY_ENCODER, width: 1920, height: 1080, fps: 25 })
    expect(args.slice(0, 8)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', '12.500', '-i', 'C:/clips/old.ts'])
    expect(args).toEqual(expect.arrayContaining(['-map', '0:0', '-an', '-sn', '-dn', '-vf', '-c:v:0', 'libx264', '-g:v:0', '25', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1']))
    const filters = args[args.indexOf('-vf') + 1]
    expect(filters).toContain("scale=w='trunc(iw*sar*min(1,min(1920/(iw*sar),1080/ih))/2)*2'")
    expect(filters).toContain('format=yuv420p')
    expect(args).not.toContain('-hwaccel')
    const fromStart = pictureDecodeArgs('C:/clips/old.ts', 2, 0, { encoder: { mode: 'nvenc', codec: 'h264_nvenc' }, width: 2560, height: 1440, fps: null })
    expect(fromStart).not.toContain('-ss')
    expect(fromStart.slice(4, 6)).toEqual(['-hwaccel', 'cuda'])
    expect(fromStart).toContain('h264_nvenc')
  })

  it('chooses the computer\'s hardware encoder once and falls back to software when asked', async () =>
  {
    gpu.mode = 'nvenc'
    const hardware = await pictureDecodeCommand('C:/clips/old.ts', 0, 3, { width: 1920, height: 1080, fps: 30, software: false })
    expect(hardware).toMatchObject({ command: '/bin/ffmpeg', encoder: 'h264_nvenc' })
    const software = await pictureDecodeCommand('C:/clips/old.ts', 0, 3, { width: 1920, height: 1080, fps: 30, software: true })
    expect(software.encoder).toBe('libx264')
    gpu.mode = 'off'
    expect((await pictureDecodeCommand('C:/clips/old.ts', 0, 0, { ...DEFAULT_DISPLAY_BOX, fps: null, software: false })).encoder).toBe('libx264')
  })

  it('repackages a picture stream into Matroska once and shares the copy between callers', async () =>
  {
    const [a, b] = await Promise.all([prepareRemuxedPicture('C:/clips/cam.m2ts', 0), prepareRemuxedPicture('C:/clips/cam.m2ts', 0)])
    expect(a).toBe(b)
    expect(a).toMatch(/cam_[a-z0-9]+_v0\.mkv$/)
    expect(runs.calls).toHaveLength(1)
    expect(runs.calls[0]).toEqual(pictureRemuxArgs('C:/clips/cam.m2ts', 0, a))
    expect(runs.calls[0]).toEqual(expect.arrayContaining(['-c', 'copy', '-an', '-sn', '-dn', '-reserve_index_space', '50000']))
  })

  it('writes text subtitles as WebVTT and reports a failed extraction', async () =>
  {
    expect(subtitleArgs('C:/clips/sub.mkv', 3)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'C:/clips/sub.mkv', '-map', '0:3', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'])
    const vtt = await extractSubtitles('C:/clips/sub.mkv', 3)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(await extractSubtitles('C:/clips/sub.mkv', 3)).toBe(vtt)
    expect(runs.calls).toHaveLength(1)
    runs.result = { code: 1, stdout: '', stderr: 'Subtitle encoding failed', killed: false }
    await expect(extractSubtitles('C:/clips/other.mkv', 3)).rejects.toThrow('Subtitle extraction failed')
  })
})

describe('resolver: the picture of a link', () =>
{
  it('asks for video-only H.264 up to the cap first, then a progressive H.264 MP4, then only the codecs the renderer decodes, all over plain HTTPS', () =>
  {
    const h264Only = videoFormatSelector(720, ['avc1'])
    expect(h264Only).toBe('bv[ext=mp4][vcodec^=avc1][height<=720][protocol=https]/b[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720][protocol=https]')
    const all = videoFormatSelector(1080, ['avc1', 'vp9', 'av01'])
    expect(all).toContain('/bv[vcodec^=vp09][height<=1080][protocol=https]/bv[vcodec=vp9][height<=1080][protocol=https]/bv[vcodec^=av01][height<=1080][protocol=https]')
    expect(videoFormatSelector(10, ['avc1'])).toContain('[height<=144]')
    expect(mergedFormatSelector(480)).toBe('bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]')
  })

  it('takes a progressive or video-only direct format and refuses playlists, segments, and codecs not allowed', () =>
  {
    expect(pickLinkVideo({ url: 'https://cdn/a.mp4', format_id: '22', ext: 'mp4', vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', width: 1280, height: 720, fps: 30, protocol: 'https', http_headers: { 'User-Agent': 'UA', Host: 'x' } }, ['avc1']))
      .toEqual({ kind: 'progressive', url: 'https://cdn/a.mp4', httpHeaders: { 'User-Agent': 'UA' }, formatId: '22', ext: 'mp4', width: 1280, height: 720, codec: 'avc1.64001F', fps: 30, hasSound: true })
    expect(pickLinkVideo({ url: 'https://cdn/v.mp4', format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', protocol: 'https' }, ['avc1'])).toMatchObject({ kind: 'dash', hasSound: false, width: null })
    expect(pickLinkVideo({ url: 'https://cdn/b.webm', vcodec: 'vp9', acodec: 'none', protocol: 'https' }, ['avc1'])).toBeNull()
    expect(pickLinkVideo({ url: 'https://cdn/b.webm', vcodec: 'vp9', acodec: 'none', protocol: 'https' }, ['avc1', 'vp9'])?.codec).toBe('vp9')
    expect(pickLinkVideo({ url: 'https://cdn/c.mp4', vcodec: 'av01.0.08M.08', protocol: 'https' }, ['avc1', 'av01'])?.kind).toBe('dash')
    expect(pickLinkVideo({ url: 'https://cdn/m.m3u8', vcodec: 'avc1.4d401f', protocol: 'm3u8_native' }, ['avc1'])).toBeNull()
    expect(pickLinkVideo({ url: 'https://cdn/seg', vcodec: 'avc1.4d401f', protocol: 'http_dash_segments' }, ['avc1'])).toBeNull()
    expect(pickLinkVideo({ url: 'https://cdn/d.mp4', vcodec: 'hev1.1.6.L120', protocol: 'https' }, ['avc1', 'vp9', 'av01'])).toBeNull()
    expect(pickLinkVideo({ vcodec: 'avc1' }, ['avc1'])).toBeNull()
    expect(pickLinkVideo(null, ['avc1'])).toBeNull()
    expect(codecFamily('vp09.00.40.08')).toBe('vp9')
    expect(codecFamily('mp4v.20.3')).toBeNull()
  })

  it('reads yt-dlp download progress lines', () =>
  {
    expect(parseDownloadProgress('[download]  43.2% of   10.00MiB at    2.00MiB/s ETA 00:03')).toBe(43.2)
    expect(parseDownloadProgress('[download] 100% of 10.00MiB in 00:05')).toBe(100)
    expect(parseDownloadProgress('[Merger] Merging formats into "x.mp4"')).toBeNull()
  })
})

describe('preview server: CDN proxy headers', () =>
{
  it('forwards the source headers and the Range, adds a User-Agent only when the source named none, and never Host', () =>
  {
    expect(proxyRequestHeaders({ 'User-Agent': 'yt', Accept: '*/*', Cookie: 'a=1', Host: 'cdn', Range: 'bytes=9-' }, 'bytes=0-1'))
      .toEqual({ 'User-Agent': 'yt', Accept: '*/*', Cookie: 'a=1', Range: 'bytes=0-1' })
    expect(proxyRequestHeaders({}, undefined)).toEqual({ 'User-Agent': PROXY_DEFAULT_USER_AGENT })
  })

  it('passes the media headers through and marks a partial answer as range capable', () =>
  {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    expect(proxyResponseHeaders(206, { 'content-type': 'audio/mp4', 'content-length': '10', 'content-range': 'bytes 0-9/100', 'x-other': 'no' }, cors))
      .toEqual({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'content-type': 'audio/mp4', 'content-length': '10', 'content-range': 'bytes 0-9/100', 'accept-ranges': 'bytes' })
    expect(proxyResponseHeaders(200, { 'content-type': 'video/mp4', 'accept-ranges': 'none' }, cors)).toMatchObject({ 'accept-ranges': 'none' })
  })
})

describe('resolver: cookies only when the site asks', () =>
{
  it('runs without cookies first and retries with them only for a sign-in error', async () =>
  {
    cookies.withCookieRetry.mockClear()
    const calls: Array<Record<string, unknown>> = []
    const plain = await cookieFreeFirst(async (flags) =>
    {
      calls.push(flags)
      return 'ok'
    })
    expect(plain).toBe('ok')
    expect(calls).toEqual([{}])
    expect(cookies.withCookieRetry).not.toHaveBeenCalled()
    const signedIn = await cookieFreeFirst(async (flags) =>
    {
      calls.push(flags)
      if (!('cookies' in flags))
      {
        throw new Error('ERROR: [youtube] x: Sign in to confirm your age')
      }
      return 'with cookies'
    })
    expect(signedIn).toBe('with cookies')
    expect(cookies.withCookieRetry).toHaveBeenCalledTimes(1)
    await expect(cookieFreeFirst(async () =>
    {
      throw new Error('HTTP Error 429: Too Many Requests')
    })).rejects.toThrow('429')
    expect(needsCookies('This video is private')).toBe(true)
    expect(needsCookies("Sign in to confirm you're not a bot")).toBe(true)
    expect(needsCookies('Requested format is not available')).toBe(false)
  })
})
