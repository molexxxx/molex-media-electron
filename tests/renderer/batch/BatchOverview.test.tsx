import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { BatchSummary, JobState, JobView, RecipeOutcome, ResultStamp, RunState, WorkersState } from '../../../src/shared/jobs/types'
import
{
  BatchOverview,
  OVERVIEW_WORDS,
  RUNNING_NOW_LIMIT,
  overviewPhase,
  runningNow,
  workersLine
} from '../../../src/renderer/src/components/batch/inspector/BatchOverview'
import
{
  RecipeProgressList,
  attentionFilter,
  isFinished,
  recipeFilter,
  recipeProgress,
  type JobFilter
} from '../../../src/renderer/src/components/batch/inspector/RecipeProgressList'
import
{
  NO_LIMITING,
  NOT_MEASURED,
  OUTCOME_COLUMNS,
  OutcomeByRecipeTable,
  checkCell,
  limitingNote,
  outcomeRows,
  peakCell,
  rangeCell
} from '../../../src/renderer/src/components/batch/inspector/OutcomeByRecipeTable'

const RUN = 'R-0031' as RunId
const OTHER_RUN = 'R-0030' as RunId

afterEach(() =>
{
  cleanup()
})

interface JobOptions
{
  state?: JobState
  runId?: RunId | null
  percent?: number | null
  stage?: string
  acknowledged?: boolean
  warnings?: number
  loudness?: Partial<NonNullable<ResultStamp['loudness']>> | null
  size?: 'within' | 'over' | null
  limitingDb?: number
}

function job(id: string, recipeLabel: string, options: JobOptions = {}): JobView
{
  const {
    state = 'done',
    runId = RUN,
    percent = null,
    stage,
    acknowledged = false,
    warnings = 0,
    loudness = null,
    size = null,
    limitingDb
  } = options
  return {
    id: id as JobId,
    recipeLabel,
    runId,
    state,
    acknowledged,
    warnings: Array.from({ length: warnings }, () => ({ code: 'outside-tolerance' })),
    source: { name: `${id.toLowerCase()}.wav` },
    stage: stage === undefined ? null : { id: 'encode', pass: 1, passes: 1, label: stage, startedAt: 0 },
    progress: percent === null ? null : { percent },
    audioPlan: limitingDb === undefined ? null : [{ audioIndex: 0, limitingDb }],
    stamp: loudness === null && size === null
      ? null
      : {
        loudness: loudness === null
          ? null
          : {
            lufs: -16,
            unit: 'LKFS',
            reference: 'target',
            referenceLufs: -16,
            deviation: 0,
            deviationUnit: 'dB',
            check: 1,
            checkClass: 'lossy',
            status: 'within',
            ...loudness
          },
        size: size === null ? null : { targetBytes: 25_000_000, status: size }
      }
  } as unknown as JobView
}

function workers(total: number, active: Partial<WorkersState['active']> = {}): WorkersState
{
  return {
    setting: 'auto',
    limits: { total, videoCpu: 4, gpu: 2 },
    active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0, ...active }
  } as unknown as WorkersState
}

function runState(status: RunState['status'], runId: RunId | null, pool: WorkersState = workers(16)): RunState
{
  return { status, runId, workers: pool } as unknown as RunState
}

const podcasts: RecipeOutcome = {
  op: 'normalize',
  label: 'Apple Podcasts',
  presetId: 'apple-podcasts',
  userPresetId: null,
  jobs: 3,
  verified: 2,
  reachable: 0,
  outsideTolerance: 1,
  returned: 1,
  loudness: {
    unit: 'LKFS',
    targetLufs: -16,
    deviationUnit: 'dB',
    checks: [
      { checkClass: 'lossless', check: 0.5, jobs: 1, within: 1 },
      { checkClass: 'lossy', check: 1, jobs: 2, within: 1 }
    ],
    minLufs: -16.2,
    maxLufs: -14.4,
    streams: 3,
    maxTruePeakDbtp: -1.6,
    limitedJobs: 1,
    maxLimitingDb: 1.8,
    reachableLevels: []
  },
  size: null
}

const compress: RecipeOutcome = {
  op: 'compress',
  label: 'Target 25 MB',
  presetId: null,
  userPresetId: null,
  jobs: 2,
  verified: 2,
  reachable: 0,
  outsideTolerance: 0,
  returned: 0,
  loudness: null,
  size: { targetBytes: 25_000_000, jobs: 2, within: 2 }
}

const convert: RecipeOutcome = {
  ...compress,
  op: 'convert',
  label: 'Web 1080p',
  jobs: 1,
  size: null
}

const finishedJobs: JobView[] = [
  job('MM-0001', 'Apple Podcasts', { loudness: { lufs: -16.2, checkClass: 'lossless', check: 0.5 }, limitingDb: 1.8 }),
  job('MM-0002', 'Apple Podcasts', { loudness: { lufs: -15.9 }, limitingDb: 0 }),
  job('MM-0003', 'Apple Podcasts', { loudness: { lufs: -14.4, status: 'above', deviation: 1.6 }, warnings: 1 }),
  job('MM-0004', 'Target 25 MB', { size: 'within' }),
  job('MM-0005', 'Target 25 MB', { size: 'within' }),
  job('MM-0006', 'Web 1080p'),
  job('MM-0007', 'Apple Podcasts', { loudness: { lufs: -16 }, runId: OTHER_RUN })
]

const finishedSummary = { runId: RUN, recipes: [podcasts, compress, convert] } as unknown as BatchSummary

const ids = (...values: string[]): JobId[] => values as JobId[]

describe('overviewPhase', () =>
{
  it('reads before, running, and after from the run and the last summary', () =>
  {
    expect(overviewPhase({ status: 'idle', runId: null }, null)).toBe('before')
    expect(overviewPhase({ status: 'running', runId: RUN }, null)).toBe('running')
    expect(overviewPhase({ status: 'paused', runId: RUN }, finishedSummary)).toBe('running')
    expect(overviewPhase({ status: 'idle', runId: RUN }, finishedSummary)).toBe('after')
    expect(overviewPhase({ status: 'idle', runId: RUN }, null)).toBe('before')
  })
})

describe('workersLine', () =>
{
  it('states busy workers and the encodes in use', () =>
  {
    expect(workersLine(workers(16, { total: 6, videoCpu: 2, gpu: 1 }))).toBe('6 of 16 workers busy \u00b7 2 CPU video encodes \u00b7 1 GPU encode')
    expect(workersLine(workers(1, { total: 1 }))).toBe('1 of 1 worker busy')
  })
})

describe('recipeProgress', () =>
{
  const running: JobView[] = [
    job('MM-0101', 'Apple Podcasts', { state: 'done' }),
    job('MM-0102', 'Apple Podcasts', { state: 'failed' }),
    job('MM-0103', 'Apple Podcasts', { state: 'encoding', percent: 50, stage: 'Encoding' }),
    job('MM-0104', 'Apple Podcasts', { state: 'queued' }),
    job('MM-0105', 'Spotify', { state: 'done', warnings: 1 }),
    job('MM-0106', 'Spotify', { state: 'held' }),
    job('MM-0107', 'Spotify', { state: 'failed', acknowledged: true }),
    job('MM-0108', 'Spotify', { state: 'done', runId: OTHER_RUN })
  ]

  it('groups the batch by recipe with finished, attention, and weighted progress', () =>
  {
    const [podcast, spotify] = recipeProgress(running, RUN)
    expect(podcast).toEqual({
      recipe: 'Apple Podcasts',
      ids: ids('MM-0101', 'MM-0102', 'MM-0103', 'MM-0104'),
      finished: 2,
      attentionIds: ids('MM-0102'),
      fraction: 2.5 / 4
    })
    expect(spotify.ids).toEqual(ids('MM-0105', 'MM-0106', 'MM-0107'))
    expect(spotify.finished).toBe(2)
    expect(spotify.attentionIds).toEqual(ids('MM-0105', 'MM-0106'))
    expect(isFinished({ state: 'held' })).toBe(false)
    expect(isFinished({ state: 'skipped' })).toBe(true)
  })

  it('makes each count a filter of exactly the jobs it counts', () =>
  {
    const [podcast] = recipeProgress(running, RUN)
    expect(recipeFilter(podcast)).toEqual({ label: 'Apple Podcasts', ids: podcast.ids })
    expect(attentionFilter(podcast)).toEqual({ label: 'Apple Podcasts, needs attention', ids: ids('MM-0102') })
  })

  it('renders one line per recipe whose count buttons filter the table', () =>
  {
    const onFilter = vi.fn<(filter: JobFilter) => void>()
    render(<RecipeProgressList jobs={running} runId={RUN} onFilter={onFilter} />)
    const list = screen.getByRole('list', { name: 'Progress by operation' })
    const lines = within(list).getAllByRole('listitem')
    expect(lines).toHaveLength(2)

    fireEvent.click(within(lines[0]).getByRole('button', { name: '2 of 4 finished' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts', ids: ids('MM-0101', 'MM-0102', 'MM-0103', 'MM-0104') })
    fireEvent.click(within(lines[0]).getByRole('button', { name: '1 needs attention' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts, needs attention', ids: ids('MM-0102') })
    fireEvent.click(within(lines[1]).getByRole('button', { name: '2 need attention' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Spotify, needs attention', ids: ids('MM-0105', 'MM-0106') })

    expect(within(lines[0]).getByRole('progressbar', { name: 'Apple Podcasts progress' })).toHaveAttribute('aria-valuenow', '63')
    expect(within(lines[0]).queryByText('Finished')).toBeNull()
  })

  it('marks a settled recipe finished and omits a zero attention count', () =>
  {
    render(<RecipeProgressList jobs={[job('MM-0201', 'Gain', { state: 'done' })]} runId={RUN} onFilter={vi.fn()} />)
    expect(screen.getByText('Finished')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['1 of 1 finished'])
  })
})

describe('runningNow', () =>
{
  it('lists at most eight running jobs of the batch', () =>
  {
    const many = Array.from({ length: 11 }, (_, i) => job(`MM-03${String(i).padStart(2, '0')}`, 'Gain', { state: 'encoding', percent: i }))
    const { shown, more } = runningNow([...many, job('MM-0399', 'Gain', { state: 'queued' })], RUN)
    expect(RUNNING_NOW_LIMIT).toBe(8)
    expect(shown).toHaveLength(8)
    expect(more).toBe(3)
  })
})

describe('outcome cells', () =>
{
  it('states the check each recipe held its jobs to', () =>
  {
    expect(checkCell(podcasts)).toBe('\u00b10.5 dB lossless, \u00b11.0 dB lossy')
    expect(checkCell(compress)).toBe('At or under 25 MB')
    expect(checkCell(convert)).toBe('Not checked')
  })

  it('states the range, the highest true peak, and the limiting', () =>
  {
    expect(rangeCell(podcasts)).toBe('\u221216.2 to \u221214.4 LKFS')
    expect(rangeCell({ ...podcasts, loudness: { ...podcasts.loudness!, minLufs: -16, maxLufs: -16 } })).toBe('\u221216.0 LKFS')
    expect(rangeCell(compress)).toBe(NOT_MEASURED)
    expect(peakCell(podcasts)).toBe('\u22121.6 dBTP')
    expect(peakCell(compress)).toBe(NOT_MEASURED)
    expect(limitingNote(podcasts)).toBe('at most 1.8 dB')
    expect(limitingNote({ ...podcasts, loudness: { ...podcasts.loudness!, limitedJobs: 0 } })).toBeNull()
    expect(limitingNote(compress)).toBeNull()
  })

  it('pairs every count with the exact jobs it counts', () =>
  {
    const [loud, size, plain] = outcomeRows(finishedSummary, finishedJobs)
    expect(loud.jobs).toEqual({ label: 'Apple Podcasts', ids: ids('MM-0001', 'MM-0002', 'MM-0003') })
    expect(loud.within).toEqual({ count: 2, filter: { label: 'Apple Podcasts, within tolerance', ids: ids('MM-0001', 'MM-0002') } })
    expect(loud.limited).toEqual({ count: 1, filter: { label: 'Apple Podcasts, peak limiting applied', ids: ids('MM-0001') } })
    expect(size.within).toEqual({ count: 2, filter: { label: 'Target 25 MB, within tolerance', ids: ids('MM-0004', 'MM-0005') } })
    expect(size.limited).toBeNull()
    expect(plain.within).toBeNull()
  })
})

describe('OutcomeByRecipeTable', () =>
{
  it('shows a block per operation with its measured values and filters the table from each count', () =>
  {
    const onFilter = vi.fn<(filter: JobFilter) => void>()
    render(<OutcomeByRecipeTable summary={finishedSummary} jobs={finishedJobs} onFilter={onFilter} />)
    const list = screen.getByRole('list', { name: 'Results by operation' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const facts = (index: number): string[] =>
    {
      const terms = [...rows[index].querySelectorAll('dt')].map((term) => term.textContent ?? '')
      const values = [...rows[index].querySelectorAll('dd')].map((value) => value.textContent ?? '')
      return [rows[index].querySelector('p')?.textContent ?? '', ...terms.map((term, at) => `${term}: ${values[at]}`)]
    }
    expect(facts(0)).toEqual([
      'Apple Podcasts',
      `${OUTCOME_COLUMNS[1]}: 3`,
      `${OUTCOME_COLUMNS[2]}: \u00b10.5 dB lossless, \u00b11.0 dB lossy`,
      `${OUTCOME_COLUMNS[3]}: 2 of 3`,
      `${OUTCOME_COLUMNS[4]}: \u221216.2 to \u221214.4 LKFS`,
      `${OUTCOME_COLUMNS[5]}: \u22121.6 dBTP`,
      `${OUTCOME_COLUMNS[6]}: 1at most 1.8 dB`
    ])
    expect(facts(1)).toEqual(['Target 25 MB', `${OUTCOME_COLUMNS[1]}: 2`, `${OUTCOME_COLUMNS[2]}: At or under 25 MB`, `${OUTCOME_COLUMNS[3]}: 2 of 2`])
    expect(facts(2)).toEqual(['Web 1080p', `${OUTCOME_COLUMNS[1]}: 1`, `${OUTCOME_COLUMNS[2]}: Not checked`])
    expect(screen.queryByText(NOT_MEASURED)).toBeNull()

    fireEvent.click(within(rows[0]).getByRole('button', { name: '3' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts', ids: ids('MM-0001', 'MM-0002', 'MM-0003') })
    fireEvent.click(within(rows[0]).getByRole('button', { name: '2 of 3' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts, within tolerance', ids: ids('MM-0001', 'MM-0002') })
    fireEvent.click(within(rows[0]).getByRole('button', { name: '1' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts, peak limiting applied', ids: ids('MM-0001') })
    fireEvent.click(within(rows[1]).getByRole('button', { name: '2 of 2' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Target 25 MB, within tolerance', ids: ids('MM-0004', 'MM-0005') })
    expect(within(rows[2]).getAllByRole('button')).toHaveLength(1)
  })

  it('writes zero counts as text, not buttons', () =>
  {
    const none: RecipeOutcome = {
      ...podcasts,
      loudness: { ...podcasts.loudness!, checks: [{ checkClass: 'lossy', check: 1, jobs: 3, within: 0 }], limitedJobs: 0, maxLimitingDb: null }
    }
    render(<OutcomeByRecipeTable summary={{ ...finishedSummary, recipes: [none] }} jobs={finishedJobs} onFilter={vi.fn()} />)
    expect(screen.getByText('0 of 3')).toBeInTheDocument()
    expect(screen.getByText(NO_LIMITING)).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['3'])
  })
})

describe('BatchOverview', () =>
{
  const props = {
    outputPolicy: 'Writes to D:\\Exports\\Podcasts \u00b7 Originals not touched',
    newFilesRecipe: 'Normalize \u00b7 Apple Podcasts',
    onFilter: vi.fn<(filter: JobFilter) => void>(),
    onFocusJob: vi.fn<(id: JobId) => void>()
  }

  it('teaches the inspector before any batch', () =>
  {
    render(<BatchOverview {...props} jobs={[]} run={runState('idle', null)} summary={null} />)
    const view = screen.getByRole('group', { name: OVERVIEW_WORDS.label })
    expect(view).toHaveAttribute('data-phase', 'before')
    expect(screen.queryByText(OVERVIEW_WORDS.intro)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Output' })).getByText(props.outputPolicy)).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'New files' })).getByText(props.newFilesRecipe)).toBeInTheDocument()
  })

  it('shows progress by recipe, the jobs running now, and the workers during a run', () =>
  {
    const onFocusJob = vi.fn<(id: JobId) => void>()
    const onFilter = vi.fn<(filter: JobFilter) => void>()
    const jobs = [
      job('MM-0141', 'Apple Podcasts', { state: 'encoding', percent: 46, stage: 'Encoding, pass 1 of 2' }),
      job('MM-0142', 'Apple Podcasts', { state: 'analyzing', percent: 10 }),
      job('MM-0143', 'Apple Podcasts', { state: 'failed' }),
      ...Array.from({ length: 8 }, (_, i) => job(`MM-02${i}0`, 'Gain', { state: 'verifying', percent: 90 }))
    ]
    render(
      <BatchOverview
        {...props}
        onFocusJob={onFocusJob}
        onFilter={onFilter}
        jobs={jobs}
        run={runState('running', RUN, workers(16, { total: 6, videoCpu: 2, gpu: 1 }))}
        summary={null}
      />
    )
    expect(screen.getByRole('group', { name: OVERVIEW_WORDS.label })).toHaveAttribute('data-phase', 'running')
    const progress = screen.getByRole('list', { name: 'Progress by operation' })
    fireEvent.click(within(progress).getByRole('button', { name: '1 needs attention' }))
    expect(onFilter).toHaveBeenLastCalledWith({ label: 'Apple Podcasts, needs attention', ids: ids('MM-0143') })

    const running = screen.getByRole('list', { name: 'Running now' })
    const buttons = within(running).getAllByRole('button')
    expect(buttons).toHaveLength(8)
    expect(buttons[0]).toHaveTextContent('MM-0141')
    expect(buttons[0]).toHaveTextContent('mm-0141.wav')
    expect(buttons[0]).toHaveTextContent('Encoding, pass 1 of 2')
    expect(buttons[0]).toHaveTextContent('46%')
    expect(buttons[1]).toHaveTextContent('Analyzing')
    expect(within(running).getByText('and 2 more')).toBeInTheDocument()
    fireEvent.click(buttons[0])
    expect(onFocusJob).toHaveBeenCalledWith('MM-0141')
    expect(screen.getByText('6 of 16 workers busy \u00b7 2 CPU video encodes \u00b7 1 GPU encode')).toBeInTheDocument()
  })

  it('says so while a paused batch runs nothing', () =>
  {
    render(<BatchOverview {...props} jobs={[job('MM-0150', 'Gain', { state: 'queued' })]} run={runState('paused', RUN)} summary={null} />)
    expect(screen.getByText(OVERVIEW_WORDS.noneRunning)).toBeInTheDocument()
  })

  it('shows outcomes by recipe and the loudness strip plot after a batch', () =>
  {
    const onFocusJob = vi.fn<(id: JobId) => void>()
    const sources = new Map([['MM-0001' as JobId, -21.4], ['MM-0003' as JobId, -30]])
    const { container } = render(
      <BatchOverview
        {...props}
        onFocusJob={onFocusJob}
        jobs={finishedJobs}
        run={runState('idle', RUN)}
        summary={finishedSummary}
        sourceLoudness={sources}
      />
    )
    expect(screen.getByRole('group', { name: OVERVIEW_WORDS.label })).toHaveAttribute('data-phase', 'after')
    expect(screen.getByRole('list', { name: 'Results by operation' })).toBeInTheDocument()
    const loudness = screen.getByRole('region', { name: 'Loudness' })
    expect(container.querySelectorAll('[data-strip]')).toHaveLength(2)
    expect(within(loudness).getByText('Apple Podcasts, \u221216 LKFS, lossless outputs')).toBeInTheDocument()
    expect(within(loudness).getByText('Apple Podcasts, \u221216 LKFS, lossy outputs')).toBeInTheDocument()
    expect(container.querySelectorAll('circle[data-series="source"]')).toHaveLength(1)
    expect(container.querySelector('svg[data-beyond="below"]')).not.toBeNull()
    const table = within(loudness).getByRole('table', { name: 'Loudness by job' })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    fireEvent.click(within(table).getByRole('button', { name: 'MM-0003' }))
    expect(onFocusJob).toHaveBeenCalledWith('MM-0003')
  })
})
