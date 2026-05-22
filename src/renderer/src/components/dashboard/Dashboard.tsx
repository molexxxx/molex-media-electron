/**
 * @module components/dashboard/Dashboard
 * @description Home screen with quick stats, workflow actions, tool cards, and system info.
 *
 * Layout:
 *   - Header row: title + inline stat pills.
 *   - Workflow strip: five compact icon-forward batch operation tiles
 *     up top — mirrors the sidebar order (Batch first).
 *   - Hero row: Editor + Player stacked vertically on the left, live
 *     System Pulse on the right spanning the full hero height.
 *   - Recent Activity + System pills footer.
 */

import React from 'react'
import { useAppStore } from '../../stores/appStore'
import { StatBar } from './components/StatCard'
import { ToolCard, drawEditorBg, drawPlayerBg } from './components/ToolCard'
import { RecentActivity } from './components/RecentActivity'
import { SystemInfo } from './components/SystemInfo'


/** Vendor → badge palette for the GPU acceleration chip. */
const GPU_VENDOR_STYLES: Record<string, { dot: string; text: string; bg: string; border: string }> = {
  nvidia: { dot: 'bg-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
  intel:  { dot: 'bg-sky-400',     text: 'text-sky-300',     bg: 'bg-sky-500/10',     border: 'border-sky-500/25' },
  amd:    { dot: 'bg-red-400',     text: 'text-red-300',     bg: 'bg-red-500/10',     border: 'border-red-500/25' },
  cpu:    { dot: 'bg-surface-500', text: 'text-surface-400', bg: 'bg-surface-700/30', border: 'border-surface-600/30' },
}

/**
 * Rolling sparkline chart with hover tooltip. Renders a filled area
 * line chart across a 100x{height} viewBox so the path stretches to
 * the container width regardless of sample count. Hovering reveals a
 * vertical guide, a dot at the nearest sample, and a floating value
 * label so the user can read recorded percentages from history.
 */
function Sparkline({
  data,
  stroke,
  unit = '%',
  height = 30,
  gradientId,
}: {
  data: number[]
  stroke: string
  unit?: string
  height?: number
  gradientId: string
}): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null)
  const w = 100
  const h = height

  if (data.length < 2) {
    return <div className="-mx-1" style={{ height }} />
  }

  const step = w / (data.length - 1)
  const path = data
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - (v / 100) * h).toFixed(2)}`)
    .join(' ')
  const fill = `${path} L${w.toFixed(2)},${h.toFixed(2)} L0,${h.toFixed(2)} Z`

  const handleMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = (e.clientX - rect.left) / rect.width
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1))))
    setHoverIdx(idx)
  }

  const hv = hoverIdx != null ? data[hoverIdx] : null
  const hx = hoverIdx != null ? hoverIdx * step : 0
  const hy = hv != null ? h - (hv / 100) * h : 0
  const hoverRatio = hoverIdx != null && data.length > 1 ? hoverIdx / (data.length - 1) : 0

  return (
    <div className="relative -mx-1" style={{ height }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full h-full cursor-crosshair"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fill} fill={`url(#${gradientId})`} />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth="1.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hoverIdx != null && (
          <>
            <line
              x1={hx}
              y1={0}
              x2={hx}
              y2={h}
              stroke={stroke}
              strokeOpacity="0.4"
              strokeWidth="0.6"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={hx} cy={hy} r="2" fill={stroke} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {hv != null && (
        <div
          className="pointer-events-none absolute -top-1 px-1.5 py-0.5 rounded bg-surface-900/95 border border-white/10 text-2xs font-mono text-surface-200 tabular-nums whitespace-nowrap shadow-lg"
          style={{
            left: `${hoverRatio * 100}%`,
            transform: `translate(${hoverRatio > 0.7 ? 'calc(-100% - 4px)' : '4px'}, -100%)`,
          }}
        >
          {hv.toFixed(1)}{unit}
        </div>
      )}
    </div>
  )
}

/**
 * Live "System Pulse" side panel. Polls the main process every 2 seconds
 * for fresh memory + CPU usage data, keeps rolling sparklines of recent
 * samples, and shows the detected GPU acceleration backend (with NVIDIA
 * GPU utilization when available) alongside FFmpeg status.
 */
function SystemPulse({
  ffmpegVersion,
  workers,
}: {
  ffmpegVersion: string | null
  workers: number | undefined
}): React.JSX.Element {
  const setSystemInfo = useAppStore((s) => s.setSystemInfo)
  const [info, setInfo] = React.useState<{ cpus: number; cpuModel?: string; cpuUsage?: number; totalMemory: number; freeMemory: number } | null>(null)
  const [gpu, setGpu] = React.useState<{ mode: string; label: string; vendor: string; pending: boolean; gpuModel?: string | null } | null>(null)
  const [memHistory, setMemHistory] = React.useState<number[]>([])
  const [cpuHistory, setCpuHistory] = React.useState<number[]>([])
  const [gpuHistory, setGpuHistory] = React.useState<number[]>([])

  React.useEffect(() => {
    let cancelled = false
    const SAMPLES = 32

    const tick = async () => {
      try {
        const next = await window.api.getSystemInfo()
        if (cancelled || !next) return
        setInfo(next)
        setSystemInfo(next)
        const memPct = next.totalMemory > 0
          ? Math.min(100, ((next.totalMemory - next.freeMemory) / next.totalMemory) * 100)
          : 0
        setMemHistory((h) => {
          const out = [...h, memPct]
          return out.length > SAMPLES ? out.slice(out.length - SAMPLES) : out
        })
        const cpuPct = typeof next.cpuUsage === 'number' ? next.cpuUsage : 0
        setCpuHistory((h) => {
          const out = [...h, cpuPct]
          return out.length > SAMPLES ? out.slice(out.length - SAMPLES) : out
        })
      } catch { /* ignore transient IPC failures */ }
    }

    tick()
    const id = window.setInterval(tick, 2000)

    // GPU detection. Re-poll while pending (ffmpeg still bootstrapping)
    // so the chip eventually settles on the detected backend instead of
    // getting stuck at "detecting…" / "CPU only" from an early call.
    let gpuId: number | undefined
    const pollGpu = async () => {
      try {
        const g = await window.api.getGpuInfo?.()
        if (cancelled || !g) return
        setGpu(g)
        if (!g.pending && gpuId !== undefined) {
          window.clearInterval(gpuId)
          gpuId = undefined
        }
      } catch { /* ignore */ }
    }
    pollGpu()
    gpuId = window.setInterval(pollGpu, 3000)

    // GPU utilization poll (NVIDIA only — nvidia-smi). Returns null on
    // non-NVIDIA systems; we simply stop appending in that case and the
    // sparkline tile hides itself.
    const pollGpuUsage = async () => {
      try {
        const r = await window.api.getGpuUsage?.()
        if (cancelled || !r || typeof r.usage !== 'number') return
        setGpuHistory((h) => {
          const out = [...h, r.usage as number]
          return out.length > SAMPLES ? out.slice(out.length - SAMPLES) : out
        })
      } catch { /* ignore */ }
    }
    pollGpuUsage()
    const gpuUsageId = window.setInterval(pollGpuUsage, 2000)

    return () => {
      cancelled = true
      window.clearInterval(id)
      window.clearInterval(gpuUsageId)
      if (gpuId !== undefined) window.clearInterval(gpuId)
    }
  }, [setSystemInfo])

  const totalGB = info ? info.totalMemory / (1024 ** 3) : 0
  const freeGB = info ? info.freeMemory / (1024 ** 3) : 0
  const usedGB = Math.max(0, totalGB - freeGB)
  const usedPct = totalGB > 0 ? Math.min(100, (usedGB / totalGB) * 100) : 0
  const memColor = usedPct > 85 ? 'bg-red-400' : usedPct > 65 ? 'bg-amber-400' : 'bg-emerald-400'
  const memStroke = usedPct > 85 ? '#f87171' : usedPct > 65 ? '#fbbf24' : '#34d399'

  const cpuPct = info?.cpuUsage ?? 0
  const cpuStroke = cpuPct > 85 ? '#f87171' : cpuPct > 60 ? '#fbbf24' : '#60a5fa'
  const gpuPct = gpuHistory.length > 0 ? gpuHistory[gpuHistory.length - 1] : null
  const gpuStroke = gpuPct != null && gpuPct > 85 ? '#f87171' : gpuPct != null && gpuPct > 60 ? '#fbbf24' : '#34d399'

  const gpuStyle = GPU_VENDOR_STYLES[gpu?.vendor || 'cpu']
  const ffmpegShort = ffmpegVersion ? ffmpegVersion.replace(/^ffmpeg version /i, '').split(/\s+/)[0] : null

  return (
    <div className="min-w-0 min-h-[180px] rounded-2xl bg-white/[0.03] border border-white/[0.06] backdrop-blur-sm p-4 flex flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-surface-300 tracking-wider uppercase">System Pulse</h3>
        <span className="flex items-center gap-1.5 text-2xs text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          live
        </span>
      </div>

      {/* Memory: header + capacity bar + rolling sparkline */}
      <div className="rounded-lg bg-surface-900/40 border border-white/[0.04] px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-2xs text-surface-500 uppercase tracking-wider">Memory</div>
            <div className="text-2xs font-mono text-surface-300 truncate">{usedGB.toFixed(1)} / {totalGB.toFixed(1)} GB</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xs text-surface-500 uppercase tracking-wider">{usedPct.toFixed(0)}%</div>
            <div className="text-2xs font-mono text-surface-400 leading-tight">used</div>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-surface-800/70 overflow-hidden">
          <div className={`h-full ${memColor} transition-all duration-700 ease-out`} style={{ width: `${usedPct}%` }} />
        </div>
        <Sparkline data={memHistory} stroke={memStroke} gradientId="spark-mem" height={24} />
      </div>

      {/* CPU: model + cores + usage sparkline */}
      <div className="rounded-lg bg-surface-900/40 border border-white/[0.04] px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-2xs text-surface-500 uppercase tracking-wider">CPU</div>
            <div className="text-2xs font-mono text-surface-300 truncate" title={info?.cpuModel || ''}>{info?.cpuModel || 'detecting…'}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xs text-surface-500 uppercase tracking-wider">{cpuPct.toFixed(0)}% · {info?.cpus ?? '—'}c</div>
            <div className="text-2xs font-mono text-surface-400 leading-tight">load · cores</div>
          </div>
        </div>
        <Sparkline data={cpuHistory} stroke={cpuStroke} gradientId="spark-cpu" height={24} />
      </div>

      {/* GPU acceleration: detected backend + adapter model + utilization */}
      <div className={`rounded-lg ${gpuStyle.bg} border ${gpuStyle.border} px-2.5 py-2 flex flex-col gap-1.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-2xs text-surface-500 uppercase tracking-wider">
              GPU Accel{gpuPct != null && <span className="ml-1 text-surface-400 normal-case">· {gpuPct.toFixed(0)}%</span>}
            </div>
            <div className={`text-sm font-semibold ${gpuStyle.text} truncate`}>{gpu ? gpu.label : 'detecting…'}</div>
          </div>
          <span className={`shrink-0 w-2 h-2 rounded-full ${gpuStyle.dot} ${gpu && !gpu.pending ? '' : 'animate-pulse'}`} />
        </div>
        {gpu?.gpuModel && (
          <div className="text-2xs font-mono text-surface-400 truncate" title={gpu.gpuModel}>{gpu.gpuModel}</div>
        )}
        {gpuHistory.length >= 2 && (
          <Sparkline data={gpuHistory} stroke={gpuStroke} gradientId="spark-gpu" height={24} />
        )}
      </div>

      {/* Workers */}
      <div className="rounded-lg bg-surface-900/40 border border-white/[0.04] px-2.5 py-2 flex items-center justify-between gap-2">
        <div className="text-2xs text-surface-500 uppercase tracking-wider">Workers</div>
        <div className="text-sm font-semibold text-surface-200 tabular-nums">{workers ?? '—'}</div>
      </div>

      {/* FFmpeg footer */}
      <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-900/40 border border-white/[0.04] px-2.5 py-2 mt-auto">
        <div className="min-w-0">
          <div className="text-2xs text-surface-500 uppercase tracking-wider">FFmpeg</div>
          <div className="text-2xs font-mono text-surface-300 truncate">{ffmpegShort ?? 'detecting…'}</div>
        </div>
        <span className={`shrink-0 w-2 h-2 rounded-full ${ffmpegShort ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
      </div>
    </div>
  )
}

export default function Dashboard(): React.JSX.Element {
  const { systemInfo, ffmpegVersion, config, totalProcessed, totalErrors, files, isProcessing, setView, setOperation, tasks } = useAppStore()

  const activeTasks = tasks.filter((t) => t.status === 'processing' || t.status === 'analyzing')

  const quickActions = [
    { label: 'Convert', desc: 'Transcode formats', op: 'convert' as const, accent: 'blue', icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polyline points="16,3 21,3 21,8" /><line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21,16 21,21 16,21" /><line x1="15" y1="15" x2="21" y2="21" />
      </svg>
    )},
    { label: 'Normalize', desc: 'BS.1770 loudness', op: 'normalize' as const, accent: 'accent', icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    )},
    { label: 'Boost', desc: 'Gain & limiter', op: 'boost' as const, accent: 'emerald', icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    )},
    { label: 'Compress', desc: 'Reduce size', op: 'compress' as const, accent: 'amber', icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    )},
    { label: 'Extract', desc: 'Rip audio', op: 'extract' as const, accent: 'purple', icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="10" /><polygon points="10,8 16,12 10,16" />
      </svg>
    )},
  ]

  // Per-accent classes for the workflow tiles. Kept inline so Tailwind's
  // JIT picks them up at build time (no dynamic class names).
  const tileAccent: Record<string, { icon: string; iconBg: string; hoverBorder: string; hoverGlow: string }> = {
    blue:    { icon: 'text-blue-400',    iconBg: 'bg-blue-500/10 border-blue-500/20',       hoverBorder: 'hover:border-blue-500/40',    hoverGlow: 'hover:shadow-blue-500/10' },
    accent:  { icon: 'text-accent-400',  iconBg: 'bg-accent-500/10 border-accent-500/20',   hoverBorder: 'hover:border-accent-500/40',  hoverGlow: 'hover:shadow-accent-500/10' },
    emerald: { icon: 'text-emerald-400', iconBg: 'bg-emerald-500/10 border-emerald-500/20', hoverBorder: 'hover:border-emerald-500/40', hoverGlow: 'hover:shadow-emerald-500/10' },
    amber:   { icon: 'text-amber-400',   iconBg: 'bg-amber-500/10 border-amber-500/20',     hoverBorder: 'hover:border-amber-500/40',   hoverGlow: 'hover:shadow-amber-500/10' },
    purple:  { icon: 'text-purple-400',  iconBg: 'bg-purple-500/10 border-purple-500/20',   hoverBorder: 'hover:border-purple-500/40',  hoverGlow: 'hover:shadow-purple-500/10' },
  }

  return (
    <div className="flex flex-col min-h-full animate-fade-in gap-3 pr-2 sm:pr-3 md:pr-4">
      {/* Header + Stats */}
      <div className="flex items-center justify-between gap-4 flex-wrap shrink-0">
        <div>
          <h1 className="text-xl font-medium text-surface-200 tracking-tight">Dashboard</h1>
          <p className="text-xs text-surface-500 mt-0.5">Media processing toolkit</p>
        </div>
        <StatBar stats={[
          { label: 'Queued', value: files.length, color: 'text-accent-400', dotColor: 'bg-accent-400' },
          { label: 'Active', value: activeTasks.length, color: isProcessing ? 'text-amber-400' : 'text-surface-400', dotColor: isProcessing ? 'bg-amber-400 animate-pulse' : 'bg-surface-600' },
          { label: 'Done', value: totalProcessed, color: 'text-emerald-400', dotColor: 'bg-emerald-400' },
          { label: 'Errors', value: totalErrors, color: totalErrors > 0 ? 'text-red-400' : 'text-surface-400', dotColor: totalErrors > 0 ? 'bg-red-400' : 'bg-surface-600' },
        ]} />
      </div>

      {/* Workflow strip — batch operations come first to match the sidebar
          ordering (Batch sits above Editor/Player). Compact horizontal
          tiles; responsive: 2 cols on mobile, 3 on tablet, 5 on desktop. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 shrink-0">
        {quickActions.map((action) => {
          const a = tileAccent[action.accent] || tileAccent.blue
          return (
            <button
              key={action.op}
              onClick={() => { setOperation(action.op); setView('batch') }}
              className={`group relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.06] ${a.hoverBorder} transition-all duration-300 hover:bg-white/[0.05] backdrop-blur-sm hover:-translate-y-0.5 shadow-sm ${a.hoverGlow} hover:shadow-lg px-3 py-3 text-left`}
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-10 h-10 shrink-0 rounded-lg border flex items-center justify-center transition-transform duration-300 group-hover:scale-105 ${a.iconBg} ${a.icon}`}>
                  {action.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-semibold text-surface-200 group-hover:text-white transition-colors leading-tight truncate">{action.label}</h4>
                  <p className="text-2xs text-surface-500 group-hover:text-surface-400 transition-colors mt-0.5 truncate">{action.desc}</p>
                </div>
                <svg className={`w-3.5 h-3.5 shrink-0 ${a.icon} opacity-0 group-hover:opacity-80 group-hover:translate-x-0.5 -translate-x-1 transition-all duration-300`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
            </button>
          )
        })}
      </div>

      {/* Hero: Editor + Player stacked vertically on the left, live System
          Pulse on the right spanning both rows. On large screens the hero
          claims remaining vertical space (flex-1); when stacked on small
          screens we let it size naturally so the page can scroll. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-3 lg:flex-1 lg:min-h-[320px]">
        <div className="grid grid-rows-1 lg:grid-rows-2 gap-3 min-w-0 min-h-0">
          <div className="min-w-0 min-h-[140px]">
            <ToolCard
              onClick={() => setView('editor')}
              accentClass="blue"
              title="Media Editor"
              desc="Multi-track timeline, spatial transforms, keyframes, real-time preview"
              drawBg={drawEditorBg}
              icon={
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3" />
                  <line x1="14.5" y1="7.5" x2="18.5" y2="11.5" />
                  <line x1="2" y1="22" x2="22" y2="22" />
                </svg>
              }
            />
          </div>
          <div className="min-w-0 min-h-[140px]">
            <ToolCard
              onClick={() => setView('player')}
              accentClass="accent"
              title="Media Player"
              desc="Play local files or stream from URLs with audio visualizations"
              drawBg={drawPlayerBg}
              icon={
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
              }
            />
          </div>
        </div>
        <SystemPulse ffmpegVersion={ffmpegVersion} workers={config?.maxWorkers} />
      </div>

      {/* Recent Activity (only when there are tasks) */}
      {tasks.length > 0 && (
        <div className="shrink-0">
          <RecentActivity tasks={tasks} />
        </div>
      )}

      {/* System pills footer */}
      <div className="shrink-0">
        <SystemInfo systemInfo={systemInfo} ffmpegVersion={ffmpegVersion} config={config} />
      </div>
    </div>
  )
}

