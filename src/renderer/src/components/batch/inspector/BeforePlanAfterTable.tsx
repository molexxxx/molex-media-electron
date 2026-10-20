import React, { useId } from 'react'
import { formatLoudness, formatLoudnessRange, formatSamplePeak, formatTruePeak } from '../../../copy/batch'
import type { StreamMeasurement } from '../../../../../shared/audio/events'
import type { GainPlan, LoudnessUnit, StreamVerdict, VerifiedStream } from '../../../../../shared/audio/types'
import type { JobMeasurement, JobView, Verification } from '../../../../../shared/jobs/types'
import { CapsText, cx } from '../../../ui'

/** The words of the before, plan, and after table. */
export const TABLE_WORDS =
{
  caption: 'Before, planned, and after',
  measure: 'Measure',
  before: 'Before',
  plan: 'Planned',
  after: 'After',
  integrated: 'Integrated loudness',
  range: 'Loudness range',
  truePeakPre: 'True peak before encoding',
  truePeakPreNote: 'The value the preset’s maximum is judged on',
  truePeakDecoded: 'True peak after decoding',
  truePeakDecodedNote: 'This app’s codec-overshoot check',
  samplePeak: 'Sample peak',
  notMeasured: 'Not measured',
  notYet: 'After Verify',
  none: 'Not planned',
  shortFile: 'not applicable under 1 minute',
  reachable: 'reachable',
  limit: 'limit'
} as const

/** The meter line under the table, by the true-peak reference Verify used. */
export const METER_NOTES =
{
  'soxr-8x': 'Loudness per ITU-R BS.1770; true peak with the 8x reference resampled by libsoxr.',
  'swr-8x': 'True peak measured with the swresample 8x reference because this FFmpeg has no libsoxr. That reference can read up to 0.17 dB low on clipped audio, so true peak is held 0.2 dB under each limit.'
} as const

/** One cell: its text, whether it failed its check, and whether it stands in for a value nobody measured or planned. */
export interface TableCell
{
  text: string
  failing: boolean
  quiet: boolean
}

/** One row of the table. */
export interface TableRow
{
  key: 'integrated' | 'range' | 'true-peak-pre' | 'true-peak-decoded' | 'sample-peak'
  label: string
  note: string | null
  before: TableCell
  plan: TableCell
  after: TableCell
}

/** One audio stream's table. */
export interface StreamTable
{
  audioIndex: number
  rows: TableRow[]
  meter: VerifiedStream['meter'] | null
}

/** The facts the table reads, per stream, joined by audio index. */
export interface StreamFacts
{
  audioIndex: number
  measured: StreamMeasurement | null
  plan: GainPlan | null
  verified: VerifiedStream | null
  verdict: StreamVerdict | null
}

function cell(text: string, failing = false): TableCell
{
  return { text, failing, quiet: false }
}

function quiet(text: string): TableCell
{
  return { text, failing: false, quiet: true }
}

/** Every audio stream the measurement or the verification knows, in audio order, with what each says about it. */
export function streamFacts(measurement: JobMeasurement | null, verification: Verification | null): StreamFacts[]
{
  const byIndex = new Map<number, StreamFacts>()
  const entry = (audioIndex: number): StreamFacts =>
  {
    const existing = byIndex.get(audioIndex)
    if (existing !== undefined)
    {
      return existing
    }
    const created: StreamFacts = { audioIndex, measured: null, plan: null, verified: null, verdict: null }
    byIndex.set(audioIndex, created)
    return created
  }
  for (const stream of measurement?.streams ?? [])
  {
    const facts = entry(stream.measurement.audioIndex)
    facts.measured = stream.measurement
    facts.plan = stream.plan
  }
  for (const stream of verification?.audio ?? [])
  {
    const facts = entry(stream.verdict.audioIndex)
    facts.verified = stream.verified
    facts.verdict = stream.verdict
  }
  return [...byIndex.values()].sort((a, b) => a.audioIndex - b.audioIndex)
}

function planLoudness(plan: GainPlan | null, unit: LoudnessUnit): TableCell
{
  if (plan === null || plan.targetLufs === null)
  {
    return quiet(TABLE_WORDS.none)
  }
  const predicted = plan.predictedLufs
  if (predicted !== null && plan.targetLufs - predicted > 0.05)
  {
    return cell(`${formatLoudness(predicted, unit)}, ${TABLE_WORDS.reachable}`)
  }
  return cell(formatLoudness(plan.targetLufs, unit))
}

function afterValue(verified: boolean, value: number | null, format: (n: number) => string, failing: boolean): TableCell
{
  if (value !== null)
  {
    return cell(format(value), failing)
  }
  return quiet(verified ? TABLE_WORDS.notMeasured : TABLE_WORDS.notYet)
}

function measuredValue(value: number | null | undefined, format: (n: number) => string): TableCell
{
  return value === null || value === undefined ? quiet(TABLE_WORDS.notMeasured) : cell(format(value))
}

/**
 * One stream's rows: integrated loudness, loudness range, true peak before encoding, true peak after decoding, and
 * sample peak. Both true peaks always have their own row, so the value the preset is judged on is never confused
 * with the decoded output's. Every After value is what Verify measured; nothing planned stands in for it.
 */
export function tableRows(facts: StreamFacts, unit: LoudnessUnit): TableRow[]
{
  const { measured, plan, verified, verdict } = facts
  const stats = measured?.stats ?? null
  const verifiedRan = verified !== null
  const shortFile = stats?.lraStatus === 'not-applicable'
  const beforeRange = shortFile ? quiet(TABLE_WORDS.shortFile) : measuredValue(stats?.loudnessRangeLu, formatLoudnessRange)
  const afterRange = verifiedRan && verified.loudnessRangeLu === null && shortFile
    ? quiet(TABLE_WORDS.shortFile)
    : afterValue(verifiedRan, verified?.loudnessRangeLu ?? null, formatLoudnessRange, false)
  const loudnessFailing = verdict !== null && (verdict.loudness.status === 'above' || verdict.loudness.status === 'below')
  return [
    {
      key: 'integrated',
      label: TABLE_WORDS.integrated,
      note: null,
      before: measuredValue(stats?.integratedLufs, (n) => formatLoudness(n, unit)),
      plan: planLoudness(plan, unit),
      after: afterValue(verifiedRan, verified?.integratedLufs ?? null, (n) => formatLoudness(n, unit), loudnessFailing)
    },
    {
      key: 'range',
      label: TABLE_WORDS.range,
      note: null,
      before: beforeRange,
      plan: quiet(TABLE_WORDS.none),
      after: afterRange
    },
    {
      key: 'true-peak-pre',
      label: TABLE_WORDS.truePeakPre,
      note: TABLE_WORDS.truePeakPreNote,
      before: measuredValue(stats?.truePeakDbtp, formatTruePeak),
      plan: plan === null ? quiet(TABLE_WORDS.none) : cell(`${TABLE_WORDS.limit} ${formatTruePeak(plan.ceiling.gateDbtp)}`),
      after: afterValue(verifiedRan, verified?.preEncodeTruePeakDbtp ?? null, formatTruePeak, verdict?.truePeak.status === 'over')
    },
    {
      key: 'true-peak-decoded',
      label: TABLE_WORDS.truePeakDecoded,
      note: TABLE_WORDS.truePeakDecodedNote,
      before: quiet(TABLE_WORDS.notMeasured),
      plan: plan === null ? quiet(TABLE_WORDS.none) : cell(`${TABLE_WORDS.limit} ${formatTruePeak(plan.ceiling.decodedLimitDbtp)}`),
      after: afterValue(verifiedRan, verified?.truePeakDbtp ?? null, formatTruePeak, verdict?.decoded.status === 'over')
    },
    {
      key: 'sample-peak',
      label: TABLE_WORDS.samplePeak,
      note: null,
      before: quiet(TABLE_WORDS.notMeasured),
      plan: quiet(TABLE_WORDS.none),
      after: afterValue(verifiedRan, verified?.samplePeakDbfs ?? null, formatSamplePeak, verdict?.samplePeakOver === true)
    }
  ]
}

/** The tables of a job: one per audio stream the measurement or the verification knows. */
export function streamTables(measurement: JobMeasurement | null, verification: Verification | null, unit: LoudnessUnit): StreamTable[]
{
  return streamFacts(measurement, verification).map((facts) => ({
    audioIndex: facts.audioIndex,
    rows: tableRows(facts, unit),
    meter: facts.verified?.meter ?? null
  }))
}

/** The loudness unit a job's values read in: the stamp's, else the plan's, else LUFS. */
export function jobUnit(job: Pick<JobView, 'stamp' | 'audioPlan'>): LoudnessUnit
{
  return job.stamp?.loudness?.unit ?? job.audioPlan?.[0]?.unit ?? 'LUFS'
}

/** Props for {@link BeforePlanAfterTable}. */
export interface BeforePlanAfterTableProps
{
  measurement: JobMeasurement | null
  verification: Verification | null
  unit: LoudnessUnit
  className?: string
}

function Cell({ value }: { value: TableCell }): React.JSX.Element
{
  return (
    <td
      data-failing={value.failing ? '' : undefined}
      data-quiet={value.quiet ? '' : undefined}
      className={cx(
        'py-1 pl-3 text-right tabular-nums',
        value.quiet ? 'text-label text-ink-3' : 'tabular-nums whitespace-nowrap',
        value.failing ? 'text-error' : !value.quiet && 'text-ink'
      )}
    >
      {value.text}
    </td>
  )
}

function StreamTableView({ table, caption }: { table: StreamTable; caption: string }): React.JSX.Element
{
  const captionId = `${useId()}-caption`
  return (
    <div role='region' aria-labelledby={captionId} tabIndex={0} className='overflow-x-auto select-text'>
      <table className='w-full border-collapse text-label'>
        <caption id={captionId} className='pb-1 text-left type-legend text-brass'>
          <CapsText>{caption}</CapsText>
        </caption>
        <thead>
          <tr className='border-b border-line text-ink-3'>
            <th scope='col' className='py-1 text-left font-normal'>{TABLE_WORDS.measure}</th>
            <th scope='col' className='py-1 pl-3 text-right font-normal'>{TABLE_WORDS.before}</th>
            <th scope='col' className='py-1 pl-3 text-right font-normal'>{TABLE_WORDS.plan}</th>
            <th scope='col' className='py-1 pl-3 text-right font-normal'>{TABLE_WORDS.after}</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key} data-row={row.key} className='border-b border-line align-top last:border-b-0'>
              <th scope='row' className='py-1 text-left font-normal text-ink-2'>
                <span className='block'>{row.label}</span>
                {row.note !== null && <span className='block text-label text-ink-3'>{row.note}</span>}
              </th>
              <Cell value={row.before} />
              <Cell value={row.plan} />
              <Cell value={row.after} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The before, plan, and after values of every audio stream, with a line naming the meter Verify used. */
export function BeforePlanAfterTable({ measurement, verification, unit, className }: BeforePlanAfterTableProps): React.JSX.Element | null
{
  const tables = streamTables(measurement, verification, unit)
  if (tables.length === 0)
  {
    return null
  }
  const meters = [...new Set(tables.map((table) => table.meter).filter((meter) => meter !== null))]
  return (
    <div className={cx('flex flex-col gap-3', className)} data-part='before-plan-after'>
      {tables.map((table) => (
        <StreamTableView
          key={table.audioIndex}
          table={table}
          caption={tables.length === 1 ? TABLE_WORDS.caption : `${TABLE_WORDS.caption}, audio ${table.audioIndex + 1}`}
        />
      ))}
      {meters.map((meter) => (
        <p key={meter} className='text-label text-ink-3 select-text'>{METER_NOTES[meter]}</p>
      ))}
    </div>
  )
}
