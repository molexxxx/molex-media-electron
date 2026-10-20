/**
 * Job logging: child loggers that stamp every line with its job, run, attempt, and stage; each attempt's stderr ring
 * with its pinned head; tails cut at a line boundary; attempt log files; and commands quoted for display.
 */

import * as path from 'path'
import type { JobId, RunId } from '../../shared/jobs/ids'
import type { StageId } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { JobLogger } from './deps'

/** Bytes of stderr one attempt keeps in memory. */
export const RING_BYTES = 256 * 1024

/** The first bytes of an attempt's stderr, kept whatever follows, because inputs and stream mapping print first. */
export const RING_HEAD_BYTES = 32 * 1024

/** The tail a `JobError` carries: memory, events, `state.json`, and history hold this much per failed job. */
export const ERROR_TAIL_BYTES = 2 * 1024

/** The tail `jobs:get` returns, a verified attempt's log keeps, and a failure writes to the global log once. */
export const DETAIL_TAIL_BYTES = 16 * 1024

/**
 * The last `maxBytes` bytes of `text` in UTF-8, starting at a line boundary. A window that holds no line break keeps
 * the end of its one line, cut at a character boundary.
 */
export function tailAtLineBoundary(text: string, maxBytes: number): string
{
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes)
  {
    return text
  }
  if (maxBytes <= 0)
  {
    return ''
  }
  let start = bytes.length - maxBytes
  const newline = bytes.indexOf(0x0a, start - 1)
  if (newline !== -1 && newline + 1 < bytes.length)
  {
    start = newline + 1
  }
  else
  {
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
    {
      start += 1
    }
  }
  return bytes.subarray(start).toString('utf8')
}

const WINDOWS_PLAIN = /^[^\s"&|<>^()!]+$/
const POSIX_PLAIN = /^[\p{L}\p{N}\p{M}_@%+=:,./-]+$/u

function quoteWindows(arg: string): string
{
  if (WINDOWS_PLAIN.test(arg))
  {
    return arg
  }
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg)
  {
    if (ch === '\\')
    {
      backslashes += 1
      continue
    }
    quoted += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) : '\\'.repeat(backslashes)
    quoted += ch
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

function quotePosix(arg: string): string
{
  if (POSIX_PLAIN.test(arg))
  {
    return arg
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * A command line for people to read and copy: each argument quoted so the platform's parser reads back the same argv
 * (the Windows argument rules on win32, a POSIX shell elsewhere). Execution never goes through a shell.
 */
export function quoteForDisplay(argv: readonly string[], platform: Platform): string
{
  const quote = platform === 'win32' ? quoteWindows : quotePosix
  return argv.map(quote).join(' ')
}

/** What a log line carries: a message, a child process's command line, its stderr, or a lifecycle event. */
export type LogKind = 'message' | 'cmd' | 'stderr' | 'event'

/** The levels job loggers write. */
export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** What a child logger stamps on every line it writes. */
export interface LogContext
{
  jobId?: JobId
  runId?: RunId
  attempt?: number
  stage?: StageId
}

/** One line for the global log, with the context of the logger that wrote it. */
export interface JobLogLine extends LogContext
{
  level: JobLogLevel
  kind: LogKind
  message: string
  details?: string
}

/** The global log as job loggers see it; the wiring adapts the app logger to it. */
export interface LogSink
{
  write(line: JobLogLine): void
}

/** Writes attempt log files. */
export interface LogFileWriter
{
  /** Writes `text` to `filePath`, creating its folder, and rejects when it cannot. */
  writeFile(filePath: string, text: string): Promise<void>
}

/** The prefix of a log file line: the catalog number for a job's lines, the run id for a run's, nothing otherwise. */
export function logPrefix(context: LogContext): string
{
  if (context.jobId)
  {
    return `[${context.jobId}]`
  }
  if (context.runId)
  {
    return `[${context.runId}]`
  }
  return ''
}

/** Where an attempt's log lives under the logs folder: `<RunId>/<JobId>-a<n>.log`. */
export function attemptLogPath(logsDir: string, runId: RunId, jobId: JobId, attempt: number): string
{
  return path.join(logsDir, runId, `${jobId}-a${attempt}.log`)
}

/** The line that stands in for the output dropped between the pinned head and the tail. */
export function omissionMarker(lines: number, bytes: number): string
{
  return `[${lines} ${lines === 1 ? 'line' : 'lines'} (${bytes} bytes) of output omitted]`
}

/** The prefix of a command line inside an attempt log. */
export const COMMAND_PREFIX = '> '

/** One attempt's stderr in bounded memory: the first bytes pinned, the latest bytes kept, the middle counted. */
export interface AttemptRing
{
  /** Bytes held by the head and the tail together, one newline per line included. */
  readonly bytes: number
  /** Lines and bytes dropped between the head and the tail. */
  readonly omitted: { lines: number; bytes: number }
  /** Adds output; text holding line breaks adds one line per break. */
  push(text: string): void
  /** Adds a child process's command line and starts that process's part of the log. */
  beginProcess(commandLine: string): void
  /** Everything held, one line per line, with the omission marker where output was dropped. */
  text(): string
  /** The last `maxBytes` of the attempt, or of its latest process without its command line, cut at a line boundary. */
  tail(maxBytes: number, scope?: 'attempt' | 'process'): string
  /** Drops everything held. */
  clear(): void
}

interface RingLine
{
  line: string
  size: number
  seq: number
}

function lineSize(line: string): number
{
  return Buffer.byteLength(line, 'utf8') + 1
}

function cleanLine(line: string): string
{
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const lastReturn = trimmed.lastIndexOf('\r')
  return lastReturn === -1 ? trimmed : trimmed.slice(lastReturn + 1)
}

/**
 * The ring an attempt writes its child processes' output to: `RING_BYTES` in all, of which the first `RING_HEAD_BYTES`
 * stay pinned and the rest keeps the latest lines. A single line longer than the tail keeps its end.
 */
export function createAttemptRing(limits: { totalBytes?: number; headBytes?: number } = {}): AttemptRing
{
  const totalBytes = Math.max(0, limits.totalBytes ?? RING_BYTES)
  const headLimit = Math.min(Math.max(0, limits.headBytes ?? RING_HEAD_BYTES), totalBytes)
  const tailLimit = totalBytes - headLimit
  let head: RingLine[] = []
  let headSize = 0
  let headOpen = true
  let tail: RingLine[] = []
  let tailStart = 0
  let tailSize = 0
  let omittedLines = 0
  let omittedBytes = 0
  let lastOmittedSeq = -1
  let nextSeq = 0
  let processSeq = 0

  const dropFront = (): void =>
  {
    const dropped = tail[tailStart]
    tailStart += 1
    tailSize -= dropped.size
    omittedLines += 1
    omittedBytes += dropped.size
    lastOmittedSeq = dropped.seq
    if (tailStart > 1024 && tailStart * 2 > tail.length)
    {
      tail = tail.slice(tailStart)
      tailStart = 0
    }
  }

  const pushLine = (raw: string): void =>
  {
    const line = cleanLine(raw)
    const size = lineSize(line)
    const seq = nextSeq
    nextSeq += 1
    if (headOpen && headSize + size <= headLimit)
    {
      head.push({ line, size, seq })
      headSize += size
      return
    }
    headOpen = false
    if (size <= tailLimit)
    {
      tail.push({ line, size, seq })
      tailSize += size
      while (tailSize > tailLimit)
      {
        dropFront()
      }
      return
    }
    while (tailStart < tail.length)
    {
      dropFront()
    }
    const kept = tailLimit > 1 ? tailAtLineBoundary(line, tailLimit - 1) : ''
    lastOmittedSeq = seq
    if (kept === '')
    {
      omittedLines += 1
      omittedBytes += size
      return
    }
    const keptSize = lineSize(kept)
    omittedBytes += size - keptSize
    tail.push({ line: kept, size: keptSize, seq })
    tailSize += keptSize
  }

  const render = (fromSeq: number): string =>
  {
    const parts: string[] = []
    for (const entry of head)
    {
      if (entry.seq >= fromSeq)
      {
        parts.push(entry.line)
      }
    }
    if (omittedBytes > 0 && lastOmittedSeq >= fromSeq)
    {
      parts.push(omissionMarker(omittedLines, omittedBytes))
    }
    for (let i = tailStart; i < tail.length; i += 1)
    {
      if (tail[i].seq >= fromSeq)
      {
        parts.push(tail[i].line)
      }
    }
    return parts.length > 0 ? `${parts.join('\n')}\n` : ''
  }

  const push = (text: string): void =>
  {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    for (const line of body.split('\n'))
    {
      pushLine(line)
    }
  }

  return {
    get bytes()
    {
      return headSize + tailSize
    },
    get omitted()
    {
      return { lines: omittedLines, bytes: omittedBytes }
    },
    push,
    beginProcess(commandLine: string): void
    {
      push(`${COMMAND_PREFIX}${commandLine}`)
      processSeq = nextSeq
    },
    text(): string
    {
      return render(0)
    },
    tail(maxBytes: number, scope: 'attempt' | 'process' = 'attempt'): string
    {
      return tailAtLineBoundary(render(scope === 'process' ? processSeq : 0), maxBytes)
    },
    clear(): void
    {
      head = []
      headSize = 0
      headOpen = true
      tail = []
      tailStart = 0
      tailSize = 0
      omittedLines = 0
      omittedBytes = 0
      lastOmittedSeq = -1
      processSeq = nextSeq
    }
  }
}

/** How an attempt ended, as its log file sees it. */
export type AttemptOutcome = 'verified' | 'outside-tolerance' | 'failed' | 'held' | 'interrupted' | 'canceled' | 'skipped'

/** Failed, held, interrupted, and outside-tolerance attempts keep their whole log; the others keep the last 16 KiB. */
export function attemptLogMode(outcome: AttemptOutcome): 'full' | 'tail'
{
  switch (outcome)
  {
    case 'failed':
    case 'held':
    case 'interrupted':
    case 'outside-tolerance':
      return 'full'
    default:
      return 'tail'
  }
}

/** What an attempt's log left behind when the attempt ended. */
export interface AttemptLogResult
{
  /** The attempt log file, or null when nothing was written. */
  logFile: string | null
  /** The last 16 KiB of the attempt's output, cut at a line boundary. */
  stderrTail: string
}

/** A job logger: it stamps its context on every line and keeps its attempt's output. */
export interface EngineLogger extends JobLogger
{
  readonly context: Readonly<LogContext>
  /** The attempt's output, shared by every logger of that attempt; null outside an attempt. */
  readonly ring: AttemptRing | null
  child(context: LogContext): EngineLogger
  /** A lifecycle line: dispatch, a stage change, measured values, the verdict, placement, the trash outcome. */
  event(message: string): void
  /** Logs a child process's command line, quoted for display, and starts its part of the attempt log. */
  cmd(argv: readonly string[]): void
  /** The last 2 KiB of the latest process's output, cut at a line boundary, for `JobError.stderrTail`. */
  errorTail(): string
  /**
   * Ends the attempt: writes `logs/<RunId>/<JobId>-a<n>.log` (whole or the last 16 KiB, by outcome), logs the last
   * 16 KiB once when it failed, and releases the attempt's memory. Later calls return the first call's result.
   */
  finishAttempt(outcome: AttemptOutcome): Promise<AttemptLogResult>
}

/** What `createEngineLog` writes to. */
export interface EngineLogOptions
{
  sink: LogSink
  files: LogFileWriter
  /** The folder that holds `<RunId>/<JobId>-a<n>.log`. */
  logsDir: string
  platform: Platform
  ringBytes?: number
  ringHeadBytes?: number
}

interface AttemptState
{
  ring: AttemptRing
  finished: Promise<AttemptLogResult> | null
}

function mergeContext(base: Readonly<LogContext>, next: LogContext): LogContext
{
  const merged: LogContext = { ...base }
  if (next.jobId !== undefined)
  {
    merged.jobId = next.jobId
  }
  if (next.runId !== undefined)
  {
    merged.runId = next.runId
  }
  if (next.attempt !== undefined)
  {
    merged.attempt = next.attempt
  }
  if (next.stage !== undefined)
  {
    merged.stage = next.stage
  }
  return merged
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function makeLogger(options: EngineLogOptions, context: Readonly<LogContext>, attempt: AttemptState | null): EngineLogger
{
  const write = (level: JobLogLevel, kind: LogKind, message: string, details?: string): void =>
  {
    const line: JobLogLine = { level, kind, message, ...context }
    if (details !== undefined)
    {
      line.details = details
    }
    options.sink.write(line)
  }

  const finish = async (state: AttemptState, outcome: AttemptOutcome): Promise<AttemptLogResult> =>
  {
    const full = state.ring.text()
    state.ring.clear()
    const stderrTail = tailAtLineBoundary(full, DETAIL_TAIL_BYTES)
    if (outcome === 'failed' && stderrTail !== '')
    {
      write('error', 'stderr', 'FFmpeg output, last 16 KiB', stderrTail)
    }
    const body = attemptLogMode(outcome) === 'full' ? full : stderrTail
    if (body === '' || context.jobId === undefined || context.runId === undefined || context.attempt === undefined)
    {
      return { logFile: null, stderrTail }
    }
    const logFile = attemptLogPath(options.logsDir, context.runId, context.jobId, context.attempt)
    try
    {
      await options.files.writeFile(logFile, body)
      return { logFile, stderrTail }
    }
    catch (err)
    {
      write('warn', 'message', `Could not write the attempt log ${logFile}: ${errorText(err)}`)
      return { logFile: null, stderrTail }
    }
  }

  return {
    context,
    ring: attempt ? attempt.ring : null,
    debug: (message: string) => write('debug', 'message', message),
    info: (message: string) => write('info', 'message', message),
    warn: (message: string) => write('warn', 'message', message),
    error: (message: string) => write('error', 'message', message),
    event: (message: string) => write('info', 'event', message),
    ffmpeg(line: string): void
    {
      if (attempt && !attempt.finished)
      {
        attempt.ring.push(line)
        return
      }
      write('debug', 'stderr', line)
    },
    cmd(argv: readonly string[]): void
    {
      const shown = quoteForDisplay(argv, options.platform)
      write('info', 'cmd', shown)
      if (attempt && !attempt.finished)
      {
        attempt.ring.beginProcess(shown)
      }
    },
    errorTail(): string
    {
      return attempt ? attempt.ring.tail(ERROR_TAIL_BYTES, 'process') : ''
    },
    finishAttempt(outcome: AttemptOutcome): Promise<AttemptLogResult>
    {
      if (!attempt)
      {
        return Promise.resolve({ logFile: null, stderrTail: '' })
      }
      if (!attempt.finished)
      {
        attempt.finished = finish(attempt, outcome)
      }
      return attempt.finished
    },
    child(next: LogContext): EngineLogger
    {
      const merged = mergeContext(context, next)
      const sameAttempt = merged.jobId === context.jobId && merged.runId === context.runId && merged.attempt === context.attempt
      let state: AttemptState | null = null
      if (sameAttempt)
      {
        state = attempt
      }
      else if (merged.attempt !== undefined)
      {
        state = { ring: createAttemptRing({ totalBytes: options.ringBytes, headBytes: options.ringHeadBytes }), finished: null }
      }
      return makeLogger(options, merged, state)
    }
  }
}

/**
 * The engine's root logger. `child({ jobId, runId, attempt })` returns a logger that stamps them on every line and
 * keeps that attempt's output in a ring; `child({ stage })` under it shares the ring. Progress is never logged.
 */
export function createEngineLog(options: EngineLogOptions): EngineLogger
{
  return makeLogger(options, {}, null)
}
