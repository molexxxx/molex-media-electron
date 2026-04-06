/**
 * @module main/ytdlp/binary
 * @description yt-dlp binary acquisition and wrapper.
 *
 * Handles downloading the platform-specific yt-dlp binary on first use,
 * locating system-installed copies on PATH, and providing a configured
 * `youtube-dl-exec` instance for other modules to use.
 */

import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { create as createYtDl } from 'youtube-dl-exec'
import { getUserDataPath, getConfig } from '../config'
import { logger } from '../logger'

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

/** Directory where the yt-dlp binary is stored. */
function getBinDir(): string {
  return path.join(getUserDataPath(), 'ytdlp-bin')
}

/** Full path to the yt-dlp executable. */
function getExecutable(): string {
  return path.join(getBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
}

/* ------------------------------------------------------------------ */
/*  Download URLs                                                      */
/* ------------------------------------------------------------------ */

const DOWNLOAD_URLS: Record<string, string> = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
}

/**
 * Follow HTTP 3xx redirects and return the response body as a Buffer.
 * Used for binary downloads from GitHub releases.
 */
function followRedirects(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { headers: { 'User-Agent': 'molexMedia/3.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        followRedirects(res.headers.location).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timed out')) })
  })
}

/* ------------------------------------------------------------------ */
/*  Binary management                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ensure the yt-dlp binary is available. Downloads it from GitHub
 * releases if not already present and not found on the system PATH.
 *
 * @returns Absolute path to the yt-dlp binary.
 */
export async function ensureYtDlp(): Promise<string> {
  const binPath = getExecutable()

  if (fs.existsSync(binPath)) return binPath

  // Check system PATH
  const systemPath = await findInPath()
  if (systemPath) {
    logger.success(`Found system yt-dlp: ${systemPath}`)
    return systemPath
  }

  // Download
  const url = DOWNLOAD_URLS[process.platform]
  if (!url) throw new Error(`Unsupported platform: ${process.platform}`)

  logger.info(`Downloading yt-dlp from ${url}`)
  const binDir = getBinDir()
  fs.mkdirSync(binDir, { recursive: true })

  const data = await followRedirects(url)
  fs.writeFileSync(binPath, data)

  if (process.platform !== 'win32') {
    fs.chmodSync(binPath, 0o755)
  }

  logger.success(`yt-dlp downloaded (${(data.length / 1024 / 1024).toFixed(1)}MB)`)
  return binPath
}

/**
 * Search the system PATH for an existing yt-dlp installation.
 * @returns Absolute path if found, otherwise `null`.
 */
async function findInPath(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, name)
    try {
      await fs.promises.access(full, fs.constants.X_OK)
      return full
    } catch {
      continue
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  youtube-dl-exec wrapper                                            */
/* ------------------------------------------------------------------ */

let ytdl: ReturnType<typeof createYtDl> | null = null

/**
 * Get (or create) a configured `youtube-dl-exec` instance pointing at
 * the managed yt-dlp binary.
 */
export async function getYtDl(): Promise<ReturnType<typeof createYtDl>> {
  if (ytdl) return ytdl
  const binPath = await ensureYtDlp()
  ytdl = createYtDl(binPath)
  return ytdl
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Cached FFmpeg directory — populated by `initFFmpegDir()`. */
let cachedFFmpegDir: string | undefined

/**
 * Resolve and cache the FFmpeg directory from app config.
 * Called once at startup (or lazily). After this, `baseFlags()` will
 * include `ffmpegLocation` automatically.
 */
export async function initFFmpegDir(): Promise<void> {
  const cfg = await getConfig()
  if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath)) {
    cachedFFmpegDir = path.dirname(cfg.ffmpegPath)
  } else {
    cachedFFmpegDir = undefined
  }
}

/**
 * Return the directory containing the app's FFmpeg binary (needed by
 * yt-dlp for HLS demuxing and post-processing).
 */
export async function getFFmpegDir(): Promise<string | undefined> {
  await initFFmpegDir()
  return cachedFFmpegDir
}

/** Common flags applied to every yt-dlp invocation. */
export function baseFlags(): Record<string, any> {
  const flags: Record<string, any> = {
    noWarnings: true,
    noCheckCertificates: true,
    jsRuntimes: 'node'
  }
  if (cachedFFmpegDir) {
    flags.ffmpegLocation = cachedFFmpegDir
  }
  return flags
}
