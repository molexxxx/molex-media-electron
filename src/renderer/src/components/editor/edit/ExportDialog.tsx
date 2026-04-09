/**
 * @module editor/edit/ExportDialog
 * Export settings dialog with format options and real-time progress tracking.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { EncoderBadge } from '../../shared/EncoderBadge'
import { SelectDropdown } from '../../batch/components/SelectDropdown'

type ExportRange = 'timeline' | 'inout' | 'selected'
type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

const FORMAT_OPTIONS = [
  { value: 'mp4', label: 'MP4 (H.264)', videoCodec: 'libx264', audioCodec: 'aac' },
  { value: 'webm', label: 'WebM (VP9)', videoCodec: 'libvpx-vp9', audioCodec: 'libopus' },
  { value: 'mov', label: 'MOV (H.264)', videoCodec: 'libx264', audioCodec: 'aac' },
  { value: 'mkv', label: 'MKV (H.264)', videoCodec: 'libx264', audioCodec: 'aac' }
]

const QUALITY_PRESETS = [
  { value: 28, label: 'Low (CRF 28)' },
  { value: 23, label: 'Medium (CRF 23)' },
  { value: 18, label: 'High (CRF 18)' },
  { value: 10, label: 'Very High (CRF 10)' }
]

const RESOLUTION_OPTIONS = [
  { value: 'source', label: 'Source' },
  { value: '1280x720', label: '720p' },
  { value: '1920x1080', label: '1080p' },
  { value: '3840x2160', label: '4K' }
]

const AUDIO_BITRATE_OPTIONS = [
  { value: '128k', label: '128 kbps' },
  { value: '192k', label: '192 kbps' },
  { value: '256k', label: '256 kbps' },
  { value: '320k', label: '320 kbps' }
]

interface ExportDialogProps {
  open: boolean
  onClose: () => void
}

export function ExportDialog({ open, onClose }: ExportDialogProps): React.JSX.Element | null {
  const project = useEditorStore((s) => s.project)
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const playback = useEditorStore((s) => s.playback)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)

  const [range, setRange] = useState<ExportRange>('timeline')
  const [formatValue, setFormatValue] = useState('mp4')
  const [crf, setCrf] = useState('18')
  const [resOption, setResOption] = useState('source')
  const [audioBitrate, setAudioBitrate] = useState('192k')
  const [sampleRate] = useState(48000)
  const [channels] = useState(2)

  const [status, setStatus] = useState<ExportStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const progressUnsub = useRef<(() => void) | null>(null)

  // Cleanup progress listener on unmount / close
  useEffect(() => {
    return () => {
      progressUnsub.current?.()
    }
  }, [])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setStatus('idle')
      setProgress(0)
      setMessage('')
      setErrorMsg('')
    }
  }, [open])

  const fmt = FORMAT_OPTIONS.find((f) => f.value === formatValue) || FORMAT_OPTIONS[0]

  const parsedRes = useMemo(() => {
    if (resOption === 'source') return undefined
    const [w, h] = resOption.split('x').map(Number)
    return { width: w, height: h }
  }, [resOption])

  const hasInOut = playback.inPoint != null && playback.outPoint != null
  const hasSelection = selectedClipIds.length > 0
  const hasClips = timeline.clips.length > 0

  const handleExport = useCallback(async () => {
    if (!hasClips) return

    // Ask user for output path
    const ext = fmt.value
    const defaultName = `${project.name || 'export'}.${ext}`
    const outputPath = await window.api.selectSavePath(
      defaultName,
      [{ name: ext.toUpperCase(), extensions: [ext] }]
    )
    if (!outputPath) return

    // Compute range frames
    let rangeFrames: { startFrame: number; endFrame: number } | undefined
    if (range === 'inout' && playback.inPoint != null && playback.outPoint != null) {
      rangeFrames = { startFrame: playback.inPoint, endFrame: playback.outPoint }
    } else if (range === 'selected' && selectedClipIds.length > 0) {
      const selectedClips = timeline.clips.filter((c) => selectedClipIds.includes(c.id))
      const minStart = Math.min(...selectedClips.map((c) => c.timelineStart))
      const maxEnd = Math.max(
        ...selectedClips.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn) / c.speed)
      )
      rangeFrames = { startFrame: minStart, endFrame: maxEnd }
    }

    // Build export request
    const request = {
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
        speed: c.speed
      })),
      output: {
        filePath: outputPath,
        format: fmt.value,
        videoCodec: fmt.videoCodec,
        audioCodec: fmt.audioCodec,
        crf: Number(crf),
        audioBitrate,
        resolution: parsedRes,
        frameRate: project.frameRate,
        sampleRate,
        audioChannels: channels
      },
      range: rangeFrames
    }

    // Start listening for progress
    progressUnsub.current?.()
    progressUnsub.current = window.api.onEditorProgress((p) => {
      setProgress(p.percent)
      setMessage(p.message)
    })

    setStatus('exporting')
    setProgress(0)
    setMessage('Starting export…')
    setErrorMsg('')

    try {
      const res = await window.api.exportTimeline(request)
      progressUnsub.current?.()
      progressUnsub.current = null

      if (res.success) {
        setStatus('done')
        setProgress(100)
        setMessage(`Exported to ${res.outputPath}`)
      } else {
        setStatus('error')
        setErrorMsg(res.error || 'Export failed')
      }
    } catch (err: any) {
      progressUnsub.current?.()
      progressUnsub.current = null
      setStatus('error')
      setErrorMsg(err.message || 'Export failed')
    }
  }, [
    hasClips, fmt, project, sources, timeline, selectedClipIds,
    range, playback, crf, audioBitrate, parsedRes, sampleRate, channels
  ])

  const handleCancel = useCallback(async () => {
    await window.api.cancelExport()
    setStatus('idle')
    setProgress(0)
    setMessage('')
  }, [])

  if (!open) return null

  const isWorking = status === 'exporting'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-900 border border-white/10 rounded-xl shadow-2xl w-120 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h2 className="text-sm font-semibold text-surface-100">Export Timeline</h2>
          <button
            onClick={onClose}
            disabled={isWorking}
            className="text-surface-500 hover:text-surface-200 text-lg disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Range */}
          <fieldset disabled={isWorking}>
            <label className="block text-[11px] text-surface-400 mb-1.5">Range</label>
            <div className="flex gap-2">
              <RadioBtn
                label="Entire Timeline"
                checked={range === 'timeline'}
                onChange={() => setRange('timeline')}
              />
              <RadioBtn
                label="In → Out"
                checked={range === 'inout'}
                onChange={() => setRange('inout')}
                disabled={!hasInOut}
              />
              <RadioBtn
                label="Selected Clips"
                checked={range === 'selected'}
                onChange={() => setRange('selected')}
                disabled={!hasSelection}
              />
            </div>
          </fieldset>

          {/* Format */}
          <fieldset disabled={isWorking}>
            <label className="block text-[11px] text-surface-400 mb-1.5">Format</label>
            <SelectDropdown
              value={formatValue}
              onChange={setFormatValue}
              className="w-full"
              items={FORMAT_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
            />
          </fieldset>

          {/* Resolution */}
          <fieldset disabled={isWorking}>
            <label className="block text-[11px] text-surface-400 mb-1.5">Resolution</label>
            <SelectDropdown
              value={resOption}
              onChange={setResOption}
              className="w-full"
              items={RESOLUTION_OPTIONS.map((r) => ({
                value: r.value,
                label: r.value === 'source' ? `${r.label} (${project.resolution.width}×${project.resolution.height})` : r.label
              }))}
            />
          </fieldset>

          {/* Quality */}
          <fieldset disabled={isWorking}>
            <label className="block text-[11px] text-surface-400 mb-1.5">Quality</label>
            <SelectDropdown
              value={crf}
              onChange={setCrf}
              className="w-full"
              items={QUALITY_PRESETS.map((q) => ({ value: String(q.value), label: q.label }))}
            />
          </fieldset>

          {/* Audio Bitrate */}
          <fieldset disabled={isWorking}>
            <label className="block text-[11px] text-surface-400 mb-1.5">Audio Bitrate</label>
            <SelectDropdown
              value={audioBitrate}
              onChange={setAudioBitrate}
              className="w-full"
              items={AUDIO_BITRATE_OPTIONS.map((a) => ({ value: a.value, label: a.label }))}
            />
          </fieldset>

          {/* Progress */}
          {status !== 'idle' && (
            <div className="space-y-2">
              <div className="w-full h-2 bg-surface-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 rounded-full ${
                    status === 'error' ? 'bg-red-500' : status === 'done' ? 'bg-green-500' : 'bg-accent-500'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-[11px] text-surface-400">{message}</p>
              {status === 'error' && (
                <p className="text-[11px] text-red-400">{errorMsg}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/5">
          <EncoderBadge />
          <div className="flex-1" />
          {isWorking ? (
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 text-xs rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-4 py-1.5 text-xs rounded text-surface-400 hover:text-surface-200 hover:bg-white/4 transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleExport}
                disabled={!hasClips || status === 'done'}
                className="px-4 py-1.5 text-xs rounded bg-accent-500/20 text-accent-200 hover:bg-accent-500/30 transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                {status === 'done' ? 'Done' : 'Export'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function RadioBtn({
  label,
  checked,
  onChange,
  disabled
}: {
  label: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`px-2.5 py-1 text-[11px] rounded border transition-all ${
        checked
          ? 'bg-accent-500/15 text-accent-200 border-accent-500/25'
          : 'text-surface-400 border-white/10 hover:text-surface-200 hover:bg-white/4'
      } disabled:opacity-30 disabled:pointer-events-none`}
    >
      {label}
    </button>
  )
}
