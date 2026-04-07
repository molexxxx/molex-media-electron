/**
 * @module components/settings/Settings
 * @description Application settings with tabbed configuration panels.
 *
 * Orchestrates auto-save with 600 ms debounce and delegates tab content to
 * {@link AudioSettings}, {@link ProcessingSettings}, and {@link ApplicationSettings}.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore, AppConfig } from '../../stores/appStore'
import { AudioSettings } from './tabs/AudioSettings'
import { ProcessingSettings } from './tabs/ProcessingSettings'
import { ApplicationSettings } from './tabs/ApplicationSettings'

type SettingsTab = 'audio' | 'processing' | 'application'

export default function Settings(): React.JSX.Element {
  const { config, setConfig } = useAppStore()
  const [localConfig, setLocalConfig] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('audio')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const localConfigRef = useRef<AppConfig | null>(null)

  useEffect(() => {
    if (config) setLocalConfig({ ...config })
  }, [config])

  // Keep ref in sync for the auto-save closure
  useEffect(() => {
    localConfigRef.current = localConfig
  }, [localConfig])

  // Auto-save with debounce
  const scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (!localConfigRef.current) return
      const result = await window.api.saveConfig(localConfigRef.current)
      setConfig(result)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }, 600)
  }, [setConfig])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (!localConfig) {
    return <div className="text-surface-400">Loading settings...</div>
  }

  const update = <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => {
    setLocalConfig((prev) => prev ? { ...prev, [key]: val } : prev)
    scheduleAutoSave()
  }

  const updateNorm = (key: 'I' | 'TP' | 'LRA', val: number) => {
    setLocalConfig((prev) =>
      prev ? { ...prev, normalization: { ...prev.normalization, [key]: val } } : prev
    )
    scheduleAutoSave()
  }

  const handleSelectOutputDir = async () => {
    const dir = await window.api.selectOutputDir()
    if (dir) update('outputDirectory', dir)
  }

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'audio', label: 'Audio' },
    { id: 'processing', label: 'Processing' },
    { id: 'application', label: 'Application' },
  ]

  const handleResetDefaults = async () => {
    const defaults: Partial<AppConfig> = {
      normalization: { I: -16.0, TP: -1.5, LRA: 11.0 },
      audioCodec: 'inherit',
      fallbackCodec: 'ac3',
      audioBitrate: '256k',
      maxWorkers: 0,
      overwriteOriginal: true,
      preserveSubtitles: true,
      preserveMetadata: true,
      showNotifications: true,
      minimizeToTray: true,
      showTrayNotification: true,
      outputDirectory: ''
    }
    const result = await window.api.saveConfig(defaults)
    setConfig(result)
    setLocalConfig({ ...result })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="space-y-5 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-sm text-surface-400 mt-0.5">Configure media processing, codecs, and application preferences</p>
        </div>
        <span className={`text-xs font-medium transition-opacity duration-300 ${saved ? 'opacity-100 text-emerald-400' : 'opacity-0'}`}>
          ✓ Saved
        </span>
      </div>

      {/* Tabs */}
      <div className="flex bg-surface-800/50 rounded-lg p-0.5 gap-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-all flex-1 ${
              activeTab === tab.id
                ? 'bg-surface-700 text-white shadow-sm'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'audio' && (
        <AudioSettings config={localConfig} onUpdate={update} onUpdateNorm={updateNorm} />
      )}

      {activeTab === 'processing' && (
        <ProcessingSettings config={localConfig} onUpdate={update} onSelectOutputDir={handleSelectOutputDir} />
      )}

      {activeTab === 'application' && (
        <ApplicationSettings config={localConfig} onUpdate={update} onResetDefaults={handleResetDefaults} />
      )}
    </div>
  )
}
