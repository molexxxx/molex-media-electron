/**
 * @module components/player/hooks/useVisualizer
 * @description Canvas-based audio visualization engine.
 *
 * Analysis pipeline per frame:
 * 1. Raw FFT + time-domain capture from AnalyserNode (fftSize 4096).
 * 2. Attack/release envelope follower smooths both domains.
 * 3. A-weighted RMS band extraction (sub → treble) via Bark-aligned boundaries.
 * 4. Spectral centroid (brightness) and RMS level.
 * 5. Half-wave-rectified spectral flux for onset / beat detection.
 * 6. Beat detection via adaptive threshold on spectral flux (replaces
 *    simple energy-variance: flux correlates far better with perceptual
 *    onsets - Bello et al. 2005, Dixon 2006).
 * 7. Dispatch to active draw mode.
 */

import { useEffect, type RefObject } from 'react'
import type { VisMode, AudioFeatures, SpaceState, MilkdropState, PlasmaState, RainState } from '../../../visualizations'
import {
  getBandEnergy,
  getAWeights,
  spectralFlux,
  spectralCentroid,
  rmsLevel,
  freqToBin,
  drawIdle,
  drawBars,
  drawWave,
  drawHorizon,
  drawDMT,
  drawSpace,
  drawMilkdrop,
  drawPlasma,
  drawRain
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

    // Previous-frame spectrum for spectral flux calculation
    const prevSpectrum = new Float32Array(2048).fill(0)

    // Beat detection state - spectral flux adaptive threshold
    // Uses a running median of recent flux values; a beat is detected when
    // the current flux exceeds the median by a multiplier, with a minimum
    // refractory period between beats.
    const FLUX_HISTORY = 48 // ~0.8 s at 60 fps
    const fluxHistory: number[] = []
    const midFluxHistory: number[] = []
    let beatIntensity = 0
    let midBeatIntensity = 0
    let lastBeatTime = 0
    let frameBeatCount = 0

    // A-weight cache ref (populated on first analyser read)
    let aWeights: Float32Array | null = null
    let cachedSampleRate = 0

    // Bark-aligned band bin boundaries (populated once we know sample rate)
    let binSub: [number, number] = [1, 6]
    let binBass: [number, number] = [6, 24]
    let binLowMid: [number, number] = [24, 46]
    let binMid: [number, number] = [46, 186]
    let binHighMid: [number, number] = [186, 400]
    let binTreble: [number, number] = [400, 1000]

    function recalcBins(sampleRate: number): void {
      if (sampleRate === cachedSampleRate) return
      cachedSampleRate = sampleRate
      aWeights = getAWeights(2048, sampleRate)
      binSub = [freqToBin(20, 2048, sampleRate), freqToBin(60, 2048, sampleRate)]
      binBass = [freqToBin(60, 2048, sampleRate), freqToBin(250, 2048, sampleRate)]
      binLowMid = [freqToBin(250, 2048, sampleRate), freqToBin(500, 2048, sampleRate)]
      binMid = [freqToBin(500, 2048, sampleRate), freqToBin(2000, 2048, sampleRate)]
      binHighMid = [freqToBin(2000, 2048, sampleRate), freqToBin(6000, 2048, sampleRate)]
      binTreble = [freqToBin(6000, 2048, sampleRate), freqToBin(20000, 2048, sampleRate)]
    }

    const audio: AudioFeatures = {
      sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
      overall: 0, beat: 0, midBeat: 0, isBeat: false, beatCount: 0,
      centroid: 0, brightness: 0, flux: 0, rms: 0
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
      stars: Array.from({ length: 2400 }, (_, i) => {
        const tier = i % 3
        const speed = tier === 0 ? Math.random() * 0.0004 + 0.0001
                    : tier === 1 ? Math.random() * 0.001  + 0.0004
                    :              Math.random() * 0.003  + 0.001
        const baseSize = tier === 0 ? 0.3 + Math.random() * 0.6
                       : tier === 1 ? 0.5 + Math.random() * 1.2
                       :              0.8 + Math.random() * 2.0
        // Distribute along 4 spiral arms with scatter
        const armIdx  = Math.floor(Math.random() * 4)
        const armBase = armIdx * Math.PI * 0.5
        const r       = 0.05 + Math.random() * 1.3
        const spiralA = armBase + r * Math.PI * 2.5 + (Math.random() - 0.5) * 0.8
        return {
          x: Math.cos(spiralA) * r, y: Math.sin(spiralA) * r,
          z: Math.random(), speed,
          brightness: 0.4 + Math.random() * 0.6,
          hue: Math.random() * 70 + 195,
          baseSize
        }
      }),
      rotation: 0, warpSpeed: 0, nebulaPhase: 0, coreGlow: 0.5
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

    const rainState: RainState = {
      t: 0,
      fontSize: 14,
      columns: []
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

      // Recalc bin boundaries on sample-rate change
      recalcBins(analyser.context.sampleRate)

      analyser.getByteFrequencyData(freqData)
      analyser.getByteTimeDomainData(timeData)

      // ---- Attack/release envelope follower ----
      // Attack = 0.3 (fast response to transients)
      // Release = 0.12 (smooth decay avoids flicker)
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

      // ---- A-weighted perceptual band energies ----
      audio.sub = getBandEnergy(freqData, binSub[0], binSub[1], aWeights)
      audio.bass = getBandEnergy(freqData, binBass[0], binBass[1], aWeights)
      audio.lowMid = getBandEnergy(freqData, binLowMid[0], binLowMid[1], aWeights)
      audio.mid = getBandEnergy(freqData, binMid[0], binMid[1], aWeights)
      audio.highMid = getBandEnergy(freqData, binHighMid[0], binHighMid[1], aWeights)
      audio.treble = getBandEnergy(freqData, binTreble[0], binTreble[1], aWeights)

      // Perceptual overall - weighted sum reflecting equal-loudness sensitivity
      // Mid-range bands get full weight; sub/treble are attenuated
      audio.overall = Math.min(1,
        (audio.sub * 0.6 + audio.bass * 1.0 + audio.lowMid * 1.0 +
         audio.mid * 1.0 + audio.highMid * 0.9 + audio.treble * 0.5) / 4.0
      )

      // ---- Spectral centroid & brightness ----
      audio.centroid = spectralCentroid(freqData, 2048, cachedSampleRate || 44100)
      // Normalise to 0-1: centroid typically in 200-8000 Hz for music
      audio.brightness = Math.min(1, Math.max(0, (audio.centroid - 200) / 6000))

      // ---- RMS level ----
      audio.rms = rmsLevel(timeData)

      // ---- Spectral flux (onset strength) ----
      // Bass-focused flux (bins for 20-300 Hz)
      const bassFlux = spectralFlux(freqData, prevSpectrum, binSub[0], binBass[1])
      // Mid-focused flux (bins for 500-6000 Hz)
      const midFlux = spectralFlux(freqData, prevSpectrum, binMid[0], binHighMid[1])
      // Full-spectrum flux
      audio.flux = spectralFlux(freqData, prevSpectrum, 1, Math.min(1000, freqData.length))

      // Store current spectrum for next frame
      for (let i = 0; i < freqData.length; i++) {
        prevSpectrum[i] = freqData[i] / 255
      }

      // ---- Beat detection (adaptive spectral-flux threshold) ----
      // Push current flux into history
      fluxHistory.push(bassFlux)
      if (fluxHistory.length > FLUX_HISTORY) fluxHistory.shift()

      midFluxHistory.push(midFlux)
      if (midFluxHistory.length > FLUX_HISTORY) midFluxHistory.shift()

      // Adaptive threshold: mean + 1.4× std-deviation of recent flux
      const avgFlux = fluxHistory.reduce((a, b) => a + b, 0) / fluxHistory.length
      let fluxVar = 0
      for (const f of fluxHistory) fluxVar += (f - avgFlux) * (f - avgFlux)
      const fluxStd = Math.sqrt(fluxVar / fluxHistory.length)
      const beatThreshold = avgFlux + fluxStd * 1.4

      audio.isBeat = bassFlux > beatThreshold && bassFlux > 0.04 &&
        (now - lastBeatTime) > 150
      if (audio.isBeat) {
        beatIntensity = 1.0
        lastBeatTime = now
        frameBeatCount++
      }
      beatIntensity *= 0.92
      audio.beat = beatIntensity
      audio.beatCount = frameBeatCount

      // Mid beat (snares / claps / hi-hats)
      const avgMidFlux = midFluxHistory.reduce((a, b) => a + b, 0) / midFluxHistory.length
      let midFluxVar = 0
      for (const f of midFluxHistory) midFluxVar += (f - avgMidFlux) * (f - avgMidFlux)
      const midFluxStd = Math.sqrt(midFluxVar / midFluxHistory.length)
      if (midFlux > avgMidFlux + midFluxStd * 1.5 && midFlux > 0.03) {
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
          drawWave(ctx, freqData, timeData, W, H, audio)
          break
        case 'horizon':
          ctx.fillStyle = '#0a0a0f'
          ctx.fillRect(0, 0, W, H)
          drawHorizon(ctx, freqData, timeData, W, H, audio)
          break
        case 'rain':
          drawRain(ctx, freqData, timeData, W, H, rainState, audio)
          break
      }
    }

    draw(0)

    return () => {
      running = false
      ro.disconnect()
    }
  }, [visMode])
}
