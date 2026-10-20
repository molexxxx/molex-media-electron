import { useId, type ReactElement } from 'react'
import type { LoudnessUnit } from '../../../../../shared/audio/types'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { BatchSummary, JobView } from '../../../../../shared/jobs/types'
import { MINUS_SIGN, countOf, formatDeviation, formatLoudness, formatTarget, formatTolerance } from '../../../copy/batch'
import { cx } from '../../../ui/cx'
import { Tooltip } from '../../../ui/Tooltip'

/** How far each strip's axis reaches on either side of its target, in LU. */
export const AXIS_HALF_SPAN_LU = 10

/** The words a cell shows when a value was never measured. */
export const NOT_MEASURED = 'Not measured'

/** One finished job's loudness as the strip plot and its data table read it. */
export interface LoudnessPoint
{
  jobId: JobId
  file: string
  recipe: string
  presetId: string | null
  unit: LoudnessUnit
  targetLufs: number
  checkClass: 'lossless' | 'lossy'
  /** The job's own check, in deviationUnit. */
  check: number
  deviationUnit: 'LU' | 'dB'
  sourceLufs: number | null
  verifiedLufs: number | null
  deviation: number | null
}

/** One strip: the jobs of one recipe and output class that share a target and a check. */
export interface LoudnessStrip
{
  key: string
  recipe: string
  presetId: string | null
  unit: LoudnessUnit
  targetLufs: number
  checkClass: 'lossless' | 'lossy'
  check: number
  deviationUnit: 'LU' | 'dB'
  points: LoudnessPoint[]
}

/** Where a value sits on a strip's axis: a fraction from 0 (target minus 10 LU) to 1, and which edge it passed. */
export interface AxisPosition
{
  fraction: number
  beyond: 'below' | 'above' | null
}

/** Places a value on the axis centered on target; values past either end sit at that end. */
export function axisPosition(value: number, targetLufs: number): AxisPosition
{
  const low = targetLufs - AXIS_HALF_SPAN_LU
  const high = targetLufs + AXIS_HALF_SPAN_LU
  if (value < low)
  {
    return { fraction: 0, beyond: 'below' }
  }
  if (value > high)
  {
    return { fraction: 1, beyond: 'above' }
  }
  return { fraction: (value - low) / (high - low), beyond: null }
}

/**
 * The loudness points of a finished batch: every job of the run with a measured stamp, in the summary's recipe
 * order. The target comes from the recipe's outcome, or from the stamp when it was judged against the target.
 * Source loudness is not part of a row, so it is read from `sources` when the page has it.
 */
export function loudnessPoints(
  jobs: readonly JobView[],
  summary: BatchSummary,
  sources: ReadonlyMap<JobId, number> = new Map()
): LoudnessPoint[]
{
  const outcomes = new Map(summary.recipes.map((recipe, index) => [recipe.label, { recipe, index }]))
  const points: Array<{ point: LoudnessPoint; order: number }> = []
  for (const job of jobs)
  {
    const loudness = job.stamp?.loudness ?? null
    if (job.runId !== summary.runId || loudness === null)
    {
      continue
    }
    const outcome = outcomes.get(job.recipeLabel) ?? null
    const stated = loudness.reference === 'target' ? loudness.referenceLufs : null
    const target = outcome?.recipe.loudness?.targetLufs ?? stated
    if (target === null)
    {
      continue
    }
    points.push({
      order: outcome === null ? summary.recipes.length : outcome.index,
      point: {
        jobId: job.id,
        file: job.source.name,
        recipe: job.recipeLabel,
        presetId: outcome?.recipe.presetId ?? null,
        unit: loudness.unit,
        targetLufs: target,
        checkClass: loudness.checkClass,
        check: loudness.check,
        deviationUnit: loudness.deviationUnit,
        sourceLufs: sources.get(job.id) ?? null,
        verifiedLufs: loudness.lufs,
        deviation: loudness.deviation
      }
    })
  }
  return points
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.point)
}

/** Groups points into strips by recipe, output class, target, and check, lossless before lossy within a recipe. */
export function buildStrips(points: readonly LoudnessPoint[]): LoudnessStrip[]
{
  const strips = new Map<string, LoudnessStrip>()
  const recipes: string[] = []
  for (const point of points)
  {
    const key = [point.recipe, point.checkClass, point.targetLufs, point.check, point.deviationUnit].join('|')
    let strip = strips.get(key)
    if (strip === undefined)
    {
      strip = {
        key,
        recipe: point.recipe,
        presetId: point.presetId,
        unit: point.unit,
        targetLufs: point.targetLufs,
        checkClass: point.checkClass,
        check: point.check,
        deviationUnit: point.deviationUnit,
        points: []
      }
      strips.set(key, strip)
      if (!recipes.includes(point.recipe))
      {
        recipes.push(point.recipe)
      }
    }
    strip.points.push(point)
  }
  return [...strips.values()]
    .map((strip, index) => ({ strip, index }))
    .sort((a, b) =>
      recipes.indexOf(a.strip.recipe) - recipes.indexOf(b.strip.recipe)
      || classRank(a.strip.checkClass) - classRank(b.strip.checkClass)
      || a.index - b.index)
    .map((entry) => entry.strip)
}

function classRank(checkClass: 'lossless' | 'lossy'): number
{
  return checkClass === 'lossless' ? 0 : 1
}

/** A target as a strip and the table state it: "−16 LKFS". */
export function targetText(strip: Pick<LoudnessStrip, 'targetLufs' | 'unit' | 'presetId'>): string
{
  return formatTarget(strip.targetLufs, strip.unit, strip.presetId)
}

/** A strip's name: "Apple Podcasts, −16 LKFS, lossy outputs". */
export function stripLabel(strip: LoudnessStrip): string
{
  return `${strip.recipe}, ${targetText(strip)}, ${strip.checkClass} outputs`
}

/** The target line's direct label: "Target −16 LKFS". */
export function targetLabel(strip: LoudnessStrip): string
{
  return `Target ${targetText(strip)}`
}

/** The check band's direct label, in the preset's unit: "Check ±1.0 LU". */
export function checkLabel(check: number, unit: 'LU' | 'dB'): string
{
  return `Check ${formatTolerance(check, unit)}`
}

/** An axis tick: "−26", "−16.5". */
export function tickText(value: number): string
{
  const tenths = Math.round(value * 10) / 10
  const digits = Number.isInteger(tenths) ? Math.abs(tenths).toFixed(0) : Math.abs(tenths).toFixed(1)
  return tenths < 0 ? `${MINUS_SIGN}${digits}` : digits
}

/** A loudness cell of the data table, or "Not measured". */
export function loudnessCell(value: number | null, unit: LoudnessUnit): string
{
  return value === null ? NOT_MEASURED : formatLoudness(value, unit)
}

/** The deviation cell of the data table, or "Not measured". */
export function deviationCell(point: LoudnessPoint): string
{
  return point.deviation === null ? NOT_MEASURED : formatDeviation(point.deviation, point.deviationUnit)
}

/** The legend's words, above the strips. */
export const LEGEND_WORDS = {
  source: 'Source loudness',
  verified: 'Verified loudness',
  beyond: `Beyond ${formatTolerance(AXIS_HALF_SPAN_LU, 'LU')} of the target`
} as const

/** The data table's column headings. */
export const TABLE_COLUMNS = ['Job', 'Operation', 'Target', 'Check', 'Source', 'Verified', 'Deviation'] as const

/** The data table's caption. */
export const TABLE_CAPTION = 'Loudness by job'

/** The words shown when a finished batch measured no loudness. */
export const NO_LOUDNESS = 'No loudness was measured in this batch.'

/** The plot's accessible name; the table states every value. */
export function plotSummary(strips: readonly LoudnessStrip[]): string
{
  return `Loudness strip plot, ${countOf(strips.length, 'strip')}. The table below lists every value.`
}

const STRIP_HEIGHT = 72
const PLOT_TOP = 16
const PLOT_BOTTOM = 50
const SOURCE_LANE = 25
const VERIFIED_LANE = 41
const LABEL_BASELINE = 11
const TICK_BASELINE = 66
const MARK_RADIUS = 4
const SOURCE_PAINT = 'fill-none stroke-viz-2'
const VERIFIED_PAINT = 'fill-viz-1 stroke-viz-1'

function percent(fraction: number): string
{
  return `${Math.round(fraction * 10000) / 100}%`
}

function jitter(index: number): number
{
  return ((index % 3) - 1) * 3
}

interface MarkProps
{
  series: 'source' | 'verified'
  point: LoudnessPoint
  value: number
  index: number
}

function Mark({ series, point, value, index }: MarkProps): ReactElement
{
  const position = axisPosition(value, point.targetLufs)
  const hollow = series === 'source'
  const y = (hollow ? SOURCE_LANE : VERIFIED_LANE) + jitter(index)
  const paint = hollow ? SOURCE_PAINT : VERIFIED_PAINT
  const title = `${point.jobId}, ${series} ${formatLoudness(value, point.unit)}`
  if (position.beyond !== null)
  {
    const outward = position.beyond === 'below' ? 'M0 0 L7 -5 L7 5 Z' : 'M0 0 L-7 -5 L-7 5 Z'
    return (
      <svg
        x={position.beyond === 'below' ? '0%' : '100%'}
        y={y}
        overflow="visible"
        data-series={series}
        data-beyond={position.beyond}
        data-fill={hollow ? 'hollow' : 'filled'}
      >
        <title>{title}</title>
        <path d={outward} className={paint} strokeWidth={hollow ? 1.5 : 1} strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <circle
      cx={percent(position.fraction)}
      cy={y}
      r={MARK_RADIUS}
      className={paint}
      strokeWidth={hollow ? 2 : 0}
      data-series={series}
      data-fill={hollow ? 'hollow' : 'filled'}
    >
      <title>{title}</title>
    </circle>
  )
}

function Strip({ strip }: { strip: LoudnessStrip }): ReactElement
{
  const center = strip.targetLufs
  const low = axisPosition(center - strip.check, center).fraction
  const high = axisPosition(center + strip.check, center).fraction
  return (
    <div className="flex flex-col gap-1" data-strip={strip.key}>
      <p className="text-label text-ink-2">{stripLabel(strip)}</p>
      <div className="px-2">
        <svg
          width="100%"
          height={STRIP_HEIGHT}
          overflow="visible"
          aria-hidden="true"
          focusable="false"
          className="block overflow-visible"
          data-axis-low={center - AXIS_HALF_SPAN_LU}
          data-axis-high={center + AXIS_HALF_SPAN_LU}
        >
          {[0.25, 0.75].map((fraction) => (
            <line
              key={fraction}
              data-part="grid"
              x1={percent(fraction)}
              x2={percent(fraction)}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              className="stroke-viz-grid"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          <rect
            data-part="check-band"
            x={percent(low)}
            y={PLOT_TOP}
            width={percent(high - low)}
            height={PLOT_BOTTOM - PLOT_TOP}
            className="fill-viz-band"
          />
          {[low, high].map((fraction, edge) => (
            <line
              key={edge}
              data-part="check-edge"
              x1={percent(fraction)}
              x2={percent(fraction)}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              className="stroke-viz-limit"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          <line
            data-part="axis"
            x1="0%"
            x2="100%"
            y1={PLOT_BOTTOM}
            y2={PLOT_BOTTOM}
            className="stroke-viz-axis"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <line
            data-part="target-line"
            x1="50%"
            x2="50%"
            y1={PLOT_TOP - 2}
            y2={PLOT_BOTTOM}
            className="stroke-viz-ref"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            data-part="target-label"
            x="50%"
            y={LABEL_BASELINE}
            textAnchor="middle"
            className="fill-viz-ref text-label tabular-nums"
          >
            {targetLabel(strip)}
          </text>
          <text
            data-part="check-label"
            x="50%"
            y={TICK_BASELINE}
            textAnchor="middle"
            className="fill-ink-3 text-label"
          >
            {checkLabel(strip.check, strip.deviationUnit)}
          </text>
          <text data-part="tick" x="0%" y={TICK_BASELINE} textAnchor="start" className="fill-ink-3 text-label tabular-nums">
            {tickText(center - AXIS_HALF_SPAN_LU)}
          </text>
          <text data-part="tick" x="100%" y={TICK_BASELINE} textAnchor="end" className="fill-ink-3 text-label tabular-nums">
            {tickText(center + AXIS_HALF_SPAN_LU)}
          </text>
          {strip.points.map((point, index) => point.sourceLufs === null ? null : (
            <Mark key={`source-${point.jobId}`} series="source" point={point} value={point.sourceLufs} index={index} />
          ))}
          {strip.points.map((point, index) => point.verifiedLufs === null ? null : (
            <Mark key={`verified-${point.jobId}`} series="verified" point={point} value={point.verifiedLufs} index={index} />
          ))}
        </svg>
      </div>
    </div>
  )
}

function Legend({ beyond }: { beyond: boolean }): ReactElement
{
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-label text-ink-2">
      <li className="flex items-center gap-1.5" data-legend="source">
        <svg width="12" height="12" aria-hidden="true" focusable="false">
          <circle cx="6" cy="6" r="4" className={SOURCE_PAINT} strokeWidth={2} />
        </svg>
        {LEGEND_WORDS.source}
      </li>
      <li className="flex items-center gap-1.5" data-legend="verified">
        <svg width="12" height="12" aria-hidden="true" focusable="false">
          <circle cx="6" cy="6" r="4" className={VERIFIED_PAINT} strokeWidth={0} />
        </svg>
        {LEGEND_WORDS.verified}
      </li>
      {beyond && (
        <li className="flex items-center gap-1.5" data-legend="beyond">
          <svg width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M11 6 L4 1 L4 11 Z" className="fill-none stroke-ink-3" strokeWidth={1.5} strokeLinejoin="round" />
          </svg>
          {LEGEND_WORDS.beyond}
        </li>
      )}
    </ul>
  )
}

const HEAD_CELL = 'pb-1 pr-3 text-left align-bottom type-legend text-brass'
const BODY_CELL = 'border-t border-line py-1 pr-3 align-top'
const VALUE_CELL = `${BODY_CELL} whitespace-nowrap tabular-nums text-ink`

interface DataTableProps
{
  strips: readonly LoudnessStrip[]
  onSelectJob?: (id: JobId) => void
}

function DataTable({ strips, onSelectJob }: DataTableProps): ReactElement
{
  const captionId = useId()
  return (
    <div role="region" aria-labelledby={captionId} tabIndex={0} className="overflow-x-auto select-text">
      <table className="w-full border-collapse text-label">
        <caption id={captionId} className="pb-1 text-left type-legend text-brass">
          {TABLE_CAPTION}
        </caption>
        <thead>
          <tr>
            {TABLE_COLUMNS.map((column) => (
              <th key={column} scope="col" className={HEAD_CELL}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strips.flatMap((strip) => strip.points.map((point) => (
            <tr key={`${strip.key}-${point.jobId}`} data-job={point.jobId}>
              <th scope="row" className={cx(BODY_CELL, 'text-left font-normal')}>
                {onSelectJob === undefined
                  ? <span className="text-ink tabular-nums" title={point.file}>{point.jobId}</span>
                  : (
                    <Tooltip content={point.file}>
                      <button
                        type="button"
                        onClick={() => onSelectJob(point.jobId)}
                        className="rounded-xs text-ink tabular-nums underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                      >
                        {point.jobId}
                      </button>
                    </Tooltip>
                  )}
              </th>
              <td className={cx(BODY_CELL, 'text-ink-2')}>{point.recipe}</td>
              <td className={VALUE_CELL}>{targetText(point)}</td>
              <td className={VALUE_CELL}>{`${formatTolerance(point.check, point.deviationUnit)} ${point.checkClass}`}</td>
              <td className={VALUE_CELL}>{loudnessCell(point.sourceLufs, point.unit)}</td>
              <td className={VALUE_CELL}>{loudnessCell(point.verifiedLufs, point.unit)}</td>
              <td className={VALUE_CELL}>{deviationCell(point)}</td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  )
}

/** Props for {@link LoudnessPlot}. */
export interface LoudnessPlotProps
{
  points: readonly LoudnessPoint[]
  /** Focuses a job's row from the data table. */
  onSelectJob?: (id: JobId) => void
  className?: string
}

/**
 * The batch's loudness strip plot on a sunken well: one strip per recipe and output class, each on its own axis
 * centered on its target, with a labeled target line, the check band, hollow source and filled verified marks, and
 * outward edge triangles for values past the axis. The data table below is the accessible version.
 */
export function LoudnessPlot({ points, onSelectJob, className }: LoudnessPlotProps): ReactElement
{
  const strips = buildStrips(points)
  if (strips.length === 0)
  {
    return <p className={cx('text-body text-ink-3', className)}>{NO_LOUDNESS}</p>
  }
  const beyond = points.some((point) =>
    [point.sourceLufs, point.verifiedLufs].some((value) => value !== null && axisPosition(value, point.targetLufs).beyond !== null))
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <Legend beyond={beyond} />
      <div role="img" aria-label={plotSummary(strips)} className="flex flex-col gap-4 rounded-xs border border-line bg-sunken p-3">
        {strips.map((strip) => <Strip key={strip.key} strip={strip} />)}
      </div>
      <DataTable strips={strips} onSelectJob={onSelectJob} />
    </div>
  )
}
