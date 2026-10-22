/**
 * The Logs view's model: level groups, sources read from the lines main and the job engine actually write, local
 * times, command lines, narrowing, the summary line, and the copied text.
 */
import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../../../src/renderer/src/stores/types'
import {
  clockTime,
  commandText,
  copiedText,
  emptyWords,
  firstLine,
  formatLogLines,
  fullStamp,
  hasMore,
  hiddenLineCount,
  isNarrowed,
  isRawText,
  levelGroup,
  LOG_SOURCES,
  LOG_WORDS,
  logSource,
  logTime,
  mergeLogEntries,
  NO_NARROWING,
  rowId,
  shownMessage,
  SOURCE_LABELS,
  SOURCE_MENU_LABELS,
  sourceCounts,
  sourcesButtonText,
  summaryLine,
  visibleLogEntries,
  type LogSource
} from '../../../src/renderer/src/components/logs/logModel'

const STAMP = '2026-10-20 09:30:05.042'

function entry(message: string, extra: Partial<LogEntry> = {}): LogEntry
{
  return { id: 1, timestamp: STAMP, level: 'info', message, ...extra }
}

function local(stamp: string): Date
{
  return new Date(`${stamp.replace(' ', 'T')}Z`)
}

function two(n: number): string
{
  return String(n).padStart(2, '0')
}

describe('levelGroup', () =>
{
  it('keeps errors and warnings and reads every other level as Info', () =>
  {
    expect(levelGroup({ level: 'error' })).toBe('error')
    expect(levelGroup({ level: 'warn' })).toBe('warning')
    for (const level of ['info', 'success', 'debug', 'ffmpeg'] as const)
    {
      expect(levelGroup({ level })).toBe('info')
    }
  })
})

describe('logSource', () =>
{
  const cases: Array<[string, Partial<LogEntry>, LogSource]> = [
    ['"C:\\ffmpeg\\bin\\ffmpeg.exe" -i in.flac out.flac', { kind: 'cmd', jobId: 'MM-0001' }, 'commands'],
    ['[CMD] C:\\ffmpeg\\bin\\ffmpeg.exe -hide_banner -encoders', { level: 'ffmpeg' }, 'commands'],
    ['> ffmpeg -hide_banner -i in.wav out.flac', { kind: 'message', jobId: 'MM-0001' }, 'commands'],
    ['> not a command from the app', {}, 'app'],
    ['[STDERR] Conversion failed!', { level: 'ffmpeg' }, 'output'],
    ['size=100kB', { level: 'ffmpeg', kind: 'stderr' }, 'output'],
    ['FFmpeg output, last 16 KiB', { level: 'error', kind: 'stderr', jobId: 'MM-0001' }, 'output'],
    ['Dispatched to worker 1', { kind: 'event', jobId: 'MM-0001' }, 'jobs'],
    ['Saved the queue snapshot through line 0', { kind: 'message' }, 'jobs'],
    ['Batch started', { runId: 'R-0031' }, 'jobs'],
    ['Job engine: loading and recovering the queue', {}, 'jobs'],
    ['The job engine could not start: busy', { level: 'error' }, 'jobs'],
    ['Job command start failed unexpectedly', { level: 'error' }, 'jobs'],
    ['[gpu] Detected nvenc support', {}, 'gpu'],
    ['[editor:cut] Export complete', {}, 'editor'],
    ['[createPreview] Transcoding AVI proxy for: a.avi', {}, 'editor'],
    ['[createAudioPreview] FFmpeg exit 1 for a.wav', { level: 'warn' }, 'editor'],
    ['Playback: remuxing aac', {}, 'player'],
    ['media:// token not found or expired', { level: 'warn' }, 'player'],
    ['[preview-server] Listening on http://127.0.0.1:4000', {}, 'player'],
    ['Checking for updates…', {}, 'updates'],
    ['Update available: v4.8.0', {}, 'updates'],
    ['App is up to date (v4.7.1)', {}, 'updates'],
    ['Could not install the update: locked', { level: 'error' }, 'updates'],
    ['The batch finished; installing the update', {}, 'updates'],
    ['yt-dlp resolve failed: 403', { level: 'error' }, 'online'],
    ['Exporting cookies from "chrome" to a.txt...', {}, 'online'],
    ['Resolving playlist: https://example.com/list', {}, 'online'],
    ['Playlist resolved: 12 entries', {}, 'online'],
    ['pickDirectAudioUrl: using top-level URL (protocol=https)', {}, 'online'],
    ['Using FFmpeg 9.0.2 (bundled) at C:\\ffmpeg.exe', { level: 'success' }, 'ffmpeg'],
    ['FFmpeg self-test soxr: passed in 38 ms', { level: 'debug' }, 'ffmpeg'],
    ['codesign verified ffmpeg', {}, 'ffmpeg'],
    ['Verified ffmpeg.zip: 120 bytes, SHA-256 abc', {}, 'ffmpeg'],
    ['molexMedia starting up...', {}, 'app'],
    ['Main window created', {}, 'app'],
    ['Uncaught exception: boom', { level: 'error' }, 'app']
  ]

  it.each(cases)('reads %s', (message, extra, source) =>
  {
    expect(logSource(entry(message, extra))).toBe(source)
  })

  it('names every source in the column and the menu', () =>
  {
    for (const source of LOG_SOURCES)
    {
      expect(SOURCE_LABELS[source]).toMatch(/^[A-Z]/)
      expect(SOURCE_MENU_LABELS[source]).toMatch(/^[A-Z]/)
    }
    expect(SOURCE_MENU_LABELS.commands).toBe('FFmpeg commands')
  })
})

describe('messages and commands', () =>
{
  it('drops a leading tag the Source column already says', () =>
  {
    expect(shownMessage(entry('[gpu] Detected nvenc support'))).toBe('Detected nvenc support')
    expect(shownMessage(entry('[preview-server] Stopped'))).toBe('Stopped')
    expect(shownMessage(entry('[editor:cut] Export complete'))).toBe('[editor:cut] Export complete')
  })

  it('reads a command from the engine kind or the runner tag', () =>
  {
    expect(commandText(entry('ffmpeg -i a', { kind: 'cmd' }))).toBe('ffmpeg -i a')
    expect(commandText(entry('[CMD] ffmpeg -i b', { level: 'ffmpeg' }))).toBe('ffmpeg -i b')
    expect(commandText(entry('[STDERR] oops', { level: 'ffmpeg' }))).toBeNull()
    expect(commandText(entry('[CMD] not ffmpeg level'))).toBeNull()
    expect(commandText(entry('> ffmpeg -i c', { kind: 'message' }))).toBe('ffmpeg -i c')
    expect(commandText(entry('> ffmpeg -i d', { jobId: 'MM-0001' }))).toBe('ffmpeg -i d')
    expect(commandText(entry('> plain'))).toBeNull()
    expect(shownMessage(entry('> ffmpeg -i c', { kind: 'message' }))).toBe('ffmpeg -i c')
  })

  it('counts what a row leaves out', () =>
  {
    const multi = entry('[STDERR] line one\nline two\nline three\n', { level: 'ffmpeg', details: 'stack 1\nstack 2' })
    expect(firstLine(multi)).toBe('line one')
    expect(hiddenLineCount(multi)).toBe(4)
    expect(hiddenLineCount(entry('one line'))).toBe(0)
    expect(hiddenLineCount(entry('one line', { details: '' }))).toBe(0)
  })

  it('sets commands and raw process output in mono, but not a failure that carries the output as details', () =>
  {
    expect(isRawText(entry('ffmpeg -i a', { kind: 'cmd' }))).toBe(true)
    expect(isRawText(entry('size=100kB', { level: 'ffmpeg', kind: 'stderr' }))).toBe(true)
    expect(isRawText(entry('FFmpeg output, last 16 KiB', { level: 'error', kind: 'stderr', details: 'Conversion failed!' }))).toBe(false)
    expect(isRawText(entry('Main window created'))).toBe(false)
  })

  it('knows when the details are worth opening', () =>
  {
    expect(hasMore(entry('short'))).toBe(false)
    expect(hasMore(entry('x'.repeat(161)))).toBe(true)
    expect(hasMore(entry('a\nb'))).toBe(true)
    expect(hasMore(entry('ffmpeg -i a', { kind: 'cmd' }))).toBe(true)
  })
})

describe('times', () =>
{
  it("reads main's UTC stamp and shows it on the local clock", () =>
  {
    const expected = local(STAMP)
    expect(logTime(entry('a'))?.getTime()).toBe(expected.getTime())
    expect(clockTime(entry('a'))).toBe(`${two(expected.getHours())}:${two(expected.getMinutes())}:${two(expected.getSeconds())}`)
    expect(fullStamp(entry('a'))).toBe(
      `${expected.getFullYear()}-${two(expected.getMonth() + 1)}-${two(expected.getDate())} ${clockTime(entry('a'))}.042`
    )
  })

  it('reads stamps without milliseconds, ISO stamps, and keeps what it cannot read', () =>
  {
    expect(logTime(entry('a', { timestamp: '2026-10-20 09:30:05' }))?.getTime()).toBe(local('2026-10-20 09:30:05').getTime())
    expect(logTime(entry('a', { timestamp: '2026-10-20T09:30:05.5Z' }))?.getUTCMilliseconds()).toBe(500)
    expect(logTime(entry('a', { timestamp: 'Tue, 20 Oct 2026 09:30:05 GMT' }))?.getUTCHours()).toBe(9)
    expect(logTime(entry('a', { timestamp: 'later' }))).toBeNull()
    expect(clockTime(entry('a', { timestamp: 'later' }))).toBe('later')
    expect(fullStamp(entry('a', { timestamp: 'later' }))).toBe('later')
  })
})

describe('rowId and mergeLogEntries', () =>
{
  it('keys a row by its id, or its place when main gave none', () =>
  {
    expect(rowId(entry('a', { id: 42 }), 3)).toBe('42')
    expect(rowId(entry('a', { id: undefined }), 3)).toBe('local-3')
  })

  it('copies the live list when nothing narrows it', () =>
  {
    const live = [entry('a')]
    const merged = mergeLogEntries(null, live, null)
    expect(merged).toEqual(live)
    expect(merged).not.toBe(live)
  })
})

describe('visibleLogEntries', () =>
{
  const lines = [
    entry('Encoding started', { id: 1, jobId: 'MM-0142' }),
    entry('Disk nearly full', { id: 2, level: 'warn' }),
    entry('[CMD] ffmpeg -i in.wav', { id: 3, level: 'ffmpeg' }),
    entry('Encode failed', { id: 4, level: 'error', details: 'Permission denied' }),
    entry('Using FFmpeg 9.0.2', { id: 5, level: 'success' })
  ]
  const ids = (list: LogEntry[]): Array<number | undefined> => list.map((line) => line.id)

  it('keeps every line without narrowing', () =>
  {
    expect(visibleLogEntries(lines, NO_NARROWING)).toHaveLength(5)
    expect(isNarrowed(NO_NARROWING)).toBe(false)
  })

  it('narrows by level group', () =>
  {
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, level: 'info' }))).toEqual([1, 3, 5])
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, level: 'warning' }))).toEqual([2])
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, level: 'error' }))).toEqual([4])
  })

  it('hides sources', () =>
  {
    const narrowing = { ...NO_NARROWING, hiddenSources: new Set<LogSource>(['commands', 'ffmpeg']) }
    expect(ids(visibleLogEntries(lines, narrowing))).toEqual([1, 2, 4])
    expect(isNarrowed(narrowing)).toBe(true)
  })

  it('searches the message, the details, and the job, ignoring case and outer spaces', () =>
  {
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, search: '  ENCODING ' }))).toEqual([1])
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, search: 'permission' }))).toEqual([4])
    expect(ids(visibleLogEntries(lines, { ...NO_NARROWING, search: 'mm-0142' }))).toEqual([1])
    expect(visibleLogEntries(lines, { ...NO_NARROWING, level: 'warning', search: 'encod' })).toEqual([])
    expect(isNarrowed({ ...NO_NARROWING, search: ' ' })).toBe(false)
  })
})

describe('sources menu words', () =>
{
  const lines = [entry('Main window created'), entry('[gpu] x'), entry('[gpu] y')]

  it('counts lines per source', () =>
  {
    const counts = sourceCounts(lines)
    expect(counts.get('app')).toBe(1)
    expect(counts.get('gpu')).toBe(2)
    expect(counts.has('jobs')).toBe(false)
  })

  it('reads "All sources" until a present source is hidden', () =>
  {
    expect(sourcesButtonText(['app', 'gpu'], new Set())).toBe(LOG_WORDS.allSources)
    expect(sourcesButtonText(['app', 'gpu'], new Set<LogSource>(['jobs']))).toBe(LOG_WORDS.allSources)
    expect(sourcesButtonText(['app', 'gpu', 'jobs'], new Set<LogSource>(['jobs']))).toBe('2 of 3 sources')
  })
})

describe('summaryLine and emptyWords', () =>
{
  const lines = [
    entry('a'),
    entry('ffmpeg -i x', { kind: 'cmd' }),
    entry('[CMD] ffmpeg -i y', { level: 'ffmpeg' }),
    entry('careful', { level: 'warn' }),
    entry('broke', { level: 'error' }),
    entry('broke again', { level: 'error' })
  ]

  it('states the lines, commands, warnings, and errors', () =>
  {
    expect(summaryLine(lines, 6, null)).toBe('6 lines, 2 FFmpeg commands, 1 warning, 2 errors')
    expect(summaryLine([entry('a')], 1, null)).toBe('1 line')
  })

  it('says how much shows while narrowed, and for which job or batch', () =>
  {
    expect(summaryLine(lines, 2, null)).toBe('2 of 6 lines shown')
    expect(summaryLine(lines, 6, { jobId: 'MM-0142' })).toContain('6 lines for MM-0142')
    expect(summaryLine(lines, 1, { runId: 'R-0031' })).toBe('1 of 6 lines for Batch 31 shown')
  })

  it('says when there is nothing yet', () =>
  {
    expect(summaryLine([], 0, null)).toBe('No lines yet')
    expect(summaryLine([], 0, { jobId: 'MM-0999' })).toBe('No lines for MM-0999 yet')
  })

  it('words the empty and the filtered-empty states', () =>
  {
    expect(emptyWords(0, null)).toEqual({ title: LOG_WORDS.emptyTitle, body: LOG_WORDS.emptyBody, narrowed: false })
    expect(emptyWords(0, { jobId: 'MM-0999' }).title).toBe('No lines for MM-0999 yet')
    expect(emptyWords(5, null)).toEqual({ title: LOG_WORDS.noMatchTitle, body: LOG_WORDS.noMatchBody, narrowed: true })
  })
})

describe('formatLogLines', () =>
{
  it('lines up the stamp, level, source, and job, then indents later lines and details', () =>
  {
    const text = formatLogLines([
      entry('[gpu] Detected nvenc support'),
      entry('Encode failed\nsecond line', { level: 'error', jobId: 'MM-0142', kind: 'event', details: 'trace 1\ntrace 2\n' })
    ])
    const stamp = fullStamp(entry('a'))
    expect(text.split('\n')).toEqual([
      `${stamp}  Info     Hardware encoding  Detected nvenc support`,
      `${stamp}  Error    Job engine         MM-0142  Encode failed`,
      '    second line',
      '    trace 1',
      '    trace 2'
    ])
  })

  it('confirms the count copied', () =>
  {
    expect(copiedText(1)).toBe('Copied 1 line.')
    expect(copiedText(12)).toBe('Copied 12 lines.')
  })
})
