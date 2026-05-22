/** @module editor/MediaEditor - Top-level NLE editor shell with mode tabs. */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useEditorStore } from '../../stores/editorStore'
import type { EditorMode, MediaSource } from './types'
import { ClipEditor } from './clip/ClipEditor'
import { EditEditor } from './edit/EditEditor'
import { InspectEditor } from './inspect/InspectEditor'
import { getRecentFiles, removeRecentFile, clearRecentFiles, type RecentFile } from '../../utils/recentFiles'

/* Clip - trim/cut icon (bracket markers for in/out points) */
const ClipIcon = ({ size = 16 }: { size?: number } = {}): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v18" />
    <path d="M18 3v18" />
    <path d="M6 8h12" />
    <path d="M6 16h12" />
    <path d="M2 3h4" />
    <path d="M2 21h4" />
    <path d="M18 3h4" />
    <path d="M18 21h4" />
  </svg>
)

/* Timeline - multi-track timeline icon (stacked horizontal bars) */
const TimelineIcon = ({ size = 16 }: { size?: number } = {}): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3" width="15" height="4" rx="1" />
    <rect x="6" y="10" width="17" height="4" rx="1" />
    <rect x="3" y="17" width="12" height="4" rx="1" />
  </svg>
)

/* Inspect - search / magnify icon */
const InspectIcon = ({ size = 16 }: { size?: number } = {}): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

interface ModeTab {
  id: EditorMode
  label: string
  icon: React.FC<{ size?: number }>
  tooltip: string
  /** Short description used on the launcher cards. */
  blurb: string
  /** One-liner positioning under the card title. */
  tagline: string
  /** Accent classes used on the launcher cards. */
  accentRing: string
  accentText: string
  accentGlow: string
  accentBg: string
  accentIconWrap: string
  accentBtn: string
}

const MODE_TABS: ModeTab[] = [
  {
    id: 'clip',
    label: 'Trim',
    icon: ClipIcon,
    tooltip: 'Quick trim & export',
    blurb: 'Set in/out points and export trimmed clips, audio, or animated GIFs.',
    tagline: 'Fast in-and-out cuts',
    accentRing: 'group-hover:border-violet-400/40',
    accentText: 'text-violet-300',
    accentGlow: 'group-hover:shadow-[0_0_40px_-8px_rgba(167,139,250,0.45)]',
    accentBg: 'from-violet-500/10 via-violet-500/3 to-transparent',
    accentIconWrap: 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/20 shadow-[inset_0_0_20px_-8px_rgba(167,139,250,0.4)]',
    accentBtn: 'bg-violet-500/15 hover:bg-violet-500/25 text-violet-100 border-violet-400/30 hover:border-violet-400/50'
  },
  {
    id: 'edit',
    label: 'Timeline',
    icon: TimelineIcon,
    tooltip: 'Multi-track NLE timeline',
    blurb: 'Multi-track non-linear editor with transforms, keyframes, and blend modes.',
    tagline: 'Full non-linear editor',
    accentRing: 'group-hover:border-sky-400/40',
    accentText: 'text-sky-300',
    accentGlow: 'group-hover:shadow-[0_0_40px_-8px_rgba(56,189,248,0.45)]',
    accentBg: 'from-sky-500/10 via-sky-500/3 to-transparent',
    accentIconWrap: 'bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/20 shadow-[inset_0_0_20px_-8px_rgba(56,189,248,0.4)]',
    accentBtn: 'bg-sky-500/15 hover:bg-sky-500/25 text-sky-100 border-sky-400/30 hover:border-sky-400/50'
  },
  {
    id: 'inspect',
    label: 'Inspect',
    icon: InspectIcon,
    tooltip: 'Media metadata & streams',
    blurb: 'Probe codecs, streams, and metadata. Edit tags & remux losslessly.',
    tagline: 'Codecs, streams, tags',
    accentRing: 'group-hover:border-emerald-400/40',
    accentText: 'text-emerald-300',
    accentGlow: 'group-hover:shadow-[0_0_40px_-8px_rgba(52,211,153,0.45)]',
    accentBg: 'from-emerald-500/10 via-emerald-500/3 to-transparent',
    accentIconWrap: 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/20 shadow-[inset_0_0_20px_-8px_rgba(52,211,153,0.4)]',
    accentBtn: 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-100 border-emerald-400/30 hover:border-emerald-400/50'
  }
]

function formatDuration(s?: number): string {
  if (!s || !isFinite(s)) return '-'
  const total = Math.round(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatRelative(ts: number): string {
  const d = Date.now() - ts
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function KindIcon({ kind }: { kind?: string }): React.JSX.Element {
  const common = 'w-full h-full'
  if (kind === 'audio') {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    )
  }
  if (kind === 'image') {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    )
  }
  // default: video / unknown
  return (
    <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  )
}

const KIND_ACCENT: Record<string, string> = {
  video: 'text-sky-300 bg-sky-500/10 ring-sky-400/20',
  audio: 'text-violet-300 bg-violet-500/10 ring-violet-400/20',
  image: 'text-emerald-300 bg-emerald-500/10 ring-emerald-400/20',
  unknown: 'text-surface-300 bg-white/4 ring-white/10'
}

/** Recent files row shown under the tool cards on the launcher. */
function RecentsRow({
  onOpen,
  onForget
}: {
  onOpen: (filePath: string) => void
  onForget: (filePath: string) => void
}): React.JSX.Element | null {
  const [recents, setRecents] = useState<RecentFile[]>(() => getRecentFiles())

  useEffect(() => {
    const refresh = (): void => setRecents(getRecentFiles())
    window.addEventListener('molex:recents-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('molex:recents-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  if (recents.length === 0) return null

  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between mb-3 px-1">
        <h3 className="text-xs font-semibold text-surface-300 tracking-wider uppercase">Recent</h3>
        <button
          onClick={() => {
            clearRecentFiles()
            setRecents([])
          }}
          className="text-2xs text-surface-500 hover:text-surface-300 transition-colors"
        >
          Clear all
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {recents.slice(0, 8).map((r) => {
          const accent = KIND_ACCENT[r.kind || 'unknown'] || KIND_ACCENT.unknown
          return (
            <div
              key={r.filePath}
              className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl bg-surface-900/40 border border-white/6 hover:border-white/15 hover:bg-surface-900/70 transition-all cursor-pointer"
              onClick={() => onOpen(r.filePath)}
              title={r.filePath}
            >
              <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center p-2 ring-1 ${accent}`}>
                <KindIcon kind={r.kind} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-surface-100 truncate">{r.fileName}</div>
                <div className="text-2xs text-surface-500 truncate">
                  {formatDuration(r.durationSec)}
                  {r.width && r.height ? ` · ${r.width}×${r.height}` : ''}
                  {' · '}
                  {formatRelative(r.openedAt)}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onForget(r.filePath)
                  setRecents((rs) => rs.filter((x) => x.filePath !== r.filePath))
                }}
                title="Forget"
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-surface-600 opacity-0 group-hover:opacity-100 hover:text-surface-200 hover:bg-white/6 transition-all"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Drag-and-drop band under the tool cards. Big, obvious target. */
function DropBand({
  onFiles,
  active
}: {
  onFiles: (paths: string[]) => void
  active: boolean
}): React.JSX.Element {
  const [hover, setHover] = useState(false)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setHover(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = files.map((f) => window.api.getFilePath(f)).filter(Boolean) as string[]
    if (paths.length > 0) onFiles(paths)
  }, [onFiles])

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); setHover(true) }}
      onDragOver={(e) => { e.preventDefault() }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
      className={`mt-8 rounded-2xl border-2 border-dashed transition-all duration-200 px-6 py-5 flex items-center gap-4
        ${hover || active
          ? 'border-accent-400/60 bg-accent-500/8'
          : 'border-white/10 bg-white/2 hover:border-white/20 hover:bg-white/3'}`}
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0
        ${hover || active ? 'bg-accent-500/20 text-accent-200' : 'bg-white/4 text-surface-400'}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-surface-100">
          {hover ? 'Release to open' : 'Drop files anywhere'}
        </div>
        <div className="text-2xs text-surface-500 mt-0.5">
          Video, audio, image, or GIF - opens into the active tool. Drop multiple files to queue them in Timeline.
        </div>
      </div>
    </div>
  )
}
/**
 * Clickable file-context pill. Shows the current filename; on click opens a
 * dropdown menu with recents (excluding the current file), Open another,
 * Close, and Back to launcher.
 */
function FileMenu({
  source,
  onOpenAnother,
  onOpenPath,
  onClose,
  onBackToLauncher
}: {
  source: MediaSource
  onOpenAnother: () => void
  onOpenPath: (filePath: string) => void
  onClose: () => void
  onBackToLauncher: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentFile[]>(() => getRecentFiles())
  const rootRef = useRef<HTMLDivElement>(null)

  // Refresh recents whenever the menu opens or recents change globally.
  useEffect(() => {
    if (!open) return
    setRecents(getRecentFiles())
    const refresh = (): void => setRecents(getRecentFiles())
    window.addEventListener('molex:recents-changed', refresh)
    return () => window.removeEventListener('molex:recents-changed', refresh)
  }, [open])

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const otherRecents = recents.filter((r) => r.filePath !== source.filePath).slice(0, 6)

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={source.filePath}
        className={`flex items-center gap-2 min-w-0 px-2.5 py-1 rounded-lg border max-w-160 transition-colors
          ${open
            ? 'bg-white/8 border-white/15 text-surface-100'
            : 'bg-white/4 border-white/8 text-surface-200 hover:bg-white/6 hover:border-white/12'}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-surface-500 shrink-0">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="text-xs truncate font-medium">{source.fileName}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-surface-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-80 z-50 rounded-xl bg-surface-900/95 backdrop-blur-sm border border-white/10 shadow-2xl shadow-black/40 overflow-hidden">
          {/* Recents */}
          {otherRecents.length > 0 && (
            <div className="py-1.5 border-b border-white/5">
              <div className="px-3 pt-1 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-surface-500">
                Switch to recent
              </div>
              {otherRecents.map((r) => (
                <button
                  key={r.filePath}
                  onClick={() => { setOpen(false); onOpenPath(r.filePath) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/6 transition-colors group"
                  title={r.filePath}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-surface-600 shrink-0">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="flex-1 min-w-0 text-xs text-surface-200 truncate">{r.fileName}</span>
                  {r.durationSec && r.durationSec > 0 ? (
                    <span className="text-2xs text-surface-500 tabular-nums shrink-0">
                      {formatDuration(r.durationSec)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="py-1">
            <MenuItem
              onClick={() => { setOpen(false); onOpenAnother() }}
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              }
              label="Open another file..."
              hint="Ctrl+O"
            />
            <MenuItem
              onClick={() => { setOpen(false); onBackToLauncher() }}
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              }
              label="Back to launcher"
              hint="Alt+\u2190"
            />
            <MenuItem
              onClick={() => { setOpen(false); onClose() }}
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              }
              label="Close file"
              danger
            />
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({
  onClick,
  icon,
  label,
  hint,
  danger
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint?: string
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
        ${danger
          ? 'text-surface-300 hover:text-rose-200 hover:bg-rose-500/10'
          : 'text-surface-200 hover:text-surface-50 hover:bg-white/6'}`}
    >
      <span className={`shrink-0 ${danger ? 'text-rose-400/70' : 'text-surface-500'}`}>{icon}</span>
      <span className="flex-1 text-xs">{label}</span>
      {hint && <span className="text-2xs text-surface-600 tabular-nums">{hint}</span>}
    </button>
  )
}

/**
 * Launcher view shown when no media file is loaded AND the user hasn't
 * entered a tool yet. Each card lets the user pick a tool and either
 * open a file immediately or jump into the empty tool to load one there.
 * Below the cards: a big drop band and a row of recent files.
 */
function ToolLauncher({
  onPick,
  onOpenPaths
}: {
  onPick: (mode: EditorMode, openFile: boolean) => void
  onOpenPaths: (paths: string[]) => void
}): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-12">
        <div className="mb-10 text-center">
          <h2 className="text-2xl font-semibold text-surface-100 tracking-tight">Media Editor</h2>
          <p className="text-sm text-surface-400 mt-2 max-w-lg mx-auto">
            Three focused tools that all share the same media engine. Pick one to start - or jump in empty and open a file there.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onPick(tab.id, false)}
              className={`group relative overflow-hidden text-left rounded-2xl border border-white/8 bg-surface-900/40 p-5 transition-all duration-200 ${tab.accentRing} ${tab.accentGlow} hover:-translate-y-0.5`}
            >
              {/* Accent gradient wash */}
              <div className={`pointer-events-none absolute inset-0 bg-linear-to-br ${tab.accentBg} opacity-60`} />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent" />

              <div className="relative">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-5 ${tab.accentIconWrap}`}>
                  <tab.icon size={26} />
                </div>

                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <h3 className="text-base font-semibold text-surface-50">{tab.label}</h3>
                  <span className={`text-2xs uppercase tracking-wider font-medium ${tab.accentText} opacity-80`}>
                    {tab.tagline}
                  </span>
                </div>

                <p className="text-xs text-surface-400 leading-relaxed min-h-12">
                  {tab.blurb}
                </p>

                <div className="mt-5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPick(tab.id, true) }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${tab.accentBtn}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    Open file
                  </button>
                  <span
                    aria-hidden
                    className={`flex items-center gap-1 px-2 py-2 rounded-lg text-xs text-surface-400 group-hover:text-surface-200 transition-colors`}
                  >
                    Enter
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>

        <DropBand onFiles={onOpenPaths} active={false} />

        <RecentsRow onOpen={(p) => onOpenPaths([p])} onForget={removeRecentFile} />

        <p className="text-center text-2xs text-surface-600 mt-10">
          Tip: drop a file anywhere in the editor to open it in the active tool.
        </p>
      </div>
    </div>
  )
}

export default function MediaEditor(): React.JSX.Element {
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const clipMode = useEditorStore((s) => s.clipMode)
  const sources = useEditorStore((s) => s.sources)
  const loadMediaFile = useEditorStore((s) => s.loadMediaFile)
  const closeMediaFile = useEditorStore((s) => s.closeMediaFile)
  const mediaLoading = useEditorStore((s) => s.mediaLoading)

  const source = sources.find((s) => s.id === clipMode.sourceId)
  const hasMedia = !!source

  const [mounted, setMounted] = useState<Set<EditorMode>>(new Set([mode]))
  const [enteredTool, setEnteredTool] = useState(false)

  // Lazy-mount modes on first visit, keep them alive after that
  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(mode)) return prev
      return new Set([...prev, mode])
    })
  }, [mode])

  // Auto-enter a tool on the RISING edge of hasMedia (e.g. deep-link from
  // dashboard). Don't re-enter if the user explicitly went back to the
  // launcher while a file was still loaded.
  const prevHasMedia = useRef(hasMedia)
  useEffect(() => {
    if (hasMedia && !prevHasMedia.current) setEnteredTool(true)
    prevHasMedia.current = hasMedia
  }, [hasMedia])

  // Close file + return to launcher.
  const handleCloseFile = useCallback(() => {
    closeMediaFile()
    setEnteredTool(false)
  }, [closeMediaFile])

  // Back to launcher (keeps file loaded so the user can re-enter the tool).
  const handleBackToTools = useCallback(() => {
    setEnteredTool(false)
  }, [])

  // Launcher: switch mode and optionally open a file in one action.
  const handleLauncherPick = useCallback(
    async (target: EditorMode, openFile: boolean) => {
      setMode(target)
      setEnteredTool(true)
      if (openFile) {
        const files = await window.api.openFiles()
        if (files?.length > 0) loadMediaFile(files[0])
      }
    },
    [setMode, loadMediaFile]
  )

  // Drop band + recents row both feed into this: load first file, enter tool.
  const handleOpenPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return
      setEnteredTool(true)
      loadMediaFile(paths[0])
    },
    [loadMediaFile]
  )

  // Launcher is shown only when the user is explicitly outside any tool.
  // hasMedia alone does not pin them inside - the rising-edge effect above
  // handles the deep-link case where a file appears from elsewhere.
  const showLauncher = !enteredTool

  // Drag-and-drop anywhere to open into the current tool.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      // At this level only handle drops when the launcher is visible
      // (no media + not entered). Once entered, child editors own drops.
      if (!showLauncher) return
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        const filePath = window.api.getFilePath(files[0])
        if (filePath) {
          setEnteredTool(true)
          loadMediaFile(filePath)
        }
      }
    },
    [showLauncher, loadMediaFile]
  )
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (showLauncher) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, [showLauncher])

  // Intercept global back-navigation (mouse button 3 / Alt+Left) while inside
  // a tool: pop to launcher first, then let App handle the next press.
  // Uses capture phase so we beat App.tsx's listeners.
  useEffect(() => {
    if (showLauncher) return
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        e.stopPropagation()
        setEnteredTool(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        setEnteredTool(false)
      }
    }
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [showLauncher])

  return (
    <div className="flex flex-col h-full" onDrop={onDrop} onDragOver={onDragOver}>
      {/* Header: visible whenever the user is inside a tool. */}
      {!showLauncher && (
        <div className="flex items-center gap-3 px-2 sm:px-3 py-1.5 border-b border-white/5">
          {/* Back to launcher */}
          <button
            onClick={handleBackToTools}
            title="Back to tool picker"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-surface-400 hover:text-surface-100 hover:bg-white/4 border border-transparent hover:border-white/8 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span className="hidden sm:inline">Tools</span>
          </button>

          <div className="w-px h-5 bg-white/8" />

          {/* Pill mode switcher */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-surface-900/60 border border-white/5">
            {MODE_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMode(tab.id)}
                title={tab.tooltip}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-150
                  ${
                    mode === tab.id
                      ? 'bg-accent-500/20 text-accent-100 shadow-sm shadow-accent-500/10'
                      : 'text-surface-400 hover:text-surface-200 hover:bg-white/4'
                  }`}
              >
                <tab.icon />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </div>

          {/* File menu (clickable pill - only when a file is loaded) */}
          {hasMedia && source && (
            <FileMenu
              source={source}
              onOpenAnother={async () => {
                const files = await window.api.openFiles()
                if (files?.length > 0) loadMediaFile(files[0])
              }}
              onOpenPath={(p) => loadMediaFile(p)}
              onClose={handleCloseFile}
              onBackToLauncher={handleBackToTools}
            />
          )}

          <div className="flex-1" />

          {/* Open file */}
          <button
            onClick={async () => {
              const files = await window.api.openFiles()
              if (files?.length > 0) loadMediaFile(files[0])
            }}
            disabled={mediaLoading}
            title={hasMedia ? 'Open another file' : 'Open file'}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-surface-400 hover:text-surface-200 hover:bg-white/4 border border-transparent hover:border-white/8 transition-colors disabled:opacity-50"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="hidden sm:inline">Open</span>
          </button>

          {/* Close file (only when loaded) */}
          {hasMedia && (
            <button
              onClick={handleCloseFile}
              title="Close file"
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-surface-400 hover:text-rose-200 hover:bg-rose-500/10 border border-transparent hover:border-rose-400/20 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              <span className="hidden sm:inline">Close</span>
            </button>
          )}
        </div>
      )}

      {/* Mode content - kept alive once mounted, toggled via display.
          When the launcher is showing, render it instead. */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {showLauncher ? (
          <ToolLauncher onPick={handleLauncherPick} onOpenPaths={handleOpenPaths} />
        ) : (
          <>
            {mounted.has('clip') && (
              <div className="h-full" style={{ display: mode === 'clip' ? 'block' : 'none' }}>
                <ClipEditor />
              </div>
            )}
            {mounted.has('edit') && (
              <div className="h-full flex flex-col" style={{ display: mode === 'edit' ? 'flex' : 'none' }}>
                <EditEditor />
              </div>
            )}
            {mounted.has('inspect') && (
              <div className="h-full" style={{ display: mode === 'inspect' ? 'block' : 'none' }}>
                <InspectEditor />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
