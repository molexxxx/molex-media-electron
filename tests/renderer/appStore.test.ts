import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { LogEntry } from '../../src/renderer/src/stores/appStore'

function resetStore(): void {
  useAppStore.setState(useAppStore.getInitialState())
}

describe('appStore', () => {
  beforeEach(() => {
    resetStore()
  })

  // -- Navigation --

  describe('setView / goBack', () => {
    it('changes the current view', () => {
      useAppStore.getState().setView('batch')
      expect(useAppStore.getState().currentView).toBe('batch')
    })

    it('pushes previous view to history', () => {
      useAppStore.getState().setView('batch')
      useAppStore.getState().setView('settings')
      expect(useAppStore.getState().viewHistory).toEqual(['dashboard', 'batch'])
      expect(useAppStore.getState().currentView).toBe('settings')
    })

    it('does not push duplicate when navigating to same view', () => {
      useAppStore.getState().setView('batch')
      useAppStore.getState().setView('batch')
      expect(useAppStore.getState().viewHistory).toEqual(['dashboard'])
    })

    it('limits history to 20 entries', () => {
      const views = ['batch', 'settings', 'logs', 'player', 'editor'] as const
      for (let i = 0; i < 25; i++) {
        useAppStore.getState().setView(views[i % views.length])
      }
      expect(useAppStore.getState().viewHistory.length).toBeLessThanOrEqual(20)
    })

    it('goes back to previous view', () => {
      useAppStore.getState().setView('batch')
      useAppStore.getState().setView('settings')
      useAppStore.getState().goBack()
      expect(useAppStore.getState().currentView).toBe('batch')
      expect(useAppStore.getState().viewHistory).toEqual(['dashboard'])
    })

    it('does nothing when history is empty', () => {
      useAppStore.getState().goBack()
      expect(useAppStore.getState().currentView).toBe('dashboard')
    })
  })

  // -- Logs --

  describe('addLog', () => {
    it('appends log entries', () => {
      const entry: LogEntry = { timestamp: '2024-01-01 00:00:00', level: 'info', message: 'test' }
      useAppStore.getState().addLog(entry)
      useAppStore.getState().addLog({ ...entry, message: 'test2' })
      expect(useAppStore.getState().logs).toHaveLength(2)
    })

    it('truncates logs beyond 5000 to 2500', () => {
      for (let i = 0; i < 5001; i++) {
        useAppStore.getState().addLog({
          timestamp: '2024-01-01 00:00:00', level: 'info', message: `log-${i}`
        })
      }
      expect(useAppStore.getState().logs.length).toBeLessThanOrEqual(2501)
    })

    it('preserves most recent entries after truncation', () => {
      for (let i = 0; i < 5001; i++) {
        useAppStore.getState().addLog({
          timestamp: '2024-01-01 00:00:00', level: 'info', message: `log-${i}`
        })
      }
      const logs = useAppStore.getState().logs
      expect(logs[logs.length - 1].message).toBe('log-5000')
    })
  })

  describe('addLogs', () => {
    it('appends a batch in one update', () => {
      const updates: number[] = []
      const stop = useAppStore.subscribe((state) => updates.push(state.logs.length))
      useAppStore.getState().addLogs([
        { id: 1, timestamp: '', level: 'info', message: 'a' },
        { id: 2, timestamp: '', level: 'warn', message: 'b' }
      ])
      stop()
      expect(updates).toEqual([2])
      expect(useAppStore.getState().logs.map((l) => l.message)).toEqual(['a', 'b'])
    })

    it('leaves the store alone for an empty batch', () => {
      const before = useAppStore.getState().logs
      useAppStore.getState().addLogs([])
      expect(useAppStore.getState().logs).toBe(before)
    })

    it('trims beyond 5000 entries to the newest 2500', () => {
      const entries: LogEntry[] = Array.from({ length: 5001 }, (_, i) => ({ timestamp: '', level: 'info', message: `log-${i}` }))
      useAppStore.getState().addLogs(entries)
      const logs = useAppStore.getState().logs
      expect(logs).toHaveLength(2500)
      expect(logs[logs.length - 1].message).toBe('log-5000')
    })
  })

  describe('clearLogs', () => {
    it('clears all logs', () => {
      useAppStore.getState().addLog({ timestamp: '', level: 'info', message: 'x' })
      useAppStore.getState().clearLogs()
      expect(useAppStore.getState().logs).toHaveLength(0)
    })
  })

  // -- FFmpeg state --

  describe('ffmpeg state', () => {
    it('sets ffmpeg ready with version', () => {
      useAppStore.getState().setFFmpegReady(true, '6.1.0')
      expect(useAppStore.getState().ffmpegReady).toBe(true)
      expect(useAppStore.getState().ffmpegVersion).toBe('6.1.0')
    })

    it('sets ffmpeg ready without version', () => {
      useAppStore.getState().setFFmpegReady(false)
      expect(useAppStore.getState().ffmpegReady).toBe(false)
      expect(useAppStore.getState().ffmpegVersion).toBe('')
    })
  })

  describe('sidebar state', () => {
    it('setSidebarCollapsed sets collapsed state', () => {
      useAppStore.getState().setSidebarCollapsed(true)
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
    })

    it('toggleSidebar flips collapsed state', () => {
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
      useAppStore.getState().toggleSidebar()
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
      useAppStore.getState().toggleSidebar()
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
    })

    it('setSidebarCollapsed updates config.sidebarCollapsed if config exists', () => {
      useAppStore.setState({ config: { sidebarCollapsed: false } as any })
      useAppStore.getState().setSidebarCollapsed(true)
      expect(useAppStore.getState().config?.sidebarCollapsed).toBe(true)
    })

    it('setSidebarCollapsed handles null config gracefully', () => {
      useAppStore.setState({ config: null as any })
      useAppStore.getState().setSidebarCollapsed(true)
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)
    })
  })

  describe('update state', () => {
    it('sets update status', () => {
      useAppStore.getState().setUpdateStatus('available')
      expect(useAppStore.getState().updateStatus).toBe('available')
    })

    it('sets update version', () => {
      useAppStore.getState().setUpdateVersion('4.0.0')
      expect(useAppStore.getState().updateVersion).toBe('4.0.0')
    })

    it('sets update error', () => {
      useAppStore.getState().setUpdateError('Download failed')
      expect(useAppStore.getState().updateError).toBe('Download failed')
    })

    it('sets update download percent', () => {
      useAppStore.getState().setUpdateDownloadPercent(75)
      expect(useAppStore.getState().updateDownloadPercent).toBe(75)
    })
  })

  describe('batch state', () => {
    it('holds none; the jobs store carries every batch fact', () => {
      const keys = Object.keys(useAppStore.getState())
      for (const key of ['files', 'addFiles', 'tasks', 'operation', 'isProcessing', 'isPaused', 'activeBatchId', 'batchWorkers', 'normalizeOptions', 'boostPercent', 'resetBatch', 'totalProcessed']) {
        expect(keys).not.toContain(key)
      }
    })
  })

  describe('misc setters', () => {
    it('sets config', () => {
      useAppStore.getState().setConfig({ audioCodec: 'aac' } as any)
      expect(useAppStore.getState().config?.audioCodec).toBe('aac')
    })

    it('setFFmpegChecking', () => {
      useAppStore.getState().setFFmpegChecking(true)
      expect(useAppStore.getState().ffmpegChecking).toBe(true)
    })

    it('setShowSetup', () => {
      useAppStore.getState().setShowSetup(true)
      expect(useAppStore.getState().showSetup).toBe(true)
    })

    it('setDownloadProgress', () => {
      useAppStore.getState().setDownloadProgress({ stage: 'downloading', message: 'test', percent: 50 })
      expect(useAppStore.getState().downloadProgress?.percent).toBe(50)
    })

    it('setSystemInfo', () => {
      useAppStore.getState().setSystemInfo({ platform: 'win32' } as any)
      expect(useAppStore.getState().systemInfo?.platform).toBe('win32')
    })

  })
})
