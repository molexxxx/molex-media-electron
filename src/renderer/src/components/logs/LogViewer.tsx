/**
 * @module components/logs/LogViewer
 * @description The Logs view: every line main and its jobs wrote, as a dense list a power user can scan, filter, and
 * act on. A level control, a Sources menu, search, and Follow new lines narrow and track the list; Copy, Open log
 * folder, and Clear act on it. "Show log" from Batch narrows the view to one job or batch, read from main's buffer,
 * and a job's complete FFmpeg output opens beside its lines. A selected line opens in full in the details pane.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useAppStore, type LogEntry } from '../../stores/appStore'
import { useF6Region } from '../../hooks/useF6Region'
import {
  Button,
  IconButton,
  InlineConfirm,
  Menu,
  SegmentedControl,
  Splitter,
  Switch,
  toast,
  type GridDensity,
  type GridSelectionState,
  type MenuEntry,
  type SegmentOption
} from '../../ui'
import type { JobId } from '../../../../shared/jobs/ids'
import { SearchField, type SearchFieldHandle } from '../batch/toolbar/SearchField'
import { FullOutputPanel } from './FullOutputPanel'
import { LogDetails } from './LogDetails'
import { LogTable } from './LogTable'
import { windowLogApi, writeClipboard, type LogViewerApi } from './logApi'
import {
  copiedText,
  emptyWords,
  formatLogLines,
  isNarrowed,
  LOG_FILTER_WORDS,
  LOG_SOURCES,
  LOG_WORDS,
  logFilterLabel,
  matchesLogFilter,
  mergeLogEntries,
  NO_NARROWING,
  rowId,
  SOURCE_MENU_LABELS,
  sourceCounts,
  sourcesButtonText,
  summaryLine,
  visibleLogEntries,
  type LevelFilter,
  type LogSource
} from './logModel'
import { showJobInBatch } from './showJob'

export { FullOutputPanel } from './FullOutputPanel'
export { windowLogApi, type JobLogResult, type LogViewerApi } from './logApi'
export { LOG_FILTER_WORDS, logFilterLabel, matchesLogFilter, mergeLogEntries, visibleLogEntries } from './logModel'

/** The details pane's heights: the default, the limits, and the sizes the Pane height menu offers. */
export const DETAILS_HEIGHT = Object.freeze({ default: 240, min: 120, short: 160, tall: 420, reserve: 200 })

/** Where the details pane's height is kept between sessions. */
export const DETAILS_HEIGHT_KEY = 'molex.logs.detailsHeight'

const LEVEL_OPTIONS: ReadonlyArray<SegmentOption<LevelFilter>> = [
  { value: 'all', label: LOG_WORDS.levelAll },
  { value: 'info', label: LOG_WORDS.levelInfo },
  { value: 'warning', label: LOG_WORDS.levelWarnings },
  { value: 'error', label: LOG_WORDS.levelErrors }
]

const NO_SELECTION: GridSelectionState = { selected: new Set(), anchor: null, focus: null }

/** The details height kept from an earlier session, or the default. */
export function readDetailsHeight(storage: Pick<Storage, 'getItem'> | null = safeStorage()): number
{
  try
  {
    const value = Number(storage?.getItem(DETAILS_HEIGHT_KEY))
    return Number.isFinite(value) && value >= DETAILS_HEIGHT.min ? Math.round(value) : DETAILS_HEIGHT.default
  }
  catch
  {
    return DETAILS_HEIGHT.default
  }
}

function safeStorage(): Storage | null
{
  try
  {
    return typeof localStorage === 'undefined' ? null : localStorage
  }
  catch
  {
    return null
  }
}

function writeDetailsHeight(height: number): void
{
  try
  {
    safeStorage()?.setItem(DETAILS_HEIGHT_KEY, String(height))
  }
  catch
  {
    return
  }
}

/** The height of an element, kept current as it resizes; null until measured. */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number | null
{
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined')
    {
      return undefined
    }
    const observer = new ResizeObserver((entries) =>
    {
      const entry = entries[entries.length - 1]
      setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/** Props for {@link LogViewer}. */
export interface LogViewerProps
{
  /** The calls into main; the preload bridge by default. */
  api?: LogViewerApi
  /** Opens a job in Batch; {@link showJobInBatch} by default. */
  onShowJob?: (entry: LogEntry) => void
}

export default function LogViewer({ api: apiProp, onShowJob }: LogViewerProps = {}): React.JSX.Element
{
  const liveLogs = useAppStore((s) => s.logs)
  const clearStoreLogs = useAppStore((s) => s.clearLogs)
  const logFilter = useAppStore((s) => s.logFilter)
  const clearLogFilter = useAppStore((s) => s.clearLogFilter)
  const showLog = useAppStore((s) => s.showLog)
  const visible = useAppStore((s) => s.currentView === 'logs')
  const [api] = useState<LogViewerApi>(() => apiProp ?? windowLogApi())
  const [level, setLevel] = useState<LevelFilter>('all')
  const [hiddenSources, setHiddenSources] = useState<ReadonlySet<LogSource>>(() => new Set())
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const [fetched, setFetched] = useState<LogEntry[] | null>(null)
  const [selection, setSelection] = useState<GridSelectionState>(NO_SELECTION)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsHeight, setDetailsHeight] = useState(() => readDetailsHeight())
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])
  const [density, setDensity] = useState<GridDensity>('compact')
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [copiedAll, setCopiedAll] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const detailsRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<SearchFieldHandle>(null)
  const clearRef = useRef<HTMLButtonElement>(null)
  const followRef = useRef(follow)
  const lastTop = useRef(0)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followId = useId()
  const detailsId = useId()
  const rootHeight = useElementHeight(rootRef)
  followRef.current = follow

  useF6Region('logs', [
    { name: 'header', ref: headerRef },
    { name: 'toolbar', ref: toolbarRef },
    { name: 'list', ref: listRef },
    { name: 'details', ref: detailsRef }
  ])

  useEffect(() =>
  {
    setFetched(null)
    setSelection(NO_SELECTION)
    if (logFilter === null)
    {
      return undefined
    }
    setLevel('all')
    setHiddenSources(new Set())
    setSearch('')
    let disposed = false
    api.getLogBuffer(logFilter).then(
      (entries) =>
      {
        if (!disposed)
        {
          setFetched(entries.filter((entry) => matchesLogFilter(entry, logFilter)))
        }
      },
      () => undefined
    )
    return () =>
    {
      disposed = true
    }
  }, [api, logFilter])

  useEffect(() => () =>
  {
    if (copiedTimer.current !== null)
    {
      clearTimeout(copiedTimer.current)
    }
  }, [])

  const scope = useMemo(() => mergeLogEntries(fetched, liveLogs, logFilter), [fetched, liveLogs, logFilter])
  const narrowing = useMemo(() => ({ level, hiddenSources, search }), [level, hiddenSources, search])
  const shown = useMemo(() => visibleLogEntries(scope, narrowing), [scope, narrowing])
  const counts = useMemo(() => sourceCounts(scope), [scope])
  const present = LOG_SOURCES.filter((source) => counts.has(source) || hiddenSources.has(source))
  const selectedEntries = useMemo(
    () => shown.filter((entry, index) => selection.selected.has(rowId(entry, index))),
    [shown, selection]
  )
  const filterLabel = logFilter === null ? null : logFilterLabel(logFilter)
  const empty = emptyWords(scope.length, logFilter)
  const anything = liveLogs.length > 0 || (fetched?.length ?? 0) > 0

  const gridElement = useCallback((): HTMLElement | null => listRef.current?.querySelector<HTMLElement>('[role="grid"]') ?? null, [])

  useLayoutEffect(() =>
  {
    const grid = gridElement()
    if (!follow || !visible || grid === null)
    {
      return
    }
    grid.scrollTop = grid.scrollHeight
    lastTop.current = grid.scrollTop
  }, [shown, follow, visible, detailsOpen, gridElement])

  const hasRows = shown.length > 0
  useEffect(() =>
  {
    const grid = gridElement()
    if (grid === null)
    {
      return undefined
    }
    lastTop.current = grid.scrollTop
    const onScroll = (): void =>
    {
      const top = grid.scrollTop
      const previous = lastTop.current
      lastTop.current = top
      const atBottom = grid.scrollHeight - top - grid.clientHeight < 4
      if (followRef.current && top < previous - 1 && !atBottom)
      {
        setFollow(false)
      }
      else if (!followRef.current && atBottom && top > previous)
      {
        setFollow(true)
      }
    }
    grid.addEventListener('scroll', onScroll, { passive: true })
    return () => grid.removeEventListener('scroll', onScroll)
  }, [hasRows, gridElement])

  useEffect(() =>
  {
    let frame = 0
    const enter = (): void =>
    {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
      {
        const root = rootRef.current
        if (root === null || root.contains(root.ownerDocument.activeElement))
        {
          return
        }
        const target = root.querySelector<HTMLElement>('[role="grid"] [role="row"][tabindex="0"]') ?? root.querySelector<HTMLElement>('input[type="search"]')
        target?.focus({ preventScroll: true })
      })
    }
    if (useAppStore.getState().currentView === 'logs')
    {
      enter()
    }
    const unsubscribe = useAppStore.subscribe((next, previous) =>
    {
      if (next.currentView === 'logs' && previous.currentView !== 'logs')
      {
        enter()
      }
    })
    return () =>
    {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [])

  const focusList = (): void =>
  {
    const row = listRef.current?.querySelector<HTMLElement>('[role="row"][tabindex="0"]')
    if (row)
    {
      row.focus({ preventScroll: true })
      return
    }
    gridElement()?.focus()
  }

  const copy = async (entries: readonly LogEntry[]): Promise<boolean> =>
  {
    if (entries.length === 0 || !(await writeClipboard(formatLogLines(entries))))
    {
      return false
    }
    toast.show({ tone: 'info', title: copiedText(entries.length), key: 'logs:copied' })
    return true
  }

  const copyShown = async (): Promise<void> =>
  {
    if (await copy(shown))
    {
      setCopiedAll(true)
      if (copiedTimer.current !== null)
      {
        clearTimeout(copiedTimer.current)
      }
      copiedTimer.current = setTimeout(() => setCopiedAll(false), 1500)
    }
  }

  const copyCommand = async (command: string): Promise<void> =>
  {
    if (await writeClipboard(command))
    {
      toast.show({ tone: 'info', title: 'Copied the FFmpeg command.', key: 'logs:copied' })
    }
  }

  const openDetails = (id: string): void =>
  {
    if (!selection.selected.has(id))
    {
      setSelection({ selected: new Set([id]), anchor: id, focus: id })
    }
    setDetailsOpen(true)
  }

  const closeDetails = (): void =>
  {
    setDetailsOpen(false)
    requestAnimationFrame(focusList)
  }

  const showJob = (entry: LogEntry): void =>
  {
    if (onShowJob)
    {
      onShowJob(entry)
      return
    }
    if (entry.jobId !== undefined)
    {
      showJobInBatch(entry.jobId, entry.runId)
    }
  }

  const clearNarrowing = (): void =>
  {
    setLevel(NO_NARROWING.level)
    setHiddenSources(new Set())
    setSearch('')
    requestAnimationFrame(focusList)
  }

  const toggleSource = (source: LogSource): void =>
  {
    setHiddenSources((current) =>
    {
      const next = new Set(current)
      if (next.has(source))
      {
        next.delete(source)
      }
      else
      {
        next.add(source)
      }
      return next
    })
  }

  const resolveClear = (confirmed: boolean): void =>
  {
    setConfirmingClear(false)
    if (!confirmed)
    {
      return
    }
    clearStoreLogs()
    setFetched((current) => (current === null ? null : []))
    setSelection(NO_SELECTION)
    void api.clearLogs()
  }

  const handleClearFilter = (): void =>
  {
    clearLogFilter()
    searchRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void =>
  {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f')
    {
      event.preventDefault()
      searchRef.current?.focus()
    }
  }

  const sourceEntries: MenuEntry[] = [
    {
      group: LOG_WORDS.sources,
      items: present.map((source) => ({
        kind: 'checkbox' as const,
        id: `source-${source}`,
        label: `${SOURCE_MENU_LABELS[source]} (${counts.get(source) ?? 0})`,
        checked: !hiddenSources.has(source),
        onSelect: () => toggleSource(source)
      }))
    },
    'separator',
    hiddenSources.size === 0
      ? { id: 'every-source', label: LOG_WORDS.showEverySource, disabled: true, disabledReason: LOG_WORDS.everySourceShown, onSelect: () => setHiddenSources(new Set()) }
      : { id: 'every-source', label: LOG_WORDS.showEverySource, onSelect: () => setHiddenSources(new Set()) }
  ]

  const maxDetails = Math.max(DETAILS_HEIGHT.min, (rootHeight ?? 640) - DETAILS_HEIGHT.reserve)
  const paneHeight = Math.min(detailsHeight, maxDetails)
  const heightEntries: MenuEntry[] = [{
    group: LOG_WORDS.paneHeight,
    items: [
      { kind: 'radio', group: 'height', id: 'short', label: 'Short', checked: paneHeight === DETAILS_HEIGHT.short, onSelect: () => commitHeight(DETAILS_HEIGHT.short) },
      { kind: 'radio', group: 'height', id: 'medium', label: 'Medium', checked: paneHeight === DETAILS_HEIGHT.default, onSelect: () => commitHeight(DETAILS_HEIGHT.default) },
      { kind: 'radio', group: 'height', id: 'tall', label: 'Tall', checked: paneHeight === Math.min(DETAILS_HEIGHT.tall, maxDetails), onSelect: () => commitHeight(DETAILS_HEIGHT.tall) }
    ]
  }]

  function commitHeight(height: number): void
  {
    const next = Math.max(DETAILS_HEIGHT.min, Math.min(height, maxDetails))
    setDetailsHeight(next)
    writeDetailsHeight(next)
  }

  return (
    <section
      ref={rootRef}
      aria-label={LOG_WORDS.title}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-ground text-ink"
      onKeyDown={onKeyDown}
    >
      <header ref={headerRef} className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-3">
        <div className="min-w-0">
          <h1 className="text-title text-ink">{LOG_WORDS.title}</h1>
          <p className="mt-0.5 text-body tabular-nums text-ink-2">{summaryLine(scope, shown.length, logFilter)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pt-1">
          <Button
            icon="action.copy"
            unavailableReason={shown.length === 0 ? LOG_WORDS.nothingToCopy : undefined}
            onClick={() => { void copyShown() }}
          >
            {copiedAll ? LOG_WORDS.copied : LOG_WORDS.copyLines}
          </Button>
          <Button icon="action.reveal" onClick={() => { void api.openLogDir() }}>{LOG_WORDS.openFolder}</Button>
          {confirmingClear
            ? (
              <InlineConfirm
                question={LOG_WORDS.clearQuestion}
                safeLabel={LOG_WORDS.keepLines}
                confirmLabel={LOG_WORDS.clearLines}
                danger
                wrap={false}
                fallbackFocus={() => clearRef.current}
                onResolve={resolveClear}
              />
              )
            : (
              <Button
                ref={clearRef}
                variant="danger"
                icon="action.trash"
                unavailableReason={anything ? undefined : LOG_WORDS.nothingToClear}
                onClick={() => setConfirmingClear(true)}
              >
                {LOG_WORDS.clear}
              </Button>
              )}
        </div>
      </header>
      <div ref={toolbarRef} role="group" aria-label="Log filters" className="shrink-0 border-y border-line">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-1.5">
          <SegmentedControl<LevelFilter> label={LOG_WORDS.levelLabel} value={level} onChange={setLevel} options={LEVEL_OPTIONS} />
          <Menu
            label={LOG_WORDS.sources}
            filterList
            items={sourceEntries}
            trigger={(
              <Button variant="ghost" icon="action.filter" iconEnd="action.openMenu" className={hiddenSources.size > 0 ? 'text-mark' : undefined}>
                {sourcesButtonText(present, hiddenSources)}
              </Button>
            )}
          />
          <SearchField
            ref={searchRef}
            value={search}
            onSearch={setSearch}
            placeholder={LOG_WORDS.searchPlaceholder}
            noMatches={search.trim() !== '' && shown.length === 0}
            onLeave={focusList}
            className="min-w-0 flex-1 [&>[role=search]]:w-full [&>[role=search]]:max-w-80"
          />
          <span className="flex shrink-0 items-center gap-2">
            <Switch id={followId} checked={follow} onChange={setFollow} />
            <label htmlFor={followId} className="text-control text-ink-2">{LOG_WORDS.follow}</label>
          </span>
        </div>
        {logFilter !== null && filterLabel !== null && (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line px-4 py-2">
            <span data-part="log-filter" className="inline-flex h-7 items-center gap-1 rounded-sm border border-line-strong bg-raised pl-2 text-label text-ink-2">
              <span>
                {LOG_FILTER_WORDS.filteredTo} <span className="tabular-nums text-ink">{filterLabel}</span>
              </span>
              <IconButton icon="action.close" label={LOG_FILTER_WORDS.clear} size="sm" variant="ghost" tooltip onClick={handleClearFilter} />
            </span>
            {'jobId' in logFilter && (
              <FullOutputPanel key={logFilter.jobId} jobId={logFilter.jobId as JobId} api={api} />
            )}
          </div>
        )}
      </div>
      <div ref={listRef} data-part="log-list" className="flex min-h-0 flex-1 flex-col">
        {hasRows
          ? (
            <LogTable
              entries={shown}
              selection={selection}
              onSelectionChange={setSelection}
              hiddenColumns={hiddenColumns}
              onHiddenColumnsChange={setHiddenColumns}
              density={density}
              onDensityChange={setDensity}
              onOpen={openDetails}
              onCopy={(entries) => { void copy(entries) }}
              onCopyCommand={(command) => { void copyCommand(command) }}
              onShowJob={showJob}
              onFilterJob={(jobId) => showLog({ jobId })}
              filter={logFilter}
              className="min-h-0 flex-1"
            />
            )
          : (
            <div data-part="log-empty" className="mx-auto flex w-full max-w-2xl flex-col items-start gap-2 px-6 pt-[min(12vh,7rem)] pb-6">
              <h2 className="text-section text-ink">{empty.title}</h2>
              <p className="max-w-[65ch] text-body text-ink-2">{empty.body}</p>
              {empty.narrowed && isNarrowed(narrowing) && (
                <Button className="mt-2" onClick={clearNarrowing}>{LOG_WORDS.clearFilters}</Button>
              )}
            </div>
            )}
      </div>
      {detailsOpen && (
        <>
          <Splitter
            orientation="horizontal"
            pane="after"
            label={LOG_WORDS.detailsHeight}
            value={paneHeight}
            min={DETAILS_HEIGHT.min}
            max={maxDetails}
            defaultValue={DETAILS_HEIGHT.default}
            onChange={setDetailsHeight}
            onCommit={commitHeight}
          />
          <div ref={detailsRef} className="flex min-h-0 shrink-0 flex-col" style={{ height: paneHeight }}>
            <LogDetails
              id={detailsId}
              entries={selectedEntries}
              onClose={closeDetails}
              onCopy={(entries) => { void copy(entries) }}
              onCopied={() => toast.show({ tone: 'info', title: 'Copied the FFmpeg command.', key: 'logs:copied' })}
              onShowJob={showJob}
              heightMenu={<Menu label={LOG_WORDS.paneHeight} items={heightEntries} align="end" trigger={<IconButton icon="popout.size" label={LOG_WORDS.paneHeight} size="sm" tooltip />} />}
              className="min-h-0 flex-1"
            />
          </div>
        </>
      )}
    </section>
  )
}
