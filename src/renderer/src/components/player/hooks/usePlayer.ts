/**
 * The player's engine: one audio element as the clock and the sound, one muted video element following it, the
 * audio graph the visualizations read, the playlist, and the session choices. Local files are probed and played the
 * cheapest way; links resolve through yt-dlp; the state moves to and from the pop-out window whole.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LinkProgress, VideoCodecFamily } from '../../../../../shared/ipc/api'
import { audioTracks, pictureStream, planPicture, textSubtitles, type PlayerMedia, type PlayRoute } from '../../../../../shared/player/media'
import { PLAYER_COPY } from '../copy'
import type { GridMoveTo } from '../../../ui/DataGrid'
import type { VisMode } from '../../../visualizations/types'
import { pictureVerdict } from '../engine/decode'
import { describeLinkError, pictureHeightFor, type LinkFailure, type PictureQuality, type SoundQuality } from '../engine/links'
import { afterEnd, dropTracks, moveTracks, nextRepeat, stepTrack, type RepeatMode } from '../engine/queue'
import { portableTracks, readSnapshot, type PlayerSnapshot, type StageView } from '../engine/snapshot'
import { PictureFollower, type FollowSource } from '../engine/sync'
import { cueTextAt, parseVtt, type Cue } from '../engine/vtt'
import { getExt, isMediaPath, trackFromPath, VIDEO_EXTS, type Track } from '../types'

/** The visualizations in menu and cycle order. */
export const VIS_ORDER: readonly VisMode[] = ['dmt', 'space', 'milkdrop', 'plasma', 'bars', 'wave', 'horizon', 'rain']

/** Where the player is. */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused'

/** The picture's state for the current track. */
export type PictureState = 'none' | 'hidden' | 'loading' | 'showing' | 'failed'

/** A problem in words, with the tool's own line folded under it. */
export type PlayerProblem = LinkFailure

/** After this many failed tracks in a row the player stops instead of skipping on. */
export const MAX_CONSECUTIVE_SKIPS = 5

/** Previous restarts the track instead when it has played longer than this, in seconds. */
export const RESTART_AFTER = 3

/** What a lookup of a site link reports to the Add link popover. */
export type LinkOutcome = { ok: true, count: number } | { ok: false, problem: PlayerProblem }

/** Everything the player's views read and do. */
export interface PlayerEngine
{
  audioRef: RefObject<HTMLAudioElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  analyserRef: RefObject<AnalyserNode | null>
  tracks: Track[]
  current: Track | null
  status: PlayerStatus
  loadingLabel: string | null
  problem: PlayerProblem | null
  time: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  visMode: VisMode
  view: StageView
  picture: PictureState
  pictureNote: string | null
  /** A note about the sound's route, such as a stream that had to be downloaded first. */
  soundNote: string | null
  /** What getting the picture is doing, while it loads: asking yt-dlp, or a download with its percent. */
  pictureProgress: string | null
  /** When the current loading started, for an elapsed count in the label; null when nothing loads. */
  loadingSince: number | null
  /** The encoder FFmpeg hands a decoded picture over with, such as h264_nvenc; null when Chromium reads the stream. */
  pictureEncoder: string | null
  soundQuality: SoundQuality
  pictureQuality: PictureQuality
  subtitleIndex: number | null
  subtitleText: string
  poppedOut: boolean
  /** True when the current source has, or may have, a picture to show. */
  canShowPicture: boolean
  addPaths(paths: readonly string[], options?: { play?: boolean }): number
  addLink(url: string, kind: 'site' | 'file'): Promise<LinkOutcome>
  playId(id: string): void
  togglePlay(): void
  next(): void
  previous(): void
  seek(seconds: number): void
  seekBy(delta: number): void
  setVolume(volume: number): void
  toggleMute(): void
  toggleShuffle(): void
  cycleRepeat(): void
  setVisMode(mode: VisMode): void
  cycleVisMode(direction: 1 | -1): void
  setView(view: StageView): void
  setSoundQuality(quality: SoundQuality): void
  setPictureQuality(quality: PictureQuality): void
  selectAudio(index: number): void
  selectSubtitles(streamIndex: number | null): void
  removeIds(ids: readonly string[]): void
  moveIds(ids: readonly string[], to: GridMoveTo): void
  dropIds(ids: readonly string[], before: string | null): void
  clear(): void
  dismissProblem(): void
  inspect(id: string): Promise<PlayerMedia | null>
  snapshot(): PlayerSnapshot
  popOut(): void
}

/** The display in physical pixels, which a picture FFmpeg decodes is fitted to. */
export function displayBox(): { width: number, height: number }
{
  const ratio = window.devicePixelRatio || 1
  return { width: Math.round((window.screen?.width ?? 1920) * ratio), height: Math.round((window.screen?.height ?? 1080) * ratio) }
}

/** A probed file with the picture plan this renderer's decoder decides. */
export async function withPicturePlan(media: PlayerMedia, verdict: typeof pictureVerdict = pictureVerdict): Promise<PlayerMedia>
{
  const stream = pictureStream(media.streams)
  if (stream === null)
  {
    return { ...media, picture: null }
  }
  return { ...media, picture: planPicture(media.streams, media.container, await verdict(stream)) }
}

/** The video codec families this renderer's Chromium decodes, asked at runtime; H.264 is always offered. */
export function linkCodecs(): VideoCodecFamily[]
{
  const out: VideoCodecFamily[] = ['avc1']
  try
  {
    const probe = document.createElement('video')
    if (probe.canPlayType('video/webm; codecs="vp9"') !== '')
    {
      out.push('vp9')
    }
    if (probe.canPlayType('video/mp4; codecs="av01.0.05M.08"') === 'probably')
    {
      out.push('av01')
    }
  }
  catch
  {
    return out
  }
  return out
}

/** The words of a link progress report. */
export function linkProgressLabel(progress: Pick<LinkProgress, 'stage' | 'percent'>): string
{
  if (progress.stage === 'downloading')
  {
    return progress.percent === null ? `${PLAYER_COPY.downloadingPicture}…` : `${PLAYER_COPY.downloadingPicture} · ${Math.round(progress.percent)}%`
  }
  return PLAYER_COPY.gettingPicture
}

/** What a picture FFmpeg decodes is sized and encoded for. */
function pictureOptions(media: PlayerMedia | null, software: boolean): { width: number, height: number, fps: number | null, software: boolean }
{
  const stream = media === null ? null : pictureStream(media.streams)
  return { ...displayBox(), fps: stream?.frameRate ?? null, software }
}

/** What the player says while it readies a file's sound. */
export function soundLoadingLabel(route: PlayRoute): string
{
  if (route === 'convert')
  {
    return 'Decoding the sound with FFmpeg…'
  }
  return route === 'remux' ? 'Repackaging the sound…' : 'Opening…'
}

function plainProblem(message: string): PlayerProblem
{
  return { message, detail: null }
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** A local file's problem in words. */
export function fileProblem(raw: string): PlayerProblem
{
  if (/ffmpeg not configured|ffprobe not configured/i.test(raw))
  {
    return { message: 'FFmpeg is not set up yet. Finish setup under Settings, then try again.', detail: raw }
  }
  if (/no such file|enoent|not found/i.test(raw))
  {
    return { message: 'This file is no longer where it was. It may have been moved or deleted.', detail: raw }
  }
  if (/invalid data|could not read media|moov atom not found/i.test(raw))
  {
    return { message: 'This file is damaged or is not a media file FFmpeg can read.', detail: raw }
  }
  return { message: 'This file could not be played. Media information may show why.', detail: raw }
}

interface PlayOptions
{
  at?: number
  paused?: boolean
  /** Keeps the problem of the track that failed, so the skip reads along with what plays instead. */
  keepProblem?: boolean
  /** Fetches a link's sound into the cache first, after a direct stream Chromium could not play. */
  download?: boolean
}

/** The player's engine for the main window or the pop-out. */
export function usePlayer({ popout }: { popout: boolean }): PlayerEngine
{
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const followerRef = useRef<PictureFollower | null>(null)

  const [tracks, setTracks] = useState<Track[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [problem, setProblem] = useState<PlayerProblem | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')
  const [visMode, setVisModeState] = useState<VisMode>('dmt')
  const [view, setViewState] = useState<StageView>('video')
  const [picture, setPicture] = useState<PictureState>('none')
  const [pictureNote, setPictureNote] = useState<string | null>(null)
  const [soundNote, setSoundNote] = useState<string | null>(null)
  const [pictureProgress, setPictureProgress] = useState<string | null>(null)
  const [loadingSince, setLoadingSince] = useState<number | null>(null)
  const [pictureEncoder, setPictureEncoder] = useState<string | null>(null)
  const [soundQuality, setSoundQualityState] = useState<SoundQuality>('best')
  const [pictureQuality, setPictureQualityState] = useState<PictureQuality>('auto')
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(null)
  const [subtitleText, setSubtitleText] = useState('')
  const [poppedOut, setPoppedOut] = useState(false)

  const tracksRef = useRef<Track[]>([])
  const currentRef = useRef<string | null>(null)
  const repeatRef = useRef(repeat)
  const shuffleRef = useRef(shuffle)
  const viewRef = useRef(view)
  const soundQualityRef = useRef(soundQuality)
  const pictureQualityRef = useRef(pictureQuality)
  const subtitleRef = useRef<number | null>(null)
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)
  const tokenRef = useRef(0)
  const skipsRef = useRef(0)
  const retriedRef = useRef<string | null>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const seekingRef = useRef(false)
  const cuesRef = useRef<Cue[]>([])
  const probingRef = useRef(false)
  const softwareRef = useRef(false)
  const codecsRef = useRef<VideoCodecFamily[] | null>(null)
  const linkPictureRef = useRef<{ pageUrl: string, kind: 'progressive' | 'dash' | 'download' } | null>(null)

  repeatRef.current = repeat
  shuffleRef.current = shuffle
  viewRef.current = view
  soundQualityRef.current = soundQuality
  pictureQualityRef.current = pictureQuality
  volumeRef.current = volume
  mutedRef.current = muted

  const commitTracks = useCallback((update: (previous: Track[]) => Track[]): void =>
  {
    const next = update(tracksRef.current)
    tracksRef.current = next
    setTracks(next)
  }, [])

  const patchTrack = useCallback((id: string, patch: Partial<Track>): void =>
  {
    commitTracks((previous) => previous.map((track) => track.id === id ? { ...track, ...patch } : track))
  }, [commitTracks])

  const clockTime = useCallback((): number => audioRef.current?.currentTime ?? 0, [])

  const ensureGraph = useCallback((): void =>
  {
    const audio = audioRef.current
    if (!audio)
    {
      return
    }
    try
    {
      ctxRef.current ??= new AudioContext()
      const ctx = ctxRef.current
      if (!sourceRef.current)
      {
        const source = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0.75
        source.connect(analyser)
        analyser.connect(ctx.destination)
        sourceRef.current = source
        analyserRef.current = analyser
      }
      if (ctx.state === 'suspended')
      {
        void ctx.resume()
      }
    }
    catch
    {
      analyserRef.current = null
    }
  }, [])

  const inspectTrack = useCallback(async (track: Track): Promise<PlayerMedia | null> =>
  {
    if (track.filePath === undefined)
    {
      return null
    }
    if (track.media !== undefined)
    {
      return track.media
    }
    const result = await window.api.inspectMedia(track.filePath)
    const media = result.ok ? await withPicturePlan(result.media) : null
    patchTrack(track.id, { media, ...(media?.duration ? { duration: media.duration } : {}) })
    return media
  }, [patchTrack])

  /** Probes the playlist's unprobed files one at a time, for their lengths and plans. */
  const probeQueue = useCallback(async (): Promise<void> =>
  {
    if (probingRef.current)
    {
      return
    }
    probingRef.current = true
    try
    {
      for (;;)
      {
        const next = tracksRef.current.find((track) => track.filePath !== undefined && track.media === undefined)
        if (!next)
        {
          return
        }
        try
        {
          await inspectTrack(next)
        }
        catch
        {
          patchTrack(next.id, { media: null })
        }
      }
    }
    finally
    {
      probingRef.current = false
    }
  }, [inspectTrack, patchTrack])

  const loadSubtitles = useCallback(async (track: Track, media: PlayerMedia | null, streamIndex: number | null, token: number): Promise<void> =>
  {
    cuesRef.current = []
    setSubtitleText('')
    if (streamIndex === null || media === null || track.filePath === undefined || !textSubtitles(media.streams).some((stream) => stream.index === streamIndex))
    {
      return
    }
    const result = await window.api.getSubtitles(track.filePath, streamIndex)
    if (tokenRef.current === token && result.ok)
    {
      cuesRef.current = parseVtt(result.vtt)
    }
  }, [])

  const startPicture = useCallback(async (track: Track, media: PlayerMedia | null, token: number): Promise<void> =>
  {
    const follower = followerRef.current
    follower?.clear()
    setPictureNote(null)
    setPictureProgress(null)
    setPictureEncoder(null)
    const isAddress = track.filePath === undefined && track.videoUrl === undefined
    const has = media?.picture != null || track.videoUrl !== undefined || (isAddress && VIDEO_EXTS.has(getExt(track.name)))
    if (!has || follower === null)
    {
      setPicture('none')
      return
    }
    if (viewRef.current !== 'video')
    {
      setPicture('hidden')
      return
    }
    setPicture('loading')
    let source: FollowSource | null = null
    let note: string | null = null
    if (track.filePath !== undefined && media?.picture)
    {
      const plan = media.picture
      const result = await window.api.getPictureUrl(track.filePath, plan.streamIndex, plan.route, plan.route === 'convert' ? clockTime() : 0, pictureOptions(media, softwareRef.current))
      source = result.ok ? result.picture : null
      if (result.ok)
      {
        setPictureEncoder(result.picture.encoder)
      }
      note = result.ok ? null : PLAYER_COPY.pictureFailed
    }
    else if (track.videoUrl !== undefined)
    {
      const screenRows = Math.round((window.screen?.height ?? 1080) * (window.devicePixelRatio || 1))
      codecsRef.current ??= linkCodecs()
      setPictureProgress(PLAYER_COPY.gettingPicture)
      const result = await window.api.getLinkPicture(track.videoUrl, pictureHeightFor(pictureQualityRef.current, screenRows), codecsRef.current)
      source = result.ok ? { url: result.link.url, live: false, offset: 0 } : null
      linkPictureRef.current = result.ok ? { pageUrl: track.videoUrl, kind: result.link.kind } : null
      note = result.ok ? null : PLAYER_COPY.noPicture
    }
    else
    {
      source = { url: track.src, live: false, offset: 0 }
    }
    if (tokenRef.current !== token)
    {
      return
    }
    setPictureProgress(null)
    if (source === null)
    {
      setPicture('failed')
      setPictureNote(note)
      return
    }
    follower.load(source)
  }, [clockTime])

  useEffect(() =>
  {
    const stop = window.api.onLinkProgress?.((progress) =>
    {
      const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
      if (track?.videoUrl === progress.pageUrl)
      {
        setPictureProgress(linkProgressLabel(progress))
      }
    })
    return () => stop?.()
  }, [])

  const stopElements = useCallback((): void =>
  {
    const audio = audioRef.current
    followerRef.current?.clear()
    if (audio)
    {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [])

  const playTrackRef = useRef<(id: string, options?: PlayOptions) => Promise<void>>(async () => undefined)

  const skipAfterFailure = useCallback((failedId: string): void =>
  {
    skipsRef.current += 1
    if (skipsRef.current >= MAX_CONSECUTIVE_SKIPS)
    {
      skipsRef.current = 0
      setStatus('paused')
      setProblem((previous) => previous ?? plainProblem('Several tracks in a row could not be played, so playback stopped.'))
      return
    }
    const ids = tracksRef.current.map((track) => track.id)
    const next = stepTrack(ids, failedId, 1, shuffleRef.current)
    if (next !== null && next !== failedId)
    {
      void playTrackRef.current(next, { keepProblem: true })
    }
    else
    {
      setStatus('paused')
    }
  }, [])

  const playTrack = useCallback(async (id: string, options: PlayOptions = {}): Promise<void> =>
  {
    const track = tracksRef.current.find((candidate) => candidate.id === id)
    const audio = audioRef.current
    if (!track || !audio)
    {
      return
    }
    const token = ++tokenRef.current
    currentRef.current = id
    setCurrentId(id)
    if (!options.keepProblem)
    {
      setProblem(null)
    }
    if (!options.download)
    {
      setSoundNote(null)
    }
    setTime(options.at ?? 0)
    setDuration(track.duration ?? 0)
    setSubtitleText('')
    cuesRef.current = []
    pendingSeekRef.current = options.at !== undefined && options.at > 0 ? options.at : null
    followerRef.current?.clear()
    setPicture('none')
    setPictureNote(null)
    audio.pause()
    setStatus('loading')
    setLoadingSince(Date.now())
    try
    {
      let url = track.src
      let media: PlayerMedia | null = null
      if (track.filePath !== undefined)
      {
        setLoadingLabel('Reading the file…')
        media = await inspectTrack(track)
        if (tokenRef.current !== token)
        {
          return
        }
        if (media === null)
        {
          throw new Error('Could not read media information')
        }
        const tracksOfFile = audioTracks(media.streams)
        if (tracksOfFile.length === 0)
        {
          setStatus('paused')
          setLoadingLabel(null)
          setProblem(plainProblem('This file has no sound, and the player plays files with sound.'))
          return
        }
        const audioIndex = Math.min(track.audioIndex ?? 0, tracksOfFile.length - 1)
        const plan = media.sound[audioIndex]
        if (url === '')
        {
          setLoadingLabel(soundLoadingLabel(plan.route))
          const result = await window.api.getSoundUrl(track.filePath, audioIndex, null, plan.route)
          if (!result.ok)
          {
            throw new Error(result.error)
          }
          url = result.url
          patchTrack(track.id, { src: url })
        }
      }
      else if (track.videoUrl !== undefined)
      {
        setLoadingLabel(options.download ? PLAYER_COPY.downloadingSound : PLAYER_COPY.gettingSound)
        const result = options.download
          ? await window.api.getStreamUrl(track.videoUrl, soundQualityRef.current, { download: true })
          : await window.api.getStreamUrl(track.videoUrl, soundQualityRef.current)
        if (tokenRef.current !== token)
        {
          return
        }
        if (!result.success || !result.mediaUrl)
        {
          setProblem(describeLinkError(result.error))
          setLoadingLabel(null)
          setLoadingSince(null)
          skipAfterFailure(track.id)
          return
        }
        url = result.mediaUrl
        setSoundNote(options.download ? PLAYER_COPY.soundDownloaded : null)
        if (typeof result.duration === 'number' && !track.duration)
        {
          patchTrack(track.id, { duration: result.duration })
          setDuration(result.duration)
        }
      }
      if (tokenRef.current !== token)
      {
        return
      }
      if (url === '')
      {
        throw new Error('No sound source')
      }
      if (track.isBlob)
      {
        audio.removeAttribute('crossOrigin')
      }
      else
      {
        audio.crossOrigin = 'anonymous'
      }
      audio.volume = volumeRef.current
      audio.muted = mutedRef.current
      ensureGraph()
      audio.src = url
      void loadSubtitles(track, media, subtitleRef.current, token)
      void startPicture(track, media, token)
      if (options.paused)
      {
        setStatus('paused')
        setLoadingLabel(null)
        setLoadingSince(null)
        return
      }
      await audio.play()
      if (tokenRef.current === token)
      {
        setLoadingLabel(null)
        setLoadingSince(null)
        setStatus('playing')
        skipsRef.current = 0
      }
    }
    catch (err)
    {
      if (tokenRef.current !== token || (err instanceof Error && err.name === 'AbortError'))
      {
        return
      }
      setLoadingLabel(null)
      setLoadingSince(null)
      setStatus('paused')
      setProblem((previous) => previous ?? fileProblem(errorText(err)))
    }
  }, [ensureGraph, inspectTrack, loadSubtitles, patchTrack, skipAfterFailure, startPicture])

  playTrackRef.current = playTrack

  useEffect(() =>
  {
    const video = videoRef.current
    if (!video)
    {
      return undefined
    }
    const follower = new PictureFollower(video, {
      time: clockTime,
      playing: () => !(audioRef.current?.paused ?? true),
      rate: () => audioRef.current?.playbackRate ?? 1
    }, (at) =>
    {
      const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
      const plan = track?.media?.picture
      if (!track?.filePath || !plan || plan.route !== 'convert')
      {
        return
      }
      const token = tokenRef.current
      void window.api.getPictureUrl(track.filePath, plan.streamIndex, 'convert', at, pictureOptions(track.media ?? null, softwareRef.current)).then((result) =>
      {
        if (tokenRef.current === token && result.ok && viewRef.current === 'video')
        {
          setPictureEncoder(result.picture.encoder)
          follower.load(result.picture)
        }
      })
    })
    followerRef.current = follower
    const onShown = (): void =>
    {
      if (video.videoWidth > 0)
      {
        setPicture('showing')
      }
    }
    const onError = (): void =>
    {
      const source = follower.current()
      if (source === null)
      {
        return
      }
      const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
      const plan = track?.media?.picture
      const link = linkPictureRef.current
      if (track?.videoUrl !== undefined && link !== null && link.pageUrl === track.videoUrl && link.kind !== 'download')
      {
        linkPictureRef.current = { pageUrl: track.videoUrl, kind: 'download' }
        const token = tokenRef.current
        const pageUrl = track.videoUrl
        setPicture('loading')
        setPictureProgress(linkProgressLabel({ stage: 'downloading', percent: null }))
        const screenRows = Math.round((window.screen?.height ?? 1080) * (window.devicePixelRatio || 1))
        void window.api.getLinkPicture(pageUrl, pictureHeightFor(pictureQualityRef.current, screenRows), codecsRef.current ?? linkCodecs(), { download: true }).then((result) =>
        {
          if (tokenRef.current !== token)
          {
            return
          }
          setPictureProgress(null)
          if (result.ok && viewRef.current === 'video')
          {
            setPictureNote(PLAYER_COPY.pictureDownloaded)
            follower.load({ url: result.link.url, live: false, offset: 0 })
            return
          }
          setPicture('failed')
          setPictureNote(PLAYER_COPY.pictureStopped)
        })
        return
      }
      if (source.live && source.encoder !== null && source.encoder !== 'libx264' && !softwareRef.current && track?.filePath && plan)
      {
        softwareRef.current = true
        const token = tokenRef.current
        void window.api.getPictureUrl(track.filePath, plan.streamIndex, 'convert', clockTime(), pictureOptions(track.media ?? null, true)).then((result) =>
        {
          if (tokenRef.current === token && result.ok)
          {
            setPictureEncoder(result.picture.encoder)
            follower.load(result.picture)
          }
        })
        return
      }
      follower.clear()
      setPicture('failed')
      setPictureNote(PLAYER_COPY.pictureStopped)
    }
    video.addEventListener('loadeddata', onShown)
    video.addEventListener('error', onError)
    return () =>
    {
      video.removeEventListener('loadeddata', onShown)
      video.removeEventListener('error', onError)
      follower.dispose()
      followerRef.current = null
    }
  }, [clockTime])

  useEffect(() =>
  {
    const audio = audioRef.current
    if (!audio)
    {
      return undefined
    }
    const follow = (): void => followerRef.current?.follow()
    const onMetadata = (): void =>
    {
      if (Number.isFinite(audio.duration) && audio.duration > 0)
      {
        setDuration(audio.duration)
        const id = currentRef.current
        const track = tracksRef.current.find((candidate) => candidate.id === id)
        if (id !== null && track && !track.duration)
        {
          patchTrack(id, { duration: audio.duration })
        }
      }
      if (pendingSeekRef.current !== null)
      {
        audio.currentTime = pendingSeekRef.current
        pendingSeekRef.current = null
      }
    }
    const onTime = (): void =>
    {
      if (!seekingRef.current)
      {
        setTime(audio.currentTime)
      }
      const cues = cuesRef.current
      if (cues.length > 0)
      {
        const text = cueTextAt(cues, audio.currentTime)
        setSubtitleText((previous) => previous === text ? previous : text)
      }
    }
    const onSeeking = (): void =>
    {
      seekingRef.current = true
      followerRef.current?.seekTo(audio.currentTime)
    }
    const onSeeked = (): void =>
    {
      seekingRef.current = false
      setTime(audio.currentTime)
      follow()
    }
    const onPlay = (): void =>
    {
      setStatus('playing')
      follow()
    }
    const onPause = (): void =>
    {
      if (!audio.ended)
      {
        setStatus((previous) => previous === 'loading' ? previous : 'paused')
      }
      follow()
    }
    const onEnded = (): void =>
    {
      const ids = tracksRef.current.map((track) => track.id)
      const next = afterEnd(ids, currentRef.current, repeatRef.current, shuffleRef.current)
      if (next === null)
      {
        setStatus('paused')
        follow()
        return
      }
      if (next === currentRef.current)
      {
        audio.currentTime = 0
        void audio.play()
        return
      }
      void playTrackRef.current(next)
    }
    const onError = (): void =>
    {
      const code = audio.error?.code
      const id = currentRef.current
      if (code === 1 || id === null || !audio.getAttribute('src'))
      {
        return
      }
      const track = tracksRef.current.find((candidate) => candidate.id === id)
      if (!track)
      {
        return
      }
      if (retriedRef.current !== id && (track.videoUrl !== undefined || track.filePath !== undefined))
      {
        retriedRef.current = id
        const at = audio.currentTime
        patchTrack(id, { src: '' })
        const retry = track.filePath !== undefined ? window.api.clearPlaybackCache(track.filePath).catch(() => undefined) : Promise.resolve()
        void retry.then(() => playTrackRef.current(id, { at, download: track.videoUrl !== undefined }))
        return
      }
      retriedRef.current = null
      setStatus('paused')
      setProblem(code === 4
        ? plainProblem(`This ${getExt(track.name).toUpperCase() || 'media'} file uses a format the player cannot decode.`)
        : { message: 'Playback stopped because of a decoding error.', detail: audio.error?.message || null })
      if (track.videoUrl !== undefined || code === 4)
      {
        skipAfterFailure(id)
      }
    }
    const listeners: Array<[string, () => void]> = [
      ['loadedmetadata', onMetadata],
      ['durationchange', onMetadata],
      ['timeupdate', onTime],
      ['seeking', onSeeking],
      ['seeked', onSeeked],
      ['play', onPlay],
      ['pause', onPause],
      ['ratechange', follow],
      ['waiting', follow],
      ['playing', follow],
      ['ended', onEnded],
      ['error', onError]
    ]
    for (const [name, listener] of listeners)
    {
      audio.addEventListener(name, listener)
    }
    return () =>
    {
      for (const [name, listener] of listeners)
      {
        audio.removeEventListener(name, listener)
      }
    }
  }, [patchTrack, skipAfterFailure])

  useEffect(() => () =>
  {
    stopElements()
    for (const track of tracksRef.current)
    {
      if (track.isBlob)
      {
        URL.revokeObjectURL(track.src)
      }
    }
    void ctxRef.current?.close().catch(() => undefined)
  }, [stopElements])

  const addTracks = useCallback((added: Track[], play: boolean): number =>
  {
    if (added.length === 0)
    {
      return 0
    }
    commitTracks((previous) => [...previous, ...added])
    void probeQueue()
    if (play && (currentRef.current === null || status !== 'playing'))
    {
      void playTrackRef.current(added[0].id)
    }
    return added.length
  }, [commitTracks, probeQueue, status])

  const addPaths = useCallback((paths: readonly string[], options: { play?: boolean } = {}): number =>
  {
    const added = paths.filter(isMediaPath).map(trackFromPath)
    return addTracks(added, options.play ?? true)
  }, [addTracks])

  const addLink = useCallback(async (url: string, kind: 'site' | 'file'): Promise<LinkOutcome> =>
  {
    if (kind === 'file')
    {
      const last = url.split('/').pop()?.split(/[?#]/)[0] ?? url
      let name = last
      try
      {
        name = decodeURIComponent(last)
      }
      catch
      {
        name = last
      }
      addTracks([{ id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, src: url, isBlob: false }], true)
      return { ok: true, count: 1 }
    }
    try
    {
      const result = await window.api.resolvePlaylist(url)
      if (!result.success)
      {
        return { ok: false, problem: describeLinkError(result.error) }
      }
      const added: Track[] = result.entries
        .filter((entry: { url?: string }) => typeof entry?.url === 'string')
        .map((entry: { id?: string, title?: string, url: string, duration?: number | null }, i: number) => ({
          id: `t-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          name: entry.title || entry.id || entry.url,
          src: '',
          isBlob: false,
          videoUrl: entry.url,
          duration: typeof entry.duration === 'number' ? entry.duration : null
        }))
      if (added.length === 0)
      {
        return { ok: false, problem: describeLinkError('no entries') }
      }
      addTracks(added, true)
      return { ok: true, count: added.length }
    }
    catch (err)
    {
      return { ok: false, problem: describeLinkError(errorText(err)) }
    }
  }, [addTracks])

  const playId = useCallback((id: string): void =>
  {
    skipsRef.current = 0
    retriedRef.current = null
    void playTrackRef.current(id)
  }, [])

  const togglePlay = useCallback((): void =>
  {
    const audio = audioRef.current
    if (!audio)
    {
      return
    }
    if (currentRef.current === null || !audio.getAttribute('src'))
    {
      const first = currentRef.current ?? tracksRef.current[0]?.id
      if (first)
      {
        playId(first)
      }
      return
    }
    if (ctxRef.current?.state === 'suspended')
    {
      void ctxRef.current.resume()
    }
    if (audio.paused)
    {
      void audio.play().catch(() => undefined)
    }
    else
    {
      audio.pause()
    }
  }, [playId])

  const next = useCallback((): void =>
  {
    const target = stepTrack(tracksRef.current.map((track) => track.id), currentRef.current, 1, shuffleRef.current)
    if (target !== null)
    {
      playId(target)
    }
  }, [playId])

  const previous = useCallback((): void =>
  {
    const audio = audioRef.current
    if (audio && audio.currentTime > RESTART_AFTER)
    {
      audio.currentTime = 0
      return
    }
    const target = stepTrack(tracksRef.current.map((track) => track.id), currentRef.current, -1, shuffleRef.current)
    if (target !== null)
    {
      playId(target)
    }
  }, [playId])

  const seek = useCallback((seconds: number): void =>
  {
    const audio = audioRef.current
    if (!audio || !audio.getAttribute('src'))
    {
      return
    }
    const end = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY
    const target = Math.max(0, Math.min(seconds, Math.max(0, end - 0.05)))
    setTime(target)
    audio.currentTime = target
  }, [])

  const seekBy = useCallback((delta: number): void =>
  {
    seek((audioRef.current?.currentTime ?? 0) + delta)
  }, [seek])

  const setVolume = useCallback((value: number): void =>
  {
    const v = Math.min(1, Math.max(0, value))
    setVolumeState(v)
    if (audioRef.current)
    {
      audioRef.current.volume = v
    }
    if (v > 0 && mutedRef.current)
    {
      setMuted(false)
      if (audioRef.current)
      {
        audioRef.current.muted = false
      }
    }
  }, [])

  const toggleMute = useCallback((): void =>
  {
    const nextMuted = !mutedRef.current
    setMuted(nextMuted)
    if (audioRef.current)
    {
      audioRef.current.muted = nextMuted
    }
  }, [])

  const toggleShuffle = useCallback((): void => setShuffle((value) => !value), [])
  const cycleRepeat = useCallback((): void => setRepeat((value) => nextRepeat(value)), [])
  const setVisMode = useCallback((mode: VisMode): void => setVisModeState(mode), [])
  const cycleVisMode = useCallback((direction: 1 | -1): void =>
  {
    setVisModeState((mode) => VIS_ORDER[(VIS_ORDER.indexOf(mode) + direction + VIS_ORDER.length) % VIS_ORDER.length])
  }, [])

  const setView = useCallback((nextView: StageView): void =>
  {
    viewRef.current = nextView
    setViewState(nextView)
    const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
    if (!track)
    {
      return
    }
    if (nextView === 'visualization')
    {
      followerRef.current?.clear()
      setPicture((state) => state === 'none' ? state : 'hidden')
      return
    }
    void startPicture(track, track.media ?? null, tokenRef.current)
  }, [startPicture])

  const setSoundQuality = useCallback((quality: SoundQuality): void =>
  {
    setSoundQualityState(quality)
    soundQualityRef.current = quality
  }, [])

  const setPictureQuality = useCallback((quality: PictureQuality): void =>
  {
    setPictureQualityState(quality)
    pictureQualityRef.current = quality
    const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
    if (track?.videoUrl !== undefined && viewRef.current === 'video')
    {
      void startPicture(track, null, tokenRef.current)
    }
  }, [startPicture])

  const selectAudio = useCallback((index: number): void =>
  {
    const id = currentRef.current
    const track = tracksRef.current.find((candidate) => candidate.id === id)
    if (!id || !track || (track.audioIndex ?? 0) === index)
    {
      return
    }
    const audio = audioRef.current
    const at = audio?.currentTime ?? 0
    const paused = audio?.paused ?? true
    patchTrack(id, { audioIndex: index, src: '' })
    void playTrackRef.current(id, { at, paused })
  }, [patchTrack])

  const selectSubtitles = useCallback((streamIndex: number | null): void =>
  {
    subtitleRef.current = streamIndex
    setSubtitleIndex(streamIndex)
    const track = tracksRef.current.find((candidate) => candidate.id === currentRef.current)
    if (track)
    {
      void loadSubtitles(track, track.media ?? null, streamIndex, tokenRef.current)
    }
  }, [loadSubtitles])

  const removeIds = useCallback((ids: readonly string[]): void =>
  {
    const gone = new Set(ids)
    for (const track of tracksRef.current)
    {
      if (gone.has(track.id) && track.isBlob)
      {
        URL.revokeObjectURL(track.src)
      }
    }
    commitTracks((previous) => previous.filter((track) => !gone.has(track.id)))
    if (currentRef.current !== null && gone.has(currentRef.current))
    {
      tokenRef.current += 1
      stopElements()
      currentRef.current = null
      setCurrentId(null)
      setStatus('idle')
      setTime(0)
      setDuration(0)
      setPicture('none')
      setLoadingLabel(null)
      setLoadingSince(null)
    }
  }, [commitTracks, stopElements])

  const moveIds = useCallback((ids: readonly string[], to: GridMoveTo): void =>
  {
    commitTracks((previous) => moveTracks(previous, ids, to))
  }, [commitTracks])

  const dropIds = useCallback((ids: readonly string[], before: string | null): void =>
  {
    commitTracks((previous) => dropTracks(previous, ids, before))
  }, [commitTracks])

  const clear = useCallback((): void =>
  {
    removeIds(tracksRef.current.map((track) => track.id))
    setProblem(null)
    skipsRef.current = 0
  }, [removeIds])

  const dismissProblem = useCallback((): void => setProblem(null), [])

  const inspect = useCallback(async (id: string): Promise<PlayerMedia | null> =>
  {
    const track = tracksRef.current.find((candidate) => candidate.id === id)
    return track ? inspectTrack(track) : null
  }, [inspectTrack])

  const snapshot = useCallback((): PlayerSnapshot => ({
    playlist: portableTracks(tracksRef.current),
    currentId: currentRef.current,
    currentTime: audioRef.current?.currentTime ?? 0,
    playing: !(audioRef.current?.paused ?? true),
    volume: volumeRef.current,
    muted: mutedRef.current,
    shuffle: shuffleRef.current,
    repeat: repeatRef.current,
    visMode,
    view: viewRef.current,
    soundQuality: soundQualityRef.current,
    pictureQuality: pictureQualityRef.current,
    subtitleIndex: subtitleRef.current
  }), [visMode])

  const restore = useCallback((raw: unknown): void =>
  {
    const state = readSnapshot(raw)
    if (state === null)
    {
      return
    }
    tracksRef.current = state.playlist
    setTracks(state.playlist)
    setVolumeState(state.volume)
    setMuted(state.muted)
    mutedRef.current = state.muted
    volumeRef.current = state.volume
    setShuffle(state.shuffle)
    setRepeat(state.repeat)
    setVisModeState(state.visMode)
    viewRef.current = state.view
    setViewState(state.view)
    setSoundQualityState(state.soundQuality)
    soundQualityRef.current = state.soundQuality
    setPictureQualityState(state.pictureQuality)
    pictureQualityRef.current = state.pictureQuality
    subtitleRef.current = state.subtitleIndex
    setSubtitleIndex(state.subtitleIndex)
    void probeQueue()
    if (state.currentId !== null)
    {
      void playTrackRef.current(state.currentId, { at: state.currentTime, paused: !state.playing })
    }
  }, [probeQueue])

  const popOut = useCallback((): void =>
  {
    const state = snapshot()
    tokenRef.current += 1
    stopElements()
    setStatus('paused')
    setPoppedOut(true)
    void window.api.popoutPlayer(state)
  }, [snapshot, stopElements])

  useEffect(() =>
  {
    if (!popout)
    {
      return undefined
    }
    const stop = window.api.onReceivePlayerState?.((state: unknown) => restore(state))
    void window.api.getPlayerState?.().then((state: unknown) =>
    {
      if (state)
      {
        restore(state)
      }
    })
    return stop
  }, [popout, restore])

  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  useEffect(() =>
  {
    if (!popout)
    {
      return undefined
    }
    const handler = (): void => window.api.returnPlayerState(snapshotRef.current())
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [popout])

  useEffect(() =>
  {
    if (popout)
    {
      return undefined
    }
    void window.api.isPopout?.().then((open: boolean) =>
    {
      if (open)
      {
        setPoppedOut(true)
      }
    })
    const stopState = window.api.onReceivePlayerState?.((state: unknown) =>
    {
      setPoppedOut(false)
      restore(state)
    })
    const stopClosed = window.api.onPopoutClosed?.(() => setPoppedOut(false))
    return () =>
    {
      stopState?.()
      stopClosed?.()
    }
  }, [popout, restore])

  const current = useMemo(() => tracks.find((track) => track.id === currentId) ?? null, [tracks, currentId])
  const canShowPicture = current !== null && (current.media?.picture != null || current.videoUrl !== undefined || (current.filePath === undefined && current.videoUrl === undefined && VIDEO_EXTS.has(getExt(current.name))))

  return {
    audioRef,
    videoRef,
    analyserRef,
    tracks,
    current,
    status,
    loadingLabel,
    problem,
    time,
    duration,
    volume,
    muted,
    shuffle,
    repeat,
    visMode,
    view,
    picture,
    pictureNote,
    soundNote,
    pictureProgress,
    loadingSince,
    pictureEncoder,
    soundQuality,
    pictureQuality,
    subtitleIndex,
    subtitleText,
    poppedOut,
    canShowPicture,
    addPaths,
    addLink,
    playId,
    togglePlay,
    next,
    previous,
    seek,
    seekBy,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    setVisMode,
    cycleVisMode,
    setView,
    setSoundQuality,
    setPictureQuality,
    selectAudio,
    selectSubtitles,
    removeIds,
    moveIds,
    dropIds,
    clear,
    dismissProblem,
    inspect,
    snapshot,
    popOut
  }
}
