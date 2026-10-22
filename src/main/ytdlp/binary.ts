/**
 * @module main/ytdlp/binary
 * @description The yt-dlp wrapper the rest of the app runs.
 *
 * Finds the binary through the updater (the app-managed copy by default, downloaded and verified when missing;
 * the copy on PATH only when the owner chose it), and hands out a `youtube-dl-exec` instance whose every run is
 * counted, so an update replaces the binary only while nothing runs it.
 */

import * as fs from 'fs'
import * as path from 'path'
import { create as createYtDl } from 'youtube-dl-exec'
import { getConfig } from '../config'
import { ytDlpUpdater } from './updater'

type YtDl = ReturnType<typeof createYtDl>

/**
 * Ensure the yt-dlp binary is available, downloading and verifying the latest release into the app folder when
 * the copy in use does not exist.
 *
 * @returns Absolute path to the yt-dlp binary.
 */
export async function ensureYtDlp(): Promise<string>
{
  return ytDlpUpdater().ensure()
}

/** A `youtube-dl-exec` instance whose runs the updater counts until each process ends. */
export function trackRuns(inner: YtDl, track: <T extends PromiseLike<unknown>>(run: T) => T): YtDl
{
  const run = ((...args: Parameters<YtDl>) => track(inner(...args))) as YtDl
  run.exec = (...args: Parameters<YtDl['exec']>) => track(inner.exec(...args))
  return run
}

let ytdl: { path: string; run: YtDl } | null = null

/**
 * Get a configured `youtube-dl-exec` instance pointing at the yt-dlp in use. The instance is kept while the
 * binary stays at the same path, so switching between the app's copy and one on PATH takes effect on the next call.
 */
export async function getYtDl(): Promise<YtDl>
{
  const binPath = await ensureYtDlp()
  if (ytdl === null || ytdl.path !== binPath)
  {
    const updater = ytDlpUpdater()
    ytdl = { path: binPath, run: trackRuns(createYtDl(binPath), (run) => updater.track(run)) }
  }
  return ytdl.run
}

/** Cached FFmpeg directory - populated by `initFFmpegDir()`. */
let cachedFFmpegDir: string | undefined

/**
 * Resolve and cache the FFmpeg directory from app config.
 * Called once at startup (or lazily). After this, `baseFlags()` will
 * include `ffmpegLocation` automatically.
 */
export async function initFFmpegDir(): Promise<void>
{
  const cfg = await getConfig()
  if (cfg.ffmpegPath && fs.existsSync(cfg.ffmpegPath))
  {
    cachedFFmpegDir = path.dirname(cfg.ffmpegPath)
  }
  else
  {
    cachedFFmpegDir = undefined
  }
}

/**
 * Return the directory containing the app's FFmpeg binary (needed by
 * yt-dlp for HLS demuxing and post-processing).
 */
export async function getFFmpegDir(): Promise<string | undefined>
{
  await initFFmpegDir()
  return cachedFFmpegDir
}

/** Common flags applied to every yt-dlp invocation. */
export function baseFlags(): Record<string, any>
{
  const flags: Record<string, any> = {
    noWarnings: true,
    noCheckCertificates: true,
    jsRuntimes: 'node'
  }
  if (cachedFFmpegDir)
  {
    flags.ffmpegLocation = cachedFFmpegDir
  }
  return flags
}
