/**
 * The Review summary and the slot that holds it: counts, consequences, the acknowledgment that stays checked while
 * preview measurements land and unchecks only when a count changes, issue groups whose fixes state their scope and
 * hand focus on when a group empties, and "Hide summary", which never hides an acknowledgment that gates Start.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { BatchPolicy, BatchSummary, PlanFix, PlanIssue, PreflightReport, VolumeReport } from '../../../src/shared/jobs/types'
import { createBatchViewStore } from '../../../src/renderer/src/stores/batchView'
import
{
  IssueGroups,
  fixLabel,
  fixedText,
  groupIssues,
  issueActionLabel,
  issueActions,
  moreIssuesLabel,
  type IssueGroupData
} from '../../../src/renderer/src/components/batch/summary/IssueGroup'
import
{
  ReviewSummary,
  backToAllLabel,
  consequenceLines,
  measuringLine,
  reviewAcknowledgmentFacts,
  reviewCountsLine,
  reviewTally,
  staleLine,
  subsetLine,
  type ReviewSummaryProps
} from '../../../src/renderer/src/components/batch/summary/ReviewSummary'
import
{
  REVIEW_GROUP_LIMIT,
  SummarySlot,
  finishedCountLine,
  type SummarySlotHandle,
  type SummarySituation
} from '../../../src/renderer/src/components/batch/summary/SummarySlot'

type ReportJob = PreflightReport['jobs'][number]

const GB = 1_000_000_000

interface JobOver
{
  status?: ReportJob['status']
  issues?: PlanIssue[]
  resolution?: 'place' | 'skip' | 'rename' | 'overwrite' | 'replace-original'
  conflict?: 'none' | 'exists' | 'collides'
  finalPath?: string
  source?: string
  bytes?: number | null
  plan?: null
}

function job(id: string, over: JobOver = {}): ReportJob
{
  const source = over.source ?? `D:\\Music\\${id}.wav`
  return {
    jobId: id as JobId,
    inputsRev: 1,
    status: over.status ?? 'ready',
    issues: over.issues ?? [],
    plan: over.plan === null
      ? null
      : {
        source: { path: source, size: 1, mtimeMs: 1 },
        output: { finalPath: over.finalPath ?? `D:\\Exports\\${id}.m4a`, resolution: over.resolution ?? 'place', conflict: over.conflict ?? 'none' },
        estimate: { outputBytes: over.bytes === undefined ? GB : over.bytes }
      } as never
  }
}

function volume(over: Partial<VolumeReport> = {}): VolumeReport
{
  return {
    volume: 'D:',
    kind: 'local',
    trash: 'available',
    trashBytesFree: 96 * GB,
    trashBytesNeeded: 9 * GB,
    volumeBytes: 2000 * GB,
    freeBytes: 412 * GB,
    estimatedBytes: 9 * GB,
    status: 'ok',
    ...over
  }
}

function report(jobs: ReportJob[], over: Partial<PreflightReport['counts']> = {}, id = 'pf-1', volumes = [volume()]): PreflightReport
{
  return {
    preflightId: id,
    createdAt: 0,
    policyRev: 1,
    capabilitiesRev: 1,
    jobs,
    counts: {
      jobs: jobs.length,
      ready: 0,
      blocked: 0,
      willSkip: 0,
      renames: 0,
      overwrites: 0,
      originalsAffected: 0,
      containerChanges: 0,
      gpuJobs: 0,
      cpuFallbacks: 0,
      warnings: 0,
      ...over
    },
    volumes,
    collisions: [],
    blocking: [],
    warnings: [],
    limits: {} as never
  }
}

function issue(code: PlanIssue['code'], severity: PlanIssue['severity'], message: string, fix: PlanFix | null = null): PlanIssue
{
  return { code, severity, message, field: 'container', fix }
}

function replaceReport(count: number, id: string, extra: ReportJob[] = []): PreflightReport
{
  const jobs = Array.from({ length: count }, (_, i) => job(`j${i}`, { resolution: 'replace-original', finalPath: `D:\\Music\\j${i}.wav` }))
  return report([...jobs, ...extra], { originalsAffected: count }, id)
}

const FOLDER: Pick<BatchPolicy, 'destination' | 'displaced'> = { destination: { mode: 'folder', folder: 'D:\\Exports\\Podcasts' }, displaced: 'trash' }
const REPLACE: Pick<BatchPolicy, 'destination' | 'displaced'> = { destination: { mode: 'replace-originals' }, displaced: 'trash' }

const MKV: PlanFix = { kind: 'set-container', container: 'mkv', scope: 'jobs' }
const RENAME: PlanFix = { kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' }

afterEach(() =>
{
  cleanup()
})

describe('counts and progress lines', () =>
{
  it('tallies ready, warnings, skipped, and blocked jobs', () =>
  {
    const jobs = [
      job('a'),
      job('b', { issues: [issue('disk-tight', 'warning', 'About 9 GB to write to D:, 12 GB free.')] }),
      job('c', { issues: [issue('container-changed', 'info', 'AAC cannot be stored in .wav; the output is .m4a.')] }),
      job('d', { status: 'blocked' }),
      job('e', { status: 'will-skip' })
    ]
    const tally = reviewTally(jobs)
    expect(tally).toEqual({ total: 5, ready: 2, warnings: 1, willSkip: 1, blocked: 1 })
    expect(reviewCountsLine(tally)).toBe('5 jobs: 2 ready, 1 with warnings, 1 will skip, 1 blocked.')
    expect(reviewCountsLine({ total: 22, ready: 18, warnings: 3, willSkip: 0, blocked: 1 })).toBe('22 jobs: 18 ready, 3 with warnings, 1 blocked.')
  })

  it('words measurement, the subset, and stale plans', () =>
  {
    expect(measuringLine(6, 15)).toBe('Measuring loudness: 6 of 15 jobs.')
    expect(subsetLine(8)).toBe('Plan for 8 selected jobs')
    expect(backToAllLabel(22)).toBe('Back to all 22')
    expect(staleLine({ kind: 'edited', field: 'Target, integrated', count: 8 })).toBe('Target, integrated changed for 8 jobs. Review them, then Start again.')
    expect(staleLine({ kind: 'edited', field: 'Codec', count: 1 })).toBe('Codec changed for 1 job. Review it, then Start again.')
    expect(staleLine({ kind: 'sources', count: 2 })).toBe('2 sources changed since this review.')
  })
})

describe('consequenceLines', () =>
{
  const win = { keepOld: false, platform: 'win32' as const }

  it('states the folder, the size, and the free space on its volume', () =>
  {
    const r = report([job('a', { bytes: 4.7 * GB }), job('b', { bytes: 4.7 * GB })])
    expect(consequenceLines(r, { ...win, destination: FOLDER.destination })).toEqual([
      'Writes 2 new files to D:\\Exports\\Podcasts, about 9.4 GB. 412 GB free on D:.',
      'Originals: not touched.',
      'Existing files: none replaced.'
    ])
  })

  it('writes next to the sources and counts the sizes it cannot predict', () =>
  {
    const r = report([job('a'), job('b', { bytes: null }), job('c', { status: 'blocked' })])
    expect(consequenceLines(r, { ...win, destination: { mode: 'next-to-source' } })[0])
      .toBe('Writes 2 new files next to their sources, about 1 GB. Size unknown for 1 job.')
  })

  it('gives one clause per volume when outputs land on several', () =>
  {
    const r = report(
      [job('a', { bytes: 6.1 * GB }), job('b', { finalPath: 'E:\\x\\b.m4a', bytes: 3.3 * GB }), job('c', { finalPath: 'F:\\c.m4a', bytes: null })],
      {},
      'pf-1',
      [volume(), volume({ volume: 'E:', freeBytes: 2.1 * GB }), volume({ volume: 'F:', freeBytes: null })]
    )
    expect(consequenceLines(r, { ...win, destination: FOLDER.destination })[0])
      .toBe('Writes 3 new files: 1 on D: (6.1 GB, 412 GB free), 1 on E: (3.3 GB, 2.1 GB free), 1 on F:. Size unknown for 1 job.')
  })

  it('says when nothing writes, and leaves free space out when it is unknown', () =>
  {
    expect(consequenceLines(report([job('a', { status: 'blocked' })]), { ...win, destination: FOLDER.destination })[0]).toBe('Writes no new files.')
    expect(consequenceLines(report([job('a', { bytes: null })], {}, 'pf', [volume({ freeBytes: null })]), { ...win, destination: FOLDER.destination })[0])
      .toBe('Writes 1 new file to D:\\Exports\\Podcasts. Size unknown for 1 job.')
  })

  it('replaces originals in place and names the extract jobs that write beside them', () =>
  {
    const extract = job('x', { issues: [issue('extract-never-replaces', 'info', 'Extract jobs never replace originals; this one writes beside its source.')] })
    const r = replaceReport(2, 'pf-1', [extract])
    expect(consequenceLines(r, { ...win, destination: REPLACE.destination })).toEqual([
      'Replaces 2 originals in place, about 2 GB; 412 GB free on D:. 1 extract job writes beside its source.',
      'Existing files: none replaced.'
    ])
  })

  it('replaces per volume, and says originals are not touched when none is replaced', () =>
  {
    const jobs = [
      job('a', { resolution: 'replace-original' }),
      job('b', { resolution: 'replace-original', source: 'E:\\b.wav', bytes: null }),
      job('x2', { issues: [issue('extract-never-replaces', 'info', 'm')] }),
      job('x3', { issues: [issue('extract-never-replaces', 'info', 'm')] })
    ]
    const r = report(jobs, {}, 'pf', [volume(), volume({ volume: 'E:', freeBytes: null })])
    expect(consequenceLines(r, { ...win, destination: REPLACE.destination })[0])
      .toBe('Replaces 2 originals in place: 1 on D: (1 GB, 412 GB free), 1 on E:. 2 extract jobs write beside their sources. Size unknown for 1 job.')
    expect(consequenceLines(report([job('a')], {}, 'pf', [volume({ freeBytes: null })]), { ...win, destination: REPLACE.destination })[0])
      .toBe('Originals: not touched.')
    expect(consequenceLines(report([job('a', { resolution: 'replace-original' })], {}, 'pf', [volume({ freeBytes: null })]), { ...win, destination: REPLACE.destination })[0])
      .toBe('Replaces 1 original in place, about 1 GB.')
  })

  it('states what happens to existing files under each rule', () =>
  {
    const lines = (r: PreflightReport, over: Partial<typeof win> = {}): string => consequenceLines(r, { ...win, ...over, destination: FOLDER.destination })[2]
    expect(lines(report([job('a', { resolution: 'overwrite' })], { overwrites: 3 }))).toBe('Existing files: 3 go to the Recycle Bin and are replaced.')
    expect(lines(report([job('a')], { overwrites: 1 }), { platform: 'darwin' })).toBe('Existing files: 1 goes to the Trash and is replaced.')
    expect(lines(report([job('a')], { overwrites: 3 }), { keepOld: true })).toBe('Existing files: 3 stay as name (previous).ext and are replaced.')
    expect(lines(report([job('a', { status: 'will-skip' }), job('b', { status: 'will-skip' }), job('c', { status: 'will-skip' })]))).toBe('Existing files: 3 skipped; those jobs will not run.')
    expect(lines(report([job('a', { status: 'will-skip' })]))).toBe('Existing files: 1 skipped; that job will not run.')
    expect(lines(report([job('a', { conflict: 'exists', resolution: 'rename' }), job('b', { conflict: 'exists', resolution: 'rename' })]))).toBe('Existing files: 2 kept; the new files are numbered (2).')
    expect(lines(report([job('a', { conflict: 'exists', resolution: 'rename' })]))).toBe('Existing files: 1 kept; the new file is numbered (2).')
  })
})

describe('issue groups', () =>
{
  it('groups distinct issues with their jobs, blocking first', () =>
  {
    const dropped = issue('streams-dropped', 'info', 'Not kept: 2 subtitle streams that .mp4 cannot hold (subrip).', MKV)
    const hold = issue('container-cannot-hold', 'error', 'WAV cannot hold AAC; choose M4A or MKA.', MKV)
    const jobs = [
      job('a', { issues: [dropped, dropped] }),
      job('b', { issues: [dropped, hold] }),
      job('c', { issues: [issue('disk-tight', 'warning', 'About 9 GB to write to D:, 12 GB free.')] })
    ]
    const groups = groupIssues(jobs)
    expect(groups.map((group) => [group.severity, group.code, group.jobIds])).toEqual([
      ['error', 'container-cannot-hold', ['b']],
      ['warning', 'disk-tight', ['c']],
      ['info', 'streams-dropped', ['a', 'b']]
    ])
    expect(groups[1].actions).toEqual(['change-output'])
  })

  it('labels each fix with its scope', () =>
  {
    expect(fixLabel(MKV, 2)).toBe('Write MKV instead for 2 jobs')
    expect(fixLabel({ kind: 'set-container', container: 'mka', scope: 'jobs' }, 1)).toBe('Keep all tracks as .mka for 1 job')
    expect(fixLabel(RENAME, 4)).toBe('Use Rename for this batch')
    expect(fixLabel({ kind: 'add-token', token: '{subdir}', scope: 'batch' }, 2)).toBe('Add {subdir} to file names')
    expect(fixLabel({ kind: 'set-gpu', gpu: 'off', scope: 'batch' }, 2)).toBe('Turn off GPU encoding for this batch')
    expect(fixLabel({ kind: 'set-gpu', gpu: 'auto', scope: 'batch' }, 2)).toBe('Use the GPU when it can for this batch')
    expect(fixLabel({ kind: 'set-gpu', gpu: 'require', scope: 'batch' }, 2)).toBe('Require the GPU for this batch')
    expect(fixLabel({ kind: 'set-displaced', displaced: 'keep', scope: 'batch' }, 2)).toBe('Keep old files beside the new ones for this batch')
    expect(fixLabel({ kind: 'set-destination', destination: 'next-to-source', scope: 'batch' }, 2)).toBe('Write next to each source instead')
    expect(fixLabel({ kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' }, 3)).toBe('Downmix to stereo for 3 jobs')
    expect(fixLabel({ kind: 'remove', scope: 'jobs' }, 2)).toBe('Remove 2 jobs from the queue')
  })

  it('names page controls and counts', () =>
  {
    expect(issueActions('source-missing').map(issueActionLabel)).toEqual(['Locate…'])
    expect(issueActions('probe-failed').map(issueActionLabel)).toEqual(['Probe again', 'Show log'])
    expect(issueActions('ffmpeg-below-minimum').map(issueActionLabel)).toEqual(['Open Settings'])
    expect(issueActions('template-unknown-token').map(issueActionLabel)).toEqual(['Change file name'])
    expect(issueActions('album-incomplete').map(issueActionLabel)).toEqual(['Select the whole album'])
    expect(issueActions('odd-dimensions')).toEqual([])
    expect(moreIssuesLabel(4)).toBe('Show 4 more issues')
    expect(moreIssuesLabel(1)).toBe('Show 1 more issue')
    expect(fixedText(2)).toBe('Fixed for 2 jobs.')
  })

  function group(key: string, ids: string[], fix: PlanFix | null = MKV, severity: IssueGroupData['severity'] = 'error'): IssueGroupData
  {
    return { key, code: 'container-cannot-hold', severity, reason: `Reason ${key}.`, jobIds: ids as JobId[], fix, actions: [] }
  }

  function Harness({ groups, onFix, onAnnounce, limit }: { groups: IssueGroupData[], onFix?: (fix: PlanFix, ids: readonly JobId[]) => void, onAnnounce?: (m: string) => void, limit?: number }): React.ReactElement
  {
    const headingRef = React.useRef<HTMLHeadingElement>(null)
    return (
      <div>
        <h2 ref={headingRef} tabIndex={-1}>Summary</h2>
        <IssueGroups groups={groups} limit={limit} headingRef={headingRef} onSelect={() => undefined} onFix={onFix ?? (() => undefined)} onAnnounce={onAnnounce} />
      </div>
    )
  }

  it('re-plans exactly the group\'s jobs and selects exactly them', () =>
  {
    const onFix = vi.fn()
    const onSelect = vi.fn()
    const onAction = vi.fn()
    const headingRef = { current: null }
    const g = { ...group('a', ['j1', 'j2']), actions: ['change-output' as const] }
    render(<IssueGroups groups={[g, group('b', ['j3'], null, 'warning')]} headingRef={headingRef} onSelect={onSelect} onFix={onFix} onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: 'Write MKV instead for 2 jobs' }))
    expect(onFix).toHaveBeenCalledWith(MKV, ['j1', 'j2'])
    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0])
    expect(onSelect).toHaveBeenCalledWith(['j1', 'j2'])
    fireEvent.click(screen.getByRole('button', { name: 'Change output' }))
    expect(onAction).toHaveBeenCalledWith('change-output', ['j1', 'j2'])
    expect(screen.getAllByRole('button', { name: 'Select' })[1]).toHaveAccessibleDescription('Reason b.')
  })

  it('shows three groups until "Show {n} more issues"', () =>
  {
    const groups = ['a', 'b', 'c', 'd', 'e'].map((key) => group(key, [`j-${key}`]))
    render(<Harness groups={groups} limit={REVIEW_GROUP_LIMIT} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more issues' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('moves focus to the next group\'s first button when a fix empties its group', () =>
  {
    const onAnnounce = vi.fn()
    const groups = [group('a', ['j1', 'j2']), group('b', ['j3'], RENAME), group('c', ['j4'])]
    const { rerender } = render(<Harness groups={groups} onAnnounce={onAnnounce} />)
    const button = screen.getByRole('button', { name: 'Write MKV instead for 2 jobs' })
    button.focus()
    fireEvent.click(button)
    rerender(<Harness groups={[groups[1], groups[2]]} onAnnounce={onAnnounce} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Use Rename for this batch' }))
    expect(onAnnounce).toHaveBeenCalledWith('Fixed for 2 jobs.')
  })

  it('falls back to the group before it, then to the summary heading', () =>
  {
    const groups = [group('a', ['j1']), group('b', ['j2'], RENAME)]
    const { rerender } = render(<Harness groups={groups} />)
    const last = screen.getByRole('button', { name: 'Use Rename for this batch' })
    last.focus()
    fireEvent.click(last)
    rerender(<Harness groups={[groups[0]]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write MKV instead for 1 job' }))
    fireEvent.click(document.activeElement as HTMLElement)
    rerender(<Harness groups={[]} />)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Summary' }))
  })

  it('keeps focus when the group survives or the user moved on', () =>
  {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const groups = [group('a', ['j1', 'j2']), group('b', ['j3'], RENAME)]
    const { rerender } = render(<Harness groups={groups} />)
    const button = screen.getByRole('button', { name: 'Write MKV instead for 2 jobs' })
    button.focus()
    fireEvent.click(button)
    rerender(<Harness groups={[group('a', ['j1']), groups[1]]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Write MKV instead for 1 job' }))
    outside.focus()
    rerender(<Harness groups={[groups[1]]} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})

describe('ReviewSummary', () =>
{
  function props(over: Partial<ReviewSummaryProps> = {}): ReviewSummaryProps
  {
    return {
      report: replaceReport(20, 'pf-1'),
      policy: REPLACE,
      platform: 'win32',
      acknowledgment: { checked: false, notice: null, counts: { originalsAffected: 20, overwrites: 0 }, onChange: () => undefined },
      onSelect: () => undefined,
      onFix: () => undefined,
      ...over
    }
  }

  it('keeps the fixed order: counts, consequences, acknowledgment, issue groups', () =>
  {
    const warn = job('w', { issues: [issue('disk-tight', 'warning', 'About 9 GB to write to D:, 12 GB free.')], resolution: 'replace-original' })
    const { container } = render(<ReviewSummary {...props({ report: replaceReport(20, 'pf-1', [warn]), stale: { kind: 'sources', count: 2 }, scanRunning: true })} />)
    const parts = [...container.querySelectorAll('h2, [data-line], [data-slot-part="acknowledgment"], [data-slot-part="issue-groups"]')]
      .map((element) => element.tagName === 'H2' ? 'counts' : (element.getAttribute('data-line') ?? element.getAttribute('data-slot-part')))
    expect(parts).toEqual(['counts', 'stale', 'scan', 'consequence', 'consequence', 'acknowledgment', 'issue-groups'])
    expect(screen.getByRole('heading', { name: '21 jobs: 20 ready, 1 with warnings, 0 blocked.' })).toBeInTheDocument()
    expect(screen.getByText('A folder scan is still adding files; they wait for the next Review.')).toBeInTheDocument()
  })

  it('carries no acknowledgment when nothing is destructive', () =>
  {
    render(<ReviewSummary {...props({ report: report([job('a')]), policy: FOLDER, acknowledgment: { checked: false, notice: null, counts: { originalsAffected: 0, overwrites: 0 }, onChange: () => undefined } })} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('reads the counts the session holds, falling back to the report', () =>
  {
    const r = replaceReport(3, 'pf-1')
    expect(reviewAcknowledgmentFacts(r, null, false, 'win32')).toMatchObject({ originals: 3, overwrites: 0, originalsByVolume: [{ volume: 'D:', count: 3 }] })
    expect(reviewAcknowledgmentFacts(r, { originalsAffected: 5, overwrites: 1 }, true, 'linux')).toMatchObject({ originals: 5, overwrites: 1, keepOld: true, platform: 'linux' })
  })

  it('stops measuring, focuses the heading, and announces it', () =>
  {
    const onStop = vi.fn()
    const onAnnounce = vi.fn()
    const { rerender } = render(<ReviewSummary {...props({ measuring: { done: 6, total: 15 }, onStopMeasuring: onStop, onAnnounce })} />)
    expect(screen.getByText('Measuring loudness: 6 of 15 jobs.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop measuring' }))
    expect(onStop).toHaveBeenCalled()
    expect(onAnnounce).toHaveBeenCalledWith('Measuring stopped.')
    expect(document.activeElement).toBe(screen.getByRole('heading'))
    rerender(<ReviewSummary {...props({ measuring: { done: 6, total: 15, stopped: true } })} />)
    expect(screen.getByText('Measuring stopped.')).toBeInTheDocument()
  })

  it('states the subset plan with the way back', () =>
  {
    const onBack = vi.fn()
    render(<ReviewSummary {...props({ report: replaceReport(8, 'pf-s'), acknowledgment: { checked: false, notice: null, counts: { originalsAffected: 8, overwrites: 0 }, onChange: () => undefined }, subset: { count: 8, total: 22 }, onBackToAll: onBack })} />)
    expect(screen.getByText('Plan for 8 selected jobs')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'I understand that 8 originals go to the Recycle Bin on D: after their outputs verify.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to all 22' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('collapsed, keeps only the count line and the acknowledgment', () =>
  {
    const g = job('g', { issues: [issue('container-cannot-hold', 'error', 'x', MKV)], status: 'blocked' })
    render(<ReviewSummary {...props({ report: replaceReport(20, 'pf-1', [g]), collapsed: true, subset: { count: 21, total: 30 } })} />)
    expect(screen.getByRole('heading')).toHaveTextContent('21 jobs: 20 ready, 0 with warnings, 1 blocked.')
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
    expect(screen.queryByText('Originals: not touched.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Write MKV/ })).toBeNull()
    expect(screen.queryByText('Plan for 21 selected jobs')).toBeNull()
  })
})

describe('SummarySlot', () =>
{
  function freshStore(originals = 20): ReturnType<typeof createBatchViewStore>
  {
    const store = createBatchViewStore({ storage: null })
    store.getState().receiveReport({ reportId: 'pf-1', originalsAffected: originals, overwrites: 0 })
    return store
  }

  function review(r: PreflightReport, over: Partial<ReviewSummaryProps> = {}): SummarySituation
  {
    return { kind: 'review', props: { report: r, policy: REPLACE, platform: 'win32', onSelect: () => undefined, onFix: () => undefined, ...over } }
  }

  function withMeasurement(r: PreflightReport, done: number): PreflightReport
  {
    const jobs = r.jobs.map((entry, i) => i < done && i % 4 === 0
      ? { ...entry, issues: [issue('disk-tight', 'warning', '3 jobs cannot reach -16 LUFS without more than 6 dB of peak limiting. They stop at the reachable level.')] }
      : entry)
    return { ...r, jobs }
  }

  it('collapses to nothing when it has nothing to say', () =>
  {
    const { container } = render(<SummarySlot situation={{ kind: 'none' }} store={freshStore()} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    render(<SummarySlot situation={{ kind: 'none' }} notices={<p>FFmpeg is not ready.</p>} store={freshStore()} />)
    expect(screen.getByText('FFmpeg is not ready.')).toBeInTheDocument()
  })

  it('stays checked while 15 preview measurements land', () =>
  {
    const store = freshStore()
    const base = replaceReport(20, 'pf-1')
    const { rerender } = render(<SummarySlot situation={review(base, { measuring: { done: 0, total: 15 } })} store={store} />)
    const box = screen.getByRole('checkbox', { name: 'I understand that 20 originals go to the Recycle Bin on D: after their outputs verify.' })
    fireEvent.click(box)
    expect(store.getState().review.acknowledged).toBe(true)
    for (let done = 1; done <= 15; done += 1)
    {
      rerender(<SummarySlot situation={review(withMeasurement(base, done), { measuring: { done, total: 15 } })} store={store} />)
      expect(screen.getByRole('checkbox')).toBeChecked()
    }
    expect(screen.getByText('Measuring loudness: 15 of 15 jobs.')).toBeInTheDocument()
    expect(store.getState().review).toMatchObject({ reportId: 'pf-1', acknowledged: true, notice: null })
  })

  it('stays checked across refreshes with the same counts, re-sending the latest report id', () =>
  {
    const store = freshStore()
    const { rerender } = render(<SummarySlot situation={review(replaceReport(20, 'pf-1'))} store={store} />)
    fireEvent.click(screen.getByRole('checkbox'))
    for (const id of ['pf-2', 'pf-3'])
    {
      act(() =>
      {
        expect(store.getState().receiveReport({ reportId: id, originalsAffected: 20, overwrites: 0 })).toBeNull()
      })
      rerender(<SummarySlot situation={review(replaceReport(20, id))} store={store} />)
      expect(screen.getByRole('checkbox')).toBeChecked()
    }
    expect(store.getState().review).toMatchObject({ reportId: 'pf-3', counts: { originalsAffected: 20, overwrites: 0 }, acknowledged: true })
  })

  it('unchecks when a count changes and says why', () =>
  {
    const store = freshStore()
    const { rerender } = render(<SummarySlot situation={review(replaceReport(20, 'pf-1'))} store={store} />)
    fireEvent.click(screen.getByRole('checkbox'))
    let notice: string | null = null
    act(() =>
    {
      notice = store.getState().receiveReport({ reportId: 'pf-2', originalsAffected: 22, overwrites: 0 })
    })
    rerender(<SummarySlot situation={review(replaceReport(22, 'pf-2'))} store={store} />)
    expect(notice).toBe('The number of originals changed to 22; confirm again.')
    const box = screen.getByRole('checkbox', { name: 'I understand that 22 originals go to the Recycle Bin on D: after their outputs verify.' })
    expect(box).not.toBeChecked()
    expect(screen.getByText('The number of originals changed to 22; confirm again.')).toBeInTheDocument()
    fireEvent.click(box)
    expect(store.getState().review).toMatchObject({ acknowledged: true, notice: null, reportId: 'pf-2' })
  })

  it('"Hide summary" keeps the count line and the acknowledgment that gates Start', () =>
  {
    const store = freshStore()
    render(<SummarySlot situation={review(replaceReport(20, 'pf-1'))} store={store} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }))
    expect(screen.getByRole('heading')).toHaveTextContent('20 jobs: 20 ready, 0 with warnings, 0 blocked.')
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
    expect(screen.queryByText(/Replaces 20 originals/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Show summary' }))
    expect(screen.getByText(/Replaces 20 originals in place/)).toBeInTheDocument()
  })

  it('Ctrl+Enter on a hidden slot expands it, focuses the checkbox, and says why', () =>
  {
    const store = freshStore()
    const ref = React.createRef<SummarySlotHandle>()
    render(<SummarySlot situation={review(replaceReport(20, 'pf-1'))} store={store} ref={ref} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }))
    let said: string | null = null
    act(() =>
    {
      said = (ref.current as SummarySlotHandle).focusAcknowledgment()
    })
    expect(said).toBe('Confirm that 20 originals go to the Recycle Bin on D: first.')
    expect(document.activeElement).toBe(screen.getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Hide summary' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    act(() =>
    {
      said = (ref.current as SummarySlotHandle).focusAcknowledgment()
    })
    expect(said).toBeNull()
  })

  it('Ctrl+Enter has nothing to focus outside a destructive Review', () =>
  {
    const ref = React.createRef<SummarySlotHandle>()
    const store = createBatchViewStore({ storage: null })
    const { rerender } = render(<SummarySlot situation={review(report([job('a')]), { policy: FOLDER })} store={store} ref={ref} />)
    expect(ref.current?.focusAcknowledgment()).toBeNull()
    rerender(<SummarySlot situation={{ kind: 'none' }} notices={<p>n</p>} store={store} ref={ref} />)
    expect(ref.current?.focusAcknowledgment()).toBeNull()
  })

  it('shows run notices during a run and the finished summary after one', () =>
  {
    const store = freshStore()
    const { rerender } = render(<SummarySlot situation={{ kind: 'run', props: { runId: 'run-31' as never, appended: 3, onReviewAppended: () => undefined, onAction: () => undefined } }} store={store} />)
    expect(screen.getByText(/^3 new jobs are not in /)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide summary' })).toBeNull()
    const summary = {
      runId: 'run-31',
      counts: { verified: 19, returned: 2, canceled: 1, skipped: 0, failed: 1, outsideTolerance: 1, interrupted: 0, held: 0 },
      bytes: { input: 25.8 * GB, output: 21.4 * GB },
      mediaSec: 3600,
      elapsedMs: 600_000,
      policy: FOLDER,
      recipes: [],
      albums: []
    } as unknown as BatchSummary
    expect(finishedCountLine(summary.counts)).toBe('19 verified · 2 returned · 1 canceled')
    const finished: SummarySituation = { kind: 'finished', props: { summary, jobs: [], onSelect: () => undefined, onRetry: () => undefined, onEditAndRetry: () => undefined, onAcknowledgeAll: () => undefined } }
    rerender(<SummarySlot situation={finished} store={store} />)
    const slot = document.querySelector('[data-summary-slot="finished"]') as HTMLElement
    expect(within(slot).getByText('verified')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }))
    expect(screen.getByText('19 verified · 2 returned · 1 canceled')).toBeInTheDocument()
  })
})
