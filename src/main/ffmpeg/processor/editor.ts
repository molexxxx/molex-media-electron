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

  const vLabels: string[] = []
  for (const t of vTracks) {
    const l = buildVideoTrack(t, active, sourceById, inputMap, filters, fps, outFps, w, h, label)
    if (l) vLabels.push(l)
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

  // Composite video tracks (overlay bottom → top)
  let vOut: string | null = null
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
