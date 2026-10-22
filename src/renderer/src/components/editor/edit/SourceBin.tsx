/**
 * @module editor/edit/SourceBin
 * The timeline's sources as a list pane. Drag a source onto a track, or choose it as the edit source (click,
 * Enter, or Space) and place it with Insert, Overwrite, Append, or On top. Up and Down move through the list,
 * Delete removes the focused source.
 */
import { useCallback, useId, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { importSources } from '../open'
import { formatLength } from '../shared/format'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'
import { Waveform } from '../shared/Waveform'
import type { MediaSource } from '../types'
import { clearPendingDropSource, setPendingDropSource } from './Timeline'

/** The second line of a source: its length and picture size, or that it is audio. */
export function sourceDetail(source: Pick<MediaSource, 'durationSeconds' | 'width' | 'height' | 'audioChannels'>): string
{
  const parts = [formatLength(source.durationSeconds)]
  if (source.width > 0)
  {
    parts.push(`${source.width} × ${source.height}`)
  }
  else if (source.audioChannels > 0)
  {
    parts.push('Audio')
  }
  return parts.filter(Boolean).join(' · ')
}

/** Props of {@link SourceBin}. */
export interface SourceBinProps
{
  width: number
}

/** The pane. */
export function SourceBin({ width }: SourceBinProps): ReactElement
{
  const sources = useEditorStore((s) => s.sources)
  const removeSource = useEditorStore((s) => s.removeSource)
  const selectSource = useEditorStore((s) => s.selectSource)
  const selectedSourceId = useEditorStore((s) => s.selectedSourceId)
  const [importing, setImporting] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const headingId = useId()

  const handleImport = useCallback(async () =>
  {
    setImporting(true)
    try
    {
      const files: string[] | undefined = await window.api.openFiles()
      if (files && files.length > 0)
      {
        await importSources(files)
      }
    }
    finally
    {
      setImporting(false)
    }
  }, [])

  const focusRow = (index: number): void =>
  {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')
    if (!rows || rows.length === 0)
    {
      return
    }
    rows[Math.max(0, Math.min(rows.length - 1, index))].focus()
  }

  const toggle = (source: MediaSource): void =>
  {
    selectSource(selectedSourceId === source.id ? null : source.id)
  }

  const remove = (source: MediaSource, index: number): void =>
  {
    if (selectedSourceId === source.id)
    {
      selectSource(null)
    }
    removeSource(source.id)
    requestAnimationFrame(() => focusRow(index))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, source: MediaSource, index: number): void =>
  {
    switch (event.key)
    {
      case 'ArrowDown':
        focusRow(index + 1)
        break
      case 'ArrowUp':
        focusRow(index - 1)
        break
      case 'Home':
        focusRow(0)
        break
      case 'End':
        focusRow(sources.length - 1)
        break
      case 'Enter':
      case ' ':
        toggle(source)
        break
      case 'Delete':
        remove(source, index)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const onDragStart = (event: DragEvent, source: MediaSource): void =>
  {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('text/plain', source.id)
    setPendingDropSource(source.id)
  }

  const tabStop = focusedId !== null && sources.some((s) => s.id === focusedId) ? focusedId : selectedSourceId ?? sources[0]?.id

  return (
    <section aria-labelledby={headingId} style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-panel" data-pane="sources">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line ps-3 pe-2">
        <h2 id={headingId} className="text-body font-semibold text-ink">Sources</h2>
        <Button variant="ghost" size="sm" icon="action.addFiles" loading={importing} loadingLabel="Adding" onClick={() => void handleImport()}>
          Add files
        </Button>
      </div>
      {sources.length === 0
        ? <p className="px-3 py-4 text-body text-ink-3">Add files or drop them here to use them on the timeline.</p>
        : (
            <ul
              ref={listRef}
              role="listbox"
              aria-labelledby={headingId}
              aria-describedby={`${headingId}-hint`}
              className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-1"
            >
              {sources.map((source, index) =>
              {
                const selected = selectedSourceId === source.id
                return (
                  <li
                    key={source.id}
                    role="option"
                    aria-selected={selected}
                    tabIndex={source.id === tabStop ? 0 : -1}
                    draggable
                    data-source={source.id}
                    className={cx(
                      'group relative flex h-12 shrink-0 cursor-grab items-center gap-2 rounded-sm ps-2 pe-1 active:cursor-grabbing',
                      selected ? 'bg-wash-selected hover:bg-wash-selected-hover' : 'hover:bg-wash-hover'
                    )}
                    onFocus={() => setFocusedId(source.id)}
                    onClick={() => toggle(source)}
                    onKeyDown={(event) => onKeyDown(event, source, index)}
                    onDragStart={(event) => onDragStart(event, source)}
                    onDragEnd={clearPendingDropSource}
                  >
                    {selected && <span aria-hidden="true" className="absolute inset-y-1 start-0 w-0.5 rounded-xs bg-accent" />}
                    <span aria-hidden="true" className="flex h-7 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-sunken">
                      {source.width > 0
                        ? <ThumbnailStrip filePath={source.filePath} durationSeconds={source.durationSeconds} width={48} height={28} numThumbnails={1} />
                        : source.audioChannels > 0
                          ? <Waveform filePath={source.filePath} width={48} height={28} numSamples={48} />
                          : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body text-ink">{source.fileName}</span>
                      <span className="truncate text-label tabular-nums text-ink-3">{sourceDetail(source)}</span>
                    </span>
                    <IconButton
                      size="sm"
                      label={`Remove ${source.fileName} from the sources`}
                      icon="action.remove"
                      tabIndex={-1}
                      className={selected ? undefined : 'invisible group-hover:visible group-focus-visible:visible'}
                      onClick={(event) =>
                      {
                        event.stopPropagation()
                        remove(source, index)
                      }}
                    />
                  </li>
                )
              })}
            </ul>
          )}
      <p id={`${headingId}-hint`} className="shrink-0 border-t border-line px-3 py-2 text-label text-ink-3">
        The chosen source goes where Insert, Overwrite, Append, and On top place it.
      </p>
    </section>
  )
}
