/**
 * The inspector's Result tab: the output tail's last lines and copying, the attempts list, the error detail with its
 * exit code name and command, the before, plan, and after table with both true peaks, the decision buttons with
 * their inline confirmations and focus, and the tab's views by outcome.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import
{
  lastLines,
  OUTPUT_TAIL_LINES,
  OUTPUT_TAIL_WORDS,
  OutputTail
} from '../../../src/renderer/src/components/batch/inspector/OutputTail'
import
{
  ATTEMPTS_CAPTION,
  attemptLines,
  Attempts,
  attemptText,
  ERROR_SHORT
} from '../../../src/renderer/src/components/batch/inspector/Attempts'
import
{
  attemptExitText,
  COMMAND_LABEL,
  copyErrorText,
  ErrorDetail,
  exitText,
  failedCommand,
  failedStageText,
  failureOutput,
  failureWhenText,
  STAGE_NAMES
} from '../../../src/renderer/src/components/batch/inspector/ErrorDetail'
import
{
  BeforePlanAfterTable,
  jobUnit,
  METER_NOTES,
  streamFacts,
  TABLE_WORDS,
  tableRows,
  type TableRow
} from '../../../src/renderer/src/components/batch/inspector/BeforePlanAfterTable'
import { COPY_COMMAND_LABEL } from '../../../src/renderer/src/components/batch/inspector/CommandBlock'
import
{
  DECISION_LABELS,
  DecisionButtons,
  discardConfirmWords,
  focusJobRow,
  keepConfirmWords,
  keepLabel,
  retryConfirmWords
} from '../../../src/renderer/src/components/batch/inspector/DecisionButtons'
import
{
  contextShowLog,
  liveFacts,
  nextLabel,
  queuedText,
  RESULT_WORDS,
  ResultTab,
  resultPhase,
  resultSentences,
  showsStamp,
  sizeFacts,
  TRACK_WORDS,
  trackStages
} from '../../../src/renderer/src/components/batch/inspector/ResultTab'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import { screenMessage } from '../../../src/renderer/src/copy/batch'
import type { JobResult } from '../../../src/shared/jobs/types'
import type { StreamMeasurement } from '../../../src/shared/audio/events'
import type { GainPlan, StreamVerdict, VerifiedStream } from '../../../src/shared/audio/types'
import type { AttemptRecord, JobDetail, JobError, JobMeasurement, JobView, ResultStamp, Verification } from '../../../src/shared/jobs/types'

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

const MINUS = '−'
const ENDED = new Date(2026, 9, 14, 22, 10).getTime()

function jobView(id: string, extra: Partial<JobView> = {}): JobView
{
  return {
    id,
    seq: 1,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.mkv`, name: `${id}.mkv`, ext: 'mkv', dir: 'D:\\Rips', size: 1000, mtimeMs: 1, origin: 'files', subdir: '' },
    recipe: { kind: 'normalize' },
    recipeLabel: 'EBU R 128',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'ok',
    plan: null,
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
    addedAt: 1,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...extra
  } as JobView
}

function attemptRecord(attempt: number, extra: Partial<AttemptRecord> = {}): AttemptRecord
{
  return {
    attempt,
    runId: 'R-0029',
    recipe: { kind: 'normalize' },
    state: 'failed',
    startedAt: ENDED - 60_000,
    endedAt: ENDED,
    verdict: null,
    errorCode: 'ffmpeg-failed',
    ...extra
  } as AttemptRecord
}

function stamp(extra: Partial<ResultStamp> = {}): ResultStamp
{
  return {
    verdict: 'verified',
    outputName: 'MM-0139.flac',
    container: 'flac',
    inputBytes: 1_400_000_000,
    outputBytes: 412_000_000,
    durationSec: 2300,
    decode: 'full',
    audioStreams: 1,
    verdictStream: 0,
    loudness: { lufs: -23, unit: 'LUFS', reference: 'target', referenceLufs: -23, deviation: 0, deviationUnit: 'LU', check: 0.2, checkClass: 'lossless', status: 'within' },
    truePeak: { dbtp: -2.4, preEncodeDbtp: -2.4, limitDbtp: -1, status: 'within' },
    size: null,
    frames: null,
    cues: null,
    placement: 'new',
    warnings: 0,
    ...extra
  }
}

function numbered(count: number): string
{
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
}

describe('lastLines', () =>
{
  it('keeps the last 40 lines and drops trailing blank lines', () =>
  {
    const tail = lastLines(`${numbered(60)}\n\n`)
    const lines = tail.split('\n')
    expect(lines).toHaveLength(OUTPUT_TAIL_LINES)
    expect(lines[0]).toBe('line 21')
    expect(lines[39]).toBe('line 60')
  })

  it('lets a carriage return overwrite its line, as FFmpeg progress does', () =>
  {
    expect(lastLines('frame=1\rframe=2\rframe=3\r\nConversion failed!\r\n')).toBe('frame=3\nConversion failed!')
  })

  it('returns nothing for an empty text or a zero count', () =>
  {
    expect(lastLines('')).toBe('')
    expect(lastLines('a\nb', 0)).toBe('')
  })
})

describe('OutputTail', () =>
{
  it('shows the last lines in a focusable, labeled, selectable region', () =>
  {
    render(<OutputTail text={numbered(50)} />)
    const region = screen.getByRole('region', { name: OUTPUT_TAIL_WORDS.caption })
    expect(region).toHaveAttribute('tabindex', '0')
    const pre = region.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.className).toContain('select-text')
    expect(pre?.className).toContain('font-mono')
    expect(pre?.textContent?.startsWith('line 11')).toBe(true)
    expect(pre?.textContent?.endsWith('line 50')).toBe(true)
  })

  it('copies exactly the lines it shows and reports the copy', async () =>
  {
    const onCopy = vi.fn()
    const onCopied = vi.fn()
    render(<OutputTail text={numbered(45)} onCopy={onCopy} onCopied={onCopied} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.copy }))
    })
    expect(onCopy).toHaveBeenCalledWith(lastLines(numbered(45)))
    expect(onCopied).toHaveBeenCalledWith(lastLines(numbered(45)))
  })

  it('does not report a copy the clipboard refused', async () =>
  {
    const onCopied = vi.fn()
    render(<OutputTail text='x' onCopy={() => Promise.reject(new Error('denied'))} onCopied={onCopied} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.copy }))
    })
    expect(onCopied).not.toHaveBeenCalled()
  })

  it('offers Full output only when the log can open, and says when FFmpeg printed nothing', () =>
  {
    const onFullOutput = vi.fn()
    const { rerender } = render(<OutputTail text='' />)
    expect(screen.queryByRole('button', { name: OUTPUT_TAIL_WORDS.full })).toBeNull()
    expect(screen.getByText(OUTPUT_TAIL_WORDS.empty)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.copy })).toBeDisabled()
    rerender(<OutputTail text='x' onFullOutput={onFullOutput} />)
    fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.full }))
    expect(onFullOutput).toHaveBeenCalledTimes(1)
  })
})

describe('Attempts', () =>
{
  it('lists the earlier attempts oldest first, then the current one', () =>
  {
    const job = jobView('MM-0139', { attempt: 3, state: 'failed', runId: 'R-0031' as JobView['runId'], endedAt: ENDED, error: { code: 'ffmpeg-failed', short: 'Decode failed', message: 'x', stage: 'encode', at: ENDED } })
    const lines = attemptLines([
      attemptRecord(2, { state: 'done', verdict: 'outside-tolerance', errorCode: null }),
      attemptRecord(1),
      attemptRecord(3)
    ], job)
    expect(lines.map((line) => line.attempt)).toEqual([1, 2, 3])
    expect(lines[0].reason).toBe(ERROR_SHORT['ffmpeg-failed'])
    expect(lines[1].outcome).toBe('Outside tolerance')
    expect(lines[2]).toMatchObject({ current: true, outcome: 'Failed', reason: 'Decode failed' })
    expect(attemptText(lines[0])).toBe('Batch 29 · Failed · FFmpeg failed · Oct 14, 22:10')
  })

  it('words every outcome without a reason where nothing failed', () =>
  {
    const records = [
      attemptRecord(1, { state: 'done', verdict: null, errorCode: null, runId: null }),
      attemptRecord(2, { state: 'canceled', errorCode: null }),
      attemptRecord(3, { state: 'done', verdict: 'verified-below-target', errorCode: null })
    ]
    const lines = attemptLines(records, jobView('MM-0140', { attempt: 4, state: 'done', stamp: stamp() }))
    expect(lines.map((line) => line.outcome)).toEqual(['Done', 'Canceled', 'Verified, reachable level', 'Verified'])
    expect(lines[0].batch).toBeNull()
    expect(lines[3].reason).toBeNull()
    expect(attemptLines([], jobView('MM-0141', { state: 'done' }))[0].outcome).toBe('Done')
    expect(attemptLines([], jobView('MM-0142', { state: 'held' }))[0]).toMatchObject({ outcome: 'Needs a decision', ended: null })
  })

  it('renders the list under its caption with the current attempt marked', () =>
  {
    render(<Attempts records={[attemptRecord(1)]} job={jobView('MM-0139', { attempt: 2, state: 'encoding' })} />)
    const list = screen.getByRole('region', { name: ATTEMPTS_CAPTION })
    const items = list.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[1].textContent).toContain('Attempt 2')
    expect(items[1].textContent).toContain('Running')
  })
})

const FAILED_AT = new Date(2026, 9, 14, 14, 2).getTime()

function jobError(extra: Partial<JobError> = {}): JobError
{
  return {
    code: 'ffmpeg-failed',
    short: 'Decode failed',
    cause: 'decode',
    message: 'FFmpeg could not decode the source after 12:31 of 38:20: Invalid data found when processing input. The file may be damaged, or this FFmpeg cannot decode it.',
    stage: 'encode',
    attempt: 1,
    encodePass: 1,
    exitCode: -22,
    exitName: 'EINVAL',
    signal: null,
    stderrTail: 'Error while decoding stream #0:1: Invalid data found when processing input\nConversion failed!',
    command: { argv: ['ffmpeg', '-i', 'in.mkv', 'out.mkv'], display: 'ffmpeg -hide_banner -i "D:\\Rips\\in.mkv" out.mkv' },
    fsError: null,
    hint: null,
    at: FAILED_AT,
    ...extra
  }
}

type StageEntry = [JobDetail['stages'][number]['id'], JobDetail['stages'][number]['outcome'], number?, number?]

function stages(...entries: StageEntry[]): JobDetail['stages']
{
  return entries.map(([id, outcome, pass = 1, passes = 1], index) => ({
    id,
    pass,
    passes,
    label: id,
    startedAt: 1000 * index,
    endedAt: outcome === 'active' ? null : 1000 * index + 72_000,
    outcome
  }))
}

describe('ErrorDetail helpers', () =>
{
  it('names the exit code from main, then from the errno table, and words a signal', () =>
  {
    expect(exitText({ exitCode: -22, exitName: 'EINVAL', signal: null })).toBe('Exit code -22 (EINVAL)')
    expect(exitText({ exitCode: -28, exitName: null, signal: null })).toBe('Exit code -28 (ENOSPC)')
    expect(exitText({ exitCode: -1094995529, exitName: null, signal: null })).toBe('Exit code -1094995529')
    expect(exitText({ exitCode: 1, exitName: null, signal: null })).toBe('Exit code 1')
    expect(exitText({ exitCode: null, exitName: null, signal: 'SIGKILL' })).toBe('Stopped by SIGKILL')
    expect(exitText({ exitCode: null, exitName: null, signal: null })).toBeNull()
  })

  it('places the failure in its stage and pass, at its time of day', () =>
  {
    const track = stages(['probe', 'done'], ['encode', 'failed', 1, 2])
    expect(failedStageText(jobError(), track)).toBe('Encode, pass 1 of 2')
    expect(failedStageText(jobError(), [])).toBe('Encode')
    expect(failedStageText(jobError({ stage: 'place', encodePass: null }), track)).toBe(STAGE_NAMES.place)
    expect(failureWhenText(jobError(), track)).toBe('Failed during Encode, pass 1 of 2, at 14:02.')
  })

  it('states the attempt with its exit and any file system error', () =>
  {
    expect(attemptExitText(jobError())).toBe('Attempt 1 · Exit code -22 (EINVAL)')
    expect(attemptExitText(jobError({ attempt: 2, exitCode: null, exitName: null, fsError: { code: 'ENOSPC', syscall: 'write', path: 'D:\\out.mkv' } })))
      .toBe('Attempt 2 · ENOSPC on write')
  })

  it('finds the command and the output to show', () =>
  {
    const commands: JobDetail['commands'] = [
      { stage: 'encode', encodePass: 1, display: 'ffmpeg pass1' },
      { stage: 'encode', encodePass: 2, display: 'ffmpeg pass2' }
    ]
    expect(failedCommand(jobError(), commands)).toBe(jobError().command?.display)
    expect(failedCommand(jobError({ command: null }), commands)).toBe('ffmpeg pass1')
    expect(failedCommand(jobError({ command: null, encodePass: null }), commands)).toBe('ffmpeg pass2')
    expect(failedCommand(jobError({ command: null, stage: 'verify' }), commands)).toBeNull()
    expect(failureOutput(jobError(), 'attempt log')).toBe('attempt log')
    expect(failureOutput(jobError(), '  ')).toBe(jobError().stderrTail)
    expect(failureOutput(jobError(), null)).toBe(jobError().stderrTail)
  })

  it('copies the sentence, the reason, and the command', () =>
  {
    const text = copyErrorText(jobError(), 'ffmpeg -i in.mkv out.mkv')
    expect(text.split('\n')).toEqual([
      jobError().message,
      'Reason: Decode failed',
      'Exit code -22 (EINVAL)',
      'Command: ffmpeg -i in.mkv out.mkv'
    ])
    expect(copyErrorText(jobError({ exitCode: null, exitName: null }), null).split('\n')).toHaveLength(2)
  })
})

describe('ErrorDetail', () =>
{
  it('shows the cause sentence, stage, pass, time, exit code, output tail, and command', async () =>
  {
    const onCopied = vi.fn()
    const onCopy = vi.fn()
    const onFullOutput = vi.fn()
    const tail = Array.from({ length: 60 }, (_, index) => `ffmpeg line ${index + 1}`).join('\n')
    render(
      <ErrorDetail
        error={jobError({ hint: 'Try another FFmpeg build.' })}
        detail={{ stages: stages(['probe', 'done'], ['encode', 'failed', 1, 2]), commands: [], stderrTail: tail }}
        onCopy={onCopy}
        onCopied={onCopied}
        onFullOutput={onFullOutput}
      />
    )
    expect(screen.getByText(jobError().message)).toBeInTheDocument()
    expect(screen.getByText('Try another FFmpeg build.')).toBeInTheDocument()
    expect(screen.getByText('Failed during Encode, pass 1 of 2, at 14:02.')).toBeInTheDocument()
    expect(screen.getByText('Attempt 1 · Exit code -22 (EINVAL)')).toBeInTheDocument()
    const region = screen.getByRole('region', { name: OUTPUT_TAIL_WORDS.caption })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.textContent?.split('\n')).toHaveLength(40)
    expect(region.textContent?.startsWith('ffmpeg line 21')).toBe(true)
    expect(region.textContent).toContain('ffmpeg line 60')
    const command = screen.getByRole('group', { name: COMMAND_LABEL })
    expect(command.textContent).toContain('ffmpeg -hide_banner -i "D:\\Rips\\in.mkv" out.mkv')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: COPY_COMMAND_LABEL }))
    })
    expect(onCopied).toHaveBeenCalledWith('command', jobError().command?.display)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.copy }))
    })
    expect(onCopied).toHaveBeenCalledWith('output', lastLines(tail))
    fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.full }))
    expect(onFullOutput).toHaveBeenCalledTimes(1)
  })

  it('leaves out the tail and the command when no process ran', () =>
  {
    render(
      <ErrorDetail
        error={jobError({ code: 'source-missing', short: 'Source missing', message: 'The file is no longer at D:\\Rips\\x.mkv.', stage: 'probe', encodePass: null, exitCode: null, exitName: null, stderrTail: '', command: null })}
        detail={{ stages: [], commands: [], stderrTail: null }}
      />
    )
    expect(screen.getByText('The file is no longer at D:\\Rips\\x.mkv.')).toBeInTheDocument()
    expect(screen.getByText('Attempt 1')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: OUTPUT_TAIL_WORDS.caption })).toBeNull()
    expect(screen.queryByRole('group', { name: COMMAND_LABEL })).toBeNull()
  })
})

const CEILING = {
  presetMaxDbtp: -1,
  codecCeilingDbtp: null,
  ceilingDbtp: -1,
  limiterCeilingDbtp: -1.5,
  gateDbtp: -1,
  decodedLimitDbtp: -1,
  outputClass: 'lossless',
  reason: 'preset'
} as unknown as GainPlan['ceiling']

function streamMeasurement(audioIndex = 0, stats: Partial<StreamMeasurement['stats']> = {}): StreamMeasurement
{
  return {
    audioIndex,
    layout: 'stereo',
    channels: 2,
    sampleRate: 48000,
    stats: {
      status: 'measured',
      integratedLufs: -20.9,
      thresholdLufs: -31,
      loudnessRangeLu: 15.8,
      lraStatus: 'measured',
      maxShortTermLufs: null,
      truePeakDbtp: -7.1,
      dialogueLufs: null,
      dualMono: false,
      channelWeights: 'bs1770-annex1',
      ...stats
    },
    loudnessToDialogueLu: null
  } as StreamMeasurement
}

function gainPlan(audioIndex = 0, extra: Partial<GainPlan> = {}): GainPlan
{
  return {
    audioIndex,
    mode: 'linear',
    reason: 'target',
    targetLufs: -23,
    requestedGainDb: -2.1,
    gainDb: -2.1,
    headroomDb: 6.1,
    limitingDb: 0,
    maxLimitingDb: 3,
    predictedLufs: -23,
    predictedTruePeakDbtp: -9.2,
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling: CEILING,
    ...extra
  } as GainPlan
}

function verifiedStream(outIndex = 0, extra: Partial<VerifiedStream> = {}): VerifiedStream
{
  return {
    outIndex,
    integratedLufs: -23,
    loudnessRangeLu: 15.6,
    maxShortTermLufs: null,
    preEncodeTruePeakDbtp: -2.4,
    truePeakDbtp: -2.6,
    samplePeakDbfs: -3.1,
    meter: 'soxr-8x',
    ...extra
  }
}

function streamVerdict(audioIndex = 0, extra: Partial<StreamVerdict> = {}): StreamVerdict
{
  return {
    audioIndex,
    outcome: 'verified',
    loudness: { status: 'within', reference: 'target', referenceLufs: -23, deviationLu: 0, toleranceLu: 0.2, standardTolerance: { value: 0.2, unit: 'LU' } },
    shortTerm: { status: 'not-checked', limitLufs: null, maxLufs: null, toleranceLu: 0 },
    truePeak: { status: 'within', basis: 'pre-encode', gateDbtp: -1, overDb: null },
    decoded: { status: 'within', limitDbtp: -1, overDb: null },
    samplePeakOver: false,
    warnings: [],
    meterMarginDb: 0,
    encodePasses: 1,
    ...extra
  }
}

function measurementOf(...streams: Array<[StreamMeasurement, GainPlan | null]>): JobMeasurement
{
  return { pass: 'source', measuredAt: 1, streams: streams.map(([measurement, plan]) => ({ measurement, plan })), album: null, messages: [] }
}

function verificationOf(...audio: Array<[VerifiedStream | null, StreamVerdict]>): Verification
{
  return { verdict: 'verified', encodePasses: 1, audio: audio.map(([verified, verdict]) => ({ verified, verdict })), media: null, messages: [] }
}

function rowOf(rows: TableRow[], key: TableRow['key']): TableRow
{
  const row = rows.find((item) => item.key === key)
  if (row === undefined)
  {
    throw new Error(`no row ${key}`)
  }
  return row
}

describe('BeforePlanAfterTable helpers', () =>
{
  it('joins measured, planned, and verified streams by audio index', () =>
  {
    const facts = streamFacts(
      measurementOf([streamMeasurement(1), gainPlan(1)], [streamMeasurement(0), gainPlan(0)]),
      verificationOf([verifiedStream(0), streamVerdict(0)], [verifiedStream(2), streamVerdict(2)])
    )
    expect(facts.map((item) => item.audioIndex)).toEqual([0, 1, 2])
    expect(facts[1].verified).toBeNull()
    expect(facts[2].measured).toBeNull()
    expect(streamFacts(null, null)).toEqual([])
  })

  it('always has separate rows for true peak before encoding and after decoding', () =>
  {
    const rows = tableRows({ audioIndex: 0, measured: null, plan: null, verified: null, verdict: null }, 'LUFS')
    expect(rows.map((row) => row.key)).toEqual(['integrated', 'range', 'true-peak-pre', 'true-peak-decoded', 'sample-peak'])
    expect(rowOf(rows, 'true-peak-pre').label).toBe(TABLE_WORDS.truePeakPre)
    expect(rowOf(rows, 'true-peak-decoded').label).toBe(TABLE_WORDS.truePeakDecoded)
    expect(rowOf(rows, 'true-peak-decoded').note).toBe(TABLE_WORDS.truePeakDecodedNote)
    expect(rows.every((row) => row.after.text === TABLE_WORDS.notYet && row.after.quiet)).toBe(true)
  })

  it('fills before from the source, plan from the gain plan, and after only from Verify', () =>
  {
    const rows = tableRows({ audioIndex: 0, measured: streamMeasurement(), plan: gainPlan(), verified: verifiedStream(), verdict: streamVerdict() }, 'LUFS')
    expect(rowOf(rows, 'integrated')).toMatchObject({ before: { text: `${MINUS}20.9 LUFS` }, plan: { text: `${MINUS}23.0 LUFS` }, after: { text: `${MINUS}23.0 LUFS`, failing: false } })
    expect(rowOf(rows, 'range')).toMatchObject({ before: { text: '15.8 LU' }, plan: { text: TABLE_WORDS.none, quiet: true }, after: { text: '15.6 LU' } })
    expect(rowOf(rows, 'true-peak-pre')).toMatchObject({ before: { text: `${MINUS}7.1 dBTP` }, plan: { text: `limit ${MINUS}1.0 dBTP` }, after: { text: `${MINUS}2.4 dBTP` } })
    expect(rowOf(rows, 'true-peak-decoded')).toMatchObject({ before: { text: TABLE_WORDS.notMeasured }, plan: { text: `limit ${MINUS}1.0 dBTP` }, after: { text: `${MINUS}2.6 dBTP` } })
    expect(rowOf(rows, 'sample-peak').after.text).toBe(`${MINUS}3.1 dBFS`)
  })

  it('marks each failing check in error ink and words a reachable plan and a short file', () =>
  {
    const rows = tableRows({
      audioIndex: 0,
      measured: streamMeasurement(0, { loudnessRangeLu: null, lraStatus: 'not-applicable' }),
      plan: gainPlan(0, { targetLufs: -18, predictedLufs: -19.1 }),
      verified: verifiedStream(0, { integratedLufs: -21.8, loudnessRangeLu: null, truePeakDbtp: -0.4, preEncodeTruePeakDbtp: -0.6, samplePeakDbfs: 0.2 }),
      verdict: streamVerdict(0, {
        loudness: { status: 'below', reference: 'target', referenceLufs: -23, deviationLu: 1.2, toleranceLu: 0.2, standardTolerance: null },
        truePeak: { status: 'over', basis: 'pre-encode', gateDbtp: -1, overDb: 0.4 },
        decoded: { status: 'over', limitDbtp: -1, overDb: 0.6 },
        samplePeakOver: true
      })
    }, 'LKFS')
    expect(rowOf(rows, 'integrated').plan.text).toBe(`${MINUS}19.1 LKFS, reachable`)
    expect(rowOf(rows, 'integrated').after.failing).toBe(true)
    expect(rowOf(rows, 'range').before.text).toBe(TABLE_WORDS.shortFile)
    expect(rowOf(rows, 'range').after.text).toBe(TABLE_WORDS.shortFile)
    expect(rowOf(rows, 'true-peak-pre').after.failing).toBe(true)
    expect(rowOf(rows, 'true-peak-decoded').after.failing).toBe(true)
    expect(rowOf(rows, 'sample-peak').after.failing).toBe(true)
  })

  it('says Not measured for a value Verify did not report, and reads the unit from the job', () =>
  {
    const rows = tableRows({ audioIndex: 0, measured: null, plan: gainPlan(0, { targetLufs: null }), verified: verifiedStream(0, { truePeakDbtp: null }), verdict: null }, 'LUFS')
    expect(rowOf(rows, 'true-peak-decoded').after.text).toBe(TABLE_WORDS.notMeasured)
    expect(rowOf(rows, 'integrated').plan.text).toBe(TABLE_WORDS.none)
    expect(rowOf(rows, 'integrated').before.text).toBe(TABLE_WORDS.notMeasured)
    expect(jobUnit(jobView('MM-0001', { stamp: stamp({ loudness: { ...stamp().loudness!, unit: 'LKFS' } }) }))).toBe('LKFS')
    expect(jobUnit(jobView('MM-0002', { audioPlan: [{ unit: 'LKFS' } as NonNullable<JobView['audioPlan']>[number]] }))).toBe('LKFS')
    expect(jobUnit(jobView('MM-0003'))).toBe('LUFS')
  })
})

describe('BeforePlanAfterTable', () =>
{
  it('renders one labeled, focusable table per stream with both true peaks and the meter line', () =>
  {
    render(
      <BeforePlanAfterTable
        measurement={measurementOf([streamMeasurement(0), gainPlan(0)], [streamMeasurement(1), gainPlan(1)])}
        verification={verificationOf([verifiedStream(0), streamVerdict(0)], [verifiedStream(1, { meter: 'swr-8x' }), streamVerdict(1)])}
        unit='LUFS'
      />
    )
    const first = screen.getByRole('region', { name: `${TABLE_WORDS.caption}, audio 1` })
    expect(first).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('region', { name: `${TABLE_WORDS.caption}, audio 2` })).toBeInTheDocument()
    const headers = screen.getAllByRole('rowheader').map((header) => header.textContent)
    expect(headers.filter((text) => text?.startsWith(TABLE_WORDS.truePeakPre))).toHaveLength(2)
    expect(headers.filter((text) => text?.startsWith(TABLE_WORDS.truePeakDecoded))).toHaveLength(2)
    expect(screen.getByText(METER_NOTES['soxr-8x'])).toBeInTheDocument()
    expect(screen.getByText(METER_NOTES['swr-8x'])).toBeInTheDocument()
  })

  it('marks failing cells and renders nothing without audio', () =>
  {
    const { container, rerender } = render(
      <BeforePlanAfterTable
        measurement={null}
        verification={verificationOf([verifiedStream(0, { truePeakDbtp: -0.4 }), streamVerdict(0, { decoded: { status: 'over', limitDbtp: -1, overDb: 0.6 } })])}
        unit='LUFS'
      />
    )
    expect(screen.getByRole('region', { name: TABLE_WORDS.caption })).toBeInTheDocument()
    const failing = container.querySelectorAll('td[data-failing]')
    expect(failing).toHaveLength(1)
    expect(failing[0].className).toContain('text-error')
    rerender(<BeforePlanAfterTable measurement={null} verification={null} unit='LUFS' />)
    expect(container.querySelector('[data-part="before-plan-after"]')).toBeNull()
  })
})

function hold(extra: Partial<NonNullable<JobView['hold']>> = {}): NonNullable<JobView['hold']>
{
  return {
    reason: 'outside-tolerance',
    message: 'Measured -21.8 LUFS after encoding, +1.2 LU from the target of -23.0 LUFS.',
    outputPath: 'D:\\work\\MM-0152.flac',
    displaces: 'D:\\Exports\\MM-0152.flac',
    actions: ['keep', 'keep-renamed', 'discard', 'retry'],
    since: 1,
    ...extra
  }
}

function heldJob(id = 'MM-0152', extra: Partial<NonNullable<JobView['hold']>> = {}): JobView
{
  return jobView(id, { state: 'held', hold: hold(extra), runId: 'R-0031' as JobView['runId'] })
}

const DONE = (ids: string[]): { status: 'done'; value: { applied: string[]; refused: [] }; seq: number } => ({ status: 'done', value: { applied: ids, refused: [] }, seq: 2 })

function renderDecisions(job: JobView, overrides: Record<string, unknown>, props: Partial<React.ComponentProps<typeof DecisionButtons>> = {}): { onFocusRow: ReturnType<typeof vi.fn> }
{
  const onFocusRow = vi.fn()
  render(
    <TestBatchActionsProvider overrides={overrides as never}>
      <DecisionButtons job={job} onFocusRow={onFocusRow} {...props} />
    </TestBatchActionsProvider>
  )
  return { onFocusRow }
}

async function press(name: string): Promise<void>
{
  await act(async () =>
  {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('DecisionButtons helpers', () =>
{
  it('relabels Keep output by what placing would do', () =>
  {
    expect(keepLabel(heldJob())).toBe(DECISION_LABELS.keep)
    expect(keepLabel(heldJob('MM-0152', { reason: 'interrupted-finalize' }))).toBe('Finish saving')
    const replace = heldJob()
    expect(keepLabel({ ...replace, hold: { ...replace.hold!, displaces: replace.source.path } })).toBe('Keep output and replace original')
  })

  it('words each inline confirmation', () =>
  {
    expect(discardConfirmWords('MM-0152' as never)).toEqual({
      question: 'Discard the output of MM-0152? The file is deleted. The original and any existing file stay.',
      safe: 'Keep it',
      confirm: 'Discard',
      danger: true
    })
    expect(retryConfirmWords('MM-0152' as never)).toMatchObject({ question: 'Retry MM-0152? The output waiting for a decision is deleted first.', safe: 'Keep waiting', confirm: 'Retry', danger: false })
    const job = heldJob()
    expect(keepConfirmWords({ ...job, hold: { ...job.hold!, displaces: job.source.path } }).question)
      .toBe('Replace the original of MM-0152 with an output outside tolerance? The original goes to the Recycle Bin.')
    expect(keepConfirmWords({ ...job, hold: { ...job.hold!, reason: 'file-locked', displaces: job.source.path } }).question)
      .toBe('Replace the original of MM-0152? The original goes to the Recycle Bin.')
    expect(keepConfirmWords(job)).toMatchObject({ question: 'Replace MM-0152.flac with the output of MM-0152? The existing file goes to the Recycle Bin.', safe: 'Keep both', confirm: 'Replace file' })
    expect(keepConfirmWords({ ...job, hold: { ...job.hold!, displaces: null } }).question).toContain('Replace the existing file')
  })

  it('focuses the job row by default', () =>
  {
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    row.dataset.rowId = 'MM-0152'
    row.tabIndex = -1
    document.body.append(row)
    focusJobRow('MM-0152' as never)
    expect(document.activeElement).toBe(row)
    row.remove()
  })
})

describe('DecisionButtons', () =>
{
  it('offers exactly the decisions main allows, in order', () =>
  {
    renderDecisions(heldJob('MM-0152', { actions: ['retry', 'keep', 'discard'] }), {})
    const labels = screen.getAllByRole('button').map((button) => button.textContent)
    expect(labels).toEqual([DECISION_LABELS.keep, DECISION_LABELS.discard, DECISION_LABELS.retry])
  })

  it('reads Finish saving after an interruption while saving', () =>
  {
    renderDecisions(heldJob('MM-0152', { reason: 'interrupted-finalize', displaces: null }), {})
    expect(screen.getByRole('button', { name: 'Finish saving' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: DECISION_LABELS.keep })).toBeNull()
  })

  it('discards after its inline confirmation, then focuses the row', async () =>
  {
    const discardOutput = vi.fn(async (ids: string[]) => DONE(ids))
    const { onFocusRow } = renderDecisions(heldJob(), { discardOutput })
    await press(DECISION_LABELS.discard)
    expect(screen.getByText(discardConfirmWords('MM-0152' as never).question)).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' }))
    expect(discardOutput).not.toHaveBeenCalled()
    await press('Discard')
    expect(discardOutput).toHaveBeenCalledWith(['MM-0152'])
    expect(onFocusRow).toHaveBeenCalledWith('MM-0152')
    expect(screen.getByRole('button', { name: DECISION_LABELS.discard })).toBeInTheDocument()
  })

  it('keeps nothing when the safe choice is taken', async () =>
  {
    const discardOutput = vi.fn()
    const { onFocusRow } = renderDecisions(heldJob(), { discardOutput })
    await press(DECISION_LABELS.discard)
    await press('Keep it')
    expect(discardOutput).not.toHaveBeenCalled()
    expect(onFocusRow).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: DECISION_LABELS.discard })).toBeInTheDocument()
  })

  it('keeps the output, confirming first when placing it displaces a file', async () =>
  {
    const keepOutput = vi.fn(async (ids: string[], options: { confirmed?: boolean }) => options.confirmed === true ? DONE(ids) : { status: 'needs-confirmation', displaces: 1 })
    const { onFocusRow } = renderDecisions(heldJob(), { keepOutput })
    await press(DECISION_LABELS.keep)
    expect(keepOutput).toHaveBeenLastCalledWith(['MM-0152'], { placement: 'planned', confirmed: false })
    expect(onFocusRow).not.toHaveBeenCalled()
    expect(screen.getByText(keepConfirmWords(heldJob()).question)).toBeInTheDocument()
    await press('Replace file')
    expect(keepOutput).toHaveBeenLastCalledWith(['MM-0152'], { placement: 'planned', confirmed: true })
    expect(onFocusRow).toHaveBeenCalledWith('MM-0152')
  })

  it('keeps the output under a new name and focuses the row', async () =>
  {
    const keepOutput = vi.fn(async (ids: string[]) => DONE(ids))
    const { onFocusRow } = renderDecisions(heldJob(), { keepOutput })
    await press(DECISION_LABELS.keepRenamed)
    expect(keepOutput).toHaveBeenCalledWith(['MM-0152'], { placement: 'renamed' })
    expect(onFocusRow).toHaveBeenCalledWith('MM-0152')
  })

  it('retries after its confirmation and hands an acknowledgment request to the owner', async () =>
  {
    const ack = { preflightId: 'p1', originalsAffected: 1, overwrites: 0 }
    const retry = vi.fn()
      .mockResolvedValueOnce({ status: 'needs-acknowledgment', ack })
      .mockResolvedValueOnce({ status: 'done', value: { queued: ['MM-0152'], changed: [], refused: [] }, seq: 3 })
    const onNeedsAcknowledgment = vi.fn()
    const { onFocusRow } = renderDecisions(heldJob(), { retry }, { onNeedsAcknowledgment })
    await press(DECISION_LABELS.retry)
    expect(screen.getByText(retryConfirmWords('MM-0152' as never).question)).toBeInTheDocument()
    await press('Retry')
    expect(retry).toHaveBeenCalledWith(['MM-0152'])
    expect(onNeedsAcknowledgment).toHaveBeenCalledWith(ack)
    expect(onFocusRow).not.toHaveBeenCalled()
    await press(DECISION_LABELS.retry)
    await press('Retry')
    expect(onFocusRow).toHaveBeenCalledWith('MM-0152')
  })

  it('leaves focus alone when main refuses a decision, and renders nothing without a hold', async () =>
  {
    const keepOutput = vi.fn(async () => ({ status: 'refused', code: 'nothing', message: 'No.' }))
    const { onFocusRow } = renderDecisions(heldJob(), { keepOutput })
    await press(DECISION_LABELS.keepRenamed)
    expect(onFocusRow).not.toHaveBeenCalled()
    cleanup()
    const { container } = render(
      <TestBatchActionsProvider>
        <DecisionButtons job={jobView('MM-0153', { state: 'done' })} />
      </TestBatchActionsProvider>
    )
    expect(container.querySelector('[data-part="decisions"]')).toBeNull()
  })
})

function progress(extra: Partial<NonNullable<JobView['progress']>> = {}): NonNullable<JobView['progress']>
{
  return {
    stage: 'encode',
    pass: 1,
    passes: 2,
    percent: 46.7,
    stagePercent: 30,
    speed: 6.2,
    etaSec: 460,
    outTimeSec: 600,
    durationSec: 2300,
    bytesWritten: 312_000_000,
    elapsedMs: 271_000,
    ...extra
  }
}

function jobDetail(view: JobView, extra: Partial<JobDetail> = {}): JobDetail
{
  return {
    view,
    plan: null,
    media: null,
    measurement: null,
    verification: null,
    result: null,
    error: null,
    stderrTail: null,
    stages: [],
    commands: [],
    attempts: [],
    ...extra
  }
}

function jobResult(extra: Partial<JobResult> = {}): JobResult
{
  return {
    outputPath: 'D:\\Exports\\MM-0139.flac',
    outputKind: 'file',
    container: 'flac',
    inputBytes: 1_400_000_000,
    outputBytes: 412_000_000,
    durationSec: 2300,
    elapsedMs: 400_000,
    encoder: { video: null, audio: ['flac'] },
    placement: { kind: 'new' },
    stamp: stamp(),
    warnings: [],
    notes: [],
    ...extra
  }
}

function failedJob(extra: Partial<JobView> = {}): JobView
{
  const error = jobError()
  return jobView('MM-0139', {
    state: 'failed',
    runId: 'R-0031' as JobView['runId'],
    error: { code: error.code, short: error.short, message: error.message, stage: error.stage, at: error.at },
    endedAt: FAILED_AT,
    ...extra
  })
}

function renderTab(props: Partial<React.ComponentProps<typeof ResultTab>> & { job: JobView }, overrides: Record<string, unknown> = {}): ReturnType<typeof render>
{
  return render(
    <TestBatchActionsProvider overrides={overrides as never}>
      <ResultTab detail={null} {...props} />
    </TestBatchActionsProvider>
  )
}

describe('ResultTab helpers', () =>
{
  it('maps every state to its view', () =>
  {
    expect(resultPhase({ state: 'pending' })).toBe('not-started')
    expect(resultPhase({ state: 'queued' })).toBe('not-started')
    expect(resultPhase({ state: 'encoding' })).toBe('running')
    expect(resultPhase({ state: 'finalizing' })).toBe('running')
    expect(resultPhase({ state: 'held' })).toBe('held')
    expect(resultPhase({ state: 'done' })).toBe('done')
    expect(resultPhase({ state: 'failed' })).toBe('failed')
    expect(resultPhase({ state: 'interrupted' })).toBe('interrupted')
    expect(resultPhase({ state: 'canceled' })).toBe('canceled')
    expect(resultPhase({ state: 'skipped' })).toBe('skipped')
  })

  it('tracks the stages run with their times, then the stages still to run', () =>
  {
    const job = jobView('MM-0139', { state: 'encoding' })
    const track = trackStages(job, { stages: stages(['probe', 'done'], ['measure', 'done'], ['encode', 'active', 1, 2]) })
    expect(track.map((stage) => [stage.label, stage.state, stage.detail])).toEqual([
      ['Probe', 'done', '1 min 12 s'],
      ['Measure', 'done', '1 min 12 s'],
      ['Encode, pass 1 of 2', 'active', undefined],
      ['Verify', 'pending', undefined],
      ['Save', 'pending', undefined]
    ])
    const convert = trackStages(jobView('MM-0140', { state: 'queued', recipe: { kind: 'convert' } as JobView['recipe'] }), null)
    expect(convert.map((stage) => stage.label)).toEqual(['Probe', 'Encode', 'Verify', 'Save'])
  })

  it('marks the failed stage and the corrective encode, and falls back to the row without a detail', () =>
  {
    const corrected = trackStages(jobView('MM-0141', { state: 'done' }), { stages: stages(['probe', 'done'], ['encode', 'done'], ['verify', 'done'], ['encode', 'done'], ['verify', 'done']) })
    expect(corrected[3]).toMatchObject({ label: TRACK_WORDS.corrective, detail: 'corrective, 1 min 12 s' })
    expect(corrected).toHaveLength(5)
    const failed = trackStages(failedJob(), null)
    expect(failed).toEqual([{ key: 'encode-1-0', label: 'Encode', state: 'failed' }])
    const live = trackStages(jobView('MM-0142', { state: 'analyzing', stage: { id: 'measure-dynamics', pass: 1, passes: 1, label: 'Measuring after dynamics', startedAt: 1 } }), null)
    expect(live.map((stage) => stage.label)).toEqual(['Measure after dynamics', 'Probe', 'Encode', 'Verify', 'Save'])
    const relabeled = trackStages(jobView('MM-0143', { state: 'encoding' }), { stages: [{ id: 'encode', pass: 1, passes: 1, label: 'Re-encoding (correction)', startedAt: 0, endedAt: null, outcome: 'active' }] })
    expect(relabeled[0]).toMatchObject({ label: TRACK_WORDS.corrective, detail: 'corrective' })
  })

  it('words the live numbers and the sizes', () =>
  {
    expect(liveFacts(progress())).toEqual([
      { label: 'Progress', value: '46%' },
      { label: 'Speed', value: '6.2x' },
      { label: 'Time left', value: '7 min 40 s' },
      { label: 'Elapsed', value: '4 min 31 s' },
      { label: 'Written', value: '312 MB' }
    ])
    const early = liveFacts(progress({ speed: null, etaSec: null, bytesWritten: null }))
    expect(early.map((fact) => fact.value)).toEqual(['46%', 'Not reported', 'Estimating time left', '4 min 31 s'])
    expect(sizeFacts(jobResult())).toEqual([
      { label: 'Source', value: '1.4 GB' },
      { label: 'Output', value: `412 MB (${MINUS}71%)` }
    ])
  })

  it('shows a stamp only for a measured outcome', () =>
  {
    expect(showsStamp({ state: 'done', stamp: stamp() })).toBe(true)
    expect(showsStamp({ state: 'done', stamp: null })).toBe(false)
    expect(showsStamp({ state: 'failed', stamp: null })).toBe(true)
    expect(showsStamp({ state: 'interrupted', stamp: null })).toBe(true)
    expect(showsStamp({ state: 'held', stamp: stamp({ verdict: 'outside-tolerance' }) })).toBe(true)
    expect(showsStamp({ state: 'held', stamp: stamp() })).toBe(false)
    expect(showsStamp({ state: 'canceled', stamp: stamp() })).toBe(false)
    expect(showsStamp({ state: 'encoding', stamp: null })).toBe(false)
  })

  it('collects Verify sentences, warnings, and notes once each', () =>
  {
    const ref = { key: 'verified-below', params: { I: -19.1, T: -18, unit: 'LUFS' } } as JobMeasurement['messages'][number]
    const warning = { code: 'decoded-overshoot', short: 'Peak over after encoding', message: 'Decoded true peak over.' } as JobView['warnings'][number]
    const sentences = resultSentences({ warnings: [warning] }, { verification: { ...verificationOf(), messages: [ref] }, result: jobResult({ warnings: [warning], notes: ['Copied unchanged.', 'Copied unchanged.'] }) })
    expect(sentences).toEqual([screenMessage(ref), 'Decoded true peak over.', 'Copied unchanged.'])
    expect(sentences[0]).toContain('reachable level')
    expect(resultSentences({ warnings: [warning] }, null)).toEqual(['Decoded true peak over.'])
  })

  it('words the queued line and the next button, and finds Show log in the actions context', () =>
  {
    expect(queuedText({ runId: 'R-0031' as JobView['runId'] })).toBe('Queued in Batch 31. Results appear here when it runs.')
    expect(queuedText({ runId: null })).toBe(RESULT_WORDS.notStarted)
    expect(nextLabel('MM-0152' as never)).toBe('Next: MM-0152')
    const showLog = vi.fn()
    expect(contextShowLog({ showLog } as never)).toBe(showLog)
    expect(contextShowLog({} as never)).toBeUndefined()
  })
})

describe('ResultTab', () =>
{
  it('shows a failure in full: stamp, sentence, stage, pass, time, exit code, tail, command, attempts, actions', async () =>
  {
    const showLog = vi.fn()
    const job = failedJob({ attempt: 2 })
    const tail = Array.from({ length: 55 }, (_, index) => `ffmpeg line ${index + 1}`).join('\n')
    const detail = jobDetail(job, {
      error: jobError({ attempt: 2 }),
      stderrTail: tail,
      stages: stages(['probe', 'done'], ['measure', 'done'], ['encode', 'failed', 1, 2]),
      attempts: [attemptRecord(1)]
    })
    const { container } = renderTab({ job, detail, onEditAndRetry: vi.fn() }, { showLog })
    const stampText = container.querySelector('[data-part="stamp"]')?.textContent ?? ''
    expect(stampText).toMatch(/returned/i)
    expect(stampText).toContain('Decode failed')
    expect(screen.getByText(jobError().message)).toBeInTheDocument()
    expect(screen.getByText('Failed during Encode, pass 1 of 2, at 14:02.')).toBeInTheDocument()
    expect(screen.getByText('Attempt 2 · Exit code -22 (EINVAL)')).toBeInTheDocument()
    const region = screen.getByRole('region', { name: OUTPUT_TAIL_WORDS.caption })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region.querySelector('pre')?.className).toContain('select-text')
    expect(region.textContent?.split('\n')).toHaveLength(40)
    expect(screen.getByRole('group', { name: COMMAND_LABEL }).textContent).toContain('ffmpeg -hide_banner')
    expect(screen.getByRole('region', { name: ATTEMPTS_CAPTION }).querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('li[data-state="failed"]')?.textContent).toContain('Encode, pass 1 of 2')
    const group = screen.getByRole('group', { name: RESULT_WORDS.actions })
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      RESULT_WORDS.retry,
      RESULT_WORDS.editAndRetry,
      RESULT_WORDS.showLog,
      RESULT_WORDS.copyError,
      RESULT_WORDS.acknowledge
    ])
    fireEvent.click(screen.getByRole('button', { name: RESULT_WORDS.showLog }))
    expect(showLog).toHaveBeenLastCalledWith('MM-0139')
    fireEvent.click(screen.getByRole('button', { name: OUTPUT_TAIL_WORDS.full }))
    expect(showLog).toHaveBeenLastCalledWith('MM-0139', { attempt: 2 })
  })

  it('copies the error and hands Edit and retry to the inspector', async () =>
  {
    const onCopy = vi.fn()
    const onCopied = vi.fn()
    const onEditAndRetry = vi.fn()
    const job = failedJob()
    renderTab({ job, detail: jobDetail(job, { error: jobError() }), onCopy, onCopied, onEditAndRetry })
    await press(RESULT_WORDS.copyError)
    expect(onCopy).toHaveBeenCalledWith(copyErrorText(jobError(), jobError().command?.display ?? null))
    expect(onCopied).toHaveBeenCalledWith('error')
    fireEvent.click(screen.getByRole('button', { name: RESULT_WORDS.editAndRetry }))
    expect(onEditAndRetry).toHaveBeenCalledWith('MM-0139')
  })

  it('copies the row error while the detail loads, and skips a refused clipboard', async () =>
  {
    const onCopied = vi.fn()
    const onCopy = vi.fn()
    renderTab({ job: failedJob(), onCopy, onCopied })
    expect(screen.getByText(jobError().message)).toBeInTheDocument()
    await press(RESULT_WORDS.copyError)
    expect(onCopy).toHaveBeenCalledWith(`${jobError().message}\nReason: Decode failed`)
    cleanup()
    renderTab({ job: failedJob(), onCopy: () => Promise.reject(new Error('denied')), onCopied })
    onCopied.mockClear()
    await press(RESULT_WORDS.copyError)
    expect(onCopied).not.toHaveBeenCalled()
  })

  it('moves focus to Next after Acknowledge when another job needs attention', async () =>
  {
    const acknowledge = vi.fn(async (ids: string[]) => DONE(ids))
    const onSelectJob = vi.fn()
    const onFocusTabs = vi.fn()
    renderTab({ job: failedJob(), nextAttention: 'MM-0152' as never, onSelectJob, onFocusTabs }, { acknowledge })
    await press(RESULT_WORDS.acknowledge)
    expect(acknowledge).toHaveBeenCalledWith(['MM-0139'])
    const next = screen.getByRole('button', { name: 'Next: MM-0152' })
    expect(document.activeElement).toBe(next)
    expect(screen.queryByRole('button', { name: RESULT_WORDS.acknowledge })).toBeNull()
    expect(onFocusTabs).not.toHaveBeenCalled()
    fireEvent.click(next)
    expect(onSelectJob).toHaveBeenCalledWith('MM-0152')
  })

  it('moves focus to the tab list after Acknowledge when nothing else needs attention', async () =>
  {
    const acknowledge = vi.fn(async (ids: string[]) => DONE(ids))
    const onFocusTabs = vi.fn()
    renderTab({ job: failedJob(), onFocusTabs }, { acknowledge })
    await press(RESULT_WORDS.acknowledge)
    expect(onFocusTabs).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^Next:/ })).toBeNull()
  })

  it('keeps Acknowledge when main refuses it', async () =>
  {
    const acknowledge = vi.fn(async () => ({ status: 'refused', code: 'nothing', message: 'No.' }))
    const onFocusTabs = vi.fn()
    renderTab({ job: failedJob(), onFocusTabs }, { acknowledge })
    await press(RESULT_WORDS.acknowledge)
    expect(onFocusTabs).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: RESULT_WORDS.acknowledge })).toBeInTheDocument()
  })

  it('asks for the acknowledgment inline before a retry that replaces files', async () =>
  {
    const ack = { preflightId: 'p1', originalsAffected: 1, overwrites: 0 }
    const retry = vi.fn()
      .mockResolvedValueOnce({ status: 'needs-acknowledgment', ack })
      .mockResolvedValueOnce({ status: 'done', value: { queued: ['MM-0139'], changed: [], refused: [] }, seq: 4 })
    renderTab({ job: failedJob() }, { retry })
    await press(RESULT_WORDS.retry)
    expect(retry).toHaveBeenLastCalledWith(['MM-0139'], {})
    const box = screen.getByRole('checkbox')
    expect(screen.getByRole('button', { name: RESULT_WORDS.retry })).toBeDisabled()
    fireEvent.click(box)
    expect(screen.getByRole('button', { name: RESULT_WORDS.retry })).not.toBeDisabled()
    await press(RESULT_WORDS.retry)
    expect(retry).toHaveBeenLastCalledWith(['MM-0139'], { ack })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('stamps a verified job with the measured values only, then the table, sizes, and output', () =>
  {
    const onReveal = vi.fn()
    const measured = stamp({ loudness: { ...stamp().loudness!, lufs: -19.1, reference: 'reachable', referenceLufs: -19.1 } })
    const job = jobView('MM-0139', { state: 'done', stamp: measured, acknowledged: true, runId: 'R-0031' as JobView['runId'] })
    const detail = jobDetail(job, {
      measurement: measurementOf([streamMeasurement(0), gainPlan(0, { targetLufs: -18, predictedLufs: -19.1 })]),
      verification: verificationOf([verifiedStream(0, { integratedLufs: -19.1 }), streamVerdict(0)]),
      result: jobResult({ stamp: measured }),
      stages: stages(['probe', 'done'], ['measure', 'done'], ['encode', 'done'], ['verify', 'done'], ['place', 'done'])
    })
    const { container } = renderTab({ job, detail, onReveal })
    const stampText = container.querySelector('[data-part="stamp"]')?.textContent ?? ''
    expect(stampText).toMatch(/verified/i)
    expect(stampText).toContain(`${MINUS}19.1 LUFS`)
    expect(stampText).not.toContain(`${MINUS}18.0`)
    expect(screen.getByRole('region', { name: TABLE_WORDS.caption })).toBeInTheDocument()
    expect(screen.getByText(`412 MB (${MINUS}71%)`)).toBeInTheDocument()
    expect(screen.getByText('D:\\Exports\\MM-0139.flac')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(onReveal).toHaveBeenCalledWith('D:\\Exports\\MM-0139.flac')
    expect(screen.queryByRole('button', { name: RESULT_WORDS.acknowledge })).toBeNull()
    expect(screen.queryByRole('button', { name: RESULT_WORDS.retry })).toBeNull()
  })

  it('shows no stamp for a done job that has no measurement', () =>
  {
    const job = jobView('MM-0144', { state: 'done', stamp: null })
    const { container } = renderTab({ job, detail: jobDetail(job) })
    expect(container.querySelector('[data-part="stamp"]')).toBeNull()
  })

  it('offers Retry and Acknowledge on a placed output outside tolerance', () =>
  {
    const warning = { code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'The output was placed because it replaced nothing.' } as JobView['warnings'][number]
    const job = jobView('MM-0145', { state: 'done', stamp: stamp({ verdict: 'outside-tolerance' }), warnings: [warning], acknowledged: false })
    const { container } = renderTab({ job, detail: jobDetail(job, { result: jobResult({ warnings: [warning] }) }), onEditAndRetry: vi.fn() })
    expect(container.querySelector('[data-part="stamp"]')?.textContent).toMatch(/returned/i)
    expect(screen.getByText(warning.message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESULT_WORDS.retry })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESULT_WORDS.editAndRetry })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESULT_WORDS.acknowledge })).toBeInTheDocument()
  })

  it('shows the live numbers, the stages to come, and the measured values while running', () =>
  {
    const job = jobView('MM-0146', { state: 'encoding', progress: progress() })
    const detail = jobDetail(job, {
      measurement: measurementOf([streamMeasurement(0), gainPlan(0)]),
      stages: stages(['probe', 'done'], ['measure', 'done'], ['encode', 'active', 1, 2])
    })
    const { container } = renderTab({ job, detail })
    expect(screen.getByRole('region', { name: RESULT_WORDS.live })).toBeInTheDocument()
    expect(screen.getByText('46%')).toBeInTheDocument()
    expect(screen.getByText('6.2x')).toBeInTheDocument()
    expect(screen.getByText('7 min 40 s')).toBeInTheDocument()
    expect(screen.getByText('312 MB')).toBeInTheDocument()
    expect(container.querySelector('[data-part="stamp"]')).toBeNull()
    expect(screen.getAllByText(TABLE_WORDS.notYet).length).toBeGreaterThan(0)
    expect(screen.getByText('Verify')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: RESULT_WORDS.actions })).toBeNull()
  })

  it('shows a decision with its buttons, stamped only when outside tolerance', () =>
  {
    const held = heldJob()
    const { container, rerender } = renderTab({ job: { ...held, stamp: stamp() } })
    expect(screen.getByText(hold().message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: DECISION_LABELS.keep })).toBeInTheDocument()
    expect(container.querySelector('[data-part="stamp"]')).toBeNull()
    expect(screen.queryByRole('button', { name: RESULT_WORDS.acknowledge })).toBeNull()
    rerender(
      <TestBatchActionsProvider>
        <ResultTab job={{ ...held, stamp: stamp({ verdict: 'outside-tolerance' }) }} detail={jobDetail(held)} />
      </TestBatchActionsProvider>
    )
    expect(container.querySelector('[data-part="stamp"]')?.textContent).toMatch(/returned/i)
    expect(screen.getByRole('region', { name: ATTEMPTS_CAPTION })).toBeInTheDocument()
  })

  it('reads Finish saving for an output interrupted while saving', () =>
  {
    renderTab({ job: heldJob('MM-0152', { reason: 'interrupted-finalize', displaces: null }) })
    expect(screen.getByRole('button', { name: 'Finish saving' })).toBeInTheDocument()
  })

  it('passes a decision retry acknowledgment to the inline check', async () =>
  {
    const ack = { preflightId: 'p2', originalsAffected: 0, overwrites: 1 }
    const retry = vi.fn().mockResolvedValue({ status: 'needs-acknowledgment', ack })
    renderTab({ job: heldJob() }, { retry })
    await press(DECISION_LABELS.retry)
    await press('Retry')
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })

  it('words the jobs that never ran or stopped', () =>
  {
    const { container, rerender } = renderTab({ job: jobView('MM-0147', { state: 'queued', runId: 'R-0031' as JobView['runId'] }) })
    expect(screen.getByText('Queued in Batch 31. Results appear here when it runs.')).toBeInTheDocument()
    expect(screen.getByText('Probe')).toBeInTheDocument()
    const again = (job: JobView): void => rerender(
      <TestBatchActionsProvider>
        <ResultTab job={job} detail={null} />
      </TestBatchActionsProvider>
    )
    again(jobView('MM-0148'))
    expect(screen.getByText(RESULT_WORDS.notStarted)).toBeInTheDocument()
    again(jobView('MM-0149', { state: 'canceled' }))
    expect(screen.getByText(RESULT_WORDS.canceled)).toBeInTheDocument()
    expect(container.querySelector('[data-part="stamp"]')).toBeNull()
    expect(screen.getByRole('button', { name: RESULT_WORDS.retry })).toBeInTheDocument()
    again(jobView('MM-0150', { state: 'skipped' }))
    expect(screen.getByText(RESULT_WORDS.skipped)).toBeInTheDocument()
    again(jobView('MM-0151', { state: 'interrupted' }))
    expect(screen.getByText(RESULT_WORDS.interrupted)).toBeInTheDocument()
    expect(container.querySelector('[data-part="stamp"]')?.textContent).toContain('Interrupted')
    expect(screen.getByRole('button', { name: RESULT_WORDS.acknowledge })).toBeInTheDocument()
  })
})
