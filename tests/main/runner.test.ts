import { describe, it, expect } from 'vitest'
import { parseProgress } from '../../src/main/ffmpeg/runner'

describe('parseProgress', () => {
  it('parses a typical ffmpeg progress line', () => {
    const line = 'frame=  120 fps= 30 size=    1024kB time=00:01:30.50 bitrate= 128.0kbits/s speed= 2.5x'
    const result = parseProgress(line)
    expect(result).toEqual({
      time: 90.5,
      speed: '2.5x',
      size: '1024kB'
    })
  })

  it('parses time with hours', () => {
    const line = 'size=  512kB time=01:02:03.04 speed= 1.0x'
    const result = parseProgress(line)
    expect(result).not.toBeNull()
    expect(result!.time).toBe(3723.04)
    expect(result!.speed).toBe('1.0x')
    expect(result!.size).toBe('512kB')
  })

  it('parses zero time', () => {
    const line = 'size=    0kB time=00:00:00.00 speed=N/A'
    const result = parseProgress(line)
    expect(result).not.toBeNull()
    expect(result!.time).toBe(0)
    expect(result!.speed).toBe('')
    expect(result!.size).toBe('0kB')
  })

  it('returns null for non-progress lines', () => {
    expect(parseProgress('Stream mapping:')).toBeNull()
    expect(parseProgress('Input #0, mp3, from "test.mp3":')).toBeNull()
    expect(parseProgress('')).toBeNull()
  })

  it('handles missing speed', () => {
    const line = 'size=  256kB time=00:00:10.00'
    const result = parseProgress(line)
    expect(result).not.toBeNull()
    expect(result!.time).toBe(10)
    expect(result!.speed).toBe('')
  })

  it('handles missing size', () => {
    const line = 'time=00:00:05.20 speed= 3.0x'
    const result = parseProgress(line)
    expect(result).not.toBeNull()
    expect(result!.time).toBe(5.2)
    expect(result!.size).toBe('')
  })
})
