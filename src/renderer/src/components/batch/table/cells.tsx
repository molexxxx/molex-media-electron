/**
 * The job table's cells. Each cell renders the one job it is given, so a row can subscribe to its own job and the
 * History lists can reuse the cells; the pure helpers beside them word what the cells print.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { formatNumber } from '../../../../../shared/audio/messages'
import type { MeasureStatus } from '../../../../../shared/audio/types'
import { sourceContainerLabel } from '../../../../../shared/jobs/describe'
import { needsAttention, needsDecision } from '../../../../../shared/jobs/states'
import { ACTIVE_STATES, TERMINAL_STATES, type AudioPlanCell, type JobView, type MediaSummary } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import
{
  batchLabel,
  countOf,
  formatBytes,
  formatClock,
  formatCount,
  formatDay,
  formatDuration,
  formatElapsed,
  formatGain,
  formatLoudness,
  formatSizeChange,
  formatSpeed,
  formatTimeOfDay,
  PART_SEPARATOR,
  rerunLabel,
  stampWords,
  statusWords,
  type StatusKey as WordStatusKey,
  type StampWords,
  type StatusWords
} from '../../../copy/batch'
import { CatalogNumber } from '../../../ui/CatalogNumber'
import { cx } from '../../../ui/cx'
import { Icon } from '../../../ui/Icon'
import { IconButton } from '../../../ui/IconButton'
import type { IconName } from '../../../ui/icons'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { ProgressBar } from '../../../ui/ProgressBar'
import { Stamp, useStampLanding } from '../../../ui/Stamp'
import { StatusLabel, type StatusKey } from '../../../ui/StatusLabel'
import { GRID_FOCUS_DELAY_MS, Tooltip } from '../../../ui/Tooltip'
import { VisuallyHidden } from '../../../ui/VisuallyHidden'

/** Every column a job list can show. */
export type JobColumnId =
  | 'no' | 'status' | 'plan' | 'file' | 'source' | 'recipe' | 'duration' | 'size' | 'output' | 'encoder' | 'audioPlan'
  | 'progress' | 'time' | 'speed' | 'out' | 'batch' | 'finished' | 'result' | 'actions' | 'quick'

/** Characters of the stem a middle truncation keeps beside the extension, so "(2)" and the extension survive. */
export const FILE_TAIL_CHARS = 6

/** Splits a name or path so the head can shrink to an ellipsis while the tail keeps the stem's end and the extension. */
export function splitFileName(name: string, keep: number = FILE_TAIL_CHARS): { head: string, tail: string }
{
  const dot = name.lastIndexOf('.')
  const stemEnd = dot > 0 ? dot : name.length
  const cut = Math.max(0, stemEnd - keep)
  return { head: name.slice(0, cut), tail: name.slice(cut) }
}

/** Text that truncates in the middle: the head ends in an ellipsis, the tail always shows, and it reads as one string. */
export function MiddleTruncate({ text, className }: { text: string, className?: string }): ReactElement
{
  const { head, tail } = splitFileName(text)
  return (
    <span className={cx('flex min-w-0 max-w-full', className)} data-part="middle">
      <VisuallyHidden>{text}</VisuallyHidden>
      <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis whitespace-pre" data-part="head">{head}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre" data-part="tail">{tail}</span>
    </span>
  )
}

const NUMBER_RUN = /(?<![\p{L}\p{N}.\-])[+−-]?\d+(?:[.,:]\d+)*/gu

/** Sets the numbers of a phrase in tabular figures so columns of values line up, "WAV · 24-bit · stereo". */
export function TabularNumbers({ text }: { text: string }): ReactElement
{
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(NUMBER_RUN))
  {
    const start = match.index
    if (start > last)
    {
      parts.push(text.slice(last, start))
    }
    parts.push(<span key={start} className="tabular-nums" data-part="number">{match[0]}</span>)
    last = start + match[0].length
  }
  if (last < text.length)
  {
    parts.push(text.slice(last))
  }
  return <>{parts}</>
}

/** The StatusLabel key that draws a status word's icon and ink. */
export function statusKeyFor(key: WordStatusKey): StatusKey
{
  return key === 'canceled' ? 'cancelled' : key
}

const VIDEO_CODECS: Readonly<Record<string, string>> =
{
  h264: 'H.264',
  hevc: 'HEVC',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  prores: 'ProRes',
  ffv1: 'FFV1',
  theora: 'Theora',
  mjpeg: 'MJPEG',
  vc1: 'VC-1',
  wmv2: 'WMV2',
  wmv3: 'WMV3',
  dnxhd: 'DNxHD',
  utvideo: 'UT Video'
}

/** A probed video codec's name: "H.264", "HEVC", or the codec in capitals. */
export function videoCodecLabel(codec: string): string
{
  return Object.hasOwn(VIDEO_CODECS, codec) ? VIDEO_CODECS[codec] : codec.toUpperCase()
}

function layoutWord(stream: MediaSummary['audio'][number]): string
{
  if (stream.layout !== null && stream.layout !== '')
  {
    return stream.layout
  }
  if (stream.channels === 1)
  {
    return 'mono'
  }
  return stream.channels === 2 ? 'stereo' : countOf(stream.channels, 'channel')
}

/**
 * The Source cell: "MKV · H.264 1080p · 2 audio · 3 subtitles", "WAV · 24-bit · stereo", "MP3 · 128 kb/s · mono".
 * The file's name picks the container when the probe names a demuxer's format list ("mov,mp4,m4a,3gp,3g2,mj2").
 */
export function sourceSummary(media: MediaSummary | null, fileName: string = ''): string
{
  if (media === null)
  {
    return ''
  }
  const parts = [sourceContainerLabel(media.container, fileName)]
  if (media.video !== null)
  {
    const lines = Math.min(media.video.width, media.video.height)
    parts.push(lines > 0 ? `${videoCodecLabel(media.video.codec)} ${lines}p` : videoCodecLabel(media.video.codec))
    if (media.audio.length > 0)
    {
      parts.push(`${formatCount(media.audio.length)} audio`)
    }
  }
  else if (media.audio.length > 0)
  {
    const first = media.audio[0]
    if (first.bitsPerSample !== null)
    {
      parts.push(`${first.bitsPerSample}-bit`)
    }
    else if (first.bitrateKbps !== null)
    {
      parts.push(`${Math.round(first.bitrateKbps)} kb/s`)
    }
    parts.push(layoutWord(first))
    if (media.audio.length > 1)
    {
      parts.push(`${formatCount(media.audio.length)} audio`)
    }
  }
  if (media.subtitles > 0)
  {
    parts.push(countOf(media.subtitles, 'subtitle'))
  }
  return parts.join(PART_SEPARATOR)
}

/** Whether a job is in an active stage: probing or measuring in a batch, encoding, verifying, or saving. */
export function isActiveJob(job: Pick<JobView, 'state'>): boolean
{
  return ACTIVE_STATES.includes(job.state)
}

/** The Audio plan cell before a measurement, for the operations that measure. */
export const MEASURED_AT_RUN = 'Measured at run'

const COPIED_WORDS: Readonly<Record<MeasureStatus, string>> =
{
  'measured': 'Copied',
  'silent': 'Silent, copied',
  'too-short': 'Too short, copied',
  'below-floor': 'Too quiet, copied'
}

function gainPlanText(cell: AudioPlanCell): string
{
  if (cell.status !== 'measured' || cell.mode === 'passthrough')
  {
    return COPIED_WORDS[cell.status]
  }
  if (cell.mode === 'linear')
  {
    return `${formatGain(cell.gainDb)}, linear`
  }
  if (cell.mode === 'peak-limited')
  {
    return `${formatGain(cell.gainDb)}, ${formatNumber(cell.limitingDb, 'amount', 'unicode')} dB limiting`
  }
  return cell.predictedLufs === null ? `${formatGain(cell.gainDb)}, reachable` : `${formatLoudness(cell.predictedLufs, cell.unit)} reachable`
}

/** The Audio plan cell: "+2.9 dB, linear", "+5.0 dB, 2.5 dB limiting", "−11.5 LUFS reachable", "+2.9 to +4.1 dB, 3 streams". */
export function audioPlanText(job: Pick<JobView, 'audioPlan' | 'recipe'>): string
{
  const cells = job.audioPlan
  if (cells === null || cells.length === 0)
  {
    return job.recipe.kind === 'normalize' || job.recipe.kind === 'boost' ? MEASURED_AT_RUN : ''
  }
  if (cells.length === 1)
  {
    return gainPlanText(cells[0])
  }
  const streams = countOf(cells.length, 'stream')
  const gains = cells.filter((cell) => cell.status === 'measured' && cell.mode !== 'passthrough').map((cell) => cell.gainDb)
  if (gains.length === 0)
  {
    return `${gainPlanText(cells[0])}, ${streams}`
  }
  const low = formatGain(Math.min(...gains))
  const high = formatGain(Math.max(...gains))
  return low === high ? `${low}, ${streams}` : `${low.replace(/ dB$/, '')} to ${high}, ${streams}`
}

function extensionOf(name: string): string
{
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The Output cell's note in Replace mode: "replaces original", ".mp4 replaces .mkv", or "beside its source". */
export function outputNote(job: Pick<JobView, 'plan' | 'source'>, replaceMode: boolean): string | null
{
  if (!replaceMode || job.plan === null)
  {
    return null
  }
  if (job.plan.resolution !== 'replace-original')
  {
    return 'beside its source'
  }
  const out = extensionOf(job.plan.finalName)
  const source = job.source.ext.replace(/^\./, '').toLowerCase()
  return out === source || out === '' ? 'replaces original' : `.${out} replaces .${source}`
}

/** The Recipe cell's two parts: the operation word and the preset label with its ", edited". */
export function recipeParts(label: string): { operation: string, preset: string }
{
  const at = label.indexOf(PART_SEPARATOR)
  return at < 0 ? { operation: '', preset: label } : { operation: label.slice(0, at), preset: label.slice(at + PART_SEPARATOR.length) }
}

/** The Recipe cell's notes after the preset: "album A" for album groups, "rerun of MM-0131" for reruns. */
export function recipeNotes(job: Pick<JobView, 'rerunOf'>, album: string | null): string[]
{
  const notes: string[] = []
  if (album !== null)
  {
    notes.push(`album ${album}`)
  }
  if (job.rerunOf !== null)
  {
    notes.push(rerunLabel(job.rerunOf.jobId))
  }
  return notes
}

/** Letters for album groups in queue order: the first group is "A", the 27th "AA". */
export function albumLetter(index: number): string
{
  let n = index
  let out = ''
  do
  {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  }
  while (n >= 0)
  return out
}

/** The Time cell: "7 min 40 s left" once the job has a time left, then the elapsed time as a span, "12 min 40 s". */
export function timeText(job: Pick<JobView, 'state' | 'progress' | 'startedAt' | 'endedAt'>): string
{
  if (isActiveJob(job))
  {
    const eta = job.progress?.etaSec ?? null
    return eta === null ? '' : `${formatDuration(eta)} left`
  }
  if (TERMINAL_STATES.includes(job.state) && job.startedAt !== null && job.endedAt !== null)
  {
    return formatElapsed(Math.max(0, job.endedAt - job.startedAt))
  }
  return ''
}

/** The Speed cell: the realtime multiple while active, "6.2x". */
export function speedText(job: Pick<JobView, 'state' | 'progress'>): string
{
  const speed = isActiveJob(job) ? job.progress?.speed ?? null : null
  return speed === null ? '' : formatSpeed(speed)
}

/** The Out cell: the bytes written so far, "312 MB", then the output and its change, "24.1 MB · −97%". */
export function outText(job: Pick<JobView, 'state' | 'progress' | 'stamp'>): string
{
  if (isActiveJob(job))
  {
    const written = job.progress?.bytesWritten ?? null
    return written === null ? '' : formatBytes(written)
  }
  if (job.stamp === null)
  {
    return ''
  }
  return `${formatBytes(job.stamp.outputBytes)}${PART_SEPARATOR}${formatSizeChange(job.stamp.outputBytes, job.stamp.inputBytes)}`
}

/** The Finished cell of History's matching jobs: "Oct 14 13:40". */
export function finishedText(job: Pick<JobView, 'endedAt'>): string
{
  return job.endedAt === null ? '' : `${formatDay(job.endedAt)} ${formatTimeOfDay(job.endedAt)}`
}

/** Run's quick button at wide widths: Cancel job while active, Skip while queued, Acknowledge for a held warning. */
export type QuickAction = 'cancel' | 'skip' | 'acknowledge'

/** The one quick button a job shows, or null; a job waiting for a decision gets its decision in the row menu. */
export function quickActionFor(job: JobView): QuickAction | null
{
  if (isActiveJob(job))
  {
    return 'cancel'
  }
  if (job.state === 'queued')
  {
    return 'skip'
  }
  return needsAttention(job) && !needsDecision(job) ? 'acknowledge' : null
}

/** A quick button's name, which names its job: "Cancel job MM-0141", "Skip MM-0141", "Acknowledge MM-0141". */
export function quickActionLabel(action: QuickAction, id: string): string
{
  switch (action)
  {
    case 'cancel':
      return `Cancel job ${id}`
    case 'skip':
      return `Skip ${id}`
    default:
      return `Acknowledge ${id}`
  }
}

/** Plans pending longer than this read "Checking". */
export const CHECKING_AFTER_MS = 600

/** Whether a waiting job's plan is being worked out: probed, but with no plan or one that no longer matches. */
export function planPending(job: Pick<JobView, 'state' | 'probe' | 'plan'>): boolean
{
  return job.state === 'pending' && job.probe === 'ok' && (job.plan === null || !job.plan.current)
}

/** True once `pending` has held for more than {@link CHECKING_AFTER_MS}. */
export function usePlanChecking(pending: boolean): boolean
{
  const [late, setLate] = useState(false)
  useEffect(() =>
  {
    if (!pending)
    {
      setLate(false)
      return undefined
    }
    const timer = setTimeout(() => setLate(true), CHECKING_AFTER_MS)
    return () => clearTimeout(timer)
  }, [pending])
  return pending && late
}

/** A value cell's text, its numbers in tabular figures; `quiet` sets metadata a step below the row's values. */
export function ValueText({ text, selected, quiet = false }: { text: string, selected: boolean, quiet?: boolean }): ReactElement | null
{
  if (text === '')
  {
    return null
  }
  const ink = quiet ? (selected ? 'text-ink-2' : 'text-ink-3') : (selected ? 'text-ink' : 'text-ink-2')
  return <span className={cx('min-w-0 truncate', ink)}><TabularNumbers text={text} /></span>
}

/** The File cell: the name in full ink, its folder in a tooltip. */
export function FileCell({ job }: { job: JobView }): ReactElement
{
  return (
    <Tooltip content={`${job.source.name}\n${job.source.dir}`} focusDelay={GRID_FOCUS_DELAY_MS} mode="label" inside>
      <span className="flex min-w-0 max-w-full" data-part="file">
        <MiddleTruncate text={job.source.name} className="text-ink" />
      </span>
    </Tooltip>
  )
}

/** A Status or Plan cell: icon and word, held while the job needs attention, the full word in a tooltip when shortened or held. */
export function StatusCell({ words }: { words: StatusWords }): ReactElement
{
  const label = (
    <StatusLabel
      status={statusKeyFor(words.status)}
      label={words.label}
      compactLabel={words.compact === words.label ? undefined : words.compact}
      held={words.held}
    />
  )
  if (words.tooltip === null)
  {
    return label
  }
  return (
    <Tooltip content={words.tooltip} focusDelay={GRID_FOCUS_DELAY_MS} inside>
      <span className="inline-flex min-w-0 max-w-full" data-part="status">{label}</span>
    </Tooltip>
  )
}

/** A preset's name without its parenthetical source, for the narrow Operation column: "Streaming (EBU R 128 s2)" reads "Streaming". */
export function shortPreset(preset: string): string
{
  const short = preset.replace(/\s*\([^)]*\)\s*$/u, '')
  return short === '' ? preset : short
}

/** The Operation cell: the operation glyph and word, then the preset a step quieter, then album and rerun notes. */
export function RecipeCell({ job, album }: { job: JobView, album: string | null }): ReactElement
{
  const { operation, preset } = recipeParts(job.recipeLabel)
  const notes = recipeNotes(job, album)
  const short = shortPreset(preset)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 text-brass"><Icon name={`op.${job.recipe.kind}`} size="sm" /></span>
      <span className="flex min-w-0 items-baseline gap-2 truncate">
        {operation !== '' && <span className="shrink-0 text-ink-2">{operation}</span>}
        <span className="min-w-0 truncate text-ink-3">{short}</span>
        {notes.length > 0 && <span className="text-ink-3">{PART_SEPARATOR}{notes.join(PART_SEPARATOR)}</span>}
      </span>
    </span>
  )
}

/** Review's Output cell: the path from the destination, truncated in the middle so "(2)" and the extension show. */
export function OutputCell({ job, replaceMode }: { job: JobView, replaceMode: boolean }): ReactElement | null
{
  if (job.plan === null || job.plan.relativePath === '')
  {
    return null
  }
  const note = outputNote(job, replaceMode)
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <MiddleTruncate text={job.plan.relativePath} className="text-ink" />
      {note !== null && <span className="min-w-0 shrink-3 truncate text-ink-2" data-part="note">{note}</span>}
    </span>
  )
}

/** Keeps a row's stamp inside its cell: the values give way first and end in an ellipsis. */
export const ROW_STAMP_FIT = 'max-w-full [&_[data-part=values]]:overflow-hidden [&_[data-part=value]]:min-w-0 [&_[data-part=value]]:truncate'

/** A row stamp's tooltip: the reference line, or the stamp's whole values when it has none, so a cut value reads in full. */
export function rowStampTooltip(words: Pick<StampWords, 'values' | 'tooltip'>): string | undefined
{
  if (words.tooltip !== null)
  {
    return words.tooltip
  }
  const text = words.values.map((item) => item.text).join(', ')
  return text === '' ? undefined : text
}

function StampFor({ job, landing }: { job: JobView, landing: boolean }): ReactElement | null
{
  const words = stampWords(job)
  if (words === null)
  {
    return null
  }
  return <Stamp outcome={words.tone} values={words.values} size="sm" landing={landing} tooltip={rowStampTooltip(words)} className={ROW_STAMP_FIT} />
}

/** Run's working cell: a 4 px bar and its percent while active, then the stamp, which lands only on a live finish. */
export function ProgressCell({ job }: { job: JobView }): ReactElement | null
{
  const active = isActiveJob(job)
  const landing = useStampLanding(active)
  if (!active)
  {
    return <StampFor job={job} landing={landing} />
  }
  const percent = job.progress?.percent ?? null
  return (
    <ProgressBar
      value={percent === null ? undefined : Math.min(1, Math.max(0, percent / 100))}
      label={`Progress of ${job.id}`}
      size="sm"
      showValue
      className="w-full"
    />
  )
}

/** History's Result cell: the stamp, settled. */
export function ResultCell({ job }: { job: JobView }): ReactElement | null
{
  return <StampFor job={job} landing={false} />
}

/** The More actions button, so the row menu is one pointer action away on every row. */
export function ActionsCell({ id, items }: { id: string, items: MenuEntry[] }): ReactElement | null
{
  if (items.length === 0)
  {
    return null
  }
  return (
    <Menu
      label={`Actions for ${id}`}
      align="end"
      items={items}
      trigger={<IconButton label={`More actions for ${id}`} icon="action.more" size="sm" />}
    />
  )
}

const QUICK_ICONS: Readonly<Record<QuickAction, IconName>> = { cancel: 'action.stop', skip: 'action.skip', acknowledge: 'action.acknowledge' }

/** Run's quick button at wide widths: Cancel job, Skip, or Acknowledge, named for its job. */
export function QuickActionCell({ job, onAction }: { job: JobView, onAction: (action: QuickAction, job: JobView) => void }): ReactElement | null
{
  const action = quickActionFor(job)
  if (action === null)
  {
    return null
  }
  return (
    <IconButton
      label={quickActionLabel(action, job.id)}
      icon={QUICK_ICONS[action]}
      size="sm"
      variant={action === 'cancel' ? 'danger' : 'ghost'}
      tooltip
      onClick={() => onAction(action, job)}
    />
  )
}

/** What a row hands each of its cells besides the job. */
export interface JobCellProps
{
  job: JobView
  column: string
  selected: boolean
  platform: Platform
  /** Run shows a waiting job as "Not in this batch". */
  inRunMode?: boolean
  /** The plan has been pending for more than 600 ms. */
  checking?: boolean
  /** This window asked the job to stop and main has not settled it yet. */
  stopping?: boolean
  /** The queue replaces originals, so Review's Output cell says how each output lands. */
  replaceMode?: boolean
  /** The letter of the job's album group. */
  album?: string | null
  /** The row menu's entries, for the More actions button. */
  menuItems?: () => MenuEntry[]
  onQuickAction?: (action: QuickAction, job: JobView) => void
}

/** One cell of a job row, by column. */
export function JobCell(props: JobCellProps): ReactNode
{
  const { job, selected } = props
  switch (props.column as JobColumnId)
  {
    case 'no':
      return <CatalogNumber value={job.id} selected={selected} />
    case 'status':
    case 'plan':
      return <StatusCell words={statusWords(job, { platform: props.platform, inRunMode: props.inRunMode, checking: props.checking, stopping: props.stopping })} />
    case 'file':
      return <FileCell job={job} />
    case 'source':
      return <ValueText text={sourceSummary(job.media, job.source.name)} selected={selected} quiet />
    case 'recipe':
      return <RecipeCell job={job} album={props.album ?? null} />
    case 'duration':
      return <ValueText text={job.media?.durationSec == null ? '' : formatClock(job.media.durationSec)} selected={selected} />
    case 'size':
      return <ValueText text={formatBytes(job.source.size)} selected={selected} />
    case 'output':
      return <OutputCell job={job} replaceMode={props.replaceMode === true} />
    case 'encoder':
      return <ValueText text={job.plan?.encoderLabel ?? ''} selected={selected} />
    case 'audioPlan':
      return <ValueText text={audioPlanText(job)} selected={selected} />
    case 'progress':
      return <ProgressCell job={job} />
    case 'result':
      return <ResultCell job={job} />
    case 'time':
      return <ValueText text={timeText(job)} selected={selected} />
    case 'speed':
      return <ValueText text={speedText(job)} selected={selected} />
    case 'out':
      return <ValueText text={outText(job)} selected={selected} />
    case 'batch':
      return <ValueText text={job.runId === null ? '' : batchLabel(job.runId)} selected={selected} />
    case 'finished':
      return <ValueText text={finishedText(job)} selected={selected} />
    case 'actions':
      return <ActionsCell id={job.id} items={props.menuItems?.() ?? []} />
    case 'quick':
      return props.onQuickAction === undefined ? null : <QuickActionCell job={job} onAction={props.onQuickAction} />
    default:
      return null
  }
}
