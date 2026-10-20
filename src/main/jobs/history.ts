/**
 * Run history under `<userData>/jobs/`: one `runs/<RunId>.jsonl` file of tagged lines per run, the run index in
 * `runs/index.json`, the retention that keeps both bounded, search across kept runs, the checks a rerun makes before
 * it adds jobs, and the CSV and JSON reports.
 */

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { renderMessage, type MessageRef } from '../../shared/audio/messages'
import type { GainPlan, StreamVerdict, VerifiedStream } from '../../shared/audio/types'
import { containerLabel, describeRecipe, isEdited, operationLabel, presetLabel, type PresetLookup } from '../../shared/jobs/describe'
import { formatRunLabel, parseCatalog, parseRunId, type JobId, type RunId } from '../../shared/jobs/ids'
import type
{
  AlbumSummary, BatchSummary, FrozenPolicy, HistoryLine, HistoryRecord, HistoryRef, Job, Placement, RecipeOutcome,
  RunIndexEntry, Verdict
} from '../../shared/jobs/types'
import type { JobCommandMap, RunSearchMatch } from '../../shared/jobs/contract'
import type { Recipe } from '../../shared/jobs/recipes'
import type { PersistenceIO } from './deps'
import { ERROR_TAIL_BYTES, tailAtLineBoundary } from './log'
import { HISTORY_MIGRATIONS, jsonLine, migrate, parseJsonLines, readJson, writeJsonAtomic, type JobsPaths } from './persistence'

const MB = 1000 * 1000

/** How much history is kept: the newest runs, and byte budgets for history files and attempt logs. */
export interface RetentionLimits
{
  runs: number
  historyBytes: number
  logBytes: number
}

/** Newest 200 runs, at most 200 MB of history and 256 MB of logs. */
export const RETENTION: Readonly<RetentionLimits> = { runs: 200, historyBytes: 200 * MB, logBytes: 256 * MB }

/** `runs:get` pages hold at most this many records. */
export const RUN_PAGE_LIMIT = 500

/** The file facts history needs beyond `PersistenceIO`. */
export interface HistoryFs
{
  /** Null when nothing is at the path. */
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean } | null>
  /** Removes a file or folder and everything under it; a missing path is not an error. */
  removeTree(path: string): Promise<void>
}

function codeOf(err: unknown): string | null
{
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : null
}

/** The real `HistoryFs` over `node:fs`. */
export function createNodeHistoryFs(): HistoryFs
{
  return {
    async stat(path)
    {
      try
      {
        const info = await stat(path)
        return { size: info.size, mtimeMs: info.mtimeMs, isFile: info.isFile() }
      }
      catch (err)
      {
        if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR')
        {
          return null
        }
        throw err
      }
    },
    removeTree: (path) => rm(path, { recursive: true, force: true })
  }
}

/** The states a history record can carry. */
export type RecordState = HistoryRecord['state']

const RECORD_STATES: readonly RecordState[] = ['done', 'failed', 'canceled', 'skipped', 'interrupted', 'held']

/** Whether a job's state is one a history record is written for. */
export function isRecordState(state: Job['state']): state is RecordState
{
  return (RECORD_STATES as readonly string[]).includes(state)
}

/**
 * The self-contained record of a job's finished attempt: plan, measurement, verification, result, error, warnings,
 * and earlier attempts, so a terminal job's detail needs nothing else.
 */
export function buildHistoryRecord(job: Job, opts: { recipeLabel: string; logFile: string | null; endedAt: number }): HistoryRecord
{
  if (!job.runId || !isRecordState(job.state))
  {
    throw new Error(`Job ${job.id} has no finished attempt to record`)
  }
  const result = job.result
  const output = result
    ? { path: result.outputPath, bytes: result.outputBytes, container: result.container }
    : job.hold
      ? { path: job.hold.outputPath, bytes: 0, container: job.plan?.output.container ?? '' }
      : null
  return {
    type: 'record',
    schema: 1,
    runId: job.runId,
    jobId: job.id,
    attempt: job.attempt,
    op: job.recipe.kind,
    source: { path: job.source.path, size: job.source.size, mtimeMs: job.source.mtimeMs },
    recipe: job.recipe,
    recipeLabel: opts.recipeLabel,
    state: job.state,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? opts.endedAt,
    output,
    placement: result?.placement ?? null,
    plan: job.plan,
    measurement: job.measurement,
    verification: job.verification,
    result,
    error: job.error,
    warnings: result?.warnings ?? job.warnings,
    attempts: job.attempts,
    rerunOf: job.rerunOf,
    logFile: opts.logFile
  }
}

/** Whether a parsed line is a history record. */
export function isHistoryRecord(value: unknown): value is HistoryRecord
{
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'record'
}

/** Whether a parsed line is the run's summary line. */
export function isSummaryLine(value: unknown): value is Extract<HistoryLine, { type: 'summary' }>
{
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'summary'
}

/** A run file's lines sorted by their tags: the records in file order and the summary, wherever it sits. */
export interface ParsedRun
{
  records: HistoryRecord[]
  summary: BatchSummary | null
  /** Lines that did not parse, were not tagged, or carry a newer schema. */
  skipped: number
}

/** Reads a run file's text by tag; position never matters, so a decision record after the summary is a record. */
export function parseRunText(text: string): ParsedRun
{
  const lines = parseJsonLines(text)
  const records: HistoryRecord[] = []
  let summary: BatchSummary | null = null
  let skipped = lines.skipped + (lines.torn ? 1 : 0)
  for (const value of lines.values)
  {
    const migrated = migrate(value, HISTORY_MIGRATIONS)
    if (migrated.status !== 'ok')
    {
      skipped += 1
      continue
    }
    const line = migrated.file
    if (isHistoryRecord(line))
    {
      records.push(line)
    }
    else if (isSummaryLine(line))
    {
      summary = line.summary
    }
    else
    {
      skipped += 1
    }
  }
  return { records, summary, skipped }
}

/**
 * Each job's current record in a run: the highest attempt, and for the same attempt the later line, so a held job's
 * decision record replaces its held record. Returned in the order the jobs first appear.
 */
export function latestRecords(records: readonly HistoryRecord[]): HistoryRecord[]
{
  const latest = new Map<JobId, HistoryRecord>()
  for (const record of records)
  {
    const current = latest.get(record.jobId)
    if (!current || record.attempt >= current.attempt)
    {
      latest.set(record.jobId, record)
    }
  }
  return [...latest.values()]
}

/** A record's verdict: the verification's, or failed for a failed attempt without one. */
export function recordVerdict(record: HistoryRecord): Verdict | null
{
  if (record.verification)
  {
    return record.verification.verdict
  }
  return record.state === 'failed' ? 'failed' : null
}

function isVerified(verdict: Verdict | null): boolean
{
  return verdict === 'verified' || verdict === 'verified-below-target' || verdict === 'passthrough'
}

/** Whether a record counts as returned: failed, interrupted, held, or done but placed outside tolerance. */
export function isReturned(record: HistoryRecord): boolean
{
  return record.state === 'failed' || record.state === 'interrupted' || record.state === 'held'
    || (record.state === 'done' && record.verification?.verdict === 'outside-tolerance')
}

/** Counts in the page's words over each job's current record. */
export function countRecords(records: readonly HistoryRecord[]): BatchSummary['counts']
{
  const counts: BatchSummary['counts'] =
  {
    total: 0, done: 0, verified: 0, reachable: 0, outsideTolerance: 0,
    failed: 0, canceled: 0, skipped: 0, held: 0, interrupted: 0, returned: 0
  }
  for (const record of latestRecords(records))
  {
    const verdict = record.verification?.verdict ?? null
    counts.total += 1
    counts[record.state] += 1
    if (record.state === 'done' && isVerified(verdict))
    {
      counts.verified += 1
      if (verdict === 'verified-below-target')
      {
        counts.reachable += 1
      }
    }
    if ((record.state === 'done' || record.state === 'held') && verdict === 'outside-tolerance')
    {
      counts.outsideTolerance += 1
    }
    if (isReturned(record))
    {
      counts.returned += 1
    }
  }
  return counts
}

/** The volume a path lies on as the page names it: "D:" for a drive, the share for a UNC path, else "/". */
export function volumeOf(path: string): string
{
  const drive = /^([A-Za-z]):/.exec(path)
  if (drive)
  {
    return `${drive[1].toUpperCase()}:`
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(path)
  return unc ? `\\\\${unc[1]}\\${unc[2]}` : '/'
}

function hasOutput(record: HistoryRecord): boolean
{
  return record.state === 'done' || record.state === 'held'
}

function gainPlans(record: HistoryRecord): GainPlan[]
{
  return (record.measurement?.streams ?? []).flatMap((stream) => stream.plan ? [stream.plan] : [])
}

function verifiedStreams(record: HistoryRecord): VerifiedStream[]
{
  return (record.verification?.audio ?? []).flatMap((stream) => stream.verified ? [stream.verified] : [])
}

function streamVerdicts(record: HistoryRecord): StreamVerdict[]
{
  return (record.verification?.audio ?? []).map((stream) => stream.verdict)
}

function maxOf(values: readonly number[]): number | null
{
  return values.length === 0 ? null : Math.max(...values)
}

function minOf(values: readonly number[]): number | null
{
  return values.length === 0 ? null : Math.min(...values)
}

function loudnessOutcome(records: readonly HistoryRecord[]): NonNullable<RecipeOutcome['loudness']>
{
  const measured = records.filter(hasOutput)
  const stamps = measured.flatMap((record) => record.result?.stamp.loudness ? [record.result.stamp.loudness] : [])
  const checks: NonNullable<RecipeOutcome['loudness']>['checks'] = []
  for (const loudness of stamps)
  {
    let check = checks.find((c) => c.checkClass === loudness.checkClass && c.check === loudness.check)
    if (!check)
    {
      check = { checkClass: loudness.checkClass, check: loudness.check, jobs: 0, within: 0 }
      checks.push(check)
    }
    check.jobs += 1
    check.within += loudness.status === 'within' ? 1 : 0
  }
  checks.sort((a, b) => a.checkClass.localeCompare(b.checkClass) || a.check - b.check)
  const streams = measured.flatMap(verifiedStreams)
  const levels = streams.flatMap((s) => s.integratedLufs === null ? [] : [s.integratedLufs])
  const peaks = streams.flatMap((s) => s.truePeakDbtp === null ? [] : [s.truePeakDbtp])
  const limiting = measured.map((record) => maxOf(gainPlans(record).map((plan) => plan.limitingDb)) ?? 0)
  const limited = limiting.filter((db) => db > 0)
  const reachable = new Set<number>()
  for (const verdict of measured.flatMap(streamVerdicts))
  {
    if (verdict.loudness.reference === 'reachable' && verdict.loudness.referenceLufs !== null)
    {
      reachable.add(verdict.loudness.referenceLufs)
    }
  }
  const targetPlan = records.flatMap(gainPlans).find((plan) => plan.targetLufs !== null && plan.mode !== 'passthrough')
  const targetStamp = stamps.find((s) => s.reference === 'target' && s.referenceLufs !== null)
  return {
    unit: stamps[0]?.unit ?? 'LUFS',
    targetLufs: records[0].op === 'normalize' ? targetPlan?.targetLufs ?? targetStamp?.referenceLufs ?? null : null,
    deviationUnit: stamps[0]?.deviationUnit ?? 'LU',
    checks,
    minLufs: minOf(levels),
    maxLufs: maxOf(levels),
    streams: levels.length,
    maxTruePeakDbtp: maxOf(peaks),
    limitedJobs: limited.length,
    maxLimitingDb: maxOf(limited),
    reachableLevels: [...reachable].sort((a, b) => a - b)
  }
}

function sizeOutcome(records: readonly HistoryRecord[]): RecipeOutcome['size']
{
  const recipe = records[0].recipe
  if (recipe.kind !== 'compress' || recipe.target.mode !== 'size')
  {
    return null
  }
  const sized = records.filter(hasOutput).flatMap((record) => record.result?.stamp.size ? [record.result.stamp.size] : [])
  return {
    targetBytes: recipe.target.targetBytes,
    jobs: sized.length,
    within: sized.filter((size) => size.status === 'within').length
  }
}

/**
 * The run's outcomes per recipe, grouped by `describeRecipe` so edited recipes group under their own label, in the
 * order the recipes first appear.
 */
export function recipeOutcomes(records: readonly HistoryRecord[]): RecipeOutcome[]
{
  const groups = new Map<string, HistoryRecord[]>()
  for (const record of latestRecords(records))
  {
    const label = describeRecipe(record.recipe)
    const group = groups.get(label)
    if (group)
    {
      group.push(record)
    }
    else
    {
      groups.set(label, [record])
    }
  }
  return [...groups].map(([label, group]) =>
  {
    const counts = countRecords(group)
    const recipe = group[0].recipe
    return {
      op: recipe.kind,
      label,
      presetId: recipe.presetId,
      userPresetId: recipe.userPreset?.id ?? null,
      jobs: counts.total,
      verified: counts.verified,
      reachable: counts.reachable,
      outsideTolerance: counts.outsideTolerance,
      returned: counts.returned,
      loudness: recipe.kind === 'normalize' || recipe.kind === 'boost' ? loudnessOutcome(group) : null,
      size: sizeOutcome(group)
    }
  })
}

/** Each album group once: its anchor and the gain every member shares. */
export function albumSummaries(records: readonly HistoryRecord[]): AlbumSummary[]
{
  const albums = new Map<string, AlbumSummary>()
  for (const record of latestRecords(records))
  {
    const album = record.measurement?.album
    if (album && !albums.has(album.groupId))
    {
      albums.set(album.groupId, album)
    }
  }
  return [...albums.values()]
}

/** What happened to originals and to files outputs displaced. */
export function displacedFiles(records: readonly HistoryRecord[]): Pick<BatchSummary, 'originals' | 'previous'>
{
  const originals: BatchSummary['originals'] = { trashed: 0, kept: 0, volumes: [] }
  const previous: BatchSummary['previous'] = { trashed: 0, kept: 0 }
  for (const record of latestRecords(records))
  {
    const placement = record.placement
    if (placement?.kind === 'replaced-original')
    {
      if (placement.original.status === 'trashed')
      {
        originals.trashed += 1
        const volume = volumeOf(record.source.path)
        const entry = originals.volumes.find((v) => v.volume === volume)
        if (entry)
        {
          entry.trashed += 1
        }
        else
        {
          originals.volumes.push({ volume, trashed: 1 })
        }
      }
      else
      {
        originals.kept += 1
      }
    }
    else if (placement?.kind === 'overwrote')
    {
      previous[placement.previous.status] += 1
    }
  }
  return { originals, previous }
}

/** Bytes read and written and the media duration of every job that produced an output. */
export function runTotals(records: readonly HistoryRecord[]): Pick<BatchSummary, 'bytes' | 'mediaSec'>
{
  const bytes = { input: 0, output: 0 }
  let mediaSec = 0
  for (const record of latestRecords(records).filter(hasOutput))
  {
    bytes.input += record.result?.inputBytes ?? record.source.size
    bytes.output += record.output?.bytes ?? 0
    mediaSec += record.result?.durationSec ?? 0
  }
  return { bytes, mediaSec }
}

/** What the engine knows about a run beyond its records. */
export interface RunFacts
{
  runId: RunId
  startedAt: number
  endedAt: number
  /** Defaults to the wall time from start to end. */
  elapsedMs?: number
  endedBy: BatchSummary['endedBy']
  interruptions: number
  policy: FrozenPolicy
  ffmpeg: BatchSummary['ffmpeg']
  appVersion: string
}

/** The finished run's summary from its records. */
export function buildBatchSummary(facts: RunFacts, records: readonly HistoryRecord[]): BatchSummary
{
  const latest = latestRecords(records)
  return {
    runId: facts.runId,
    startedAt: facts.startedAt,
    endedAt: facts.endedAt,
    elapsedMs: facts.elapsedMs ?? Math.max(0, facts.endedAt - facts.startedAt),
    endedBy: facts.endedBy,
    interruptions: facts.interruptions,
    counts: countRecords(latest),
    ...runTotals(latest),
    ...displacedFiles(latest),
    recipes: recipeOutcomes(latest),
    albums: albumSummaries(latest),
    failures: latest.flatMap((record) => record.state === 'failed' && record.error
      ? [{ jobId: record.jobId, code: record.error.code, short: record.error.short, message: record.error.message }]
      : []),
    policy: facts.policy,
    ffmpeg: facts.ffmpeg,
    appVersion: facts.appVersion
  }
}

/** The index entry of a run that has just started. */
export function openIndexEntry(runId: RunId, startedAt: number): RunIndexEntry
{
  return { runId, startedAt, endedAt: null, endedBy: null, counts: countRecords([]), bytes: { input: 0, output: 0 } }
}

/** The index entry of a run from its records, with the summary's end when it has one. */
export function indexEntryOf(runId: RunId, startedAt: number, summary: BatchSummary | null, records: readonly HistoryRecord[]): RunIndexEntry
{
  return {
    runId,
    startedAt: summary?.startedAt ?? startedAt,
    endedAt: summary?.endedAt ?? null,
    endedBy: summary?.endedBy ?? null,
    counts: countRecords(records),
    bytes: runTotals(records).bytes
  }
}

/** One `runs:search` match. */
export type SearchMatch = RunSearchMatch

/** A `runs:search` page. */
export type SearchResult = JobCommandMap['searchRuns']['res']

/** What a rerun may add, and the sources it reports instead. */
export interface RerunCheck
{
  /** Sources to add as new pending jobs, in run order, with the recipes they ran with. */
  add: Array<{ path: string; recipe: Recipe; rerunOf: { runId: RunId; jobId: JobId } }>
  missing: JobCommandMap['rerun']['res']['missing']
  holdsOutput: JobCommandMap['rerun']['res']['holdsOutput']
}

/** A file's name from a Windows or POSIX path. */
export function fileName(path: string): string
{
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** The folder of a Windows or POSIX path. */
export function folderOf(path: string): string
{
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut)
}

function isWindowsPath(path: string): boolean
{
  return /^[A-Za-z]:/.test(path) || /^[\\/]{2}/.test(path)
}

/** Whether two recorded paths name the same file; Windows paths compare without case and with either separator. */
export function samePath(a: string, b: string): boolean
{
  if (isWindowsPath(a) && isWindowsPath(b))
  {
    return a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase()
  }
  return a === b
}

/**
 * A search query as a record test: a case-insensitive part of the source name, path, or catalog number, and for a
 * number ("131", "mm-131", "MM-0131") the job with that catalog sequence. Null for an empty query.
 */
export function recordMatcher(query: string): ((record: HistoryRecord) => boolean) | null
{
  const text = query.trim().replace(/^["']+|["']+$/g, '').toLowerCase()
  if (text === '')
  {
    return null
  }
  const number = /^(?:mm-?)?(\d+)$/.exec(text)
  const seq = number ? Number(number[1]) : null
  return (record) => record.source.path.toLowerCase().includes(text)
    || fileName(record.source.path).toLowerCase().includes(text)
    || record.jobId.toLowerCase().includes(text)
    || (seq !== null && parseCatalog(record.jobId) === seq)
}

function attemptsOf(records: readonly HistoryRecord[], jobId: JobId): HistoryRecord[]
{
  return records.filter((record) => record.jobId === jobId)
}

function newestRecordFirst(a: HistoryRecord, b: HistoryRecord): number
{
  return b.endedAt - a.endedAt || (parseCatalog(b.jobId) ?? 0) - (parseCatalog(a.jobId) ?? 0)
}

function searchMatch(record: HistoryRecord): SearchMatch
{
  return {
    runId: record.runId,
    jobId: record.jobId,
    attempt: record.attempt,
    sourceName: fileName(record.source.path),
    sourcePath: record.source.path,
    state: record.state,
    verdict: recordVerdict(record),
    endedAt: record.endedAt,
    stamp: record.result?.stamp ?? null
  }
}

/** Whether placing the output sent the original to the bin. */
export function originalTrashed(placement: Placement | null): boolean
{
  return placement?.kind === 'replaced-original' && placement.original.status === 'trashed'
}

/**
 * Whether the file now at a record's source path is that job's own output: the output went to the source path (a
 * Replace run that kept the extension) and the file has the output's size. Records carry no output modification
 * time, so a file that still matches the recorded source's size and time is taken to be the source.
 */
export function holdsOwnOutput(record: HistoryRecord, file: { size: number; mtimeMs: number }): boolean
{
  if (record.state !== 'done' || !record.output || !samePath(record.output.path, record.source.path))
  {
    return false
  }
  const unchangedSource = file.size === record.source.size && file.mtimeMs === record.source.mtimeMs
  return file.size === record.output.bytes && !unchangedSource
}

/** The CSV report's columns, in order. */
export const REPORT_COLUMNS = [
  'Batch', 'Job', 'Attempt', 'Status', 'Verdict', 'Source', 'Source size', 'Source duration', 'Output', 'Output size',
  'Placement', 'Original', 'Operation', 'Preset', 'Recipe', 'Edited', 'Container', 'Video encoder', 'Audio encoders',
  'GPU', 'Streams kept', 'Streams not kept', 'Started', 'Finished', 'Elapsed', 'Integrated before', 'Range before',
  'True peak before', 'Gain planned', 'Plan mode', 'Peak limiting planned', 'Integrated after', 'Range after',
  'True peak after', 'Sample peak after', 'Target', 'Standard tolerance', 'App check', 'Verification', 'Warnings',
  'Error', 'Exit code', 'Command', 'Output policy', 'FFmpeg build', 'molexMedia version'
] as const

/** A report column's name. */
export type ReportColumn = typeof REPORT_COLUMNS[number]

/** One report row: a job's current record and the summary of the run it ran in, null while that run is open. */
export interface ReportRow
{
  record: HistoryRecord
  summary: BatchSummary | null
  /** Every record line of the job in its run, earlier attempts first. */
  attempts: HistoryRecord[]
}

/** The Verdict column: "verified", "verified, reachable level", "outside tolerance", or "failed". */
export function verdictWords(verdict: Verdict | null): string
{
  switch (verdict)
  {
    case 'verified':
    case 'passthrough':
      return 'verified'
    case 'verified-below-target':
      return 'verified, reachable level'
    case 'outside-tolerance':
      return 'outside tolerance'
    case 'failed':
      return 'failed'
    default:
      return ''
  }
}

/** The Status column. */
export function statusWords(state: RecordState): string
{
  return state === 'held' ? 'waiting for a decision' : state
}

/** Where a displaced file on a path's volume went when it went to the OS bin. */
export function binName(path: string): string
{
  return isWindowsPath(path) ? `Recycle Bin on ${volumeOf(path)}` : 'Trash'
}

/** The Original column: "Recycle Bin on D:", "kept as {path}", or "not touched". */
export function originalWords(record: HistoryRecord): string
{
  const placement = record.placement
  if (placement?.kind !== 'replaced-original')
  {
    return 'not touched'
  }
  return placement.original.status === 'trashed' ? binName(record.source.path) : `kept as ${placement.original.path}`
}

/** The Placement column. */
export function placementWords(placement: Placement | null, outputPath: string): string
{
  switch (placement?.kind)
  {
    case 'new':
      return 'new file'
    case 'renamed':
      return `renamed, ${fileName(placement.planned)} was taken`
    case 'overwrote':
      return placement.previous.status === 'trashed'
        ? `overwrote a file, sent to the ${binName(outputPath)}`
        : `overwrote a file, kept as ${placement.previous.path}`
    case 'replaced-original':
      return 'replaced the original'
    default:
      return ''
  }
}

const MODE_WORDS: Readonly<Record<GainPlan['mode'], string>> =
{
  'linear': 'linear',
  'peak-limited': 'peak limited',
  'reachable-linear': 'reachable level, linear',
  'reachable-limited': 'reachable level, peak limited',
  'passthrough': 'passthrough'
}

const FFMPEG_SOURCE_WORDS: Readonly<Record<BatchSummary['ffmpeg']['source'], string>> = { bundled: 'pinned', path: 'PATH', custom: 'custom' }

/** The Output policy column. */
export function policyWords(policy: FrozenPolicy): string
{
  const destination = policy.destination
  const where = destination.mode === 'folder'
    ? `Folder ${destination.folder}`
    : destination.mode === 'next-to-source' ? 'Next to source' : 'Replace originals'
  return `${where}, template ${policy.template}, existing files: ${policy.conflict}, displaced files: ${policy.displaced === 'trash' ? 'to the bin' : 'kept'}`
}

/** The FFmpeg build column: the version and where it came from. */
export function ffmpegWords(ffmpeg: BatchSummary['ffmpeg']): string
{
  return `${ffmpeg.version} (${FFMPEG_SOURCE_WORDS[ffmpeg.source]})`
}

function fixed(value: number | null | undefined, decimals = 1): string
{
  if (value === null || value === undefined || !Number.isFinite(value))
  {
    return ''
  }
  const text = value.toFixed(decimals)
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text
}

function seconds(value: number | null | undefined): string
{
  return value === null || value === undefined || !Number.isFinite(value) ? '' : String(Number(value.toFixed(3)))
}

function stated(value: number): string
{
  return String(Number(value.toFixed(1)))
}

function timestamp(ms: number | null): string
{
  return ms === null ? '' : new Date(ms).toISOString()
}

function verdictAudioIndex(record: HistoryRecord): number | null
{
  return record.result?.stamp.verdictStream ?? record.verification?.audio?.[0]?.verdict.audioIndex ?? null
}

function primaryStreams(record: HistoryRecord): { before: GainPlan | null; stats: { integratedLufs: number | null; loudnessRangeLu: number | null; truePeakDbtp: number | null } | null; after: VerifiedStream | null; verdict: StreamVerdict | null }
{
  const index = verdictAudioIndex(record)
  const measured = record.measurement?.streams ?? []
  const stream = measured.find((s) => s.measurement.audioIndex === index) ?? measured[0]
  const audio = record.verification?.audio ?? []
  const verified = audio.find((a) => a.verdict.audioIndex === index) ?? audio[0]
  return {
    before: stream?.plan ?? null,
    stats: stream?.measurement.stats ?? null,
    after: verified?.verified ?? null,
    verdict: verified?.verdict ?? null
  }
}

function gpuWords(record: HistoryRecord): string
{
  const video = record.plan?.video
  if (!video)
  {
    return ''
  }
  if (video.gpu === null)
  {
    return 'no'
  }
  return record.warnings.some((w) => w.code === 'ran-on-cpu') ? `no, ran on the CPU instead of ${video.gpu}` : video.gpu
}

function decodeWords(record: HistoryRecord): string
{
  const decode = record.result?.stamp.decode ?? record.verification?.media?.decode ?? (record.verification?.audio ? 'full' : null)
  return decode === null ? '' : `${decode} decode`
}

function targetWords(record: HistoryRecord, plan: GainPlan | null): string
{
  const loudness = record.result?.stamp.loudness ?? null
  const target = record.op === 'normalize'
    ? plan?.targetLufs ?? (loudness?.reference === 'target' ? loudness.referenceLufs : null)
    : null
  return target === null || target === undefined ? '' : `${fixed(target)} ${loudness?.unit ?? 'LUFS'}`
}

function appCheckWords(record: HistoryRecord, verdict: StreamVerdict | null): string
{
  const loudness = record.result?.stamp.loudness
  if (loudness)
  {
    return `±${loudness.check.toFixed(1)} ${loudness.deviationUnit}`
  }
  return verdict ? `±${verdict.loudness.toleranceLu.toFixed(1)} LU` : ''
}

/** A report row's values by column, worded as the page words them. */
export function reportValues(row: ReportRow, lookup: PresetLookup): Record<ReportColumn, string>
{
  const { record, summary } = row
  const plan = record.plan
  const streams = primaryStreams(record)
  const tolerance = streams.verdict?.loudness.standardTolerance ?? null
  const container = record.output?.container ?? plan?.output.container ?? ''
  const elapsedMs = record.result?.elapsedMs ?? (record.startedAt === null ? null : record.endedAt - record.startedAt)
  return {
    'Batch': formatRunLabel(record.runId),
    'Job': record.jobId,
    'Attempt': String(record.attempt),
    'Status': statusWords(record.state),
    'Verdict': verdictWords(recordVerdict(record)),
    'Source': record.source.path,
    'Source size': String(record.source.size),
    'Source duration': seconds(record.verification?.media?.expectedDurationSec ?? record.result?.durationSec),
    'Output': record.output?.path ?? '',
    'Output size': record.output ? String(record.output.bytes) : '',
    'Placement': placementWords(record.placement, record.output?.path ?? record.source.path),
    'Original': originalWords(record),
    'Operation': operationLabel(record.op),
    'Preset': presetLabel(record.recipe, lookup),
    'Recipe': describeRecipe(record.recipe),
    'Edited': isEdited(record.recipe, lookup) ? 'yes' : 'no',
    'Container': container === '' ? '' : containerLabel(container),
    'Video encoder': record.result?.encoder.video ?? plan?.video?.encoder ?? '',
    'Audio encoders': (record.result?.encoder.audio ?? plan?.audio.map((a) => a.encoder) ?? []).join(', '),
    'GPU': gpuWords(record),
    'Streams kept': (plan?.streams.kept ?? []).map((s) => `${s.kind} ${s.source} (${s.action})`).join('; '),
    'Streams not kept': (plan?.streams.dropped ?? []).map((s) => `${s.kind} ${s.source}: ${s.reason}`).join('; '),
    'Started': timestamp(record.startedAt),
    'Finished': timestamp(record.endedAt),
    'Elapsed': seconds(elapsedMs === null ? null : elapsedMs / 1000),
    'Integrated before': fixed(streams.stats?.integratedLufs),
    'Range before': fixed(streams.stats?.loudnessRangeLu),
    'True peak before': fixed(streams.stats?.truePeakDbtp),
    'Gain planned': fixed(streams.before?.gainDb),
    'Plan mode': streams.before ? MODE_WORDS[streams.before.mode] : '',
    'Peak limiting planned': fixed(streams.before?.limitingDb),
    'Integrated after': fixed(streams.after?.integratedLufs),
    'Range after': fixed(streams.after?.loudnessRangeLu),
    'True peak after': fixed(streams.after?.truePeakDbtp),
    'Sample peak after': fixed(streams.after?.samplePeakDbfs),
    'Target': targetWords(record, streams.before),
    'Standard tolerance': tolerance ? `±${stated(tolerance.value)} ${tolerance.unit}` : '',
    'App check': appCheckWords(record, streams.verdict),
    'Verification': decodeWords(record),
    'Warnings': record.warnings.map((w) => w.message).join(' '),
    'Error': record.error?.message ?? '',
    'Exit code': record.error?.exitCode === null || record.error?.exitCode === undefined ? '' : String(record.error.exitCode),
    'Command': record.error?.command?.display ?? plan?.command?.display ?? '',
    'Output policy': summary ? policyWords(summary.policy) : '',
    'FFmpeg build': summary ? ffmpegWords(summary.ffmpeg) : '',
    'molexMedia version': summary?.appVersion ?? ''
  }
}

/**
 * One CSV field: quoted when it holds a comma, quote, line break, or edge space, and prefixed with an apostrophe when
 * a spreadsheet would read it as a formula. Signed numbers, with or without a unit, stay as they are.
 */
export function csvField(value: string): string
{
  const formula = /^[=+@\t\r]/.test(value) || (value.startsWith('-') && !/^-\d+(\.\d+)?( [A-Za-z]+)?$/.test(value))
  const text = formula ? `'${value}` : value
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The CSV report: a byte order mark, the header, and one row per job, with CRLF line ends. */
export function reportCsv(rows: readonly ReportRow[], lookup: PresetLookup): string
{
  const lines = [REPORT_COLUMNS.map(csvField).join(',')]
  for (const row of rows)
  {
    const values = reportValues(row, lookup)
    lines.push(REPORT_COLUMNS.map((column) => csvField(values[column])).join(','))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

function rendered(refs: readonly MessageRef[]): string[]
{
  return refs.map((ref) => renderMessage(ref, { minus: 'hyphen' }))
}

/** A failed attempt's FFmpeg output tail for the JSON report; null when its log is gone. */
export interface FailedAttemptTail
{
  attempt: number
  runId: RunId | null
  errorCode: string | null
  tail: string | null
}

/** The JSON report: the batches' summaries and, per job, the CSV values, every record, the audio text, and tails. */
export function reportJson(title: string, generatedAt: number, rows: readonly ReportRow[], lookup: PresetLookup, tails: ReadonlyMap<string, FailedAttemptTail[]>): string
{
  const batches = new Map<RunId, { runId: RunId; batch: string; summary: BatchSummary | null }>()
  for (const row of rows)
  {
    if (!batches.has(row.record.runId))
    {
      batches.set(row.record.runId, { runId: row.record.runId, batch: formatRunLabel(row.record.runId), summary: row.summary })
    }
  }
  const jobs = rows.map((row) =>
  {
    const record = row.record
    return {
      batch: formatRunLabel(record.runId),
      job: record.jobId,
      columns: reportValues(row, lookup),
      record,
      attempts: row.attempts,
      text:
      {
        plan: rendered((record.plan?.audio ?? []).flatMap((a) => a.messages)),
        measurement: rendered(record.measurement?.messages ?? []),
        verification: rendered(record.verification?.messages ?? [])
      },
      failedAttempts: tails.get(`${record.runId}/${record.jobId}`) ?? []
    }
  })
  return `${JSON.stringify({ schema: 1, report: title, generatedAt: new Date(generatedAt).toISOString(), batches: [...batches.values()], jobs }, null, 2)}\n`
}

/** The report's default file name: "molexMedia Batch 31 report.csv". */
export function reportName(label: string, format: 'csv' | 'json'): string
{
  return `molexMedia ${label} report.${format}`
}

/** The folder the save dialog opens in: the run's destination folder, else the first source's folder. */
export function reportFolder(rows: readonly ReportRow[]): string | null
{
  const first = rows[0]
  if (!first)
  {
    return null
  }
  const destination = first.summary?.policy.destination
  return destination?.mode === 'folder' ? destination.folder : folderOf(first.record.source.path)
}

/** A folder and a file name joined with the folder's own separator. */
export function joinReportPath(folder: string | null, name: string): string
{
  if (folder === null || folder === '')
  {
    return name
  }
  const separator = isWindowsPath(folder) || folder.includes('\\') ? '\\' : '/'
  return folder.endsWith('/') || folder.endsWith('\\') ? `${folder}${name}` : `${folder}${separator}${name}`
}

/** What `jobs:exportReport` needs from the engine: the preset lookup and the save dialog. */
export interface ReportOptions
{
  lookup: PresetLookup
  /** Shows the save dialog at the default path; null when it is canceled. */
  choose(defaultPath: string): Promise<string | null>
  now?: () => number
}

/** The part of the job store history writes through. */
export interface HistoryStore
{
  appendLines(path: string, values: readonly unknown[], durable?: boolean): Promise<void>
}

/** What the run history is built on. */
export interface RunHistoryOptions
{
  io: PersistenceIO
  fs: HistoryFs
  paths: JobsPaths
  store: HistoryStore
  limits?: RetentionLimits
  /** The run still open, which is never pruned or deleted. */
  openRun?: () => RunId | null
}

/** History and log usage for Settings. */
export interface HistoryUsage
{
  runs: number
  historyBytes: number
  logBytes: number
}

/** What retention removed: whole runs, and runs whose logs alone were removed. */
export interface PruneResult
{
  runs: RunId[]
  logs: RunId[]
}

function isIndexEntry(value: unknown): value is RunIndexEntry
{
  if (typeof value !== 'object' || value === null)
  {
    return false
  }
  const entry = value as Partial<RunIndexEntry>
  return typeof entry.runId === 'string' && parseRunId(entry.runId) !== null && typeof entry.startedAt === 'number'
    && typeof entry.counts === 'object' && entry.counts !== null && typeof entry.bytes === 'object' && entry.bytes !== null
}

function runSeq(runId: RunId): number
{
  return parseRunId(runId) ?? -1
}

function newestFirst(a: RunIndexEntry, b: RunIndexEntry): number
{
  return runSeq(b.runId) - runSeq(a.runId)
}

/** The run index and the run files behind it. */
export class RunHistory
{
  private readonly io: PersistenceIO
  private readonly fs: HistoryFs
  private readonly paths: JobsPaths
  private readonly store: HistoryStore
  private readonly limits: RetentionLimits
  private readonly openRun: () => RunId | null
  private index: RunIndexEntry[] = []
  private readonly sizes = new Map<RunId, number>()
  private readonly sizing = new Map<RunId, Promise<void>>()
  private indexWrite: Promise<void> = Promise.resolve()

  constructor(options: RunHistoryOptions)
  {
    this.io = options.io
    this.fs = options.fs
    this.paths = options.paths
    this.store = options.store
    this.limits = options.limits ?? RETENTION
    this.openRun = options.openRun ?? (() => null)
  }

  /** Reads the run index; a missing or unreadable index is rebuilt from the run files. */
  async load(): Promise<{ status: 'ok' | 'rebuilt' | 'empty'; runs: number }>
  {
    await this.io.mkdir(this.paths.runs)
    const read = await readJson(this.io, this.paths.runsIndex)
    if (read.status === 'ok' && Array.isArray(read.value))
    {
      this.index = read.value.filter(isIndexEntry).sort(newestFirst)
      return { status: 'ok', runs: this.index.length }
    }
    const files = (await this.io.list(this.paths.runs)).filter((name) => name.endsWith('.jsonl'))
    if (read.status === 'missing' && files.length === 0)
    {
      this.index = []
      return { status: 'empty', runs: 0 }
    }
    const entries: RunIndexEntry[] = []
    for (const name of files)
    {
      const runId = name.slice(0, -'.jsonl'.length) as RunId
      if (parseRunId(runId) === null)
      {
        continue
      }
      const parsed = await this.readRun(runId)
      const startedAt = minOf(parsed.records.map((r) => r.startedAt ?? r.endedAt)) ?? 0
      entries.push(indexEntryOf(runId, startedAt, parsed.summary, parsed.records))
    }
    this.index = entries.sort(newestFirst)
    await this.writeIndex()
    return { status: 'rebuilt', runs: this.index.length }
  }

  /** The run index, newest first. */
  entries(): readonly RunIndexEntry[]
  {
    return this.index
  }

  /** Adds a started run to the index. */
  async startRun(runId: RunId, startedAt: number): Promise<void>
  {
    if (!this.index.some((entry) => entry.runId === runId))
    {
      this.index = [...this.index, openIndexEntry(runId, startedAt)].sort(newestFirst)
      await this.writeIndex()
    }
  }

  /** Appends a finished attempt's record and returns where its line sits. */
  appendRecord(record: HistoryRecord): Promise<HistoryRef>
  {
    return this.appendLine(record.runId, record)
  }

  /** Appends the summary line once the run completes and rewrites its index entry, then applies retention. */
  async completeRun(summary: BatchSummary): Promise<PruneResult>
  {
    await this.appendLine(summary.runId, { type: 'summary', schema: 1, summary })
    const parsed = await this.readRun(summary.runId)
    this.putEntry(indexEntryOf(summary.runId, summary.startedAt, summary, parsed.records))
    await this.writeIndex()
    return this.prune()
  }

  /**
   * Appends the record of a decision on a held job of a completed run, after its summary line, and rewrites the
   * run's index entry with the counts that follow.
   */
  async recordDecision(record: HistoryRecord): Promise<HistoryRef>
  {
    const ref = await this.appendLine(record.runId, record)
    const parsed = await this.readRun(record.runId)
    const current = this.index.find((entry) => entry.runId === record.runId)
    this.putEntry(indexEntryOf(record.runId, current?.startedAt ?? record.startedAt ?? record.endedAt, parsed.summary, parsed.records))
    await this.writeIndex()
    return ref
  }

  /** Every line of a run file by its tag. */
  async readRun(runId: RunId): Promise<ParsedRun>
  {
    return parseRunText((await this.io.read(this.paths.history(runId))) ?? '')
  }

  /** The record line a terminal job's `HistoryRef` points at, or null when the file no longer holds it. */
  async readRecord(ref: HistoryRef): Promise<HistoryRecord | null>
  {
    const text = await this.io.read(this.paths.history(ref.runId))
    if (text === null)
    {
      return null
    }
    const slice = Buffer.from(text, 'utf8').subarray(ref.offset, ref.offset + ref.length).toString('utf8')
    const record = parseRunText(slice).records[0]
    return record ?? null
  }

  /** `runs:list`: a page of the index after `before`, with the usage. */
  async list(before: RunId | null, limit: number): Promise<{ runs: RunIndexEntry[]; more: boolean; usage: HistoryUsage }>
  {
    const start = before === null ? 0 : this.index.findIndex((entry) => entry.runId === before) + 1
    const from = before !== null && start === 0 ? this.index.length : start
    const size = Math.max(1, Math.floor(limit))
    const runs = this.index.slice(from, from + size)
    return { runs, more: from + size < this.index.length, usage: await this.usage() }
  }

  /** `runs:get`: a page of the run's jobs at their current records; the summary is null while the run is open. */
  async get(runId: RunId, offset: number, limit: number): Promise<{ summary: BatchSummary | null; records: HistoryRecord[]; total: number }>
  {
    const parsed = await this.readRun(runId)
    const latest = latestRecords(parsed.records)
    const start = Math.max(0, Math.floor(offset))
    const size = Math.min(RUN_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
    return { summary: parsed.summary, records: latest.slice(start, start + size), total: latest.length }
  }

  /** History and log bytes on disk; logs are counted for every run folder, indexed or not. */
  async usage(): Promise<HistoryUsage>
  {
    let historyBytes = 0
    for (const entry of this.index)
    {
      historyBytes += await this.historyBytesOf(entry.runId)
    }
    let logBytes = 0
    for (const name of await this.io.list(this.paths.logs))
    {
      logBytes += await this.logBytesOf(name as RunId)
    }
    return { runs: this.index.length, historyBytes, logBytes }
  }

  /** `runs:delete`: removes the runs' files, index entries, and logs; the open run is never deleted. */
  async delete(runIds: RunId[] | 'all'): Promise<{ deleted: number }>
  {
    const open = this.openRun()
    const wanted = runIds === 'all' ? this.index.map((entry) => entry.runId) : runIds
    const targets = [...new Set(wanted)].filter((runId) => runId !== open && this.index.some((entry) => entry.runId === runId))
    for (const runId of targets)
    {
      await this.removeRunFiles(runId)
    }
    this.index = this.index.filter((entry) => !targets.includes(entry.runId))
    await this.writeIndex()
    return { deleted: targets.length }
  }

  /**
   * Retention, oldest first: whole runs go while there are more than the run limit or their history files exceed the
   * history budget; then, while logs exceed the log budget, the oldest runs lose their logs and keep their records.
   */
  async prune(): Promise<PruneResult>
  {
    const open = this.openRun()
    const oldest = [...this.index].reverse().filter((entry) => entry.runId !== open)
    const historySizes = new Map<RunId, number>()
    let historyTotal = 0
    for (const entry of this.index)
    {
      const bytes = await this.historyBytesOf(entry.runId)
      historySizes.set(entry.runId, bytes)
      historyTotal += bytes
    }
    const removed: RunId[] = []
    let count = this.index.length
    for (const entry of oldest)
    {
      if (count <= this.limits.runs && historyTotal <= this.limits.historyBytes)
      {
        break
      }
      await this.removeRunFiles(entry.runId)
      removed.push(entry.runId)
      count -= 1
      historyTotal -= historySizes.get(entry.runId) ?? 0
    }
    if (removed.length > 0)
    {
      this.index = this.index.filter((entry) => !removed.includes(entry.runId))
      await this.writeIndex()
    }
    const logs: RunId[] = []
    const logSizes = new Map<RunId, number>()
    let logTotal = 0
    for (const name of await this.io.list(this.paths.logs))
    {
      const bytes = await this.logBytesOf(name as RunId)
      logSizes.set(name as RunId, bytes)
      logTotal += bytes
    }
    const logOrder = [...logSizes.keys()].filter((runId) => runId !== open).sort((a, b) => runSeq(a) - runSeq(b))
    for (const runId of logOrder)
    {
      if (logTotal <= this.limits.logBytes)
      {
        break
      }
      await this.fs.removeTree(join(this.paths.logs, runId))
      logs.push(runId)
      logTotal -= logSizes.get(runId) ?? 0
    }
    return { runs: removed, logs }
  }

  /**
   * `runs:search`: every kept run, newest first, by source name, path, and catalog number, one match per job at its
   * current record. Run files are read one at a time and reading stops once a page and one more match are found.
   */
  async search(query: string, limit: number, before: { runId: RunId; jobId: JobId } | null): Promise<SearchResult>
  {
    const matcher = recordMatcher(query)
    const size = Math.max(1, Math.floor(limit))
    const matches: SearchMatch[] = []
    let more = false
    let skipping = before !== null
    for (const entry of this.index)
    {
      if (more || matcher === null)
      {
        break
      }
      if (before !== null && skipping && runSeq(entry.runId) > runSeq(before.runId))
      {
        continue
      }
      const records = latestRecords((await this.readRun(entry.runId)).records).sort(newestRecordFirst)
      for (const record of records)
      {
        if (skipping && before !== null && entry.runId === before.runId)
        {
          skipping = record.jobId !== before.jobId
          continue
        }
        skipping = false
        if (!matcher(record))
        {
          continue
        }
        if (matches.length === size)
        {
          more = true
          break
        }
        matches.push(searchMatch(record))
      }
      skipping = false
    }
    return { matches, runs: new Set(matches.map((m) => m.runId)).size, more }
  }

  /**
   * The checks `runs:rerun` makes before adding jobs: each recorded source is stat'ed; a missing source is reported
   * and never added, and a path that now holds the job's own output is reported in `holdsOutput` unless `force`.
   */
  async rerunCheck(runId: RunId, jobIds: JobId[] | 'all' | 'returned', force: boolean): Promise<RerunCheck>
  {
    const latest = latestRecords((await this.readRun(runId)).records)
    const wanted = jobIds === 'all' || jobIds === 'returned' ? null : new Set(jobIds)
    const chosen = latest.filter((record) => wanted ? wanted.has(record.jobId) : jobIds === 'all' || isReturned(record))
    const check: RerunCheck = { add: [], missing: [], holdsOutput: [] }
    for (const record of chosen)
    {
      const info = await this.fs.stat(record.source.path)
      if (!info || !info.isFile)
      {
        check.missing.push({ jobId: record.jobId, path: record.source.path })
      }
      else if (!force && holdsOwnOutput(record, info))
      {
        check.holdsOutput.push({ jobId: record.jobId, path: record.source.path, originalTrashed: originalTrashed(record.placement) })
      }
      else
      {
        check.add.push({ path: record.source.path, recipe: record.recipe, rerunOf: { runId, jobId: record.jobId } })
      }
    }
    return check
  }

  /**
   * The report rows of a run, or of jobs by catalog number at their newest records across kept runs, in the order
   * asked for.
   */
  async reportRows(scope: { runId: RunId } | { ids: JobId[] }): Promise<ReportRow[]>
  {
    if ('runId' in scope)
    {
      const parsed = await this.readRun(scope.runId)
      return latestRecords(parsed.records).map((record) => ({ record, summary: parsed.summary, attempts: attemptsOf(parsed.records, record.jobId) }))
    }
    const wanted = [...new Set(scope.ids)]
    const found = new Map<JobId, ReportRow>()
    for (const entry of this.index)
    {
      if (found.size === wanted.length)
      {
        break
      }
      const parsed = await this.readRun(entry.runId)
      for (const record of latestRecords(parsed.records))
      {
        if (wanted.includes(record.jobId) && !found.has(record.jobId))
        {
          found.set(record.jobId, { record, summary: parsed.summary, attempts: attemptsOf(parsed.records, record.jobId) })
        }
      }
    }
    return wanted.flatMap((jobId) => found.get(jobId) ?? [])
  }

  /**
   * `jobs:exportReport`: the save dialog opens at the default name in the run's destination folder, and the CSV or
   * JSON report is written to the chosen path.
   */
  async exportReport(scope: { runId: RunId } | { ids: JobId[] }, format: 'csv' | 'json', options: ReportOptions): Promise<{ path: string } | { canceled: true }>
  {
    const rows = await this.reportRows(scope)
    const runs = new Set(rows.map((row) => row.record.runId))
    const label = 'runId' in scope
      ? formatRunLabel(scope.runId)
      : runs.size === 1 ? formatRunLabel([...runs][0]) : 'jobs'
    const path = await options.choose(joinReportPath(reportFolder(rows), reportName(label, format)))
    if (path === null)
    {
      return { canceled: true }
    }
    const text = format === 'csv'
      ? reportCsv(rows, options.lookup)
      : reportJson(`molexMedia ${label}`, (options.now ?? Date.now)(), rows, options.lookup, await this.failedTails(rows))
    await this.io.writeAtomic(path, text)
    return { path }
  }

  private async failedTails(rows: readonly ReportRow[]): Promise<Map<string, FailedAttemptTail[]>>
  {
    const tails = new Map<string, FailedAttemptTail[]>()
    for (const { record } of rows)
    {
      const list: FailedAttemptTail[] = []
      for (const attempt of record.attempts.filter((a) => a.state === 'failed'))
      {
        const log = await this.io.read(this.paths.attemptLog(attempt.runId ?? record.runId, record.jobId, attempt.attempt))
        list.push({ attempt: attempt.attempt, runId: attempt.runId, errorCode: attempt.errorCode, tail: log === null ? null : tailAtLineBoundary(log, ERROR_TAIL_BYTES) })
      }
      if (record.state === 'failed' && record.error)
      {
        list.push({ attempt: record.attempt, runId: record.runId, errorCode: record.error.code, tail: record.error.stderrTail })
      }
      tails.set(`${record.runId}/${record.jobId}`, list)
    }
    return tails
  }

  private putEntry(entry: RunIndexEntry): void
  {
    this.index = [...this.index.filter((e) => e.runId !== entry.runId), entry].sort(newestFirst)
  }

  private writeIndex(): Promise<void>
  {
    const write = this.indexWrite.catch(() => undefined).then(() => writeJsonAtomic(this.io, this.paths.runsIndex, this.index))
    this.indexWrite = write
    return write
  }

  private async ensureSize(runId: RunId): Promise<void>
  {
    if (this.sizes.has(runId))
    {
      return
    }
    let pending = this.sizing.get(runId)
    if (!pending)
    {
      pending = this.fs.stat(this.paths.history(runId)).then((info) =>
      {
        if (!this.sizes.has(runId))
        {
          this.sizes.set(runId, info?.size ?? 0)
        }
      })
      this.sizing.set(runId, pending)
    }
    try
    {
      await pending
    }
    finally
    {
      this.sizing.delete(runId)
    }
  }

  private async appendLine(runId: RunId, line: HistoryLine): Promise<HistoryRef>
  {
    const length = Buffer.byteLength(jsonLine(line))
    await this.ensureSize(runId)
    const offset = this.sizes.get(runId) as number
    this.sizes.set(runId, offset + length)
    await this.store.appendLines(this.paths.history(runId), [line], true)
    return { runId, offset, length }
  }

  private async historyBytesOf(runId: RunId): Promise<number>
  {
    return (await this.fs.stat(this.paths.history(runId)))?.size ?? 0
  }

  private async logBytesOf(runId: RunId): Promise<number>
  {
    const dir = join(this.paths.logs, runId)
    let bytes = 0
    for (const name of await this.io.list(dir))
    {
      const info = await this.fs.stat(join(dir, name))
      bytes += info?.isFile ? info.size : 0
    }
    return bytes
  }

  private async removeRunFiles(runId: RunId): Promise<void>
  {
    await this.fs.removeTree(this.paths.history(runId))
    await this.fs.removeTree(join(this.paths.logs, runId))
    this.sizes.delete(runId)
  }
}
