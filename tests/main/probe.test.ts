import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  formatDuration, formatFileSize, createProbe, parseProbeJson, bitDepth, streamDuration, probeArgs, toMediaInfo,
  ProbeOutputError, PROBE_TIMEOUT_MS
} from '../../src/main/ffmpeg/probe'

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

function fakeProcess() {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

function fakeSpawn(proc: any) {
  return vi.fn(() => proc) as any
}

describe('probeArgs', () => {
  it('asks for format, streams, and chapters as JSON with the path after -i', () => {
    expect(probeArgs('-odd name.wav')).toEqual(['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-i', '-odd name.wav'])
  })
})

describe('parseProbeJson', () => {
  it('keeps what ffprobe printed and reads missing sections as empty', () => {
    expect(parseProbeJson('{\n\n}')).toEqual({ streams: [], format: null, chapters: [] })
    const parsed = parseProbeJson(JSON.stringify({ streams: [{ index: 0, codec_type: 'audio' }, 7, null], chapters: [{ id: 1 }, 'x'], format: { duration: '1.0' } }))
    expect(parsed).toEqual({ streams: [{ index: 0, codec_type: 'audio' }], chapters: [{ id: 1 }], format: { duration: '1.0' } })
  })

  it('throws ProbeOutputError for output that is not a JSON object', () => {
    expect(() => parseProbeJson('BROKEN')).toThrow(ProbeOutputError)
    expect(() => parseProbeJson('[]')).toThrow('ffprobe printed no JSON object')
    expect(() => parseProbeJson('null')).toThrow(ProbeOutputError)
  })
})

describe('bitDepth', () => {
  it('prefers bits_per_raw_sample, as FLAC in an s32 sample format reports', () => {
    expect(bitDepth({ bits_per_sample: 0, bits_per_raw_sample: '24' })).toBe(24)
  })

  it('falls back to bits_per_sample, as PCM reports', () => {
    expect(bitDepth({ bits_per_sample: 24 })).toBe(24)
  })

  it('is null for a lossy stream that reports 0 bits', () => {
    expect(bitDepth({ bits_per_sample: 0 })).toBeNull()
    expect(bitDepth({})).toBeNull()
    expect(bitDepth({ bits_per_raw_sample: 'N/A' })).toBeNull()
  })
})

describe('streamDuration', () => {
  it('reads the duration field first', () => {
    expect(streamDuration({ duration: '2.000000', tags: { DURATION: '00:00:09.000000000' } })).toBe(2)
  })

  it('reads the Matroska DURATION tag, with or without a language suffix', () => {
    expect(streamDuration({ tags: { DURATION: '00:00:02.000000000' } })).toBe(2)
    expect(streamDuration({ tags: { 'DURATION-eng': '01:02:03.5' } })).toBeCloseTo(3723.5, 9)
  })

  it('is null when neither is present or readable', () => {
    expect(streamDuration({})).toBeNull()
    expect(streamDuration({ duration: 'N/A', tags: { DURATION: 'soon' } })).toBeNull()
  })
})

describe('toMediaInfo', () => {
  it('builds streams only from what ffprobe listed', () => {
    const info = toMediaInfo({ streams: [], format: null, chapters: [] }, '/x/silence.dat')
    expect(info.audioStreams).toEqual([])
    expect(info.format).toEqual({ filename: '/x/silence.dat', duration: '0', size: '0', bit_rate: '0', format_name: 'unknown', tags: undefined })
    expect(info.isAudioOnly).toBe(false)
    expect(info.chapters).toEqual([])
  })
})

describe('createProbe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the parsed output of one hidden run', async () => {
    const proc = fakeProcess()
    const spawn = fakeSpawn(proc)
    const pending = createProbe('/bin/ffprobe', { spawn })('/m/a.flac')
    proc.stdout.emit('data', Buffer.from('{"streams":[{"index":0,"codec_type":"audio","sample_fmt":"s'))
    proc.stdout.emit('data', '16"}]}')
    proc.emit('close', 0, null)
    await expect(pending).resolves.toEqual({ streams: [{ index: 0, codec_type: 'audio', sample_fmt: 's16' }], format: null, chapters: [] })
    expect(spawn).toHaveBeenCalledWith('/bin/ffprobe', probeArgs('/m/a.flac'), { windowsHide: true })
  })

  it('decodes a multibyte character split across chunks', async () => {
    const proc = fakeProcess()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc) })('/m/a.flac')
    const bytes = Buffer.from('{"format":{"tags":{"title":"\u00e9t\u00e9"}}}')
    proc.stdout.emit('data', bytes.subarray(0, 25))
    proc.stdout.emit('data', bytes.subarray(25))
    proc.emit('close', 0, null)
    await expect(pending).resolves.toMatchObject({ format: { tags: { title: '\u00e9t\u00e9' } } })
  })

  it('rejects with stderr on a non-zero exit and names a signal exit', async () => {
    const proc = fakeProcess()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc) })('/m/gone.wav')
    proc.stderr.emit('data', Buffer.from('gone.wav: No such file or directory\n'))
    proc.emit('close', 1, null)
    await expect(pending).rejects.toThrow('ffprobe exited with 1: gone.wav: No such file or directory')

    const killed = fakeProcess()
    const second = createProbe('/bin/ffprobe', { spawn: fakeSpawn(killed) })('/m/a.wav')
    killed.emit('close', null, 'SIGKILL')
    await expect(second).rejects.toThrow('ffprobe exited with SIGKILL')
  })

  it('rejects with the spawn error', async () => {
    const proc = fakeProcess()
    const pending = createProbe('/bin/missing', { spawn: fakeSpawn(proc) })('/m/a.wav')
    proc.emit('error', new Error('spawn /bin/missing ENOENT'))
    proc.emit('close', -2, null)
    await expect(pending).rejects.toThrow('ENOENT')
  })

  it('rejects with ProbeOutputError when a clean exit printed no JSON', async () => {
    const proc = fakeProcess()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc) })('/m/a.wav')
    proc.stdout.emit('data', Buffer.from('garbage'))
    proc.emit('close', 0, null)
    await expect(pending).rejects.toBeInstanceOf(ProbeOutputError)
  })

  it('never spawns for a signal that is already aborted', async () => {
    const spawn = fakeSpawn(fakeProcess())
    const controller = new AbortController()
    controller.abort()
    await expect(createProbe('/bin/ffprobe', { spawn })('/m/a.wav', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('kills the process and rejects when the signal aborts', async () => {
    const proc = fakeProcess()
    const controller = new AbortController()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc) })('/m/a.wav', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'The probe was canceled' })
    expect(proc.kill).toHaveBeenCalledTimes(1)
    proc.emit('close', null, 'SIGTERM')
  })

  it('kills the process and rejects after the time limit', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc) })('/m/slow.wav')
    const settled = expect(pending).rejects.toThrow(`ffprobe did not finish within ${PROBE_TIMEOUT_MS / 1000} s`)
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS)
    await settled
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('takes a shorter time limit', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess()
    const pending = createProbe('/bin/ffprobe', { spawn: fakeSpawn(proc), timeoutMs: 2000 })('/m/slow.wav')
    const settled = expect(pending).rejects.toThrow('ffprobe did not finish within 2 s')
    vi.advanceTimersByTime(2000)
    await settled
  })
})