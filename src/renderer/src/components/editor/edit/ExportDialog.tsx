/**
 * @module editor/edit/ExportDialog
 * The timeline export on the shared dialog: the range, format, size, quality, and audio bit rate, then the
 * progress, the saved file, or the error. The request it sends is built by {@link buildExportRequest}.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { Dialog } from '../../../ui/Dialog'
import { FieldMessage } from '../../../ui/NumberField'
import { ProgressBar } from '../../../ui/ProgressBar'
import { SegmentedControl } from '../../../ui/SegmentedControl'
import { Select, type SelectOption } from '../../../ui/Select'
import { encoderNote } from '../clip/ClipExport'
import { EditorField } from '../shared/Field'
import type { EditorProject, MediaSource, PlaybackState, Timeline } from '../types'

export type ExportRange = 'timeline' | 'inout' | 'selected'
type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

export const FORMAT_OPTIONS = [
  { value: 'mp4', label: 'MP4 (H.264)', videoCodec: 'libx264', audioCodec: 'aac' },
  { value: 'webm', label: 'WebM (VP9)', videoCodec: 'libvpx-vp9', audioCodec: 'libopus' },
  { value: 'mov', label: 'MOV (H.264)', videoCodec: 'libx264', audioCodec: 'aac' },
  { value: 'mkv', label: 'MKV (H.264)', videoCodec: 'libx264', audioCodec: 'aac' }
] as const

const QUALITY_OPTIONS: SelectOption[] = [
  { value: '28', label: 'Low (CRF 28)' },
  { value: '23', label: 'Medium (CRF 23)' },
  { value: '18', label: 'High (CRF 18)' },
  { value: '10', label: 'Very high (CRF 10)' }
]

const AUDIO_BITRATE_OPTIONS: SelectOption[] = [
  { value: '128k', label: '128 kbps' },
  { value: '192k', label: '192 kbps' },
  { value: '256k', label: '256 kbps' },
  { value: '320k', label: '320 kbps' }
]

/** The export settings the dialog collects. */
export interface ExportSettings
{
  range: ExportRange
  format: string
  crf: string
  resolution: string
  audioBitrate: string
  sampleRate: number
  channels: number
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  range: 'timeline',
  format: 'mp4',
  crf: '18',
  resolution: 'source',
  audioBitrate: '192k',
  sampleRate: 48000,
  channels: 2
}

/** The request `exportTimeline` receives for the timeline and these settings, written to `outputPath`. */
export function buildExportRequest(
  state: { project: EditorProject, sources: MediaSource[], timeline: Timeline, playback: PlaybackState, selectedClipIds: string[] },
  settings: ExportSettings,
  outputPath: string
): Record<string, unknown>
{
  const { project, sources, timeline, playback, selectedClipIds } = state
  const fmt = FORMAT_OPTIONS.find((f) => f.value === settings.format) ?? FORMAT_OPTIONS[0]
  let range: { startFrame: number, endFrame: number } | undefined
  if (settings.range === 'inout' && playback.inPoint != null && playback.outPoint != null)
  {
    range = { startFrame: playback.inPoint, endFrame: playback.outPoint }
  }
  else if (settings.range === 'selected' && selectedClipIds.length > 0)
  {
    const selected = timeline.clips.filter((c) => selectedClipIds.includes(c.id))
    range = {
      startFrame: Math.min(...selected.map((c) => c.timelineStart)),
      endFrame: Math.max(...selected.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn) / c.speed))
    }
  }
  const resolution = settings.resolution === 'source'
    ? undefined
    : (() =>
      {
        const [width, height] = settings.resolution.split('x').map(Number)
        return { width, height }
      })()
  return {
    project: {
      frameRate: project.frameRate,
      sampleRate: project.sampleRate,
      resolution: project.resolution
    },
    sources: sources.map((s) => ({
      id: s.id,
      filePath: s.filePath,
      frameRate: s.frameRate,
      width: s.width,
      height: s.height,
      audioChannels: s.audioChannels,
      audioSampleRate: s.audioSampleRate,
      durationSeconds: s.durationSeconds
    })),
    tracks: timeline.tracks.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      index: t.index,
      muted: t.muted,
      visible: t.visible
    })),
    clips: timeline.clips.map((c) => ({
      id: c.id,
      sourceId: c.sourceId,
      trackId: c.trackId,
      timelineStart: c.timelineStart,
      sourceIn: c.sourceIn,
      sourceOut: c.sourceOut,
      muted: c.muted,
      volume: c.volume,
      pan: c.pan,
      speed: c.speed,
      transform: c.transform,
      keyframes: c.keyframes,
      blendMode: c.blendMode
    })),
    output: {
      filePath: outputPath,
      format: fmt.value,
      videoCodec: fmt.videoCodec,
      audioCodec: fmt.audioCodec,
      crf: Number(settings.crf),
      audioBitrate: settings.audioBitrate,
      resolution,
      frameRate: project.frameRate,
      sampleRate: settings.sampleRate,
      audioChannels: settings.channels
    },
    range
  }
}

interface ExportDialogProps
{
  open: boolean
  onClose: () => void
}

/** The dialog. */
export function ExportDialog({ open, onClose }: ExportDialogProps): ReactElement
{
  const project = useEditorStore((s) => s.project)
  const hasClips = useEditorStore((s) => s.timeline.clips.length > 0)
  const hasInOut = useEditorStore((s) => s.playback.inPoint != null && s.playback.outPoint != null)
  const hasSelection = useEditorStore((s) => s.selectedClipIds.length > 0)
  const gpuMode = useAppStore((s) => s.config?.gpuAcceleration)
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS)
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const unsubscribe = useRef<(() => void) | null>(null)
  const ids = { range: useId(), format: useId(), size: useId(), quality: useId(), audio: useId(), error: useId() }

  useEffect(() => () => unsubscribe.current?.(), [])

  useEffect(() =>
  {
    if (open)
    {
      setStatus('idle')
      setProgress(0)
      setMessage('')
      setErrorMsg('')
    }
  }, [open])

  const update = (patch: Partial<ExportSettings>): void => setSettings((current) => ({ ...current, ...patch }))
  const range = (settings.range === 'inout' && !hasInOut) || (settings.range === 'selected' && !hasSelection) ? 'timeline' : settings.range

  const handleExport = useCallback(async () =>
  {
    if (!hasClips)
    {
      return
    }
    const ext = settings.format
    const outputPath = await window.api.selectSavePath(`${project.name || 'export'}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }])
    if (!outputPath)
    {
      return
    }
    const state = useEditorStore.getState()
    const request = buildExportRequest(state, { ...settings, range }, outputPath)
    unsubscribe.current?.()
    unsubscribe.current = window.api.onEditorProgress((p) =>
    {
      setProgress(p.percent)
      setMessage(p.message)
    })
    setStatus('exporting')
    setProgress(0)
    setMessage('Starting the export')
    setErrorMsg('')
    try
    {
      const result = await window.api.exportTimeline(request)
      if (result.success)
      {
        setStatus('done')
        setProgress(100)
        setMessage(result.outputPath ?? outputPath)
      }
      else
      {
        setStatus('error')
        setErrorMsg(result.error || 'FFmpeg gave no reason')
      }
    }
    catch (caught)
    {
      setStatus('error')
      setErrorMsg(caught instanceof Error ? caught.message : String(caught))
    }
    finally
    {
      unsubscribe.current?.()
      unsubscribe.current = null
    }
  }, [hasClips, project.name, settings, range])

  const handleCancel = useCallback(async () =>
  {
    await window.api.cancelExport()
    setStatus('idle')
    setProgress(0)
    setMessage('')
  }, [])

  const working = status === 'exporting'
  const sizeOptions: SelectOption[] = [
    { value: 'source', label: `Same as the project (${project.resolution.width} × ${project.resolution.height})` },
    { value: '1280x720', label: '720p (1280 × 720)' },
    { value: '1920x1080', label: '1080p (1920 × 1080)' },
    { value: '3840x2160', label: '4K (3840 × 2160)' }
  ]

  const actions = working
    ? <Button variant="danger" onClick={() => void handleCancel()}>Cancel export</Button>
    : (
        <>
          <Button onClick={onClose}>{status === 'done' ? 'Done' : 'Close'}</Button>
          {status !== 'done' && (
            <Button
              variant="primary"
              icon="action.export"
              unavailableReason={hasClips ? undefined : 'Add a clip to the timeline to export it.'}
              onClick={() => void handleExport()}
            >
              Export
            </Button>
          )}
        </>
      )

  return (
    <Dialog
      open={open}
      onClose={() =>
      {
        if (!working)
        {
          onClose()
        }
      }}
      title="Export the timeline"
      description="Renders every visible track into one file."
      size="md"
      actions={actions}
    >
      <div className="flex flex-col gap-4">
        <EditorField label="Range" captionId={ids.range}>
          <SegmentedControl<ExportRange>
            labelledBy={ids.range}
            value={range}
            disabled={working}
            onChange={(value) => update({ range: value })}
            options={[
              { value: 'timeline', label: 'Whole timeline' },
              { value: 'inout', label: 'In to out', disabled: !hasInOut, description: hasInOut ? undefined : 'Mark in and out on the timeline with I and O first.' },
              { value: 'selected', label: 'Selected clips', disabled: !hasSelection, description: hasSelection ? undefined : 'Select clips on the timeline first.' }
            ]}
          />
        </EditorField>
        <div className="grid grid-cols-2 gap-4">
          <EditorField label="Format" htmlFor={ids.format}>
            <Select id={ids.format} value={settings.format} disabled={working} options={FORMAT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))} onChange={(format) => update({ format })} className="w-full" />
          </EditorField>
          <EditorField label="Size" htmlFor={ids.size}>
            <Select id={ids.size} value={settings.resolution} disabled={working} options={sizeOptions} onChange={(resolution) => update({ resolution })} className="w-full" />
          </EditorField>
          <EditorField label="Quality" htmlFor={ids.quality}>
            <Select id={ids.quality} value={settings.crf} disabled={working} options={QUALITY_OPTIONS} onChange={(crf) => update({ crf })} className="w-full" />
          </EditorField>
          <EditorField label="Audio bit rate" htmlFor={ids.audio}>
            <Select id={ids.audio} value={settings.audioBitrate} disabled={working} options={AUDIO_BITRATE_OPTIONS} onChange={(audioBitrate) => update({ audioBitrate })} className="w-full" />
          </EditorField>
        </div>
        {status === 'exporting' && (
          <div className="flex flex-col gap-1.5" role="status">
            <ProgressBar value={progress / 100} label="Exporting the timeline" />
            <p className="text-label text-ink-2">{message}</p>
          </div>
        )}
        {status === 'done' && (
          <div className="flex min-w-0 items-center justify-between gap-3" role="status">
            <p className="min-w-0 truncate text-body text-ink">Saved {message.split(/[\\/]/).pop()}</p>
            <Button size="sm" variant="ghost" icon="action.reveal" onClick={() => void window.api.showInFolder(message)}>Show in folder</Button>
          </div>
        )}
        {status === 'error' && (
          <FieldMessage id={ids.error} tone="error">{`The export failed: ${errorMsg}. Check the settings and try again, or open Logs for the FFmpeg output.`}</FieldMessage>
        )}
        <p className="text-label text-ink-3">{encoderNote(gpuMode)}</p>
      </div>
    </Dialog>
  )
}
