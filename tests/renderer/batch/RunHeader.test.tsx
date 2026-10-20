/**
 * The run header: one primary element per state of the primary budget and none where it says none, disabled
 * primaries drawn neutral with their reason, the action slot's one stable element, the run controls in their own
 * slot, the inline confirmations, the attention button, the consequence line, and the after-run actions and
 * overflow menu at every width.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import
{
  PAUSE_NOW_CONFIRM_AFTER_SEC,
  RunHeader,
  attentionFilters,
  cancelRunQuestion,
  pauseNowQuestion,
  type RunHeaderProps
} from '../../../src/renderer/src/components/batch/header/RunHeader'
import
{
  ACTION_LABELS,
  HEADER_TOOLTIPS,
  appendLabel,
  formatDuration,
  needAttention,
  pauseNowLabel,
  retryReturnedLabel,
  reviewLabel,
  reviewNewLabel,
  startLabel,
  type ActionKind
} from '../../../src/renderer/src/copy/batch'
import
{
  sentenceText,
  type HeaderAction,
  type HeaderModel,
  type RunControls,
  type SentencePart,
  type StateSentence
} from '../../../src/renderer/src/stores/batchHeader'
import { formatRunId } from '../../../src/shared/jobs/ids'

const RUN = formatRunId(31)

const POLICY_TEXT = 'Writes to D:\\Exports\\Podcasts as {name} · Renames if the name is taken · Originals are not touched'

function action(kind: ActionKind, label: string, over: Partial<HeaderAction> = {}): HeaderAction
{
  return { kind, label, tooltip: `${label} (Ctrl+Enter)`, count: 1, enabled: true, reason: null, blockedBy: null, place: 'header', ...over }
}

function disabledReview(): HeaderAction
{
  return action('review', ACTION_LABELS.review, { tooltip: HEADER_TOOLTIPS.reviewDisabled, count: 0, enabled: false })
}

function part(kind: SentencePart['kind'], text: string, short: string = text): SentencePart
{
  return { kind, text, short, tone: null }
}

function sentenceOf(...parts: SentencePart[]): StateSentence
{
  return { parts, full: sentenceText(parts) }
}

function runControls(over: Partial<RunControls> = {}): RunControls
{
  return {
    pause: { label: ACTION_LABELS.pause, tooltip: 'Pause (Ctrl+P). Jobs already running finish first.' },
    pauseNow: { label: pauseNowLabel(3), tooltip: HEADER_TOOLTIPS.pauseNow, running: 3 },
    cancel: { label: ACTION_LABELS.cancelRun, tooltip: HEADER_TOOLTIPS.cancelRun },
    ...over
  }
}

function model(over: Partial<HeaderModel> = {}): HeaderModel
{
  return {
    title: 'Batch',
    subject: 'waiting',
    sentence: sentenceOf(part('lead', '24 jobs'), part('size', '35.6 GB'), part('media', '10 h 2 min of media')),
    attention: null,
    action: null,
    slot: null,
    primary: null,
    controls: null,
    consequence: { kind: 'policy', text: POLICY_TEXT, warning: false },
    output: { label: 'Output', tooltip: HEADER_TOOLTIPS.output, locked: false },
    workers: { label: '16 workers · GPU when allowed', shortLabel: 'Workers', tooltip: HEADER_TOOLTIPS.workers },
    ...over
  }
}

function withSlot(slot: HeaderAction, over: Partial<HeaderModel> = {}): HeaderModel
{
  return model({ action: slot, slot, primary: slot.enabled ? 'slot' : null, ...over })
}

const running = (over: Partial<HeaderModel> = {}): HeaderModel => model({
  title: 'Batch 31',
  subject: 'run',
  sentence: sentenceOf(part('lead', '10 of 22 finished')),
  controls: runControls(),
  consequence: { kind: 'progress', percent: 46, percentText: '46%', status: null, timeLeft: 'about 18 min left', throughput: '3.4x realtime' },
  ...over
})

/** Each row of the primary budget: the header of that moment and the primary element it allows. */
const BRASS_STATES: Array<{ name: string; header: HeaderModel; primary: string | null }> = [
  {
    name: 'empty queue (Add files is in the empty state)',
    header: model({ subject: 'empty', sentence: sentenceOf(part('lead', 'No jobs yet')), action: action('add-files', ACTION_LABELS.addFiles, { place: 'empty-state', count: 0 }), slot: disabledReview(), primary: 'empty-state' }),
    primary: null
  },
  { name: 'jobs waiting, no batch running', header: withSlot(action('review', reviewLabel(24), { count: 24 })), primary: 'Review 24 jobs' },
  { name: 'Review, nothing destructive, jobs runnable', header: withSlot(action('start', startLabel(21), { count: 21 })), primary: 'Start 21 jobs' },
  {
    name: 'Review, originals affected, box not checked',
    header: withSlot(action('start', startLabel(21, { subset: false, originals: 20, overwrites: 0 }), { count: 21, enabled: false, reason: 'Confirm the Recycle Bin step in the summary first.', blockedBy: 'acknowledgment' })),
    primary: null
  },
  {
    name: 'Review, nothing runnable',
    header: withSlot(action('start', startLabel(0), { count: 0, enabled: false, reason: 'Nothing can run: 2 jobs are blocked.', blockedBy: 'nothing-runnable' })),
    primary: null
  },
  { name: 'running', header: running(), primary: null },
  { name: 'running, new jobs waiting', header: running({ action: action('review-new', reviewNewLabel(3), { count: 3 }), slot: action('review-new', reviewNewLabel(3), { count: 3 }), primary: 'slot' }), primary: 'Review 3 new jobs' },
  { name: 'running, new jobs in Review', header: running({ action: action('append', appendLabel(3, RUN), { count: 3 }), slot: action('append', appendLabel(3, RUN), { count: 3 }), primary: 'slot' }), primary: 'Append 3 jobs to Batch 31' },
  {
    name: 'pausing or paused',
    header: running({ sentence: sentenceOf(part('lead', 'Paused · 12 jobs waiting')), controls: runControls({ pause: null, pauseNow: null }), action: action('resume', ACTION_LABELS.resume), slot: action('resume', ACTION_LABELS.resume), primary: 'slot' }),
    primary: 'Resume'
  },
  {
    name: 'finished with returned jobs, nothing waiting',
    header: withSlot(action('retry-returned', retryReturnedLabel(2), { count: 2 }), { title: 'Batch 31', subject: 'finished', consequence: { kind: 'outcome', text: 'Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched' } }),
    primary: 'Retry 2 returned'
  },
  {
    name: 'finished, all verified, nothing waiting',
    header: model({ title: 'Batch 31', subject: 'finished', slot: disabledReview(), consequence: { kind: 'outcome', text: 'Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched' } }),
    primary: null
  }
]

interface Rendered
{
  props: RunHeaderProps
  rerender: (header: HeaderModel, over?: Partial<RunHeaderProps>) => void
  root: HTMLElement
}

function renderHeader(header: HeaderModel, over: Partial<RunHeaderProps> = {}): Rendered
{
  const props: RunHeaderProps = {
    header,
    batch: header.subject === 'run' || header.subject === 'finished' ? { runId: RUN, active: 3, queued: 12 } : null,
    viewWidth: 1400,
    onAction: vi.fn(),
    onStartSelected: vi.fn(),
    onPause: vi.fn(),
    onCancelRun: vi.fn(),
    onShowAttention: vi.fn(),
    onOpenFolder: vi.fn(),
    onExportReport: vi.fn(),
    onOutput: vi.fn(),
    onWorkers: vi.fn(),
    onShowLog: vi.fn(),
    onShowShortcuts: vi.fn(),
    onInspectorWidth: vi.fn(),
    focusTable: vi.fn(),
    ...over
  }
  const view = render(<RunHeader {...props} />)
  return {
    props,
    root: screen.getByRole('region', { name: 'Batch status and controls' }),
    rerender: (next, more = {}) =>
    {
      Object.assign(props, { header: next }, more)
      view.rerender(<RunHeader {...props} />)
    }
  }
}

/** Enabled controls drawn as the primary button. */
function primaryElements(root: HTMLElement): HTMLElement[]
{
  return Array.from(root.querySelectorAll<HTMLElement>('[data-variant="primary"]'))
    .filter((element) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true')
}

function slotButton(root: HTMLElement): HTMLButtonElement
{
  const slot = root.querySelector<HTMLElement>('[data-slot="action"]')
  expect(slot).not.toBeNull()
  return within(slot as HTMLElement).getAllByRole('button')[0] as HTMLButtonElement
}

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

describe('RunHeader confirmation words', () =>
{
  it('words Cancel run for one job and for several', () =>
  {
    expect(cancelRunQuestion(RUN, 1, 1)).toBe('Cancel Batch 31? 1 job in progress stops and its partial file is deleted. 1 queued job is canceled. Finished jobs keep their outputs.')
    expect(cancelRunQuestion(RUN, 0, 4)).toBe('Cancel Batch 31? 4 queued jobs are canceled. Finished jobs keep their outputs.')
    expect(cancelRunQuestion(RUN, 2, 0)).toBe('Cancel Batch 31? 2 jobs in progress stop and their partial files are deleted. Finished jobs keep their outputs.')
  })

  it('words Pause now with the work it discards', () =>
  {
    expect(pauseNowQuestion(1, 95)).toBe(`Pause now? 1 running job restarts from the beginning; ${formatDuration(95)} of encoding is discarded.`)
    expect(PAUSE_NOW_CONFIRM_AFTER_SEC).toBe(30)
  })

  it('filters to Needs attention in this batch only', () =>
  {
    expect(attentionFilters(RUN)).toEqual([{ facet: 'status', value: 'attention' }, { facet: 'batch', value: RUN }])
  })
})

describe('RunHeader primary budget', () =>
{
  it.each(BRASS_STATES)('$name', ({ header, primary }) =>
  {
    const { root } = renderHeader(header)
    const lit = primaryElements(root)
    if (primary === null)
    {
      expect(lit).toHaveLength(0)
      return
    }
    expect(lit).toHaveLength(1)
    expect(lit[0]).toHaveAccessibleName(primary)
    expect(lit[0].closest('[data-slot]')).toHaveAttribute('data-slot', 'action')
  })

  it('draws Start and its menu chevron as one primary split control while a selection can start alone', () =>
  {
    const { root, props } = renderHeader(withSlot(action('start', startLabel(21), { count: 21 })), { selectedCount: 8 })
    const lit = primaryElements(root)
    expect(lit).toHaveLength(2)
    expect(lit[0]).toHaveAccessibleName('Start 21 jobs')
    expect(lit[1]).toHaveAccessibleName('More start options')
    expect(new Set(lit.map((element) => element.closest('[data-part="split"]'))).size).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'More start options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Start only the 8 selected jobs/, hidden: true }))
    expect(props.onStartSelected).toHaveBeenCalledTimes(1)
  })

  it('keeps the chevron neutral and disabled while nothing is selected', () =>
  {
    const { root } = renderHeader(withSlot(action('start', startLabel(21), { count: 21 })))
    const chevron = screen.getByRole('button', { name: 'More start options' })
    expect(chevron).toBeDisabled()
    expect(chevron).toHaveAttribute('data-variant', 'secondary')
    expect(primaryElements(root)).toHaveLength(1)
  })

  it('never draws the run controls as the primary button', () =>
  {
    const { root } = renderHeader(running())
    const controls = root.querySelector('[data-slot="run-controls"]') as HTMLElement
    for (const button of within(controls).getAllByRole('button'))
    {
      expect(button).not.toHaveAttribute('data-variant', 'primary')
    }
  })
})

describe('RunHeader disabled actions', () =>
{
  it('draws a blocked Start neutral with its reason written beside it', () =>
  {
    const reason = 'Confirm the Recycle Bin step in the summary first.'
    const blocked = action('start', 'Start 21 jobs, replace 20 originals', { count: 21, enabled: false, reason, blockedBy: 'acknowledgment' })
    const { root, props } = renderHeader(withSlot(blocked))
    const button = slotButton(root)
    expect(button).toHaveAttribute('data-variant', 'secondary')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(reason)
    expect(root.querySelector('[data-part="reason"]')).toHaveTextContent(reason)
    fireEvent.click(button)
    expect(props.onAction).not.toHaveBeenCalled()
  })

  it('keeps a disabled Review focusable and explains it in its description', () =>
  {
    const { root } = renderHeader(model({ subject: 'empty', slot: disabledReview(), primary: 'empty-state' }))
    const button = slotButton(root)
    expect(button).toHaveAccessibleName('Review')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(HEADER_TOOLTIPS.reviewDisabled)
  })

  it('writes a typed refusal from main inline beside Start', () =>
  {
    const { root } = renderHeader(withSlot(action('start', startLabel(21), { count: 21 })), { refusal: 'The plan changed. Review the changes, then start again.' })
    const refusal = root.querySelector('[data-part="refusal"]') as HTMLElement
    expect(refusal).toHaveTextContent('The plan changed. Review the changes, then start again.')
    expect(refusal.compareDocumentPosition(slotButton(root)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('RunHeader action slot', () =>
{
  it('relabels one element through Review, Start, Append, Resume, and Retry returned, keeping focus on it', () =>
  {
    const review = action('review', reviewLabel(24), { count: 24 })
    const { root, rerender, props } = renderHeader(withSlot(review))
    const button = slotButton(root)
    button.focus()
    fireEvent.click(button)
    expect(props.onAction).toHaveBeenCalledWith(review)

    const steps: HeaderModel[] = [
      withSlot(action('start', startLabel(21), { count: 21 })),
      running({ action: action('append', appendLabel(3, RUN), { count: 3 }), slot: action('append', appendLabel(3, RUN), { count: 3 }), primary: 'slot' }),
      running({ controls: runControls({ pause: null }), action: action('resume', ACTION_LABELS.resume), slot: action('resume', ACTION_LABELS.resume), primary: 'slot' }),
      withSlot(action('retry-returned', retryReturnedLabel(2), { count: 2 }), { title: 'Batch 31', subject: 'finished' })
    ]
    for (const step of steps)
    {
      rerender(step)
      expect(slotButton(root)).toBe(button)
      expect(button).toHaveAccessibleName((step.slot as HeaderAction).label)
      expect(document.activeElement).toBe(button)
    }
  })

  it('shows Starting with the width of the label it replaces and ignores further presses', () =>
  {
    const start = action('start', startLabel(21), { count: 21 })
    const { root, rerender, props } = renderHeader(withSlot(start))
    const button = slotButton(root)
    const pressed = { ...start, label: 'Starting…', enabled: false, blockedBy: 'starting' as const }
    rerender(model({ subject: 'starting', sentence: sentenceOf(part('lead', 'Starting Batch 31')), action: pressed, slot: pressed, primary: null }))
    expect(slotButton(root)).toBe(button)
    expect(button).toHaveTextContent('Starting…')
    expect(button.textContent).toContain('Start 21 jobs')
    expect(root.querySelector('[data-part="reason"]')).toBeNull()
    fireEvent.click(button)
    expect(props.onAction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'More start options' })).toBeDisabled()
  })
})

describe('RunHeader run controls', () =>
{
  it('keeps Pause and Cancel run in their own slot beside the action slot', () =>
  {
    const { root } = renderHeader(running({ action: action('review-new', reviewNewLabel(3), { count: 3 }), slot: action('review-new', reviewNewLabel(3), { count: 3 }), primary: 'slot' }))
    const controls = root.querySelector('[data-slot="run-controls"]') as HTMLElement
    const slot = root.querySelector('[data-slot="action"]') as HTMLElement
    expect(within(controls).getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(within(controls).getByRole('button', { name: 'Cancel run' })).toBeInTheDocument()
    expect(within(slot).queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(within(slot).queryByRole('button', { name: 'Cancel run' })).toBeNull()
    expect(slot.contains(controls) || controls.contains(slot)).toBe(false)
  })

  it('pauses with running jobs finishing first', () =>
  {
    const { props } = renderHeader(running())
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(props.onPause).toHaveBeenCalledWith('finish-running')
  })

  it('offers Pause now alone while the batch is pausing', () =>
  {
    const { props } = renderHeader(running({ controls: runControls({ pause: null }), action: action('resume', ACTION_LABELS.resume), slot: action('resume', ACTION_LABELS.resume), primary: 'slot' }), { discardedWork: () => 10 })
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause now' }))
    expect(props.onPause).toHaveBeenCalledWith('stop-running')
  })

  it('describes Pause, Pause now, and Cancel run with their tooltips', () =>
  {
    renderHeader(running())
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAccessibleDescription('Pause (Ctrl+P). Jobs already running finish first.')
    expect(screen.getByRole('button', { name: 'Cancel run' })).toHaveAccessibleDescription(HEADER_TOOLTIPS.cancelRun)
    expect(screen.getByRole('button', { name: 'More pause options' })).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('disables the Pause menu while no running job could restart', () =>
  {
    renderHeader(running({ controls: runControls({ pauseNow: null }) }))
    expect(screen.getByRole('button', { name: 'More pause options' })).toBeDisabled()
  })

  it('keeps focus on the slot when Pause turns into Resume', () =>
  {
    const { root, rerender } = renderHeader(running())
    const pause = screen.getByRole('button', { name: 'Pause' })
    pause.focus()
    rerender(running({ controls: runControls({ pause: null }), action: action('resume', ACTION_LABELS.resume), slot: action('resume', ACTION_LABELS.resume), primary: 'slot' }))
    expect(document.activeElement).toBe(slotButton(root))
    expect(document.activeElement).toHaveAccessibleName('Resume')
  })

  it('moves focus from Resume to Pause when the batch resumes', () =>
  {
    const paused = running({ controls: runControls({ pause: null, pauseNow: null }), action: action('resume', ACTION_LABELS.resume), slot: action('resume', ACTION_LABELS.resume), primary: 'slot' })
    const { root, rerender, props } = renderHeader(paused)
    slotButton(root).focus()
    rerender(running())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }))
    expect(props.focusTable).not.toHaveBeenCalled()
  })

  it('sends focus to the table when Append is accepted and the action slot empties', () =>
  {
    const append = action('append', appendLabel(3, RUN), { count: 3 })
    const { root, rerender, props } = renderHeader(running({ action: append, slot: append, primary: 'slot' }))
    slotButton(root).focus()
    rerender(running())
    expect(root.querySelector('[data-slot="action"]')).toBeNull()
    expect(props.focusTable).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when the slot empties while focus is elsewhere', () =>
  {
    const append = action('append', appendLabel(3, RUN), { count: 3 })
    const { root, rerender, props } = renderHeader(running({ action: append, slot: append, primary: 'slot' }))
    slotButton(root).focus()
    screen.getByRole('button', { name: 'Output' }).focus()
    rerender(running())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Output' }))
    expect(props.focusTable).not.toHaveBeenCalled()
  })

  it('hands focus to the overflow menu when Output leaves row 1 on a narrowing view', () =>
  {
    const { rerender } = renderHeader(model())
    screen.getByRole('button', { name: 'Output' }).focus()
    rerender(model(), { viewWidth: 650 })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More batch actions' }))
  })
})

describe('RunHeader confirmations', () =>
{
  it('asks inline before Cancel run, with focus on Keep running and Escape keeping the batch running', () =>
  {
    const { root, props } = renderHeader(running())
    const cancel = screen.getByRole('button', { name: 'Cancel run' })
    cancel.focus()
    fireEvent.click(cancel)
    const question = 'Cancel Batch 31? 3 jobs in progress stop and their partial files are deleted. 12 queued jobs are canceled. Finished jobs keep their outputs.'
    const group = screen.getByRole('group', { name: question })
    expect(group.closest('[data-slot]')).toHaveAttribute('data-slot', 'confirm')
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Keep running' }))
    expect(within(group).getByRole('button', { name: 'Cancel run' })).toHaveAttribute('data-variant', 'danger')
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(root.querySelector('[data-slot="run-controls"]')?.closest('[hidden]')).not.toBeNull()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: question })).toBeNull()
    expect(props.onCancelRun).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel run' }))
  })

  it('cancels the run on the danger choice and lands focus on the table once the run controls are gone', () =>
  {
    const { rerender, props } = renderHeader(running())
    const cancel = screen.getByRole('button', { name: 'Cancel run' })
    cancel.focus()
    fireEvent.click(cancel)
    const group = screen.getByRole('group', { name: /^Cancel Batch 31\?/ })
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel run' }))
    expect(props.onCancelRun).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel run' }))
    rerender(running({ sentence: sentenceOf(part('lead', 'Canceling · stopping 3 jobs')), controls: null }))
    expect(props.focusTable).toHaveBeenCalledTimes(1)
  })

  it('asks before Pause now discards more than 30 s of work', () =>
  {
    const { props } = renderHeader(running(), { discardedWork: () => 52 * 60 })
    fireEvent.click(screen.getByRole('button', { name: 'More pause options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause now: 3 running jobs restart from the beginning/, hidden: true }))
    const group = screen.getByRole('group', { name: 'Pause now? 3 running jobs restart from the beginning; 52 min of encoding is discarded.' })
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Keep running' }))
    expect(props.onPause).not.toHaveBeenCalled()

    fireEvent.keyDown(group, { key: 'Escape' })
    expect(props.onPause).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }))

    fireEvent.click(screen.getByRole('button', { name: 'More pause options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause now/, hidden: true }))
    fireEvent.click(within(screen.getByRole('group', { name: /^Pause now\?/ })).getByRole('button', { name: 'Pause now' }))
    expect(props.onPause).toHaveBeenCalledWith('stop-running')
  })

  it('pauses now without asking when 30 s or less of work is discarded', () =>
  {
    const { props } = renderHeader(running(), { discardedWork: () => 30 })
    fireEvent.click(screen.getByRole('button', { name: 'More pause options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause now/, hidden: true }))
    expect(screen.queryByRole('group', { name: /^Pause now\?/ })).toBeNull()
    expect(props.onPause).toHaveBeenCalledWith('stop-running')
  })

  it('drops a Pause now question whose running jobs have finished', () =>
  {
    const { rerender } = renderHeader(running(), { discardedWork: () => 120 })
    fireEvent.click(screen.getByRole('button', { name: 'More pause options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Pause now/, hidden: true }))
    expect(screen.getByRole('group', { name: /^Pause now\?/ })).toBeInTheDocument()
    rerender(running({ controls: runControls({ pauseNow: null }) }))
    expect(screen.queryByRole('group', { name: /^Pause now\?/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })
})

describe('RunHeader attention button', () =>
{
  const attention = { runId: RUN, count: 1, label: needAttention(1), tooltip: 'Show the jobs of Batch 31 that need attention (F8 steps through them)' }
  const withAttention = running({
    sentence: sentenceOf(part('lead', '10 of 22 finished'), part('attention', needAttention(1))),
    attention
  })

  it('asks the page for the Needs attention and In Batch filters, counted for this batch only', () =>
  {
    const { props } = renderHeader(withAttention)
    const button = screen.getByRole('button', { name: /1 needs attention/ })
    expect(button).toHaveAccessibleDescription(attention.tooltip)
    fireEvent.click(button)
    expect(props.onShowAttention).toHaveBeenCalledWith({
      runId: RUN,
      count: 1,
      filters: [{ facet: 'status', value: 'attention' }, { facet: 'batch', value: RUN }]
    })
  })

  it('names the full sentence as the header description', () =>
  {
    const { root } = renderHeader(withAttention)
    expect(root).toHaveAccessibleDescription('10 of 22 finished · 1 needs attention')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Batch 31')
  })
})

describe('RunHeader state sentence', () =>
{
  const busy = sentenceOf(
    part('lead', '24 jobs'),
    part('size', '35.6 GB'),
    part('media', '10 h 2 min of media'),
    part('blocked', '2 blocked'),
    part('warnings', '3 with warnings', '3 warnings')
  )

  function measureAt(available: number): void
  {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement)
    {
      return this.hasAttribute('data-sentence') ? available : 0
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement)
    {
      const width = (this.dataset.probeText ?? '').length * 7
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
  }

  function shownSentence(root: HTMLElement): string
  {
    const box = root.querySelector('[data-sentence]') as HTMLElement
    return (box.firstElementChild as HTMLElement).textContent ?? ''
  }

  it('sheds the media time, then the size, and never a problem, until row 1 fits', () =>
  {
    measureAt(300)
    const { root } = renderHeader(model({ sentence: busy }))
    expect(root.querySelector('[data-sentence]')).toHaveAttribute('data-shed-level', '2')
    expect(shownSentence(root)).toBe('24 jobs · 2 blocked · 3 with warnings')
    expect(root).toHaveAccessibleDescription(busy.full)
  })

  it('shortens the problems as the last step', () =>
  {
    measureAt(100)
    const { root } = renderHeader(model({ sentence: busy }))
    expect(shownSentence(root)).toBe('24 jobs · 2 blocked · 3 warnings')
  })

  it('keeps every part when the sentence fits', () =>
  {
    measureAt(2000)
    const { root } = renderHeader(model({ sentence: busy }))
    expect(shownSentence(root)).toBe(busy.full)
  })

  it('keeps counts and problems only below 700 px of view', () =>
  {
    const { root } = renderHeader(model({ sentence: busy }), { viewWidth: 650 })
    expect(shownSentence(root)).toBe('24 jobs · 2 blocked · 3 warnings')
    expect(root).toHaveAccessibleDescription(busy.full)
  })

  it('draws a pause the app made as a warning label', () =>
  {
    const paused = sentenceOf({ kind: 'lead', text: 'Paused: D: is full', short: 'Paused: D: is full', tone: 'warning' })
    const { root } = renderHeader(running({ sentence: paused, controls: runControls({ pause: null, pauseNow: null }) }))
    const label = root.querySelector('[data-sentence] [data-status="warning"]')
    expect(label).toHaveTextContent('Paused: D: is full')
  })
})

describe('RunHeader consequence line', () =>
{
  it('states the output policy as a sentence before a run', () =>
  {
    const { root } = renderHeader(withSlot(action('review', reviewLabel(24), { count: 24 })))
    const line = root.querySelector('[data-consequence]') as HTMLElement
    expect(line).toHaveAttribute('data-consequence', 'policy')
    expect(line).toHaveTextContent(POLICY_TEXT)
    expect(line.querySelector('[data-status]')).toBeNull()
  })

  it('turns into a warning label under Replace originals', () =>
  {
    const text = 'Replaces originals: each output is verified, then its original goes to the Recycle Bin. Ends with this batch.'
    const { root } = renderHeader(withSlot(action('review', reviewLabel(24), { count: 24 }), { consequence: { kind: 'policy', text, warning: true } }))
    const line = root.querySelector('[data-consequence]') as HTMLElement
    expect(line).toHaveAttribute('data-consequence', 'warning')
    expect(line.querySelector('[data-status="warning"]')).toHaveTextContent(text)
  })

  it('turns into the progress bar with its percent, time left, and throughput during a run', () =>
  {
    const { root } = renderHeader(running())
    const line = root.querySelector('[data-consequence]') as HTMLElement
    expect(line).toHaveAttribute('data-consequence', 'progress')
    const bar = within(line).getByRole('progressbar', { name: 'Batch 31 progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '46')
    expect(bar).toHaveAttribute('aria-valuetext', '46 percent, about 18 min left, 3.4x realtime')
    expect(line).toHaveTextContent('46%')
    expect(line.querySelector('[data-part="time-left"]')).toHaveTextContent('about 18 min left')
    expect(line.querySelector('[data-part="time-left"]')).toHaveAccessibleDescription(HEADER_TOOLTIPS.timeLeft)
    expect(line.querySelector('[data-part="throughput"]')).toHaveTextContent('3.4x realtime')
    expect(line.querySelector('[data-part="throughput"]')).toHaveAccessibleDescription(HEADER_TOOLTIPS.throughput)
  })

  it('freezes the bar and says Paused, without time left, while paused', () =>
  {
    const { root } = renderHeader(running({ consequence: { kind: 'progress', percent: 46, percentText: '46%', status: 'Paused', timeLeft: null, throughput: null } }))
    const line = root.querySelector('[data-consequence]') as HTMLElement
    expect(within(line).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '46 percent, Paused')
    expect(line.querySelector('[data-status="paused"]')).toHaveTextContent('Paused')
    expect(line.querySelector('[data-part="time-left"]')).toBeNull()
    expect(line.querySelector('[data-part="throughput"]')).toBeNull()
  })

  it('states what happened after a run', () =>
  {
    const outcome = 'Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched'
    const { root } = renderHeader(model({ title: 'Batch 31', subject: 'finished', slot: disabledReview(), consequence: { kind: 'outcome', text: outcome } }))
    expect(root.querySelector('[data-consequence="outcome"]')).toHaveTextContent(outcome)
  })

  it('leaves row 2 empty when there is nothing to state', () =>
  {
    const { root } = renderHeader(model({ consequence: null }))
    expect(root.querySelector('[data-consequence]')).toBeNull()
  })
})

describe('RunHeader after a run', () =>
{
  const outcome = 'Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched'
  const finished = withSlot(action('retry-returned', retryReturnedLabel(2), { count: 2 }), { title: 'Batch 31', subject: 'finished', consequence: { kind: 'outcome', text: outcome } })

  it('offers Open output folder and Export report in row 1', () =>
  {
    const { props } = renderHeader(finished, { outputFolders: ['D:\\Exports\\Podcasts'] })
    const open = screen.getByRole('button', { name: 'Open output folder' })
    expect(open).toHaveAccessibleDescription('D:\\Exports\\Podcasts')
    fireEvent.click(open)
    expect(props.onOpenFolder).toHaveBeenCalledWith('D:\\Exports\\Podcasts')

    const exportButton = screen.getByRole('button', { name: 'Export report' })
    expect(exportButton).toHaveAccessibleDescription('Saves a record of this batch: settings, outputs, measurements, and errors')
    fireEvent.click(exportButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV, one row per job', hidden: true }))
    expect(props.onExportReport).toHaveBeenCalledWith(RUN, 'csv')
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'JSON, full records', hidden: true }))
    expect(props.onExportReport).toHaveBeenCalledWith(RUN, 'json')
  })

  it('lists the folders under Show outputs when outputs sit next to their sources', () =>
  {
    const folders = ['D:\\Rips\\Live', 'D:\\Rips\\Interviews', 'E:\\Archive\\Tapes']
    const { props } = renderHeader(finished, { outputFolders: folders })
    expect(screen.queryByRole('button', { name: 'Open output folder' })).toBeNull()
    const show = screen.getByRole('button', { name: 'Show outputs' })
    expect(show).toHaveAccessibleDescription('Outputs are in 3 folders')
    fireEvent.click(show)
    fireEvent.click(screen.getByRole('menuitem', { name: 'D:\\Rips\\Interviews', hidden: true }))
    expect(props.onOpenFolder).toHaveBeenCalledWith('D:\\Rips\\Interviews')
  })

  it('moves the after-run actions into the batch overflow menu below 1000 px of view', () =>
  {
    const { props } = renderHeader(finished, { outputFolders: ['D:\\Exports\\Podcasts'], viewWidth: 960 })
    expect(screen.queryByRole('button', { name: 'Open output folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export report' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open output folder/, hidden: true }))
    expect(props.onOpenFolder).toHaveBeenCalledWith('D:\\Exports\\Podcasts')

    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Export report/, hidden: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV, one row per job', hidden: true }))
    expect(props.onExportReport).toHaveBeenCalledWith(RUN, 'csv')
  })

  it('moves Show outputs into the overflow menu too', () =>
  {
    const { props } = renderHeader(finished, { outputFolders: ['D:\\Rips\\Live', 'D:\\Rips\\Interviews'], viewWidth: 960 })
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Show outputs/, hidden: true }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'D:\\Rips\\Live', hidden: true }))
    expect(props.onOpenFolder).toHaveBeenCalledWith('D:\\Rips\\Live')
  })

  it('offers no after-run actions while a batch runs', () =>
  {
    renderHeader(running(), { outputFolders: ['D:\\Exports\\Podcasts'] })
    expect(screen.queryByRole('button', { name: 'Open output folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export report' })).toBeNull()
  })
})

describe('RunHeader overflow menu', () =>
{
  it('holds the batch log, Keyboard shortcuts, and the Inspector width radio items', () =>
  {
    const { props } = renderHeader(running(), { inspectorWidth: 360 })
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    expect(screen.getByRole('menuitem', { name: /Show log for Batch 31/, hidden: true })).toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Inspector width', hidden: true })
    const radios = within(group).getAllByRole('menuitemradio', { hidden: true })
    expect(radios.map((radio) => radio.textContent)).toEqual(['300 px', '360 px', '440 px', '520 px'])
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    fireEvent.click(radios[2])
    expect(props.onInspectorWidth).toHaveBeenCalledWith(440)

    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Keyboard shortcuts/, hidden: true }))
    expect(props.onShowShortcuts).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Show log for Batch 31/, hidden: true }))
    expect(props.onShowLog).toHaveBeenCalledWith(RUN)
  })

  it('leaves out the log while the header describes no batch', () =>
  {
    renderHeader(withSlot(action('review', reviewLabel(24), { count: 24 })))
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    expect(screen.queryByRole('menuitem', { name: /Show log/, hidden: true })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /^Keyboard shortcuts/, hidden: true })).toBeInTheDocument()
  })

  it('adds the page items it is given, such as Clear', () =>
  {
    const onClear = vi.fn()
    renderHeader(model(), { overflowItems: [{ id: 'clear', label: 'Clear finished jobs', onSelect: onClear }] })
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear finished jobs', hidden: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('RunHeader Output and Workers', () =>
{
  it('shows their full labels from 1000 px of view', () =>
  {
    const { props } = renderHeader(model())
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(props.onOutput).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '16 workers · GPU when allowed' }))
    expect(props.onWorkers).toHaveBeenCalledTimes(1)
  })

  it('drops the Workers value below 1000 px of view', () =>
  {
    renderHeader(model(), { viewWidth: 960 })
    expect(screen.getByRole('button', { name: 'Workers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Output' })).toBeInTheDocument()
  })

  it('moves Output and Workers into the overflow menu below 700 px of view', () =>
  {
    const { props } = renderHeader(model(), { viewWidth: 650 })
    expect(screen.queryByRole('button', { name: 'Output' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Workers' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Output', hidden: true }))
    expect(props.onOutput).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'More batch actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workers', hidden: true }))
    expect(props.onWorkers).toHaveBeenCalledTimes(1)
  })

  it('hands the page its triggers with the label, tooltip, and lock of the moment', () =>
  {
    const renderOutput = vi.fn((control: { label: string }) => <button type="button">{`${control.label} trigger`}</button>)
    const renderWorkers = vi.fn((control: { label: string }) => <button type="button">{`${control.label} trigger`}</button>)
    renderHeader(running({ output: { label: 'Output', tooltip: 'Output unlocks when 3 running jobs finish.', locked: true }, workers: { label: '16 workers · 6 active', shortLabel: 'Workers', tooltip: HEADER_TOOLTIPS.workers } }), { renderOutput, renderWorkers })
    expect(renderOutput).toHaveBeenLastCalledWith({ label: 'Output', tooltip: 'Output unlocks when 3 running jobs finish.', locked: true })
    expect(renderWorkers).toHaveBeenLastCalledWith({ label: '16 workers · 6 active', tooltip: HEADER_TOOLTIPS.workers, locked: false })
    expect(screen.getByRole('button', { name: 'Output trigger' }).closest('[data-slot]')).toHaveAttribute('data-slot', 'output')
    expect(screen.getByRole('button', { name: '16 workers · 6 active trigger' }).closest('[data-slot]')).toHaveAttribute('data-slot', 'workers')
  })
})
