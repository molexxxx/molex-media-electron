/**
 * @module components/dashboard/SystemInfo
 * @description System information panel displaying FFmpeg version, paths, and OS details.
 */

import React from 'react'
import type { AppConfig, SystemInfo as SystemInfoType } from '../../../stores/types'

function InfoRow({ label, value, ok }: { label: string; value: string; ok?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 min-w-0">
      <span className="text-surface-500 text-xs shrink-0">{label}</span>
      <span className={`font-mono text-xs truncate ${ok === true ? 'text-emerald-400' : ok === false ? 'text-red-400' : 'text-surface-300'}`}>
        {value}
      </span>
    </div>
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
    <div className="glass rounded-xl p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-2">System</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
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
  )
}
