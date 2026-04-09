/**
 * @module components/player/hooks/useVisualizer
 * @description Canvas-based audio visualization engine.
 *
 * Sets up the canvas render loop, performs FFT analysis with an
 * attack/release envelope follower, detects beats using the energy
 * variance method, and dispatches to one of 8 draw modes per frame.
 */

import { useEffect, type RefObject } from 'react'
import type { VisMode, AudioFeatures, SpaceState, MilkdropState, PlasmaState } from '../../../visualizations'
import {
  getBandEnergy,
  drawIdle,
  drawBars,
  drawWave,
  drawCircular,
  drawHorizon,
  drawDMT,
  drawSpace,
  drawMilkdrop,
  drawPlasma
} from '../../../visualizations'

export function useVisualizer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  analyserRef: RefObject<AnalyserNode | null>,
  visMode: VisMode
): void {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let running = true
    const resizeCanvas = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resizeCanvas()
    const ro = new ResizeObserver(resizeCanvas)
    ro.observe(canvas.parentElement!)

    const freqData = new Uint8Array(2048)
    const timeData = new Uint8Array(4096)
    const smoothBars = new Float32Array(128).fill(0)
    const smoothFreq = new Float32Array(2048).fill(0)
    const smoothTime = new Float32Array(4096).fill(128)
    const peakBars = new Float32Array(128).fill(0)
    const peakDecay = new Float32Array(128).fill(0)

    // Beat detection state (energy variance method - Frédéric Patin)
    const BEAT_HISTORY = 43
    const bassHistory: number[] = []
    const midHistory: number[] = []
    let beatIntensity = 0
    let midBeatIntensity = 0
    let lastBeatTime = 0
    let frameBeatCount = 0

    const audio: AudioFeatures = {
      sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
      overall: 0, beat: 0, midBeat: 0, isBeat: false, beatCount: 0
    }

    // Persistent visualizer state
    const dmtState = {
      hueBase: 0,
      tunnelDepth: 0,
      particles: Array.from({ length: 180 }, () => ({
        angle: Math.random() * Math.PI * 2,
        radius: Math.random() * 0.6 + 0.05,
        speed: Math.random() * 0.015 + 0.003,
        hueOff: Math.random() * 360,
        size: Math.random() * 2.5 + 0.5,
        layer: Math.floor(Math.random() * 3),
        brightness: Math.random() * 0.5 + 0.5
      })),
      orbs: Array.from({ length: 8 }, () => ({
        x: (Math.random() - 0.5) * 0.6,
        y: (Math.random() - 0.5) * 0.6,
        vx: (Math.random() - 0.5) * 0.003,
        vy: (Math.random() - 0.5) * 0.003,
        radius: Math.random() * 15 + 8,
        hue: Math.random() * 360,
        pulse: Math.random() * Math.PI * 2,
        life: 1
      })),
      eyes: Array.from({ length: 6 }, (_, i) => ({
        orbitRadius: 0.18 + i * 0.07,
        angle: (i / 6) * Math.PI * 2,
        speed: 0.008 + Math.random() * 0.006,
        size: 10 + Math.random() * 8,
        pupilPhase: Math.random() * Math.PI * 2,
        irisHue: Math.random() * 360,
        blinkPhase: Math.random() * Math.PI * 2
      })),
      kaleidoAngle: 0,
      wingPhase: 0,
      shockwaves: [],
      trailCanvas: null as HTMLCanvasElement | null,
      trailCtx: null as CanvasRenderingContext2D | null
    }

    const spaceState: SpaceState = {
      stars: Array.from({ length: 500 }, () => ({
        x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2,
        z: Math.random(), speed: Math.random() * 0.004 + 0.001,
        brightness: Math.random(), hue: Math.random() * 60 + 200
      })),
      comets: Array.from({ length: 4 }, () => ({
        x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2,
        vx: (Math.random() - 0.5) * 0.02, vy: (Math.random() - 0.5) * 0.02,
        life: Math.random(), hue: Math.random() * 360,
        trail: []
      })),
      debris: Array.from({ length: 80 }, () => ({
        angle: Math.random() * Math.PI * 2, dist: 0.08 + Math.random() * 0.45,
        speed: (Math.random() * 0.006 + 0.002) * (Math.random() > 0.5 ? 1 : -1),
        size: 0.5 + Math.random() * 2, hue: 200 + Math.random() * 80,
        brightness: 0.3 + Math.random() * 0.7
      })),
      nebulae: Array.from({ length: 50 }, () => ({
        x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5,
        radius: Math.random() * 0.15 + 0.05, hue: Math.random() * 360,
        phase: Math.random() * Math.PI * 2
      })),
      rotation: 0, warpSpeed: 0
    }

    const milkdropState: MilkdropState = {
      waveHistory: [], presetPhase: 0, morphT: 0,
      rot: 0, zoom: 1, hueShift: 0,
      feedbackCanvas: null, feedbackCtx: null
    }

    const plasmaState: PlasmaState = {
      t: 0, hueBase: 0,
      blobs: Array.from({ length: 6 }, () => ({
        x: Math.random() * Math.PI * 2, y: Math.random() * Math.PI * 2,
        sx: Math.random() * 0.01 + 0.005, sy: Math.random() * 0.01 + 0.005,
        hue: Math.random() * 360
      }))
    }

    const draw = (now: number): void => {
      if (!running) return
      requestAnimationFrame(draw)

      const W = canvas.width / (window.devicePixelRatio || 1)
      const H = canvas.height / (window.devicePixelRatio || 1)

      const analyser = analyserRef.current
      if (!analyser) {
        ctx.fillStyle = '#0a0a0f'
        ctx.fillRect(0, 0, W, H)
        drawIdle(ctx, W, H)
        return
      }

      analyser.getByteFrequencyData(freqData)
      analyser.getByteTimeDomainData(timeData)

      // Attack/release envelope follower
      for (let i = 0; i < freqData.length; i++) {
        const raw = freqData[i]
        if (raw > smoothFreq[i]) {
          smoothFreq[i] += (raw - smoothFreq[i]) * 0.3
        } else {
          smoothFreq[i] += (raw - smoothFreq[i]) * 0.12
        }
        freqData[i] = smoothFreq[i]
      }
      for (let i = 0; i < timeData.length; i++) {
        const raw = timeData[i]
        const delta = Math.abs(raw - 128) - Math.abs(smoothTime[i] - 128)
        if (delta > 0) {
          smoothTime[i] += (raw - smoothTime[i]) * 0.3
        } else {
          smoothTime[i] += (raw - smoothTime[i]) * 0.12
        }
        timeData[i] = smoothTime[i]
      }

      // Perceptual frequency bands
      audio.sub = getBandEnergy(freqData, 1, 6)
      audio.bass = getBandEnergy(freqData, 6, 24)
      audio.lowMid = getBandEnergy(freqData, 24, 46)
      audio.mid = getBandEnergy(freqData, 46, 186)
      audio.highMid = getBandEnergy(freqData, 186, 400)
      audio.treble = getBandEnergy(freqData, 400, 1000)
      audio.overall = (audio.sub * 0.8 + audio.bass + audio.lowMid +
        audio.mid + audio.highMid * 0.8 + audio.treble * 0.6) / 4.7

      // Beat detection
      const instantBass = audio.bass + audio.sub * 0.5
      bassHistory.push(instantBass)
      if (bassHistory.length > BEAT_HISTORY) bassHistory.shift()
      const avgBass = bassHistory.reduce((a, b) => a + b, 0) / bassHistory.length

      const instantMid = audio.mid + audio.highMid * 0.3
      midHistory.push(instantMid)
      if (midHistory.length > BEAT_HISTORY) midHistory.shift()
      const avgMid = midHistory.reduce((a, b) => a + b, 0) / midHistory.length

      audio.isBeat = instantBass > avgBass * 1.4 && instantBass > 0.12 &&
        (now - lastBeatTime) > 150
      if (audio.isBeat) {
        beatIntensity = 1.0
        lastBeatTime = now
        frameBeatCount++
      }
      beatIntensity *= 0.92
      audio.beat = beatIntensity
      audio.beatCount = frameBeatCount

      if (instantMid > avgMid * 1.5 && instantMid > 0.1) {
        midBeatIntensity = 1.0
      }
      midBeatIntensity *= 0.94
      audio.midBeat = midBeatIntensity

      switch (visMode) {
        case 'dmt':
          drawDMT(ctx, freqData, timeData, W, H, dmtState, audio)
          break
        case 'space':
          drawSpace(ctx, freqData, timeData, W, H, spaceState, audio)
          break
        case 'milkdrop':
          drawMilkdrop(ctx, freqData, timeData, W, H, milkdropState, audio)
          break
        case 'plasma':
          drawPlasma(ctx, freqData, timeData, W, H, plasmaState, audio)
          break
        case 'bars':
          ctx.fillStyle = '#0a0a0f'
          ctx.fillRect(0, 0, W, H)
          drawBars(ctx, freqData, smoothBars, peakBars, peakDecay, W, H, audio)
          break
        case 'wave':
          ctx.fillStyle = '#0a0a0f'
          ctx.fillRect(0, 0, W, H)
          drawWave(ctx, timeData, W, H, audio)
          break
        case 'circular':
          ctx.fillStyle = '#0a0a0f'
          ctx.fillRect(0, 0, W, H)
          drawCircular(ctx, freqData, timeData, W, H, audio)
          break
        case 'horizon':
          ctx.fillStyle = '#0a0a0f'
          ctx.fillRect(0, 0, W, H)
          drawHorizon(ctx, freqData, timeData, W, H, audio)
          break
      }

      // Universal beat flash
      if (audio.beat > 0.2) {
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        ctx.fillStyle = `rgba(180, 140, 255, ${audio.beat * 0.05})`
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
    }

    draw(0)

    return () => {
      running = false
      ro.disconnect()
    }
  }, [visMode])
}
