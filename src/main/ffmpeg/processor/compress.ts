/**
 * @module main/ffmpeg/processor/compress
 * @description Media file compression with CRF and target-size modes.
 *
 * Builds a codec-aware ffmpeg pipeline that supports:
 *   - CRF (quality-targeted) and target-size (bitrate-targeted) modes
 *   - libx264, libx265, libvpx-vp9, libaom-av1, libsvtav1 video codecs
 *   - AAC, libopus, FLAC, and stream-copy audio codecs
 *   - Optional two-pass encoding for target-size mode
 *   - Optional output scaling (maxHeight cap)
 *   - Optional pixel format (yuv420p / yuv420p10le)
 *   - Optional encoder tune (film/animation/grain/fastdecode/zerolatency)
 *   - Per-codec CRF tables and speed→cpu-used translation tables
 *   - GPU encoder dispatch (NVENC/QSV/AMF) via resolveGpuCodec
 *
 * Backwards compatible with the legacy CompressOptions shape: callers
 * that only set `targetSizeMB` and `quality` get the same behavior as
 * the original implementation.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { getConfig } from '../../config'
import { logger } from '../../logger'
import { probeMedia, formatDuration, formatFileSize } from '../probe'
import { runCommand, parseProgress } from '../runner'
import {
  type ProcessingTask,
  type TaskProgressCallback,
  type CompressOptions,
  createTempPath,
  cleanupTemp,
  formatElapsed,
  extractFFmpegError,
  safeRename,
  ensureDir,
  validateOutput
} from './types'
import {
  resolveGpuCodec,
  getHwaccelInputArgs,
  getGpuPreset,
  getGpuQualityArgs,
  type GpuMode
} from '../gpu'

/** Quality preset → CRF value per codec. lossless rows used as-is (0). */
const CRF_MAP: Record<string, Record<string, number>> = {
  libx264:      { lossless: 0, high: 18, medium: 23, low: 28 },
  libx265:      { lossless: 0, high: 22, medium: 28, low: 33 },
  'libvpx-vp9': { lossless: 0, high: 24, medium: 31, low: 38 },
  'libaom-av1': { lossless: 0, high: 22, medium: 28, low: 35 },
  libsvtav1:    { lossless: 0, high: 24, medium: 30, low: 36 },
}

/** Speed → -cpu-used for VP9 (0=slowest, 8=fastest). */
const VP9_CPU_MAP: Record<string, string> = { veryslow: '0', slow: '1', medium: '2', fast: '4', veryfast: '5' }
/** Speed → -cpu-used for libaom-av1 (1=slowest, 8=fastest). */
const AV1_CPU_MAP: Record<string, string> = { veryslow: '1', slow: '2', medium: '4', fast: '6', veryfast: '8' }
/** Speed → -preset for libsvtav1 (0=slowest, 13=fastest). */
const SVTAV1_PRESET_MAP: Record<string, string> = { veryslow: '2', slow: '4', medium: '6', fast: '8', veryfast: '10' }

/** Tunes that x264/x265 accept and that we expose in the UI. */
const TUNE_ALLOWED = new Set(['film', 'animation', 'grain', 'fastdecode', 'zerolatency'])

/** Platform-appropriate null sink path for two-pass first pass. */
const NULL_SINK = os.platform() === 'win32' ? 'NUL' : '/dev/null'

/**
 * Compute the per-codec encoder-speed argument pair (e.g. `['-preset', 'slow']`
 * for x264/x265, `['-cpu-used', '4']` for AV1/VP9).
 */
function getSpeedArgs(codec: string, speed: string): string[] {
  if (codec === 'libx264' || codec === 'libx265') return ['-preset', speed]
  if (codec === 'libvpx-vp9') return ['-cpu-used', VP9_CPU_MAP[speed] || '2']
  if (codec === 'libaom-av1') return ['-cpu-used', AV1_CPU_MAP[speed] || '4']
  if (codec === 'libsvtav1') return ['-preset', SVTAV1_PRESET_MAP[speed] || '6']
  return []
}

/** Default audio bitrate by quality tier (used when caller didn't specify). */
function defaultAudioBitrate(quality: string): string {
  if (quality === 'lossless') return ''
  if (quality === 'low') return '128k'
  if (quality === 'medium') return '192k'
  return '256k'
}

/** Resolve effective CRF for the chosen codec + quality (or custom override). */
function resolveCrf(opts: CompressOptions, codec: string): number {
  if (opts.quality === 'custom' && typeof opts.customCrf === 'number') {
    return Math.max(0, Math.min(51, Math.round(opts.customCrf)))
  }
  const table = CRF_MAP[codec] || CRF_MAP.libx264
  return table[opts.quality] ?? 23
}

/**
 * Build the audio output args for a video file.
 * Returns the argv slice (e.g. `['-c:a', 'aac', '-b:a', '192k']`).
 */
function buildVideoAudioArgs(opts: CompressOptions): string[] {
  const ac = opts.audioCodec
  if (ac === 'copy') return ['-c:a', 'copy']
  if (ac === 'flac') return ['-c:a', 'flac']
  const abr = opts.audioBitrate || defaultAudioBitrate(opts.quality)
  if (ac === 'libopus') return ['-c:a', 'libopus', '-b:a', abr || '128k']
  // Default = AAC (preserves legacy behavior)
  return ['-c:a', 'aac', '-b:a', abr || '256k']
}

/**
 * Build the audio output args for an audio-only file.
 * Lossless quality maps to FLAC unless the caller picked another codec.
 */
function buildAudioOnlyArgs(opts: CompressOptions): string[] {
  const ac = opts.audioCodec
  if (ac === 'copy') return ['-c:a', 'copy']
  if (ac === 'flac' || (!ac && opts.quality === 'lossless')) return ['-c:a', 'flac']
  const abr = opts.audioBitrate || defaultAudioBitrate(opts.quality) || '192k'
  if (ac === 'libopus') return ['-c:a', 'libopus', '-b:a', abr]
  return ['-c:a', 'aac', '-b:a', abr]
}

/**
 * Compress a media file using quality-preset (CRF) or target-size (ABR) encoding.
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
export async function compressFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) { task.status = 'error'; task.error = 'FFmpeg not configured'; onProgress(task); return task }

  const opts: CompressOptions = task.compressOptions || { targetSizeMB: 0, quality: 'high' }

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing media...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0
    const totalDuration = parseFloat(info.format.duration) || 0

    logger.info(`Compressing: ${task.fileName} (${opts.quality} quality)`)

    task.status = 'processing'
    task.message = `Compressing (${opts.quality} quality)...`
    task.progress = 5
    onProgress(task)

    const tempPath = createTempPath(task.filePath, config.tempSuffix)

    const softwareCodec = opts.videoCodec || 'libx264'
    const speed = opts.speed || (opts.quality === 'lossless' ? 'veryslow' : 'medium')
    const gpuMode = (config.gpuAcceleration || 'off') as GpuMode

    // Resolve GPU codec (auto-detect if needed)
    const gpuResult = info.isVideoFile
      ? await resolveGpuCodec(ffmpegPath, softwareCodec, gpuMode)
      : { codec: softwareCodec, activeMode: 'off' as GpuMode, isGpu: false }
    const codec = gpuResult.codec

    if (gpuResult.isGpu) {
      logger.info(`[compress] Using GPU encoder: ${codec} (${gpuResult.activeMode})`)
    }

    // Mode resolution: explicit mode wins; otherwise legacy targetSizeMB>0 implies target-size.
    const wantsTargetSize = opts.mode === 'target-size' || (opts.mode == null && opts.targetSizeMB > 0)
    const twoPass = wantsTargetSize && opts.twoPass === true && !gpuResult.isGpu && info.isVideoFile

    // Hardware-accel input flags must come before -i
    const hwaccelArgs = getHwaccelInputArgs(gpuResult.activeMode, false)
    const inputArgs = ['-y', ...hwaccelArgs, '-i', task.filePath, '-threads', '0']

    // Video filter chain (currently just optional scaling).
    const videoFilters: string[] = []
    const srcHeight = info.videoStreams?.[0]?.height ?? 0
    if (info.isVideoFile && opts.maxHeight && opts.maxHeight > 0 && srcHeight > opts.maxHeight) {
      // -2 keeps aspect ratio while ensuring even width (required by libx264/libx265)
      videoFilters.push(`scale=-2:${opts.maxHeight}`)
    }

    /**
     * Build the encoder argument tail (everything between input args and output path).
     * Used twice for two-pass encoding.
     */
    const buildEncoderArgs = (passNum: 0 | 1 | 2): string[] => {
      const out: string[] = []

      if (!info.isVideoFile) {
        out.push(...buildAudioOnlyArgs(opts))
        return out
      }

      if (videoFilters.length > 0) out.push('-vf', videoFilters.join(','))
      out.push('-c:v', codec)

      // Speed / preset (codec + GPU aware)
      if (gpuResult.isGpu) {
        out.push(...getGpuPreset(gpuResult.activeMode, speed))
      } else {
        out.push(...getSpeedArgs(codec, speed))
      }

      // Quality vs bitrate
      if (wantsTargetSize && totalDuration > 0 && opts.targetSizeMB > 0) {
        const targetBits = opts.targetSizeMB * 8 * 1024 * 1024
        // Estimate audio bitrate from settings (kbps → bps)
        const abrStr = opts.audioBitrate || defaultAudioBitrate(opts.quality) || '128k'
        const abrBps = (parseInt(abrStr, 10) || 128) * 1000
        const videoBitrate = Math.max(100000, Math.floor((targetBits / totalDuration) - abrBps))
        out.push('-b:v', String(videoBitrate),
                 '-maxrate', String(videoBitrate * 2),
                 '-bufsize', String(videoBitrate * 4))
      } else {
        const crf = resolveCrf(opts, softwareCodec)
        if (gpuResult.isGpu) {
          out.push(...getGpuQualityArgs(gpuResult.activeMode, crf))
        } else {
          out.push('-crf', String(crf))
        }
        // VP9 needs -b:v 0 to enable true CRF mode
        if (codec === 'libvpx-vp9') out.push('-b:v', '0')
      }

      // Pixel format (skip for GPU encoders — they manage their own)
      if (opts.pixelFormat && !gpuResult.isGpu) {
        out.push('-pix_fmt', opts.pixelFormat)
      }

      // Tune (x264/x265 only)
      if (opts.tune && TUNE_ALLOWED.has(opts.tune) && (softwareCodec === 'libx264' || softwareCodec === 'libx265') && !gpuResult.isGpu) {
        out.push('-tune', opts.tune)
      }

      // Two-pass scaffolding
      if (twoPass) {
        if (passNum === 1) {
          out.push('-pass', '1', '-an', '-f', 'null')
        } else if (passNum === 2) {
          out.push('-pass', '2')
        }
      }

      // Audio (skip on pass 1)
      if (!(twoPass && passNum === 1)) {
        out.push(...buildVideoAudioArgs(opts))
      }

      return out
    }

    /**
     * Run a single ffmpeg invocation and surface progress through the callback.
     */
    const runPass = async (extraArgs: string[], outPath: string, pass: 0 | 1 | 2): Promise<void> => {
      const args = [...inputArgs, ...extraArgs]
      if (info.isVideoFile && config.preserveSubtitles && pass !== 1) args.push('-c:s', 'copy')
      args.push(outPath)

      const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
        const progress = parseProgress(line)
        if (progress && totalDuration > 0) {
          // Map two-pass progress into [5,95] across both passes
          let pct: number
          if (twoPass) {
            const passBase = pass === 1 ? 5 : 50
            const passSpan = 45
            pct = Math.min(95, passBase + Math.round((progress.time / totalDuration) * passSpan))
          } else {
            pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
          }
          task.progress = pct
          const passLabel = twoPass ? ` [pass ${pass}/2]` : ''
          task.message = `Compressing${passLabel}... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
          onProgress(task)
        }
      })

      if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })
      const result = await promise

      if (result.killed || abortSignal?.signal.aborted) {
        throw new Error('__cancelled__')
      }
      if (result.code !== 0) {
        const reason = extractFFmpegError(result.stderr)
        logger.ffmpeg('ERROR', result.stderr.slice(-1500))
        throw new Error(`Compression failed: ${reason}`)
      }
    }

    try {
      if (twoPass) {
        // Two-pass: pass 1 writes the log file, pass 2 produces the output.
        await runPass(buildEncoderArgs(1), NULL_SINK, 1)
        await runPass(buildEncoderArgs(2), tempPath, 2)
      } else {
        await runPass(buildEncoderArgs(0), tempPath, 0)
      }
    } catch (err: any) {
      if (err && err.message === '__cancelled__') {
        cleanupTemp(tempPath)
        task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task
      }
      cleanupTemp(tempPath)
      throw err
    }

    task.status = 'finalizing'
    task.message = 'Finalizing...'
    task.progress = 96
    onProgress(task)

    validateOutput(tempPath, 'Compression')

    // Clean up two-pass log file if present
    if (twoPass) {
      try { fs.unlinkSync('ffmpeg2pass-0.log') } catch { /* ignore */ }
      try { fs.unlinkSync('ffmpeg2pass-0.log.mbtree') } catch { /* ignore */ }
    }

    if (config.afterProcessing === 'replace') {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
      task.outputPath = task.filePath
    } else {
      const outDir = task.outputDir || config.outputDirectory || path.dirname(task.filePath)
      ensureDir(outDir)
      const outPath = path.join(outDir, `compressed_${path.basename(task.filePath)}`)
      safeRename(tempPath, outPath)
      task.outputPath = outPath
    }

    task.outputSize = fs.statSync(task.outputPath!).size
    const ratio = task.inputSize ? Math.round((1 - task.outputSize / task.inputSize) * 100) : 0
    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.message = `Compressed (${ratio}% smaller) in ${formatElapsed(task.startedAt!, task.completedAt)}`
    logger.success(`Compressed: ${task.fileName} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)}, ${ratio}% reduction)`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'; task.error = err.message; task.message = `Error: ${err.message}`; task.completedAt = Date.now()
    logger.error(`Failed to compress ${task.fileName}: ${err.message}`); onProgress(task); return task
  }
}
