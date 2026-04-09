import { describe, it, expect, vi } from 'vitest'

// Mock logger to suppress console output
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

import {
  channelLayout,
  stripMolexTag,
  createTempPath,
  formatElapsed,
  pauseProcessing,
  resumeProcessing,
  getIsPaused
} from '../../src/main/ffmpeg/processor'

describe('channelLayout', () => {
  it('returns known layouts', () => {
    expect(channelLayout(1)).toBe('mono')
    expect(channelLayout(2)).toBe('stereo')
    expect(channelLayout(6)).toBe('5.1')
    expect(channelLayout(8)).toBe('7.1')
  })

  it('returns stereo for unknown channel counts', () => {
    expect(channelLayout(3)).toBe('stereo')
    expect(channelLayout(0)).toBe('stereo')
    expect(channelLayout(99)).toBe('stereo')
  })
})

describe('stripMolexTag', () => {
  it('strips [molexMedia...] tags', () => {
    expect(stripMolexTag('My Song [molexMedia normalized] extra')).toBe('My Song extra')
    expect(stripMolexTag('[molexMedia v3] Title')).toBe('Title')
  })

  it('strips [molexMedia...] tags', () => {
    expect(stripMolexTag('Track [molexMedia processed]')).toBe('Track')
  })

  it('strips multiple tags', () => {
    expect(stripMolexTag('[molexMedia a] Song [molexMedia b]')).toBe('Song')
  })

  it('returns untouched strings without tags', () => {
    expect(stripMolexTag('Normal Title')).toBe('Normal Title')
    expect(stripMolexTag('')).toBe('')
  })
})

describe('createTempPath', () => {
  it('inserts suffix before extension', () => {
    // path.join normalises separators per OS
    const result = createTempPath('/home/user/song.mp3', '_temp')
    expect(result).toContain('song_temp.mp3')
  })

  it('handles files with multiple dots', () => {
    const result = createTempPath('/data/my.song.v2.flac', '_proc')
    expect(result).toContain('my.song.v2_proc.flac')
  })
})

describe('formatElapsed', () => {
  it('formats milliseconds', () => {
    expect(formatElapsed(0, 500)).toBe('500ms')
    expect(formatElapsed(1000, 1999)).toBe('999ms')
  })

  it('formats seconds', () => {
    expect(formatElapsed(0, 1000)).toBe('1.0s')
    expect(formatElapsed(0, 5500)).toBe('5.5s')
    expect(formatElapsed(0, 59999)).toBe('60.0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatElapsed(0, 60000)).toBe('1m 0s')
    expect(formatElapsed(0, 90000)).toBe('1m 30s')
    expect(formatElapsed(0, 125000)).toBe('2m 5s')
  })
})

describe('pause/resume processing', () => {
  it('starts unpaused', () => {
    // Clean state - resume to ensure clean
    resumeProcessing()
    expect(getIsPaused()).toBe(false)
  })

  it('can pause and resume', () => {
    pauseProcessing()
    expect(getIsPaused()).toBe(true)
    resumeProcessing()
    expect(getIsPaused()).toBe(false)
  })

  it('pause is idempotent', () => {
    pauseProcessing()
    pauseProcessing() // second call should not throw
    expect(getIsPaused()).toBe(true)
    resumeProcessing()
  })

  it('resume is idempotent', () => {
    resumeProcessing()
    resumeProcessing() // second call should not throw
    expect(getIsPaused()).toBe(false)
  })
})
