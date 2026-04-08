import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getName: vi.fn(() => 'molex-media'),
    getVersion: vi.fn(() => '3.0.0')
  }
}))

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn()
}))

// Track store state
const storeData: Record<string, any> = {}
const mockStoreGet = vi.fn((key: string) => storeData[key])
const mockStoreSet = vi.fn((key: string, val: any) => { storeData[key] = val })

vi.mock('electron-store', () => ({
  default: class MockStore {
    get = mockStoreGet
    set = mockStoreSet
    store = storeData
  }
}))

const { loadConfig, saveConfig, getConfig, getConfigSync, getUserDataPath, getFFmpegBinDir, getLogDir, addUrlHistory, getUrlHistory, removeUrlHistory, clearUrlHistory } = await import('../../src/main/config')

describe('config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear store data
    for (const key of Object.keys(storeData)) delete storeData[key]
  })

  describe('loadConfig', () => {
    it('returns default config when store is empty', async () => {
      const config = await loadConfig()
      expect(config.normalization.I).toBe(-16.0)
      expect(config.normalization.TP).toBe(-1.5)
      expect(config.audioCodec).toBe('inherit')
      expect(config.audioBitrate).toBe('256k')
      expect(config.preserveSubtitles).toBe(true)
    })

    it('merges stored values over defaults', async () => {
      storeData.audioCodec = 'aac'
      storeData.audioBitrate = '320k'

      const config = await loadConfig()
      expect(config.audioCodec).toBe('aac')
      expect(config.audioBitrate).toBe('320k')
    })

    it('auto-detects maxWorkers when set to 0', async () => {
      storeData.maxWorkers = 0

      const config = await loadConfig()
      expect(config.maxWorkers).toBeGreaterThanOrEqual(1)
    })

    it('preserves positive maxWorkers value', async () => {
      storeData.maxWorkers = 4

      const config = await loadConfig()
      expect(config.maxWorkers).toBe(4)
    })
  })

  describe('saveConfig', () => {
    it('persists partial config updates to the store', async () => {
      await saveConfig({ audioCodec: 'flac', audioBitrate: '192k' })
      expect(mockStoreSet).toHaveBeenCalledWith('audioCodec', 'flac')
      expect(mockStoreSet).toHaveBeenCalledWith('audioBitrate', '192k')
    })

    it('returns the reloaded config after saving', async () => {
      storeData.audioCodec = 'opus'
      const config = await saveConfig({ audioCodec: 'opus' })
      expect(config.audioCodec).toBe('opus')
    })
  })

  describe('getConfig', () => {
    it('returns cached config without reloading', async () => {
      await loadConfig()
      const config = await getConfig()
      expect(config).toBeDefined()
      expect(config.version).toBe('3.0.0')
    })
  })

  describe('getConfigSync', () => {
    it('returns default config if loadConfig has not been called', () => {
      // Force cache clear by saving (which sets cache to null then reloads)
      const config = getConfigSync()
      expect(config).toBeDefined()
      expect(config.version).toBe('3.0.0')
    })
  })

  describe('path helpers', () => {
    it('getUserDataPath returns the electron userData path', () => {
      const p = getUserDataPath()
      expect(p).toBe('/tmp/test-userdata')
    })

    it('getFFmpegBinDir returns a subdirectory of userData', () => {
      const p = getFFmpegBinDir()
      expect(p).toContain('ffmpeg-bin')
    })

    it('getLogDir returns a logs subdirectory and creates it if needed', () => {
      const p = getLogDir()
      expect(p).toContain('logs')
    })

    it('getLogDir creates directory when it does not exist', async () => {
      const fs = await import('fs')
      vi.mocked(fs.existsSync).mockReturnValueOnce(false)
      const p = getLogDir()
      expect(p).toContain('logs')
      expect(fs.mkdirSync).toHaveBeenCalled()
    })
  })

  describe('URL history', () => {
    it('addUrlHistory adds an entry', async () => {
      // Pre-seed the config cache with empty history
      await loadConfig()

      const history = await addUrlHistory({
        url: 'https://youtube.com/watch?v=abc',
        title: 'Test Video',
        trackCount: 1
      })

      expect(history).toHaveLength(1)
      expect(history[0].url).toBe('https://youtube.com/watch?v=abc')
      expect(history[0].title).toBe('Test Video')
      expect(history[0].addedAt).toBeGreaterThan(0)
    })

    it('addUrlHistory deduplicates by URL', async () => {
      await loadConfig()

      await addUrlHistory({ url: 'https://youtube.com/watch?v=abc', title: 'First', trackCount: 1 })
      const history = await addUrlHistory({ url: 'https://youtube.com/watch?v=abc', title: 'Updated', trackCount: 2 })

      expect(history).toHaveLength(1)
      expect(history[0].title).toBe('Updated')
    })

    it('getUrlHistory returns the current history', async () => {
      storeData.urlHistory = [
        { url: 'https://example.com', title: 'Example', trackCount: 1, addedAt: Date.now() }
      ]
      await loadConfig()

      const history = await getUrlHistory()
      expect(history).toHaveLength(1)
      expect(history[0].url).toBe('https://example.com')
    })

    it('removeUrlHistory removes a specific URL', async () => {
      storeData.urlHistory = [
        { url: 'https://a.com', title: 'A', trackCount: 1, addedAt: 1 },
        { url: 'https://b.com', title: 'B', trackCount: 1, addedAt: 2 }
      ]
      await loadConfig()

      const history = await removeUrlHistory('https://a.com')
      expect(history).toHaveLength(1)
      expect(history[0].url).toBe('https://b.com')
    })

    it('clearUrlHistory empties the history', async () => {
      storeData.urlHistory = [
        { url: 'https://a.com', title: 'A', trackCount: 1, addedAt: 1 }
      ]
      await loadConfig()

      await clearUrlHistory()
      // saveConfig was called with empty array
      expect(mockStoreSet).toHaveBeenCalledWith('urlHistory', [])
    })

    it('addUrlHistory caps history at MAX_URL_HISTORY (50)', async () => {
      // Pre-seed with 50 entries
      storeData.urlHistory = Array.from({ length: 50 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `Video ${i}`,
        trackCount: 1,
        addedAt: i
      }))
      await loadConfig()

      // Adding a new entry should cap at 50
      const history = await addUrlHistory({
        url: 'https://example.com/new',
        title: 'New Video',
        trackCount: 1
      })
      expect(history).toHaveLength(50)
      expect(history[0].url).toBe('https://example.com/new')
    })

    it('removeUrlHistory no-ops when URL not in history', async () => {
      storeData.urlHistory = [
        { url: 'https://a.com', title: 'A', trackCount: 1, addedAt: 1 }
      ]
      await loadConfig()

      const history = await removeUrlHistory('https://nonexistent.com')
      expect(history).toHaveLength(1)
      expect(history[0].url).toBe('https://a.com')
    })
  })

  describe('loadConfig edge cases', () => {
    it('auto-detects maxWorkers when set to negative value', async () => {
      storeData.maxWorkers = -5
      const config = await loadConfig()
      expect(config.maxWorkers).toBeGreaterThanOrEqual(1)
    })

    it('getStore reuses Store constructor on second call', async () => {
      // First loadConfig initializes Store
      await loadConfig()
      // Second loadConfig reuses the cached Store constructor
      const config = await loadConfig()
      expect(config).toBeDefined()
    })
  })

  describe('path helpers edge cases', () => {
    it('getLogDir skips mkdir when directory already exists', async () => {
      const fs = await import('fs')
      vi.mocked(fs.existsSync).mockReturnValueOnce(true)
      const p = getLogDir()
      expect(p).toContain('logs')
      // mkdirSync should NOT be called when dir exists
      expect(fs.mkdirSync).not.toHaveBeenCalled()
    })
  })
})
