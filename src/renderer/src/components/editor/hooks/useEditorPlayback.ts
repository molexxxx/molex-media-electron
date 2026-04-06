/**
 * @module components/editor/hooks/useEditorPlayback
 * @description Hook managing media element playback, audio analyser wiring, and waveform canvas.
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import type { Clip } from '../types'

/**
 * Manages media element playback, audio context / analyser wiring,
 * and the audio-only canvas waveform visualizer for the editor.
 */
export function useEditorPlayback(clip: Clip | null) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  // -- Audio analyser setup --
  useEffect(() => {
    if (!clip || clip.isVideo) return
    const audio = audioRef.current
    if (!audio) return

    audio.src = clip.previewUrl || clip.objectUrl
    audio.currentTime = clip.inPoint

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
  }, [clip?.id])

  // -- Video source --
  useEffect(() => {
    if (!clip || !clip.isVideo) return
    const video = videoRef.current
    if (!video) return
    video.preload = 'auto'
    video.src = clip.previewUrl || clip.objectUrl
    const seekOnce = (): void => { video.currentTime = clip.inPoint }
    if (video.readyState >= 1) seekOnce()
    else video.addEventListener('loadedmetadata', seekOnce, { once: true })
    return () => { video.removeEventListener('loadedmetadata', seekOnce) }
  }, [clip?.id])

  // -- Playback time tracking --
  useEffect(() => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (!el) return

    const onTime = (): void => {
      setCurrentTime(el.currentTime)
      if (el.currentTime >= clip.outPoint) {
        el.pause()
        el.currentTime = clip.outPoint
        setPlaying(false)
      }
    }
    const onEnd = (): void => setPlaying(false)

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('ended', onEnd)
    }
  }, [clip?.id, clip?.outPoint])

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
      }
      el.play().catch(() => setPlaying(false))
      setPlaying(true)
    } else {
      el.pause()
      setPlaying(false)
    }
  }, [clip])

  const seek = useCallback((time: number) => {
    if (!clip) return
    const el = clip.isVideo ? videoRef.current : audioRef.current
    if (el && !el.seeking) el.currentTime = time
    setCurrentTime(time)
  }, [clip])

  return { playing, currentTime, videoRef, audioRef, canvasRef, togglePlay, seek }
}
