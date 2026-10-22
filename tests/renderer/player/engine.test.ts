import { describe, it, expect, vi } from 'vitest'
import type { PlayerMedia, PlayerStream } from '../../../src/shared/player/media'
import { checkLink, describeLinkError, foundSentence, LINK_REASONS, lookupSentence, pictureHeightFor } from '@renderer/components/player/engine/links'
import { afterEnd, dropTracks, moveTracks, nextRepeat, reorderTracks, stepTrack } from '@renderer/components/player/engine/queue'
import { cueTextAt, parseVtt, parseVttTime, plainCueText } from '@renderer/components/player/engine/vtt'
import { portableTracks, readSnapshot } from '@renderer/components/player/engine/snapshot'
import { codecQueryFor, depthOf, pictureVerdict } from '@renderer/components/player/engine/decode'
import { PictureFollower, START_LEAD, SYNC_LIMITS, syncAction, whenPlayable } from '@renderer/components/player/engine/sync'
import { audioTrackName, channelWords, containerName, decodeNote, encoderName, languageName, mediaInfo, pictureLine, pictureRouteSentence, routeName, soundLine, soundRouteSentence, subtitleTrackName, trackFacts } from '@renderer/components/player/engine/describe'
import { keyTargetOf, PLAYER_SHORTCUTS, playerKeyCommand } from '@renderer/components/player/hooks/usePlayerKeys'
import { fileNameOf, formatTime, isMediaPath, totalDuration, trackFromAddress, trackFromPath, type Track } from '@renderer/components/player/types'

function stream(over: Partial<PlayerStream>): PlayerStream
{
  return {
    index: 0, kind: 'video', codec: 'h264', profile: 'High', level: 40, language: null, title: null, isDefault: true, bitRate: 5_000_000,
    sampleRate: null, channels: null, layout: null, bitDepth: null, width: 1920, height: 1080, frameRate: 29.97, pixelFormat: 'yuv420p',
    colorTransfer: null, colorPrimaries: null, colorSpace: null, hdr: null, ...over
  }
}

const video = stream({})
const english = stream({ index: 1, kind: 'audio', codec: 'aac', language: 'eng', title: 'English', channels: 2, layout: 'stereo', sampleRate: 48000, bitRate: 160_000, width: null, height: null, frameRate: null, pixelFormat: null })
const german = stream({ index: 2, kind: 'audio', codec: 'ac3', language: 'ger', title: null, channels: 6, layout: '5.1(side)', sampleRate: 48000, bitRate: 384_000, width: null, height: null, frameRate: null, pixelFormat: null, isDefault: false })
const subs = stream({ index: 3, kind: 'subtitle', codec: 'subrip', language: 'eng', width: null, height: null, frameRate: null, pixelFormat: null, isDefault: false })

const media: PlayerMedia = {
  path: 'C:/clips/Two tracks.mkv',
  container: 'matroska,webm',
  containerName: 'Matroska / WebM',
  duration: 95.5,
  startTime: 0,
  bitRate: 6_000_000,
  size: 71_625_000,
  streams: [video, english, german, subs],
  picture: { route: 'direct', streamIndex: 0, reason: null },
  sound: [
    { route: 'remux', audioIndex: 0, streamIndex: 1, target: null, remappedTo: null },
    { route: 'convert', audioIndex: 1, streamIndex: 2, target: 'opus', remappedTo: '5.1' }
  ]
}

const tracks: Track[] = [
  { id: 'a', name: 'a.mp3', src: '', isBlob: false, filePath: 'C:/m/a.mp3', duration: 60 },
  { id: 'b', name: 'b.mp3', src: '', isBlob: false, filePath: 'C:/m/b.mp3', duration: 120 },
  { id: 'c', name: 'c.mp3', src: '', isBlob: false, filePath: 'C:/m/c.mp3' },
  { id: 'd', name: 'd.mp3', src: '', isBlob: false, filePath: 'C:/m/d.mp3', duration: 30 }
]

describe('links', () =>
{
  it('checks a pasted address and tells a site link from a media address', () =>
  {
    expect(checkLink('')).toEqual({ ok: false, reason: LINK_REASONS.empty })
    expect(checkLink('ftp://host/a.mp3')).toEqual({ ok: false, reason: LINK_REASONS.notWeb })
    expect(checkLink('nonsense')).toEqual({ ok: false, reason: LINK_REASONS.incomplete })
    expect(checkLink('http://[::1')).toEqual({ ok: false, reason: LINK_REASONS.incomplete })
    expect(checkLink('youtu.be/abc123')).toEqual({ ok: true, url: 'https://youtu.be/abc123', kind: 'site' })
    expect(checkLink(' https://www.youtube.com/watch?v=abc ')).toMatchObject({ ok: true, kind: 'site' })
    expect(checkLink('https://example.com/music/track%20one.flac?x=1')).toMatchObject({ ok: true, kind: 'file' })
    expect(checkLink('https://example.com/page.html')).toMatchObject({ ok: true, kind: 'site' })
  })

  it('turns yt-dlp errors into plain words with the way out and keeps the tool\'s line', () =>
  {
    const unavailable = describeLinkError('ERROR: [youtube] dQw4w9WgXcQ: Video unavailable')
    expect(unavailable.message).toContain('unavailable')
    expect(unavailable.detail).toBe('Video unavailable')
    expect(describeLinkError('ERROR: Unsupported URL: https://x').message).toContain('cannot read this site')
    expect(describeLinkError('Sign in to confirm you’re not a bot').message).toContain('Settings')
    expect(describeLinkError('HTTP Error 429: Too Many Requests').message).toContain('limiting requests')
    expect(describeLinkError('getaddrinfo ENOTFOUND www.youtube.com').message).toContain('internet connection')
    expect(describeLinkError('spawn yt-dlp ENOENT').message).toContain('yt-dlp is not ready')
    expect(describeLinkError('no entries').message).toContain('no tracks')
    expect(describeLinkError('')).toEqual({ message: expect.stringContaining('could not read this link'), detail: null })
    expect(describeLinkError(undefined).detail).toBeNull()
    expect(describeLinkError('WARNING: something\nERROR: [generic] x: Premieres in 3 hours').detail).toBe('Premieres in 3 hours')
    expect(describeLinkError('A live stream cannot be downloaded').message).toContain('This live stream could not be played')
    expect(describeLinkError('No sound format the player can stream').message).toBe('The link offers no format the player can play.')
  })

  it('names a live link, and says a picture subtitle is one', () =>
  {
    const base = { id: 'l', name: 'Live', src: '', isBlob: false }
    expect(trackFacts({ ...base, videoUrl: 'https://www.youtube.com/watch?v=L1', live: true })).toBe('YouTube live stream')
    expect(trackFacts({ ...base, videoUrl: 'https://news.example/live', live: true })).toBe('Live stream from news.example')
    expect(trackFacts({ ...base, videoUrl: 'https://news.example/live' })).toBe('Link from news.example')
    expect(subtitleTrackName(stream({ index: 4, kind: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' }), 0)).toBe('English, picture')
    expect(subtitleTrackName(stream({ index: 5, kind: 'subtitle', codec: 'dvd_subtitle', language: null, title: 'Commentary' }), 1)).toBe('Commentary, picture')
  })

  it('words the lookup and the result', () =>
  {
    expect(foundSentence(1)).toBe('Found 1 track.')
    expect(foundSentence(1200)).toBe('Found 1,200 tracks.')
    expect(lookupSentence(1)).toBe('Reading the link with yt-dlp…')
    expect(lookupSentence(7.8)).toContain('(7 s)')
  })

  it('caps a link\'s picture at the chosen height, or at the screen for Auto', () =>
  {
    expect(pictureHeightFor('720p', 2160)).toBe(720)
    expect(pictureHeightFor('480p', 2160)).toBe(480)
    expect(pictureHeightFor('1080p', 720)).toBe(1080)
    expect(pictureHeightFor('auto', 1440)).toBe(1440)
    expect(pictureHeightFor('auto', 1200)).toBe(1080)
    expect(pictureHeightFor('auto', 300)).toBe(480)
  })
})

describe('queue', () =>
{
  const ids = ['a', 'b', 'c', 'd']

  it('steps in order, wraps, and shuffles to another track', () =>
  {
    expect(stepTrack([], null, 1, false)).toBeNull()
    expect(stepTrack(ids, null, 1, false)).toBe('a')
    expect(stepTrack(ids, null, -1, false)).toBe('d')
    expect(stepTrack(ids, 'd', 1, false)).toBe('a')
    expect(stepTrack(ids, 'a', -1, false)).toBe('d')
    expect(stepTrack(ids, 'b', 1, true, () => 0)).toBe('a')
    expect(stepTrack(ids, 'b', 1, true, () => 0.99)).toBe('d')
    expect(stepTrack(['only'], 'only', 1, true)).toBe('only')
  })

  it('decides what plays after a track ends', () =>
  {
    expect(afterEnd(ids, null, 'all', false)).toBeNull()
    expect(afterEnd(ids, 'b', 'one', false)).toBe('b')
    expect(afterEnd(ids, 'b', 'off', false)).toBe('c')
    expect(afterEnd(ids, 'd', 'off', false)).toBeNull()
    expect(afterEnd(ids, 'd', 'all', false)).toBe('a')
    expect(afterEnd(ids, 'd', 'off', true, () => 0)).toBe('a')
    expect(nextRepeat('off')).toBe('all')
    expect(nextRepeat('all')).toBe('one')
    expect(nextRepeat('one')).toBe('off')
  })

  it('reorders by the grid moves and by pointer drops', () =>
  {
    expect(moveTracks(tracks, ['c'], 'up').map((t) => t.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveTracks(tracks, ['a', 'b'], 'bottom').map((t) => t.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(dropTracks(tracks, ['d'], 'a').map((t) => t.id)).toEqual(['d', 'a', 'b', 'c'])
    expect(dropTracks(tracks, ['a', 'c'], null).map((t) => t.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(dropTracks(tracks, ['a'], 'missing').map((t) => t.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(reorderTracks(tracks, ['d', 'zzz', 'a']).map((t) => t.id)).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('subtitles', () =>
{
  const vtt = 'WEBVTT\n\n00:01.000 --> 00:04.000\nFirst <i>line</i>\n\n2\n00:05.000 --> 00:09.000 align:start\nSecond\nline\n\nbroken\n\n01:00:12.000 --> 01:00:16.000\nLate &amp; last\n'

  it('reads times and cue text', () =>
  {
    expect(parseVttTime('01:02:03.456')).toBeCloseTo(3723.456)
    expect(parseVttTime('02:03.4')).toBeCloseTo(123.4)
    expect(parseVttTime('nope')).toBeNull()
    expect(plainCueText('<v Bob>Hello <b>there</b>&nbsp;&lt;3</v>\n\n ')).toBe('Hello there <3')
  })

  it('parses cues in order and finds the ones showing at a moment', () =>
  {
    const cues = parseVtt(vtt)
    expect(cues.map((cue) => cue.text)).toEqual(['First line', 'Second\nline', 'Late & last'])
    expect(cueTextAt(cues, 0.5)).toBe('')
    expect(cueTextAt(cues, 2)).toBe('First line')
    expect(cueTextAt(cues, 6)).toBe('Second\nline')
    expect(cueTextAt(cues, 3613)).toBe('Late & last')
    expect(cueTextAt(cues, 3617)).toBe('')
    expect(cueTextAt(parseVtt(''), 1)).toBe('')
  })
})

describe('snapshots', () =>
{
  it('clears per-process URLs and reads old and new shapes', () =>
  {
    const portable = portableTracks([{ id: 'x', name: 'x', src: 'blob:1', isBlob: true }, { id: 'y', name: 'y', src: 'https://host/y.mp3', isBlob: false }, { id: 'z', name: 'z', src: 'http://127.0.0.1/p1', isBlob: false, filePath: 'C:/z.wav' }])
    expect(portable.map((t) => t.src)).toEqual(['', 'https://host/y.mp3', ''])
    expect(readSnapshot(null)).toBeNull()
    expect(readSnapshot({ playlist: 'no' })).toBeNull()
    const legacy = readSnapshot({ playlist: [{ id: 'a', name: 'a', src: '', isBlob: false }, { id: 'b', name: 'b', src: '', isBlob: false }], trackIdx: 1, currentTime: 12, volume: 2, audioQuality: 'good', repeat: 'all', playing: false })
    expect(legacy).toMatchObject({ currentId: 'b', currentTime: 12, volume: 1, soundQuality: 'good', repeat: 'all', playing: false, view: 'video', pictureQuality: 'auto', subtitleIndex: null })
    const fresh = readSnapshot({ playlist: [{ id: 'a', name: 'a', src: '', isBlob: false }], currentId: 'a', view: 'visualization', visMode: 'rain', pictureQuality: '720p', subtitleIndex: 3, muted: true })
    expect(fresh).toMatchObject({ currentId: 'a', view: 'visualization', visMode: 'rain', pictureQuality: '720p', subtitleIndex: 3, muted: true, playing: true })
    expect(readSnapshot({ playlist: [], currentId: 'gone', visMode: 'nope' })).toMatchObject({ currentId: null, visMode: 'dmt' })
  })
})

describe('decoder questions', () =>
{
  it('builds exact codec strings from the probe', () =>
  {
    expect(codecQueryFor(video)?.contentType).toBe('video/mp4; codecs="avc1.640028"')
    expect(codecQueryFor(stream({ profile: 'Constrained Baseline', level: 31 }))?.contentType).toBe('video/mp4; codecs="avc1.42E01F"')
    expect(codecQueryFor(stream({ codec: 'hevc', profile: 'Main 10', level: 120, pixelFormat: 'yuv420p10le' }))?.contentType).toBe('video/mp4; codecs="hvc1.2.4.L120.B0"')
    expect(codecQueryFor(stream({ codec: 'hevc', profile: null, level: null, pixelFormat: 'yuv420p' }))?.contentType).toBe('video/mp4; codecs="hvc1.1.6.L120.B0"')
    expect(codecQueryFor(stream({ codec: 'vp9', profile: 'Profile 2', pixelFormat: 'yuv420p10le', height: 2160 }))?.contentType).toBe('video/mp4; codecs="vp09.02.51.10"')
    expect(codecQueryFor(stream({ codec: 'vp8' }))?.contentType).toBe('video/webm; codecs="vp8"')
    expect(codecQueryFor(stream({ codec: 'av1', profile: 'Main', level: 8, pixelFormat: 'yuv420p' }))?.contentType).toBe('video/mp4; codecs="av01.0.08M.08"')
    expect(codecQueryFor(stream({ codec: 'mpeg2video' }))).toBeNull()
    expect(depthOf({ bitDepth: 10, pixelFormat: null })).toBe(10)
    expect(depthOf({ bitDepth: null, pixelFormat: 'yuv422p12le' })).toBe(12)
    expect(depthOf({ bitDepth: null, pixelFormat: null })).toBe(8)
  })

  it('answers no decoder, not here, or decodes from the decoder\'s answer', async () =>
  {
    const ask = vi.fn(async (question: { contentType: string }) => question.contentType.includes('avc1'))
    expect(await pictureVerdict(stream({ codec: 'mpeg2video' }), ask)).toBe('no-decoder')
    expect(ask).not.toHaveBeenCalled()
    expect(await pictureVerdict(video, ask)).toBe('decodes')
    expect(ask).toHaveBeenLastCalledWith({ contentType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, framerate: 29.97, bitrate: 5_000_000 })
    expect(await pictureVerdict(stream({ codec: 'hevc', width: null, height: null, frameRate: null, bitRate: null }), ask)).toBe('not-here')
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1920, height: 1080, framerate: 30, bitrate: 8_000_000 }))
  })
})

describe('picture sync', () =>
{
  it('nudges the rate inside the limits, seeks a seekable picture, and restarts or holds a live one', () =>
  {
    expect(syncAction({ master: 10, picture: 10.01, playing: true, live: false, rate: 1 })).toEqual({ kind: 'rate', rate: 1 })
    const slowed = syncAction({ master: 10, picture: 10.1, playing: true, live: false, rate: 1 })
    expect(slowed.kind === 'rate' && slowed.rate).toBeCloseTo(1 - 0.1 * SYNC_LIMITS.gain, 6)
    expect(syncAction({ master: 10, picture: 10.3, playing: true, live: false, rate: 1 })).toEqual({ kind: 'rate', rate: 1 - SYNC_LIMITS.maxNudge })
    const hurried = syncAction({ master: 10, picture: 9.9, playing: true, live: false, rate: 2 })
    expect(hurried.kind === 'rate' && hurried.rate).toBeCloseTo(2 * (1 + 0.1 * SYNC_LIMITS.gain), 6)
    expect(syncAction({ master: 10, picture: 9.5, playing: true, live: false, rate: 1 })).toEqual({ kind: 'rate', rate: 1 + SYNC_LIMITS.maxNudge })
    expect(syncAction({ master: 10, picture: 12, playing: true, live: false, rate: 1 })).toEqual({ kind: 'seek', to: 10 })
    expect(syncAction({ master: 10, picture: 10.4, playing: true, live: true, rate: 1 })).toEqual({ kind: 'hold' })
    expect(syncAction({ master: 10, picture: 13, playing: true, live: true, rate: 1 })).toEqual({ kind: 'restart', at: 10 })
    expect(syncAction({ master: 10, picture: 8, playing: true, live: true, rate: 1 })).toEqual({ kind: 'restart', at: 10 })
    expect(syncAction({ master: 10, picture: 9.8, playing: true, live: true, rate: 1 })).toEqual({ kind: 'rate', rate: 1 + SYNC_LIMITS.maxNudge })
  })

  it('holds a picture on the sound\'s own clock that arrives ahead, and restarts one that falls behind', () =>
  {
    expect(syncAction({ master: 100, picture: 103, playing: true, live: true, rate: 1, shared: true })).toEqual({ kind: 'hold' })
    expect(syncAction({ master: 100, picture: 100 + SYNC_LIMITS.sharedHold, playing: true, live: true, rate: 1, shared: true })).toEqual({ kind: 'hold' })
    expect(syncAction({ master: 100, picture: 109, playing: true, live: true, rate: 1, shared: true })).toEqual({ kind: 'restart', at: 100 })
    expect(syncAction({ master: 100, picture: 98, playing: true, live: true, rate: 1, shared: true })).toEqual({ kind: 'restart', at: 100 })
    expect(syncAction({ master: 100, picture: 100.02, playing: true, live: true, rate: 1, shared: true })).toEqual({ kind: 'rate', rate: 1 })
    expect(syncAction({ master: 100, picture: 103, playing: true, live: true, rate: 1 })).toEqual({ kind: 'restart', at: 100 })
  })

  it('follows the clock: loads, seeks, restarts a live picture ahead of the clock, and clears', () =>
  {
    const video = document.createElement('video')
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined)
    vi.spyOn(video, 'load').mockImplementation(() => undefined)
    Object.defineProperty(video, 'readyState', { value: 3, configurable: true })
    Object.defineProperty(video, 'paused', { get: () => pausedNow, configurable: true })
    let pausedNow = true
    let time = 0
    Object.defineProperty(video, 'currentTime', { get: () => time, set: (value: number) => { time = value }, configurable: true })
    const clock = { time: () => 20, playing: () => true, rate: () => 1 }
    const restart = vi.fn()
    const follower = new PictureFollower(video, clock, restart)
    follower.load({ url: 'http://x/p1', live: false, offset: 0 })
    expect(video.getAttribute('src')).toBe('http://x/p1')
    time = 20
    follower.follow()
    expect(play).toHaveBeenCalled()
    pausedNow = false
    follower.seekTo(50)
    expect(time).toBe(50)
    follower.load({ url: 'http://x/l1', live: true, offset: 20 })
    time = 0
    follower.follow()
    expect(restart).not.toHaveBeenCalled()
    follower.seekTo(5)
    expect(restart).toHaveBeenCalledWith(5 + START_LEAD.initial)
    follower.clear()
    expect(pause).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(follower.current()).toBeNull()
    follower.dispose()
  })

  it('reads a stream picture on the sound\'s own clock, with no lead taken off its first frame', () =>
  {
    const video = document.createElement('video')
    vi.spyOn(video, 'play').mockResolvedValue(undefined)
    vi.spyOn(video, 'pause').mockImplementation(() => undefined)
    vi.spyOn(video, 'load').mockImplementation(() => undefined)
    Object.defineProperty(video, 'buffered', { value: { length: 1, start: () => 7662.564, end: () => 7664 }, configurable: true })
    Object.defineProperty(video, 'currentTime', { value: 7662.6, configurable: true, writable: true })
    const follower = new PictureFollower(video, { time: () => 7662.6, playing: () => false, rate: () => 1 }, vi.fn())
    follower.load({ url: 'http://x/m2', live: true, offset: 0, shared: true })
    video.dispatchEvent(new Event('loadeddata'))
    expect(follower.pictureTime()).toBeCloseTo(7662.6, 6)
    follower.load({ url: 'http://x/l2', live: true, offset: 12 })
    video.dispatchEvent(new Event('loadeddata'))
    expect(follower.pictureTime()).toBeCloseTo(7662.6 - 7662.564 + 12, 6)
    follower.dispose()
  })

  it('waits for a picture to be playable, its failure, or the time limit', async () =>
  {
    vi.useFakeTimers()
    try
    {
      const video = document.createElement('video')
      let ready: boolean | null = null
      const waiting = whenPlayable(video, 1000).then((playable) => { ready = playable })
      await vi.advanceTimersByTimeAsync(10)
      expect(ready).toBeNull()
      video.dispatchEvent(new Event('canplay'))
      await waiting
      expect(ready).toBe(true)
      const failed = whenPlayable(video, 1000)
      video.dispatchEvent(new Event('error'))
      expect(await failed).toBe(false)
      const late = whenPlayable(video, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await late).toBe(false)
      Object.defineProperty(video, 'readyState', { value: 4, configurable: true })
      expect(await whenPlayable(video, 1000)).toBe(true)
    }
    finally
    {
      vi.useRealTimers()
    }
  })
})

describe('describing media', () =>
{
  it('names containers, channels, languages, and lines', () =>
  {
    expect(containerName('matroska,webm', 'a.webm')).toBe('WebM')
    expect(containerName('matroska,webm', 'a.mkv')).toBe('Matroska')
    expect(containerName('mov,mp4,m4a,3gp,3g2,mj2')).toBe('MP4')
    expect(containerName('mpegts')).toBe('MPEG transport stream')
    expect(containerName('weird')).toBe('WEIRD')
    expect(containerName('')).toBe('Unknown container')
    expect(channelWords(1, 'mono')).toBe('mono')
    expect(channelWords(2, null)).toBe('stereo')
    expect(channelWords(6, '5.1(side)')).toBe('5.1')
    expect(channelWords(8, '7.1(wide)')).toBe('7.1')
    expect(channelWords(4, 'quad')).toBe('4 channels')
    expect(channelWords(null, null)).toBe('unknown channels')
    expect(languageName('eng')).toBe('English')
    expect(languageName('und')).toBeNull()
    expect(pictureLine(video)).toBe('H.264 · 1920 × 1080 · 29.97 fps')
    expect(pictureLine(stream({ hdr: 'pq' }))).toContain('HDR (PQ)')
    expect(soundLine(german)).toBe('Dolby Digital (AC-3) · 5.1 · 48 kHz · German')
    expect(audioTrackName(english, 0)).toBe('English (AAC, stereo)')
    expect(audioTrackName(german, 1)).toBe('German (Dolby Digital (AC-3), 5.1)')
    expect(audioTrackName(stream({ kind: 'audio', codec: 'aac', language: null, title: null, channels: 2, layout: 'stereo' }), 2)).toBe('Track 3 (AAC, stereo)')
    expect(subtitleTrackName(subs, 0)).toBe('English')
    expect(subtitleTrackName({ ...subs, title: 'Signs', language: 'jpn' }, 0)).toBe('Signs (Japanese)')
    expect(subtitleTrackName({ ...subs, language: null }, 1)).toBe('Subtitles 2')
  })

  it('writes the facts under a title and how a file plays', () =>
  {
    expect(trackFacts({ id: 'l', name: 'Song', src: '', isBlob: false, videoUrl: 'https://www.youtube.com/watch?v=1' })).toBe('YouTube link')
    expect(trackFacts({ id: 'l', name: 'Song', src: '', isBlob: false, videoUrl: 'https://vimeo.com/1' })).toBe('Link from vimeo.com')
    expect(trackFacts({ id: 'w', name: 'a.mp3', src: 'https://cdn.example.org/a.mp3', isBlob: false })).toBe('Web address on cdn.example.org')
    expect(trackFacts({ id: 'b', name: 'a.mp3', src: 'blob:x', isBlob: true })).toBe('Dropped file')
    expect(trackFacts({ id: 'f', name: 'a.flac', src: '', isBlob: false, filePath: 'C:/a.flac' })).toBe('FLAC file')
    expect(trackFacts({ id: 'f', name: 'Two tracks.mkv', src: '', isBlob: false, filePath: media.path, media }, 1)).toBe('Matroska · H.264 · 1920 × 1080 · Dolby Digital (AC-3) 5.1')
    expect(pictureRouteSentence(media, true)).toBe('Picture: plays directly in Chromium.')
    expect(pictureRouteSentence(media, false)).toContain('hidden')
    expect(pictureRouteSentence({ ...media, picture: null }, true)).toBeNull()
    const decoded = { ...media, picture: { route: 'convert' as const, streamIndex: 0, reason: 'codec' as const } }
    expect(pictureRouteSentence(decoded, true, 'h264_nvenc')).toBe('Picture: decoded by FFmpeg, because Chromium has no decoder for H.264. It reaches the screen as H.264 through the NVIDIA hardware encoder (h264_nvenc).')
    expect(pictureRouteSentence({ ...media, picture: { route: 'remux', streamIndex: 0, reason: 'container' } }, true)).toContain('repackaged into Matroska')
    expect(pictureRouteSentence({ ...media, picture: { route: 'convert', streamIndex: 0, reason: 'machine' } }, true)).toContain('on this computer cannot decode')
    expect(soundRouteSentence(media, 0)).toBe('Sound: repackaged out of the file without re-encoding.')
    expect(soundRouteSentence(media, 1)).toBe('Sound: decoded by FFmpeg from Dolby Digital (AC-3) 5.1, because Chromium has no decoder for it, and handed over as Opus 5.1 through the Opus encoder (libopus).')
    expect(soundRouteSentence({ ...media, sound: [{ ...media.sound[0], route: 'direct' }] }, 0)).toBe('Sound: plays directly in Chromium.')
    expect(soundRouteSentence({ ...media, sound: [] }, 0)).toContain('no sound')
    expect(decodeNote(decoded, 1, true)).toBe('Picture and sound decoded by FFmpeg')
    expect(decodeNote(decoded, 0, true)).toBe('Picture decoded by FFmpeg')
    expect(decodeNote(media, 1, false)).toBe('Sound decoded by FFmpeg')
    expect(decodeNote(media, 0, true)).toBeNull()
    expect(decodeNote(null, 0, true)).toBeNull()
    expect(routeName('remux')).toBe('Repackaged')
    expect(encoderName('libx264')).toBe('the x264 software encoder (libx264)')
    expect(encoderName('h264_videotoolbox')).toBe('h264_videotoolbox')
  })

  it('lays out the Media information view', () =>
  {
    const info = mediaInfo(media, 1, true, null)
    expect(info.playing).toHaveLength(2)
    expect(info.routes).toEqual([
      { term: 'Picture path', value: 'Direct' },
      { term: 'Sound path', value: 'Decoded by FFmpeg' },
      { term: 'Sound encoder', value: 'libopus' }
    ])
    expect(info.sections.map((section) => section.title)).toEqual(['File', 'Video', 'Audio 1', 'Audio 2', 'Subtitles'])
    expect(info.sections[0].summary).toBe('Matroska · 1 min 36 s · 6.0 Mb/s · 71.6 MB')
    expect(info.sections[0].rows).toEqual(expect.arrayContaining([{ term: 'Container', value: 'Matroska / WebM (matroska,webm)' }, { term: 'Duration', value: '95.500 s' }, { term: 'Path', value: media.path }]))
    expect(info.sections[1].rows).toEqual(expect.arrayContaining([{ term: 'Codec', value: 'H.264 (h264)' }, { term: 'Resolution', value: '1920 × 1080' }, { term: 'Default track', value: 'Yes' }]))
    expect(info.sections[3].rows).toEqual(expect.arrayContaining([{ term: 'Language', value: 'German (ger)' }, { term: 'Channels', value: '6 (5.1(side))' }, { term: 'Bit rate', value: '384 kb/s' }]))
    const decoded = mediaInfo({ ...media, picture: { route: 'convert', streamIndex: 0, reason: 'codec' } }, 0, true, 'h264_nvenc')
    expect(decoded.routes[1]).toEqual({ term: 'Picture encoder', value: 'h264_nvenc' })
    expect(mediaInfo(media, 0, false).routes[0]).toEqual({ term: 'Picture path', value: 'Not shown' })
  })
})

describe('keys', () =>
{
  const free = { text: false, button: false, arrows: false }
  const chord = (key: string, over: Partial<{ ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }> = {}) => ({ key, code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over })

  it('maps the keys and leaves controls their own', () =>
  {
    expect(playerKeyCommand(chord(' '), free)).toEqual({ kind: 'toggle-play' })
    expect(playerKeyCommand(chord(' '), { ...free, button: true })).toBeNull()
    expect(playerKeyCommand(chord('ArrowLeft'), free)).toEqual({ kind: 'seek', by: -5 })
    expect(playerKeyCommand(chord('ArrowRight', { shiftKey: true }), free)).toEqual({ kind: 'seek', by: 30 })
    expect(playerKeyCommand(chord('ArrowUp'), free)).toEqual({ kind: 'volume', by: 0.05 })
    expect(playerKeyCommand(chord('ArrowUp'), { ...free, arrows: true })).toBeNull()
    expect(playerKeyCommand(chord('m'), free)).toEqual({ kind: 'mute' })
    expect(playerKeyCommand(chord('M', { shiftKey: true }), free)).toBeNull()
    expect(playerKeyCommand(chord('n'), free)).toEqual({ kind: 'next' })
    expect(playerKeyCommand(chord('p'), free)).toEqual({ kind: 'previous' })
    expect(playerKeyCommand(chord('s'), free)).toEqual({ kind: 'shuffle' })
    expect(playerKeyCommand(chord('r'), free)).toEqual({ kind: 'repeat' })
    expect(playerKeyCommand(chord('v'), free)).toEqual({ kind: 'visualization', direction: 1 })
    expect(playerKeyCommand(chord('V', { shiftKey: true }), free)).toEqual({ kind: 'visualization', direction: -1 })
    expect(playerKeyCommand(chord('b'), free)).toEqual({ kind: 'view' })
    expect(playerKeyCommand(chord('?'), free)).toEqual({ kind: 'shortcuts' })
    expect(playerKeyCommand(chord('F1'), { ...free, text: true })).toEqual({ kind: 'shortcuts' })
    expect(playerKeyCommand(chord('F11'), { ...free, text: true })).toEqual({ kind: 'full-screen' })
    expect(playerKeyCommand(chord('Escape'), free)).toEqual({ kind: 'escape' })
    expect(playerKeyCommand(chord('Escape'), { ...free, text: true })).toBeNull()
    expect(playerKeyCommand(chord('MediaPlayPause'), { ...free, text: true })).toEqual({ kind: 'toggle-play' })
    expect(playerKeyCommand(chord('o', { ctrlKey: true }), free)).toEqual({ kind: 'add-files' })
    expect(playerKeyCommand(chord('O', { ctrlKey: true, shiftKey: true }), free)).toEqual({ kind: 'add-folder' })
    expect(playerKeyCommand(chord('u', { metaKey: true }), free)).toEqual({ kind: 'add-link' })
    expect(playerKeyCommand(chord('i', { ctrlKey: true }), free)).toEqual({ kind: 'media-info' })
    expect(playerKeyCommand(chord('/', { ctrlKey: true }), free)).toEqual({ kind: 'shortcuts' })
    expect(playerKeyCommand(chord('x', { ctrlKey: true }), free)).toBeNull()
    expect(playerKeyCommand(chord('m'), { ...free, text: true })).toBeNull()
    expect(playerKeyCommand(chord('m', { altKey: true }), free)).toBeNull()
    expect(playerKeyCommand(chord('z'), free)).toBeNull()
  })

  it('reads where a key landed', () =>
  {
    document.body.innerHTML = '<input id="t" type="text"><button id="b"></button><input id="r" type="range"><div role="grid"><div id="row" role="row" tabindex="0"></div></div><div id="plain"></div>'
    expect(keyTargetOf(document.getElementById('t'))).toEqual({ text: true, button: false, arrows: false })
    expect(keyTargetOf(document.getElementById('b'))).toEqual({ text: false, button: true, arrows: false })
    expect(keyTargetOf(document.getElementById('r'))).toEqual({ text: false, button: false, arrows: true })
    expect(keyTargetOf(document.getElementById('row'))).toEqual({ text: false, button: false, arrows: true })
    expect(keyTargetOf(document.getElementById('plain'))).toEqual({ text: false, button: false, arrows: false })
    expect(keyTargetOf(null)).toEqual({ text: false, button: false, arrows: false })
    document.body.innerHTML = ''
  })

  it('lists every key it acts on in the shortcuts popover', () =>
  {
    const labels = PLAYER_SHORTCUTS.flatMap((group) => group.entries.map((entry) => entry.label))
    expect(labels).toEqual(expect.arrayContaining(['Play or pause', 'Full screen', 'Leave full screen', 'Add link', 'Media information', 'Keyboard shortcuts']))
    expect(PLAYER_SHORTCUTS.map((group) => group.id)).toEqual(['playback', 'view', 'playlist'])
  })
})

describe('track helpers', () =>
{
  it('formats time with hours, names files, and sums known lengths', () =>
  {
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(65.9)).toBe('1:05')
    expect(formatTime(NaN)).toBe('0:00')
    expect(fileNameOf('C:\\music\\a b.flac')).toBe('a b.flac')
    expect(fileNameOf('/m/x.mp3')).toBe('x.mp3')
    expect(isMediaPath('C:/m/x.MKV')).toBe(true)
    expect(isMediaPath('C:/m/notes.txt')).toBe(false)
    expect(trackFromPath('C:/m/x.mp3')).toMatchObject({ name: 'x.mp3', filePath: 'C:/m/x.mp3', isBlob: false, src: '' })
    expect(trackFromAddress('https://h/a%20b.mp3?x=1')).toMatchObject({ name: 'a b.mp3', src: 'https://h/a%20b.mp3?x=1' })
    expect(trackFromAddress('https://h/%E0%A4%A').name).toBe('%E0%A4%A')
    expect(totalDuration(tracks)).toEqual({ seconds: 210, complete: false })
    expect(totalDuration(tracks.slice(0, 2))).toEqual({ seconds: 180, complete: true })
  })
})
