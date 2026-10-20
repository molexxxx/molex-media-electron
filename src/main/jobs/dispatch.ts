/**
 * Worker slots and the pure dispatch choice: which queued jobs take a slot in one turn, and which analysis requests
 * use the slots left after them. The scheduler owns the claim turn and the dispatch checks; nothing here has state.
 */

import type { JobId } from '../../shared/jobs/ids'
import type { Job, JobPlan, RunSettings, WorkersState } from '../../shared/jobs/types'

/** A job's scheduling class, from its plan. */
export type JobClass = JobPlan['class']

/** Every job class. */
export const JOB_CLASSES: readonly JobClass[] = ['audio', 'copy', 'video-cpu', 'video-gpu']

/** Slot limits: every job, CPU video encodes, and GPU encodes. */
export type WorkerLimits = WorkersState['limits']

/** Most analysis tasks running at once. */
export const MAX_ANALYSIS_TASKS = 2

/** Highest fixed worker count. */
export const MAX_WORKERS = 64

/** Waiting reasons that hold a queued job back while it keeps its queue position. */
export const DISPATCH_HOLDS: ReadonlySet<NonNullable<Job['waiting']>> = new Set<NonNullable<Job['waiting']>>([
  'album',
  'disk-space',
  'volume-offline'
])

/** The limits a workers setting gives on a machine with `cores` logical cores under a GPU session budget. */
export function workerLimits(setting: RunSettings['workers'], cores: number, gpuBudget: number): WorkerLimits
{
  const gpu = Math.max(0, Math.floor(gpuBudget))
  if (setting.mode === 'auto')
  {
    const logical = Math.max(1, Math.floor(cores))
    return { total: logical, videoCpu: Math.max(1, Math.floor(logical / 8)), gpu }
  }
  const count = Math.min(MAX_WORKERS, Math.max(1, Math.floor(setting.count)))
  return { total: count, videoCpu: count, gpu: Math.min(count, gpu) }
}

/** What holds a slot: an active job, a dispatch claim, an album task, or an analysis task. */
export type SlotKind = 'job' | 'claim' | 'album' | 'analysis'

/** One taken slot; album and analysis tasks are class audio. */
export interface Slot
{
  kind: SlotKind
  class: JobClass
}

/** Taken slots per class and in total; claims also count in `starting`, analysis tasks also in `analysis`. */
export interface Occupancy
{
  total: number
  audio: number
  copy: number
  videoCpu: number
  gpu: number
  analysis: number
  starting: number
}

/** No slot taken. */
export const EMPTY_OCCUPANCY: Readonly<Occupancy> = Object.freeze({
  total: 0,
  audio: 0,
  copy: 0,
  videoCpu: 0,
  gpu: 0,
  analysis: 0,
  starting: 0
})

/** The occupancy with one more slot taken. */
export function occupy(occupancy: Readonly<Occupancy>, slot: Slot): Occupancy
{
  const next = { ...occupancy, total: occupancy.total + 1 }
  if (slot.class === 'audio') next.audio += 1
  else if (slot.class === 'copy') next.copy += 1
  else if (slot.class === 'video-cpu') next.videoCpu += 1
  else next.gpu += 1
  if (slot.kind === 'claim') next.starting += 1
  if (slot.kind === 'analysis') next.analysis += 1
  return next
}

/** Counts every taken slot, each in its class and in the total. */
export function countOccupancy(slots: Iterable<Slot>): Occupancy
{
  let occupancy: Occupancy = { ...EMPTY_OCCUPANCY }
  for (const slot of slots) occupancy = occupy(occupancy, slot)
  return occupancy
}

/** `WorkersState.active` from an occupancy. */
export function workersActive(occupancy: Readonly<Occupancy>): WorkersState['active']
{
  return {
    total: occupancy.total,
    videoCpu: occupancy.videoCpu,
    gpu: occupancy.gpu,
    analysis: occupancy.analysis,
    starting: occupancy.starting
  }
}

/** A queued job that may take a slot, in queue order. */
export interface DispatchCandidate
{
  id: JobId
  class: JobClass
  waiting: Job['waiting']
}

/** The fields of a job that decide whether it is a candidate. */
export type QueuedJob = Pick<Job, 'id' | 'state' | 'inputsRev' | 'waiting'> & { plan: Pick<JobPlan, 'basis' | 'class'> | null }

/** The current revisions a plan basis is compared against. */
export interface BasisRevs
{
  policyRev: number
  capabilitiesRev: number
}

/** What builds the candidate list besides the jobs themselves. */
export interface CandidateContext extends BasisRevs
{
  /** Jobs under a dispatch claim; they are counted in the occupancy and never selected again. */
  claimed: ReadonlySet<JobId>
  /** The class a job runs as when it differs from its plan's, such as a GPU job on its CPU fallback. */
  classOf?(job: QueuedJob): JobClass
  /**
   * The waiting reason dispatch applies when it is held outside the job record, such as an album task in progress;
   * undefined keeps the job's own.
   */
  waitingOf?(job: QueuedJob): Job['waiting'] | undefined
}

/** True when the job's plan was computed against its current inputs, the current policy, and the current build. */
export function planIsCurrent(job: Pick<QueuedJob, 'inputsRev' | 'plan'>, revs: BasisRevs): boolean
{
  const basis = job.plan?.basis
  return basis !== undefined &&
    basis.inputsRev === job.inputsRev &&
    basis.policyRev === revs.policyRev &&
    basis.capabilitiesRev === revs.capabilitiesRev
}

/** The queued, unclaimed jobs whose plan basis is current, in queue order. */
export function dispatchCandidates(queue: Iterable<QueuedJob>, context: CandidateContext): DispatchCandidate[]
{
  const candidates: DispatchCandidate[] = []
  for (const job of queue)
  {
    if (job.state !== 'queued' || job.plan === null || context.claimed.has(job.id)) continue
    if (!planIsCurrent(job, context)) continue
    const held = context.waitingOf?.(job)
    const waiting = held === undefined ? job.waiting : held
    candidates.push({ id: job.id, class: context.classOf?.(job) ?? job.plan.class, waiting })
  }
  return candidates
}

function hasRoom(jobClass: JobClass, occupancy: Readonly<Occupancy>, limits: WorkerLimits): boolean
{
  if (occupancy.total >= limits.total) return false
  if (jobClass === 'video-cpu') return occupancy.videoCpu < limits.videoCpu
  if (jobClass === 'video-gpu') return occupancy.gpu < limits.gpu
  return true
}

/**
 * Picks each candidate whose class has room while the total has room. Held jobs are skipped and keep their position,
 * a job blocked by its class limit does not hold back other classes, and each class stays first in, first out.
 */
export function selectDispatch(candidates: readonly DispatchCandidate[], occupancy: Readonly<Occupancy>, limits: WorkerLimits): JobId[]
{
  const picked: JobId[] = []
  const seen = new Set<JobId>()
  let taken: Occupancy = { ...occupancy }
  for (const candidate of candidates)
  {
    if (taken.total >= limits.total) break
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (candidate.waiting !== null && DISPATCH_HOLDS.has(candidate.waiting)) continue
    if (!hasRoom(candidate.class, taken, limits)) continue
    picked.push(candidate.id)
    taken = occupy(taken, { kind: 'claim', class: candidate.class })
  }
  return picked
}

/** The analysis requests that fit in the slots left, at most `MAX_ANALYSIS_TASKS` running. */
export function selectAnalysis(requests: readonly JobId[], occupancy: Readonly<Occupancy>, limits: WorkerLimits): JobId[]
{
  const room = Math.min(MAX_ANALYSIS_TASKS - occupancy.analysis, limits.total - occupancy.total)
  return room > 0 ? [...new Set(requests)].slice(0, room) : []
}

/** One dispatch turn's choice: queued jobs first, then analysis requests in the slots they leave. */
export interface DispatchChoice
{
  jobs: JobId[]
  analysis: JobId[]
}

/** Runs `selectDispatch`, counts its picks as claims, then gives the remaining slots to analysis requests. */
export function planDispatch(
  candidates: readonly DispatchCandidate[],
  requests: readonly JobId[],
  occupancy: Readonly<Occupancy>,
  limits: WorkerLimits
): DispatchChoice
{
  const jobs = selectDispatch(candidates, occupancy, limits)
  const classes = new Map(candidates.map((candidate) => [candidate.id, candidate.class]))
  let taken: Occupancy = { ...occupancy }
  for (const id of jobs) taken = occupy(taken, { kind: 'claim', class: classes.get(id) as JobClass })
  const picked = new Set(jobs)
  return { jobs, analysis: selectAnalysis(requests.filter((id) => !picked.has(id)), taken, limits) }
}
