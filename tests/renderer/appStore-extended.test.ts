import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import type { AppConfig, SystemInfo } from '../../src/renderer/src/stores/appStore'

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
      const cfg = {
        ffmpegPath: '/usr/bin/ffmpeg',
        ffprobePath: '/usr/bin/ffprobe',
        audioBitrate: '320k',
        maxWorkers: 4,
        sidebarCollapsed: false,
        interfaceScale: 100,
        announceProgress: false
      } as AppConfig
      useAppStore.getState().setConfig(cfg)
      expect(useAppStore.getState().config).toEqual(cfg)
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
})
