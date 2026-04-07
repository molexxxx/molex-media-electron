/**
 * @module components/settings/tabs/ApplicationSettings
 * @description Application tab — updates, notifications, window behavior, paths, and reset.
 */

import React, { useState, useEffect, useCallback } from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { useAppStore } from '../../../stores/appStore'
import { SettingGroup, SettingRow, Toggle } from '../../shared/ui'

interface BrowserOption { name: string; label: string }
type CookieStatus = 'idle' | 'confirming' | 'exporting' | 'success' | 'error'

function formatAge(ms: number | null): string {
  if (ms == null || ms < 0) return 'unknown time'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'less than a minute'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

interface ApplicationSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onResetDefaults: () => void
}

export function ApplicationSettings({ config, onUpdate, onResetDefaults }: ApplicationSettingsProps): React.JSX.Element {
  const updateStatus = useAppStore((s) => s.updateStatus)
  const updateVersion = useAppStore((s) => s.updateVersion)
  const updateError = useAppStore((s) => s.updateError)
  const downloadPercent = useAppStore((s) => s.updateDownloadPercent)
  const setUpdateStatus = useAppStore((s) => s.setUpdateStatus)
  const setUpdateError = useAppStore((s) => s.setUpdateError)

  const [browsers, setBrowsers] = useState<BrowserOption[]>([])
  const [cookieStatus, setCookieStatus] = useState<CookieStatus>('idle')
  const [cookieError, setCookieError] = useState<string | null>(null)
  const [pendingBrowser, setPendingBrowser] = useState<string | null>(null)
  const [cookieInfo, setCookieInfo] = useState<{ exists: boolean; age: number | null; browser: string } | null>(null)

  useEffect(() => {
    window.api.getInstalledBrowsers?.().then(setBrowsers).catch(() => {})
    window.api.getCookieInfo?.().then(setCookieInfo).catch(() => {})
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

  const handleBrowserSelect = useCallback((browserName: string) => {
    if (!browserName) {
      onUpdate('ytdlpBrowser', '')
      return
    }
    setPendingBrowser(browserName)
    setCookieStatus('confirming')
    setCookieError(null)
  }, [onUpdate])

  const confirmCookieExport = useCallback(async () => {
    if (!pendingBrowser) return
    setCookieStatus('exporting')
    setCookieError(null)
    try {
      const result = await window.api.setCookieBrowser(pendingBrowser)
      if (result.success) {
        onUpdate('ytdlpBrowser', pendingBrowser)
        setCookieStatus('success')
        window.api.getCookieInfo?.().then(setCookieInfo).catch(() => {})
      } else {
        setCookieError(result.error || 'Export failed')
        setCookieStatus('error')
      }
    } catch (err: any) {
      setCookieError(err.message || 'Export failed')
      setCookieStatus('error')
    }
    setPendingBrowser(null)
  }, [pendingBrowser, onUpdate])

  const cancelCookieExport = useCallback(() => {
    setPendingBrowser(null)
    setCookieStatus('idle')
    setCookieError(null)
  }, [])

  const handleClearCookies = useCallback(async () => {
    await window.api.clearCookies()
    onUpdate('ytdlpBrowser', '' as any)
    setCookieInfo({ exists: false, age: null, browser: '' })
    setCookieStatus('idle')
    setCookieError(null)
  }, [onUpdate])

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
        <SettingRow label="Sidebar Collapsed" description="Start with the sidebar collapsed on launch">
          <Toggle checked={config.sidebarCollapsed ?? false} onChange={(v) => {
            onUpdate('sidebarCollapsed', v as any)
            useAppStore.setState({ sidebarCollapsed: v })
          }} />
        </SettingRow>
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
      <SettingGroup title="YouTube Cookies">
        <SettingRow label="Cookie Source Browser" description="Browser to extract YouTube login cookies from for age-restricted or private content">
          <select
            value={config.ytdlpBrowser || ''}
            onChange={(e) => handleBrowserSelect(e.target.value)}
            disabled={cookieStatus === 'exporting'}
            className="rounded-lg text-xs bg-surface-800/60 border border-surface-700 text-surface-200 px-2 py-1.5 transition-colors focus:border-accent-500 outline-none"
          >
            <option value="">Auto-detect</option>
            {browsers.map((b) => (
              <option key={b.name} value={b.name}>{b.label}</option>
            ))}
          </select>
        </SettingRow>
        {/* Confirm dialog */}
        {cookieStatus === 'confirming' && pendingBrowser && (
          <div className="mx-4 mb-3 p-3 rounded-lg bg-surface-800/80 border border-surface-700 space-y-2 animate-fade-in">
            <div className="flex items-start gap-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div className="text-xs text-surface-300 space-y-1">
                <p className="font-medium text-surface-200">Close {browsers.find((b) => b.name === pendingBrowser)?.label || pendingBrowser} first</p>
                <p>The browser must be completely closed before cookies can be extracted. This is a one-time process — cookies are cached for 7 days after export.</p>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={confirmCookieExport}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
              >
                Browser is closed — continue
              </button>
              <button
                onClick={cancelCookieExport}
                className="px-3 py-1.5 text-xs text-surface-500 hover:text-surface-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {cookieStatus === 'exporting' && (
          <div className="mx-4 mb-3 flex items-center gap-2 text-xs text-surface-400 animate-fade-in">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
            Extracting cookies…
          </div>
        )}
        {cookieStatus === 'success' && (
          <div className="mx-4 mb-3 text-xs text-green-400 animate-fade-in">
            Cookies exported successfully
          </div>
        )}
        {cookieStatus === 'error' && cookieError && (
          <div className="mx-4 mb-3 text-xs text-red-400 animate-fade-in">
            {cookieError}
          </div>
        )}
        <SettingRow
          label="Cached Cookies"
          description={cookieInfo?.exists
            ? `Exported ${formatAge(cookieInfo.age)} ago${cookieInfo.browser ? ` from ${cookieInfo.browser}` : ''} — refreshes every 7 days`
            : 'No cookies cached — will export on next YouTube request'}
        >
          <button
            onClick={handleClearCookies}
            disabled={!cookieInfo?.exists}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear Cookies
          </button>
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
