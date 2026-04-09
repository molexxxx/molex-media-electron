/**
 * @module main/ffmpeg/bootstrap
 * @description FFmpeg/FFprobe binary download and installation.
 *
 * Detects the host platform and architecture, downloads the appropriate
 * FFmpeg build from GitHub releases, extracts the archive, and verifies
 * the installation by running `ffmpeg -version`. Reports progress
 * percentage back to the renderer for the setup wizard UI.
 */

import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { getFFmpegBinDir } from '../config'
import { logger } from '../logger'

export interface BootstrapProgress {
  stage: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error'
  message: string
  percent: number
  detail?: string
}

export interface FFmpegPaths {
  ffmpeg: string
  ffprobe: string
}

type ProgressCallback = (progress: BootstrapProgress) => void

const DOWNLOAD_URLS: Record<string, { url: string; type: 'zip' | 'tar' }> = {
  win32: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    type: 'zip'
  },
  darwin: {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    type: 'zip'
  },
  linux: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    type: 'tar'
  }
}

const FFPROBE_MAC_URL = 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip'

/**
 * Returns the platform-specific executable name (appends `.exe` on Windows).
 * @param base - The base binary name (e.g. `"ffmpeg"`).
 */
function getExecutableName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

/**
 * Searches for existing FFmpeg and FFprobe binaries, first in the app's
 * data directory and then in the system PATH.
 *
 * @returns The paths to both binaries, or `null` if neither location has them.
 */
export async function findSystemFFmpeg(): Promise<FFmpegPaths | null> {
  const ffmpegName = getExecutableName('ffmpeg')
  const ffprobeName = getExecutableName('ffprobe')

  const binDir = getFFmpegBinDir()
  const localFFmpeg = path.join(binDir, ffmpegName)
  const localFFprobe = path.join(binDir, ffprobeName)

  if (fs.existsSync(localFFmpeg) && fs.existsSync(localFFprobe)) {
    const valid = await verifyBinary(localFFmpeg)
    if (valid) {
      logger.success('Found FFmpeg in app data directory')
      return { ffmpeg: localFFmpeg, ffprobe: localFFprobe }
    }
  }

  const systemFFmpeg = await findInPath('ffmpeg')
  const systemFFprobe = await findInPath('ffprobe')

  if (systemFFmpeg && systemFFprobe) {
    logger.success(`Found system FFmpeg: ${systemFFmpeg}`)
    return { ffmpeg: systemFFmpeg, ffprobe: systemFFprobe }
  }

  return null
}

/**
 * Searches directories listed in `$PATH` for an executable by name.
 * @param name - Base binary name to look for.
 * @returns The first matching absolute path, or `null`.
 */
async function findInPath(name: string): Promise<string | null> {
  const execName = getExecutableName(name)
  const pathDirs = (process.env.PATH || '').split(path.delimiter)

  for (const dir of pathDirs) {
    const fullPath = path.join(dir, execName)
    try {
      await fs.promises.access(fullPath, fs.constants.X_OK)
      return fullPath
    } catch {
      continue
    }
  }
  return null
}

/**
 * Runs `ffmpeg -version` to verify the binary is functional.
 * @param binPath - Absolute path to the binary to verify.
 * @returns `true` if the binary produces valid version output.
 */
async function verifyBinary(binPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(binPath, ['-version'], { timeout: 10000 })
    let output = ''
    proc.stdout?.on('data', (d) => (output += d.toString()))
    proc.on('close', (code) => resolve(code === 0 && output.includes('ffmpeg')))
    proc.on('error', () => resolve(false))
  })
}

/**
 * Downloads the content at `url`, following HTTP 3xx redirects, and
 * reports byte-level progress to an optional callback.
 *
 * @param url        - The URL to download.
 * @param onProgress - Optional callback receiving `(downloaded, total)` byte counts.
 * @returns The downloaded file contents as a Buffer.
 */
function followRedirects(url: string, onProgress?: (downloaded: number, total: number) => void, depth = 0): Promise<Buffer> {
  if (depth > 10) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    const req = protocol.get(url, { headers: { 'User-Agent': 'molexMedia/3.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        followRedirects(res.headers.location, onProgress, depth + 1).then(resolve).catch(reject)
        return
      }

      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`))
        return
      }

      const total = parseInt(res.headers['content-length'] || '0', 10)
      const chunks: Buffer[] = []
      let downloaded = 0

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        downloaded += chunk.length
        onProgress?.(downloaded, total)
      })

      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(300000, () => {
      req.destroy()
      reject(new Error('Download timed out'))
    })
  })
}

/**
 * Downloads, extracts, and verifies FFmpeg and FFprobe for the current
 * platform. Reports stage-based progress to the setup wizard UI.
 *
 * On macOS the FFprobe binary is downloaded separately from evermeet.cx
 * because the FFmpeg-only release does not include it.
 *
 * @param onProgress - Callback receiving {@link BootstrapProgress} updates.
 * @returns The absolute paths to the installed binaries.
 * @throws If the platform is unsupported or verification fails.
 */
export async function downloadFFmpeg(onProgress: ProgressCallback): Promise<FFmpegPaths> {
  const platform = process.platform
  const config = DOWNLOAD_URLS[platform]

  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  const binDir = getFFmpegBinDir()
  fs.mkdirSync(binDir, { recursive: true })

  onProgress({ stage: 'downloading', message: 'Downloading FFmpeg...', percent: 0 })

  logger.info(`Downloading FFmpeg for ${platform} from ${config.url}`)

  const data = await followRedirects(config.url, (downloaded, total) => {
    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0
    const mb = (downloaded / 1024 / 1024).toFixed(1)
    const totalMb = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?'
    onProgress({
      stage: 'downloading',
      message: `Downloading FFmpeg... ${mb}MB / ${totalMb}MB`,
      percent: pct,
      detail: `${pct}% complete`
    })
  })

  onProgress({ stage: 'extracting', message: 'Extracting FFmpeg binaries...', percent: 0 })
  logger.info(`Download complete (${(data.length / 1024 / 1024).toFixed(1)}MB), extracting...`)

  const tempDir = path.join(os.tmpdir(), `molex-ffmpeg-${Date.now()}`)
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    if (config.type === 'zip') {
      const zipPath = path.join(tempDir, 'ffmpeg.zip')
      fs.writeFileSync(zipPath, data)
      const extractZip = (await import('extract-zip')).default
      await extractZip(zipPath, { dir: tempDir })
    } else {
      const tarPath = path.join(tempDir, 'ffmpeg.tar.xz')
      fs.writeFileSync(tarPath, data)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('tar', ['xf', tarPath, '-C', tempDir], { timeout: 120000 })
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
        proc.on('error', reject)
      })
    }

    onProgress({ stage: 'extracting', message: 'Locating binaries...', percent: 50 })

    const ffmpegName = getExecutableName('ffmpeg')
    const ffprobeName = getExecutableName('ffprobe')

    const ffmpegSrc = findFile(tempDir, ffmpegName)
    let ffprobeSrc = findFile(tempDir, ffprobeName)

    if (!ffmpegSrc) {
      throw new Error('Could not find ffmpeg binary in download')
    }

    const ffmpegDest = path.join(binDir, ffmpegName)
    fs.copyFileSync(ffmpegSrc, ffmpegDest)
    if (process.platform !== 'win32') {
      fs.chmodSync(ffmpegDest, 0o755)
    }

    if (!ffprobeSrc && platform === 'darwin') {
      onProgress({ stage: 'downloading', message: 'Downloading ffprobe for macOS...', percent: 70 })
      const probeData = await followRedirects(FFPROBE_MAC_URL)
      const probeZip = path.join(tempDir, 'ffprobe.zip')
      fs.writeFileSync(probeZip, probeData)
      const extractZip = (await import('extract-zip')).default
      await extractZip(probeZip, { dir: tempDir })
      ffprobeSrc = findFile(tempDir, ffprobeName)
    }

    if (!ffprobeSrc) {
      throw new Error('Could not find ffprobe binary in download')
    }

    const ffprobeDest = path.join(binDir, ffprobeName)
    fs.copyFileSync(ffprobeSrc, ffprobeDest)
    if (process.platform !== 'win32') {
      fs.chmodSync(ffprobeDest, 0o755)
    }

    onProgress({ stage: 'verifying', message: 'Verifying FFmpeg installation...', percent: 90 })

    const valid = await verifyBinary(ffmpegDest)
    if (!valid) {
      throw new Error('FFmpeg verification failed - binary may be corrupt')
    }

    logger.success('FFmpeg installed and verified successfully')
    onProgress({ stage: 'complete', message: 'FFmpeg is ready!', percent: 100 })

    return { ffmpeg: ffmpegDest, ffprobe: ffprobeDest }
  } finally {
    fs.rm(tempDir, { recursive: true, force: true }, () => {})
  }
}

/**
 * Recursively searches a directory tree for a file by exact name.
 * @param dir  - Root directory to begin the search.
 * @param name - Exact filename to match.
 * @returns The first matching absolute path, or `null`.
 */
function findFile(dir: string, name: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return fullPath
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name)
      if (found) return found
    }
  }
  return null
}

/**
 * Runs `ffmpeg -version` and extracts the version string.
 * @param ffmpegPath - Absolute path to the FFmpeg binary.
 * @returns The version string (e.g. `"6.1-full_build"`) or `"unknown"`.
 */
export async function getFFmpegVersion(ffmpegPath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-version'], { timeout: 10000 })
    let output = ''
    proc.stdout?.on('data', (d) => (output += d.toString()))
    proc.on('close', () => {
      const match = output.match(/ffmpeg version (\S+)/)
      resolve(match ? match[1] : 'unknown')
    })
    proc.on('error', () => resolve('error'))
  })
}
