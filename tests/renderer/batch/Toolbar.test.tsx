/**
 * The Batch view's table toolbar: the mode tabs with the Queue count and the Run tab that waits for the first
 * batch, the Add menu, Set operation, New files, the debounced search, the Filter menu with its chips and
 * counts, the Clear menu that never clears jobs that need attention, and the collapse at each view width.
 */
import React, { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import
{
  CLEAR_SEARCH_LABEL,
  NO_MATCHES_TEXT,
  SEARCH_BUTTON_LABEL,
  SEARCH_DEBOUNCE_MS,
  SearchField,
  type SearchFieldHandle
} from '../../../src/renderer/src/components/batch/toolbar/SearchField'
import { MODE_TABS_ID, ModeTabs, modeTabItems } from '../../../src/renderer/src/components/batch/toolbar/ModeTabs'
import { FilterChips, chipsThatFit, moreFiltersLabel, removeFilterLabel, type FilterChip } from '../../../src/renderer/src/components/batch/toolbar/FilterChips'
import { FilterMenu, filterMenuEntries, filterOptionLabel, filterTriggerLabel } from '../../../src/renderer/src/components/batch/toolbar/FilterMenu'
import
{
  ADD_COPY,
  AddMenu,
  addMenuEntries,
  recentFolderDate,
  recentFolderDescription,
  type AddMenuActions
} from '../../../src/renderer/src/components/batch/toolbar/AddMenu'
import
{
  NEW_FILES_GET_CAPTION,
  NEW_FILES_GET_LABEL,
  NEW_FILES_GET_TOOLTIP,
  NEW_FILES_LOADING,
  NewFilesGetSelect,
  newFilesGroups,
  newFilesLabel,
  newFilesRecipe,
  newFilesSubmenu,
  newFilesValue,
  useNewFilesChoice
} from '../../../src/renderer/src/components/batch/toolbar/NewFilesGetSelect'
import
{
  ClearMenu,
  NOTHING_TO_CLEAR,
  canClear,
  clearCounts,
  clearSubmenu
} from '../../../src/renderer/src/components/batch/toolbar/ClearMenu'
import
{
  TOOLBAR_COPY,
  Toolbar,
  toolbarLayout,
  type ToolbarHandle,
  type ToolbarPickers,
  type ToolbarProps
} from '../../../src/renderer/src/components/batch/toolbar/Toolbar'
import { createTestBatchActions, TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import { modeRows, useBatchView } from '../../../src/renderer/src/stores/batchView'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import { Button, LiveRegion, PlatformProvider } from '../../../src/renderer/src/ui'
import { filterChips, filterMenu, hiddenSelectionMessage, NO_FILTERS, type BatchFilter, type BatchFilters } from '../../../src/renderer/src/stores/batchFilters'
import { applyPreset, BUILTIN_PRESETS, USER_PRESET_GROUP } from '../../../src/shared/jobs/presets'
import { OPERATIONS, type Recipe } from '../../../src/shared/jobs/recipes'
import { operationLabel } from '../../../src/shared/jobs/describe'
import type { JobView, PresetState, RecentFolder } from '../../../src/shared/jobs/types'

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Over = Partial<Omit<JobView, 'source'>> & { source?: Partial<JobView['source']> }

const stereo = { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 192, language: null, isDefault: true }

const audioOnly = { container: 'wav', durationSec: 60, video: null, audio: [stereo], subtitles: 0, attachments: 0, chapters: 0, cover: false } as unknown as JobView['media']

function job(id: string, over: Over = {}): JobView
{
  const { source, ...rest } = over
  return {
    id,
    seq: 1,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Media\\Show\\Season 3\\${id}.mkv`, name: `${id}.mkv`, ext: '.mkv', dir: 'D:\\Media\\Show\\Season 3', size: 1000, mtimeMs: 1, origin: 'files', subdir: '', ...source },
    recipe: { kind: 'normalize', presetId: 'ebu-r128', userPreset: null },
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: null,
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: { container: 'matroska', durationSec: 60, video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 25 }, audio: [stereo], subtitles: 0, attachments: 0, chapters: 0, cover: false },
    probe: null,
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
    addedAt: 1,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...rest
  } as unknown as JobView
}

const AUDIO_ONLY: BatchFilter = { facet: 'type', value: 'audio' }
const ATTENTION: BatchFilter = { facet: 'status', value: 'attention' }
const EXTRAS: BatchFilter = { facet: 'folder', value: 'D:\\Media\\Show\\Season 3\\Extras' }

/** The New files menu button, named for its choice. */
function newFilesTrigger(): HTMLElement
{
  return screen.getByRole('button', { name: new RegExp(`^${NEW_FILES_GET_LABEL}`) })
}

/** The choice the New files button shows. */
function newFilesShown(): string
{
  return document.querySelector('[data-part="new-files-value"]')?.textContent ?? ''
}

/** Opens the New files menu and picks the choice with this label. */
function pickNewFiles(label: string): void
{
  fireEvent.click(newFilesTrigger())
  fireEvent.click(screen.getByRole('menuitemradio', { name: label, hidden: true }))
}

function withChips(...chips: BatchFilter[]): BatchFilters
{
  return { chips, search: '' }
}

describe('SearchField', () =>
{
  it('applies the search 150 ms after the last key, once', () =>
  {
    vi.useFakeTimers()
    const onSearch = vi.fn()
    render(<SearchField value="" onSearch={onSearch} />)
    const input = screen.getByRole('searchbox', { name: 'Filter by name or folder' })
    fireEvent.change(input, { target: { value: 'sea' } })
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    fireEvent.change(input, { target: { value: 'season' } })
    act(() => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    expect(onSearch).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(onSearch).toHaveBeenCalledWith('season')
  })

  it('clears on the first Escape and leaves on the second', () =>
  {
    const onSearch = vi.fn()
    const onLeave = vi.fn()
    render(<SearchField value="intro" onSearch={onSearch} onLeave={onLeave} />)
    const input = screen.getByRole('searchbox') as HTMLInputElement
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onSearch).toHaveBeenCalledWith('')
    expect(input.value).toBe('')
    expect(onLeave).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('lets go of focus on the second Escape when nothing takes it', () =>
  {
    render(<SearchField value="" onSearch={() => undefined} />)
    const input = screen.getByRole('searchbox')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
  })

  it('empties the field from the clear button and keeps focus in it', () =>
  {
    const onSearch = vi.fn()
    render(<SearchField value="intro" onSearch={onSearch} />)
    fireEvent.click(screen.getByRole('button', { name: CLEAR_SEARCH_LABEL }))
    expect(onSearch).toHaveBeenCalledWith('')
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    expect(screen.queryByRole('button', { name: CLEAR_SEARCH_LABEL })).toBeNull()
  })

  it('shows a search changed elsewhere, such as Clear filters', () =>
  {
    const { rerender } = render(<SearchField value="intro" onSearch={() => undefined} />)
    rerender(<SearchField value="" onSearch={() => undefined} />)
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })

  it('applies a pending search on Enter, on leaving, and when it unmounts', () =>
  {
    vi.useFakeTimers()
    const onSearch = vi.fn()
    const { unmount } = render(
      <div>
        <SearchField value="" onSearch={onSearch} />
        <button type="button">Elsewhere</button>
      </div>
    )
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSearch).toHaveBeenLastCalledWith('a')
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) })
    expect(onSearch).toHaveBeenLastCalledWith('ab')
    fireEvent.change(input, { target: { value: 'abc' } })
    unmount()
    expect(onSearch).toHaveBeenLastCalledWith('abc')
    expect(onSearch).toHaveBeenCalledTimes(3)
  })

  it('describes a search that keeps no rows', () =>
  {
    render(<SearchField value="zzz" onSearch={() => undefined} noMatches />)
    expect(screen.getByRole('searchbox')).toHaveAccessibleDescription(NO_MATCHES_TEXT)
  })

  it('takes the History placeholder and a separate name', () =>
  {
    render(<SearchField value="" onSearch={() => undefined} placeholder="Find a file or job number" label="Search history" />)
    const input = screen.getByRole('searchbox', { name: 'Search history' })
    expect(input).toHaveAttribute('placeholder', 'Find a file or job number')
  })

  it('collapses into an icon button that expands the field and folds back when focus leaves', () =>
  {
    render(
      <div>
        <SearchField value="" onSearch={() => undefined} collapsed />
        <button type="button">Elsewhere</button>
      </div>
    )
    expect(screen.queryByRole('searchbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON_LABEL }))
    const input = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(input)
    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('button', { name: SEARCH_BUTTON_LABEL })).toBeInTheDocument()
  })

  it('returns focus to the icon button when the collapsed field is left with Escape', () =>
  {
    render(<SearchField value="" onSearch={() => undefined} collapsed />)
    fireEvent.click(screen.getByRole('button', { name: SEARCH_BUTTON_LABEL }))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: SEARCH_BUTTON_LABEL }))
  })

  it('expands and focuses from its handle, for Ctrl+F', () =>
  {
    const ref = createRef<SearchFieldHandle>()
    render(<SearchField ref={ref} value="intro" onSearch={() => undefined} collapsed />)
    expect(screen.getByRole('button', { name: SEARCH_BUTTON_LABEL })).toHaveAccessibleDescription('Filtering by intro')
    act(() => ref.current?.focus())
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    act(() => ref.current?.focus())
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })
})

describe('ModeTabs', () =>
{
  it('names the four modes, with the Queue count', () =>
  {
    render(<ModeTabs mode="queue" runAvailable queueCount={38} onChange={() => undefined} />)
    expect(screen.getByRole('tablist', { name: 'Batch modes' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label') ?? tab.textContent)).toEqual(['Queue, 38', 'Review', 'Run', 'History'])
    expect(screen.getByRole('tab', { name: 'Queue, 38' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Queue, 38' }).id).toContain(MODE_TABS_ID)
  })

  it('keeps Run focusable with aria-disabled and its reason before the first batch', () =>
  {
    const onChange = vi.fn()
    render(<ModeTabs mode="queue" runAvailable={false} queueCount={3} onChange={onChange} />)
    const run = screen.getByRole('tab', { name: 'Run' })
    expect(run).toHaveAttribute('aria-disabled', 'true')
    expect(run).not.toHaveAttribute('disabled')
    expect(run).toHaveAccessibleDescription('Starts when you press Start.')
    run.focus()
    expect(document.activeElement).toBe(run)
    fireEvent.click(run)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces why Run does not open when it is pressed before the first batch', async () =>
  {
    render(
      <LiveRegion>
        <ModeTabs mode="queue" runAvailable={false} queueCount={3} onChange={() => undefined} />
      </LiveRegion>
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }))
    expect(await screen.findByText('Run starts when you press Start.')).toBeInTheDocument()
  })

  it('opens Run once a batch has started, and the other modes always', () =>
  {
    const onChange = vi.fn()
    render(<ModeTabs mode="queue" runAvailable queueCount={3} onChange={onChange} />)
    expect(screen.getByRole('tab', { name: 'Run' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }))
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(onChange.mock.calls.map(([mode]) => mode)).toEqual(['run', 'history'])
  })

  it('builds the tab items from availability and the count', () =>
  {
    expect(modeTabItems(false, 0)).toEqual([
      { value: 'queue', label: 'Queue', count: 0 },
      { value: 'review', label: 'Review' },
      { value: 'run', label: 'Run', disabled: true, disabledReason: 'Starts when you press Start.' },
      { value: 'history', label: 'History' }
    ])
  })
})

describe('FilterChips', () =>
{
  const chips: FilterChip[] = filterChips(withChips(AUDIO_ONLY, EXTRAS, ATTENTION))

  it('names what each chip keeps, with a remove button per chip, and the counts after them', () =>
  {
    const onRemove = vi.fn()
    render(<FilterChips chips={chips} onRemove={onRemove} wrap renderOverflow={() => null} counts="Showing 2 of 9 · 2 selected" />)
    const list = screen.getByRole('list', { name: 'Active filters' })
    expect(Array.from(list.querySelectorAll('[data-chip-label]')).map((label) => label.textContent)).toEqual(['Audio only', 'Folder: Season 3\\Extras', 'Needs attention'])
    expect(screen.getByRole('button', { name: 'Remove filter Audio only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove filter Needs attention' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Folder: Season 3\\Extras' }))
    expect(onRemove).toHaveBeenCalledWith(EXTRAS)
    expect(screen.getByText('Showing 2 of 9 · 2 selected')).toBeInTheDocument()
  })

  it('renders nothing without chips or counts', () =>
  {
    const { container } = render(<FilterChips chips={[]} onRemove={() => undefined} wrap renderOverflow={() => null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('moves focus to the next chip after a removal, and out to the Filter button after the last', () =>
  {
    const onEmptied = vi.fn()
    const view = (list: FilterChip[]): React.JSX.Element =>
      <FilterChips chips={list} onRemove={() => undefined} wrap renderOverflow={() => null} onEmptied={onEmptied} />
    const { rerender } = render(view(chips))
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Audio only' }))
    rerender(view(chips.slice(1)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove filter Folder: Season 3\\Extras' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Needs attention' }))
    rerender(view(chips.slice(1, 2)))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove filter Folder: Season 3\\Extras' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Folder: Season 3\\Extras' }))
    rerender(view([]))
    expect(onEmptied).toHaveBeenCalledTimes(1)
  })

  it('gives the chips that do not fit on one line to "+{n} filters"', () =>
  {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement)
    {
      const width = this.hasAttribute('data-filter-chips')
        ? 300
        : this.hasAttribute('data-chip-ghost-overflow')
          ? 80
          : this.parentElement?.hasAttribute('data-chip-ghost') === true ? 120 : 0
      return { width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    const renderOverflow = vi.fn((label: string) => <button type="button">{label}</button>)
    render(<FilterChips chips={chips} onRemove={() => undefined} wrap={false} renderOverflow={renderOverflow} />)
    expect(screen.getAllByRole('button', { name: /^Remove filter/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '+2 filters' })).toBeInTheDocument()
    expect(renderOverflow).toHaveBeenLastCalledWith('+2 filters', 2)
  })

  it('counts how many chips fit beside the overflow trigger', () =>
  {
    expect(chipsThatFit([100, 100], 204, 60)).toBe(2)
    expect(chipsThatFit([100, 100, 100], 250, 60)).toBe(1)
    expect(chipsThatFit([100, 100, 100], 150, 60)).toBe(0)
    expect(chipsThatFit([0, 0], 0, 0)).toBe(2)
    expect(moreFiltersLabel(1)).toBe('+1 filter')
    expect(removeFilterLabel('In Batch 31')).toBe('Remove filter In Batch 31')
  })
})

describe('FilterMenu', () =>
{
  const rows = [
    job('a', { source: { dir: 'D:\\Rips\\Podcasts', name: 'a.wav', ext: '.wav' }, media: audioOnly }),
    job('b'),
    job('c')
  ]

  function open(): void
  {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }))
  }

  function groupName(group: HTMLElement): string | null
  {
    const by = group.getAttribute('aria-labelledby')
    return group.getAttribute('aria-label') ?? (by === null ? null : document.getElementById(by)?.textContent ?? null)
  }

  it('groups check items by facet, each with the rows it keeps, and toggles without closing', () =>
  {
    const onToggle = vi.fn()
    render(<FilterMenu groups={filterMenu(rows, withChips(AUDIO_ONLY))} active={1} onToggle={onToggle} onClear={() => undefined} />)
    open()
    expect(screen.getAllByRole('group', { hidden: true }).map(groupName)).toEqual(expect.arrayContaining(['Type', 'Channels', 'Container', 'Folder', 'Recipe', 'Status', 'Batch']))
    const audio = screen.getByRole('menuitemcheckbox', { name: 'Audio only (1)', hidden: true })
    expect(audio).toHaveAttribute('aria-checked', 'true')
    const video = screen.getByRole('menuitemcheckbox', { name: 'Video (2)', hidden: true })
    expect(video).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(video)
    expect(onToggle).toHaveBeenCalledWith({ facet: 'type', value: 'video' })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Video (2)', hidden: true })).toBeInTheDocument()
  })

  it('offers Clear filters only while a filter is set', () =>
  {
    const onClear = vi.fn()
    const { rerender } = render(<FilterMenu groups={filterMenu(rows, NO_FILTERS)} active={0} onToggle={() => undefined} onClear={onClear} />)
    open()
    const clear = screen.getByRole('menuitem', { name: /Clear filters/, hidden: true })
    expect(clear).toHaveAttribute('aria-disabled', 'true')
    expect(clear.textContent).toContain('No filters are set.')
    rerender(<FilterMenu groups={filterMenu(rows, withChips(ATTENTION))} active={1} onToggle={() => undefined} onClear={onClear} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters', hidden: true }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('names the count on the trigger when the chips are out of view, and takes another trigger', () =>
  {
    const { rerender } = render(<FilterMenu groups={[]} active={2} onToggle={() => undefined} onClear={() => undefined} showCount />)
    expect(screen.getByRole('button', { name: 'Filter, 2 set' })).toBeInTheDocument()
    rerender(<FilterMenu groups={[]} active={2} onToggle={() => undefined} onClear={() => undefined} iconOnly />)
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument()
    rerender(<FilterMenu groups={[]} active={2} onToggle={() => undefined} onClear={() => undefined} trigger={<Button size="sm" variant="ghost">+2 filters</Button>} />)
    expect(screen.getByRole('button', { name: '+2 filters' })).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('builds entries without empty groups', () =>
  {
    const entries = filterMenuEntries([{ id: 'container', label: 'Container', options: [] }], 0, () => undefined, () => undefined)
    expect(entries).toHaveLength(2)
    expect(filterOptionLabel({ filter: AUDIO_ONLY, label: 'Audio only', count: 1200, checked: false })).toBe('Audio only (1,200)')
    expect(filterTriggerLabel(0)).toBe('Filter')
  })
})

describe('AddMenu', () =>
{
  const now = new Date(2026, 9, 17, 12).getTime()

  function folder(name: string, files: number, day: number): RecentFolder
  {
    return { path: `D:\\Rips\\${name}`, name, files, addedAt: new Date(2026, 9, day, 12).getTime() }
  }

  function actions(): AddMenuActions & { [K in keyof AddMenuActions]: ReturnType<typeof vi.fn> }
  {
    return {
      onAddFiles: vi.fn(),
      onAddFolder: vi.fn(),
      onPaste: vi.fn(),
      onToggleSubfolders: vi.fn(),
      onOpenRecent: vi.fn(),
      onClearRecent: vi.fn()
    }
  }

  const recent = [folder('Podcasts', 212, 12), folder('Concerts', 1, 11), folder('Season 3', 40, 10), folder('Tapes', 9, 9), folder('Stems', 3, 8), folder('Old', 7, 7)]

  function open(): void
  {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  }

  it('offers the three ways in with their keys, Include subfolders, and five recent folders', () =>
  {
    const run = actions()
    render(<AddMenu includeSubfolders recentFolders={recent} now={now} {...run} />)
    open()
    const files = screen.getByRole('menuitem', { name: /^Add files…/, hidden: true })
    expect(files).toHaveAttribute('aria-keyshortcuts')
    expect(screen.getByRole('menuitem', { name: /^Add folder…/, hidden: true })).toHaveAttribute('aria-keyshortcuts')
    expect(screen.getByRole('menuitem', { name: /^Paste files/, hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: ADD_COPY.subfolders, hidden: true })).toHaveAttribute('aria-checked', 'true')
    const podcasts = screen.getByRole('menuitem', { name: /^Podcasts/, hidden: true })
    expect(podcasts.textContent).toContain('D:\\Rips\\Podcasts · 212 files · Oct 12')
    expect(screen.queryByRole('menuitem', { name: /^Old/, hidden: true })).toBeNull()
    fireEvent.click(podcasts)
    expect(run.onOpenRecent).toHaveBeenCalledWith(recent[0])
  })

  it('runs each item', () =>
  {
    const run = actions()
    render(<AddMenu includeSubfolders={false} recentFolders={recent} now={now} {...run} />)
    const pick = (role: string, name: RegExp | string): void =>
    {
      open()
      fireEvent.click(screen.getByRole(role, { name, hidden: true }))
    }
    pick('menuitem', /^Add files…/)
    pick('menuitem', /^Add folder…/)
    pick('menuitem', /^Paste files/)
    pick('menuitemcheckbox', ADD_COPY.subfolders)
    pick('menuitem', ADD_COPY.clearRecent)
    expect(run.onAddFiles).toHaveBeenCalledTimes(1)
    expect(run.onAddFolder).toHaveBeenCalledTimes(1)
    expect(run.onPaste).toHaveBeenCalledTimes(1)
    expect(run.onToggleSubfolders).toHaveBeenCalledTimes(1)
    expect(run.onClearRecent).toHaveBeenCalledTimes(1)
  })

  it('leaves out the recent folders until there are some, and holds New files when the view is narrow', () =>
  {
    const submenu = { kind: 'submenu' as const, id: 'new-files-get', label: 'New files', items: [] }
    const entries = addMenuEntries({ includeSubfolders: true, recentFolders: [], newFiles: submenu }, actions())
    expect(entries).toHaveLength(6)
    expect(entries[5]).toBe(submenu)
    expect(addMenuEntries({ includeSubfolders: true, recentFolders: [] }, actions())).toHaveLength(4)
  })

  it('stays focusable but does not open while a picker is open', () =>
  {
    render(<AddMenu picking includeSubfolders recentFolders={[]} {...actions()} />)
    const trigger = screen.getByRole('button', { name: 'Add' })
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    expect(trigger).toHaveAccessibleDescription(ADD_COPY.picking)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /^Add files…/, hidden: true })).toBeNull()
  })

  it('words the folder line with its count and date', () =>
  {
    expect(recentFolderDescription(folder('Concerts', 1, 11), now)).toBe('D:\\Rips\\Concerts · 1 file · Oct 11')
    expect(recentFolderDescription(folder('Big', 1204, 3), now)).toBe('D:\\Rips\\Big · 1,204 files · Oct 3')
    expect(recentFolderDate(new Date(2025, 11, 30, 12).getTime(), now)).toBe('Dec 30, 2025')
  })
})

describe('NewFilesGetSelect', () =>
{
  const SAME = { kind: 'same-as-source' } as const
  const normalizeIds = BUILTIN_PRESETS.filter((info) => info.op === 'normalize').map((info) => info.id)

  function recipe(id: string): Recipe
  {
    const made = applyPreset(id, SAME)
    if (made === null)
    {
      throw new Error(`no preset ${id}`)
    }
    return made
  }

  const first = recipe(normalizeIds[0])
  const second = recipe(normalizeIds[1])
  const mine = { id: 'user-1', name: 'My podcast', recipe: first, createdAt: 1, updatedAt: 1 }
  const presets: PresetState = { user: [mine], pins: {}, recent: [] }

  function Harness({ current, onChoose }: { current: Recipe | null; onChoose: (next: Recipe) => Promise<boolean> }): React.JSX.Element
  {
    const choice = useNewFilesChoice(current, presets, onChoose)
    return <NewFilesGetSelect choice={choice} />
  }

  it('groups the presets by operation in the picker order, then Your presets', () =>
  {
    const groups = newFilesGroups(presets, first)
    expect(groups.map((group) => group.group)).toEqual([...OPERATIONS.map(operationLabel), USER_PRESET_GROUP])
    expect(groups[0].options.every((option) => option.label.startsWith(`${operationLabel('normalize')} · `))).toBe(true)
    expect(groups[groups.length - 1].options).toEqual([{ value: 'normalize:user-1', label: `${operationLabel('normalize')} · My podcast` }])
    expect(newFilesGroups(null, null).map((group) => group.group)).toEqual(OPERATIONS.map(operationLabel))
  })

  it('leads its operation with a current recipe no group lists, such as Custom', () =>
  {
    const custom = { ...first, presetId: null, userPreset: null } as Recipe
    const groups = newFilesGroups(null, custom)
    expect(newFilesValue(custom)).toBe('normalize:custom')
    expect(groups[0].options[0].value).toBe('normalize:custom')
    expect(newFilesLabel(groups, 'normalize:custom')).toBe(groups[0].options[0].label)
    expect(newFilesLabel(groups, 'nothing')).toBeNull()
    expect(newFilesValue(null)).toBeNull()
  })

  it('makes the whole recipe of a new choice, and nothing for the current one', () =>
  {
    expect(newFilesRecipe(newFilesValue(first) as string, first, presets)).toBeNull()
    const next = newFilesRecipe(`normalize:${normalizeIds[1]}`, first, presets)
    expect(next).toEqual(second)
    expect(newFilesRecipe('normalize:user-1', null, presets)).not.toBeNull()
  })

  it('offers the same choices as a radio submenu for the Add menu', () =>
  {
    const choose = vi.fn()
    const groups = newFilesGroups(presets, first)
    const value = newFilesValue(first)
    const submenu = newFilesSubmenu(groups, value, choose)
    expect(submenu.label).toBe(NEW_FILES_GET_CAPTION)
    expect(submenu.description).toBe(newFilesLabel(groups, value))
    const items = submenu.items.flatMap((entry) => (typeof entry === 'object' && 'group' in entry ? entry.items : []))
    expect(items.filter((item) => item.kind === 'radio' && item.checked)).toHaveLength(1)
    items[1].onSelect()
    expect(choose).toHaveBeenCalledWith(groups[0].options[1].value)
    expect(newFilesSubmenu(groups, null, choose).description).toBeUndefined()
  })

  const labelOf = (value: string | null): string => newFilesLabel(newFilesGroups(presets, first), value) ?? NEW_FILES_LOADING

  it('names the button with the choice, describes what it does, and hides only the caption when narrow', () =>
  {
    render(<Harness current={first} onChoose={async () => true} />)
    const current = labelOf(newFilesValue(first))
    expect(newFilesTrigger()).toHaveAccessibleName(`${NEW_FILES_GET_LABEL}: ${current}`)
    expect(newFilesTrigger()).toHaveAccessibleDescription(`${current}. ${NEW_FILES_GET_TOOLTIP}`)
    expect(newFilesShown()).toBe(current)
    expect(screen.getByText(NEW_FILES_GET_CAPTION).className).toContain('@max-[1179px]:hidden')
  })

  it('waits for main before it offers a choice', () =>
  {
    render(<Harness current={null} onChoose={async () => true} />)
    expect(newFilesTrigger()).toBeDisabled()
    expect(newFilesShown()).toBe(NEW_FILES_LOADING)
  })

  it('shows a choice at once, keeps it once main takes it, and snaps back when main refuses it', async () =>
  {
    let answer: (taken: boolean) => void = () => undefined
    const onChoose = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
    const { rerender } = render(<Harness current={first} onChoose={onChoose} />)
    const target = `normalize:${normalizeIds[1]}`
    pickNewFiles(labelOf(target))
    expect(onChoose).toHaveBeenCalledWith(second)
    expect(newFilesShown()).toBe(labelOf(target))
    await act(async () => { answer(false) })
    expect(newFilesShown()).toBe(labelOf(newFilesValue(first)))
    pickNewFiles(labelOf(target))
    await act(async () => { answer(true) })
    expect(newFilesShown()).toBe(labelOf(target))
    rerender(<Harness current={second} onChoose={onChoose} />)
    expect(newFilesShown()).toBe(labelOf(target))
    pickNewFiles(labelOf(target))
    expect(onChoose).toHaveBeenCalledTimes(2)
  })
})

describe('ClearMenu', () =>
{
  const warned = [{ code: 'loudness-outside' }] as unknown as JobView['warnings']

  const finished = [
    job('verified', { state: 'done' }),
    job('seen', { state: 'done', warnings: warned, acknowledged: true }),
    job('warned', { state: 'done', warnings: warned }),
    job('failed', { state: 'failed' }),
    job('retired', { state: 'failed', acknowledged: true }),
    job('interrupted', { state: 'interrupted' }),
    job('canceled', { state: 'canceled' }),
    job('skipped', { state: 'skipped' }),
    job('held', { state: 'held' }),
    job('waiting-1', { state: 'pending' }),
    job('queued', { state: 'queued' }),
    job('encoding', { state: 'encoding' }),
    job('waiting-2', { state: 'pending' })
  ]

  function open(): void
  {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  }

  it('counts each scope without the jobs that need attention', () =>
  {
    expect(clearCounts(finished)).toEqual({ done: 2, doneKept: 1, finished: 5, finishedKept: 4, pending: ['waiting-1', 'waiting-2'] })
    expect(canClear(clearCounts([job('queued', { state: 'queued' })]))).toBe(false)
  })

  it('states each scope with its count, says how many stay, and clears that scope', () =>
  {
    const onClear = vi.fn()
    render(<ClearMenu counts={clearCounts(finished)} onClear={onClear} />)
    open()
    const done = screen.getByRole('menuitem', { name: /^Clear done \(2\)/, hidden: true })
    expect(done.textContent).toContain('1 job that needs attention stays until acknowledged.')
    const all = screen.getByRole('menuitem', { name: /^Clear finished \(5\)/, hidden: true })
    expect(all.textContent).toContain('4 jobs that need attention stay until acknowledged.')
    fireEvent.click(all)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Clear done/, hidden: true }))
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove jobs not in a batch \(2\)/, hidden: true }))
    expect(onClear.mock.calls.map(([scope]) => scope)).toEqual([
      { kind: 'finished' },
      { kind: 'done' },
      { kind: 'ids', ids: ['waiting-1', 'waiting-2'] }
    ])
  })

  it('never offers a scope that would clear only jobs that need attention', () =>
  {
    const onClear = vi.fn()
    render(<ClearMenu counts={clearCounts([job('warned', { state: 'done', warnings: warned }), job('waiting', { state: 'pending' })])} onClear={onClear} />)
    open()
    const done = screen.getByRole('menuitem', { name: /^Clear done \(0\)/, hidden: true })
    expect(done).toHaveAttribute('aria-disabled', 'true')
    expect(done.textContent).toContain(`${NOTHING_TO_CLEAR} 1 job that needs attention stays until acknowledged.`)
    fireEvent.click(done)
    expect(onClear).not.toHaveBeenCalled()
  })

  it('keeps the trigger focusable with its reason while nothing can be cleared', () =>
  {
    render(<ClearMenu counts={clearCounts([job('queued', { state: 'queued' })])} onClear={() => undefined} />)
    const trigger = screen.getByRole('button', { name: 'Clear' })
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    expect(trigger).toHaveAccessibleDescription(NOTHING_TO_CLEAR)
  })

  it('builds the same scopes as a submenu for the batch overflow menu', () =>
  {
    const onClear = vi.fn()
    const submenu = clearSubmenu(clearCounts(finished), onClear)
    expect(submenu.label).toBe('Clear')
    expect(submenu.disabled).toBeUndefined()
    expect(submenu.items).toHaveLength(3)
    expect(clearSubmenu(clearCounts([]), onClear)).toMatchObject({ disabled: true, disabledReason: NOTHING_TO_CLEAR })
  })
})

describe('Toolbar', () =>
{
  const SAME = { kind: 'same-as-source' } as const
  const normalizeIds = BUILTIN_PRESETS.filter((info) => info.op === 'normalize').map((info) => info.id)
  const recipeOf = (id: string): Recipe => applyPreset(id, SAME) as Recipe
  const created: BatchActions[] = []

  beforeEach(() =>
  {
    useJobsStore.setState(initialJobsState(), true)
    useBatchView.setState(useBatchView.getInitialState(), true)
  })

  afterEach(() =>
  {
    created.splice(0).forEach((actions) => actions.dispose())
  })

  function seed(rows: JobView[], extra: Record<string, unknown> = {}): void
  {
    useJobsStore.setState({
      order: rows.map((row) => row.id),
      jobs: Object.fromEntries(rows.map((row) => [row.id, row])),
      ...extra
    } as never)
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void }
  {
    let resolve: (value: T) => void = () => undefined
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }

  interface Setup
  {
    overrides?: Partial<BatchActions>
    pickers?: ToolbarPickers
    props?: Partial<ToolbarProps>
  }

  function renderToolbar({ overrides = {}, pickers, props = {} }: Setup = {}): ReturnType<typeof render>
  {
    const actions = createTestBatchActions({ jobs: useJobsStore, view: useBatchView, overrides })
    created.push(actions)
    return render(
      <PlatformProvider platform="win32">
        <LiveRegion>
          <TestBatchActionsProvider actions={actions}>
            <Toolbar
              pickers={pickers ?? { openFiles: async () => [], openDirectory: async () => null }}
              {...props}
            />
          </TestBatchActionsProvider>
        </LiveRegion>
      </PlatformProvider>
    )
  }

  function spy<K extends keyof BatchActions>(value: unknown): BatchActions[K]
  {
    return vi.fn(async () => value) as unknown as BatchActions[K]
  }

  function viewWidth(width: number): void
  {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement)
    {
      const w = this.hasAttribute('data-batch-toolbar') ? width : 0
      return { width: w, height: 44, top: 0, left: 0, right: w, bottom: 44, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
  }

  function within(element: Element, container: string): boolean
  {
    return element.closest(`[class~="${container}"]`) !== null
  }

  it('reads the modes first with the Queue count, then Add, Set operation, and New files', () =>
  {
    seed([job('a'), job('b'), job('c')])
    renderToolbar()
    const order = [
      screen.getByRole('tab', { name: 'Queue, 3' }),
      screen.getByRole('button', { name: 'Add' }),
      screen.getByRole('button', { name: /^Set operation/ }),
      newFilesTrigger()
    ]
    for (let i = 1; i < order.length; i += 1)
    {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('keeps Run focusable with its reason before the first batch and opens the other modes', async () =>
  {
    renderToolbar()
    const run = screen.getByRole('tab', { name: 'Run' })
    expect(run).toHaveAttribute('aria-disabled', 'true')
    expect(run).toHaveAccessibleDescription('Starts when you press Start.')
    fireEvent.click(run)
    expect(useBatchView.getState().mode).toBe('queue')
    expect(await screen.findByText('Run starts when you press Start.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(useBatchView.getState().mode).toBe('review')
  })

  it('offers Set operation in Queue and Review only, unavailable until jobs are selected', () =>
  {
    seed([job('a'), job('b')], { presets: { user: [], pins: {}, recent: [] } })
    renderToolbar()
    const apply = screen.getByRole('button', { name: /^Set operation/ })
    expect(apply).toHaveAttribute('aria-disabled', 'true')
    expect(apply).toHaveAccessibleDescription(TOOLBAR_COPY.selectFirst)
    expect(apply).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    fireEvent.click(apply)
    expect(screen.queryByRole('combobox', { name: /^Set operation to/, hidden: true })).toBeNull()
    act(() => { useBatchView.getState().select('queue', { type: 'click', id: 'a' }) })
    const picker = screen.getByRole('button', { name: 'Set operation' })
    expect(picker).not.toHaveAttribute('aria-disabled')
    expect(picker).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    fireEvent.click(picker)
    expect(picker).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('combobox', { name: 'Set operation for a', hidden: true })).toBe(document.activeElement)
    act(() => { useBatchView.getState().setMode('history') })
    expect(screen.queryByRole('button', { name: /^Set operation/ })).toBeNull()
  })

  it('opens the recipe picker for the selection from its handle, and says to select jobs first', async () =>
  {
    const ref = createRef<ToolbarHandle>()
    seed([job('a'), job('b')], { presets: { user: [], pins: {}, recent: [] } })
    renderToolbar({ props: { ref } })
    act(() => ref.current?.openRecipePicker())
    await waitFor(() => expect(screen.getAllByText(TOOLBAR_COPY.selectFirst).some((node) => node.getAttribute('role') === 'status')).toBe(true))
    act(() => { useBatchView.getState().select('queue', { type: 'selectAll', ids: ['a', 'b'] }) })
    act(() => ref.current?.openRecipePicker())
    const input = screen.getByRole('combobox', { name: 'Set operation for 2 selected jobs', hidden: true })
    expect(document.activeElement).toBe(input)
  })

  it('keeps Set operation unavailable until main sends the presets, and leaves the picker alone outside Queue and Review', () =>
  {
    const ref = createRef<ToolbarHandle>()
    seed([job('a')])
    renderToolbar({ props: { ref } })
    act(() => { useBatchView.getState().select('queue', { type: 'click', id: 'a' }) })
    const apply = screen.getByRole('button', { name: /^Set operation/ })
    expect(apply).toHaveAttribute('aria-disabled', 'true')
    expect(apply).toHaveAccessibleDescription(NEW_FILES_LOADING)
    act(() => { useBatchView.getState().setMode('history') })
    act(() => ref.current?.openRecipePicker())
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('adds the files a picker returns, and keeps Add unavailable while the picker is open', async () =>
  {
    const files = deferred<string[]>()
    const addPaths = spy<'addPaths'>({ status: 'empty' })
    const openFiles = vi.fn(() => files.promise)
    renderToolbar({ overrides: { addPaths }, pickers: { openFiles, openDirectory: async () => null } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Add files…/, hidden: true }))
    expect(openFiles).toHaveBeenCalledTimes(1)
    const trigger = screen.getByRole('button', { name: 'Add' })
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { files.resolve(['D:/Rips/a.mkv', 'D:/Rips/b.mkv']) })
    expect(addPaths).toHaveBeenCalledWith(['D:/Rips/a.mkv', 'D:/Rips/b.mkv'], { origin: 'files' })
    expect(trigger).not.toHaveAttribute('aria-disabled')
  })

  it('adds a picked folder, and nothing when the picker is canceled', async () =>
  {
    const addPaths = spy<'addPaths'>({ status: 'empty' })
    const openDirectory = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce('D:/Rips/Podcasts')
    renderToolbar({ overrides: { addPaths }, pickers: { openFiles: async () => [], openDirectory } })
    for (let i = 0; i < 2; i += 1)
    {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /^Add folder…/, hidden: true })) })
    }
    expect(addPaths).toHaveBeenCalledTimes(1)
    expect(addPaths).toHaveBeenCalledWith(['D:/Rips/Podcasts'], { origin: 'folder' })
  })

  it('sends paste, Include subfolders, a recent folder, and Clear recent folders to main', async () =>
  {
    const folder: RecentFolder = { path: 'D:/Rips/Podcasts', name: 'Podcasts', files: 212, addedAt: Date.now() }
    seed([], { recentFolders: [folder], settings: { includeSubfolders: true } })
    const addPaths = spy<'addPaths'>({ status: 'empty' })
    const pasteFiles = spy<'pasteFiles'>({ status: 'empty' })
    const send = spy<'send'>({ status: 'done', value: null, seq: 1 })
    renderToolbar({ overrides: { addPaths, pasteFiles, send } })
    const choose = async (role: string, name: RegExp | string): Promise<void> =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      await act(async () => { fireEvent.click(screen.getByRole(role, { name, hidden: true })) })
    }
    await choose('menuitem', /^Paste files/)
    await choose('menuitemcheckbox', 'Include subfolders')
    await choose('menuitem', /^Podcasts/)
    await choose('menuitem', 'Clear recent folders')
    expect(pasteFiles).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('setSettings', { settings: { includeSubfolders: false } })
    expect(addPaths).toHaveBeenCalledWith(['D:/Rips/Podcasts'], { origin: 'folder' })
    expect(send).toHaveBeenCalledWith('clearRecentFolders', {})
  })

  it('sends the New files choice to main and says why when main refuses it', async () =>
  {
    const first = recipeOf(normalizeIds[0])
    const second = recipeOf(normalizeIds[1])
    seed([], { defaultRecipe: first, presets: { user: [], pins: {}, recent: [] } })
    const send = vi.fn(async () => ({ status: 'refused', code: 'internal', message: 'Main could not save the choice.' })) as unknown as BatchActions['send']
    renderToolbar({ overrides: { send } })
    const groups = newFilesGroups({ user: [], pins: {}, recent: [] }, first)
    fireEvent.click(newFilesTrigger())
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: newFilesLabel(groups, `normalize:${normalizeIds[1]}`) as string, hidden: true })) })
    expect(send).toHaveBeenCalledWith('setDefaultRecipe', { recipe: second })
    expect(newFilesShown()).toBe(newFilesLabel(groups, `normalize:${normalizeIds[0]}`))
    expect(await screen.findByText('Main could not save the choice.')).toBeInTheDocument()
  })

  it('collapses at each view width', () =>
  {
    const at = (width: number | null): string => Object.entries(toolbarLayout(width)).filter(([, on]) => on).map(([name]) => name).join(' ')
    expect(at(null)).toBe('wrapChips')
    expect(at(1180)).toBe('wrapChips')
    expect(at(1179)).toBe('')
    expect(at(1000)).toBe('')
    expect(at(999)).toBe('searchCollapsed newFilesInAddMenu')
    expect(at(880)).toBe('searchCollapsed newFilesInAddMenu')
    expect(at(879)).toBe('searchCollapsed newFilesInAddMenu clearInOverflow')
    expect(at(700)).toBe('searchCollapsed newFilesInAddMenu clearInOverflow')
    expect(at(699)).toBe('searchCollapsed newFilesInAddMenu clearInOverflow iconsOnly')
  })

  it('moves New files into the Add menu below 1000 px of view, and hides the select there', () =>
  {
    const first = recipeOf(normalizeIds[0])
    seed([], { defaultRecipe: first, presets: { user: [], pins: {}, recent: [] } })
    viewWidth(900)
    const { container } = renderToolbar()
    expect(container.querySelector('[data-batch-toolbar]')?.className).toContain('@container')
    expect(within(newFilesTrigger(), '@max-[999px]:hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('menuitem', { name: /^New files/, hidden: true })).toHaveAttribute('aria-haspopup', 'menu')
  })

  const podcast = (): JobView => job('a', { source: { dir: 'D:\\Rips\\Podcasts', name: 'a.wav', ext: '.wav' }, media: audioOnly })

  it('shows chips that name what they keep, then Showing {k} of {n} and {s} selected', () =>
  {
    seed([podcast(), job('b'), job('c')])
    renderToolbar()
    expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull()
    act(() =>
    {
      const view = useBatchView.getState()
      view.addFilter('queue', AUDIO_ONLY, modeRows('queue', useJobsStore.getState()))
      view.select('queue', { type: 'click', id: 'a' })
    })
    const list = screen.getByRole('list', { name: 'Active filters' })
    expect(list.textContent).toContain('Audio only')
    expect(screen.getByText('Showing 1 of 3 · 1 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Audio only' }))
    expect(useBatchView.getState().views.queue.filters.chips).toEqual([])
    expect(screen.queryByText(/^Showing/)).toBeNull()
  })

  it('counts a selection of several rows without a filter', () =>
  {
    seed([job('a'), job('b'), job('c')])
    renderToolbar()
    act(() => { useBatchView.getState().selectAllVisible('queue', modeRows('queue', useJobsStore.getState())) })
    expect(screen.getByText('3 selected')).toBeInTheDocument()
    expect(screen.queryByText(/^Showing/)).toBeNull()
  })

  it('toggles filters from the menu, deselects the rows they hide, and says so', async () =>
  {
    seed([podcast(), job('b'), job('c')])
    renderToolbar()
    act(() => { useBatchView.getState().selectAllVisible('queue', modeRows('queue', useJobsStore.getState())) })
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Audio only (1)', hidden: true }))
    expect(useBatchView.getState().views.queue.filters.chips).toEqual([AUDIO_ONLY])
    expect(useBatchView.getState().views.queue.selection.selected.size).toBe(1)
    const message = hiddenSelectionMessage(2) as string
    expect(await screen.findByText((text) => text.includes(message))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear filters', hidden: true }))
    expect(useBatchView.getState().views.queue.filters.chips).toEqual([])
  })

  it('filters by name or folder as you type, and searches every kept batch in History', () =>
  {
    seed([job('a'), job('b')])
    renderToolbar()
    const input = screen.getByRole('searchbox', { name: 'Filter by name or folder' })
    fireEvent.change(input, { target: { value: 'zzz' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useBatchView.getState().views.queue.filters.search).toBe('zzz')
    expect(input).toHaveAccessibleDescription(NO_MATCHES_TEXT)
    act(() => { useBatchView.getState().setMode('history') })
    const historyInput = screen.getByRole('searchbox', { name: 'Find a file or job number' })
    fireEvent.change(historyInput, { target: { value: '31' } })
    fireEvent.keyDown(historyInput, { key: 'Enter' })
    expect(useBatchView.getState().history.query).toBe('31')
    expect(screen.getByRole('searchbox', { name: 'Find a file or job number' })).toBe(historyInput)
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('clears a scope through main, counting only jobs that do not need attention', async () =>
  {
    const warned = [{ code: 'loudness-outside' }] as unknown as JobView['warnings']
    seed([job('v', { state: 'done' }), job('w', { state: 'done', warnings: warned }), job('p', { state: 'pending' })])
    const clear = spy<'clear'>({ status: 'done', value: { removed: 1, kept: 0, tombstone: 't' }, seq: 1, entryId: 1 })
    renderToolbar({ overrides: { clear } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('menuitem', { name: /^Clear done \(1\)/, hidden: true }).textContent).toContain('1 job that needs attention stays until acknowledged.')
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /^Remove jobs not in a batch \(1\)/, hidden: true })) })
    expect(clear).toHaveBeenCalledWith({ kind: 'ids', ids: ['p'] })
  })

  it('hides Clear below 880 px of view, where the Inspector toggle shows', () =>
  {
    const onToggleInspector = vi.fn()
    const { rerender } = renderToolbar({ props: { onToggleInspector, inspectorId: 'inspector' } })
    expect(within(screen.getByRole('button', { name: 'Clear' }), '@max-[879px]:hidden')).toBe(true)
    const toggle = screen.getByRole('button', { name: TOOLBAR_COPY.inspector })
    expect(within(toggle, '@max-[879px]:flex')).toBe(true)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'inspector')
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+I')
    fireEvent.click(toggle)
    expect(onToggleInspector).toHaveBeenCalledTimes(1)
    rerender(
      <LiveRegion>
        <TestBatchActionsProvider actions={created[0]}>
          <Toolbar onToggleInspector={onToggleInspector} inspectorOpen />
        </TestBatchActionsProvider>
      </LiveRegion>
    )
    expect(screen.getByRole('button', { name: TOOLBAR_COPY.inspector })).toHaveAttribute('aria-expanded', 'true')
  })

  it('leaves out the Inspector toggle when the page docks the inspector itself', () =>
  {
    renderToolbar()
    expect(screen.queryByRole('button', { name: TOOLBAR_COPY.inspector })).toBeNull()
  })

  it('wraps the chips only at the full width, shortens the search at 1179 px, and collapses it below 1000 px', () =>
  {
    seed([podcast(), job('b')])
    act(() => { useBatchView.getState().addFilter('queue', AUDIO_ONLY, modeRows('queue', useJobsStore.getState())) })
    const { container, unmount } = renderToolbar()
    expect(container.querySelector('[data-filter-chips]')).toHaveAttribute('data-wrap')
    expect(within(screen.getByRole('searchbox'), '@max-[1179px]:w-40')).toBe(true)
    unmount()
    viewWidth(1100)
    const second = renderToolbar()
    expect(second.container.querySelector('[data-filter-chips]')).not.toHaveAttribute('data-wrap')
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
    second.unmount()
    viewWidth(900)
    renderToolbar()
    expect(screen.queryByRole('searchbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('shortens Set operation below 1000 px and keeps only the icons of Add and Filter below 700 px', () =>
  {
    renderToolbar()
    const apply = screen.getByRole('button', { name: /^Set operation/ })
    expect(within(screen.getByText(TOOLBAR_COPY.applyRecipe), '@max-[999px]:hidden')).toBe(true)
    expect(within(screen.getByText(TOOLBAR_COPY.apply), '@max-[999px]:inline')).toBe(true)
    expect(apply.contains(screen.getByText(TOOLBAR_COPY.apply))).toBe(true)
    expect(within(screen.getByText('Add'), '@max-[699px]:sr-only')).toBe(true)
    expect(within(screen.getByText('Filter'), '@max-[699px]:sr-only')).toBe(true)
  })

  it('focuses the search and runs the add commands for the page shortcuts', async () =>
  {
    const ref = createRef<ToolbarHandle>()
    const openFiles = vi.fn(async () => [])
    const openDirectory = vi.fn(async () => null)
    const pasteFiles = spy<'pasteFiles'>({ status: 'empty' })
    viewWidth(900)
    renderToolbar({ overrides: { pasteFiles }, pickers: { openFiles, openDirectory }, props: { ref } })
    act(() => ref.current?.focusSearch())
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    await act(async () =>
    {
      await ref.current?.addFiles()
      await ref.current?.addFolder()
      await ref.current?.pasteFiles()
    })
    expect(openFiles).toHaveBeenCalledTimes(1)
    expect(openDirectory).toHaveBeenCalledTimes(1)
    expect(pasteFiles).toHaveBeenCalledTimes(1)
  })

  it('follows the view as it resizes', () =>
  {
    const observers: Array<(entries: ResizeObserverEntry[]) => void> = []
    vi.stubGlobal('ResizeObserver', class
    {
      constructor(callback: (entries: ResizeObserverEntry[]) => void)
      {
        observers.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    try
    {
      viewWidth(1300)
      renderToolbar()
      expect(screen.getByRole('searchbox')).toBeInTheDocument()
      const resize = (entry: Partial<ResizeObserverEntry>): void => act(() => observers.forEach((callback) => callback([entry as ResizeObserverEntry])))
      resize({ borderBoxSize: [{ inlineSize: 900, blockSize: 44 }], contentRect: { width: 900 } as DOMRectReadOnly })
      expect(screen.queryByRole('searchbox')).toBeNull()
      expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
      resize({ contentRect: { width: 1300 } as DOMRectReadOnly })
      expect(screen.getByRole('searchbox')).toBeInTheDocument()
    }
    finally
    {
      vi.unstubAllGlobals()
    }
  })

  it('opens the window pickers when the page gives none', async () =>
  {
    const openFiles = vi.fn(async () => ['D:/Rips/a.mkv'])
    Object.defineProperty(window, 'api', { value: { openFiles, openDirectory: async () => null }, configurable: true, writable: true })
    try
    {
      const addPaths = spy<'addPaths'>({ status: 'empty' })
      const actions = createTestBatchActions({ jobs: useJobsStore, view: useBatchView, overrides: { addPaths } })
      created.push(actions)
      render(
        <TestBatchActionsProvider actions={actions}>
          <Toolbar />
        </TestBatchActionsProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: /^Add files…/, hidden: true })) })
      expect(openFiles).toHaveBeenCalledTimes(1)
      expect(addPaths).toHaveBeenCalledWith(['D:/Rips/a.mkv'], { origin: 'files' })
    }
    finally
    {
      Reflect.deleteProperty(window, 'api')
    }
  })

  it('keeps a New files choice that main took', async () =>
  {
    const first = recipeOf(normalizeIds[0])
    seed([], { defaultRecipe: first, presets: { user: [], pins: {}, recent: [] } })
    const send = spy<'send'>({ status: 'done', value: null, seq: 2 })
    renderToolbar({ overrides: { send } })
    const groups = newFilesGroups({ user: [], pins: {}, recent: [] }, first)
    const target = newFilesLabel(groups, `normalize:${normalizeIds[1]}`) as string
    fireEvent.click(newFilesTrigger())
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: target, hidden: true })) })
    expect(newFilesShown()).toBe(target)
  })

  it('moves focus to the Filter button when the last chip is removed', () =>
  {
    seed([podcast(), job('b')])
    act(() => { useBatchView.getState().addFilter('queue', AUDIO_ONLY, modeRows('queue', useJobsStore.getState())) })
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Audio only' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Filter/ }))
  })

  it('opens one picker at a time', async () =>
  {
    const ref = createRef<ToolbarHandle>()
    const files = deferred<string[]>()
    const openFiles = vi.fn(() => files.promise)
    const openDirectory = vi.fn(async () => null)
    renderToolbar({ pickers: { openFiles, openDirectory }, props: { ref } })
    let first: Promise<void> | undefined
    act(() => { first = ref.current?.addFiles() })
    await act(async () => { await ref.current?.addFolder() })
    expect(openDirectory).not.toHaveBeenCalled()
    await act(async () =>
    {
      files.resolve([])
      await first
    })
    expect(openFiles).toHaveBeenCalledTimes(1)
  })
})
