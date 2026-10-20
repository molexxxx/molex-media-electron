import React, { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyChord } from '../../../src/renderer/src/components/batch/table/tableCommands'
import {
  fixFirst,
  isViewActive,
  keyPlace,
  MODE_KEYS,
  NOTHING_TO_START,
  openPopupTrigger,
  PAUSABLE,
  pausePress,
  readBatchKey,
  RUN_NOT_STARTED,
  runBatchKey,
  runBrass,
  useBatchKeys,
  type BatchKeyCommand,
  type BatchKeyContext,
  type BatchKeyFacts,
  type BatchKeyHandlers,
  type KeyPlace
} from '../../../src/renderer/src/components/batch/page/useBatchKeys'
import {
  resolveShortcut,
  SHORTCUT_GROUPS,
  SHORTCUTS_LABEL,
  shortcutText,
  ShortcutsPopover
} from '../../../src/renderer/src/components/batch/page/ShortcutsPopover'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { createDraftCommitters, type DraftCommit } from '../../../src/renderer/src/stores/batchActions'
import type { Platform } from '../../../src/shared/text/platform'

const TABLE: KeyPlace = { inTable: true, inControl: false, inInspector: false }
const FIELD: KeyPlace = { inTable: false, inControl: true, inInspector: false }
const VIEW: KeyPlace = { inTable: false, inControl: false, inInspector: false }
const INSPECTOR: KeyPlace = { inTable: false, inControl: false, inInspector: true }

function chord(key: string, over: Partial<KeyChord> = {}): KeyChord
{
  return { key, code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over }
}

function ctrl(key: string, over: Partial<KeyChord> = {}): KeyChord
{
  return chord(key, { ctrlKey: true, ...over })
}

const RUNNING: BatchKeyFacts = { mode: 'run', runStatus: 'running', runLabel: 'Batch 31', runningCount: 3, runAvailable: true, historyBatchOpen: false }
const IDLE: BatchKeyFacts = { mode: 'queue', runStatus: 'idle', runLabel: 'Batch', runningCount: 0, runAvailable: false, historyBatchOpen: false }

function context(handlers: BatchKeyHandlers, facts: BatchKeyFacts = IDLE): BatchKeyContext & { announce: ReturnType<typeof vi.fn> }
{
  return { handlers, facts: () => facts, announce: vi.fn(), busy: { current: false } }
}

async function settle(): Promise<void>
{
  await act(async () =>
  {
    for (let index = 0; index < 6; index += 1)
    {
      await Promise.resolve()
    }
  })
}

afterEach(() =>
{
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('readBatchKey', () =>
{
  const views: Array<[string, KeyChord, BatchKeyCommand]> = [
    ['Ctrl+Enter', ctrl('Enter'), { kind: 'brass' }],
    ['Ctrl+Shift+Enter', ctrl('Enter', { shiftKey: true }), { kind: 'start-selected' }],
    ['Ctrl+P', ctrl('p'), { kind: 'pause' }],
    ['Ctrl+K', ctrl('k'), { kind: 'picker' }],
    ['Ctrl+O', ctrl('o'), { kind: 'add-files' }],
    ['Ctrl+Shift+O', ctrl('O', { shiftKey: true }), { kind: 'add-folder' }],
    ['Ctrl+F', ctrl('f'), { kind: 'search' }],
    ['Ctrl+1', ctrl('1', { code: 'Digit1' }), { kind: 'mode', mode: 'queue' }],
    ['Ctrl+2', ctrl('2', { code: 'Digit2' }), { kind: 'mode', mode: 'review' }],
    ['Ctrl+3', ctrl('3', { code: 'Digit3' }), { kind: 'mode', mode: 'run' }],
    ['Ctrl+4 on the keypad', ctrl('4', { code: 'Numpad4' }), { kind: 'mode', mode: 'history' }],
    ['Ctrl+I', ctrl('I'), { kind: 'inspector' }],
    ['Ctrl+/', ctrl('/'), { kind: 'shortcuts' }],
    ['Ctrl+/ by key position', ctrl('-', { code: 'Slash' }), { kind: 'shortcuts' }],
    ['F1', chord('F1'), { kind: 'shortcuts' }],
    ['F6', chord('F6'), { kind: 'region', direction: 'next' }],
    ['Shift+F6', chord('F6', { shiftKey: true }), { kind: 'region', direction: 'previous' }],
    ['F8', chord('F8'), { kind: 'attention', direction: 'next' }],
    ['Shift+F8', chord('F8', { shiftKey: true }), { kind: 'attention', direction: 'previous' }]
  ]

  it.each(views)('reads %s from a text field as a view chord', (_name, keys, expected) =>
  {
    expect(readBatchKey(keys, FIELD)).toEqual(expected)
    expect(readBatchKey(keys, TABLE)).toEqual(expected)
  })

  it('reads a digit without a key position by its character', () =>
  {
    expect(readBatchKey(ctrl('2'), VIEW)).toEqual({ kind: 'mode', mode: 'review' })
    expect(readBatchKey(ctrl('5', { code: 'Digit5' }), VIEW)).toBeNull()
    expect(MODE_KEYS).toEqual(['queue', 'review', 'run', 'history'])
  })

  it('reads undo and redo outside controls only', () =>
  {
    expect(readBatchKey(ctrl('z'), TABLE)).toEqual({ kind: 'undo' })
    expect(readBatchKey(ctrl('Z', { shiftKey: true }), TABLE)).toEqual({ kind: 'redo' })
    expect(readBatchKey(ctrl('y'), VIEW)).toEqual({ kind: 'redo' })
    expect(readBatchKey(ctrl('z'), FIELD)).toBeNull()
    expect(readBatchKey(ctrl('Z', { shiftKey: true }), FIELD)).toBeNull()
    expect(readBatchKey(ctrl('y'), FIELD)).toBeNull()
  })

  it('leaves the editing chords and table keys to the table and controls', () =>
  {
    for (const key of ['a', 'c', 'v', 'd', ' '])
    {
      expect(readBatchKey(ctrl(key), TABLE)).toBeNull()
    }
    for (const key of ['Delete', 'Home', 'End', ' ', 'ArrowDown', 'Enter', 'a'])
    {
      expect(readBatchKey(chord(key), TABLE)).toBeNull()
      expect(readBatchKey(chord(key), FIELD)).toBeNull()
    }
  })

  it('never binds Ctrl+R or Ctrl+Minus', () =>
  {
    expect(readBatchKey(ctrl('r'), VIEW)).toBeNull()
    expect(readBatchKey(ctrl('-', { code: 'Minus' }), VIEW)).toBeNull()
    expect(readBatchKey(ctrl('R', { shiftKey: true }), VIEW)).toBeNull()
  })

  it('leaves Alt chords to the table and the shell', () =>
  {
    expect(readBatchKey(chord('1', { altKey: true, code: 'Digit1' }), TABLE)).toBeNull()
    expect(readBatchKey(chord('ArrowLeft', { altKey: true }), VIEW)).toBeNull()
    expect(readBatchKey(ctrl('Enter', { altKey: true }), VIEW)).toBeNull()
  })

  it('reads "?" only from the table', () =>
  {
    expect(readBatchKey(chord('?', { shiftKey: true }), TABLE)).toEqual({ kind: 'shortcuts' })
    expect(readBatchKey(chord('?', { shiftKey: true }), VIEW)).toBeNull()
    expect(readBatchKey(chord('?', { shiftKey: true }), FIELD)).toBeNull()
    expect(readBatchKey(chord('F1', { shiftKey: true }), VIEW)).toBeNull()
  })

  it('reads Escape by where it landed and leaves it to controls', () =>
  {
    expect(readBatchKey(chord('Escape'), TABLE)).toEqual({ kind: 'escape', from: 'table' })
    expect(readBatchKey(chord('Escape'), INSPECTOR)).toEqual({ kind: 'escape', from: 'inspector' })
    expect(readBatchKey(chord('Escape'), VIEW)).toEqual({ kind: 'escape', from: 'view' })
    expect(readBatchKey(chord('Escape'), FIELD)).toBeNull()
    expect(readBatchKey(chord('Escape', { shiftKey: true }), TABLE)).toBeNull()
  })

  it('reads Backspace outside text fields as back to the History list', () =>
  {
    expect(readBatchKey(chord('Backspace'), VIEW)).toEqual({ kind: 'history-back' })
    expect(readBatchKey(chord('Backspace'), FIELD)).toBeNull()
    expect(readBatchKey(chord('Backspace', { shiftKey: true }), VIEW)).toBeNull()
  })

  it('reads Cmd on macOS and never Ctrl+Y there', () =>
  {
    const cmd = (key: string, over: Partial<KeyChord> = {}): KeyChord => chord(key, { metaKey: true, ...over })
    expect(readBatchKey(cmd('Enter'), FIELD, true)).toEqual({ kind: 'brass' })
    expect(readBatchKey(cmd('p'), VIEW, true)).toEqual({ kind: 'pause' })
    expect(readBatchKey(cmd('Z', { shiftKey: true }), VIEW, true)).toEqual({ kind: 'redo' })
    expect(readBatchKey(cmd('y'), VIEW, true)).toBeNull()
    expect(readBatchKey(ctrl('Enter'), VIEW, true)).toBeNull()
    expect(readBatchKey(cmd('Enter'), VIEW)).toBeNull()
  })
})

describe('pausePress', () =>
{
  it('says what a press does in each run state', () =>
  {
    expect(pausePress(RUNNING)).toBe('Pausing Batch 31. 3 running jobs finish first.')
    expect(pausePress({ ...RUNNING, runningCount: 1 })).toBe('Pausing Batch 31. 1 running job finishes first.')
    expect(pausePress({ ...RUNNING, runningCount: 0 })).toBe('Pausing Batch 31.')
    expect(pausePress({ ...RUNNING, runStatus: 'paused' })).toBe('Batch 31 resumed.')
    expect(pausePress({ ...RUNNING, runStatus: 'pausing' })).toBe('Batch 31 resumed.')
    expect([...PAUSABLE].sort()).toEqual(['paused', 'pausing', 'running'])
    expect(fixFirst('Target, integrated')).toBe('Fix Target, integrated first.')
  })
})

describe('runBatchKey', () =>
{
  it('declines every command without a handler', () =>
  {
    const ctx = context({})
    const commands: BatchKeyCommand[] = [
      { kind: 'brass' },
      { kind: 'start-selected' },
      { kind: 'pause' },
      { kind: 'picker' },
      { kind: 'add-files' },
      { kind: 'add-folder' },
      { kind: 'search' },
      { kind: 'mode', mode: 'queue' },
      { kind: 'inspector' },
      { kind: 'shortcuts' },
      { kind: 'attention', direction: 'next' },
      { kind: 'undo' },
      { kind: 'redo' },
      { kind: 'history-back' },
      { kind: 'escape', from: 'table' },
      { kind: 'escape', from: 'inspector' },
      { kind: 'escape', from: 'view' },
      { kind: 'unknown' } as unknown as BatchKeyCommand
    ]
    for (const command of commands)
    {
      expect(runBatchKey(command, ctx)).toBe(false)
    }
  })

  it('calls the handler of each simple command', () =>
  {
    const handlers = {
      addFiles: vi.fn(),
      addFolder: vi.fn(),
      focusSearch: vi.fn(),
      toggleInspector: vi.fn(),
      openShortcuts: vi.fn(),
      focusAttention: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      openPicker: vi.fn(),
      focusRegion: vi.fn()
    }
    const ctx = context(handlers)
    expect(runBatchKey({ kind: 'add-files' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'add-folder' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'search' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'inspector' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'shortcuts' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'attention', direction: 'previous' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'undo' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'redo' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'picker' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'region', direction: 'previous' }, ctx)).toBe(true)
    for (const handler of Object.values(handlers))
    {
      expect(handler).toHaveBeenCalledTimes(1)
    }
    expect(handlers.focusAttention).toHaveBeenCalledWith('previous')
    expect(handlers.focusRegion).toHaveBeenCalledWith('previous')
  })

  it('cycles regions through the shell registry when the page gives no handler', () =>
  {
    expect(runBatchKey({ kind: 'region', direction: 'next' }, context({}))).toBe(true)
  })

  it('opens the operation picker in Queue and Review only', () =>
  {
    const openPicker = vi.fn()
    expect(runBatchKey({ kind: 'picker' }, context({ openPicker }, { ...IDLE, mode: 'review' }))).toBe(true)
    expect(runBatchKey({ kind: 'picker' }, context({ openPicker }, RUNNING))).toBe(false)
    expect(runBatchKey({ kind: 'picker' }, context({ openPicker }, { ...IDLE, mode: 'history' }))).toBe(false)
    expect(openPicker).toHaveBeenCalledTimes(1)
  })

  it('switches modes and announces Run before the first batch without switching', () =>
  {
    const setMode = vi.fn()
    const ctx = context({ setMode })
    expect(runBatchKey({ kind: 'mode', mode: 'run' }, ctx)).toBe(true)
    expect(setMode).not.toHaveBeenCalled()
    expect(ctx.announce).toHaveBeenCalledWith(RUN_NOT_STARTED)
    expect(runBatchKey({ kind: 'mode', mode: 'history' }, ctx)).toBe(true)
    expect(setMode).toHaveBeenCalledWith('history')
    const later = context({ setMode }, RUNNING)
    expect(runBatchKey({ kind: 'mode', mode: 'run' }, later)).toBe(true)
    expect(setMode).toHaveBeenLastCalledWith('run')
    expect(later.announce).not.toHaveBeenCalled()
  })

  it('pauses and resumes only while a batch runs, pauses, or is paused, announcing each press', () =>
  {
    const togglePause = vi.fn()
    const running = context({ togglePause }, RUNNING)
    expect(runBatchKey({ kind: 'pause' }, running)).toBe(true)
    expect(togglePause).toHaveBeenLastCalledWith('pause')
    expect(running.announce).toHaveBeenCalledWith('Pausing Batch 31. 3 running jobs finish first.')
    const paused = context({ togglePause }, { ...RUNNING, runStatus: 'paused' })
    expect(runBatchKey({ kind: 'pause' }, paused)).toBe(true)
    expect(togglePause).toHaveBeenLastCalledWith('resume')
    expect(paused.announce).toHaveBeenCalledWith('Batch 31 resumed.')
    expect(runBatchKey({ kind: 'pause' }, context({ togglePause }, IDLE))).toBe(false)
    expect(runBatchKey({ kind: 'pause' }, context({ togglePause }, { ...RUNNING, runStatus: 'canceling' }))).toBe(false)
    expect(togglePause).toHaveBeenCalledTimes(2)
  })

  it('goes back to the History list only from an opened batch', () =>
  {
    const historyBack = vi.fn()
    expect(runBatchKey({ kind: 'history-back' }, context({ historyBack }))).toBe(false)
    expect(runBatchKey({ kind: 'history-back' }, context({ historyBack }, { ...IDLE, mode: 'history', historyBatchOpen: true }))).toBe(true)
    expect(historyBack).toHaveBeenCalledTimes(1)
  })

  it('clears the selection from the table and returns to the row from the inspector', () =>
  {
    const clearSelection = vi.fn(() => true)
    const returnToRow = vi.fn()
    const ctx = context({ clearSelection, returnToRow })
    expect(runBatchKey({ kind: 'escape', from: 'table' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'escape', from: 'inspector' }, ctx)).toBe(true)
    expect(runBatchKey({ kind: 'escape', from: 'view' }, ctx)).toBe(false)
    expect(clearSelection).toHaveBeenCalledTimes(1)
    expect(returnToRow).toHaveBeenCalledTimes(1)
    expect(runBatchKey({ kind: 'escape', from: 'table' }, context({ clearSelection: () => false }))).toBe(false)
  })

  it('starts only the selected jobs in Review, after committing the draft', async () =>
  {
    const startSelected = vi.fn()
    const commitDraft = vi.fn((): DraftCommit => ({ status: 'none' }))
    expect(runBatchKey({ kind: 'start-selected' }, context({ startSelected, commitDraft }, { ...IDLE, mode: 'queue' }))).toBe(false)
    expect(runBatchKey({ kind: 'start-selected' }, context({ startSelected, commitDraft }, { ...IDLE, mode: 'review' }))).toBe(true)
    await settle()
    expect(commitDraft).toHaveBeenCalledTimes(1)
    expect(startSelected).toHaveBeenCalledTimes(1)
  })
})

describe('runBrass', () =>
{
  it('performs the brass action of the moment', async () =>
  {
    const perform = vi.fn()
    const ctx = context({})
    await runBrass(ctx, () => ({ kind: 'ready', perform }))
    expect(perform).toHaveBeenCalledTimes(1)
    expect(ctx.busy.current).toBe(false)
  })

  it('announces "Nothing to start." without a brass action', async () =>
  {
    const ctx = context({})
    await runBrass(ctx, () => ({ kind: 'none' }))
    expect(ctx.announce).toHaveBeenCalledWith(NOTHING_TO_START)
  })

  it('focuses the acknowledgment and says why when it gates Start', async () =>
  {
    const ctx = context({})
    await runBrass(ctx, () => ({ kind: 'gated', focusAcknowledgment: () => 'Confirm that 20 originals go to the Recycle Bin on D: first.' }))
    expect(ctx.announce).toHaveBeenCalledWith('Confirm that 20 originals go to the Recycle Bin on D: first.')
    const quiet = context({})
    await runBrass(quiet, () => ({ kind: 'gated', focusAcknowledgment: () => null }))
    expect(quiet.announce).not.toHaveBeenCalled()
  })

  it('refuses with "Fix {field} first." on an invalid draft and never reads the brass action', async () =>
  {
    const brass = vi.fn()
    const ctx = context({ commitDraft: () => ({ status: 'invalid', field: 'Target, integrated' }) })
    await runBrass(ctx, brass)
    expect(ctx.announce).toHaveBeenCalledWith('Fix Target, integrated first.')
    expect(brass).not.toHaveBeenCalled()
  })

  it('ignores a second press while the first commits and runs', async () =>
  {
    let release: (value: DraftCommit) => void = () => undefined
    const pending = new Promise<DraftCommit>((resolve) =>
    {
      release = resolve
    })
    const perform = vi.fn()
    const ctx = context({ commitDraft: () => pending })
    const first = runBrass(ctx, () => ({ kind: 'ready', perform }))
    await runBrass(ctx, () => ({ kind: 'ready', perform }))
    release({ status: 'committed', seq: 4 })
    await first
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('frees the key when the action throws', async () =>
  {
    const ctx = context({})
    await expect(runBrass(ctx, () => ({ kind: 'ready', perform: () => Promise.reject(new Error('refused')) }))).rejects.toThrow('refused')
    expect(ctx.busy.current).toBe(false)
  })
})

interface HarnessProps
{
  handlers: BatchKeyHandlers
  facts?: BatchKeyFacts
  announce?: (text: string) => void
  platform?: Platform
  hidden?: boolean
  menuOpen?: boolean
  onGridKey?: (event: React.KeyboardEvent<HTMLElement>) => void
}

/** A Batch view skeleton with a table, a toolbar of controls, an open menu and popover, and an inspector. */
function Harness({ handlers, facts = IDLE, announce = () => undefined, platform = 'win32', hidden = false, menuOpen = false, onGridKey }: HarnessProps): React.JSX.Element
{
  const rootRef = useRef<HTMLElement>(null)
  useBatchKeys({ rootRef, platform, handlers, facts: () => facts, announce })
  return (
    <section ref={rootRef} aria-label="Batch" style={hidden ? { display: 'none' } : undefined}>
      <div data-region="toolbar">
        <button>Add</button>
        <input type="search" aria-label="Search jobs" />
        <select aria-label="New files"><option>Normalize</option></select>
        <button aria-haspopup="menu" aria-expanded={menuOpen} onClick={handlers.openPicker}>More batch actions</button>
      </div>
      <div data-region="table">
        <div role="grid" aria-label="Jobs" tabIndex={0} onKeyDown={onGridKey}>
          <div role="row" tabIndex={-1}>01 Overture.flac</div>
        </div>
      </div>
      <div role="menu" aria-label="Row menu"><button role="menuitem">Duplicate</button></div>
      <div popover="auto" role="dialog" aria-label="Output"><button>Browse</button></div>
      <aside data-region="inspector">
        <button>Settings</button>
        <input aria-label="Target, integrated" />
      </aside>
    </section>
  )
}

function grid(): HTMLElement
{
  return screen.getByRole('grid', { name: 'Jobs' })
}

/** Dispatches a key and reports whether the page prevented it. */
function press(target: Element, key: string, over: Partial<KeyChord> & { isComposing?: boolean } = {}): boolean
{
  return !fireEvent.keyDown(target, { key, code: '', ...over })
}

describe('useBatchKeys', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  it('acts on view chords from anywhere in the view and prevents them', () =>
  {
    const handlers = { addFiles: vi.fn(), addFolder: vi.fn(), focusSearch: vi.fn(), toggleInspector: vi.fn(), openShortcuts: vi.fn() }
    render(<Harness handlers={handlers} />)
    const search = screen.getByRole('searchbox', { name: 'Search jobs' })
    expect(press(search, 'o', { ctrlKey: true })).toBe(true)
    expect(press(screen.getByRole('menuitem'), 'O', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(press(grid(), 'f', { ctrlKey: true })).toBe(true)
    expect(press(screen.getByRole('button', { name: 'Settings' }), 'i', { ctrlKey: true })).toBe(true)
    expect(press(screen.getByRole('combobox', { name: 'New files' }), 'F1')).toBe(true)
    expect(press(document.body, '/', { ctrlKey: true })).toBe(true)
    expect(handlers.addFiles).toHaveBeenCalledTimes(1)
    expect(handlers.addFolder).toHaveBeenCalledTimes(1)
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1)
    expect(handlers.toggleInspector).toHaveBeenCalledTimes(1)
    expect(handlers.openShortcuts).toHaveBeenCalledTimes(2)
  })

  it('leaves the editing keys to text fields, selects, menus, and popovers', () =>
  {
    const handlers = { undo: vi.fn(), redo: vi.fn(), clearSelection: vi.fn(() => true), historyBack: vi.fn(), openShortcuts: vi.fn() }
    render(<Harness handlers={handlers} facts={{ ...IDLE, mode: 'history', historyBatchOpen: true }} />)
    const targets = [
      screen.getByRole('searchbox', { name: 'Search jobs' }),
      screen.getByRole('textbox', { name: 'Target, integrated' }),
      screen.getByRole('combobox', { name: 'New files' }),
      screen.getByRole('menuitem'),
      screen.getByText('Browse')
    ]
    const keys: Array<[string, Partial<KeyChord>]> = [
      ['a', { ctrlKey: true }],
      ['c', { ctrlKey: true }],
      ['v', { ctrlKey: true }],
      ['z', { ctrlKey: true }],
      ['y', { ctrlKey: true }],
      ['Z', { ctrlKey: true, shiftKey: true }],
      ['Delete', {}],
      ['Home', {}],
      ['End', {}],
      ['Backspace', {}],
      ['Escape', {}],
      ['?', { shiftKey: true }],
      [' ', {}]
    ]
    for (const target of targets)
    {
      for (const [key, over] of keys)
      {
        expect(press(target, key, over), `${key} on ${target.getAttribute('aria-label') ?? target.textContent}`).toBe(false)
      }
    }
    for (const handler of Object.values(handlers))
    {
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it('acts on keys without a modifier only from the table', () =>
  {
    const handlers = { openShortcuts: vi.fn(), clearSelection: vi.fn(() => true) }
    render(<Harness handlers={handlers} />)
    expect(press(screen.getByRole('button', { name: 'Add' }), '?', { shiftKey: true })).toBe(false)
    expect(press(screen.getByRole('button', { name: 'Add' }), 'Escape')).toBe(false)
    expect(handlers.openShortcuts).not.toHaveBeenCalled()
    expect(press(grid(), '?', { shiftKey: true })).toBe(true)
    expect(press(screen.getByRole('row'), 'Escape')).toBe(true)
    expect(handlers.openShortcuts).toHaveBeenCalledTimes(1)
    expect(handlers.clearSelection).toHaveBeenCalledTimes(1)
  })

  it('undoes and redoes queue edits from the table', () =>
  {
    const handlers = { undo: vi.fn(), redo: vi.fn() }
    render(<Harness handlers={handlers} />)
    expect(press(grid(), 'z', { ctrlKey: true })).toBe(true)
    expect(press(grid(), 'y', { ctrlKey: true })).toBe(true)
    expect(press(grid(), 'Z', { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(handlers.undo).toHaveBeenCalledTimes(1)
    expect(handlers.redo).toHaveBeenCalledTimes(2)
  })

  it('leaves a key the table already handled', () =>
  {
    const handlers = { focusAttention: vi.fn() }
    render(<Harness handlers={handlers} onGridKey={(event) => event.key === 'F8' && event.preventDefault()} />)
    expect(press(grid(), 'F8')).toBe(true)
    expect(handlers.focusAttention).not.toHaveBeenCalled()
    expect(press(screen.getByRole('button', { name: 'Add' }), 'F8', { shiftKey: true })).toBe(true)
    expect(handlers.focusAttention).toHaveBeenCalledWith('previous')
  })

  it('ignores keys from outside the view except F6', () =>
  {
    const handlers = { addFiles: vi.fn(), focusRegion: vi.fn() }
    render(
      <>
        <nav><button>Dashboard</button></nav>
        <Harness handlers={handlers} />
      </>
    )
    const rail = screen.getByRole('button', { name: 'Dashboard' })
    expect(press(rail, 'o', { ctrlKey: true })).toBe(false)
    expect(press(rail, 'F6')).toBe(true)
    expect(handlers.addFiles).not.toHaveBeenCalled()
    expect(handlers.focusRegion).toHaveBeenCalledWith('next')
  })

  it('reads Cmd on macOS', () =>
  {
    const handlers = { addFiles: vi.fn() }
    render(<Harness handlers={handlers} platform="darwin" />)
    expect(press(grid(), 'o', { ctrlKey: true })).toBe(false)
    expect(press(grid(), 'o', { metaKey: true })).toBe(true)
    expect(handlers.addFiles).toHaveBeenCalledTimes(1)
  })

  it('ignores keys while an input method composes', () =>
  {
    const handlers = { addFiles: vi.fn() }
    render(<Harness handlers={handlers} />)
    expect(press(grid(), 'o', { ctrlKey: true, isComposing: true })).toBe(false)
    expect(handlers.addFiles).not.toHaveBeenCalled()
  })

  it('pauses and resumes with Ctrl+P while a batch runs and announces each press', () =>
  {
    const announce = vi.fn()
    const togglePause = vi.fn()
    const { rerender } = render(<Harness handlers={{ togglePause }} facts={RUNNING} announce={announce} />)
    expect(press(grid(), 'p', { ctrlKey: true })).toBe(true)
    rerender(<Harness handlers={{ togglePause }} facts={{ ...RUNNING, runStatus: 'paused' }} announce={announce} />)
    expect(press(grid(), 'p', { ctrlKey: true })).toBe(true)
    expect(togglePause.mock.calls).toEqual([['pause'], ['resume']])
    expect(announce.mock.calls).toEqual([['Pausing Batch 31. 3 running jobs finish first.'], ['Batch 31 resumed.']])
    rerender(<Harness handlers={{ togglePause }} facts={IDLE} announce={announce} />)
    expect(press(grid(), 'p', { ctrlKey: true })).toBe(false)
  })

  it('announces Run before the first batch without moving focus', () =>
  {
    const announce = vi.fn()
    const setMode = vi.fn()
    render(<Harness handlers={{ setMode }} announce={announce} />)
    const row = screen.getByRole('row')
    row.focus()
    expect(press(row, '3', { ctrlKey: true, code: 'Digit3' })).toBe(true)
    expect(announce).toHaveBeenCalledWith(RUN_NOT_STARTED)
    expect(setMode).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(row)
    expect(press(row, '4', { ctrlKey: true, code: 'Digit4' })).toBe(true)
    expect(setMode).toHaveBeenCalledWith('history')
  })

  describe('the visible-view guard', () =>
  {
    it('acts on nothing while another view shows', () =>
    {
      useAppStore.setState({ currentView: 'editor' })
      const handlers = { brass: vi.fn(), togglePause: vi.fn(), undo: vi.fn(), addFiles: vi.fn(), openShortcuts: vi.fn(), focusRegion: vi.fn(), clearSelection: vi.fn(() => true) }
      render(<Harness handlers={handlers} facts={RUNNING} />)
      for (const target of [grid(), document.body])
      {
        expect(press(target, 'Enter', { ctrlKey: true })).toBe(false)
        expect(press(target, 'p', { ctrlKey: true })).toBe(false)
        expect(press(target, 'z', { ctrlKey: true })).toBe(false)
        expect(press(target, 'o', { ctrlKey: true })).toBe(false)
        expect(press(target, 'F1')).toBe(false)
        expect(press(target, 'F6')).toBe(false)
        expect(press(target, 'Escape')).toBe(false)
      }
      for (const handler of Object.values(handlers))
      {
        expect(handler).not.toHaveBeenCalled()
      }
    })

    it('acts on nothing while the view root is hidden', () =>
    {
      const handlers = { addFiles: vi.fn(), resolveConfirmation: vi.fn(() => true) }
      render(<Harness handlers={handlers} hidden />)
      const hiddenGrid = screen.getByRole('grid', { name: 'Jobs', hidden: true })
      expect(press(hiddenGrid, 'o', { ctrlKey: true })).toBe(false)
      expect(press(hiddenGrid, 'Escape')).toBe(false)
      expect(handlers.addFiles).not.toHaveBeenCalled()
      expect(handlers.resolveConfirmation).not.toHaveBeenCalled()
    })

    it('reads the guard and the key place directly', () =>
    {
      render(<Harness handlers={{}} />)
      const root = screen.getByRole('region', { name: 'Batch' })
      expect(isViewActive('batch', root)).toBe(true)
      expect(isViewActive('editor', root)).toBe(false)
      expect(isViewActive('batch', null)).toBe(false)
      expect(keyPlace(screen.getByRole('row'), root)).toEqual({ inTable: true, inControl: false, inInspector: false })
      expect(keyPlace(screen.getByRole('textbox', { name: 'Target, integrated' }), root)).toEqual({ inTable: false, inControl: true, inInspector: true })
      expect(keyPlace(document.body, root)).toEqual({ inTable: false, inControl: false, inInspector: false })
      expect(keyPlace(null, root)).toEqual({ inTable: false, inControl: false, inInspector: false })
    })
  })

  describe('Escape order', () =>
  {
    it('lets a visible tooltip consume Escape before anything else', () =>
    {
      const handlers = { resolveConfirmation: vi.fn(() => true), clearSelection: vi.fn(() => true) }
      const tooltip = (event: KeyboardEvent): void =>
      {
        if (event.key === 'Escape')
        {
          event.preventDefault()
          event.stopPropagation()
        }
      }
      document.addEventListener('keydown', tooltip, true)
      try
      {
        render(<Harness handlers={handlers} menuOpen />)
        expect(press(screen.getByRole('row'), 'Escape')).toBe(true)
        expect(handlers.resolveConfirmation).not.toHaveBeenCalled()
        expect(handlers.clearSelection).not.toHaveBeenCalled()
      }
      finally
      {
        document.removeEventListener('keydown', tooltip, true)
      }
    })

    it('closes an open menu or popover before a confirmation or the selection', () =>
    {
      const openPicker = vi.fn()
      const handlers = { openPicker, resolveConfirmation: vi.fn(() => true), clearSelection: vi.fn(() => true) }
      render(<Harness handlers={handlers} menuOpen />)
      expect(openPopupTrigger(screen.getByRole('region', { name: 'Batch' }))?.textContent).toBe('More batch actions')
      expect(press(screen.getByRole('row'), 'Escape')).toBe(true)
      expect(openPicker).toHaveBeenCalledTimes(1)
      expect(handlers.resolveConfirmation).not.toHaveBeenCalled()
      expect(handlers.clearSelection).not.toHaveBeenCalled()
    })

    it('chooses a confirmation\'s safe action before the table sees Escape, so the selection stays', () =>
    {
      const gridEscape = vi.fn()
      let pending = true
      const handlers = {
        resolveConfirmation: vi.fn(() =>
        {
          const was = pending
          pending = false
          return was
        }),
        clearSelection: vi.fn(() => true)
      }
      render(<Harness handlers={handlers} onGridKey={(event) => event.key === 'Escape' && gridEscape()} />)
      expect(press(screen.getByRole('row'), 'Escape')).toBe(true)
      expect(gridEscape).not.toHaveBeenCalled()
      expect(handlers.clearSelection).not.toHaveBeenCalled()
      expect(press(screen.getByRole('row'), 'Escape')).toBe(true)
      expect(gridEscape).toHaveBeenCalledTimes(1)
      expect(handlers.clearSelection).toHaveBeenCalledTimes(1)
    })

    it('returns from the inspector to the row', () =>
    {
      const handlers = { returnToRow: vi.fn(), clearSelection: vi.fn(() => true) }
      render(<Harness handlers={handlers} />)
      expect(press(screen.getByRole('button', { name: 'Settings' }), 'Escape')).toBe(true)
      expect(handlers.returnToRow).toHaveBeenCalledTimes(1)
      expect(handlers.clearSelection).not.toHaveBeenCalled()
    })
  })
})

interface BrassPageProps
{
  start: () => Promise<void>
  apply: (value: number) => Promise<number>
  announce: (text: string) => void
  gated?: boolean
  nothing?: boolean
}

/**
 * A Review moment: a Target field whose draft commits through the same path as blur, a summary the user hid with
 * the acknowledgment inside it, and Start as the brass action.
 */
function BrassPage({ start, apply, announce, gated = false, nothing = false }: BrassPageProps): React.JSX.Element
{
  const rootRef = useRef<HTMLElement>(null)
  const [drafts] = useState(() => createDraftCommitters())
  const [draft, setDraft] = useState('-16')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const commit = async (): Promise<DraftCommit> =>
  {
    const value = Number(draftRef.current)
    if (!Number.isFinite(value) || value > -5 || value < -70)
    {
      setError('Enter a target from -70 to -5 LUFS.')
      return { status: 'invalid', field: 'Target, integrated' }
    }
    setError(null)
    const seq = await apply(value)
    return { status: 'committed', seq, field: 'Target, integrated' }
  }
  useBatchKeys({
    rootRef,
    platform: 'win32',
    announce,
    facts: () => ({ ...IDLE, mode: 'review' }),
    handlers: {
      commitDraft: () => drafts.commit(),
      brass: () =>
      {
        if (nothing)
        {
          return { kind: 'none' }
        }
        if (gated)
        {
          return {
            kind: 'gated',
            focusAcknowledgment: () =>
            {
              flushSync(() => setExpanded(true))
              document.getElementById('ack')?.focus()
              return 'Confirm that 20 originals go to the Recycle Bin on D: first.'
            }
          }
        }
        return { kind: 'ready', perform: start }
      }
    }
  })
  return (
    <section ref={rootRef} aria-label="Batch">
      <div data-region="summary">
        <p>Review: 21 jobs ready.</p>
        {expanded && <label><input id="ack" type="checkbox" /> Send 20 originals to the Recycle Bin on D:</label>}
      </div>
      <div role="grid" aria-label="Jobs" tabIndex={0} />
      <aside data-region="inspector">
        <input
          aria-label="Target, integrated"
          aria-invalid={error !== null}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => drafts.register(commit)}
          onBlur={() => void drafts.commit()}
        />
        {error !== null && <p role="alert">{error}</p>}
      </aside>
    </section>
  )
}

describe('Ctrl+Enter', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  it('sends no Start until main has applied the focused draft', async () =>
  {
    let applied: (seq: number) => void = () => undefined
    const apply = vi.fn((_value: number) => new Promise<number>((resolve) =>
    {
      applied = resolve
    }))
    const start = vi.fn(async () => undefined)
    const announce = vi.fn()
    render(<BrassPage start={start} apply={apply} announce={announce} />)
    const field = screen.getByRole('textbox', { name: 'Target, integrated' })
    field.focus()
    fireEvent.change(field, { target: { value: '-18' } })
    expect(press(field, 'Enter', { ctrlKey: true })).toBe(true)
    await settle()
    expect(apply).toHaveBeenCalledWith(-18)
    expect(start).not.toHaveBeenCalled()
    await act(async () =>
    {
      applied(12)
    })
    await settle()
    expect(start).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(field)
    expect(announce).not.toHaveBeenCalled()
  })

  it('refuses an invalid draft, keeps focus in the field, and names it', async () =>
  {
    const apply = vi.fn(async () => 1)
    const start = vi.fn(async () => undefined)
    const announce = vi.fn()
    render(<BrassPage start={start} apply={apply} announce={announce} />)
    const field = screen.getByRole('textbox', { name: 'Target, integrated' })
    field.focus()
    fireEvent.change(field, { target: { value: '-2' } })
    expect(press(field, 'Enter', { ctrlKey: true })).toBe(true)
    await settle()
    expect(announce).toHaveBeenCalledWith('Fix Target, integrated first.')
    expect(start).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a target from -70 to -5 LUFS.')
  })

  it('expands a hidden summary, focuses the acknowledgment, and says why', async () =>
  {
    const start = vi.fn(async () => undefined)
    const announce = vi.fn()
    render(<BrassPage start={start} apply={async () => 1} announce={announce} gated />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(press(grid(), 'Enter', { ctrlKey: true })).toBe(true)
    await settle()
    expect(screen.getByRole('checkbox')).toHaveFocus()
    expect(announce).toHaveBeenCalledWith('Confirm that 20 originals go to the Recycle Bin on D: first.')
    expect(start).not.toHaveBeenCalled()
  })

  it('announces "Nothing to start." when no brass action exists', async () =>
  {
    const announce = vi.fn()
    render(<BrassPage start={vi.fn()} apply={async () => 1} announce={announce} nothing />)
    expect(press(grid(), 'Enter', { ctrlKey: true })).toBe(true)
    await settle()
    expect(announce).toHaveBeenCalledWith(NOTHING_TO_START)
  })
})

describe('shortcut list', () =>
{
  const entries = SHORTCUT_GROUPS.flatMap((group) => group.entries)
  const find = (label: string) => entries.find((entry) => entry.label === label) ?? entries[0]

  it('groups the keys by area', () =>
  {
    expect(SHORTCUT_GROUPS.map((group) => group.title)).toEqual(['Table', 'Jobs', 'Batch', 'View'])
    for (const group of SHORTCUT_GROUPS)
    {
      expect(group.entries.length).toBeGreaterThan(0)
    }
  })

  it('covers every view chord of the keyboard map', () =>
  {
    const windows = entries.map((entry) => shortcutText(entry, 'win32')).join(' | ')
    for (const keys of ['Ctrl+Enter', 'Ctrl+Shift+Enter', 'Ctrl+P', 'Ctrl+K', 'Ctrl+O', 'Ctrl+Shift+O', 'Ctrl+F', 'Ctrl+1 to Ctrl+4', 'Ctrl+I', 'Ctrl+/ or F1', 'F6 or Shift+F6', 'F8 or Shift+F8', 'Alt+1 to Alt+9', 'Alt+Shift+1 to Alt+Shift+9', 'Shift+Delete', 'Ctrl+Y or Ctrl+Shift+Z', 'Space or Ctrl+Space', 'Shift+F10 or Menu', 'Backspace', 'Alt+Left', '?'])
    {
      expect(windows).toContain(keys)
    }
    expect(windows).not.toContain('Ctrl+R')
    expect(windows).not.toContain('Ctrl+-')
  })

  it('writes the keys in macOS words', () =>
  {
    expect(shortcutText(find('Pause or resume'), 'darwin')).toBe('Cmd+P')
    expect(shortcutText(find('Apply pinned operation 1 to 9'), 'darwin')).toBe('Option+1 to Option+9')
    expect(shortcutText(find('Move to the top or bottom'), 'darwin')).toBe('Option+fn+Left or Option+fn+Right')
    expect(shortcutText(find('Cancel the selected running jobs'), 'darwin')).toBe('Cmd+Delete')
    expect(shortcutText(find('Redo'), 'darwin')).toBe('Cmd+Shift+Z')
    expect(shortcutText(find('Select or deselect the focused row'), 'darwin')).toBe('Space')
    expect(shortcutText(find('Row menu'), 'darwin')).toBe('Ctrl+click, or More actions')
    expect(shortcutText(find('Back to the History list'), 'darwin')).toBe('Delete')
    expect(shortcutText(find('Back to Batch from Logs'), 'darwin')).toBe('Cmd+[')
    expect(shortcutText(find('Keyboard shortcuts'), 'darwin')).toBe('?')
    expect(shortcutText(find('First or last row, Shift extends'), 'darwin')).toBe('fn+Left or fn+Right')
    expect(shortcutText(find('Next or previous region'), 'darwin')).toBe('fn+F6 or Shift+fn+F6')
    expect(shortcutText(find('Jump to a file by name'), 'win32')).toBe('Type a name')
    expect(resolveShortcut(find('Jump to a file by name'), 'linux')).toEqual({ label: 'Jump to a file by name', chords: [], joiner: 'or', text: 'Type a name' })
  })

  it('writes Linux keys in Windows words', () =>
  {
    expect(shortcutText(find('Pause or resume'), 'linux')).toBe('Ctrl+P')
    expect(shortcutText(find('Redo'), 'linux')).toBe('Ctrl+Y or Ctrl+Shift+Z')
  })
})

/** The page's popover wiring: the hook opens it, Close and Escape shut it. */
function ShortcutsPage({ platform = 'win32', fallback }: { platform?: Platform, fallback?: () => HTMLElement | null }): React.JSX.Element
{
  const rootRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [menuItem, setMenuItem] = useState(true)
  const clearSelection = useRef(vi.fn(() => true))
  useBatchKeys({
    rootRef,
    platform,
    announce: () => undefined,
    facts: () => IDLE,
    handlers: { openShortcuts: () => setOpen(true), clearSelection: clearSelection.current }
  })
  return (
    <section ref={rootRef} aria-label="Batch">
      <div data-region="toolbar">
        <button>Add</button>
        {menuItem && <button onClick={() => { setMenuItem(false); setOpen(true) }}>{SHORTCUTS_LABEL}</button>}
      </div>
      <div role="grid" aria-label="Jobs" tabIndex={0} data-cleared={clearSelection.current.mock.calls.length} />
      <button>Outside</button>
      <ShortcutsPopover open={open} onClose={() => setOpen(false)} platform={platform} fallbackFocus={fallback} />
    </section>
  )
}

function dialog(): HTMLElement
{
  const element = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${SHORTCUTS_LABEL}"]`)
  if (element === null)
  {
    throw new Error('The shortcuts popover is not rendered.')
  }
  return element
}

describe('ShortcutsPopover', () =>
{
  beforeEach(() =>
  {
    useAppStore.setState({ currentView: 'batch' })
  })

  it('opens on Ctrl+/ and lists the keys by area in Windows words', () =>
  {
    render(<ShortcutsPage />)
    grid().focus()
    act(() =>
    {
      press(grid(), '/', { ctrlKey: true })
    })
    const popover = dialog()
    expect(popover).toHaveAttribute('data-open', 'true')
    expect(popover).toHaveFocus()
    const headings = within(popover).getAllByRole('heading', { level: 3, hidden: true })
    expect(headings.map((heading) => heading.textContent)).toEqual(['Table', 'Jobs', 'Batch', 'View'])
    expect(headings[0]).toHaveClass('type-legend', 'text-brass')
    expect(within(popover).getByRole('heading', { level: 2, hidden: true })).toHaveTextContent(SHORTCUTS_LABEL)
    const batch = popover.querySelector<HTMLElement>('[data-group="batch"]') as HTMLElement
    expect(within(batch).getByText('Pause or resume').nextElementSibling).toHaveTextContent('Ctrl+P')
    expect(within(batch).getByText('Review, Start, or the next action').nextElementSibling).toHaveTextContent('Ctrl+Enter')
    expect(within(popover).getAllByText('Ctrl').length).toBeGreaterThan(5)
    expect(within(popover).queryByText('Cmd')).toBeNull()
  })

  it('writes Cmd and Option on macOS', () =>
  {
    render(<ShortcutsPage platform="darwin" />)
    act(() =>
    {
      press(grid(), 'F1')
    })
    const popover = dialog()
    expect(within(popover).getAllByText('Cmd').length).toBeGreaterThan(5)
    expect(within(popover).getAllByText('Option').length).toBeGreaterThan(2)
    expect(within(popover).queryByText('Ctrl')).toBeNull()
    expect(within(popover).getByText('Ctrl+click, or More actions')).toBeInTheDocument()
  })

  it('opens on F1 and on "?" from the table, but not on "?" elsewhere', () =>
  {
    render(<ShortcutsPage />)
    act(() =>
    {
      press(screen.getByRole('button', { name: 'Add' }), '?', { shiftKey: true })
    })
    expect(dialog()).not.toHaveAttribute('data-open')
    act(() =>
    {
      press(grid(), '?', { shiftKey: true })
    })
    expect(dialog()).toHaveAttribute('data-open', 'true')
  })

  it('closes on Escape, returns focus to the table, and keeps the selection', () =>
  {
    render(<ShortcutsPage />)
    grid().focus()
    act(() =>
    {
      press(grid(), 'F1')
    })
    expect(dialog()).toHaveFocus()
    act(() =>
    {
      press(dialog(), 'Escape')
    })
    expect(dialog()).not.toHaveAttribute('data-open')
    expect(grid()).toHaveFocus()
    expect(grid()).toHaveAttribute('data-cleared', '0')
  })

  it('closes from its Close button and returns focus to the opener', () =>
  {
    render(<ShortcutsPage />)
    const add = screen.getByRole('button', { name: 'Add' })
    add.focus()
    act(() =>
    {
      press(add, 'F1')
    })
    fireEvent.click(within(dialog()).getByLabelText('Close'))
    expect(dialog()).not.toHaveAttribute('data-open')
    expect(add).toHaveFocus()
  })

  it('sends focus to the fallback when the opener removed itself', () =>
  {
    render(<ShortcutsPage fallback={() => screen.getByRole('button', { name: 'Add' })} />)
    const item = screen.getByRole('button', { name: SHORTCUTS_LABEL })
    item.focus()
    fireEvent.click(item)
    act(() =>
    {
      press(dialog(), 'Escape')
    })
    expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus()
  })

  it('closes when Tab leaves it and leaves focus where Tab put it', () =>
  {
    render(<ShortcutsPage />)
    act(() =>
    {
      press(grid(), 'F1')
    })
    const outside = screen.getByRole('button', { name: 'Outside' })
    act(() =>
    {
      fireEvent.blur(dialog(), { relatedTarget: outside })
      outside.focus()
    })
    expect(dialog()).not.toHaveAttribute('data-open')
    expect(outside).toHaveFocus()
  })

  it('closes when the platform dismisses it', () =>
  {
    render(<ShortcutsPage />)
    act(() =>
    {
      press(grid(), 'F1')
    })
    act(() =>
    {
      dialog().dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }))
    })
    expect(dialog()).toHaveAttribute('data-open', 'true')
    act(() =>
    {
      dialog().dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }))
    })
    expect(dialog()).not.toHaveAttribute('data-open')
  })

  it('keeps other keys inside it to itself', () =>
  {
    render(<ShortcutsPage />)
    act(() =>
    {
      press(grid(), 'F1')
    })
    expect(press(dialog(), 'a')).toBe(false)
    expect(dialog()).toHaveAttribute('data-open', 'true')
  })
})
