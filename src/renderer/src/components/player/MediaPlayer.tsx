/**
 * @module components/player/MediaPlayer
 * @description Full-featured audio / video player with real-time visualizations.
 *
 * Orchestrates playback, URL resolution, popout transfer, and drag-and-drop.
 * Delegates canvas rendering to {@link useVisualizer}, transport controls to
 * {@link TransportBar}, playlist UI to {@link PlaylistPanel}, header to
 * {@link PlayerHeader}, and URL input to {@link UrlInputBar}.
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { VisMode, AudioQuality } from '../../visualizations'
import { type Track, MEDIA_EXTS, DIRECT_AUDIO_EXTS, isYouTubeUrl, getExt } from './types'
import { useVisualizer } from './hooks/useVisualizer'
import { TransportBar } from './components/TransportBar'
import { PopoutTransport } from './components/PopoutTransport'
import { PlaylistPanel } from './components/PlaylistPanel'
import { PlayerHeader } from './components/PlayerHeader'
import { UrlInputBar } from './components/UrlInputBar'

export default function MediaPlayer({ popout = false }: { popout?: boolean }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const [playlist, setPlaylist] = useState<Track[]>([])
  const [trackIdx, setTrackIdx] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [visMode, setVisMode] = useState<VisMode>('dmt')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<'off' | 'all' | 'one'>('off')
  const [showPlaylist, setShowPlaylist] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [audioQuality, setAudioQuality] = useState<AudioQuality>('best')
  const [urlHistory, setUrlHistory] = useState<{ url: string; title: string; trackCount: number; addedAt: number }[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [isPoppedOut, setIsPoppedOut] = useState(false)
  const pendingPlayRef = useRef<number | null>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const pendingPauseRef = useRef(false)
  const skipCountRef = useRef(0) // prevent infinite skip loops on consecutive failures
  const ytRetryRef = useRef<string | null>(null) // track ID that already had one retry
  const localRetryRef = useRef<string | null>(null) // local file ID that already had one retry
  const seekingRef = useRef(false)
  const preloadVersionRef = useRef(0)
  const timeOffsetRef = useRef(0)   // offset from seek-extraction (see seekEnd)
  const fullDurationRef = useRef(0) // full track duration (before seek-extraction)
  const MAX_CONSECUTIVE_SKIPS = 5

  // Refs for values needed inside audio event closures (avoids stale closures)
  const repeatRef = useRef(repeat)
  const playlistRef = useRef(playlist)
  const nextIndexRef = useRef<((current: number, direction?: 1 | -1) => number) | null>(null)
  const trackIdxRef = useRef(-1)
  useEffect(() => { repeatRef.current = repeat }, [repeat])
  useEffect(() => { playlistRef.current = playlist }, [playlist])
  useEffect(() => { trackIdxRef.current = trackIdx }, [trackIdx])

  const track = trackIdx >= 0 && trackIdx < playlist.length ? playlist[trackIdx] : null

  // Canvas visualization engine
  useVisualizer(canvasRef, analyserRef, visMode)

  // -- Pick next track index (respects shuffle) --
  const nextIndex = useCallback((current: number, direction: 1 | -1 = 1): number => {
    if (playlist.length === 0) return -1
    if (shuffle) {
      let next = Math.floor(Math.random() * playlist.length)
      if (playlist.length > 1) while (next === current) next = Math.floor(Math.random() * playlist.length)
      return next
    }
    return (current + direction + playlist.length) % playlist.length
  }, [playlist.length, shuffle])

  useEffect(() => { nextIndexRef.current = nextIndex }, [nextIndex])

  // -- Deferred auto-play: waits for playlist state to commit --
  const playTrackRef = useRef<((idx: number) => void) | null>(null)
  const [playlistVersion, setPlaylistVersion] = useState(0)

  const schedulePlay = useCallback((idx: number) => {
    pendingPlayRef.current = idx
    // Bump version to ensure the effect fires even if playlist.length hasn't changed
    setPlaylistVersion((v) => v + 1)
  }, [])

  // Lazily create AudioContext + MediaElementSource (once)
  const ensureAudioContext = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!ctxRef.current) ctxRef.current = new AudioContext()
    const actx = ctxRef.current
    if (!sourceRef.current) {
      const source = actx.createMediaElementSource(audio)
      const analyser = actx.createAnalyser()
      analyser.fftSize = 4096
      analyser.smoothingTimeConstant = 0.75
      source.connect(analyser)
      analyser.connect(actx.destination)
      sourceRef.current = source
      analyserRef.current = analyser
    }
    if (actx.state === 'suspended') actx.resume()
  }, [])

  // -- Audio context setup --
  const playTrack = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= playlist.length) return
    const t = playlist[idx]
    setError(null)
    setTrackIdx(idx)
    trackIdxRef.current = idx // eagerly sync for event handlers
    timeOffsetRef.current = 0 // reset seek offset for new track
    fullDurationRef.current = 0
    setCurrentTime(0)
    setDuration(0)

    // Helper: skip to next track on failure (respects shuffle, limited retries)
    const autoSkip = () => {
      skipCountRef.current++
      if (skipCountRef.current >= MAX_CONSECUTIVE_SKIPS) {
        setError('Too many consecutive failures — stopping playback')
        setPlaying(false)
        skipCountRef.current = 0
        return
      }
      const ni = nextIndexRef.current?.(idx) ?? -1
      if (ni !== idx && ni >= 0) {
        playTrackRef.current?.(ni)
      } else {
        setPlaying(false)
      }
    }

    // Resolve YouTube stream URL on demand
    // Re-resolve if src is a media:// token (may be expired)
    let audioSrc = t.src
    const isYouTube = !!t.videoUrl
    const needsResolve = t.videoUrl && (!t.src || t.src.startsWith('media://'))
    if (isYouTube) setResolving(true)
    if (needsResolve) {
      try {
        setResolving(true)
        const result = await window.api.getStreamUrl(t.videoUrl!, audioQuality)
        if (!result.success) {
          setError(`Could not resolve: ${result.error}`)
          setResolving(false)
          autoSkip()
          return
        }
        audioSrc = result.mediaUrl!
        // Cache the proxy URL on the track
        setPlaylist((prev) => prev.map((tr, i) => i === idx ? { ...tr, src: audioSrc } : tr))
      } catch (err: any) {
        setError(`Resolve failed: ${err.message}`)
        setResolving(false)
        autoSkip()
        return
      } finally {
        setResolving(false)
      }
    }

    // Local file: register for media:// protocol streaming.
    // Only call registerLocalFile when we don't already have a cached
    // media:// URL — re-registering every time is wasteful because it
    // invokes prepareForPlayback (which probes + potentially FFmpeg-extracts).
    if (!audioSrc && !isYouTube && t.filePath) {
      try {
        setResolving(true)
        audioSrc = await window.api.registerLocalFile(t.filePath)
        setPlaylist((prev) => prev.map((tr, i) => i === idx ? { ...tr, src: audioSrc, isBlob: false } : tr))
      } catch (err2: any) {
        setError(`Failed to load file: ${err2.message}`)
        setResolving(false)
        autoSkip()
        return
      } finally {
        setResolving(false)
      }
    }

    if (!audioSrc) {
      setError('No audio source available')
      autoSkip()
      return
    }

    ytRetryRef.current = null

    // Use the persistent <audio> element — no new Audio() needed
    const audio = audioRef.current
    if (!audio) return

    audio.pause()

    // Only set crossOrigin for remote HTTP(S) URLs
    // Blob, media://, and YouTube CDN don't serve CORS headers
    const isLocal = t.isBlob || isYouTube || audioSrc.startsWith('media://')
    if (isLocal) audio.removeAttribute('crossOrigin')
    else audio.crossOrigin = 'anonymous'
    audio.volume = volume

    // Initialize AudioContext & analyser graph (once, requires user gesture)
    ensureAudioContext()

    // Setting a new src automatically aborts the previous load (fires code 1, ignored)
    audio.src = audioSrc
    audio.play().then(() => {
      setResolving(false)
      // If track was paused during transfer, pause immediately after starting
      if (pendingPauseRef.current) {
        pendingPauseRef.current = false
        audio.pause()
        setPlaying(false)
      } else {
        setPlaying(true)
      }
    }).catch((err) => {
      setResolving(false)
      // Ignore AbortError — happens when play() is interrupted by a new track load
      if (err.name === 'AbortError') return
      // Only set error if the error-event handler hasn't already set a more
      // specific message — avoids overwriting "Format not supported: X"
      setError((prev) => prev || `Playback failed: ${err.message}`)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, volume, audioQuality, ensureAudioContext])

  // Keep ref in sync so deferred auto-play can call the latest playTrack
  // IMPORTANT: This effect MUST run before the deferred auto-play effect below
  useEffect(() => { playTrackRef.current = playTrack }, [playTrack])

  // -- Deferred auto-play: runs AFTER playTrackRef is updated --
  useEffect(() => {
    const idx = pendingPlayRef.current
    if (idx !== null && idx < playlist.length) {
      pendingPlayRef.current = null
      // Use microtask to ensure playTrackRef is fully synced
      Promise.resolve().then(() => {
        playTrackRef.current?.(idx)
      })
    }
  }, [playlist.length, playlistVersion])

  // -- Persistent audio element event listeners (set up once, read from refs) --
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onLoadedMetadata = (): void => {
      // WebM served via chunked 206 may initially report Infinity;
      // accept only finite values here — durationchange catches updates.
      if (Number.isFinite(audio.duration)) {
        const realDur = audio.duration + timeOffsetRef.current
        // Only update fullDuration if this is a fresh track (no seek offset yet)
        // or if the full duration hasn't been set
        if (fullDurationRef.current === 0) fullDurationRef.current = realDur
        setDuration(fullDurationRef.current)
      }
      skipCountRef.current = 0
      if (pendingSeekRef.current != null) {
        audio.currentTime = pendingSeekRef.current
        pendingSeekRef.current = null
      }
    }

    const onDurationChange = (): void => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const realDur = audio.duration + timeOffsetRef.current
        if (fullDurationRef.current === 0) fullDurationRef.current = realDur
        setDuration(fullDurationRef.current)
      }
    }

    const onTimeUpdate = (): void => {
      if (!seekingRef.current) setCurrentTime(audio.currentTime + timeOffsetRef.current)
    }

    // 'seeking' / 'seeked' events from the browser — guard against
    // timeupdate firing mid-seek which snaps the slider back.
    const onSeeking = (): void => { seekingRef.current = true }
    const onSeeked = (): void => {
      seekingRef.current = false
      setCurrentTime(audio.currentTime + timeOffsetRef.current)
    }

    const onEnded = (): void => {
      setPlaying(false)
      const curRepeat = repeatRef.current
      const curPlaylist = playlistRef.current
      const curIdx = trackIdxRef.current

      if (curRepeat === 'one') {
        audio.currentTime = 0
        audio.play().then(() => setPlaying(true))
      } else if (curRepeat === 'all' || curIdx < curPlaylist.length - 1) {
        const ni = nextIndexRef.current?.(curIdx) ?? -1
        if (ni >= 0) playTrackRef.current?.(ni)
      }
    }

    const onError = (): void => {
      const curIdx = trackIdxRef.current
      const pl = playlistRef.current
      if (curIdx < 0 || curIdx >= pl.length) return
      const t = pl[curIdx]
      const isYT = !!t.videoUrl

      const code = audio.error?.code
      const msg = audio.error?.message || 'Unknown error'

      // MEDIA_ERR_ABORTED (1) — seek or source change interrupted; not a real error
      if (code === 1) return

      if (isYT) {
        setPlaylist((prev) => prev.map((tr, i) => i === curIdx ? { ...tr, src: '' } : tr))
        if (ytRetryRef.current !== t.id) {
          ytRetryRef.current = t.id
          setError(null)
          playTrackRef.current?.(curIdx)
          return
        }
      }

      if (!isYT && t.filePath && localRetryRef.current !== t.id) {
        localRetryRef.current = t.id
        setPlaylist((prev) => prev.map((tr, i) => i === curIdx ? { ...tr, src: '' } : tr))
        setError(null)
        window.api.clearPlaybackCache(t.filePath)
          .catch(() => {})
          .finally(() => { playTrackRef.current?.(curIdx) })
        return
      }

      const unsupported = code === 4
      const errMsg = unsupported
        ? `Format not supported: ${getExt(t.name).toUpperCase()}`
        : `Playback error (code ${code}): ${msg}`
      setError(errMsg)
      setPlaying(false)
      ytRetryRef.current = null
      localRetryRef.current = null

      if (isYT || unsupported) {
        skipCountRef.current++
        if (skipCountRef.current < MAX_CONSECUTIVE_SKIPS) {
          const ni = nextIndexRef.current?.(curIdx) ?? -1
          if (ni !== curIdx && ni >= 0) playTrackRef.current?.(ni)
        } else {
          skipCountRef.current = 0
        }
      }
    }

    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('durationchange', onDurationChange)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('seeking', onSeeking)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('durationchange', onDurationChange)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('seeking', onSeeking)
      audio.removeEventListener('seeked', onSeeked)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // One-time setup — all values read from refs

  // -- Pre-extract local files sequentially so playback is instant --
  // Uses a version counter to cancel previous batches when new tracks arrive.
  const preloadTracks = useCallback((tracks: Track[]) => {
    const version = ++preloadVersionRef.current
    const toPreload = tracks.filter((t) => t.filePath && !t.src)
    if (toPreload.length === 0) return
    ;(async () => {
      for (const t of toPreload) {
        if (preloadVersionRef.current !== version) break
        try {
          const src = await window.api.registerLocalFile(t.filePath!)
          if (preloadVersionRef.current === version) {
            setPlaylist((prev) =>
              prev.map((tr) => tr.id === t.id && !tr.src ? { ...tr, src } : tr)
            )
          }
        } catch {} // ignore preload failures
      }
    })()
  }, [])

  // -- Add tracks from File objects --
  const addFiles = useCallback((files: File[]) => {
    const newTracks: Track[] = []
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      if (!MEDIA_EXTS.includes(ext)) continue
      const fp = window.api.getFilePath(f)
      // Prefer native path → resolved lazily via media:// on play (no memory limit)
      // Fall back to blob URL only when no native path available
      newTracks.push({
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        src: fp ? '' : URL.createObjectURL(f),
        isBlob: !fp,
        filePath: fp || undefined
      })
    }
    if (newTracks.length === 0) return
    const startIdx = playlist.length // index of first new track
    setPlaylist((prev) => [...prev, ...newTracks])
    setShowPlaylist(true)
    preloadTracks(newTracks)
    // Auto-play first added track
    schedulePlay(startIdx)
  }, [playlist.length, trackIdx, playTrack, schedulePlay, preloadTracks])

  // -- Add track from URL --
  const addUrl = useCallback(async () => {
    const url = urlInput.trim()
    if (!url) return
    try { new URL(url) } catch { setError('Invalid URL'); return }

    // YouTube or other yt-dlp-supported URL
    if (isYouTubeUrl(url)) {
      setResolving(true)
      setError(null)
      try {
        const result = await window.api.resolvePlaylist(url)
        if (!result.success) {
          setError(`Playlist resolve failed: ${result.error}`)
          setResolving(false)
          return
        }
        const newTracks: Track[] = result.entries.map((e: any) => ({
          id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: e.title || e.id,
          src: '', // resolved lazily on play
          isBlob: false,
          videoUrl: e.url
        }))
        if (newTracks.length === 0) {
          setError('No tracks found in playlist')
          setResolving(false)
          return
        }
        const startIdx = playlist.length
        setPlaylist((prev) => [...prev, ...newTracks])
        setUrlInput('')
        setShowUrlInput(false)
        setShowPlaylist(true)
        // Always auto-play first new track
        schedulePlay(startIdx)
      } catch (err: any) {
        setError(`Resolve failed: ${err.message}`)
      } finally {
        setResolving(false)
      }
      return
    }

    // Direct audio URL
    const name = url.split('/').pop()?.split('?')[0] || url
    const newTrack: Track = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: decodeURIComponent(name),
      src: url,
      isBlob: false
    }
    const startIdx = playlist.length
    setPlaylist((prev) => [...prev, newTrack])
    setUrlInput('')
    setShowUrlInput(false)
    setShowPlaylist(true)
    schedulePlay(startIdx)
  }, [urlInput, playlist.length, playTrack, schedulePlay])

  // -- Native DOM drop handling (more reliable than React synthetic events in Electron) --
  const addFilesRef = useRef(addFiles)
  useEffect(() => { addFilesRef.current = addFiles }, [addFiles])
  const playlistLenRef = useRef(playlist.length)
  useEffect(() => { playlistLenRef.current = playlist.length }, [playlist.length])
  const schedulePlayRef = useRef(schedulePlay)
  useEffect(() => { schedulePlayRef.current = schedulePlay }, [schedulePlay])

  const dragCounter = useRef(0)

  useEffect(() => {
    const el = dropRef.current
    if (!el) return

    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      dragCounter.current++
      setDragging(true)
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      dragCounter.current--
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setDragging(false)
      }
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setDragging(false)

      // Check for dropped URLs (from browser)
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || ''
      if (text && /^https?:\/\//.test(text.trim())) {
        const url = text.trim().split('\n')[0]
        const name = url.split('/').pop()?.split('?')[0] || url
        const newTrack: Track = {
          id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: decodeURIComponent(name),
          src: url,
          isBlob: false
        }
        const startIdx = playlistLenRef.current
        setPlaylist((prev) => [...prev, newTrack])
        setShowPlaylist(true)
        schedulePlayRef.current(startIdx)
        return
      }

      // Local files
      const files = Array.from(e.dataTransfer?.files || [])
      if (files.length > 0) addFilesRef.current(files)
    }

    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [])

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = MEDIA_EXTS.map((e) => `.${e}`).join(',')
    input.onchange = () => {
      const files = Array.from(input.files || [])
      if (files.length > 0) addFiles(files)
    }
    input.click()
  }, [addFiles])

  // -- Playback controls --
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()
    if (audio.paused) {
      audio.play()
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }, [])

  const playNext = useCallback(() => {
    if (playlist.length === 0) return
    skipCountRef.current = 0
    playTrack(nextIndex(trackIdx))
  }, [playlist.length, trackIdx, nextIndex, playTrack])

  const playPrev = useCallback(() => {
    if (playlist.length === 0) return
    // If more than 3s in, restart current track
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0
      return
    }
    skipCountRef.current = 0
    playTrack(nextIndex(trackIdx, -1))
  }, [playlist.length, trackIdx, nextIndex, playTrack])

  const removeTrack = useCallback((idx: number) => {
    setPlaylist((prev) => {
      const t = prev[idx]
      if (t.isBlob) URL.revokeObjectURL(t.src)
      return prev.filter((_, i) => i !== idx)
    })
    if (idx === trackIdx) {
      // Stop playback if removing current
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load() }
      setPlaying(false)
      setTrackIdx(-1)
    } else if (idx < trackIdx) {
      setTrackIdx((prev) => prev - 1)
    }
  }, [trackIdx])

  const moveTrack = useCallback((from: number, to: number) => {
    if (from === to) return
    setPlaylist((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
    setTrackIdx((prev) => {
      if (prev === from) return to
      if (from < prev && to >= prev) return prev - 1
      if (from > prev && to <= prev) return prev + 1
      return prev
    })
  }, [])

  const clearPlaylist = useCallback(() => {
    playlist.forEach((t) => { if (t.isBlob) URL.revokeObjectURL(t.src) })
    setPlaylist([])
    setTrackIdx(-1)
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load() }
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setError(null)
    setUrlInput('')
    setShowUrlInput(false)
    setResolving(false)
    setShowHistory(false)
    skipCountRef.current = 0
    ytRetryRef.current = null
  }, [playlist])

  // Load all media files from a folder into the playlist
  const loadFolder = useCallback(async (folderPath: string, mode: 'replace' | 'append') => {
    try {
      const result = await window.api.browseDirectory(folderPath)
      if (!result.success) return
      const audioFiles = result.entries.filter(
        (e: any) => !e.isDirectory && MEDIA_EXTS.includes(e.ext.replace('.', ''))
      )
      if (audioFiles.length === 0) return
      const newTracks: Track[] = audioFiles.map((f) => ({
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        src: '',
        isBlob: false,
        filePath: f.path
      }))
      if (mode === 'replace') {
        playlist.forEach((t) => { if (t.isBlob) URL.revokeObjectURL(t.src) })
        if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute('src'); audioRef.current.load() }
        setPlaying(false)
        setTrackIdx(-1)
        setPlaylist(newTracks)
        preloadTracks(newTracks)
        schedulePlay(0)
      } else {
        const startIdx = playlist.length
        setPlaylist((prev) => [...prev, ...newTracks])
        preloadTracks(newTracks)
        if (trackIdx < 0) schedulePlay(startIdx)
      }
    } catch { /* ignored */ }
  }, [playlist, trackIdx, schedulePlay, preloadTracks])

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')
  }, [])

  const seekStart = useCallback(() => { seekingRef.current = true }, [])

  const seekEnd = useCallback((e: React.ChangeEvent<HTMLInputElement> | React.MouseEvent | React.TouchEvent) => {
    const audio = audioRef.current
    if (!audio) return
    // Read the absolute target time from the slider
    const absTime = 'target' in e && (e.target as HTMLInputElement).value != null
      ? parseFloat((e.target as HTMLInputElement).value)
      : audio.currentTime + timeOffsetRef.current

    // Check if this track was extracted via FFmpeg (non-native extension)
    const pl = playlistRef.current
    const idx = trackIdxRef.current
    const t = idx >= 0 && idx < pl.length ? pl[idx] : null
    const ext = t?.filePath ? getExt(t.filePath) : ''
    const needsSeekExtract = t?.filePath && !t.videoUrl && ext && !DIRECT_AUDIO_EXTS.has(ext)

    if (needsSeekExtract && absTime > 1) {
      // Re-extract audio starting at the seek position — the extracted
      // file plays from t=0, timeOffsetRef compensates in the UI.
      seekingRef.current = true
      setResolving(true)
      window.api.seekLocalFile(t.filePath!, absTime)
        .then((src) => {
          timeOffsetRef.current = absTime
          audio.pause()
          audio.src = src
          audio.play().then(() => setPlaying(true)).catch(() => {})
        })
        .catch(() => {
          // Fallback: try normal seek
          audio.currentTime = absTime - timeOffsetRef.current
        })
        .finally(() => {
          seekingRef.current = false
          setResolving(false)
        })
    } else {
      // Normal seek for browser-native files or small seeks
      audio.currentTime = absTime - timeOffsetRef.current
      // seekingRef is cleared by the browser 'seeked' event
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value)
    seekingRef.current = true // keep slider at user position
    setCurrentTime(val)
  }, [])

  const changeVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const el = audioRef.current
      if (el) {
        el.pause()
        el.removeAttribute('src')
        el.load()
      }
      playlist.forEach((t) => { if (t.isBlob) URL.revokeObjectURL(t.src) })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cycleVisMode = useCallback(() => {
    const modes: VisMode[] = ['dmt', 'space', 'milkdrop', 'plasma', 'bars', 'wave', 'circular', 'horizon']
    setVisMode((m) => modes[(modes.indexOf(m) + 1) % modes.length])
  }, [])

  const cycleQuality = useCallback(() => {
    const levels: AudioQuality[] = ['best', 'good', 'low']
    setAudioQuality((q) => {
      const next = levels[(levels.indexOf(q) + 1) % levels.length]
      // Invalidate cached YouTube stream URLs so next play re-resolves with new quality
      setPlaylist((prev) => prev.map((t) => t.videoUrl ? { ...t, src: '' } : t))
      return next
    })
  }, [])

  // -- State serialization for popout transfer --
  const getSerializableState = useCallback(() => {
    return {
      playlist: playlist.map((t) => ({
        ...t,
        // Blob URLs are per-process and can't be transferred.
        // YouTube cached media:// tokens point to CDN URLs that may expire;
        // clear them so the target window gets fresh resolution.
        src: t.isBlob || t.videoUrl ? '' : t.src
      })),
      trackIdx,
      currentTime: audioRef.current?.currentTime ?? currentTime,
      volume,
      visMode,
      audioQuality,
      shuffle,
      repeat,
      showPlaylist,
      playing
    }
  }, [playlist, trackIdx, currentTime, volume, visMode, audioQuality, shuffle, repeat, showPlaylist, playing])

  const restoreFromState = useCallback(async (state: any) => {
    if (!state) return
    if (state.playlist) {
      // Re-register local/blob tracks: clear src so playTrack lazily loads them;
      // YouTube tracks get src cleared so playTrack re-resolves on demand.
      const restored: Track[] = state.playlist.map((t: Track) => {
        // Local file with a filePath → clear src so playTrack reads fresh blob
        if (t.filePath && !t.videoUrl) {
          return { ...t, src: '', isBlob: false }
        }
        // YouTube tracks: ensure src is cleared so playTrack re-resolves
        if (t.videoUrl) {
          return { ...t, src: '' }
        }
        return t
      })
      setPlaylist(restored)
      preloadTracks(restored)
    }
    if (state.volume != null) setVolume(state.volume)
    if (state.visMode) setVisMode(state.visMode)
    if (state.audioQuality) setAudioQuality(state.audioQuality)
    if (state.shuffle != null) setShuffle(state.shuffle)
    if (state.repeat) setRepeat(state.repeat)
    if (state.showPlaylist != null) setShowPlaylist(state.showPlaylist)
    // Prepare seek position and pause state for seamless transition
    if (state.currentTime > 0) pendingSeekRef.current = state.currentTime
    if (state.playing === false) pendingPauseRef.current = true
    // Play the track after state is restored
    if (state.trackIdx >= 0 && state.playlist?.length > 0) {
      schedulePlay(state.trackIdx)
    }
  }, [schedulePlay, preloadTracks])

  // -- Popout: receive state when this window opens as popout --
  useEffect(() => {
    if (!popout) return
    const cleanup = window.api.onReceivePlayerState?.((state: any) => {
      restoreFromState(state)
    })
    // Pull pending state in case the push from did-finish-load arrived
    // before React mounted and registered the listener above.
    window.api.getPlayerState?.().then((state: any) => {
      if (state) restoreFromState(state)
    })
    return cleanup
  }, [popout, restoreFromState])

  // -- Popout: send state back before window closes --
  useEffect(() => {
    if (!popout) return
    const handler = (): void => {
      window.api.returnPlayerState(getSerializableState())
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [popout, getSerializableState])

  // -- Main window: listen for returned state from popout --
  useEffect(() => {
    if (popout) return
    // On mount, check if popout is already open
    window.api.isPopout?.().then((isOpen) => {
      if (isOpen) setIsPoppedOut(true)
    })
    const cleanupState = window.api.onReceivePlayerState?.((state: any) => {
      setIsPoppedOut(false)
      restoreFromState(state)
    })
    const cleanupClosed = window.api.onPopoutClosed?.(() => {
      setIsPoppedOut(false)
    })
    return () => {
      cleanupState?.()
      cleanupClosed?.()
    }
  }, [popout, restoreFromState])

  // -- Popout button handler --
  const handlePopout = useCallback(() => {
    const state = getSerializableState()
    state.showPlaylist = false // start popout with playlist collapsed
    // Stop local playback
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
    }
    setPlaying(false)
    setIsPoppedOut(true)
    window.api.popoutPlayer(state)
  }, [getSerializableState])

  const loadHistory = useCallback(async () => {
    try {
      const history = await window.api.getUrlHistory()
      setUrlHistory(history)
    } catch { /* ignore */ }
  }, [])

  const loadFromHistory = useCallback((url: string) => {
    setUrlInput(url)
    setShowHistory(false)
    setShowUrlInput(true)
  }, [])

  const removeFromHistory = useCallback(async (url: string) => {
    try {
      const updated = await window.api.removeUrlHistory(url)
      setUrlHistory(updated)
    } catch { /* ignore */ }
  }, [])

  // -- Popout: compact layout --
  if (popout) {
    return (
      <div className="flex flex-col animate-fade-in h-full min-w-0">
        <audio ref={audioRef} className="hidden" preload="auto" />
        {/* Canvas area with playlist overlay */}
        <div
          ref={dropRef}
          className={`flex-1 relative rounded-xl overflow-hidden border transition-colors ${
            dragging ? 'border-accent-400 bg-accent-500/5' : 'border-white/5 bg-surface-900/50'
          }`}
        >
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          {!track && !error && !resolving && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-2">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
                <p className="text-surface-500 text-xs">Drop files or add tracks</p>
              </div>
            </div>
          )}
          {resolving && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-6 h-6 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {error && (
            <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 rounded-lg bg-red-500/15 border border-red-500/20 text-[10px] text-red-300">
              {error}
            </div>
          )}
          {dragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm pointer-events-none z-10">
              <p className="text-accent-300 font-semibold text-sm">Drop to add</p>
            </div>
          )}
          {/* Playlist overlay — slides up from bottom of canvas */}
          {showPlaylist && (
            <div className="absolute inset-0 z-20 flex flex-col bg-surface-950/85 backdrop-blur-sm" onClick={() => setShowPlaylist(false)}>
              <div className="flex-1 min-h-0" onClick={(e) => e.stopPropagation()}>
              <PlaylistPanel
                playlist={playlist}
                trackIdx={trackIdx}
                playing={playing}
                onPlayTrack={(idx) => { skipCountRef.current = 0; playTrack(idx) }}
                onRemoveTrack={removeTrack}
                onMoveTrack={moveTrack}
                onClearPlaylist={clearPlaylist}
                onLoadFolder={loadFolder}
              />
              </div>
            </div>
          )}
        </div>

        {/* Compact transport */}
        <div className="pt-2 shrink-0">
          <PopoutTransport
            track={track}
            playing={playing}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            shuffle={shuffle}
            repeat={repeat}
            visMode={visMode}
            showPlaylist={showPlaylist}
            playlistLength={playlist.length}
            onTogglePlay={togglePlay}
            onPlayNext={playNext}
            onPlayPrev={playPrev}
            onSeek={seek}
            onSeekStart={seekStart}
            onSeekEnd={seekEnd}
            onVolumeChange={changeVolume}
            onToggleShuffle={() => setShuffle((s) => !s)}
            onCycleRepeat={cycleRepeat}
            onCycleVisMode={cycleVisMode}
            onTogglePlaylist={() => setShowPlaylist((v) => !v)}
            onFileSelect={handleFileSelect}
          />
        </div>
      </div>
    )
  }

  // -- Main window layout --
  return (
    <div
      className="flex animate-fade-in gap-4 relative h-full min-w-0"
    >
      <audio ref={audioRef} className="hidden" preload="auto" />
      {/* Popped-out overlay */}
      {isPoppedOut && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-950/90 backdrop-blur-sm rounded-2xl">
          <div className="text-center space-y-4">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-accent-400">
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Player is Popped Out</h2>
              <p className="text-sm text-surface-400">Playback is controlled from the pop-out window.<br/>Close it to restore the player here.</p>
            </div>
          </div>
        </div>
      )}
      {/* Main column — always full width */}
      <div className="flex flex-col flex-1 gap-3 min-w-0">
        <PlayerHeader
          track={track}
          popout={false}
          isPoppedOut={isPoppedOut}
          visMode={visMode}
          audioQuality={audioQuality}
          showPlaylist={showPlaylist}
          playlistLength={playlist.length}
          onCycleQuality={cycleQuality}
          onCycleVisMode={cycleVisMode}
          onTogglePlaylist={() => setShowPlaylist((v) => !v)}
          onToggleUrlInput={() => setShowUrlInput((v) => !v)}
          onPopout={handlePopout}
          onFileSelect={handleFileSelect}
          onClearPlaylist={clearPlaylist}
        />

        {showUrlInput && (
          <UrlInputBar
            urlInput={urlInput}
            resolving={resolving}
            showHistory={showHistory}
            urlHistory={urlHistory}
            onUrlChange={setUrlInput}
            onAddUrl={addUrl}
            onToggleHistory={() => setShowHistory((v) => !v)}
            onLoadHistory={loadHistory}
            onLoadFromHistory={loadFromHistory}
            onRemoveFromHistory={removeFromHistory}
          />
        )}

        {/* Canvas area */}
        <div
          ref={dropRef}
          className={`flex-1 relative rounded-2xl overflow-hidden border transition-colors ${
            dragging ? 'border-accent-400 bg-accent-500/5' : 'border-white/5 bg-surface-900/50'
          }`}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
          />
          {!track && !error && !resolving && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
                <p className="text-surface-500 text-sm">Drop audio files, paste YouTube links, or browse</p>
              </div>
            </div>
          )}
          {resolving && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-accent-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-surface-400 text-sm">Preparing audio...</p>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute bottom-3 left-3 right-3 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/20 text-xs text-red-300">
              {error}
            </div>
          )}
          {dragging && (
            <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm pointer-events-none z-10">
              <p className="text-accent-300 font-semibold text-lg">Drop to add</p>
            </div>
          )}
          {/* Playlist overlay — floats on top of the canvas */}
          {showPlaylist && (
            <>
              <div className="absolute inset-0 z-[19]" onClick={() => setShowPlaylist(false)} />
              <div className="absolute top-0 right-0 bottom-0 z-20 w-64 max-w-[60%]">
              <PlaylistPanel
                playlist={playlist}
                trackIdx={trackIdx}
                playing={playing}
                onPlayTrack={(idx) => { skipCountRef.current = 0; playTrack(idx) }}
                onRemoveTrack={removeTrack}
                onMoveTrack={moveTrack}
                onClearPlaylist={clearPlaylist}
                onLoadFolder={loadFolder}
              />
              </div>
            </>
          )}
        </div>

        <TransportBar
          track={track}
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          shuffle={shuffle}
          repeat={repeat}
          playlistLength={playlist.length}
          onTogglePlay={togglePlay}
          onPlayNext={playNext}
          onPlayPrev={playPrev}
          onSeek={seek}
          onSeekStart={seekStart}
          onSeekEnd={seekEnd}
          onVolumeChange={changeVolume}
          onToggleShuffle={() => setShuffle((s) => !s)}
          onCycleRepeat={cycleRepeat}
        />
      </div>
    </div>
  )
}
