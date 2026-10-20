import React, { useId, useState } from 'react'
import type { StreamMeasurement } from '../../../../../shared/audio/events'
import { codecLabel, formatNumber, type MessageKey, type MessageRef } from '../../../../../shared/audio/messages'
import type { GainPlan, LoudnessUnit, MediaFacts } from '../../../../../shared/audio/types'
import { containerLabel } from '../../../../../shared/jobs/describe'
import type { JobId } from '../../../../../shared/jobs/ids'
import type
{
  BatchPolicy,
  JobDetail,
  JobPlan,
  JobResult,
  JobView,
  PlanFix,
  PlanIssue,
  PlanIssueCode,
  PreflightReport
} from '../../../../../shared/jobs/types'
import { binPhrase, type Platform } from '../../../../../shared/text/platform'
import { countOf, formatBytes, formatTruePeak, PART_SEPARATOR, screenMessage, verbFor } from '../../../copy/batch'
import { Button, CapsText, cx, Icon, usePlatform, VisuallyHidden, type IconName } from '../../../ui'
import { CommandBlock } from './CommandBlock'
import { languageName, StreamList, streamLines } from './StreamList'

/** One job's entry in a preflight report: its status, plan, and issues. */
export type PlanEntry = PreflightReport['jobs'][number]

/** The Plan tab's fixed words. */
export const PLAN_WORDS =
{
  probing: 'Probing. The output preview appears when ffprobe finishes.',
  noFile: 'No file there now.',
  written: 'Written by this job.',
  notTouched: 'Not touched.',
  extractStays: 'Stays. Extract jobs never replace originals; this one writes beside it.',
  measuredAtRun: 'Measured when the job runs.',
  measureNow: 'Measure now',
  measuring: 'Measuring loudness',
  noIssues: 'No issues.',
  showCommand: 'Show planned FFmpeg command',
  hideCommand: 'Hide command',
  commandLabel: 'Planned FFmpeg command',
  select: 'Select'
} as const

/** The section captions of the Plan tab, in reading order. */
export const PLAN_CAPTIONS =
{
  output: 'Output',
  original: 'Original',
  originals: 'Originals',
  container: 'Container',
  kept: 'Streams kept',
  notKept: 'Not kept',
  encoder: 'Encoder',
  ceiling: 'Ceiling',
  loudness: 'Loudness',
  issues: 'Issues'
} as const

/** How many issue groups show before "Show {n} more issues". */
export const ISSUE_GROUPS_SHOWN = 3

function baseName(path: string): string
{
  return path.split(/[\\/]/).at(-1) ?? path
}

/** A file name's stem and extension, without the dot; the extension is '' when there is none. */
export function splitName(name: string): { stem: string; ext: string }
{
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, dot), ext: name.slice(dot + 1) }
}

function keptName(path: string, marker: 'original' | 'previous'): string
{
  const { stem, ext } = splitName(baseName(path))
  return ext === '' ? `${stem} (${marker})` : `${stem} (${marker}).${ext}`
}

function capitalize(text: string): string
{
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/** What is at the output path now and what the job does about it; null when the output replaces the original itself. */
export function outputNowText(output: JobPlan['output'], policy: BatchPolicy, platform: Platform): string | null
{
  switch (output.resolution)
  {
    case 'replace-original':
      return null
    case 'rename':
      return `A file with this name exists; this job writes ${baseName(output.renamedTo ?? output.finalPath)}.`
    case 'skip':
      return 'A file with this name exists; this job will skip.'
    case 'overwrite':
      return policy.displaced === 'keep'
        ? `A file with this name exists; it stays as ${keptName(output.displaces ?? output.finalPath, 'previous')} after this output verifies.`
        : `A file with this name exists; it goes to ${binPhrase(platform)} after this output verifies.`
    default:
      return PLAN_WORDS.noFile
  }
}

/**
 * What a finished job left at its output path, from the placement its result records. The plan's words describe the
 * path before the run, so once the job placed its output they no longer hold.
 */
export function outputDoneText(result: Pick<JobResult, 'placement'>, platform: Platform): string
{
  const placement = result.placement
  switch (placement.kind)
  {
    case 'renamed':
      return `Written by this job; ${baseName(placement.planned)} was taken, so it got this name.`
    case 'overwrote':
      return placement.previous.status === 'trashed'
        ? `Written by this job; the file it replaced went to ${binPhrase(platform)}.`
        : `Written by this job; the file it replaced stays as ${baseName(placement.previous.path)}.`
    case 'replaced-original':
      return 'Written by this job in place of the original.'
    default:
      return PLAN_WORDS.written
  }
}

/** What happened to a finished job's original when its output replaced it; null when the output went beside it. */
export function originalDoneText(result: Pick<JobResult, 'placement'>, platform: Platform): string | null
{
  const placement = result.placement
  if (placement.kind !== 'replaced-original')
  {
    return null
  }
  return placement.original.status === 'trashed'
    ? `Went to ${binPhrase(platform)} after the output verified.`
    : `Kept as ${baseName(placement.original.path)}.`
}

/** What happens to the job's original. */
export function originalText(plan: JobPlan, issues: readonly PlanIssue[], policy: BatchPolicy, platform: Platform): string
{
  if (issues.some((issue) => issue.code === 'extract-never-replaces'))
  {
    return PLAN_WORDS.extractStays
  }
  if (plan.output.resolution !== 'replace-original')
  {
    return PLAN_WORDS.notTouched
  }
  const kept = keptName(plan.source.path, 'original')
  return policy.displaced === 'keep'
    ? `Renamed to ${kept} after the output verifies; nothing goes to ${binPhrase(platform)}.`
    : `Goes to ${binPhrase(platform)} after the output verifies. If the bin refuses it, it stays here as ${kept}.`
}

/** The output container, and the source's when they differ: "MP4, from MKV". */
export function containerText(plan: JobPlan, sourceContainer: string | null): string
{
  const output = containerLabel(plan.output.container)
  if (sourceContainer === null || sourceContainer === '' || sourceContainer === plan.output.container)
  {
    return output
  }
  return `${output}, from ${containerLabel(sourceContainer)}`
}

function bitrate(kbps: number | null): string
{
  return kbps === null ? '' : ` ${kbps} kb/s`
}

/** The video encode as it runs: encoder, passes, and where. */
export function videoEncoderText(video: Pick<NonNullable<JobPlan['video']>, 'encoder' | 'passes' | 'gpu'>): string
{
  const passes = video.passes === 2 ? ', two-pass' : ''
  const where = video.gpu === null ? 'CPU' : `GPU (${video.gpu})`
  return `${video.encoder}${passes}, ${where}`
}

/** One planned audio stream's encode: "Audio 1: AAC 256 kb/s", or "copied" for a stream copy. */
export function audioEncoderText(stream: JobPlan['audio'][number]): string
{
  const encode = stream.encoder === 'copy' ? 'copied' : `${codecLabel(stream.encoder)}${bitrate(stream.bitrateKbps)}`
  return `Audio ${stream.audioIndex + 1}: ${encode}`
}

/** The ceiling of one planned audio stream with its basis, and the level the limiter aims for. */
export function ceilingText(stream: JobPlan['audio'][number]): { value: string; basis: string }
{
  const { ceiling } = stream
  const codec = codecLabel(stream.encoder)
  const value = `Audio ${stream.audioIndex + 1}: ${formatTruePeak(ceiling.ceilingDbtp)} for ${codec}${bitrate(stream.bitrateKbps).replace(' ', ' at ')}`
  const limiter = `The limiter targets ${formatTruePeak(ceiling.limiterCeilingDbtp)}.`
  const codecSets = ceiling.codecCeilingDbtp !== null && ceiling.codecCeilingDbtp < ceiling.presetMaxDbtp
  const basis = codecSets
    ? `This app's measured ceiling for ${codec}; the preset allows ${formatTruePeak(ceiling.presetMaxDbtp)}. ${limiter}`
    : `The preset's maximum true peak. ${limiter}`
  return { value, basis }
}

/** The page's label of a fix, with its scope: the jobs it changes, or "for this batch". */
export function fixLabel(fix: PlanFix, count: number): string
{
  const jobs = `for ${countOf(count, 'job')}`
  switch (fix.kind)
  {
    case 'set-conflict-rule':
      return `Use ${capitalize(fix.rule)} for this batch`
    case 'add-token':
      return `Add ${fix.token} to file names`
    case 'set-gpu':
      return fix.gpu === 'off' ? 'Turn off GPU encoding for this batch' : `Set GPU encoding to ${capitalize(fix.gpu)} for this batch`
    case 'set-displaced':
      return 'Keep old files beside the new ones for this batch'
    case 'set-destination':
      return 'Write next to each source instead'
    case 'set-container':
      return fix.container === 'mka' ? `Keep all tracks as .mka ${jobs}` : `Write ${containerLabel(fix.container)} instead ${jobs}`
    case 'patch-recipe':
      return `${fix.label} ${jobs}`
    default:
      return 'Remove from queue'
  }
}

/** The page actions an issue offers beside main's fix. */
export type IssueAction = 'locate' | 'probe-again' | 'show-log' | 'change-output' | 'change-file-name' | 'choose-replace' | 'open-settings' | 'select-album'

/** The label of each issue action. */
export const ISSUE_ACTION_LABELS: Readonly<Record<IssueAction, string>> =
{
  'locate': 'Locate…',
  'probe-again': 'Probe again',
  'show-log': 'Show log',
  'change-output': 'Change output',
  'change-file-name': 'Change file name',
  'choose-replace': 'Choose Replace originals',
  'open-settings': 'Open Settings',
  'select-album': 'Select the whole album'
}

const ISSUE_ACTIONS: Partial<Readonly<Record<PlanIssueCode, readonly IssueAction[]>>> =
{
  'source-missing': ['locate'],
  'source-unreadable': ['probe-again'],
  'source-changed': ['probe-again'],
  'probe-failed': ['probe-again', 'show-log'],
  'destination-invalid': ['change-output'],
  'destination-not-writable': ['change-output'],
  'disk-tight': ['change-output'],
  'disk-insufficient': ['change-output'],
  'template-unknown-token': ['change-file-name'],
  'template-empty': ['change-file-name'],
  'template-escapes': ['change-file-name'],
  'same-as-source': ['change-file-name', 'choose-replace'],
  'ffmpeg-unavailable': ['open-settings'],
  'ffmpeg-below-minimum': ['open-settings'],
  'self-test-failed': ['open-settings'],
  'album-incomplete': ['select-album']
}

/** The page actions of one issue, in button order. */
export function issueActions(code: PlanIssueCode): readonly IssueAction[]
{
  return ISSUE_ACTIONS[code] ?? []
}

const SEVERITY_ORDER: Readonly<Record<PlanIssue['severity'], number>> = { error: 0, warning: 1, info: 2 }

/** Issues blocking first, then warnings, then notes, otherwise in main's order. */
export function sortIssues<T extends { severity: PlanIssue['severity'] }>(issues: readonly T[]): T[]
{
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] || a.index - b.index)
    .map(({ issue }) => issue)
}

/** Whether a recipe's plan depends on a loudness measurement. */
export function isLoudnessJob(view: Pick<JobView, 'recipe'>): boolean
{
  return view.recipe.kind === 'normalize' || view.recipe.kind === 'boost'
}

/** The "Measured" sentence of one stream; null when the stream has no level to state. */
export function measuredRef(measurement: StreamMeasurement, unit: LoudnessUnit): MessageRef | null
{
  const { stats } = measurement
  if (stats.status !== 'measured')
  {
    return null
  }
  const key: MessageKey = stats.lraStatus === 'measured' ? 'measured' : 'measured-short'
  return { key, params: { I: stats.integratedLufs, LRA: stats.loudnessRangeLu, TP: stats.truePeakDbtp, unit } }
}

const PASSTHROUGH_KEYS: Readonly<Record<string, MessageKey>> = { 'silent': 'silent', 'too-short': 'too-short', 'below-floor': 'below-floor' }

/** The "Plan" sentence of one stream's gain plan, from the audio sentences; null for a plan with no sentence. */
export function planRef(plan: GainPlan, codec: string, unit: LoudnessUnit, operation: 'normalize' | 'boost'): MessageRef | null
{
  if (plan.mode === 'passthrough')
  {
    const key = PASSTHROUGH_KEYS[plan.reason]
    return key === undefined ? null : { key, params: {} }
  }
  const ceiling = plan.ceiling.ceilingDbtp
  if (operation === 'boost' && plan.gainDb < plan.requestedGainDb)
  {
    const needed = plan.headroomDb === null ? plan.limitingDb : Math.max(0, plan.requestedGainDb - plan.headroomDb)
    return { key: 'boost-reduced', params: { X: plan.gainDb, R: plan.requestedGainDb, Z: needed, N: plan.maxLimitingDb } }
  }
  if (operation === 'normalize' && plan.reason === 'short-term-capped')
  {
    return { key: 'plan-short-term', params: { T: plan.targetLufs, G: plan.requestedGainDb, limit: plan.shortTermLimitLufs, Y: plan.predictedLufs, unit } }
  }
  if (operation === 'normalize' && plan.mode === 'reachable-linear')
  {
    const needed = plan.headroomDb === null ? null : Math.max(0, plan.requestedGainDb - plan.headroomDb)
    return { key: 'plan-reachable', params: { T: plan.targetLufs, G: plan.requestedGainDb, H: plan.headroomDb, Y: plan.predictedLufs, Z: needed, unit } }
  }
  if (operation === 'normalize' && plan.mode === 'reachable-limited')
  {
    return { key: 'plan-capped', params: { T: plan.targetLufs, G: plan.requestedGainDb, N: plan.maxLimitingDb, Y: plan.predictedLufs, unit } }
  }
  if (plan.limitingDb > 0)
  {
    return { key: 'plan-limited', params: { G: plan.gainDb, Z: plan.limitingDb, C: ceiling, codec } }
  }
  return { key: 'plan-linear', params: { G: plan.gainDb, P: plan.predictedTruePeakDbtp, C: ceiling, codec } }
}

/** The center-channel sentence of a cinematic stream; null without a center-channel estimate. */
export function dialogueRef(measurement: StreamMeasurement, unit: LoudnessUnit): MessageRef | null
{
  const { dialogueLufs } = measurement.stats
  if (dialogueLufs === null || measurement.loudnessToDialogueLu === null)
  {
    return null
  }
  return { key: 'dialogue', params: { DL: dialogueLufs, LDR: measurement.loudnessToDialogueLu, unit } }
}

const STREAM_SENTENCE_KEYS: ReadonlySet<MessageKey> = new Set<MessageKey>([
  'measured', 'measured-short', 'silent', 'too-short', 'below-floor', 'dialogue',
  'plan-linear', 'plan-limited', 'plan-reachable', 'plan-capped', 'plan-short-term', 'boost-reduced'
])

/** The measurement's sentences that are not one stream's measured, plan, or center-channel line. */
export function jobNotes(messages: readonly MessageRef[]): MessageRef[]
{
  return messages.filter((ref) => !STREAM_SENTENCE_KEYS.has(ref.key))
}

const GAIN_PLACEHOLDER = /^[<{]gain(?:-a(\d+))?[>}]$/

/** A gain in the form FFmpeg's volume filter reads, with the ASCII minus the command line needs. */
function commandGain(db: number): string
{
  return formatNumber(db, 'amount', 'hyphen')
}

/**
 * The planned argument list, program first, with each gain placeholder filled once its stream is measured
 * ({gain} for a single stream, {gain-a0} for audio stream 0), and the placeholders still open.
 */
export function plannedCommand(
  command: NonNullable<JobPlan['command']>,
  plans: ReadonlyArray<GainPlan | null>
): { argv: string[]; placeholders: string[] }
{
  const gains = new Map<string, string>()
  for (const token of command.placeholders)
  {
    const match = GAIN_PLACEHOLDER.exec(token)
    if (match === null)
    {
      continue
    }
    const audioIndex = match[1] === undefined ? null : Number(match[1])
    const plan = audioIndex === null
      ? (plans.length === 1 ? plans[0] : null)
      : plans.find((candidate) => candidate?.audioIndex === audioIndex) ?? null
    if (plan !== null && plan.mode !== 'passthrough')
    {
      gains.set(token, commandGain(plan.gainDb))
    }
  }
  const fill = (arg: string): string => [...gains].reduce((text, [token, value]) => text.split(token).join(value), arg)
  const program = /(^|[\\/])ffmpeg(\.exe)?$/i.test(command.argv[0] ?? '') ? [] : ['ffmpeg']
  return {
    argv: [...program, ...command.argv.map(fill)],
    placeholders: command.placeholders.filter((token) => !gains.has(token))
  }
}

/** The heading of a stream's loudness block: "Audio 1 · English · 5.1(side) · AC-3 448 kb/s". */
export function streamHeading(audioIndex: number, media: MediaFacts | null): string
{
  const facts = media?.audio.find((stream) => stream.audioIndex === audioIndex)
  if (facts === undefined)
  {
    return `Audio ${audioIndex + 1}`
  }
  const rate = facts.bitRate === null ? '' : ` ${Math.round(facts.bitRate / 1000)} kb/s`
  return [`Audio ${audioIndex + 1}`, languageName(facts.language), facts.layout, `${codecLabel(facts.codecName)}${rate}`]
    .filter((part): part is string => part !== null && part !== '')
    .join(PART_SEPARATOR)
}

/** One stream's loudness lines, rendered for the screen. */
export interface StreamLoudness
{
  audioIndex: number
  heading: string
  measured: string | null
  plan: string[]
}

/** Each measured stream's heading, Measured line, and Plan lines, with the stream's static plan sentences after them. */
export function loudnessBlocks(detail: Pick<JobDetail, 'view' | 'plan' | 'media' | 'measurement'>): StreamLoudness[]
{
  const { measurement, plan, view } = detail
  if (measurement === null || !isLoudnessJob(view))
  {
    return []
  }
  const operation = view.recipe.kind === 'boost' ? 'boost' : 'normalize'
  return measurement.streams.map(({ measurement: stream, plan: gain }) =>
  {
    const audioIndex = stream.audioIndex
    const unit = view.audioPlan?.find((cell) => cell.audioIndex === audioIndex)?.unit ?? 'LUFS'
    const output = plan?.audio.find((candidate) => candidate.audioIndex === audioIndex)
    const codec = output?.encoder ?? ''
    const refs = [
      gain === null ? null : planRef(gain, codec, unit, operation),
      dialogueRef(stream, unit),
      ...(output?.messages ?? [])
    ]
    const measured = measuredRef(stream, unit)
    return {
      audioIndex,
      heading: streamHeading(audioIndex, detail.media),
      measured: measured === null ? null : screenMessage(measured),
      plan: refs.filter((ref): ref is MessageRef => ref !== null).map(screenMessage)
    }
  })
}

const SEVERITY_ICONS: Readonly<Record<PlanIssue['severity'], { icon: IconName; ink: string; word: string }>> =
{
  error: { icon: 'status.failed', ink: 'text-error', word: 'Blocking' },
  warning: { icon: 'status.warning', ink: 'text-warning', word: 'Warning' },
  info: { icon: 'action.info', ink: 'text-ink-3', word: 'Note' }
}

interface PlanSectionProps
{
  caption: string
  children: React.ReactNode
}

function PlanSection({ caption, children }: PlanSectionProps): React.JSX.Element
{
  const id = useId()
  return (
    <section aria-labelledby={id} className='flex flex-col gap-1.5'>
      <h3 id={id} className='type-legend text-brass'>
        <CapsText>{caption}</CapsText>
      </h3>
      {children}
    </section>
  )
}

/** What the issue buttons do; each handler receives the jobs the issue applies to. */
export interface PlanIssueHandlers
{
  /** Applies main's fix to the jobs; the page re-plans them and records the change for Undo. */
  onFix?: (fix: PlanFix, jobIds: readonly JobId[], issue: PlanIssue) => void
  /** Runs a page action such as Locate or Change output. */
  onAction?: (action: IssueAction, jobIds: readonly JobId[], issue: PlanIssue) => void
  /** Selects exactly these jobs and focuses the first. */
  onSelect?: (jobIds: readonly JobId[]) => void
}

/** Issues grouped by their exact reason, for one job or a selection. */
export interface IssueGroup
{
  key: string
  issue: PlanIssue
  jobIds: JobId[]
}

interface IssueLineProps extends PlanIssueHandlers
{
  group: IssueGroup
  /** Shows the count and "Select" for a selection. */
  several: boolean
}

function IssueLine({ group, several, onFix, onAction, onSelect }: IssueLineProps): React.JSX.Element
{
  const { issue, jobIds } = group
  const severity = SEVERITY_ICONS[issue.severity]
  const actions = onAction === undefined ? [] : issueActions(issue.code)
  const hasButtons = (issue.fix !== null && onFix !== undefined) || actions.length > 0 || (several && onSelect !== undefined)
  return (
    <li data-severity={issue.severity} className='flex flex-col gap-1.5'>
      <p className='flex items-start gap-1.5 text-label text-ink'>
        <span className={cx('mt-0.5 shrink-0', severity.ink)}>
          <Icon name={severity.icon} size='sm' />
        </span>
        <span className='min-w-0 select-text wrap-anywhere'>
          <VisuallyHidden>{`${severity.word}: `}</VisuallyHidden>
          {issue.message}
          {several && <span className='tabular-nums text-ink-3'>{`${PART_SEPARATOR}${countOf(jobIds.length, 'job')}`}</span>}
        </span>
      </p>
      {hasButtons && (
        <div className='flex flex-wrap gap-1.5 pl-5'>
          {issue.fix !== null && onFix !== undefined && (
            <Button variant='secondary' size='sm' onClick={() => onFix(issue.fix as PlanFix, jobIds, issue)}>
              {fixLabel(issue.fix, jobIds.length)}
            </Button>
          )}
          {actions.map((action) => (
            <Button key={action} variant='secondary' size='sm' onClick={() => onAction?.(action, jobIds, issue)}>
              {ISSUE_ACTION_LABELS[action]}
            </Button>
          ))}
          {several && onSelect !== undefined && (
            <Button variant='ghost' size='sm' onClick={() => onSelect(jobIds)}>{PLAN_WORDS.select}</Button>
          )}
        </div>
      )}
    </li>
  )
}

interface IssueListProps extends PlanIssueHandlers
{
  groups: readonly IssueGroup[]
  several: boolean
}

function IssueList({ groups, several, ...handlers }: IssueListProps): React.JSX.Element
{
  const [expanded, setExpanded] = useState(false)
  if (groups.length === 0)
  {
    return <p className='text-label text-ink-2'>{PLAN_WORDS.noIssues}</p>
  }
  const hidden = groups.length - ISSUE_GROUPS_SHOWN
  const shown = expanded || hidden <= 0 ? groups : groups.slice(0, ISSUE_GROUPS_SHOWN)
  return (
    <>
      <ul className='flex flex-col gap-2.5'>
        {shown.map((group) => <IssueLine key={group.key} group={group} several={several} {...handlers} />)}
      </ul>
      {hidden > 0 && (
        <Button variant='ghost' size='sm' aria-expanded={expanded} className='self-start' onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer issues' : `Show ${countOf(hidden, 'more issue', 'more issues')}`}
        </Button>
      )}
    </>
  )
}

/** One group per distinct issue across the entries, blocking first, each with the jobs it applies to. */
export function issueGroups(entries: readonly PlanEntry[]): IssueGroup[]
{
  const groups = new Map<string, IssueGroup>()
  for (const entry of entries)
  {
    for (const issue of entry.issues)
    {
      const key = `${issue.severity}|${issue.code}|${issue.message}|${JSON.stringify(issue.fix)}`
      const group = groups.get(key)
      if (group === undefined)
      {
        groups.set(key, { key, issue, jobIds: [entry.jobId] })
      }
      else if (!group.jobIds.includes(entry.jobId))
      {
        group.jobIds.push(entry.jobId)
      }
    }
  }
  return sortIssues([...groups.values()].map((group) => ({ ...group, severity: group.issue.severity })))
    .map(({ key, issue, jobIds }) => ({ key, issue, jobIds }))
}

/** The selection's counts: "8 jobs: 5 ready, 2 with warnings, 1 blocked." */
export function selectionCounts(jobs: readonly JobView[], entries: readonly PlanEntry[]): string
{
  const byId = new Map(entries.map((entry) => [entry.jobId, entry]))
  let ready = 0
  let warnings = 0
  let blocked = 0
  let skipping = 0
  let probing = 0
  let unplanned = 0
  for (const job of jobs)
  {
    const entry = byId.get(job.id)
    if (job.probe === 'pending')
    {
      probing += 1
    }
    else if (entry === undefined)
    {
      unplanned += 1
    }
    else if (entry.status === 'blocked')
    {
      blocked += 1
    }
    else if (entry.status === 'will-skip')
    {
      skipping += 1
    }
    else if (entry.issues.some((issue) => issue.severity === 'warning'))
    {
      warnings += 1
    }
    else
    {
      ready += 1
    }
  }
  const parts = [`${ready} ready`, `${warnings} with warnings`, `${blocked} blocked`]
  if (skipping > 0)
  {
    parts.push(`${skipping} will skip`)
  }
  if (probing > 0)
  {
    parts.push(`${probing} probing`)
  }
  if (unplanned > 0)
  {
    parts.push(`${unplanned} not planned yet`)
  }
  return `${countOf(jobs.length, 'job')}: ${parts.join(', ')}.`
}

function runnable(entries: readonly PlanEntry[]): PlanEntry[]
{
  return entries.filter((entry) => entry.status === 'ready' && entry.plan !== null)
}

function sizeClause(entries: readonly PlanEntry[]): string
{
  const known = entries.filter((entry) => entry.plan?.estimate.outputBytes !== null)
  const unknown = entries.length - known.length
  const bytes = known.reduce((sum, entry) => sum + (entry.plan?.estimate.outputBytes ?? 0), 0)
  if (known.length === 0)
  {
    return 'size unknown'
  }
  const about = `about ${formatBytes(bytes)}`
  return unknown === 0 ? about : `${about}; size unknown for ${countOf(unknown, 'job')}`
}

/** Where the selection's runnable jobs write and about how much. */
export function destinationText(entries: readonly PlanEntry[], policy: BatchPolicy): string
{
  const writing = runnable(entries)
  if (writing.length === 0)
  {
    return 'Writes no new files.'
  }
  const files = countOf(writing.length, 'new file')
  const size = sizeClause(writing)
  switch (policy.destination.mode)
  {
    case 'folder':
      return `Writes ${files} to ${policy.destination.folder}, ${size}.`
    case 'next-to-source':
      return `Writes ${files} next to ${writing.length === 1 ? 'its source' : 'their sources'}, ${size}.`
    default:
    {
      const replacing = writing.filter((entry) => entry.plan?.output.resolution === 'replace-original')
      const beside = writing.length - replacing.length
      const head = replacing.length === 0 ? `Writes ${files} next to their sources, ${size}.` : `Replaces ${countOf(replacing.length, 'original')} in place, ${size}.`
      const extract = beside === 0 || replacing.length === 0 ? '' : ` ${countOf(beside, 'job')} ${verbFor(beside, 'writes', 'write')} beside ${beside === 1 ? 'its source' : 'their sources'}.`
      return `${head}${extract}`
    }
  }
}

/** What the selection does to originals and to files already at its output paths. */
export function originalsText(entries: readonly PlanEntry[], policy: BatchPolicy, platform: Platform): string[]
{
  const writing = runnable(entries)
  const originals = writing.filter((entry) => entry.plan?.output.resolution === 'replace-original').length
  const overwrites = writing.filter((entry) => entry.plan?.output.resolution === 'overwrite').length
  const renames = writing.filter((entry) => entry.plan?.output.resolution === 'rename').length
  const skips = entries.filter((entry) => entry.status === 'will-skip').length
  const bin = binPhrase(platform)
  const lines: string[] = []
  if (originals === 0)
  {
    lines.push(PLAN_WORDS.notTouched)
  }
  else if (policy.displaced === 'keep')
  {
    lines.push(`${countOf(originals, 'original')} ${verbFor(originals, 'is', 'are')} renamed to name (original).ext and replaced by ${originals === 1 ? 'its output' : 'their outputs'}.`)
  }
  else
  {
    lines.push(`${countOf(originals, 'original')} ${verbFor(originals, 'goes', 'go')} to ${bin} after ${originals === 1 ? 'its output verifies' : 'their outputs verify'}.`)
  }
  if (overwrites > 0)
  {
    lines.push(policy.displaced === 'keep'
      ? `Existing files: ${overwrites} ${verbFor(overwrites, 'stays', 'stay')} as name (previous).ext and ${verbFor(overwrites, 'is', 'are')} replaced.`
      : `Existing files: ${overwrites} ${verbFor(overwrites, 'goes', 'go')} to ${bin} and ${verbFor(overwrites, 'is', 'are')} replaced.`)
  }
  if (renames > 0)
  {
    lines.push(`Existing files: ${renames} kept; the new ${renames === 1 ? 'file is' : 'files are'} numbered (2).`)
  }
  if (skips > 0)
  {
    lines.push(`Existing files: ${skips} skipped; ${skips === 1 ? 'that job' : 'those jobs'} will not run.`)
  }
  return lines
}

function Lines({ lines, className }: { lines: readonly string[]; className?: string }): React.JSX.Element
{
  return (
    <>
      {lines.map((line, index) => <p key={index} className={cx('text-label text-ink', className)}>{line}</p>)}
    </>
  )
}

interface CommandDisclosureProps
{
  command: NonNullable<JobPlan['command']>
  plans: ReadonlyArray<GainPlan | null>
  platform: Platform
  onCopied?: (text: string) => void
}

function CommandDisclosure({ command, plans, platform, onCopied }: CommandDisclosureProps): React.JSX.Element
{
  const [open, setOpen] = useState(false)
  const id = useId()
  const planned = plannedCommand(command, plans)
  return (
    <div className='flex flex-col gap-2'>
      <Button
        variant='ghost'
        size='sm'
        icon={open ? 'action.collapse' : 'action.expand'}
        aria-expanded={open}
        aria-controls={id}
        className='self-start'
        onClick={() => setOpen(!open)}
      >
        {open ? PLAN_WORDS.hideCommand : PLAN_WORDS.showCommand}
      </Button>
      <div id={id} hidden={!open}>
        {open && (
          <CommandBlock
            label={PLAN_WORDS.commandLabel}
            argv={planned.argv}
            placeholders={planned.placeholders}
            state='planned'
            platform={platform}
            onCopied={onCopied}
          />
        )}
      </div>
    </div>
  )
}

interface LoudnessSectionProps
{
  detail: Pick<JobDetail, 'view' | 'plan' | 'media' | 'measurement'>
  onMeasureNow?: (jobId: JobId) => void
}

function LoudnessSection({ detail, onMeasureNow }: LoudnessSectionProps): React.JSX.Element
{
  const blocks = loudnessBlocks(detail)
  const notes = detail.measurement === null ? [] : jobNotes(detail.measurement.messages).map(screenMessage)
  if (blocks.length === 0)
  {
    const busy = detail.view.analysis !== null
    return (
      <div className='flex flex-col items-start gap-1.5'>
        <p className='text-label text-ink-2'>{PLAN_WORDS.measuredAtRun}</p>
        {onMeasureNow !== undefined && (
          <Button variant='secondary' size='sm' loading={busy} loadingLabel={PLAN_WORDS.measuring} onClick={() => onMeasureNow(detail.view.id)}>
            {PLAN_WORDS.measureNow}
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className='flex flex-col gap-3'>
      {blocks.map((block) => (
        <div key={block.audioIndex} className='flex flex-col gap-1'>
          <h4 className='text-label tabular-nums text-ink-2'>{block.heading}</h4>
          <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-label'>
            {block.measured !== null && (
              <div className='contents'>
                <dt className='text-ink-3'>Measured</dt>
                <dd className='text-ink'>{block.measured}</dd>
              </div>
            )}
            {block.plan.length > 0 && (
              <div className='contents'>
                <dt className='text-ink-3'>Planned</dt>
                <dd className='flex flex-col gap-1 text-ink'>
                  {block.plan.map((line, index) => <span key={index}>{line}</span>)}
                </dd>
              </div>
            )}
          </dl>
        </div>
      ))}
      {notes.length > 0 && <Lines lines={notes} className='text-ink-2' />}
    </div>
  )
}

/** What the Plan tab needs from its host beyond the jobs. */
export interface PlanTabHandlers extends PlanIssueHandlers
{
  /** Measures one job's loudness now, as an analysis-only job. */
  onMeasureNow?: (jobId: JobId) => void
  /** Runs after the command is copied, for the page's "Copied" toast. */
  onCopied?: (text: string) => void
}

type PlanDetail = Pick<JobDetail, 'view' | 'plan' | 'media' | 'measurement'> & { result?: JobDetail['result'] }

interface JobPlanViewProps extends PlanTabHandlers
{
  detail: PlanDetail
  entry: PlanEntry | null
  policy: BatchPolicy
  platform: Platform
}

function StreamSections({ plan, media }: { plan: JobPlan; media: MediaFacts | null }): React.JSX.Element
{
  const lines = streamLines(plan, media)
  return (
    <>
      {lines.kept.length > 0 && (
        <PlanSection caption={PLAN_CAPTIONS.kept}>
          <StreamList label={PLAN_CAPTIONS.kept} lines={lines.kept} />
        </PlanSection>
      )}
      {lines.dropped.length > 0 && (
        <PlanSection caption={PLAN_CAPTIONS.notKept}>
          <StreamList label={PLAN_CAPTIONS.notKept} lines={lines.dropped} />
        </PlanSection>
      )}
    </>
  )
}

function EncoderSection({ plan, loudness }: { plan: JobPlan; loudness: boolean }): React.JSX.Element | null
{
  if (plan.video === null && plan.audio.length === 0)
  {
    return null
  }
  return (
    <PlanSection caption={PLAN_CAPTIONS.encoder}>
      {plan.video !== null && (
        <>
          <p className='font-mono text-label text-ink'>{videoEncoderText(plan.video)}</p>
          <Lines lines={plan.video.notes} className='text-ink-2' />
          {plan.video.cpuFallback !== null && (
            <p className='text-label text-ink-2'>{`CPU fallback: ${videoEncoderText(plan.video.cpuFallback)}`}</p>
          )}
        </>
      )}
      {plan.audio.map((stream) => (
        <React.Fragment key={stream.audioIndex}>
          <p className='font-mono text-label text-ink'>{audioEncoderText(stream)}</p>
          {!loudness && <Lines lines={stream.messages.map(screenMessage)} className='text-ink-2' />}
        </React.Fragment>
      ))}
    </PlanSection>
  )
}

function CeilingSection({ plan }: { plan: JobPlan }): React.JSX.Element | null
{
  const encoded = plan.audio.filter((stream) => stream.encoder !== 'copy')
  if (encoded.length === 0)
  {
    return null
  }
  return (
    <PlanSection caption={PLAN_CAPTIONS.ceiling}>
      {encoded.map((stream) =>
      {
        const text = ceilingText(stream)
        return (
          <React.Fragment key={stream.audioIndex}>
            <p className='text-label text-ink'>{text.value}</p>
            <p className='text-label text-ink-2'>{text.basis}</p>
          </React.Fragment>
        )
      })}
    </PlanSection>
  )
}

function JobPlanView({ detail, entry, policy, platform, onMeasureNow, onCopied, ...handlers }: JobPlanViewProps): React.JSX.Element
{
  const { view } = detail
  if (view.probe === 'pending')
  {
    return <p className='text-label text-ink-2'>{PLAN_WORDS.probing}</p>
  }
  const plan = entry?.plan ?? detail.plan
  const issues = sortIssues(entry?.issues ?? [])
  const groups = issues.map((issue, index) => ({ key: `${index}-${issue.code}`, issue, jobIds: [view.id] }))
  const loudness = isLoudnessJob(view)
  const gains = detail.measurement?.streams.map((stream) => stream.plan) ?? []
  const sourceContainer = detail.media?.container ?? view.media?.container ?? view.source.ext
  const result = detail.result ?? null
  const now = result !== null ? outputDoneText(result, platform) : plan === null ? null : outputNowText(plan.output, policy, platform)
  return (
    <>
      {plan !== null && (
        <>
          <PlanSection caption={PLAN_CAPTIONS.output}>
            <p className='text-label text-ink wrap-anywhere select-text'>{result?.outputPath ?? plan.output.finalPath}</p>
            {now !== null && <p className='text-label text-ink-2'>{now}</p>}
          </PlanSection>
          <PlanSection caption={PLAN_CAPTIONS.original}>
            <p className='text-label text-ink'>{(result === null ? null : originalDoneText(result, platform)) ?? originalText(plan, issues, policy, platform)}</p>
          </PlanSection>
          <PlanSection caption={PLAN_CAPTIONS.container}>
            <p className='text-label text-ink'>{containerText(plan, sourceContainer)}</p>
            {plan.output.containerChanged !== null && <p className='text-label text-ink-2'>{plan.output.containerChanged.reason}</p>}
          </PlanSection>
          <StreamSections plan={plan} media={detail.media} />
          <EncoderSection plan={plan} loudness={loudness} />
          {loudness && <CeilingSection plan={plan} />}
          {loudness && (
            <PlanSection caption={PLAN_CAPTIONS.loudness}>
              <LoudnessSection detail={{ ...detail, plan }} onMeasureNow={onMeasureNow} />
            </PlanSection>
          )}
        </>
      )}
      <PlanSection caption={PLAN_CAPTIONS.issues}>
        <IssueList groups={groups} several={false} {...handlers} />
      </PlanSection>
      {plan !== null && plan.command !== null && <CommandDisclosure command={plan.command} plans={gains} platform={platform} onCopied={onCopied} />}
    </>
  )
}

interface SelectionPlanViewProps extends PlanIssueHandlers
{
  jobs: readonly JobView[]
  entries: readonly PlanEntry[]
  policy: BatchPolicy
  platform: Platform
}

function SelectionPlanView({ jobs, entries, policy, platform, ...handlers }: SelectionPlanViewProps): React.JSX.Element
{
  const ids = new Set(jobs.map((job) => job.id))
  const selected = entries.filter((entry) => ids.has(entry.jobId))
  return (
    <>
      <p className='text-label text-ink'>{selectionCounts(jobs, selected)}</p>
      <PlanSection caption={PLAN_CAPTIONS.issues}>
        <IssueList groups={issueGroups(selected)} several {...handlers} />
      </PlanSection>
      <PlanSection caption={PLAN_CAPTIONS.output}>
        <p className='text-label text-ink wrap-anywhere'>{destinationText(selected, policy)}</p>
      </PlanSection>
      <PlanSection caption={PLAN_CAPTIONS.originals}>
        <Lines lines={originalsText(selected, policy, platform)} />
      </PlanSection>
    </>
  )
}

export interface PlanTabProps extends PlanTabHandlers
{
  /** The jobs the inspector shows: one job shows its full plan, several the selection's aggregate. */
  jobs: readonly JobView[]
  /** The single selected job's detail: plan, probe facts, and measurement. */
  detail?: PlanDetail | null
  /** Each job's status, plan, and issues from the latest report or live plan. */
  entries?: readonly PlanEntry[]
  /** The output policy the plans were computed against. */
  policy: BatchPolicy
  platform?: Platform
  className?: string
}

/**
 * The inspector's Plan tab. For one job: the output path and what is there now, the original's fate, the container,
 * the streams kept and not kept, the encoder, the ceiling, the loudness plan with "Measure now", the issues with their
 * fixes, and the planned FFmpeg command. A finished job states its placed path and what its placement did instead of
 * the plan's view before the run. For several: counts, the selection's issue groups, the destination, and the
 * originals affected. Its text opts in to selection.
 */
export function PlanTab({ jobs, detail = null, entries = [], policy, platform, className, ...handlers }: PlanTabProps): React.JSX.Element | null
{
  const contextPlatform = usePlatform()
  const shell = platform ?? contextPlatform
  if (jobs.length === 0)
  {
    return null
  }
  const body = jobs.length === 1
    ? (
        <JobPlanView
          detail={detail !== null && detail.view.id === jobs[0].id ? detail : { view: jobs[0], plan: null, media: null, measurement: null }}
          entry={entries.find((entry) => entry.jobId === jobs[0].id) ?? null}
          policy={policy}
          platform={shell}
          {...handlers}
        />
      )
    : <SelectionPlanView jobs={jobs} entries={entries} policy={policy} platform={shell} {...handlers} />
  return <div className={cx('flex select-text flex-col gap-4 px-4 py-3', className)}>{body}</div>
}
