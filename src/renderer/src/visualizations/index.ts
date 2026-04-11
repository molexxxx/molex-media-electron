/**
 * @module visualizations
 * @description Barrel export for all visualization draw functions, types,
 * constants, and audio utilities.
 *
 * Import everything from `'../visualizations'` in consuming components:
 * ```ts
 * import { drawDMT, drawBars, getBandEnergy, type AudioFeatures } from '../visualizations'
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

export { getBandEnergy, getAWeights, spectralFlux, spectralCentroid, rmsLevel, freqToBin } from './audio'
export { drawIdle } from './idle'
export { drawBars } from './bars'
export { drawWave } from './wave'
export { drawHorizon } from './horizon'
export { drawDMT } from './dmt'
export { drawSpace } from './space'
export { drawMilkdrop } from './milkdrop'
export { drawPlasma } from './plasma'
export { drawRain } from './rain'
