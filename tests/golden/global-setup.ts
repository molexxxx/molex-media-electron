/**
 * Resolves the FFmpeg build for the golden suite from MOLEX_FFMPEG_DIR or PATH, reads its version, encoders,
 * and configuration, runs the startup self-test, builds or reuses the corpus under the temp folder, and
 * provides the result to every test file as `golden`.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'
import { execArgv, exitName, normalizeLines, signedExitCode } from '../../src/main/ffmpeg/exec'
import type { ExecResult } from '../../src/main/ffmpeg/exec'
import { SELF_TESTS, executableName, meetsMinimum, minimumMessage, parseEncoders, parseVersion, searchDirs } from '../../src/main/ffmpeg/build'
import type { SelfTestId } from '../../src/main/ffmpeg/build'
import { buildCorpus } from './corpus'
import { loudnessArgs, readLoudness, runTool } from './oracle'

/** The skip reason when no build is found. */
export const SKIP_MESSAGE = 'No FFmpeg: set MOLEX_FFMPEG_DIR or put ffmpeg and ffprobe on PATH'

/** Everything the golden tests know about the build under test. */
export interface GoldenInfo
{
  /** Why the suite skips, or null when a build was found. Every other field is empty when set. */
  skip: string | null
  ffmpeg: string
  ffprobe: string
  /** The folder-safe version token, such as n9.0.2-17-g2a571b6068-20260930. */
  buildId: string
  versionString: string
  libs: Record<string, number[]>
  configuration: string[]
  encoders: string[]
  experimental: string[]
  /** The build lists --enable-libsoxr and its soxr self-test passed. */
  soxr: boolean
  meetsMinimum: boolean
  /** The refusal a build below FFmpeg 5.1 gets, or null. */
  minimumMessage: string | null
  selfTest: Record<SelfTestId, boolean>
  /** The golden root: MOLEX_GOLDEN_OUT or `<os.tmpdir()>/molex-golden`. */
  root: string
  /** `<root>/<buildId>`. */
  dir: string
  corpusDir: string
  /** Per-run outputs; removed after the run unless MOLEX_GOLDEN_KEEP=1. */
  outDir: string
  reportDir: string
  /** Corpus file name to absolute path. */
  corpus: Record<string, string>
  /** Corpus entries this build could not make, with the reason. */
  missing: Record<string, string>
  /** MOLEX_GOLDEN_ONLY as a list, or null. */
  only: string[] | null
  keep: boolean
}

declare module 'vitest'
{
  export interface ProvidedContext
  {
    golden: GoldenInfo
  }
}

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function skipped(reason: string): GoldenInfo
{
  return {
    skip: reason, ffmpeg: '', ffprobe: '', buildId: '', versionString: '', libs: {}, configuration: [], encoders: [], experimental: [],
    soxr: false, meetsMinimum: false, minimumMessage: null, selfTest: {} as Record<SelfTestId, boolean>, root: '', dir: '', corpusDir: '',
    outDir: '', reportDir: '', corpus: {}, missing: {}, only: null, keep: false
  }
}

/** Finds ffmpeg and ffprobe in MOLEX_FFMPEG_DIR, else on PATH; a MOLEX_FFMPEG_DIR without both is an error. */
export function resolveBinaries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { ffmpeg: string; ffprobe: string } | null
{
  const pair = (dir: string): { ffmpeg: string; ffprobe: string } => ({
    ffmpeg: join(dir, executableName('ffmpeg', platform)),
    ffprobe: join(dir, executableName('ffprobe', platform))
  })
  const fromEnv = env.MOLEX_FFMPEG_DIR?.trim()
  if (fromEnv)
  {
    const found = pair(resolve(fromEnv))
    if (!existsSync(found.ffmpeg) || !existsSync(found.ffprobe)) throw new Error(`MOLEX_FFMPEG_DIR has no ffmpeg and ffprobe: ${fromEnv}`)
    return found
  }
  for (const dir of searchDirs(platform, env.PATH))
  {
    const found = pair(dir)
    if (existsSync(found.ffmpeg) && existsSync(found.ffprobe)) return found
  }
  return null
}

/** A folder-safe build id from a version token. */
export function buildIdOf(versionString: string): string
{
  return versionString.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown'
}

/** One corpus file as a build measures it: its first audio stream's loudness, range, and peaks. */
export type CorpusPrint = { integrated: number, lra: number, samplePeak: number | null, truePeak: number | null } | { error: string }

/**
 * Measures every corpus file's first audio stream, four at a time, so a build that renders the corpus differently
 * shows which file differs when its report is set beside another build's. A file without audio records its error.
 */
export async function corpusFingerprint(ffmpeg: string, corpus: Readonly<Record<string, string>>): Promise<Record<string, CorpusPrint>>
{
  const names = Object.keys(corpus).sort()
  const prints: Record<string, CorpusPrint> = {}
  for (let i = 0; i < names.length; i += 4)
  {
    await Promise.all(names.slice(i, i + 4).map(async (name) =>
    {
      const run = await runTool(ffmpeg, loudnessArgs(corpus[name]))
      try
      {
        const reading = readLoudness(run.stderr)
        prints[name] = { integrated: reading.integratedPrecise ?? reading.integrated, lra: reading.lraPrecise ?? reading.lra, samplePeak: reading.samplePeak, truePeak: reading.truePeak }
      }
      catch (error)
      {
        prints[name] = { error: `exit ${run.code}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }))
  }
  return Object.fromEntries(names.map((name) => [name, prints[name]]))
}

/** A run folder untouched this long belongs to a run that ended without its teardown. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000

/**
 * The output folder of one run, named by its process, so two runs on one build and root never clear each other's
 * outputs. It stays short because several cases measure path-length limits under it.
 */
export function runFolderName(pid: number): string
{
  return `run-${pid}`
}

/** Removes the run folders under `outRoot` last modified before `before`; a missing root is fine. */
export async function sweepStaleRuns(outRoot: string, before: number): Promise<string[]>
{
  const names = await readdir(outRoot).catch(() => [] as string[])
  const removed: string[] = []
  for (const name of names)
  {
    const path = join(outRoot, name)
    const info = await stat(path).catch(() => null)
    if (info !== null && info.mtimeMs < before)
    {
      await rm(path, { recursive: true, force: true })
      removed.push(name)
    }
  }
  return removed
}

/** The golden root; refuses a folder inside the repository, which packaging would sweep up. */
export function goldenRoot(env: NodeJS.ProcessEnv, repo = REPO): string
{
  const root = resolve(env.MOLEX_GOLDEN_OUT?.trim() || join(tmpdir(), 'molex-golden'))
  const rel = relative(repo, root)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error(`Golden outputs must live outside the repository: ${root}`)
  return root
}

async function runSelfTests(ffmpeg: string): Promise<Record<SelfTestId, boolean>>
{
  const results = {} as Record<SelfTestId, boolean>
  for (const test of SELF_TESTS)
  {
    const run = await runTool(ffmpeg, execArgv(test.args, 'kill'))
    const code = signedExitCode(run.code)
    const result: ExecResult = {
      code, exitName: exitName(code), signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: run.stderr.slice(-2048), ms: run.ms
    }
    const text = normalizeLines(test.reads === 'stdout' ? run.stdout : run.stderr)
    const lines = text.split('\n').filter((line, i, all) => i < all.length - 1 || line.length > 0)
    results[test.id] = test.pass(result, lines)
  }
  return results
}

/** Resolves and inspects the build, runs the self-test, and builds or reuses the corpus. */
export async function prepareGolden(env: NodeJS.ProcessEnv, log: (message: string) => void): Promise<GoldenInfo>
{
  const bins = resolveBinaries(env)
  if (!bins) return skipped(SKIP_MESSAGE)
  const version = await runTool(bins.ffmpeg, ['-hide_banner', '-version'])
  if (version.code !== 0) throw new Error(`${bins.ffmpeg} -version exited with ${version.code}`)
  const parsed = parseVersion(version.stdout)
  const listed = await runTool(bins.ffmpeg, ['-hide_banner', '-encoders'])
  const encoders = parseEncoders(listed.stdout)
  const selfTest = await runSelfTests(bins.ffmpeg)
  const minimum = meetsMinimum(parsed.libs)
  const buildId = buildIdOf(parsed.versionString)
  const root = goldenRoot(env)
  const dir = join(root, buildId)
  const corpusDir = join(dir, 'corpus')
  const outDir = join(dir, 'out', runFolderName(process.pid))
  const reportDir = join(root, 'report')
  log(`FFmpeg ${parsed.versionString} at ${bins.ffmpeg}`)
  await sweepStaleRuns(join(dir, 'out'), Date.now() - STALE_RUN_MS)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })

  let corpus: Record<string, string> = {}
  let missing: Record<string, string> = {}
  if (minimum)
  {
    const manifest = await buildCorpus({ ffmpeg: bins.ffmpeg, dir: corpusDir, encoders: encoders.all, log, fresh: env.MOLEX_GOLDEN_FRESH === '1' })
    corpus = Object.fromEntries(Object.keys(manifest.files).map((name) => [name, join(corpusDir, name)]))
    missing = manifest.missing
    await mkdir(reportDir, { recursive: true })
    await writeFile(join(reportDir, `${buildId}-corpus.json`), JSON.stringify(await corpusFingerprint(bins.ffmpeg, corpus), null, 2))
  }
  else
  {
    log(minimumMessage(parsed.versionString))
  }

  const info: GoldenInfo = {
    skip: null,
    ffmpeg: bins.ffmpeg,
    ffprobe: bins.ffprobe,
    buildId,
    versionString: parsed.versionString,
    libs: Object.fromEntries(Object.entries(parsed.libs).map(([k, v]) => [k, [...v]])),
    configuration: [...parsed.configuration],
    encoders: [...encoders.all].sort(),
    experimental: [...encoders.experimental].sort(),
    soxr: parsed.configuration.includes('--enable-libsoxr') && selfTest.soxr,
    meetsMinimum: minimum,
    minimumMessage: minimum ? null : minimumMessage(parsed.versionString),
    selfTest,
    root,
    dir,
    corpusDir,
    outDir,
    reportDir,
    corpus,
    missing,
    only: env.MOLEX_GOLDEN_ONLY ? env.MOLEX_GOLDEN_ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null,
    keep: env.MOLEX_GOLDEN_KEEP === '1'
  }
  await writeFile(join(reportDir, `${buildId}-setup.json`), JSON.stringify(info, null, 2))
  return info
}

/** Vitest global setup: provides `golden`, or a skip that MOLEX_GOLDEN_REQUIRED=1 turns into a failure. */
export default async function setup(project: TestProject): Promise<() => Promise<void>>
{
  const log = (message: string): void => console.log(`[golden] ${message}`)
  const info = await prepareGolden(process.env, log)
  if (info.skip)
  {
    if (process.env.MOLEX_GOLDEN_REQUIRED === '1') throw new Error(info.skip)
    console.warn(`[golden] ${info.skip}`)
  }
  project.provide('golden', info)
  return async () =>
  {
    if (!info.skip && !info.keep) await rm(info.outDir, { recursive: true, force: true })
  }
}
