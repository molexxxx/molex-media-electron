/**
 * The job table: rows in the queue order the snapshot gives and a sort cycle that ends in queue order, each
 * list's priority columns at 680 and 960 px of grid width, the held Status cell with its hidden words, the
 * stamp on finished rows and the 4 px bar with its percent on active ones, the File cell truncated in the
 * middle with its extension kept, the cells' words, and rows that are never disabled.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { AudioPlanCell, BatchPolicy, JobProgress, JobView, MediaSummary, PlanSummary, ResultStamp, RunState } from '../../../src/shared/jobs/types'
import { useBatchView } from '../../../src/renderer/src/stores/batchView'
import { initialJobsState, useJobsStore, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { visibleGridColumns } from '../../../src/renderer/src/ui/DataGrid'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'
import { NOT_ACKNOWLEDGED } from '../../../src/renderer/src/ui/StatusLabel'
import { JobTable, type JobTableProps } from '../../../src/renderer/src/components/batch/table/JobTable'
import
{
  albumLetter,
  audioPlanText,
  finishedText,
  MEASURED_AT_RUN,
  MiddleTruncate,
  TabularNumbers,
  outText,
  outputNote,
  planPending,
  quickActionFor,
  quickActionLabel,
  recipeNotes,
  recipeParts,
  ROW_STAMP_FIT,
  rowStampTooltip,
  sourceSummary,
  speedText,
  splitFileName,
  statusKeyFor,
  timeText,
  videoCodecLabel
} from '../../../src/renderer/src/components/batch/table/cells'
import
{
  ACTIONS_LABEL,
  isSortable,
  jobColumns,
  NARROW_TABLE_WIDTH,
  QUICK_ACTIONS_LABEL,
  sortKey,
  type JobColumnOptions,
  type JobColumnSet
} from '../../../src/renderer/src/components/batch/table/columns'

let reportWidth: (width: number) => void = () => undefined

beforeEach(() =>
{
  useJobsStore.setState(initialJobsState(), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
  reportWidth = observeWidths()
})

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Replaces the ResizeObserver so a test can report the grid's width. */
function observeWidths(): (width: number) => void
{
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal('ResizeObserver', class
  {
    constructor(callback: ResizeObserverCallback)
    {
      callbacks.push(callback)
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  })
  return (width: number) =>
  {
    const entry = { borderBoxSize: [{ inlineSize: width, blockSize: 400 }], contentRect: { width, height: 400 } } as unknown as ResizeObserverEntry
    act(() => callbacks.forEach((callback) => callback([entry], {} as ResizeObserver)))
  }
}

const AT = new Date(2026, 9, 16, 13, 40).getTime()
const R31 = 'R-0031' as RunId
const M = '\u2212'

const RECIPE = { kind: 'normalize', presetId: 'streaming' } as unknown as JobView['recipe']

let seq = 0

function plan(over: Partial<PlanSummary> = {}): PlanSummary
{
  return {
    status: 'ready',
    current: true,
    finalName: 'a.wav',
    relativePath: 'a.wav',
    container: 'wav',
    resolution: 'place',
    encoderLabel: 'PCM 24-bit',
    errors: 0,
    warnings: 0,
    firstIssue: null,
    ...over
  }
}

function media(over: Partial<MediaSummary> = {}): MediaSummary
{
  return { container: 'wav', durationSec: 3730, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false, ...over }
}

function job(over: Partial<JobView> = {}): JobView
{
  seq += 1
  const id = `MM-${String(seq).padStart(4, '0')}` as JobId
  return {
    id,
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.wav`, name: `${id}.wav`, ext: 'wav', dir: 'D:\\Rips', size: 498_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE,
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: media(),
    probe: 'ok',
    plan: plan(),
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function options(over: Partial<JobColumnOptions> = {}): JobColumnOptions
{
  return { lookup: () => null, platform: 'win32', ...over }
}

function shownAt(set: JobColumnSet, width: number, over: Partial<JobColumnOptions> = {}): string[]
{
  return visibleGridColumns(jobColumns(set, options(over)), [], width).map((column) => column.id)
}

describe('file names truncated in the middle', () =>
{
  it('keeps the end of the stem and the extension in the tail', () =>
  {
    expect(splitFileName('podcast-episode-142.wav')).toEqual({ head: 'podcast-episo', tail: 'de-142.wav' })
    expect(splitFileName('concert set (2).flac')).toEqual({ head: 'concert s', tail: 'et (2).flac' })
    expect(splitFileName('README')).toEqual({ head: '', tail: 'README' })
    expect(splitFileName('.hidden-settings')).toEqual({ head: '.hidden-se', tail: 'ttings' })
    expect(splitFileName('a.mp4')).toEqual({ head: '', tail: 'a.mp4' })
  })

  it('renders a shrinking head, a tail that always shows, and the whole name for assistive technology', () =>
  {
    const { container } = render(<MiddleTruncate text="podcast-episode-142.wav" />)
    const head = container.querySelector('[data-part="head"]')
    const tail = container.querySelector('[data-part="tail"]')
    expect(head?.textContent).toBe('podcast-episo')
    expect(head).toHaveClass('min-w-0', 'overflow-hidden', 'text-ellipsis')
    expect(head).toHaveAttribute('aria-hidden', 'true')
    expect(tail?.textContent).toBe('de-142.wav')
    expect(tail).toHaveClass('shrink-0')
    expect(tail).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('[data-part="middle"]')?.firstElementChild).toHaveTextContent('podcast-episode-142.wav')
  })
})

describe('cell words', () =>
{
  it('sets numbers in mono and leaves codec names whole', () =>
  {
    const { container } = render(<span><TabularNumbers text={`MKV · H.264 1080p · 2 audio · ${M}11.5 LUFS · E-AC-3`} /></span>)
    const numbers = [...container.querySelectorAll('[data-part="number"]')].map((node) => node.textContent)
    expect(numbers).toEqual(['1080', '2', `${M}11.5`])
    expect(container.textContent).toBe(`MKV · H.264 1080p · 2 audio · ${M}11.5 LUFS · E-AC-3`)
  })

  it('words the source of video and audio files', () =>
  {
    const stream = { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: null, isDefault: true }
    const video = { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 24 }
    expect(sourceSummary(media({ container: 'mkv', video, audio: [stream, stream], subtitles: 3 }))).toBe('MKV · H.264 1080p · 2 audio · 3 subtitles')
    expect(sourceSummary(media({ container: 'mp4', video: { ...video, width: 1080, height: 1920 }, audio: [stream], subtitles: 1 }))).toBe('MP4 · H.264 1080p · 1 audio · 1 subtitle')
    expect(sourceSummary(media({ audio: [{ ...stream, codec: 'pcm_s24le', bitsPerSample: 24, bitrateKbps: null }] }))).toBe('WAV · 24-bit · stereo')
    expect(sourceSummary(media({ container: 'flac', audio: [{ ...stream, channels: 6, layout: '5.1(side)', bitsPerSample: 24 }] }))).toBe('FLAC · 24-bit · 5.1(side)')
    expect(sourceSummary(media({ container: 'mp3', audio: [{ ...stream, channels: 1, layout: null, bitrateKbps: 128 }] }))).toBe('MP3 · 128 kb/s · mono')
    expect(sourceSummary(media({ container: 'ogg', audio: [{ ...stream, channels: 4, layout: null, bitrateKbps: null }, stream] }))).toBe('Ogg · 4 channels · 2 audio')
    expect(sourceSummary(media({ container: 'avi', video: { ...video, codec: 'cinepak', width: 0, height: 0 } }))).toBe('AVI · CINEPAK')
    expect(sourceSummary(null)).toBe('')
    expect(videoCodecLabel('hevc')).toBe('HEVC')
  })

  it('names the container from the file when the probe reports a format list', () =>
  {
    const stream = { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: null, isDefault: true }
    const video = { codec: 'h264', width: 3840, height: 2160, rotation: 0, fps: 30 }
    const mov = 'mov,mp4,m4a,3gp,3g2,mj2'
    expect(sourceSummary(media({ container: mov, video, audio: [stream] }), 'Drone 4K 0031.mov')).toBe('MOV · H.264 2160p · 1 audio')
    expect(sourceSummary(media({ container: mov, audio: [stream] }), 'Voice memo 2026-03-14.m4a')).toBe('M4A · 192 kb/s · stereo')
    expect(sourceSummary(media({ container: mov, video, audio: [stream] }), 'Screen capture (silent).mp4')).toBe('MP4 · H.264 2160p · 1 audio')
    expect(sourceSummary(media({ container: 'matroska,webm', video: { ...video, codec: 'vp9' } }), 'Product loop.webm')).toBe('WebM · VP9 2160p')
    expect(sourceSummary(media({ container: 'matroska,webm', video }), 'Harbor Lights (2019).mkv')).toBe('MKV · H.264 2160p')
    expect(sourceSummary(media({ container: 'matroska,webm', video }))).toBe('MKV · H.264 2160p')
  })

  it('draws a canceled job with the label key the primitive knows', () =>
  {
    expect(statusKeyFor('canceled')).toBe('cancelled')
    expect(statusKeyFor('verified')).toBe('verified')
  })
})

describe('columns per list', () =>
{
  it('shows each list its priority 1 columns below 680 px, priority 2 from 680, and priority 3 from 960', () =>
  {
    expect(shownAt('queue', 560)).toEqual(['no', 'file', 'recipe', 'status', 'actions'])
    expect(shownAt('queue', 680)).toEqual(['no', 'file', 'recipe', 'status', 'size', 'actions'])
    expect(shownAt('queue', 960)).toEqual(['no', 'file', 'recipe', 'status', 'size', 'duration', 'source', 'actions'])
    expect(shownAt('review', 679)).toEqual(['no', 'plan', 'output', 'actions'])
    expect(shownAt('review', 680)).toEqual(['no', 'file', 'plan', 'output', 'encoder', 'actions'])
    expect(shownAt('review', 960)).toEqual(['no', 'file', 'plan', 'output', 'encoder', 'audioPlan', 'actions'])
    expect(shownAt('run', 600)).toEqual(['no', 'file', 'status', 'progress', 'actions'])
    expect(shownAt('run', 680)).toEqual(['no', 'file', 'status', 'progress', 'time', 'actions'])
    expect(shownAt('run', 960)).toEqual(['no', 'file', 'status', 'progress', 'time', 'speed', 'out', 'actions'])
    expect(shownAt('run', 959, { quickActions: true })).toEqual(['no', 'file', 'status', 'progress', 'time', 'actions'])
    expect(shownAt('run', 960, { quickActions: true })).toEqual(['no', 'file', 'status', 'progress', 'time', 'speed', 'out', 'quick', 'actions'])
    expect(shownAt('historyResults', 680)).toEqual(['no', 'file', 'batch', 'result', 'finished', 'actions'])
    expect(shownAt('historyResults', 960)).toEqual(['no', 'file', 'batch', 'result', 'finished', 'recipe', 'actions'])
  })

  it('steps the working column aside below 560 px, and the rest fits the narrowest table', () =>
  {
    expect(NARROW_TABLE_WIDTH).toBe(560)
    expect(shownAt('queue', 440, { narrow: true })).toEqual(['no', 'file', 'status', 'actions'])
    expect(shownAt('run', 440, { narrow: true, quickActions: true })).toEqual(['no', 'file', 'status', 'actions'])
    expect(shownAt('review', 440, { narrow: true })).toEqual(['no', 'plan', 'output', 'actions'])
    expect(shownAt('historyResults', 440, { narrow: true })).toEqual(['no', 'file', 'batch', 'actions'])
    const least = (set: JobColumnSet): number => visibleGridColumns(jobColumns(set, options({ narrow: true })), [], 440)
      .reduce((sum, column) => sum + parseInt(/(\d+)px/.exec(column.width)?.[1] ?? '0', 10), 0)
    for (const set of ['queue', 'review', 'run', 'historyResults'] as const)
    {
      expect(least(set), set).toBeLessThanOrEqual(440)
    }
  })

  it('names the working column Progress while a batch runs and Result after, and the button columns for assistive technology', () =>
  {
    const label = (set: JobColumnSet, id: string, over: Partial<JobColumnOptions> = {}): string | undefined => jobColumns(set, options(over)).find((column) => column.id === id)?.label
    expect(label('run', 'progress', { running: true })).toBe('Progress')
    expect(label('run', 'progress')).toBe('Result')
    expect(label('queue', 'actions')).toBe(ACTIONS_LABEL)
    expect(label('run', 'quick', { quickActions: true })).toBe(QUICK_ACTIONS_LABEL)
    expect(jobColumns('run', options({ quickActions: true })).filter((column) => column.kind === 'actions').map((column) => column.id)).toEqual(['quick', 'actions'])
  })

  it('fits priority 1 in 560 px and each priority within its threshold', () =>
  {
    const least = (set: JobColumnSet, width: number): number => visibleGridColumns(jobColumns(set, options({ quickActions: true })), [], width)
      .reduce((sum, column) => sum + parseInt(/(\d+)px/.exec(column.width)?.[1] ?? '0', 10), 0)
    for (const set of ['queue', 'review', 'run', 'historyResults'] as const)
    {
      expect(least(set, 0)).toBeLessThanOrEqual(560)
      expect(least(set, 680)).toBeLessThanOrEqual(680)
      expect(least(set, 960)).toBeLessThanOrEqual(960)
    }
  })

  it('sorts by the values the cells show and leaves the live and button columns unsorted', () =>
  {
    const a = job({ media: media({ durationSec: 30 }) })
    const lookup = (id: string): JobView | null => id === a.id ? a : null
    const columns = jobColumns('queue', options({ lookup }))
    const sortable = columns.filter((column) => column.sortable).map((column) => column.id)
    expect(sortable).toEqual(['no', 'file', 'recipe', 'status', 'size', 'duration', 'source'])
    expect(columns.find((column) => column.id === 'duration')?.sortValue?.({ id: a.id })).toBe(30)
    expect(columns.find((column) => column.id === 'duration')?.sortValue?.({ id: 'MM-9999' })).toBeNull()
    expect(columns.find((column) => column.id === 'size')?.align).toBe('end')
    expect(isSortable('progress')).toBe(false)
    expect(isSortable('actions')).toBe(false)
    expect(sortKey('progress', a, 'run', 'win32')).toBeNull()
    expect(sortKey('no', a, 'queue', 'win32')).toBe(a.seq)
    expect(sortKey('status', a, 'queue', 'win32')).toBe('00 Ready')
    expect(sortKey('batch', job({ runId: R31 }), 'historyResults', 'win32')).toBe(R31)
  })

  it('sorts the Review and History columns by their plan, recipe, and finish values', () =>
  {
    const planned = job({ plan: plan({ relativePath: 'out\\a.wav', encoderLabel: 'AAC 256k' }), audioPlan: [gain({ gainDb: 4.1 })], endedAt: AT })
    expect(sortKey('source', planned, 'queue', 'win32')).toBe(sourceSummary(planned.media))
    expect(sortKey('recipe', planned, 'queue', 'win32')).toBe('Normalize · Streaming (EBU R 128 s2)')
    expect(sortKey('output', planned, 'review', 'win32')).toBe('out\\a.wav')
    expect(sortKey('encoder', planned, 'review', 'win32')).toBe('AAC 256k')
    expect(sortKey('audioPlan', planned, 'review', 'win32')).toBe(4.1)
    expect(sortKey('finished', planned, 'historyResults', 'win32')).toBe(AT)
    const bare = job({ plan: null, audioPlan: null, media: null })
    expect(['output', 'encoder', 'audioPlan', 'duration'].map((column) => sortKey(column, bare, 'review', 'win32'))).toEqual([null, null, null, null])
    expect(sortKey('source', bare, 'queue', 'win32')).toBe('')
    expect(sortKey('audioPlan', job({ audioPlan: [] }), 'review', 'win32')).toBeNull()
  })
})

function gain(over: Partial<AudioPlanCell> = {}): AudioPlanCell
{
  return { audioIndex: 0, mode: 'linear', gainDb: 2.9, requestedGainDb: 2.9, limitingDb: 0, predictedLufs: -16, unit: 'LUFS', status: 'measured', ...over }
}

function progress(over: Partial<JobProgress> = {}): JobProgress
{
  return { stage: 'encode', pass: 1, passes: 1, percent: 46, stagePercent: 46, speed: 6.2, etaSec: 460, outTimeSec: 120, durationSec: 600, bytesWritten: 312_000_000, elapsedMs: 60_000, ...over }
}

function stamp(over: Partial<ResultStamp> = {}): ResultStamp
{
  return {
    verdict: 'verified',
    outputName: 'a.wav',
    container: 'wav',
    inputBytes: 800_000_000,
    outputBytes: 24_100_000,
    durationSec: 600,
    decode: 'full',
    audioStreams: 1,
    verdictStream: 0,
    loudness: { lufs: -16, unit: 'LUFS', reference: 'target', referenceLufs: -16, deviation: 0, deviationUnit: 'LU', check: 1, checkClass: 'lossless', status: 'within' },
    truePeak: { dbtp: -1.6, preEncodeDbtp: null, limitDbtp: -1, status: 'within' },
    size: null,
    frames: null,
    cues: null,
    placement: 'new',
    warnings: 0,
    ...over
  }
}

describe('cell text per column', () =>
{
  it('words the audio plan of one stream, several streams, and none measured yet', () =>
  {
    expect(audioPlanText(job({ audioPlan: [gain()] }))).toBe('+2.9 dB, linear')
    expect(audioPlanText(job({ audioPlan: [gain({ mode: 'peak-limited', gainDb: 5, limitingDb: 2.5 })] }))).toBe('+5.0 dB, 2.5 dB limiting')
    expect(audioPlanText(job({ audioPlan: [gain({ mode: 'reachable-limited', gainDb: 9, predictedLufs: -11.5 })] }))).toBe(`${M}11.5 LUFS reachable`)
    expect(audioPlanText(job({ audioPlan: [gain({ mode: 'reachable-linear', predictedLufs: null })] }))).toBe('+2.9 dB, reachable')
    expect(audioPlanText(job({ audioPlan: [gain({ mode: 'passthrough', status: 'silent' })] }))).toBe('Silent, copied')
    expect(audioPlanText(job({ audioPlan: [gain({ gainDb: 2.9 }), gain({ gainDb: 4.1 }), gain({ gainDb: 3.3 })] }))).toBe('+2.9 to +4.1 dB, 3 streams')
    expect(audioPlanText(job({ audioPlan: [gain(), gain()] }))).toBe('+2.9 dB, 2 streams')
    expect(audioPlanText(job({ audioPlan: [gain({ mode: 'passthrough', status: 'too-short' }), gain({ mode: 'passthrough', status: 'below-floor' })] }))).toBe('Too short, copied, 2 streams')
    expect(audioPlanText(job())).toBe(MEASURED_AT_RUN)
    expect(audioPlanText(job({ recipe: { kind: 'convert' } as unknown as JobView['recipe'] }))).toBe('')
  })

  it('notes how an output lands in Replace mode', () =>
  {
    const replacing = plan({ finalName: 'a.mp4', resolution: 'replace-original' })
    expect(outputNote(job({ plan: replacing, source: { ...job().source, ext: 'mkv' } }), true)).toBe('.mp4 replaces .mkv')
    expect(outputNote(job({ plan: { ...replacing, finalName: 'a.wav' } }), true)).toBe('replaces original')
    expect(outputNote(job({ plan: plan({ resolution: 'place' }) }), true)).toBe('beside its source')
    expect(outputNote(job(), false)).toBeNull()
    expect(outputNote(job({ plan: null }), true)).toBeNull()
  })

  it('splits the recipe label and notes album groups and reruns', () =>
  {
    expect(recipeParts('Normalize · Podcast, edited')).toEqual({ operation: 'Normalize', preset: 'Podcast, edited' })
    expect(recipeParts('Custom')).toEqual({ operation: '', preset: 'Custom' })
    expect(recipeNotes(job({ rerunOf: { runId: R31, jobId: 'MM-0131' as JobId } }), 'A')).toEqual(['album A', 'rerun of MM-0131'])
    expect(recipeNotes(job(), null)).toEqual([])
    expect([0, 1, 25, 26, 27, 701, 702].map(albumLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it('words time, speed, and output size while active and after', () =>
  {
    const active = job({ state: 'encoding', progress: progress(), startedAt: AT })
    expect(timeText(active)).toBe('7 min 40 s left')
    expect(timeText(job({ state: 'encoding', progress: progress({ etaSec: null }) }))).toBe('')
    expect(timeText(job({ state: 'done', startedAt: AT, endedAt: AT + 760_000 }))).toBe('12 min 40 s')
    expect(timeText(job({ state: 'queued' }))).toBe('')
    expect(speedText(active)).toBe('6.2x')
    expect(speedText(job({ state: 'done', progress: progress() }))).toBe('')
    expect(outText(active)).toBe('312 MB')
    expect(outText(job({ state: 'encoding', progress: progress({ bytesWritten: null }) }))).toBe('')
    expect(outText(job({ state: 'done', stamp: stamp() }))).toBe(`24.1 MB · ${M}97%`)
    expect(outText(job({ state: 'canceled' }))).toBe('')
    expect(finishedText(job({ endedAt: AT }))).toBe('Oct 16 13:40')
    expect(finishedText(job())).toBe('')
  })

  it('offers one quick button per job, naming the job', () =>
  {
    expect(quickActionFor(job({ state: 'encoding' }))).toBe('cancel')
    expect(quickActionFor(job({ state: 'queued' }))).toBe('skip')
    expect(quickActionFor(job({ state: 'failed' }))).toBe('acknowledge')
    expect(quickActionFor(job({ state: 'failed', acknowledged: true }))).toBeNull()
    expect(quickActionFor(job({ state: 'held' }))).toBeNull()
    expect(quickActionFor(job({ state: 'pending' }))).toBeNull()
    expect(quickActionLabel('cancel', 'MM-0141')).toBe('Cancel job MM-0141')
    expect(quickActionLabel('skip', 'MM-0141')).toBe('Skip MM-0141')
    expect(quickActionLabel('acknowledge', 'MM-0141')).toBe('Acknowledge MM-0141')
  })

  it('treats a probed waiting job without a current plan as being checked', () =>
  {
    expect(planPending(job({ plan: null }))).toBe(true)
    expect(planPending(job({ plan: plan({ current: false }) }))).toBe(true)
    expect(planPending(job())).toBe(false)
    expect(planPending(job({ probe: 'pending', plan: null }))).toBe(false)
    expect(planPending(job({ state: 'queued', plan: null }))).toBe(false)
  })
})

const RUNNING = { runId: R31, status: 'running' } as unknown as RunState

function source(name: string): JobView['source']
{
  return { path: `D:\\Rips\\${name}`, name, ext: name.slice(name.lastIndexOf('.') + 1), dir: 'D:\\Rips', size: 498_000_000, mtimeMs: AT, origin: 'files', subdir: '' }
}

function load(jobs: readonly JobView[], over: Partial<JobsState> = {}): void
{
  act(() =>
  {
    useJobsStore.setState({
      ...initialJobsState(),
      status: 'hydrated',
      hydrations: 1,
      order: jobs.map((entry) => entry.id),
      jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])),
      ...over
    }, true)
  })
}

function update(id: string, over: Partial<JobView>): void
{
  act(() =>
  {
    const state = useJobsStore.getState()
    const current = state.jobs[id as JobId]
    useJobsStore.setState({ jobs: { ...state.jobs, [id]: { ...current, ...over } } })
  })
}

function renderTable(props: Partial<JobTableProps> = {}): void
{
  render(<LiveRegion><JobTable list="queue" platform="win32" {...props} /></LiveRegion>)
}

function bodyRows(): HTMLElement[]
{
  return screen.queryAllByRole('row').filter((element) => element.hasAttribute('data-row-id'))
}

function shownIds(): string[]
{
  return bodyRows().map((element) => element.getAttribute('data-row-id') ?? '')
}

function row(id: string): HTMLElement
{
  const found = bodyRows().find((element) => element.getAttribute('data-row-id') === id)
  if (found === undefined)
  {
    throw new Error(`no row ${id}`)
  }
  return found
}

function headerNames(): string[]
{
  return screen.getAllByRole('columnheader').map((header) => (header.querySelector('span[aria-hidden="true"]') ?? header).textContent ?? '')
}

async function announced(text: string): Promise<void>
{
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text))
}

describe('JobTable', () =>
{
  it('renders the rows in the queue order the snapshot gives, not in catalog order', () =>
  {
    const [a, b, c] = [job(), job(), job()]
    load([c, a, b])
    renderTable()
    expect(shownIds()).toEqual([c.id, a.id, b.id])
    expect(screen.getByRole('grid', { name: 'Jobs' })).toBeInTheDocument()
  })

  it('cycles a header through ascending and descending and ends back in queue order', async () =>
  {
    const a = job({ source: source('beta.wav') })
    const b = job({ source: source('Alpha.wav') })
    const c = job({ source: source('gamma.wav') })
    load([a, c, b])
    renderTable()
    const file = screen.getByRole('button', { name: 'File' })
    fireEvent.click(file)
    expect(shownIds()).toEqual([b.id, a.id, c.id])
    await announced('Sorted by File, ascending.')
    fireEvent.click(file)
    expect(shownIds()).toEqual([c.id, a.id, b.id])
    await announced('Sorted by File, descending.')
    fireEvent.click(file)
    expect(shownIds()).toEqual([a.id, c.id, b.id])
    await announced('Back to queue order.')
    expect(useBatchView.getState().views.queue.sort).toBeNull()
    expect(screen.getAllByRole('columnheader').filter((header) => header.hasAttribute('aria-sort'))).toEqual([])
  })

  it('sorts again when a value the sort reads changes', () =>
  {
    const a = job({ source: { ...source('a.wav'), size: 3 } })
    const b = job({ source: { ...source('b.wav'), size: 2 } })
    load([a, b])
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Size' }))
    expect(shownIds()).toEqual([b.id, a.id])
    update(a.id, { source: { ...a.source, size: 1 } })
    expect(shownIds()).toEqual([a.id, b.id])
  })

  it('shows each list its priority columns at 680 and 960 px of grid width', () =>
  {
    const expected: Array<[JobTableProps['list'], string[], string[], string[]]> = [
      [
        'queue',
        ['#', 'File', 'Operation', 'Status', 'Actions'],
        ['#', 'File', 'Operation', 'Status', 'Size', 'Actions'],
        ['#', 'File', 'Operation', 'Status', 'Size', 'Duration', 'Source', 'Actions']
      ],
      [
        'review',
        ['#', 'Check', 'Output file', 'Actions'],
        ['#', 'File', 'Check', 'Output file', 'Encoder', 'Actions'],
        ['#', 'File', 'Check', 'Output file', 'Encoder', 'Audio', 'Actions']
      ],
      [
        'run',
        ['#', 'File', 'Status', 'Progress', 'Actions'],
        ['#', 'File', 'Status', 'Progress', 'Time', 'Actions'],
        ['#', 'File', 'Status', 'Progress', 'Time', 'Speed', 'Out', 'Actions']
      ]
    ]
    load([job()], { run: RUNNING })
    for (const [list, at560, at680, at960] of expected)
    {
      renderTable({ list })
      reportWidth(560)
      expect(headerNames(), `${list} at 560`).toEqual(at560)
      reportWidth(680)
      expect(headerNames(), `${list} at 680`).toEqual(at680)
      reportWidth(960)
      expect(headerNames(), `${list} at 960`).toEqual(at960)
      cleanup()
    }
  })

  it('keeps the Actions column on screen below 560 px by stepping the working column aside', () =>
  {
    load([job()], { run: RUNNING })
    for (const [list, narrow] of [['queue', ['#', 'File', 'Status', 'Actions']], ['run', ['#', 'File', 'Status', 'Actions']], ['review', ['#', 'Check', 'Output file', 'Actions']]] as const)
    {
      renderTable({ list })
      reportWidth(440)
      expect(headerNames(), `${list} at 440`).toEqual(narrow)
      reportWidth(560)
      expect(headerNames(), `${list} at 560`).toContain(list === 'review' ? 'Output file' : list === 'run' ? 'Progress' : 'Operation')
      cleanup()
    }
  })

  it('names the Run list working column Result once no batch runs', () =>
  {
    load([job({ state: 'done', runId: R31, stamp: stamp() })])
    renderTable({ list: 'run' })
    expect(headerNames()).toContain('Result')
    expect(headerNames()).not.toContain('Progress')
  })

  it('holds the Status of a job that needs attention, with its hidden words, until it is acknowledged', () =>
  {
    const failed = job({ state: 'failed', runId: R31, startedAt: AT, endedAt: AT + 1000 })
    const acknowledged = job({ state: 'failed', runId: R31, acknowledged: true })
    const verified = job({ state: 'done', runId: R31, stamp: stamp() })
    load([failed, acknowledged, verified])
    renderTable({ list: 'run' })
    const status = (id: string): Element | null => row(id).querySelector('[data-status]')
    expect(status(failed.id)).toHaveAttribute('data-held')
    expect(status(failed.id)).toHaveTextContent(`Failed${NOT_ACKNOWLEDGED}`)
    expect(status(acknowledged.id)).not.toHaveAttribute('data-held')
    expect(status(acknowledged.id)?.textContent).not.toContain(NOT_ACKNOWLEDGED)
    expect(status(verified.id)).not.toHaveAttribute('data-held')
    expect(status(verified.id)).toHaveTextContent('Verified')
  })

  it('shows a 4 px bar with its percent on active rows and the stamp on finished rows', () =>
  {
    const active = job({ state: 'encoding', runId: R31, progress: progress({ percent: 46 }), startedAt: AT })
    const finished = job({ state: 'done', runId: R31, stamp: stamp(), startedAt: AT, endedAt: AT + 760_000 })
    const queued = job({ state: 'queued', runId: R31 })
    load([active, finished, queued], { run: RUNNING })
    renderTable({ list: 'run' })
    const bar = within(row(active.id)).getByRole('progressbar', { name: `Progress of ${active.id}` })
    expect(bar).toHaveAttribute('data-size', 'sm')
    expect(bar).toHaveAttribute('aria-valuenow', '46')
    expect(row(active.id)).toHaveTextContent('46%')
    expect(row(active.id)).toHaveTextContent('7 min 40 s left')
    expect(row(active.id).querySelector('.ui-stamp')).toBeNull()
    expect(within(row(finished.id)).queryByRole('progressbar')).toBeNull()
    expect(row(finished.id).querySelector('.ui-stamp')).not.toBeNull()
    expect(row(finished.id)).toHaveTextContent('12 min 40 s')
    expect(row(finished.id)).toHaveTextContent(`24.1 MB · ${M}97%`)
    expect(within(row(queued.id)).queryByRole('progressbar')).toBeNull()
    expect(row(queued.id).querySelector('.ui-stamp')).toBeNull()
  })

  it('keeps a long returned reason inside the Result cell and gives its full text a tooltip', () =>
  {
    const error = { code: 'ffmpeg-failed', short: 'Decode errors', cause: 'decode', message: 'The source is damaged.', stage: 'encode', attempt: 1 } as unknown as JobView['error']
    const failed = job({ state: 'failed', runId: R31, error, startedAt: AT, endedAt: AT + 6000 })
    const verified = job({ state: 'done', runId: R31, stamp: stamp() })
    load([failed, verified])
    renderTable({ list: 'run' })
    const returned = row(failed.id).querySelector('.ui-stamp')
    expect(returned).toHaveAttribute('data-outcome', 'returned')
    expect(returned).toHaveClass('max-w-full')
    expect(returned?.querySelector('[data-part="value"]')).toHaveTextContent('Decode errors')
    expect(row(verified.id).querySelector('.ui-stamp')).toHaveClass('max-w-full')
    expect(ROW_STAMP_FIT).toContain('[&_[data-part=value]]:truncate')
  })

  it('words a row stamp tooltip from its reference line or its whole values', () =>
  {
    expect(rowStampTooltip({ values: [{ text: 'Decode errors', failing: true }], tooltip: null })).toBe('Decode errors')
    expect(rowStampTooltip({ values: [{ text: 'a' }, { text: 'b' }], tooltip: null })).toBe('a, b')
    expect(rowStampTooltip({ values: [{ text: 'x' }], tooltip: 'EBU R 128 s2: -23 LUFS' })).toBe('EBU R 128 s2: -23 LUFS')
    expect(rowStampTooltip({ values: [], tooltip: null })).toBeUndefined()
  })

  it('names the Source container from the job file when the probe lists formats', () =>
  {
    const movie = job({ source: source('Drone 4K 0031.mov'), media: media({ container: 'mov,mp4,m4a,3gp,3g2,mj2' }) })
    load([movie])
    renderTable({ list: 'queue' })
    expect(row(movie.id)).toHaveTextContent('MOV')
    expect(row(movie.id).textContent).not.toContain('MOV,MP4')
  })

  it('updates an active row as its progress arrives', () =>
  {
    const active = job({ state: 'encoding', runId: R31, progress: progress({ percent: 10 }) })
    load([active, job({ state: 'queued', runId: R31 })], { run: RUNNING })
    renderTable({ list: 'run' })
    update(active.id, { progress: progress({ percent: 63 }) })
    expect(within(row(active.id)).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63')
  })

  it('re-renders only the row whose job changed', () =>
  {
    const a = job({ state: 'encoding', runId: R31, progress: progress({ percent: 10 }) })
    const b = job({ state: 'encoding', runId: R31, progress: progress({ percent: 20 }) })
    load([a, b], { run: RUNNING })
    renderTable({ list: 'run', rowMenu: () => [] })
    const observer = new MutationObserver(() => undefined)
    observer.observe(screen.getByRole('grid'), { subtree: true, childList: true, attributes: true, characterData: true })
    update(a.id, { progress: progress({ percent: 30 }) })
    const touched = new Set(observer.takeRecords()
      .map((record) => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('[role="row"]')?.getAttribute('data-row-id'))
      .filter((id) => id !== undefined && id !== null))
    observer.disconnect()
    expect([...touched]).toEqual([a.id])
    expect(within(row(a.id)).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
  })

  it('truncates the File cell in the middle and keeps the extension', () =>
  {
    const long = job({ source: source('podcast-episode-142.wav') })
    load([long])
    renderTable()
    const cell = row(long.id).querySelector('[data-part="middle"]')
    expect(cell?.querySelector('[data-part="tail"]')?.textContent).toBe('de-142.wav')
    expect(cell?.querySelector('[data-part="head"]')).toHaveClass('text-ellipsis')
    expect(cell?.firstElementChild).toHaveTextContent('podcast-episode-142.wav')
  })

  it('never disables a row, however locked its job is', () =>
  {
    load([
      job({ plan: plan({ status: 'blocked', errors: 1 }) }),
      job({ probe: 'failed', media: null, plan: null }),
      job({ state: 'failed', runId: R31 }),
      job({ state: 'canceled', runId: R31 }),
      job({ state: 'encoding', runId: R31, progress: progress() })
    ])
    renderTable()
    expect(bodyRows()).toHaveLength(5)
    for (const element of bodyRows())
    {
      expect(element).not.toHaveAttribute('aria-disabled')
    }
  })

  it('shows Review the jobs not in a batch with their plan words and outputs', () =>
  {
    const ready = job({ plan: plan({ relativePath: '.\\podcast-episode-142.wav', finalName: 'podcast-episode-142.wav', resolution: 'replace-original' }) })
    const warned = job({ plan: plan({ warnings: 2 }) })
    const blocked = job({ plan: plan({ status: 'blocked', errors: 1 }) })
    const queued = job({ state: 'queued', runId: R31 })
    load([ready, warned, blocked, queued], { policy: { destination: { mode: 'replace-originals' } } as unknown as BatchPolicy })
    renderTable({ list: 'review' })
    expect(shownIds()).toEqual([ready.id, warned.id, blocked.id])
    expect(row(ready.id)).toHaveTextContent('replaces original')
    expect(row(warned.id).querySelector('[data-status]')).toHaveTextContent('2 warnings')
    expect(row(blocked.id).querySelector('[data-status]')).toHaveTextContent('Blocked')
    expect(row(ready.id)).toHaveTextContent('PCM 24-bit')
  })

  it('reads Checking once a stale plan has been pending for more than 600 ms', () =>
  {
    vi.useFakeTimers()
    const pending = job({ plan: plan({ current: false }) })
    load([pending])
    renderTable()
    expect(row(pending.id).querySelector('[data-status]')).toHaveTextContent('Ready')
    act(() =>
    {
      vi.advanceTimersByTime(500)
    })
    expect(row(pending.id).querySelector('[data-status]')).toHaveTextContent('Ready')
    act(() =>
    {
      vi.advanceTimersByTime(601)
    })
    expect(row(pending.id).querySelector('[data-status]')).toHaveTextContent('Checking')
  })

  it('words the operation with its preset, album letter, and rerun', () =>
  {
    const first = job({ albumGroupId: 'g-7' })
    const second = job({ albumGroupId: 'g-2', rerunOf: { runId: R31, jobId: 'MM-0131' as JobId } })
    const third = job({ albumGroupId: 'g-7' })
    load([first, second, third])
    renderTable()
    expect(row(first.id)).toHaveTextContent('NormalizeStreaming · album A')
    expect(row(second.id)).toHaveTextContent('album B · rerun of MM-0131')
    expect(row(third.id)).toHaveTextContent('album A')
  })

  it('keeps selection in the batch view, lights the selected well, and drops rows that leave the list', () =>
  {
    const [a, b] = [job(), job()]
    load([a, b])
    renderTable()
    fireEvent.click(row(b.id))
    expect(useBatchView.getState().views.queue.selection.selected.has(b.id)).toBe(true)
    expect(row(b.id).querySelector('[data-selected]')).not.toBeNull()
    expect(row(a.id).querySelector('[data-selected]')).toBeNull()
    load([a])
    expect(shownIds()).toEqual([a.id])
    expect(useBatchView.getState().views.queue.selection.selected.has(b.id)).toBe(false)
  })

  it('puts the row menu one pointer action away and the Run quick buttons at priority 3 widths', () =>
  {
    const running = job({ state: 'encoding', runId: R31, progress: progress() })
    const queued = job({ state: 'queued', runId: R31 })
    const failed = job({ state: 'failed', runId: R31 })
    load([running, queued, failed], { run: RUNNING })
    const onQuickAction = vi.fn()
    const onSelect = vi.fn()
    renderTable({ list: 'run', rowMenu: () => [{ id: 'log', label: 'Show log', onSelect }], onQuickAction })
    reportWidth(960)
    expect(screen.getByRole('button', { name: `More actions for ${running.id}` })).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(screen.getByRole('button', { name: `Cancel job ${running.id}` }))
    expect(onQuickAction).toHaveBeenCalledWith('cancel', running)
    expect(screen.getByRole('button', { name: `Skip ${queued.id}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Acknowledge ${failed.id}` })).toBeInTheDocument()
    reportWidth(959)
    expect(screen.queryByRole('button', { name: `Cancel job ${running.id}` })).toBeNull()
    expect(screen.getByRole('button', { name: `More actions for ${running.id}` })).toBeInTheDocument()
  })

  it('shows skeleton rows before the first snapshot', () =>
  {
    renderTable()
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    expect(bodyRows()).toEqual([])
  })

  it('opens one row menu from a right click and from More actions, with the page entries alone', () =>
  {
    const [a, b, c] = [job(), job(), job()]
    load([a, b, c])
    const onMoveRows = vi.fn()
    const onSelect = vi.fn()
    renderTable({ rowMenu: (entry) => [{ id: 'log', label: `Show log of ${entry.id}`, onSelect }], onMoveRows })
    fireEvent.contextMenu(row(b.id), { button: 2, clientX: 4, clientY: 4 })
    let menu = openMenu(`Actions for ${b.id}`)
    expect(within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.textContent)).toEqual([`Show log of ${b.id}`])
    expect(within(menu).queryByRole('separator', { hidden: true })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: `Show log of ${b.id}` }))
    expect(onSelect).toHaveBeenCalledTimes(1)

    const more = screen.getByRole('button', { name: `More actions for ${a.id}` })
    fireEvent.click(more)
    menu = openMenu(`Actions for ${a.id}`)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(row(a.id)).toHaveAttribute('aria-selected', 'true')
    expect(within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.textContent)).toEqual([`Show log of ${a.id}`])
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: `Show log of ${a.id}` }))
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(more).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(row(a.id))
    fireEvent.click(row(c.id), { ctrlKey: true })
    fireEvent.contextMenu(row(c.id), { button: 2, clientX: 4, clientY: 4 })
    expect(openMenu('Actions for 2 jobs')).toBeInTheDocument()
  })

  it('keeps the column menu choices in the batch view: hidden columns per list and compact rows', () =>
  {
    load([job()])
    renderTable()
    const file = screen.getByRole('button', { name: 'File' })
    fireEvent.contextMenu(file, { button: 2, clientX: 4, clientY: 4 })
    fireEvent.click(within(openMenu('Column options')).getByRole('menuitemcheckbox', { hidden: true, name: 'Size' }))
    expect(useBatchView.getState().prefs.hiddenColumns.queue).toEqual(['size'])
    expect(headerNames()).not.toContain('Size')
    fireEvent.contextMenu(file, { button: 2, clientX: 4, clientY: 4 })
    fireEvent.click(within(openMenu('Column options')).getByRole('menuitemcheckbox', { hidden: true, name: 'Compact rows' }))
    expect(useBatchView.getState().prefs.compactRows).toBe(true)
    expect(screen.getByRole('grid')).toHaveAttribute('data-density', 'compact')
  })

  it('moves focus to the row whose file name starts with the typed letter', () =>
  {
    const a = job({ source: source('beta.wav') })
    const b = job({ source: source('gamma.wav') })
    load([a, b])
    renderTable()
    fireEvent.click(row(a.id))
    fireEvent.keyDown(row(a.id), { key: 'g' })
    expect(document.activeElement).toBe(row(b.id))
    expect(useBatchView.getState().views.queue.selection.selected.has(b.id)).toBe(true)
  })

  it('names the full file name and its folder in the row tooltip', () =>
  {
    const a = job({ source: source('podcast-episode-142.wav') })
    load([a])
    renderTable()
    const tips = screen.getAllByRole('tooltip', { hidden: true }).map((tip) => tip.textContent)
    expect(tips).toContain('podcast-episode-142.wav\nD:\\Rips')
  })

  it('words the Recycle Bin step for the platform the shell provides', () =>
  {
    const saving = job({ state: 'finalizing', runId: R31, stage: { id: 'trash', pass: 1, passes: 1, label: 'Save', startedAt: AT } })
    load([saving], { run: RUNNING })
    render(<PlatformProvider platform="darwin"><LiveRegion><JobTable list="run" /></LiveRegion></PlatformProvider>)
    expect(row(saving.id).querySelector('[data-status]')).toHaveTextContent('Moving original to the Trash')
  })
})

/** The open menu with this name; a closed Menu keeps its empty list in the document. */
function openMenu(name: string): HTMLElement
{
  const menu = screen.getAllByRole('menu', { hidden: true })
    .find((candidate) => candidate.getAttribute('aria-label') === name && candidate.querySelector('[role^="menuitem"]') !== null)
  if (menu === undefined)
  {
    throw new Error(`no open menu named ${name}`)
  }
  return menu
}
