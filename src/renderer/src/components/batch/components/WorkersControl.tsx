import React, { useEffect } from 'react'
import { useAppStore } from '../../../stores/appStore'

export function WorkersControl(): React.JSX.Element {
  const { config, systemInfo, isProcessing, batchWorkers, setBatchWorkers, activeWorkerCount, setActiveWorkerCount } = useAppStore()
  const cpuCores = systemInfo?.cpus || 4
  // Settings maxWorkers: 0 (or unset) means unlimited = CPU core count
  const settingsMax = config?.maxWorkers && config.maxWorkers > 0 ? config.maxWorkers : cpuCores
  const sliderMax = Math.min(settingsMax, cpuCores)

  // Initialise batchWorkers from config on mount
  useEffect(() => {
    if (batchWorkers === 0 && config?.maxWorkers) {
      setBatchWorkers(Math.min(config.maxWorkers, sliderMax))
    }
  }, [config?.maxWorkers, batchWorkers, setBatchWorkers, sliderMax])

  // Clamp if settings max was lowered below current slider value
  useEffect(() => {
    if (batchWorkers > sliderMax) {
      setBatchWorkers(sliderMax)
    }
  }, [sliderMax, batchWorkers, setBatchWorkers])

  // Listen for live worker status updates from backend
  useEffect(() => {
    const unsub = window.api.onWorkerStatus((status) => {
      setActiveWorkerCount(status.active)
    })
    return unsub
  }, [setActiveWorkerCount])

  const effectiveWorkers = batchWorkers || config?.maxWorkers || sliderMax

  const handleChange = async (value: number) => {
    setBatchWorkers(value)
    if (isProcessing) {
      await window.api.setWorkers(value)
    }
  }

  const pct = ((effectiveWorkers - 1) / Math.max(1, sliderMax - 1)) * 100

  return (
    <div className="flex items-center gap-2 min-w-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-surface-500 shrink-0">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
      <span className="text-2xs text-surface-500 font-medium shrink-0">Workers</span>
      <div className="relative flex-1 min-w-[80px] max-w-[140px] h-4 flex items-center">
        <div className="absolute left-0 right-0 h-1 rounded-full bg-surface-700">
          <div
            className="h-full rounded-full bg-accent-500/60 transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={1}
          max={sliderMax}
          value={effectiveWorkers}
          onChange={(e) => handleChange(parseInt(e.target.value, 10))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div
          className="absolute w-2.5 h-2.5 rounded-full bg-accent-400 border-2 border-accent-300 shadow-sm pointer-events-none"
          style={{ left: `calc(${pct}% - 5px)` }}
        />
      </div>
      <span className="text-2xs font-mono text-surface-300 shrink-0 w-10 text-right">
        {isProcessing ? (
          <span title={`${activeWorkerCount} active / ${effectiveWorkers} target`}>
            <span className="text-accent-400">{activeWorkerCount}</span>
            <span className="text-surface-600">/{effectiveWorkers}</span>
          </span>
        ) : (
          <span>{effectiveWorkers}</span>
        )}
      </span>
    </div>
  )
}
