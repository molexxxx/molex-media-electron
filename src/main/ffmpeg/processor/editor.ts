/**
 * @module main/ffmpeg/processor/editor
 * @description FFmpeg filter_complex generator for NLE timeline export.
 *
 * Converts a serialised timeline state (tracks, clips, sources) into
 * FFmpeg CLI arguments that render the multi-track timeline to a file.
 */

import { logger } from '../../logger'
import {
  resolveGpuCodec,
  getGpuPreset,
  getGpuQualityArgs,
  type GpuMode
} from '../gpu'

// ---------------------------------------------------------------------------
// Export request types (serialisable contract between renderer ↔ main)
// ---------------------------------------------------------------------------

export interface ExportSource {
  id: string
  filePath: string
  frameRate: number
  width: number
  height: number
  audioChannels: number
  audioSampleRate: number
  durationSeconds: number
}

export interface ExportClipTransform {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  anchorX: number
  anchorY: number
  opacity: number
}

export type ExportEasingFunction = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

export interface ExportTransformKeyframe {
  frame: number
  transform: ExportClipTransform
  easing: ExportEasingFunction
}

export type ExportBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add'
  | 'difference'

export interface ExportClip {
  id: string
  sourceId: string
  trackId: string
  timelineStart: number // project frames
  sourceIn: number // source frames
  sourceOut: number // source frames
  muted: boolean
  volume: number // 0–2
  pan: number // -1 (left) to 1 (right)
  speed: number // 1.0 = normal
  transform?: ExportClipTransform
  keyframes?: ExportTransformKeyframe[]
  blendMode?: ExportBlendMode
  width?: number   // source width (needed for transform calculations)
  height?: number  // source height (needed for transform calculations)
}

export interface ExportTrack {
  id: string
  type: 'video' | 'audio'
  name: string
  index: number
  muted: boolean
  visible: boolean
}

export interface ExportProject {
  frameRate: number
  sampleRate: number
  resolution: { width: number; height: number }
}

export interface ExportOutputOptions {
  filePath: string
  format: string // mp4 | webm | mov | mkv
  videoCodec: string // libx264 | libx265 | libvpx-vp9
  audioCodec: string // aac | flac | libopus
  crf?: number
  videoBitrate?: string
  audioBitrate?: string
  resolution?: { width: number; height: number }
  frameRate?: number
  sampleRate?: number
  audioChannels?: number
}

export interface ExportRequest {
  project: ExportProject
  sources: ExportSource[]
  tracks: ExportTrack[]
  clips: ExportClip[]
  output: ExportOutputOptions
  range?: { startFrame: number; endFrame: number }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function framesToSec(frames: number, fps: number): number {
  return fps > 0 ? frames / fps : 0
}

function sec(n: number): string {
  return n.toFixed(6)
}

/**
 * Build an `atempo` filter chain.  FFmpeg's `atempo` only accepts values
 * in [0.5, 100].  For rates below 0.5 then chain multiple filters.
 */
function buildAtempo(speed: number): string {
  if (speed >= 0.5 && speed <= 100) return `atempo=${speed}`
  const parts: string[] = []
  let remaining = speed
  while (remaining < 0.5) {
    parts.push('atempo=0.5')
    remaining /= 0.5
  }
  while (remaining > 100) {
    parts.push('atempo=100')
    remaining /= 100
  }
  if (Math.abs(remaining - 1) > 0.001) parts.push(`atempo=${remaining}`)
  return parts.length > 0 ? parts.join(',') : 'atempo=1'
}

/**
 * Trim clips to a given frame range, adjusting sourceIn/Out and
 * rebasing timelineStart so the range starts at frame 0.
 */
function trimClipsToRange(
  clips: ExportClip[],
  range: { startFrame: number; endFrame: number }
): ExportClip[] {
  return clips
    .filter((c) => {
      const dur = (c.sourceOut - c.sourceIn) / c.speed
      const end = c.timelineStart + dur
      return end > range.startFrame && c.timelineStart < range.endFrame
    })
    .map((c) => {
      const dur = (c.sourceOut - c.sourceIn) / c.speed
      const end = c.timelineStart + dur
      const oStart = Math.max(c.timelineStart, range.startFrame)
      const oEnd = Math.min(end, range.endFrame)
      const srcTrimStart = (oStart - c.timelineStart) * c.speed
      const srcTrimEnd = (end - oEnd) * c.speed
      return {
        ...c,
        timelineStart: oStart - range.startFrame,
        sourceIn: c.sourceIn + srcTrimStart,
        sourceOut: c.sourceOut - srcTrimEnd
      }
    })
}

// ---------------------------------------------------------------------------
// Spatial transform helpers
// ---------------------------------------------------------------------------

/** FFmpeg blend mode mapping. 'normal' uses standard overlay (no blend filter needed). */
const FFMPEG_BLEND_MAP: Record<ExportBlendMode, string> = {
  normal: '',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'addition',
  difference: 'difference'
}

/**
 * Neutral pad/fill colour per blend mode.  When a pixel in the padded area
 * is blended with the base, the neutral value produces the base unchanged:
 *   multiply / darken → white  (base × 1 = base, min(base,1) = base)
 *   screen / lighten / add / difference → black
 *   overlay → mid-gray 0x808080  (formula returns base when fg = 0.5)
 */
const BLEND_NEUTRAL_COLOR: Record<ExportBlendMode, string> = {
  normal: '0x000000',
  multiply: '0xFFFFFF',
  screen: '0x000000',
  overlay: '0x808080',
  darken: '0xFFFFFF',
  lighten: '0x000000',
  add: '0x000000',
  difference: '0x000000'
}

/** Easing function for keyframe interpolation (mirrored from renderer). */
function applyEasing(t: number, easing: ExportEasingFunction): number {
  switch (easing) {
    case 'linear': return t
    case 'ease-in': return t * t
    case 'ease-out': return t * (2 - t)
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + 180) % 360) - 180
  if (diff < -180) diff += 360
  return a + diff * t
}

/**
 * Check whether a transform is the identity (centered, full-size, no rotation, full opacity).
 */
function isIdentityTransform(t: ExportClipTransform, sourceW: number, sourceH: number, outW: number, outH: number): boolean {
  const fitScale = Math.min(outW / sourceW, outH / sourceH)
  return (
    Math.abs(t.x - outW / 2) < 0.5 &&
    Math.abs(t.y - outH / 2) < 0.5 &&
    Math.abs(t.scaleX - fitScale) < 0.001 &&
    Math.abs(t.scaleY - fitScale) < 0.001 &&
    Math.abs(t.rotation) < 0.01 &&
    Math.abs(t.anchorX - 0.5) < 0.001 &&
    Math.abs(t.anchorY - 0.5) < 0.001 &&
    t.opacity >= 0.999
  )
}

/**
 * Compute the size of a rotated bounding box.
 */
function computeRotatedSize(w: number, h: number, rotDeg: number): { rw: number; rh: number } {
  const rad = Math.abs(rotDeg * Math.PI / 180)
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return {
    rw: Math.ceil(w * cos + h * sin),
    rh: Math.ceil(w * sin + h * cos)
  }
}

/**
 * Build per-clip transform filters: scale → rotate → opacity → (produces a label ready for overlay).
 * Returns the filter strings and the output label, plus the dimensions of the result.
 *
 * When `skipOpacity` is true the opacity step is omitted (caller handles it
 * via the blend filter's `all_opacity` parameter).
 * When `rotateFill` is provided it replaces the default transparent-black
 * fill colour used by the rotation filter.
 */
function buildClipTransformFilters(
  transform: ExportClipTransform,
  sourceW: number,
  sourceH: number,
  inputLabel: string,
  labelFn: () => string,
  options?: { skipOpacity?: boolean; rotateFill?: string }
): { filters: string[]; outputLabel: string; resultW: number; resultH: number } {
  const filters: string[] = []
  let current = inputLabel

  const scaledW = Math.round(sourceW * transform.scaleX)
  const scaledH = Math.round(sourceH * transform.scaleY)

  // 1. Scale (if not 1:1)
  if (Math.abs(transform.scaleX - 1) > 0.001 || Math.abs(transform.scaleY - 1) > 0.001) {
    const out = labelFn()
    // Force even dimensions for encoder compatibility
    const w = scaledW % 2 === 0 ? scaledW : scaledW + 1
    const h = scaledH % 2 === 0 ? scaledH : scaledH + 1
    filters.push(`[${current}]scale=${w}:${h}:flags=lanczos[${out}]`)
    current = out
  }

  // 2. Rotation (if non-zero)
  let finalW = scaledW
  let finalH = scaledH
  if (Math.abs(transform.rotation) > 0.01) {
    const out = labelFn()
    const rad = transform.rotation * Math.PI / 180
    const { rw, rh } = computeRotatedSize(scaledW, scaledH, transform.rotation)
    finalW = rw
    finalH = rh
    const fillColor = options?.rotateFill ?? '0x00000000'
    filters.push(
      `[${current}]format=rgba,rotate=${rad.toFixed(6)}:ow=rotw(${rad.toFixed(6)}):oh=roth(${rad.toFixed(6)}):c=${fillColor}:bilinear=1[${out}]`
    )
    current = out
  }

  // 3. Opacity (if < 1.0) — skipped when the caller applies it via blend all_opacity
  if (!options?.skipOpacity && transform.opacity < 0.999) {
    const out = labelFn()
    filters.push(
      `[${current}]format=rgba,colorchannelmixer=aa=${transform.opacity.toFixed(4)}[${out}]`
    )
    current = out
  }

  return { filters, outputLabel: current, resultW: finalW, resultH: finalH }
}

/**
 * Compute the overlay x:y position in output space.
 * (transform.x, transform.y) is the CENTER position of the clip.
 */
function computeOverlayPos(
  transform: ExportClipTransform,
  overlayW: number,
  overlayH: number
): { x: number; y: number } {
  return {
    x: Math.round(transform.x - overlayW / 2),
    y: Math.round(transform.y - overlayH / 2)
  }
}

/**
 * Generate a piecewise linear FFmpeg expression for an animated property.
 * Uses `if(between(t,...), ...)` segments with `eval=frame`.
 * For v1, non-linear easing is approximated by subdividing into short linear segments (10 subdivisions each).
 */
function buildAnimatedExpr(
  keyframes: ExportTransformKeyframe[],
  property: keyof ExportClipTransform,
  fps: number,
  clipStartFrame: number,
  isAngle: boolean = false
): string {
  if (keyframes.length === 0) return '0'
  if (keyframes.length === 1) return String(keyframes[0].transform[property])

  const segments: string[] = []

  for (let i = 0; i < keyframes.length - 1; i++) {
    const left = keyframes[i]
    const right = keyframes[i + 1]
    const tStart = framesToSec(left.frame + clipStartFrame, fps)
    const tEnd = framesToSec(right.frame + clipStartFrame, fps)
    const vStart = left.transform[property]
    const vEnd = right.transform[property]

    if (left.easing === 'linear' && !isAngle) {
      // Simple linear: value = vStart + (vEnd - vStart) * clamp((t - tStart) / (tEnd - tStart), 0, 1)
      const range = tEnd - tStart
      if (range > 0) {
        segments.push(
          `if(between(t,${sec(tStart)},${sec(tEnd)}),${vStart}+(${vEnd - vStart})*min(max((t-${sec(tStart)})/${sec(range)},0),1)`
        )
      }
    } else {
      // Non-linear or angle: subdivide into N short linear segments
      const N = 10
      for (let j = 0; j < N; j++) {
        const t0Frac = j / N
        const t1Frac = (j + 1) / N
        const eased0 = applyEasing(t0Frac, left.easing)
        const eased1 = applyEasing(t1Frac, left.easing)
        const v0 = isAngle
          ? lerpAngle(vStart as number, vEnd as number, eased0)
          : lerp(vStart as number, vEnd as number, eased0)
        const v1 = isAngle
          ? lerpAngle(vStart as number, vEnd as number, eased1)
          : lerp(vStart as number, vEnd as number, eased1)
        const segStart = tStart + t0Frac * (tEnd - tStart)
        const segEnd = tStart + t1Frac * (tEnd - tStart)
        const segRange = segEnd - segStart
        if (segRange > 0) {
          segments.push(
            `if(between(t,${sec(segStart)},${sec(segEnd)}),${v0.toFixed(4)}+(${(v1 - v0).toFixed(4)})*min(max((t-${sec(segStart)})/${sec(segRange)},0),1)`
          )
        }
      }
    }
  }

  // Clamp: before first keyframe → first value, after last → last value
  const firstVal = keyframes[0].transform[property]
  const lastVal = keyframes[keyframes.length - 1].transform[property]
  const firstT = framesToSec(keyframes[0].frame + clipStartFrame, fps)

  let expr = `if(lt(t,${sec(firstT)}),${firstVal},`
  for (const seg of segments) {
    expr += seg + ','
  }
  expr += String(lastVal)
  // Close all ifs
  expr += ')'.repeat(segments.length + 1)

  return expr
}

// ---------------------------------------------------------------------------
// Per-track filter builders
// ---------------------------------------------------------------------------

function buildVideoTrack(
  track: ExportTrack,
  clips: ExportClip[],
  sourceById: Map<string, ExportSource>,
  inputMap: Map<string, number>,
  filters: string[],
  fps: number,
  outFps: number,
  w: number,
  h: number,
  label: () => string
): string | null {
  const sorted = clips
    .filter((c) => c.trackId === track.id)
    .sort((a, b) => a.timelineStart - b.timelineStart)

  if (sorted.length === 0) return null

  const segments: string[] = []
  let cursorSec = 0

  for (const clip of sorted) {
    const src = sourceById.get(clip.sourceId)
    if (!src || src.width === 0 || src.height === 0) continue
    const idx = inputMap.get(src.filePath)
    if (idx == null) continue

    // Trim points in seconds (source timebase)
    const inSec = framesToSec(clip.sourceIn, src.frameRate)
    const outSec = framesToSec(clip.sourceOut, src.frameRate)
    const clipStartSec = framesToSec(clip.timelineStart, fps)
    const clipDurSec = (outSec - inSec) / clip.speed

    // Insert gap before this clip
    if (clipStartSec > cursorSec + 0.0001) {
      const gapSec = clipStartSec - cursorSec
      const gl = label()
      filters.push(`color=c=black:s=${w}x${h}:d=${sec(gapSec)}:r=${outFps}[${gl}]`)
      segments.push(`[${gl}]`)
    }

    // Trim + optional speed + scale
    const cl = label()

    let chain = `[${idx}:v]trim=start=${sec(inSec)}:end=${sec(outSec)},setpts=PTS-STARTPTS`
    if (Math.abs(clip.speed - 1) > 0.001) {
      chain += `,setpts=PTS/${clip.speed}`
    }
    chain += `,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
    chain += `[${cl}]`
    filters.push(chain)
    segments.push(`[${cl}]`)

    cursorSec = clipStartSec + clipDurSec
  }

  if (segments.length === 0) return null
  if (segments.length === 1) return segments[0].slice(1, -1)

  const tl = label()
  filters.push(`${segments.join('')}concat=n=${segments.length}:v=1:a=0[${tl}]`)
  return tl
}

function buildAudioTrack(
  track: ExportTrack,
  clips: ExportClip[],
  sourceById: Map<string, ExportSource>,
  inputMap: Map<string, number>,
  filters: string[],
  fps: number,
  sr: number,
  ch: number,
  label: () => string
): string | null {
  const sorted = clips
    .filter((c) => c.trackId === track.id)
    .sort((a, b) => a.timelineStart - b.timelineStart)

  if (sorted.length === 0) return null

  const layout = ch === 1 ? 'mono' : 'stereo'
  const segments: string[] = []
  let cursorSec = 0

  for (const clip of sorted) {
    const src = sourceById.get(clip.sourceId)
    if (!src || src.audioChannels === 0) continue
    const idx = inputMap.get(src.filePath)
    if (idx == null) continue

    // Trim points in seconds (source timebase)
    const inSec = framesToSec(clip.sourceIn, src.frameRate)
    const outSec = framesToSec(clip.sourceOut, src.frameRate)
    const clipStartSec = framesToSec(clip.timelineStart, fps)
    const clipDurSec = (outSec - inSec) / clip.speed

    // Insert silence gap
    if (clipStartSec > cursorSec + 0.0001) {
      const gapSec = clipStartSec - cursorSec
      const gl = label()
      filters.push(
        `anullsrc=r=${sr}:cl=${layout},atrim=0:${sec(gapSec)},asetpts=PTS-STARTPTS[${gl}]`
      )
      segments.push(`[${gl}]`)
    }

    // Trim + optional speed / volume + format
    const al = label()

    let chain = `[${idx}:a]atrim=start=${sec(inSec)}:end=${sec(outSec)},asetpts=PTS-STARTPTS`
    if (Math.abs(clip.speed - 1) > 0.001) chain += `,${buildAtempo(clip.speed)}`
    if (Math.abs(clip.volume - 1) > 0.01) chain += `,volume=${clip.volume}`
    if (Math.abs(clip.pan) > 0.01) chain += `,stereotools=balance_out=${clip.pan.toFixed(3)}`
    chain += `,aformat=sample_rates=${sr}:channel_layouts=${layout}`
    chain += `[${al}]`
    filters.push(chain)
    segments.push(`[${al}]`)

    cursorSec = clipStartSec + clipDurSec
  }

  if (segments.length === 0) return null
  if (segments.length === 1) return segments[0].slice(1, -1)

  const tl = label()
  filters.push(`${segments.join('')}concat=n=${segments.length}:v=0:a=1[${tl}]`)
  return tl
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the complete FFmpeg CLI arguments to export a timeline.
 * Returns the args array (excluding the ffmpeg binary path itself).
 */
export async function buildExportCommand(req: ExportRequest, ffmpegPath?: string, gpuMode?: GpuMode): Promise<string[]> {
  const { project, sources, tracks, clips, output, range } = req
  const fps = project.frameRate
  const w = output.resolution?.width ?? project.resolution.width
  const h = output.resolution?.height ?? project.resolution.height
  const outFps = output.frameRate ?? fps
  const sr = output.sampleRate ?? project.sampleRate
  const ch = output.audioChannels ?? 2

  const sourceById = new Map(sources.map((s) => [s.id, s]))

  // Classify active tracks
  const vTracks = tracks
    .filter((t) => t.type === 'video' && !t.muted && t.visible)
    .sort((a, b) => a.index - b.index)
  const aTracks = tracks
    .filter((t) => t.type === 'audio' && !t.muted)
    .sort((a, b) => a.index - b.index)

  const activeIds = new Set([...vTracks, ...aTracks].map((t) => t.id))
  let active = clips.filter((c) => !c.muted && activeIds.has(c.trackId))

  if (range) active = trimClipsToRange(active, range)

  // De-duplicate source file inputs
  const inputMap = new Map<string, number>()
  const inputArgs: string[] = []
  let nextIdx = 0
  for (const c of active) {
    const src = sourceById.get(c.sourceId)
    if (!src || inputMap.has(src.filePath)) continue
    inputMap.set(src.filePath, nextIdx++)
    inputArgs.push('-i', src.filePath)
  }

  if (nextIdx === 0) throw new Error('No active clips to export')

  // Label counter
  let li = 0
  const label = (): string => `l${li++}`

  // Build per-track filter graphs
  const filters: string[] = []

  // Check if any clip has a spatial transform
  const hasSpatialTransforms = active.some((c) => {
    if (!c.transform) return false
    const src = sourceById.get(c.sourceId)
    if (!src) return false
    return !isIdentityTransform(c.transform, src.width, src.height, w, h)
  })
  const hasKeyframes = active.some((c) => c.keyframes && c.keyframes.length > 0)
  const hasBlendModes = active.some((c) => c.blendMode && c.blendMode !== 'normal')
  const useSpatialCompositing = hasSpatialTransforms || hasKeyframes || hasBlendModes

  let vOut: string | null = null

  if (useSpatialCompositing) {
    // === Spatial compositing path ===
    // Create black background at output resolution for the full timeline duration
    const totalDurSec = getExportDurationSeconds(req)
    const bgLabel = label()
    filters.push(`color=c=black:s=${w}x${h}:d=${sec(totalDurSec)}:r=${outFps}[${bgLabel}]`)
    let base = bgLabel

    // Collect all video clips across all visible video tracks, sorted by track index (bottom→top) then timeline position
    const allVideoClips: { clip: ExportClip; track: ExportTrack }[] = []
    for (const t of vTracks) {
      const trackClips = active
        .filter((c) => c.trackId === t.id)
        .sort((a, b) => a.timelineStart - b.timelineStart)
      for (const c of trackClips) {
        allVideoClips.push({ clip: c, track: t })
      }
    }

    // Overlay each clip onto the base with its transform
    for (const { clip } of allVideoClips) {
      const src = sourceById.get(clip.sourceId)
      if (!src || src.width === 0 || src.height === 0) continue
      const idx = inputMap.get(src.filePath)
      if (idx == null) continue

      const inSec = framesToSec(clip.sourceIn, src.frameRate)
      const outSec = framesToSec(clip.sourceOut, src.frameRate)
      const clipStartSec = framesToSec(clip.timelineStart, fps)
      const clipDurSec = (outSec - inSec) / clip.speed

      // Trim + speed
      const trimLabel = label()
      let chain = `[${idx}:v]trim=start=${sec(inSec)}:end=${sec(outSec)},setpts=PTS-STARTPTS`
      if (Math.abs(clip.speed - 1) > 0.001) {
        chain += `,setpts=PTS/${clip.speed}`
      }
      chain += `[${trimLabel}]`
      filters.push(chain)

      let currentLabel = trimLabel
      const sourceW = clip.width ?? src.width
      const sourceH = clip.height ?? src.height

      // Determine the transform to apply
      const transform = clip.transform ?? {
        x: w / 2, y: h / 2,
        scaleX: Math.min(w / sourceW, h / sourceH),
        scaleY: Math.min(w / sourceW, h / sourceH),
        rotation: 0, anchorX: 0.5, anchorY: 0.5, opacity: 1
      }

      const hasKF = clip.keyframes && clip.keyframes.length > 0

      if (hasKF) {
        // Animated transforms: we need eval=frame on the overlay
        // For animated scale, we scale to max size and use overlay expressions
        // For v1: apply static intermediate scale, use animated overlay position
        // Find the max scale across all keyframes for pre-scaling
        const allKF = clip.keyframes!
        const maxScaleX = Math.max(transform.scaleX, ...allKF.map((k) => k.transform.scaleX))
        const maxScaleY = Math.max(transform.scaleY, ...allKF.map((k) => k.transform.scaleY))
        const preScaleW = Math.round(sourceW * maxScaleX)
        const preScaleH = Math.round(sourceH * maxScaleY)
        const preW = preScaleW % 2 === 0 ? preScaleW : preScaleW + 1
        const preH = preScaleH % 2 === 0 ? preScaleH : preScaleH + 1

        if (preW !== sourceW || preH !== sourceH) {
          const scaleOut = label()
          filters.push(`[${currentLabel}]scale=${preW}:${preH}:flags=lanczos[${scaleOut}]`)
          currentLabel = scaleOut
        }

        // Opacity animation (skipped for non-normal blend modes — handled by all_opacity on blend filter)
        const kfBlendMode = clip.blendMode ?? 'normal'
        const kfIsBlend = kfBlendMode !== 'normal'
        if (!kfIsBlend) {
          const hasOpacityAnim = allKF.some((k) => Math.abs(k.transform.opacity - transform.opacity) > 0.001)
          if (hasOpacityAnim || transform.opacity < 0.999) {
            const opOut = label()
            const opExpr = buildAnimatedExpr(allKF, 'opacity', fps, clip.timelineStart)
            filters.push(`[${currentLabel}]format=rgba,colorchannelmixer=aa='${opExpr}'[${opOut}]`)
            currentLabel = opOut
          }
        }

        // Animated overlay position
        const xExpr = buildAnimatedExpr(allKF, 'x', fps, clip.timelineStart)
        const yExpr = buildAnimatedExpr(allKF, 'y', fps, clip.timelineStart)
        const overlayX = `(${xExpr})-(overlay_w/2)`
        const overlayY = `(${yExpr})-(overlay_h/2)`

        const oOut = label()
        const blendMode = clip.blendMode ?? 'normal'
        if (blendMode !== 'normal') {
          // Pad to output size with blend-neutral colour, then blend.
          // Convert to RGB (gbrp) first — blend formulas are defined for
          // RGB and produce colour-shifted output when applied to YUV.
          const padOut = label()
          const neutralColor = BLEND_NEUTRAL_COLOR[blendMode]
          filters.push(`[${currentLabel}]format=gbrp,pad=${w}:${h}:${overlayX}:${overlayY}:color=${neutralColor}[${padOut}]`)
          currentLabel = padOut
          const bm = FFMPEG_BLEND_MAP[blendMode]
          const blendOp = transform.opacity < 0.999 ? transform.opacity.toFixed(4) : '1'
          const baseRgb = label()
          filters.push(`[${base}]format=gbrp[${baseRgb}]`)
          filters.push(`[${baseRgb}][${currentLabel}]blend=all_mode=${bm}:all_opacity=${blendOp}:shortest=1:eof_action=pass[${oOut}]`)
        } else {
          filters.push(
            `[${base}][${currentLabel}]overlay=x='${overlayX}':y='${overlayY}':eval=frame:format=auto:eof_action=pass:enable='between(t,${sec(clipStartSec)},${sec(clipStartSec + clipDurSec)})'[${oOut}]`
          )
        }
        base = oOut
      } else {
        // Static transform: apply scale → rotate → opacity filters, then positioned overlay
        const blendMode = clip.blendMode ?? 'normal'
        const isBlend = blendMode !== 'normal'
        const { filters: tFilters, outputLabel, resultW, resultH } = buildClipTransformFilters(
          transform, sourceW, sourceH, currentLabel, label,
          isBlend ? { skipOpacity: true, rotateFill: BLEND_NEUTRAL_COLOR[blendMode] } : undefined
        )
        filters.push(...tFilters)
        currentLabel = outputLabel

        const pos = computeOverlayPos(transform, resultW, resultH)
        const oOut = label()

        if (isBlend) {
          // For non-normal blend modes: convert to RGB (gbrp), pad to output
          // size with blend-neutral colour, then blend.  Blend formulas are
          // defined for RGB; applying them to YUV chroma channels (centred
          // at 128) produces colour-shifted results.
          const padOut = label()
          const padX = Math.max(0, pos.x)
          const padY = Math.max(0, pos.y)
          const neutralColor = BLEND_NEUTRAL_COLOR[blendMode]
          filters.push(`[${currentLabel}]format=gbrp,pad=${w}:${h}:${padX}:${padY}:color=${neutralColor}[${padOut}]`)
          const bm = FFMPEG_BLEND_MAP[blendMode]
          const blendOp = transform.opacity < 0.999 ? transform.opacity.toFixed(4) : '1'
          const baseRgb = label()
          filters.push(`[${base}]format=gbrp[${baseRgb}]`)
          filters.push(
            `[${baseRgb}][${padOut}]blend=all_mode=${bm}:all_opacity=${blendOp}:shortest=1:eof_action=pass:enable='between(t,${sec(clipStartSec)},${sec(clipStartSec + clipDurSec)})'[${oOut}]`
          )
        } else {
          filters.push(
            `[${base}][${currentLabel}]overlay=${pos.x}:${pos.y}:format=auto:eof_action=pass:enable='between(t,${sec(clipStartSec)},${sec(clipStartSec + clipDurSec)})'[${oOut}]`
          )
        }
        base = oOut
      }
    }

    vOut = base
  } else {
    // === Legacy path (no spatial transforms) - simple scale+pad+concat per track ===
    const vLabels: string[] = []
    for (const t of vTracks) {
      const l = buildVideoTrack(t, active, sourceById, inputMap, filters, fps, outFps, w, h, label)
      if (l) vLabels.push(l)
    }

    // Composite video tracks (overlay bottom → top)
    if (vLabels.length === 1) {
      vOut = vLabels[0]
    } else if (vLabels.length > 1) {
      let base = vLabels[0]
      for (let i = 1; i < vLabels.length; i++) {
        const out = label()
        filters.push(`[${base}][${vLabels[i]}]overlay=0:0:eof_action=pass[${out}]`)
        base = out
      }
      vOut = base
    }
  }

  // Build audio from both audio tracks AND video tracks (embedded audio)
  const aLabels: string[] = []
  for (const t of aTracks) {
    const l = buildAudioTrack(t, active, sourceById, inputMap, filters, fps, sr, ch, label)
    if (l) aLabels.push(l)
  }
  for (const t of vTracks) {
    const l = buildAudioTrack(t, active, sourceById, inputMap, filters, fps, sr, ch, label)
    if (l) aLabels.push(l)
  }

  // Mix audio tracks
  let aOut: string | null = null
  if (aLabels.length === 1) {
    aOut = aLabels[0]
  } else if (aLabels.length > 1) {
    const out = label()
    filters.push(
      `${aLabels.map((l) => `[${l}]`).join('')}amix=inputs=${aLabels.length}:duration=longest:normalize=0[${out}]`
    )
    aOut = out
  }

  // Assemble final command
  const args: string[] = ['-y', ...inputArgs]

  if (filters.length > 0) {
    args.push('-filter_complex', filters.join(';'))
  }

  if (vOut) args.push('-map', `[${vOut}]`)
  if (aOut) args.push('-map', `[${aOut}]`)

  // Video encoding
  if (vOut) {
    const softwareVc = output.videoCodec || 'libx264'
    const effectiveGpuMode = gpuMode || 'off'
    // Resolve GPU codec - filter_complex uses software pixel formats so no hwaccel decoding
    const gpuResult = ffmpegPath
      ? await resolveGpuCodec(ffmpegPath, softwareVc, effectiveGpuMode)
      : { codec: softwareVc, activeMode: 'off' as GpuMode, isGpu: false }
    const vc = gpuResult.codec

    args.push('-c:v', vc)

    if (output.crf != null) {
      args.push(...(gpuResult.isGpu ? getGpuQualityArgs(gpuResult.activeMode, output.crf) : ['-crf', String(output.crf)]))
    }
    if (output.videoBitrate) args.push('-b:v', output.videoBitrate)
    args.push('-r', String(outFps))

    if (gpuResult.isGpu) {
      args.push('-pix_fmt', 'yuv420p', ...getGpuPreset(gpuResult.activeMode, 'medium'))
    } else if (vc === 'libx264' || vc === 'libx265') {
      args.push('-pix_fmt', 'yuv420p', '-preset', 'medium')
    } else if (vc === 'libvpx-vp9') {
      args.push('-pix_fmt', 'yuv420p')
    }
  }

  // Audio encoding
  if (aOut) {
    const ac = output.audioCodec || 'aac'
    args.push('-c:a', ac)
    if (output.audioBitrate) args.push('-b:a', output.audioBitrate)
    args.push('-ar', String(sr), '-ac', String(ch))
  }

  // Audio-only: explicitly disable video
  if (!vOut && aOut) {
    args.push('-vn')
  }

  args.push(output.filePath)

  logger.info(
    `[editor:export] filter_complex: ${filters.length} filter(s), ${nextIdx} input(s), ` +
      `video=${vOut ? 'yes' : 'no'}, audio=${aOut ? 'yes' : 'no'}`
  )
  return args
}

/**
 * Compute the total export duration in seconds (for progress reporting).
 */
export function getExportDurationSeconds(req: ExportRequest): number {
  if (req.range) {
    return framesToSec(req.range.endFrame - req.range.startFrame, req.project.frameRate)
  }
  const sourceById = new Map(req.sources.map((s) => [s.id, s]))
  let maxSec = 0
  for (const c of req.clips) {
    if (c.muted) continue
    const src = sourceById.get(c.sourceId)
    const srcFps = src?.frameRate || req.project.frameRate
    const inSec = framesToSec(c.sourceIn, srcFps)
    const outSec = framesToSec(c.sourceOut, srcFps)
    const clipDurSec = (outSec - inSec) / c.speed
    const clipStartSec = framesToSec(c.timelineStart, req.project.frameRate)
    const endSec = clipStartSec + clipDurSec
    if (endSec > maxSec) maxSec = endSec
  }
  return maxSec
}
