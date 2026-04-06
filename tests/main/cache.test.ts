import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerStreamUrl, resolveStreamToken } from '../../src/main/ytdlp/cache'

describe('ytdlp/cache', () => {
  describe('registerStreamUrl', () => {
    it('returns a non-empty token', () => {
      const token = registerStreamUrl('https://cdn.example.com/stream.m4a')
      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')
      expect(token.length).toBeGreaterThan(5)
    })

    it('returns unique tokens for different URLs', () => {
      const t1 = registerStreamUrl('https://cdn.example.com/a')
      const t2 = registerStreamUrl('https://cdn.example.com/b')
      expect(t1).not.toBe(t2)
    })

    it('returns unique tokens for the same URL', () => {
      const t1 = registerStreamUrl('https://cdn.example.com/same')
      const t2 = registerStreamUrl('https://cdn.example.com/same')
      expect(t1).not.toBe(t2)
    })
  })

  describe('resolveStreamToken', () => {
    it('resolves a registered token to its URL', () => {
      const url = 'https://cdn.example.com/stream.m4a'
      const token = registerStreamUrl(url)
      expect(resolveStreamToken(token)).toBe(url)
    })

    it('returns null for unknown tokens', () => {
      expect(resolveStreamToken('nonexistent')).toBeNull()
    })

    it('returns null for expired tokens', () => {
      const url = 'https://cdn.example.com/expired'
      const token = registerStreamUrl(url)

      // Fast-forward past TTL (4 hours)
      const realDateNow = Date.now
      Date.now = vi.fn(() => realDateNow() + 5 * 60 * 60 * 1000) // 5 hours later

      expect(resolveStreamToken(token)).toBeNull()

      Date.now = realDateNow
    })

    it('still resolves within TTL window', () => {
      const url = 'https://cdn.example.com/valid'
      const token = registerStreamUrl(url)

      const realDateNow = Date.now
      Date.now = vi.fn(() => realDateNow() + 3 * 60 * 60 * 1000) // 3 hours later

      expect(resolveStreamToken(token)).toBe(url)

      Date.now = realDateNow
    })
  })
})
