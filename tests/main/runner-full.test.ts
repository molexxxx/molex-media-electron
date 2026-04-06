import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ChildProcess, EventEmitter } from 'events'

// Mock logger before importing
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

// Mock child_process.spawn
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }))

import { runCommand, killAllProcesses, getActiveProcessCount } from '../../src/main/ffmpeg/runner'

/** Helper to create a mock child process. */
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    killed: boolean
    kill: ReturnType<typeof vi.fn>
    pid: number
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = vi.fn(() => { proc.killed = true })
  proc.pid = 12345
  return proc
}

describe('runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Ensure no leftover active processes
    killAllProcesses()
  })

  it('resolves with stdout, stderr, and exit code on success', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { promise } = runCommand('/usr/bin/ffmpeg', ['-i', 'test.mp3'])

    mockProc.stdout.emit('data', Buffer.from('output data'))
    mockProc.stderr.emit('data', Buffer.from('progress info'))
    mockProc.emit('close', 0)

    const result = await promise
    expect(result.stdout).toBe('output data')
    expect(result.stderr).toBe('progress info')
    expect(result.code).toBe(0)
    expect(result.killed).toBe(false)
  })

  it('invokes onStderr callback for each non-empty line', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)
    const onStderr = vi.fn()

    const { promise } = runCommand('/usr/bin/ffmpeg', ['-i', 'x.mp3'], onStderr)

    mockProc.stderr.emit('data', Buffer.from('line1\nline2\n'))
    mockProc.emit('close', 0)

    await promise
    expect(onStderr).toHaveBeenCalledWith('line1')
    expect(onStderr).toHaveBeenCalledWith('line2')
  })

  it('rejects on process error', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { promise } = runCommand('/usr/bin/ffmpeg', [])

    mockProc.emit('error', new Error('spawn ENOENT'))

    await expect(promise).rejects.toThrow('spawn ENOENT')
  })

  it('resolves with killed=true when process was killed', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { promise } = runCommand('/usr/bin/ffmpeg', [])

    mockProc.killed = true
    mockProc.emit('close', null)

    const result = await promise
    expect(result.killed).toBe(true)
    expect(result.code).toBe(1) // null coalesces to 1
  })

  it('returns the child process handle', () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { process } = runCommand('/usr/bin/ffmpeg', ['-version'])
    expect(process).toBe(mockProc)
  })

  it('tracks active processes', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    runCommand('/usr/bin/ffmpeg', [])
    expect(getActiveProcessCount()).toBe(1)

    mockProc.emit('close', 0)
    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 0))
    expect(getActiveProcessCount()).toBe(0)
  })
})

describe('killAllProcesses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    killAllProcesses()
  })

  it('kills all active processes', () => {
    const proc1 = createMockProcess()
    const proc2 = createMockProcess()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    runCommand('/usr/bin/ffmpeg', ['-version'])
    runCommand('/usr/bin/ffmpeg', ['-version'])
    expect(getActiveProcessCount()).toBe(2)

    killAllProcesses()
    expect(getActiveProcessCount()).toBe(0)
  })

  it('is safe to call when no processes are running', () => {
    expect(() => killAllProcesses()).not.toThrow()
    expect(getActiveProcessCount()).toBe(0)
  })
})

describe('getActiveProcessCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    killAllProcesses()
  })

  it('returns 0 when no processes are running', () => {
    expect(getActiveProcessCount()).toBe(0)
  })
})
