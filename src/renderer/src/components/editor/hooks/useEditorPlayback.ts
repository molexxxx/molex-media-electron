/**
 * @module components/editor/hooks/useEditorPlayback
 * @description Hook managing media element playback, audio analyser wiring, and waveform canvas.
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { EditorClip } from '../../../stores/editorStore'
import { useEditorStore } from '../../../stores/editorStore'

/**
 * Manages media element playback, audio context / analyser wiring,
 * and the audio-only canvas waveform visualizer for the editor.
 */
export function useEditorPlayback(clip: EditorClip | null) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const a2AudioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)
  const lastSrcRef = useRef<string>('')
  const wantPlayRef = useRef(false)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  // -- Audio analyser setup --
  useEffect(() => {
    if (!clip || clip.isVideo) return
    const audio = audioRef.current
    if (!audio) return

    const src = clip.previewUrl || clip.objectUrl
    // Only reload if URL changed (split clips share the same URL)
    if (audio.src !== src && src) audio.src = src
    audio.currentTime = clip.inPoint

    // Auto-play if advancing from a different-source clip
    if (wantPlayRef.current) {
      wantPlayRef.current = false
      if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()
      audio.play().catch(() => setPlaying(false))
    }

    if (!ctxRef.current) ctxRef.current = new AudioContext()
    const actx = ctxRef.current

    if (!sourceRef.current) {
      sourceRef.current = actx.createMediaElementSource(audio)
    }
    const source = sourceRef.current
    try { source.disconnect() } catch { /* ok */ }

    const analyser = actx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser)
    analyser.connect(actx.destination)
    analyserRef.current = analyser

    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [clip?.id, clip?.loadingState]) // re-run when loading finishes (element appears in DOM)

  // -- Video source --
  useEffect(() => {
    if (!clip || !clip.isVideo || clip.loadingState !== 'ready') return
    const video = videoRef.current
    if (!video) return
    const src = clip.previewUrl || clip.objectUrl
    if (!src) return
    // Only reload media if the URL actually changed (split clips share the same URL)
    if (lastSrcRef.current !== src) {
      video.preload = 'auto'
      video.src = src
      lastSrcRef.current = src
    }
    // Always seek to the clip's inPoint (handles clip switches within same source)
    const seekOnce = (): void => {
      video.currentTime = clip.inPoint
      if (wantPlayRef.current) {
        wantPlayRef.current = false
        video.play().catch(() => setPlaying(false))
      }
    }
    if (video.readyState >= 1) seekOnce()
    else video.addEventListener('loadedmetadata', seekOnce, { once: true })
    const onError = (): void => {
      console.error('[useEditorPlayback] video load error:', video.error?.message, 'src:', src)
    }
    video.addEventListener('error', onError)
    return () => {
      video.removeEventListener('loadedmetadata', seekOnce)
      video.removeEventListener('error', onError)
    }
  }, [clip?.id, clip?.loadingState, clip?.previewUrl, clip?.objectUrl]) // re-run when clip becomes ready or src changes

  // -- Sync media element when inPoint moves ahead of playhead --
  useEffect(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return
    // Tolerance for video keyframe imprecision — browser may land on the
    // nearest keyframe before inPoint, so only re-seek if clearly behind.
    const tol = clip.isVideo ? 0.15 : 0
    if (el.currentTime < clip.inPoint - tol) {
      el.currentTime = clip.inPoint
      setCurrentTime(clip.inPoint)
    }
  }, [clip?.id, clip?.inPoint]) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Sync media element when outPoint shrinks behind playhead --
  useEffect(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return
    if (el.currentTime >= clip.outPoint) {
      el.pause()
      el.currentTime = clip.outPoint
      setCurrentTime(clip.outPoint)
      setPlaying(false)
    }
  }, [clip?.id, clip?.outPoint]) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Sync volume and playback rate --
  const volume = useEditorStore((s) => s.volume)
  const playbackRate = useEditorStore((s) => s.playbackRate)
  const clipVolume = clip?.clipVolume ?? 1
  const clipMuted = clip?.clipMuted ?? false

  useEffect(() => {
    const el = clip?.isVideo ? videoRef.current : audioRef.current
    if (el) el.volume = clipMuted ? 0 : volume * clipVolume
  }, [clip?.id, clip?.isVideo, volume, clipVolume, clipMuted])

  useEffect(() => {
    const el = clip?.isVideo ? videoRef.current : audioRef.current
    if (el) el.playbackRate = playbackRate
  }, [clip?.id, clip?.isVideo, playbackRate])

  // -- A2 audio source loading --
  const a2Url = clip?.audioReplacement?.objectUrl
  useEffect(() => {
    const a2 = a2AudioRef.current
    if (!a2) return
    if (!a2Url) {
      a2.pause()
      a2.removeAttribute('src')
      a2.load()
      return
    }
    a2.src = a2Url
  }, [a2Url])

  // -- A2 volume sync --
  const a2Volume = clip?.audioReplacement?.volume ?? 1
  const a2Muted = clip?.audioReplacement?.muted ?? false
  useEffect(() => {
    const a2 = a2AudioRef.current
    if (a2 && a2.src) a2.volume = a2Muted ? 0 : volume * a2Volume
  }, [a2Volume, a2Muted, volume])

  // -- A2 playback rate sync --
  useEffect(() => {
    const a2 = a2AudioRef.current
    if (a2 && a2.src) a2.playbackRate = playbackRate
  }, [playbackRate])

  // -- Playback time tracking --
  useEffect(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return

    // Tolerance for video — browser may seek to nearest keyframe slightly
    // before inPoint. Without tolerance, the handler re-seeks endlessly.
    const tol = clip.isVideo ? 0.15 : 0
    const onTime = (): void => {
      setCurrentTime(el.currentTime)
      if (el.currentTime < clip.inPoint - tol) {
        el.currentTime = clip.inPoint
      } else if (el.currentTime >= clip.outPoint) {
        // Auto-advance to the next clip/segment if available
        const state = useEditorStore.getState()
        // Guard: if store already advanced past this clip, bail
        if (state.clips[state.activeIdx]?.id !== clip.id) return

        const nextIdx = state.activeIdx + 1
        if (nextIdx < state.clips.length) {
          const nextClip = state.clips[nextIdx]
          const nextSrc = nextClip.previewUrl || nextClip.objectUrl
          const curSrc = clip.previewUrl || clip.objectUrl
          // Pause A2 of current clip before advancing
          const a2 = a2AudioRef.current
          if (a2 && !a2.paused) a2.pause()
          // Switch active clip without resetting playing state
          useEditorStore.setState({ activeIdx: nextIdx })

          if (nextSrc === curSrc && nextClip.isVideo === clip.isVideo) {
            // Same source — seek and keep playing
            el.currentTime = nextClip.inPoint
            setCurrentTime(nextClip.inPoint)
          } else {
            // Different source — pause, let source effects reload + auto-play
            el.pause()
            wantPlayRef.current = true
          }
        } else {
          // Last clip — stop
          el.pause()
          el.currentTime = clip.outPoint
          const a2 = a2AudioRef.current
          if (a2 && !a2.paused) a2.pause()
          setPlaying(false)
        }
      }

      // A2 sync — read fresh state from store so offset/volume changes
      // after drag operations are always respected
      const a2 = a2AudioRef.current
      if (a2 && !el.paused) {
        const freshState = useEditorStore.getState()
        const freshClip = freshState.clips.find((c) => c.id === clip.id)
        const ar = freshClip?.audioReplacement
        if (ar && a2.src) {
          const rel = el.currentTime - clip.inPoint
          const a2Time = rel - ar.offset
          if (a2Time >= 0 && a2Time < ar.duration) {
            // Keep A2 volume/rate in sync with latest values
            a2.volume = ar.muted ? 0 : freshState.volume * ar.volume
            a2.playbackRate = freshState.playbackRate
            if (a2.paused) {
              a2.currentTime = a2Time
              a2.play().catch(() => {})
            } else if (Math.abs(a2.currentTime - a2Time) > 0.3) {
              // Drift correction
              a2.currentTime = a2Time
            }
          } else if (!a2.paused) {
            a2.pause()
          }
        } else if (!a2.paused) {
          // A2 was removed from this clip (e.g. moved to another clip)
          a2.pause()
        }
      }
    }
    const onEnd = (): void => {
      const a2 = a2AudioRef.current
      if (a2 && !a2.paused) a2.pause()
      setPlaying(false)
    }

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('ended', onEnd)
    }
  }, [clip?.id, clip?.loadingState, clip?.inPoint, clip?.outPoint])

  // -- Canvas waveform visualizer (audio-only) --
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !clip || clip.isVideo) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let running = true
    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)

    const freqData = new Uint8Array(1024)
    const smoothBars = new Float32Array(80).fill(0)

    const draw = (): void => {
      if (!running) return
      rafRef.current = requestAnimationFrame(draw)

      const W = canvas.width / (window.devicePixelRatio || 1)
      const H = canvas.height / (window.devicePixelRatio || 1)
      ctx.fillStyle = '#0a0a0f'
      ctx.fillRect(0, 0, W, H)

      const analyser = analyserRef.current
      if (!analyser) return

      analyser.getByteFrequencyData(freqData)

      const count = 80
      const gap = 2
      const barW = (W - gap * (count - 1)) / count

      for (let i = 0; i < count; i++) {
        const fi = Math.floor(Math.pow(i / count, 1.5) * freqData.length * 0.5)
        const raw = freqData[fi] || 0
        smoothBars[i] += (raw - smoothBars[i]) * 0.25
        const h = (smoothBars[i] / 255) * H * 0.85
        const x = i * (barW + gap)
        const y = H - h

        const grad = ctx.createLinearGradient(x, H, x, y)
        grad.addColorStop(0, 'rgba(139, 92, 246, 0.9)')
        grad.addColorStop(0.6, 'rgba(168, 85, 247, 0.6)')
        grad.addColorStop(1, 'rgba(59, 130, 246, 0.4)')
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.roundRect(x, y, barW, h, [2, 2, 0, 0])
        ctx.fill()
      }
    }
    draw()

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [clip?.id, clip?.isVideo])

  // -- Controls --
  const togglePlay = useCallback(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return

    if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()

    if (el.paused) {
      if (el.currentTime >= clip.outPoint || el.currentTime < clip.inPoint) {
        el.currentTime = clip.inPoint
        setCurrentTime(clip.inPoint)
      }
      // Read latest clip state from the store so mute/volume changes are
      // respected even when the callback reference hasn't been recreated.
      const store = useEditorStore.getState()
      const fresh = store.clips.find((c) => c.id === clip.id)
      const isMuted = fresh?.clipMuted ?? clip.clipMuted
      const vol = fresh?.clipVolume ?? clip.clipVolume
      el.volume = isMuted ? 0 : store.volume * vol
      // Browser handles play-after-pending-seek correctly; no need to await seeked
      el.play().catch(() => setPlaying(false))
      // Start A2 if in range
      const a2 = a2AudioRef.current
      const ar = fresh?.audioReplacement ?? clip.audioReplacement
      if (a2 && ar && a2.src) {
        a2.volume = ar.muted ? 0 : store.volume * ar.volume
        a2.playbackRate = store.playbackRate
        const rel = el.currentTime - clip.inPoint
        const a2Time = rel - ar.offset
        if (a2Time >= 0 && a2Time < ar.duration) {
          a2.currentTime = a2Time
          a2.play().catch(() => {})
        }
      }
      setPlaying(true)
    } else {
      el.pause()
      const a2 = a2AudioRef.current
      if (a2 && !a2.paused) a2.pause()
      setPlaying(false)
    }
  }, [clip?.id, clip?.inPoint, clip?.outPoint, clip?.isVideo, clip?.audioReplacement])

  const seek = useCallback((time: number) => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (el) el.currentTime = time
    setCurrentTime(time)
    // Sync A2 — read fresh state to respect offset changes
    const a2 = a2AudioRef.current
    const freshClip = useEditorStore.getState().clips.find((c) => c.id === clip.id)
    const ar = freshClip?.audioReplacement
    if (a2 && ar && a2.src) {
      const rel = time - clip.inPoint
      const a2Time = rel - ar.offset
      if (a2Time >= 0 && a2Time < ar.duration) {
        a2.currentTime = a2Time
      } else if (!a2.paused) {
        a2.pause()
      }
    }
  }, [clip])

  return { playing, currentTime, videoRef, audioRef, a2AudioRef, canvasRef, togglePlay, seek }
}
