/**
 * The one interface every job runner implements. A runner reads only its frozen recipe, its runnable job, and its
 * context; it writes only inside the execution's work folder, runs every process through `ctx.exec`, checks
 * `ctx.signal.aborted` after every await, reports stages instead of states, verifies its own output, and returns
 * `aborted` instead of throwing. A runner that waits takes `Timers` from `src/main/timers.ts`, any `onSpawn` it
 * passes never throws, and it names a failed process with `execEnding`.
 */

import type { MediaFacts } from '../../../shared/audio/types'
import type { JobId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import type { FrozenPolicy, JobError, JobMeasurement, JobPlan, OutputPlan, PlanIssue, SourceRef, StageId, Verification } from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import type { BuildCapabilities } from '../../ffmpeg/audio/encoders'
import type { Exec, ExecResult } from '../../ffmpeg/exec'
import type { AlbumHandle, GpuLease, JobLogger, MeasurementCache } from '../deps'

/** What a runner plans from: its recipe, the probed source, the build, and the output the planner chose. */
export interface PlanInput<R extends Recipe = Recipe>
{
  readonly recipe: R
  readonly source: SourceRef
  readonly facts: MediaFacts
  readonly caps: BuildCapabilities
  readonly output: OutputPlan
  readonly platform: Platform
}

/**
 * A runner's share of a job's plan, with measurement-dependent values in the command as placeholders; the planner
 * adds the basis, fingerprint, source, output, reserve, and album.
 */
export interface RunnerPlan
{
  command: JobPlan['command']
  streams: JobPlan['streams']
  video: JobPlan['video']
  audio: JobPlan['audio']
  class: JobPlan['class']
  stages: JobPlan['stages']
  estimate: { outputBytes: number | null; workSec: number | null; confidence: JobPlan['estimate']['confidence'] }
  issues: PlanIssue[]
}

/** A queued job as a runner sees it: the frozen recipe, plan, and policy, and the source it reads. */
export interface RunnableJob<R extends Recipe = Recipe>
{
  readonly id: JobId
  readonly recipe: R
  readonly plan: JobPlan
  readonly policy: FrozenPolicy
  readonly source: SourceRef
  readonly attempt: number
}

/** One runner per recipe kind. */
export interface JobRunner<R extends Recipe = Recipe>
{
  readonly kind: R['kind']
  plan(input: PlanInput<R>): RunnerPlan
  run(job: RunnableJob<R>, ctx: RunContext): Promise<RunOutcome>
}

/** Everything a running job may touch; the engine builds one per execution. */
export interface RunContext
{
  readonly signal: AbortSignal
  readonly exec: Exec
  readonly workDir: string
  readonly execution: number
  readonly caps: BuildCapabilities
  readonly gpu: GpuLease | null
  readonly album: AlbumHandle | null
  readonly cache: MeasurementCache
  probe(path: string): Promise<MediaFacts>
  output(ext: string, encodePass: number): string
  outputFolder(name: string): string
  stage(update: { id: StageId; pass: number; passes: number; label: string }): void
  progress(p: { outTimeSec: number | null; durationSec: number | null; speed: number | null; bytes: number | null }): void
  measured(m: JobMeasurement): void
  log: JobLogger
  now(): number
}

/** A run's result; expected failures and aborts are values, never throws. */
export type RunOutcome =
  | { kind: 'output'; artifact: OutputArtifact; verification: Verification; measurement: JobMeasurement | null; notes: string[] }
  | { kind: 'failed'; error: JobError }
  | { kind: 'aborted' }

/** The verified file or folder a run left in its work folder for the engine to place. */
export interface OutputArtifact
{
  kind: 'file' | 'folder'
  path: string
  container: string
  bytes: number
  durationSec: number | null
  encoder: { video: string | null; audio: string[] }
}

/** How a finished FFmpeg run ended, as a runner reports it. */
export type ExecEnding =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'output-exists' }
  | { kind: 'failed'; exitCode: number | null; exitName: string | null; signal: string | null }

/**
 * Names how a run ended. A non-zero code or a signal names the failure before `outputRefused` is read, because
 * FFmpeg 9 also reports `outputRefused` for an unknown encoder; `outputRefused` with code 0 is an existing output
 * that -n refused, and a run exec had to stop is never completed.
 */
export function execEnding(result: ExecResult): ExecEnding
{
  if (result.aborted)
  {
    return { kind: 'aborted' }
  }
  if (result.code !== 0 || result.signal !== null || result.stopped !== 'none')
  {
    return { kind: 'failed', exitCode: result.code, exitName: result.exitName, signal: result.signal }
  }
  if (result.outputRefused)
  {
    return { kind: 'output-exists' }
  }
  return { kind: 'completed' }
}
