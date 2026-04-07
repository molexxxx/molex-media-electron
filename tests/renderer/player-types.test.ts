import { describe, it, expect } from 'vitest'
import {
  MEDIA_EXTS,
  BROWSER_NATIVE_EXTS,
  VIDEO_EXTS,
  getExt,
  isYouTubeUrl,
  formatTime
} from '@renderer/components/player/types'

describe('getExt', () => {
  it('extracts extension from simple filename', () => {
    expect(getExt('song.mp3')).toBe('mp3')
  })

  it('extracts extension from deeply nested path', () => {
    expect(getExt('folder/sub/track.flac')).toBe('flac')
  })

  it('handles multiple dots', () => {
    expect(getExt('my.song.v2.wav')).toBe('wav')
  })

  it('normalises to lowercase', () => {
    expect(getExt('Song.MP3')).toBe('mp3')
    expect(getExt('Track.FLAC')).toBe('flac')
  })

  it('returns empty string for no extension', () => {
    expect(getExt('README')).toBe('readme')
  })

  it('returns empty string for empty input', () => {
    expect(getExt('')).toBe('')
  })
})

describe('BROWSER_NATIVE_EXTS', () => {
  it('includes common audio formats', () => {
    for (const ext of ['mp3', 'wav', 'ogg', 'flac', 'opus', 'aac', 'm4a']) {
      expect(BROWSER_NATIVE_EXTS.has(ext)).toBe(true)
    }
  })

  it('includes browser-playable video formats', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'ogv']) {
      expect(BROWSER_NATIVE_EXTS.has(ext)).toBe(true)
    }
  })

  it('excludes non-native formats', () => {
    for (const ext of ['mkv', 'avi', 'flv', 'wmv', 'wma', 'mts']) {
      expect(BROWSER_NATIVE_EXTS.has(ext)).toBe(false)
    }
  })
})

describe('VIDEO_EXTS', () => {
  it('includes all video containers', () => {
    for (const ext of ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv']) {
      expect(VIDEO_EXTS.has(ext)).toBe(true)
    }
  })

  it('excludes audio-only formats', () => {
    for (const ext of ['mp3', 'wav', 'flac', 'ogg', 'aac', 'opus', 'wma', 'm4a']) {
      expect(VIDEO_EXTS.has(ext)).toBe(false)
    }
  })
})

describe('MEDIA_EXTS', () => {
  it('contains all BROWSER_NATIVE_EXTS', () => {
    for (const ext of BROWSER_NATIVE_EXTS) {
      expect(MEDIA_EXTS).toContain(ext)
    }
  })

  it('contains all VIDEO_EXTS', () => {
    for (const ext of VIDEO_EXTS) {
      expect(MEDIA_EXTS).toContain(ext)
    }
  })
})

describe('isYouTubeUrl', () => {
  it('detects standard YouTube URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(true)
    expect(isYouTubeUrl('https://youtube.com/watch?v=abc123')).toBe(true)
  })

  it('detects short YouTube URLs', () => {
    expect(isYouTubeUrl('https://youtu.be/abc123')).toBe(true)
  })

  it('detects YouTube playlist URLs', () => {
    expect(isYouTubeUrl('https://www.youtube.com/playlist?list=PLxyz')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isYouTubeUrl('https://YOUTUBE.COM/watch?v=abc')).toBe(true)
    expect(isYouTubeUrl('https://YOUTU.BE/abc')).toBe(true)
  })

  it('rejects non-YouTube URLs', () => {
    expect(isYouTubeUrl('https://vimeo.com/12345')).toBe(false)
    expect(isYouTubeUrl('https://example.com')).toBe(false)
    expect(isYouTubeUrl('not-a-url')).toBe(false)
  })
})

describe('formatTime', () => {
  it('formats zero', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  it('formats seconds under a minute', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(59)).toBe('0:59')
  })

  it('formats minutes and seconds', () => {
    expect(formatTime(60)).toBe('1:00')
    expect(formatTime(90)).toBe('1:30')
    expect(formatTime(605)).toBe('10:05')
  })

  it('floors fractional seconds', () => {
    expect(formatTime(90.7)).toBe('1:30')
    expect(formatTime(5.9)).toBe('0:05')
  })

  it('handles negative values', () => {
    expect(formatTime(-1)).toBe('0:00')
  })

  it('handles NaN and Infinity', () => {
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})
