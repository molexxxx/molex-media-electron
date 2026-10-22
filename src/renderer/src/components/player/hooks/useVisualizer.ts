/**
 * @module components/player/hooks/useVisualizer
 * @description The visualization engine. Each frame it reads the analyser's spectrum and waveform, smooths both with
 * an attack and release follower, measures A-weighted energy in six bands, the spectral centroid, and the RMS level,
 * detects bass and mid beats from the half-wave-rectified spectral flux against an adaptive threshold (Bello et al.
 * 2005, Dixon 2006), and draws the chosen visualization in the token palette. While the stage shows the picture or
 * nothing plays, it paints the ground only.
 */

import { useEffect, type RefObject } from 'react'
import type { AudioFeatures, MilkdropState, PlasmaState, RainState, SpaceState, VisMode } from '../../../visualizations'
import {
  css,
  drawBars,
  drawDMT,
  drawHorizon,
  drawMilkdrop,
  drawPlasma,
  drawRain,
  drawSpace,
  drawWave,
  freqToBin,
  getAWeights,
  getBandEnergy,
  readVizPalette,
  rmsLevel,
  spectralCentroid,
  spectralFlux
} from '../../../visualizations'

/** Frames of spectral flux the beat threshold looks back over, about 0.8 s at 60 fps. */
const FLUX_HISTORY = 48

/** The band edges in Hz: sub, bass, low mid, mid, high mid, treble. */
const BAND_EDGES = [20, 60, 250, 500, 2000, 6000, 20000] as const

/** The follower's attack and release per frame. */
const ATTACK = 0.3
const RELEASE = 0.12

function follow(target: Uint8Array, smooth: Float32Array, centered: boolean): void
{
  for (let i = 0; i < target.length; i++)
  {
    const raw = target[i]
    const rising = centered ? Math.abs(raw - 128) > Math.abs(smooth[i] - 128) : raw > smooth[i]
    smooth[i] += (raw - smooth[i]) * (rising ? ATTACK : RELEASE)
    target[i] = smooth[i]
  }
}

function meanAndSpread(values: readonly number[]): { mean: number, spread: number }
{
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  let variance = 0
  for (const value of values)
  {
    variance += (value - mean) * (value - mean)
  }
  return { mean, spread: Math.sqrt(variance / values.length) }
}

function pushBounded(history: number[], value: number): void
{
  history.push(value)
  if (history.length > FLUX_HISTORY)
  {
    history.shift()
  }
}

function dmtStart(): Parameters<typeof drawDMT>[5]
{
  return {
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
    trailCanvas: null,
    trailCtx: null
  }
}

function spaceStart(): SpaceState
{
  return {
    stars: Array.from({ length: 2400 }, (_, i) =>
    {
      const tier = i % 3
      const speed = tier === 0 ? Math.random() * 0.0004 + 0.0001 : tier === 1 ? Math.random() * 0.001 + 0.0004 : Math.random() * 0.003 + 0.001
      const baseSize = tier === 0 ? 0.3 + Math.random() * 0.6 : tier === 1 ? 0.5 + Math.random() * 1.2 : 0.8 + Math.random() * 2.0
      const armBase = Math.floor(Math.random() * 4) * Math.PI * 0.5
      const r = 0.05 + Math.random() * 1.3
      const spiral = armBase + r * Math.PI * 2.5 + (Math.random() - 0.5) * 0.8
      return {
        x: Math.cos(spiral) * r,
        y: Math.sin(spiral) * r,
        z: Math.random(),
        speed,
        brightness: 0.4 + Math.random() * 0.6,
        hue: Math.random() * 70 + 195,
        baseSize
      }
    }),
    rotation: 0,
    warpSpeed: 0,
    nebulaPhase: 0,
    coreGlow: 0.5
  }
}

/** Draws the visualization on `canvasRef` from `analyserRef` while `active` is not false. */
export function useVisualizer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  analyserRef: RefObject<AnalyserNode | null>,
  visMode: VisMode,
  active?: RefObject<boolean>
): void
{
  useEffect(() =>
  {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: false }) ?? null
    if (!canvas || !ctx)
    {
      return undefined
    }
    let running = true
    const palette = readVizPalette()
    const ground = css(palette.ground)
    const resize = (): void =>
    {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect)
      {
        return
      }
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    if (canvas.parentElement)
    {
      observer.observe(canvas.parentElement)
    }

    const freqData = new Uint8Array(2048)
    const timeData = new Uint8Array(4096)
    const smoothFreq = new Float32Array(2048).fill(0)
    const smoothTime = new Float32Array(4096).fill(128)
    const smoothBars = new Float32Array(128).fill(0)
    const peakBars = new Float32Array(128).fill(0)
    const peakDecay = new Float32Array(128).fill(0)
    const prevSpectrum = new Float32Array(2048).fill(0)
    const bassHistory: number[] = []
    const midHistory: number[] = []
    let beatIntensity = 0
    let midBeatIntensity = 0
    let lastBeatTime = 0
    let beatCount = 0
    let aWeights: Float32Array | null = null
    let sampleRate = 0
    let bins: Array<[number, number]> = [[1, 6], [6, 24], [24, 46], [46, 186], [186, 400], [400, 1000]]

    const audio: AudioFeatures = {
      sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
      overall: 0, beat: 0, midBeat: 0, isBeat: false, beatCount: 0,
      centroid: 0, brightness: 0, flux: 0, rms: 0
    }
    const dmtState = dmtStart()
    const spaceState = spaceStart()
    const milkdropState: MilkdropState = { waveHistory: [], presetPhase: 0, morphT: 0, rot: 0, zoom: 1, hueShift: 0, feedbackCanvas: null, feedbackCtx: null }
    const plasmaState: PlasmaState = {
      t: 0,
      hueBase: 0,
      blobs: Array.from({ length: 6 }, () => ({
        x: Math.random() * Math.PI * 2,
        y: Math.random() * Math.PI * 2,
        sx: Math.random() * 0.01 + 0.005,
        sy: Math.random() * 0.01 + 0.005,
        hue: Math.random() * 360
      }))
    }
    const rainState: RainState = { t: 0, fontSize: 14, columns: [] }

    const measure = (analyser: AnalyserNode, now: number): void =>
    {
      const rate = analyser.context.sampleRate
      if (rate !== sampleRate)
      {
        sampleRate = rate
        aWeights = getAWeights(2048, rate)
        bins = BAND_EDGES.slice(0, -1).map((low, i) => [freqToBin(low, 2048, rate), freqToBin(BAND_EDGES[i + 1], 2048, rate)])
      }
      analyser.getByteFrequencyData(freqData)
      analyser.getByteTimeDomainData(timeData)
      follow(freqData, smoothFreq, false)
      follow(timeData, smoothTime, true)

      const [sub, bass, lowMid, mid, highMid, treble] = bins.map(([from, to]) => getBandEnergy(freqData, from, to, aWeights))
      Object.assign(audio, { sub, bass, lowMid, mid, highMid, treble })
      audio.overall = Math.min(1, (sub * 0.6 + bass + lowMid + mid + highMid * 0.9 + treble * 0.5) / 4.0)
      audio.centroid = spectralCentroid(freqData, 2048, sampleRate || 44100)
      audio.brightness = Math.min(1, Math.max(0, (audio.centroid - 200) / 6000))
      audio.rms = rmsLevel(timeData)

      const bassFlux = spectralFlux(freqData, prevSpectrum, bins[0][0], bins[1][1])
      const midFlux = spectralFlux(freqData, prevSpectrum, bins[3][0], bins[4][1])
      audio.flux = spectralFlux(freqData, prevSpectrum, 1, Math.min(1000, freqData.length))
      for (let i = 0; i < freqData.length; i++)
      {
        prevSpectrum[i] = freqData[i] / 255
      }

      pushBounded(bassHistory, bassFlux)
      pushBounded(midHistory, midFlux)
      const bassStats = meanAndSpread(bassHistory)
      audio.isBeat = bassFlux > bassStats.mean + bassStats.spread * 1.4 && bassFlux > 0.04 && now - lastBeatTime > 150
      if (audio.isBeat)
      {
        beatIntensity = 1
        lastBeatTime = now
        beatCount++
      }
      beatIntensity *= 0.92
      audio.beat = beatIntensity
      audio.beatCount = beatCount
      const midStats = meanAndSpread(midHistory)
      if (midFlux > midStats.mean + midStats.spread * 1.5 && midFlux > 0.03)
      {
        midBeatIntensity = 1
      }
      midBeatIntensity *= 0.94
      audio.midBeat = midBeatIntensity
    }

    const draw = (now: number): void =>
    {
      if (!running)
      {
        return
      }
      requestAnimationFrame(draw)
      const dpr = window.devicePixelRatio || 1
      const W = canvas.width / dpr
      const H = canvas.height / dpr
      const analyser = analyserRef.current
      if (!analyser || active?.current === false)
      {
        ctx.fillStyle = ground
        ctx.fillRect(0, 0, W, H)
        return
      }
      measure(analyser, now)
      switch (visMode)
      {
        case 'dmt':
          drawDMT(ctx, freqData, timeData, W, H, dmtState, audio, palette)
          break
        case 'space':
          drawSpace(ctx, freqData, timeData, W, H, spaceState, audio, palette)
          break
        case 'milkdrop':
          drawMilkdrop(ctx, freqData, timeData, W, H, milkdropState, audio, palette)
          break
        case 'plasma':
          drawPlasma(ctx, freqData, timeData, W, H, plasmaState, audio, palette)
          break
        case 'bars':
          ctx.fillStyle = ground
          ctx.fillRect(0, 0, W, H)
          drawBars(ctx, freqData, smoothBars, peakBars, peakDecay, W, H, audio, palette)
          break
        case 'wave':
          drawWave(ctx, freqData, timeData, W, H, audio, palette)
          break
        case 'horizon':
          ctx.fillStyle = ground
          ctx.fillRect(0, 0, W, H)
          drawHorizon(ctx, freqData, timeData, W, H, audio, palette)
          break
        case 'rain':
          drawRain(ctx, freqData, timeData, W, H, rainState, audio, palette)
          break
      }
    }
    requestAnimationFrame(draw)

    return () =>
    {
      running = false
      observer.disconnect()
    }
  }, [canvasRef, analyserRef, visMode, active])
}
