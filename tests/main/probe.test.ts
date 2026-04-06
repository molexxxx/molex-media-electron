import { describe, it, expect } from 'vitest'
import { formatDuration, formatFileSize } from '../../src/main/ffmpeg/probe'

describe('formatDuration', () => {
  it('formats seconds-only durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(59)).toBe('0:59')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(90)).toBe('1:30')
    expect(formatDuration(605)).toBe('10:05')
  })

  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(7384)).toBe('2:03:04')
  })

  it('handles fractional seconds by flooring', () => {
    expect(formatDuration(90.7)).toBe('1:30')
    expect(formatDuration(3601.999)).toBe('1:00:01')
  })
})

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 100)).toBe('100.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 5.5)).toBe('5.5 MB')
  })

  it('formats gigabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB')
    expect(formatFileSize(1024 * 1024 * 1024 * 2.75)).toBe('2.75 GB')
  })
})
