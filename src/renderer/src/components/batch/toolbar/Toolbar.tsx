/**
 * The Batch view's table toolbar: the mode tabs, Add, Set operation, New files, search, the Filter menu with
 * its chips and counts, and Clear. The toolbar spans the view and is its own size container, so every collapse
 * reads the view's width: the container queries hide and shorten controls, and the same widths decide what moves
 * into a menu.
 */
import React, { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefObject } from 'react'
import { ariaKeyShortcuts, Button, cx, useAnnounce, usePlatform } from '../../../ui'
import { filterChips, filterMenu, filterRows, toolbarCounts, type BatchFilter, type FilterContext } from '../../../stores/batchFilters'
import { useJobsStore } from '../../../stores/jobs'
import { selectOrderedJobs } from '../../../stores/jobsSelectors'
import { activeViewKey, modeRows, useBatchView, type BatchMode, type FilterChange } from '../../../stores/batchView'
import type { Recipe } from '../../../../../shared/jobs/recipes'
import type { RecentFolder } from '../../../../../shared/jobs/types'
import { useBatchActions } from '../BatchActionsContext'
import { AddMenu } from './AddMenu'
import { ClearMenu, clearCounts } from './ClearMenu'
import { FilterChips } from './FilterChips'
import { FilterMenu } from './FilterMenu'
import { ModeTabs } from './ModeTabs'
import { NEW_FILES_LOADING, NewFilesGetSelect, newFilesSubmenu, useNewFilesChoice } from './NewFilesGetSelect'
import { RecipePicker, type RecipePickerHandle } from './RecipePicker'
import { HISTORY_SEARCH_PLACEHOLDER, SearchField, type SearchFieldHandle } from './SearchField'

/** The view widths, in px, at which the toolbar gives up room, widest first. */
export const TOOLBAR_WIDTHS = Object.freeze({ full: 1180, medium: 1000, compact: 880, narrow: 700 })

/** What the toolbar shows at a view width; null before the first measurement reads as the full toolbar. */
export interface ToolbarLayout
{
  /** Chips wrap to a second line instead of giving way to "+{n} filters". */
  wrapChips: boolean
  /** The search field is an icon button that expands over the toolbar. */
  searchCollapsed: boolean
  /** "New files" is a submenu of the Add menu, and Set operation reads "Set". */
  newFilesInAddMenu: boolean
  /** Clear belongs to the batch overflow menu, and the "Inspector" toggle shows. */
  clearInOverflow: boolean
  /** Add and Filter keep only their icons. */
  iconsOnly: boolean
}

/** The toolbar's layout at a view width, following the responsive table of the Batch view. */
export function toolbarLayout(width: number | null): ToolbarLayout
{
  const measured = width !== null && width > 0
  const below = (limit: number): boolean => measured && width < limit
  return {
    wrapChips: !below(TOOLBAR_WIDTHS.full),
    searchCollapsed: below(TOOLBAR_WIDTHS.medium),
    newFilesInAddMenu: below(TOOLBAR_WIDTHS.medium),
    clearInOverflow: below(TOOLBAR_WIDTHS.compact),
    iconsOnly: below(TOOLBAR_WIDTHS.narrow)
  }
}

/** The width of an element, kept current as it resizes; null until measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null
{
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element === null)
    {
      return
    }
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined')
    {
      return
    }
    const observer = new ResizeObserver((entries) =>
    {
      const entry = entries[entries.length - 1]
      setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** The words of the toolbar's own buttons. */
export const TOOLBAR_COPY = Object.freeze({
  applyRecipe: 'Set operation',
  apply: 'Set',
  selectFirst: 'Select jobs first.',
  inspector: 'Inspector'
})

/** The modes that assign recipes. */
const ASSIGNING: readonly BatchMode[] = ['queue', 'review']

/** The window's file pickers, parented to the window by main. */
export interface ToolbarPickers
{
  openFiles(): Promise<string[]>
  openDirectory(): Promise<string | null>
}

const WINDOW_PICKERS: ToolbarPickers = {
  openFiles: () => window.api.openFiles(),
  openDirectory: () => window.api.openDirectory()
}

/** What the page's shortcuts call: Ctrl+F, Ctrl+K, Ctrl+O, Ctrl+Shift+O, and Ctrl+V with the table focused. */
export interface ToolbarHandle
{
  /** Focuses the search field, expanding it first when collapsed. */
  focusSearch(): void
  /**
   * Opens the recipe picker for the selection in Queue and Review; says "Select jobs first." while nothing is
   * selected, and does nothing in the other modes.
   */
  openRecipePicker(): void
  /** Opens the file picker and adds what it returns; nothing while a picker is open. */
  addFiles(): Promise<void>
  /** Opens the folder picker and adds the folder; nothing while a picker is open. */
  addFolder(): Promise<void>
  pasteFiles(): Promise<void>
}

/** Props of Toolbar. */
export interface ToolbarProps
{
  /** The table, which takes focus back when the recipe picker closes. */
  tableElement?(): HTMLElement | null
  /** With onToggleInspector, the "Inspector" toggle shows while the view is too narrow to dock the inspector. */
  inspectorOpen?: boolean
  onToggleInspector?(): void
  /** The inspector region's id, which the toggle controls. */
  inspectorId?: string
  /** Where a second Escape in the search field sends focus, such as the table. */
  onSearchLeave?(): void
  /** What the list's filters read, such as the preset lookup that decides Edited; the table takes the same. */
  filterContext?: FilterContext
  /** The file pickers; the window's dialogs by default. */
  pickers?: ToolbarPickers
  className?: string
  ref?: Ref<ToolbarHandle>
}

/** The table toolbar of the Batch view. */
export function Toolbar({
  tableElement,
  inspectorOpen = false,
  onToggleInspector,
  inspectorId,
  onSearchLeave,
  filterContext,
  pickers = WINDOW_PICKERS,
  className,
  ref
}: ToolbarProps): React.JSX.Element
{
  const actions = useBatchActions()
  const announce = useAnnounce()
  const platform = usePlatform()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<SearchFieldHandle>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<RecipePickerHandle>(null)
  const layout = toolbarLayout(useElementWidth(rootRef))

  const mode = useBatchView((state) => state.mode)
  const key = useBatchView(activeViewKey)
  const runAvailable = useBatchView((state) => state.runAvailable)
  const filters = useBatchView((state) => state.views[activeViewKey(state)].filters)
  const selection = useBatchView((state) => state.views[activeViewKey(state)].selection.selected)
  const selected = selection.size
  const historyQuery = useBatchView((state) => state.history.query)
  const jobsState = useJobsStore()
  const { settings, recentFolders, defaultRecipe, presets } = jobsState
  const includeSubfolders = settings?.includeSubfolders ?? true
  const history = mode === 'history'

  const everyJob = useMemo(() => selectOrderedJobs(jobsState), [jobsState])
  const rows = useMemo(() => modeRows(mode, jobsState), [mode, jobsState])
  const visible = useMemo(() => filterRows(rows, filters, filterContext).length, [rows, filters, filterContext])
  const groups = useMemo(() => filterMenu(rows, filters, filterContext), [rows, filters, filterContext])
  const chips = useMemo(() => filterChips(filters), [filters])
  const clear = useMemo(() => clearCounts(everyJob), [everyJob])
  const counts = toolbarCounts(filters, visible, rows.length, selected)
  const countsText = [counts.showing, counts.selected].filter((part) => part !== null).join(' · ')
  const assigning = ASSIGNING.includes(mode)
  const selectedJobs = useMemo(() => rows.filter((row) => selection.has(row.id)), [rows, selection])
  const pickerPresets = assigning && selectedJobs.length > 0 ? presets : null

  const [picking, setPicking] = useState(false)
  const pickingRef = useRef(false)

  const pick = useCallback(async <T,>(open: () => Promise<T>): Promise<T | null> =>
  {
    if (pickingRef.current)
    {
      return null
    }
    pickingRef.current = true
    setPicking(true)
    try
    {
      return await open()
    }
    finally
    {
      pickingRef.current = false
      setPicking(false)
    }
  }, [])

  const addFiles = useCallback(async (): Promise<void> =>
  {
    const paths = await pick(() => pickers.openFiles())
    if (paths !== null && paths.length > 0)
    {
      await actions.addPaths(paths, { origin: 'files' })
    }
  }, [actions, pick, pickers])

  const addFolder = useCallback(async (): Promise<void> =>
  {
    const folder = await pick(() => pickers.openDirectory())
    if (folder !== null && folder !== '')
    {
      await actions.addPaths([folder], { origin: 'folder' })
    }
  }, [actions, pick, pickers])

  const pasteFiles = useCallback(async (): Promise<void> =>
  {
    await actions.pasteFiles()
  }, [actions])

  const openRecent = useCallback((folder: RecentFolder): void =>
  {
    void actions.addPaths([folder.path], { origin: 'folder' })
  }, [actions])

  const chooseNewFiles = useCallback(async (recipe: Recipe): Promise<boolean> =>
  {
    const outcome = await actions.send('setDefaultRecipe', { recipe })
    if (outcome.status !== 'done')
    {
      announce(outcome.message)
      return false
    }
    return true
  }, [actions, announce])

  const newFiles = useNewFilesChoice(defaultRecipe, presets, chooseNewFiles)

  const openRecipePicker = useCallback((): void =>
  {
    if (!assigning)
    {
      return
    }
    if (pickerRef.current === null)
    {
      announce(TOOLBAR_COPY.selectFirst)
      return
    }
    pickerRef.current.open()
  }, [assigning, announce])

  useImperativeHandle(ref, () => ({
    focusSearch: () => searchRef.current?.focus(),
    openRecipePicker,
    addFiles,
    addFolder,
    pasteFiles
  }), [openRecipePicker, addFiles, addFolder, pasteFiles])

  const changeMode = (next: BatchMode): void =>
  {
    const change = useBatchView.getState().setMode(next)
    if (change.announcement !== null)
    {
      announce(change.announcement)
    }
  }

  const said = (change: FilterChange): void =>
  {
    if (change.announcement !== null)
    {
      announce(change.announcement)
    }
  }

  const search = (text: string): void =>
  {
    const view = useBatchView.getState()
    if (history)
    {
      view.setHistoryQuery(text)
      return
    }
    said(view.setSearch(key, text, rows, filterContext))
  }

  const toggleFilter = (filter: BatchFilter): void => said(useBatchView.getState().toggleFilter(key, filter, rows, filterContext))
  const removeFilter = (filter: BatchFilter): void => said(useBatchView.getState().removeFilter(key, filter, rows, filterContext))
  const clearFilters = (): void => said(useBatchView.getState().clearFilters(key, rows, filterContext))

  return (
    <div
      ref={rootRef}
      data-batch-toolbar=""
      className={cx('@container relative min-h-11 shrink-0 border-b border-line bg-ground', className)}
    >
      <div className="flex min-h-11 items-center gap-2 px-4 py-1.5">
        <ModeTabs mode={mode} runAvailable={runAvailable} queueCount={jobsState.order.length} onChange={changeMode} />
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
        <AddMenu
          picking={picking}
          includeSubfolders={includeSubfolders}
          recentFolders={recentFolders}
          newFiles={layout.newFilesInAddMenu ? newFilesSubmenu(newFiles.groups, newFiles.value, newFiles.choose) : null}
          labelClassName="@max-[699px]:sr-only"
          onAddFiles={() => void addFiles()}
          onAddFolder={() => void addFolder()}
          onPaste={() => void pasteFiles()}
          onToggleSubfolders={() => void actions.send('setSettings', { settings: { includeSubfolders: !includeSubfolders } })}
          onOpenRecent={openRecent}
          onClearRecent={() => void actions.send('clearRecentFolders', {})}
        />
        {pickerPresets !== null
          ? <RecipePicker ref={pickerRef} jobs={selectedJobs} presets={pickerPresets} returnFocus={tableElement} />
          : assigning
            ? (
              <Button
                aria-keyshortcuts={ariaKeyShortcuts(['Mod', 'K'], platform)}
                unavailableReason={selected === 0 ? TOOLBAR_COPY.selectFirst : NEW_FILES_LOADING}
              >
                <span className="@max-[999px]:hidden">{TOOLBAR_COPY.applyRecipe}</span>
                <span className="hidden @max-[999px]:inline">{TOOLBAR_COPY.apply}</span>
              </Button>
              )
            : null}
        <NewFilesGetSelect choice={newFiles} className="flex min-w-0 shrink items-center gap-2 @max-[999px]:hidden" />
        <SearchField
          key={mode}
          ref={searchRef}
          value={history ? historyQuery : filters.search}
          onSearch={search}
          placeholder={history ? HISTORY_SEARCH_PLACEHOLDER : undefined}
          noMatches={!history && filters.search.trim() !== '' && visible === 0}
          collapsed={layout.searchCollapsed}
          onLeave={onSearchLeave}
        />
        {history
          ? <span className="flex-1" />
          : (
            <>
              <FilterMenu
                groups={groups}
                active={chips.length}
                onToggle={toggleFilter}
                onClear={clearFilters}
                triggerRef={filterRef}
                labelClassName="@max-[699px]:sr-only"
              />
              <div className="flex min-w-0 flex-1 items-center">
                <FilterChips
                  chips={chips}
                  onRemove={removeFilter}
                  wrap={layout.wrapChips}
                  counts={countsText === '' ? null : countsText}
                  onEmptied={() => filterRef.current?.focus()}
                  renderOverflow={(label) => (
                    <FilterMenu
                      groups={groups}
                      active={chips.length}
                      onToggle={toggleFilter}
                      onClear={clearFilters}
                      trigger={<Button size="sm" variant="ghost">{label}</Button>}
                    />
                  )}
                />
              </div>
              <div className="flex shrink-0 @max-[879px]:hidden">
                <ClearMenu counts={clear} onClear={(scope) => void actions.clear(scope)} />
              </div>
            </>
            )}
        {onToggleInspector === undefined
          ? null
          : (
            <div className="hidden shrink-0 @max-[879px]:flex">
              <Button
                variant="ghost"
                aria-expanded={inspectorOpen}
                aria-controls={inspectorId}
                aria-keyshortcuts={ariaKeyShortcuts(['Mod', 'I'], platform)}
                className={inspectorOpen ? 'text-mark' : undefined}
                onClick={onToggleInspector}
              >
                {TOOLBAR_COPY.inspector}
              </Button>
            </div>
            )}
      </div>
    </div>
  )
}
