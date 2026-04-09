/**
 * @module main/ipc/editor
 * @description IPC handlers for the NLE editor - Clip mode trim/export
 * and shared probe functionality.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as crypto from 'crypto'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import type { ChildProcess } from 'child_process'
import { getConfigSync } from '../config'
import { runCommand } from '../ffmpeg/runner'
import { probeMedia, type MediaInfo } from '../ffmpeg/probe'
import { buildExportCommand, getExportDurationSeconds, type ExportRequest } from '../ffmpeg/processor'
import { startPreviewServer, registerPreviewPath } from '../preview-server'
import { sendToAll } from './helpers'
import { logger } from '../logger'
import { resolveGpuCodec, resolveEffectiveMode, getHwaccelInputArgs, getGpuQualityArgs, type GpuMode } from '../ffmpeg/gpu'

/** Quality → CRF mapping for H.264 encoding. */
const CRF_MAP: Record<string, number> = {
  low: 28,
  medium: 23,
  high: 18
}

/** Ref to the active export process for cancellation. */
let activeExportProcess: ChildProcess | null = null

/** Cache: source file path → temp WAV path for clean audio decode. */
const audioPreviewCache = new Map<string, string>()
/** Deduplicate concurrent extractions for the same file. */
const audioExtractionInProgress = new Map<string, Promise<string | null>>()

export function registerEditorIPC(): void {
  // ---------------------------------------------------------------
  // editor:cut - Trim a segment from a source file
  // ---------------------------------------------------------------
  ipcMain.handle(
    'editor:cut',
    async (
      _,
      filePath: string,
      inPoint: number,
      outPoint: number,
      options?: {
        mode?: 'fast' | 'precise'
        outputFormat?: string
        gifOptions?: { loop?: boolean; fps?: number; width?: number }
      }
    ) => {
      const config = getConfigSync()
      const ffmpegPath = config?.ffmpegPath
      if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'Source file not found' }

      const mode = options?.mode ?? 'fast'
      const fmt = options?.outputFormat ?? (path.extname(filePath).replace('.', '') || 'mp4')

      // Ask user where to save
      const win = BrowserWindow.getFocusedWindow()
      const defaultName = `${path.basename(filePath, path.extname(filePath))}_trimmed.${fmt}`
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export Trimmed Segment',
        defaultPath: path.join(config.outputDirectory || path.dirname(filePath), defaultName),
        filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
      })

      if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' }
      const outputPath = result.filePath

      try {
        const args: string[] = ['-y']
        const gpuMode = (config.gpuAcceleration || 'off') as GpuMode

        // Input seeking (fast) or output seeking (precise)
        if (mode === 'fast') {
          args.push('-ss', String(inPoint), '-to', String(outPoint), '-i', filePath, '-c', 'copy')
        } else if (fmt === 'gif') {
          const fps = options?.gifOptions?.fps ?? 15
          const width = options?.gifOptions?.width ?? 480
          args.push(
            '-ss', String(inPoint), '-to', String(outPoint),
            '-i', filePath,
            '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos`,
            '-loop', options?.gifOptions?.loop === false ? '-1' : '0'
          )
        } else {
          // Precise re-encode - use GPU if available
          const crf = CRF_MAP[options?.mode === 'precise' ? 'high' : 'medium'] ?? 18
          const gpuResult = await resolveGpuCodec(ffmpegPath, 'libx264', gpuMode)
          const hwArgs = getHwaccelInputArgs(gpuResult.activeMode, false)
          args.push(...hwArgs)
          args.push(
            '-ss', String(inPoint), '-to', String(outPoint),
            '-i', filePath,
            '-c:v', gpuResult.codec, ...getGpuQualityArgs(gpuResult.activeMode, crf),
            '-c:a', 'aac', '-b:a', '192k'
          )
        }

        args.push(outputPath)

        logger.info(`[editor:cut] Trimming ${path.basename(filePath)} [${inPoint}→${outPoint}] → ${fmt}`)

        // Parse progress from FFmpeg stderr
        const totalDuration = outPoint - inPoint
        const { promise } = runCommand(ffmpegPath, args, (line) => {
          const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
          if (match && totalDuration > 0) {
            const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])
            const percent = Math.min(100, Math.round((secs / totalDuration) * 100))
            sendToAll('editor:progress', { percent, message: `Exporting... ${percent}%` })
          }
        })

        const res = await promise
        if (res.code !== 0 && !res.killed) {
          return { success: false, error: `FFmpeg exited with code ${res.code}` }
        }

        logger.info(`[editor:cut] Export complete → ${outputPath}`)
        return { success: true, outputPath }
      } catch (err: any) {
        logger.error('[editor:cut] Export failed:', err)
        return { success: false, error: err.message || 'Export failed' }
      }
    }
  )

  // ---------------------------------------------------------------
  // editor:probeDetailed - Full FFprobe analysis for a source file
  // ---------------------------------------------------------------
  ipcMain.handle('editor:probeDetailed', async (_, filePath: string) => {
    try {
      const info: MediaInfo = await probeMedia(filePath)
      return { success: true, data: info }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ---------------------------------------------------------------
  // editor:createPreview - Serve the raw file via local HTTP server.
  // A plain HTTP server avoids all the media:// protocol quirks that
  // break seeking and stall large files in Chromium's video decoder.
  //
  // AVI files are transcoded to a fast-start MP4 proxy since Chromium
  // cannot decode AVI containers.  Everything else is served raw.
  // ---------------------------------------------------------------
  const videoProxyCache = new Map<string, string>()
  const videoProxyInProgress = new Map<string, Promise<string | null>>()

  ipcMain.handle('editor:createPreview', async (_, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }
    try {
      const ext = path.extname(filePath).toLowerCase()
      const baseUrl = await startPreviewServer()

      // Only AVI needs a proxy transcode
      if (ext !== '.avi') {
        const token = registerPreviewPath(filePath)
        return { success: true, data: `${baseUrl}/${token}` }
      }

      const config = getConfigSync()
      const ffmpegPath = config?.ffmpegPath
      if (!ffmpegPath) {
        const token = registerPreviewPath(filePath)
        return { success: true, data: `${baseUrl}/${token}` }
      }

      // Return cached proxy
      const cached = videoProxyCache.get(filePath)
      if (cached && fs.existsSync(cached)) {
        const token = registerPreviewPath(cached)
        return { success: true, data: `${baseUrl}/${token}` }
      }
      videoProxyCache.delete(filePath)

      // Coalesce concurrent requests
      if (!videoProxyInProgress.has(filePath)) {
        const transcodePromise = (async (): Promise<string | null> => {
          const tmpDir = path.join(os.tmpdir(), 'molex-video-proxy')
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

          const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 12)
          const proxyFile = path.join(tmpDir, `${hash}.mp4`)

          if (fs.existsSync(proxyFile)) {
            videoProxyCache.set(filePath, proxyFile)
            return proxyFile
          }

          logger.info(`[createPreview] Transcoding AVI proxy for: ${path.basename(filePath)}`)

          const args = [
            '-y', '-i', filePath,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            proxyFile
          ]

          const { promise } = runCommand(ffmpegPath, args)
          const result = await promise

          if (result.code !== 0) {
            logger.warn(`[createPreview] AVI proxy transcode failed (exit ${result.code})`)
            return null
          }

          videoProxyCache.set(filePath, proxyFile)
          return proxyFile
        })()

        videoProxyInProgress.set(filePath, transcodePromise)
        transcodePromise.finally(() => videoProxyInProgress.delete(filePath))
      }

      const proxyPath = await videoProxyInProgress.get(filePath)
      if (proxyPath && fs.existsSync(proxyPath)) {
        const token = registerPreviewPath(proxyPath)
        return { success: true, data: `${baseUrl}/${token}` }
      }

      // Transcode failed - fallback to raw
      const token = registerPreviewPath(filePath)
      return { success: true, data: `${baseUrl}/${token}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ---------------------------------------------------------------
  // editor:createAudioPreview - Extract audio to a clean WAV via
  // FFmpeg and serve it.  Eliminates decodeAudioData() static that
  // occurs when the browser tries to parse video container bytes.
  // ---------------------------------------------------------------
  ipcMain.handle('editor:createAudioPreview', async (_, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }

    const config = getConfigSync()
    const ffmpegPath = config?.ffmpegPath
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }

    try {
      // Return cached extraction
      const cached = audioPreviewCache.get(filePath)
      if (cached && fs.existsSync(cached)) {
        const baseUrl = await startPreviewServer()
        const token = registerPreviewPath(cached)
        return { success: true, data: `${baseUrl}/${token}` }
      }
      audioPreviewCache.delete(filePath)

      // Coalesce concurrent extractions for the same file
      if (audioExtractionInProgress.has(filePath)) {
        const tmpPath = await audioExtractionInProgress.get(filePath)
        if (tmpPath && fs.existsSync(tmpPath)) {
          const baseUrl = await startPreviewServer()
          const token = registerPreviewPath(tmpPath)
          return { success: true, data: `${baseUrl}/${token}` }
        }
        return { success: false, error: 'Audio extraction failed' }
      }

      const extractionPromise = (async (): Promise<string | null> => {
        const tmpDir = path.join(os.tmpdir(), 'molex-audio-preview')
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

        const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 12)
        const tmpFile = path.join(tmpDir, `${hash}.m4a`)

        // Reuse from a previous session
        if (fs.existsSync(tmpFile)) {
          audioPreviewCache.set(filePath, tmpFile)
          return tmpFile
        }

        // Extract first audio stream → compressed AAC (tiny vs raw PCM)
        const args = [
          '-y', '-i', filePath,
          '-vn', '-map', '0:a:0',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          tmpFile
        ]

        const { promise } = runCommand(ffmpegPath, args)
        const result = await promise

        if (result.code !== 0) {
          logger.warn(`[createAudioPreview] FFmpeg exit ${result.code} for ${filePath}`)
          return null
        }

        audioPreviewCache.set(filePath, tmpFile)
        return tmpFile
      })()

      audioExtractionInProgress.set(filePath, extractionPromise)
      const tmpPath = await extractionPromise
      audioExtractionInProgress.delete(filePath)

      if (!tmpPath) return { success: false, error: 'Audio extraction failed' }

      const baseUrl = await startPreviewServer()
      const token = registerPreviewPath(tmpPath)
      return { success: true, data: `${baseUrl}/${token}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ---------------------------------------------------------------
  // editor:remux - Remux a file keeping only selected streams,
  // optionally updating metadata and disposition flags.
  // ---------------------------------------------------------------
  ipcMain.handle(
    'editor:remux',
    async (
      _,
      filePath: string,
      options: {
        keepStreams: number[]
        metadata?: Record<string, string>
        dispositions?: Record<number, Record<string, number>>
      }
    ) => {
      const config = getConfigSync()
      const ffmpegPath = config?.ffmpegPath
      if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'Source file not found' }

      const ext = path.extname(filePath) || '.mkv'
      const defaultName = `${path.basename(filePath, ext)}_remuxed${ext}`
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Remuxed File',
        defaultPath: path.join(config.outputDirectory || path.dirname(filePath), defaultName),
        filters: [{ name: ext.replace('.', '').toUpperCase(), extensions: [ext.replace('.', '')] }]
      })

      if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' }
      const outputPath = result.filePath

      try {
        const args: string[] = ['-y', '-i', filePath]

        // Map only the selected streams
        for (const idx of options.keepStreams) {
          args.push('-map', `0:${idx}`)
        }

        args.push('-c', 'copy')

        // Apply metadata
        if (options.metadata) {
          // Clear all existing metadata first, then set new values
          args.push('-map_metadata', '-1')
          for (const [key, value] of Object.entries(options.metadata)) {
            if (value.trim()) {
              args.push('-metadata', `${key}=${value}`)
            }
          }
        }

        // Apply per-stream dispositions
        if (options.dispositions) {
          for (const [streamIdx, flags] of Object.entries(options.dispositions)) {
            const flagStr = Object.entries(flags)
              .filter(([, v]) => v === 1)
              .map(([k]) => k)
              .join('+')
            // Find the output stream index (position in keepStreams array)
            const outIdx = options.keepStreams.indexOf(Number(streamIdx))
            if (outIdx >= 0) {
              args.push(`-disposition:${outIdx}`, flagStr || '0')
            }
          }
        }

        args.push(outputPath)

        logger.info(`[editor:remux] Remuxing ${path.basename(filePath)} → ${path.basename(outputPath)}`)

        const { promise } = runCommand(ffmpegPath, args, (line) => {
          const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
          if (match) {
            const secs = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])
            sendToAll('editor:progress', { percent: Math.min(99, Math.round(secs)), message: `Remuxing…` })
          }
        })

        const res = await promise
        if (res.code !== 0 && !res.killed) {
          return { success: false, error: `FFmpeg exited with code ${res.code}` }
        }

        logger.info(`[editor:remux] Complete → ${outputPath}`)
        return { success: true, outputPath }
      } catch (err: any) {
        logger.error('[editor:remux] Failed:', err)
        return { success: false, error: err.message || 'Remux failed' }
      }
    }
  )

  // ---------------------------------------------------------------
  // editor:export - Render an NLE timeline to an output file
  // ---------------------------------------------------------------
  ipcMain.handle('editor:export', async (_, request: ExportRequest) => {
    const config = getConfigSync()
    const ffmpegPath = config?.ffmpegPath
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }

    // Validate that all source files exist on disk
    for (const src of request.sources) {
      if (!fs.existsSync(src.filePath)) {
        return { success: false, error: `Source file not found: ${path.basename(src.filePath)}` }
      }
    }

    try {
      const gpuMode = (config.gpuAcceleration || 'off') as GpuMode
      const args = await buildExportCommand(request, ffmpegPath, gpuMode)
      const totalDuration = getExportDurationSeconds(request)

      logger.info(
        `[editor:export] Starting timeline export (${totalDuration.toFixed(1)}s) → ${request.output.filePath}`
      )

      const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
        const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
        if (match && totalDuration > 0) {
          const secs =
            parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3])
          const percent = Math.min(99, Math.round((secs / totalDuration) * 100))
          sendToAll('editor:progress', { percent, message: `Rendering… ${percent}%` })
        }
      })

      activeExportProcess = proc
      const res = await promise
      activeExportProcess = null

      if (res.killed) {
        return { success: false, error: 'Export cancelled' }
      }
      if (res.code !== 0) {
        // Extract a useful error from stderr
        const lines = res.stderr.split('\n').filter((l) => l.trim())
        const errMsg = lines.slice(-3).join(' ').slice(0, 300)
        return { success: false, error: errMsg || `FFmpeg exited with code ${res.code}` }
      }

      sendToAll('editor:progress', { percent: 100, message: 'Export complete' })
      logger.info(`[editor:export] Complete → ${request.output.filePath}`)
      return { success: true, outputPath: request.output.filePath }
    } catch (err: any) {
      activeExportProcess = null
      logger.error('[editor:export] Failed:', err)
      return { success: false, error: err.message || 'Export failed' }
    }
  })

  // ---------------------------------------------------------------
  // editor:cancelExport - Kill the active export process
  // ---------------------------------------------------------------
  ipcMain.handle('editor:cancelExport', async () => {
    if (activeExportProcess) {
      activeExportProcess.kill('SIGTERM')
      activeExportProcess = null
      return { success: true }
    }
    return { success: false, error: 'No export in progress' }
  })

  // ---------------------------------------------------------------
  // editor:thumbnailStrip - Batch-extract frames as small JPEGs
  //   Uses parallel fast-seek (−ss before −i) for speed
  // ---------------------------------------------------------------
  const thumbnailStripCache = new Map<string, { interval: number; frames: string[] }>()
  const thumbnailStripInProgress = new Map<string, Promise<{ success: boolean; interval?: number; frames?: string[]; error?: string }>>()

  ipcMain.handle('editor:thumbnailStrip', async (_, filePath: string, durationSeconds: number) => {
    const config = getConfigSync()
    const ffmpegPath = config?.ffmpegPath
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' }

    // Return cached strip
    if (thumbnailStripCache.has(filePath)) {
      return { success: true, ...thumbnailStripCache.get(filePath)! }
    }

    // Coalesce concurrent requests for the same file
    if (thumbnailStripInProgress.has(filePath)) {
      return thumbnailStripInProgress.get(filePath)!
    }

    const doExtract = async (): Promise<{ success: boolean; interval?: number; frames?: string[]; error?: string }> => {
      const maxFrames = durationSeconds > 7200 ? 10 : durationSeconds > 1800 ? 20 : 30
      const interval = Math.max(1, durationSeconds / maxFrames)
      const count = Math.min(maxFrames, Math.max(2, Math.ceil(durationSeconds / interval)))
      const thumbHeight = 60
      const fpsRate = `1/${interval.toFixed(4)}`

      const hash = crypto.createHash('md5').update(filePath).digest('hex')
      const tmpDir = path.join(os.tmpdir(), `molex-strip-${hash}`)
      try {
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
      } catch { /* ignore */ }

      try {
        // Single FFmpeg call - one decode pass, outputs all frames
        const pattern = path.join(tmpDir, 'f%04d.jpg')
        const args = [
          '-i', filePath,
          '-vf', `fps=${fpsRate},scale=-2:${thumbHeight}`,
          '-q:v', '11',
          '-y',
          pattern
        ]

        const { promise } = runCommand(ffmpegPath, args)
        const res = await promise

        if (res.code !== 0) {
          return { success: false, error: 'Thumbnail extraction failed' }
        }

        // Read whatever frames were produced
        const results: string[] = []
        for (let i = 1; i <= count + 5; i++) {
          const filePath2 = path.join(tmpDir, `f${String(i).padStart(4, '0')}.jpg`)
          if (!fs.existsSync(filePath2)) break
          const buf = fs.readFileSync(filePath2)
          results.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
        }

        if (results.length === 0) {
          return { success: false, error: 'No frames extracted' }
        }

        const result = { interval, frames: results }
        thumbnailStripCache.set(filePath, result)
        return { success: true, ...result }
      } catch (err: any) {
        return { success: false, error: err.message }
      } finally {
        try {
          if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch { /* ignore */ }
      }
    }

    const promise = doExtract()
    thumbnailStripInProgress.set(filePath, promise)
    promise.finally(() => thumbnailStripInProgress.delete(filePath))
    return promise
  })

  // ---------------------------------------------------------------
  // editor:thumbnail - Extract a single frame as a base64 PNG
  // ---------------------------------------------------------------
  ipcMain.handle('editor:thumbnail', async (_, filePath: string, timeSec: number) => {
    const config = getConfigSync()
    const ffmpegPath = config?.ffmpegPath
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' }

    const tmpPath = path.join(
      os.tmpdir(),
      `molex-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    )

    try {
      const baseArgs = [
        '-ss',
        String(Math.max(0, timeSec)),
        '-i',
        filePath,
        '-vframes',
        '1',
        '-y',
        tmpPath
      ]

      // Try GPU hw-accel decoding first, fall back to CPU if it fails
      const gpuMode = (config.gpuAcceleration || 'off') as GpuMode
      const effectiveMode = await resolveEffectiveMode(ffmpegPath, gpuMode)
      let res: { code: number | null; killed: boolean; stderr: string }

      if (effectiveMode !== 'off') {
        const gpuArgs = ['-hwaccel', 'auto', ...baseArgs]
        const gpuRun = runCommand(ffmpegPath, gpuArgs)
        res = await gpuRun.promise
        // If hwaccel failed, retry without it
        if (res.code !== 0 || !fs.existsSync(tmpPath)) {
          const cpuRun = runCommand(ffmpegPath, baseArgs)
          res = await cpuRun.promise
        }
      } else {
        const cpuRun = runCommand(ffmpegPath, baseArgs)
        res = await cpuRun.promise
      }

      if (res.code !== 0 || !fs.existsSync(tmpPath)) {
        return { success: false, error: 'Failed to extract thumbnail' }
      }

      const buf = fs.readFileSync(tmpPath)
      const base64 = buf.toString('base64')
      return { success: true, data: `data:image/png;base64,${base64}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      } catch {
        /* ignore cleanup errors */
      }
    }
  })

  // ---------------------------------------------------------------
  // editor:waveform - Extract audio waveform peak data
  // ---------------------------------------------------------------
  ipcMain.handle('editor:waveform', async (_, filePath: string, numSamples?: number) => {
    const config = getConfigSync()
    const ffmpegPath = config?.ffmpegPath
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found' }

    const tmpPath = path.join(
      os.tmpdir(),
      `molex-wave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.raw`
    )
    const targetSamples = numSamples ?? 800

    try {
      // Extract mono f32le audio at 8 kHz to a temp file
      const args = ['-i', filePath, '-ac', '1', '-f', 'f32le', '-ar', '8000', '-y', tmpPath]

      const { promise } = runCommand(ffmpegPath, args)
      const res = await promise

      if (res.code !== 0 || !fs.existsSync(tmpPath)) {
        return { success: false, error: 'Failed to extract waveform' }
      }

      const buf = fs.readFileSync(tmpPath)
      const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

      // Down-sample to targetSamples peaks
      const chunkSize = Math.max(1, Math.floor(samples.length / targetSamples))
      const peaks: number[] = []
      for (let i = 0; i < samples.length; i += chunkSize) {
        let max = 0
        const end = Math.min(i + chunkSize, samples.length)
        for (let j = i; j < end; j++) {
          const abs = Math.abs(samples[j])
          if (abs > max) max = abs
        }
        peaks.push(max)
      }

      return { success: true, data: peaks }
    } catch (err: any) {
      return { success: false, error: err.message }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      } catch {
        /* ignore cleanup errors */
      }
    }
  })
}
