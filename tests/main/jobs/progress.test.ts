import { describe, expect, it } from 'vitest'
import {
  createJobProgress,
  createRunProgress,
  createThroughputWindow,
  createSpeedBook,
  normalizeSpeed,
  parseSpeed,
  planWeight,
  stageWeight,
  weightedMediaSec,
  type PlannedStage,
  type RunJobInput,
  type SpeedBook,
  type StageSample
} from '../../../src/main/jobs/progress'

function stage(id: PlannedStage['id'], durationSec: number | null, extra: Partial<PlannedStage> = {}): PlannedStage
{
  return { id, pass: 1, passes: 1, durationSec, ...extra }
}

describe('stage weights', () =>
{
  it('weighs measure 1, encode 2, a full verify 1, a sampled verify 0.25, and placing nothing', () =>
  {
    expect(stageWeight(stage('measure', 60))).toBe(1)
    expect(stageWeight(stage('measure-dynamics', 60))).toBe(1)
    expect(stageWeight(stage('measure-album', 60))).toBe(1)
    expect(stageWeight(stage('encode', 60))).toBe(2)
    expect(stageWeight(stage('verify', 60))).toBe(1)
    expect(stageWeight(stage('verify', 60, { sampled: true }))).toBe(0.25)
    expect(stageWeight(stage('place', null))).toBe(0)
    expect(stageWeight(stage('trash', null))).toBe(0)
    expect(stageWeight(stage('probe', null))).toBe(0)
    expect(stageWeight(stage('wait-lock', null))).toBe(0)
  })

  it('weighs a two-pass encode 1 then 2, and a corrective audio pass 2', () =>
  {
    expect(stageWeight(stage('encode', 60, { pass: 1, passes: 2, twoPass: true }))).toBe(1)
    expect(stageWeight(stage('encode', 60, { pass: 2, passes: 2, twoPass: true }))).toBe(2)
    expect(stageWeight(stage('encode', 60, { pass: 2, passes: 2 }))).toBe(2)
  })

  it('adds up a plan', () =>
  {
    expect(planWeight([stage('measure', 60), stage('encode', 60), stage('verify', 60), stage('place', null)])).toBe(4)
    expect(planWeight([
      stage('encode', 60, { pass: 1, passes: 2, twoPass: true }),
      stage('encode', 60, { pass: 2, passes: 2, twoPass: true }),
      stage('verify', 60, { sampled: true })
    ])).toBe(3.25)
    expect(planWeight([])).toBe(0)
  })
})

describe('speeds', () =>
{
  it('treats 0x, N/A, and non-positive speeds as unknown', () =>
  {
    expect(normalizeSpeed(2.5)).toBe(2.5)
    expect(normalizeSpeed(0)).toBeNull()
    expect(normalizeSpeed(-1)).toBeNull()
    expect(normalizeSpeed(Number.NaN)).toBeNull()
    expect(normalizeSpeed(Number.POSITIVE_INFINITY)).toBeNull()
    expect(normalizeSpeed(null)).toBeNull()
    expect(normalizeSpeed(undefined)).toBeNull()
  })

  it.each([
    ['2.5x', 2.5],
    [' 1.02x', 1.02],
    ['31x', 31],
    ['1.2e+03x', 1200],
    ['0x', null],
    ['0.00x', null],
    ['N/A', null],
    ['', null],
    ['fast', null]
  ])('reads speed %s as %s', (text, speed) =>
  {
    expect(parseSpeed(text)).toBe(speed)
  })

  it('reads a missing speed as unknown', () =>
  {
    expect(parseSpeed(null)).toBeNull()
    expect(parseSpeed(undefined)).toBeNull()
  })

  it('times unobserved stages at 1x and observed ones at their mean', () =>
  {
    const book = createSpeedBook()
    expect(book.speed('audio', 'encode')).toBe(1)
    book.observe('audio', 'encode', 30)
    book.observe('audio', 'encode', 50)
    book.observe('audio', 'encode', 0)
    book.observe('audio', 'encode', Number.NaN)
    expect(book.speed('audio', 'encode')).toBe(40)
    expect(book.speed('video-cpu', 'encode')).toBe(1)
    expect(book.speed('audio', 'verify')).toBe(1)
  })
})

const NORMALIZE: PlannedStage[] = [stage('measure', 60), stage('encode', 60), stage('verify', 60), stage('place', null)]

function tracker(stages: PlannedStage[] = NORMALIZE, speeds: SpeedBook = createSpeedBook())
{
  return createJobProgress({ stages, jobClass: 'audio', speeds, startedAt: 1000 })
}

function sample(outTimeSec: number | null, speed: number | null = 10, extra: Partial<StageSample> = {}): StageSample
{
  return { outTimeSec, speed, bytesWritten: null, ...extra }
}

function finiteOrNull(value: number | null): boolean
{
  return value === null || Number.isFinite(value)
}

describe('createJobProgress', () =>
{
  it('weighs each stage of a normalize job', () =>
  {
    const job = tracker()
    expect(job.weightTotal).toBe(4)
    expect(job.start('measure', 1, 1000).percent).toBe(0)
    expect(job.sample(sample(30), 1500)).toMatchObject({ stage: 'measure', percent: 12.5, stagePercent: 50 })
    expect(job.finishStage(2000)).toMatchObject({ percent: 25, stagePercent: 100 })
    job.start('encode', 1, 2000)
    expect(job.sample(sample(30), 3000).percent).toBe(50)
    expect(job.start('verify', 1, 4000).percent).toBe(75)
    expect(job.finishStage(5000).percent).toBe(100)
    expect(job.start('place', 1, 5000)).toMatchObject({ stage: 'place', percent: 100 })
    expect(job.finishStage(5100).percent).toBe(100)
  })

  it('weighs a two-pass encode 1 then 2 and a sampled verify 0.25', () =>
  {
    const job = tracker([
      stage('encode', 100, { pass: 1, passes: 2, twoPass: true }),
      stage('encode', 100, { pass: 2, passes: 2, twoPass: true }),
      stage('verify', 100, { sampled: true })
    ])
    job.start('encode', 1, 1000)
    expect(job.finishStage(2000).percent).toBeCloseTo(100 / 3.25)
    expect(job.start('encode', 2, 2000)).toMatchObject({ pass: 2, passes: 2 })
    expect(job.finishStage(3000).percent).toBeCloseTo(300 / 3.25)
  })

  it('never lets the percent drop when a corrective pass is added', () =>
  {
    const job = tracker([stage('measure', 60), stage('encode', 60), stage('verify', 60)])
    const seen: number[] = []
    const track = (value: { percent: number }): void =>
    {
      seen.push(value.percent)
    }
    track(job.start('measure', 1, 1000))
    track(job.finishStage(2000))
    track(job.start('encode', 1, 2000))
    track(job.sample(sample(60), 3000))
    track(job.start('verify', 1, 3000))
    track(job.sample(sample(30), 3500))
    expect(job.percent).toBe(87.5)
    track(job.extend([stage('encode', 60, { pass: 2, passes: 2 }), stage('verify', 60)], 3600))
    expect(job.percent).toBe(87.5)
    expect(job.weightTotal).toBe(7)
    track(job.start('encode', 2, 4000))
    track(job.sample(sample(30), 4500))
    track(job.sample(sample(10), 4600))
    track(job.start('verify', 1, 5000))
    track(job.finishStage(6000))
    for (let i = 1; i < seen.length; i += 1)
    {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    }
    expect(seen[seen.length - 1]).toBe(100)
  })

  it('spreads the rest of the range over the added stages', () =>
  {
    const job = tracker([stage('encode', 100), stage('verify', 100)])
    job.start('encode', 1, 1000)
    job.finishStage(2000)
    job.start('verify', 1, 2000)
    job.sample(sample(50), 2500)
    const before = job.percent
    job.extend([stage('encode', 100, { pass: 2, passes: 2 }), stage('verify', 100)], 2600)
    job.start('encode', 2, 3000)
    const afterVerify = job.percent
    expect(afterVerify).toBeGreaterThan(before)
    job.sample(sample(50), 3500)
    const halfway = job.percent
    expect(halfway).toBeCloseTo(before + ((100 - before) * 1.5) / 3.5)
    job.start('verify', 1, 4000)
    expect(job.finishStage(5000).percent).toBe(100)
  })

  it('holds the percent when the output time goes backward', () =>
  {
    const job = tracker()
    job.start('measure', 1, 1000)
    job.sample(sample(40), 1100)
    expect(job.sample(sample(10), 1200).percent).toBeCloseTo((1 * 40) / 60 / 4 * 100)
  })

  it('adds nothing for a stage of unknown or zero span until it finishes', () =>
  {
    for (const durationSec of [null, 0])
    {
      const job = tracker([stage('measure', durationSec), stage('encode', 60)])
      job.start('measure', 1, 1000)
      const running = job.sample(sample(30), 1500)
      expect(running.percent).toBe(0)
      expect(running.stagePercent).toBeNull()
      expect(running.durationSec).toBeNull()
      expect(Number.isNaN(running.percent)).toBe(false)
      job.sample(sample(31), 1600)
      expect(job.progress(1600).etaSec).toBeNull()
      expect(job.finishStage(2000).percent).toBeCloseTo(100 / 3)
      expect(job.mediaSecDone).toBe(31)
    }
  })

  it('reads a 0x speed as unknown and gives no time left', () =>
  {
    const job = tracker()
    job.start('encode', 1, 1000)
    job.sample(sample(1, 0), 1100)
    const progress = job.sample(sample(2, 0), 1200)
    expect(progress.speed).toBeNull()
    expect(progress.etaSec).toBeNull()
    expect(job.sample(sample(3, Number.NaN), 1300).speed).toBeNull()
  })

  it('never reports NaN for missing or bad numbers', () =>
  {
    const job = tracker()
    job.start('measure', 1, 1000)
    const progress = job.sample({ outTimeSec: Number.NaN, speed: Number.NaN, bytesWritten: Number.NaN }, 1100)
    expect(progress).toMatchObject({ outTimeSec: null, speed: null, bytesWritten: null, stagePercent: null, etaSec: null, percent: 0 })
    expect(job.sample(sample(-5, 2), 1200)).toMatchObject({ outTimeSec: 0, stagePercent: 0 })
    for (const value of [progress.percent, progress.stagePercent, progress.etaSec, progress.speed, progress.durationSec])
    {
      expect(finiteOrNull(value)).toBe(true)
    }
  })

  it('takes a span the samples reveal', () =>
  {
    const job = tracker([stage('encode', null), stage('verify', null)])
    job.start('encode', 1, 1000)
    const progress = job.sample(sample(30, 2, { durationSec: 120 }), 1500)
    expect(progress).toMatchObject({ durationSec: 120, stagePercent: 25 })
    expect(job.sample(sample(60, 2, { durationSec: Number.NaN }), 1600).durationSec).toBe(120)
  })

  it('estimates the job time left from the second sample on', () =>
  {
    const speeds = createSpeedBook()
    const job = tracker(NORMALIZE, speeds)
    job.start('measure', 1, 1000)
    expect(job.sample(sample(10, 2), 1500).etaSec).toBeNull()
    expect(job.sample(sample(30, 2), 2000).etaSec).toBe(15 + 60 + 60)
    speeds.observe('audio', 'encode', 30)
    speeds.observe('audio', 'verify', 60)
    expect(job.progress(2000).etaSec).toBe(15 + 2 + 1)
  })

  it('learns the speed of a finished stage for later jobs of its class', () =>
  {
    const speeds = createSpeedBook()
    const job = tracker(NORMALIZE, speeds)
    job.start('measure', 1, 1000)
    job.sample(sample(60, 25), 3000)
    job.finishStage(3000)
    expect(speeds.speed('audio', 'measure')).toBe(30)
    const quick = tracker([stage('encode', null)], speeds)
    quick.start('encode', 1, 5000)
    quick.sample(sample(10, 4), 5000)
    quick.finishStage(5000)
    expect(speeds.speed('audio', 'encode')).toBe(4)
    const silent = tracker([stage('verify', null)], speeds)
    silent.start('verify', 1, 6000)
    silent.finishStage(6000)
    expect(speeds.speed('audio', 'verify')).toBe(1)
  })

  it('has no time left between stages', () =>
  {
    const job = tracker()
    job.start('measure', 1, 1000)
    job.sample(sample(10), 1100)
    job.sample(sample(20), 1200)
    expect(job.finishStage(1300).etaSec).toBeNull()
  })

  it('counts planned stages it passed over as done', () =>
  {
    const job = tracker([stage('measure', 60), stage('measure-dynamics', 60), stage('encode', 60)])
    job.start('measure', 1, 1000)
    expect(job.start('encode', 1, 2000).percent).toBe(50)
  })

  it('matches a stage by its id when the pass differs from the plan', () =>
  {
    const job = tracker([stage('measure', 60), stage('encode', 60)])
    job.start('measure', 1, 1000)
    expect(job.start('encode', 3, 2000)).toMatchObject({ stage: 'encode', pass: 1, passes: 1, percent: 100 / 3 })
  })

  it('reports an unplanned stage without moving the percent', () =>
  {
    const job = tracker()
    job.start('measure', 1, 1000)
    job.finishStage(2000)
    const waiting = job.start('wait-lock', 1, 2000)
    expect(waiting).toMatchObject({ stage: 'wait-lock', pass: 1, passes: 1, percent: 25, stagePercent: null })
    job.sample(sample(null, null), 2500)
    expect(job.start('encode', 1, 3000).percent).toBe(25)
    const early = tracker()
    expect(early.start('probe', 1, 1000)).toMatchObject({ stage: 'probe', percent: 0 })
    early.sample(sample(5, 1, { durationSec: 10 }), 1100)
    early.sample(sample(6, 1), 1200)
    expect(early.progress(1200).etaSec).toBe(4 + 60 + 60 + 60)
    expect(early.start('measure', 1, 2000).percent).toBe(0)
  })

  it('counts media seconds across stages', () =>
  {
    const job = tracker()
    job.start('measure', 1, 1000)
    job.sample(sample(90), 1500)
    expect(job.mediaSecDone).toBe(60)
    job.finishStage(2000)
    job.start('encode', 1, 2000)
    job.sample(sample(30), 2500)
    expect(job.mediaSecDone).toBe(90)
    const unknown = tracker([stage('measure', null)])
    unknown.start('measure', 1, 1000)
    unknown.sample(sample(12), 1100)
    expect(unknown.mediaSecDone).toBe(12)
  })

  it('reports before any stage starts and ignores samples outside a stage', () =>
  {
    const job = tracker()
    expect(job.progress(1500)).toEqual({
      stage: 'measure',
      pass: 1,
      passes: 1,
      percent: 0,
      stagePercent: null,
      speed: null,
      etaSec: null,
      outTimeSec: null,
      durationSec: null,
      bytesWritten: null,
      elapsedMs: 500
    })
    expect(job.sample(sample(30), 1600).percent).toBe(0)
    expect(job.progress(500).elapsedMs).toBe(0)
    job.start('measure', 1, 2000)
    job.finishStage(2500)
    expect(job.sample(sample(30), 2600).outTimeSec).toBeNull()
    expect(job.finishStage(2700).percent).toBe(25)
  })

  it('reports bytes written and elapsed time', () =>
  {
    const job = tracker()
    job.start('encode', 1, 1000)
    expect(job.sample(sample(10, 2, { bytesWritten: 312_000 }), 4000)).toMatchObject({ bytesWritten: 312_000, elapsedMs: 3000 })
  })

  it('handles an empty plan', () =>
  {
    const job = tracker([])
    expect(job.progress(1000)).toMatchObject({ stage: 'probe', percent: 0 })
    job.start('encode', 1, 1000)
    expect(job.finishStage(2000).percent).toBe(0)
    expect(job.weightTotal).toBe(0)
  })

  it('keeps 100 when stages are added after every stage finished', () =>
  {
    const job = tracker([stage('verify', 60)])
    job.start('verify', 1, 1000)
    job.finishStage(2000)
    expect(job.extend([stage('encode', 60, { pass: 2, passes: 2 })], 2000).percent).toBe(100)
    job.start('encode', 2, 2000)
    expect(job.sample(sample(30), 2500).percent).toBe(100)
  })
})

describe('createThroughputWindow', () =>
{
  it('has no rate until an observation spans some time', () =>
  {
    const window = createThroughputWindow()
    expect(window.rate).toBeNull()
    expect(window.observe(0, 1000)).toBeNull()
    expect(window.observe(5, 1000)).toBeNull()
    expect(window.rate).toBeNull()
  })

  it('reads a steady rate as that rate', () =>
  {
    const window = createThroughputWindow()
    for (let second = 0; second <= 120; second += 1)
    {
      window.observe(second * 3.4, second * 1000)
    }
    expect(window.rate).toBeCloseTo(3.4, 10)
  })

  it('averages a short history plainly instead of leaning on the first interval', () =>
  {
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(10, 1000)
    for (let second = 2; second <= 15; second += 1)
    {
      window.observe(10 + (second - 1) * 2, second * 1000)
    }
    const weights = Array.from({ length: 15 }, (_, i) => Math.exp(-(14 - i) / 30))
    const expected = (10 * weights[0] + 2 * weights.slice(1).reduce((a, b) => a + b, 0)) / weights.reduce((a, b) => a + b, 0)
    expect(window.rate).toBeCloseTo(expected, 10)
    expect(window.rate).toBeLessThan(3)
  })

  it('follows a change of rate with a 30-second time constant', () =>
  {
    const window = createThroughputWindow()
    let total = 0
    for (let second = 1; second <= 600; second += 1)
    {
      total += 2
      window.observe(total, second * 1000)
    }
    expect(window.rate).toBeCloseTo(2, 6)
    for (let second = 601; second <= 630; second += 1)
    {
      total += 4
      window.observe(total, second * 1000)
    }
    expect(window.rate).toBeCloseTo(4 - 2 / Math.E, 2)
    for (let second = 631; second <= 900; second += 1)
    {
      total += 4
      window.observe(total, second * 1000)
    }
    expect(window.rate).toBeCloseTo(4, 3)
  })

  it('takes a custom window', () =>
  {
    const short = createThroughputWindow(1000)
    const long = createThroughputWindow()
    for (const window of [short, long])
    {
      window.observe(0, 0)
      window.observe(100, 1000)
      window.observe(100, 4000)
    }
    expect(short.rate).toBeCloseTo((100 * Math.exp(-3) * 1000) / (1000 * Math.exp(-3) + 3000), 10)
    expect(long.rate).toBeCloseTo((100 * Math.exp(-0.1) * 1000) / (1000 * Math.exp(-0.1) + 3000), 10)
    expect(long.rate ?? 0).toBeGreaterThan(short.rate ?? 0)
  })

  it('counts a falling total as no progress and ignores bad numbers and repeated times', () =>
  {
    const window = createThroughputWindow()
    window.observe(10, 0)
    window.observe(4, 1000)
    expect(window.rate).toBe(0)
    window.observe(Number.NaN, 2000)
    window.observe(6, Number.POSITIVE_INFINITY)
    window.observe(6, 1000)
    window.observe(6, 500)
    expect(window.rate).toBe(0)
    window.observe(6, 2000)
    expect(window.rate).toBeCloseTo(2 * 1000 / (Math.exp(-1 / 30) * 1000 + 1000), 10)
  })

  it('leaves a paused gap out after a rebase', () =>
  {
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(10, 10_000)
    expect(window.rate).toBeCloseTo(1, 10)
    window.rebase(10, 3_600_000)
    window.observe(20, 3_610_000)
    expect(window.rate).toBeCloseTo(1, 10)
    window.rebase(Number.NaN, 4_000_000)
    window.observe(30, 3_620_000)
    expect(window.rate).toBeCloseTo(1, 10)
  })
})

describe('job work', () =>
{
  it('weighs work by span and counts what the attempt has done', () =>
  {
    const job = tracker()
    expect(job.work).toBe(240)
    expect(job.workDone).toBe(0)
    job.start('measure', 1, 1000)
    job.sample(sample(30), 1500)
    expect(job.workDone).toBe(30)
    job.start('encode', 1, 2000)
    expect(job.workDone).toBe(60)
    job.sample(sample(15), 2500)
    expect(job.workDone).toBe(90)
    job.finishStage(3000)
    expect(job.workDone).toBe(180)
  })

  it('takes a span revealed by the samples and adds corrective stages', () =>
  {
    const job = tracker([stage('encode', null), stage('verify', null)])
    expect(job.work).toBe(0)
    job.start('encode', 1, 1000)
    job.sample(sample(10, 10, { durationSec: 40 }), 1500)
    expect(job.work).toBe(80)
    expect(job.workDone).toBe(20)
    job.finishStage(2000)
    job.extend([stage('encode', 40, { pass: 2, passes: 2 })], 2000)
    expect(job.work).toBe(160)
    expect(job.workDone).toBe(80)
  })

  it('leaves a revealed span on the planned stage, not one started outside the plan', () =>
  {
    const job = tracker([stage('encode', 60)])
    job.start('encode', 1, 1000)
    job.finishStage(2000)
    job.start('wait-lock', 1, 2000)
    job.sample(sample(5, 1, { durationSec: 10 }), 2500)
    expect(job.work).toBe(120)
    expect(job.workDone).toBe(120)
  })
})

describe('weightedMediaSec', () =>
{
  it('adds each stage weight times its span', () =>
  {
    expect(weightedMediaSec(NORMALIZE)).toBe(240)
    expect(weightedMediaSec([stage('encode', 100, { twoPass: true }), stage('encode', 100, { pass: 2, passes: 2, twoPass: true })])).toBe(300)
    expect(weightedMediaSec([stage('verify', 100, { sampled: true })])).toBe(25)
  })

  it('is null while no weighted stage has a known span', () =>
  {
    expect(weightedMediaSec([])).toBeNull()
    expect(weightedMediaSec([stage('encode', null), stage('verify', 0), stage('place', 60)])).toBeNull()
    expect(weightedMediaSec([stage('encode', Number.NaN), stage('measure', 10)])).toBe(10)
  })
})

function runJob(id: string, state: RunJobInput['state'], extra: Partial<RunJobInput> = {}): RunJobInput
{
  return { id: id as RunJobInput['id'], state, work: 100, ...extra }
}

describe('createRunProgress', () =>
{
  it('weighs the run by work, never by the mean of row percents', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    const progress = run.update({
      status: 'running',
      jobs: [
        runJob('a', 'done', { work: 300 }),
        runJob('b', 'encoding', { work: 100, workDone: 50 }),
        runJob('c', 'queued', { work: 600 })
      ]
    }, 1000)
    expect(progress.percent).toBe(35)
  })

  it('counts finished and held jobs in full and leaves pending jobs out', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    const jobs = [
      runJob('a', 'failed'), runJob('b', 'canceled'), runJob('c', 'skipped'), runJob('d', 'interrupted'),
      runJob('e', 'held'), runJob('f', 'queued'), runJob('g', 'pending', { work: 1_000_000 })
    ]
    expect(run.update({ status: 'running', jobs }, 1000).percent).toBeCloseTo(500 / 6, 10)
    expect(run.update({ status: 'idle', jobs: jobs.filter((job) => job.state !== 'queued') }, 2000).percent).toBe(100)
  })

  it('lowers the percent when jobs are appended', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    expect(run.update({ status: 'running', jobs: [runJob('a', 'done'), runJob('b', 'queued')] }, 1000).percent).toBe(50)
    expect(run.update({ status: 'running', jobs: [runJob('a', 'done'), runJob('b', 'queued'), runJob('c', 'queued'), runJob('d', 'queued')] }, 2000).percent).toBe(25)
  })

  it('weighs a job of unknown span as the mean of the known ones, and 1 when none is known', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    const mixed = [runJob('a', 'done', { work: 100 }), runJob('b', 'done', { work: 300 }), runJob('c', 'queued', { work: null })]
    expect(run.update({ status: 'running', jobs: mixed }, 1000).percent).toBeCloseTo(400 / 6, 10)
    const unknown = [runJob('a', 'done', { work: 0 }), runJob('b', 'encoding', { work: null, percent: 50 })]
    expect(run.update({ status: 'running', jobs: unknown }, 2000).percent).toBe(75)
  })

  it('falls back to the job percent without the work done, and never reports NaN', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    const progress = run.update({
      status: 'running',
      jobs: [
        runJob('a', 'encoding', { percent: 40 }),
        runJob('b', 'verifying', { percent: Number.NaN, workDone: Number.NaN, speed: Number.NaN, bytesWritten: Number.NaN }),
        runJob('c', 'analyzing', { workDone: 500 })
      ]
    }, 1000)
    expect(progress.percent).toBeCloseTo(140 / 3, 10)
    expect(Object.values(progress).every((value) => value === null || Number.isFinite(value))).toBe(true)
    expect(createRunProgress({ startedAt: 0 }).update({ status: 'running', jobs: [] }, 0)).toEqual({
      percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0
    })
  })

  it('sums the running speeds and every bytes written', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    const progress = run.update({
      status: 'running',
      jobs: [
        runJob('a', 'encoding', { speed: 2.5, bytesWritten: 1000 }),
        runJob('b', 'analyzing', { speed: 40, bytesWritten: null }),
        runJob('c', 'encoding', { speed: 0 }),
        runJob('d', 'done', { speed: 9, bytesWritten: 5000 }),
        runJob('e', 'pending', { bytesWritten: 7000 })
      ]
    }, 1000)
    expect(progress.aggregateSpeed).toBe(42.5)
    expect(progress.bytesWritten).toBe(6000)
    expect(run.update({ status: 'running', jobs: [runJob('a', 'encoding', { speed: null })] }, 2000).aggregateSpeed).toBeNull()
  })
})

describe('run time left and throughput', () =>
{
  function steady(run: ReturnType<typeof createRunProgress>, from: number, to: number, rate: number, status: 'running' | 'pausing' = 'running')
  {
    let last = run.update({ status, jobs: [runJob('a', 'encoding', { work: 1000, workDone: from * rate, mediaSecDone: from * rate / 2 })] }, from * 1000)
    for (let second = from + 1; second <= to; second += 1)
    {
      last = run.update({ status, jobs: [runJob('a', 'encoding', { work: 1000, workDone: second * rate, mediaSecDone: second * rate / 2 })] }, second * 1000)
    }
    return last
  }

  it('estimates nothing for the first 15 seconds, then divides the remaining work by the throughput', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    expect(steady(run, 0, 14, 10).etaSec).toBeNull()
    const progress = steady(run, 15, 15, 10)
    expect(progress.etaSec).toBeCloseTo(85, 10)
    expect(progress.mediaSecPerSec).toBeCloseTo(5, 10)
    expect(progress.elapsedMs).toBe(15_000)
  })

  it('takes a custom delay and window', () =>
  {
    const run = createRunProgress({ startedAt: 0, etaDelayMs: 2000, windowMs: 1000 })
    expect(steady(run, 0, 2, 10).etaSec).toBeCloseTo(98, 10)
  })

  it('needs some progress before it estimates', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    expect(steady(run, 0, 20, 0)).toMatchObject({ etaSec: null, mediaSecPerSec: 0 })
  })

  it('reads 0 left when the work is done but a job still finishes', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    steady(run, 0, 20, 10)
    const progress = run.update({ status: 'running', jobs: [runJob('a', 'finalizing', { work: 200, workDone: 200 })] }, 21_000)
    expect(progress.etaSec).toBe(0)
  })

  it('hides the time left while pausing, canceling, paused, and idle, and stops the clock while paused', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    steady(run, 0, 20, 10)
    const pausing = steady(run, 21, 21, 10, 'pausing')
    expect(pausing.etaSec).toBeNull()
    expect(pausing.mediaSecPerSec).toBeCloseTo(5, 10)
    const canceling = run.update({ status: 'canceling', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 220 })] }, 22_000)
    expect(canceling.etaSec).toBeNull()
    expect(canceling.elapsedMs).toBe(22_000)
    const paused = run.update({ status: 'paused', jobs: [runJob('a', 'queued', { work: 1000 })] }, 23_000)
    expect(paused).toMatchObject({ etaSec: null, mediaSecPerSec: null, elapsedMs: 23_000 })
    expect(run.update({ status: 'paused', jobs: [runJob('a', 'queued', { work: 1000 })] }, 3_600_000).elapsedMs).toBe(23_000)
    expect(run.update({ status: 'idle', jobs: [runJob('a', 'done', { work: 1000 })] }, 3_700_000)).toMatchObject({ etaSec: null, mediaSecPerSec: null })
  })

  it('leaves the paused gap out of the elapsed time and the throughput', () =>
  {
    const run = createRunProgress({ startedAt: 0 })
    steady(run, 0, 20, 10)
    run.update({ status: 'paused', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 200, mediaSecDone: 100 })] }, 20_000)
    run.update({ status: 'paused', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 200, mediaSecDone: 100 })] }, 3_620_000)
    const resumed = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 200, mediaSecDone: 100 })] }, 3_620_000)
    expect(resumed.elapsedMs).toBe(20_000)
    let progress = resumed
    for (let second = 1; second <= 10; second += 1)
    {
      progress = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 200 + second * 10, mediaSecDone: 100 + second * 5 })] }, 3_620_000 + second * 1000)
    }
    expect(progress.elapsedMs).toBe(30_000)
    expect(progress.etaSec).toBeCloseTo(70, 10)
    expect(progress.mediaSecPerSec).toBeCloseTo(5, 10)
  })

  it('carries the elapsed time of a restored run', () =>
  {
    const run = createRunProgress({ startedAt: 1000, elapsedMs: 60_000 })
    expect(run.update({ status: 'paused', jobs: [runJob('a', 'queued')] }, 1000).elapsedMs).toBe(60_000)
    run.update({ status: 'running', jobs: [runJob('a', 'queued')] }, 5000)
    expect(run.update({ status: 'running', jobs: [runJob('a', 'encoding', { workDone: 10 })] }, 15_000).elapsedMs).toBe(70_000)
    expect(createRunProgress({ startedAt: 0, elapsedMs: Number.NaN }).update({ status: 'running', jobs: [] }, 10).elapsedMs).toBe(10)
  })

  it('counts a new execution from zero and a falling attempt as a new baseline', () =>
  {
    const run = createRunProgress({ startedAt: 0, etaDelayMs: 0 })
    run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 0, execution: 1 })] }, 0)
    run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 500, execution: 1 })] }, 10_000)
    const restarted = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 100, execution: 2 })] }, 20_000)
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(500, 10_000)
    window.observe(600, 20_000)
    expect(restarted.etaSec).toBeCloseTo(900 / (window.rate ?? 1), 6)
    const dropped = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 50, execution: 2 })] }, 30_000)
    window.observe(600, 30_000)
    expect(dropped.etaSec).toBeCloseTo(950 / (window.rate ?? 1), 6)
  })

  it('restarts a requeued job from zero', () =>
  {
    const run = createRunProgress({ startedAt: 0, etaDelayMs: 0 })
    run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 0 })] }, 0)
    run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 400 })] }, 10_000)
    run.update({ status: 'running', jobs: [runJob('a', 'queued', { work: 1000 })] }, 10_000)
    const progress = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 200 })] }, 20_000)
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(400, 10_000)
    window.observe(600, 20_000)
    expect(progress.etaSec).toBeCloseTo(800 / (window.rate ?? 1), 6)
  })

  it('counts the last stretch of a done job once and nothing for a failed one', () =>
  {
    const run = createRunProgress({ startedAt: 0, etaDelayMs: 0 })
    const jobs = (a: RunJobInput, b: RunJobInput) => [a, b, runJob('c', 'queued', { work: 10_000 })]
    run.update({ status: 'running', jobs: jobs(runJob('a', 'encoding', { workDone: 0 }), runJob('b', 'encoding', { workDone: 0 })) }, 0)
    run.update({ status: 'running', jobs: jobs(runJob('a', 'encoding', { workDone: 90 }), runJob('b', 'encoding', { workDone: 90 })) }, 10_000)
    const first = run.update({ status: 'running', jobs: jobs(runJob('a', 'done'), runJob('b', 'failed')) }, 20_000)
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(180, 10_000)
    window.observe(190, 20_000)
    expect(first.etaSec).toBeCloseTo(10_000 / (window.rate ?? 1), 6)
    const second = run.update({ status: 'running', jobs: jobs(runJob('a', 'done', { work: 5000 }), runJob('b', 'failed')) }, 30_000)
    window.observe(190, 30_000)
    expect(second.etaSec).toBeCloseTo(10_000 / (window.rate ?? 1), 6)
  })

  it('takes the first update as the baseline and counts a job that appears later from zero', () =>
  {
    const run = createRunProgress({ startedAt: 0, etaDelayMs: 0 })
    const first = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 500, mediaSecDone: 250 })] }, 10_000)
    expect(first).toMatchObject({ etaSec: null, mediaSecPerSec: 0 })
    run.update({ status: 'running', jobs: [] }, 20_000)
    const later = run.update({ status: 'running', jobs: [runJob('a', 'encoding', { work: 1000, workDone: 300, mediaSecDone: 150 })] }, 30_000)
    const window = createThroughputWindow()
    window.observe(0, 0)
    window.observe(0, 10_000)
    window.observe(0, 20_000)
    window.observe(300, 30_000)
    expect(later.etaSec).toBeCloseTo(700 / (window.rate ?? 1), 6)
    expect(later.mediaSecPerSec).toBeCloseTo((window.rate ?? 0) / 2, 6)
  })
})

