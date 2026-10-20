/**
 * The inspector's identity header and scope footer: one job's catalog number, name, folder, status, and the actions
 * a job that needs attention offers; several jobs' breakdown and narrowing links; no selection; the Locate and Relink
 * flow of a job whose source is missing; and the footer's scope sentences with the values locked jobs keep.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import { formatCatalog, formatRunId } from '../../../src/shared/jobs/ids'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { JobView } from '../../../src/shared/jobs/types'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import
{
  decisionConfirmWords,
  decisionLabel,
  IdentityHeader,
  keepReplacesOriginal,
  locateRequest,
  middleTruncate,
  narrowings,
  nextNeedingAttention,
  NO_SELECTION,
  NO_SELECTION_TEXT,
  operationBreakdown,
  samePath,
  selectionBreakdown,
  sourceMissing,
  statusKey
} from '../../../src/renderer/src/components/batch/inspector/IdentityHeader'
import { ScopeFooter, scopeLines } from '../../../src/renderer/src/components/batch/inspector/ScopeFooter'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'

const OUT = { kind: 'same-as-source' } as const

let seq = 0

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

function normalize(id = 'ebu-r128'): Recipe
{
  return applyLoudnessPreset(id, OUT) as Recipe
}

function gain(): Recipe
{
  return applyGainPreset('gentle-lift', OUT) as Recipe
}

function job(recipe: Recipe = normalize(), over: Partial<JobView> = {}): JobView
{
  seq += 1
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:/Rips/Live/take-${seq}.flac`, name: `take-${seq}.flac`, ext: '.flac', dir: 'D:/Rips/Live', size: 1_000_000, mtimeMs: 0, origin: 'files', subdir: '' },
    recipe,
    recipeLabel: '',
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
    addedAt: seq,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  } as JobView
}

function withDuration(durationSec: number): Partial<JobView>
{
  return { media: { durationSec } as JobView['media'] }
}

describe('middleTruncate', () =>
{
  it('keeps a short text whole', () =>
  {
    expect(middleTruncate('concert-set-02.flac', 64)).toBe('concert-set-02.flac')
  })

  it('cuts the middle and keeps more of the end, where the extension is', () =>
  {
    const text = 'interview-raw-multitrack-session-recorded-in-the-harbor-studio-final.mkv'
    const cut = middleTruncate(text, 24)
    expect(Array.from(cut)).toHaveLength(24)
    expect(cut).toContain('\u2026')
    expect(cut.startsWith('interview-')).toBe(true)
    expect(cut.endsWith('final.mkv')).toBe(true)
  })

  it('counts characters, not code units', () =>
  {
    const text = '\u{1F3B5}'.repeat(30)
    expect(Array.from(middleTruncate(text, 10))).toHaveLength(10)
  })
})

describe('statusKey', () =>
{
  it('spells the canceled state as the status registry does', () =>
  {
    expect(statusKey('canceled')).toBe('cancelled')
    expect(statusKey('ready')).toBe('ready')
  })
})

describe('selection breakdown', () =>
{
  it('counts operations with the most common first', () =>
  {
    expect(operationBreakdown([job(), job(gain()), job()])).toBe('2 Normalize, 1 Gain')
  })

  it('adds the total duration only once every job is probed', () =>
  {
    const probed = [job(normalize(), withDuration(60)), job(normalize(), withDuration(120))]
    expect(selectionBreakdown(probed)).toMatch(/^2 Normalize · .+ · 3 min$/)
    expect(selectionBreakdown([...probed, job()])).toMatch(/^3 Normalize · [^·]+$/)
  })

  it('offers narrowing by operation when operations differ', () =>
  {
    const a = job()
    const b = job(gain())
    const c = job()
    const links = narrowings([a, b, c])
    expect(links.map((link) => link.label)).toEqual(['Select only: Normalize (2)', 'Select only: Gain (1)'])
    expect(links[0].ids).toEqual([a.id, c.id])
  })

  it('offers narrowing by preset when one operation mixes presets', () =>
  {
    const links = narrowings([job(normalize('apple-podcasts')), job(normalize('ebu-r128')), job(normalize('apple-podcasts'))])
    expect(links).toHaveLength(2)
    expect(links[0].label).toMatch(/^Select only: .*Apple Podcasts.* \(2\)$/)
    expect(links[1].label).toMatch(/\(1\)$/)
  })

  it('offers nothing when the selection agrees', () =>
  {
    expect(narrowings([job(), job()])).toEqual([])
  })
})

describe('IdentityHeader, several jobs and none', () =>
{
  it('shows the batch heading and teaching text with nothing selected', () =>
  {
    render(<IdentityHeader jobs={[]} />)
    expect(screen.getByRole('heading', { name: NO_SELECTION })).toBeTruthy()
    expect(screen.getByText(NO_SELECTION_TEXT)).toBeTruthy()
  })

  it('counts several jobs, breaks them down, and narrows them', () =>
  {
    const jobs = [job(normalize('apple-podcasts')), job(normalize('apple-podcasts')), job(normalize('ebu-r128'))]
    const onSelectOnly = vi.fn()
    render(<IdentityHeader jobs={jobs} onSelectOnly={onSelectOnly} />)
    expect(screen.getByRole('heading', { name: '3 jobs selected' })).toBeTruthy()
    expect(screen.getByText(/^3 Normalize · /)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /\(2\)$/ }))
    expect(onSelectOnly).toHaveBeenCalledWith([jobs[0].id, jobs[1].id])
  })

  it('leaves out the narrowing links without a handler', () =>
  {
    render(<IdentityHeader jobs={[job(), job(gain())]} />)
    expect(screen.queryByRole('list', { name: 'Narrow the selection' })).toBeNull()
  })
})

describe('IdentityHeader, one job', () =>
{
  it('shows the name as the heading, then the job number, the folder, and the status', () =>
  {
    const one = job(normalize(), { plan: { status: 'ready', warnings: 0, current: true, firstIssue: null } as unknown as JobView['plan'] })
    const { container } = render(<IdentityHeader jobs={[one]} />)
    const heading = screen.getByRole('heading', { name: `${one.id}, ${one.source.name}` })
    expect(heading.querySelector('.ui-catalog-number')).toHaveTextContent(one.id)
    expect(heading.textContent).toContain(one.source.name)
    expect(screen.getByText('D:/Rips/Live')).toBeTruthy()
    expect(container.querySelector('.ui-status-label, [data-status]')).toBeTruthy()
  })

  it('truncates a long name in the middle and keeps the whole name in its tooltip and heading', () =>
  {
    const long = `${'very-long-field-recording-from-the-harbor-'.repeat(3)}take-7.wav`
    const one = job(normalize(), { source: { ...job().source, name: long } })
    render(<IdentityHeader jobs={[one]} />)
    const heading = screen.getByRole('heading', { name: `${one.id}, ${long}` })
    const name = heading.querySelector(`[title="${long}"]`)
    expect(name?.textContent).toContain('\u2026')
    expect(name?.textContent?.endsWith('take-7.wav')).toBe(true)
  })

  it('says which job of a multi-selection it shows, and goes back to all of them', () =>
  {
    const onBack = vi.fn()
    const one = job()
    render(<IdentityHeader jobs={[one]} within={{ count: 8, onBack }} jobActions={<button type='button'>Job actions</button>} />)
    expect(screen.getByText(`Showing ${one.id} of 8 selected`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to all 8' }))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Job actions' })).toBeTruthy()
  })
})

const FAILED: Partial<JobView> = {
  state: 'failed',
  error: { code: 'ffmpeg-failed', short: 'Decode failed', message: 'FFmpeg could not decode the source.', stage: 'encode', at: 0 }
}

function held(reason: NonNullable<JobView['hold']>['reason'], displaces: 'original' | 'file' | null = null): Partial<JobView>
{
  const base = job()
  return {
    state: 'held',
    source: base.source,
    hold: {
      reason,
      message: 'Outside tolerance after one corrective encode.',
      outputPath: 'D:/Exports/take.flac',
      displaces: displaces === 'original' ? base.source.path.replace(/\//g, '\\').toUpperCase() : displaces === 'file' ? 'D:/Exports/take.flac' : null,
      actions: ['keep', 'keep-renamed', 'discard', 'retry'],
      since: 0
    }
  }
}

function done<T>(value: T): { status: 'done'; value: T; seq: number }
{
  return { status: 'done', value, seq: 1 }
}

function spokenText(element: Element): string
{
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
  return copy.textContent ?? ''
}

/** Renders as on Windows on every host, since the fixtures compare Windows paths. */
function provide(overrides: Partial<BatchActions>, ui: React.ReactElement): ReturnType<typeof render>
{
  return render(<PlatformProvider platform="win32"><TestBatchActionsProvider overrides={overrides}>{ui}</TestBatchActionsProvider></PlatformProvider>)
}

describe('decision and locate words', () =>
{
  it('compares Windows paths without case or separator differences, and others exactly', () =>
  {
    expect(samePath('D:\\Rips\\Take.flac', 'd:/rips/take.flac', 'win32')).toBe(true)
    expect(samePath('/media/Take.flac', '/media/take.flac', 'linux')).toBe(false)
    expect(samePath('/media/take/', '/media/take', 'darwin')).toBe(true)
  })

  it('labels keeping an output by what it replaces and why it waits', () =>
  {
    const original = job(normalize(), held('outside-tolerance', 'original'))
    expect(keepReplacesOriginal(original, 'win32')).toBe(true)
    expect(decisionLabel('keep', original, 'win32')).toBe('Keep output and replace original')
    expect(decisionLabel('keep', job(normalize(), held('destination-appeared', 'file')), 'win32')).toBe('Keep output')
    expect(decisionLabel('keep', job(normalize(), held('interrupted-finalize', 'original')), 'win32')).toBe('Finish saving')
    expect(decisionLabel('keep-renamed', original, 'win32')).toBe('Keep under a new name')
    expect(decisionLabel('discard', original, 'win32')).toBe('Discard output')
    expect(decisionLabel('retry', original, 'win32')).toBe('Retry')
  })

  it('asks before replacing, discarding, or retrying, in the platform words', () =>
  {
    const original = job(normalize(), held('outside-tolerance', 'original'))
    expect(decisionConfirmWords('keep', original, 'win32')).toEqual({
      question: `Replace the original of ${original.id} with an output outside tolerance? The original goes to the Recycle Bin.`,
      safe: 'Keep both',
      confirm: 'Replace original',
      danger: true
    })
    const file = job(normalize(), held('destination-appeared', 'file'))
    expect(decisionConfirmWords('keep', file, 'darwin').question).toBe(`Replace the existing file with the output of ${file.id}? The existing file goes to the Trash.`)
    const saving = job(normalize(), held('interrupted-finalize', 'original'))
    expect(decisionConfirmWords('keep', saving, 'win32').question).toContain('with its output?')
    expect(decisionConfirmWords('discard', file, 'win32')).toMatchObject({ safe: 'Keep it', confirm: 'Discard', danger: true })
    expect(decisionConfirmWords('retry', file, 'win32')).toEqual({
      question: `Retry ${file.id}? The output waiting for a decision is deleted first.`,
      safe: 'Keep waiting',
      confirm: 'Retry',
      danger: false
    })
  })

  it('opens Locate in the old folder with the old name, filtered to its type', () =>
  {
    expect(locateRequest({ path: 'D:/Rips/Old/take.flac', name: 'take.flac', ext: '.flac' }))
      .toEqual({ defaultPath: 'D:/Rips/Old/take.flac', name: 'take.flac', extensions: ['flac'] })
    expect(locateRequest({ path: 'D:/Rips/Old/README', name: 'README', ext: '' }).extensions).toEqual(['*'])
  })

  it('knows a missing source by its plan issue or its error', () =>
  {
    expect(sourceMissing(job(normalize(), { plan: { firstIssue: { code: 'source-missing' } } as unknown as JobView['plan'] }))).toBe(true)
    expect(sourceMissing(job(normalize(), { error: { ...FAILED.error!, code: 'source-missing' } }))).toBe(true)
    expect(sourceMissing(job())).toBe(false)
  })

  it('finds the next job that needs attention in table order, wrapping around', () =>
  {
    const a = job(normalize(), FAILED)
    const b = job()
    const c = job(normalize(), FAILED)
    expect(nextNeedingAttention([a, b, c], a.id)?.id).toBe(c.id)
    expect(nextNeedingAttention([a, b, c], c.id)?.id).toBe(a.id)
    expect(nextNeedingAttention([a, b], a.id)).toBeNull()
    expect(nextNeedingAttention([], a.id)).toBeNull()
  })
})

describe('IdentityHeader, a job that needs attention', () =>
{
  it('acknowledges a failed job, then names the next one that needs attention', async () =>
  {
    const one = job(normalize(), FAILED)
    const other = job(normalize(), FAILED)
    const acknowledge = vi.fn(async (ids: readonly string[]) => done({ applied: [...ids], refused: [] }))
    const onShowJob = vi.fn()
    provide(
      { acknowledge: acknowledge as unknown as BatchActions['acknowledge'] },
      <IdentityHeader jobs={[one]} queue={[one, job(), other]} onShowJob={onShowJob} />
    )
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    })
    expect(acknowledge).toHaveBeenCalledWith([one.id])
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Next: ${other.id}` }))
    expect(onShowJob).toHaveBeenCalledWith(other.id)
  })

  it('keeps Acknowledge when the command is refused', async () =>
  {
    const one = job(normalize(), FAILED)
    const acknowledge = vi.fn(async () => ({ status: 'refused', code: 'internal', message: 'No.' }))
    provide({ acknowledge: acknowledge as unknown as BatchActions['acknowledge'] }, <IdentityHeader jobs={[one]} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    })
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy()
  })

  it('offers no actions without the batch commands', () =>
  {
    render(<IdentityHeader jobs={[job(normalize(), FAILED)]} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the decision buttons instead of Acknowledge, and confirms replacing the original', async () =>
  {
    const one = job(normalize(), held('outside-tolerance', 'original'))
    const keepOutput = vi.fn(async (_ids: readonly string[], options: { confirmed?: boolean } = {}) =>
      options.confirmed === true ? done({ applied: [one.id], refused: [] }) : { status: 'needs-confirmation', displaces: 1 })
    const onFocusRow = vi.fn()
    provide({ keepOutput: keepOutput as unknown as BatchActions['keepOutput'] }, <IdentityHeader jobs={[one]} onFocusRow={onFocusRow} />)
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    const group = screen.getByRole('group', { name: `Decide ${one.id}` })
    expect(Array.from(group.querySelectorAll('button')).map(spokenText))
      .toEqual(['Keep output and replace original', 'Keep under a new name', 'Discard output', 'Retry'])
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Keep output and replace original' }))
    })
    expect(screen.getByText(/^Replace the original of .+ with an output outside tolerance\?/)).toBeTruthy()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Replace original' }))
    })
    expect(keepOutput).toHaveBeenLastCalledWith([one.id], { confirmed: true })
    expect(onFocusRow).toHaveBeenCalledWith(one.id)
  })

  it('keeps an output under a new name without asking', async () =>
  {
    const one = job(normalize(), held('destination-appeared', 'file'))
    const keepOutput = vi.fn(async () => done({ applied: [one.id], refused: [] }))
    const onFocusRow = vi.fn()
    provide({ keepOutput: keepOutput as unknown as BatchActions['keepOutput'] }, <IdentityHeader jobs={[one]} onFocusRow={onFocusRow} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Keep under a new name' }))
    })
    expect(keepOutput).toHaveBeenCalledWith([one.id], { placement: 'renamed' })
    expect(onFocusRow).toHaveBeenCalledWith(one.id)
  })

  it('discards only after the confirmation, and the safe choice changes nothing', async () =>
  {
    const one = job(normalize(), held('destination-appeared', 'file'))
    const discardOutput = vi.fn(async () => done({ applied: [one.id], refused: [] }))
    provide({ discardOutput: discardOutput as unknown as BatchActions['discardOutput'] }, <IdentityHeader jobs={[one]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard output' }))
    expect(screen.getByText(`Discard the output of ${one.id}? The file is deleted. The original and any existing file stay.`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(discardOutput).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard output' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    })
    expect(discardOutput).toHaveBeenCalledWith([one.id])
  })

  it('hands a Retry that needs the acknowledgment to the inspector', async () =>
  {
    const one = job(normalize(), held('outside-tolerance', 'original'))
    const ack = { preflightId: 'p1', originals: 1, overwrites: 0 }
    const retry = vi.fn(async () => ({ status: 'needs-acknowledgment', ack }))
    const onRetryNeedsAcknowledgment = vi.fn()
    provide(
      { retry: retry as unknown as BatchActions['retry'] },
      <IdentityHeader jobs={[one]} onRetryNeedsAcknowledgment={onRetryNeedsAcknowledgment} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(retry).toHaveBeenCalledWith([one.id])
    expect(onRetryNeedsAcknowledgment).toHaveBeenCalledWith([one.id], ack)
  })

  it('reads Finish saving after an interruption while saving', () =>
  {
    const one = job(normalize(), held('interrupted-finalize'))
    provide({}, <IdentityHeader jobs={[one]} />)
    expect(screen.getByRole('button', { name: 'Finish saving' })).toBeTruthy()
  })
})

describe('IdentityHeader, a missing source', () =>
{
  const MISSING: Partial<JobView> = { plan: { status: 'blocked', warnings: 0, current: true, firstIssue: { code: 'source-missing' } } as unknown as JobView['plan'] }

  it('locates the file in its old folder, then offers to relink the others from that folder', async () =>
  {
    const one = job(normalize(), MISSING)
    const pickSource = vi.fn(async () => 'E:/Rips/New/take.flac')
    const send = vi.fn(async (name: string) => name === 'locate'
      ? done({ applied: [one.id], refused: [], relinkable: { fromDir: 'D:/Rips/Live', toDir: 'E:/Rips/New', ids: ['MM-0900', 'MM-0901'] } })
      : done({ applied: ['MM-0900', 'MM-0901'], refused: [] }))
    provide({ send: send as unknown as BatchActions['send'] }, <IdentityHeader jobs={[one]} pickSource={pickSource} />)
    expect(screen.getAllByText('Source missing').length).toBeGreaterThan(0)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
    })
    expect(pickSource).toHaveBeenCalledWith({ defaultPath: one.source.path, name: one.source.name, extensions: ['flac'] })
    expect(send).toHaveBeenCalledWith('locate', { jobId: one.id, path: 'E:/Rips/New/take.flac' })
    expect(screen.getByText('Relink 2 more jobs from D:/Rips/Live to E:/Rips/New?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Relink' }))
    })
    expect(send).toHaveBeenLastCalledWith('relink', { fromDir: 'D:/Rips/Live', toDir: 'E:/Rips/New', ids: ['MM-0900', 'MM-0901'] })
    expect(screen.queryByText(/^Relink 2 more jobs/)).toBeNull()
  })

  it('asks nothing more when the pick stays in the same folder, and Not now relinks nothing', async () =>
  {
    const one = job(normalize(), MISSING)
    let relinkable: { fromDir: string; toDir: string; ids: string[] } | null = null
    const send = vi.fn(async () => done({ applied: [one.id], refused: [], relinkable }))
    provide({ send: send as unknown as BatchActions['send'] }, <IdentityHeader jobs={[one]} pickSource={async () => 'D:/Rips/Live/take.flac'} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
    })
    expect(screen.queryByRole('button', { name: 'Relink' })).toBeNull()
    relinkable = { fromDir: 'D:/Rips/Live', toDir: 'E:/Rips/New', ids: ['MM-0900'] }
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
    })
    expect(screen.getByText('Relink 1 more job from D:/Rips/Live to E:/Rips/New?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(send).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Locate\u2026' })).toBeTruthy()
  })

  it('sends nothing when the dialog is canceled or fails, and shows a refusal', async () =>
  {
    const one = job(normalize(), MISSING)
    const send = vi.fn(async () => ({ status: 'refused', code: 'not-media', message: 'The chosen file is not media.' }))
    const pickSource = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('dialog'))
      .mockResolvedValueOnce('E:/Rips/New/notes.txt')
    provide({ send: send as unknown as BatchActions['send'] }, <IdentityHeader jobs={[one]} pickSource={pickSource} />)
    for (let attempt = 0; attempt < 2; attempt += 1)
    {
      await act(async () =>
      {
        fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
      })
    }
    expect(send).not.toHaveBeenCalled()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('The chosen file is not media.')
  })

  it('shows a refused relink', async () =>
  {
    const one = job(normalize(), MISSING)
    const send = vi.fn(async (name: string) => name === 'locate'
      ? done({ applied: [one.id], refused: [], relinkable: { fromDir: 'D:/Rips/Live', toDir: 'E:/Rips/New', ids: ['MM-0900'] } })
      : { status: 'refused', code: 'internal', message: 'Relink failed.' })
    provide({ send: send as unknown as BatchActions['send'] }, <IdentityHeader jobs={[one]} pickSource={async () => 'E:/Rips/New/take.flac'} />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Locate\u2026' }))
    })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Relink' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Relink failed.')
  })

  it('offers no Locate without a file dialog', () =>
  {
    provide({}, <IdentityHeader jobs={[job(normalize(), MISSING)]} />)
    expect(screen.queryByRole('button', { name: 'Locate\u2026' })).toBeNull()
  })
})

describe('ScopeFooter', () =>
{
  it('says nothing for an empty selection', () =>
  {
    expect(scopeLines([])).toEqual([])
    const { container } = render(<ScopeFooter jobs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('states the scope of an edit to editable jobs', () =>
  {
    render(<ScopeFooter jobs={[job(), job()]} />)
    expect(screen.getByText('Changes apply to 2 selected jobs.')).toBeTruthy()
  })

  it('names the locked jobs and the values they keep, once each', () =>
  {
    const runId = formatRunId(31)
    const jobs = [job(), job(normalize(), { state: 'queued', runId }), job(normalize(), { state: 'done', runId })]
    const note = '2 locked jobs keep \u221214.0 LUFS.'
    const lines = scopeLines(jobs, [{ lockedNote: note }, { lockedNote: null }, { lockedNote: note }])
    expect(lines).toEqual([
      'Changes apply to 1 job not in a batch. 2 queued, running, or finished jobs keep their settings.',
      note
    ])
  })

  it('says nothing when every selected job is locked, since the Settings tab states the lock once', () =>
  {
    const runId = formatRunId(31)
    expect(scopeLines([job(normalize(), { state: 'queued', runId })])).toEqual([])
    expect(scopeLines([job(normalize(), { state: 'done', runId }), job(normalize(), { state: 'queued', runId })])).toEqual([])
  })
})
