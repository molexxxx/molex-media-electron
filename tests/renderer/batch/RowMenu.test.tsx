/**
 * The Batch table's row menu: every action names its job, unavailable items keep their reason as visible text,
 * moves are unavailable while sorted, and Cancel job, several skips, and decisions confirm first at the row.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { formatRunId, type JobId } from '../../../src/shared/jobs/ids'
import { applyPreset } from '../../../src/shared/jobs/presets'
import type { JobView, MediaSummary, PlanSummary, Recipe } from '../../../src/shared/jobs/types'
import { createTestBatchActions, TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import { createBatchViewStore, type ViewKey } from '../../../src/renderer/src/stores/batchView'
import { createJobsStore, initialJobsState, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { Menu, type MenuEntry, type MenuItem } from '../../../src/renderer/src/ui/Menu'
import
{
  ACKNOWLEDGE_FIRST,
  menuTargets,
  RECENT_RECIPES,
  revealText,
  rowElement,
  rowMenuEntries,
  rowPhase,
  TableConfirm,
  targetName,
  useRowMenu,
  type RowMenuContext
} from '../../../src/renderer/src/components/batch/table/RowMenu'
import { REORDER_SORTED, useTableCommands, type ConfirmRequest } from '../../../src/renderer/src/components/batch/table/tableCommands'

afterEach(() =>
{
  cleanup()
})

const AT = new Date(2026, 9, 16, 13, 40).getTime()

const RECIPE = { kind: 'normalize', presetId: 'streaming' } as unknown as JobView['recipe']

const RUN = formatRunId(31)

let seq = 0

function plan(over: Partial<PlanSummary> = {}): PlanSummary
{
  return {
    status: 'ready',
    current: true,
    finalName: 'a.wav',
    relativePath: 'a.wav',
    container: 'wav',
    resolution: 'place',
    encoderLabel: 'PCM 24-bit',
    errors: 0,
    warnings: 0,
    firstIssue: null,
    ...over
  } as PlanSummary
}

function media(): MediaSummary
{
  return { container: 'wav', durationSec: 3730, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false } as MediaSummary
}

function job(over: Partial<JobView> = {}): JobView
{
  seq += 1
  const id = `MM-${String(seq).padStart(4, '0')}` as JobId
  return {
    id,
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.wav`, name: `${id}.wav`, ext: 'wav', dir: 'D:\\Rips', size: 498_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE,
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: media(),
    probe: 'ok',
    plan: plan(),
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
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function jobsState(jobs: readonly JobView[], recent: Recipe[] = []): JobsState
{
  return {
    ...initialJobsState(),
    status: 'hydrated',
    hydrations: 1,
    order: jobs.map((entry) => entry.id),
    jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])),
    presets: { user: [], pins: {}, recent }
  } as JobsState
}

type Spy = ReturnType<typeof vi.fn>

interface Harness
{
  ctx: RowMenuContext
  confirms: ConfirmRequest[]
  announced: string[]
  spies: Record<string, Spy>
}

function harness(jobs: readonly JobView[], over: Partial<RowMenuContext> = {}, selected: readonly JobView[] = jobs.slice(0, 1)): Harness
{
  const done = { status: 'done', value: { applied: [], refused: [] }, seq: 1, entryId: null }
  const spies: Record<string, Spy> = {
    send: vi.fn(async () => ({ status: 'done', value: null, seq: 1 })),
    duplicate: vi.fn(async () => done),
    move: vi.fn(async () => done),
    remove: vi.fn(async () => done),
    skip: vi.fn(async () => done),
    takeOut: vi.fn(async () => done),
    cancelJobs: vi.fn(async () => done),
    keepOutput: vi.fn(async () => done),
    discardOutput: vi.fn(async () => done),
    retry: vi.fn(async () => done),
    acknowledge: vi.fn(async () => done),
    deleteJobs: vi.fn(async () => ({ status: 'done', plan: { remove: [], skip: [], clear: [], running: [], attention: [] } })),
    assignRecipes: vi.fn(async () => done),
    select: vi.fn(),
    selectSimilar: vi.fn(() => 'Selected 2 jobs with the same type.')
  }
  const confirms: ConfirmRequest[] = []
  const announced: string[] = []
  const ctx: RowMenuContext = {
    actions: { ...createTestBatchActions(), ...spies } as unknown as BatchActions,
    list: 'queue',
    mode: 'queue',
    platform: 'win32',
    jobs: jobsState(jobs),
    selection: { selected: new Set(selected.map((entry) => entry.id)), anchor: null, focus: selected[0]?.id ?? null },
    sorted: false,
    replaceMode: false,
    now: AT + 271_000,
    host: {},
    view: { select: spies.select, selectSimilar: spies.selectSimilar } as unknown as RowMenuContext['view'],
    confirm: (request) => void confirms.push(request),
    announce: (message) => void announced.push(message),
    writeText: vi.fn(),
    ...over
  }
  return { ctx, confirms, announced, spies }
}

/** Every item of a menu, submenu items after their parent. */
function flat(entries: readonly MenuEntry[]): MenuItem[]
{
  const items: MenuItem[] = []
  for (const entry of entries)
  {
    if (entry === 'separator')
    {
      continue
    }
    if ('group' in entry)
    {
      items.push(...flat(entry.items))
      continue
    }
    items.push(entry)
    if (entry.kind === 'submenu')
    {
      items.push(...flat(entry.items))
    }
  }
  return items
}

function item(entries: readonly MenuEntry[], id: string): MenuItem
{
  const found = flat(entries).find((entry) => entry.id === id)
  if (found === undefined)
  {
    throw new Error(`No item ${id}`)
  }
  return found
}

function choose(entries: readonly MenuEntry[], id: string): void
{
  const found = item(entries, id)
  if (found.kind === 'submenu')
  {
    throw new Error(`${id} is a submenu`)
  }
  found.onSelect()
}

function topLabels(entries: readonly MenuEntry[]): string[]
{
  return entries.filter((entry): entry is MenuItem => entry !== 'separator' && !('group' in entry)).map((entry) => entry.label)
}

async function settle(): Promise<void>
{
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const FULL_HOST = {
  editRecipe: vi.fn(),
  openPicker: vi.fn(),
  openInPlayer: vi.fn(),
  openOutput: vi.fn(),
  showLog: vi.fn(),
  locate: vi.fn(),
  editAndRetry: vi.fn(),
  copyCommand: vi.fn(),
  retryNeedsAcknowledgment: vi.fn()
}

describe('rowPhase and targets', () =>
{
  it('reads the phase from the job state and the list', () =>
  {
    expect(rowPhase({ state: 'pending' }, 'queue')).toBe('waiting')
    expect(rowPhase({ state: 'queued' }, 'run')).toBe('queued')
    expect(rowPhase({ state: 'encoding' }, 'run')).toBe('running')
    expect(rowPhase({ state: 'held' }, 'run')).toBe('decision')
    expect(rowPhase({ state: 'failed' }, 'run')).toBe('finished')
    expect(rowPhase({ state: 'done' }, 'historyBatch' as ViewKey)).toBe('history')
  })

  it('acts on the selection when the row is part of it, else on the row alone', () =>
  {
    const a = job()
    const b = job()
    const c = job()
    const { ctx } = harness([a, b, c], {}, [c, a])
    expect(menuTargets(a, ctx).map((entry) => entry.id)).toEqual([a.id, c.id])
    expect(menuTargets(b, ctx).map((entry) => entry.id)).toEqual([b.id])
    expect(targetName([a])).toBe(a.id)
    expect(targetName([a, b])).toBe('2 jobs')
  })

  it('words Show in folder for the platform', () =>
  {
    expect(revealText('source', 'MM-0137', 'win32')).toBe('Show source of MM-0137 in folder')
    expect(revealText('output', 'MM-0137', 'darwin')).toMatch(/^Show output of MM-0137 in Finder$|^Show output of MM-0137 /)
  })
})

describe('waiting jobs', () =>
{
  it('lists the waiting items in order, each naming the job', () =>
  {
    const a = job()
    const { ctx } = harness([a, job()], { host: FULL_HOST })
    const entries = rowMenuEntries(a, ctx)
    expect(topLabels(entries)).toEqual([
      `Edit settings for ${a.id}`,
      `Set operation for ${a.id}`,
      `Duplicate job ${a.id}`,
      `Select similar to ${a.id}`,
      `Move ${a.id} up`,
      `Move ${a.id} down`,
      `Move ${a.id} to top`,
      `Move ${a.id} to bottom`,
      `Show source of ${a.id} in folder`,
      `Open source of ${a.id} in Player`,
      `Copy source path of ${a.id}`,
      `Probe ${a.id} again`,
      `Remove ${a.id} from queue`
    ])
    expect(item(entries, 'edit-recipe')).toMatchObject({ shortcut: 'Enter' })
    expect(item(entries, 'duplicate')).toMatchObject({ shortcut: 'Mod+D' })
    expect(item(entries, 'remove')).toMatchObject({ shortcut: 'Delete' })
  })

  it('leaves out the items whose command the page does not supply', () =>
  {
    const a = job()
    const labels = topLabels(rowMenuEntries(a, harness([a]).ctx))
    expect(labels).not.toContain(`Edit settings for ${a.id}`)
    expect(labels).not.toContain(`Open source of ${a.id} in Player`)
  })

  it('offers Locate for a missing source', () =>
  {
    const a = job({ plan: plan({ status: 'blocked', firstIssue: { code: 'source-missing' } as PlanSummary['firstIssue'] }) })
    const { ctx } = harness([a], { host: FULL_HOST })
    const entries = rowMenuEntries(a, ctx)
    expect(item(entries, 'locate').label).toBe(`Locate source of ${a.id}\u2026`)
    choose(entries, 'locate')
    expect(FULL_HOST.locate).toHaveBeenCalledWith(a)
  })

  it('names the count when the row is part of a selection of several', () =>
  {
    const a = job()
    const b = job()
    const { ctx, spies } = harness([a, b], {}, [a, b])
    const entries = rowMenuEntries(a, ctx)
    expect(item(entries, 'duplicate').label).toBe('Duplicate 2 jobs')
    expect(item(entries, 'remove').label).toBe('Remove 2 jobs from queue')
    expect(item(entries, 'copy-source-path').label).toBe('Copy source paths of 2 jobs')
    choose(entries, 'duplicate')
    choose(entries, 'remove')
    choose(entries, 'probe-again')
    expect(spies.duplicate).toHaveBeenCalledWith([a.id, b.id])
    expect(spies.remove).toHaveBeenCalledWith([a.id, b.id])
    expect(spies.send).toHaveBeenCalledWith('reprobe', { ids: [a.id, b.id] })
  })

  it('reveals, copies, and opens through the right commands', async () =>
  {
    const a = job()
    const { ctx, spies, announced } = harness([a], { host: FULL_HOST })
    const entries = rowMenuEntries(a, ctx)
    choose(entries, 'reveal-source')
    expect(spies.send).toHaveBeenCalledWith('reveal', { jobId: a.id, target: 'source' })
    choose(entries, 'copy-source-path')
    await settle()
    expect(ctx.writeText).toHaveBeenCalledWith(a.source.path)
    expect(announced).toEqual(['Copied the source path.'])
    choose(entries, 'open-in-player')
    choose(entries, 'edit-recipe')
    expect(FULL_HOST.openInPlayer).toHaveBeenCalledWith(a)
    expect(FULL_HOST.editRecipe).toHaveBeenCalledWith(a)
  })

  it('announces a copy the clipboard refused', async () =>
  {
    const a = job()
    const b = job()
    const { ctx, announced } = harness([a, b], { writeText: () => Promise.reject(new Error('denied')) }, [a, b])
    choose(rowMenuEntries(a, ctx), 'copy-source-path')
    await settle()
    expect(announced).toEqual(['Could not copy the source path.'])
    const ok = harness([a, b], {}, [a, b])
    choose(rowMenuEntries(a, ok.ctx), 'copy-source-path')
    await settle()
    expect(ok.announced).toEqual(['Copied 2 source paths.'])
  })

  it('disables the moves while sorted, with the reason', () =>
  {
    const a = job()
    const b = job()
    const { ctx } = harness([a, b], { sorted: true }, [b])
    const entries = rowMenuEntries(b, ctx)
    for (const id of ['move-up', 'move-down', 'move-top', 'move-bottom'])
    {
      expect(item(entries, id)).toMatchObject({ disabled: true, disabledReason: REORDER_SORTED })
    }
  })

  it('disables the moves that change nothing, and moves the others', () =>
  {
    const a = job()
    const b = job()
    const { ctx, spies } = harness([a, b])
    const entries = rowMenuEntries(a, ctx)
    expect(item(entries, 'move-up')).toMatchObject({ disabled: true, disabledReason: 'Already at the top.' })
    expect(item(entries, 'move-top')).toMatchObject({ disabled: true, disabledReason: 'Already at the top.' })
    expect(item(entries, 'move-down')).toMatchObject({ disabled: false, shortcut: 'Alt+Down' })
    choose(entries, 'move-bottom')
    expect(spies.move).toHaveBeenCalledWith([a.id], 'bottom')
    const last = rowMenuEntries(b, harness([a, b], {}, [b]).ctx)
    expect(item(last, 'move-down')).toMatchObject({ disabled: true, disabledReason: 'Already at the bottom.' })
  })

  it('applies one of the eight recent recipes to the row, which becomes the selection', async () =>
  {
    const web = applyPreset('web-1080p', { kind: 'same-as-source' } as never) as Recipe
    const recent = Array.from({ length: 10 }, () => structuredClone(web))
    const a = job()
    const b = job()
    const { ctx, spies } = harness([a, b], { jobs: jobsState([a, b], recent), host: FULL_HOST }, [a])
    const entries = rowMenuEntries(b, ctx)
    const submenu = item(entries, 'apply-recipe')
    expect(submenu.kind).toBe('submenu')
    const leaves = submenu.kind === 'submenu' ? submenu.items.filter((entry) => entry !== 'separator') as MenuItem[] : []
    expect(leaves).toHaveLength(RECENT_RECIPES + 1)
    expect(leaves[RECENT_RECIPES]).toMatchObject({ label: 'More operations\u2026', shortcut: 'Mod+K' })
    leaves[0].kind === 'submenu' ? undefined : leaves[0].onSelect()
    await settle()
    expect(spies.select).toHaveBeenCalledWith('queue', { type: 'click', id: b.id })
    const assignments = spies.assignRecipes.mock.calls[0][0] as Array<{ jobId: string, recipe: Recipe }>
    expect(assignments.map((entry) => entry.jobId)).toEqual([b.id])
    expect(assignments[0].recipe.kind).toBe('compress')
    choose(entries, 'more-recipes')
    expect(FULL_HOST.openPicker).toHaveBeenCalled()
  })

  it('says when no recipe was applied yet, and announces a selection that keeps its settingss', async () =>
  {
    const a = job()
    const entries = rowMenuEntries(a, harness([a]).ctx)
    const submenu = item(entries, 'apply-recipe')
    expect(submenu.kind === 'submenu' ? submenu.items : []).toEqual([
      expect.objectContaining({ label: 'No recent operations', disabled: true, disabledReason: 'Operations you set appear here.' })
    ])
    const web = applyPreset('web-1080p', { kind: 'same-as-source' } as never) as Recipe
    const queued = job({ state: 'queued' })
    const mixed = harness([a, queued], { jobs: jobsState([a, queued], [web]) }, [a, queued])
    choose(rowMenuEntries(a, mixed.ctx), 'recent:0')
    await settle()
    expect((mixed.spies.assignRecipes.mock.calls[0][0] as Array<{ jobId: string }>).map((entry) => entry.jobId)).toEqual([a.id])
    const started: JobView = { ...a, state: 'queued' }
    const locked = harness([started], { jobs: jobsState([started], [web]) })
    choose(rowMenuEntries(a, locked.ctx), 'recent:0')
    await settle()
    expect(locked.spies.assignRecipes).not.toHaveBeenCalled()
    expect(locked.announced).toEqual(['These jobs keep their settings: they are queued, running, or finished.'])
  })

  it('selects similar rows and announces the result', () =>
  {
    const a = job()
    const { ctx, spies, announced } = harness([a])
    const entries = rowMenuEntries(a, ctx)
    const submenu = item(entries, 'select-similar')
    expect(submenu.kind === 'submenu' ? submenu.items.map((entry) => entry !== 'separator' && !('group' in entry) ? entry.label : '') : [])
      .toEqual(['Same type', 'Same operation', 'Same folder', 'Same extension'])
    choose(entries, 'similar-folder')
    expect(spies.selectSimilar).toHaveBeenCalledWith('queue', a, [a], 'folder', undefined)
    expect(announced).toEqual(['Selected 2 jobs with the same type.'])
  })
})

describe('queued jobs', () =>
{
  it('lists Run next, the moves, Skip, and Take out of the batch, naming the job', () =>
  {
    const a = job({ state: 'queued', runId: RUN })
    const b = job({ state: 'queued', runId: RUN })
    const { ctx } = harness([a, b], { list: 'run', mode: 'run' }, [b])
    const entries = rowMenuEntries(b, ctx)
    expect(topLabels(entries)).toEqual([
      `Run ${b.id} next`,
      `Move ${b.id} up`,
      `Move ${b.id} down`,
      `Move ${b.id} to top`,
      `Move ${b.id} to bottom`,
      `Skip ${b.id}`,
      `Take ${b.id} out of Batch 31`,
      `Show source of ${b.id} in folder`,
      `Copy source path of ${b.id}`
    ])
    const first = rowMenuEntries(a, harness([a, b], { list: 'run', mode: 'run' }, [a]).ctx)
    expect(item(first, 'run-next')).toMatchObject({ disabled: true, disabledReason: 'It already runs next.' })
  })

  it('runs next, skips one at once, and takes it out of the batch', () =>
  {
    const a = job({ state: 'queued', runId: RUN })
    const b = job({ state: 'queued', runId: RUN })
    const { ctx, spies, confirms } = harness([a, b], { list: 'run', mode: 'run' }, [b])
    const entries = rowMenuEntries(b, ctx)
    choose(entries, 'run-next')
    expect(spies.move).toHaveBeenCalledWith([b.id], 'top')
    choose(entries, 'skip')
    expect(spies.skip).toHaveBeenCalledWith([b.id])
    expect(confirms).toHaveLength(0)
    choose(entries, 'take-out')
    expect(spies.takeOut).toHaveBeenCalledWith([b.id])
  })

  it('asks before skipping several, anchored to the row', () =>
  {
    const a = job({ state: 'queued', runId: RUN })
    const b = job({ state: 'queued', runId: RUN })
    const { ctx, spies, confirms } = harness([a, b], { list: 'run', mode: 'run', sorted: true }, [a, b])
    const entries = rowMenuEntries(b, ctx)
    expect(item(entries, 'skip').label).toBe('Skip 2 jobs')
    expect(item(entries, 'run-next')).toMatchObject({ disabled: true, disabledReason: REORDER_SORTED })
    choose(entries, 'skip')
    expect(spies.skip).not.toHaveBeenCalled()
    expect(confirms[0]).toMatchObject({
      question: 'Skip 2 queued jobs? They end as Skipped; Retry runs them later.',
      safeLabel: 'Keep queued',
      confirmLabel: 'Skip 2 jobs',
      anchorId: b.id
    })
    confirms[0].onConfirm()
    expect(spies.skip).toHaveBeenCalledWith([a.id, b.id])
  })

  it('names the batch generically when the job has none', () =>
  {
    const a = job({ state: 'queued' })
    expect(item(rowMenuEntries(a, harness([a]).ctx), 'take-out').label).toBe(`Take ${a.id} out of the batch`)
  })
})

describe('running jobs', () =>
{
  it('names the job in Cancel job and asks first', () =>
  {
    const a = job({ state: 'encoding', startedAt: AT, runId: RUN })
    const { ctx, spies, confirms } = harness([a], { list: 'run', mode: 'run', host: FULL_HOST })
    const entries = rowMenuEntries(a, ctx)
    expect(topLabels(entries)).toEqual([`Cancel job ${a.id}`, `Show log for ${a.id}`, `Show source of ${a.id} in folder`, `Copy command for ${a.id}`])
    expect(item(entries, 'cancel')).toMatchObject({ danger: true, shortcut: 'Shift+Delete' })
    choose(entries, 'cancel')
    expect(spies.cancelJobs).not.toHaveBeenCalled()
    expect(confirms[0]).toMatchObject({ safeLabel: 'Keep running', confirmLabel: 'Cancel job', danger: true, anchorId: a.id })
    expect(confirms[0].question).toBe(`Cancel ${a.id}? 4 min 31 s of encoding is discarded and its partial file is deleted. The source is not touched.`)
    confirms[0].onConfirm()
    expect(spies.cancelJobs).toHaveBeenCalledWith([a.id])
    choose(entries, 'show-log')
    choose(entries, 'copy-command')
    expect(FULL_HOST.showLog).toHaveBeenCalledWith(a)
    expect(FULL_HOST.copyCommand).toHaveBeenCalledWith(a)
  })

  it('cancels the running jobs of a selection and says the queued ones stay', () =>
  {
    const a = job({ state: 'encoding', startedAt: AT })
    const b = job({ state: 'verifying', startedAt: AT })
    const c = job({ state: 'queued' })
    const { ctx, confirms, spies } = harness([a, b, c], { list: 'run', mode: 'run', platform: 'darwin' }, [a, b, c])
    const entries = rowMenuEntries(a, ctx)
    expect(item(entries, 'cancel')).toMatchObject({ label: 'Cancel 2 jobs', shortcut: 'Mod+Delete' })
    choose(entries, 'cancel')
    expect(confirms[0].confirmLabel).toBe('Cancel 2 jobs')
    expect(confirms[0].question).toContain('1 queued job in the selection stays queued; Delete skips it.')
    confirms[0].onConfirm()
    expect(spies.cancelJobs).toHaveBeenCalledWith([a.id, b.id])
  })
})

describe('jobs waiting for a decision', () =>
{
  function held(over: Partial<JobView['hold']> = {}): JobView
  {
    return job({
      state: 'held',
      runId: RUN,
      hold: { reason: 'outside-tolerance', message: '', outputPath: 'D:\\out\\a.wav', displaces: 'D:\\Rips\\a.wav', actions: ['keep', 'keep-renamed', 'discard', 'retry'], since: AT, ...over }
    })
  }

  it('lists the decisions, each naming the job', () =>
  {
    const a = held()
    const { ctx } = harness([a], { list: 'run', mode: 'run', host: FULL_HOST })
    expect(topLabels(rowMenuEntries(a, ctx))).toEqual([
      `Keep output of ${a.id}`,
      `Keep ${a.id} under a new name`,
      `Discard output of ${a.id}`,
      `Retry ${a.id}`,
      `Show log for ${a.id}`
    ])
    expect(item(rowMenuEntries(a, { ...ctx, replaceMode: true }), 'keep-output').label).toBe(`Keep output of ${a.id} and replace original`)
    const saving = held({ reason: 'interrupted-finalize', actions: ['keep', 'retry'] })
    expect(topLabels(rowMenuEntries(saving, ctx))).toEqual([`Finish saving ${saving.id}`, `Retry ${saving.id}`, `Show log for ${saving.id}`])
  })

  it('keeps the output, confirming when it replaces a file', async () =>
  {
    const a = held()
    const { ctx, spies, confirms } = harness([a], { list: 'run', mode: 'run' })
    spies.keepOutput.mockResolvedValueOnce({ status: 'needs-confirmation', displaces: 1 })
    choose(rowMenuEntries(a, ctx), 'keep-output')
    await settle()
    expect(confirms[0]).toMatchObject({
      question: `Replace the original of ${a.id} with an output outside tolerance? The original goes to the Recycle Bin.`,
      safeLabel: 'Keep both',
      confirmLabel: 'Replace original',
      danger: true
    })
    confirms[0].onConfirm()
    expect(spies.keepOutput).toHaveBeenLastCalledWith([a.id], { confirmed: true })
    choose(rowMenuEntries(a, ctx), 'keep-output')
    await settle()
    expect(confirms).toHaveLength(1)
    choose(rowMenuEntries(a, ctx), 'keep-renamed')
    expect(spies.keepOutput).toHaveBeenLastCalledWith([a.id], { placement: 'renamed' })
  })

  it('confirms Discard output and Retry', async () =>
  {
    const a = held()
    const { ctx, spies, confirms } = harness([a], { list: 'run', mode: 'run', host: FULL_HOST })
    choose(rowMenuEntries(a, ctx), 'discard-output')
    expect(confirms[0]).toMatchObject({
      question: `Discard the output of ${a.id}? The file is deleted. The original and any existing file stay.`,
      safeLabel: 'Keep it',
      confirmLabel: 'Discard',
      danger: true
    })
    confirms[0].onConfirm()
    expect(spies.discardOutput).toHaveBeenCalledWith([a.id])
    choose(rowMenuEntries(a, ctx), 'retry')
    expect(confirms[1]).toMatchObject({ question: `Retry ${a.id}? The output waiting for a decision is deleted first.`, safeLabel: 'Keep waiting', confirmLabel: 'Retry', danger: false })
    const ack = { preflightId: 'p', originalsAffected: 1, overwrites: 0 }
    spies.retry.mockResolvedValueOnce({ status: 'needs-acknowledgment', ack })
    confirms[1].onConfirm()
    await settle()
    expect(spies.retry).toHaveBeenCalledWith([a.id])
    expect(FULL_HOST.retryNeedsAcknowledgment).toHaveBeenCalledWith([a.id], ack)
  })

  it('offers every decision when the hold names none', () =>
  {
    const a = job({ state: 'held' })
    expect(topLabels(rowMenuEntries(a, harness([a], { list: 'run', mode: 'run' }).ctx))).toHaveLength(4)
  })
})

describe('finished jobs', () =>
{
  it('lists the finished items, each naming the job', () =>
  {
    const a = job({ state: 'done', runId: RUN })
    const { ctx } = harness([a], { list: 'run', mode: 'run', host: FULL_HOST })
    expect(topLabels(rowMenuEntries(a, ctx))).toEqual([
      `Show output of ${a.id} in folder`,
      `Open output of ${a.id}`,
      `Retry ${a.id}`,
      `Edit and retry ${a.id}`,
      `Duplicate job ${a.id}`,
      `Show log for ${a.id}`,
      `Copy command for ${a.id}`,
      `Copy result of ${a.id}`,
      `Remove ${a.id} from table`
    ])
  })

  it('offers Acknowledge and keeps Remove from table unavailable while the job needs attention', () =>
  {
    const a = job({ state: 'failed', runId: RUN, error: { code: 'ffmpeg-failed', short: 'Decode failed', message: '', stage: 'encode', at: AT } as JobView['error'] })
    const { ctx, spies } = harness([a], { list: 'run', mode: 'run' })
    const entries = rowMenuEntries(a, ctx)
    expect(topLabels(entries)).not.toContain(`Show output of ${a.id} in folder`)
    expect(item(entries, 'remove-from-table')).toMatchObject({ disabled: true, disabledReason: ACKNOWLEDGE_FIRST, shortcut: 'Delete' })
    choose(entries, 'acknowledge')
    expect(spies.acknowledge).toHaveBeenCalledWith([a.id])
  })

  it('retries, removes, reveals, and copies the result', async () =>
  {
    const a = job({ state: 'canceled', runId: RUN })
    const b = job({ state: 'done', runId: RUN })
    const running = job({ state: 'encoding', runId: RUN })
    const { ctx, spies, announced } = harness([a, b, running], { list: 'run', mode: 'run', host: FULL_HOST }, [a, b, running])
    const entries = rowMenuEntries(b, ctx)
    expect(item(entries, 'retry').label).toBe('Retry 2 jobs')
    choose(entries, 'retry')
    choose(entries, 'remove-from-table')
    choose(entries, 'reveal-output')
    choose(entries, 'open-output')
    choose(entries, 'edit-and-retry')
    expect(spies.retry).toHaveBeenCalledWith([a.id, b.id])
    expect(spies.deleteJobs).toHaveBeenCalledWith([a.id, b.id])
    expect(spies.send).toHaveBeenCalledWith('reveal', { jobId: b.id, target: 'output' })
    expect(FULL_HOST.openOutput).toHaveBeenCalledWith(b)
    expect(FULL_HOST.editAndRetry).toHaveBeenCalledWith(b)
    choose(entries, 'copy-result')
    await settle()
    expect(ctx.writeText).toHaveBeenCalledWith(b.id)
    expect(announced).toEqual(['Copied the result.'])
    const failing = harness([b], { writeText: () => Promise.reject(new Error('denied')) })
    choose(rowMenuEntries(b, failing.ctx), 'copy-result')
    await settle()
    expect(failing.announced).toEqual(['Could not copy the result.'])
  })

  it('shows History jobs read-only', () =>
  {
    const a = job({ state: 'done', runId: RUN })
    const f = job({ state: 'failed', runId: RUN })
    const { ctx } = harness([a, f], { list: 'historyBatch', mode: 'history', host: FULL_HOST })
    expect(topLabels(rowMenuEntries(a, ctx))).toEqual([
      `Show output of ${a.id} in folder`,
      `Open output of ${a.id}`,
      `Show log for ${a.id}`,
      `Copy command for ${a.id}`,
      `Copy result of ${a.id}`
    ])
    expect(topLabels(rowMenuEntries(f, harness([f], { list: 'historyBatch', mode: 'history' }).ctx))).toEqual([`Copy result of ${f.id}`])
  })
})

describe('every phase', () =>
{
  it('names the job in every action label', () =>
  {
    const states: Array<Partial<JobView>> = [
      { state: 'pending' },
      { state: 'queued', runId: RUN },
      { state: 'encoding', runId: RUN },
      { state: 'held', runId: RUN },
      { state: 'done', runId: RUN },
      { state: 'failed', runId: RUN }
    ]
    for (const over of states)
    {
      const a = job(over)
      const { ctx } = harness([a], { list: 'run', mode: 'run', host: FULL_HOST })
      for (const entry of topLabels(rowMenuEntries(a, ctx)))
      {
        expect(entry).toContain(a.id)
      }
    }
  })
})

describe('rendered row menu', () =>
{
  it('keeps an unavailable item focusable with its reason as visible text', () =>
  {
    const a = job({ state: 'failed', runId: RUN })
    const { ctx } = harness([a], { list: 'run', mode: 'run' })
    render(<Menu trigger={<button type="button">More actions for {a.id}</button>} items={rowMenuEntries(a, ctx)} label={`Actions for ${a.id}`} />)
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${a.id}` }))
    const remove = screen.getByRole('menuitem', { hidden: true, name: new RegExp(`Remove ${a.id} from table`) })
    expect(remove.getAttribute('aria-disabled')).toBe('true')
    expect(remove.textContent).toContain(ACKNOWLEDGE_FIRST)
    remove.focus()
    expect(document.activeElement).toBe(remove)
  })
})

function dialogQuestion(): string | null
{
  const dialog = screen.getByRole('dialog', { hidden: true })
  return document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent ?? null
}

describe('TableConfirm', () =>
{
  it('anchors the confirmation to the row with focus on the safe choice', () =>
  {
    const onResolve = vi.fn()
    const pending: ConfirmRequest = { question: 'Skip 2 queued jobs? They end as Skipped; Retry runs them later.', safeLabel: 'Keep queued', confirmLabel: 'Skip 2 jobs', danger: false, anchorId: 'MM-0001', onConfirm: vi.fn() }
    render(
      <div>
        <div role="row" data-row-id="MM-0002" tabIndex={-1}>b</div>
        <div role="row" data-row-id="MM-0001" tabIndex={-1}>a</div>
        <TableConfirm pending={pending} onResolve={onResolve} />
      </div>
    )
    expect(dialogQuestion()).toBe(pending.question)
    expect(document.activeElement?.textContent).toBe('Keep queued')
    expect(rowElement('MM-0001')?.textContent).toBe('a')
    expect(rowElement('MM-0003')).toBeNull()
    fireEvent.click(screen.getByRole('button', { hidden: true, name: 'Skip 2 jobs' }))
    expect(onResolve).toHaveBeenCalledWith(true)
  })

  it('renders nothing without a pending confirmation', () =>
  {
    const { container } = render(<TableConfirm pending={null} onResolve={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('anchors to the table when no row asked', () =>
  {
    const pending: ConfirmRequest = { question: 'Cancel 2 running jobs?', safeLabel: 'Keep running', confirmLabel: 'Cancel 2 jobs', danger: true, anchorId: null, onConfirm: vi.fn() }
    render(<TableConfirm pending={pending} onResolve={vi.fn()} />)
    expect(dialogQuestion()).toBe(pending.question)
  })
})

describe('useTableCommands and useRowMenu', () =>
{
  function stores(jobs: readonly JobView[]): { jobs: ReturnType<typeof createJobsStore>, view: ReturnType<typeof createBatchViewStore> }
  {
    const jobStore = createJobsStore()
    jobStore.setState(jobsState(jobs), true)
    const view = createBatchViewStore({ storage: null })
    view.getState().markRunAvailable()
    return { jobs: jobStore, view }
  }

  function key(init: KeyboardEventInit): KeyboardEvent
  {
    return new KeyboardEvent('keydown', { bubbles: true, ...init })
  }

  it('toggles the focused row with Space in Run and never pauses', () =>
  {
    const a = job({ state: 'encoding', runId: RUN })
    const { jobs, view } = stores([a])
    view.getState().setMode('run')
    const togglePause = vi.fn()
    const wrapper = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
      <TestBatchActionsProvider jobs={jobs} view={view} overrides={{ togglePause } as Partial<BatchActions>}>{children}</TestBatchActionsProvider>
    const { result } = renderHook(() => useTableCommands({ list: 'run', platform: 'win32', announce: vi.fn(), jobs, view }), { wrapper })
    expect(result.current.onKeyCommand(key({ key: ' ', code: 'Space' }), a.id)).toBe(true)
    expect(view.getState().views.run.selection.selected.has(a.id)).toBe(true)
    expect(result.current.onKeyCommand(key({ key: ' ', code: 'Space' }), a.id)).toBe(true)
    expect(view.getState().views.run.selection.selected.has(a.id)).toBe(false)
    expect(togglePause).not.toHaveBeenCalled()
    expect(result.current.onKeyCommand(key({ key: 'ArrowDown' }), a.id)).toBe(false)
  })

  it('holds the Shift+Delete confirmation until a choice, and shares it with the row menu', () =>
  {
    const a = job({ state: 'encoding', startedAt: AT, runId: RUN })
    const { jobs, view } = stores([a])
    view.getState().setMode('run')
    view.getState().select('run', { type: 'click', id: a.id })
    const cancelJobs = vi.fn(async () => ({ status: 'done', value: { applied: [a.id], refused: [] }, seq: 1 }))
    const wrapper = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
      <TestBatchActionsProvider jobs={jobs} view={view} overrides={{ cancelJobs } as Partial<BatchActions>}>{children}</TestBatchActionsProvider>
    const { result } = renderHook(() =>
    {
      const commands = useTableCommands({ list: 'run', platform: 'win32', announce: vi.fn(), jobs, view, now: () => AT + 1000 })
      const rowMenu = useRowMenu({ list: 'run', platform: 'win32', announce: vi.fn(), confirm: commands.confirm, jobs, view, now: () => AT + 1000 })
      return { commands, rowMenu }
    }, { wrapper })
    act(() =>
    {
      result.current.commands.onKeyCommand(key({ key: 'Delete', shiftKey: true }), null)
    })
    expect(result.current.commands.pending?.question).toBe(`Cancel ${a.id}? 1 s of encoding is discarded and its partial file is deleted. The source is not touched.`)
    act(() => result.current.commands.resolve(false))
    expect(result.current.commands.pending).toBeNull()
    expect(cancelJobs).not.toHaveBeenCalled()

    const entries = result.current.rowMenu(a)
    act(() => choose(entries, 'cancel'))
    expect(result.current.commands.pending?.confirmLabel).toBe('Cancel job')
    act(() => result.current.commands.resolve(true))
    expect(cancelJobs).toHaveBeenCalledWith([a.id])
    act(() => result.current.commands.resolve(true))
    expect(cancelJobs).toHaveBeenCalledTimes(1)
  })

  it('applies a pin from the table but not from a text field', async () =>
  {
    const a = job()
    const { jobs, view } = stores([a])
    jobs.setState({ presets: { user: [], pins: { 6: 'web-1080p' }, recent: [] } })
    view.getState().select('queue', { type: 'click', id: a.id })
    const assignRecipes = vi.fn(async () => ({ status: 'done', value: { applied: [a.id], refused: [] }, seq: 1, entryId: null }))
    const wrapper = ({ children }: { children?: React.ReactNode }): React.JSX.Element =>
      <TestBatchActionsProvider jobs={jobs} view={view} overrides={{ assignRecipes } as Partial<BatchActions>}>{children}</TestBatchActionsProvider>
    const { result } = renderHook(() => useTableCommands({ list: 'queue', platform: 'win32', announce: vi.fn(), jobs, view }), { wrapper })
    const field = document.createElement('input')
    document.body.append(field)
    const fromField = key({ key: '6', code: 'Digit6', altKey: true })
    field.dispatchEvent(fromField)
    expect(result.current.onKeyCommand(fromField, a.id)).toBe(false)
    expect(result.current.onKeyCommand(key({ key: '6', code: 'Numpad6', altKey: true }), a.id)).toBe(false)
    expect(result.current.onKeyCommand(key({ key: '6', code: 'Digit6', altKey: true }), a.id)).toBe(true)
    await act(settle)
    expect(assignRecipes).toHaveBeenCalledTimes(1)
    field.remove()
  })
})
