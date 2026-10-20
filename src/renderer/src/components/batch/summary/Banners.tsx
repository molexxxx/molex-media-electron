import { useState, type ReactElement, type ReactNode } from 'react'
import type { JobId, RunId } from '../../../../../shared/jobs/ids'
import type { JobState, RunAlert, RunAlertKind, ScanState } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { batchLabel, countOf, formatCount, verbFor } from '../../../copy/batch'
import { Banner, type BannerTone } from '../../../ui/Banner'
import { Button } from '../../../ui/Button'
import { Checkbox } from '../../../ui/Checkbox'

/** A banner control. */
export type BannerActionId =
  | 'resume'
  | 'write-elsewhere'
  | 'select-waiting'
  | 'change-output'
  | 'show-log'
  | 'open-settings'
  | 'show-folder'
  | 'retry-interrupted'
  | 'show-decisions'
  | 'show-missing'
  | 'clear-restored'
  | 'show-file'
  | 'show-attention'

/** One control of a banner with the jobs or the path it acts on. */
export interface BannerAction
{
  id: BannerActionId
  label: string
  jobIds: readonly JobId[]
  path: string | null
}

/** A banner's words: tone, an optional lead sentence, the text, the controls, and how it is read out and dismissed. */
export interface BannerWords
{
  tone: BannerTone
  title: string | null
  body: string
  actions: BannerAction[]
  /** A run-blocking error, the only kind of banner read out assertively. */
  blocking: boolean
  /** Offers Dismiss; the other banners stay until their condition is resolved. */
  dismissible: boolean
}

/** Where "Write the rest elsewhere…" stands: not chosen, waiting for running jobs to finish, or done with Output unlocked. */
export type WriteElsewhereStage = 'none' | 'waiting' | 'unlocked'

/** What a run banner reads besides its alert. */
export interface AlertContext
{
  runId: RunId | null
  /** Jobs of the batch still running, for the line that says when Output unlocks. */
  running?: number
  writeElsewhere?: WriteElsewhereStage
  /** The volume holding molexMedia's own data; a full disk there means the queue cannot be saved. */
  dataVolume?: string | null
  /** A job's current state, so the restored banner retries interrupted jobs and shows those waiting for a decision. */
  stateOf?: (id: JobId) => JobState | undefined
  /** Whether a restored job's source is missing, for "Show missing". */
  isMissing?: (id: JobId) => boolean
}

/** The id of the acknowledgment in a restored Replace batch's banner, which Ctrl+Enter focuses. */
export const RESTORED_ACKNOWLEDGMENT_ID = 'batch-restored-acknowledgment'

/** Alert kinds that pause or block the run; they are the only banners read out as alerts. */
export const BLOCKING_ALERT_KINDS: readonly RunAlertKind[] = ['disk-space', 'destination-unavailable', 'ffmpeg-unavailable', 'storage-error']

const DISMISS_KINDS: readonly RunAlertKind[] = ['gpu-sessions', 'volume-offline', 'replace-migrated']

const SEVERITY_TONE: Record<RunAlert['severity'], BannerTone> = {
  info: 'info',
  warning: 'warning',
  error: 'error'
}

const LABELS = {
  resume: 'Resume',
  writeElsewhere: 'Write the rest elsewhere…',
  selectWaiting: 'Select waiting',
  changeOutput: 'Change output',
  showLog: 'Show log',
  openSettings: 'Open Settings',
  showFolder: 'Show folder',
  show: 'Show',
  showMissing: 'Show missing',
  clearRestored: 'Clear restored jobs',
  showFile: 'Show file'
} as const

function act(id: BannerActionId, label: string, jobIds: readonly JobId[] = [], path: string | null = null): BannerAction
{
  return { id, label, jobIds, path }
}

/** The cause main reports, without its closing period, for templates that quote it. */
function reasonOf(message: string): string
{
  return message.trim().replace(/[\s.]+$/u, '')
}

/** Fills a template around main's message unless the message already is the full sentence. */
function around(message: string, lead: string, tail: string): string
{
  const text = message.trim()
  return text.startsWith(lead) ? text : `${lead} ${reasonOf(text)}.${tail}`
}

function writeElsewhereWords(lead: string, actions: BannerAction[], context: AlertContext): { body: string; actions: BannerAction[] }
{
  const stage = context.writeElsewhere ?? 'none'
  if (stage === 'waiting')
  {
    const running = context.running ?? 0
    return { body: `${lead} Output unlocks when ${countOf(running, 'running job')} ${verbFor(running, 'finishes', 'finish')}.`, actions: [] }
  }
  if (stage === 'unlocked')
  {
    return { body: lead, actions: [act('change-output', LABELS.changeOutput)] }
  }
  return { body: lead, actions }
}

function restoredRunBody(counts: NonNullable<RunAlert['counts']>): string
{
  const parts: string[] = []
  const { interrupted, decisions, queued } = counts
  if (interrupted > 0)
  {
    parts.push(interrupted === 1
      ? '1 job was interrupted; its partial file was removed.'
      : `${countOf(interrupted, 'job')} were interrupted; their partial files were removed.`)
  }
  if (decisions > 0)
  {
    parts.push(decisions === 1
      ? '1 job was saving its output and needs a decision.'
      : `${countOf(decisions, 'job')} were saving their outputs and need a decision.`)
  }
  if (queued > 0)
  {
    parts.push(`${countOf(queued, 'queued job')} ${verbFor(queued, 'is', 'are')} paused.`)
  }
  return parts.join(' ')
}

const NO_COUNTS: NonNullable<RunAlert['counts']> = { interrupted: 0, decisions: 0, queued: 0, restored: 0, missing: 0 }

/**
 * The words of the banner one run alert raises: its sentence from the kind, counts, volume, and path, and its
 * controls with the jobs each acts on. Main's message is quoted where the sentence needs values the alert does not
 * carry as fields: the free and needed space of a full disk, the cause FFmpeg or saving failed with, and the GPU
 * encoder family with its lowered limit.
 */
export function alertWords(alert: RunAlert, context: AlertContext): BannerWords
{
  const batch = context.runId === null ? null : batchLabel(context.runId)
  const blocking = BLOCKING_ALERT_KINDS.includes(alert.kind)
  const words = (body: string, actions: BannerAction[], title: string | null = null): BannerWords => ({
    tone: SEVERITY_TONE[alert.severity],
    title,
    body,
    actions,
    blocking,
    dismissible: alert.dismissible || DISMISS_KINDS.includes(alert.kind)
  })
  const resume = batch === null ? [] : [act('resume', LABELS.resume)]
  const counts = alert.counts ?? NO_COUNTS
  const byState = (state: JobState): JobId[] =>
    context.stateOf ? alert.jobIds.filter((id) => context.stateOf?.(id) === state) : [...alert.jobIds]
  switch (alert.kind)
  {
    case 'disk-space':
    {
      if (alert.volume !== null && alert.volume === context.dataVolume)
      {
        const tail = batch === null ? ' Free some space.' : ` ${batch} is paused; free some space, then resume.`
        return words(`molexMedia cannot save its queue: ${alert.volume} is full.${tail}`, resume)
      }
      const lead = alert.message.trim() || `${alert.volume ?? 'The destination drive'} is full. Free some space, then resume.`
      const held = writeElsewhereWords(lead, [
        ...resume,
        act('write-elsewhere', LABELS.writeElsewhere, alert.jobIds),
        act('select-waiting', LABELS.selectWaiting, alert.jobIds)
      ], context)
      return words(held.body, held.actions)
    }
    case 'destination-unavailable':
    {
      const folder = alert.path ?? alert.volume ?? 'The destination'
      const tail = batch === null ? ' Reconnect it, then try again.' : ` ${batch} is paused; reconnect it, then resume.`
      const held = writeElsewhereWords(`${folder} is not available.${tail}`, [
        ...resume,
        act('write-elsewhere', LABELS.writeElsewhere, alert.jobIds)
      ], context)
      return words(held.body, held.actions)
    }
    case 'storage-error':
    {
      const tail = batch === null ? '' : ` ${batch} is paused until saving works again.`
      return words(around(alert.message, 'molexMedia cannot save its queue:', tail), [...resume, act('show-log', LABELS.showLog)])
    }
    case 'gpu-sessions':
      return words(alert.message.trim(), [])
    case 'ffmpeg-unavailable':
      return words(around(alert.message, 'FFmpeg is not ready:', ' Jobs cannot start.'), [act('open-settings', LABELS.openSettings)])
    case 'cleanup-pending':
    {
      const folder = alert.path ?? reasonOf(alert.message)
      return words(`molexMedia could not delete a temporary folder yet: ${folder}. It tries again every minute.`,
        alert.path === null ? [] : [act('show-folder', LABELS.showFolder, [], alert.path)])
    }
    case 'restored-run':
    {
      const actions: BannerAction[] = []
      if (counts.interrupted > 0)
      {
        actions.push(act('retry-interrupted', `Retry ${formatCount(counts.interrupted)} interrupted`, byState('interrupted')))
      }
      if (counts.decisions > 0)
      {
        actions.push(act('show-decisions', LABELS.show, byState('held')))
      }
      return words(restoredRunBody(counts), actions, `molexMedia closed during ${batch ?? 'the last batch'}.`)
    }
    case 'restored-queue':
    {
      const missing = counts.missing > 0 ? ` ${countOf(counts.missing, 'source')} ${verbFor(counts.missing, 'is', 'are')} missing.` : ''
      const missingIds = context.isMissing ? alert.jobIds.filter((id) => context.isMissing?.(id) === true) : [...alert.jobIds]
      return words(`Restored ${countOf(counts.restored, 'job')} from your last session.${missing}`, [
        ...(counts.missing > 0 ? [act('show-missing', LABELS.showMissing, missingIds)] : []),
        act('clear-restored', LABELS.clearRestored, alert.jobIds)
      ])
    }
    case 'volume-offline':
    {
      const volume = alert.volume ?? 'A drive'
      const decisions = counts.decisions
      return words(decisions > 0
        ? `${volume} is not reachable. ${countOf(decisions, 'job')} waiting for a decision ${verbFor(decisions, 'keeps its output', 'keep their outputs')} there; decide when it returns.`
        : `${volume} is not reachable. Jobs reading from it wait and start when it returns.`, [])
    }
    case 'queue-recovered':
      return words('The saved queue could not be read and was set aside. The queue starts empty.',
        alert.path === null ? [] : [act('show-file', LABELS.showFile, [], alert.path)])
    case 'replace-migrated':
      return words('Replace originals is now chosen per batch. This batch writes next to each source.', [act('change-output', LABELS.changeOutput)])
  }
}

/** A banner's full text, the lead sentence first. */
export function bannerText(words: BannerWords): string
{
  return words.title === null ? words.body : `${words.title} ${words.body}`.trim()
}

/** The one notice after a window reload while jobs of the batch need attention. */
export function reloadWords(attention: number, runId: RunId): BannerWords
{
  return {
    tone: 'info',
    title: null,
    body: `The window reloaded. ${countOf(attention, 'job')} ${verbFor(attention, 'needs', 'need')} attention in ${batchLabel(runId)}. Undo history was cleared.`,
    actions: [act('show-attention', LABELS.show)],
    blocking: false,
    dismissible: true
  }
}

/** The notice of a folder scan that stopped because its folder went away. */
export function scanStoppedWords(scan: Pick<ScanState, 'root' | 'added'>): BannerWords
{
  return {
    tone: 'warning',
    title: null,
    body: `Folder scan stopped: ${scan.root} is no longer available. Added ${countOf(scan.added, 'file')} found before the error.`,
    actions: [],
    blocking: false,
    dismissible: true
  }
}

/** The acknowledgment a restored Replace batch's banner carries; Resume stays disabled until it is checked. */
export interface RestoredAcknowledgment
{
  originals: number
  overwrites: number
  /** The volume whose Recycle Bin receives the originals, when there is one. */
  drive: string | null
  platform: Platform
  checked: boolean
  onChange: (checked: boolean) => void
}

/** The restored batch's acknowledgment sentence, with the counts of what the remaining jobs replace. */
export function restoredAcknowledgmentText(ack: Pick<RestoredAcknowledgment, 'originals' | 'overwrites' | 'drive' | 'platform'>): string
{
  const windows = ack.platform === 'win32'
  const bin = windows ? 'the Recycle Bin' : 'the Trash'
  const parts: string[] = []
  if (ack.originals > 0)
  {
    const where = windows && ack.drive ? ` on ${ack.drive}` : ''
    parts.push(`${countOf(ack.originals, 'original')} ${verbFor(ack.originals, 'goes', 'go')} to ${bin}${where} after ${verbFor(ack.originals, 'its output verifies', 'their outputs verify')}`)
  }
  if (ack.overwrites > 0)
  {
    parts.push(`${countOf(ack.overwrites, 'existing file')} ${verbFor(ack.overwrites, 'goes', 'go')} to ${bin} and ${verbFor(ack.overwrites, 'is', 'are')} replaced`)
  }
  return `I understand that ${parts.join(' and ')}.`
}

/** Props for {@link NoticeBanner}. */
export interface NoticeBannerProps
{
  words: BannerWords
  /** Defaults to status; pass alert only for a run-blocking error that appeared after the window loaded. */
  role?: 'status' | 'alert'
  onAction: (action: BannerAction) => void
  onDismiss?: () => void
  /** Content after the text, such as the restored batch's acknowledgment. */
  children?: ReactNode
}

/**
 * One summary-slot notice drawn from its words. It holds: a dismissible notice offers Dismiss and stays until
 * then, and every other notice stays until its owner removes it once the condition is resolved.
 */
export function NoticeBanner({ words, role = 'status', onAction, onDismiss, children }: NoticeBannerProps): ReactElement
{
  const actions = words.actions.length === 0
    ? undefined
    : words.actions.map((action) => (
      <Button key={action.id} size="sm" variant="secondary" onClick={() => onAction(action)}>{action.label}</Button>
    ))
  return (
    <div data-held="" data-blocking={words.blocking ? '' : undefined}>
      <Banner
        tone={words.tone}
        title={words.title ?? undefined}
        role={role}
        held={words.dismissible}
        onDismiss={words.dismissible ? onDismiss : undefined}
        actions={actions}
      >
        <p>{words.body}</p>
        {children}
      </Banner>
    </div>
  )
}

function RestoredAcknowledgmentCheck({ ack }: { ack: RestoredAcknowledgment }): ReactElement
{
  return (
    <Checkbox
      id={RESTORED_ACKNOWLEDGMENT_ID}
      className="mt-2"
      checked={ack.checked}
      onChange={(event) => ack.onChange(event.currentTarget.checked)}
    >
      {restoredAcknowledgmentText(ack)}
    </Checkbox>
  )
}

/** Props for {@link RunBanner}. */
export interface RunBannerProps
{
  alert: RunAlert
  context: AlertContext
  /** When the window took main's snapshot; only a blocking alert raised after it is read out as an alert. */
  loadedAt: number
  onAction: (action: BannerAction, alert: RunAlert) => void
  onDismiss?: (alert: RunAlert) => void
  /** Under Replace, the restored batch's acknowledgment, which the restored-run banner carries. */
  acknowledgment?: RestoredAcknowledgment | null
}

/** The banner one run alert raises, with its counts, the jobs its controls act on, and its role. */
export function RunBanner({ alert, context, loadedAt, onAction, onDismiss, acknowledgment = null }: RunBannerProps): ReactElement
{
  const words = alertWords(alert, context)
  const role = words.blocking && alert.at > loadedAt ? 'alert' : 'status'
  const showAck = alert.kind === 'restored-run' && acknowledgment !== null && (acknowledgment.originals > 0 || acknowledgment.overwrites > 0)
  return (
    <div data-alert-kind={alert.kind} data-alert-id={alert.id}>
      <NoticeBanner
        words={words}
        role={role}
        onAction={(action) => onAction(action, alert)}
        onDismiss={onDismiss ? () => onDismiss(alert) : undefined}
      >
        {showAck && acknowledgment ? <RestoredAcknowledgmentCheck ack={acknowledgment} /> : null}
      </NoticeBanner>
    </div>
  )
}

/** Props for {@link RunBanners}. */
export interface RunBannersProps extends Omit<RunBannerProps, 'alert' | 'loadedAt'>
{
  alerts: readonly RunAlert[]
  /** When the window took main's snapshot; defaults to when the list first rendered. */
  loadedAt?: number
}

/** Orders alerts with the run-blocking ones first, keeping main's order within each group. */
export function orderAlerts(alerts: readonly RunAlert[]): RunAlert[]
{
  const blocking = alerts.filter((alert) => BLOCKING_ALERT_KINDS.includes(alert.kind))
  return [...blocking, ...alerts.filter((alert) => !BLOCKING_ALERT_KINDS.includes(alert.kind))]
}

/** Every run alert as a held banner, run-blocking ones first; nothing when there are none. */
export function RunBanners({ alerts, loadedAt, ...rest }: RunBannersProps): ReactElement | null
{
  const [mountedAt] = useState(() => Date.now())
  if (alerts.length === 0)
  {
    return null
  }
  return (
    <div className="flex flex-col gap-2">
      {orderAlerts(alerts).map((alert) => (
        <RunBanner key={alert.id} alert={alert} loadedAt={loadedAt ?? mountedAt} {...rest} />
      ))}
    </div>
  )
}
