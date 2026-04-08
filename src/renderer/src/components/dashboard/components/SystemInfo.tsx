/**
 * @module components/dashboard/SystemInfo
 * @description Minimal system info footer with pill badges.
 */

import React from 'react'
import type { AppConfig, SystemInfo as SystemInfoType } from '../../../stores/types'

function Pill({ children, accent }: { children: React.ReactNode; accent?: boolean }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-mono ${
      accent ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/15' : 'text-surface-400 bg-white/[0.03] border border-white/[0.04]'
    }`}>
      {children}
    </span>
  )
}

function formatPlatform(platform?: string, arch?: string): string {
  const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return `${names[platform || ''] || platform || '—'} ${arch || ''}`
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '—'
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

export function SystemInfo({ systemInfo, ffmpegVersion, config }: {
  systemInfo: SystemInfoType | null
  ffmpegVersion: string
  config: AppConfig | null
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap py-2 border-t border-white/[0.04]">
      <span className="text-2xs text-surface-600 uppercase tracking-wider font-semibold mr-1">Sys</span>
      <Pill accent={!!ffmpegVersion}>FFmpeg {ffmpegVersion ? '✓' : '✗'}</Pill>
      <Pill>{formatPlatform(systemInfo?.platform, systemInfo?.arch)}</Pill>
      <Pill>{systemInfo?.cpus || '—'} cores</Pill>
      <Pill>{config?.maxWorkers || '—'} workers</Pill>
      <Pill>{config?.audioCodec || '—'}</Pill>
      <Pill>{config?.audioBitrate || '—'}</Pill>
      {systemInfo && <Pill>{formatBytes(systemInfo.freeMemory)} free</Pill>}
    </div>
  )
}
