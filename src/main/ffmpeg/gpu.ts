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
let _adapterNames: string[] | null = null

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
  // binary not ready yet on early app startup), do NOT cache 'off' -
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
    // ignore - fall back to attempting each test encode blind
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
      // Use 256x144 (16:9, evenly aligned) - large enough to satisfy
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
        logger.info(`[gpu] ${mode}: test encode failed - ${reason}`)
      }
    } catch (err)
    {
      logger.info(`[gpu] ${mode}: spawn error - ${(err as Error)?.message ?? 'unknown'}`)
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
  _adapterNames = null
}

/** The hardware vendors a GPU mode encodes on. */
export type GpuVendorName = 'nvidia' | 'intel' | 'amd'

/** The vendor of a hardware mode; null for software. */
export function vendorOfMode(mode: GpuMode): GpuVendorName | null
{
  switch (mode)
  {
    case 'nvenc':
      return 'nvidia'
    case 'qsv':
      return 'intel'
    case 'amf':
      return 'amd'
    default:
      return null
  }
}

/** The hardware encoders a mode offers, in the order of GPU_CODECS; empty for software and auto. */
export function gpuEncodersFor(mode: GpuMode): string[]
{
  return Object.values(GPU_CODECS[mode] ?? {})
}

const VENDOR_PATTERNS: Record<GpuVendorName, RegExp> = {
  nvidia: /\b(nvidia|geforce|quadro|tesla)\b/i,
  intel: /\bintel\b/i,
  amd: /\b(amd|radeon|ati)\b/i
}

/** The vendor a display adapter's name belongs to, or null when it names none of the three. */
export function vendorOfAdapter(name: string): GpuVendorName | null
{
  const found = (Object.keys(VENDOR_PATTERNS) as GpuVendorName[]).find((v) => VENDOR_PATTERNS[v].test(name))
  return found ?? null
}

/**
 * Display adapter names from the platform's listing: one name per line of the Win32_VideoController query on
 * Windows, the "Chipset Model" lines of system_profiler on macOS, and the VGA, 3D, and display controller lines of
 * lspci on Linux.
 */
export function parseAdapterNames(platform: NodeJS.Platform, stdout: string): string[]
{
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (platform === 'win32')
  {
    return lines
  }
  if (platform === 'darwin')
  {
    return lines.flatMap((l) =>
    {
      const m = /^Chipset Model:\s*(.+)$/.exec(l)
      return m ? [m[1].trim()] : []
    })
  }
  return lines.flatMap((l) =>
  {
    const m = /(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/.exec(l)
    return m ? [m[1].replace(/\s*\(rev [0-9a-f]+\)$/i, '').trim()] : []
  })
}

/** The adapter a vendor's encoder runs on: the first name of that vendor, else the first listed name, else null. */
export function adapterFor(names: readonly string[], vendor: GpuVendorName | null): string | null
{
  if (vendor !== null)
  {
    const match = names.find((n) => vendorOfAdapter(n) === vendor)
    if (match !== undefined)
    {
      return match
    }
  }
  return names[0] ?? null
}

/** The command that lists display adapters on a platform; null where none is known. */
export function adapterQuery(platform: NodeJS.Platform, systemRoot: string | undefined = process.env.SystemRoot): { file: string; args: string[] } | null
{
  if (platform === 'win32')
  {
    const root = systemRoot ?? 'C:\\Windows'
    return {
      file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name']
    }
  }
  if (platform === 'darwin')
  {
    return { file: '/usr/sbin/system_profiler', args: ['SPDisplaysDataType'] }
  }
  if (platform === 'linux')
  {
    return { file: 'lspci', args: [] }
  }
  return null
}

/**
 * The display adapter names of this machine, read once per detection cycle. A query that cannot run answers an
 * empty list and is tried again on the next call.
 */
export async function listGpuAdapters(platform: NodeJS.Platform = process.platform): Promise<string[]>
{
  if (_adapterNames)
  {
    return _adapterNames
  }
  const query = adapterQuery(platform)
  if (!query)
  {
    return []
  }
  try
  {
    const { promise } = runCommand(query.file, query.args, undefined, { log: false })
    const result = await promise
    if (result.code !== 0)
    {
      logger.info(`[gpu] Adapter query exited ${result.code}`)
      return []
    }
    _adapterNames = parseAdapterNames(platform, result.stdout)
    return _adapterNames
  }
  catch (err)
  {
    logger.info(`[gpu] Adapter query failed - ${(err as Error)?.message ?? 'unknown'}`)
    return []
  }
}

/** What the batch page shows of GPU encoding: the vendor, the adapter that encodes, and its encoders. */
export interface GpuSummary
{
  vendor: GpuVendorName | null
  name: string | null
  encoders: string[]
}

/** The detected GPU for `CapabilitySummary.gpu`: the effective mode's vendor, its adapter's name, and encoders. */
export async function detectGpuSummary(ffmpegPath: string, gpuMode: GpuMode, platform: NodeJS.Platform = process.platform): Promise<GpuSummary>
{
  const mode = await resolveEffectiveMode(ffmpegPath, gpuMode)
  const vendor = vendorOfMode(mode)
  if (vendor === null)
  {
    return { vendor: null, name: null, encoders: [] }
  }
  return { vendor, name: adapterFor(await listGpuAdapters(platform), vendor), encoders: gpuEncodersFor(mode) }
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
 *
 * Verified against the encoders' own AVOption tables:
 * - NVENC: `-rc constqp` + `-qp` (constant quantiser). `-cq` is the VBR
 *   constant-quality knob and is not what we want here.
 * - QSV: `-global_quality`, a generic encoder option rather than a
 *   QSV-specific one.
 * - AMF: `-rc cqp` + `-qp_i`/`-qp_p`/`-qp_b`. All three frame types have
 *   to be set; any left at the default -1 is chosen by the encoder, which
 *   makes the requested quality only partly honoured.
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
      return ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-qp_b', String(crf)]
    default:
      return ['-crf', String(crf)]
  }
}
