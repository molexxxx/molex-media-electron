/**
 * @module components/settings/Settings
 * @description Settings page: the tab bar and page frame over {@link BatchSettings},
 * {@link PresetSettings}, {@link FfmpegSettings}, and {@link ApplicationSettings}. There are no
 * global loudness or encoding settings: each job carries its own operation and preset.
 *
 * Renderer-owned keys save through config:save 600 ms after an edit (main strips the keys it owns,
 * so this save can never write the batch settings); the Batch tab writes through engine commands.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, AppConfig } from '../../stores/appStore'
import { useJobsStore } from '../../stores/jobs'
import { Tabs, type TabItem } from '../../ui'
import { FfmpegSettings } from './tabs/AudioSettings'
import { BatchSettings, resetBatchDefaults, resetMessage } from './tabs/BatchSettings'
import { ApplicationSettings } from './tabs/ApplicationSettings'
import { PresetSettings } from './tabs/PresetSettings'

type SettingsTab = 'batch' | 'presets' | 'ffmpeg' | 'application'

const TABS: ReadonlyArray<TabItem<SettingsTab>> = [
  { value: 'batch', label: 'Batch' },
  { value: 'presets', label: 'Presets' },
  { value: 'ffmpeg', label: 'FFmpeg' },
  { value: 'application', label: 'Application' }
]

/** The renderer-owned keys a reset restores, at their new-install values. */
export const APPLICATION_DEFAULTS: Partial<AppConfig> = {
  autoUpdate: true,
  showNotifications: true,
  minimizeToTray: true,
  showTrayNotification: true,
  sidebarCollapsed: false,
  interfaceScale: 100,
  announceProgress: false
}

const SAVED_MS = 1500

export default function Settings(): React.JSX.Element {
  const { config, setConfig } = useAppStore()
  const [localConfig, setLocalConfig] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SettingsTab>('batch')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localConfigRef = useRef<AppConfig | null>(null)

  useEffect(() => {
    if (config) setLocalConfig({ ...config })
  }, [config])

  useEffect(() => {
    localConfigRef.current = localConfig
  }, [localConfig])

  const showSaved = useCallback(() => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSaved(true)
    savedTimerRef.current = setTimeout(() => setSaved(false), SAVED_MS)
  }, [])

  const scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (!localConfigRef.current) return
      const result = await window.api.saveConfig(localConfigRef.current)
      setConfig(result)
      showSaved()
    }, 600)
  }, [setConfig, showSaved])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  if (!localConfig) {
    return <p className="text-body text-ink-2">Loading settings…</p>
  }

  const update = <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => {
    setLocalConfig((prev) => prev ? { ...prev, [key]: val } : prev)
    scheduleAutoSave()
  }

  const handleResetDefaults = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setNotice(null)
    const result = await window.api.saveConfig(APPLICATION_DEFAULTS)
    setConfig(result)
    setLocalConfig({ ...result })
    const jobs = useJobsStore.getState()
    const outcome = await resetBatchDefaults(window.api.jobs, { policy: jobs.policy, run: jobs.run, capabilities: jobs.capabilities })
    if (outcome.errors.length > 0 || outcome.policyLocked) setNotice(resetMessage(outcome))
    showSaved()
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-title text-ink">Settings</h1>
          <p className="mt-0.5 text-body text-ink-2">How batches write their outputs, your presets, FFmpeg, and how the app behaves.</p>
        </div>
        <p role="status" className="shrink-0 pt-1 text-label text-ink-3">{saved ? 'Saved' : ''}</p>
      </header>
      {notice !== null && <p role="status" className="text-label text-ink-2">{notice}</p>}

      <Tabs<SettingsTab> value={activeTab} onChange={setActiveTab} tabs={TABS} label="Settings sections" panelClassName="pt-5">
        {activeTab === 'batch' && <BatchSettings />}
        {activeTab === 'presets' && <PresetSettings />}
        {activeTab === 'ffmpeg' && <FfmpegSettings />}
        {activeTab === 'application' && (
          <ApplicationSettings config={localConfig} onUpdate={update} onResetDefaults={handleResetDefaults} />
        )}
      </Tabs>
    </div>
  )
}
