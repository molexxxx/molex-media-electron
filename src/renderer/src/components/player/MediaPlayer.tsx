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
import { type Track, AUDIO_EXTS, isYouTubeUrl } from './types'
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
  const MAX_CONSECUTIVE_SKIPS = 5

  // Refs for values needed inside audio event closures (avoids stale closures)
  const repeatRef = useRef(repeat)
  const playlistRef = useRef(playlist)
  const nextIndexRef = useRef<((current: number, direction?: 1 | -1) => number) | null>(null)
  useEffect(() => { repeatRef.current = repeat }, [repeat])
  useEffect(() => { playlistRef.current = playlist }, [playlist])

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

  // -- Audio context setup --
  const playTrack = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= playlist.length) return
    const t = playlist[idx]
    setError(null)
    setTrackIdx(idx)

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

    if (!audioSrc) {
      setError('No audio source available')
      autoSkip()
      return
    }

    // Successful start — reset skip counter
    skipCountRef.current = 0

    // Tear down previous — remove src BEFORE creating new element
    // to avoid the old error listener firing on the empty-src load
    const prev = audioRef.current
    if (prev) {
      prev.pause()
      prev.removeAttribute('src')
      prev.load() // reset without triggering network error
    }

    const audio = new Audio()
    // Only set crossOrigin for non-blob, non-YouTube, non-local URLs
    // YouTube CDN (googlevideo.com) does not serve CORS headers
    // media:// is our local protocol
    if (!t.isBlob && !isYouTube && !audioSrc.startsWith('media://')) audio.crossOrigin = 'anonymous'
    audio.volume = volume
    audioRef.current = audio

    if (!ctxRef.current) {
      ctxRef.current = new AudioContext()
    }
    const actx = ctxRef.current

    if (sourceRef.current) {
      try { sourceRef.current.disconnect() } catch { /* ok */ }
      sourceRef.current = null
    }

    const source = actx.createMediaElementSource(audio)
    const analyser = actx.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    analyser.connect(actx.destination)
    sourceRef.current = source
    analyserRef.current = analyser

    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration)
      // Restore seek position from state transfer (popout transition)
      if (pendingSeekRef.current != null) {
        audio.currentTime = pendingSeekRef.current
        pendingSeekRef.current = null
      }
    })
    audio.addEventListener('timeupdate', () => setCurrentTime(audio.currentTime))
    audio.addEventListener('ended', () => {
      setPlaying(false)
      // Use refs for up-to-date values (this closure captures nothing stale)
      const curRepeat = repeatRef.current
      const curPlaylist = playlistRef.current
      const curNextIndex = nextIndexRef.current

      if (curRepeat === 'one') {
        audio.currentTime = 0
        audio.play().then(() => setPlaying(true))
      } else if (curRepeat === 'all' || idx < curPlaylist.length - 1) {
        const ni = curNextIndex?.(idx) ?? -1
        if (ni >= 0) playTrackRef.current?.(ni)
      }
    })
    audio.addEventListener('error', () => {
      const code = audio.error?.code
      const msg = audio.error?.message || 'Unknown error'
      setError(`Audio load failed (code ${code}): ${msg}`)
      setPlaying(false)
      // Clear cached URL for YouTube tracks so re-clicking will re-resolve
      if (isYouTube) {
        setPlaylist((prev) => prev.map((tr, i) => i === idx ? { ...tr, src: '' } : tr))
      }
      // Auto-skip to next track
      skipCountRef.current++
      if (skipCountRef.current < MAX_CONSECUTIVE_SKIPS) {
        const ni = nextIndexRef.current?.(idx) ?? -1
        if (ni !== idx && ni >= 0) playTrackRef.current?.(ni)
      } else {
        skipCountRef.current = 0
      }
    })

    audio.src = audioSrc
    if (actx.state === 'suspended') actx.resume()
    audio.play().then(() => {
      // If track was paused during transfer, pause immediately after starting
      if (pendingPauseRef.current) {
        pendingPauseRef.current = false
        audio.pause()
        setPlaying(false)
      } else {
        setPlaying(true)
      }
    }).catch((err) => {
      setError(`Playback failed: ${err.message}`)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, volume, audioQuality])

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

  // -- Add tracks from File objects --
  const addFiles = useCallback((files: File[]) => {
    const newTracks: Track[] = []
    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || ''
      if (!AUDIO_EXTS.includes(ext)) continue
      newTracks.push({
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        src: URL.createObjectURL(f),
        isBlob: true
      })
    }
    if (newTracks.length === 0) return
    const startIdx = playlist.length // index of first new track
    setPlaylist((prev) => [...prev, ...newTracks])
    setShowPlaylist(true)
    // Auto-play first added track
    schedulePlay(startIdx)
  }, [playlist.length, trackIdx, playTrack, schedulePlay])

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
    input.accept = AUDIO_EXTS.map((e) => `.${e}`).join(',')
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
    playTrack(nextIndex(trackIdx))
  }, [playlist.length, trackIdx, nextIndex, playTrack])

  const playPrev = useCallback(() => {
    if (playlist.length === 0) return
    // If more than 3s in, restart current track
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0
      return
    }
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
  }, [playlist])

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => r === 'off' ? 'all' : r === 'all' ? 'one' : 'off')
  }, [])

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = parseFloat(e.target.value)
  }, [])

  const changeVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.removeAttribute('src')
        audioRef.current.load()
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
        // Blob URLs are per-process and can't be transferred
        src: t.isBlob ? '' : t.src
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

  const restoreFromState = useCallback((state: any) => {
    if (!state) return
    if (state.playlist) setPlaylist(state.playlist)
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
  }, [schedulePlay])

  // -- Popout: receive state when this window opens as popout --
  useEffect(() => {
    if (!popout) return
    const cleanup = window.api.onReceivePlayerState?.((state: any) => {
      restoreFromState(state)
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
        {/* Canvas area */}
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
        </div>

        {/* Compact transport */}
        <div className="pt-2">
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
            onVolumeChange={changeVolume}
            onToggleShuffle={() => setShuffle((s) => !s)}
            onCycleRepeat={cycleRepeat}
            onCycleVisMode={cycleVisMode}
            onTogglePlaylist={() => setShowPlaylist((v) => !v)}
            onFileSelect={handleFileSelect}
          />
        </div>

        {/* Playlist stacks below */}
        {showPlaylist && (
          <PlaylistPanel
            playlist={playlist}
            trackIdx={trackIdx}
            playing={playing}
            vertical
            onPlayTrack={(idx) => { skipCountRef.current = 0; playTrack(idx) }}
            onRemoveTrack={removeTrack}
            onMoveTrack={moveTrack}
            onClearPlaylist={clearPlaylist}
          />
        )}
      </div>
    )
  }

  // -- Main window layout --
  return (
    <div
      className="flex animate-fade-in gap-4 relative h-full"
    >
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
      {/* Main column */}
      <div className="flex flex-col flex-1 gap-4 min-w-0">
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
                <p className="text-surface-400 text-sm">Resolving playlist...</p>
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
          onVolumeChange={changeVolume}
          onToggleShuffle={() => setShuffle((s) => !s)}
          onCycleRepeat={cycleRepeat}
        />
      </div>

      {/* Main view: playlist sits beside the player column */}
      {showPlaylist && (
        <PlaylistPanel
          playlist={playlist}
          trackIdx={trackIdx}
          playing={playing}
          onPlayTrack={(idx) => { skipCountRef.current = 0; playTrack(idx) }}
          onRemoveTrack={removeTrack}
          onMoveTrack={moveTrack}
          onClearPlaylist={clearPlaylist}
        />
      )}
    </div>
  )
}
