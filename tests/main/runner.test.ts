import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSpawn, mockLog } = vi.hoisted(() => ({ mockSpawn: vi.fn(), mockLog: vi.fn() }))

vi.mock('child_process', () => ({
  spawn: (...a: unknown[]) => mockSpawn(...a),
  ChildProcess: class {}
}))

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: (...a: unknown[]) => mockLog(...a) }
}))

import { parseProgress, runCommand, killAllProcesses, getActiveProcessCount } from '../../src/main/ffmpeg/runner'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'

class FakeChild extends EventEmitter
{
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  pid = 100
  killed = false
  kill = vi.fn(() =>
  {
    this.killed = true
    return true
  })
}

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

describe('process tracking', () => {
  beforeEach(() => {
    killAllProcesses()
    mockSpawn.mockReset()
    mockLog.mockReset()
  })

  it('kills only the children started through runCommand, never a job exec', () => {
    const tracked = new FakeChild()
    const job = new FakeChild()
    mockSpawn.mockReturnValueOnce(tracked)
    runCommand('ffmpeg', ['-version'])
    const exec = createExec('ffmpeg', { timers: realTimers, spawn: (() => job) as never })
    void exec.run(['-i', 'in.wav', 'out.wav'], { signal: new AbortController().signal, stop: 'kill' })
    expect(getActiveProcessCount()).toBe(1)
    killAllProcesses()
    expect(tracked.kill).toHaveBeenCalledWith('SIGTERM')
    expect(job.kill).not.toHaveBeenCalled()
    expect(getActiveProcessCount()).toBe(0)
  })

  it('logs the command unless asked not to', () => {
    mockSpawn.mockReturnValue(new FakeChild())
    runCommand('ffmpeg', ['-encoders'])
    runCommand('powershell.exe', ['-NoProfile'], undefined, { log: false })
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('CMD', 'ffmpeg -encoders')
  })

  it('stops tracking a child once it closes', async () => {
    const child = new FakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const { promise } = runCommand('ffmpeg', ['-version'])
    child.stdout.emit('data', 'ffmpeg version n9.0.2')
    child.emit('close', 0)
    await expect(promise).resolves.toEqual({ stdout: 'ffmpeg version n9.0.2', stderr: '', code: 0, killed: false })
    expect(getActiveProcessCount()).toBe(0)
  })
})
