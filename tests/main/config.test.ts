import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import type { NormalizeRecipe } from '../../src/shared/audio/types'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getName: vi.fn(() => 'molex-media'),
    getVersion: vi.fn(() => '3.0.0')
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => any) => { ipcHandlers.set(channel, fn) })
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

const { loadConfig, saveConfig, getConfig, getConfigSync, getUserDataPath, getFFmpegBinDir, getLogDir, addUrlHistory, getUrlHistory, removeUrlHistory, clearUrlHistory, getFFmpegRoot, migrateFfmpegConfig, readFfmpegConfig, saveFfmpegConfig, stripMainOwned, MAIN_OWNED_KEYS, READ_ONLY_MIRRORS, DEFAULT_CONFIG, legacyEncoderPolicy, legacyCustomRecipe, firstDefaultRecipe, presetSeed, EARLIER_DEFAULT_PRESET, clampInterfaceScale, INTERFACE_SCALE, migrateJobsConfig, legacyWorkers, legacyPolicy, saveJobsConfig, takeJobsAlerts, DEFAULT_RUN_SETTINGS, MAX_RECENT_FOLDERS } = await import('../../src/main/config')
const { applyLoudnessPreset, applyGainPreset } = await import('../../src/shared/audio/presets')
const { validateAudioRecipe } = await import('../../src/shared/audio/limits')
const { registerConfigIPC } = await import('../../src/main/ipc/config')

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

const USER_DATA = '/tmp/test-userdata'
const BUNDLED = path.join(USER_DATA, 'ffmpeg', 'btbn-n9.0.2-17-g2a571b6068')
const LEGACY = path.join(USER_DATA, 'ffmpeg-bin')
const ROOTS = [path.join(USER_DATA, 'ffmpeg'), LEGACY]

function block(overrides: Record<string, unknown> = {}): any {
  return {
    source: 'bundled',
    buildId: 'btbn-n9.0.2-17-g2a571b6068',
    ffmpegPath: path.join(BUNDLED, 'ffmpeg.exe'),
    ffprobePath: path.join(BUNDLED, 'ffprobe.exe'),
    selfTest: {
      identity: { path: path.join(BUNDLED, 'ffmpeg.exe'), size: 194000000, mtimeMs: 1760000000000 },
      rev: 1,
      results: { 'chain-flac-s16': true, 'chain-opus-51side': true, 'chain-aac-mono': true, 'meter-dual-mono': true, soxr: true, encoders: true }
    },
    ...overrides
  }
}

function ffmpegWrites(): unknown[][] {
  return mockStoreSet.mock.calls.filter(([key]) => key === 'ffmpeg')
}

describe('ffmpeg config block', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(storeData)) delete storeData[key]
  })

  describe('readFfmpegConfig', () => {
    it('accepts a complete block', () => {
      expect(readFfmpegConfig(block())).toEqual(block())
    })

    it.each([
      ['an unknown source', { source: 'download' }],
      ['an empty ffmpeg path', { ffmpegPath: '' }],
      ['a numeric ffprobe path', { ffprobePath: 3 }],
      ['a numeric build id', { buildId: 7 }]
    ])('refuses %s', (_label, overrides) => {
      expect(readFfmpegConfig(block(overrides))).toBeNull()
    })

    it('refuses anything that is not an object', () => {
      expect(readFfmpegConfig(null)).toBeNull()
      expect(readFfmpegConfig('C:/ffmpeg.exe')).toBeNull()
      expect(readFfmpegConfig([block()])).toBeNull()
    })

    it.each([
      ['a missing identity', { rev: 1, results: {} }],
      ['a string size', { identity: { path: 'x', size: '1', mtimeMs: 1 }, rev: 1, results: {} }],
      ['a missing revision', { identity: { path: 'x', size: 1, mtimeMs: 1 }, results: {} }],
      ['a non-boolean result', { identity: { path: 'x', size: 1, mtimeMs: 1 }, rev: 1, results: { soxr: 'yes' } }]
    ])('drops a self-test record with %s', (_label, selfTest) => {
      expect(readFfmpegConfig(block({ selfTest }))?.selfTest).toBeNull()
    })
  })

  describe('migrateFfmpegConfig', () => {
    it('keeps a valid block as it is', () => {
      expect(migrateFfmpegConfig({ ffmpeg: block(), ffmpegPath: 'C:/old/ffmpeg.exe', ffprobePath: 'C:/old/ffprobe.exe' }, ROOTS))
        .toEqual({ block: block(), changed: false })
    })

    it('turns legacy paths under the app folder into a bundled block', () => {
      const ffmpegPath = path.join(LEGACY, 'ffmpeg.exe')
      const ffprobePath = path.join(LEGACY, 'ffprobe.exe')
      expect(migrateFfmpegConfig({ ffmpeg: null, ffmpegPath, ffprobePath }, ROOTS)).toEqual({
        block: { source: 'bundled', buildId: null, ffmpegPath, ffprobePath, selfTest: null },
        changed: true
      })
    })

    it('turns legacy paths anywhere else into a PATH block', () => {
      const result = migrateFfmpegConfig({ ffmpegPath: 'C:/ffmpeg/bin/ffmpeg.exe', ffprobePath: 'C:/ffmpeg/bin/ffprobe.exe' }, ROOTS)
      expect(result.block?.source).toBe('path')
      expect(result.changed).toBe(true)
    })

    it('does not count the bundled root itself or a sibling folder as an install', () => {
      expect(migrateFfmpegConfig({ ffmpegPath: LEGACY }, ROOTS).block?.source).toBe('path')
      expect(migrateFfmpegConfig({ ffmpegPath: path.join(USER_DATA, 'ffmpeg-bin-old', 'ffmpeg') }, ROOTS).block?.source).toBe('path')
    })

    it('reads a missing ffprobe path as empty', () => {
      expect(migrateFfmpegConfig({ ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: undefined }, ROOTS).block?.ffprobePath).toBe('')
    })

    it('is idempotent', () => {
      const first = migrateFfmpegConfig({ ffmpeg: null, ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe' }, ROOTS)
      const second = migrateFfmpegConfig({ ffmpeg: first.block, ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe' }, ROOTS)
      expect(second).toEqual({ block: first.block, changed: false })
      const stored = JSON.parse(JSON.stringify(second.block))
      expect(migrateFfmpegConfig({ ffmpeg: stored }, ROOTS).changed).toBe(false)
    })

    it('rewrites a block whose self-test record is malformed, once', () => {
      const first = migrateFfmpegConfig({ ffmpeg: block({ selfTest: { rev: 1 } }) }, ROOTS)
      expect(first.changed).toBe(true)
      expect(first.block?.selfTest).toBeNull()
      expect(migrateFfmpegConfig({ ffmpeg: first.block }, ROOTS).changed).toBe(false)
    })

    it('has nothing to migrate without paths, and clears an unusable block', () => {
      expect(migrateFfmpegConfig({ ffmpeg: null, ffmpegPath: '', ffprobePath: '' }, ROOTS)).toEqual({ block: null, changed: false })
      expect(migrateFfmpegConfig({}, ROOTS)).toEqual({ block: null, changed: false })
      expect(migrateFfmpegConfig({ ffmpeg: { source: 'bundled' } }, ROOTS)).toEqual({ block: null, changed: true })
    })
  })

  describe('loadConfig', () => {
    it('migrates the top-level paths into the block once and mirrors them', async () => {
      storeData.ffmpeg = null
      storeData.ffmpegPath = path.join(LEGACY, 'ffmpeg.exe')
      storeData.ffprobePath = path.join(LEGACY, 'ffprobe.exe')
      const config = await loadConfig()
      expect(config.ffmpeg).toEqual({ source: 'bundled', buildId: null, ffmpegPath: storeData.ffmpegPath, ffprobePath: storeData.ffprobePath, selfTest: null })
      expect(config.ffmpegPath).toBe(storeData.ffmpegPath)
      expect(ffmpegWrites()).toHaveLength(1)
      await loadConfig()
      expect(ffmpegWrites()).toHaveLength(1)
    })

    it('mirrors the block over stale top-level paths', async () => {
      storeData.ffmpeg = block()
      storeData.ffmpegPath = 'C:/stale/ffmpeg.exe'
      storeData.ffprobePath = 'C:/stale/ffprobe.exe'
      const config = await loadConfig()
      expect(config.ffmpegPath).toBe(block().ffmpegPath)
      expect(config.ffprobePath).toBe(block().ffprobePath)
      expect(ffmpegWrites()).toHaveLength(0)
    })

    it('leaves empty mirrors when nothing is installed', async () => {
      const config = await loadConfig()
      expect(config.ffmpeg).toBeNull()
      expect(config.ffmpegPath).toBe('')
      expect(config.ffprobePath).toBe('')
      expect(DEFAULT_CONFIG.ffmpeg).toBeNull()
    })
  })

  describe('saveConfig', () => {
    it('never writes the mirrors from a partial', async () => {
      storeData.ffmpeg = block()
      const config = await saveConfig({ ffmpegPath: 'C:/evil/ffmpeg.exe', ffprobePath: 'C:/evil/ffprobe.exe', theme: 'light' })
      expect(mockStoreSet).not.toHaveBeenCalledWith('ffmpegPath', expect.anything())
      expect(mockStoreSet).not.toHaveBeenCalledWith('ffprobePath', expect.anything())
      expect(mockStoreSet).toHaveBeenCalledWith('theme', 'light')
      expect(config.ffmpegPath).toBe(block().ffmpegPath)
    })

    it('writes a block with its mirrors', async () => {
      const config = await saveFfmpegConfig(block())
      expect(mockStoreSet).toHaveBeenCalledWith('ffmpeg', block())
      expect(mockStoreSet).toHaveBeenCalledWith('ffmpegPath', block().ffmpegPath)
      expect(mockStoreSet).toHaveBeenCalledWith('ffprobePath', block().ffprobePath)
      expect(config.ffmpeg).toEqual(block())
    })

    it('clears the block and its mirrors', async () => {
      storeData.ffmpeg = block()
      const config = await saveFfmpegConfig(null)
      expect(mockStoreSet).toHaveBeenCalledWith('ffmpeg', null)
      expect(mockStoreSet).toHaveBeenCalledWith('ffmpegPath', '')
      expect(config.ffmpeg).toBeNull()
      expect(config.ffmpegPath).toBe('')
    })

    it('stores an unusable block as null', async () => {
      await saveConfig({ ffmpeg: { source: 'elsewhere' } as any })
      expect(mockStoreSet).toHaveBeenCalledWith('ffmpeg', null)
    })
  })

  describe('stripMainOwned', () => {
    it('removes the main-owned keys and keeps the mirrors', () => {
      const config = { ...DEFAULT_CONFIG, ffmpeg: block(), ffmpegPath: 'a', ffprobePath: 'b' }
      const stripped = stripMainOwned(config)
      expect('ffmpeg' in stripped).toBe(false)
      expect('jobs' in stripped).toBe(false)
      expect(stripped.ffmpegPath).toBe('a')
      expect('audio' in stripped).toBe(false)
      expect(stripped.announceProgress).toBe(false)
      expect(config.ffmpeg).toEqual(block())
      expect(config.jobs).toEqual(DEFAULT_CONFIG.jobs)
      expect(MAIN_OWNED_KEYS).toEqual(['ffmpeg', 'jobs'])
      expect(READ_ONLY_MIRRORS).toEqual(['ffmpegPath', 'ffprobePath'])
    })

    it('reads anything that is not a plain object as an empty partial', () => {
      expect(stripMainOwned(null as unknown as object)).toEqual({})
      expect(stripMainOwned([1, 2] as unknown as object)).toEqual({})
      expect(stripMainOwned('ffmpeg' as unknown as object)).toEqual({})
    })
  })

  describe('config IPC', () => {
    registerConfigIPC()

    it('registers the config and history channels', () => {
      expect([...ipcHandlers.keys()].sort()).toEqual(['config:get', 'config:load', 'config:save', 'history:clear', 'history:get', 'history:remove'])
    })

    it('never returns the ffmpeg key from config:load or config:get', async () => {
      storeData.ffmpeg = block()
      const loaded = await ipcHandlers.get('config:load')!({})
      expect('ffmpeg' in loaded).toBe(false)
      expect(loaded.ffmpegPath).toBe(block().ffmpegPath)
      const got = await ipcHandlers.get('config:get')!({})
      expect('ffmpeg' in got).toBe(false)
      expect(got.ffprobePath).toBe(block().ffprobePath)
    })

    it('never saves or returns the ffmpeg key or the mirrors through config:save', async () => {
      storeData.ffmpeg = block()
      const saved = await ipcHandlers.get('config:save')!({}, { ffmpeg: block({ ffmpegPath: 'C:/evil.exe' }), ffmpegPath: 'C:/evil.exe', ffprobePath: 'C:/evil-probe.exe', theme: 'light' })
      expect(ffmpegWrites()).toHaveLength(0)
      expect(mockStoreSet).not.toHaveBeenCalledWith('ffmpegPath', expect.anything())
      expect(mockStoreSet).toHaveBeenCalledWith('theme', 'light')
      expect('ffmpeg' in saved).toBe(false)
      expect(saved.ffmpegPath).toBe(block().ffmpegPath)
      expect(storeData.ffmpeg).toEqual(block())
    })

    it('treats a missing or malformed partial as empty', async () => {
      await loadConfig()
      mockStoreSet.mockClear()
      await ipcHandlers.get('config:save')!({}, undefined)
      await ipcHandlers.get('config:save')!({}, 'theme=light')
      expect(mockStoreSet).not.toHaveBeenCalled()
    })

    it('serves the URL history channels', async () => {
      storeData.urlHistory = [{ url: 'https://a.com', title: 'A', trackCount: 1, addedAt: 1 }]
      await loadConfig()
      expect(await ipcHandlers.get('history:get')!({})).toHaveLength(1)
      expect(await ipcHandlers.get('history:remove')!({}, 'https://a.com')).toEqual([])
      await ipcHandlers.get('history:clear')!({})
      expect(mockStoreSet).toHaveBeenCalledWith('urlHistory', [])
    })
  })

  describe('getFFmpegRoot', () => {
    it('is the ffmpeg folder under userData', () => {
      expect(getFFmpegRoot()).toBe(path.join(USER_DATA, 'ffmpeg'))
    })
  })
})

describe('earlier settings', () => {
  const legacy = { normalization: { I: -14, TP: -1, LRA: 7 }, audioCodec: 'inherit', fallbackCodec: 'ac3', audioBitrate: '256k' }

  describe('firstDefaultRecipe', () => {
    it('gives new installs the streaming preset and the source codec', () => {
      expect(firstDefaultRecipe(legacy, false)).toEqual(applyLoudnessPreset('streaming-r128s2', { kind: 'same-as-source' }))
    })

    it('turns the old global target into the Earlier default preset on upgrades', () => {
      const recipe = firstDefaultRecipe(legacy, true) as NormalizeRecipe
      expect(recipe.kind).toBe('normalize')
      expect(recipe.presetId).toBe('custom')
      expect(recipe.userPreset).toEqual({ id: EARLIER_DEFAULT_PRESET.id, name: EARLIER_DEFAULT_PRESET.name })
      expect(recipe.target.integratedLufs).toBe(-14)
      expect(recipe.target.maxTruePeakDbtp).toBe(-1)
      expect(JSON.stringify(recipe)).not.toContain('LRA')
      expect(validateAudioRecipe({ ...recipe, userPreset: null })).toEqual([])
    })

    it('clamps the integrated target to -60..-5 and the true peak to -9..0', () => {
      expect((firstDefaultRecipe({ normalization: { I: -2, TP: 3, LRA: 20 } }, true) as NormalizeRecipe).target).toMatchObject({ integratedLufs: -5, maxTruePeakDbtp: 0 })
      expect((firstDefaultRecipe({ normalization: { I: -80, TP: -12, LRA: 1 } }, true) as NormalizeRecipe).target).toMatchObject({ integratedLufs: -60, maxTruePeakDbtp: -9 })
    })

    it('reads an unusable legacy target as the old defaults', () => {
      const target = (firstDefaultRecipe({ normalization: { I: 'loud', TP: Number.NaN } }, true) as NormalizeRecipe).target
      expect(target).toMatchObject({ integratedLufs: -16, maxTruePeakDbtp: -1.5 })
      expect(legacyCustomRecipe(null, { kind: 'same-as-source' }).target).toMatchObject({ integratedLufs: -16, maxTruePeakDbtp: -1.5 })
    })

    it('carries the old codec and bitrate into the preset', () => {
      const recipe = firstDefaultRecipe({ ...legacy, audioCodec: 'aac', audioBitrate: '192k' }, true) as NormalizeRecipe
      expect(recipe.output).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: 192 })
    })
  })

  describe('presetSeed', () => {
    it('seeds the Earlier default preset while new files still get it, and nothing otherwise', () => {
      const recipe = firstDefaultRecipe(legacy, true)
      const [seed, ...rest] = presetSeed({ defaultRecipe: recipe }, 1000)
      expect(rest).toEqual([])
      expect(seed).toEqual({ id: 'user-earlier-default', name: 'Earlier default', recipe: { ...recipe, userPreset: null }, createdAt: 1000, updatedAt: 1000 })
      expect(seed.recipe).not.toBe(recipe)
      expect(presetSeed({ defaultRecipe: firstDefaultRecipe(legacy, false) }, 1000)).toEqual([])
    })
  })

  describe('legacyEncoderPolicy', () => {
    it('maps the source codec choice to same as source', () => {
      expect(legacyEncoderPolicy('inherit', 'ac3', '256k')).toEqual({ kind: 'same-as-source' })
      expect(legacyEncoderPolicy('copy', 'ac3', '256k')).toEqual({ kind: 'same-as-source' })
    })

    it('maps encoder names and keeps the bitrate per channel pair', () => {
      expect(legacyEncoderPolicy('libmp3lame', 'ac3', '320k')).toEqual({ kind: 'codec', codec: 'mp3', kbpsPerPair: 320 })
      expect(legacyEncoderPolicy('Opus', 'ac3', 160)).toEqual({ kind: 'codec', codec: 'opus', kbpsPerPair: 160 })
      expect(legacyEncoderPolicy('eac3', 'ac3', '640000')).toEqual({ kind: 'codec', codec: 'eac3', kbpsPerPair: 640 })
    })

    it('gives lossless codecs no bitrate', () => {
      expect(legacyEncoderPolicy('flac', 'ac3', '256k')).toEqual({ kind: 'codec', codec: 'flac', kbpsPerPair: null })
      expect(legacyEncoderPolicy('pcm_s16le', 'ac3', '256k')).toEqual({ kind: 'codec', codec: 'pcm', kbpsPerPair: null })
    })

    it('clamps the bitrate and reads an unusable one as null', () => {
      expect(legacyEncoderPolicy('aac', 'ac3', '8k')).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: 32 })
      expect(legacyEncoderPolicy('aac', 'ac3', 'high')).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: null })
      expect(legacyEncoderPolicy('aac', 'ac3', '0k')).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: null })
      expect(legacyEncoderPolicy('aac', 'ac3', undefined)).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: null })
    })

    it('falls back to the fallback codec for a codec no longer offered, then to the source codec', () => {
      expect(legacyEncoderPolicy('dts', 'ac3', '448k')).toEqual({ kind: 'codec', codec: 'ac3', kbpsPerPair: 448 })
      expect(legacyEncoderPolicy('dts', 'dts', '448k')).toEqual({ kind: 'same-as-source' })
      expect(legacyEncoderPolicy(undefined, undefined, undefined)).toEqual({ kind: 'same-as-source' })
    })
  })
})

describe('interface size', () => {
  it('clamps to 90..200 and defaults to 100', () => {
    expect(INTERFACE_SCALE).toEqual({ min: 90, max: 200, default: 100 })
    expect(clampInterfaceScale(150)).toBe(150)
    expect(clampInterfaceScale(50)).toBe(90)
    expect(clampInterfaceScale(400)).toBe(200)
    expect(clampInterfaceScale('125')).toBe(100)
    expect(clampInterfaceScale(Number.POSITIVE_INFINITY)).toBe(100)
    expect(DEFAULT_CONFIG.interfaceScale).toBe(100)
  })
})

describe('jobs key', () => {
  const FOLDER = path.resolve('/media/out')
  const VIDEOS = path.resolve('/videos/MolexMedia')
  const context = { cpuCount: 8, defaultFolder: VIDEOS, upgrade: true }
  const newInstall = { ...context, upgrade: false }
  const fresh = { afterProcessing: 'keep-both', outputDirectory: '', confirmReplace: true, maxWorkers: 0, gpuAcceleration: 'off', showNotifications: true, normalization: { I: -14, TP: -1, LRA: 7 }, audioCodec: 'inherit' }

  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(storeData)) delete storeData[key]
  })

  describe('migrateJobsConfig', () => {
    it('gives a new install the stated defaults', () => {
      const { jobs, changed } = migrateJobsConfig(fresh, newInstall)
      expect(jobs.policy).toEqual({ rev: 0, destination: { mode: 'folder', folder: VIDEOS }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' })
      expect(jobs.settings).toEqual(DEFAULT_RUN_SETTINGS)
      expect(jobs.defaultRecipe).toEqual(applyLoudnessPreset('streaming-r128s2', { kind: 'same-as-source' }))
      expect(jobs.recentFolders).toEqual([])
      expect(jobs.pendingAlerts).toEqual([])
      expect(changed).toBe(true)
    })

    it('keeps the old output folder', () => {
      const { jobs } = migrateJobsConfig({ ...fresh, outputDirectory: FOLDER }, context)
      expect(jobs.policy.destination).toEqual({ mode: 'folder', folder: FOLDER })
      expect(jobs.policy.template).toBe('{name}')
    })

    it('migrates Replace to next to source and queues the alert once', () => {
      const legacy = { ...fresh, afterProcessing: 'replace', outputDirectory: FOLDER, confirmReplace: false }
      const first = migrateJobsConfig(legacy, context)
      expect(first.jobs.policy.destination).toEqual({ mode: 'next-to-source' })
      expect(first.jobs.policy.template).toBe('{name}-{op}')
      expect(first.jobs.pendingAlerts).toEqual(['replace-migrated'])
      const again = migrateJobsConfig({ ...legacy, jobs: first.jobs }, context)
      expect(again.changed).toBe(false)
      const taken = { ...first.jobs, pendingAlerts: [] }
      expect(migrateJobsConfig({ ...legacy, jobs: taken }, context).jobs.pendingAlerts).toEqual([])
      const rewritten = { ...taken, policy: { ...taken.policy, destination: { mode: 'replace-originals' } } }
      const repaired = migrateJobsConfig({ ...legacy, jobs: rewritten }, context).jobs
      expect(repaired.policy.destination).toEqual({ mode: 'next-to-source' })
      expect(repaired.pendingAlerts).toEqual([])
    })

    it('never raises the alert when the engine already wrote the policy', () => {
      const policy = { rev: 4, destination: { mode: 'folder', folder: FOLDER }, template: '{name}', conflict: 'skip', displaced: 'keep', gpu: 'require' }
      const { jobs } = migrateJobsConfig({ ...fresh, afterProcessing: 'replace', jobs: { policy } }, context)
      expect(jobs.policy).toBe(policy)
      expect(jobs.pendingAlerts).toEqual([])
    })

    it('maps the worker count: the CPU count or 0 is Auto, anything else stays fixed', () => {
      expect(migrateJobsConfig({ ...fresh, maxWorkers: 8 }, context).jobs.settings.workers).toEqual({ mode: 'auto' })
      expect(migrateJobsConfig({ ...fresh, maxWorkers: 3 }, context).jobs.settings.workers).toEqual({ mode: 'fixed', count: 3 })
      expect(legacyWorkers(0, 8)).toEqual({ mode: 'auto' })
      expect(legacyWorkers(-2, 8)).toEqual({ mode: 'auto' })
      expect(legacyWorkers(12, 8)).toEqual({ mode: 'fixed', count: 12 })
      expect(legacyWorkers(500, 8)).toEqual({ mode: 'fixed', count: 64 })
      expect(legacyWorkers(2.7, 8)).toEqual({ mode: 'fixed', count: 2 })
      expect(legacyWorkers('4', 8)).toEqual({ mode: 'auto' })
      expect(legacyWorkers(Number.NaN, 8)).toEqual({ mode: 'auto' })
    })

    it('derives notifications from the legacy switch and GPU from the legacy acceleration', () => {
      const { jobs } = migrateJobsConfig({ ...fresh, showNotifications: false, gpuAcceleration: 'nvenc' }, context)
      expect(jobs.settings.notify).toEqual({ completion: false, firstFailure: false })
      expect(jobs.policy.gpu).toBe('auto')
      expect(migrateJobsConfig({}, context).jobs.policy.gpu).toBe('off')
      expect(migrateJobsConfig({}, context).jobs.settings.notify).toEqual({ completion: true, firstFailure: true })
    })

    it('gives new files the Earlier default preset on upgrades', () => {
      const { jobs } = migrateJobsConfig(fresh, context)
      expect(jobs.defaultRecipe).toEqual(firstDefaultRecipe(fresh, true))
      expect(jobs.defaultRecipe.userPreset?.id).toBe(EARLIER_DEFAULT_PRESET.id)
    })

    it('fills only absent fields and never overwrites what the engine wrote', () => {
      const engine = {
        settings: { workers: { mode: 'fixed', count: 5 }, priority: 'normal', keepAwake: false, notify: { completion: false } },
        policy: { rev: 9, destination: { mode: 'next-to-source' }, template: '{name}_{date}', conflict: 'overwrite', displaced: 'keep', gpu: 'off' },
        defaultRecipe: applyGainPreset('louder', { kind: 'same-as-source' }),
        recentFolders: [{ path: FOLDER, name: 'out', files: 12, addedAt: 1760000000000 }],
        pendingAlerts: [],
        extra: 'kept'
      }
      const legacy = { ...fresh, maxWorkers: 2, afterProcessing: 'replace', outputDirectory: VIDEOS, showNotifications: true }
      const { jobs } = migrateJobsConfig({ ...legacy, jobs: engine }, context)
      expect(jobs.settings).toEqual({ ...DEFAULT_RUN_SETTINGS, workers: { mode: 'fixed', count: 5 }, priority: 'normal', keepAwake: false, notify: { completion: false, firstFailure: true } })
      expect(jobs.policy).toBe(engine.policy)
      expect(jobs.defaultRecipe).toBe(engine.defaultRecipe)
      expect(jobs.recentFolders).toBe(engine.recentFolders)
      expect((jobs as unknown as { extra: string }).extra).toBe('kept')
      expect(jobs.pendingAlerts).toEqual([])
    })

    it('is idempotent on new installs and upgrades', () => {
      for (const [legacy, machine] of [[fresh, newInstall], [{ ...fresh, afterProcessing: 'replace', maxWorkers: 3 }, context]] as const) {
        const first = migrateJobsConfig(legacy, machine)
        const second = migrateJobsConfig({ ...legacy, jobs: first.jobs }, machine)
        expect(second.changed).toBe(false)
        expect(second.jobs).toEqual(first.jobs)
      }
    })

    it('rebuilds unusable fields', () => {
      const broken = {
        settings: { workers: { mode: 'fixed', count: 0 }, gpuSessions: { mode: 'fixed', count: 99 }, priority: 'high', verifyVideo: 'none', notify: 'yes', measureOnReview: 1 },
        policy: { rev: -1, destination: { mode: 'next-to-source' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' },
        defaultRecipe: { kind: 'normalize' },
        recentFolders: [{ path: FOLDER, name: 'a', files: 1, addedAt: 1 }, { path: '', name: 'b', files: 1, addedAt: 1 }, 'c'],
        pendingAlerts: ['replace-migrated', 'nonsense', 'replace-migrated']
      }
      const { jobs } = migrateJobsConfig({ ...fresh, maxWorkers: 3, jobs: broken }, context)
      expect(jobs.settings).toEqual({ ...DEFAULT_RUN_SETTINGS, workers: { mode: 'fixed', count: 3 } })
      expect(jobs.policy.destination).toEqual({ mode: 'folder', folder: VIDEOS })
      expect(jobs.defaultRecipe).toEqual(firstDefaultRecipe(fresh, true))
      expect(jobs.recentFolders).toEqual([{ path: FOLDER, name: 'a', files: 1, addedAt: 1 }])
      expect(jobs.pendingAlerts).toEqual(['replace-migrated'])
      expect(migrateJobsConfig({ ...fresh, jobs: { policy: 'folder', recentFolders: {}, pendingAlerts: 'x' } }, context).jobs).toMatchObject({ recentFolders: [], pendingAlerts: [] })
      expect(migrateJobsConfig({ ...fresh, jobs: { policy: { rev: 1, destination: { mode: 'folder', folder: FOLDER } } } }, context).jobs.policy.rev).toBe(0)
    })

    it('keeps at most eight recent folders', () => {
      const folders = Array.from({ length: 10 }, (_, i) => ({ path: path.join(FOLDER, String(i)), name: String(i), files: i, addedAt: i }))
      const { jobs } = migrateJobsConfig({ ...fresh, jobs: { recentFolders: folders } }, context)
      expect(jobs.recentFolders).toEqual(folders.slice(0, MAX_RECENT_FOLDERS))
      expect(MAX_RECENT_FOLDERS).toBe(8)
    })
  })

  describe('legacyPolicy', () => {
    it('falls back to the default folder for an unusable old folder, then to next to source', () => {
      expect(legacyPolicy({ outputDirectory: 'relative/out' }, VIDEOS).destination).toEqual({ mode: 'folder', folder: VIDEOS })
      expect(legacyPolicy({ outputDirectory: '   ' }, '').destination).toEqual({ mode: 'next-to-source' })
      expect(legacyPolicy({ outputDirectory: 7 }, '').template).toBe('{name}-{op}')
    })
  })

  describe('loadConfig', () => {
    it('migrates an upgrade once and keeps the legacy keys readable', async () => {
      storeData.normalization = { I: -20, TP: -2, LRA: 9 }
      storeData.audioCodec = 'aac'
      storeData.audioBitrate = '192k'
      storeData.afterProcessing = 'replace'
      storeData.outputDirectory = FOLDER
      storeData.maxWorkers = 2
      const config = await loadConfig()
      const recipe = config.jobs.defaultRecipe as NormalizeRecipe
      expect(recipe.userPreset?.id).toBe(EARLIER_DEFAULT_PRESET.id)
      expect(recipe.target).toMatchObject({ integratedLufs: -20, maxTruePeakDbtp: -2 })
      expect(recipe.output).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: 192 })
      expect('audio' in config).toBe(false)
      expect(config.jobs.policy.destination).toEqual({ mode: 'next-to-source' })
      expect(config.jobs.settings.workers).toEqual({ mode: 'fixed', count: 2 })
      expect(config.jobs.pendingAlerts).toEqual(['replace-migrated'])
      expect(config.normalization).toEqual({ I: -20, TP: -2, LRA: 9 })
      expect(config.afterProcessing).toBe('replace')
      expect(config.outputDirectory).toBe(FOLDER)
      expect(config.maxWorkers).toBe(2)
      expect(storeData.audio).toBeUndefined()
      expect(storeData.jobs).toEqual(config.jobs)
      mockStoreSet.mockClear()
      await loadConfig()
      expect(mockStoreSet).not.toHaveBeenCalled()
    })

    it('hands the replace-migrated alert out once', async () => {
      storeData.afterProcessing = 'replace'
      await loadConfig()
      expect(await takeJobsAlerts()).toEqual(['replace-migrated'])
      expect(storeData.jobs.pendingAlerts).toEqual([])
      expect(await takeJobsAlerts()).toEqual([])
      await loadConfig()
      expect(await takeJobsAlerts()).toEqual([])
    })

    it('merges engine fields into the jobs key', async () => {
      await loadConfig()
      const policy = { ...storeData.jobs.policy, rev: 3, conflict: 'skip' }
      const jobs = await saveJobsConfig({ policy })
      expect(jobs.policy).toEqual(policy)
      expect(storeData.jobs.policy).toEqual(policy)
      expect(storeData.jobs.settings).toEqual(DEFAULT_RUN_SETTINGS)
    })

    it('clamps the interface size and reads announceProgress as a boolean', async () => {
      storeData.interfaceScale = 500
      storeData.announceProgress = 'yes'
      let config = await loadConfig()
      expect(config.interfaceScale).toBe(200)
      expect(config.announceProgress).toBe(false)
      storeData.interfaceScale = 125
      storeData.announceProgress = true
      config = await loadConfig()
      expect(config.interfaceScale).toBe(125)
      expect(config.announceProgress).toBe(true)
      expect(DEFAULT_CONFIG.announceProgress).toBe(false)
    })

    it('leaves the migrated keys out of the store defaults', () => {
      expect(DEFAULT_CONFIG.jobs.policy.destination).toEqual({ mode: 'next-to-source' })
      expect('audio' in DEFAULT_CONFIG).toBe(false)
    })
  })

  describe('new installs', () => {
    async function freshModule(exists: () => boolean): Promise<typeof import('../../src/main/config')> {
      vi.resetModules()
      const fsModule = await import('fs')
      vi.mocked(fsModule.existsSync).mockImplementationOnce(exists)
      return import('../../src/main/config')
    }

    it('get the streaming preset and the new-install policy', async () => {
      storeData.normalization = { I: -16, TP: -1.5, LRA: 11 }
      const mod = await freshModule(() => false)
      const electron = await import('electron')
      vi.mocked(electron.app.getPath).mockImplementation((name: string) => name === 'videos' ? path.resolve('/videos') : USER_DATA)
      const config = await mod.loadConfig()
      expect(config.jobs.defaultRecipe).toMatchObject({ kind: 'normalize', presetId: 'streaming-r128s2', userPreset: null })
      expect(config.jobs.policy).toEqual({ rev: 0, destination: { mode: 'folder', folder: path.join(path.resolve('/videos'), 'MolexMedia') }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' })
      expect(config.outputDirectory).toBe(path.join(path.resolve('/videos'), 'MolexMedia'))
      expect(config.jobs.settings.workers).toEqual({ mode: 'auto' })
      const again = await mod.loadConfig()
      expect(again.jobs.defaultRecipe).toEqual(config.jobs.defaultRecipe)
    })

    it('read an unreadable config folder as an upgrade', async () => {
      const mod = await freshModule(() => { throw new Error('denied') })
      const config = await mod.loadConfig()
      expect(config.jobs.defaultRecipe.userPreset?.id).toBe(EARLIER_DEFAULT_PRESET.id)
    })
  })

  describe('config IPC', () => {
    it('never returns, saves, or overwrites the jobs key', async () => {
      await loadConfig()
      const before = storeData.jobs
      for (const channel of ['config:load', 'config:get']) {
        const config = await ipcHandlers.get(channel)!({})
        expect('jobs' in config).toBe(false)
      }
      mockStoreSet.mockClear()
      const saved = await ipcHandlers.get('config:save')!({}, { jobs: { policy: { rev: 0, destination: { mode: 'replace-originals' } } }, announceProgress: true, interfaceScale: 150 })
      expect(mockStoreSet).not.toHaveBeenCalledWith('jobs', expect.anything())
      expect(mockStoreSet).toHaveBeenCalledWith('announceProgress', true)
      expect(storeData.jobs).toEqual(before)
      expect('jobs' in saved).toBe(false)
      expect(saved.announceProgress).toBe(true)
      expect(saved.interfaceScale).toBe(150)
    })
  })
})
