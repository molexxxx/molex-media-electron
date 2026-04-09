import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { AppConfig, ProcessingTask, SystemInfo } from '../../src/renderer/src/stores/appStore'

function resetStore(): void {
  useAppStore.setState(useAppStore.getInitialState())
}

describe('appStore - extended coverage', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('config', () => {
    it('starts null', () => {
      expect(useAppStore.getState().config).toBeNull()
    })

    it('sets config object', () => {
      const cfg: AppConfig = {
        ffmpegPath: '/usr/bin/ffmpeg',
        ffprobePath: '/usr/bin/ffprobe',
        defaultOutputDir: '/out',
        audioBitrate: '320k',
        maxWorkers: 4,
        afterProcessing: 'keep-both',
        outputDirectory: '/out',
        preserveMetadata: true,
        preserveSubtitles: true,
        tempSuffix: '_temp'
      }
      useAppStore.getState().setConfig(cfg)
      expect(useAppStore.getState().config).toEqual(cfg)
    })
  })

  describe('isProcessing', () => {
    it('defaults to false', () => {
      expect(useAppStore.getState().isProcessing).toBe(false)
    })

    it('toggles processing flag', () => {
      useAppStore.getState().setIsProcessing(true)
      expect(useAppStore.getState().isProcessing).toBe(true)
      useAppStore.getState().setIsProcessing(false)
      expect(useAppStore.getState().isProcessing).toBe(false)
    })
  })

  describe('isPaused', () => {
    it('defaults to false', () => {
      expect(useAppStore.getState().isPaused).toBe(false)
    })

    it('sets paused state', () => {
      useAppStore.getState().setIsPaused(true)
      expect(useAppStore.getState().isPaused).toBe(true)
    })
  })

  describe('activeBatch', () => {
    it('defaults to null', () => {
      expect(useAppStore.getState().activeBatchId).toBeNull()
    })

    it('sets batch id', () => {
      useAppStore.getState().setActiveBatch('batch-123')
      expect(useAppStore.getState().activeBatchId).toBe('batch-123')
    })

    it('clears batch id', () => {
      useAppStore.getState().setActiveBatch('batch-123')
      useAppStore.getState().setActiveBatch(null)
      expect(useAppStore.getState().activeBatchId).toBeNull()
    })
  })

  describe('ffmpegChecking', () => {
    it('defaults to true', () => {
      expect(useAppStore.getState().ffmpegChecking).toBe(true)
    })

    it('sets checking state', () => {
      useAppStore.getState().setFFmpegChecking(false)
      expect(useAppStore.getState().ffmpegChecking).toBe(false)
    })
  })

  describe('systemInfo', () => {
    it('defaults to null', () => {
      expect(useAppStore.getState().systemInfo).toBeNull()
    })

    it('sets system info', () => {
      const info: SystemInfo = {
        platform: 'win32',
        arch: 'x64',
        cpus: 8,
        totalMemory: 16000000000,
        freeMemory: 8000000000,
        nodeVersion: '20.0.0',
        electronVersion: '28.0.0',
        appVersion: '3.0.0'
      }
      useAppStore.getState().setSystemInfo(info)
      expect(useAppStore.getState().systemInfo).toEqual(info)
    })
  })

  describe('showSetup', () => {
    it('defaults to false', () => {
      expect(useAppStore.getState().showSetup).toBe(false)
    })

    it('shows and hides setup', () => {
      useAppStore.getState().setShowSetup(true)
      expect(useAppStore.getState().showSetup).toBe(true)
      useAppStore.getState().setShowSetup(false)
      expect(useAppStore.getState().showSetup).toBe(false)
    })
  })

  describe('downloadProgress', () => {
    it('defaults to null', () => {
      expect(useAppStore.getState().downloadProgress).toBeNull()
    })

    it('sets progress', () => {
      useAppStore.getState().setDownloadProgress({
        stage: 'downloading',
        message: 'Downloading FFmpeg...',
        percent: 42
      })
      expect(useAppStore.getState().downloadProgress?.percent).toBe(42)
    })

    it('clears progress', () => {
      useAppStore.getState().setDownloadProgress({ stage: 'done', message: '', percent: 100 })
      useAppStore.getState().setDownloadProgress(null)
      expect(useAppStore.getState().downloadProgress).toBeNull()
    })
  })

  describe('setTasks', () => {
    it('replaces all tasks', () => {
      const t1: ProcessingTask = {
        id: '1', filePath: '/a.mp3', fileName: 'a.mp3',
        operation: 'normalize', status: 'queued', progress: 0, message: ''
      }
      const t2: ProcessingTask = {
        id: '2', filePath: '/b.mp3', fileName: 'b.mp3',
        operation: 'boost', status: 'queued', progress: 0, message: ''
      }
      useAppStore.getState().setTasks([t1])
      expect(useAppStore.getState().tasks).toHaveLength(1)
      useAppStore.getState().setTasks([t1, t2])
      expect(useAppStore.getState().tasks).toHaveLength(2)
    })
  })

  describe('updateTask with unknown id', () => {
    it('does not add a new task', () => {
      useAppStore.getState().setTasks([{
        id: 't1', filePath: '/a.mp3', fileName: 'a.mp3',
        operation: 'normalize', status: 'queued', progress: 0, message: ''
      }])
      useAppStore.getState().updateTask({
        id: 'unknown', filePath: '/x.mp3', fileName: 'x.mp3',
        operation: 'boost', status: 'complete', progress: 100, message: 'done'
      })
      expect(useAppStore.getState().tasks).toHaveLength(1)
      expect(useAppStore.getState().tasks[0].id).toBe('t1')
    })
  })

  describe('updateFile with unknown path', () => {
    it('does not add or crash', () => {
      useAppStore.getState().addFiles([{ path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }])
      useAppStore.getState().updateFile('/nonexistent.mp3', { probed: true })
      expect(useAppStore.getState().files).toHaveLength(1)
      expect(useAppStore.getState().files[0].probed).toBeUndefined()
    })
  })

  describe('removeFile with unknown path', () => {
    it('does not alter list', () => {
      useAppStore.getState().addFiles([{ path: '/a.mp3', name: 'a.mp3', size: 1000, ext: 'mp3' }])
      useAppStore.getState().removeFile('/nonexistent.mp3')
      expect(useAppStore.getState().files).toHaveLength(1)
    })
  })

  describe('sidebar', () => {
    it('setSidebarCollapsed updates state and calls saveConfig', () => {
      useAppStore.getState().setSidebarCollapsed(true)
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)

      useAppStore.getState().setSidebarCollapsed(false)
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
    })

    it('toggleSidebar flips the state', () => {
      useAppStore.getState().setSidebarCollapsed(false)
      useAppStore.getState().toggleSidebar()
      expect(useAppStore.getState().sidebarCollapsed).toBe(true)

      useAppStore.getState().toggleSidebar()
      expect(useAppStore.getState().sidebarCollapsed).toBe(false)
    })
  })

  describe('operation setters', () => {
    it('setConvertOptions merges partial options', () => {
      useAppStore.getState().setConvertOptions({ outputFormat: 'webm' })
      expect(useAppStore.getState().convertOptions.outputFormat).toBe('webm')
      expect(useAppStore.getState().convertOptions.videoCodec).toBe('libx264')
    })

    it('setExtractOptions merges partial options', () => {
      useAppStore.getState().setExtractOptions({ outputFormat: 'flac' })
      expect(useAppStore.getState().extractOptions.outputFormat).toBe('flac')
      expect(useAppStore.getState().extractOptions.streamIndex).toBe(0)
    })

    it('setCompressOptions merges partial options', () => {
      useAppStore.getState().setCompressOptions({ targetSizeMB: 50 })
      expect(useAppStore.getState().compressOptions.targetSizeMB).toBe(50)
      expect(useAppStore.getState().compressOptions.quality).toBe('high')
    })

    it('setOperation changes the operation', () => {
      useAppStore.getState().setOperation('boost')
      expect(useAppStore.getState().operation).toBe('boost')
    })

    it('setBoostPercent updates boost value', () => {
      useAppStore.getState().setBoostPercent(75)
      expect(useAppStore.getState().boostPercent).toBe(75)
    })

    it('setSelectedPreset updates preset', () => {
      useAppStore.getState().setSelectedPreset('custom')
      expect(useAppStore.getState().selectedPreset).toBe('custom')
    })

    it('setBatchOutputDir updates batch output dir', () => {
      useAppStore.getState().setBatchOutputDir('/output')
      expect(useAppStore.getState().batchOutputDir).toBe('/output')
    })
  })
})
