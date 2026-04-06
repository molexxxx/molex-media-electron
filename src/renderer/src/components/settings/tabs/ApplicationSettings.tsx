/**
 * @module components/settings/tabs/ApplicationSettings
 * @description Application tab — updates, notifications, window behavior, paths, and reset.
 */

import React, { useState, useEffect, useCallback } from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { SettingGroup, SettingRow, Toggle } from '../../shared/ui'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'

interface ApplicationSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onResetDefaults: () => void
}

export function ApplicationSettings({ config, onUpdate, onResetDefaults }: ApplicationSettingsProps): React.JSX.Element {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)

  useEffect(() => {
    const cleanup = window.api.onUpdaterStatus?.((info: any) => {
      setUpdateStatus(info.status)
      if (info.version) setUpdateVersion(info.version)
      if (info.error) setUpdateError(info.error)
      if (info.percent != null) setDownloadPercent(info.percent)
    })
    return cleanup
  }, [])

  const checkNow = useCallback(async () => {
    setUpdateStatus('checking')
    setUpdateError(null)
    const result = await window.api.checkForUpdates()
    if (!result.success) {
      setUpdateStatus('error')
      setUpdateError(result.error || 'Check failed')
    }
  }, [])

  const downloadNow = useCallback(async () => {
    const result = await window.api.downloadUpdate()
    if (!result.success) {
      setUpdateStatus('error')
      setUpdateError(result.error || 'Download failed')
    }
  }, [])

  const installNow = useCallback(() => {
    window.api.installUpdate()
  }, [])

  return (
    <div className="space-y-5">
      <SettingGroup title="Updates">
        <SettingRow label="Automatic Updates" description="Check for updates when the app starts">
          <Toggle checked={config.autoUpdate} onChange={(v) => onUpdate('autoUpdate', v)} />
        </SettingRow>
        <div className="px-4 pb-3 space-y-2">
          <div className="flex items-center gap-3">
            {updateStatus === 'downloaded' ? (
              <button
                onClick={installNow}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
              >
                Install & Restart
              </button>
            ) : updateStatus === 'available' ? (
              <button
                onClick={downloadNow}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
              >
                Download v{updateVersion}
              </button>
            ) : (
              <button
                onClick={checkNow}
                disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updateStatus === 'checking' ? 'Checking…' : 'Check for Updates'}
              </button>
            )}
            <span className="text-2xs text-surface-500">
              {updateStatus === 'checking' && 'Looking for new releases…'}
              {updateStatus === 'up-to-date' && 'You\'re on the latest version'}
              {updateStatus === 'available' && `v${updateVersion} is available`}
              {updateStatus === 'downloading' && `Downloading… ${downloadPercent}%`}
              {updateStatus === 'downloaded' && `v${updateVersion} ready to install`}
              {updateStatus === 'error' && (
                <span className="text-red-400">{updateError}</span>
              )}
            </span>
          </div>
          {updateStatus === 'downloading' && (
            <div className="h-1 rounded-full bg-surface-700 overflow-hidden">
              <div
                className="h-full bg-accent-500 rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
          )}
        </div>
      </SettingGroup>
      <SettingGroup title="Notifications">
        <SettingRow label="Desktop Notifications" description="Show a system notification when batch processing completes">
          <Toggle checked={config.showNotifications} onChange={(v) => onUpdate('showNotifications', v)} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Window Behavior">
        <SettingRow label="Minimize to Tray" description="Close button hides to system tray instead of quitting">
          <Toggle checked={config.minimizeToTray} onChange={(v) => {
            onUpdate('minimizeToTray', v)
            if (!v) onUpdate('showTrayNotification', false)
          }} />
        </SettingRow>
        {config.minimizeToTray && (
          <SettingRow label="Confirm on Close" description="Ask whether to minimize or quit each time you close">
            <Toggle checked={config.showTrayNotification} onChange={(v) => onUpdate('showTrayNotification', v)} />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title="Paths">
        <SettingRow label="FFmpeg" description="Auto-detected or downloaded on first launch">
          <span className="text-xs text-surface-500 font-mono max-w-[300px] truncate block" title={config.ffmpegPath || 'Not set'}>
            {config.ffmpegPath || 'Not set'}
          </span>
        </SettingRow>
        <SettingRow label="FFprobe" description="Used for media analysis and probing">
          <span className="text-xs text-surface-500 font-mono max-w-[300px] truncate block" title={config.ffprobePath || 'Not set'}>
            {config.ffprobePath || 'Not set'}
          </span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="About">
        <div className="flex items-center justify-between">
          <div className="text-xs text-surface-400 space-y-1">
            <p><span className="text-surface-300 font-medium">molexMedia</span> v{config.version}</p>
            <p>Media processing toolkit powered by FFmpeg</p>
          </div>
          <button
            onClick={onResetDefaults}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 hover:text-white transition-colors"
          >
            Reset to Defaults
          </button>
        </div>
      </SettingGroup>
    </div>
  )
}
