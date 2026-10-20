/**
 * @module hooks/useIPC
 * @description React hook that bridges the renderer process with Electron's main process.
 *
 * On mount, loads the persisted configuration, system information, FFmpeg
 * status, and the log buffer. Subscribes to IPC event channels (log entries,
 * download progress, and navigation) and pipes them into the Zustand store.
 * Batch state arrives through the jobs store instead. Cleans up all
 * listeners on unmount.
 */

import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { LogEntry, WindowApi } from '../../../shared/ipc/api'

/** What log hydration needs from the preload. */
export type LogSyncApi = Pick<WindowApi, 'getLogBuffer' | 'onLogEntries'>

/** Where hydrated and live log entries go. */
export interface LogSink {
  /** The id of the newest entry already held, if any. */
  newestId(): number | undefined
  add(entries: LogEntry[]): void
}

/**
 * Keeps a log sink in step with main's buffer: subscribes to `logs:entries`
 * first, then fetches the buffer after the newest held id. Live batches that
 * arrive before the reply wait for it, and an entry at or below the last
 * applied id is dropped, so every line lands once and in order.
 * @returns Stops listening; a reply arriving later is ignored.
 */
export function startLogSync(api: LogSyncApi, sink: LogSink): () => void {
  let stopped = false
  let hydrated = false
  let lastId = sink.newestId() ?? Number.NEGATIVE_INFINITY
  const waiting: LogEntry[][] = []

  const apply = (entries: LogEntry[]): void => {
    const fresh: LogEntry[] = []
    for (const entry of entries) {
      if (entry.id > lastId) {
        fresh.push(entry)
        lastId = entry.id
      }
    }
    if (fresh.length > 0) sink.add(fresh)
  }

  const finishHydration = (): void => {
    hydrated = true
    for (const batch of waiting.splice(0)) apply(batch)
  }

  const unsubscribe = api.onLogEntries((entries) => {
    if (stopped) return
    if (hydrated) apply(entries)
    else waiting.push(entries)
  })

  const afterId = sink.newestId()
  api.getLogBuffer(afterId === undefined ? {} : { afterId }).then(
    (entries) => {
      if (stopped) return
      apply(entries)
      finishHydration()
    },
    (err: unknown) => {
      if (stopped) return
      console.error('Log buffer error:', err)
      finishHydration()
    }
  )

  return () => {
    stopped = true
    unsubscribe()
  }
}

/** The app store as a log sink. */
export function appStoreLogSink(): LogSink {
  return {
    newestId: () => {
      const logs = useAppStore.getState().logs
      for (let i = logs.length - 1; i >= 0; i--) {
        const id = logs[i].id
        if (typeof id === 'number') return id
      }
      return undefined
    },
    add: (entries) => useAppStore.getState().addLogs(entries)
  }
}

export function useIPC(): void {
  const {
    setConfig,
    setFFmpegReady,
    setFFmpegChecking,
    setShowSetup,
    setSystemInfo,
    setView,
    setDownloadProgress
  } = useAppStore()

  useEffect(() => {
    let cancelled = false

    // Subscribes before fetching so the startup lines appear once
    const stopLogSync = startLogSync(window.api, appStoreLogSink())

    const init = async () => {
      try {
        if (cancelled) return
        // Load config
        const config = await window.api.loadConfig()
        setConfig(config)
        // Hydrate sidebar collapsed state from persisted config
        if (config && typeof config.sidebarCollapsed === 'boolean') {
          useAppStore.setState({ sidebarCollapsed: config.sidebarCollapsed })
        }

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
      } catch (err) {
        console.error('Init error:', err)
        setFFmpegChecking(false)
      }
    }

    init()

    // Subscribe to IPC events
    const unsubDownload = window.api.onDownloadProgress((progress: any) => {
      setDownloadProgress(progress)
    })

    const unsubNavigate = window.api.onNavigate?.((view: string) => {
      setView(view as any)
    })

    return () => {
      cancelled = true
      stopLogSync()
      unsubDownload?.()
      unsubNavigate?.()
    }
  }, [])
}
