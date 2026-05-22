/**
 * @module main/ffmpeg/gpu
 * GPU hardware acceleration helpers for FFmpeg.
 *
 * Provides codec mapping, quality parameter translation, and hwaccel
 * input flags for NVIDIA NVENC, Intel QSV, and AMD AMF encoders.
 *
 * The config setting `gpuAcceleration` controls the mode:
 * - 'off'   - software encoding (default)
 * - 'auto'  - try NVENC → QSV → AMF, fall back to software
 * - 'nvenc' - force NVIDIA NVENC
 * - 'qsv'   - force Intel Quick Sync Video
 * - 'amf'   - force AMD AMF
 */

import { logger } from '../logger'
import { runCommand } from './runner'

export type GpuMode = 'off' | 'auto' | 'nvenc' | 'qsv' | 'amf'

// GPU encoder names keyed by [mode][softwareCodec]
const GPU_CODECS: Record<string, Record<string, string>> = {
  nvenc: {
    libx264: 'h264_nvenc',
    libx265: 'hevc_nvenc',
    // AV1 NVENC requires Ada Lovelace+ GPUs - omit for broad compat
  },
  qsv: {
    libx264: 'h264_qsv',
    libx265: 'hevc_qsv',
  },
  amf: {
    libx264: 'h264_amf',
    libx265: 'hevc_amf',
  },
}

// Hwaccel input flags per mode (inserted before -i)
// NOTE: Intentionally omit -hwaccel_output_format cuda/qsv because it pins
// decoded frames to GPU surfaces. When multiple batch workers run concurrently
// they exhaust the limited surface pool ("No decoder surfaces left"). Using
// -hwaccel alone still accelerates decoding but copies frames to system memory,
// which is safe for concurrent use.
const HWACCEL_INPUT: Record<string, string[]> = {
  nvenc: ['-hwaccel', 'cuda'],
  qsv: ['-hwaccel', 'qsv'],
  amf: ['-hwaccel', 'auto'],
}

// Preset mapping: software name → GPU-specific name
const PRESET_MAP: Record<string, Record<string, string>> = {
  nvenc: {
    veryslow: 'p7', slow: 'p6', medium: 'p4', fast: 'p2', veryfast: 'p1',
  },
  qsv: {
    veryslow: 'veryslow', slow: 'slower', medium: 'medium', fast: 'fast', veryfast: 'veryfast',
  },
  amf: {
    veryslow: 'quality', slow: 'quality', medium: 'balanced', fast: 'speed', veryfast: 'speed',
  },
}

/** Cache for which GPU modes are available (tested once). */
let _detectedMode: GpuMode | null = null
let _detecting = false
const _detectQueue: ((mode: GpuMode) => void)[] = []

/**
 * Detect available GPU encoder by trying a small encode.
 * Returns the first working mode, or 'off' if none available.
 */
export async function detectGpuMode(ffmpegPath: string): Promise<GpuMode>
{
  if (_detectedMode) return _detectedMode
  if (_detecting)
  {
    return new Promise((resolve) => _detectQueue.push(resolve))
  }
  _detecting = true

  // Track whether *any* attempt actually completed (spawned + exited).
  // If every attempt threw before producing an exit code (e.g. ffmpeg
  // binary not ready yet on early app startup), do NOT cache 'off' —
  // leave _detectedMode null so a later call can retry detection.
  let anyCompleted = false

  // Probe available encoders first. Skipping a mode whose encoder is not
  // compiled in avoids a confusing spawn failure and lets us log a clean
  // reason. The list is cheap (one ffmpeg invocation).
  let encoders = ''
  try {
    const { promise } = runCommand(ffmpegPath, ['-hide_banner', '-encoders'])
    const r = await promise
    encoders = r.stdout + r.stderr
    if (r.code === 0 || encoders.length > 0) anyCompleted = true
  } catch {
    // ignore — fall back to attempting each test encode blind
  }

  for (const mode of ['nvenc', 'qsv', 'amf'] as const)
  {
    const codec = GPU_CODECS[mode]?.libx264
    if (!codec) continue
    if (encoders && !encoders.includes(codec)) {
      logger.info(`[gpu] ${mode}: encoder ${codec} not compiled into ffmpeg, skipping`)
      continue
    }
    try
    {
      // Use 256x144 (16:9, evenly aligned) — large enough to satisfy
      // NVENC/QSV/AMF minimum-dimension constraints. The color filter is
      // a synthetic source so no input file is required.
      const { promise } = runCommand(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x144:d=0.1',
        '-c:v', codec, '-frames:v', '1',
        '-f', 'null', '-'
      ])
      const result = await promise
      anyCompleted = true
      if (result.code === 0)
      {
        logger.info(`[gpu] Detected ${mode} support`)
        _detectedMode = mode
        _detecting = false
        _detectQueue.forEach((fn) => fn(mode))
        _detectQueue.length = 0
        return mode
      }
      else
      {
        // Surface the first line of stderr so the user can see *why*
        // detection failed (driver missing, no capable device, etc.).
        const reason = (result.stderr || '').split(/\r?\n/).filter(Boolean)[0] || `exit ${result.code}`
        logger.info(`[gpu] ${mode}: test encode failed — ${reason}`)
      }
    } catch (err)
    {
      logger.info(`[gpu] ${mode}: spawn error — ${(err as Error)?.message ?? 'unknown'}`)
    }
  }

  _detecting = false
  if (!anyCompleted)
  {
    // FFmpeg likely unavailable during this attempt. Don't cache so the
    // next call retries once the binary is ready.
    logger.warn('[gpu] Detection inconclusive (no ffmpeg attempt completed)')
    _detectQueue.forEach((fn) => fn('off'))
    _detectQueue.length = 0
    return 'off'
  }

  logger.info('[gpu] No GPU encoder detected, using software')
  _detectedMode = 'off'
  _detectQueue.forEach((fn) => fn('off'))
  _detectQueue.length = 0
  return 'off'
}

/** Reset cached detection (e.g. after config change). */
export function resetGpuDetection(): void
{
  _detectedMode = null
}

export interface GpuCodecResult
{
  /** The encoder name (e.g. 'h264_nvenc' or 'libx264') */
  codec: string
  /** The active GPU mode ('off' if software) */
  activeMode: GpuMode
  /** Whether GPU encoding is being used */
  isGpu: boolean
}

/**
 * Resolve the effective video codec given GPU settings.
 * If mode is 'auto', runs detection. If the requested software codec
 * has no GPU equivalent, falls back to software.
 */
export async function resolveGpuCodec(
  ffmpegPath: string,
  softwareCodec: string,
  gpuMode: GpuMode
): Promise<GpuCodecResult>
{
  if (gpuMode === 'off')
  {
    return { codec: softwareCodec, activeMode: 'off', isGpu: false }
  }

  const effectiveMode = gpuMode === 'auto'
    ? await detectGpuMode(ffmpegPath)
    : gpuMode

  if (effectiveMode === 'off')
  {
    return { codec: softwareCodec, activeMode: 'off', isGpu: false }
  }

  const gpuCodec = GPU_CODECS[effectiveMode]?.[softwareCodec]
  if (!gpuCodec)
  {
    // No GPU equivalent (e.g. VP9, AV1 on non-NVENC Ada)
    logger.info(`[gpu] No ${effectiveMode} equivalent for ${softwareCodec}, using software`)
    return { codec: softwareCodec, activeMode: 'off', isGpu: false }
  }

  return { codec: gpuCodec, activeMode: effectiveMode, isGpu: true }
}

/**
 * Resolve the effective GPU mode from config (handle 'auto' detection).
 * Use this when you only need hwaccel decoding (thumbnails, etc.) and
 * don't need a codec mapping.
 */
export async function resolveEffectiveMode(
  ffmpegPath: string,
  gpuMode: GpuMode
): Promise<GpuMode>
{
  if (gpuMode === 'off') return 'off'
  return gpuMode === 'auto' ? await detectGpuMode(ffmpegPath) : gpuMode
}

/**
 * Get hwaccel input args to prepend before -i (for hardware-accelerated decoding).
 * Only adds flags when GPU encoding is active AND we're not using complex filter graphs
 * (which require software pixel formats).
 */
export function getHwaccelInputArgs(activeMode: GpuMode, hasFilterComplex: boolean): string[]
{
  if (activeMode === 'off' || hasFilterComplex) return []
  return HWACCEL_INPUT[activeMode] || []
}

/**
 * Get the appropriate preset flag for the active GPU mode.
 * Returns ['-preset', value] for NVENC/QSV or ['-quality', value] for AMF.
 */
export function getGpuPreset(activeMode: GpuMode, softwarePreset: string): string[]
{
  if (activeMode === 'off') return ['-preset', softwarePreset]

  const mapped = PRESET_MAP[activeMode]?.[softwarePreset] || 'medium'

  if (activeMode === 'amf')
  {
    return ['-quality', mapped]
  }
  return ['-preset', mapped]
}

/**
 * Get quality args for GPU encoders (replaces -crf with the appropriate equivalent).
 * NVENC: -cq, QSV: -global_quality, AMF: -qp_i/-qp_p
 */
export function getGpuQualityArgs(activeMode: GpuMode, crf: number): string[]
{
  if (activeMode === 'off') return ['-crf', String(crf)]

  switch (activeMode)
  {
    case 'nvenc':
      return ['-rc', 'constqp', '-qp', String(crf)]
    case 'qsv':
      return ['-global_quality', String(crf)]
    case 'amf':
      return ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)]
    default:
      return ['-crf', String(crf)]
  }
}
