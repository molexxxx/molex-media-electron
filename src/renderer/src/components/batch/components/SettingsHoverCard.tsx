import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Operation } from '../../../stores/types'
import type { ResolvedFileSettings } from '../../../stores/taskSettings'
import { BUILTIN_PRESETS, BUILTIN_COMPRESS_PRESETS, BUILTIN_EXTRACT_PRESETS } from '../../../stores/types'
import { OP_TABS } from './OperationPanel'

const OP_LABELS: Record<Operation, string> = {
  convert: 'Convert', normalize: 'Normalize', boost: 'Volume',
  compress: 'Compress', extract: 'Extract'
}

function getOpIcon(op: Operation): React.JSX.Element | null {
  return OP_TABS.find((t) => t.id === op)?.icon || null
}

function SettingsContent({ settings }: { settings: ResolvedFileSettings }): React.JSX.Element {
  const op = settings.operation

  const renderDetails = (): React.JSX.Element => {
    switch (op) {
      case 'normalize': {
        const opts = settings.normalizeOptions
        const preset = BUILTIN_PRESETS.find((p) => p.id === settings.selectedPreset)
        const compression = (opts as { compression?: string }).compression ?? 'off'
        const downmix = (opts as { downmix?: string }).downmix ?? 'keep'
        return (
          <div className="space-y-1">
            <div className="text-2xs text-surface-400">
              <span className="text-surface-500">Preset:</span> {preset?.name || 'Custom'}
            </div>
            <div className="text-2xs text-surface-400 font-mono">
              I: {opts.I} LUFS
            </div>
            <div className="text-2xs text-surface-400 font-mono">
              TP: {opts.TP} dBTP
            </div>
            <div className="text-2xs text-surface-400 font-mono">
              LRA: {opts.LRA} LU
            </div>
            {compression !== 'off' && (
              <div className="text-2xs text-surface-400">
                <span className="text-surface-500">Compression:</span> {compression}
              </div>
            )}
            {downmix !== 'keep' && (
              <div className="text-2xs text-surface-400">
                <span className="text-surface-500">Layout:</span> {downmix === 'dialog-stereo' ? 'Dialog stereo' : 'Stereo'}
              </div>
            )}
          </div>
        )
      }
      case 'boost': {
        const pct = settings.boostOptions?.percent ?? settings.boostPercent
        return (
          <div className="text-2xs text-surface-400 font-mono">
            Boost: {pct > 0 ? '+' : ''}{pct}%
          </div>
        )
      }
      case 'convert': {
        const opts = settings.convertOptions
        return (
          <div className="space-y-1">
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Format:</span> {opts.outputFormat.toUpperCase()}</div>
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Video:</span> {opts.videoCodec === 'copy' ? 'Copy' : opts.videoCodec}{opts.videoBitrate ? ` @ ${opts.videoBitrate}` : ''}</div>
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Audio:</span> {opts.audioCodec === 'copy' ? 'Copy' : opts.audioCodec}{opts.audioBitrate ? ` @ ${opts.audioBitrate}` : ''}</div>
            {opts.resolution && <div className="text-2xs text-surface-400"><span className="text-surface-500">Resolution:</span> {opts.resolution}</div>}
            {opts.framerate && <div className="text-2xs text-surface-400"><span className="text-surface-500">Framerate:</span> {opts.framerate} fps</div>}
          </div>
        )
      }
      case 'extract': {
        const opts = settings.extractOptions
        const preset = BUILTIN_EXTRACT_PRESETS.find((p) => p.id === settings.selectedExtractPreset)
        const mode = opts.mode || 'audio'
        const modeLabel = mode === 'audio' ? 'Audio'
          : mode === 'video' ? 'Silent Video'
          : mode === 'gif' ? 'GIF'
          : mode === 'frames' ? 'Frames'
          : 'Subtitles'
        return (
          <div className="space-y-1">
            {preset && <div className="text-2xs text-surface-400"><span className="text-surface-500">Preset:</span> {preset.name}</div>}
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Mode:</span> {modeLabel}</div>
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Format:</span> {opts.outputFormat.toUpperCase()}</div>
            {mode === 'audio' && <>
              <div className="text-2xs text-surface-400"><span className="text-surface-500">Stream:</span> {opts.streamIndex}</div>
              {opts.audioBitrate && <div className="text-2xs text-surface-400"><span className="text-surface-500">Bitrate:</span> {opts.audioBitrate}</div>}
              {opts.sampleRate && <div className="text-2xs text-surface-400"><span className="text-surface-500">Sample Rate:</span> {opts.sampleRate}</div>}
              {opts.channels && <div className="text-2xs text-surface-400"><span className="text-surface-500">Channels:</span> {opts.channels}</div>}
            </>}
            {mode === 'video' && <div className="text-2xs text-surface-400"><span className="text-surface-500">Encoding:</span> {opts.videoReencode ? `H.264 CRF ${opts.videoCrf ?? 20}` : 'Stream copy'}</div>}
            {mode === 'gif' && <>
              <div className="text-2xs text-surface-400"><span className="text-surface-500">Size:</span> {opts.gifWidth || 480}w @ {opts.gifFps || 12}fps</div>
              <div className="text-2xs text-surface-400"><span className="text-surface-500">Dither:</span> {opts.gifDither || 'sierra2_4a'}</div>
            </>}
            {mode === 'frames' && <>
              <div className="text-2xs text-surface-400"><span className="text-surface-500">Sampling:</span> {opts.framesMode || 'interval'}</div>
              {opts.framesMode === 'interval' && <div className="text-2xs text-surface-400"><span className="text-surface-500">Every:</span> {opts.frameInterval ?? 1}s</div>}
              {opts.framesMode === 'fps' && <div className="text-2xs text-surface-400"><span className="text-surface-500">FPS:</span> {opts.framesFps ?? 1}</div>}
              {opts.framesMode === 'count' && <div className="text-2xs text-surface-400"><span className="text-surface-500">Count:</span> {opts.frameCount ?? 25}</div>}
            </>}
            {mode === 'subtitles' && <div className="text-2xs text-surface-400"><span className="text-surface-500">Stream:</span> {opts.streamIndex}</div>}
            {(opts.startTime || opts.duration) && (
              <div className="text-2xs text-surface-400">
                <span className="text-surface-500">Trim:</span> {opts.startTime || '0'}{opts.duration ? ` + ${opts.duration}` : ''}
              </div>
            )}
          </div>
        )
      }
      case 'compress': {
        const opts = settings.compressOptions
        const preset = BUILTIN_COMPRESS_PRESETS.find((p) => p.id === settings.selectedCompressPreset)
        const mode = opts.mode === 'target-size' || (opts.mode == null && opts.targetSizeMB > 0) ? 'target-size' : 'crf'
        return (
          <div className="space-y-1">
            {preset && <div className="text-2xs text-surface-400"><span className="text-surface-500">Preset:</span> {preset.name}</div>}
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Mode:</span> {mode === 'target-size' ? 'Target Size' : 'CRF Quality'}</div>
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Quality:</span> {opts.quality.charAt(0).toUpperCase() + opts.quality.slice(1)}{opts.quality === 'custom' && opts.customCrf != null ? ` (CRF ${opts.customCrf})` : ''}</div>
            {opts.videoCodec && <div className="text-2xs text-surface-400"><span className="text-surface-500">Codec:</span> {opts.videoCodec}</div>}
            {opts.speed && <div className="text-2xs text-surface-400"><span className="text-surface-500">Speed:</span> {opts.speed}</div>}
            {opts.pixelFormat && <div className="text-2xs text-surface-400"><span className="text-surface-500">Pix fmt:</span> {opts.pixelFormat === 'yuv420p10le' ? '10-bit' : '8-bit'}</div>}
            {opts.tune && <div className="text-2xs text-surface-400"><span className="text-surface-500">Tune:</span> {opts.tune}</div>}
            {opts.maxHeight ? <div className="text-2xs text-surface-400"><span className="text-surface-500">Max H:</span> {opts.maxHeight}p</div> : null}
            {opts.audioCodec && <div className="text-2xs text-surface-400"><span className="text-surface-500">Audio:</span> {opts.audioCodec}{opts.audioCodec !== 'flac' && opts.audioCodec !== 'copy' && opts.audioBitrate ? ` @ ${opts.audioBitrate}` : ''}</div>}
            {mode === 'target-size' ? <div className="text-2xs text-surface-400"><span className="text-surface-500">Target:</span> {opts.targetSizeMB} MB{opts.twoPass ? ' (2-pass)' : ''}</div> : null}
          </div>
        )
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="[&>svg]:w-3.5 [&>svg]:h-3.5 text-accent-400">{getOpIcon(op)}</span>
        <span className="text-xs font-semibold text-surface-200">{OP_LABELS[op]}</span>
      </div>
      {renderDetails()}
    </div>
  )
}

interface SettingsHoverCardProps {
  /** Settings the run will actually use (file overrides merged with panel). */
  settings: ResolvedFileSettings
  anchorRef: React.RefObject<HTMLElement | null>
  onRequestEdit: () => void
  onClose: () => void
}

export function SettingsHoverCard({ settings, anchorRef, onRequestEdit, onClose }: SettingsHoverCardProps): React.JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const updatePos = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const cardHeight = 180
    const spaceBelow = window.innerHeight - rect.bottom
    const top = spaceBelow > cardHeight + 8 ? rect.bottom + 6 : rect.top - cardHeight - 6
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 220))
    setPos({ top, left })
  }, [anchorRef])

  useEffect(() => {
    updatePos()
    const onScroll = () => updatePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [updatePos])

  if (!pos) return null

  return createPortal(
    <>
      <div className="fixed inset-0 z-[99]" onClick={onClose} />
      <div
        ref={cardRef}
        className="fixed z-[100] w-52 rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl p-3 animate-fade-in"
        style={{ top: pos.top, left: pos.left }}
      >
        <SettingsContent settings={settings} />
        <div className="mt-2.5 pt-2 border-t border-white/[0.06]">
          <button
            onClick={(e) => { e.stopPropagation(); onRequestEdit() }}
            className="flex items-center gap-1 text-2xs text-accent-400 hover:text-accent-300 font-medium transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}
