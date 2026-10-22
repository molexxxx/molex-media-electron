/**
 * The player engine against a stubbed window.api: links play their sound through yt-dlp as before, the picture
 * is additive and falls back to the visualization with a note, failures read in plain words, and local files play
 * the way their plan says.
 */
import React, { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { PICTURE_JOIN_LEAD, usePlayer, type PlayerEngine } from '@renderer/components/player/hooks/usePlayer'

const api = vi.hoisted(() => ({
  resolvePlaylist: vi.fn(),
  getStreamUrl: vi.fn(),
  getLinkPicture: vi.fn(),
  getLinkStream: vi.fn(),
  inspectMedia: vi.fn(),
  getSoundUrl: vi.fn(),
  getPictureUrl: vi.fn(),
  getSubtitles: vi.fn(),
  clearPlaybackCache: vi.fn(async () => undefined),
  isPopout: vi.fn(async () => false),
  onReceivePlayerState: vi.fn(() => () => undefined),
  onPopoutClosed: vi.fn(() => () => undefined),
  getPlayerState: vi.fn(async () => null),
  returnPlayerState: vi.fn(),
  popoutPlayer: vi.fn(async () => undefined),
  getFilePath: vi.fn((file: File) => `C:/drop/${file.name}`),
  onLinkProgress: vi.fn(() => () => undefined),
  isFullScreen: vi.fn(async () => false),
  onFullScreenChanged: vi.fn(() => () => undefined),
  setFullScreen: vi.fn(async (on: boolean) => on)
}))

const mp4Probe = {
  path: 'C:/clips/a.mp4',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  containerName: 'QuickTime / MOV',
  duration: 20,
  startTime: 0,
  bitRate: 3_000_000,
  size: 7_500_000,
  streams: [
    { index: 0, kind: 'video', codec: 'h264', profile: 'High', level: 40, language: null, title: null, isDefault: true, bitRate: null, sampleRate: null, channels: null, layout: null, bitDepth: null, width: 1280, height: 720, frameRate: 30, pixelFormat: 'yuv420p', colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null },
    { index: 1, kind: 'audio', codec: 'aac', profile: null, level: null, language: null, title: null, isDefault: true, bitRate: 160_000, sampleRate: 48000, channels: 6, layout: '5.1', bitDepth: null, width: null, height: null, frameRate: null, pixelFormat: null, colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null }
  ],
  picture: null,
  sound: [{ route: 'direct', audioIndex: 0, streamIndex: 1, target: null, remappedTo: null }]
}

let engine: PlayerEngine | null = null

function Harness(): React.JSX.Element
{
  const player = usePlayer({ popout: false })
  useEffect(() =>
  {
    engine = player
  })
  return (
    <div>
      <audio ref={player.audioRef} />
      <video ref={player.videoRef} />
    </div>
  )
}

function current(): PlayerEngine
{
  if (engine === null)
  {
    throw new Error('not mounted')
  }
  return engine
}

describe('usePlayer', () =>
{
  beforeEach(() =>
  {
    vi.clearAllMocks()
    for (const fn of [api.resolvePlaylist, api.getStreamUrl, api.inspectMedia, api.getSoundUrl, api.getLinkPicture, api.getLinkStream, api.getPictureUrl])
    {
      fn.mockReset()
    }
    api.onLinkProgress.mockImplementation(() => () => undefined)
    Object.assign(window, { api })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', { value: () => '', configurable: true })
    Object.defineProperty(navigator, 'mediaCapabilities', { value: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) }, configurable: true })
    api.getLinkPicture.mockResolvedValue({ ok: false, error: 'No picture format the player can show' })
    api.getSubtitles.mockResolvedValue({ ok: true, vtt: 'WEBVTT\n' })
    api.getPictureUrl.mockResolvedValue({ ok: true, picture: { url: 'http://127.0.0.1:1/p9', live: false, offset: 0, encoder: null } })
  })

  afterEach(() =>
  {
    engine = null
    vi.restoreAllMocks()
  })

  it('adds a site link through yt-dlp and plays its sound as before, with the picture failing over to the visualization', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'First', url: 'https://www.youtube.com/watch?v=v1', duration: 212 }, { id: 'v2', title: 'Second', url: 'https://www.youtube.com/watch?v=v2', duration: null }] })
    api.getStreamUrl.mockResolvedValue({ success: true, mediaUrl: 'http://127.0.0.1:1/s1', title: 'First', duration: 212 })
    const { container } = render(<Harness />)
    let outcome: Awaited<ReturnType<PlayerEngine['addLink']>> | null = null
    await act(async () =>
    {
      outcome = await current().addLink('https://www.youtube.com/playlist?list=x', 'site')
    })
    expect(outcome).toEqual({ ok: true, count: 2 })
    expect(api.resolvePlaylist).toHaveBeenCalledWith('https://www.youtube.com/playlist?list=x')
    await waitFor(() => expect(api.getStreamUrl).toHaveBeenCalledWith('https://www.youtube.com/watch?v=v1', 'best'))
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1'))
    await waitFor(() => expect(current().status).toBe('playing'))
    expect(current().tracks.map((track) => track.name)).toEqual(['First', 'Second'])
    expect(current().current?.videoUrl).toBe('https://www.youtube.com/watch?v=v1')
    expect(current().duration).toBe(212)
    await waitFor(() => expect(current().picture).toBe('failed'))
    expect(current().pictureNote).toContain('visualization shows instead')
    expect(api.getLinkPicture).toHaveBeenCalledWith('https://www.youtube.com/watch?v=v1', expect.any(Number), expect.arrayContaining(['avc1']))
    expect(current().problem).toBeNull()
  })

  it('shows the picture of a link when yt-dlp offers one', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Clip', url: 'https://youtu.be/v1', duration: 10 }] })
    api.getStreamUrl.mockResolvedValue({ success: true, mediaUrl: 'http://127.0.0.1:1/s1' })
    api.getLinkPicture.mockResolvedValue({ ok: true, link: { kind: 'dash', url: 'http://127.0.0.1:1/s2', width: 1280, height: 720, codec: 'avc1.4d401f', fps: 30, hasSound: false } })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://youtu.be/v1', 'site')
    })
    const video = container.querySelector('video') as HTMLVideoElement
    await waitFor(() => expect(video.getAttribute('src')).toBe('http://127.0.0.1:1/s2'))
    expect(video.muted).toBe(true)
    expect(current().canShowPicture).toBe(true)
    await act(async () =>
    {
      current().setView('visualization')
    })
    expect(current().picture).toBe('hidden')
    expect(video.hasAttribute('src')).toBe(false)
  })

  it('downloads a link\'s sound when the direct stream cannot be played, and says so', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Clip', url: 'https://youtu.be/v1', duration: 10 }] })
    api.getStreamUrl
      .mockResolvedValueOnce({ success: true, mediaUrl: 'http://127.0.0.1:1/s1' })
      .mockResolvedValueOnce({ success: true, mediaUrl: 'http://127.0.0.1:1/p7', downloaded: true })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://youtu.be/v1', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1'))
    Object.defineProperty(audio, 'error', { value: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }, configurable: true })
    await act(async () =>
    {
      audio.dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(api.getStreamUrl).toHaveBeenLastCalledWith('https://youtu.be/v1', 'best', { download: true }))
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/p7'))
    expect(current().soundNote).toContain('downloaded first')
    expect(current().problem).toBeNull()
  })

  it('downloads a link\'s video once when its direct picture stops playing', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Clip', url: 'https://youtu.be/v1', duration: 10 }] })
    api.getStreamUrl.mockResolvedValue({ success: true, mediaUrl: 'http://127.0.0.1:1/s1' })
    api.getLinkPicture
      .mockResolvedValueOnce({ ok: true, link: { kind: 'dash', url: 'http://127.0.0.1:1/s2', width: 1920, height: 1080, codec: 'avc1.640028', fps: 24, hasSound: false } })
      .mockResolvedValueOnce({ ok: true, link: { kind: 'download', url: 'http://127.0.0.1:1/p9', width: null, height: null, codec: 'h264', fps: null, hasSound: true } })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://youtu.be/v1', 'site')
    })
    const video = container.querySelector('video') as HTMLVideoElement
    await waitFor(() => expect(video.getAttribute('src')).toBe('http://127.0.0.1:1/s2'))
    Object.defineProperty(video, 'error', { value: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }, configurable: true })
    await act(async () =>
    {
      video.dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(api.getLinkPicture).toHaveBeenLastCalledWith('https://youtu.be/v1', expect.any(Number), expect.arrayContaining(['avc1']), { download: true }))
    await waitFor(() => expect(video.getAttribute('src')).toBe('http://127.0.0.1:1/p9'))
    expect(current().pictureNote).toContain('downloaded first')
    await act(async () =>
    {
      video.dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(current().picture).toBe('failed'))
    expect(api.getLinkPicture).toHaveBeenCalledTimes(2)
  })

  it('shows a download\'s progress for the current link', async () =>
  {
    let report: ((progress: { pageUrl: string, stage: 'resolving' | 'downloading', percent: number | null }) => void) | null = null
    api.onLinkProgress.mockImplementation((cb: typeof report) =>
    {
      report = cb
      return () => undefined
    })
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Clip', url: 'https://youtu.be/v1', duration: 10 }] })
    api.getStreamUrl.mockResolvedValue({ success: true, mediaUrl: 'http://127.0.0.1:1/s1' })
    api.getLinkPicture.mockImplementation(() => new Promise(() => undefined))
    render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://youtu.be/v1', 'site')
    })
    await waitFor(() => expect(current().pictureProgress).toBe('Getting the picture through yt-dlp…'))
    await act(async () =>
    {
      report?.({ pageUrl: 'https://youtu.be/v1', stage: 'downloading', percent: 43.2 })
    })
    expect(current().pictureProgress).toBe('Downloading the video · 43%')
    await act(async () =>
    {
      report?.({ pageUrl: 'https://youtu.be/other', stage: 'downloading', percent: 90 })
    })
    expect(current().pictureProgress).toBe('Downloading the video · 43%')
  })

  it('reports a yt-dlp failure in plain words and does not add anything', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: false, error: 'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', entries: [] })
    render(<Harness />)
    let outcome: Awaited<ReturnType<PlayerEngine['addLink']>> | null = null
    await act(async () =>
    {
      outcome = await current().addLink('https://youtu.be/abc', 'site')
    })
    expect(outcome).toEqual({ ok: false, problem: { message: 'This video is private, so it cannot be played.', detail: expect.stringContaining('Private video') } })
    expect(current().tracks).toHaveLength(0)
    api.resolvePlaylist.mockRejectedValue(new Error('spawn yt-dlp ENOENT'))
    await act(async () =>
    {
      outcome = await current().addLink('https://youtu.be/abc', 'site')
    })
    expect(outcome).toMatchObject({ ok: false, problem: { message: expect.stringContaining('yt-dlp is not ready') } })
  })

  it('moves on when a link track cannot be streamed, and stops with the problem on the last one', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'a', title: 'A', url: 'https://youtu.be/a' }, { id: 'b', title: 'B', url: 'https://youtu.be/b' }] })
    api.getStreamUrl
      .mockResolvedValueOnce({ success: false, error: 'ERROR: [youtube] a: Video unavailable' })
      .mockResolvedValueOnce({ success: true, mediaUrl: 'http://127.0.0.1:1/b' })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://www.youtube.com/playlist?list=y', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/b'))
    expect(current().current?.name).toBe('B')
    expect(current().problem?.message).toContain('unavailable')
  })

  it('adds a direct media address and plays it without yt-dlp', async () =>
  {
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://cdn.example.org/show/episode%201.mp3', 'file')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('https://cdn.example.org/show/episode%201.mp3'))
    expect(current().current?.name).toBe('episode 1.mp3')
    expect(api.getStreamUrl).not.toHaveBeenCalled()
  })

  it('plays a local file by its plan, starts the picture when the file has one, and probes the rest of the list', async () =>
  {
    api.inspectMedia.mockResolvedValue({ ok: true, media: mp4Probe })
    api.getSoundUrl.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:1/p1' })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/clips/a.mp4', 'C:/clips/notes.txt', 'C:/clips/b.mkv'])
    })
    expect(current().tracks.map((track) => track.name)).toEqual(['a.mp4', 'b.mkv'])
    await waitFor(() => expect(api.getSoundUrl).toHaveBeenCalledWith('C:/clips/a.mp4', 0, null, 'direct'))
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/p1'))
    await waitFor(() => expect(api.getPictureUrl).toHaveBeenCalledWith('C:/clips/a.mp4', 0, 'direct', 0, expect.objectContaining({ software: false })))
    await waitFor(() => expect(api.inspectMedia).toHaveBeenCalledWith('C:/clips/b.mkv'))
    expect(current().current?.media?.picture).toEqual({ route: 'direct', streamIndex: 0, reason: null })
    expect(current().canShowPicture).toBe(true)
  })

  it('explains a file that cannot be read and a file without sound', async () =>
  {
    api.inspectMedia.mockImplementation(async (path: string) => path.endsWith('broken.mkv')
      ? { ok: false, error: 'ffprobe exited with 1: Invalid data found when processing input' }
      : { ok: true, media: { ...mp4Probe, path, streams: [mp4Probe.streams[0]], sound: [] } })
    render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/clips/broken.mkv'])
    })
    await waitFor(() => expect(current().problem).not.toBeNull())
    expect(current().problem?.message).toContain('FFmpeg can read')
    await act(async () =>
    {
      current().addPaths(['C:/clips/silent.mp4'])
    })
    await waitFor(() => expect(current().problem?.message).toContain('no sound'))
  })

  it('keeps the playlist order through moves, drops, and removals, and clears everything', async () =>
  {
    api.inspectMedia.mockResolvedValue({ ok: true, media: mp4Probe })
    api.getSoundUrl.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:1/p1' })
    render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/m/a.mp3', 'C:/m/b.mp3', 'C:/m/c.mp3'])
    })
    const [a, b, c] = current().tracks.map((track) => track.id)
    await act(async () =>
    {
      current().moveIds([c], 'top')
    })
    expect(current().tracks.map((track) => track.id)).toEqual([c, a, b])
    await act(async () =>
    {
      current().dropIds([a], null)
    })
    expect(current().tracks.map((track) => track.id)).toEqual([c, b, a])
    await waitFor(() => expect(current().current?.id).toBe(a))
    await act(async () =>
    {
      current().removeIds([a])
    })
    expect(current().current).toBeNull()
    expect(current().status).toBe('idle')
    await act(async () =>
    {
      current().clear()
    })
    expect(current().tracks).toHaveLength(0)
  })

  it('plays a live link through one FFmpeg session: the picture first, then the sound, Live, and no seeking', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'L1', title: 'Lofi radio', url: 'https://www.youtube.com/watch?v=L1', duration: null }] })
    api.getStreamUrl.mockResolvedValue({ success: true, streamed: true, live: true, title: 'Lofi radio', duration: null })
    api.getLinkStream.mockImplementation(async (_url: string, request: { sound: boolean, picture: boolean }) => ({
      ok: true,
      stream: {
        live: true,
        sound: request.sound ? `http://127.0.0.1:1/s${api.getLinkStream.mock.calls.length}` : null,
        picture: request.picture ? { url: `http://127.0.0.1:1/p${api.getLinkStream.mock.calls.length}`, live: true, offset: 0, encoder: null, shared: true } : null,
        hasPicture: true,
        duration: null
      }
    }))
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://www.youtube.com/watch?v=L1', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    const video = container.querySelector('video') as HTMLVideoElement
    await waitFor(() => expect(video.getAttribute('src')).toBe('http://127.0.0.1:1/p1'))
    expect(api.getLinkStream).toHaveBeenCalledWith('https://www.youtube.com/watch?v=L1', expect.objectContaining({ at: null, sound: true, picture: true, soundQuality: 'best', codecs: expect.arrayContaining(['avc1']) }))
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    await act(async () =>
    {
      video.dispatchEvent(new Event('canplay'))
    })
    await waitFor(() => expect(current().status).toBe('playing'))
    expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1')
    expect(current().live).toBe(true)
    expect(current().current?.live).toBe(true)
    expect(current().duration).toBe(0)
    expect(api.getLinkPicture).not.toHaveBeenCalled()
    const clock = { time: 0, ready: 0 }
    Object.defineProperty(audio, 'currentTime', { get: () => clock.time, set: (value: number) => { clock.time = value }, configurable: true })
    Object.defineProperty(audio, 'readyState', { get: () => clock.ready, configurable: true })
    Object.defineProperty(audio, 'paused', { value: false, configurable: true })
    const tick = async (time: number, ready = 4): Promise<void> =>
    {
      clock.time = time
      clock.ready = ready
      await act(async () =>
      {
        audio.dispatchEvent(new Event('timeupdate'))
      })
    }
    await tick(0, 0)
    await tick(7662.5)
    expect(current().time).toBe(0)
    await tick(7672.5)
    await act(async () =>
    {
      current().seek(30)
      current().seekBy(5)
    })
    expect(current().time).toBe(10)
    expect(api.getLinkStream).toHaveBeenCalledTimes(1)
    for (let round = 0; round < 2; round++)
    {
      await act(async () =>
      {
        current().setView('visualization')
      })
      expect(video.hasAttribute('src')).toBe(false)
      await tick(7680 + round * 20)
      await act(async () =>
      {
        current().setView('video')
      })
      await waitFor(() => expect(api.getLinkStream).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=L1', expect.objectContaining({ at: 7680 + round * 20 + PICTURE_JOIN_LEAD, sound: false, picture: true })))
      await waitFor(() => expect(video.getAttribute('src')).toBe(`http://127.0.0.1:1/p${round + 2}`))
      await tick(7690 + round * 20)
      expect(current().time).toBe(7690 + round * 20 - 7662.5)
    }
    expect(api.getLinkStream).toHaveBeenCalledTimes(3)
    expect(api.getLinkStream.mock.calls.filter(([, request]) => request.sound)).toHaveLength(1)
    expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1')
    expect(current().live).toBe(true)
    expect(current().duration).toBe(0)
  })

  it('keeps one clock for an HLS-only recording across the Show switch, and seeking still works after it', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Talk', url: 'https://vimeo.example/2' }] })
    api.getStreamUrl.mockResolvedValue({ success: true, streamed: true, live: false, duration: 300 })
    api.getLinkStream.mockImplementation(async (_url: string, request: { sound: boolean, picture: boolean }) => ({
      ok: true,
      stream: {
        live: false,
        sound: request.sound ? `http://127.0.0.1:1/s${api.getLinkStream.mock.calls.length}` : null,
        picture: request.picture ? { url: `http://127.0.0.1:1/p${api.getLinkStream.mock.calls.length}`, live: true, offset: 0, encoder: null, shared: true } : null,
        hasPicture: true,
        duration: 300
      }
    }))
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://vimeo.example/2', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    const video = container.querySelector('video') as HTMLVideoElement
    await waitFor(() => expect(video.getAttribute('src')).toBe('http://127.0.0.1:1/p1'))
    await act(async () =>
    {
      video.dispatchEvent(new Event('canplay'))
    })
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1'))
    const clock = { time: 0, ready: 4 }
    Object.defineProperty(audio, 'currentTime', { get: () => clock.time, set: (value: number) => { clock.time = value }, configurable: true })
    Object.defineProperty(audio, 'readyState', { get: () => clock.ready, configurable: true })
    const tick = async (time: number): Promise<void> =>
    {
      clock.time = time
      await act(async () =>
      {
        audio.dispatchEvent(new Event('timeupdate'))
      })
    }
    await tick(41.5)
    for (const view of ['visualization', 'video', 'visualization', 'video'] as const)
    {
      await act(async () =>
      {
        current().setView(view)
      })
      await tick(clock.time + 2)
      expect(current().time).toBe(clock.time)
      expect(current().duration).toBe(300)
    }
    expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1')
    expect(api.getLinkStream.mock.calls.filter(([, request]) => request.sound)).toHaveLength(1)
    let opened: (value: unknown) => void = () => undefined
    api.getLinkStream.mockImplementationOnce(() => new Promise((resolve) => { opened = resolve }))
    await act(async () =>
    {
      current().seek(200)
    })
    expect(current().time).toBe(200)
    await tick(49.5)
    expect(current().time).toBe(200)
    expect(api.getLinkStream).toHaveBeenLastCalledWith('https://vimeo.example/2', expect.objectContaining({ at: 200, sound: true, picture: true }))
    await act(async () =>
    {
      opened({ ok: true, stream: { live: false, sound: 'http://127.0.0.1:1/seek', picture: null, hasPicture: true, duration: 300 } })
    })
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/seek'))
    await tick(200.2)
    expect(current().time).toBe(200.2)
    expect(current().duration).toBe(300)
  })

  it('keeps a direct link\'s sound and length across the Show switch, and seeks it in place after', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Bunny', url: 'https://youtu.be/b', duration: 634 }] })
    api.getStreamUrl.mockResolvedValue({ success: true, mediaUrl: 'http://127.0.0.1:1/s1', duration: 634 })
    api.getLinkPicture.mockResolvedValue({ ok: true, link: { kind: 'dash', url: 'http://127.0.0.1:1/v', width: 1920, height: 1080, codec: 'avc1.640028', fps: 24, hasSound: false } })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://youtu.be/b', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(current().status).toBe('playing'))
    const clock = { time: 0 }
    Object.defineProperty(audio, 'currentTime', { get: () => clock.time, set: (value: number) => { clock.time = value }, configurable: true })
    for (const view of ['visualization', 'video', 'visualization', 'video'] as const)
    {
      await act(async () =>
      {
        current().setView(view)
      })
      clock.time += 3
      await act(async () =>
      {
        audio.dispatchEvent(new Event('timeupdate'))
      })
      expect(current().time).toBe(clock.time)
      expect(current().duration).toBe(634)
    }
    expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1')
    expect(api.getStreamUrl).toHaveBeenCalledTimes(1)
    await act(async () =>
    {
      current().seek(317)
    })
    expect(clock.time).toBe(317)
    expect(current().time).toBe(317)
  })

  it('never shows the last time of the track it left while the next one loads', async () =>
  {
    api.inspectMedia.mockResolvedValue({ ok: true, media: mp4Probe })
    api.getSoundUrl.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:1/p1' })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/m/a.mp3', 'C:/m/b.mp3'])
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/p1'))
    Object.defineProperty(audio, 'currentTime', { value: 95, configurable: true, writable: true })
    let release: (value: unknown) => void = () => undefined
    api.getSoundUrl.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    await act(async () =>
    {
      current().next()
    })
    await act(async () =>
    {
      audio.dispatchEvent(new Event('timeupdate'))
    })
    expect(current().time).toBe(0)
    await act(async () =>
    {
      release({ ok: true, url: 'http://127.0.0.1:1/p2' })
    })
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/p2'))
  })

  it('retries a live stream that stops once with a fresh reading, then says so in plain words', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'L1', title: 'Lofi radio', url: 'https://www.youtube.com/watch?v=L1' }] })
    api.getStreamUrl.mockResolvedValue({ success: true, streamed: true, live: true })
    api.getLinkStream.mockResolvedValue({ ok: true, stream: { live: true, sound: 'http://127.0.0.1:1/s', picture: null, hasPicture: false, duration: null } })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://www.youtube.com/watch?v=L1', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(current().status).toBe('playing'))
    expect(current().picture).toBe('none')
    Object.defineProperty(audio, 'error', { value: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }, configurable: true })
    await act(async () =>
    {
      audio.dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(api.getLinkStream).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=L1', expect.objectContaining({ fresh: true, at: null })))
    await act(async () =>
    {
      audio.dispatchEvent(new Event('error'))
    })
    await waitFor(() => expect(current().problem?.message).toContain('This live stream could not be played'))
    expect(api.getStreamUrl).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), { download: true })
  })

  it('says a live stream that cannot start could not be played, without downloading', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'L1', title: 'News', url: 'https://news.example/live' }] })
    api.getStreamUrl.mockResolvedValue({ success: true, streamed: true, live: true })
    api.getLinkStream.mockResolvedValue({ ok: false, error: 'HTTP error 403 Forbidden' })
    render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://news.example/live', 'site')
    })
    await waitFor(() => expect(current().problem).toEqual({ message: expect.stringContaining('This live stream could not be played'), detail: 'HTTP error 403 Forbidden' }))
    expect(current().status).toBe('paused')
    expect(api.getStreamUrl).toHaveBeenCalledTimes(1)
  })

  it('streams an HLS-only recording, seeks by restarting the stream, and falls back to the download', async () =>
  {
    api.resolvePlaylist.mockResolvedValue({ success: true, entries: [{ id: 'v1', title: 'Talk', url: 'https://vimeo.example/1' }] })
    api.getStreamUrl
      .mockResolvedValueOnce({ success: true, streamed: true, live: false, duration: 300 })
      .mockResolvedValueOnce({ success: true, mediaUrl: 'http://127.0.0.1:1/file', downloaded: true })
    api.getLinkStream
      .mockResolvedValueOnce({ ok: true, stream: { live: false, sound: 'http://127.0.0.1:1/s1', picture: null, hasPicture: false, duration: 300 } })
      .mockResolvedValueOnce({ ok: true, stream: { live: false, sound: 'http://127.0.0.1:1/s2', picture: null, hasPicture: false, duration: 300 } })
      .mockResolvedValueOnce({ ok: false, error: 'HTTP error 410' })
    const { container } = render(<Harness />)
    await act(async () =>
    {
      await current().addLink('https://vimeo.example/1', 'site')
    })
    const audio = container.querySelector('audio') as HTMLAudioElement
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s1'))
    expect(current().duration).toBe(300)
    expect(current().live).toBe(false)
    await act(async () =>
    {
      current().seek(500)
    })
    await waitFor(() => expect(api.getLinkStream).toHaveBeenLastCalledWith('https://vimeo.example/1', expect.objectContaining({ at: 299, sound: true })))
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/s2'))
    expect(current().time).toBe(299)
    await act(async () =>
    {
      current().seek(120)
    })
    await waitFor(() => expect(api.getStreamUrl).toHaveBeenLastCalledWith('https://vimeo.example/1', 'best', { download: true }))
    await waitFor(() => expect(audio.getAttribute('src')).toBe('http://127.0.0.1:1/file'))
    expect(current().soundNote).toContain('downloaded first')
  })

  it('draws a picture subtitle on the decode route, and returns to the cheapest route without it', async () =>
  {
    const subtitled = {
      ...mp4Probe,
      path: 'C:/clips/s.mkv',
      container: 'matroska,webm',
      streams: [
        mp4Probe.streams[0],
        mp4Probe.streams[1],
        { ...mp4Probe.streams[1], index: 2, kind: 'subtitle', codec: 'hdmv_pgs_subtitle', width: 1920, height: 1080, channels: null, sampleRate: null, layout: null },
        { ...mp4Probe.streams[1], index: 3, kind: 'subtitle', codec: 'subrip', width: null, height: null, channels: null, sampleRate: null, layout: null }
      ]
    }
    api.inspectMedia.mockResolvedValue({ ok: true, media: subtitled })
    api.getSoundUrl.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:1/p1' })
    api.getPictureUrl.mockResolvedValue({ ok: true, picture: { url: 'http://127.0.0.1:1/v', live: false, offset: 0, encoder: null } })
    render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/clips/s.mkv'])
    })
    await waitFor(() => expect(api.getPictureUrl).toHaveBeenCalledWith('C:/clips/s.mkv', 0, 'direct', 0, expect.objectContaining({ subtitle: null })))
    await act(async () =>
    {
      current().selectSubtitles(2)
    })
    await waitFor(() => expect(api.getPictureUrl).toHaveBeenLastCalledWith('C:/clips/s.mkv', 0, 'convert', 0, expect.objectContaining({ subtitle: { streamIndex: 2, scaleTo: { width: 1280, height: 720 } } })))
    expect(api.getSubtitles).not.toHaveBeenCalled()
    const calls = api.getPictureUrl.mock.calls.length
    await act(async () =>
    {
      current().selectSubtitles(3)
    })
    await waitFor(() => expect(api.getSubtitles).toHaveBeenCalledWith('C:/clips/s.mkv', 3))
    expect(api.getPictureUrl.mock.calls.length).toBe(calls + 1)
    expect(api.getPictureUrl).toHaveBeenLastCalledWith('C:/clips/s.mkv', 0, 'direct', 0, expect.objectContaining({ subtitle: null }))
    await act(async () =>
    {
      current().selectSubtitles(null)
    })
    expect(api.getPictureUrl.mock.calls.length).toBe(calls + 1)
  })

  it('carries its state to the pop-out and reads it back', async () =>
  {
    api.inspectMedia.mockResolvedValue({ ok: true, media: mp4Probe })
    api.getSoundUrl.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:1/p1' })
    render(<Harness />)
    await act(async () =>
    {
      current().addPaths(['C:/m/a.mp3'])
      current().setVolume(0.4)
      current().toggleShuffle()
      current().cycleRepeat()
      current().setVisMode('rain')
    })
    await waitFor(() => expect(current().current).not.toBeNull())
    const snapshot = current().snapshot()
    expect(snapshot).toMatchObject({ currentId: current().tracks[0].id, volume: 0.4, shuffle: true, repeat: 'all', visMode: 'rain', soundQuality: 'best', pictureQuality: 'auto' })
    expect(snapshot.playlist[0].src).toBe('')
    await act(async () =>
    {
      current().popOut()
    })
    expect(api.popoutPlayer).toHaveBeenCalledWith(expect.objectContaining({ visMode: 'rain' }))
    expect(current().poppedOut).toBe(true)
  })
})
