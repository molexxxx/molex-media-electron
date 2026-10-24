/**
 * @module editor/clip/ClipExport
 * Trim's export panel, laid out as the Batch inspector: the format and quality up top, rare settings behind
 * More settings, then Export and Add to timeline with the progress, the saved file, or the error at the foot.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { FieldMessage } from '../../../ui/NumberField'
import { ProgressBar } from '../../../ui/ProgressBar'
import { Select } from '../../../ui/Select'
import { EditorField, MoreSettings } from '../shared/Field'
import { formatTimecode, framesToSeconds } from '../shared/TimeDisplay'
import type { MediaSource } from '../types'
import {
  buildCutOptions,
  DEFAULT_GIF,
  DEFAULT_VIDEO,
  FORMAT_OPTIONS,
  formatKind,
  GifFields,
  GifMoreFields,
  QUALITY_CRF,
  qualityForCrf,
  qualityOptions,
  VideoMoreFields,
  type ExportFormat,
  type GifOptions,
  type VideoOptions
} from './ClipExportAdvanced'

const GPU_NAMES: Readonly<Record<string, string>> = { nvenc: 'NVENC', qsv: 'Quick Sync', amf: 'AMF', auto: 'the GPU' }

/** Which encoder the export uses, in one sentence. */
export function encoderNote(gpuMode: string | undefined): string
{
  const name = gpuMode ? GPU_NAMES[gpuMode] : undefined
  return name ? `Video encodes with ${name} where the codec allows.` : 'Video encodes on the CPU. GPU encoding can be turned on in Settings.'
}

function baseName(filePath: string): string
{
  return filePath.split(/[\\/]/).pop() || filePath
}

/** Props of {@link ClipExport}. */
export interface ClipExportProps
{
  source: MediaSource
  /** The panel's width in px. */
  width: number
}

/** The export panel for the active file's in to out range. */
export function ClipExport({ source, width }: ClipExportProps): ReactElement
{
  const inPoint = useEditorStore((s) => s.clipMode.inPoint)
  const outPoint = useEditorStore((s) => s.clipMode.outPoint)
  const projectRate = useEditorStore((s) => s.project.frameRate)
  const frameRate = source.frameRate || projectRate
  const gpuMode = useAppStore((s) => s.config?.gpuAcceleration)
  const headingId = useId()
  const formatId = useId()
  const qualityId = useId()

  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [lossless, setLossless] = useState(false)
  const [gif, setGif] = useState<GifOptions>(DEFAULT_GIF)
  const [video, setVideo] = useState<VideoOptions>(DEFAULT_VIDEO)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(() => () => unsubscribe.current?.(), [])

  const kind = formatKind(format)
  const length = Math.max(0, outPoint - inPoint)
  const quality = lossless ? 'lossless' : qualityForCrf(video.crf) ?? 'custom'

  const chooseQuality = (value: string): void =>
  {
    if (value === 'lossless')
    {
      setLossless(true)
      return
    }
    setLossless(false)
    if (value === 'high' || value === 'medium' || value === 'low')
    {
      setVideo((current) => ({ ...current, crf: QUALITY_CRF[value] }))
    }
  }

  const runExport = async (): Promise<void> =>
  {
    setExporting(true)
    setError(null)
    setSaved(null)
    setProgress(0)
    unsubscribe.current = window.api.onEditorProgress(({ percent }) => setProgress(percent))
    try
    {
      const options = buildCutOptions(format, lossless, gif, video)
      const result = await window.api.cutMedia(source.filePath, framesToSeconds(inPoint, frameRate), framesToSeconds(outPoint, frameRate), options)
      if (result?.success && result.outputPath)
      {
        setSaved(result.outputPath)
      }
      else if (result?.error !== 'Cancelled')
      {
        setError(`The export failed: ${result?.error ?? 'FFmpeg gave no reason'}. Try another format or quality, or open Logs for the FFmpeg output.`)
      }
    }
    catch (caught)
    {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(`The export failed: ${message}. Try again, or open Logs for the FFmpeg output.`)
    }
    finally
    {
      unsubscribe.current?.()
      unsubscribe.current = null
      setExporting(false)
      setProgress(0)
    }
  }

  const addToTimeline = (): void =>
  {
    const { timeline, addClip, setMode } = useEditorStore.getState()
    const wanted = source.width > 0 ? 'video' : 'audio'
    const track = timeline.tracks.find((t) => t.type === wanted) ?? timeline.tracks[0]
    if (!track)
    {
      return
    }
    addClip({
      sourceId: source.id,
      trackId: track.id,
      timelineStart: timeline.duration,
      sourceIn: inPoint,
      sourceOut: outPoint,
      name: source.fileName,
      color: '',
      muted: false,
      locked: false,
      volume: 1,
      pan: 0,
      speed: 1
    })
    setMode('edit')
  }

  return (
    <aside aria-labelledby={headingId} style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-panel" data-panel="trim-export">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto ps-5 pe-3 py-4">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="text-section text-ink">Export</h2>
          <p className="text-label tabular-nums text-ink-3">
            {formatTimecode(length, frameRate)} from {formatTimecode(inPoint, frameRate)}
          </p>
        </div>
        <EditorField label="Format" htmlFor={formatId}>
          <Select id={formatId} value={format} options={FORMAT_OPTIONS} onChange={(value) => setFormat(value as ExportFormat)} className="w-full" />
        </EditorField>
        {kind !== 'gif' && (
          <EditorField
            label="Quality"
            htmlFor={qualityId}
            note={lossless
              ? 'Copies the streams without re-encoding, so cuts land on the nearest keyframe. MP4 always re-encodes.'
              : kind === 'audio'
                ? 'Re-encodes the audio.'
                : 'Re-encodes at this CRF, cutting on the exact frame.'}
          >
            <Select id={qualityId} value={quality} options={qualityOptions(lossless, video.crf)} onChange={chooseQuality} className="w-full" />
          </EditorField>
        )}
        {kind === 'gif' && <GifFields gif={gif} onChange={setGif} />}
        {kind === 'gif' && (
          <MoreSettings scope="trim-gif">
            <GifMoreFields gif={gif} onChange={setGif} />
          </MoreSettings>
        )}
        {kind === 'video' && (
          <MoreSettings scope="trim-video">
            <VideoMoreFields video={video} onChange={setVideo} />
          </MoreSettings>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-3 border-t border-line px-5 py-3">
        {exporting && <ProgressBar value={progress / 100} label={`Exporting ${source.fileName}`} size="sm" />}
        {error !== null && !exporting && <FieldMessage id={`${headingId}-error`} tone="error">{error}</FieldMessage>}
        {saved !== null && !exporting && (
          <div className="flex min-w-0 items-center justify-between gap-2" role="status">
            <p className="min-w-0 truncate text-label text-ink-2">Saved {baseName(saved)}</p>
            <Button size="sm" variant="ghost" icon="action.reveal" onClick={() => void window.api.showInFolder(saved)}>Show in folder</Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon="action.export"
            loading={exporting}
            loadingLabel="Exporting"
            unavailableReason={length <= 0 ? 'Set an out point after the in point to export.' : undefined}
            onClick={() => void runExport()}
          >
            Export
          </Button>
          <Button icon="editor.add" onClick={addToTimeline}>Add to timeline</Button>
        </div>
        <p className="text-label text-ink-3">{encoderNote(gpuMode)}</p>
      </div>
    </aside>
  )
}
