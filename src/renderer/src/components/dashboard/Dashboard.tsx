/**
 * @module components/dashboard/Dashboard
 * @description Home screen with quick stats, workflow actions, tool cards, and system info.
 *
 * Provides at-a-glance metrics (batch count, processing status, errors),
 * one-click workflow launchers for each batch operation, animated tool
 * cards for the Editor and Player, system information (FFmpeg version,
 * CPU cores, memory), and a recent-activity task feed.
 */

import React from 'react'
import { useAppStore } from '../../stores/appStore'
import { StatBar } from './components/StatCard'
import { ToolCard, drawEditorBg, drawPlayerBg } from './components/ToolCard'
import { SystemInfo } from './components/SystemInfo'


export default function Dashboard(): React.JSX.Element {
  const { systemInfo, ffmpegVersion, config, totalProcessed, totalErrors, files, isProcessing, setView, setOperation, tasks } = useAppStore()

  const activeTasks = tasks.filter((t) => t.status === 'processing' || t.status === 'analyzing')

  const quickActions = [
    { label: 'Convert', desc: 'Transcode formats', op: 'convert' as const, iconClass: 'text-blue-400', boxClass: 'bg-blue-500/10 border-blue-500/20', hoverBorder: 'hover:border-blue-500/30', icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polyline points="16,3 21,3 21,8" /><line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21,16 21,21 16,21" /><line x1="15" y1="15" x2="21" y2="21" />
      </svg>
    )},
    { label: 'Normalize', desc: 'ITU-R BS.1770 loudness', op: 'normalize' as const, iconClass: 'text-accent-400', boxClass: 'bg-accent-500/10 border-accent-500/20', hoverBorder: 'hover:border-accent-500/30', icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    )},
    { label: 'Boost Audio', desc: 'Adjust gain level', op: 'boost' as const, iconClass: 'text-emerald-400', boxClass: 'bg-emerald-500/10 border-emerald-500/20', hoverBorder: 'hover:border-emerald-500/30', icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    )},
    { label: 'Compress', desc: 'Reduce file size', op: 'compress' as const, iconClass: 'text-amber-400', boxClass: 'bg-amber-500/10 border-amber-500/20', hoverBorder: 'hover:border-amber-500/30', icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7,10 12,15 17,10" /><line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    )},
    { label: 'Extract', desc: 'Rip audio tracks', op: 'extract' as const, iconClass: 'text-purple-400', boxClass: 'bg-purple-500/10 border-purple-500/20', hoverBorder: 'hover:border-purple-500/30', icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="10" /><polygon points="10,8 16,12 10,16" />
      </svg>
    )},
  ]

  return (
    <div className="flex flex-col min-h-full animate-fade-in">
      {/* Header + Inline Stats */}
      <div className="mb-4">
        <h1 className="text-xl font-medium text-surface-200 tracking-tight">Dashboard</h1>
        <div className="flex items-center justify-between gap-4 mt-1.5 flex-wrap">
          <p className="text-xs text-surface-400">Media processing toolkit — audio, video, and everything in between</p>
          <StatBar stats={[
            { label: 'Queued', value: files.length, color: 'text-accent-400', dotColor: 'bg-accent-400' },
            { label: 'Active', value: activeTasks.length, color: isProcessing ? 'text-amber-400' : 'text-surface-400', dotColor: isProcessing ? 'bg-amber-400 animate-pulse' : 'bg-surface-600' },
            { label: 'Done', value: totalProcessed, color: 'text-emerald-400', dotColor: 'bg-emerald-400' },
            { label: 'Errors', value: totalErrors, color: totalErrors > 0 ? 'text-red-400' : 'text-surface-400', dotColor: totalErrors > 0 ? 'bg-red-400' : 'bg-surface-600' },
          ]} />
        </div>
      </div>

      {/* Workflow Actions */}
      <div className="mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-3">Workflow</h3>
        <div className="flex flex-col sm:grid sm:grid-cols-5 gap-1.5 sm:gap-2">
          {quickActions.map((action) => (
            <button
              key={action.op}
              onClick={() => { setOperation(action.op); setView('batch') }}
              className={`rounded-xl group bg-white/[0.03] border border-white/[0.06] ${action.hoverBorder} transition-all duration-200 backdrop-blur-sm hover:bg-white/[0.05] flex items-center gap-3 px-3 py-2.5 sm:flex-col sm:px-2 sm:py-3 sm:text-center sm:gap-0`}
            >
              <div className={`w-8 h-8 sm:w-9 sm:h-9 shrink-0 sm:mx-auto rounded-lg border flex items-center justify-center sm:mb-2 ${action.boxClass} ${action.iconClass}`}>
                {action.icon}
              </div>
              <h4 className="text-xs font-semibold text-surface-200 group-hover:text-white transition-colors truncate">{action.label}</h4>
            </button>
          ))}
        </div>
      </div>

      {/* Tools — Editor & Player */}
      <div className="flex-1 flex flex-col min-h-0">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-3">Tools</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Editor card */}
          <ToolCard
            onClick={() => setView('editor')}
            accentClass="blue"
            title="Media Editor"
            desc="Cut, trim, and merge with precision timeline controls"
            drawBg={drawEditorBg}
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3" />
                <line x1="14.5" y1="7.5" x2="18.5" y2="11.5" />
                <line x1="2" y1="22" x2="22" y2="22" />
              </svg>
            }
          />

          {/* Player card */}
          <ToolCard
            onClick={() => setView('player')}
            accentClass="accent"
            title="Media Player"
            desc="Play local files or stream from URLs such as YouTube with visualizations"
            drawBg={drawPlayerBg}
            icon={
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            }
          />
        </div>
      </div>

      <div className="mt-auto pt-3">
        <SystemInfo systemInfo={systemInfo} ffmpegVersion={ffmpegVersion} config={config} />
      </div>
    </div>
  )
}
