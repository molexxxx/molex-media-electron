/**
 * FFmpeg build policy: version and encoder parsing, the FFmpeg 5.1 minimum, the startup self-test commands, pinned
 * asset selection, streamed digest checks, and install planning. It reads no file, configuration, log, or Electron
 * state, so the bootstrap, the golden suite, and the pin script share every decision.
 */
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ExecResult } from './exec'
import { parseEbur128Blocks } from './audio/measure'

/** The libraries whose versions decide what a build can run. */
export type LibName = 'avutil' | 'avcodec' | 'avformat' | 'avfilter' | 'swresample'

/** A library version as major, minor, micro. */
export type LibVersion = readonly [number, number, number]

/** The startup self-tests, in the order they run. */
export type SelfTestId = 'chain-flac-s16' | 'chain-opus-51side' | 'chain-aac-mono' | 'meter-dual-mono' | 'meter-surround' | 'soxr' | 'encoders'

/** Where a build came from: the app's own install, a PATH search, or a binary the user chose. */
export type BuildSource = 'bundled' | 'path' | 'custom'

/** The cache key of a self-test result: the binary's path, size, and modification time. */
export interface BinaryIdentity
{
  path: string
  size: number
  mtimeMs: number
}

/** Everything the app knows about one FFmpeg build. */
export interface FfmpegBuildInfo
{
  ffmpegPath: string
  ffprobePath: string
  source: BuildSource
  /** The token after "ffmpeg version", such as n9.0.2-17-g2a571b6068-20260930. */
  versionString: string
  libs: Record<LibName, LibVersion>
  configuration: readonly string[]
  encoders: ReadonlySet<string>
  experimental: ReadonlySet<string>
  soxr: boolean
  /** The meter-surround self-test passed; when false, loudness jobs that meter more than two channels are refused. */
  surroundMeter: boolean
  meetsMinimum: boolean
  selfTest: Readonly<Record<SelfTestId, boolean>>
  identity: BinaryIdentity
}

/** FFmpeg 5.1: the first release with aresample's ochl option and alimiter's latency option. */
export const MINIMUM = { avfilter: [8, 44, 100], swresample: [4, 7, 100] } as const

const LIB_NAMES: readonly LibName[] = ['avutil', 'avcodec', 'avformat', 'avfilter', 'swresample']

const VERSION_LINE = /^(?:ffmpeg|ffprobe) version (\S+)/
const LIB_LINE = /^lib(\w+)\s+(\d+)\.\s*(\d+)\.\s*(\d+)(?:\s*\/\s*(\d+)\.\s*(\d+)\.\s*(\d+))?/

function isLibName(name: string): name is LibName
{
  return (LIB_NAMES as readonly string[]).includes(name)
}

/** Splits a configure line into its arguments, keeping quoted values whole and dropping the quote marks. */
function splitConfigure(text: string): string[]
{
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (const ch of text)
  {
    if (quote)
    {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '\'' || ch === '"')
    {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch))
    {
      if (started) out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/**
 * Reads `ffmpeg -version` (or `ffprobe -version`) output: the version token, the runtime version of each library
 * that decides the minimum, and the configure arguments. Lines it does not know, such as the
 * "Exiting with exit code 0" line that 9.0.2 prints, are ignored; a library it cannot find reads as 0.0.0.
 */
export function parseVersion(stdout: string): Pick<FfmpegBuildInfo, 'versionString' | 'libs' | 'configuration'>
{
  const libs: Record<LibName, LibVersion> = { avutil: [0, 0, 0], avcodec: [0, 0, 0], avformat: [0, 0, 0], avfilter: [0, 0, 0], swresample: [0, 0, 0] }
  let versionString = ''
  let configuration: string[] = []
  for (const raw of stdout.split(/\r?\n|\r/))
  {
    const line = raw.trim()
    const version = VERSION_LINE.exec(line)
    if (version)
    {
      if (!versionString) versionString = version[1]
      continue
    }
    if (line.startsWith('configuration:'))
    {
      configuration = splitConfigure(line.slice('configuration:'.length))
      continue
    }
    const lib = LIB_LINE.exec(line)
    if (lib && isLibName(lib[1]))
    {
      const at = lib[5] === undefined ? 2 : 5
      libs[lib[1]] = [Number(lib[at]), Number(lib[at + 1]), Number(lib[at + 2])]
    }
  }
  return { versionString, libs, configuration }
}

/**
 * Reads `ffmpeg -encoders` output into every listed encoder and the ones flagged experimental. The experimental
 * flag's column comes from the legend, so a build that adds a flag column still parses.
 */
export function parseEncoders(stdout: string): { all: Set<string>; experimental: Set<string> }
{
  const all = new Set<string>()
  const experimental = new Set<string>()
  let column = 3
  let listing = false
  for (const raw of stdout.split(/\r?\n|\r/))
  {
    const line = raw.trim()
    if (!listing)
    {
      const legend = /^([.A-Z]+) = (.*)$/.exec(line)
      if (legend && /experimental/i.test(legend[2])) column = legend[1].search(/[^.]/)
      if (/^-{3,}$/.test(line)) listing = true
      continue
    }
    const entry = /^([.A-Z]{4,})\s+(\S+)/.exec(line)
    if (!entry) continue
    all.add(entry[2])
    if (entry[1][column] === 'X') experimental.add(entry[2])
  }
  return { all, experimental }
}

function atLeast(found: LibVersion, min: LibVersion): boolean
{
  for (let i = 0; i < 3; i++)
  {
    if (found[i] !== min[i]) return found[i] > min[i]
  }
  return true
}

/** True when libavfilter and libswresample are at least the FFmpeg 5.1 versions in {@link MINIMUM}. */
export function meetsMinimum(libs: FfmpegBuildInfo['libs']): boolean
{
  return atLeast(libs.avfilter, MINIMUM.avfilter) && atLeast(libs.swresample, MINIMUM.swresample)
}

/** The release number in a version token (4.4.2-0ubuntu0.22.04.1 reads 4.4.2), or the token itself for git builds. */
export function displayVersion(versionString: string): string
{
  const release = /^n?(\d+\.\d+(?:\.\d+)?)(?![\d.])/.exec(versionString)
  if (release) return release[1]
  return versionString || 'an unrecognized version'
}

/** The refusal shown for a build below {@link MINIMUM}. */
export function minimumMessage(versionString: string): string
{
  return `FFmpeg 5.1 or newer is required; found ${displayVersion(versionString)}`
}

/** The self-test ids in the order they run. */
export const SELF_TEST_IDS: readonly SelfTestId[] =
  ['chain-flac-s16', 'chain-opus-51side', 'chain-aac-mono', 'meter-dual-mono', 'meter-surround', 'soxr', 'encoders']

/** Raised when the self-test commands or pass rules change, so a cached result from older rules runs again. */
export const SELF_TEST_REV = 2

/** BS.1770 weights the surround channels 1.41 and the front and center channels 1.0. */
const SURROUND_WEIGHT = 1.41

/** How much louder a signal reads panned into the five full-range channels of 5.1 than alone in mono. */
export const SURROUND_GAIN_DB = 10 * Math.log10(3 + 2 * SURROUND_WEIGHT)

/** How far the measured surround gain may stray from {@link SURROUND_GAIN_DB}. */
export const SURROUND_TOLERANCE_DB = 0.3

/** Self-tests whose failure narrows what runs instead of disabling the pipeline. */
const NARROWING_TESTS: ReadonlySet<SelfTestId> = new Set(['soxr', 'meter-surround'])

/** Encoders the pipeline writes with; each must be listed and not flagged experimental. libvorbis is optional. */
export const REQUIRED_ENCODERS: readonly string[] = ['aac', 'flac', 'alac', 'libmp3lame', 'libopus', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le']

/** One startup self-test: lavfi input only, run through the exec prefix. */
export interface SelfTest
{
  id: SelfTestId
  /** The arguments after the exec prefix of `execArgv(args, 'kill')`. */
  args: readonly string[]
  /** The output whose lines `pass` reads: stderr for the chains and meters, stdout for the encoder list. */
  reads: 'stderr' | 'stdout'
  pass(r: ExecResult, lines: readonly string[]): boolean
}

const QUIET = ['-loglevel', 'level+error'] as const

function ranClean(r: ExecResult): boolean
{
  return r.code === 0 && r.stopped === 'none' && !r.aborted && !r.outputRefused
}

function within(value: number | null | undefined, expected: number, tolerance: number): boolean
{
  return typeof value === 'number' && Math.abs(value - expected) <= tolerance + 1e-9
}

/** True when every required encoder is listed and none of them is flagged experimental. */
export function hasRequiredEncoders(encoders: ReadonlySet<string>, experimental: ReadonlySet<string>): boolean
{
  return REQUIRED_ENCODERS.every((name) => encoders.has(name) && !experimental.has(name))
}

/** The surround meter's integrated loudness minus the mono meter's, or null when either reading is missing. */
export function surroundGainDb(lines: readonly string[]): number | null
{
  const blocks = parseEbur128Blocks(lines.join('\n'))
  const mono = blocks.get('mono')?.integratedLufs ?? null
  const surround = blocks.get('surround')?.integratedLufs ?? null
  return mono === null || surround === null ? null : surround - mono
}

/**
 * The startup self-tests. The chain commands are the production builders' outputs for fixed inputs, so each run
 * exercises the rate change and layout pin after a 4x or 5x resampler on whatever binary is installed. The surround
 * meter reads one sine in mono and in the five full-range channels of 5.1(side), LFE silent, in a single run.
 */
export const SELF_TESTS: ReadonlyArray<SelfTest> = [
  {
    id: 'chain-flac-s16',
    args: [...QUIET, '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=1', '-filter_complex',
      '[0:a]aformat=channel_layouts=stereo,aformat=sample_fmts=dbl,volume=6.00dB:precision=double,aresample=220500,alimiter=limit=-1.50dB:attack=20:release=200:level=disabled:latency=1,aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a]',
      '-map', '[a]', '-c:a', 'flac', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r, lines) => ranClean(r) && !lines.some((line) => line.includes('[error]'))
  },
  {
    id: 'chain-opus-51side',
    args: [...QUIET, '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=1', '-filter_complex',
      '[0:a]aformat=channel_layouts=5.1(side),aformat=sample_fmts=dbl,volume=-3.00dB:precision=double,aresample=192000,alimiter=limit=-3.50dB:attack=20:release=200:level=disabled:latency=1,aformat=sample_rates=48000:channel_layouts=5.1[a]',
      '-map', '[a]', '-c:a', 'libopus', '-b:a', '384k', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r) => ranClean(r)
  },
  {
    id: 'chain-aac-mono',
    args: [...QUIET, '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=32000:duration=1', '-filter_complex',
      '[0:a]aformat=sample_fmts=dbl,volume=0.00dB:precision=double,aresample=192000,alimiter=limit=-3.50dB:attack=20:release=200:level=disabled:latency=1,aformat=sample_rates=32000:channel_layouts=mono[a]',
      '-map', '[a]', '-c:a', 'aac', '-b:a', '96k', '-aac_coder', 'fast', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r) => ranClean(r)
  },
  {
    id: 'meter-dual-mono',
    args: [...QUIET, '-nostats', '-loglevel', 'level+info', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=5',
      '-filter_complex', '[0:a]ebur128@st=peak=true:dualmono=true:framelog=verbose[o]', '-map', '[o]', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r, lines) =>
    {
      const block = parseEbur128Blocks(lines.join('\n')).get('st')
      return ranClean(r) && within(block?.integratedLufs, -18.1, 0.1) && within(block?.truePeakDbtp, -18.1, 0.1)
    }
  },
  {
    id: 'meter-surround',
    args: [...QUIET, '-nostats', '-loglevel', 'level+info', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=5',
      '-filter_complex', '[0:a]asplit=2[m][s];[m]ebur128@mono=peak=none:framelog=verbose[o];[s]pan=5.1(side)|FL=c0|FR=c0|FC=c0|SL=c0|SR=c0,ebur128@surround=peak=none:framelog=verbose,anullsink',
      '-map', '[o]', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r, lines) => ranClean(r) && within(surroundGainDb(lines), SURROUND_GAIN_DB, SURROUND_TOLERANCE_DB)
  },
  {
    id: 'soxr',
    args: [...QUIET, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.1', '-af', 'aresample=resampler=soxr:precision=33:osr=384000', '-f', 'null', '-'],
    reads: 'stderr',
    pass: (r) => ranClean(r)
  },
  {
    id: 'encoders',
    args: [...QUIET, '-encoders'],
    reads: 'stdout',
    pass: (r, lines) =>
    {
      const listed = parseEncoders(lines.join('\n'))
      return ranClean(r) && hasRequiredEncoders(listed.all, listed.experimental)
    }
  }
]

/** A self-test result as the config caches it, keyed by the binary's identity and the rules' revision. */
export interface SelfTestRecord
{
  identity: BinaryIdentity
  rev: number
  results: Record<SelfTestId, boolean>
}

/** The main-owned `ffmpeg` config block: the build the app runs and its cached self-test. */
export interface FfmpegConfig
{
  source: BuildSource
  /** The install folder name of a bundled build from the pin; null for PATH, custom, and older installs. */
  buildId: string | null
  ffmpegPath: string
  ffprobePath: string
  selfTest: SelfTestRecord | null
}

function sameIdentity(a: BinaryIdentity, b: BinaryIdentity): boolean
{
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** The cached results when the record belongs to this binary and to the current rules, otherwise null. */
export function cachedSelfTest(record: SelfTestRecord | null | undefined, identity: BinaryIdentity): Record<SelfTestId, boolean> | null
{
  if (!record || record.rev !== SELF_TEST_REV || !record.identity || !sameIdentity(record.identity, identity)) return null
  if (!record.results || !SELF_TEST_IDS.every((id) => typeof record.results[id] === 'boolean')) return null
  return { ...record.results }
}

/**
 * The first failing self-test that disables the pipeline. soxr only switches the verify meter and meter-surround only
 * refuses loudness jobs on surround streams, so neither ever does.
 */
export function selfTestFailure(results: Readonly<Record<SelfTestId, boolean>>): SelfTestId | null
{
  return SELF_TEST_IDS.find((id) => !NARROWING_TESTS.has(id) && !results[id]) ?? null
}

/** Why the audio pipeline cannot run on a build, or null when it can. */
export function pipelineRefusal(info: Pick<FfmpegBuildInfo, 'versionString' | 'meetsMinimum' | 'selfTest'>): string | null
{
  if (!info.meetsMinimum) return minimumMessage(info.versionString)
  const failed = selfTestFailure(info.selfTest)
  return failed ? `FFmpeg failed the ${failed} self-test` : null
}

/** One pinned download: an archive holding ffmpeg, ffprobe, or both, with the size and digest it must match. */
export interface Asset
{
  /** The install folder name of the build this asset belongs to, such as btbn-n9.0.2-17-g2a571b6068. */
  build: string
  url: string
  bytes: number
  sha256: string
  kind: 'zip' | 'tar.xz'
  contains: ReadonlyArray<'ffmpeg' | 'ffprobe'>
}

/** The assets of one platform key: every primary asset forms one build, every fallback asset another. */
export interface PlatformPin
{
  /** The FFmpeg release both builds carry: the platform's own version when the pin holds it at another release, else the pin's. */
  version: string
  primary: Asset[]
  fallback: Asset[]
}

/** The contents of pinned-builds.json. */
export interface PinnedBuilds
{
  id: string
  /** The FFmpeg release of every platform that names no version of its own. */
  version: string
  fetched: string
  platforms: Readonly<Record<string, PlatformPin>>
}

/** What a download plan does next. */
export type InstallPlan =
  | { kind: 'reuse'; folder: string }
  | { kind: 'download'; assets: Asset[]; source: 'primary' | 'fallback' }
  | { kind: 'offer-alternatives' }

const PIN_ID = /^(?:btbn-n(\d+(?:\.\d+)+)-\d+-g[0-9a-f]+|gyan-(\d+(?:\.\d+)+)-full|mriedl-(\d+(?:\.\d+)+))$/
const PARTIAL_SUFFIX = /\.part-[A-Za-z0-9]+$/
const SHA256 = /^[0-9a-f]{64}$/
const GONE: ReadonlySet<number> = new Set([404, 410])

/** True for an install folder name the app creates: btbn-n<version>-<n>-g<hash>, gyan-<version>-full, or mriedl-<version>. */
export function isPinId(name: string): boolean
{
  return PIN_ID.test(name)
}

/** The FFmpeg release an install folder name carries, such as 9.0.2 for btbn-n9.0.2-17-g2a571b6068, or null for any other name. */
export function buildVersion(name: string): string | null
{
  const m = PIN_ID.exec(name)
  return m ? m[1] ?? m[2] ?? m[3] : null
}

/** The pin key of a host, such as win32-x64. */
export function pinKey(platform: NodeJS.Platform, arch: string): string
{
  return `${platform}-${arch}`
}

function readAsset(value: unknown, where: string): Asset
{
  const a = (value ?? {}) as Record<string, unknown>
  const contains = Array.isArray(a.contains) ? a.contains : []
  const valid = typeof a.build === 'string' && isPinId(a.build)
    && typeof a.url === 'string' && a.url.startsWith('https://')
    && typeof a.bytes === 'number' && Number.isSafeInteger(a.bytes) && a.bytes > 0
    && typeof a.sha256 === 'string' && SHA256.test(a.sha256)
    && (a.kind === 'zip' || a.kind === 'tar.xz')
    && contains.length > 0 && contains.every((c) => c === 'ffmpeg' || c === 'ffprobe')
  if (!valid) throw new Error(`Invalid pinned asset at ${where}`)
  return { build: a.build as string, url: a.url as string, bytes: a.bytes as number, sha256: a.sha256 as string, kind: a.kind as Asset['kind'], contains: contains as Asset['contains'] }
}

function readAssetSet(value: unknown, where: string): Asset[]
{
  if (!Array.isArray(value)) throw new Error(`Invalid pinned asset list at ${where}`)
  const assets = value.map((v, i) => readAsset(v, `${where}[${i}]`))
  const builds = new Set(assets.map((a) => a.build))
  const covered = new Set(assets.flatMap((a) => a.contains))
  if (assets.length > 0 && (builds.size !== 1 || !covered.has('ffmpeg') || !covered.has('ffprobe')))
  {
    throw new Error(`Pinned assets at ${where} must form one build holding ffmpeg and ffprobe`)
  }
  return assets
}

/**
 * Checks the shape of pinned-builds.json and returns it typed; throws on anything the bootstrap could misuse. A
 * platform may name its own version; every build of a platform must carry that platform's version.
 */
export function parsePin(value: unknown): PinnedBuilds
{
  const pin = (value ?? {}) as Record<string, unknown>
  if (typeof pin.id !== 'string' || typeof pin.version !== 'string' || typeof pin.fetched !== 'string' || !pin.platforms || typeof pin.platforms !== 'object')
  {
    throw new Error('Invalid pinned build list')
  }
  const platforms: Record<string, PlatformPin> = {}
  for (const [key, entry] of Object.entries(pin.platforms as Record<string, unknown>))
  {
    const e = (entry ?? {}) as Record<string, unknown>
    if (e.version !== undefined && typeof e.version !== 'string') throw new Error(`Invalid pinned version at ${key}`)
    const version = (e.version as string | undefined) ?? pin.version
    const primary = readAssetSet(e.primary, `${key}.primary`)
    const fallback = readAssetSet(e.fallback, `${key}.fallback`)
    for (const assets of [primary, fallback])
    {
      if (assets.length > 0 && buildVersion(assets[0].build) !== version)
      {
        throw new Error(`Pinned build ${assets[0].build} at ${key} is not FFmpeg ${version}`)
      }
    }
    platforms[key] = { version, primary, fallback }
  }
  return { id: pin.id, version: pin.version, fetched: pin.fetched, platforms }
}

/** The FFmpeg release the pin installs on a platform key: the platform's own version, or the pin's when it has no entry. */
export function pinnedVersion(pin: PinnedBuilds, platformKey: string): string
{
  return pin.platforms[platformKey]?.version ?? pin.version
}

/** The primary and fallback assets for a host, or null when the pin has no build for it. */
export function selectAssets(pin: PinnedBuilds, platform: NodeJS.Platform, arch: string): { primary: Asset[]; fallback: Asset[] } | null
{
  const entry = pin.platforms[pinKey(platform, arch)]
  if (!entry) return null
  return { primary: [...entry.primary], fallback: [...entry.fallback] }
}

/**
 * Hashes a download as its chunks arrive and compares size and SHA-256 with the pin. Reading stops as soon as the
 * stream passes the expected size, so an oversized or endless response never finishes downloading.
 */
export async function verifyDigest(chunks: AsyncIterable<Uint8Array>, expected: { bytes: number; sha256: string }): Promise<{ ok: boolean; bytes: number; sha256: string }>
{
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of chunks)
  {
    hash.update(chunk)
    bytes += chunk.byteLength
    if (bytes > expected.bytes) break
  }
  const sha256 = hash.digest('hex')
  return { ok: bytes === expected.bytes && sha256 === expected.sha256.toLowerCase(), bytes, sha256 }
}

function isGone(assets: readonly Asset[], failures: ReadonlyArray<{ url: string; status: number }>): boolean
{
  return assets.some((a) => failures.some((f) => f.url === a.url && GONE.has(f.status)))
}

/**
 * Decides the next install step: reuse an installed folder of this pin, download the primary build, fall back after
 * the primary answered 404 or 410, or offer the alternatives (a PATH build at or above 5.1, a binary chosen by hand,
 * or an app update) when neither build can be fetched or the pin has no build for the platform.
 */
export function planInstall(pin: PinnedBuilds, platformKey: string, existingFolders: readonly string[],
  failures: ReadonlyArray<{ url: string; status: number }>): InstallPlan
{
  const entry = pin.platforms[platformKey]
  if (!entry) return { kind: 'offer-alternatives' }
  for (const assets of [entry.primary, entry.fallback])
  {
    const folder = assets[0]?.build
    if (folder && existingFolders.includes(folder)) return { kind: 'reuse', folder }
  }
  if (entry.primary.length > 0 && !isGone(entry.primary, failures)) return { kind: 'download', assets: [...entry.primary], source: 'primary' }
  if (entry.fallback.length > 0 && !isGone(entry.fallback, failures)) return { kind: 'download', assets: [...entry.fallback], source: 'fallback' }
  return { kind: 'offer-alternatives' }
}

/**
 * The entries of `<userData>/ffmpeg/` to delete after an install: other pinned build folders, and staging folders
 * (`<build id>.part-<random>`) an interrupted install left. Anything else, a PATH or custom folder included, stays.
 */
export function foldersToDelete(currentId: string, entries: readonly string[]): string[]
{
  return entries.filter((name) => name !== currentId && (isPinId(name) || (PARTIAL_SUFFIX.test(name) && isPinId(name.replace(PARTIAL_SUFFIX, '')))))
}

/** The executable file name of a tool on a platform. */
export function executableName(base: 'ffmpeg' | 'ffprobe', platform: NodeJS.Platform): string
{
  return platform === 'win32' ? `${base}.exe` : base
}

/**
 * The folders searched for a PATH build, in order. macOS apps launched from Finder do not inherit the shell PATH,
 * so /opt/homebrew/bin and /usr/local/bin are searched there as well.
 */
export function searchDirs(platform: NodeJS.Platform, envPath: string | undefined): string[]
{
  const delimiter = platform === 'win32' ? ';' : ':'
  const dirs = (envPath ?? '').split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d.length > 0)
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return [...new Set(dirs)]
}

/** The message shown when a download does not match its pin. */
export const CHECKSUM_MESSAGE = 'Download did not match the expected checksum'

/** The message shown when neither pinned build can be downloaded, or the pin has none for the host. */
export function alternativesMessage(platformKey: string): string
{
  return `FFmpeg could not be downloaded for ${platformKey}. Install FFmpeg 5.1 or newer and add it to PATH, or update molexMedia.`
}

/** One place a build may be found. */
export interface BuildCandidate
{
  source: BuildSource
  buildId: string | null
  ffmpegPath: string
  ffprobePath: string
}

/**
 * The builds tried when looking for FFmpeg, in order: the configured build, this pin's installed folders under
 * `root`, the folder older versions installed into, then each PATH folder holding both tools. A path already listed
 * is not listed again.
 */
export function discoveryCandidates(o: {
  configured: FfmpegConfig | null
  pin: PinnedBuilds
  platform: NodeJS.Platform
  arch: string
  root: string
  installed: readonly string[]
  legacyDir: string
  envPath: string | undefined
}): BuildCandidate[]
{
  const join = o.platform === 'win32' ? win32.join : posix.join
  const ffmpeg = executableName('ffmpeg', o.platform)
  const ffprobe = executableName('ffprobe', o.platform)
  const at = (dir: string, source: BuildSource, buildId: string | null): BuildCandidate =>
    ({ source, buildId, ffmpegPath: join(dir, ffmpeg), ffprobePath: join(dir, ffprobe) })
  const out: BuildCandidate[] = []
  if (o.configured)
  {
    const { source, buildId, ffmpegPath, ffprobePath } = o.configured
    out.push({ source, buildId, ffmpegPath, ffprobePath })
  }
  const entry = o.pin.platforms[pinKey(o.platform, o.arch)]
  for (const assets of entry ? [entry.primary, entry.fallback] : [])
  {
    const id = assets[0]?.build
    if (id && o.installed.includes(id)) out.push(at(join(o.root, id), 'bundled', id))
  }
  out.push(at(o.legacyDir, 'bundled', null))
  for (const dir of searchDirs(o.platform, o.envPath)) out.push(at(dir, 'path', null))
  const seen = new Set<string>()
  return out.filter((c) =>
  {
    if (seen.has(c.ffmpegPath)) return false
    seen.add(c.ffmpegPath)
    return true
  })
}

/** Self-test results for a build that never ran them, such as one below the minimum. */
export function notRun(): Record<SelfTestId, boolean>
{
  return Object.fromEntries(SELF_TEST_IDS.map((id) => [id, false])) as Record<SelfTestId, boolean>
}

/**
 * Puts together what was read from a build: its `-version` and `-encoders` output and its self-test results (null
 * when the tests did not run). `soxr` follows the soxr self-test, which decides the true-peak meter, and
 * `surroundMeter` follows meter-surround, which decides whether loudness jobs may meter more than two channels.
 */
export function assembleBuildInfo(o: {
  candidate: Pick<BuildCandidate, 'source' | 'ffmpegPath' | 'ffprobePath'>
  identity: BinaryIdentity
  versionStdout: string
  encodersStdout: string
  selfTest: Record<SelfTestId, boolean> | null
}): FfmpegBuildInfo
{
  const version = parseVersion(o.versionStdout)
  const listed = parseEncoders(o.encodersStdout)
  const selfTest = o.selfTest ? { ...o.selfTest } : notRun()
  return {
    ffmpegPath: o.candidate.ffmpegPath,
    ffprobePath: o.candidate.ffprobePath,
    source: o.candidate.source,
    ...version,
    encoders: listed.all,
    experimental: listed.experimental,
    soxr: selfTest.soxr,
    surroundMeter: selfTest['meter-surround'],
    meetsMinimum: meetsMinimum(version.libs),
    selfTest,
    identity: { ...o.identity }
  }
}

/** The config block that records a build the app accepted, with its self-test cached under the binary's identity. */
export function configBlock(candidate: BuildCandidate, info: Pick<FfmpegBuildInfo, 'identity' | 'selfTest'>): FfmpegConfig
{
  return {
    source: candidate.source,
    buildId: candidate.buildId,
    ffmpegPath: candidate.ffmpegPath,
    ffprobePath: candidate.ffprobePath,
    selfTest: { identity: { ...info.identity }, rev: SELF_TEST_REV, results: { ...info.selfTest } }
  }
}
