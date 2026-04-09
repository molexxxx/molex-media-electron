/** @module editor/inspect/StreamInfo - Per-stream metadata display. */
import React from 'react'

interface StreamBase {
  index: number
  codec_name: string
  bit_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
  profile?: string
}

interface VideoStreamData extends StreamBase {
  width: number
  height: number
  duration?: string
  r_frame_rate?: string
  pix_fmt?: string
}

interface AudioStreamData extends StreamBase {
  channels: number
  sample_rate: string
  channel_layout?: string
}

interface SubtitleStreamData {
  index: number
  codec_name: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

interface DataStreamData {
  index: number
  codec_name: string
  codec_type: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

/** Props added to every stream component for toggle support. */
interface StreamToggleProps {
  included?: boolean
  onToggle?: (index: number) => void
}

/** Format a bitrate number-string to human-readable. */
function formatBitrate(br?: string): string {
  if (!br) return '-'
  const n = parseInt(br, 10)
  if (isNaN(n)) return br
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mb/s`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} kb/s`
  return `${n} b/s`
}

/** Parse FFprobe rational frame rate string (e.g. "30000/1001"). */
function parseFps(str?: string): string {
  if (!str) return '-'
  const parts = str.split('/')
  if (parts.length === 2) {
    const num = parseFloat(parts[0])
    const den = parseFloat(parts[1])
    if (den > 0) return `${(num / den).toFixed(3)} fps`
  }
  const n = parseFloat(str)
  return isNaN(n) ? str : `${n} fps`
}

/** Active dispositions as a comma-separated string. */
function formatDisposition(d?: Record<string, number>): string | null {
  if (!d) return null
  const active = Object.entries(d)
    .filter(([, v]) => v === 1)
    .map(([k]) => k)
  return active.length > 0 ? active.join(', ') : null
}

/* -- Shared row helper -- */
function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element | null {
  if (value === '-' || value === null || value === undefined) return null
  return (
    <div className="flex gap-2 py-0.5">
      <span className="text-surface-500 shrink-0 w-28 text-right">{label}</span>
      <span className="text-surface-200 break-all">{value}</span>
    </div>
  )
}

/* -- Stream card wrapper -- */
function StreamCard({
  icon,
  title,
  index,
  included,
  onToggle,
  children
}: {
  icon: React.ReactNode
  title: string
  index: number
  included?: boolean
  onToggle?: (index: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const excluded = included === false
  return (
    <div className={`rounded-lg border p-3 transition-colors ${excluded ? 'bg-white/[0.01] border-white/[0.03] opacity-50' : 'bg-white/[0.03] border-white/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        {onToggle && (
          <button
            onClick={() => onToggle(index)}
            className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              excluded
                ? 'border-surface-600 bg-transparent'
                : 'border-accent-500/50 bg-accent-500/20'
            }`}
            title={excluded ? 'Include stream' : 'Exclude stream'}
          >
            {!excluded && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-accent-300"><polyline points="20 6 9 17 4 12" /></svg>
            )}
          </button>
        )}
        {icon}
        <span className="text-xs font-semibold text-surface-300 uppercase tracking-wide">{title}</span>
        {excluded && <span className="text-2xs text-red-400/70 ml-auto">excluded</span>}
      </div>
      <div className="text-xs font-mono">{children}</div>
    </div>
  )
}

/* -- Icons -- */
const VideoIcon = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><rect x="2" y="2" width="20" height="20" rx="2" /><polygon points="10 8 16 12 10 16 10 8" /></svg>
)
const AudioIcon = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
)
const SubtitleIcon = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-400"><rect x="2" y="2" width="20" height="20" rx="2" /><line x1="6" y1="14" x2="18" y2="14" /><line x1="8" y1="18" x2="16" y2="18" /></svg>
)
const DataIcon = (): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-surface-400"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>
)

/* -- Per-type stream renderers -- */
export function VideoStreamInfo({ stream, included, onToggle }: { stream: VideoStreamData } & StreamToggleProps): React.JSX.Element {
  const disp = formatDisposition(stream.disposition)
  return (
    <StreamCard icon={<VideoIcon />} title={`Video · Stream #${stream.index}`} index={stream.index} included={included} onToggle={onToggle}>
      <Row label="Codec" value={stream.profile ? `${stream.codec_name} (${stream.profile})` : stream.codec_name} />
      <Row label="Resolution" value={stream.width && stream.height ? `${stream.width}×${stream.height}` : '-'} />
      <Row label="Frame rate" value={parseFps(stream.r_frame_rate)} />
      <Row label="Pixel format" value={stream.pix_fmt || '-'} />
      <Row label="Bitrate" value={formatBitrate(stream.bit_rate)} />
      {disp && <Row label="Disposition" value={disp} />}
      {stream.tags?.language && <Row label="Language" value={stream.tags.language} />}
    </StreamCard>
  )
}

export function AudioStreamInfo({ stream, included, onToggle }: { stream: AudioStreamData } & StreamToggleProps): React.JSX.Element {
  const disp = formatDisposition(stream.disposition)
  return (
    <StreamCard icon={<AudioIcon />} title={`Audio · Stream #${stream.index}`} index={stream.index} included={included} onToggle={onToggle}>
      <Row label="Codec" value={stream.profile ? `${stream.codec_name} (${stream.profile})` : stream.codec_name} />
      <Row label="Channels" value={`${stream.channels} (${stream.channel_layout || 'unknown layout'})`} />
      <Row label="Sample rate" value={`${stream.sample_rate} Hz`} />
      <Row label="Bitrate" value={formatBitrate(stream.bit_rate)} />
      {disp && <Row label="Disposition" value={disp} />}
      {stream.tags?.language && <Row label="Language" value={stream.tags.language} />}
      {stream.tags?.title && <Row label="Title" value={stream.tags.title} />}
    </StreamCard>
  )
}

export function SubtitleStreamInfo({ stream, included, onToggle }: { stream: SubtitleStreamData } & StreamToggleProps): React.JSX.Element {
  const disp = formatDisposition(stream.disposition)
  return (
    <StreamCard icon={<SubtitleIcon />} title={`Subtitle · Stream #${stream.index}`} index={stream.index} included={included} onToggle={onToggle}>
      <Row label="Codec" value={stream.codec_name} />
      {stream.tags?.language && <Row label="Language" value={stream.tags.language} />}
      {stream.tags?.title && <Row label="Title" value={stream.tags.title} />}
      {disp && <Row label="Disposition" value={disp} />}
    </StreamCard>
  )
}

export function DataStreamInfo({ stream, included, onToggle }: { stream: DataStreamData } & StreamToggleProps): React.JSX.Element {
  return (
    <StreamCard icon={<DataIcon />} title={`${stream.codec_type} · Stream #${stream.index}`} index={stream.index} included={included} onToggle={onToggle}>
      <Row label="Codec" value={stream.codec_name} />
      {stream.tags?.language && <Row label="Language" value={stream.tags.language} />}
    </StreamCard>
  )
}
