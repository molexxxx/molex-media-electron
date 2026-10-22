/**
 * @module main/ffmpeg/bootstrap
 * @description FFmpeg discovery, pinned download, and installation.
 *
 * The IO half of the build policy in build.ts, which makes every decision.
 * This module spawns binaries for their version, encoder list, and
 * self-test, streams the pinned archive through SHA-256 to disk, extracts
 * it, and moves the binaries into `<userData>/ffmpeg/<build id>/`.
 */

import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { once } from 'events'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import { getConfig, getFFmpegBinDir, getFFmpegRoot, saveFfmpegConfig } from '../config'
import { logger } from '../logger'
import { initFFmpegDir } from '../ytdlp/binary'
import { resetGpuDetection } from './gpu'
import { extractZip } from './unzip'
import { execArgv, exitName, normalizeLines, signedExitCode, type ExecResult } from './exec'
import pinJson from './pinned-builds.json'
import {
  CHECKSUM_MESSAGE, SELF_TESTS, alternativesMessage, assembleBuildInfo, cachedSelfTest, configBlock,
  discoveryCandidates, displayVersion, executableName, foldersToDelete, meetsMinimum, parsePin, parseVersion,
  pinKey, pinnedVersion, pipelineRefusal, planInstall, verifyDigest,
  type Asset, type BinaryIdentity, type BuildCandidate, type FfmpegBuildInfo, type PinnedBuilds,
  type SelfTestId, type SelfTestRecord
} from './build'

export interface BootstrapProgress {
  stage: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error'
  message: string
  percent: number
  detail?: string
  /** Bytes received so far, while downloading. */
  received?: number
  /** Bytes of every asset of the build together, while downloading. */
  total?: number
}

export interface FFmpegPaths {
  ffmpeg: string
  ffprobe: string
}

type ProgressCallback = (progress: BootstrapProgress) => void

const VERSION_TIMEOUT_MS = 10000
const SELF_TEST_TIMEOUT_MS = 20000
const EXTRACT_TIMEOUT_MS = 300000
const STALL_TIMEOUT_MS = 60000
const MAX_REDIRECTS = 10
const STDERR_TAIL_CHARS = 2048

function pinnedBuilds(): PinnedBuilds {
  return parsePin(pinJson)
}

interface Captured {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  spawnFailed: boolean
  timedOut: boolean
  ms: number
}

/** Runs a program hidden with no stdin and collects its output. Never rejects. */
function capture(bin: string, args: readonly string[], timeoutMs: number): Promise<Captured> {
  return new Promise((resolve) => {
    const started = Date.now()
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let settled = false
    let proc: ReturnType<typeof spawn>
    const finish = (code: number | null, signal: string | null, spawnFailed: boolean, extra: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + extra,
        spawnFailed,
        timedOut,
        ms: Date.now() - started
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      proc?.kill('SIGKILL')
    }, timeoutMs)
    try {
      proc = spawn(bin, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      finish(null, null, true, (e as Error).message)
      return
    }
    proc.stdout?.on('data', (d: Buffer) => out.push(d))
    proc.stderr?.on('data', (d: Buffer) => err.push(d))
    proc.on('error', (e) => finish(null, null, true, e.message))
    proc.on('close', (code, signal) => finish(code, signal, false, ''))
  })
}

function lastLine(text: string): string {
  const lines = normalizeLines(text).split('\n').filter((line) => line.trim().length > 0)
  return lines[lines.length - 1]?.trim() ?? ''
}

async function identify(file: string): Promise<BinaryIdentity | null> {
  try {
    const st = await fs.promises.stat(file)
    return st.isFile() ? { path: file, size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

async function listFolders(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Runs every startup self-test through the exec prefix and applies each pass rule to the output it reads. */
async function runSelfTests(ffmpegPath: string): Promise<Record<SelfTestId, boolean>> {
  const results = {} as Record<SelfTestId, boolean>
  for (const test of SELF_TESTS) {
    const run = await capture(ffmpegPath, execArgv(test.args, 'kill'), SELF_TEST_TIMEOUT_MS)
    const code = signedExitCode(run.code)
    const result: ExecResult = {
      code,
      exitName: exitName(code),
      signal: run.signal,
      aborted: false,
      stopped: run.timedOut ? 'killed' : 'none',
      outputRefused: false,
      stderrTail: run.stderr.slice(-STDERR_TAIL_CHARS),
      ms: run.ms
    }
    const text = normalizeLines(test.reads === 'stdout' ? run.stdout : run.stderr)
    const lines = text.split('\n').filter((line, i, all) => i < all.length - 1 || line.length > 0)
    results[test.id] = test.pass(result, lines)
    logger.debug(`FFmpeg self-test ${test.id}: ${results[test.id] ? 'passed' : 'failed'} in ${run.ms} ms`)
    if (!results[test.id]) {
      logger.warn(`FFmpeg self-test ${test.id} failed (exit ${code ?? run.signal}): ${lastLine(run.stderr)}`)
    }
  }
  return results
}

/**
 * Reads a build's version and encoder list and runs its self-test, reusing
 * a cached result recorded for the same binary identity. A build below the
 * minimum never runs the self-test.
 * @returns The build's information, or null when either tool is missing or
 *   `ffmpeg -version` does not run.
 */
export async function inspectBuild(candidate: BuildCandidate, cached: SelfTestRecord | null): Promise<FfmpegBuildInfo | null> {
  const identity = await identify(candidate.ffmpegPath)
  if (!identity || !(await identify(candidate.ffprobePath))) return null
  const version = await capture(candidate.ffmpegPath, ['-version'], VERSION_TIMEOUT_MS)
  if (version.code !== 0) {
    logger.warn(`FFmpeg at ${candidate.ffmpegPath} did not run: ${lastLine(version.stderr) || `exit ${version.code ?? version.signal}`}`)
    return null
  }
  const encoders = await capture(candidate.ffmpegPath, execArgv(['-encoders'], 'kill'), VERSION_TIMEOUT_MS)
  let selfTest = cachedSelfTest(cached, identity)
  if (!selfTest && meetsMinimum(parseVersion(version.stdout).libs)) {
    logger.info(`Running the FFmpeg self-test on ${candidate.ffmpegPath}`)
    selfTest = await runSelfTests(candidate.ffmpegPath)
  }
  return assembleBuildInfo({ candidate, identity, versionStdout: version.stdout, encodersStdout: encoders.stdout, selfTest })
}

/** Records an accepted build in config (with its mirrors) and points yt-dlp and GPU detection at it. */
async function adopt(candidate: BuildCandidate, info: FfmpegBuildInfo): Promise<FFmpegPaths> {
  const block = configBlock(candidate, info)
  const config = await getConfig()
  if (JSON.stringify(config.ffmpeg) !== JSON.stringify(block)) {
    await saveFfmpegConfig(block)
    await initFFmpegDir()
    resetGpuDetection()
  }
  return { ffmpeg: candidate.ffmpegPath, ffprobe: candidate.ffprobePath }
}

/** Inspects one candidate and adopts it when the pipeline can run on it. */
async function tryCandidate(candidate: BuildCandidate): Promise<{ paths: FFmpegPaths } | { refusal: string }> {
  const config = await getConfig()
  const info = await inspectBuild(candidate, config.ffmpeg?.selfTest ?? null)
  if (!info) return { refusal: `FFmpeg was not found at ${candidate.ffmpegPath}` }
  const refusal = pipelineRefusal(info)
  if (refusal) return { refusal }
  logger.success(`Using FFmpeg ${displayVersion(info.versionString)} (${candidate.source}) at ${candidate.ffmpegPath}`)
  return { paths: await adopt(candidate, info) }
}

/**
 * Looks for a usable FFmpeg build: the configured one, this pin's installed
 * folders, the folder older versions installed into, then PATH (with the
 * Homebrew folders on macOS). A build below FFmpeg 5.1 or one failing the
 * self-test is skipped with its reason logged. The accepted build is
 * recorded in config.
 *
 * @returns The paths to both binaries, or `null` when no usable build exists.
 */
export async function findSystemFFmpeg(): Promise<FFmpegPaths | null> {
  const config = await getConfig()
  const root = getFFmpegRoot()
  const candidates = discoveryCandidates({
    configured: config.ffmpeg,
    pin: pinnedBuilds(),
    platform: process.platform,
    arch: process.arch,
    root,
    installed: await listFolders(root),
    legacyDir: getFFmpegBinDir(),
    envPath: process.env.PATH
  })
  for (const candidate of candidates) {
    if (!(await identify(candidate.ffmpegPath))) continue
    const outcome = await tryCandidate(candidate)
    if ('paths' in outcome) return outcome.paths
    logger.warn(`Skipping FFmpeg at ${candidate.ffmpegPath}: ${outcome.refusal}`)
  }
  return null
}

/** An HTTP status other than success or a redirect, reported against the pinned URL that was requested. */
class HttpStatusError extends Error {
  constructor(readonly url: string, readonly status: number) {
    super(`Download failed with status ${status}`)
    this.name = 'HttpStatusError'
  }
}

/** Requests a pinned URL over HTTPS only, following redirects, and resolves with the successful response. */
function request(url: string, pinned: string, depth = 0): Promise<import('http').IncomingMessage> {
  if (depth > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'))
  if (!url.startsWith('https://')) return Promise.reject(new Error(`Refusing a download over ${url.split(':')[0]}`))
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'molexMedia' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        request(new URL(res.headers.location, url).toString(), pinned, depth + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new HttpStatusError(pinned, status))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(STALL_TIMEOUT_MS, () => req.destroy(new Error('The download stalled')))
  })
}

/**
 * Streams one pinned asset to `file` while hashing it, so the archive is
 * never held in memory and its size and digest are known before anything
 * is extracted.
 */
async function download(asset: Asset, file: string, onBytes: (received: number) => void): Promise<{ ok: boolean; bytes: number; sha256: string }> {
  const res = await request(asset.url, asset.url)
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })
  let writeError: Error | null = null
  out.on('error', (e) => {
    writeError = e
  })
  let received = 0
  async function* tee(): AsyncGenerator<Uint8Array> {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      if (writeError) throw writeError
      if (!out.write(chunk)) await once(out, 'drain')
      received += chunk.byteLength
      onBytes(received)
      yield chunk
    }
  }
  try {
    const digest = await verifyDigest(tee(), asset)
    if (writeError) throw writeError
    return digest
  } finally {
    res.destroy()
    const closed = once(out, 'close').catch(() => undefined)
    out.end()
    await closed
  }
}

async function extract(asset: Asset, file: string, dest: string): Promise<void> {
  if (asset.kind === 'zip') {
    await extractZip(file, dest)
    return
  }
  const run = await capture('tar', ['-xJf', file, '-C', dest], EXTRACT_TIMEOUT_MS)
  if (run.code !== 0) {
    throw new Error(`Could not extract the FFmpeg download: ${lastLine(run.stderr) || `tar exit ${run.code ?? run.signal}`}`)
  }
}

/** Runs `codesign --verify --strict` on macOS and logs the result; a failure or a missing codesign is not fatal. */
async function checkSignatures(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const run = await capture('codesign', ['--verify', '--strict', file], VERSION_TIMEOUT_MS)
    if (run.code === 0) logger.info(`codesign verified ${path.basename(file)}`)
    else logger.warn(`codesign did not verify ${path.basename(file)}: ${run.spawnFailed ? 'codesign is not available' : lastLine(run.stderr)}`)
  }
}

/** Deletes the build folders and interrupted staging folders that `foldersToDelete` names. */
async function removeOlderBuilds(root: string, currentId: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.promises.readdir(root)
  } catch {
    return
  }
  for (const name of foldersToDelete(currentId, entries)) {
    try {
      await fs.promises.rm(path.join(root, name), { recursive: true, force: true })
      logger.info(`Removed the older FFmpeg build ${name}`)
    } catch (e) {
      logger.warn(`Could not remove the older FFmpeg build ${name}: ${(e as Error).message}`)
    }
  }
}

function bundledCandidate(root: string, buildId: string): BuildCandidate {
  const dir = path.join(root, buildId)
  return {
    source: 'bundled',
    buildId,
    ffmpegPath: path.join(dir, executableName('ffmpeg', process.platform)),
    ffprobePath: path.join(dir, executableName('ffprobe', process.platform))
  }
}

/**
 * Downloads one pinned build, checks every asset's size and SHA-256 before
 * extracting it, stages the binaries next to their install folder, renames
 * the staging folder into place, and runs the self-test there.
 */
async function installAssets(root: string, version: string, assets: readonly Asset[], onProgress: ProgressCallback): Promise<FFmpegPaths> {
  const buildId = assets[0].build
  const total = assets.reduce((sum, a) => sum + a.bytes, 0)
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'molex-ffmpeg-'))
  let staging: string | null = null
  try {
    const extracted = path.join(tmp, 'x')
    await fs.promises.mkdir(extracted)
    let done = 0
    let shown = -1
    onProgress({ stage: 'downloading', message: `Downloading FFmpeg ${version}...`, percent: 0 })
    for (const [i, asset] of assets.entries()) {
      const file = path.join(tmp, `asset-${i}`)
      logger.info(`Downloading FFmpeg ${version} from ${asset.url}`)
      const digest = await download(asset, file, (received) => {
        const bytes = done + Math.min(received, asset.bytes)
        const percent = Math.floor((bytes / total) * 100)
        if (percent === shown) return
        shown = percent
        onProgress({
          stage: 'downloading',
          message: `Downloading FFmpeg ${version}... ${(bytes / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`,
          percent,
          detail: `${percent}% complete`,
          received: bytes,
          total
        })
      })
      if (!digest.ok) {
        await fs.promises.rm(file, { force: true })
        logger.error(`${asset.url}: expected ${asset.bytes} bytes with SHA-256 ${asset.sha256}, received ${digest.bytes} bytes with SHA-256 ${digest.sha256}`)
        throw new Error(CHECKSUM_MESSAGE)
      }
      logger.info(`Verified ${path.basename(new URL(asset.url).pathname)}: ${digest.bytes} bytes, SHA-256 ${digest.sha256}`)
      done += asset.bytes
      onProgress({ stage: 'extracting', message: 'Extracting FFmpeg binaries...', percent: Math.round(((i + 1) / assets.length) * 50) })
      await extract(asset, file, extracted)
      await fs.promises.rm(file, { force: true })
    }

    const ffmpegName = executableName('ffmpeg', process.platform)
    const ffprobeName = executableName('ffprobe', process.platform)
    const ffmpegSrc = findFile(extracted, ffmpegName)
    const ffprobeSrc = findFile(extracted, ffprobeName)
    if (!ffmpegSrc) throw new Error('Could not find ffmpeg binary in download')
    if (!ffprobeSrc) throw new Error('Could not find ffprobe binary in download')
    if (process.platform === 'darwin') await checkSignatures([ffmpegSrc, ffprobeSrc])

    onProgress({ stage: 'extracting', message: 'Installing FFmpeg...', percent: 75 })
    staging = path.join(root, `${buildId}.part-${randomBytes(6).toString('hex')}`)
    await fs.promises.mkdir(staging)
    for (const [src, name] of [[ffmpegSrc, ffmpegName], [ffprobeSrc, ffprobeName]] as const) {
      const dest = path.join(staging, name)
      await fs.promises.copyFile(src, dest)
      if (process.platform !== 'win32') await fs.promises.chmod(dest, 0o755)
    }
    const folder = path.join(root, buildId)
    await fs.promises.rename(staging, folder)
    staging = null

    onProgress({ stage: 'verifying', message: 'Verifying FFmpeg installation...', percent: 90 })
    const outcome = await tryCandidate(bundledCandidate(root, buildId))
    if ('refusal' in outcome) {
      await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(outcome.refusal)
    }
    await removeOlderBuilds(root, buildId)
    logger.success(`FFmpeg ${version} installed into ${folder} and verified`)
    onProgress({ stage: 'complete', message: 'FFmpeg is ready!', percent: 100 })
    return outcome.paths
  } finally {
    if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Installs the pinned FFmpeg build for this platform into
 * `<userData>/ffmpeg/<build id>/`, or reuses it when it is already there.
 * `planInstall` picks the primary build, the fallback after a 404 or 410,
 * or the alternatives; each download is streamed through SHA-256 and must
 * match the pin before it is extracted. The installed build must pass the
 * self-test before it is recorded in config, after which older pinned
 * builds are deleted. Reports stage-based progress to the setup wizard UI.
 *
 * @param onProgress - Callback receiving {@link BootstrapProgress} updates.
 * @returns The absolute paths to the installed binaries.
 * @throws On a checksum mismatch, a failed install or self-test, or when no
 *   pinned build can be downloaded (the message lists the alternatives).
 */
export async function downloadFFmpeg(onProgress: ProgressCallback): Promise<FFmpegPaths> {
  const pin = pinnedBuilds()
  const key = pinKey(process.platform, process.arch)
  const root = getFFmpegRoot()
  await fs.promises.mkdir(root, { recursive: true })
  onProgress({ stage: 'checking', message: 'Checking for an installed FFmpeg...', percent: 0 })

  const failures: Array<{ url: string; status: number }> = []
  let last: { source: 'primary' | 'fallback'; error: HttpStatusError } | null = null
  for (;;) {
    const plan = planInstall(pin, key, await listFolders(root), failures)
    if (plan.kind === 'offer-alternatives') {
      throw new Error(alternativesMessage(key))
    }
    if (plan.kind === 'reuse') {
      const outcome = await tryCandidate(bundledCandidate(root, plan.folder))
      if ('paths' in outcome) {
        await removeOlderBuilds(root, plan.folder)
        onProgress({ stage: 'complete', message: 'FFmpeg is ready!', percent: 100 })
        return outcome.paths
      }
      logger.warn(`Removing the unusable FFmpeg build ${plan.folder}: ${outcome.refusal}`)
      await fs.promises.rm(path.join(root, plan.folder), { recursive: true, force: true })
      continue
    }
    if (last && last.source === plan.source) throw last.error
    try {
      return await installAssets(root, pinnedVersion(pin, key), plan.assets, onProgress)
    } catch (err) {
      if (!(err instanceof HttpStatusError)) throw err
      logger.warn(`FFmpeg ${plan.source} download returned ${err.status}: ${err.url}`)
      failures.push({ url: err.url, status: err.status })
      last = { source: plan.source, error: err }
    }
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
  const run = await capture(ffmpegPath, ['-version'], VERSION_TIMEOUT_MS)
  if (run.spawnFailed) return 'error'
  return parseVersion(run.stdout).versionString || 'unknown'
}
