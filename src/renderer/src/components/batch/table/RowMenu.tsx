/**
 * The Batch table's row menu: the items of each job phase (waiting, queued in a batch, running, waiting for a
 * decision, finished, and History's read-only jobs), every action naming the job it acts on, and the small
 * confirmation a Cancel job, a Skip of several, or a decision asks for first, anchored to the row.
 */
import { useCallback, useLayoutEffect, useRef, type ReactElement } from 'react'
import type { StoreApi } from 'zustand'
import type { EncoderPolicy } from '../../../../../shared/audio/types'
import type { Ack } from '../../../../../shared/jobs/contract'
import type { JobId } from '../../../../../shared/jobs/ids'
import { needsAttention, needsDecision } from '../../../../../shared/jobs/states'
import type { JobView } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { batchLabel, countOf, revealLabel } from '../../../copy/batch'
import { moveBefore, type BatchActions, type MoveTarget } from '../../../stores/batchActions'
import { SIMILAR_BASES, similarItemLabel, type FilterContext } from '../../../stores/batchFilters'
import { modeRows, useBatchView, type BatchMode, type BatchViewState, type ViewKey } from '../../../stores/batchView'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { ConfirmPopover } from '../../../ui/ConfirmPopover'
import type { FocusFallback } from '../../../ui/InlineConfirm'
import type { MenuActionItem, MenuEntry, MenuLeafItem } from '../../../ui/Menu'
import type { GridSelectionState } from '../../../ui/useGridSelection'
import { useBatchActions } from '../BatchActionsContext'
import { applyRecipe, recipeCatalog } from '../toolbar/RecipePicker'
import { cancelQuestion, commandTargets, isHistoryList, isRunningJob, REORDER_SORTED, resultText, skipQuestion, type ConfirmRequest } from './tableCommands'

/** How many recently applied recipes the Set operation submenu lists. */
export const RECENT_RECIPES = 8

/** Why Remove from table is unavailable while a job needs attention. */
export const ACKNOWLEDGE_FIRST = 'Acknowledge it first.'

/** The phase whose items a row's menu shows. */
export type RowPhase = 'waiting' | 'queued' | 'running' | 'decision' | 'finished' | 'history'

/**
 * The page's commands the row menu offers beyond the Batch view's actions. An item whose command the page does not
 * supply is left out of the menu.
 */
export interface RowMenuHost
{
  /** Edit recipe (Enter): the job opens in the inspector with focus on its first field. */
  editRecipe?: (job: JobView) => void
  /** More operations (Ctrl+K): the recipe picker for the selection. */
  openPicker?: () => void
  openInPlayer?: (job: JobView) => void
  /** Opens a finished job's output with the system's default app. */
  openOutput?: (job: JobView) => void
  /** Logs, filtered to the job. */
  showLog?: (job: JobView) => void
  /** A file dialog in the source's old folder, filtered to its name. */
  locate?: (job: JobView) => void
  /** The Recipe tab as a draft for the next attempt. */
  editAndRetry?: (job: JobView) => void
  /** Copies the exact argument list, quoted for the platform's shell. */
  copyCommand?: (job: JobView) => void
  /** A retry that replaces files asks for the acknowledgment inline first. */
  retryNeedsAcknowledgment?: (ids: JobId[], ack: Ack) => void
}

/** What the row menu reads and calls; the hook binds it to the page, tests build it directly. */
export interface RowMenuContext
{
  actions: BatchActions
  list: ViewKey
  mode: BatchMode
  platform: Platform
  jobs: JobsState
  selection: GridSelectionState
  /** The list is sorted by a column, so its move items are unavailable. */
  sorted: boolean
  /** The batch replaces originals, which changes what Keep output says. */
  replaceMode: boolean
  output?: EncoderPolicy
  filterContext?: FilterContext
  now: number
  host: RowMenuHost
  view: Pick<BatchViewState, 'select' | 'selectSimilar'>
  confirm(request: ConfirmRequest): void
  announce(message: string): void
  writeText(text: string): void | Promise<void>
  firstMeasured?: (id: JobId) => string | null
}

/** The phase a job's row menu shows: History's jobs are read-only whatever their state. */
export function rowPhase(job: Pick<JobView, 'state'>, list: ViewKey): RowPhase
{
  if (isHistoryList(list))
  {
    return 'history'
  }
  if (job.state === 'pending')
  {
    return 'waiting'
  }
  if (job.state === 'queued')
  {
    return 'queued'
  }
  if (isRunningJob(job))
  {
    return 'running'
  }
  return needsDecision(job) ? 'decision' : 'finished'
}

/** The jobs a row's menu acts on: the selection, in queue order, when the row is part of it; else the row alone. */
export function menuTargets(job: JobView, ctx: Pick<RowMenuContext, 'jobs' | 'selection'>): JobView[]
{
  const picked = ctx.selection.selected.has(job.id) ? commandTargets(ctx.jobs, ctx.selection.selected, null) : []
  return picked.length > 0 ? picked : [job]
}

/** A job's catalog number, or "3 jobs" for several. */
export function targetName(jobs: readonly Pick<JobView, 'id'>[]): string
{
  return jobs.length === 1 ? jobs[0].id : countOf(jobs.length, 'job')
}

/** "Show source of MM-0137 in folder", worded for the platform's file manager. */
export function revealText(what: 'source' | 'output', id: string, platform: Platform): string
{
  const label = revealLabel(platform)
  return label.startsWith('Show ') ? `Show ${what} of ${id} ${label.slice(5)}` : `${label}: ${what} of ${id}`
}

function present<T>(items: ReadonlyArray<T | null>): T[]
{
  return items.filter((item): item is T => item !== null)
}

/** Groups of items with separators between the groups that have any. */
function sections(...groups: ReadonlyArray<ReadonlyArray<MenuEntry | null>>): MenuEntry[]
{
  const entries: MenuEntry[] = []
  for (const group of groups)
  {
    const items = present(group)
    if (items.length === 0)
    {
      continue
    }
    if (entries.length > 0)
    {
      entries.push('separator')
    }
    entries.push(...items)
  }
  return entries
}

function ids(jobs: readonly JobView[]): JobId[]
{
  return jobs.map((job) => job.id)
}

function revealItem(job: JobView, what: 'source' | 'output', ctx: RowMenuContext): MenuActionItem
{
  return {
    id: `reveal-${what}`,
    label: revealText(what, job.id, ctx.platform),
    onSelect: () => void ctx.actions.send('reveal', { jobId: job.id, target: what })
  }
}

function hostItem(id: string, label: string, run: ((job: JobView) => void) | undefined, job: JobView): MenuActionItem | null
{
  return run === undefined ? null : { id, label, onSelect: () => run(job) }
}

function copyPathItem(targets: readonly JobView[], ctx: RowMenuContext): MenuActionItem
{
  const one = targets.length === 1
  return {
    id: 'copy-source-path',
    label: one ? `Copy source path of ${targets[0].id}` : `Copy source paths of ${targetName(targets)}`,
    onSelect: () =>
    {
      void Promise.resolve(ctx.writeText(targets.map((job) => job.source.path).join('\n'))).then(
        () => ctx.announce(one ? 'Copied the source path.' : `Copied ${countOf(targets.length, 'source path')}.`),
        () => ctx.announce('Could not copy the source path.')
      )
    }
  }
}

function duplicateItem(targets: readonly JobView[], ctx: RowMenuContext): MenuActionItem
{
  return {
    id: 'duplicate',
    label: targets.length === 1 ? `Duplicate job ${targets[0].id}` : `Duplicate ${targetName(targets)}`,
    shortcut: 'Mod+D',
    onSelect: () => void ctx.actions.duplicate(ids(targets))
  }
}

const MOVE_WORDS: ReadonlyArray<{ where: MoveTarget, id: string, label: (name: string) => string, shortcut: string, end: string }> = [
  { where: 'up', id: 'move-up', label: (name) => `Move ${name} up`, shortcut: 'Alt+Up', end: 'Already at the top.' },
  { where: 'down', id: 'move-down', label: (name) => `Move ${name} down`, shortcut: 'Alt+Down', end: 'Already at the bottom.' },
  { where: 'top', id: 'move-top', label: (name) => `Move ${name} to top`, shortcut: 'Alt+Home', end: 'Already at the top.' },
  { where: 'bottom', id: 'move-bottom', label: (name) => `Move ${name} to bottom`, shortcut: 'Alt+End', end: 'Already at the bottom.' }
]

/** Why a move is unavailable: the table is sorted, or the jobs are already there. */
function moveReason(targets: readonly JobView[], where: MoveTarget, end: string, ctx: RowMenuContext): string | undefined
{
  if (ctx.sorted)
  {
    return REORDER_SORTED
  }
  return moveBefore(ctx.jobs, ids(targets), where) === null ? end : undefined
}

/** "Run next" (queued jobs only) and the four moves, unavailable while sorted with the reason as visible text. */
function moveItems(targets: readonly JobView[], ctx: RowMenuContext, runNext: boolean): MenuActionItem[]
{
  const name = targetName(targets)
  const move = (where: MoveTarget): void => void ctx.actions.move(ids(targets), where)
  const items: MenuActionItem[] = []
  if (runNext)
  {
    const reason = moveReason(targets, 'top', targets.length === 1 ? 'It already runs next.' : 'They already run next.', ctx)
    items.push({ id: 'run-next', label: `Run ${name} next`, disabled: reason !== undefined, disabledReason: reason, onSelect: () => move('top') })
  }
  for (const word of MOVE_WORDS)
  {
    const reason = moveReason(targets, word.where, word.end, ctx)
    items.push({ id: word.id, label: word.label(name), shortcut: word.shortcut, disabled: reason !== undefined, disabledReason: reason, onSelect: () => move(word.where) })
  }
  return items
}

/** Makes the row the selection when it is not part of it, as Set operation and the picker act on the selection. */
function selectRow(job: JobView, ctx: RowMenuContext): void
{
  if (!ctx.selection.selected.has(job.id))
  {
    ctx.view.select(ctx.list, { type: 'click', id: job.id })
  }
}

/** "Set operation": the eight most recently set operations, then "More operations" (Ctrl+K). */
function applyRecipeItem(job: JobView, targets: readonly JobView[], ctx: RowMenuContext): MenuEntry
{
  const catalog = recipeCatalog(ctx.jobs.presets ?? { user: [], pins: {}, recent: [] }, ctx.output)
  const recent = catalog.groups.find((group) => group.id === 'recent')?.options.slice(0, RECENT_RECIPES) ?? []
  const items: Array<MenuEntry<MenuLeafItem>> = recent.map((option): MenuLeafItem =>
  {
    const entry = catalog.entries.get(option.id)
    return {
      id: option.id,
      label: option.label,
      description: option.description,
      shortcut: option.shortcut,
      onSelect: () =>
      {
        selectRow(job, ctx)
        if (entry === undefined)
        {
          return
        }
        void applyRecipe(ctx.actions, targets, entry, false).then((result) =>
        {
          if (result.kind === 'none')
          {
            ctx.announce(result.status)
          }
        })
      }
    }
  })
  if (items.length === 0)
  {
    items.push({ id: 'no-recent', label: 'No recent operations', disabled: true, disabledReason: 'Operations you set appear here.', onSelect: () => undefined })
  }
  const openPicker = ctx.host.openPicker
  if (openPicker !== undefined)
  {
    items.push('separator', { id: 'more-recipes', label: 'More operations\u2026', shortcut: 'Mod+K', onSelect: () => { selectRow(job, ctx); openPicker() } })
  }
  return { id: 'apply-recipe', kind: 'submenu', label: `Set operation for ${targetName(targets)}`, items }
}

/** "Select similar": every visible row with the focused row's type, recipe, folder, or extension. */
function selectSimilarItem(job: JobView, ctx: RowMenuContext): MenuEntry
{
  return {
    id: 'select-similar',
    kind: 'submenu',
    label: `Select similar to ${job.id}`,
    items: SIMILAR_BASES.map((basis): MenuLeafItem => ({
      id: `similar-${basis}`,
      label: similarItemLabel(basis),
      onSelect: () => ctx.announce(ctx.view.selectSimilar(ctx.list, job, modeRows(ctx.mode, ctx.jobs), basis, ctx.filterContext))
    }))
  }
}

function waitingItems(job: JobView, targets: readonly JobView[], ctx: RowMenuContext): MenuEntry[]
{
  const name = targetName(targets)
  const host = ctx.host
  const editRecipe = host.editRecipe
  const missing = job.plan?.firstIssue?.code === 'source-missing'
  return sections(
    [
      editRecipe === undefined ? null : { id: 'edit-recipe', label: `Edit settings for ${name}`, shortcut: 'Enter', onSelect: () => editRecipe(job) },
      applyRecipeItem(job, targets, ctx),
      duplicateItem(targets, ctx),
      selectSimilarItem(job, ctx)
    ],
    moveItems(targets, ctx, false),
    [
      missing ? hostItem('locate', `Locate source of ${job.id}\u2026`, host.locate, job) : null,
      revealItem(job, 'source', ctx),
      hostItem('open-in-player', `Open source of ${job.id} in Player`, host.openInPlayer, job),
      copyPathItem(targets, ctx),
      { id: 'probe-again', label: `Probe ${name} again`, onSelect: () => void ctx.actions.send('reprobe', { ids: ids(targets) }) }
    ],
    [{ id: 'remove', label: `Remove ${name} from queue`, shortcut: 'Delete', onSelect: () => void ctx.actions.remove(ids(targets.filter((entry) => entry.state === 'pending'))) }]
  )
}

function queuedItems(job: JobView, targets: readonly JobView[], ctx: RowMenuContext): MenuEntry[]
{
  const queued = targets.filter((entry) => entry.state === 'queued')
  const name = targetName(queued)
  const batch = job.runId === null ? 'the batch' : batchLabel(job.runId)
  const skip = (): void =>
  {
    if (queued.length === 1)
    {
      void ctx.actions.skip(ids(queued))
      return
    }
    ctx.confirm({
      question: skipQuestion(queued.length),
      safeLabel: 'Keep queued',
      confirmLabel: `Skip ${countOf(queued.length, 'job')}`,
      danger: false,
      anchorId: job.id,
      onConfirm: () => void ctx.actions.skip(ids(queued))
    })
  }
  return sections(
    moveItems(queued, ctx, true),
    [
      { id: 'skip', label: `Skip ${name}`, shortcut: 'Delete', onSelect: skip },
      { id: 'take-out', label: `Take ${name} out of ${batch}`, onSelect: () => void ctx.actions.takeOut(ids(queued)) }
    ],
    [revealItem(job, 'source', ctx), copyPathItem([job], ctx)]
  )
}

function runningItems(job: JobView, targets: readonly JobView[], ctx: RowMenuContext): MenuEntry[]
{
  const running = targets.filter(isRunningJob)
  const queued = targets.filter((entry) => entry.state === 'queued').length
  const cancel = (): void => ctx.confirm({
    question: cancelQuestion(running, { now: ctx.now, platform: ctx.platform, queued, firstMeasured: ctx.firstMeasured }),
    safeLabel: 'Keep running',
    confirmLabel: running.length === 1 ? 'Cancel job' : `Cancel ${countOf(running.length, 'job')}`,
    danger: true,
    anchorId: job.id,
    onConfirm: () => void ctx.actions.cancelJobs(ids(running))
  })
  return sections(
    [{
      id: 'cancel',
      label: running.length === 1 ? `Cancel job ${running[0].id}` : `Cancel ${targetName(running)}`,
      shortcut: ctx.platform === 'darwin' ? 'Mod+Delete' : 'Shift+Delete',
      danger: true,
      onSelect: cancel
    }],
    [
      hostItem('show-log', `Show log for ${job.id}`, ctx.host.showLog, job),
      revealItem(job, 'source', ctx),
      hostItem('copy-command', `Copy command for ${job.id}`, ctx.host.copyCommand, job)
    ]
  )
}

function retry(targets: readonly JobView[], ctx: RowMenuContext): void
{
  const list = ids(targets)
  void ctx.actions.retry(list).then((outcome) =>
  {
    if (outcome.status === 'needs-acknowledgment')
    {
      ctx.host.retryNeedsAcknowledgment?.(list, outcome.ack)
    }
  })
}

function copyResultItem(job: JobView, ctx: RowMenuContext): MenuActionItem
{
  return {
    id: 'copy-result',
    label: `Copy result of ${job.id}`,
    onSelect: () =>
    {
      void Promise.resolve(ctx.writeText(`${job.id} ${resultText(job)}`.trim())).then(
        () => ctx.announce('Copied the result.'),
        () => ctx.announce('Could not copy the result.')
      )
    }
  }
}

/** A held job's decisions; each acts on this job alone. */
function decisionItems(job: JobView, ctx: RowMenuContext): MenuEntry[]
{
  const offered = job.hold?.actions ?? ['keep', 'keep-renamed', 'discard', 'retry']
  const keepLabel = job.hold?.reason === 'interrupted-finalize'
    ? `Finish saving ${job.id}`
    : ctx.replaceMode ? `Keep output of ${job.id} and replace original` : `Keep output of ${job.id}`
  const keep = (): void =>
  {
    void ctx.actions.keepOutput([job.id]).then((outcome) =>
    {
      if (outcome.status !== 'needs-confirmation')
      {
        return
      }
      ctx.confirm({
        question: `Replace the original of ${job.id} with an output outside tolerance? The original goes to the Recycle Bin.`,
        safeLabel: 'Keep both',
        confirmLabel: 'Replace original',
        danger: true,
        anchorId: job.id,
        onConfirm: () => void ctx.actions.keepOutput([job.id], { confirmed: true })
      })
    })
  }
  const discard = (): void => ctx.confirm({
    question: `Discard the output of ${job.id}? The file is deleted. The original and any existing file stay.`,
    safeLabel: 'Keep it',
    confirmLabel: 'Discard',
    danger: true,
    anchorId: job.id,
    onConfirm: () => void ctx.actions.discardOutput([job.id])
  })
  const retryHeld = (): void => ctx.confirm({
    question: `Retry ${job.id}? The output waiting for a decision is deleted first.`,
    safeLabel: 'Keep waiting',
    confirmLabel: 'Retry',
    danger: false,
    anchorId: job.id,
    onConfirm: () => retry([job], ctx)
  })
  return sections(
    [
      offered.includes('keep') ? { id: 'keep-output', label: keepLabel, onSelect: keep } : null,
      offered.includes('keep-renamed')
        ? { id: 'keep-renamed', label: `Keep ${job.id} under a new name`, onSelect: () => void ctx.actions.keepOutput([job.id], { placement: 'renamed' }) }
        : null,
      offered.includes('discard') ? { id: 'discard-output', label: `Discard output of ${job.id}`, danger: true, onSelect: discard } : null,
      offered.includes('retry') ? { id: 'retry', label: `Retry ${job.id}`, onSelect: retryHeld } : null
    ],
    [hostItem('show-log', `Show log for ${job.id}`, ctx.host.showLog, job)]
  )
}

function finishedItems(job: JobView, targets: readonly JobView[], ctx: RowMenuContext): MenuEntry[]
{
  const host = ctx.host
  const name = targetName(targets)
  const output = job.state === 'done'
  const attention = needsAttention(job)
  return sections(
    [
      output ? revealItem(job, 'output', ctx) : null,
      output ? hostItem('open-output', `Open output of ${job.id}`, host.openOutput, job) : null
    ],
    [
      { id: 'retry', label: `Retry ${name}`, onSelect: () => retry(targets, ctx) },
      hostItem('edit-and-retry', `Edit and retry ${job.id}`, host.editAndRetry, job),
      duplicateItem(targets, ctx)
    ],
    [
      hostItem('show-log', `Show log for ${job.id}`, host.showLog, job),
      hostItem('copy-command', `Copy command for ${job.id}`, host.copyCommand, job),
      copyResultItem(job, ctx)
    ],
    [
      attention ? { id: 'acknowledge', label: `Acknowledge ${name}`, onSelect: () => void ctx.actions.acknowledge(ids(targets)) } : null,
      {
        id: 'remove-from-table',
        label: `Remove ${name} from table`,
        shortcut: 'Delete',
        disabled: attention,
        disabledReason: attention ? ACKNOWLEDGE_FIRST : undefined,
        onSelect: () => void ctx.actions.deleteJobs(ids(targets))
      }
    ]
  )
}

/** History's jobs are read-only: their output, log, command, and result. */
function historyItems(job: JobView, ctx: RowMenuContext): MenuEntry[]
{
  const output = job.state === 'done'
  return sections(
    [
      output ? revealItem(job, 'output', ctx) : null,
      output ? hostItem('open-output', `Open output of ${job.id}`, ctx.host.openOutput, job) : null
    ],
    [
      hostItem('show-log', `Show log for ${job.id}`, ctx.host.showLog, job),
      hostItem('copy-command', `Copy command for ${job.id}`, ctx.host.copyCommand, job),
      copyResultItem(job, ctx)
    ]
  )
}

/**
 * A row's menu by its job's phase. Every action names the job it acts on ("Cancel job MM-0137"), or the count when
 * it acts on a selection the row is part of; unavailable items stay focusable with their reason as visible text.
 */
export function rowMenuEntries(job: JobView, ctx: RowMenuContext): MenuEntry[]
{
  const targets = menuTargets(job, ctx)
  switch (rowPhase(job, ctx.list))
  {
    case 'waiting':
      return waitingItems(job, targets, ctx)
    case 'queued':
      return queuedItems(job, targets, ctx)
    case 'running':
      return runningItems(job, targets, ctx)
    case 'decision':
      return decisionItems(job, ctx)
    case 'finished':
      return finishedItems(job, targets.filter((entry) => rowPhase(entry, ctx.list) === 'finished'), ctx)
    case 'history':
      return historyItems(job, ctx)
  }
}

/** What the row menu hook reads from the page. */
export interface RowMenuOptions
{
  list: ViewKey
  platform: Platform
  /** The table's confirmation, shared with the key commands (useTableCommands().confirm). */
  confirm: (request: ConfirmRequest) => void
  /** The view's polite live region. */
  announce: (message: string) => void
  host?: RowMenuHost
  /** The window's stores by default. */
  jobs?: StoreApi<JobsState>
  view?: StoreApi<BatchViewState>
  replaceMode?: boolean
  output?: EncoderPolicy
  filterContext?: FilterContext
  /** The system clipboard by default. */
  writeText?: (text: string) => void | Promise<void>
  firstMeasured?: (id: JobId) => string | null
  now?: () => number
}

function clipboardText(text: string): Promise<void>
{
  return navigator.clipboard.writeText(text)
}

/** The table's `rowMenu`: each job's items, read from the stores when the menu opens. */
export function useRowMenu(options: RowMenuOptions): (job: JobView) => MenuEntry[]
{
  const actions = useBatchActions()
  const latest = useRef(options)

  useLayoutEffect(() =>
  {
    latest.current = options
  })

  return useCallback((job: JobView): MenuEntry[] =>
  {
    const current = latest.current
    const view = current.view ?? useBatchView
    const state = view.getState()
    const listView = state.views[current.list]
    return rowMenuEntries(job, {
      actions,
      list: current.list,
      mode: state.mode,
      platform: current.platform,
      jobs: (current.jobs ?? useJobsStore).getState(),
      selection: listView.selection,
      sorted: listView.sort !== null,
      replaceMode: current.replaceMode ?? false,
      output: current.output,
      filterContext: current.filterContext,
      now: (current.now ?? Date.now)(),
      host: current.host ?? {},
      view: view.getState(),
      confirm: current.confirm,
      announce: current.announce,
      writeText: current.writeText ?? clipboardText,
      firstMeasured: current.firstMeasured
    })
  }, [actions])
}

/** The table row a confirmation anchors to, found by its row id. */
export function rowElement(id: string, root: ParentNode = document): HTMLElement | null
{
  for (const row of root.querySelectorAll<HTMLElement>('[role="row"][data-row-id]'))
  {
    if (row.dataset.rowId === id)
    {
      return row
    }
  }
  return null
}

/** Props for {@link TableConfirm}. */
export interface TableConfirmProps
{
  /** The confirmation waiting for a choice (useTableCommands().pending). */
  pending: ConfirmRequest | null
  /** The choice (useTableCommands().resolve). */
  onResolve: (confirmed: boolean) => void
  /** Finds a row's element; the grid's rows by default. */
  anchorFor?: (id: string) => HTMLElement | null
  /** The table's stable element, focused after the choice when the row is gone. */
  fallbackFocus?: FocusFallback
}

/** The small confirmation a table command asks for, anchored to its row with focus on the safe choice. */
export function TableConfirm({ pending, onResolve, anchorFor = rowElement, fallbackFocus }: TableConfirmProps): ReactElement | null
{
  if (pending === null)
  {
    return null
  }
  return (
    <ConfirmPopover
      key={`${pending.anchorId ?? ''}\n${pending.question}`}
      anchor={pending.anchorId === null ? null : anchorFor(pending.anchorId)}
      question={pending.question}
      safeLabel={pending.safeLabel}
      confirmLabel={pending.confirmLabel}
      danger={pending.danger}
      onResolve={onResolve}
      fallbackFocus={fallbackFocus}
    />
  )
}
