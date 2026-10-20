/**
 * The Recipe tab and its field sets: commit before acting, mixed operations, locked jobs, attempt drafts, the
 * out-of-reach policy, mono, short-form, and the Gain fields with their predicted peak limiting line.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import { formatCatalog, formatRunId, type JobId } from '../../../src/shared/jobs/ids'
import { DEFAULT_PINS } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { JobMeasurement, JobView, PreflightReport, PresetState } from '../../../src/shared/jobs/types'
import type { JobsApi } from '../../../src/shared/jobs/contract'
import { operationStart, type FieldState, type OperationField, type RecipeContext } from '../../../src/renderer/src/stores/recipeFields'
import { createJobsStore } from '../../../src/renderer/src/stores/jobs'
import { createBatchViewStore } from '../../../src/renderer/src/stores/batchView'
import type { BatchActions, StartOutcome } from '../../../src/renderer/src/stores/batchActions'
import { createTestBatchActions, TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import { draftActions, operationNotes, RecipeTab } from '../../../src/renderer/src/components/batch/inspector/RecipeTab'
import
{
  draftRegistry,
  draftSelection,
  patchLabel,
  selectionLock,
  withoutLockReason,
  type SentEdit
} from '../../../src/renderer/src/components/batch/inspector/RecipeEditor'
import { valueText, withCheckedHint } from '../../../src/renderer/src/components/batch/inspector/fields/NormalizeFields'

const OUT = { kind: 'same-as-source' } as const
const RUN = formatRunId(31)

let seq = 0

beforeEach(() =>
{
  window.localStorage.clear()
})

afterEach(() =>
{
  cleanup()
  vi.restoreAllMocks()
})

function job(recipe: Recipe, over: Partial<JobView> = {}): JobView
{
  seq += 1
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `C:/media/take-${seq}.wav`, name: `take-${seq}.wav`, ext: '.wav', dir: 'C:/media', size: 1000, mtimeMs: 0, origin: 'files', subdir: '' },
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

function presets(over: Partial<PresetState> = {}): PresetState
{
  return { user: [], pins: { ...DEFAULT_PINS }, recent: [], ...over }
}

function ctx(over: Partial<RecipeContext> = {}): RecipeContext
{
  return { presets: presets(), output: OUT, albumIds: [], ...over }
}

function loudness(id: Parameters<typeof applyLoudnessPreset>[0], lufs?: number): Recipe
{
  const recipe = applyLoudnessPreset(id, OUT)
  return (lufs === undefined ? recipe : { ...recipe, target: { ...recipe.target, integratedLufs: lufs } }) as Recipe
}

function report(id: string): PreflightReport
{
  return {
    preflightId: id,
    createdAt: 0,
    policyRev: 1,
    capabilitiesRev: 1,
    jobs: [],
    counts: { jobs: 1, ready: 1, blocked: 0, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0 },
    volumes: [],
    collisions: [],
    blocking: [],
    warnings: [],
    limits: { total: 4, videoCpu: 2, gpu: 1 }
  } as unknown as PreflightReport
}

function ok(value: unknown, at: number = 0): { ok: true; value: unknown; seq: number }
{
  return { ok: true, value, seq: at }
}

function fail(code: string, details: unknown = null): { ok: false; error: { code: string; message: string; issues: never[]; details: unknown } }
{
  return { ok: false, error: { code, message: code, issues: [], details } }
}

async function flush(): Promise<void>
{
  for (let index = 0; index < 10; index += 1)
  {
    await act(async () =>
    {
      await Promise.resolve()
    })
  }
}

/** Real actions over a store that holds the given jobs, with engine commands as spies. */
function harness(rows: JobView[], api: Partial<Record<keyof JobsApi, ReturnType<typeof vi.fn>>> = {})
{
  const jobs = createJobsStore()
  jobs.setState({ order: rows.map((row) => row.id), jobs: Object.fromEntries(rows.map((row) => [row.id, row])), seq: 1 })
  const view = createBatchViewStore({ storage: null })
  const announce = vi.fn()
  const spies = {
    preflight: vi.fn(async () => ok(report('pf-1'))),
    assignRecipe: vi.fn(async (req: { assignments: Array<{ jobId: JobId }> }) => ok({ applied: req.assignments.map((entry) => entry.jobId), refused: [] }, 7)),
    start: vi.fn(async () => fail('plan-stale', { changed: rows.map((row) => row.id) })),
    unqueue: vi.fn(async (req: { ids: JobId[] }) => ok({ applied: req.ids, refused: [] }, 2)),
    ...api
  }
  const actions = createTestBatchActions({ api: spies as unknown as Partial<JobsApi>, jobs, view, announce })
  return { jobs, view, api: spies, actions, announce }
}

/** The page around the tab: Ctrl+Enter runs the brass action, Start here. */
function Page({ actions, children, onStart }: { actions: BatchActions; children: React.ReactNode; onStart(outcome: Promise<StartOutcome>): void }): React.JSX.Element
{
  return (
    <TestBatchActionsProvider actions={actions}>
      <div
        onKeyDown={(event) =>
        {
          if (event.key === 'Enter' && event.ctrlKey)
          {
            event.preventDefault()
            onStart(actions.start())
          }
        }}
      >
        {children}
      </div>
    </TestBatchActionsProvider>
  )
}

function spin(name: string): HTMLInputElement
{
  return screen.getByRole('spinbutton', { name }) as HTMLInputElement
}

describe('commit before acting', () =>
{
  it('sends no Start until the typed target has applied, which then returns plan-stale', async () =>
  {
    const row = job(loudness('custom', -16))
    const { jobs, api, actions } = harness([row])
    await actions.openReview()
    let outcome: Promise<StartOutcome> | null = null
    render(
      <Page actions={actions} onStart={(started) => { outcome = started }}>
        <RecipeTab jobs={[row]} ctx={ctx()} onSelectOnly={() => undefined} />
      </Page>
    )
    const target = spin('Target, integrated exact value')
    act(() => target.focus())
    fireEvent.change(target, { target: { value: '-18' } })
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true })
    await flush()
    expect(outcome).not.toBeNull()
    expect(api.assignRecipe).toHaveBeenCalledTimes(1)
    const [request] = api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ jobId: JobId; recipe: Recipe }> }]
    expect(request.assignments).toHaveLength(1)
    expect((request.assignments[0].recipe as { target: { integratedLufs: number } }).target.integratedLufs).toBe(-18)
    expect(api.start).not.toHaveBeenCalled()
    act(() => jobs.setState({ seq: 7 }))
    await expect(outcome).resolves.toEqual({
      status: 'stale',
      changed: [row.id],
      reason: 'Target, integrated changed for 1 job. Review it, then Start again.'
    })
    expect(api.start).toHaveBeenCalledTimes(1)
  })
})

function renderTab(rows: JobView[], options: { drafts?: ReadonlySet<JobId>; onSelectOnly?: (ids: readonly JobId[]) => void; context?: RecipeContext } = {}, api: Parameters<typeof harness>[1] = {})
{
  const built = harness(rows, api)
  const onSelectOnly = vi.fn(options.onSelectOnly ?? (() => undefined))
  const view = render(
    <TestBatchActionsProvider actions={built.actions}>
      <RecipeTab jobs={rows} ctx={options.context ?? ctx()} drafts={options.drafts} onSelectOnly={onSelectOnly} />
    </TestBatchActionsProvider>
  )
  return { ...built, onSelectOnly, view }
}

describe('mixed operations', () =>
{
  it('replaces the fields with the prompt and one Select only link per operation', () =>
  {
    const rows = [job(loudness('ebu-r128')), job(loudness('spotify')), job(applyGainPreset('gentle-lift', OUT) as Recipe)]
    const { onSelectOnly } = renderTab(rows)
    expect(screen.getByText('These jobs use different operations. Choose one operation for all 3, or narrow the selection:')).toBeTruthy()
    const operation = screen.getByLabelText('Operation') as HTMLSelectElement
    expect(operation.selectedOptions[0].textContent).toBe('Mixed: 2 Normalize, 1 Gain')
    expect(screen.queryByLabelText('Preset')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select only Gain (1)' }))
    expect(onSelectOnly).toHaveBeenCalledWith([rows[2].id])
    fireEvent.click(screen.getByRole('button', { name: 'Select only Normalize (2)' }))
    expect(onSelectOnly).toHaveBeenLastCalledWith([rows[0].id, rows[1].id])
  })

  it('gives every selected job the chosen operation as a whole recipe', async () =>
  {
    const rows = [job(loudness('ebu-r128')), job(applyGainPreset('gentle-lift', OUT) as Recipe)]
    const { api } = renderTab(rows)
    fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'normalize' } })
    await flush()
    expect(api.assignRecipe).toHaveBeenCalledTimes(1)
    const [request] = api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ jobId: JobId; recipe: Recipe }> }]
    expect(request.assignments.every((entry) => entry.recipe.kind === 'normalize')).toBe(true)
    expect(request.assignments.map((entry) => entry.jobId)).toContain(rows[1].id)
  })

  it('narrows a locked mixed selection without offering to change it', () =>
  {
    const rows = [job(loudness('ebu-r128'), { state: 'done', runId: RUN }), job(applyGainPreset('gentle-lift', OUT) as Recipe, { state: 'done', runId: RUN })]
    renderTab(rows)
    expect(screen.getByText('These jobs use different operations. Narrow the selection:')).toBeTruthy()
    expect((screen.getByLabelText('Operation') as HTMLSelectElement).disabled).toBe(true)
  })
})

describe('locked jobs', () =>
{
  it('shows a finished job read-only with the frozen reason', () =>
  {
    const row = job(loudness('custom', -16), { state: 'done', runId: RUN })
    const { view } = renderTab([row])
    const lock = view.container.querySelector('[data-recipe-lock]') as HTMLElement
    expect(lock.textContent).toBe('Frozen when Batch 31 started. To change it, use Edit and retry.')
    expect(spin('Target, integrated exact value').disabled).toBe(true)
    expect((screen.getByLabelText('Operation') as HTMLSelectElement).disabled).toBe(true)
    expect(view.container.querySelector('[data-recipe-editor]')?.getAttribute('data-recipe-editor')).toBe('locked')
    expect(screen.queryByRole('button', { name: /Take out/ })).toBeNull()
  })

  it('shows a queued job read-only with the queued reason and takes it out of the batch', async () =>
  {
    const row = job(loudness('custom', -16), { state: 'queued', runId: RUN })
    const { view, api } = renderTab([row])
    const lock = view.container.querySelector('[data-recipe-lock]') as HTMLElement
    expect(lock.textContent).toContain('Queued in Batch 31. Take it out of the batch to edit it.')
    expect(spin('Target, integrated exact value').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Take out of Batch 31' }))
    await flush()
    expect(api.unqueue).toHaveBeenCalledWith({ ids: [row.id] })
  })

  it('states one count when the locked jobs keep their settings for different reasons', () =>
  {
    const rows = [job(loudness('ebu-r128'), { state: 'done', runId: RUN }), job(loudness('ebu-r128'), { state: 'queued', runId: RUN })]
    const { view } = renderTab(rows)
    const lock = view.container.querySelector('[data-recipe-lock]') as HTMLElement
    expect(lock.textContent).toBe('2 queued, running, or finished jobs keep their settings.')
  })
})

describe('attempt drafts', () =>
{
  it('shows the note, edits the returned job, and its first change sends it back to the queue', async () =>
  {
    const row = job(loudness('custom', -16), { state: 'failed', runId: RUN, attempt: 1 })
    const { view, api } = renderTab([row], { drafts: new Set([row.id]) })
    expect(view.container.querySelector('[data-attempt-draft]')?.textContent).toBe(`Editing ${row.id} for attempt 2. Attempt 1 stays in the record.`)
    expect(view.container.querySelector('[data-recipe-lock]')).toBeNull()
    const target = spin('Target, integrated exact value')
    expect(target.disabled).toBe(false)
    act(() => target.focus())
    fireEvent.change(target, { target: { value: '-20' } })
    fireEvent.keyDown(target, { key: 'Enter' })
    await flush()
    expect(api.assignRecipe).toHaveBeenCalledTimes(1)
    const [request] = api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ jobId: JobId; recipe: Recipe }> }]
    expect(request.assignments.map((entry) => entry.jobId)).toEqual([row.id])
  })

  it('names the next attempt for several drafts at once', () =>
  {
    const rows = [job(loudness('ebu-r128'), { state: 'failed', runId: RUN }), job(loudness('ebu-r128'), { state: 'failed', runId: RUN })]
    const { view } = renderTab(rows, { drafts: new Set(rows.map((row) => row.id)) })
    expect(view.container.querySelector('[data-attempt-draft]')?.textContent).toBe('Editing 2 jobs for their next attempt. Earlier attempts stay in the record.')
  })
})

function group(name: string): HTMLElement
{
  return screen.getByRole('radiogroup', { name })
}

function radios(name: string): HTMLElement[]
{
  return Array.from(group(name).querySelectorAll('[role="radio"]')) as HTMLElement[]
}

/** Opens More settings, where the rarely changed fields wait, when it is closed. */
function openMore(): void
{
  const more = screen.queryByRole('button', { name: 'More settings' })
  if (more !== null)
  {
    fireEvent.click(more)
  }
}

function policyRadios(): HTMLInputElement[]
{
  openMore()
  return Array.from(group('When the target is out of reach').querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
}

function radioLabel(input: HTMLInputElement): string
{
  return input.closest('label')?.textContent ?? ''
}

describe('normalize fields', () =>
{
  it('draws the out-of-reach policy as a RadioList whose allowance is enabled only while its option is checked', async () =>
  {
    const stop = job({ ...loudness('custom', -16), policy: 'stop-at-reachable' } as Recipe)
    const first = renderTab([stop])
    const options = policyRadios()
    expect(options.map(radioLabel)).toEqual(expect.arrayContaining(['Stop at the reachable level']))
    expect(options.length).toBe(3)
    const allowance = first.view.container.querySelector('[data-field="allowance"] input') as HTMLInputElement
    expect(allowance).not.toBeNull()
    expect(allowance.matches(':disabled')).toBe(true)
    const limit = options.find((option) => /limiting/i.test(radioLabel(option))) as HTMLInputElement
    fireEvent.click(limit)
    await flush()
    expect(first.api.assignRecipe).toHaveBeenCalledTimes(1)
    const [request] = first.api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ recipe: { policy: string } }> }]
    expect(request.assignments[0].recipe.policy).toBe('peak-limit')
    cleanup()
    const limited = job({ ...loudness('custom', -16), policy: 'peak-limit' } as Recipe)
    const second = renderTab([limited])
    const enabled = second.view.container.querySelector('[data-field="allowance"] input') as HTMLInputElement
    expect(enabled.matches(':disabled')).toBe(false)
    expect(radioLabel(policyRadios().find((option) => option.checked) as HTMLInputElement)).toMatch(/limiting/i)
  })

  it('checks no policy and hints Mixed when the jobs differ', () =>
  {
    const rows = [job({ ...loudness('custom', -16), policy: 'stop-at-reachable' } as Recipe), job({ ...loudness('custom', -16), policy: 'peak-limit' } as Recipe)]
    const { view } = renderTab(rows)
    expect(policyRadios().some((option) => option.checked)).toBe(false)
    expect((view.container.querySelector('[data-field="policy"]') as HTMLElement).textContent).toContain('Mixed')
  })

  it('keeps mono read-only for a standard and editable for Custom', () =>
  {
    const standard = renderTab([job(loudness('ebu-r128'))])
    openMore()
    const fixed = standard.view.container.querySelector('[data-field="mono"]') as HTMLElement
    expect(fixed.textContent).toContain('Fixed by EBU R 128. Choose Custom to set your own.')
    const fixedRadios = Array.from(fixed.querySelectorAll('[role="radio"]')) as HTMLButtonElement[]
    expect(fixedRadios.every((option) => option.disabled || option.getAttribute('aria-disabled') === 'true')).toBe(true)
    cleanup()
    const custom = renderTab([job(loudness('custom', -16))])
    openMore()
    const open = Array.from((custom.view.container.querySelector('[data-field="mono"]') as HTMLElement).querySelectorAll('[role="radio"]')) as HTMLButtonElement[]
    expect(open.map((option) => option.textContent)).toEqual(['One channel', 'Two speakers'])
    expect(open.some((option) => option.disabled || option.getAttribute('aria-disabled') === 'true')).toBe(false)
  })

  it('states the Apple Podcasts duplication as read-only text', () =>
  {
    const { view } = renderTab([job(loudness('apple-podcasts'))])
    openMore()
    expect((view.container.querySelector('[data-field="mono"]') as HTMLElement).textContent).toContain('Duplicated into two identical channels (Apple Podcasts)')
  })

  it('offers the short-form limit as a SegmentedControl with Automatic, Always, and Never', async () =>
  {
    const { api } = renderTab([job(loudness('ebu-r128'))])
    openMore()
    const segments = radios('Short-form limit')
    expect(segments.map((segment) => segment.textContent)).toEqual(['Automatic', 'Always', 'Never'])
    fireEvent.click(segments[2])
    await flush()
    const [request] = api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ recipe: { shortForm: { mode: string } } }> }]
    expect(request.assignments[0].recipe.shortForm.mode).toBe('off')
  })

  it('shows a fixed target read-only with its reason', () =>
  {
    const { view } = renderTab([job(loudness('ebu-r128'))])
    const target = view.container.querySelector('[data-field="target"]') as HTMLElement
    expect(target.textContent).toContain('Fixed by EBU R 128. Choose Custom to set your own.')
  })
})

function measured(truePeak: number | null, pass: JobMeasurement['pass'] = 'source'): JobMeasurement
{
  return {
    pass,
    measuredAt: 0,
    streams: [{ measurement: { audioIndex: 0, layout: 'stereo', channels: 2, sampleRate: 48000, stats: { truePeakDbtp: truePeak } }, plan: null }],
    album: null,
    messages: []
  } as unknown as JobMeasurement
}

function gainRecipe(over: Partial<Record<'gainDb' | 'maxTruePeakDbtp' | 'maxLimitingDb', number>> = {}): Recipe
{
  return { ...applyGainPreset('louder', OUT), maxTruePeakDbtp: -1, maxLimitingDb: 1, ...over } as Recipe
}

function renderGain(rows: JobView[], measurement: JobMeasurement | null = null, api: Parameters<typeof harness>[1] = {})
{
  const built = harness(rows, api)
  const view = render(
    <TestBatchActionsProvider actions={built.actions}>
      <RecipeTab jobs={rows} ctx={ctx()} onSelectOnly={() => undefined} measurement={measurement} />
    </TestBatchActionsProvider>
  )
  const line = (): string => (view.container.querySelector('[data-field="predictedLimiting"] [role="status"]') as HTMLElement).textContent ?? ''
  return { ...built, view, line }
}

describe('gain fields', () =>
{
  it('edits the gain in dB as one patch', async () =>
  {
    const { api, view } = renderGain([job(gainRecipe())])
    expect(view.container.textContent).toContain('App presets, not standards.')
    const gain = spin('Gain exact value')
    expect((view.container.querySelector('[data-field="gain"]') as HTMLElement).textContent).toContain('dB')
    act(() => gain.focus())
    fireEvent.change(gain, { target: { value: '3' } })
    fireEvent.keyDown(gain, { key: 'Enter' })
    await flush()
    expect(api.assignRecipe).toHaveBeenCalledTimes(1)
    const [request] = api.assignRecipe.mock.calls[0] as [{ assignments: Array<{ recipe: { gainDb: number } }> }]
    expect(request.assignments[0].recipe.gainDb).toBe(3)
  })

  it('predicts the peak limiting for a measured source and the gain it applies over the allowance', () =>
  {
    const over = renderGain([job(gainRecipe())], measured(-5))
    expect(over.line()).toBe('Applying +5.0 dB of the requested +6.0 dB: the full gain needs 2.0 dB of peak limiting, over the 1.0 dB allowance.')
    cleanup()
    const within = renderGain([job(gainRecipe({ gainDb: 2.5 }))], measured(-3))
    expect(within.line()).toMatch(/^Measured true peak .3\.0 dBTP\. \+2\.5 dB needs about 0\.5 dB of peak limiting to stay under the .1\.0 dBTP ceiling\.$/)
    cleanup()
    const none = renderGain([job(gainRecipe({ gainDb: 1 }))], measured(-6, 'preview'))
    expect(none.line()).toMatch(/needs no peak limiting/)
  })

  it('offers Measure now before the source is measured, and defers to Plan for several jobs', async () =>
  {
    const analyze = vi.fn(async (req: { ids: JobId[] }) => ok({ applied: req.ids, refused: [] }, 3))
    const one = renderGain([job(gainRecipe())], null, { analyze })
    expect(one.line()).toBe('Known after measuring.')
    fireEvent.click(screen.getByRole('button', { name: 'Measure now' }))
    await flush()
    expect(analyze).toHaveBeenCalledTimes(1)
    cleanup()
    const several = renderGain([job(gainRecipe()), job(gainRecipe())])
    expect(several.line()).toBe('Depends on each file\'s true peak. See Output for each job.')
    expect(screen.queryByRole('button', { name: 'Measure now' })).toBeNull()
    cleanup()
    const silent = renderGain([job(gainRecipe())], measured(null, 'after-dynamics'))
    expect(silent.line()).toBe('Known after measuring.')
    expect(screen.queryByRole('button', { name: 'Measure now' })).toBeNull()
  })
})

describe('commit before acting, other paths', () =>
{
  it('refuses Start on an invalid draft and names the field', async () =>
  {
    const row = job(loudness('custom', -16))
    const { api, actions, announce } = harness([row])
    await actions.openReview()
    let outcome: Promise<StartOutcome> | null = null
    render(
      <Page actions={actions} onStart={(started) => { outcome = started }}>
        <RecipeTab jobs={[row]} ctx={ctx()} onSelectOnly={() => undefined} />
      </Page>
    )
    const target = spin('Target, integrated exact value')
    act(() => target.focus())
    fireEvent.change(target, { target: { value: 'loud' } })
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true })
    await flush()
    await expect(outcome).resolves.toEqual({ status: 'invalid-draft', field: 'Target, integrated' })
    expect(announce).toHaveBeenCalledWith('Fix Target, integrated first.')
    expect(api.assignRecipe).not.toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled()
  })

  it('waits for the commit a blur already sent when Start is pressed with the pointer', async () =>
  {
    const row = job(loudness('custom', -16))
    let answer: (value: unknown) => void = () => undefined
    const assignRecipe = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    const { jobs, api, actions } = harness([row], { assignRecipe })
    await actions.openReview()
    render(
      <TestBatchActionsProvider actions={actions}>
        <RecipeTab jobs={[row]} ctx={ctx()} onSelectOnly={() => undefined} />
        <button type="button">Start</button>
      </TestBatchActionsProvider>
    )
    const peak = spin('Maximum true peak')
    act(() => peak.focus())
    fireEvent.change(peak, { target: { value: '-2' } })
    act(() => screen.getByRole('button', { name: 'Start' }).focus())
    expect(assignRecipe).toHaveBeenCalledTimes(1)
    const outcome = actions.start()
    await flush()
    answer(ok({ applied: [row.id], refused: [] }, 9))
    await flush()
    expect(api.start).not.toHaveBeenCalled()
    act(() => jobs.setState({ seq: 9 }))
    await expect(outcome).resolves.toMatchObject({ status: 'stale', reason: 'Maximum true peak changed for 1 job. Review it, then Start again.' })
  })
})

describe('operation field sets', () =>
{
  it.each(['convert', 'compress', 'extract'] as const)('draws the %s fields', (op) =>
  {
    const { view } = renderTab([job(operationStart(op, ctx()))])
    const editor = view.container.querySelector('[data-recipe-editor]') as HTMLElement
    expect(editor.getAttribute('data-recipe-editor')).toBe('editable')
    expect(editor.querySelectorAll('[data-field]').length).toBeGreaterThan(0)
  })

  it('draws nothing for an empty selection', () =>
  {
    const { view } = renderTab([])
    expect(view.container.querySelector('[data-recipe-tab]')).toBeNull()
  })
})

function sel(over: Partial<OperationField>): OperationField
{
  const option = (value: OperationField['value'], label: string, note: string | null) =>
    ({ key: value, value, label, description: null, group: null, disabled: false, reason: null, note })
  return {
    label: 'Operation',
    value: 'normalize',
    mixed: false,
    distinct: [],
    text: 'Normalize',
    options: [
      option('normalize', 'Normalize', null),
      option('compress', 'Compress', '8 of 38 have no video stream; Compress needs one, so they would be blocked.'),
      option('extract', 'Extract', '')
    ],
    prompt: null,
    selectOnly: [],
    disabled: false,
    reason: null,
    count: 2,
    ...over
  }
}

function state(over: Partial<FieldState>): FieldState
{
  return {
    key: 'target',
    label: 'Target, integrated',
    kind: 'range',
    value: -16,
    mixed: false,
    distinct: [],
    text: '-16.0 LUFS',
    mixedText: null,
    disabled: false,
    reason: null,
    hint: null,
    error: null,
    note: null,
    unit: 'LUFS',
    range: { min: -60, max: -5, step: 0.1 },
    options: null,
    nested: null,
    more: false,
    count: 1,
    edited: 0,
    lockedNote: null,
    ...over
  } as FieldState
}

describe('helpers', () =>
{
  it('lists what choosing another operation would block', () =>
  {
    expect(operationNotes(sel({}))).toEqual(['Compress: 8 of 38 have no video stream; Compress needs one, so they would be blocked.'])
    expect(operationNotes(sel({ disabled: true }))).toEqual([])
    expect(operationNotes(sel({ mixed: true }))).toHaveLength(1)
  })

  it('passes actions through unless attempt drafts need retryDraft', async () =>
  {
    const assignRecipes = vi.fn(async () => ({ status: 'empty' }))
    const actions = { assignRecipes } as unknown as BatchActions
    expect(draftActions(actions, false)).toBe(actions)
    await draftActions(actions, true).assignRecipes([], { field: 'Gain' })
    await draftActions(actions, true).assignRecipes([])
    expect(assignRecipes.mock.calls).toEqual([[[], { field: 'Gain', retryDraft: true }], [[], { retryDraft: true }]])
  })

  it('counts only finished drafts as editable', () =>
  {
    const done = job(loudness('ebu-r128'), { state: 'done', runId: RUN })
    const queued = job(loudness('ebu-r128'), { state: 'queued', runId: RUN })
    const drafts = new Set([done.id, queued.id])
    expect(draftSelection([done, queued], drafts).map((row) => row.state)).toEqual(['pending', 'queued'])
    expect(selectionLock([job(loudness('ebu-r128'))])).toBeNull()
    expect(selectionLock([])).toBeNull()
  })

  it('drops the repeated lock reason from fields and their nested field', () =>
  {
    const lock = { text: 'Frozen when Batch 31 started.', action: null, queued: [] }
    const nested = state({ key: 'allowance', label: 'Peak limiting allowance', reason: lock.text })
    const [stripped, kept] = withoutLockReason([state({ reason: lock.text, nested }), state({ reason: 'Fixed by EBU R 128.' })], lock)
    expect(stripped.reason).toBeNull()
    expect(stripped.nested?.reason).toBeNull()
    expect(kept.reason).toBe('Fixed by EBU R 128.')
    expect(withoutLockReason([state({ reason: lock.text })], null)[0].reason).toBe(lock.text)
  })

  it('names the field a patch sets, nested fields included', () =>
  {
    const fields = [state({ nested: state({ key: 'allowance', label: 'Peak limiting allowance' }) })]
    expect(patchLabel(fields, { field: 'target', value: -18 })).toBe('Target, integrated')
    expect(patchLabel(fields, { field: 'allowance', value: 2 })).toBe('Peak limiting allowance')
    expect(patchLabel(fields, { field: 'gain', value: 2 })).toBe('Settings')
  })

  it('commits nothing when the draft sent nothing, and nothing for a refused assignment', async () =>
  {
    let committer: () => unknown = () => null
    const actions = {
      registerDraftCommitter: (fn: () => unknown) =>
      {
        committer = fn
        return () => undefined
      }
    } as unknown as BatchActions
    const last: { current: SentEdit | null } = { current: null }
    draftRegistry(actions, last).register('Gain', async () => 'unchanged')
    await expect(committer()).resolves.toEqual({ status: 'none' })
    draftRegistry(actions, last).register('Gain', async () =>
    {
      last.current = { field: 'Gain', promise: Promise.resolve({ status: 'refused' } as never), settled: true }
      return 'committed'
    })
    await expect(committer()).resolves.toEqual({ status: 'none' })
  })

  it('states values in their unit and a segmented choice by its description', () =>
  {
    expect(valueText(state({ key: 'gain', unit: 'dB', range: { min: -20, max: 12, step: 0.5 } }), 3)).toMatch(/^\+3\.0 dB$/)
    expect(valueText(state({ unit: null, range: null }), -18)).toMatch(/^.18\.0$/)
    const segmented = state({
      kind: 'segmented',
      value: 'auto' as never,
      options: [{ key: 'auto', value: 'auto', label: 'Automatic', description: 'By duration.', group: null, disabled: false, reason: null, note: null }] as never
    })
    expect(withCheckedHint(segmented).hint).toBe('By duration.')
    expect(withCheckedHint({ ...segmented, mixed: true })).toEqual({ ...segmented, mixed: true })
    expect(withCheckedHint({ ...segmented, value: 'on' } as FieldState).hint).toBeNull()
  })
})
