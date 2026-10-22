/**
 * @module editor/inspect/InspectEditor
 * Inspect: the active file's ffprobe report as quiet name and value lists spanning the pane: the file, every stream,
 * the tags, and the keyframes, each value plain first and technical second with a Copy button. The header copies the
 * path or the whole report and opens the file in Trim. Leaving streams out or editing tags enables Save a copy,
 * which remuxes losslessly to a new file.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import { Menu } from '../../../ui/Menu'
import { FieldMessage } from '../../../ui/NumberField'
import { ProgressBar } from '../../../ui/ProgressBar'
import { KeyframeView } from './KeyframeView'
import { containerFacts, hasVideo, parseReport, reportFromProbe, reportText, type ProbeReport, type ReportStream } from './report'
import { FactList, StreamSection, useCopy } from './StreamInfo'

/** One tag row while editing; the id keeps a row's fields in place while its name changes. */
interface TagRow
{
  id: string
  key: string
  value: string
}

/** The report Inspect shows, and the raw ffprobe text when it came from ffprobe's own report. */
interface Loaded
{
  report: ProbeReport
  raw: string | null
}

const TEXT_FRAME = [
  'h-7 w-full min-w-0 rounded-sm border border-line-control bg-sunken px-2 text-body text-ink',
  'placeholder:text-ink-3 transition-colors duration-fast ease-out hover:border-line-control-hover'
].join(' ')

/** Every stream index of the report, in order. */
export function allStreamIndices(streams: readonly Pick<ReportStream, 'index'>[]): number[]
{
  return streams.map((s) => s.index).sort((a, b) => a - b)
}

/** The edited tags as the record the remux writes; a later row wins a repeated name. */
export function tagsRecord(rows: readonly TagRow[]): Record<string, string>
{
  const record: Record<string, string> = {}
  for (const row of rows)
  {
    record[row.key] = row.value
  }
  return record
}

/** Whether the edited tags differ from the file's. */
export function tagsChanged(original: Record<string, string> | undefined, edited: Record<string, string>): boolean
{
  const before = original ?? {}
  const beforeKeys = Object.keys(before).sort()
  const afterKeys = Object.keys(edited).sort()
  if (beforeKeys.length !== afterKeys.length)
  {
    return true
  }
  return beforeKeys.some((key, i) => key !== afterKeys[i] || before[key] !== edited[afterKeys[i]])
}

/** The options the remux receives: the kept streams, and the tags only when they were edited. */
export function remuxOptions(kept: ReadonlySet<number>, editing: boolean, original: Record<string, string> | undefined, rows: readonly TagRow[]): { keepStreams: number[], metadata?: Record<string, string> }
{
  const options: { keepStreams: number[], metadata?: Record<string, string> } = { keepStreams: [...kept].sort((a, b) => a - b) }
  const edited = tagsRecord(rows)
  if (editing && tagsChanged(original, edited))
  {
    options.metadata = edited
  }
  return options
}

/** Reads ffprobe's own report, and falls back to the app's probe when that report cannot be read. */
export async function loadReport(filePath: string): Promise<Loaded>
{
  const answer = await window.api.probeReport(filePath).catch(() => null)
  if (answer?.success)
  {
    const report = parseReport(answer.report)
    if (report)
    {
      return { report, raw: answer.report }
    }
  }
  const probe = await window.api.probeDetailed(filePath)
  if (!probe?.success || !probe.data)
  {
    throw new Error(probe?.error || 'FFprobe could not read it')
  }
  return { report: reportFromProbe(probe.data), raw: null }
}

let rowCounter = 0

function toRows(tags: Record<string, string> | undefined): TagRow[]
{
  return Object.entries(tags ?? {}).map(([key, value]) => ({ id: `tag-${++rowCounter}`, key, value }))
}

function baseName(filePath: string): string
{
  return filePath.split(/[\\/]/).pop() || filePath
}

/** Inspect for the active file; nothing while no file is open. */
export function InspectEditor(): ReactElement | null
{
  const sources = useEditorStore((s) => s.sources)
  const sourceId = useEditorStore((s) => s.clipMode.sourceId)
  const source = sources.find((s) => s.id === sourceId)
  if (!source)
  {
    return null
  }
  return <InspectFile key={source.id} filePath={source.filePath} fileName={source.fileName} durationSeconds={source.durationSeconds} />
}

function InspectFile({ filePath, fileName, durationSeconds }: { filePath: string, fileName: string, durationSeconds: number }): ReactElement
{
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [kept, setKept] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<TagRow[]>([])
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ success: boolean, message: string } | null>(null)
  const { copied, copy } = useCopy()
  const ids = { file: useId(), streams: useId(), tags: useId() }

  useEffect(() =>
  {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadReport(filePath)
      .then((next) =>
      {
        if (cancelled)
        {
          return
        }
        setLoaded(next)
        setKept(new Set(allStreamIndices(next.report.streams)))
        setRows(toRows(next.report.format.tags))
        setEditing(false)
      })
      .catch((caught: Error) =>
      {
        if (!cancelled)
        {
          setError(caught.message)
        }
      })
      .finally(() =>
      {
        if (!cancelled)
        {
          setLoading(false)
        }
      })
    return () =>
    {
      cancelled = true
    }
  }, [filePath])

  const toggleStream = useCallback((index: number) =>
  {
    setKept((prev) =>
    {
      const next = new Set(prev)
      if (next.has(index))
      {
        next.delete(index)
      }
      else
      {
        next.add(index)
      }
      return next
    })
    setResult(null)
  }, [])

  const report = loaded?.report ?? null
  const total = report ? report.streams.length : 0
  const tagChanges = report !== null && editing && tagsChanged(report.format.tags, tagsRecord(rows))
  const changed = (report !== null && kept.size !== total) || tagChanges
  const removed = total - kept.size

  const changeSummary = useMemo(() =>
  {
    const parts: string[] = []
    if (removed > 0)
    {
      parts.push(removed === 1 ? 'leaves 1 stream out' : `leaves ${removed} streams out`)
    }
    if (tagChanges)
    {
      parts.push('writes the edited tags')
    }
    return parts.length > 0 ? `The copy ${parts.join(' and ')}.` : ''
  }, [removed, tagChanges])

  const save = async (): Promise<void> =>
  {
    if (!report)
    {
      return
    }
    if (kept.size === 0)
    {
      setResult({ success: false, message: 'Keep at least one stream to save a copy.' })
      return
    }
    setSaving(true)
    setResult(null)
    try
    {
      const answer = await window.api.remuxMedia(filePath, remuxOptions(kept, editing, report.format.tags, rows))
      setResult(answer.success
        ? { success: true, message: answer.outputPath ?? '' }
        : { success: false, message: `The copy failed: ${answer.error || 'FFmpeg gave no reason'}. Try keeping more streams, or open Logs for the FFmpeg output.` })
    }
    catch (caught)
    {
      setResult({ success: false, message: `The copy failed: ${caught instanceof Error ? caught.message : String(caught)}. Try again, or open Logs for the FFmpeg output.` })
    }
    finally
    {
      setSaving(false)
    }
  }

  const updateRow = (id: string, patch: Partial<TagRow>): void =>
  {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    setResult(null)
  }

  const cancelEditing = (): void =>
  {
    setEditing(false)
    setRows(toRows(report?.format.tags))
  }

  if (loading)
  {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 pt-[min(12vh,7rem)]">
        <p className="text-body text-ink-2">Reading {fileName}</p>
        <ProgressBar label={`Reading ${fileName}`} size="sm" showValue={false} />
      </div>
    )
  }

  if (error !== null || report === null)
  {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-6 pt-[min(12vh,7rem)]">
        <h2 className="text-section text-ink">Could not read {fileName}</h2>
        <FieldMessage id={`${ids.file}-error`} tone="error">{`${error ?? 'FFprobe gave no answer'}. Check that the file still exists and is a media file, then open it again.`}</FieldMessage>
      </div>
    )
  }

  const tags = Object.entries(report.format.tags ?? {}).map(([key, value]) => ({ name: key, value }))
  const copyItems = [
    { id: 'path', label: 'Copy the file path', onSelect: () => copy('menu:path', filePath, 'the file path') },
    { id: 'text', label: 'Copy the report as text', onSelect: () => copy('menu:text', reportText(report, fileName, filePath), 'the report') },
    {
      id: 'json',
      label: 'Copy the FFprobe report',
      description: 'JSON, as FFprobe printed it',
      disabled: loaded?.raw === null,
      disabledReason: loaded?.raw === null ? 'FFprobe could not print its report for this file.' : undefined,
      onSelect: () => copy('menu:json', loaded?.raw ?? '', 'the FFprobe report')
    }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 pt-3 pb-3">
        <div className="min-w-0">
          <h1 id={ids.file} className="truncate text-title text-ink">{fileName}</h1>
          <p className="mt-0.5 truncate font-mono text-label text-ink-3">{filePath}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pt-1">
          <Button icon="editor.split" onClick={() => useEditorStore.getState().setMode('clip')}>Open in Trim</Button>
          <Menu label="Copy" align="end" items={copyItems} trigger={<Button icon="action.copy" iconEnd="action.openMenu">Copy</Button>} />
          <Button icon="action.reveal" onClick={() => void window.api.showInFolder(filePath)}>Show in folder</Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-2 py-4">
          <section aria-labelledby={`${ids.file}-legend`} className="flex flex-col gap-1">
            <h2 id={`${ids.file}-legend`} className="type-legend px-2 text-accent-ink">File</h2>
            <FactList facts={containerFacts(report, fileName)} label="File facts" scope="file" copied={copied} onCopy={copy} />
          </section>

          <section aria-labelledby={ids.streams} className="flex flex-col gap-3">
            <h2 id={ids.streams} className="type-legend px-2 text-accent-ink">Streams</h2>
            {report.streams.map((stream) => (
              <StreamSection key={stream.index} stream={stream} kept={kept.has(stream.index)} onToggle={toggleStream} copied={copied} onCopy={copy} />
            ))}
          </section>

          <section aria-labelledby={ids.tags} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 px-2">
              <h2 id={ids.tags} className="type-legend text-accent-ink">Tags</h2>
              {editing
                ? <Button size="sm" variant="ghost" onClick={cancelEditing}>Discard tag edits</Button>
                : <Button size="sm" variant="secondary" icon="action.edit" onClick={() => setEditing(true)}>Edit tags</Button>}
            </div>
            {!editing && (tags.length === 0
              ? <p className="px-2 text-body text-ink-3">The file has no tags.</p>
              : <FactList facts={tags} label="Tags" scope="tags" copied={copied} onCopy={copy} />)}
            {editing && (
              <div className="flex flex-col gap-2 px-2">
                <div className="grid grid-cols-[14rem_minmax(0,1fr)_1.5rem] gap-2 text-label text-ink-3" aria-hidden="true">
                  <span>Name</span>
                  <span>Value</span>
                </div>
                {rows.map((row) => (
                  <div key={row.id} className="grid grid-cols-[14rem_minmax(0,1fr)_1.5rem] items-center gap-2">
                    <input
                      aria-label="Tag name"
                      className={`${TEXT_FRAME} font-mono`}
                      value={row.key}
                      spellCheck={false}
                      onChange={(event) => updateRow(row.id, { key: event.target.value })}
                    />
                    <input
                      aria-label={`Value of ${row.key || 'the new tag'}`}
                      className={TEXT_FRAME}
                      value={row.value}
                      spellCheck={false}
                      onChange={(event) => updateRow(row.id, { value: event.target.value })}
                    />
                    <IconButton
                      size="sm"
                      label={`Remove the tag ${row.key || 'without a name'}`}
                      icon="action.remove"
                      onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  icon="editor.add"
                  className="-ms-2 self-start"
                  onClick={() => setRows((current) => [...current, { id: `tag-${++rowCounter}`, key: `tag_${Date.now()}`, value: '' }])}
                >
                  Add tag
                </Button>
              </div>
            )}
          </section>

          {hasVideo(report) && (
            <div className="px-2">
              <KeyframeView filePath={filePath} durationSeconds={durationSeconds || parseFloat(report.format.duration ?? '') || 0} />
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-panel px-4 py-2" data-region="inspect-actions">
        <Button
          variant="primary"
          icon="action.save"
          loading={saving}
          loadingLabel="Saving"
          unavailableReason={changed ? undefined : 'Leave a stream out or edit the tags first.'}
          onClick={() => void save()}
        >
          Save a copy
        </Button>
        <p className="min-w-0 flex-1 text-label text-ink-3">
          {changed ? changeSummary : 'Leave streams out or edit the tags, then save a copy. The original file is not changed.'}
        </p>
        {result !== null && result.success && (
          <span className="flex min-w-0 items-center gap-2" role="status">
            <span className="truncate text-label text-ink-2">Saved {baseName(result.message)}</span>
            <Button size="sm" variant="ghost" icon="action.reveal" onClick={() => void window.api.showInFolder(result.message)}>Show in folder</Button>
          </span>
        )}
        {result !== null && !result.success && <FieldMessage id={`${ids.file}-save`} tone="error">{result.message}</FieldMessage>}
      </div>
    </div>
  )
}
