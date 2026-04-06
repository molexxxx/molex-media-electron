/**
 * @module components/settings/tabs/ApplicationSettings
 * @description Application tab — notifications, window behavior, paths, and reset.
 */

import React from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { SettingGroup, SettingRow, Toggle } from '../../shared/ui'

interface ApplicationSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onResetDefaults: () => void
}

export function ApplicationSettings({ config, onUpdate, onResetDefaults }: ApplicationSettingsProps): React.JSX.Element {
  return (
    <div className="space-y-5">
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
