import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  albumSummaries,
  binName,
  buildBatchSummary,
  buildHistoryRecord,
  countRecords,
  createNodeHistoryFs,
  csvField,
  displacedFiles,
  ffmpegWords,
  fileName,
  folderOf,
  holdsOwnOutput,
  indexEntryOf,
  isRecordState,
  isReturned,
  joinReportPath,
  latestRecords,
  openIndexEntry,
  originalTrashed,
  originalWords,
  parseRunText,
  placementWords,
  policyWords,
  recipeOutcomes,
  recordMatcher,
  recordVerdict,
  REPORT_COLUMNS,
  reportCsv,
  reportFolder,
  reportName,
  reportValues,
  RunHistory,
  runTotals,
  samePath,
  statusWords,
  verdictWords,
  volumeOf,
  type HistoryFs,
  type ReportColumn,
  type ReportRow,
  type RunFacts
} from '../../../src/main/jobs/history'
import type { PersistenceIO } from '../../../src/main/jobs/deps'
import { jobsPaths, jsonLine } from '../../../src/main/jobs/persistence'
import type { GainPlan, StreamVerdict, VerifiedStream } from '../../../src/shared/audio/types'
import { formatCatalog, formatRunId, type RunId } from '../../../src/shared/jobs/ids'
import { applyDefaultPreset, presetLookup } from '../../../src/shared/jobs/presets'
import type { CompressRecipe, Recipe } from '../../../src/shared/jobs/recipes'
import type
{
  AlbumSummary, BatchSummary, FrozenPolicy, HistoryRecord, Job, JobError, JobMeasurement, JobPlan, JobResult, Placement,
  ResultStamp, TrashOutcome, Verdict, Verification
} from '../../../src/shared/jobs/types'

const RUN = formatRunId(31)

const SAME = { kind: 'same-as-source' } as const

function normalizeRecipe(): Recipe
{
  return applyDefaultPreset('normalize', SAME)
}

function compressRecipe(target: CompressRecipe['target']): Recipe
{
  return { ...(applyDefaultPreset('compress', SAME) as CompressRecipe), target }
}

function verifiedStream(lufs: number, peak: number, outIndex = 0): VerifiedStream
{
  return {
    outIndex,
    integratedLufs: lufs,
    loudnessRangeLu: 6.2,
    maxShortTermLufs: null,
    preEncodeTruePeakDbtp: peak - 0.1,
    truePeakDbtp: peak,
    samplePeakDbfs: peak - 0.4,
    meter: 'soxr-8x'
  }
}

function streamVerdict(outcome: Verdict, toleranceLu = 1, audioIndex = 0, referenceLufs: number | null = -16): StreamVerdict
{
  return {
    audioIndex,
    outcome,
    loudness:
    {
      status: outcome === 'outside-tolerance' ? 'below' : 'within',
      reference: outcome === 'verified-below-target' ? 'reachable' : 'target',
      referenceLufs,
      deviationLu: -0.1,
      toleranceLu,
      standardTolerance: { value: 1, unit: 'dB' }
    },
    shortTerm: { status: 'not-checked', limitLufs: null, maxLufs: null, toleranceLu: 1 },
    truePeak: { status: 'within', basis: 'pre-encode', gateDbtp: -1, overDb: null },
    decoded: { status: 'within', limitDbtp: -0.5, overDb: null },
    samplePeakOver: false,
    warnings: [],
    meterMarginDb: 0,
    encodePasses: 1
  }
}

function verification(verdict: Verdict, streams: Array<{ lufs: number; peak: number; outcome?: Verdict; check?: number; reference?: number | null }> = [{ lufs: -16.1, peak: -1.6 }]): Verification
{
  return {
    verdict,
    encodePasses: 1,
    audio: streams.map((s, index) => ({ verified: verifiedStream(s.lufs, s.peak, index), verdict: streamVerdict(s.outcome ?? verdict, s.check ?? 1, index, s.reference ?? -16) })),
    media: null,
    messages: []
  }
}

function stamp(verdict: Verdict, overrides: Partial<ResultStamp> = {}): ResultStamp
{
  return {
    verdict,
    outputName: 'a.m4a',
    container: 'm4a',
    inputBytes: 1000,
    outputBytes: 800,
    durationSec: 60,
    decode: 'full',
    audioStreams: 1,
    verdictStream: 0,
    loudness:
    {
      lufs: -16.1,
      unit: 'LKFS',
      reference: verdict === 'verified-below-target' ? 'reachable' : 'target',
      referenceLufs: -16,
      deviation: -0.1,
      deviationUnit: 'LU',
      check: 1,
      checkClass: 'lossy',
      status: verdict === 'outside-tolerance' ? 'below' : 'within'
    },
    truePeak: { dbtp: -1.6, preEncodeDbtp: -1.7, limitDbtp: -1, status: 'within' },
    size: null,
    frames: null,
    cues: null,
    placement: 'new',
    warnings: 0,
    ...overrides
  }
}

function result(verdict: Verdict, outputPath: string, placement: Placement = { kind: 'new' }, overrides: Partial<ResultStamp> = {}): JobResult
{
  return {
    outputPath,
    outputKind: 'file',
    container: 'm4a',
    inputBytes: 1000,
    outputBytes: 800,
    durationSec: 60,
    elapsedMs: 4000,
    encoder: { video: null, audio: ['aac'] },
    placement,
    stamp: stamp(verdict, { placement: placement.kind, ...overrides }),
    warnings: [],
    notes: []
  }
}

interface RecordOptions
{
  seq: number
  state?: HistoryRecord['state']
  verdict?: Verdict | null
  attempt?: number
  runId?: RunId
  path?: string
  recipe?: Recipe
  label?: string
  placement?: Placement
  endedAt?: number
}

function record(opts: RecordOptions): HistoryRecord
{
  const state = opts.state ?? 'done'
  const verdict = opts.verdict === undefined ? (state === 'done' ? 'verified' : null) : opts.verdict
  const path = opts.path ?? `D:\\Audio\\track-${opts.seq}.wav`
  const outputPath = `D:\\Exports\\track-${opts.seq}.m4a`
  const hasOutput = state === 'done' || state === 'held'
  const res = hasOutput && verdict ? result(verdict, outputPath, opts.placement) : null
  return {
    type: 'record',
    schema: 1,
    runId: opts.runId ?? RUN,
    jobId: formatCatalog(opts.seq),
    attempt: opts.attempt ?? 1,
    op: (opts.recipe ?? normalizeRecipe()).kind,
    source: { path, size: 1000, mtimeMs: 5000 },
    recipe: opts.recipe ?? normalizeRecipe(),
    recipeLabel: opts.label ?? 'Normalize · Apple Podcasts',
    state,
    startedAt: 1000,
    endedAt: opts.endedAt ?? 2000 + opts.seq,
    output: res ? { path: outputPath, bytes: 800, container: 'm4a' } : null,
    placement: res ? res.placement : null,
    plan: null,
    measurement: null,
    verification: verdict && verdict !== 'failed' ? verification(verdict) : null,
    result: res,
    error: null,
    warnings: [],
    attempts: [],
    rerunOf: null,
    logFile: null
  }
}

describe('history records', () =>
{
  it('recognizes the states a record is written for', () =>
  {
    expect(isRecordState('done')).toBe(true)
    expect(isRecordState('held')).toBe(true)
    expect(isRecordState('encoding')).toBe(false)
    expect(isRecordState('pending')).toBe(false)
  })

  it('builds a self-contained record from a finished job', () =>
  {
    const res = result('verified', 'D:\\Exports\\a.m4a')
    const job = {
      id: formatCatalog(142),
      runId: RUN,
      state: 'done',
      attempt: 2,
      recipe: normalizeRecipe(),
      source: { path: 'D:\\Audio\\a.wav', name: 'a', ext: 'wav', dir: 'D:\\Audio', size: 1000, mtimeMs: 5000, origin: 'files', subdir: '' },
      startedAt: 100,
      endedAt: 200,
      result: res,
      hold: null,
      plan: null,
      measurement: null,
      verification: verification('verified'),
      error: null,
      warnings: [{ code: 'ran-on-cpu', short: 'ran on CPU', message: 'Ran on the CPU.' }],
      attempts: [{ attempt: 1, runId: RUN, recipe: normalizeRecipe(), state: 'failed', startedAt: 1, endedAt: 2, verdict: null, errorCode: 'ffmpeg-failed' }],
      rerunOf: { runId: formatRunId(29), jobId: formatCatalog(131) }
    } as unknown as Job
    const rec = buildHistoryRecord(job, { recipeLabel: 'Normalize · Apple Podcasts', logFile: 'x.log', endedAt: 999 })
    expect(rec.type).toBe('record')
    expect(rec.schema).toBe(1)
    expect(rec.op).toBe('normalize')
    expect(rec.attempt).toBe(2)
    expect(rec.endedAt).toBe(200)
    expect(rec.output).toEqual({ path: 'D:\\Exports\\a.m4a', bytes: 800, container: 'm4a' })
    expect(rec.placement).toEqual({ kind: 'new' })
    expect(rec.source).toEqual({ path: 'D:\\Audio\\a.wav', size: 1000, mtimeMs: 5000 })
    expect(rec.warnings).toEqual([])
    expect(rec.attempts).toHaveLength(1)
    expect(rec.rerunOf?.jobId).toBe('MM-0131')
    expect(rec.logFile).toBe('x.log')
  })

  it('records a held job with its work-folder output and a failed job without one', () =>
  {
    const base = {
      id: formatCatalog(7),
      runId: RUN,
      attempt: 1,
      recipe: normalizeRecipe(),
      source: { path: 'D:\\a.wav', size: 1, mtimeMs: 2 },
      startedAt: null,
      endedAt: null,
      result: null,
      plan: { output: { container: 'flac' } },
      measurement: null,
      verification: null,
      error: null,
      warnings: [{ code: 'source-changed', short: 's', message: 'm' }],
      attempts: [],
      rerunOf: null
    }
    const held = buildHistoryRecord({ ...base, state: 'held', hold: { outputPath: 'W:\\work\\a.flac' } } as unknown as Job, { recipeLabel: 'x', logFile: null, endedAt: 50 })
    expect(held.output).toEqual({ path: 'W:\\work\\a.flac', bytes: 0, container: 'flac' })
    expect(held.endedAt).toBe(50)
    expect(held.warnings).toHaveLength(1)
    const heldNoPlan = buildHistoryRecord({ ...base, plan: null, state: 'held', hold: { outputPath: 'W:\\a' } } as unknown as Job, { recipeLabel: 'x', logFile: null, endedAt: 50 })
    expect(heldNoPlan.output?.container).toBe('')
    const failed = buildHistoryRecord({ ...base, state: 'failed', hold: null } as unknown as Job, { recipeLabel: 'x', logFile: null, endedAt: 50 })
    expect(failed.output).toBeNull()
    expect(failed.placement).toBeNull()
  })

  it('refuses a job without a finished attempt', () =>
  {
    const job = { id: formatCatalog(1), runId: RUN, state: 'encoding' } as unknown as Job
    expect(() => buildHistoryRecord(job, { recipeLabel: 'x', logFile: null, endedAt: 1 })).toThrow(/no finished attempt/)
    const noRun = { id: formatCatalog(1), runId: null, state: 'done' } as unknown as Job
    expect(() => buildHistoryRecord(noRun, { recipeLabel: 'x', logFile: null, endedAt: 1 })).toThrow()
  })
})

describe('run files by tag', () =>
{
  it('reads records after the summary as records, and skips untagged, newer, and torn lines', () =>
  {
    const summary = { runId: RUN } as unknown as BatchSummary
    const text = [
      jsonLine(record({ seq: 1 })),
      jsonLine({ type: 'summary', schema: 1, summary }),
      jsonLine(record({ seq: 2, state: 'done' })),
      jsonLine({ type: 'other', schema: 1 }),
      jsonLine({ type: 'record', schema: 9 }),
      'not json\n',
      '{"type":"rec'
    ].join('')
    const parsed = parseRunText(text)
    expect(parsed.records.map((r) => r.jobId)).toEqual(['MM-0001', 'MM-0002'])
    expect(parsed.summary).toEqual(summary)
    expect(parsed.skipped).toBe(4)
  })

  it('keeps each job at its newest attempt, a later line winning within an attempt', () =>
  {
    const held = record({ seq: 3, state: 'held', verdict: 'outside-tolerance' })
    const kept = record({ seq: 3, state: 'done', verdict: 'outside-tolerance' })
    const first = record({ seq: 4, state: 'failed', attempt: 1 })
    const retry = record({ seq: 4, state: 'done', attempt: 2 })
    const latest = latestRecords([held, first, retry, kept, record({ seq: 4, attempt: 1, state: 'canceled' })])
    expect(latest).toHaveLength(2)
    expect(latest[0].state).toBe('done')
    expect(latest[1].attempt).toBe(2)
  })

  it('reads verdicts', () =>
  {
    expect(recordVerdict(record({ seq: 1 }))).toBe('verified')
    expect(recordVerdict(record({ seq: 1, state: 'failed' }))).toBe('failed')
    expect(recordVerdict(record({ seq: 1, state: 'canceled' }))).toBeNull()
  })
})

describe('counts', () =>
{
  it('counts in the page words, returned including held and placed outside tolerance', () =>
  {
    const records = [
      record({ seq: 1 }),
      record({ seq: 2, verdict: 'verified-below-target' }),
      record({ seq: 3, verdict: 'passthrough' }),
      record({ seq: 4, verdict: 'outside-tolerance' }),
      record({ seq: 5, state: 'held', verdict: 'outside-tolerance' }),
      record({ seq: 6, state: 'failed' }),
      record({ seq: 7, state: 'canceled' }),
      record({ seq: 8, state: 'skipped' }),
      record({ seq: 9, state: 'interrupted' })
    ]
    expect(countRecords(records)).toEqual({
      total: 9, done: 4, verified: 3, reachable: 1, outsideTolerance: 2,
      failed: 1, canceled: 1, skipped: 1, held: 1, interrupted: 1, returned: 4
    })
    expect(isReturned(records[0])).toBe(false)
    expect(isReturned(records[3])).toBe(true)
  })
})

function gainPlan(limitingDb: number, targetLufs: number | null = -16, mode: GainPlan['mode'] = 'linear'): GainPlan
{
  return { audioIndex: 0, mode, targetLufs, limitingDb, gainDb: 3 } as unknown as GainPlan
}

function measured(rec: HistoryRecord, plans: Array<GainPlan | null>, album: AlbumSummary | null = null): HistoryRecord
{
  const measurement = {
    pass: 'source',
    measuredAt: 1,
    streams: plans.map((plan) => ({ measurement: { audioIndex: 0, stats: { integratedLufs: -20, loudnessRangeLu: 7, truePeakDbtp: -3 } }, plan })),
    album,
    messages: []
  } as unknown as JobMeasurement
  return { ...rec, measurement }
}

const POLICY = {
  rev: 3,
  destination: { mode: 'folder', folder: 'D:\\Exports' },
  template: '{name}',
  conflict: 'rename',
  displaced: 'trash',
  gpu: 'auto',
  frozenAt: 1,
  date: '2026-10-18'
} as FrozenPolicy

const FACTS: RunFacts = {
  runId: RUN,
  startedAt: 1000,
  endedAt: 61000,
  endedBy: 'completed',
  interruptions: 1,
  policy: POLICY,
  ffmpeg: { version: '9.0.2', source: 'bundled' },
  appVersion: '5.0.0'
}

describe('the batch summary', () =>
{
  it('names volumes', () =>
  {
    expect(volumeOf('d:\\Audio\\a.wav')).toBe('D:')
    expect(volumeOf('\\\\nas\\media\\a.wav')).toBe('\\\\nas\\media')
    expect(volumeOf('/home/a.wav')).toBe('/')
  })

  it('groups outcomes by recipe with checks, range, peaks, limiting, and reachable levels', () =>
  {
    const twoStreams = record({ seq: 3 })
    twoStreams.verification = verification('verified', [{ lufs: -16.2, peak: -1.6 }, { lufs: -15.9, peak: -2.2 }])
    const lossless = record({ seq: 4 })
    lossless.result!.stamp.loudness!.checkClass = 'lossless'
    lossless.result!.stamp.loudness!.check = 0.5
    const reachable = record({ seq: 5, verdict: 'verified-below-target' })
    reachable.verification = verification('verified-below-target', [{ lufs: -17.4, peak: -1, reference: -17.4 }])
    const outside = record({ seq: 6, verdict: 'outside-tolerance' })
    outside.result!.stamp.loudness!.status = 'below'
    const records = [
      measured(record({ seq: 1 }), [gainPlan(0)]),
      measured(record({ seq: 2 }), [gainPlan(1.8), null]),
      measured(twoStreams, [gainPlan(0.6, -16, 'peak-limited')]),
      lossless,
      reachable,
      outside,
      record({ seq: 7, state: 'failed' })
    ]
    const [normalize] = recipeOutcomes(records)
    expect(normalize.op).toBe('normalize')
    expect(normalize.presetId).toBe(normalizeRecipe().presetId)
    expect(normalize.userPresetId).toBeNull()
    expect(normalize.jobs).toBe(7)
    expect(normalize.verified).toBe(5)
    expect(normalize.reachable).toBe(1)
    expect(normalize.outsideTolerance).toBe(1)
    expect(normalize.returned).toBe(2)
    expect(normalize.size).toBeNull()
    const loudness = normalize.loudness!
    expect(loudness.unit).toBe('LKFS')
    expect(loudness.targetLufs).toBe(-16)
    expect(loudness.deviationUnit).toBe('LU')
    expect(loudness.checks).toEqual([
      { checkClass: 'lossless', check: 0.5, jobs: 1, within: 1 },
      { checkClass: 'lossy', check: 1, jobs: 5, within: 4 }
    ])
    expect(loudness.minLufs).toBe(-17.4)
    expect(loudness.maxLufs).toBe(-15.9)
    expect(loudness.streams).toBe(7)
    expect(loudness.maxTruePeakDbtp).toBe(-1)
    expect(loudness.limitedJobs).toBe(2)
    expect(loudness.maxLimitingDb).toBe(1.8)
    expect(loudness.reachableLevels).toEqual([-17.4])
  })

  it('reads the target from the stamps without plans, and gives Gain no target', () =>
  {
    const [normalize] = recipeOutcomes([record({ seq: 1 })])
    expect(normalize.loudness!.targetLufs).toBe(-16)
    expect(normalize.loudness!.maxLimitingDb).toBeNull()
    const boost: Recipe = { ...applyDefaultPreset('boost', SAME), userPreset: { id: 'u1', name: 'Mine' } }
    const [gain] = recipeOutcomes([measured(record({ seq: 2, recipe: boost }), [gainPlan(1.2, -12)])])
    expect(gain.op).toBe('boost')
    expect(gain.userPresetId).toBe('u1')
    expect(gain.loudness!.targetLufs).toBeNull()
    expect(gain.loudness!.limitedJobs).toBe(1)
    const failedOnly = recipeOutcomes([record({ seq: 3, state: 'failed' })])[0].loudness!
    expect(failedOnly).toMatchObject({ unit: 'LUFS', deviationUnit: 'LU', targetLufs: null, minLufs: null, streams: 0, checks: [] })
  })

  it('separates edited recipes and counts size targets for Compress', () =>
  {
    const compress = (targetBytes: number): Recipe => compressRecipe({ mode: 'size', targetBytes, twoPass: true })
    const quality = compressRecipe({ mode: 'crf', crf: 23 })
    const within = record({ seq: 1, recipe: compress(25e6) })
    within.result!.stamp.size = { targetBytes: 25e6, status: 'within' }
    const over = record({ seq: 2, recipe: compress(25e6) })
    over.result!.stamp.size = { targetBytes: 25e6, status: 'over' }
    const outcomes = recipeOutcomes([within, over, record({ seq: 3, recipe: compress(10e6) }), record({ seq: 4, recipe: quality })])
    expect(outcomes).toHaveLength(3)
    expect(outcomes[0].size).toEqual({ targetBytes: 25e6, jobs: 2, within: 1 })
    expect(outcomes[1].size).toEqual({ targetBytes: 10e6, jobs: 0, within: 0 })
    expect(outcomes[2].size).toBeNull()
    expect(outcomes[2].loudness).toBeNull()
    expect(outcomes[0].label).not.toBe(outcomes[1].label)
  })

  it('lists each album once', () =>
  {
    const album = { groupId: 'g1', members: 4, anchorJobId: formatCatalog(1), anchorLufs: -7.9, gainDb: -10.1, reason: 'fits' } as AlbumSummary
    const albums = albumSummaries([measured(record({ seq: 1 }), [], album), measured(record({ seq: 2 }), [], album), record({ seq: 3 })])
    expect(albums).toEqual([album])
  })

  it('counts originals per volume and displaced previous files', () =>
  {
    const replaced = (seq: number, path: string, original: TrashOutcome): HistoryRecord => record({ seq, path, placement: { kind: 'replaced-original', original } })
    const moved = displacedFiles([
      replaced(1, 'D:\\a.flac', { status: 'trashed' }),
      replaced(2, 'D:\\b.flac', { status: 'trashed' }),
      replaced(3, 'E:\\c.flac', { status: 'trashed' }),
      replaced(4, 'D:\\d.flac', { status: 'kept', path: 'D:\\d (original).flac', reason: 'no bin' }),
      record({ seq: 5, placement: { kind: 'overwrote', previous: { status: 'trashed' } } }),
      record({ seq: 6, placement: { kind: 'overwrote', previous: { status: 'kept', path: 'x', reason: 'y' } } }),
      record({ seq: 7, placement: { kind: 'renamed', planned: 'x' } })
    ])
    expect(moved.originals).toEqual({ trashed: 3, kept: 1, volumes: [{ volume: 'D:', trashed: 2 }, { volume: 'E:', trashed: 1 }] })
    expect(moved.previous).toEqual({ trashed: 1, kept: 1 })
  })

  it('totals bytes and media of jobs with outputs', () =>
  {
    const held = record({ seq: 2, state: 'held', verdict: null })
    held.output = { path: 'W:\\x', bytes: 0, container: 'flac' }
    expect(runTotals([record({ seq: 1 }), held, record({ seq: 3, state: 'failed' })])).toEqual({ bytes: { input: 2000, output: 800 }, mediaSec: 60 })
  })

  it('builds the summary with failures, policy, build, and version', () =>
  {
    const failed = record({ seq: 2, state: 'failed' })
    failed.error = { code: 'ffmpeg-failed', short: 'encoder failed', message: 'The encoder stopped.' } as JobError
    const summary = buildBatchSummary(FACTS, [record({ seq: 1 }), failed, record({ seq: 3, state: 'failed' })])
    expect(summary.elapsedMs).toBe(60000)
    expect(summary.interruptions).toBe(1)
    expect(summary.counts.total).toBe(3)
    expect(summary.counts.returned).toBe(2)
    expect(summary.failures).toEqual([{ jobId: 'MM-0002', code: 'ffmpeg-failed', short: 'encoder failed', message: 'The encoder stopped.' }])
    expect(summary.recipes).toHaveLength(1)
    expect(summary.ffmpeg).toEqual({ version: '9.0.2', source: 'bundled' })
    expect(summary.appVersion).toBe('5.0.0')
    expect(summary.policy).toBe(POLICY)
    expect(buildBatchSummary({ ...FACTS, elapsedMs: 5 }, []).elapsedMs).toBe(5)
  })

  it('builds index entries for open and finished runs', () =>
  {
    const open = openIndexEntry(RUN, 1000)
    expect(open).toMatchObject({ runId: RUN, startedAt: 1000, endedAt: null, endedBy: null, bytes: { input: 0, output: 0 } })
    expect(open.counts.total).toBe(0)
    const summary = buildBatchSummary(FACTS, [record({ seq: 1 })])
    const entry = indexEntryOf(RUN, 0, summary, [record({ seq: 1 }), record({ seq: 2, state: 'failed' })])
    expect(entry).toMatchObject({ startedAt: 1000, endedAt: 61000, endedBy: 'completed', bytes: { input: 1000, output: 800 } })
    expect(entry.counts.failed).toBe(1)
    expect(indexEntryOf(RUN, 7, null, []).startedAt).toBe(7)
  })
})

class MemoryDisk
{
  readonly files = new Map<string, string>()
  readonly io: PersistenceIO
  readonly fs: HistoryFs
  readonly store = { appendLines: async (path: string, values: readonly unknown[]): Promise<void> => this.append(path, values.map(jsonLine).join('')) }
  writes = 0

  constructor()
  {
    this.io = {
      append: async (path, text) => this.append(path, text),
      appendSync: (path, text) => this.append(path, text),
      fsync: async () => undefined,
      writeAtomic: async (path, text) =>
      {
        this.writes += 1
        this.files.set(path, text)
      },
      read: async (path) => this.files.get(path) ?? null,
      list: async (dir) =>
      {
        const names = new Set<string>()
        for (const key of this.files.keys())
        {
          if (key.startsWith(dir + sep))
          {
            names.add(key.slice(dir.length + 1).split(sep)[0])
          }
        }
        return [...names]
      },
      rename: async () => undefined,
      unlink: async (path) =>
      {
        this.files.delete(path)
      },
      mkdir: async () => undefined
    }
    this.fs = {
      stat: async (path) =>
      {
        const text = this.files.get(path)
        if (text !== undefined)
        {
          return { size: Buffer.byteLength(text), mtimeMs: 1, isFile: true }
        }
        return [...this.files.keys()].some((key) => key.startsWith(path + sep)) ? { size: 0, mtimeMs: 1, isFile: false } : null
      },
      removeTree: async (path) =>
      {
        for (const key of [...this.files.keys()])
        {
          if (key === path || key.startsWith(path + sep))
          {
            this.files.delete(key)
          }
        }
      }
    }
  }

  append(path: string, text: string): void
  {
    this.files.set(path, (this.files.get(path) ?? '') + text)
  }
}

const PATHS = jobsPaths(join('mem', 'jobs'))

function history(disk: MemoryDisk, extra: Partial<ConstructorParameters<typeof RunHistory>[0]> = {}): RunHistory
{
  return new RunHistory({ io: disk.io, fs: disk.fs, paths: PATHS, store: disk.store, ...extra })
}

function summaryOf(runId: RunId, records: HistoryRecord[], startedAt = 1000): BatchSummary
{
  return buildBatchSummary({ ...FACTS, runId, startedAt, endedAt: startedAt + 60000 }, records)
}

function indexOnDisk(disk: MemoryDisk): Array<{ runId: string; endedAt: number | null; counts: BatchSummary['counts'] }>
{
  return JSON.parse(disk.files.get(PATHS.runsIndex) as string)
}

describe('the run history', () =>
{
  it('writes the index at run start, records with refs, and the summary at completion', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    expect(await runs.load()).toEqual({ status: 'empty', runs: 0 })
    await runs.startRun(RUN, 1000)
    await runs.startRun(RUN, 1000)
    expect(indexOnDisk(disk)).toHaveLength(1)
    expect(indexOnDisk(disk)[0].endedAt).toBeNull()
    const first = await runs.appendRecord(record({ seq: 1 }))
    const second = await runs.appendRecord(record({ seq: 2, state: 'held', verdict: 'outside-tolerance' }))
    expect(first.offset).toBe(0)
    expect(second.offset).toBe(first.length)
    expect((await runs.readRecord(second))?.jobId).toBe('MM-0002')
    expect((await runs.get(RUN, 0, 10)).summary).toBeNull()
    const records = (await runs.readRun(RUN)).records
    const pruned = await runs.completeRun(summaryOf(RUN, records))
    expect(pruned).toEqual({ runs: [], logs: [] })
    const entry = indexOnDisk(disk)[0]
    expect(entry.endedAt).toBe(61000)
    expect(entry.counts.held).toBe(1)
    const page = await runs.get(RUN, 0, 10)
    expect(page.summary?.counts.total).toBe(2)
    expect(page.total).toBe(2)
  })

  it('appends a decision after the summary, reads it by its tag, and rewrites the index with the new counts', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    await runs.load()
    await runs.startRun(RUN, 1000)
    await runs.appendRecord(record({ seq: 1 }))
    await runs.appendRecord(record({ seq: 2, state: 'held', verdict: 'outside-tolerance' }))
    await runs.completeRun(summaryOf(RUN, (await runs.readRun(RUN)).records))
    const writes = disk.writes
    const kept = record({ seq: 2, state: 'done', verdict: 'outside-tolerance', endedAt: 90000 })
    const ref = await runs.recordDecision(kept)
    expect(disk.writes).toBe(writes + 1)
    const lines = (disk.files.get(PATHS.history(RUN)) as string).trim().split('\n').map((line) => JSON.parse(line).type)
    expect(lines).toEqual(['record', 'record', 'summary', 'record'])
    expect((await runs.readRecord(ref))?.state).toBe('done')
    const entry = indexOnDisk(disk)[0]
    expect(entry.counts.held).toBe(0)
    expect(entry.counts.done).toBe(2)
    expect(entry.counts.returned).toBe(1)
    expect(entry.endedAt).toBe(61000)
    const page = await runs.get(RUN, 0, 10)
    expect(page.records.map((r) => r.state)).toEqual(['done', 'done'])
    expect(page.summary?.counts.held).toBe(1)
  })

  it('records a decision for a run missing from the index', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    await runs.load()
    await runs.recordDecision(record({ seq: 1, runId: formatRunId(5) }))
    expect(runs.entries()[0]).toMatchObject({ runId: 'R-0005', startedAt: 1000, endedAt: null })
  })

  it('offsets concurrent appends one after another on an existing file', async () =>
  {
    const disk = new MemoryDisk()
    disk.files.set(PATHS.history(RUN), 'x'.repeat(10) + '\n')
    const runs = history(disk)
    const refs = await Promise.all([runs.appendRecord(record({ seq: 1 })), runs.appendRecord(record({ seq: 2 })), runs.appendRecord(record({ seq: 3 }))])
    expect(refs[0].offset).toBe(11)
    expect(refs[1].offset).toBe(11 + refs[0].length)
    expect(refs[2].offset).toBe(refs[1].offset + refs[1].length)
    expect((await runs.readRecord(refs[2]))?.jobId).toBe('MM-0003')
  })

  it('returns null for a ref the file no longer holds', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    expect(await runs.readRecord({ runId: RUN, offset: 0, length: 10 })).toBeNull()
    disk.files.set(PATHS.history(RUN), 'garbage line\n')
    expect(await runs.readRecord({ runId: RUN, offset: 0, length: 5 })).toBeNull()
  })

  it('loads a kept index newest first and rebuilds a corrupt or missing one from the run files', async () =>
  {
    const disk = new MemoryDisk()
    const older = formatRunId(9)
    const newer = formatRunId(10)
    disk.files.set(PATHS.runsIndex, JSON.stringify([openIndexEntry(older, 1), openIndexEntry(newer, 2), { runId: 'bad' }, null]))
    const kept = history(disk)
    expect(await kept.load()).toEqual({ status: 'ok', runs: 2 })
    expect(kept.entries().map((e) => e.runId)).toEqual([newer, older])

    disk.files.set(PATHS.runsIndex, '{ torn')
    disk.files.set(PATHS.history(older), jsonLine(record({ seq: 1, runId: older })) + jsonLine({ type: 'summary', schema: 1, summary: summaryOf(older, [record({ seq: 1, runId: older })], 500) }))
    disk.files.set(PATHS.history(newer), jsonLine(record({ seq: 2, runId: newer, state: 'failed' })))
    disk.files.set(join(PATHS.runs, 'notes.jsonl'), '')
    disk.files.set(join(PATHS.runs, 'readme.txt'), '')
    const rebuilt = history(disk)
    expect(await rebuilt.load()).toEqual({ status: 'rebuilt', runs: 2 })
    expect(rebuilt.entries()[0]).toMatchObject({ runId: newer, endedAt: null, startedAt: 1000 })
    expect(rebuilt.entries()[1]).toMatchObject({ runId: older, startedAt: 500, endedBy: 'completed' })
    expect(indexOnDisk(disk)).toHaveLength(2)

    disk.files.delete(PATHS.runsIndex)
    expect((await history(disk).load()).status).toBe('rebuilt')
    disk.files.set(PATHS.runsIndex, JSON.stringify({ not: 'a list' }))
    expect((await history(disk).load()).status).toBe('rebuilt')
  })

  it('rebuilds a run without started times from its end times', async () =>
  {
    const disk = new MemoryDisk()
    const rec = { ...record({ seq: 1 }), startedAt: null, endedAt: 4242 }
    disk.files.set(PATHS.history(RUN), jsonLine(rec))
    const runs = history(disk)
    await runs.load()
    expect(runs.entries()[0].startedAt).toBe(4242)
    disk.files.delete(PATHS.runsIndex)
    disk.files.set(PATHS.history(RUN), '')
    await runs.load()
    expect(runs.entries()[0].startedAt).toBe(0)
  })

  it('lists the index in pages with history and log usage', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    await runs.load()
    for (let seq = 1; seq <= 5; seq++)
    {
      await runs.startRun(formatRunId(seq), seq)
    }
    disk.files.set(PATHS.history(formatRunId(1)), 'a'.repeat(100))
    disk.files.set(PATHS.history(formatRunId(2)), 'b'.repeat(50))
    disk.files.set(PATHS.attemptLog(formatRunId(1), formatCatalog(1), 1), 'l'.repeat(30))
    disk.files.set(PATHS.attemptLog(formatRunId(9), formatCatalog(2), 1), 'l'.repeat(7))
    const first = await runs.list(null, 2)
    expect(first.runs.map((e) => e.runId)).toEqual(['R-0005', 'R-0004'])
    expect(first.more).toBe(true)
    expect(first.usage).toEqual({ runs: 5, historyBytes: 150, logBytes: 37 })
    const last = await runs.list(formatRunId(2), 2)
    expect(last.runs.map((e) => e.runId)).toEqual(['R-0001'])
    expect(last.more).toBe(false)
    expect((await runs.list(formatRunId(77), 2)).runs).toEqual([])
    expect((await runs.list(null, 0)).runs).toHaveLength(1)
  })

  it('pages a run at most 500 jobs at a time', async () =>
  {
    const disk = new MemoryDisk()
    disk.files.set(PATHS.history(RUN), Array.from({ length: 503 }, (_, i) => jsonLine(record({ seq: i + 1 }))).join(''))
    const runs = history(disk)
    const page = await runs.get(RUN, 0, 10000)
    expect(page.records).toHaveLength(500)
    expect(page.total).toBe(503)
    expect((await runs.get(RUN, 500, 10)).records).toHaveLength(3)
    expect((await runs.get(RUN, -4, 0)).records[0].jobId).toBe('MM-0001')
  })

  it('deletes runs with their logs, never the open run, and leaves outputs alone', async () =>
  {
    const disk = new MemoryDisk()
    const open = formatRunId(3)
    const runs = history(disk, { openRun: () => open })
    await runs.load()
    for (let seq = 1; seq <= 3; seq++)
    {
      const runId = formatRunId(seq)
      await runs.startRun(runId, seq)
      await runs.appendRecord(record({ seq, runId }))
      disk.files.set(PATHS.attemptLog(runId, formatCatalog(seq), 1), 'log')
    }
    disk.files.set('D:\\Exports\\track-1.m4a', 'output')
    expect(await runs.delete([formatRunId(1), formatRunId(1), formatRunId(42)])).toEqual({ deleted: 1 })
    expect(disk.files.has(PATHS.history(formatRunId(1)))).toBe(false)
    expect(disk.files.has(PATHS.attemptLog(formatRunId(1), formatCatalog(1), 1))).toBe(false)
    expect(disk.files.has('D:\\Exports\\track-1.m4a')).toBe(true)
    expect(await runs.delete('all')).toEqual({ deleted: 1 })
    expect(runs.entries().map((e) => e.runId)).toEqual([open])
    expect(disk.files.has(PATHS.history(open))).toBe(true)
    const appended = await runs.appendRecord(record({ seq: 9, runId: formatRunId(2) }))
    expect(appended.offset).toBe(0)
  })

  it('prunes the oldest runs past the run limit and the history budget, never the open run', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk, { limits: { runs: 3, historyBytes: 1e9, logBytes: 1e9 }, openRun: () => formatRunId(1) })
    await runs.load()
    for (let seq = 1; seq <= 5; seq++)
    {
      await runs.startRun(formatRunId(seq), seq)
    }
    expect((await runs.prune()).runs).toEqual(['R-0002', 'R-0003'])
    expect(runs.entries().map((e) => e.runId)).toEqual(['R-0005', 'R-0004', 'R-0001'])

    const sized = history(disk, { limits: { runs: 10, historyBytes: 250, logBytes: 1e9 } })
    disk.files.set(PATHS.history(formatRunId(1)), 'a'.repeat(100))
    disk.files.set(PATHS.history(formatRunId(4)), 'a'.repeat(100))
    disk.files.set(PATHS.history(formatRunId(5)), 'a'.repeat(100))
    await sized.load()
    expect((await sized.prune()).runs).toEqual(['R-0001'])
    expect((await sized.prune()).runs).toEqual([])
  })

  it('prunes the oldest logs past the log budget and keeps their records', async () =>
  {
    const disk = new MemoryDisk()
    const open = formatRunId(1)
    const runs = history(disk, { limits: { runs: 10, historyBytes: 1e9, logBytes: 100 }, openRun: () => open })
    await runs.load()
    for (let seq = 1; seq <= 4; seq++)
    {
      const runId = formatRunId(seq)
      await runs.startRun(runId, seq)
      await runs.appendRecord(record({ seq, runId }))
      disk.files.set(PATHS.attemptLog(runId, formatCatalog(seq), 1), 'l'.repeat(40))
    }
    const result = await runs.prune()
    expect(result.runs).toEqual([])
    expect(result.logs).toEqual(['R-0002', 'R-0003'])
    expect(disk.files.has(PATHS.attemptLog(formatRunId(1), formatCatalog(1), 1))).toBe(true)
    expect(disk.files.has(PATHS.attemptLog(formatRunId(2), formatCatalog(2), 1))).toBe(false)
    expect(disk.files.has(PATHS.history(formatRunId(2)))).toBe(true)
  })

  it('applies retention when a run completes', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk, { limits: { runs: 1, historyBytes: 1e9, logBytes: 1e9 } })
    await runs.load()
    await runs.startRun(formatRunId(1), 1)
    await runs.startRun(formatRunId(2), 2)
    const pruned = await runs.completeRun(summaryOf(formatRunId(2), []))
    expect(pruned.runs).toEqual(['R-0001'])
  })

  it('keeps writing the index after a failed write', async () =>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    const write = disk.io.writeAtomic
    let fail = true
    disk.io.writeAtomic = async (path, text) =>
    {
      if (fail)
      {
        fail = false
        throw new Error('disk full')
      }
      return write(path, text)
    }
    await expect(runs.startRun(formatRunId(1), 1)).rejects.toThrow('disk full')
    await runs.startRun(formatRunId(2), 2)
    expect(indexOnDisk(disk)).toHaveLength(2)
  })
})

describe('the node history file access', () =>
{
  let dir: string | null = null

  afterEach(() =>
  {
    if (dir)
    {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  it('stats files and folders, reports missing paths, and removes trees', async () =>
  {
    dir = mkdtempSync(join(tmpdir(), 'mm-history-'))
    const nodeFs = createNodeHistoryFs()
    const file = join(dir, 'a.jsonl')
    writeFileSync(file, 'hello')
    mkdirSync(join(dir, 'logs', 'R-0001'), { recursive: true })
    writeFileSync(join(dir, 'logs', 'R-0001', 'x.log'), 'x')
    expect(await nodeFs.stat(file)).toMatchObject({ size: 5, isFile: true })
    expect((await nodeFs.stat(join(dir, 'logs')))?.isFile).toBe(false)
    expect(await nodeFs.stat(join(dir, 'missing'))).toBeNull()
    expect(await nodeFs.stat(join(file, 'inside'))).toBeNull()
    await nodeFs.removeTree(join(dir, 'logs'))
    await nodeFs.removeTree(join(dir, 'never'))
    expect(existsSync(join(dir, 'logs'))).toBe(false)
  })

  it('rethrows unexpected stat errors', async () =>
  {
    const nodeFs = createNodeHistoryFs()
    await expect(nodeFs.stat('bad\0path')).rejects.toThrow()
  })
})

describe('paths', () =>
{
  it('splits Windows and POSIX paths and compares Windows paths without case', () =>
  {
    expect(fileName('D:\\Audio\\Interview 01.wav')).toBe('Interview 01.wav')
    expect(fileName('/home/me/a.flac')).toBe('a.flac')
    expect(fileName('plain')).toBe('plain')
    expect(folderOf('D:\\Audio\\a.wav')).toBe('D:\\Audio')
    expect(folderOf('/a.wav')).toBe('/')
    expect(folderOf('/home/a.wav')).toBe('/home')
    expect(folderOf('a.wav')).toBe('')
    expect(samePath('D:\\Audio\\A.flac', 'd:/audio/a.FLAC')).toBe(true)
    expect(samePath('\\\\nas\\x\\a', '//NAS/x/a')).toBe(true)
    expect(samePath('/a/B', '/a/b')).toBe(false)
    expect(samePath('/a/b', '/a/b')).toBe(true)
  })
})

async function searchable(): Promise<{ disk: MemoryDisk; runs: RunHistory }>
{
  const disk = new MemoryDisk()
  const runs = history(disk)
  await runs.load()
  const r29 = formatRunId(29)
  const r30 = formatRunId(30)
  await runs.startRun(r29, 1)
  await runs.startRun(r30, 2)
  await runs.appendRecord(record({ seq: 131, runId: r29, path: 'D:\\Podcasts\\interview-ann.wav', endedAt: 10 }))
  await runs.appendRecord(record({ seq: 132, runId: r29, path: 'D:\\Podcasts\\music.wav', endedAt: 11 }))
  await runs.appendRecord(record({ seq: 133, runId: r29, path: 'D:\\Interviews\\bob.wav', endedAt: 12, state: 'failed' }))
  await runs.appendRecord(record({ seq: 140, runId: r30, path: 'E:\\Raw\\Interview-cid.wav', endedAt: 20, state: 'held', verdict: 'outside-tolerance' }))
  await runs.appendRecord(record({ seq: 140, runId: r30, path: 'E:\\Raw\\Interview-cid.wav', endedAt: 21 }))
  return { disk, runs }
}

describe('history search', () =>
{
  it('matches names, paths, and catalog numbers across runs, newest first, one match per job', async () =>
  {
    const { runs } = await searchable()
    const all = await runs.search('  "Interview" ', 10, null)
    expect(all.matches.map((m) => m.jobId)).toEqual(['MM-0140', 'MM-0133', 'MM-0131'])
    expect(all.runs).toBe(2)
    expect(all.more).toBe(false)
    expect(all.matches[0]).toMatchObject({ runId: 'R-0030', attempt: 1, sourceName: 'Interview-cid.wav', sourcePath: 'E:\\Raw\\Interview-cid.wav', state: 'done', verdict: 'verified', endedAt: 21 })
    expect(all.matches[0].stamp?.verdict).toBe('verified')
    expect(all.matches[1]).toMatchObject({ state: 'failed', verdict: 'failed', stamp: null })
    expect((await runs.search('mm-131', 10, null)).matches.map((m) => m.jobId)).toEqual(['MM-0131'])
    expect((await runs.search('132', 10, null)).matches.map((m) => m.jobId)).toEqual(['MM-0132'])
    expect((await runs.search('MM-0140', 10, null)).matches).toHaveLength(1)
    expect((await runs.search('podcasts\\music', 10, null)).matches.map((m) => m.jobId)).toEqual(['MM-0132'])
    expect((await runs.search('nothing here', 10, null)).matches).toEqual([])
  })

  it('returns nothing for an empty query', async () =>
  {
    const { runs } = await searchable()
    expect(await runs.search('   ', 10, null)).toEqual({ matches: [], runs: 0, more: false })
    expect(recordMatcher('')).toBeNull()
  })

  it('pages after a cursor and stops at the limit', async () =>
  {
    const { runs } = await searchable()
    const first = await runs.search('interview', 1, null)
    expect(first.matches.map((m) => m.jobId)).toEqual(['MM-0140'])
    expect(first.more).toBe(true)
    const second = await runs.search('interview', 1, { runId: first.matches[0].runId, jobId: first.matches[0].jobId })
    expect(second.matches.map((m) => m.jobId)).toEqual(['MM-0133'])
    expect(second.more).toBe(true)
    const third = await runs.search('interview', 5, { runId: second.matches[0].runId, jobId: second.matches[0].jobId })
    expect(third.matches.map((m) => m.jobId)).toEqual(['MM-0131'])
    expect(third.more).toBe(false)
    const gone = await runs.search('interview', 5, { runId: formatRunId(29), jobId: formatCatalog(999) })
    expect(gone.matches).toEqual([])
    const deletedRun = await runs.search('interview', 5, { runId: formatRunId(35), jobId: formatCatalog(1) })
    expect(deletedRun.matches).toHaveLength(3)
    const zero = await runs.search('interview', 0, null)
    expect(zero.matches).toHaveLength(1)
  })
})

describe('rerun checks', () =>
{
  async function rerunRun(): Promise<{ disk: MemoryDisk; runs: RunHistory; run: RunId }>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    await runs.load()
    const run = formatRunId(29)
    await runs.startRun(run, 1)
    const replaced = record({ seq: 131, runId: run, path: 'D:\\Live\\set.flac', placement: { kind: 'replaced-original', original: { status: 'trashed' } } })
    replaced.output = { path: 'd:/live/SET.flac', bytes: 800, container: 'flac' }
    await runs.appendRecord(replaced)
    await runs.appendRecord(record({ seq: 132, runId: run, path: 'D:\\Live\\gone.flac', state: 'failed' }))
    await runs.appendRecord(record({ seq: 133, runId: run, path: 'D:\\Live\\ok.flac' }))
    await runs.appendRecord(record({ seq: 134, runId: run, path: 'D:\\Live\\held.flac', state: 'held', verdict: 'outside-tolerance' }))
    disk.files.set('D:\\Live\\set.flac', 'o'.repeat(800))
    disk.files.set('D:\\Live\\ok.flac', 'k'.repeat(1000))
    disk.files.set('D:\\Live\\held.flac', 'h'.repeat(1000))
    return { disk, runs, run }
  }

  it('reports missing sources and paths holding the job output, and adds the rest with rerunOf', async () =>
  {
    const { runs, run } = await rerunRun()
    const check = await runs.rerunCheck(run, 'all', false)
    expect(check.missing).toEqual([{ jobId: 'MM-0132', path: 'D:\\Live\\gone.flac' }])
    expect(check.holdsOutput).toEqual([{ jobId: 'MM-0131', path: 'D:\\Live\\set.flac', originalTrashed: true }])
    expect(check.add.map((a) => a.path)).toEqual(['D:\\Live\\ok.flac', 'D:\\Live\\held.flac'])
    expect(check.add[0].rerunOf).toEqual({ runId: run, jobId: 'MM-0133' })
    expect(check.add[0].recipe).toEqual(normalizeRecipe())
  })

  it('adds a path holding the output when forced, never a missing source', async () =>
  {
    const { runs, run } = await rerunRun()
    const forced = await runs.rerunCheck(run, [formatCatalog(131), formatCatalog(132)], true)
    expect(forced.holdsOutput).toEqual([])
    expect(forced.missing).toHaveLength(1)
    expect(forced.add.map((a) => a.rerunOf.jobId)).toEqual(['MM-0131'])
  })

  it('reruns only returned jobs for returned', async () =>
  {
    const { runs, run } = await rerunRun()
    const returned = await runs.rerunCheck(run, 'returned', false)
    expect(returned.missing.map((m) => m.jobId)).toEqual(['MM-0132'])
    expect(returned.add.map((a) => a.rerunOf.jobId)).toEqual(['MM-0134'])
  })

  it('treats a folder at the source path as missing', async () =>
  {
    const { disk, runs, run } = await rerunRun()
    disk.files.set('D:\\Live\\gone.flac\\inner', 'x')
    expect((await runs.rerunCheck(run, [formatCatalog(132)], false)).missing).toHaveLength(1)
  })

  it('recognizes the job output only at the source path with the output size', () =>
  {
    const replaced = record({ seq: 1, path: 'D:\\a.flac', placement: { kind: 'replaced-original', original: { status: 'kept', path: 'D:\\a (original).flac', reason: 'no bin' } } })
    replaced.output = { path: 'D:\\a.flac', bytes: 800, container: 'flac' }
    expect(holdsOwnOutput(replaced, { size: 800, mtimeMs: 9 })).toBe(true)
    expect(holdsOwnOutput(replaced, { size: 801, mtimeMs: 9 })).toBe(false)
    expect(holdsOwnOutput({ ...replaced, source: { ...replaced.source, size: 800 } }, { size: 800, mtimeMs: 5000 })).toBe(false)
    expect(holdsOwnOutput(record({ seq: 2 }), { size: 800, mtimeMs: 9 })).toBe(false)
    expect(holdsOwnOutput({ ...replaced, state: 'held' }, { size: 800, mtimeMs: 9 })).toBe(false)
    expect(holdsOwnOutput({ ...replaced, output: null }, { size: 800, mtimeMs: 9 })).toBe(false)
    expect(originalTrashed(replaced.placement)).toBe(false)
    expect(originalTrashed(null)).toBe(false)
    expect(originalTrashed({ kind: 'new' })).toBe(false)
  })
})

const LOOKUP = presetLookup()

function summaryRow(rec: HistoryRecord, policy: FrozenPolicy = POLICY): ReportRow
{
  return { record: rec, summary: { ...summaryOf(rec.runId, [rec]), policy }, attempts: [rec] }
}

function parseCsv(text: string): string[][]
{
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++)
  {
    const char = text[i]
    if (quoted)
    {
      if (char === '"' && text[i + 1] === '"')
      {
        field += '"'
        i += 1
      }
      else if (char === '"')
      {
        quoted = false
      }
      else
      {
        field += char
      }
    }
    else if (char === '"')
    {
      quoted = true
    }
    else if (char === ',')
    {
      row.push(field)
      field = ''
    }
    else if (char === '\r' && text[i + 1] === '\n')
    {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
    }
    else
    {
      field += char
    }
  }
  return rows
}

function plannedRecord(): HistoryRecord
{
  const rec = measured(record({ seq: 131 }), [{ ...gainPlan(1.8, -16, 'peak-limited'), gainDb: 4.25 }])
  rec.measurement!.streams[0].measurement.stats.loudnessRangeLu = 7.04
  rec.plan = {
    output: { container: 'm4a' },
    streams: { kept: [{ kind: 'audio', source: 1, output: 0, action: 'encode' }], dropped: [{ kind: 'subtitle', source: 2, reason: 'not supported by M4A' }], chapters: 'none' },
    video: null,
    audio: [{ encoder: 'aac', messages: [{ key: 'verified', params: { I: -16.1, unit: 'LKFS', preset: 'apple-podcasts', T: -16, tol: 1, class: 'lossy', TP: -1.6, gate: -1 } }] }],
    command: { argv: [], display: 'ffmpeg -i "a.wav" out.m4a', placeholders: [] }
  } as unknown as JobPlan
  rec.warnings = [{ code: 'ran-on-cpu', short: 'ran on CPU', message: 'Ran on the CPU.' }, { code: 'source-changed', short: 'changed', message: 'The source changed.' }]
  return rec
}

describe('report wording', () =>
{
  it('words verdicts, states, originals, placements, policies, and builds', () =>
  {
    expect(['verified', 'passthrough', 'verified-below-target', 'outside-tolerance', 'failed', null].map((v) => verdictWords(v as Verdict | null)))
      .toEqual(['verified', 'verified', 'verified, reachable level', 'outside tolerance', 'failed', ''])
    expect(statusWords('held')).toBe('waiting for a decision')
    expect(statusWords('canceled')).toBe('canceled')
    expect(binName('D:\\a.flac')).toBe('Recycle Bin on D:')
    expect(binName('/home/a.flac')).toBe('Trash')
    const trashed = record({ seq: 1, path: 'D:\\a.flac', placement: { kind: 'replaced-original', original: { status: 'trashed' } } })
    expect(originalWords(trashed)).toBe('Recycle Bin on D:')
    const kept = record({ seq: 1, placement: { kind: 'replaced-original', original: { status: 'kept', path: 'D:\\concert-set-02 (original).flac', reason: 'no bin' } } })
    expect(originalWords(kept)).toBe('kept as D:\\concert-set-02 (original).flac')
    expect(originalWords(record({ seq: 1 }))).toBe('not touched')
    expect(placementWords({ kind: 'new' }, 'D:\\x')).toBe('new file')
    expect(placementWords({ kind: 'renamed', planned: 'D:\\Exports\\a.m4a' }, 'D:\\x')).toBe('renamed, a.m4a was taken')
    expect(placementWords({ kind: 'overwrote', previous: { status: 'trashed' } }, 'E:\\x')).toBe('overwrote a file, sent to the Recycle Bin on E:')
    expect(placementWords({ kind: 'overwrote', previous: { status: 'kept', path: 'E:\\x (previous)', reason: 'r' } }, 'E:\\x')).toBe('overwrote a file, kept as E:\\x (previous)')
    expect(placementWords({ kind: 'replaced-original', original: { status: 'trashed' } }, 'E:\\x')).toBe('replaced the original')
    expect(placementWords(null, 'E:\\x')).toBe('')
    expect(policyWords(POLICY)).toBe('Folder D:\\Exports, template {name}, existing files: rename, displaced files: to the bin')
    expect(policyWords({ ...POLICY, destination: { mode: 'next-to-source' }, displaced: 'keep' })).toBe('Next to source, template {name}, existing files: rename, displaced files: kept')
    expect(policyWords({ ...POLICY, destination: { mode: 'replace-originals' } })).toMatch(/^Replace originals,/)
    expect(ffmpegWords({ version: '9.0.2', source: 'bundled' })).toBe('9.0.2 (pinned)')
    expect(ffmpegWords({ version: '7.1', source: 'path' })).toBe('7.1 (PATH)')
    expect(ffmpegWords({ version: 'n8', source: 'custom' })).toBe('n8 (custom)')
  })

  it('quotes CSV fields and defuses formulas but keeps signed numbers', () =>
  {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField(' edge')).toBe('" edge"')
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvField('+1')).toBe("'+1")
    expect(csvField('@x')).toBe("'@x")
    expect(csvField('-cmd|calc')).toBe("'-cmd|calc")
    expect(csvField('-16.2')).toBe('-16.2')
    expect(csvField('-16.0 LKFS')).toBe('-16.0 LKFS')
  })

  it('names the report file and opens the dialog in the destination folder', () =>
  {
    expect(reportName('Batch 31', 'csv')).toBe('molexMedia Batch 31 report.csv')
    expect(reportName('Batch 31', 'json')).toBe('molexMedia Batch 31 report.json')
    const rec = record({ seq: 1, path: 'C:\\Music\\a.wav' })
    expect(reportFolder([summaryRow(rec)])).toBe('D:\\Exports')
    expect(reportFolder([summaryRow(rec, { ...POLICY, destination: { mode: 'replace-originals' } })])).toBe('C:\\Music')
    expect(reportFolder([{ record: rec, summary: null, attempts: [] }])).toBe('C:\\Music')
    expect(reportFolder([])).toBeNull()
    expect(joinReportPath('D:\\Exports', 'r.csv')).toBe('D:\\Exports\\r.csv')
    expect(joinReportPath('D:\\', 'r.csv')).toBe('D:\\r.csv')
    expect(joinReportPath('/home/me', 'r.csv')).toBe('/home/me/r.csv')
    expect(joinReportPath('', 'r.csv')).toBe('r.csv')
    expect(joinReportPath(null, 'r.csv')).toBe('r.csv')
  })
})

describe('the CSV report', () =>
{
  it('writes every report column in order with its wording', () =>
  {
    const rec = plannedRecord()
    const csv = reportCsv([summaryRow(rec)], LOOKUP)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    const [header, row] = parseCsv(csv.slice(1))
    expect(header).toEqual([...REPORT_COLUMNS])
    expect(header).toHaveLength(46)
    const value = Object.fromEntries(header.map((name, i) => [name, row[i]]))
    expect(value).toMatchObject({
      'Batch': 'Batch 31',
      'Job': 'MM-0131',
      'Attempt': '1',
      'Status': 'done',
      'Verdict': 'verified',
      'Source': 'D:\\Audio\\track-131.wav',
      'Source size': '1000',
      'Source duration': '60',
      'Output': 'D:\\Exports\\track-131.m4a',
      'Output size': '800',
      'Placement': 'new file',
      'Original': 'not touched',
      'Operation': 'Normalize',
      'Edited': 'no',
      'Audio encoders': 'aac',
      'Video encoder': '',
      'GPU': '',
      'Streams kept': 'audio 1 (encode)',
      'Streams not kept': 'subtitle 2: not supported by M4A',
      'Started': new Date(1000).toISOString(),
      'Finished': new Date(2131).toISOString(),
      'Elapsed': '4',
      'Integrated before': '-20.0',
      'Range before': '7.0',
      'True peak before': '-3.0',
      'Gain planned': '4.3',
      'Plan mode': 'peak limited',
      'Peak limiting planned': '1.8',
      'Integrated after': '-16.1',
      'Range after': '6.2',
      'True peak after': '-1.6',
      'Sample peak after': '-2.0',
      'Target': '-16.0 LKFS',
      'Standard tolerance': '±1 dB',
      'App check': '±1.0 LU',
      'Verification': 'full decode',
      'Warnings': 'Ran on the CPU. The source changed.',
      'Error': '',
      'Exit code': '',
      'Command': 'ffmpeg -i "a.wav" out.m4a',
      'Output policy': 'Folder D:\\Exports, template {name}, existing files: rename, displaced files: to the bin',
      'FFmpeg build': '9.0.2 (pinned)',
      'molexMedia version': '5.0.0'
    })
    expect(value['Preset']).toBe(LOOKUP(rec.recipe)?.label)
    expect(value['Recipe']).not.toBe('')
    expect(value['Container']).not.toBe('')
  })

  it('words failed, held, reachable, and video rows', () =>
  {
    const failed = record({ seq: 2, state: 'failed' })
    failed.error = { code: 'ffmpeg-failed', short: 'encoder failed', message: 'The encoder stopped.', exitCode: -22, command: { argv: [], display: 'ffmpeg -x' }, stderrTail: 'tail' } as unknown as JobError
    const held = record({ seq: 3, state: 'held', verdict: 'outside-tolerance' })
    const reachable = record({ seq: 4, verdict: 'verified-below-target' })
    const video = record({ seq: 5, recipe: compressRecipe({ mode: 'crf', crf: 23 }) })
    video.result!.encoder = { video: 'hevc_nvenc', audio: ['aac', 'ac3'] }
    video.result!.stamp.decode = 'sampled'
    video.result!.stamp.loudness = null
    video.verification = { ...video.verification!, audio: null, media: { decode: 'sampled', expectedDurationSec: 61.5 } } as unknown as Verification
    video.plan = { output: { container: 'mp4' }, video: { encoder: 'hevc_nvenc', gpu: 'NVIDIA RTX' }, audio: [], streams: { kept: [], dropped: [] }, command: null } as unknown as JobPlan
    const edited = { ...normalizeRecipe() }
    ;(edited as { mono?: unknown }).mono = 'played-on-two-speakers-edited'
    const editedRow = record({ seq: 6, recipe: edited })
    const noStart = { ...record({ seq: 7, state: 'canceled' }), startedAt: null }
    const csv = reportCsv([failed, held, reachable, video, editedRow, noStart].map((r) => ({ record: r, summary: null, attempts: [r] })), LOOKUP)
    const rows = parseCsv(csv.slice(1))
    const header = rows[0]
    const at = (row: number, column: ReportColumn): string => rows[row][header.indexOf(column)]
    expect(at(1, 'Status')).toBe('failed')
    expect(at(1, 'Verdict')).toBe('failed')
    expect(at(1, 'Error')).toBe('The encoder stopped.')
    expect(at(1, 'Exit code')).toBe('-22')
    expect(at(1, 'Command')).toBe('ffmpeg -x')
    expect(at(1, 'Output')).toBe('')
    expect(at(1, 'Output policy')).toBe('')
    expect(at(1, 'FFmpeg build')).toBe('')
    expect(at(2, 'Status')).toBe('waiting for a decision')
    expect(at(2, 'Verdict')).toBe('outside tolerance')
    expect(at(3, 'Verdict')).toBe('verified, reachable level')
    expect(at(4, 'Video encoder')).toBe('hevc_nvenc')
    expect(at(4, 'Audio encoders')).toBe('aac, ac3')
    expect(at(4, 'GPU')).toBe('NVIDIA RTX')
    expect(at(4, 'Verification')).toBe('sampled decode')
    expect(at(4, 'Source duration')).toBe('61.5')
    expect(at(4, 'Target')).toBe('')
    expect(at(4, 'App check')).toBe('')
    expect(at(4, 'Operation')).toBe('Compress')
    expect(at(5, 'Edited')).toBe('yes')
    expect(at(6, 'Elapsed')).toBe('')
    expect(at(6, 'Started')).toBe('')
    expect(at(6, 'Verification')).toBe('')
  })

  it('reads values from the verdict stream and falls back without stamps', () =>
  {
    const rec = record({ seq: 8 })
    rec.verification = verification('verified', [{ lufs: -16.4, peak: -2 }, { lufs: -15.8, peak: -1.2 }])
    rec.result!.stamp.verdictStream = 1
    rec.result!.stamp.loudness = null
    const values = reportValues({ record: rec, summary: null, attempts: [] }, LOOKUP)
    expect(values['Integrated after']).toBe('-15.8')
    expect(values['App check']).toBe('±1.0 LU')
    expect(values['Target']).toBe('')
    expect(values['Integrated before']).toBe('')
    const zero = record({ seq: 9 })
    zero.verification = verification('verified', [{ lufs: -0.01, peak: -1 }])
    expect(reportValues({ record: zero, summary: null, attempts: [] }, LOOKUP)['Integrated after']).toBe('0.0')
    const gpuFallback = record({ seq: 10 })
    gpuFallback.plan = { output: { container: 'mp4' }, video: { encoder: 'libx264', gpu: 'NVIDIA RTX' }, audio: [], streams: { kept: [], dropped: [] }, command: null } as unknown as JobPlan
    gpuFallback.warnings = [{ code: 'ran-on-cpu', short: 'cpu', message: 'Ran on the CPU.' }]
    expect(reportValues({ record: gpuFallback, summary: null, attempts: [] }, LOOKUP)['GPU']).toBe('no, ran on the CPU instead of NVIDIA RTX')
    gpuFallback.plan = { ...gpuFallback.plan, video: { encoder: 'libx264', gpu: null } } as unknown as JobPlan
    expect(reportValues({ record: gpuFallback, summary: null, attempts: [] }, LOOKUP)['GPU']).toBe('no')
    const bare = { ...record({ seq: 11, state: 'skipped' }), verification: null, result: null }
    const bareValues = reportValues({ record: bare, summary: null, attempts: [] }, LOOKUP)
    expect(bareValues['Container']).toBe('')
    expect(bareValues['Verdict']).toBe('')
    expect(bareValues['Elapsed']).toBe('1.011')
  })
})

describe('report export', () =>
{
  async function reportHistory(): Promise<{ disk: MemoryDisk; runs: RunHistory }>
  {
    const disk = new MemoryDisk()
    const runs = history(disk)
    await runs.load()
    const r30 = formatRunId(30)
    await runs.startRun(r30, 1)
    await runs.appendRecord(record({ seq: 120, runId: r30 }))
    await runs.completeRun(summaryOf(r30, [record({ seq: 120, runId: r30 })]))
    await runs.startRun(RUN, 2)
    const firstTry = record({ seq: 131, state: 'failed' })
    firstTry.error = { code: 'ffmpeg-failed', short: 'encoder failed', message: 'The encoder stopped.', stderrTail: 'attempt 1 tail' } as JobError
    await runs.appendRecord(firstTry)
    const second = { ...plannedRecord(), attempt: 2, attempts: [{ attempt: 1, runId: RUN, recipe: normalizeRecipe(), state: 'failed', startedAt: 1, endedAt: 2, verdict: null, errorCode: 'ffmpeg-failed' }] } as HistoryRecord
    second.verification = { ...second.verification!, messages: [{ key: 'verified', params: { I: -16.1, unit: 'LKFS', preset: 'apple-podcasts', T: -16, tol: 1, class: 'lossy', TP: -1.6, gate: -1 } }] }
    await runs.appendRecord(second)
    const failed = record({ seq: 132, state: 'failed' })
    failed.error = { code: 'decode-errors', short: 'decode errors', message: 'Decode errors.', stderrTail: 'last lines' } as JobError
    failed.attempts = [{ attempt: 0, runId: null, recipe: normalizeRecipe(), state: 'failed', startedAt: 1, endedAt: 2, verdict: null, errorCode: 'ffmpeg-failed' }]
    await runs.appendRecord(failed)
    await runs.completeRun(summaryOf(RUN, (await runs.readRun(RUN)).records))
    disk.files.set(PATHS.attemptLog(RUN, formatCatalog(131), 1), 'line one\nline two\n')
    return { disk, runs }
  }

  it('offers the default name in the destination folder and writes the CSV there', async () =>
  {
    const { disk, runs } = await reportHistory()
    let offered = ''
    const saved = await runs.exportReport({ runId: RUN }, 'csv', { lookup: LOOKUP, choose: async (path) => (offered = path, 'D:\\Exports\\Podcasts\\out.csv') })
    expect(offered).toBe('D:\\Exports\\molexMedia Batch 31 report.csv')
    expect(saved).toEqual({ path: 'D:\\Exports\\Podcasts\\out.csv' })
    const rows = parseCsv((disk.files.get('D:\\Exports\\Podcasts\\out.csv') as string).slice(1))
    expect(rows).toHaveLength(3)
    expect(rows[1][1]).toBe('MM-0131')
    expect(rows[1][2]).toBe('2')
  })

  it('returns canceled when the dialog is closed and writes nothing', async () =>
  {
    const { disk, runs } = await reportHistory()
    const files = disk.files.size
    expect(await runs.exportReport({ runId: RUN }, 'json', { lookup: LOOKUP, choose: async () => null })).toEqual({ canceled: true })
    expect(disk.files.size).toBe(files)
  })

  it('writes the JSON report with full records, every attempt, rendered audio text, and failed attempt tails', async () =>
  {
    const { disk, runs } = await reportHistory()
    let offered = ''
    await runs.exportReport({ runId: RUN }, 'json', { lookup: LOOKUP, now: () => 0, choose: async (path) => (offered = path, 'D:\\r.json') })
    expect(offered).toBe('D:\\Exports\\molexMedia Batch 31 report.json')
    const report = JSON.parse(disk.files.get('D:\\r.json') as string)
    expect(report.schema).toBe(1)
    expect(report.report).toBe('molexMedia Batch 31')
    expect(report.generatedAt).toBe(new Date(0).toISOString())
    expect(report.batches).toHaveLength(1)
    expect(report.batches[0].summary.appVersion).toBe('5.0.0')
    const [job131, job132] = report.jobs
    expect(job131.columns.Verdict).toBe('verified')
    expect(job131.record.plan.streams.kept).toHaveLength(1)
    expect(job131.record.verification.audio).toHaveLength(1)
    expect(job131.attempts.map((a: HistoryRecord) => a.attempt)).toEqual([1, 2])
    expect(job131.failedAttempts).toEqual([{ attempt: 1, runId: RUN, errorCode: 'ffmpeg-failed', tail: 'line one\nline two\n' }])
    expect(job131.text.plan[0]).toContain('-16')
    expect(job131.text.verification[0]).toContain('-16')
    expect(job131.text.verification[0]).not.toContain('\u2212')
    expect(job131.text.measurement).toEqual([])
    expect(job132.failedAttempts).toEqual([
      { attempt: 0, runId: null, errorCode: 'ffmpeg-failed', tail: null },
      { attempt: 1, runId: RUN, errorCode: 'decode-errors', tail: 'last lines' }
    ])
    expect(job132.text).toEqual({ plan: [], measurement: [], verification: [] })
  })

  it('reports jobs by catalog number at their newest records across runs', async () =>
  {
    const { disk, runs } = await reportHistory()
    let offered = ''
    await runs.exportReport({ ids: [formatCatalog(132), formatCatalog(120), formatCatalog(999), formatCatalog(132)] }, 'csv', { lookup: LOOKUP, choose: async (path) => (offered = path, 'D:\\ids.csv') })
    expect(offered).toBe('D:\\Exports\\molexMedia jobs report.csv')
    const rows = parseCsv((disk.files.get('D:\\ids.csv') as string).slice(1))
    expect(rows.slice(1).map((r) => r[1])).toEqual(['MM-0132', 'MM-0120'])
    expect(rows.slice(1).map((r) => r[0])).toEqual(['Batch 31', 'Batch 30'])
    await runs.exportReport({ ids: [formatCatalog(131)] }, 'csv', { lookup: LOOKUP, choose: async (path) => (offered = path, null) })
    expect(offered).toBe('D:\\Exports\\molexMedia Batch 31 report.csv')
    await runs.exportReport({ ids: [formatCatalog(120)] }, 'csv', { lookup: LOOKUP, choose: async (path) => (offered = path, null) })
    expect(offered).toBe('D:\\Exports\\molexMedia Batch 30 report.csv')
    await runs.exportReport({ ids: [] }, 'json', { lookup: LOOKUP, choose: async (path) => (offered = path, null) })
    expect(offered).toBe('molexMedia jobs report.json')
  })
})
