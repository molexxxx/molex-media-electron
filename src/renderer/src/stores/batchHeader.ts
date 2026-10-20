/**
 * The run header's derivations: the title, the state sentence and the order it sheds parts in, the attention button,
 * the one next action by the primary precedence, the run controls, the consequence line before, during, and after a
 * run, and the Output and Workers labels. Pure functions over the jobs store and the view's Review session, so the
 * header, Ctrl+Enter, and the summary slot read one answer.
 */
import type { RunId } from '../../../shared/jobs/ids'
import { needsAttention, STATE_GROUPS } from '../../../shared/jobs/states'
import type
{
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  JobView,
  PreflightReport,
  RunAlert,
  RunState,
  RunStatus,
  ScanState
} from '../../../shared/jobs/types'
import { binPhrase, type Platform } from '../../../shared/text/platform'
import
{
  ACTION_LABELS,
  ANNOUNCEMENTS,
  ESTIMATING_TIME_LEFT,
  HEADER_TOOLTIPS,
  PAGE_NAME,
  PART_SEPARATOR,
  STARTING_LABEL,
  acknowledgeFirstReason,
  acknowledgeRestoredReason,
  actionTooltip,
  appendLabel,
  checkingReason,
  countOf,
  finishedOf,
  fixFieldFirst,
  formatBytes,
  formatCount,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatThroughput,
  formatTimeLeft,
  formatTimeOfDay,
  needAttention,
  needAttentionTooltip,
  nothingRunnableReason,
  pageTitle,
  pauseNowLabel,
  pauseTooltip,
  probingReason,
  retryReturnedLabel,
  reviewLabel,
  reviewNewLabel,
  startLabel,
  verbFor,
  type ActionKind
} from '../copy/batch'
import type { JobsState, PreflightProgress } from './jobs'
import { selectLatestRunId, selectPendingSummary, type PendingSummary } from './jobsSelectors'

/** The modes of the one table. */
export type BatchMode = 'queue' | 'review' | 'run' | 'history'

/** The batch the header describes: the current run, or the latest run any job in the queue belongs to. */
export interface BatchFacts
{
  runId: RunId
  /** Jobs of the batch; waiting jobs that carry its id are not in it. */
  total: number
  /** Jobs that left the working states: held ones and every ended state. */
  settled: number
  /** Jobs holding a worker slot. */
  active: number
  queued: number
  done: number
  canceled: number
  /** Jobs Cancel run ended. */
  canceledByRun: number
  /** Jobs of this batch for which needsAttention is true. */
  attention: number
  startedAt: number | null
  endedAt: number | null
}

/** What the header reads from the jobs store. */
export interface HeaderFacts
{
  status: RunStatus
  batch: BatchFacts | null
  pending: Readonly<PendingSummary>
  jobCount: number
  queueFull: boolean
  /** Failed and interrupted jobs and jobs placed outside tolerance: what Retry returned retries. */
  returned: number
  /** Waiting Extract jobs, which never replace originals. */
  pendingExtract: number
  /** The folder scan still running, if any. */
  scan: ScanState | null
}

type Jobs = JobsState['jobs']

function lastValue<A extends readonly unknown[], R>(compute: (...inputs: A) => R): (...inputs: A) => R
{
  let last: { inputs: A; value: R } | null = null
  return (...inputs: A): R =>
  {
    const previous = last
    if (previous !== null && inputs.every((input, index) => Object.is(input, previous.inputs[index])))
    {
      return previous.value
    }
    const value = compute(...inputs)
    last = { inputs, value }
    return value
  }
}

function emptyBatch(runId: RunId): BatchFacts
{
  return { runId, total: 0, settled: 0, active: 0, queued: 0, done: 0, canceled: 0, canceledByRun: 0, attention: 0, startedAt: null, endedAt: null }
}

function addToBatch(facts: BatchFacts, job: JobView): void
{
  facts.total += 1
  const group = STATE_GROUPS[job.state]
  if (group === 'decision' || group === 'terminal')
  {
    facts.settled += 1
  }
  else if (group === 'active')
  {
    facts.active += 1
  }
  else
  {
    facts.queued += 1
  }
  if (job.state === 'done')
  {
    facts.done += 1
  }
  else if (job.state === 'canceled')
  {
    facts.canceled += 1
    facts.canceledByRun += job.reason === 'run-canceled' ? 1 : 0
  }
  facts.attention += needsAttention(job) ? 1 : 0
  if (job.startedAt !== null && (facts.startedAt === null || job.startedAt < facts.startedAt))
  {
    facts.startedAt = job.startedAt
  }
  if (job.endedAt !== null && (facts.endedAt === null || job.endedAt > facts.endedAt))
  {
    facts.endedAt = job.endedAt
  }
}

function isReturned(job: JobView): boolean
{
  return job.state === 'failed' || job.state === 'interrupted' ||
    (job.state === 'done' && job.warnings.some((warning) => warning.code === 'outside-tolerance-placed'))
}

const headerFacts = lastValue((
  run: RunState | null,
  jobs: Jobs,
  jobCount: number,
  maxJobs: number | null,
  scans: readonly ScanState[],
  pending: Readonly<PendingSummary>,
  latestRunId: RunId | null
): HeaderFacts =>
{
  const status = run?.status ?? 'idle'
  const current = status !== 'idle' && run !== null && run.runId !== null
  const batch = latestRunId === null ? null : emptyBatch(latestRunId)
  let returned = 0
  let pendingExtract = 0
  for (const job of Object.values(jobs))
  {
    if (job.state === 'pending')
    {
      pendingExtract += job.recipe.kind === 'extract' ? 1 : 0
      continue
    }
    if (batch !== null && job.runId === batch.runId)
    {
      addToBatch(batch, job)
    }
    returned += isReturned(job) ? 1 : 0
  }
  return {
    status,
    batch: batch !== null && (batch.total > 0 || current) ? batch : null,
    pending,
    jobCount,
    queueFull: maxJobs !== null && jobCount >= maxJobs,
    returned,
    pendingExtract,
    scan: scans.find((scan) => scan.status === 'scanning') ?? null
  }
})

/** The counts the header states, memoized on the store fields they read. */
export function selectHeaderFacts(state: JobsState): HeaderFacts
{
  return headerFacts(
    state.run,
    state.jobs,
    state.order.length,
    state.limits?.maxJobs ?? null,
    state.scans,
    selectPendingSummary(state),
    selectLatestRunId(state)
  )
}

/** The Review session as the header reads it. */
export interface ReviewSession
{
  /** The counts of the report Start would send; null before the first report arrives. */
  counts: PreflightReport['counts'] | null
  /** The report covers only the selected jobs. */
  subset: boolean
  /** The acknowledgment in the summary is checked. */
  acknowledged: boolean
}

/** What the header reads from the view and the window. */
export interface HeaderView
{
  mode: BatchMode
  platform: Platform
  /** The Review session; null before Review opened. */
  review?: ReviewSession | null
  /** The label of the first field whose draft is invalid; Start and Append refuse until it is fixed. */
  invalidField?: string | null
  /** From a press of Start or Append until main answers. */
  starting?: boolean
  /** The acknowledgment in a restored Replace batch's banner is checked. */
  restoredAcknowledged?: boolean
  /** The latest batch's summary when the window has it: the completed event, or runs:get after a reload. */
  summary?: BatchSummary | null
}

/** What holds the one next action back, so Ctrl+Enter knows what to say and where focus goes. */
export type ActionBlock = 'probing' | 'checking' | 'nothing-runnable' | 'acknowledgment' | 'field' | 'starting'

/** The one next action; a disabled action is drawn neutral, never primary. */
export interface HeaderAction
{
  kind: ActionKind
  label: string
  tooltip: string
  /** The jobs it acts on. */
  count: number
  enabled: boolean
  /** Why it is disabled, written beside it; null when enabled or while Start waits for main. */
  reason: string | null
  blockedBy: ActionBlock | null
  /** Add files is the empty state's action; every other action sits in the header's action slot. */
  place: 'header' | 'empty-state'
}

function ready(kind: ActionKind, label: string, count: number, platform: Platform, place: HeaderAction['place'] = 'header'): HeaderAction
{
  return { kind, label, tooltip: actionTooltip(kind, platform), count, enabled: true, reason: null, blockedBy: null, place }
}

function blocked(action: HeaderAction, blockedBy: ActionBlock, reason: string | null): HeaderAction
{
  return { ...action, enabled: false, reason, blockedBy }
}

function resumeAction(view: HeaderView, needsAck: boolean): HeaderAction
{
  const action = ready('resume', ACTION_LABELS.resume, 0, view.platform)
  return needsAck && view.restoredAcknowledged !== true
    ? blocked(action, 'acknowledgment', acknowledgeRestoredReason(view.platform))
    : action
}

function startBlock(facts: HeaderFacts, view: HeaderView, preflight: PreflightProgress | null): { blockedBy: ActionBlock; reason: string } | null
{
  const { pending } = facts
  const counts = view.review?.counts ?? null
  if (pending.probing > 0)
  {
    return { blockedBy: 'probing', reason: probingReason(pending.jobs - pending.probing, pending.jobs) }
  }
  if (preflight !== null && preflight.done < preflight.total)
  {
    return { blockedBy: 'checking', reason: checkingReason(preflight.done, preflight.total) }
  }
  if (counts === null)
  {
    return { blockedBy: 'checking', reason: checkingReason(0, pending.jobs) }
  }
  if (counts.ready === 0)
  {
    return { blockedBy: 'nothing-runnable', reason: nothingRunnableReason(counts.blocked) }
  }
  if ((counts.originalsAffected > 0 || counts.overwrites > 0) && view.review?.acknowledged !== true)
  {
    return { blockedBy: 'acknowledgment', reason: acknowledgeFirstReason(view.platform) }
  }
  if (view.invalidField)
  {
    return { blockedBy: 'field', reason: fixFieldFirst(view.invalidField) }
  }
  return null
}

function gatedAction(kind: 'start' | 'append', facts: HeaderFacts, view: HeaderView, preflight: PreflightProgress | null, runId: RunId | null): HeaderAction
{
  const counts = view.review?.counts ?? null
  const count = counts?.ready ?? 0
  const scope = { subset: view.review?.subset ?? false, originals: counts?.originalsAffected ?? 0, overwrites: counts?.overwrites ?? 0 }
  const label = kind === 'append' ? appendLabel(count, runId as RunId) : startLabel(count, scope)
  const action = ready(kind, label, count, view.platform)
  if (view.starting === true)
  {
    return blocked({ ...action, label: STARTING_LABEL }, 'starting', null)
  }
  const block = startBlock(facts, view, preflight)
  return block === null ? action : blocked(action, block.blockedBy, block.reason)
}

/** Jobs added outside the running batch that could join it; a blocked job cannot, so it is not one. */
export function newJobsWaiting(facts: Pick<HeaderFacts, 'pending'>): number
{
  return Math.max(0, facts.pending.jobs - facts.pending.blocked)
}

/**
 * The one next action by the primary precedence: Resume, then Append or Review new jobs during a run, then Start in
 * Review, then Review, then Retry returned, then Add files; null when the moment has none ("Nothing to start.").
 * Start and Append may come back disabled with their reason, and Resume while a restored Replace batch waits for
 * its acknowledgment.
 */
export function nextAction(facts: HeaderFacts, view: HeaderView, preflight: PreflightProgress | null = null, needsAck = false): HeaderAction | null
{
  const { status } = facts
  const waiting = facts.pending.jobs
  if (status === 'pausing' || status === 'paused')
  {
    return resumeAction(view, needsAck)
  }
  if (status === 'running')
  {
    const runnable = newJobsWaiting(facts)
    if (runnable === 0 || facts.batch === null)
    {
      return null
    }
    return view.mode === 'review'
      ? gatedAction('append', facts, view, preflight, facts.batch.runId)
      : ready('review-new', reviewNewLabel(runnable), runnable, view.platform)
  }
  if (status !== 'idle')
  {
    return null
  }
  if (waiting > 0)
  {
    return view.mode === 'review'
      ? gatedAction('start', facts, view, preflight, null)
      : ready('review', reviewLabel(waiting), waiting, view.platform)
  }
  if (facts.returned > 0)
  {
    return ready('retry-returned', retryReturnedLabel(facts.returned), facts.returned, view.platform)
  }
  return facts.jobCount === 0 ? ready('add-files', ACTION_LABELS.addFiles, 0, view.platform, 'empty-state') : null
}

/** The header's action slot: the next action, else Review drawn neutral and disabled; null while only run controls show. */
export function slotAction(facts: HeaderFacts, action: HeaderAction | null): HeaderAction | null
{
  if (action !== null && action.place === 'header')
  {
    return action
  }
  if (facts.status === 'running' || facts.status === 'canceling')
  {
    return null
  }
  return {
    kind: 'review',
    label: ACTION_LABELS.review,
    tooltip: HEADER_TOOLTIPS.reviewDisabled,
    count: 0,
    enabled: false,
    reason: null,
    blockedBy: null,
    place: 'header'
  }
}

/** What Ctrl+Enter does at this moment. */
export type CtrlEnterOutcome =
  | { kind: 'perform'; action: HeaderAction }
  | { kind: 'refuse'; action: HeaderAction; announcement: string; focus: 'acknowledgment' | 'field' | null }
  | { kind: 'ignore' }
  | { kind: 'nothing'; announcement: string }

/**
 * Ctrl+Enter performs the next action; a disabled one announces its reason and sends focus to the acknowledgment or
 * the field that holds it; while Start waits for main further presses are ignored; with no action it announces
 * "Nothing to start." Committing a field draft first is the caller's step.
 */
export function ctrlEnter(action: HeaderAction | null): CtrlEnterOutcome
{
  if (action === null)
  {
    return { kind: 'nothing', announcement: ANNOUNCEMENTS.nothingToStart }
  }
  if (action.enabled)
  {
    return { kind: 'perform', action }
  }
  if (action.blockedBy === 'starting')
  {
    return { kind: 'ignore' }
  }
  const focus = action.blockedBy === 'acknowledgment' || action.blockedBy === 'field' ? action.blockedBy : null
  return { kind: 'refuse', action, announcement: action.reason ?? ANNOUNCEMENTS.nothingToStart, focus }
}

/** The kinds of the state sentence's parts. */
export type SentencePartKind = 'lead' | 'size' | 'media' | 'blocked' | 'warnings' | 'queue-full' | 'new-jobs' | 'attention'

/** One part of the state sentence; the attention part is the button that shows those jobs. */
export interface SentencePart
{
  kind: SentencePartKind
  text: string
  /** The form the last shedding step uses. */
  short: string
  /** A batch the app paused carries a warning StatusLabel. */
  tone: 'warning' | null
}

/** The state sentence; full is every part at full length, the accessible description and the tooltip. */
export interface StateSentence
{
  parts: SentencePart[]
  full: string
}

function part(kind: SentencePartKind, text: string, short: string = text, tone: SentencePart['tone'] = null): SentencePart
{
  return { kind, text, short, tone }
}

/** Joins sentence parts with the dot separator. */
export function sentenceText(parts: readonly SentencePart[], short = false): string
{
  return parts.map((item) => (short ? item.short : item.text)).join(PART_SEPARATOR)
}

function sentence(parts: SentencePart[]): StateSentence
{
  return { parts, full: sentenceText(parts) }
}

/** Shedding steps: 0 every part, 1 without the media time, 2 without the size too, 3 with the problems shortened. */
export type ShedLevel = 0 | 1 | 2 | 3

/** Every shedding step, in the order a tight header tries them. */
export const SHED_LEVELS: readonly ShedLevel[] = [0, 1, 2, 3]

/** The parts at one shedding step; blocked, warning, and need-attention parts are never dropped, only shortened last. */
export function shedSentence(value: StateSentence, level: ShedLevel): SentencePart[]
{
  return value.parts
    .filter((item) => !(item.kind === 'media' && level >= 1) && !(item.kind === 'size' && level >= 2))
    .map((item) => (level === 3 ? { ...item, text: item.short } : item))
}

/** The sentence a header of a given width shows: the first step whose text fits, else the last step. */
export function fitSentence(value: StateSentence, fits: (text: string) => boolean): { level: ShedLevel; parts: SentencePart[]; text: string }
{
  const steps = SHED_LEVELS.map((level) =>
  {
    const parts = shedSentence(value, level)
    return { level, parts, text: sentenceText(parts) }
  })
  return steps.find((step) => fits(step.text)) ?? steps[steps.length - 1]
}

/** The attention button: the batch's jobs that need attention, which it filters to and steps through. */
export interface AttentionButton
{
  runId: RunId
  count: number
  label: string
  tooltip: string
}

function attentionButton(facts: HeaderFacts, platform: Platform): AttentionButton | null
{
  const batch = facts.batch
  if (batch === null || batch.attention === 0)
  {
    return null
  }
  return { runId: batch.runId, count: batch.attention, label: needAttention(batch.attention), tooltip: needAttentionTooltip(batch.runId, platform) }
}

function attentionPart(facts: HeaderFacts): SentencePart[]
{
  const count = facts.batch?.attention ?? 0
  return count > 0 ? [part('attention', needAttention(count))] : []
}

function alertOf(alerts: readonly RunAlert[], kind: RunAlert['kind']): RunAlert | null
{
  for (let index = alerts.length - 1; index >= 0; index -= 1)
  {
    if (alerts[index].kind === kind)
    {
      return alerts[index]
    }
  }
  return null
}

function pausedByApp(run: RunState, alerts: readonly RunAlert[], policy: BatchPolicy | null): string | null
{
  switch (run.pause?.reason)
  {
    case 'disk-space':
      return `Paused: ${alertOf(alerts, 'disk-space')?.volume ?? 'the disk'} is full`
    case 'destination-unavailable':
    {
      const alert = alertOf(alerts, 'destination-unavailable')
      const folder = alert?.path ?? alert?.volume ?? (policy?.destination.mode === 'folder' ? policy.destination.folder : 'the output folder')
      return `Paused: ${folder} is not available`
    }
    case 'ffmpeg-unavailable':
      return 'Paused: FFmpeg is not ready'
    case 'storage':
      return 'Paused: molexMedia cannot save its queue'
    default:
      return null
  }
}

function runLead(facts: HeaderFacts, batch: BatchFacts, run: RunState, alerts: readonly RunAlert[], policy: BatchPolicy | null): SentencePart
{
  const appReason = pausedByApp(run, alerts, policy)
  if (appReason !== null && (facts.status === 'pausing' || facts.status === 'paused'))
  {
    return part('lead', appReason, appReason, 'warning')
  }
  switch (facts.status)
  {
    case 'pausing':
      return part('lead', `Pausing${PART_SEPARATOR}${countOf(batch.active, 'job')} finishing ${verbFor(batch.active, 'its', 'their')} current encode`)
    case 'paused':
      return part('lead', `Paused${PART_SEPARATOR}${countOf(batch.queued, 'job')} waiting`)
    case 'canceling':
      return part('lead', `Canceling${PART_SEPARATOR}stopping ${countOf(batch.active, 'job')}`)
    default:
      return part('lead', finishedOf(batch.settled, batch.total))
  }
}

function waitingParts(facts: HeaderFacts, view: HeaderView): SentencePart[]
{
  const { pending } = facts
  if (pending.probing > 0)
  {
    return [part('lead', `Probing ${formatCount(pending.jobs - pending.probing)} of ${countOf(pending.jobs, 'file')}`)]
  }
  const counts = view.review?.counts ?? null
  if (view.mode === 'review' && counts !== null)
  {
    return [part('lead', `${formatCount(counts.ready)} of ${countOf(counts.jobs, 'job')} can run`)]
  }
  const parts = [part('lead', countOf(pending.jobs, 'job'))]
  if (pending.bytes > 0)
  {
    parts.push(part('size', formatBytes(pending.bytes)))
  }
  if (pending.mediaSec > 0)
  {
    parts.push(part('media', `${formatDuration(pending.mediaSec)} of media`))
  }
  if (pending.blocked > 0)
  {
    parts.push(part('blocked', `${formatCount(pending.blocked)} blocked`))
  }
  if (pending.withWarnings > 0)
  {
    parts.push(part('warnings', `${formatCount(pending.withWarnings)} with warnings`, `${formatCount(pending.withWarnings)} warnings`))
  }
  if (facts.queueFull)
  {
    parts.push(part('queue-full', 'queue full'))
  }
  return parts
}

function summaryOf(batch: BatchFacts, view: HeaderView): BatchSummary | null
{
  const summary = view.summary ?? null
  return summary !== null && summary.runId === batch.runId ? summary : null
}

function elapsedOf(batch: BatchFacts, summary: BatchSummary | null): number | null
{
  if (summary !== null)
  {
    return summary.elapsedMs
  }
  return batch.startedAt !== null && batch.endedAt !== null ? batch.endedAt - batch.startedAt : null
}

function finishedLead(batch: BatchFacts, view: HeaderView): SentencePart
{
  const summary = summaryOf(batch, view)
  const elapsed = elapsedOf(batch, summary)
  const canceled = summary !== null ? summary.endedBy === 'canceled' : batch.canceledByRun > 0
  if (canceled)
  {
    const verified = summary?.counts.verified ?? batch.done
    const stopped = summary?.counts.canceled ?? batch.canceled
    const after = elapsed === null ? 'Canceled' : `Canceled after ${formatElapsed(elapsed)}`
    return part('lead', `${after}${PART_SEPARATOR}${formatCount(verified)} verified${PART_SEPARATOR}${formatCount(stopped)} canceled`)
  }
  return part('lead', elapsed === null ? 'Finished' : `Finished in ${formatElapsed(elapsed)}`)
}

/** What the header describes, which decides the title and the sentence. */
export type HeaderSubject = 'run' | 'starting' | 'scanning' | 'empty' | 'waiting' | 'finished' | 'jobs'

/** The subject of the header at this moment. */
export function headerSubject(facts: HeaderFacts, view: HeaderView): HeaderSubject
{
  if (facts.status !== 'idle' && facts.batch !== null)
  {
    return 'run'
  }
  if (view.starting === true)
  {
    return 'starting'
  }
  if (facts.scan !== null)
  {
    return 'scanning'
  }
  if (facts.jobCount === 0)
  {
    return 'empty'
  }
  if (facts.pending.jobs > 0)
  {
    return 'waiting'
  }
  return facts.batch !== null ? 'finished' : 'jobs'
}

/** The state sentence for the header's subject. */
export function stateSentence(facts: HeaderFacts, view: HeaderView, run: RunState | null, alerts: readonly RunAlert[] = [], policy: BatchPolicy | null = null): StateSentence
{
  const subject = headerSubject(facts, view)
  const batch = facts.batch as BatchFacts
  switch (subject)
  {
    case 'run':
    {
      const parts = [runLead(facts, batch, run as RunState, alerts, policy)]
      const runnable = newJobsWaiting(facts)
      if (facts.status === 'running' && runnable > 0)
      {
        parts.push(part('new-jobs', `${countOf(runnable, 'new job')} waiting`))
      }
      return sentence([...parts, ...attentionPart(facts)])
    }
    case 'starting':
      return sentence([part('lead', 'Starting')])
    case 'scanning':
    {
      const scan = facts.scan as ScanState
      return sentence([part('lead', `Scanning ${scan.root}${PART_SEPARATOR}${countOf(scan.added, 'file')} found`)])
    }
    case 'empty':
      return sentence([part('lead', 'No jobs yet')])
    case 'waiting':
      return sentence([...waitingParts(facts, view), ...attentionPart(facts)])
    case 'finished':
      return sentence([finishedLead(batch, view), ...attentionPart(facts)])
    default:
      return sentence([part('lead', countOf(facts.jobCount, 'job'))])
  }
}

/** The page title: "Batch 31" while the header describes that batch, else "Batch". */
export function headerTitle(facts: HeaderFacts, view: HeaderView): string
{
  const subject = headerSubject(facts, view)
  return (subject === 'run' || subject === 'finished') && facts.batch !== null ? pageTitle(facts.batch.runId) : PAGE_NAME
}

/** The run controls beside the action slot: Pause with Pause now in its menu, and Cancel run. */
export interface RunControls
{
  pause: { label: string; tooltip: string } | null
  pauseNow: { label: string; tooltip: string; running: number } | null
  cancel: { label: string; tooltip: string }
}

/** The run controls of this moment; null when no batch can be paused or canceled. */
export function runControls(facts: HeaderFacts, run: RunState | null, platform: Platform): RunControls | null
{
  const status = facts.status
  if (facts.batch === null || (status !== 'running' && status !== 'pausing' && status !== 'paused'))
  {
    return null
  }
  const running = facts.batch.active
  const canPauseNow = running > 0 && (status === 'running' || run?.pause?.mode === 'finish-running')
  return {
    pause: status === 'running' ? { label: ACTION_LABELS.pause, tooltip: pauseTooltip(platform) } : null,
    pauseNow: canPauseNow ? { label: pauseNowLabel(running), tooltip: HEADER_TOOLTIPS.pauseNow, running } : null,
    cancel: { label: ACTION_LABELS.cancelRun, tooltip: HEADER_TOOLTIPS.cancelRun }
  }
}

/** Row 2 of the header: the output policy before a run, the progress during one, what happened after one. */
export type ConsequenceLine =
  | { kind: 'policy'; text: string; warning: boolean }
  | { kind: 'progress'; percent: number; percentText: string; status: 'Paused' | null; timeLeft: string | null; throughput: string | null }
  | { kind: 'outcome'; text: string }

function conflictClause(policy: BatchPolicy, platform: Platform): string
{
  switch (policy.conflict)
  {
    case 'skip':
      return 'Skips the job if the name is taken'
    case 'overwrite':
      return policy.displaced === 'keep'
        ? 'Replaces an existing file after this output verifies; the old one stays as name (previous).ext'
        : `Replaces an existing file after this output verifies; the old one goes to ${binPhrase(platform)}`
    default:
      return 'Renames if the name is taken'
  }
}

/** The output policy as a sentence, as the header states it before a run. */
export function policySentence(policy: BatchPolicy, platform: Platform, extractJobs = 0): { text: string; warning: boolean }
{
  const destination = policy.destination
  if (destination.mode === 'replace-originals')
  {
    const fate = policy.displaced === 'keep'
      ? 'Replaces originals: each output is verified, then takes its original\'s place; originals stay as name (original).ext. Ends with this batch.'
      : `Replaces originals: each output is verified, then its original goes to ${binPhrase(platform)}. Ends with this batch.`
    return { text: extractJobs > 0 ? `${fate} Extract jobs write beside their sources.` : fate, warning: true }
  }
  const where = destination.mode === 'folder' ? `Writes to ${destination.folder}` : 'Writes next to each source'
  return { text: [`${where} as ${policy.template}`, conflictClause(policy, platform), 'Originals are not touched'].join(PART_SEPARATOR), warning: false }
}

function progressLine(facts: HeaderFacts, run: RunState): ConsequenceLine
{
  const { progress } = run
  const moving = facts.status === 'running' || facts.status === 'pausing'
  let timeLeft: string | null = null
  if (moving)
  {
    timeLeft = progress.etaSec === null || progress.elapsedMs < 15_000 ? ESTIMATING_TIME_LEFT : formatTimeLeft(progress.etaSec)
  }
  return {
    kind: 'progress',
    percent: progress.percent,
    percentText: formatPercent(progress.percent),
    status: facts.status === 'paused' ? 'Paused' : null,
    timeLeft,
    throughput: moving && progress.mediaSecPerSec !== null ? formatThroughput(progress.mediaSecPerSec) : null
  }
}

function originalsFate(summary: BatchSummary, platform: Platform): string
{
  const { originals } = summary
  const fates = originals.volumes
    .filter((item) => item.trashed > 0)
    .map((item) => `${formatCount(item.trashed)} in ${binPhrase(platform, item.volume)}`)
  const listed = originals.volumes.reduce((sum, item) => sum + item.trashed, 0)
  if (originals.trashed > listed)
  {
    fates.push(`${formatCount(originals.trashed - listed)} in ${binPhrase(platform)}`)
  }
  if (originals.kept > 0)
  {
    fates.push(`${formatCount(originals.kept)} kept beside ${verbFor(originals.kept, 'its output', 'their outputs')}`)
  }
  return `Replaced ${countOf(originals.trashed + originals.kept, 'original')}: ${fates.join(', ')}`
}

/** What happened in a finished batch: when it started, where it wrote, and what happened to originals. */
export function outcomeSentence(summary: BatchSummary, platform: Platform): string
{
  const started = `Started ${formatTimeOfDay(summary.startedAt)}`
  const destination = summary.policy.destination
  if (destination.mode === 'replace-originals')
  {
    return `${started}${PART_SEPARATOR}${originalsFate(summary, platform)}`
  }
  const where = destination.mode === 'folder' ? `Wrote to ${destination.folder}` : 'Wrote next to each source'
  return [started, where, 'Originals not touched'].join(PART_SEPARATOR)
}

/** The consequence line of this moment; null before the policy is known and when nothing can be said. */
export function consequenceLine(
  facts: HeaderFacts,
  view: HeaderView,
  run: RunState | null,
  policy: BatchPolicy | null
): ConsequenceLine | null
{
  const subject = headerSubject(facts, view)
  if (subject === 'run')
  {
    return progressLine(facts, run as RunState)
  }
  if (subject === 'finished')
  {
    const batch = facts.batch as BatchFacts
    const summary = summaryOf(batch, view)
    if (summary !== null)
    {
      return { kind: 'outcome', text: outcomeSentence(summary, view.platform) }
    }
    return batch.startedAt === null ? null : { kind: 'outcome', text: `Started ${formatTimeOfDay(batch.startedAt)}` }
  }
  if (policy === null)
  {
    return null
  }
  return { kind: 'policy', ...policySentence(policy, view.platform, facts.pendingExtract) }
}

/** The Output button: locked while the batch has queued or running jobs. */
export interface OutputButton
{
  label: string
  tooltip: string
  locked: boolean
}

/** The Output button of this moment. */
export function outputButton(facts: HeaderFacts): OutputButton
{
  const batch = facts.batch
  const locked = facts.status !== 'idle' && batch !== null && batch.queued + batch.active > 0
  const finishing = locked && batch.queued === 0
  return {
    label: 'Output',
    tooltip: finishing
      ? `Output unlocks when ${countOf(batch.active, 'running job')} ${verbFor(batch.active, 'finishes', 'finish')}.`
      : HEADER_TOOLTIPS.output,
    locked
  }
}

/** The Workers button: its full label and the bare word narrow headers use. */
export interface WorkersButton
{
  label: string
  shortLabel: string
  tooltip: string
}

/** "16 workers · GPU when allowed", "16 workers · GPU off", "16 workers"; during a run "16 workers · 6 active". */
export function workersButton(run: RunState | null, policy: BatchPolicy | null, capabilities: CapabilitySummary | null): WorkersButton
{
  const base = { shortLabel: 'Workers', tooltip: HEADER_TOOLTIPS.workers }
  if (run === null)
  {
    return { ...base, label: 'Workers' }
  }
  const workers = countOf(run.workers.limits.total, 'worker')
  if (run.status !== 'idle')
  {
    return { ...base, label: `${workers}${PART_SEPARATOR}${formatCount(run.workers.active.total)} active` }
  }
  const gpu = capabilities !== null && capabilities.gpu.status === 'ready' && capabilities.gpu.encoders.length > 0
  if (!gpu)
  {
    return { ...base, label: workers }
  }
  return { ...base, label: `${workers}${PART_SEPARATOR}${policy?.gpu === 'off' ? 'GPU off' : 'GPU when allowed'}` }
}

/** Everything the run header shows. */
export interface HeaderModel
{
  title: string
  subject: HeaderSubject
  sentence: StateSentence
  attention: AttentionButton | null
  /** The one next action by the precedence, possibly disabled. */
  action: HeaderAction | null
  /** What the action slot shows. */
  slot: HeaderAction | null
  /** Where the primary is: the action slot, the empty state's Add files, or nowhere. */
  primary: 'slot' | 'empty-state' | null
  controls: RunControls | null
  consequence: ConsequenceLine | null
  output: OutputButton
  workers: WorkersButton
}

/** Derives the run header from the jobs store and the view. */
export function deriveHeader(state: JobsState, view: HeaderView): HeaderModel
{
  const facts = selectHeaderFacts(state)
  const action = nextAction(facts, view, state.preflight, (state.run?.needsAck ?? null) !== null)
  const slot = slotAction(facts, action)
  let primary: HeaderModel['primary'] = null
  if (action !== null && action.enabled)
  {
    primary = action.place === 'header' ? 'slot' : 'empty-state'
  }
  return {
    title: headerTitle(facts, view),
    subject: headerSubject(facts, view),
    sentence: stateSentence(facts, view, state.run, state.alerts, state.policy),
    attention: attentionButton(facts, view.platform),
    action,
    slot,
    primary,
    controls: runControls(facts, state.run, view.platform),
    consequence: consequenceLine(facts, view, state.run, state.policy),
    output: outputButton(facts),
    workers: workersButton(state.run, state.policy, state.capabilities)
  }
}
