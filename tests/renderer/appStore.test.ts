import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { FileItem, ProcessingTask, LogEntry } from '../../src/renderer/src/stores/appStore'

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

  // -- Files --

  describe('addFiles', () => {
    const file1: FileItem = { path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }
    const file2: FileItem = { path: '/b.wav', name: 'b.wav', size: 2000, ext: 'wav' }

    it('adds files to the list', () => {
      useAppStore.getState().addFiles([file1, file2])
      expect(useAppStore.getState().files).toHaveLength(2)
    })

    it('deduplicates by path', () => {
      useAppStore.getState().addFiles([file1])
      useAppStore.getState().addFiles([file1, file2])
      expect(useAppStore.getState().files).toHaveLength(2)
    })
  })

  describe('updateFile', () => {
    it('updates a file by path', () => {
      useAppStore.getState().addFiles([{ path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }])
      useAppStore.getState().updateFile('/a.mp3', { probed: true, duration: '3:45' })
      expect(useAppStore.getState().files[0].probed).toBe(true)
      expect(useAppStore.getState().files[0].duration).toBe('3:45')
    })

    it('does not affect other files', () => {
      useAppStore.getState().addFiles([
        { path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' },
        { path: '/b.mp3', name: 'b.mp3', size: 2000, ext: 'mp3' }
      ])
      useAppStore.getState().updateFile('/a.mp3', { probed: true })
      expect(useAppStore.getState().files[1].probed).toBeUndefined()
    })
  })

  describe('removeFile', () => {
    it('removes a file by path', () => {
      useAppStore.getState().addFiles([
        { path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' },
        { path: '/b.mp3', name: 'b.mp3', size: 2000, ext: 'mp3' }
      ])
      useAppStore.getState().removeFile('/a.mp3')
      expect(useAppStore.getState().files).toHaveLength(1)
      expect(useAppStore.getState().files[0].path).toBe('/b.mp3')
    })
  })

  describe('clearFiles', () => {
    it('clears all files', () => {
      useAppStore.getState().addFiles([{ path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }])
      useAppStore.getState().clearFiles()
      expect(useAppStore.getState().files).toHaveLength(0)
    })
  })

  // -- Tasks --

  describe('updateTask', () => {
    it('replaces a task by id', () => {
      const task: ProcessingTask = {
        id: 't1', filePath: '/a.mp3', fileName: 'a.mp3',
        operation: 'normalize', status: 'queued', progress: 0, message: ''
      }
      useAppStore.getState().setTasks([task])
      useAppStore.getState().updateTask({ ...task, status: 'processing', progress: 50 })
      expect(useAppStore.getState().tasks[0].status).toBe('processing')
      expect(useAppStore.getState().tasks[0].progress).toBe(50)
    })

    it('does not affect other tasks', () => {
      const t1: ProcessingTask = {
        id: 't1', filePath: '/a.mp3', fileName: 'a.mp3',
        operation: 'normalize', status: 'queued', progress: 0, message: ''
      }
      const t2: ProcessingTask = {
        id: 't2', filePath: '/b.mp3', fileName: 'b.mp3',
        operation: 'boost', status: 'queued', progress: 0, message: ''
      }
      useAppStore.getState().setTasks([t1, t2])
      useAppStore.getState().updateTask({ ...t1, status: 'complete' })
      expect(useAppStore.getState().tasks[1].status).toBe('queued')
    })
  })

  describe('clearTasks', () => {
    it('clears tasks, batch id, and paused state', () => {
      useAppStore.getState().setTasks([{
        id: 't1', filePath: '/a.mp3', fileName: 'a.mp3',
        operation: 'normalize', status: 'complete', progress: 100, message: 'done'
      }])
      useAppStore.getState().setActiveBatch('batch-1')
      useAppStore.getState().setIsPaused(true)
      useAppStore.getState().clearTasks()
      expect(useAppStore.getState().tasks).toHaveLength(0)
      expect(useAppStore.getState().activeBatchId).toBeNull()
      expect(useAppStore.getState().isPaused).toBe(false)
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

  describe('clearLogs', () => {
    it('clears all logs', () => {
      useAppStore.getState().addLog({ timestamp: '', level: 'info', message: 'x' })
      useAppStore.getState().clearLogs()
      expect(useAppStore.getState().logs).toHaveLength(0)
    })
  })

  // -- Stats --

  describe('incrementProcessed / incrementErrors', () => {
    it('increments processed count', () => {
      useAppStore.getState().incrementProcessed()
      useAppStore.getState().incrementProcessed()
      expect(useAppStore.getState().totalProcessed).toBe(2)
    })

    it('increments error count', () => {
      useAppStore.getState().incrementErrors()
      expect(useAppStore.getState().totalErrors).toBe(1)
    })
  })

  // -- Option setters --

  describe('option setters', () => {
    it('sets operation', () => {
      useAppStore.getState().setOperation('boost')
      expect(useAppStore.getState().operation).toBe('boost')
    })

    it('sets boost percent', () => {
      useAppStore.getState().setBoostPercent(25)
      expect(useAppStore.getState().boostPercent).toBe(25)
    })

    it('sets selected preset', () => {
      useAppStore.getState().setSelectedPreset('dialogue')
      expect(useAppStore.getState().selectedPreset).toBe('dialogue')
    })

    it('merges convert options', () => {
      useAppStore.getState().setConvertOptions({ outputFormat: 'mkv' })
      expect(useAppStore.getState().convertOptions.outputFormat).toBe('mkv')
      // Other fields should be preserved
      expect(useAppStore.getState().convertOptions.videoCodec).toBe('libx264')
    })

    it('merges extract options', () => {
      useAppStore.getState().setExtractOptions({ streamIndex: 2 })
      expect(useAppStore.getState().extractOptions.streamIndex).toBe(2)
      expect(useAppStore.getState().extractOptions.outputFormat).toBe('mp3')
    })

    it('merges compress options', () => {
      useAppStore.getState().setCompressOptions({ quality: 'low' })
      expect(useAppStore.getState().compressOptions.quality).toBe('low')
      expect(useAppStore.getState().compressOptions.targetSizeMB).toBe(0)
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

  describe('resetBatch', () => {
    it('resets all batch state to defaults', () => {
      useAppStore.getState().addFiles([{ path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }])
      useAppStore.getState().setOperation('normalize')
      useAppStore.getState().setIsProcessing(true)
      useAppStore.getState().resetBatch()
      const s = useAppStore.getState()
      expect(s.files).toEqual([])
      expect(s.tasks).toEqual([])
      expect(s.isProcessing).toBe(false)
      expect(s.operation).toBe('convert')
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

    it('setActiveBatch', () => {
      useAppStore.getState().setActiveBatch('batch-123')
      expect(useAppStore.getState().activeBatchId).toBe('batch-123')
    })

    it('setIsPaused', () => {
      useAppStore.getState().setIsPaused(true)
      expect(useAppStore.getState().isPaused).toBe(true)
    })

    it('setTasks', () => {
      useAppStore.getState().setTasks([{ id: 't1', status: 'queued' } as any])
      expect(useAppStore.getState().tasks).toHaveLength(1)
    })

    it('setBatchOutputDir', () => {
      useAppStore.getState().setBatchOutputDir('/output')
      expect(useAppStore.getState().batchOutputDir).toBe('/output')
    })

    it('setNormalizeOptions merges options', () => {
      useAppStore.getState().setNormalizeOptions({ I: -14 })
      expect(useAppStore.getState().normalizeOptions.I).toBe(-14)
    })
  })
})
