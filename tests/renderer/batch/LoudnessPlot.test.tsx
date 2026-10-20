import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { BatchSummary, JobView, RecipeOutcome, ResultStamp } from '../../../src/shared/jobs/types'
import
{
  AXIS_HALF_SPAN_LU,
  LEGEND_WORDS,
  LoudnessPlot,
  NO_LOUDNESS,
  NOT_MEASURED,
  TABLE_COLUMNS,
  axisPosition,
  buildStrips,
  checkLabel,
  deviationCell,
  loudnessCell,
  loudnessPoints,
  plotSummary,
  stripLabel,
  targetLabel,
  tickText,
  type LoudnessPoint
} from '../../../src/renderer/src/components/batch/inspector/LoudnessPlot'

const RUN = 'R-0031' as RunId

afterEach(() =>
{
  cleanup()
})

type Loudness = NonNullable<ResultStamp['loudness']>

function stampWith(loudness: Partial<Loudness> | null): ResultStamp
{
  return {
    verdict: 'verified',
    outputName: 'out.m4a',
    container: 'mp4',
    inputBytes: 1000,
    outputBytes: 800,
    durationSec: 60,
    decode: 'full',
    audioStreams: 1,
    verdictStream: 0,
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
    truePeak: null,
    size: null,
    frames: null,
    cues: null,
    placement: 'written',
    warnings: 0
  } as unknown as ResultStamp
}

function job(id: string, recipeLabel: string, loudness: Partial<Loudness> | null, runId: RunId | null = RUN): JobView
{
  return {
    id: id as JobId,
    recipeLabel,
    runId,
    source: { name: `${id}.wav` },
    stamp: loudness === undefined ? null : stampWith(loudness)
  } as unknown as JobView
}

function outcome(label: string, targetLufs: number | null, presetId: string | null): RecipeOutcome
{
  return {
    op: 'normalize',
    label,
    presetId,
    userPresetId: null,
    jobs: 1,
    verified: 1,
    reachable: 0,
    outsideTolerance: 0,
    returned: 0,
    loudness: {
      unit: 'LKFS',
      targetLufs,
      deviationUnit: 'dB',
      checks: [],
      minLufs: null,
      maxLufs: null,
      streams: 1,
      maxTruePeakDbtp: null,
      limitedJobs: 0,
      maxLimitingDb: null,
      reachableLevels: []
    },
    size: null
  } as RecipeOutcome
}

function summary(recipes: RecipeOutcome[]): BatchSummary
{
  return { runId: RUN, recipes } as unknown as BatchSummary
}

function point(overrides: Partial<LoudnessPoint>): LoudnessPoint
{
  return {
    jobId: 'MM-0001' as JobId,
    file: 'a.wav',
    recipe: 'Apple Podcasts',
    presetId: 'apple-podcasts',
    unit: 'LKFS',
    targetLufs: -16,
    checkClass: 'lossy',
    check: 1,
    deviationUnit: 'LU',
    sourceLufs: -21.4,
    verifiedLufs: -16.1,
    deviation: -0.1,
    ...overrides
  }
}

describe('axisPosition', () =>
{
  it('centers the axis on the target and spans 10 LU each way', () =>
  {
    expect(AXIS_HALF_SPAN_LU).toBe(10)
    expect(axisPosition(-16, -16)).toEqual({ fraction: 0.5, beyond: null })
    expect(axisPosition(-26, -16)).toEqual({ fraction: 0, beyond: null })
    expect(axisPosition(-6, -16)).toEqual({ fraction: 1, beyond: null })
    expect(axisPosition(-21, -16).fraction).toBeCloseTo(0.25)
    expect(axisPosition(-23, -23)).toEqual({ fraction: 0.5, beyond: null })
  })

  it('pins values past either end to that end and says which', () =>
  {
    expect(axisPosition(-30, -16)).toEqual({ fraction: 0, beyond: 'below' })
    expect(axisPosition(-2, -16)).toEqual({ fraction: 1, beyond: 'above' })
  })
})

describe('labels', () =>
{
  it('writes ticks with the minus sign', () =>
  {
    expect(tickText(-26)).toBe('−26')
    expect(tickText(-16.5)).toBe('−16.5')
    expect(tickText(4)).toBe('4')
    expect(tickText(0)).toBe('0')
  })

  it('names a strip by recipe, target, and output class', () =>
  {
    const [strip] = buildStrips([point({ deviationUnit: 'dB' })])
    expect(stripLabel(strip)).toBe('Apple Podcasts, −16 LKFS, lossy outputs')
    expect(targetLabel(strip)).toBe('Target −16 LKFS')
  })

  it('labels the check from the jobs own tolerance in its unit', () =>
  {
    expect(checkLabel(1, 'LU')).toBe('Check ±1.0 LU')
    expect(checkLabel(0.5, 'dB')).toBe('Check ±0.5 dB')
  })

  it('words cells that were never measured', () =>
  {
    expect(loudnessCell(null, 'LUFS')).toBe(NOT_MEASURED)
    expect(loudnessCell(-23, 'LUFS')).toBe('−23.0 LUFS')
    expect(deviationCell(point({ deviation: null }))).toBe(NOT_MEASURED)
    expect(deviationCell(point({ deviation: 0.4 }))).toBe('+0.4 LU')
  })

  it('summarizes the plot for assistive technology', () =>
  {
    expect(plotSummary(buildStrips([point({})]))).toBe('Loudness strip plot, 1 strip. The table below lists every value.')
  })
})

describe('loudnessPoints', () =>
{
  it('reads every measured job of the run in the summary recipe order', () =>
  {
    const jobs = [
      job('MM-0003', 'Spotify', { lufs: -14.2, unit: 'LUFS', referenceLufs: -14, deviation: -0.2, deviationUnit: 'LU' }),
      job('MM-0001', 'Apple Podcasts', { lufs: -16.1, deviation: -0.1 }),
      job('MM-0002', 'Apple Podcasts', null),
      job('MM-0004', 'Apple Podcasts', { lufs: -16 }, 'R-0030' as RunId),
      job('MM-0005', 'Apple Podcasts', { lufs: -15.9, checkClass: 'lossless', check: 0.5 })
    ]
    const sources = new Map([['MM-0001' as JobId, -21.4]])
    const points = loudnessPoints(jobs, summary([outcome('Apple Podcasts', -16, 'apple-podcasts'), outcome('Spotify', -14, 'spotify')]), sources)
    expect(points.map((p) => p.jobId)).toEqual(['MM-0001', 'MM-0005', 'MM-0003'])
    expect(points[0]).toMatchObject({
      file: 'MM-0001.wav',
      presetId: 'apple-podcasts',
      targetLufs: -16,
      sourceLufs: -21.4,
      verifiedLufs: -16.1,
      deviation: -0.1,
      checkClass: 'lossy',
      check: 1
    })
    expect(points[1]).toMatchObject({ sourceLufs: null, checkClass: 'lossless', check: 0.5 })
    expect(points[2]).toMatchObject({ unit: 'LUFS', targetLufs: -14, deviationUnit: 'LU' })
  })

  it('falls back to the stamp target and drops jobs with no target', () =>
  {
    const jobs = [
      job('MM-0010', 'Custom', { lufs: -18.2, unit: 'LUFS', referenceLufs: -18 }),
      job('MM-0011', 'Custom', { lufs: -19.5, unit: 'LUFS', reference: 'reachable', referenceLufs: -19.4 }),
      job('MM-0012', 'Unlisted', { lufs: -20, unit: 'LUFS', referenceLufs: -20 })
    ]
    const points = loudnessPoints(jobs, summary([outcome('Custom', null, null)]))
    expect(points.map((p) => [p.jobId, p.targetLufs, p.presetId])).toEqual([
      ['MM-0010', -18, null],
      ['MM-0012', -20, null]
    ])
  })
})

describe('buildStrips', () =>
{
  it('makes one strip per recipe and output class, lossless first', () =>
  {
    const strips = buildStrips([
      point({ jobId: 'MM-0001' as JobId }),
      point({ jobId: 'MM-0002' as JobId, recipe: 'EBU R 128', presetId: 'ebu-r128', unit: 'LUFS', targetLufs: -23, check: 0.2 }),
      point({ jobId: 'MM-0003' as JobId, checkClass: 'lossless', check: 0.5 }),
      point({ jobId: 'MM-0004' as JobId })
    ])
    expect(strips.map((s) => [s.recipe, s.checkClass, s.targetLufs, s.check])).toEqual([
      ['Apple Podcasts', 'lossless', -16, 0.5],
      ['Apple Podcasts', 'lossy', -16, 1],
      ['EBU R 128', 'lossy', -23, 0.2]
    ])
    expect(strips[1].points.map((p) => p.jobId)).toEqual(['MM-0001', 'MM-0004'])
  })

  it('keeps different targets of one recipe on separate axes', () =>
  {
    const strips = buildStrips([point({ targetLufs: -16 }), point({ targetLufs: -18 })])
    expect(strips).toHaveLength(2)
  })
})

describe('LoudnessPlot', () =>
{
  const points = [
    point({ jobId: 'MM-0001' as JobId, sourceLufs: -21.4, verifiedLufs: -16.1 }),
    point({ jobId: 'MM-0002' as JobId, sourceLufs: -31.2, verifiedLufs: -15.8 }),
    point({ jobId: 'MM-0003' as JobId, sourceLufs: null, verifiedLufs: -3.5, deviation: 12.5 }),
    point({ jobId: 'MM-0004' as JobId, recipe: 'EBU R 128', presetId: 'ebu-r128', unit: 'LUFS', targetLufs: -23, check: 0.2, sourceLufs: -19, verifiedLufs: -23 })
  ]

  it('draws one strip per recipe and output class with its axis, target line, and check band', () =>
  {
    const { container } = render(<LoudnessPlot points={points} />)
    const strips = container.querySelectorAll('[data-strip]')
    expect(strips).toHaveLength(2)
    expect(screen.getByText('Apple Podcasts, −16 LKFS, lossy outputs')).toBeInTheDocument()
    expect(screen.getByText('EBU R 128, −23.0 LUFS, lossy outputs')).toBeInTheDocument()

    const first = strips[0].querySelector('svg') as SVGSVGElement
    expect(first.getAttribute('data-axis-low')).toBe('-26')
    expect(first.getAttribute('data-axis-high')).toBe('-6')
    const ticks = [...first.querySelectorAll('[data-part="tick"]')].map((t) => t.textContent)
    expect(ticks).toEqual(['−26', '−6'])
    const target = first.querySelector('[data-part="target-line"]') as SVGLineElement
    expect(target.getAttribute('x1')).toBe('50%')
    expect(target.getAttribute('stroke-dasharray')).toBe('3 3')
    expect(target.getAttribute('class')).toContain('stroke-viz-ref')
    expect(first.querySelector('[data-part="target-label"]')?.textContent).toBe('Target −16 LKFS')
    const band = first.querySelector('[data-part="check-band"]') as SVGRectElement
    expect(band.getAttribute('x')).toBe('45%')
    expect(band.getAttribute('width')).toBe('10%')
    expect(band.getAttribute('class')).toContain('fill-viz-band')
    const edges = [...first.querySelectorAll('[data-part="check-edge"]')]
    expect(edges.map((e) => e.getAttribute('x1'))).toEqual(['45%', '55%'])
    expect(edges.every((e) => e.getAttribute('class')?.includes('stroke-viz-limit'))).toBe(true)
    expect(first.querySelector('[data-part="check-label"]')?.textContent).toBe('Check ±1.0 LU')

    const second = strips[1].querySelector('svg') as SVGSVGElement
    expect(second.querySelector('[data-part="check-label"]')?.textContent).toBe('Check ±0.2 LU')
    expect(second.querySelector('[data-part="target-label"]')?.textContent).toBe('Target −23.0 LUFS')
  })

  it('marks source loudness hollow and verified loudness filled', () =>
  {
    const { container } = render(<LoudnessPlot points={points} />)
    const sources = [...container.querySelectorAll('circle[data-series="source"]')]
    const verified = [...container.querySelectorAll('circle[data-series="verified"]')]
    expect(sources).toHaveLength(2)
    expect(verified).toHaveLength(3)
    expect(sources.every((c) => c.getAttribute('data-fill') === 'hollow' && c.getAttribute('class')?.includes('fill-none') && c.getAttribute('class')?.includes('stroke-viz-2'))).toBe(true)
    expect(verified.every((c) => c.getAttribute('data-fill') === 'filled' && c.getAttribute('class')?.includes('fill-viz-1'))).toBe(true)
    expect(sources[0].getAttribute('cx')).toBe('23%')
  })

  it('draws marks past the axis as outward triangles at the edge', () =>
  {
    const { container } = render(<LoudnessPlot points={points} />)
    const below = container.querySelector('svg[data-beyond="below"]') as SVGSVGElement
    const above = container.querySelector('svg[data-beyond="above"]') as SVGSVGElement
    expect(below.getAttribute('data-series')).toBe('source')
    expect(below.getAttribute('x')).toBe('0%')
    expect(below.querySelector('path')?.getAttribute('d')).toBe('M0 0 L7 -5 L7 5 Z')
    expect(below.querySelector('path')?.getAttribute('class')).toContain('fill-none')
    expect(above.getAttribute('data-series')).toBe('verified')
    expect(above.getAttribute('x')).toBe('100%')
    expect(above.querySelector('path')?.getAttribute('d')).toBe('M0 0 L-7 -5 L-7 5 Z')
    expect(above.querySelector('path')?.getAttribute('class')).toContain('fill-viz-1')
    expect(screen.getByText(LEGEND_WORDS.beyond)).toBeInTheDocument()
  })

  it('names both series in a legend above the strips', () =>
  {
    render(<LoudnessPlot points={points.slice(0, 1)} />)
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(within(legend).getByText('Source loudness')).toBeInTheDocument()
    expect(within(legend).getByText('Verified loudness')).toBeInTheDocument()
    expect(within(legend).queryByText(LEGEND_WORDS.beyond)).toBeNull()
    const plot = screen.getByRole('img', { name: 'Loudness strip plot, 1 strip. The table below lists every value.' })
    expect(legend.compareDocumentPosition(plot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(plot.className).toContain('bg-sunken')
  })

  it('lists every value in the data table', () =>
  {
    const onSelectJob = vi.fn()
    render(<LoudnessPlot points={points} onSelectJob={onSelectJob} />)
    const table = screen.getByRole('table', { name: 'Loudness by job' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([...TABLE_COLUMNS])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    const visibleText = (cell: Element): string =>
    {
      const copy = cell.cloneNode(true) as Element
      copy.querySelectorAll('[role="tooltip"]').forEach((tip) => tip.remove())
      return copy.textContent ?? ''
    }
    const cells = (index: number): string[] => [...rows[index].querySelectorAll('th, td')].map(visibleText)
    expect(cells(0)).toEqual(['MM-0001', 'Apple Podcasts', '−16 LKFS', '±1.0 LU lossy', '−21.4 LKFS', '−16.1 LKFS', '−0.1 LU'])
    expect(cells(2)).toEqual(['MM-0003', 'Apple Podcasts', '−16 LKFS', '±1.0 LU lossy', NOT_MEASURED, '−3.5 LKFS', '+12.5 LU'])
    expect(within(rows[0]).getByRole('button', { name: 'MM-0001' })).toHaveAccessibleDescription(points[0].file)
    fireEvent.click(within(rows[3]).getByRole('button', { name: 'MM-0004' }))
    expect(onSelectJob).toHaveBeenCalledWith('MM-0004')
  })

  it('shows job numbers as text when nothing can focus a row', () =>
  {
    render(<LoudnessPlot points={points.slice(0, 1)} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('MM-0001')).toBeInTheDocument()
  })

  it('says so when nothing was measured', () =>
  {
    render(<LoudnessPlot points={[]} />)
    expect(screen.getByText(NO_LOUDNESS)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
