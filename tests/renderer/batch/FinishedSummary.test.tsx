/**
 * The finished summary: outcome counts as display numbers that keep acknowledged jobs, sizes and times, the
 * Replace ended line, one line per measured recipe naming its check, album lines, returned jobs grouped by reason,
 * Acknowledge all skipping decisions, and the next-batch line.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import
{
  RecipeOutcomeLines,
  albumLetter,
  albumLine,
  checkPhrase,
  compressLine,
  gainLine,
  normalizeLine,
  outcomeLines,
  recipeLine,
  recipeName
} from '../../../src/renderer/src/components/batch/summary/RecipeOutcomeLines'
import
{
  RETURNED_HEADING,
  ReasonGroups,
  acknowledgeAllPlan,
  acknowledgeAllReason,
  acknowledgedAllText,
  groupText,
  isReturned,
  reasonGroups,
  returnedIds,
  returnedReason,
  type ReturnedSubject
} from '../../../src/renderer/src/components/batch/summary/ReasonGroups'
import
{
  FinishedSummary,
  NEXT_BATCH_LINE,
  clearDoneLabel,
  newJobsPolicy,
  outcomeCounts,
  replaceEndedLine,
  returnedBreakdown,
  showMoreLabel,
  sizesLine,
  type FinishedSummaryProps
} from '../../../src/renderer/src/components/batch/summary/FinishedSummary'
import { formatCatalog, formatRunId, type JobId } from '../../../src/shared/jobs/ids'
import type { AlbumSummary, BatchPolicy, BatchSummary, JobHold, JobState, JobWarning, RecipeOutcome } from '../../../src/shared/jobs/types'

const M = '−'
const RUN = formatRunId(31)
const job = (seq: number): JobId => formatCatalog(seq)

type Loudness = NonNullable<RecipeOutcome['loudness']>

function loudness(patch: Partial<Loudness> = {}): Loudness
{
  return {
    unit: 'LKFS',
    targetLufs: -16,
    deviationUnit: 'dB',
    checks: [{ checkClass: 'lossless', check: 0.5, jobs: 4, within: 4 }, { checkClass: 'lossy', check: 1, jobs: 5, within: 5 }],
    minLufs: -16.2,
    maxLufs: -15.9,
    streams: 9,
    maxTruePeakDbtp: -1.6,
    limitedJobs: 0,
    maxLimitingDb: null,
    reachableLevels: [],
    ...patch
  }
}

function outcome(patch: Partial<RecipeOutcome> = {}): RecipeOutcome
{
  return {
    op: 'normalize',
    label: 'Normalize · Apple Podcasts',
    presetId: 'apple-podcasts',
    userPresetId: null,
    jobs: 9,
    verified: 9,
    reachable: 0,
    outsideTolerance: 0,
    returned: 0,
    loudness: loudness(),
    size: null,
    ...patch
  }
}

afterEach(() =>
{
  cleanup()
})

describe('recipe outcome lines', () =>
{
  it('names a recipe by its preset, else by its label without the operation word', () =>
  {
    expect(recipeName(outcome())).toBe('Apple Podcasts')
    expect(recipeName(outcome({ op: 'boost', presetId: 'louder' }))).toBe('Louder')
    expect(recipeName(outcome({ op: 'compress', presetId: null, label: 'Compress · Target 25 MB' }))).toBe('Target 25 MB')
    expect(recipeName(outcome({ op: 'compress', presetId: 'nope', label: 'Small files' }))).toBe('Small files')
  })

  it('words one check, several checks, and none', () =>
  {
    expect(checkPhrase(loudness())).toBe('their checks (±0.5 dB lossless, ±1.0 dB lossy)')
    expect(checkPhrase(loudness({ deviationUnit: 'LU', checks: [{ checkClass: 'lossy', check: 0.2, jobs: 3, within: 3 }, { checkClass: 'lossless', check: 0.2, jobs: 3, within: 3 }] }))).toBe('±0.2 LU')
    expect(checkPhrase(loudness({ checks: [] }))).toBeNull()
    expect(checkPhrase(loudness({ checks: [{ checkClass: 'lossy', check: 1, jobs: 0, within: 0 }] }))).toBeNull()
  })

  it('reads a Normalize line with its target, checks, range, and highest true peak', () =>
  {
    const line = normalizeLine(outcome())
    expect(line?.text).toBe(`Apple Podcasts, ${M}16 LKFS: 9 verified within their checks (±0.5 dB lossless, ±1.0 dB lossy), ${M}16.2 to ${M}15.9 LKFS. Highest true peak ${M}1.6 dBTP.`)
    expect(line?.check).toBe('their checks (±0.5 dB lossless, ±1.0 dB lossy)')
  })

  it('reads one check as one value, the way EBU R 128 states it', () =>
  {
    const line = normalizeLine(outcome({
      label: 'Normalize · EBU R 128',
      presetId: 'ebu-r128',
      jobs: 6,
      verified: 6,
      loudness: loudness({ unit: 'LUFS', targetLufs: -23, deviationUnit: 'LU', checks: [{ checkClass: 'lossless', check: 0.2, jobs: 6, within: 6 }], minLufs: -23.1, maxLufs: -22.9, streams: 6, maxTruePeakDbtp: null })
    }))
    expect(line?.text).toBe(`EBU R 128, ${M}23.0 LUFS: 6 verified within ±0.2 LU, ${M}23.1 to ${M}22.9 LUFS.`)
    expect(line?.check).toBe('±0.2 LU')
  })

  it('counts streams when outputs carry several audio streams', () =>
  {
    const line = normalizeLine(outcome({ jobs: 7, verified: 7, loudness: loudness({ streams: 14 }) }))
    expect(line?.text).toContain(`${M}16.2 to ${M}15.9 LKFS across 14 streams.`)
  })

  it('adds the reachable and outside-tolerance counts when present', () =>
  {
    const line = normalizeLine(outcome({
      jobs: 11,
      verified: 9,
      reachable: 1,
      outsideTolerance: 1,
      loudness: loudness({ reachableLevels: [-17.4], checks: [{ checkClass: 'lossless', check: 0.5, jobs: 4, within: 4 }, { checkClass: 'lossy', check: 1, jobs: 7, within: 6 }], streams: 11 })
    }))
    expect(line?.text).toBe(
      `Apple Podcasts, ${M}16 LKFS: 9 verified within their checks (±0.5 dB lossless, ±1.0 dB lossy), ${M}16.2 to ${M}15.9 LKFS. ` +
      `1 job verified at the reachable level (${M}17.4 LKFS) and 1 job outside tolerance against the ±1.0 dB check. Highest true peak ${M}1.6 dBTP.`
    )
  })

  it('words a range of reachable levels and outside-tolerance jobs across several checks', () =>
  {
    const line = normalizeLine(outcome({
      reachable: 2,
      outsideTolerance: 2,
      loudness: loudness({ reachableLevels: [-18.2, -17.1, Number.NaN], checks: [{ checkClass: 'lossless', check: 0.5, jobs: 4, within: 3 }, { checkClass: 'lossy', check: 1, jobs: 5, within: 4 }], minLufs: -16, maxLufs: -16, streams: 2 })
    }))
    expect(line?.text).toContain(`2 jobs verified at the reachable level (${M}18.2 to ${M}17.1 LKFS)`)
    expect(line?.text).toContain('2 jobs outside tolerance against their checks.')
    expect(line?.text).toContain(`9 verified within their checks (±0.5 dB lossless, ±1.0 dB lossy), ${M}16.0 LKFS.`)
  })

  it('words counts without levels or checks', () =>
  {
    const line = normalizeLine(outcome({
      presetId: 'custom',
      label: 'Normalize · Custom',
      reachable: 1,
      outsideTolerance: 1,
      loudness: loudness({ unit: 'LUFS', targetLufs: null, checks: [], minLufs: null, maxLufs: null, maxTruePeakDbtp: null })
    }))
    expect(line?.text).toBe('Custom: 9 verified. 1 job verified at the reachable level and 1 job outside tolerance.')
    expect(line?.check).toBeNull()
    expect(normalizeLine(outcome({ loudness: null }))).toBeNull()
  })

  it('reads a Gain line with its limiting', () =>
  {
    const line = gainLine(outcome({ op: 'boost', label: 'Gain · Louder', presetId: 'louder', jobs: 4, verified: 4, loudness: loudness({ checks: [], limitedJobs: 1, maxLimitingDb: 1.8 }) }))
    expect(line.text).toBe('Gain · Louder: 4 verified; peak limiting on 1 job, at most 1.8 dB.')
    const checked = gainLine(outcome({ op: 'boost', presetId: 'louder', verified: 3, loudness: loudness({ checks: [{ checkClass: 'lossy', check: 1, jobs: 3, within: 3 }], limitedJobs: 2, maxLimitingDb: null }) }))
    expect(checked.text).toBe('Gain · Louder: 3 verified within ±1.0 dB; peak limiting on 2 jobs.')
    expect(checked.check).toBe('±1.0 dB')
    expect(gainLine(outcome({ op: 'boost', presetId: 'louder', verified: 2, loudness: null })).text).toBe('Gain · Louder: 2 verified.')
  })

  it('reads a Compress line only for a size target', () =>
  {
    const line = compressLine(outcome({ op: 'compress', presetId: null, label: 'Compress · Target 25 MB', jobs: 2, loudness: null, size: { targetBytes: 25_000_000, jobs: 2, within: 2 } }))
    expect(line?.text).toBe('Compress · Target 25 MB: 2 of 2 at or under 25 MB.')
    expect(line?.check).toBe('at or under 25 MB')
    expect(compressLine(outcome({ op: 'compress', size: null }))).toBeNull()
  })

  it('dispatches by operation and skips recipes without a measured outcome', () =>
  {
    expect(recipeLine(outcome())?.kind).toBe('recipe')
    expect(recipeLine(outcome({ op: 'boost', presetId: 'louder' }))?.text.startsWith('Gain · Louder')).toBe(true)
    expect(recipeLine(outcome({ op: 'compress', size: null }))).toBeNull()
    expect(recipeLine(outcome({ op: 'convert' }))).toBeNull()
    expect(recipeLine(outcome({ op: 'extract' }))).toBeNull()
  })

  it('reads an album line from the audio album sentence', () =>
  {
    const album: AlbumSummary = { groupId: 'g1', members: 4, anchorJobId: job(12), anchorLufs: -7.9, gainDb: -10.1, reason: 'fits' }
    const line = albumLine(album, 0, { nameOf: () => 'loudmaster.wav', presetOf: () => 'streaming-r128s2' })
    expect(line.text).toBe(`Album A: one gain of ${M}10.1 dB for 4 tracks, anchored on the loudest track, loudmaster.wav at ${M}7.9 LUFS (EBU R 128 s2 (i)).`)
    expect(line.kind).toBe('album')
    const bare = albumLine(album, 1)
    expect(bare.text).toContain('Album B:')
    expect(bare.text).toContain(`${job(12)} at`)
    expect(albumLine(album, 0, { albumName: () => 'Live set' }).text.startsWith('Album Live set:')).toBe(true)
  })

  it('letters albums past Z', () =>
  {
    expect(albumLetter(0)).toBe('A')
    expect(albumLetter(25)).toBe('Z')
    expect(albumLetter(26)).toBe('AA')
    expect(albumLetter(27)).toBe('AB')
  })

  it('lists recipe lines in main\'s order, then albums', () =>
  {
    const lines = outcomeLines({
      recipes: [outcome(), outcome({ op: 'convert', label: 'Convert · MP4' }), outcome({ op: 'boost', label: 'Gain · Louder', presetId: 'louder' })],
      albums: [{ groupId: 'g1', members: 2, anchorJobId: job(3), anchorLufs: -9, gainDb: -7, reason: 'fits' }]
    })
    expect(lines.map((line) => line.key)).toEqual(['recipe:Normalize · Apple Podcasts', 'recipe:Gain · Louder', 'album:g1'])
  })

  it('renders the lines and nothing without any', () =>
  {
    const lines = outcomeLines({ recipes: [outcome()], albums: [] })
    render(<RecipeOutcomeLines lines={lines} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Apple Podcasts')
    cleanup()
    const { container } = render(<RecipeOutcomeLines lines={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

const OUTSIDE: JobWarning = { code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'Measured off target.' }
const CPU: JobWarning = { code: 'ran-on-cpu', short: 'Ran on the CPU', message: 'NVENC was busy.' }

function subject(seq: number, state: JobState, patch: Partial<ReturnedSubject> = {}): ReturnedSubject
{
  return { id: job(seq), seq, state, acknowledged: false, warnings: [], error: null, hold: null, runId: RUN, ...patch }
}

function failed(seq: number, short: string, message: string, acknowledged = false): ReturnedSubject
{
  return subject(seq, 'failed', { acknowledged, error: { code: 'decode-failed' as never, short, message, stage: 'encode' as never, at: 0 } })
}

function held(seq: number, reason: JobHold['reason']): ReturnedSubject
{
  return subject(seq, 'held', { hold: { reason, message: 'The output measured outside tolerance.', outputPath: 'D:\\x.flac', displaces: null, actions: ['keep', 'discard', 'retry'], since: 0 } })
}

describe('reason groups', () =>
{
  it('counts failed, interrupted, held, and placed outside tolerance as returned, acknowledged or not', () =>
  {
    expect(isReturned(subject(1, 'failed', { acknowledged: true }))).toBe(true)
    expect(isReturned(subject(1, 'interrupted'))).toBe(true)
    expect(isReturned(subject(1, 'held'))).toBe(true)
    expect(isReturned(subject(1, 'done', { warnings: [OUTSIDE], acknowledged: true }))).toBe(true)
    expect(isReturned(subject(1, 'done', { warnings: [CPU] }))).toBe(false)
    expect(isReturned(subject(1, 'canceled'))).toBe(false)
  })

  it('reads each returned job\'s short reason', () =>
  {
    expect(returnedReason(failed(1, 'Decode failed', 'FFmpeg could not decode the source.'))).toEqual({ short: 'Decode failed', sentence: 'FFmpeg could not decode the source.', decision: false })
    expect(returnedReason(subject(1, 'failed'))).toEqual({ short: 'Failed', sentence: null, decision: false })
    expect(returnedReason(subject(1, 'interrupted'))?.short).toBe('Interrupted')
    expect(returnedReason(held(1, 'interrupted-finalize'))).toEqual({ short: 'Interrupted while saving', sentence: 'The output measured outside tolerance.', decision: true })
    expect(returnedReason(held(1, 'destination-appeared'))?.short).toBe('File appeared, needs a decision')
    expect(returnedReason(subject(1, 'held'))).toEqual({ short: 'Needs a decision', sentence: null, decision: true })
    expect(returnedReason(subject(1, 'done', { warnings: [OUTSIDE] }))?.short).toBe('Outside tolerance')
    expect(returnedReason(subject(1, 'done', { warnings: [{ ...OUTSIDE, short: '' }] }))?.short).toBe('Outside tolerance')
    expect(returnedReason(subject(1, 'done', { warnings: [CPU] }))).toBeNull()
    expect(returnedReason(subject(1, 'skipped'))).toBeNull()
  })

  it('groups by short reason, largest first, keeping acknowledged jobs and the shared sentence', () =>
  {
    const jobs = [
      failed(5, 'Disk full on D:', 'D: filled twice.'),
      failed(2, 'Decode failed', 'Invalid data A.', true),
      failed(3, 'Decode failed', 'Invalid data B.'),
      subject(4, 'done', { warnings: [OUTSIDE] }),
      held(6, 'outside-tolerance'),
      { ...failed(9, 'Decode failed', 'x'), runId: formatRunId(30) },
      subject(7, 'done', { warnings: [CPU] }),
      failed(8, 'Decode failed', 'y')
    ]
    const groups = reasonGroups(jobs, RUN)
    expect(groups.map((group) => group.short)).toEqual(['Decode failed', 'Outside tolerance', 'Disk full on D:', 'Needs a decision'])
    expect(groups[0].jobIds).toEqual([job(2), job(3), job(8)])
    expect(groups[0].attention).toBe(2)
    expect(groups[0].sentence).toBeNull()
    expect(groups[2].sentence).toBe('D: filled twice.')
    expect(groups[3].decision).toBe(true)
    expect(reasonGroups(jobs).find((group) => group.short === 'Decode failed')?.jobIds).toHaveLength(4)
  })

  it('selects every returned job of the batch in catalog order', () =>
  {
    const jobs = [failed(3, 'Decode failed', 'a', true), subject(1, 'interrupted'), subject(2, 'done'), { ...subject(4, 'failed'), runId: null }]
    expect(returnedIds(jobs, RUN)).toEqual([job(1), job(3)])
    expect(returnedIds(jobs)).toEqual([job(1), job(3), job(4)])
  })

  it('plans Acknowledge all to skip decisions and count them', () =>
  {
    const jobs = [
      failed(1, 'Decode failed', 'a'),
      failed(2, 'Decode failed', 'a', true),
      subject(3, 'done', { warnings: [CPU] }),
      held(4, 'file-locked'),
      subject(5, 'interrupted'),
      { ...subject(6, 'failed'), runId: formatRunId(30) },
      subject(7, 'done')
    ]
    const plan = acknowledgeAllPlan(jobs, RUN)
    expect(plan).toEqual({ ids: [job(1), job(3), job(5)], decisions: 1 })
    expect(acknowledgeAllPlan(jobs).ids).toHaveLength(4)
    expect(acknowledgedAllText(plan.ids.length, plan.decisions)).toBe('Acknowledged 3 jobs. 1 job still needs a decision.')
    expect(acknowledgedAllText(1, 0)).toBe('Acknowledged 1 job.')
    expect(acknowledgedAllText(2, 3)).toBe('Acknowledged 2 jobs. 3 jobs still need a decision.')
    expect(acknowledgeAllReason(plan)).toBeNull()
    expect(acknowledgeAllReason({ ids: [], decisions: 2 })).toBe('Nothing left to acknowledge. 2 jobs still need a decision.')
    expect(acknowledgeAllReason({ ids: [], decisions: 0 })).toBe('Nothing left to acknowledge.')
  })

  it('words a group with or without its sentence', () =>
  {
    expect(groupText({ short: 'Decode failed', sentence: 'FFmpeg could not decode the source.' })).toBe('Decode failed: FFmpeg could not decode the source.')
    expect(groupText({ short: 'Decode failed', sentence: null })).toBe('Decode failed')
  })

  it('renders groups with their actions, and decisions with Select only', () =>
  {
    const onSelect = vi.fn()
    const onRetry = vi.fn()
    const onEditAndRetry = vi.fn()
    const onAcknowledgeAll = vi.fn()
    const jobs = [failed(1, 'Decode failed', 'Invalid data.'), failed(2, 'Decode failed', 'Invalid data.'), held(3, 'outside-tolerance')]
    render(
      <ReasonGroups
        groups={reasonGroups(jobs, RUN)}
        returned={returnedIds(jobs, RUN)}
        acknowledgePlan={acknowledgeAllPlan(jobs, RUN)}
        onSelect={onSelect}
        onRetry={onRetry}
        onEditAndRetry={onEditAndRetry}
        onAcknowledgeAll={onAcknowledgeAll}
        acknowledgedText="Acknowledged 2 jobs. 1 job still needs a decision."
      />
    )
    expect(screen.getByText(RETURNED_HEADING)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Acknowledged 2 jobs. 1 job still needs a decision.')
    const [decode, decision] = screen.getAllByRole('listitem')
    expect(decode).toHaveTextContent(/^Decode failed2 jobsInvalid data\./)
    expect(within(decode).getByText('2 jobs')).toBeInTheDocument()
    fireEvent.click(within(decode).getByRole('button', { name: 'Retry these' }))
    expect(onRetry).toHaveBeenCalledWith([job(1), job(2)])
    fireEvent.click(within(decode).getByRole('button', { name: 'Edit and retry' }))
    expect(onEditAndRetry).toHaveBeenCalledWith([job(1), job(2)])
    expect(within(decision).queryByRole('button', { name: 'Retry these' })).toBeNull()
    fireEvent.click(within(decision).getByRole('button', { name: 'Select' }))
    expect(onSelect).toHaveBeenCalledWith([job(3)])
    fireEvent.click(screen.getByRole('button', { name: 'Select returned' }))
    expect(onSelect).toHaveBeenLastCalledWith([job(1), job(2), job(3)])
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }))
    expect(onAcknowledgeAll).toHaveBeenCalledTimes(1)
  })

  it('keeps Acknowledge all unavailable with its reason when only decisions remain', () =>
  {
    const onAcknowledgeAll = vi.fn()
    const jobs = [held(3, 'outside-tolerance')]
    render(
      <ReasonGroups
        groups={reasonGroups(jobs)}
        returned={returnedIds(jobs)}
        acknowledgePlan={acknowledgeAllPlan(jobs)}
        onSelect={() => {}}
        onRetry={() => {}}
        onEditAndRetry={() => {}}
        onAcknowledgeAll={onAcknowledgeAll}
      />
    )
    const button = screen.getByRole('button', { name: 'Acknowledge all' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(onAcknowledgeAll).not.toHaveBeenCalled()
  })

  it('renders nothing when no job returned', () =>
  {
    const { container } = render(
      <ReasonGroups groups={[]} returned={[]} acknowledgePlan={{ ids: [], decisions: 0 }} onSelect={() => {}} onRetry={() => {}} onEditAndRetry={() => {}} onAcknowledgeAll={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

const FOLDER_POLICY: BatchPolicy = { rev: 2, destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

function counts(patch: Partial<BatchSummary['counts']> = {}): BatchSummary['counts']
{
  return { total: 22, done: 20, verified: 19, reachable: 0, outsideTolerance: 1, failed: 1, canceled: 1, skipped: 0, held: 0, interrupted: 0, returned: 2, ...patch }
}

function summary(patch: Partial<BatchSummary> = {}): BatchSummary
{
  return {
    runId: RUN,
    startedAt: 0,
    endedAt: 2_530_000,
    elapsedMs: 2_530_000,
    endedBy: 'completed',
    interruptions: 0,
    counts: counts(),
    bytes: { input: 25_800_000_000, output: 21_400_000_000 },
    mediaSec: 9 * 3600 + 49 * 60,
    originals: { trashed: 0, kept: 0, volumes: [] },
    previous: { trashed: 0, kept: 0 },
    recipes: [outcome()],
    albums: [],
    failures: [],
    policy: { ...FOLDER_POLICY, frozenAt: 0, date: '2026-10-18' },
    ffmpeg: { version: '9.0.2', source: 'bundled' },
    appVersion: '5.0.0',
    ...patch
  }
}

function props(patch: Partial<FinishedSummaryProps> = {}): FinishedSummaryProps
{
  return {
    summary: summary(),
    jobs: [],
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onEditAndRetry: vi.fn(),
    onAcknowledgeAll: vi.fn(),
    ...patch
  }
}

describe('finished summary words', () =>
{
  it('breaks returned down by what happened', () =>
  {
    expect(returnedBreakdown(counts())).toBe('1 failed · 1 outside tolerance')
    expect(returnedBreakdown(counts({ failed: 0, outsideTolerance: 0, interrupted: 2, held: 1, returned: 3 }))).toBe('2 interrupted · 1 waiting for a decision')
    expect(returnedBreakdown(counts({ returned: 0, failed: 0, outsideTolerance: 0 }))).toBeNull()
    expect(returnedBreakdown(counts({ returned: 1, failed: 0, outsideTolerance: 0 }))).toBeNull()
  })

  it('lists verified, returned, and canceled, then skipped when any', () =>
  {
    expect(outcomeCounts(counts()).map((count) => `${count.value} ${count.word}`)).toEqual(['19 verified', '2 returned', '1 canceled'])
    expect(outcomeCounts(counts({ skipped: 3 })).map((count) => count.key)).toEqual(['verified', 'returned', 'canceled', 'skipped'])
  })

  it('reads sizes, media time, and elapsed time', () =>
  {
    expect(sizesLine(summary())).toBe(`25.8 GB in · 21.4 GB out (${M}17%) · 9 h 49 min of media in 42 min 10 s`)
    expect(sizesLine(summary({ bytes: { input: 0, output: 0 }, mediaSec: 45, elapsedMs: 50_000 }))).toBe('0 B in · 0 B out · 45 s of media in 50 s')
  })

  it('says Replace originals ended and where new jobs write', () =>
  {
    const replaced = summary({ policy: { ...FOLDER_POLICY, destination: { mode: 'replace-originals' }, frozenAt: 0, date: '' } })
    expect(replaceEndedLine(replaced, FOLDER_POLICY)).toBe('Replace originals ended with Batch 31. New jobs write to D:\\Exports.')
    expect(replaceEndedLine(replaced, { ...FOLDER_POLICY, destination: { mode: 'next-to-source' } })).toBe('Replace originals ended with Batch 31. New jobs write next to each source.')
    expect(replaceEndedLine(replaced, null)).toBe('Replace originals ended with Batch 31.')
    expect(replaceEndedLine(summary(), FOLDER_POLICY)).toBeNull()
    expect(newJobsPolicy({ ...FOLDER_POLICY, destination: { mode: 'replace-originals' } })).toBe('write next to each source')
  })

  it('labels the next-batch and show-more controls', () =>
  {
    expect(NEXT_BATCH_LINE).toBe('Next batch: add files, then Review and Start.')
    expect(clearDoneLabel(1204)).toBe('Clear done (1,204)')
    expect(showMoreLabel(3)).toBe('Show 3 more')
  })
})

describe('FinishedSummary', () =>
{
  it('keeps counting acknowledged jobs in its outcome counts', () =>
  {
    const jobs = [failed(1, 'Decode failed', 'x', true), subject(2, 'done', { warnings: [OUTSIDE], acknowledged: true })]
    const { container } = render(<FinishedSummary {...props({ jobs })} />)
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveTextContent('19verified')
    expect(container.querySelector('[data-count="returned"]')).toHaveTextContent('2returned1 failed · 1 outside tolerance')
    expect(container.querySelector('[data-count="canceled"]')).toHaveTextContent('1canceled')
    expect(screen.getByText(`25.8 GB in · 21.4 GB out (${M}17%) · 9 h 49 min of media in 42 min 10 s`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Acknowledge all' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByRole('listitem').map((item) => item.getAttribute('data-reason') ?? item.getAttribute('data-line-kind')))
      .toEqual(['recipe', 'Decode failed', 'Outside tolerance'])
  })

  it('acknowledges all but decisions, says how many remain, and focuses the summary heading', () =>
  {
    const onAcknowledgeAll = vi.fn()
    const jobs = [failed(1, 'Decode failed', 'x'), held(2, 'outside-tolerance'), subject(3, 'done', { warnings: [CPU] }), failed(4, 'Decode failed', 'x', true)]
    render(<FinishedSummary {...props({ jobs, onAcknowledgeAll, summary: summary({ counts: counts({ held: 1, returned: 3 }) }) })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }))
    expect(onAcknowledgeAll).toHaveBeenCalledWith([job(1), job(3)])
    expect(screen.getByRole('status')).toHaveTextContent('Acknowledged 2 jobs. 1 job still needs a decision.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }))
  })

  it('passes group and returned selections through', () =>
  {
    const onSelect = vi.fn()
    const onRetry = vi.fn()
    const onEditAndRetry = vi.fn()
    const jobs = [failed(1, 'Decode failed', 'x'), failed(2, 'Decode failed', 'x', true), subject(3, 'done')]
    render(<FinishedSummary {...props({ jobs, onSelect, onRetry, onEditAndRetry })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry these' }))
    expect(onRetry).toHaveBeenCalledWith([job(1), job(2)])
    fireEvent.click(screen.getByRole('button', { name: 'Edit and retry' }))
    expect(onEditAndRetry).toHaveBeenCalledWith([job(1), job(2)])
    fireEvent.click(screen.getByRole('button', { name: 'Select returned' }))
    expect(onSelect).toHaveBeenCalledWith([job(1), job(2)])
  })

  it('shares its line limit between recipe lines and reason groups, behind Show more', () =>
  {
    const jobs = [failed(1, 'Decode failed', 'x'), failed(2, 'Disk full on D:', 'y')]
    const recipes = [outcome(), outcome({ op: 'boost', label: 'Gain · Louder', presetId: 'louder' })]
    render(<FinishedSummary {...props({ jobs, limit: 3, summary: summary({ recipes }) })} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    const more = screen.getByRole('button', { name: 'Show 1 more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('hides reason groups entirely when the recipe lines fill the limit', () =>
  {
    render(<FinishedSummary {...props({ jobs: [failed(1, 'Decode failed', 'x')], limit: 1 })} />)
    expect(screen.queryByText('Returned, by reason. They stay marked until you acknowledge them.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeInTheDocument()
  })

  it('shows the Replace ended line with Change output after a Replace batch', () =>
  {
    const onChangeOutput = vi.fn()
    const replaced = summary({ policy: { ...FOLDER_POLICY, destination: { mode: 'replace-originals' }, frozenAt: 0, date: '' } })
    render(<FinishedSummary {...props({ summary: replaced, currentPolicy: FOLDER_POLICY, onChangeOutput })} />)
    expect(screen.getByText('Replace originals ended with Batch 31. New jobs write to D:\\Exports.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change output' }))
    expect(onChangeOutput).toHaveBeenCalled()
    cleanup()
    render(<FinishedSummary {...props({ summary: replaced })} />)
    expect(screen.getByText('Replace originals ended with Batch 31.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change output' })).toBeNull()
  })

  it('offers the next batch with Add files and Clear done', () =>
  {
    const onAddFiles = vi.fn()
    const onClearDone = vi.fn()
    render(<FinishedSummary {...props({ clearDone: 19, onAddFiles, onClearDone })} />)
    expect(screen.getByText(NEXT_BATCH_LINE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear done (19)' }))
    expect(onAddFiles).toHaveBeenCalled()
    expect(onClearDone).toHaveBeenCalled()
  })

  it('leaves out Clear done when nothing is done, and the next-batch line without a count', () =>
  {
    const { rerender } = render(<FinishedSummary {...props({ clearDone: 0 })} />)
    expect(screen.queryByRole('button', { name: /Clear done/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
    rerender(<FinishedSummary {...props({ clearDone: null })} />)
    expect(screen.queryByText(NEXT_BATCH_LINE)).toBeNull()
  })

  it('ignores Acknowledge all when nothing is left to acknowledge', () =>
  {
    const onAcknowledgeAll = vi.fn()
    render(<FinishedSummary {...props({ jobs: [held(1, 'file-locked')], onAcknowledgeAll })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge all' }))
    expect(onAcknowledgeAll).not.toHaveBeenCalled()
  })
})
