import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

declare global {
  interface Window {
    api: any
  }
}

export function useIPC(): void {
  const {
    setConfig,
    setFFmpegReady,
    setFFmpegChecking,
    setShowSetup,
    setSystemInfo,
    addLog,
    updateTask,
    setTasks,
    setActiveBatch,
    setIsProcessing,
    setDownloadProgress,
    incrementProcessed,
    incrementErrors
  } = useAppStore()

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        if (cancelled) return
        // Load config
        const config = await window.api.loadConfig()
        setConfig(config)

        // Load system info
        const sysInfo = await window.api.getSystemInfo()
        setSystemInfo(sysInfo)

        // Check FFmpeg
        setFFmpegChecking(true)
        const result = await window.api.checkFFmpeg()
        if (result.found) {
          setFFmpegReady(true, result.version)
          // Reload config with updated paths
          const updated = await window.api.loadConfig()
          setConfig(updated)
        } else {
          setShowSetup(true)
        }
        setFFmpegChecking(false)

        // Load existing logs
        const logs = await window.api.getLogBuffer()
        for (const log of logs) {
          addLog(log)
        }
      } catch (err) {
        console.error('Init error:', err)
        setFFmpegChecking(false)
      }
    }

    init()

    // Subscribe to IPC events
    const unsubLog = window.api.onLogEntry((entry: any) => {
      addLog(entry)
    })

    const unsubTaskProgress = window.api.onTaskProgress((task: any) => {
      updateTask(task)
      if (task.status === 'complete') incrementProcessed()
      if (task.status === 'error') incrementErrors()
    })

    const unsubBatchStarted = window.api.onBatchStarted((data: any) => {
      setTasks(data.tasks)
      setActiveBatch(data.batchId)
      setIsProcessing(true)
    })

    const unsubBatchComplete = window.api.onBatchComplete(() => {
      setIsProcessing(false)
      setActiveBatch(null)
    })

    const unsubDownload = window.api.onDownloadProgress((progress: any) => {
      setDownloadProgress(progress)
    })

    return () => {
      cancelled = true
      unsubLog?.()
      unsubTaskProgress?.()
      unsubBatchStarted?.()
      unsubBatchComplete?.()
      unsubDownload?.()
    }
  }, [])
}
