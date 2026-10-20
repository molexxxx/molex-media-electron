/**
 * The timeline export as a job: the export command with its limiter tail, then the standard verify of the audio
 * stream. Only the true peak is judged, against the -1 dBTP gate; loudness is reported, since an export has no
 * target.
 */
import { extname } from 'path'
import type { Ceiling, Outcome } from '../../../shared/audio/types'
import type { AudioJobDeps } from '../audio/job'
import { buildVerifyArgs, isDecodeError, MAX_DECODE_ERRORS, METER_MARGIN_DB, parseVerify } from '../audio/verify'
import type { VerifyParse, VerifySpec } from '../audio/verify'
import type { Exec, ExecResult, FfmpegProgress } from '../exec'
import type { GpuMode } from '../gpu'
import { buildExportCommand, exportCeiling, getExportDurationSeconds } from './editor'
import type { ExportRequest } from './editor'

/** What the export needs from its host; the encode writes only the path output() returns. */
export interface ExportDeps
{
  exec: Exec
  /** The path the export writes, for the requested extension. */
  output(ext: string): string
  /** Called only with paths from output(). */
  fs: AudioJobDeps['fs']
  log: AudioJobDeps['log']
  /** The verify meter: soxr when the build has libsoxr, else swresample with its margin (the default). */
  meter?: 'soxr' | 'swr'
  /** GPU video encoding; software encoding when absent. */
  gpu?: { ffmpegPath: string; mode: GpuMode }
  onProgress?(p: ExportProgress): void
}

/** Render progress in percent, held below 100 until the export completes; verify reports no percent. */
export interface ExportProgress
{
  stage: 'render' | 'verify'
  percent: number | null
}

/** The verify of the exported audio stream. */
export interface ExportVerification
{
  outcome: Extract<Outcome, 'verified' | 'outside-tolerance' | 'failed'>
  ceiling: Ceiling
  /** The gate lowered by the meter margin. */
  limitDbtp: number
  truePeakDbtp: number | null
  /** The excess over limitDbtp; null when within or not measured. */
  overDb: number | null
  samplePeakDbfs: number | null
  samplePeakOver: boolean
  integratedLufs: number | null
  loudnessRangeLu: number | null
  meter: 'soxr-8x' | 'swr-8x'
  decodeErrors: string[]
  decodeErrorCount: number
}

export type ExportResult =
  | { status: 'done'; outputPath: string; verification: ExportVerification | null }
  | { status: 'canceled' }
  | { status: 'failed'; error: string }

type RunEnd =
  | { kind: 'ok'; result: ExecResult }
  | { kind: 'canceled' }
  | { kind: 'failed'; error: string }

const EPSILON = 1e-9

/** The last non-empty lines of a stderr tail, at most 300 characters. */
export function failureText(result: ExecResult): string
{
  const lines = result.stderrTail.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const text = lines.slice(-3).join(' ').slice(0, 300)
  if (text !== '')
  {
    return text
  }
  return result.code === null ? `FFmpeg stopped by ${result.signal ?? 'a signal'}` : `FFmpeg exited with code ${result.code}`
}

/** The render percent of a progress block: 0 to 99, null without a duration or a time. */
export function renderPercent(p: FfmpegProgress, durationSec: number): number | null
{
  if (durationSec <= 0 || p.outTimeSec === null)
  {
    return null
  }
  return Math.min(99, Math.max(0, Math.round(p.outTimeSec / durationSec * 100)))
}

function round2(value: number): number
{
  const rounded = Math.round(value * 100 + Math.sign(value) * EPSILON) / 100
  return rounded === 0 ? 0 : rounded
}

async function runOnce(exec: Exec, args: string[], signal: AbortSignal, durationSec: number,
  onLine: (line: string) => void, onProgress?: (p: FfmpegProgress) => void): Promise<RunEnd>
{
  if (signal.aborted)
  {
    return { kind: 'canceled' }
  }
  let result: ExecResult
  try
  {
    result = await exec.run(args, {
      signal,
      stop: 'kill',
      ...(durationSec > 0 ? { durationSec } : {}),
      ...(onProgress === undefined ? {} : { onProgress }),
      onStderrLine: onLine
    })
  }
  catch (err)
  {
    if (signal.aborted)
    {
      return { kind: 'canceled' }
    }
    return { kind: 'failed', error: `FFmpeg did not start: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (signal.aborted || result.aborted)
  {
    return { kind: 'canceled' }
  }
  if (result.outputRefused)
  {
    return { kind: 'failed', error: 'FFmpeg could not write the output file' }
  }
  if (result.code !== 0 || result.stopped !== 'none')
  {
    return { kind: 'failed', error: failureText(result) }
  }
  return { kind: 'ok', result }
}

/**
 * Judges the exported audio stream: decode errors or a missing measurement fail it; a decoded true peak over the
 * gate less the meter margin, or decoded samples over 0 dBFS, put it outside tolerance.
 */
export function judgeExport(ceiling: Ceiling, meter: 'soxr' | 'swr', parsed: VerifyParse,
  decodeErrors: string[], decodeErrorCount: number): ExportVerification
{
  const stream = parsed.streams.get(0)
  const limitDbtp = round2(ceiling.gateDbtp - METER_MARGIN_DB[meter])
  const truePeakDbtp = stream?.truePeakDbtp ?? null
  const excess = truePeakDbtp === null ? null : truePeakDbtp - limitDbtp
  const overDb = excess === null || excess <= EPSILON ? null : round2(excess)
  const samplePeakDbfs = stream?.samplePeakDbfs ?? null
  const samplePeakOver = samplePeakDbfs !== null && samplePeakDbfs > 0
  const outcome = decodeErrorCount > 0 || stream === undefined || truePeakDbtp === null ? 'failed'
    : overDb === null && !samplePeakOver ? 'verified' : 'outside-tolerance'
  return {
    outcome,
    ceiling,
    limitDbtp,
    truePeakDbtp,
    overDb,
    samplePeakDbfs,
    samplePeakOver,
    integratedLufs: stream?.integratedLufs ?? null,
    loudnessRangeLu: stream?.loudnessRangeLu ?? null,
    meter: meter === 'soxr' ? 'soxr-8x' : 'swr-8x',
    decodeErrors,
    decodeErrorCount
  }
}

function hasAudio(args: readonly string[]): boolean
{
  return args.includes('-c:a')
}

async function removeOutput(deps: ExportDeps, path: string): Promise<void>
{
  try
  {
    await deps.fs.remove(path)
  }
  catch (err)
  {
    deps.log({ level: 'warn', message: 'Could not remove the export output', data: { path, error: err instanceof Error ? err.message : String(err) } })
  }
}

/**
 * Renders a timeline export and verifies its audio. A cancel or a failed render removes the output; a finished
 * render is kept whatever its verdict, which the result carries for the caller to report.
 */
export async function runExportJob(request: ExportRequest, deps: ExportDeps, signal: AbortSignal): Promise<ExportResult>
{
  if (signal.aborted)
  {
    return { status: 'canceled' }
  }
  const path = deps.output(extname(request.output.filePath).slice(1).toLowerCase())
  const job: ExportRequest = { ...request, output: { ...request.output, filePath: path } }
  let args: string[]
  try
  {
    args = await buildExportCommand(job, deps.gpu?.ffmpegPath, deps.gpu?.mode)
  }
  catch (err)
  {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  const durationSec = getExportDurationSeconds(job)
  deps.log({ level: 'info', message: 'Timeline export started', data: { path, durationSec: Math.round(durationSec * 10) / 10 } })
  deps.onProgress?.({ stage: 'render', percent: 0 })
  const rendered = await runOnce(deps.exec, args, signal, durationSec, () => undefined,
    (p) => deps.onProgress?.({ stage: 'render', percent: renderPercent(p, durationSec) }))
  if (rendered.kind !== 'ok')
  {
    await removeOutput(deps, path)
    if (rendered.kind === 'canceled')
    {
      return { status: 'canceled' }
    }
    deps.log({ level: 'error', message: 'Timeline export failed', data: { path, error: rendered.error } })
    return { status: 'failed', error: rendered.error }
  }
  let bytes = 0
  try
  {
    bytes = await deps.fs.size(path)
  }
  catch
  {
    bytes = 0
  }
  if (bytes <= 0)
  {
    await removeOutput(deps, path)
    return { status: 'failed', error: 'The export wrote an empty file' }
  }
  if (!hasAudio(args))
  {
    deps.log({ level: 'info', message: 'Timeline export complete', data: { path } })
    return { status: 'done', outputPath: path, verification: null }
  }
  return verifyExport(job, deps, signal, path, durationSec)
}

async function verifyExport(job: ExportRequest, deps: ExportDeps, signal: AbortSignal, path: string,
  durationSec: number): Promise<ExportResult>
{
  deps.onProgress?.({ stage: 'verify', percent: null })
  const meter = deps.meter ?? 'swr'
  const ceiling = exportCeiling(job.output)
  const spec: VerifySpec = {
    outIndex: 0,
    sampleRate: job.output.sampleRate ?? job.project.sampleRate,
    dualMono: false,
    weights: null,
    shortTerm: false,
    passthrough: false,
    preEncodeTruePeakDbtp: null,
    durationSec: durationSec > 0 ? durationSec : null
  }
  const lines: string[] = []
  const errors: string[] = []
  let errorCount = 0
  const checked = await runOnce(deps.exec, buildVerifyArgs(path, [spec], meter), signal, durationSec, (line) =>
  {
    if (!isDecodeError(line))
    {
      lines.push(line)
      return
    }
    errorCount++
    if (errors.length < MAX_DECODE_ERRORS)
    {
      errors.push(line)
    }
  })
  if (checked.kind === 'canceled')
  {
    await removeOutput(deps, path)
    return { status: 'canceled' }
  }
  const parsed = parseVerify(lines, [spec], meter)
  const failedRun = checked.kind === 'failed'
  const count = Math.max(parsed.decodeErrorCount, errorCount, failedRun && errorCount === 0 ? 1 : 0)
  const decodeErrors = failedRun && errors.length === 0 ? [checked.error] : errors
  const verification = judgeExport(ceiling, meter, parsed, decodeErrors, count)
  deps.log({
    level: verification.outcome === 'verified' ? 'info' : 'warn',
    message: 'Timeline export verified',
    data: {
      path,
      outcome: verification.outcome,
      truePeakDbtp: verification.truePeakDbtp,
      limitDbtp: verification.limitDbtp,
      integratedLufs: verification.integratedLufs,
      decodeErrorCount: verification.decodeErrorCount
    }
  })
  return { status: 'done', outputPath: path, verification }
}
