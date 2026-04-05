import { useAppStore } from '../stores/appStore'

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color: string }): JSX.Element {
  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-1">
      <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">{label}</span>
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-2xs text-surface-500">{sub}</span>}
    </div>
  )
}

export default function Dashboard(): JSX.Element {
  const { systemInfo, ffmpegVersion, config, totalProcessed, totalErrors, files, isProcessing, setView, tasks } = useAppStore()

  const activeTasks = tasks.filter((t) => t.status === 'processing' || t.status === 'analyzing')

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-sm text-surface-400 mt-1">Overview of your audio processing workspace</p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="Queue"
          value={files.length}
          sub={files.length === 1 ? 'file ready' : 'files ready'}
          color="text-accent-400"
        />
        <StatCard
          label="Processing"
          value={activeTasks.length}
          sub={isProcessing ? 'active now' : 'idle'}
          color={isProcessing ? 'text-amber-400' : 'text-surface-300'}
        />
        <StatCard
          label="Completed"
          value={totalProcessed}
          sub="this session"
          color="text-emerald-400"
        />
        <StatCard
          label="Errors"
          value={totalErrors}
          sub="this session"
          color={totalErrors > 0 ? 'text-red-400' : 'text-surface-300'}
        />
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setView('queue')}
          className="glass-hover rounded-xl p-5 text-left group"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-accent-500/10 border border-accent-500/20 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-accent-400">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-surface-200 group-hover:text-white transition-colors">Normalize Audio</h3>
              <p className="text-xs text-surface-500">ITU-R BS.1770-4 loudness standard</p>
            </div>
          </div>
          <p className="text-xs text-surface-500 leading-relaxed">
            Analyze and normalize audio to target loudness levels. Perfect for consistent volume across media files.
          </p>
        </button>

        <button
          onClick={() => setView('queue')}
          className="glass-hover rounded-xl p-5 text-left group"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-emerald-400">
                <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-surface-200 group-hover:text-white transition-colors">Boost Volume</h3>
              <p className="text-xs text-surface-500">Amplify audio by percentage</p>
            </div>
          </div>
          <p className="text-xs text-surface-500 leading-relaxed">
            Increase or decrease volume of audio tracks by a custom percentage. Great for quiet recordings.
          </p>
        </button>
      </div>

      {/* System Info */}
      <div className="glass rounded-xl p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-3">System</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <InfoRow label="FFmpeg" value={ffmpegVersion || 'Not installed'} ok={!!ffmpegVersion} />
          <InfoRow label="Platform" value={formatPlatform(systemInfo?.platform, systemInfo?.arch)} />
          <InfoRow label="CPU Cores" value={String(systemInfo?.cpus || '—')} />
          <InfoRow label="Workers" value={String(config?.maxWorkers || '—')} />
          <InfoRow label="Audio Codec" value={config?.audioCodec || '—'} />
          <InfoRow label="Bitrate" value={config?.audioBitrate || '—'} />
          <InfoRow
            label="Target LUFS"
            value={config ? `I=${config.normalization.I} TP=${config.normalization.TP} LRA=${config.normalization.LRA}` : '—'}
          />
          <InfoRow
            label="Memory"
            value={systemInfo ? `${formatBytes(systemInfo.freeMemory)} free / ${formatBytes(systemInfo.totalMemory)}` : '—'}
          />
        </div>
      </div>

      {/* Recent activity */}
      {tasks.length > 0 && (
        <div className="glass rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500">Recent Activity</h3>
            <button
              onClick={() => setView('processing')}
              className="text-2xs text-accent-400 hover:text-accent-300 font-medium transition-colors"
            >
              View All →
            </button>
          </div>
          <div className="space-y-1.5">
            {tasks.slice(-5).reverse().map((task) => (
              <div key={task.id} className="flex items-center gap-3 py-1.5">
                <StatusDot status={task.status} />
                <span className="text-sm text-surface-300 flex-1 truncate">{task.fileName}</span>
                <span className="text-2xs text-surface-500 font-mono">{task.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value, ok }: { label: string; value: string; ok?: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-surface-500 text-xs">{label}</span>
      <span className={`font-mono text-xs ${ok === true ? 'text-emerald-400' : ok === false ? 'text-red-400' : 'text-surface-300'}`}>
        {value}
      </span>
    </div>
  )
}

function StatusDot({ status }: { status: string }): JSX.Element {
  const colors: Record<string, string> = {
    complete: 'bg-emerald-400',
    error: 'bg-red-400',
    processing: 'bg-amber-400 animate-pulse',
    analyzing: 'bg-blue-400 animate-pulse',
    queued: 'bg-surface-500',
    cancelled: 'bg-surface-500',
    finalizing: 'bg-cyan-400 animate-pulse'
  }
  return <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[status] || 'bg-surface-500'}`} />
}

function formatPlatform(platform?: string, arch?: string): string {
  const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return `${names[platform || ''] || platform || '—'} ${arch || ''}`
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '—'
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}
