/**
 * @module main/ytdlp/cookies
 * @description Browser cookie detection, export, and retry logic.
 *
 * Detects installed browsers, exports a Netscape-format `cookies.txt`
 * file from whichever browser is available, caches the file for 24 h,
 * and provides a generic retry helper that transparently re-exports
 * cookies when a request fails with an authentication error.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getUserDataPath, getConfig, saveConfig } from '../config'
import { logger } from '../logger'
import { getYtDl, baseFlags } from './binary'

/* ------------------------------------------------------------------ */
/*  Browser detection                                                  */
/* ------------------------------------------------------------------ */

/** Per-platform browser → data-directory mappings. */
const BROWSER_PATHS: Record<string, Record<string, () => string>> = {
  win32: {
    edge:    () => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
    chrome:  () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    firefox: () => path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles'),
    opera:   () => path.join(process.env.APPDATA || '', 'Opera Software', 'Opera Stable'),
    brave:   () => path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data'),
    vivaldi: () => path.join(process.env.LOCALAPPDATA || '', 'Vivaldi', 'User Data')
  },
  darwin: {
    chrome:  () => path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    safari:  () => path.join(os.homedir(), 'Library', 'Safari'),
    firefox: () => path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles'),
    opera:   () => path.join(os.homedir(), 'Library', 'Application Support', 'com.operasoftware.Opera'),
    brave:   () => path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    vivaldi: () => path.join(os.homedir(), 'Library', 'Application Support', 'Vivaldi'),
    edge:    () => path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge')
  },
  linux: {
    chrome:   () => path.join(os.homedir(), '.config', 'google-chrome'),
    firefox:  () => path.join(os.homedir(), '.mozilla', 'firefox'),
    chromium: () => path.join(os.homedir(), '.config', 'chromium'),
    opera:    () => path.join(os.homedir(), '.config', 'opera'),
    brave:    () => path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser'),
    vivaldi:  () => path.join(os.homedir(), '.config', 'vivaldi'),
    edge:     () => path.join(os.homedir(), '.config', 'microsoft-edge')
  }
}

/** Preferred browser probe order per platform. */
const BROWSER_ORDER: Record<string, string[]> = {
  win32:  ['vivaldi', 'brave', 'firefox', 'chrome', 'edge', 'opera'],
  darwin: ['chrome', 'safari', 'firefox', 'brave', 'vivaldi', 'opera', 'edge'],
  linux:  ['chrome', 'firefox', 'chromium', 'brave', 'vivaldi', 'opera', 'edge']
}

let sessionBrowser: string | null = null
const failedBrowsers = new Set<string>()

/**
 * Return the list of browsers installed on this system.
 * Each entry has a `name` (yt-dlp identifier) and a `label` (display name).
 */
export function getInstalledBrowsers(): { name: string; label: string }[] {
  const LABELS: Record<string, string> = {
    chrome: 'Google Chrome', edge: 'Microsoft Edge', firefox: 'Firefox',
    opera: 'Opera', brave: 'Brave', vivaldi: 'Vivaldi',
    safari: 'Safari', chromium: 'Chromium'
  }
  const platformPaths = BROWSER_PATHS[process.platform] || {}
  const order = BROWSER_ORDER[process.platform] || Object.keys(platformPaths)
  const result: { name: string; label: string }[] = []
  for (const name of order) {
    const pathFn = platformPaths[name]
    if (!pathFn) continue
    try {
      if (fs.existsSync(pathFn())) {
        result.push({ name, label: LABELS[name] || name.charAt(0).toUpperCase() + name.slice(1) })
      }
    } catch { /* skip */ }
  }
  return result
}

/**
 * Manually set the browser for cookie export and immediately re-export.
 * Returns true if the export succeeded.
 */
export async function setBrowserAndExport(browserName: string): Promise<boolean> {
  sessionBrowser = browserName
  failedBrowsers.delete(browserName)
  await saveConfig({ ytdlpBrowser: browserName })
  invalidateCookiesFile()
  return exportCookiesFromBrowser()
}

/* ------------------------------------------------------------------ */
/*  Cookie file management                                             */
/* ------------------------------------------------------------------ */

/** Path to the locally-cached Netscape cookies file. */
function getCookiesFilePath(): string {
  return path.join(getUserDataPath(), 'cookies.txt')
}

/** Max age before cookies are re-exported from the browser (7 days). */
const COOKIES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Check if the cookies file exists and is younger than the max age. */
function isCookiesFileFresh(): boolean {
  const fp = getCookiesFilePath()
  try {
    const stat = fs.statSync(fp)
    return Date.now() - stat.mtimeMs < COOKIES_MAX_AGE_MS
  } catch {
    return false
  }
}

/** Return `true` if the error message looks cookie-related. */
function isCookieError(msg: string): boolean {
  return /could not copy.*cookie|cookie.*database|permission.*cookie|locked.*cookie|cookie.*locked|failed to decrypt|DPAPI/i.test(msg)
}

/* ------------------------------------------------------------------ */
/*  Browser detection + export                                         */
/* ------------------------------------------------------------------ */

/**
 * Detect an installed browser suitable for cookie export.
 * Caches the result for the lifetime of the process and persists it
 * to config for faster startup next time.
 */
async function detectBrowser(): Promise<string | null> {
  if (sessionBrowser && !failedBrowsers.has(sessionBrowser)) return sessionBrowser

  const cfg = await getConfig()
  if (cfg.ytdlpBrowser && !failedBrowsers.has(cfg.ytdlpBrowser)) {
    sessionBrowser = cfg.ytdlpBrowser
    logger.info(`Using cached browser for cookies: ${sessionBrowser}`)
    return sessionBrowser
  }

  const platformPaths = BROWSER_PATHS[process.platform] || {}
  const order = BROWSER_ORDER[process.platform] || Object.keys(platformPaths)

  for (const name of order) {
    const pathFn = platformPaths[name]
    if (!pathFn) continue
    try {
      const dir = pathFn()
      if (fs.existsSync(dir)) {
        sessionBrowser = name
        logger.info(`Detected browser for cookies: ${name} (${dir})`)
        await saveConfig({ ytdlpBrowser: name })
        return name
      }
    } catch {
      continue
    }
  }

  logger.warn('No browser detected for yt-dlp cookies - requests may be blocked')
  return null
}

/**
 * Export cookies from the detected browser to a local Netscape-format
 * `cookies.txt` file.  This is the only step that requires the browser
 * to be closed.  After export the file is reused for 24 hours.
 */
async function exportCookiesFromBrowser(): Promise<boolean> {
  await detectBrowser()
  if (!sessionBrowser) return false

  const dl = await getYtDl()
  const cookiesFile = getCookiesFilePath()

  try {
    logger.info(`Exporting cookies from "${sessionBrowser}" to ${cookiesFile}...`)
    await dl('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
      cookiesFromBrowser: sessionBrowser,
      cookies: cookiesFile,
      skipDownload: true,
      flatPlaylist: true,
      noPlaylist: true,
      ...baseFlags()
    } as any)
    logger.success(`Cookies exported successfully from "${sessionBrowser}"`)
    return true
  } catch (err: any) {
    if (isCookieError(err.message)) {
      logger.warn(`Could not export cookies from "${sessionBrowser}": ${err.message}`)
      await invalidateBrowser()
      await detectBrowser()
      if (sessionBrowser) {
        try {
          await dl('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
            cookiesFromBrowser: sessionBrowser,
            cookies: cookiesFile,
            skipDownload: true,
            flatPlaylist: true,
            noPlaylist: true,
            ...baseFlags()
          } as any)
          logger.success(`Cookies exported from fallback browser "${sessionBrowser}"`)
          return true
        } catch {
          logger.warn('Fallback browser cookie export also failed')
        }
      }
    } else {
      if (fs.existsSync(cookiesFile) && fs.statSync(cookiesFile).size > 0) {
        logger.info('Cookies file was written despite yt-dlp error - using it')
        return true
      }
      logger.warn(`Cookie export failed: ${err.message}`)
    }
    return false
  }
}

/** Mark the current browser as unusable and clear the persisted config. */
async function invalidateBrowser(): Promise<void> {
  if (sessionBrowser) {
    logger.warn(`Browser cookie access failed for "${sessionBrowser}", trying next browser...`)
    failedBrowsers.add(sessionBrowser)
    sessionBrowser = null
    await saveConfig({ ytdlpBrowser: '' })
  }
}

/** Delete the cached cookies file so it will be re-exported on next use. */
function invalidateCookiesFile(): void {
  try {
    const fp = getCookiesFilePath()
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  } catch { /* ignore */ }
}

/**
 * Delete cached cookies and clear the selected browser.
 * Exported for use via IPC.
 */
export async function clearCookies(): Promise<void> {
  invalidateCookiesFile()
  sessionBrowser = null
  failedBrowsers.clear()
  await saveConfig({ ytdlpBrowser: '' })
  logger.info('Cached cookies and browser selection cleared')
}

/**
 * Return info about the current cookie cache state.
 */
export function getCookieInfo(): { exists: boolean; age: number | null; browser: string } {
  const fp = getCookiesFilePath()
  let exists = false
  let age: number | null = null
  try {
    const stat = fs.statSync(fp)
    exists = stat.size > 0
    age = Date.now() - stat.mtimeMs
  } catch { /* no file */ }
  return { exists, age, browser: sessionBrowser || '' }
}

/* ------------------------------------------------------------------ */
/*  Cookie flag helper                                                 */
/* ------------------------------------------------------------------ */

/**
 * Return yt-dlp flags that point to our local cookies file, exporting
 * from the browser first if the file is missing or stale.
 */
export async function ensureCookieFlags(): Promise<Record<string, string>> {
  const cookiesFile = getCookiesFilePath()

  // Reuse existing fresh cookies file - no browser access needed
  if (isCookiesFileFresh()) {
    return { cookies: cookiesFile }
  }

  // File exists but stale - use it now, refresh in background
  const fileUsable = (() => {
    try { return fs.existsSync(cookiesFile) && fs.statSync(cookiesFile).size > 0 }
    catch { return false }
  })()
  if (fileUsable) {
    logger.info('Using stale cookies file while refreshing in background...')
    exportCookiesFromBrowser().catch(() => {})
    return { cookies: cookiesFile }
  }

  // No file at all - must export now (first launch only)
  const ok = await exportCookiesFromBrowser()
  if (ok && fs.existsSync(cookiesFile)) {
    return { cookies: cookiesFile }
  }

  return {}
}

/* ------------------------------------------------------------------ */
/*  Retry helper                                                       */
/* ------------------------------------------------------------------ */

/**
 * Execute an async function with automatic cookie retry.
 *
 * 1. First attempt uses the cached (or freshly exported) cookies file.
 * 2. If the request fails with an auth / cookie error, invalidates the
 *    cookies file, re-exports from the browser, and retries.
 * 3. If that also fails, retries once more without any cookies.
 */
export async function withCookieRetry<T>(fn: (flags: Record<string, any>) => Promise<T>): Promise<T> {
  const cookieFlags = await ensureCookieFlags()
  try {
    return await fn(cookieFlags)
  } catch (err: any) {
    if (isCookieError(err.message) || /sign in|age-restricted|login required/i.test(err.message)) {
      logger.warn('Request failed with possible auth issue - re-exporting cookies from browser...')
      invalidateCookiesFile()
      const freshFlags = await ensureCookieFlags()
      try {
        return await fn(freshFlags)
      } catch (retryErr: any) {
        if (isCookieError(retryErr.message)) {
          logger.warn('Cookie retry failed - trying without cookies...')
          return fn({})
        }
        throw retryErr
      }
    }
    throw err
  }
}
