/**
 * The Batch table's key commands: which chord a key event is, and what it does to the selected jobs. Every command
 * goes through the Batch view's actions, so the table, the row menu, and the page share one path.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { EncoderPolicy } from '../../../../../shared/audio/types'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { JobView, PresetState } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { countOf, formatElapsed, stampWords, statusWords } from '../../../copy/batch'
import type { BatchActions, MoveTarget } from '../../../stores/batchActions'
import { useBatchView, type BatchMode, type BatchViewState, type ViewKey } from '../../../stores/batchView'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import type { GridSelectionAction, GridSelectionState } from '../../../ui/useGridSelection'
import { useBatchActions } from '../BatchActionsContext'
import { runPinChord, type PinKey } from '../toolbar/RecipePicker'

/** Why moves are refused while the table is sorted by a column. */
export const REORDER_SORTED = 'Sort by queue order to reorder.'

/** The Status word of a job in its corrective audio encode. */
export const CORRECTIVE_WORD = 'Re-encoding (correction)'

/** The columns Ctrl+C copies, in order. */
export const COPY_COLUMNS = ['No.', 'File', 'Status', 'Operation', 'Result', 'Output path'] as const

const RUNNING_STATES: ReadonlySet<JobView['state']> = new Set<JobView['state']>(['analyzing', 'encoding', 'verifying', 'finalizing'])

const NO_PRESETS: PresetState = { user: [], pins: {}, recent: [] }

/** True while a job holds a worker: probing, measuring, encoding, verifying, or saving. */
export function isRunningJob(job: Pick<JobView, 'state'>): boolean
{
  return RUNNING_STATES.has(job.state)
}

/** True for the lists of History, whose jobs are read-only. */
export function isHistoryList(list: ViewKey): boolean
{
  return list === 'history' || list === 'historyResults' || list === 'historyBatch'
}

/** The selected jobs in queue order, or the focused job alone when nothing is selected. */
export function commandTargets(jobs: Pick<JobsState, 'order' | 'jobs'>, selected: ReadonlySet<string>, focusedId: string | null): JobView[]
{
  const picked = jobs.order.filter((id) => selected.has(id)).map((id) => jobs.jobs[id]).filter((job): job is JobView => job !== undefined)
  if (picked.length > 0)
  {
    return picked
  }
  const focused = focusedId === null ? undefined : jobs.jobs[focusedId as JobId]
  return focused === undefined ? [] : [focused]
}

/** "Skip 38 queued jobs? They end as Skipped; Retry runs them later." */
export function skipQuestion(count: number): string
{
  return `Skip ${countOf(count, 'queued job')}? They end as Skipped; Retry runs them later.`
}

/** What the Cancel job question reads besides the running jobs themselves. */
export interface CancelFacts
{
  now: number
  platform: Platform
  /** Queued jobs in the selection, which stay queued. */
  queued: number
  /** The first encode's measured value of a job in its corrective encode ("-21.8 LUFS"), when known. */
  firstMeasured?: (id: JobId) => string | null
}

function elapsedOf(job: Pick<JobView, 'startedAt'>, now: number): number
{
  return job.startedAt === null ? 0 : Math.max(0, now - job.startedAt)
}

/**
 * The Cancel job question: one job names its discarded time and, during the corrective encode, the first encode;
 * several sum their time; queued jobs in the selection are named as staying queued.
 */
export function cancelQuestion(running: readonly JobView[], facts: CancelFacts): string
{
  const parts: string[] = []
  if (running.length === 1)
  {
    const job = running[0]
    parts.push(`Cancel ${job.id}? ${formatElapsed(elapsedOf(job, facts.now))} of encoding is discarded and its partial file is deleted. The source is not touched.`)
    if (statusWords(job, { platform: facts.platform }).label === CORRECTIVE_WORD)
    {
      const measured = facts.firstMeasured?.(job.id) ?? null
      parts.push(measured === null ? 'The first encode is discarded too.' : `The first encode, measured ${measured}, is discarded too.`)
    }
  }
  else
  {
    const total = running.reduce((sum, job) => sum + elapsedOf(job, facts.now), 0)
    parts.push(`Cancel ${countOf(running.length, 'running job')}? ${formatElapsed(total)} of work is discarded and their partial files are deleted.`)
  }
  if (facts.queued === 1)
  {
    parts.push('1 queued job in the selection stays queued; Delete skips it.')
  }
  else if (facts.queued > 1)
  {
    parts.push(`${countOf(facts.queued, 'queued job')} in the selection stay queued; Delete skips them.`)
  }
  return parts.join(' ')
}

function cell(text: string): string
{
  return text.replace(/[\t\r\n]+/g, ' ')
}

/** The Result column as text: the stamp as it is spoken, else the short reason a job returned. */
export function resultText(job: JobView): string
{
  return stampWords(job)?.spoken ?? job.error?.short ?? ''
}

/** The selected rows as tab-separated text under a header row: No., File, Status, Recipe, Result, Output path. */
export function rowsAsText(jobs: readonly JobView[], platform: Platform, inRunMode = false): string
{
  const lines = [COPY_COLUMNS.join('\t')]
  for (const job of jobs)
  {
    const output = job.plan?.relativePath ?? job.stamp?.outputName ?? ''
    lines.push([job.id, job.source.name, statusWords(job, { platform, inRunMode }).label, job.recipeLabel, resultText(job), output].map(cell).join('\t'))
  }
  return lines.join('\n')
}

/** A key command the table acts on. */
export type TableKeyCommand =
  | { kind: 'toggle' }
  | { kind: 'delete' }
  | { kind: 'cancel' }
  | { kind: 'duplicate' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'pin'; digit: number; add: boolean }
  | { kind: 'move'; where: 'up' | 'down' | 'top' | 'bottom' }
  | { kind: 'shortcuts' }
  | { kind: 'attention'; direction: 'next' | 'previous' }

/** The parts of a key event the commands read. */
export interface KeyChord
{
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** The top-row digit a key position names (Digit1 to Digit9), or null; numeric keypad digits are never pins. */
export function pinDigit(code: string): number | null
{
  const match = /^Digit([1-9])$/.exec(code)
  return match === null ? null : Number(match[1])
}

const MOVE_KEYS: Readonly<Record<string, 'up' | 'down' | 'top' | 'bottom'>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'top',
  End: 'bottom'
}

/**
 * The table command a chord names, or null for keys the table leaves to the grid, the page, or the system. On
 * macOS Cmd stands for Ctrl, the key that deletes backward is Delete, and Cmd with it cancels; Ctrl+Space toggles
 * only on Windows and Linux. Pins read the key position, so the character Alt or Option types does not matter, and
 * AltGr (Ctrl with Alt) never pins.
 */
export function readTableKey(chord: KeyChord, mac = false): TableKeyCommand | null
{
  const { key, code, altKey, shiftKey } = chord
  const command = mac ? chord.metaKey : chord.ctrlKey
  const other = mac ? chord.ctrlKey : chord.metaKey
  if (other)
  {
    return null
  }
  if (altKey)
  {
    if (command || code.startsWith('Numpad'))
    {
      return null
    }
    const digit = pinDigit(code)
    if (digit !== null)
    {
      return { kind: 'pin', digit, add: shiftKey }
    }
    const where = MOVE_KEYS[key]
    return where !== undefined && !shiftKey ? { kind: 'move', where } : null
  }
  const deleteKey = key === 'Delete' || (mac && key === 'Backspace')
  if (command)
  {
    if (shiftKey)
    {
      return null
    }
    if (mac && deleteKey)
    {
      return { kind: 'cancel' }
    }
    if (key === ' ' && !mac)
    {
      return { kind: 'toggle' }
    }
    switch (key.toLowerCase())
    {
      case 'd':
        return { kind: 'duplicate' }
      case 'c':
        return { kind: 'copy' }
      case 'v':
        return { kind: 'paste' }
      default:
        return null
    }
  }
  if (key === 'F8')
  {
    return { kind: 'attention', direction: shiftKey ? 'previous' : 'next' }
  }
  if (key === '?')
  {
    return { kind: 'shortcuts' }
  }
  if (shiftKey)
  {
    return key === 'Delete' && !mac ? { kind: 'cancel' } : null
  }
  if (key === ' ')
  {
    return { kind: 'toggle' }
  }
  return deleteKey ? { kind: 'delete' } : null
}

const CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="dialog"]',
  '[popover]'
].join(', ')

/** True while a key's target is a text field, select, menu, or popover, whose keys keep their meaning there. */
export function keyBelongsToControl(target: EventTarget | null): boolean
{
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(CONTROL_SELECTOR) !== null
}

/** A confirmation a command asks for first, shown in a small popover anchored to a row. */
export interface ConfirmRequest
{
  question: string
  /** The choice that keeps things as they are; it comes first and takes focus. */
  safeLabel: string
  confirmLabel: string
  danger: boolean
  /** The row the popover anchors to and focus returns to; null anchors it to the table. */
  anchorId: string | null
  onConfirm: () => void
}

/** What a key command reads and calls; the hook binds it to the page, tests build it directly. */
export interface TableCommandContext
{
  actions: BatchActions
  list: ViewKey
  mode: BatchMode
  platform: Platform
  jobs: JobsState
  selection: GridSelectionState
  focusedId: string | null
  /** The list is sorted by a column, so it cannot reorder. */
  sorted: boolean
  /** The key came from a text field, select, menu, or popover. */
  fromControl: boolean
  output?: EncoderPolicy
  now: number
  select(action: GridSelectionAction): void
  confirm(request: ConfirmRequest): void
  announce(message: string): void
  writeText(text: string): void | Promise<void>
  /** "?" while the table has focus: the keyboard shortcuts popover. */
  onShortcuts?: () => void
  /** F8 and Shift+F8: the next or previous job that needs attention. */
  onAttention?: (direction: 'next' | 'previous') => void
  firstMeasured?: (id: JobId) => string | null
}

function targetsOf(ctx: TableCommandContext): JobView[]
{
  return commandTargets(ctx.jobs, ctx.selection.selected, ctx.focusedId)
}

function editable(ctx: TableCommandContext): boolean
{
  return !isHistoryList(ctx.list) && !ctx.fromControl
}

/** Delete acts on each selected job by its state; several skips ask first, anchored to the focused row. */
function deleteCommand(ctx: TableCommandContext): boolean
{
  if (ctx.list === 'history')
  {
    return false
  }
  const ids = targetsOf(ctx).map((job) => job.id)
  if (ids.length === 0 && !isHistoryList(ctx.list))
  {
    return false
  }
  const anchorId = ctx.focusedId
  void ctx.actions.deleteJobs(ids).then((outcome) =>
  {
    if (outcome.status !== 'needs-confirmation')
    {
      return
    }
    const count = outcome.plan.skip.length
    ctx.confirm({
      question: skipQuestion(count),
      safeLabel: 'Keep queued',
      confirmLabel: `Skip ${countOf(count, 'job')}`,
      danger: false,
      anchorId,
      onConfirm: () => void ctx.actions.deleteJobs(ids, { confirmed: true })
    })
  })
  return true
}

/** Shift+Delete cancels the selected running jobs after the small confirmation; queued jobs are left alone. */
function cancelCommand(ctx: TableCommandContext): boolean
{
  if (isHistoryList(ctx.list))
  {
    return false
  }
  const targets = targetsOf(ctx)
  const running = targets.filter(isRunningJob)
  if (running.length === 0)
  {
    ctx.announce('Only running jobs can be canceled.')
    return true
  }
  const queued = targets.filter((job) => job.state === 'queued').length
  const ids = running.map((job) => job.id)
  ctx.confirm({
    question: cancelQuestion(running, { now: ctx.now, platform: ctx.platform, queued, firstMeasured: ctx.firstMeasured }),
    safeLabel: 'Keep running',
    confirmLabel: running.length === 1 ? 'Cancel job' : `Cancel ${countOf(running.length, 'job')}`,
    danger: true,
    anchorId: ctx.focusedId,
    onConfirm: () => void ctx.actions.cancelJobs(ids)
  })
  return true
}

/** Alt with a digit applies that pin, and Alt+Shift adds second jobs with it, only in Queue and Review. */
function pinCommand(command: Extract<TableKeyCommand, { kind: 'pin' }>, ctx: TableCommandContext): boolean
{
  if (ctx.fromControl || (ctx.mode !== 'queue' && ctx.mode !== 'review') || ctx.list !== ctx.mode)
  {
    return false
  }
  const jobs = targetsOf(ctx)
  const chord = { key: String(command.digit) as PinKey, add: command.add }
  void runPinChord(ctx.actions, ctx.jobs.presets ?? NO_PRESETS, jobs, chord, ctx.platform, ctx.output).then((result) =>
  {
    if (result.kind === 'none')
    {
      ctx.announce(result.status)
    }
  })
  return true
}

/** Alt with the arrows, Home, and End move the selected jobs, only in queue order. */
function moveCommand(where: MoveTarget, ctx: TableCommandContext): boolean
{
  if (!editable(ctx))
  {
    return false
  }
  if (ctx.sorted)
  {
    ctx.announce(REORDER_SORTED)
    return true
  }
  const ids = targetsOf(ctx).map((job) => job.id)
  if (ids.length === 0)
  {
    return false
  }
  void ctx.actions.move(ids, where)
  return true
}

/** Ctrl+C copies the selected rows as tab-separated text. */
function copyCommand(ctx: TableCommandContext): boolean
{
  const jobs = targetsOf(ctx)
  if (jobs.length === 0)
  {
    return false
  }
  void Promise.resolve(ctx.writeText(rowsAsText(jobs, ctx.platform, ctx.mode === 'run'))).then(
    () => ctx.announce(`Copied ${countOf(jobs.length, 'row')}.`),
    () => ctx.announce('Could not copy the rows.')
  )
  return true
}

/**
 * Runs a key command on the table and returns true when it handled the key. Space toggles the focused row in every
 * mode and never pauses, stops, or cancels anything.
 */
export function runTableCommand(command: TableKeyCommand, ctx: TableCommandContext): boolean
{
  switch (command.kind)
  {
    case 'toggle':
      if (ctx.focusedId === null)
      {
        return false
      }
      ctx.select({ type: 'toggle', id: ctx.focusedId })
      return true
    case 'delete':
      return deleteCommand(ctx)
    case 'cancel':
      return cancelCommand(ctx)
    case 'duplicate':
    {
      const ids = editable(ctx) ? targetsOf(ctx).map((job) => job.id) : []
      if (ids.length === 0)
      {
        return false
      }
      void ctx.actions.duplicate(ids)
      return true
    }
    case 'copy':
      return copyCommand(ctx)
    case 'paste':
      if (!editable(ctx))
      {
        return false
      }
      void ctx.actions.pasteFiles()
      return true
    case 'pin':
      return pinCommand(command, ctx)
    case 'move':
      return moveCommand(command.where, ctx)
    case 'shortcuts':
      if (ctx.onShortcuts === undefined)
      {
        return false
      }
      ctx.onShortcuts()
      return true
    case 'attention':
      if (ctx.onAttention === undefined)
      {
        return false
      }
      ctx.onAttention(command.direction)
      return true
  }
}

/** What the table's command hook reads from the page. */
export interface TableCommandOptions
{
  list: ViewKey
  platform: Platform
  /** The view's polite live region. */
  announce: (message: string) => void
  /** The window's stores by default. */
  jobs?: StoreApi<JobsState>
  view?: StoreApi<BatchViewState>
  output?: EncoderPolicy
  /** The system clipboard by default. */
  writeText?: (text: string) => void | Promise<void>
  onShortcuts?: () => void
  onAttention?: (direction: 'next' | 'previous') => void
  firstMeasured?: (id: JobId) => string | null
  now?: () => number
}

/** The table's key commands and the confirmation one of them is asking for. */
export interface TableCommands
{
  /** The table's `onKeyCommand`: true when the key was a command it ran. */
  onKeyCommand: (event: KeyboardEvent, focusedId: string | null) => boolean
  /** The confirmation waiting for a choice, or null. */
  pending: ConfirmRequest | null
  /** Asks a confirmation, replacing one still open. */
  confirm: (request: ConfirmRequest) => void
  /** The choice for the pending confirmation; confirming runs it. */
  resolve: (confirmed: boolean) => void
}

function clipboardText(text: string): Promise<void>
{
  return navigator.clipboard.writeText(text)
}

/** Binds the key commands to the Batch view's actions, the list's view state, and the page's announcer. */
export function useTableCommands(options: TableCommandOptions): TableCommands
{
  const actions = useBatchActions()
  const latest = useRef(options)
  const pendingRef = useRef<ConfirmRequest | null>(null)
  const [pending, setPending] = useState<ConfirmRequest | null>(null)

  useLayoutEffect(() =>
  {
    latest.current = options
  })

  const confirm = useCallback((request: ConfirmRequest): void =>
  {
    pendingRef.current = request
    setPending(request)
  }, [])

  const resolve = useCallback((confirmed: boolean): void =>
  {
    const request = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (confirmed && request !== null)
    {
      request.onConfirm()
    }
  }, [])

  const onKeyCommand = useCallback((event: KeyboardEvent, focusedId: string | null): boolean =>
  {
    const current = latest.current
    const command = readTableKey(event, current.platform === 'darwin')
    if (command === null)
    {
      return false
    }
    const view = current.view ?? useBatchView
    const state = view.getState()
    const listView = state.views[current.list]
    return runTableCommand(command, {
      actions,
      list: current.list,
      mode: state.mode,
      platform: current.platform,
      jobs: (current.jobs ?? useJobsStore).getState(),
      selection: listView.selection,
      focusedId: focusedId ?? listView.selection.focus,
      sorted: listView.sort !== null,
      fromControl: keyBelongsToControl(event.target),
      output: current.output,
      now: (current.now ?? Date.now)(),
      select: (action) => void view.getState().select(current.list, action),
      confirm,
      announce: current.announce,
      writeText: current.writeText ?? clipboardText,
      onShortcuts: current.onShortcuts,
      onAttention: current.onAttention,
      firstMeasured: current.firstMeasured
    })
  }, [actions, confirm])

  return { onKeyCommand, pending, confirm, resolve }
}
