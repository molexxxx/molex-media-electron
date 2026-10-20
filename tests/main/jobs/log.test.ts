import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import {
  COMMAND_PREFIX,
  attemptLogMode,
  createEngineLog,
  type AttemptOutcome,
  type JobLogLine,
  type LogFileWriter,
  createAttemptRing,
  DETAIL_TAIL_BYTES,
  ERROR_TAIL_BYTES,
  RING_BYTES,
  RING_HEAD_BYTES,
  attemptLogPath,
  logPrefix,
  omissionMarker,
  quoteForDisplay,
  tailAtLineBoundary
} from '../../../src/main/jobs/log'
import { formatCatalog, formatRunId } from '../../../src/shared/jobs/ids'
import type { Platform } from '../../../src/shared/text/platform'

const JOB = formatCatalog(142)
const RUN = formatRunId(31)

function bytes(text: string): number
{
  return Buffer.byteLength(text, 'utf8')
}

function numbered(count: number, width = 20): string[]
{
  return Array.from({ length: count }, (_, i) => `L${String(i).padStart(5, '0')}`.padEnd(width, 'x'))
}

describe('tailAtLineBoundary', () =>
{
  it('returns text that already fits unchanged', () =>
  {
    expect(tailAtLineBoundary('a\nb\n', 4)).toBe('a\nb\n')
    expect(tailAtLineBoundary('', 10)).toBe('')
  })

  it('returns nothing for a zero budget', () =>
  {
    expect(tailAtLineBoundary('abc\n', 0)).toBe('')
    expect(tailAtLineBoundary('abc\n', -5)).toBe('')
  })

  it('starts the tail at a line boundary', () =>
  {
    const text = 'first line\nsecond line\nthird\n'
    const tail = tailAtLineBoundary(text, 14)
    expect(tail).toBe('third\n')
    expect(bytes(tail)).toBeLessThanOrEqual(14)
  })

  it('keeps a cut that already falls on a boundary', () =>
  {
    expect(tailAtLineBoundary('aaa\nbbb\nccc\n', 8)).toBe('bbb\nccc\n')
  })

  it('keeps the end of a single long line at a character boundary', () =>
  {
    const text = `${'é'.repeat(10)}\n`
    const tail = tailAtLineBoundary(text, 6)
    expect(bytes(tail)).toBeLessThanOrEqual(6)
    expect(tail).toBe('éé\n')
    expect(tail).not.toContain('\ufffd')
  })

  it('keeps the end of text without a line break', () =>
  {
    expect(tailAtLineBoundary('abcdefgh', 3)).toBe('fgh')
  })

  it.each([ERROR_TAIL_BYTES, DETAIL_TAIL_BYTES])('cuts a %i byte tail at a line boundary', (limit) =>
  {
    const lines = numbered(4000, 37)
    const text = `${lines.join('\n')}\n`
    const tail = tailAtLineBoundary(text, limit)
    expect(bytes(tail)).toBeLessThanOrEqual(limit)
    expect(bytes(tail)).toBeGreaterThan(limit - 40)
    expect(text.endsWith(tail)).toBe(true)
    expect(tail.startsWith('L')).toBe(true)
    expect(text[text.length - tail.length - 1]).toBe('\n')
  })
})

describe('quoteForDisplay', () =>
{
  const platforms: Platform[] = ['win32', 'linux', 'darwin']

  it.each(platforms)('leaves plain arguments bare on %s', (platform) =>
  {
    expect(quoteForDisplay(['ffmpeg', '-hide_banner', '-i', 'in.flac', 'out.m4a'], platform))
      .toBe('ffmpeg -hide_banner -i in.flac out.m4a')
  })

  it.each(platforms)('quotes empty arguments on %s', (platform) =>
  {
    expect(quoteForDisplay(['-metadata', ''], platform)).toBe(platform === 'win32' ? '-metadata ""' : `-metadata ''`)
  })

  it.each([
    ['win32', ['-i', 'D:\\Music\\My Song.flac'], '-i "D:\\Music\\My Song.flac"'],
    ['linux', ['-i', '/home/me/My Song.flac'], `-i '/home/me/My Song.flac'`],
    ['darwin', ['-i', '/Users/me/My Song.flac'], `-i '/Users/me/My Song.flac'`]
  ] as Array<[Platform, string[], string]>)('quotes arguments with spaces on %s', (platform, argv, expected) =>
  {
    expect(quoteForDisplay(argv, platform)).toBe(expected)
  })

  it.each([
    ['win32', 'say "hi".mp3', '"say \\"hi\\".mp3"'],
    ['linux', `it's here.mp3`, `'it'\\''s here.mp3'`],
    ['darwin', `it's.mp3`, `'it'\\''s.mp3'`],
    ['linux', 'say "hi".mp3', `'say "hi".mp3'`]
  ] as Array<[Platform, string, string]>)('escapes quotes on %s', (platform, arg, expected) =>
  {
    expect(quoteForDisplay([arg], platform)).toBe(expected)
  })

  it.each([
    ['win32', 'Café.flac', 'Café.flac'],
    ['win32', 'Мой файл.flac', '"Мой файл.flac"'],
    ['linux', 'Café.flac', 'Café.flac'],
    ['linux', '日本語 曲.flac', `'日本語 曲.flac'`],
    ['darwin', 'Ünïcödé.m4a', 'Ünïcödé.m4a'],
    ['darwin', 'Ünïcödé ü.m4a', `'Ünïcödé ü.m4a'`]
  ] as Array<[Platform, string, string]>)('handles non-ASCII names on %s', (platform, arg, expected) =>
  {
    expect(quoteForDisplay([arg], platform)).toBe(expected)
  })

  it('doubles backslashes before a quote and at the end of a quoted Windows argument', () =>
  {
    expect(quoteForDisplay(['a\\"b c'], 'win32')).toBe('"a\\\\\\"b c"')
    expect(quoteForDisplay(['D:\\My Folder\\'], 'win32')).toBe('"D:\\My Folder\\\\"')
    expect(quoteForDisplay(['D:\\plain\\path'], 'win32')).toBe('D:\\plain\\path')
  })

  it('quotes shell metacharacters', () =>
  {
    expect(quoteForDisplay(['a&b', 'c|d', '(x)'], 'win32')).toBe('"a&b" "c|d" "(x)"')
    expect(quoteForDisplay(['$HOME', 'a;b', 'a*b'], 'linux')).toBe(`'$HOME' 'a;b' 'a*b'`)
  })
})

describe('log names', () =>
{
  it('prefixes a job line with its catalog number and a run line with its id', () =>
  {
    expect(logPrefix({ jobId: JOB, runId: RUN, attempt: 2 })).toBe('[MM-0142]')
    expect(logPrefix({ runId: RUN })).toBe('[R-0031]')
    expect(logPrefix({})).toBe('')
  })

  it('places an attempt log under its run', () =>
  {
    expect(attemptLogPath('/logs', RUN, JOB, 3)).toBe(path.join('/logs', 'R-0031', 'MM-0142-a3.log'))
  })

  it('words the omission marker', () =>
  {
    expect(omissionMarker(1, 10)).toBe('[1 line (10 bytes) of output omitted]')
    expect(omissionMarker(12, 3456)).toBe('[12 lines (3456 bytes) of output omitted]')
  })
})

describe('createAttemptRing', () =>
{
  it('keeps everything while it fits', () =>
  {
    const ring = createAttemptRing({ totalBytes: 100, headBytes: 20 })
    ring.push('one')
    ring.push('two\nthree\n')
    expect(ring.text()).toBe('one\ntwo\nthree\n')
    expect(ring.bytes).toBe(14)
    expect(ring.omitted).toEqual({ lines: 0, bytes: 0 })
  })

  it('pins the head and keeps the latest lines with an omission marker between them', () =>
  {
    const ring = createAttemptRing({ totalBytes: 100, headBytes: 30 })
    const lines = numbered(30, 9)
    for (const line of lines)
    {
      ring.push(line)
    }
    const text = ring.text()
    const out = text.split('\n')
    expect(out.slice(0, 3)).toEqual(lines.slice(0, 3))
    expect(out[3]).toMatch(/^\[\d+ lines \(\d+ bytes\) of output omitted\]$/)
    expect(out.slice(4, -1)).toEqual(lines.slice(23))
    expect(ring.bytes).toBeLessThanOrEqual(100)
    expect(ring.omitted).toEqual({ lines: 20, bytes: 200 })
  })

  it('bounds memory at the default 256 KiB with the first 32 KiB pinned', () =>
  {
    const ring = createAttemptRing()
    const lines = numbered(30000, 40)
    for (const line of lines)
    {
      ring.push(line)
    }
    expect(ring.bytes).toBeLessThanOrEqual(RING_BYTES)
    expect(ring.bytes).toBeGreaterThan(RING_BYTES - 41)
    const text = ring.text()
    const headLines = Math.floor(RING_HEAD_BYTES / 41)
    expect(text.startsWith(`${lines.slice(0, headLines).join('\n')}\n[`)).toBe(true)
    expect(text.endsWith(`${lines[lines.length - 1]}\n`)).toBe(true)
    expect(ring.omitted.lines).toBeGreaterThan(0)
  })

  it('strips carriage returns and keeps the last rewrite of a line', () =>
  {
    const ring = createAttemptRing({ totalBytes: 100, headBytes: 50 })
    ring.push('size=1\rsize=2\r')
    ring.push('done\r\n')
    expect(ring.text()).toBe('size=2\ndone\n')
  })

  it('keeps the end of a line longer than the whole tail', () =>
  {
    const ring = createAttemptRing({ totalBytes: 30, headBytes: 10 })
    ring.push('head')
    ring.push('first tail')
    ring.push(`${'a'.repeat(40)}END`)
    const text = ring.text()
    expect(text.startsWith('head\n[')).toBe(true)
    expect(text.endsWith('aaaaEND\n')).toBe(true)
    expect(ring.bytes).toBeLessThanOrEqual(30)
    expect(ring.omitted.lines).toBe(1)
  })

  it('drops everything after the head when the head takes the whole ring', () =>
  {
    const ring = createAttemptRing({ totalBytes: 12, headBytes: 12 })
    ring.push('abcde')
    ring.push('fghij')
    ring.push('later')
    expect(ring.text()).toBe('abcde\nfghij\n[1 line (6 bytes) of output omitted]\n')
  })

  it('cuts the attempt tail at a line boundary', () =>
  {
    const ring = createAttemptRing()
    for (const line of numbered(5000, 33))
    {
      ring.push(line)
    }
    const tail = ring.tail(ERROR_TAIL_BYTES)
    expect(bytes(tail)).toBeLessThanOrEqual(ERROR_TAIL_BYTES)
    expect(tail.startsWith('L')).toBe(true)
    expect(ring.text().endsWith(tail)).toBe(true)
  })

  it('scopes the process tail to the latest process without its command line', () =>
  {
    const ring = createAttemptRing({ totalBytes: 1000, headBytes: 100 })
    ring.beginProcess('ffmpeg -i a.flac -f null -')
    ring.push('measure output')
    ring.beginProcess('ffmpeg -i a.flac out.m4a')
    ring.push('Error opening output file')
    expect(ring.tail(ERROR_TAIL_BYTES, 'process')).toBe('Error opening output file\n')
    expect(ring.tail(ERROR_TAIL_BYTES)).toBe(
      `${COMMAND_PREFIX}ffmpeg -i a.flac -f null -\nmeasure output\n${COMMAND_PREFIX}ffmpeg -i a.flac out.m4a\nError opening output file\n`
    )
  })

  it('marks an omission inside the latest process', () =>
  {
    const ring = createAttemptRing({ totalBytes: 60, headBytes: 20 })
    ring.beginProcess('ffmpeg')
    const lines = numbered(10, 9)
    for (const line of lines)
    {
      ring.push(line)
    }
    const tail = ring.tail(1000, 'process')
    expect(tail.split('\n')[0]).toBe(lines[0])
    expect(tail).toContain('of output omitted]')
  })

  it('leaves the marker out of a process that started after the omission', () =>
  {
    const ring = createAttemptRing({ totalBytes: 60, headBytes: 20 })
    for (const line of numbered(10, 9))
    {
      ring.push(line)
    }
    ring.beginProcess('ffmpeg')
    ring.push('fresh')
    expect(ring.tail(1000, 'process')).toBe('fresh\n')
  })

  it('clears what it holds', () =>
  {
    const ring = createAttemptRing({ totalBytes: 40, headBytes: 10 })
    for (const line of numbered(10, 9))
    {
      ring.push(line)
    }
    ring.clear()
    expect(ring.text()).toBe('')
    expect(ring.bytes).toBe(0)
    expect(ring.omitted).toEqual({ lines: 0, bytes: 0 })
    ring.push('again')
    expect(ring.text()).toBe('again\n')
  })

  it('compacts its tail storage over a long attempt', () =>
  {
    const ring = createAttemptRing({ totalBytes: 200, headBytes: 20 })
    const lines = numbered(5000, 9)
    for (const line of lines)
    {
      ring.push(line)
    }
    const out = ring.text().split('\n')
    expect(out[out.length - 2]).toBe(lines[lines.length - 1])
    expect(ring.bytes).toBeLessThanOrEqual(200)
  })
})

function harness(files?: LogFileWriter, limits: { ringBytes?: number; ringHeadBytes?: number } = {})
{
  const lines: JobLogLine[] = []
  const written: Array<{ file: string; text: string }> = []
  const writer: LogFileWriter = files ?? {
    async writeFile(file: string, text: string): Promise<void>
    {
      written.push({ file, text })
    }
  }
  const root = createEngineLog({ sink: { write: (line) => lines.push(line) }, files: writer, logsDir: '/logs', platform: 'win32', ...limits })
  return { root, lines, written }
}

describe('attemptLogMode', () =>
{
  it.each([
    ['failed', 'full'],
    ['held', 'full'],
    ['interrupted', 'full'],
    ['outside-tolerance', 'full'],
    ['verified', 'tail'],
    ['canceled', 'tail'],
    ['skipped', 'tail']
  ] as Array<[AttemptOutcome, 'full' | 'tail']>)('keeps a %s attempt log as %s', (outcome, mode) =>
  {
    expect(attemptLogMode(outcome)).toBe(mode)
  })
})

describe('createEngineLog', () =>
{
  it('writes root lines without context', () =>
  {
    const { root, lines } = harness()
    root.info('Engine ready')
    root.debug('detail')
    expect(lines).toEqual([
      { level: 'info', kind: 'message', message: 'Engine ready' },
      { level: 'debug', kind: 'message', message: 'detail' }
    ])
    expect(root.context).toEqual({})
    expect(root.ring).toBeNull()
  })

  it('stamps job, run, attempt, and stage on every line of a child', () =>
  {
    const { root, lines } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 2 })
    const encode = attempt.child({ stage: 'encode' })
    attempt.event('Dispatched')
    encode.warn('Slow disk')
    encode.error('Encoder stopped')
    expect(lines).toEqual([
      { level: 'info', kind: 'event', message: 'Dispatched', jobId: JOB, runId: RUN, attempt: 2 },
      { level: 'warn', kind: 'message', message: 'Slow disk', jobId: JOB, runId: RUN, attempt: 2, stage: 'encode' },
      { level: 'error', kind: 'message', message: 'Encoder stopped', jobId: JOB, runId: RUN, attempt: 2, stage: 'encode' }
    ])
  })

  it('keeps context a child does not override', () =>
  {
    const { root } = harness()
    const run = root.child({ runId: RUN })
    const job = run.child({ jobId: JOB, attempt: 1, stage: 'measure' })
    expect(job.child({ jobId: undefined, stage: 'verify' }).context).toEqual({ runId: RUN, jobId: JOB, attempt: 1, stage: 'verify' })
  })

  it('shares one ring across the stages of an attempt and starts a new one for the next attempt', () =>
  {
    const { root, lines } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    const measure = attempt.child({ stage: 'measure' })
    measure.ffmpeg('Input #0, flac')
    attempt.child({ stage: 'encode' }).ffmpeg('Output #0, ipod')
    expect(attempt.ring).not.toBeNull()
    expect(measure.ring).toBe(attempt.ring)
    expect(attempt.ring?.text()).toBe('Input #0, flac\nOutput #0, ipod\n')
    expect(lines).toEqual([])
    const retry = attempt.child({ attempt: 2 })
    expect(retry.ring).not.toBe(attempt.ring)
    expect(retry.ring?.text()).toBe('')
  })

  it('sends stderr outside an attempt to the global log at debug level', () =>
  {
    const { root, lines } = harness()
    root.child({ jobId: JOB }).ffmpeg('probe line')
    expect(lines).toEqual([{ level: 'debug', kind: 'stderr', message: 'probe line', jobId: JOB }])
    expect(root.child({ jobId: JOB }).errorTail()).toBe('')
  })

  it('logs each command quoted for display and starts its part of the attempt log', () =>
  {
    const { root, lines } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    attempt.cmd(['ffmpeg', '-i', 'D:\\My Music\\a.flac', '-f', 'null', '-'])
    attempt.ffmpeg('measure output')
    attempt.cmd(['ffmpeg', '-i', 'D:\\My Music\\a.flac', 'out.m4a'])
    attempt.ffmpeg('Error opening output file out.m4a.')
    expect(lines.map((line) => [line.kind, line.message])).toEqual([
      ['cmd', 'ffmpeg -i "D:\\My Music\\a.flac" -f null -'],
      ['cmd', 'ffmpeg -i "D:\\My Music\\a.flac" out.m4a']
    ])
    expect(attempt.errorTail()).toBe('Error opening output file out.m4a.\n')
    expect(attempt.ring?.text()).toContain(`${COMMAND_PREFIX}ffmpeg -i "D:\\My Music\\a.flac" -f null -\nmeasure output\n`)
  })

  it('logs a root command without an attempt log', () =>
  {
    const { root, lines } = harness()
    root.cmd(['ffmpeg', '-version'])
    expect(lines).toEqual([{ level: 'info', kind: 'cmd', message: 'ffmpeg -version' }])
  })

  it('writes the whole log of a failed attempt and logs its last 16 KiB once', async () =>
  {
    const { root, lines, written } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 3 })
    for (const line of numbered(2000, 30))
    {
      attempt.ffmpeg(line)
    }
    const full = attempt.ring?.text() ?? ''
    const result = await attempt.child({ stage: 'encode' }).finishAttempt('failed')
    expect(result.logFile).toBe(path.join('/logs', 'R-0031', 'MM-0142-a3.log'))
    expect(written).toEqual([{ file: result.logFile, text: full }])
    expect(bytes(result.stderrTail)).toBeLessThanOrEqual(DETAIL_TAIL_BYTES)
    expect(full.endsWith(result.stderrTail)).toBe(true)
    const stderr = lines.filter((line) => line.kind === 'stderr')
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toMatchObject({ level: 'error', jobId: JOB, runId: RUN, attempt: 3, stage: 'encode', details: result.stderrTail })
    expect(attempt.ring?.bytes).toBe(0)
    await attempt.finishAttempt('failed')
    expect(lines.filter((line) => line.kind === 'stderr')).toHaveLength(1)
    expect(written).toHaveLength(1)
  })

  it('trims a verified attempt log to the last 16 KiB without logging stderr', async () =>
  {
    const { root, lines, written } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    for (const line of numbered(2000, 30))
    {
      attempt.ffmpeg(line)
    }
    const result = await attempt.finishAttempt('verified')
    expect(written).toHaveLength(1)
    expect(written[0].text).toBe(result.stderrTail)
    expect(bytes(written[0].text)).toBeLessThanOrEqual(DETAIL_TAIL_BYTES)
    expect(lines).toEqual([])
  })

  it('stops keeping output once the attempt has finished', async () =>
  {
    const { root, lines } = harness()
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    await attempt.finishAttempt('canceled')
    attempt.ffmpeg('late line')
    attempt.cmd(['ffmpeg'])
    expect(attempt.ring?.text()).toBe('')
    expect(lines.map((line) => line.kind)).toEqual(['stderr', 'cmd'])
  })

  it('writes no file for an attempt without output or without a run', async () =>
  {
    const { root, written } = harness()
    expect(await root.child({ jobId: JOB, runId: RUN, attempt: 1 }).finishAttempt('failed')).toEqual({ logFile: null, stderrTail: '' })
    const loose = root.child({ jobId: JOB, attempt: 1 })
    loose.ffmpeg('output')
    expect(await loose.finishAttempt('held')).toEqual({ logFile: null, stderrTail: 'output\n' })
    expect(await root.finishAttempt('failed')).toEqual({ logFile: null, stderrTail: '' })
    expect(written).toEqual([])
  })

  it('warns and returns no file when the log cannot be written', async () =>
  {
    const writeFile = vi.fn(async () =>
    {
      throw new Error('ENOSPC: no space left on device')
    })
    const { root, lines } = harness({ writeFile })
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    attempt.ffmpeg('output')
    const result = await attempt.finishAttempt('interrupted')
    expect(result).toEqual({ logFile: null, stderrTail: 'output\n' })
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([
      {
        level: 'warn',
        kind: 'message',
        message: `Could not write the attempt log ${path.join('/logs', 'R-0031', 'MM-0142-a1.log')}: ENOSPC: no space left on device`,
        jobId: JOB,
        runId: RUN,
        attempt: 1
      }
    ])
  })

  it('reports a write failure that is not an Error', async () =>
  {
    const { root, lines } = harness({ writeFile: () => Promise.reject('busy') })
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    attempt.ffmpeg('output')
    await attempt.finishAttempt('failed')
    expect(lines[lines.length - 1].message.endsWith(': busy')).toBe(true)
  })

  it('bounds each attempt ring by the configured limits', () =>
  {
    const { root } = harness(undefined, { ringBytes: 64, ringHeadBytes: 16 })
    const attempt = root.child({ jobId: JOB, runId: RUN, attempt: 1 })
    for (const line of numbered(50, 9))
    {
      attempt.ffmpeg(line)
    }
    expect(attempt.ring?.bytes).toBeLessThanOrEqual(64)
    expect(attempt.ring?.omitted.lines).toBeGreaterThan(0)
  })
})
