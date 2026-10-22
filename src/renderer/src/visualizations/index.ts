/**
 * @module visualizations
 * @description Barrel export for all visualization draw functions, types,
 * constants, the token palette they draw with, and audio utilities.
 *
 * Import everything from `'../visualizations'` in consuming components:
 * ```ts
 * import { drawDMT, readVizPalette, type AudioFeatures } from '../visualizations'
 * ```
 */

export type {
  AudioFeatures,
  DMTParticle,
  DMTOrb,
  DMTEye,
  DMTState,
  SpaceStar,
  SpaceState,
  MilkdropState,
  PlasmaBlob,
  PlasmaState,
  RainColumn,
  RainState,
  VisMode,
  AudioQuality
} from './types'

export { VIS_LABELS, QUALITY_LABELS } from './types'

export * from './palette'
export { getBandEnergy, getAWeights, spectralFlux, spectralCentroid, rmsLevel, freqToBin } from './audio'
export { drawBars } from './bars'
export { drawWave } from './wave'
export { drawHorizon } from './horizon'
export { drawDMT } from './dmt'
export { drawSpace } from './space'
export { drawMilkdrop } from './milkdrop'
export { drawPlasma } from './plasma'
export { drawRain } from './rain'
