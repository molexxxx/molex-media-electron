import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { FileItem, Operation } from '../../../stores/types'
import { BUILTIN_PRESETS } from '../../../stores/types'
import { OP_TABS } from './OperationPanel'

const OP_LABELS: Record<Operation, string> = {
  convert: 'Convert', normalize: 'Normalize', boost: 'Volume',
  compress: 'Compress', extract: 'Extract'
}

function getOpIcon(op: Operation): React.JSX.Element | null {
  return OP_TABS.find((t) => t.id === op)?.icon || null
}

function SettingsContent({ file }: { file: FileItem }): React.JSX.Element {
  const op = file.operation || 'normalize'

  const renderDetails = (): React.JSX.Element => {
    switch (op) {
      case 'normalize': {
        const opts = file.normalizeOptions || { I: -16, TP: -1.5, LRA: 11 }
        const preset = BUILTIN_PRESETS.find((p) => p.id === file.selectedPreset)
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
          </div>
        )
      }
      case 'boost': {
        const pct = file.boostPercent ?? 10
        return (
          <div className="text-2xs text-surface-400 font-mono">
            Boost: {pct > 0 ? '+' : ''}{pct}%
          </div>
        )
      }
      case 'convert': {
        const opts = file.convertOptions || { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' }
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
        const opts = file.extractOptions || { outputFormat: 'mp3', streamIndex: 0 }
        return (
          <div className="space-y-1">
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Format:</span> {opts.outputFormat.toUpperCase()}</div>
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Stream:</span> {opts.streamIndex}</div>
            {opts.audioBitrate && <div className="text-2xs text-surface-400"><span className="text-surface-500">Bitrate:</span> {opts.audioBitrate}</div>}
            {opts.sampleRate && <div className="text-2xs text-surface-400"><span className="text-surface-500">Sample Rate:</span> {opts.sampleRate}</div>}
          </div>
        )
      }
      case 'compress': {
        const opts = file.compressOptions || { targetSizeMB: 0, quality: 'high' as const }
        return (
          <div className="space-y-1">
            <div className="text-2xs text-surface-400"><span className="text-surface-500">Quality:</span> {opts.quality.charAt(0).toUpperCase() + opts.quality.slice(1)}</div>
            {opts.videoCodec && <div className="text-2xs text-surface-400"><span className="text-surface-500">Codec:</span> {opts.videoCodec}</div>}
            {opts.speed && <div className="text-2xs text-surface-400"><span className="text-surface-500">Speed:</span> {opts.speed}</div>}
            {opts.targetSizeMB ? <div className="text-2xs text-surface-400"><span className="text-surface-500">Target:</span> {opts.targetSizeMB} MB</div> : null}
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
  file: FileItem
  anchorRef: React.RefObject<HTMLElement | null>
  onRequestEdit: () => void
  onClose: () => void
}

export function SettingsHoverCard({ file, anchorRef, onRequestEdit, onClose }: SettingsHoverCardProps): React.JSX.Element | null {
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
        <SettingsContent file={file} />
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
