import { useEffect, useRef, type RefObject } from 'react'
import type { RunStatus } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { focusNextRegion, type F6Direction } from '../../../hooks/useF6Region'
import { useAppStore } from '../../../stores/appStore'
import type { DraftCommit } from '../../../stores/batchActions'
import type { BatchMode } from '../../../stores/batchView'
import type { View } from '../../../stores/types'
import type { Announce } from '../../../ui/LiveRegion'
import { keyBelongsToControl, type KeyChord } from '../table/tableCommands'
import { isShown } from './focus'

/** Announced when Ctrl+Enter finds no brass action. */
export const NOTHING_TO_START = 'Nothing to start.'

/** Announced when Ctrl+3 asks for Run before the first batch. */
export const RUN_NOT_STARTED = 'Run starts when you press Start.'

/** Announced when a brass action is refused by an invalid field draft; focus stays in the field. */
export function fixFirst(field: string): string
{
  return `Fix ${field} first.`
}

/** The modes Ctrl+1 to Ctrl+4 open, in key order. */
export const MODE_KEYS: readonly BatchMode[] = ['queue', 'review', 'run', 'history']

/** A view chord or key of the Batch view's keyboard map that the page acts on. */
export type BatchKeyCommand =
  | { kind: 'brass' }
  | { kind: 'start-selected' }
  | { kind: 'pause' }
  | { kind: 'picker' }
  | { kind: 'add-files' }
  | { kind: 'add-folder' }
  | { kind: 'search' }
  | { kind: 'mode'; mode: BatchMode }
  | { kind: 'inspector' }
  | { kind: 'shortcuts' }
  | { kind: 'region'; direction: F6Direction }
  | { kind: 'attention'; direction: 'next' | 'previous' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'history-back' }
  | { kind: 'escape'; from: 'table' | 'inspector' | 'view' }

/** Where a key landed: the table, a control that keeps its own keys, or the inspector. */
export interface KeyPlace
{
  inTable: boolean
  inControl: boolean
  inInspector: boolean
}

function modeDigit(code: string, key: string): BatchMode | null
{
  const match = /^(?:Digit|Numpad)([1-4])$/.exec(code)
  const digit = match !== null ? match[1] : code === '' && /^[1-4]$/.test(key) ? key : null
  return digit === null ? null : MODE_KEYS[Number(digit) - 1]
}

function readCommandChord(chord: KeyChord, place: KeyPlace, mac: boolean): BatchKeyCommand | null
{
  const { key, code, shiftKey } = chord
  const lower = key.toLowerCase()
  if (key === 'Enter')
  {
    return shiftKey ? { kind: 'start-selected' } : { kind: 'brass' }
  }
  if (lower === 'o')
  {
    return shiftKey ? { kind: 'add-folder' } : { kind: 'add-files' }
  }
  if (lower === 'z')
  {
    return place.inControl ? null : shiftKey ? { kind: 'redo' } : { kind: 'undo' }
  }
  if (shiftKey)
  {
    return null
  }
  const mode = modeDigit(code, key)
  if (mode !== null)
  {
    return { kind: 'mode', mode }
  }
  switch (lower)
  {
    case 'p':
      return { kind: 'pause' }
    case 'k':
      return { kind: 'picker' }
    case 'f':
      return { kind: 'search' }
    case 'i':
      return { kind: 'inspector' }
    case '/':
      return { kind: 'shortcuts' }
    case 'y':
      return mac || place.inControl ? null : { kind: 'redo' }
    default:
      return code === 'Slash' ? { kind: 'shortcuts' } : null
  }
}

/**
 * The Batch view command a key names, or null for keys the table, a control, the shell, or the system keep.
 * View chords (Ctrl+Enter, Ctrl+Shift+Enter, Ctrl+P, Ctrl+K, Ctrl+O, Ctrl+Shift+O, Ctrl+F, Ctrl+1 to Ctrl+4, Ctrl+I,
 * Ctrl+/, F1, F6, F8) act from anywhere in the view; Ctrl+Z and Ctrl+Y stay with text fields, selects, menus, and
 * popovers; "?" is a character key, so it acts only from the table. On macOS Cmd stands for Ctrl, Ctrl+Y is not
 * redo, and the key that deletes backward is Backspace. Ctrl+R and Ctrl+Minus are never bound.
 */
export function readBatchKey(chord: KeyChord, place: KeyPlace, mac = false): BatchKeyCommand | null
{
  const command = mac ? chord.metaKey : chord.ctrlKey
  const other = mac ? chord.ctrlKey : chord.metaKey
  if (other || chord.altKey)
  {
    return null
  }
  if (command)
  {
    return readCommandChord(chord, place, mac)
  }
  switch (chord.key)
  {
    case 'F1':
      return chord.shiftKey ? null : { kind: 'shortcuts' }
    case 'F6':
      return { kind: 'region', direction: chord.shiftKey ? 'previous' : 'next' }
    case 'F8':
      return { kind: 'attention', direction: chord.shiftKey ? 'previous' : 'next' }
    case 'Escape':
      if (place.inControl || chord.shiftKey)
      {
        return null
      }
      return { kind: 'escape', from: place.inTable ? 'table' : place.inInspector ? 'inspector' : 'view' }
    case 'Backspace':
      return place.inControl || chord.shiftKey ? null : { kind: 'history-back' }
    case '?':
      return place.inTable && !place.inControl ? { kind: 'shortcuts' } : null
    default:
      return null
  }
}

/** The run facts the pause key reads. */
export interface PauseFacts
{
  runStatus: RunStatus
  /** "Batch 31". */
  runLabel: string
  /** Jobs that finish before a pause settles. */
  runningCount: number
}

/** The run states in which Ctrl+P pauses or resumes. */
export const PAUSABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'pausing', 'paused'])

/** What a Ctrl+P press says: "Pausing Batch 31. 3 running jobs finish first." or "Batch 31 resumed." */
export function pausePress(facts: PauseFacts): string
{
  if (facts.runStatus !== 'running')
  {
    return `${facts.runLabel} resumed.`
  }
  const count = facts.runningCount
  if (count <= 0)
  {
    return `Pausing ${facts.runLabel}.`
  }
  return count === 1
    ? `Pausing ${facts.runLabel}. 1 running job finishes first.`
    : `Pausing ${facts.runLabel}. ${count} running jobs finish first.`
}

/** What Ctrl+Enter does at this moment, read after the focused draft is committed. */
export type BrassMoment =
  | { kind: 'none' }
  /** Start waits on an unchecked acknowledgment: expand a hidden summary, focus the checkbox, and return why. */
  | { kind: 'gated'; focusAcknowledgment: () => string | null }
  | { kind: 'ready'; perform: () => void | Promise<void> }

/** The page facts the keys read, evaluated at each press. */
export interface BatchKeyFacts extends PauseFacts
{
  mode: BatchMode
  /** False before the first batch, when Run has nothing to show. */
  runAvailable: boolean
  /** True while History shows the rows of one opened batch. */
  historyBatchOpen: boolean
}

/**
 * What the page does for each command. A missing handler leaves its key to the rest of the app; a handler that
 * returns false declines the key, so it is not prevented.
 */
export interface BatchKeyHandlers
{
  /** Commits the focused field's draft through the same path as blur. */
  commitDraft?: () => DraftCommit | Promise<DraftCommit>
  brass?: () => BrassMoment
  startSelected?: () => void | Promise<void>
  togglePause?: (to: 'pause' | 'resume') => void
  openPicker?: () => void
  addFiles?: () => void
  addFolder?: () => void
  focusSearch?: () => void
  setMode?: (mode: BatchMode) => void
  toggleInspector?: () => void
  openShortcuts?: () => void
  focusRegion?: (direction: F6Direction) => void
  focusAttention?: (direction: 'next' | 'previous') => void
  undo?: () => void
  redo?: () => void
  historyBack?: () => void
  /** Chooses the safe action of an open inline confirmation; true when one was open. */
  resolveConfirmation?: () => boolean
  /** Clears the table's selection; true when there was one. */
  clearSelection?: () => boolean
  /** Returns focus from the inspector to the row that owns the selection focus. */
  returnToRow?: () => void
}

/** Everything a command needs to run. */
export interface BatchKeyContext
{
  handlers: BatchKeyHandlers
  facts: () => BatchKeyFacts
  announce: Announce
  /** Set while a brass action commits and runs, so a second press does not start twice. */
  busy: { current: boolean }
}

async function commitThen(ctx: BatchKeyContext, act: () => void | Promise<void>): Promise<void>
{
  if (ctx.busy.current)
  {
    return
  }
  ctx.busy.current = true
  try
  {
    const commit = ctx.handlers.commitDraft === undefined ? { status: 'none' as const } : await ctx.handlers.commitDraft()
    if (commit.status === 'invalid')
    {
      ctx.announce(fixFirst(commit.field))
      return
    }
    await act()
  }
  finally
  {
    ctx.busy.current = false
  }
}

/**
 * Commits any field draft, then performs the brass action of the moment: an invalid
 * draft refuses with "Fix {field} first.", a gate on the acknowledgment focuses the checkbox and says why, and no
 * brass action says "Nothing to start."
 */
export function runBrass(ctx: BatchKeyContext, brass: () => BrassMoment): Promise<void>
{
  return commitThen(ctx, async () =>
  {
    const moment = brass()
    switch (moment.kind)
    {
      case 'gated':
      {
        const text = moment.focusAcknowledgment()
        if (text !== null)
        {
          ctx.announce(text)
        }
        return
      }
      case 'ready':
        await moment.perform()
        return
      default:
        ctx.announce(NOTHING_TO_START)
    }
  })
}

function call(handler: (() => void) | undefined): boolean
{
  if (handler === undefined)
  {
    return false
  }
  handler()
  return true
}

/** Runs a command; true when the page acted on it, so the key is prevented and nothing else acts on it. */
export function runBatchKey(command: BatchKeyCommand, ctx: BatchKeyContext): boolean
{
  const { handlers } = ctx
  switch (command.kind)
  {
    case 'brass':
    {
      const brass = handlers.brass
      if (brass === undefined)
      {
        return false
      }
      void runBrass(ctx, brass)
      return true
    }
    case 'start-selected':
    {
      const start = handlers.startSelected
      if (start === undefined || ctx.facts().mode !== 'review')
      {
        return false
      }
      void commitThen(ctx, start)
      return true
    }
    case 'pause':
    {
      const facts = ctx.facts()
      if (handlers.togglePause === undefined || !PAUSABLE.has(facts.runStatus))
      {
        return false
      }
      ctx.announce(pausePress(facts))
      handlers.togglePause(facts.runStatus === 'running' ? 'pause' : 'resume')
      return true
    }
    case 'picker':
    {
      const mode = ctx.facts().mode
      return mode === 'queue' || mode === 'review' ? call(handlers.openPicker) : false
    }
    case 'add-files':
      return call(handlers.addFiles)
    case 'add-folder':
      return call(handlers.addFolder)
    case 'search':
      return call(handlers.focusSearch)
    case 'mode':
    {
      const setMode = handlers.setMode
      if (setMode === undefined)
      {
        return false
      }
      if (command.mode === 'run' && !ctx.facts().runAvailable)
      {
        ctx.announce(RUN_NOT_STARTED)
        return true
      }
      setMode(command.mode)
      return true
    }
    case 'inspector':
      return call(handlers.toggleInspector)
    case 'shortcuts':
      return call(handlers.openShortcuts)
    case 'region':
      (handlers.focusRegion ?? focusNextRegion)(command.direction)
      return true
    case 'attention':
      return call(handlers.focusAttention === undefined ? undefined : () => handlers.focusAttention?.(command.direction))
    case 'undo':
      return call(handlers.undo)
    case 'redo':
      return call(handlers.redo)
    case 'history-back':
      return ctx.facts().historyBatchOpen ? call(handlers.historyBack) : false
    case 'escape':
      if (command.from === 'inspector')
      {
        return call(handlers.returnToRow)
      }
      return command.from === 'table' && handlers.clearSelection !== undefined ? handlers.clearSelection() : false
    default:
      return false
  }
}

/**
 * The visible-view guard: true only while the shell shows `view` and its root is in the document and not
 * hidden, so a view the shell keeps mounted never acts on keys meant for another.
 */
export function isViewActive(view: View, root: HTMLElement | null): root is HTMLElement
{
  return useAppStore.getState().currentView === view && isShown(root)
}

/** Where a key event's target sits inside the Batch view. */
export function keyPlace(target: EventTarget | null, root: HTMLElement): KeyPlace
{
  const element = target instanceof Element ? target : null
  const inRoot = element !== null && root.contains(element)
  return {
    inTable: inRoot && element.closest('[role="grid"]') !== null,
    inControl: keyBelongsToControl(element),
    inInspector: inRoot && element.closest('[data-region="inspector"]') !== null
  }
}

function inView(target: EventTarget | null, root: HTMLElement): boolean
{
  const doc = root.ownerDocument
  return target === null || target === doc || target === doc.body || target === doc.documentElement || (target instanceof Node && root.contains(target))
}

/** A popup trigger in the view that reports its menu or popover open (a combobox keeps its own Escape). */
export function openPopupTrigger(root: HTMLElement): HTMLElement | null
{
  return root.querySelector<HTMLElement>('[aria-haspopup][aria-expanded="true"]:not([role="combobox"])')
}

/** Options for {@link useBatchKeys}. */
export interface BatchKeysOptions
{
  rootRef: RefObject<HTMLElement | null>
  platform: Platform
  handlers: BatchKeyHandlers
  facts: () => BatchKeyFacts
  announce: Announce
  /** The shell view the keys belong to. */
  view?: View
}

/**
 * Binds the Batch view's keyboard map. Every key acts only while the view is visible. View chords act
 * from anywhere in the view, after the table and controls had their turn, so a key they prevented is left alone;
 * F6 cycles regions from anywhere while the view shows. Escape closes the innermost thing first: a visible tooltip
 * consumes it itself, then an open menu or popover closes, then an inline confirmation chooses its safe action, and
 * only then does the table clear its selection or the inspector return focus to the row.
 */
export function useBatchKeys(options: BatchKeysOptions): void
{
  const latest = useRef(options)
  latest.current = options
  const busy = useRef(false)
  const { rootRef } = options
  const view = options.view ?? 'batch'
  useEffect(() =>
  {
    const root = rootRef.current
    if (root === null)
    {
      return undefined
    }
    const doc = root.ownerDocument
    const win = doc.defaultView
    const onEscapeCapture = (event: KeyboardEvent): void =>
    {
      if (event.key !== 'Escape' || event.defaultPrevented || !isViewActive(view, root) || keyBelongsToControl(event.target))
      {
        return
      }
      const trigger = openPopupTrigger(root)
      if (trigger !== null)
      {
        event.preventDefault()
        event.stopPropagation()
        trigger.click()
        return
      }
      if (latest.current.handlers.resolveConfirmation?.() === true)
      {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const onKeyDown = (event: KeyboardEvent): void =>
    {
      if (event.defaultPrevented || event.isComposing || !isViewActive(view, root))
      {
        return
      }
      const { platform, handlers, facts, announce } = latest.current
      const command = readBatchKey(event, keyPlace(event.target, root), platform === 'darwin')
      if (command === null || (command.kind !== 'region' && !inView(event.target, root)))
      {
        return
      }
      if (runBatchKey(command, { handlers, facts, announce, busy }))
      {
        event.preventDefault()
      }
    }
    root.addEventListener('keydown', onEscapeCapture, true)
    win?.addEventListener('keydown', onKeyDown)
    return () =>
    {
      root.removeEventListener('keydown', onEscapeCapture, true)
      win?.removeEventListener('keydown', onKeyDown)
    }
  }, [rootRef, view])
}
