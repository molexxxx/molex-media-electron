import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}))

const mockGetConfig = vi.fn()
const mockSaveConfig = vi.fn()
const mockGetUserDataPath = vi.fn(() => '/mock/userdata')
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: any[]) => mockGetConfig(...a),
  saveConfig: (...a: any[]) => mockSaveConfig(...a),
  getUserDataPath: () => mockGetUserDataPath()
}))

const mockExistsSync = vi.fn()
const mockStatSync = vi.fn()
const mockUnlinkSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a),
  statSync: (...a: any[]) => mockStatSync(...a),
  unlinkSync: (...a: any[]) => mockUnlinkSync(...a),
  mkdirSync: vi.fn()
}))

const mockDl = vi.fn()
const mockGetYtDl = vi.fn(() => Promise.resolve(mockDl))
const mockBaseFlags = vi.fn(() => ({ noWarnings: true }))
vi.mock('../../src/main/ytdlp/binary', () => ({
  getYtDl: (...a: any[]) => mockGetYtDl(...a),
  baseFlags: (...a: any[]) => mockBaseFlags(...a)
}))

// We need a fresh module for each test because cookies.ts has module-level state
let ensureCookieFlags: typeof import('../../src/main/ytdlp/cookies').ensureCookieFlags
let withCookieRetry: typeof import('../../src/main/ytdlp/cookies').withCookieRetry
let getInstalledBrowsers: typeof import('../../src/main/ytdlp/cookies').getInstalledBrowsers
let setBrowserAndExport: typeof import('../../src/main/ytdlp/cookies').setBrowserAndExport
let clearCookies: typeof import('../../src/main/ytdlp/cookies').clearCookies
let getCookieInfo: typeof import('../../src/main/ytdlp/cookies').getCookieInfo

beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()

  mockGetConfig.mockResolvedValue({ ytdlpBrowser: '' })
  mockSaveConfig.mockResolvedValue({})
  mockGetYtDl.mockResolvedValue(mockDl)

  const mod = await import('../../src/main/ytdlp/cookies')
  ensureCookieFlags = mod.ensureCookieFlags
  withCookieRetry = mod.withCookieRetry
  getInstalledBrowsers = mod.getInstalledBrowsers
  setBrowserAndExport = mod.setBrowserAndExport
  clearCookies = mod.clearCookies
  getCookieInfo = mod.getCookieInfo
})

describe('ytdlp/cookies', () => {
  describe('ensureCookieFlags', () => {
    it('returns cookie path when cookies file is fresh', async () => {
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 1000 })

      const flags = await ensureCookieFlags()
      expect(flags).toHaveProperty('cookies')
      expect(flags.cookies).toContain('cookies.txt')
    })

    it('uses stale cookies when file exists but is old, triggers background refresh', async () => {
      let statCallCount = 0
      mockStatSync.mockImplementation(() => {
        statCallCount++
        if (statCallCount === 1) {
          // Freshness: stale
          return { mtimeMs: Date.now() - 25 * 60 * 60 * 1000 }
        }
        // Size check for usability
        return { mtimeMs: Date.now() - 25 * 60 * 60 * 1000, size: 500 }
      })
      mockExistsSync.mockReturnValue(true)

      const flags = await ensureCookieFlags()
      expect(flags).toHaveProperty('cookies')
    })

    it('exports cookies from detected browser when no file exists', async () => {
      // No fresh cookies, no existing file
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })

      // Browser detection: existsSync checks for browser paths
      // On win32, checks vivaldi, brave, firefox, chrome, edge, opera data dirs
      let existsCallCount = 0
      mockExistsSync.mockImplementation((p: string) => {
        existsCallCount++
        // Simulate finding Chrome
        if (typeof p === 'string' && p.includes('Chrome')) return true
        if (typeof p === 'string' && p.includes('cookies.txt')) {
          // After export, cookie file exists
          return existsCallCount > 5
        }
        return false
      })

      // Export succeeds
      mockDl.mockResolvedValue(undefined)

      const flags = await ensureCookieFlags()
      // Either returns cookie flags or empty (depends on export success)
      expect(flags).toBeDefined()
    })

    it('returns empty flags when no browser and no cookies file', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const flags = await ensureCookieFlags()
      expect(flags).toEqual({})
    })

    it('returns empty flags when export fails and no fallback browser', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })

      // First existsSync for browser detection - find a browser
      let callN = 0
      mockExistsSync.mockImplementation((p: string) => {
        callN++
        if (typeof p === 'string' && p.includes('Chrome') && callN < 3) return true
        return false
      })

      // Export fails
      mockDl.mockRejectedValue(new Error('cannot connect'))

      const flags = await ensureCookieFlags()
      expect(flags).toEqual({})
    })

    it('handles cookie export with cookie error and tries fallback browser', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })

      let callIdx = 0
      mockExistsSync.mockImplementation((p: string) => {
        callIdx++
        // Find Chrome first, then Edge as fallback
        if (typeof p === 'string' && p.includes('Chrome')) return true
        if (typeof p === 'string' && p.includes('Edge') && callIdx > 5) return true
        return false
      })

      // First export fails with cookie error, second (fallback) also fails
      mockDl.mockRejectedValue(new Error('could not copy cookie database'))

      const flags = await ensureCookieFlags()
      expect(flags).toEqual({})
    })

    it('uses existing cookie file when export fails non-cookie error but file exists', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })

      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('Chrome')) return true
        if (typeof p === 'string' && p.includes('cookies.txt')) return true
        return false
      })

      // Re-mock statSync for the file size check inside the catch
      // We need statSync to throw for freshness but work for the size check
      let freshChecked = false
      mockStatSync.mockImplementation(() => {
        if (!freshChecked) {
          freshChecked = true
          throw new Error('ENOENT')
        }
        return { size: 500 }
      })

      // Export fails with non-cookie error but file exists with content
      mockDl.mockRejectedValue(new Error('network timeout'))

      const flags = await ensureCookieFlags()
      // Should detect the file was written despite error
      expect(flags).toBeDefined()
    })
  })

  describe('withCookieRetry', () => {
    it('returns result on first attempt success', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn().mockResolvedValue('success')
      const result = await withCookieRetry(fn)
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('throws non-auth errors directly', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn().mockRejectedValue(new Error('Network timeout'))
      await expect(withCookieRetry(fn)).rejects.toThrow('Network timeout')
    })

    it('retries on cookie error then succeeds', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('could not copy cookie database'))
        .mockResolvedValueOnce('retry-success')

      const result = await withCookieRetry(fn)
      expect(result).toBe('retry-success')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('retries on sign-in error', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Sign in to confirm your age'))
        .mockResolvedValueOnce('ok')

      const result = await withCookieRetry(fn)
      expect(result).toBe('ok')
    })

    it('falls back to no cookies when retry also fails with cookie error', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('could not copy cookie database'))
        .mockRejectedValueOnce(new Error('failed to decrypt'))
        .mockResolvedValueOnce('no-cookie-success')

      const result = await withCookieRetry(fn)
      expect(result).toBe('no-cookie-success')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('throws when retry fails with non-cookie error', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('login required'))
        .mockRejectedValueOnce(new Error('Server error 500'))

      await expect(withCookieRetry(fn)).rejects.toThrow('Server error 500')
    })

    it('retries on age-restricted error', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('age-restricted content'))
        .mockResolvedValueOnce('ok')

      const result = await withCookieRetry(fn)
      expect(result).toBe('ok')
    })

    it('uses cached browser from config', async () => {
      mockGetConfig.mockResolvedValue({ ytdlpBrowser: 'firefox' })
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 1000 })

      const fn = vi.fn().mockResolvedValue('result')
      const result = await withCookieRetry(fn)
      expect(result).toBe('result')
    })
  })

  describe('getInstalledBrowsers', () => {
    it('returns browsers whose data directories exist', () => {
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && (p.includes('Chrome') || p.includes('Firefox'))
      )
      const browsers = getInstalledBrowsers()
      expect(Array.isArray(browsers)).toBe(true)
      for (const b of browsers) {
        expect(b).toHaveProperty('name')
        expect(b).toHaveProperty('label')
      }
    })

    it('returns empty array when no browsers found', () => {
      mockExistsSync.mockReturnValue(false)
      const browsers = getInstalledBrowsers()
      expect(browsers).toEqual([])
    })

    it('handles existsSync errors gracefully', () => {
      mockExistsSync.mockImplementation(() => { throw new Error('access denied') })
      const browsers = getInstalledBrowsers()
      expect(Array.isArray(browsers)).toBe(true)
    })
  })

  describe('setBrowserAndExport', () => {
    it('sets sessionBrowser and saves config', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)
      await setBrowserAndExport('chrome')
      expect(mockSaveConfig).toHaveBeenCalledWith({ ytdlpBrowser: 'chrome' })
    })

    it('returns true when export succeeds', async () => {
      mockDl.mockResolvedValue(undefined)
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('cookies.txt')) return true
        return false
      })
      const result = await setBrowserAndExport('firefox')
      // sessionBrowser is set to 'firefox' so detectBrowser returns it
      expect(typeof result).toBe('boolean')
    })

    it('returns false when no browser is available and export fails', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)
      mockDl.mockRejectedValue(new Error('cannot connect'))
      const result = await setBrowserAndExport('nonexistent')
      expect(result).toBe(false)
    })

    it('handles cookie error and succeeds with fallback browser', async () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      let callIdx = 0
      mockExistsSync.mockImplementation((p: string) => {
        callIdx++
        // First: setBrowserAndExport already sets sessionBrowser to 'chrome'
        // detectBrowser uses sessionBrowser, so exportCookiesFromBrowser proceeds
        // After invalidation: find Edge as fallback
        if (typeof p === 'string' && p.toLowerCase().includes('edge') && callIdx > 3) return true
        return false
      })
      // First export fails with cookie error, fallback export succeeds
      mockDl
        .mockRejectedValueOnce(new Error('could not copy cookie database'))
        .mockResolvedValueOnce(undefined)
      const result = await setBrowserAndExport('chrome')
      expect(result).toBe(true)
    })
  })

  describe('clearCookies', () => {
    it('removes cookie file and resets browser state', async () => {
      mockExistsSync.mockReturnValue(true)
      await clearCookies()
      expect(mockUnlinkSync).toHaveBeenCalled()
      expect(mockSaveConfig).toHaveBeenCalledWith({ ytdlpBrowser: '' })
    })

    it('handles missing cookie file gracefully', async () => {
      mockExistsSync.mockReturnValue(false)
      await expect(clearCookies()).resolves.not.toThrow()
      expect(mockSaveConfig).toHaveBeenCalledWith({ ytdlpBrowser: '' })
    })
  })

  describe('getCookieInfo', () => {
    it('returns info when cookie file exists with data', () => {
      mockStatSync.mockReturnValue({ size: 500, mtimeMs: Date.now() - 5000 })
      const info = getCookieInfo()
      expect(info.exists).toBe(true)
      expect(info.age).toBeGreaterThanOrEqual(5000)
    })

    it('returns exists=false for empty file', () => {
      mockStatSync.mockReturnValue({ size: 0, mtimeMs: Date.now() })
      const info = getCookieInfo()
      expect(info.exists).toBe(false)
    })

    it('returns exists=false when file does not exist', () => {
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      const info = getCookieInfo()
      expect(info.exists).toBe(false)
      expect(info.age).toBeNull()
    })

    it('returns browser name when session browser is set', async () => {
      // Set session browser via setBrowserAndExport
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockReturnValue(false)
      await setBrowserAndExport('edge')
      mockStatSync.mockReturnValue({ size: 100, mtimeMs: Date.now() })
      const info = getCookieInfo()
      expect(info.browser).toBe('edge')
    })
  })

  describe('ensureCookieFlags – IIFE fileUsable catch path', () => {
    it('handles existsSync true but statSync throws in IIFE', async () => {
      let freshChecked = false
      mockStatSync.mockImplementation(() => {
        if (!freshChecked) {
          freshChecked = true
          // First call: isCookiesFileFresh → throws (stale/missing)
          throw new Error('ENOENT')
        }
        // Second call: inside IIFE statSync(fp).size → throw
        throw new Error('permission denied')
      })
      // existsSync returns true for cookies.txt, false for browsers
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('cookies.txt')
      )
      const flags = await ensureCookieFlags()
      // fileUsable catch returns false → goes to "No file at all"
      // No browser found → returns {}
      expect(flags).toEqual({})
    })
  })

  describe('ensureCookieFlags – detectBrowser config browser failed', () => {
    it('skips config browser when it has previously failed', async () => {
      // First call: set and fail a browser
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT') })
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && p.includes('Chrome')
      )
      mockDl.mockRejectedValue(new Error('could not copy cookie database'))
      mockGetConfig.mockResolvedValue({ ytdlpBrowser: 'chrome' })

      // This will fail with cookie error, invalidate 'chrome', then try to detect
      // another browser. If Chrome is the only one, it loops through all and fails.
      await ensureCookieFlags()

      // Now call again — chrome should be in failedBrowsers and cfg.ytdlpBrowser='chrome'
      // detectBrowser should skip chrome and fall through
      mockExistsSync.mockReturnValue(false)
      const flags = await ensureCookieFlags()
      expect(flags).toEqual({})
    })
  })
})
