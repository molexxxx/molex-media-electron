/**
 * @module components/logs/logModel
 * @description What the Logs view reads from a log entry: its level group, the part of the app that wrote it, its
 * local time, an FFmpeg command line it carries, and the words and copy text built from them. Pure, so every rule
 * here is tested without a window.
 */

import type { LogEntry, LogFilter } from '../../stores/types'
import { formatRunLabel, type RunId } from '../../../../shared/jobs/ids'
import { countOf, formatCount } from '../../copy/batch'

/** The three levels the view filters by; success, debug, and FFmpeg lines read as Info. */
export type LogLevelGroup = 'info' | 'warning' | 'error'

/** The level control's value. */
export type LevelFilter = 'all' | LogLevelGroup

/** The part of the app a line came from. */
export type LogSource = 'app' | 'jobs' | 'commands' | 'output' | 'ffmpeg' | 'gpu' | 'updates' | 'player' | 'editor' | 'online'

/** Every source in menu order. */
export const LOG_SOURCES: readonly LogSource[] = ['app', 'jobs', 'commands', 'output', 'ffmpeg', 'gpu', 'updates', 'player', 'editor', 'online']

/** A source as the Source column names one line. */
export const SOURCE_LABELS: Readonly<Record<LogSource, string>> = {
  app: 'App',
  jobs: 'Job engine',
  commands: 'FFmpeg command',
  output: 'FFmpeg output',
  ffmpeg: 'FFmpeg setup',
  gpu: 'Hardware encoding',
  updates: 'Updates',
  player: 'Player',
  editor: 'Editor',
  online: 'Online media'
}

/** A source as the Sources menu lists it. */
export const SOURCE_MENU_LABELS: Readonly<Record<LogSource, string>> = {
  ...SOURCE_LABELS,
  commands: 'FFmpeg commands'
}

/** A level as the Level column and control name it. */
export const LEVEL_LABELS: Readonly<Record<LogLevelGroup, string>> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error'
}

/** The page's words. */
export const LOG_WORDS = {
  title: 'Logs',
  levelLabel: 'Level',
  levelAll: 'All',
  levelInfo: 'Info',
  levelWarnings: 'Warnings',
  levelErrors: 'Errors',
  sources: 'Sources',
  allSources: 'All sources',
  showEverySource: 'Show every source',
  everySourceShown: 'Every source is shown.',
  searchPlaceholder: 'Search the log',
  follow: 'Follow new lines',
  copyLines: 'Copy lines',
  copied: 'Copied',
  nothingToCopy: 'No lines to copy.',
  openFolder: 'Open log folder',
  clear: 'Clear',
  clearQuestion: 'Clear every line from this view? The log files keep them.',
  nothingToClear: 'Nothing to clear.',
  keepLines: 'Keep lines',
  clearLines: 'Clear lines',
  paneHeight: 'Pane height',
  gridLabel: 'Log lines',
  emptyTitle: 'Nothing logged yet',
  emptyBody: 'Lines appear here as molexMedia works: starting up, checking FFmpeg, and running batches.',
  noMatchTitle: 'No lines match',
  noMatchBody: 'Nothing shown passes the level, sources, and search set above.',
  clearFilters: 'Clear filters',
  copyLine: 'Copy line',
  copyCommand: 'Copy command',
  showDetails: 'Show details',
  hideDetails: 'Close details',
  detailsHeight: 'Details height',
  detailsLabel: 'Line details',
  detailsEmpty: 'Select a line to read all of it here.',
  details: 'Details',
  command: 'FFmpeg command',
  showJob: 'Show job'
} as const

/** The words of the job and batch filter and the full output panel. */
export const LOG_FILTER_WORDS = {
  filteredTo: 'Showing lines for',
  clear: 'Show all lines',
  fullOutput: 'Full FFmpeg output',
  showOutput: 'Show output',
  hideOutput: 'Hide output',
  reading: 'Reading the output',
  emptyOutput: 'FFmpeg printed nothing for this job.',
  unavailable: 'The full output cannot be read in this window.',
  failed: 'The full output could not be read.',
  truncated: 'This is the end of the output; the log file holds all of it.',
  tryAgain: 'Try again',
  copy: 'Copy output',
  copied: 'Copied',
  showFile: 'Show in folder'
} as const

/** A long single line counts as more than a row shows from this many characters. */
export const LONG_LINE_CHARS = 160

const COMMAND_TAG = '[CMD] '

/** How the job engine's runners mark the FFmpeg command line they are about to run. */
const ENGINE_COMMAND = '> '

/** Leading tags whose meaning the Source column already carries. */
const SOURCE_TAGS = ['[CMD] ', '[STDERR] ', '[gpu] ', '[preview-server] ']

const JOB_ENGINE = /^(?:Job engine\b|The job engine\b|Job command\b)/
const GPU = /^\[gpu\]/
const EDITOR = /^\[(?:editor:|createPreview|createAudioPreview)/
const PLAYER = /^(?:Playback:|media:\/\/|\[preview-server\])/
const UPDATES = /^(?:Checking for updates|Update |App is up to date|Could not install the update|The batch finished; installing the update)/
const ONLINE = /yt-dlp|cookie|^Resolving |^Playlist resolved|^pickDirectAudioUrl|^Audio stream|^Audio downloaded|^All \d+ formats|^Cleaned up \d+ cached audio|^Using cached browser|^Detected browser|^No browser detected|^Request failed with possible auth|^setBrowser/i
const FFMPEG_SETUP = /FFmpeg|^codesign|^Verified .+ bytes, SHA-256/

/** The level group a line filters under. */
export function levelGroup(entry: Pick<LogEntry, 'level'>): LogLevelGroup
{
  if (entry.level === 'error')
  {
    return 'error'
  }
  return entry.level === 'warn' ? 'warning' : 'info'
}

/**
 * The part of the app that wrote a line. Structure decides first: a command line, a child process's output, and any
 * line the job engine stamped (a job, a run, or a kind, which main's child loggers put on every line). The rest are
 * the main process's own lines, told apart by the prefixes their writers use.
 */
export function logSource(entry: LogEntry): LogSource
{
  if (commandText(entry) !== null)
  {
    return 'commands'
  }
  if (entry.level === 'ffmpeg')
  {
    return 'output'
  }
  if (entry.kind === 'stderr')
  {
    return 'output'
  }
  const message = entry.message
  if (entry.jobId !== undefined || entry.runId !== undefined || entry.kind !== undefined || JOB_ENGINE.test(message))
  {
    return 'jobs'
  }
  if (GPU.test(message))
  {
    return 'gpu'
  }
  if (EDITOR.test(message))
  {
    return 'editor'
  }
  if (PLAYER.test(message))
  {
    return 'player'
  }
  if (UPDATES.test(message))
  {
    return 'updates'
  }
  if (ONLINE.test(message))
  {
    return 'online'
  }
  return FFMPEG_SETUP.test(message) ? 'ffmpeg' : 'app'
}

/** The message as the view shows it: a command line alone, or the message without a leading tag the Source column already says. */
export function shownMessage(entry: LogEntry): string
{
  const command = commandText(entry)
  if (command !== null)
  {
    return command
  }
  const tag = SOURCE_TAGS.find((candidate) => entry.message.startsWith(candidate))
  return tag === undefined ? entry.message : entry.message.slice(tag.length)
}

/**
 * The command line a line carries, or null: the engine's command kind, the runner's "[CMD]" tag, or the "> " the job
 * engine's runners put before the FFmpeg command they run.
 */
export function commandText(entry: LogEntry): string | null
{
  if (entry.kind === 'cmd')
  {
    return entry.message
  }
  if (entry.level === 'ffmpeg' && entry.message.startsWith(COMMAND_TAG))
  {
    return entry.message.slice(COMMAND_TAG.length)
  }
  if ((entry.jobId !== undefined || entry.kind !== undefined) && entry.message.startsWith(ENGINE_COMMAND))
  {
    return entry.message.slice(ENGINE_COMMAND.length)
  }
  return null
}

/** The first line of the shown message, which is what a row shows. */
export function firstLine(entry: LogEntry): string
{
  const text = shownMessage(entry)
  const end = text.indexOf('\n')
  return end < 0 ? text : text.slice(0, end)
}

function lineCount(text: string | undefined): number
{
  if (text === undefined || text === '')
  {
    return 0
  }
  return text.replace(/\n+$/, '').split('\n').length
}

/** How many lines the row leaves out: the message's later lines and every line of its details. */
export function hiddenLineCount(entry: LogEntry): number
{
  return Math.max(0, lineCount(shownMessage(entry)) - 1) + lineCount(entry.details)
}

/** Whether a line reads as raw program text, set in mono: a command, or a child process's own output line. */
export function isRawText(entry: LogEntry): boolean
{
  return commandText(entry) !== null || (logSource(entry) === 'output' && (entry.details === undefined || entry.details === ''))
}

/** Whether a row shows less than the line holds, so the details are worth opening. */
export function hasMore(entry: LogEntry): boolean
{
  return hiddenLineCount(entry) > 0 || shownMessage(entry).length > LONG_LINE_CHARS || commandText(entry) !== null
}

const MAIN_STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/

/** When a line was written. Main stamps UTC without a zone ("2026-10-20 21:25:59.123"); null when it cannot be read. */
export function logTime(entry: Pick<LogEntry, 'timestamp'>): Date | null
{
  const m = MAIN_STAMP.exec(entry.timestamp.trim())
  if (m)
  {
    const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'))
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms))
  }
  const parsed = Date.parse(entry.timestamp)
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

function two(n: number): string
{
  return String(n).padStart(2, '0')
}

/** The local clock time a row shows: "21:25:59"; the stamp as written when it cannot be read. */
export function clockTime(entry: Pick<LogEntry, 'timestamp'>): string
{
  const time = logTime(entry)
  return time === null ? entry.timestamp : `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`
}

/** The full local stamp copied text carries: "2026-10-20 21:25:59.123". */
export function fullStamp(entry: Pick<LogEntry, 'timestamp'>): string
{
  const time = logTime(entry)
  if (time === null)
  {
    return entry.timestamp
  }
  const ms = String(time.getMilliseconds()).padStart(3, '0')
  return `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${clockTime(entry)}.${ms}`
}

/** The row id the grid keys a line by. */
export function rowId(entry: LogEntry, index: number): string
{
  return entry.id === undefined ? `local-${index}` : String(entry.id)
}

/** The chip text of a filter: the catalog number for a job, the batch label for a run. */
export function logFilterLabel(filter: LogFilter): string
{
  return 'jobId' in filter ? filter.jobId : formatRunLabel(filter.runId as RunId)
}

/** Whether an entry belongs to the job or run a filter names; every entry matches no filter. */
export function matchesLogFilter(entry: LogEntry, filter: LogFilter | null): boolean
{
  if (filter === null)
  {
    return true
  }
  return 'jobId' in filter ? entry.jobId === filter.jobId : entry.runId === filter.runId
}

/**
 * The entries a filtered view shows: what main returned for the filter, then the live entries that arrived after its
 * newest line. Without a fetched list, the live entries that match.
 */
export function mergeLogEntries(fetched: readonly LogEntry[] | null, live: readonly LogEntry[], filter: LogFilter | null): LogEntry[]
{
  const matching = filter === null ? [...live] : live.filter((entry) => matchesLogFilter(entry, filter))
  if (fetched === null)
  {
    return matching
  }
  let lastId = 0
  for (const entry of fetched)
  {
    if (entry.id !== undefined && entry.id > lastId)
    {
      lastId = entry.id
    }
  }
  return [...fetched, ...matching.filter((entry) => entry.id !== undefined && entry.id > lastId)]
}

/** What narrows the lines after the job or run filter. */
export interface LogNarrowing
{
  level: LevelFilter
  hiddenSources: ReadonlySet<LogSource>
  search: string
}

/** No narrowing: every level and source, no search. */
export const NO_NARROWING: LogNarrowing = { level: 'all', hiddenSources: new Set(), search: '' }

/** Whether anything narrows the lines. */
export function isNarrowed(narrowing: LogNarrowing): boolean
{
  return narrowing.level !== 'all' || narrowing.hiddenSources.size > 0 || narrowing.search.trim() !== ''
}

const haystacks = new WeakMap<LogEntry, string>()

/** The lowercase text a search looks through: the message, the details, the job, and the batch. */
function haystack(entry: LogEntry): string
{
  let text = haystacks.get(entry)
  if (text === undefined)
  {
    text = [entry.message, entry.details ?? '', entry.jobId ?? '', entry.runId ?? ''].join('\n').toLowerCase()
    haystacks.set(entry, text)
  }
  return text
}

/** The lines the level, the hidden sources, and a case-insensitive search keep. */
export function visibleLogEntries(entries: readonly LogEntry[], narrowing: LogNarrowing): LogEntry[]
{
  const needle = narrowing.search.trim().toLowerCase()
  return entries.filter((entry) =>
  {
    if (narrowing.level !== 'all' && levelGroup(entry) !== narrowing.level)
    {
      return false
    }
    if (narrowing.hiddenSources.size > 0 && narrowing.hiddenSources.has(logSource(entry)))
    {
      return false
    }
    return needle === '' || haystack(entry).includes(needle)
  })
}

/** How many lines each source has, for the Sources menu. */
export function sourceCounts(entries: readonly LogEntry[]): Map<LogSource, number>
{
  const counts = new Map<LogSource, number>()
  for (const entry of entries)
  {
    const source = logSource(entry)
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  return counts
}

/** The Sources button's text: "All sources", or "3 of 7 sources" while some are hidden. */
export function sourcesButtonText(present: readonly LogSource[], hidden: ReadonlySet<LogSource>): string
{
  const shown = present.filter((source) => !hidden.has(source)).length
  if (hidden.size === 0 || shown === present.length)
  {
    return LOG_WORDS.allSources
  }
  return `${shown} of ${countOf(present.length, 'source')}`
}

/** The line under the title: what the view holds, or how much of it shows. */
export function summaryLine(scope: readonly LogEntry[], shown: number, filter: LogFilter | null): string
{
  const label = filter === null ? null : logFilterLabel(filter)
  if (scope.length === 0)
  {
    return label === null ? 'No lines yet' : `No lines for ${label} yet`
  }
  const lines = `${countOf(scope.length, 'line')}${label === null ? '' : ` for ${label}`}`
  if (shown !== scope.length)
  {
    return `${formatCount(shown)} of ${lines} shown`
  }
  let commands = 0
  let warnings = 0
  let errors = 0
  for (const entry of scope)
  {
    if (commandText(entry) !== null)
    {
      commands++
    }
    const group = levelGroup(entry)
    if (group === 'warning')
    {
      warnings++
    }
    else if (group === 'error')
    {
      errors++
    }
  }
  const parts = [lines]
  if (commands > 0)
  {
    parts.push(countOf(commands, 'FFmpeg command'))
  }
  if (warnings > 0)
  {
    parts.push(countOf(warnings, 'warning'))
  }
  if (errors > 0)
  {
    parts.push(countOf(errors, 'error'))
  }
  return parts.join(', ')
}

/** The empty state's words when nothing shows. */
export function emptyWords(scope: number, filter: LogFilter | null): { title: string, body: string, narrowed: boolean }
{
  if (scope > 0)
  {
    return { title: LOG_WORDS.noMatchTitle, body: LOG_WORDS.noMatchBody, narrowed: true }
  }
  if (filter !== null)
  {
    const label = logFilterLabel(filter)
    return { title: `No lines for ${label} yet`, body: `Lines for ${label} appear here as it runs.`, narrowed: false }
  }
  return { title: LOG_WORDS.emptyTitle, body: LOG_WORDS.emptyBody, narrowed: false }
}

/**
 * Lines as plain text for the clipboard, one per entry with its local stamp, level, source, and job, the columns
 * padded to line up; a line's later lines and its details follow, indented.
 */
export function formatLogLines(entries: readonly LogEntry[]): string
{
  const levelWidth = Math.max(...Object.values(LEVEL_LABELS).map((label) => label.length))
  const sourceWidth = entries.reduce((width, entry) => Math.max(width, SOURCE_LABELS[logSource(entry)].length), 0)
  return entries.map((entry) =>
  {
    const [head, ...rest] = shownMessage(entry).split('\n')
    const job = entry.jobId === undefined ? '' : `${entry.jobId}  `
    const parts = [
      `${fullStamp(entry)}  ${LEVEL_LABELS[levelGroup(entry)].padEnd(levelWidth)}  ${SOURCE_LABELS[logSource(entry)].padEnd(sourceWidth)}  ${job}${head}`.trimEnd()
    ]
    for (const line of [...rest, ...(entry.details === undefined || entry.details === '' ? [] : entry.details.replace(/\n+$/, '').split('\n'))])
    {
      parts.push(`    ${line}`.trimEnd())
    }
    return parts.join('\n')
  }).join('\n')
}

/** "Copied 3 lines." */
export function copiedText(count: number): string
{
  return `Copied ${countOf(count, 'line')}.`
}
