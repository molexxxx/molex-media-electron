import { spawn } from 'child_process'
import { getConfig } from '../config'
import { logger } from '../logger'

export interface AudioStream {
  index: number
  codec_name: string
  channels: number
  sample_rate: string
  bit_rate?: string
  tags?: Record<string, string>
}

export interface VideoStream {
  index: number
  codec_name: string
  width: number
  height: number
  duration?: string
  bit_rate?: string
}

export interface MediaInfo {
  audioStreams: AudioStream[]
  videoStreams: VideoStream[]
  format: {
    filename: string
    duration: string
    size: string
    bit_rate: string
    format_name: string
    tags?: Record<string, string>
  }
  isVideoFile: boolean
  isAudioOnly: boolean
}

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const config = await getConfig()
  const ffprobe = config.ffprobePath

  if (!ffprobe) throw new Error('ffprobe path not configured')

  const args = [
    '-i', filePath,
    '-show_streams',
    '-show_format',
    '-loglevel', 'quiet',
    '-print_format', 'json'
  ]

  logger.debug(`Probing: ${filePath}`)

  const result = await runProbe(ffprobe, args)

  try {
    const data = JSON.parse(result)
    const streams = data.streams || []
    const format = data.format || {}

    const audioStreams: AudioStream[] = streams
      .filter((s: any) => s.codec_type === 'audio')
      .map((s: any) => ({
        index: s.index,
        codec_name: s.codec_name || 'unknown',
        channels: parseInt(s.channels, 10) || 2,
        sample_rate: s.sample_rate || '48000',
        bit_rate: s.bit_rate,
        tags: s.tags
      }))

    const videoStreams: VideoStream[] = streams
      .filter((s: any) => s.codec_type === 'video')
      .map((s: any) => ({
        index: s.index,
        codec_name: s.codec_name || 'unknown',
        width: parseInt(s.width, 10) || 0,
        height: parseInt(s.height, 10) || 0,
        duration: s.duration,
        bit_rate: s.bit_rate
      }))

    return {
      audioStreams,
      videoStreams,
      format: {
        filename: format.filename || filePath,
        duration: format.duration || '0',
        size: format.size || '0',
        bit_rate: format.bit_rate || '0',
        format_name: format.format_name || 'unknown',
        tags: format.tags
      },
      isVideoFile: videoStreams.length > 0,
      isAudioOnly: videoStreams.length === 0 && audioStreams.length > 0
    }
  } catch (e) {
    logger.warn(`Primary probe failed for ${filePath}, trying fallback...`)
    return fallbackProbe(ffprobe, filePath)
  }
}

async function fallbackProbe(ffprobe: string, filePath: string): Promise<MediaInfo> {
  const args = [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index,codec_name,channels,sample_rate',
    '-of', 'json',
    '-i', filePath
  ]

  try {
    const result = await runProbe(ffprobe, args)
    const data = JSON.parse(result)
    const streams = data.streams || []

    const audioStreams: AudioStream[] = streams.map((s: any) => ({
      index: s.index || 0,
      codec_name: s.codec_name || 'unknown',
      channels: parseInt(s.channels, 10) || 2,
      sample_rate: s.sample_rate || '48000'
    }))

    if (audioStreams.length === 0) {
      audioStreams.push({ index: 0, codec_name: 'unknown', channels: 2, sample_rate: '48000' })
    }

    return {
      audioStreams,
      videoStreams: [],
      format: {
        filename: filePath,
        duration: '0',
        size: '0',
        bit_rate: '0',
        format_name: 'unknown'
      },
      isVideoFile: false,
      isAudioOnly: audioStreams.length > 0
    }
  } catch {
    logger.error(`All probe methods failed for ${filePath}`)
    return {
      audioStreams: [{ index: 0, codec_name: 'unknown', channels: 2, sample_rate: '48000' }],
      videoStreams: [],
      format: { filename: filePath, duration: '0', size: '0', bit_rate: '0', format_name: 'unknown' },
      isVideoFile: false,
      isAudioOnly: true
    }
  }
}

function runProbe(ffprobe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobe, args, { timeout: 30000 })
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (d) => (stdout += d.toString()))
    proc.stderr?.on('data', (d) => (stderr += d.toString()))

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`ffprobe exited with code ${code}: ${stderr}`))
    })

    proc.on('error', (err) => reject(err))
  })
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
