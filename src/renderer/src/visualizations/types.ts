/**
 * @module visualizations/types
 * @description Shared type definitions for the audio visualization engine.
 *
 * All visualization draw functions receive frequency/time-domain data from the
 * Web Audio API {@link AnalyserNode} plus a pre-computed {@link AudioFeatures}
 * snapshot describing perceptual energy bands, beat detection, etc.
 */

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

/**
 * Per-frame snapshot of perceptually weighted audio energy bands and beat state.
 *
 * Band boundaries follow the standard audio engineering split:
 * | Band    | Range        | Typical Content            |
 * |---------|------------- |----------------------------|
 * | sub     | 10 - 65 Hz   | Sub-bass kick thump        |
 * | bass    | 65 - 260 Hz  | Bass guitar, kick body     |
 * | lowMid  | 260 - 500 Hz | Low vocals, guitar body    |
 * | mid     | 500 - 2 kHz  | Vocals, snare              |
 * | highMid | 2 - 6 kHz    | Vocal clarity, hi-hat      |
 * | treble  | 6 - 20 kHz   | Cymbals, air               |
 */
export interface AudioFeatures {
  sub: number
  bass: number
  lowMid: number
  mid: number
  highMid: number
  treble: number
  /** Perceptually weighted average of all bands. */
  overall: number
  /** 0-1 beat intensity with fast attack and exponential decay. */
  beat: number
  /** 0-1 mid-range beat intensity (snares, claps). */
  midBeat: number
  /** `true` only on the frame a bass beat is first detected. */
  isBeat: boolean
  /** Cumulative beat count for the current session. */
  beatCount: number
}

// ---------------------------------------------------------------------------
// DMT visualization
// ---------------------------------------------------------------------------

/** A single orbiting particle in the DMT particle field (Layer 7). */
export interface DMTParticle {
  angle: number
  radius: number
  speed: number
  hueOff: number
  size: number
  /** Depth layer (0-2) - affects speed, size, and opacity. */
  layer: number
  brightness: number
}

/** A floating luminous orb in the DMT scene (Layer 5). */
export interface DMTOrb {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  hue: number
  pulse: number
  life: number
}

/** An ophanim eye orbiting the concentric rings (Layer 2). */
export interface DMTEye {
  orbitRadius: number
  angle: number
  speed: number
  size: number
  pupilPhase: number
  irisHue: number
  blinkPhase: number
}

/** Mutable state bag for the DMT visualization across frames. */
export interface DMTState {
  hueBase: number
  tunnelDepth: number
  particles: DMTParticle[]
  orbs: DMTOrb[]
  eyes: DMTEye[]
  kaleidoAngle: number
  wingPhase: number
  shockwaves: { radius: number; alpha: number; hue: number }[]
  trailCanvas: HTMLCanvasElement | null
  trailCtx: CanvasRenderingContext2D | null
}

// ---------------------------------------------------------------------------
// Space visualization
// ---------------------------------------------------------------------------

/** A warp-field star with depth (z) for perspective projection. */
export interface SpaceStar {
  x: number
  y: number
  z: number
  speed: number
  brightness: number
  hue: number
}

/** A comet with velocity, trail history, and lifetime. */
export interface SpaceComet {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  hue: number
  trail: { x: number; y: number }[]
}

/** An orbiting debris particle around the central black hole. */
export interface SpaceDebris {
  angle: number
  dist: number
  speed: number
  size: number
  hue: number
  brightness: number
}

/** A background nebula cloud with drift phase. */
export interface SpaceNebula {
  x: number
  y: number
  radius: number
  hue: number
  phase: number
}

/** Mutable state bag for the Space visualization across frames. */
export interface SpaceState {
  stars: SpaceStar[]
  comets: SpaceComet[]
  debris: SpaceDebris[]
  nebulae: SpaceNebula[]
  rotation: number
  warpSpeed: number
}

// ---------------------------------------------------------------------------
// Milkdrop visualization
// ---------------------------------------------------------------------------

/** Mutable state bag for the Milkdrop (Winamp-inspired) visualization. */
export interface MilkdropState {
  waveHistory: Float32Array[]
  presetPhase: number
  morphT: number
  rot: number
  zoom: number
  hueShift: number
  feedbackCanvas: HTMLCanvasElement | null
  feedbackCtx: CanvasRenderingContext2D | null
}

// ---------------------------------------------------------------------------
// Plasma visualization
// ---------------------------------------------------------------------------

/** An audio-driven sine-plasma blob that modulates the field. */
export interface PlasmaBlob {
  x: number
  y: number
  sx: number
  sy: number
  hue: number
}

/** Mutable state bag for the Plasma visualization. */
export interface PlasmaState {
  t: number
  hueBase: number
  blobs: PlasmaBlob[]
}

// ---------------------------------------------------------------------------
// Visualization mode + quality
// ---------------------------------------------------------------------------

/** Union of all available visualization mode identifiers. */
export type VisMode = 'dmt' | 'space' | 'milkdrop' | 'plasma' | 'bars' | 'wave' | 'circular' | 'horizon'

/** Audio streaming quality preset. */
export type AudioQuality = 'best' | 'good' | 'low'

/** Human-readable labels for each {@link VisMode}. */
export const VIS_LABELS: Record<VisMode, string> = {
  dmt: 'DMT',
  space: 'Space',
  milkdrop: 'Milkdrop',
  plasma: 'Plasma',
  bars: 'Bars',
  wave: 'Waveform',
  circular: 'Gravity',
  horizon: 'Horizon'
}

/** Human-readable labels for each {@link AudioQuality}. */
export const QUALITY_LABELS: Record<AudioQuality, string> = {
  best: 'Best',
  good: 'Good',
  low: 'Low'
}
