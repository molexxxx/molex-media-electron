/**
 * @module main/logger
 * @description File-based and in-memory logger for the main process.
 *
 * Writes timestamped, level-tagged entries to a daily log file in the app's
 * log directory and keeps the newest 10,000 entries in memory, each with a
 * monotonic id, so renderer windows can hydrate with `afterId` and filter by
 * job or run. Child loggers stamp a job's catalog number, run, attempt, and
 * stage on every line they write.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogDir } from './config'
import type { StageId } from '../shared/jobs/types'

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'

/** What a line carries: a message, a child process's command line, its stderr, or a lifecycle event. */
export type LogKind = 'message' | 'cmd' | 'stderr' | 'event'

/** What a child logger stamps on every line it writes. */
export interface LogContext {
  jobId?: string
  runId?: string
  attempt?: number
  stage?: StageId
}

/** One line to record, with the context of the logger that wrote it. */
export interface LogLine extends LogContext {
  level: LogLevel
  message: string
  details?: string
  kind?: LogKind
}

interface LogEntry extends LogLine {
  /** Monotonic for the life of the process; a clear never reuses an id. */
  id: number
  timestamp: string
}

/** Which buffered entries to return; every field narrows the result. */
export interface LogQuery {
  /** Only entries with a greater id. */
  afterId?: number
  jobId?: string
  runId?: string
}

/** A logger bound to a job, run, or attempt. */
export interface ScopedLogger {
  readonly context: Readonly<LogContext>
  debug(message: string, details?: string): void
  info(message: string, details?: string): void
  warn(message: string, details?: string): void
  error(message: string, details?: string): void
  success(message: string, details?: string): void
  /** One line a child process wrote to stderr. */
  ffmpeg(line: string): void
  /** Records a line with this logger's context under the line's own. */
  write(line: LogLine): LogEntry
  child(context: LogContext): ScopedLogger
}

/** The in-memory buffer's size; every path that adds an entry trims to it. */
export const MAX_BUFFER_ENTRIES = 10_000

/** How long new entries collect before batch listeners receive them. */
export const BATCH_INTERVAL_MS = 100

const LOG_COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  debug: '\x1b[90m',
  ffmpeg: '\x1b[35m'
}

/** The catalog number for a job's lines, the run id for a run's, nothing otherwise. */
function contextPrefix(context: LogContext): string {
  if (context.jobId) return `[${context.jobId}] `
  if (context.runId) return `[${context.runId}] `
  return ''
}

function mergeContext(base: Readonly<LogContext>, next: LogContext): LogContext {
  const merged: LogContext = { ...base }
  if (next.jobId !== undefined) merged.jobId = next.jobId
  if (next.runId !== undefined) merged.runId = next.runId
  if (next.attempt !== undefined) merged.attempt = next.attempt
  if (next.stage !== undefined) merged.stage = next.stage
  return merged
}

/** The index of the first entry whose id is greater than `afterId`; ids ascend with the buffer. */
function firstAfter(entries: readonly LogEntry[], afterId: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (entries[mid].id <= afterId) low = mid + 1
    else high = mid
  }
  return low
}

class ContextLogger implements ScopedLogger {
  constructor(private readonly root: Logger, readonly context: Readonly<LogContext>) {}

  debug(message: string, details?: string): void {
    this.write({ level: 'debug', message, details })
  }

  info(message: string, details?: string): void {
    this.write({ level: 'info', message, details })
  }

  warn(message: string, details?: string): void {
    this.write({ level: 'warn', message, details })
  }

  error(message: string, details?: string): void {
    this.write({ level: 'error', message, details })
  }

  success(message: string, details?: string): void {
    this.write({ level: 'success', message, details })
  }

  ffmpeg(line: string): void {
    this.write({ level: 'ffmpeg', kind: 'stderr', message: line })
  }

  write(line: LogLine): LogEntry {
    return this.root.write({ ...line, ...mergeContext(this.context, line) })
  }

  child(context: LogContext): ScopedLogger {
    return new ContextLogger(this.root, mergeContext(this.context, context))
  }
}

class Logger {
  private logBuffer: LogEntry[] = []
  private logFile: string = ''
  private ffmpegLogFile: string = ''
  private nextId = 1
  private listeners: Set<(entry: LogEntry) => void> = new Set()
  private batchListeners: Set<(entries: LogEntry[]) => void> = new Set()
  private pending: LogEntry[] = []
  private batchTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Initializes log file paths based on today's date.
   * Must be called after the app's user-data directory is available.
   */
  init(): void {
    const logDir = getLogDir()
    const date = new Date().toISOString().split('T')[0]
    this.logFile = path.join(logDir, `molex-media-${date}.log`)
    this.ffmpegLogFile = path.join(logDir, `ffmpeg-debug-${date}.log`)
  }

  /**
   * Registers a callback that is invoked for every new log entry.
   * @param cb - Listener receiving each {@link LogEntry}.
   * @returns An unsubscribe function.
   */
  onLog(cb: (entry: LogEntry) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Registers a callback that receives new entries in batches, at most one batch every {@link BATCH_INTERVAL_MS}.
   * @returns An unsubscribe function.
   */
  onEntries(cb: (entries: LogEntry[]) => void): () => void {
    this.batchListeners.add(cb)
    return () => {
      this.batchListeners.delete(cb)
      if (this.batchListeners.size === 0) this.dropPending()
    }
  }

  /** Delivers the collected entries to batch listeners now. */
  flush(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    for (const cb of this.batchListeners) {
      try {
        cb(batch)
      } catch {}
    }
  }

  private dropPending(): void {
    if (this.batchTimer !== null) clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.pending = []
  }

  private emit(entry: LogEntry): void {
    for (const cb of this.listeners) {
      try {
        cb(entry)
      } catch {}
    }
    if (this.batchListeners.size === 0) return
    this.pending.push(entry)
    while (this.pending.length > MAX_BUFFER_ENTRIES) this.pending.shift()
    if (this.batchTimer === null) {
      this.batchTimer = setTimeout(() => this.flush(), BATCH_INTERVAL_MS)
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').replace('Z', '')
  }

  /** Stamps an id and a timestamp, buffers the entry, trims the buffer, and notifies listeners. */
  private record(line: LogLine): LogEntry {
    const entry: LogEntry = { id: this.nextId++, timestamp: this.formatTimestamp(), level: line.level, message: line.message }
    if (line.details !== undefined) entry.details = line.details
    if (line.kind !== undefined) entry.kind = line.kind
    if (line.jobId !== undefined) entry.jobId = line.jobId
    if (line.runId !== undefined) entry.runId = line.runId
    if (line.attempt !== undefined) entry.attempt = line.attempt
    if (line.stage !== undefined) entry.stage = line.stage

    this.logBuffer.push(entry)
    while (this.logBuffer.length > MAX_BUFFER_ENTRIES) this.logBuffer.shift()

    this.emit(entry)
    return entry
  }

  /**
   * Records one line: the console, the daily log file (prefixed with the catalog number or run id), the buffer, and
   * listeners. FFmpeg-level lines go to the FFmpeg debug file instead of the daily log.
   */
  write(line: LogLine): LogEntry {
    const entry = this.record(line)
    const prefix = contextPrefix(entry)
    const level = entry.level.toUpperCase()
    console.log(`${LOG_COLORS[entry.level]}[${entry.timestamp}] [${level}] ${prefix}${entry.message}\x1b[0m`)

    if (entry.level === 'ffmpeg') {
      if (this.ffmpegLogFile) {
        fs.appendFile(this.ffmpegLogFile, `${entry.timestamp} | ${prefix}${entry.message}\n`, () => {})
      }
    } else if (this.logFile) {
      const details = entry.details ? '\n  ' + entry.details : ''
      fs.appendFile(this.logFile, `${entry.timestamp} | ${level.padEnd(7)} | ${prefix}${entry.message}${details}\n`, () => {})
    }
    return entry
  }

  /** Logs an informational message. */
  info(msg: string, details?: string): void {
    this.write({ level: 'info', message: msg, details })
  }
  /** Logs a warning message. */
  warn(msg: string, details?: string): void {
    this.write({ level: 'warn', message: msg, details })
  }
  /** Logs an error message. */
  error(msg: string, details?: string): void {
    this.write({ level: 'error', message: msg, details })
  }
  /** Logs a success message. */
  success(msg: string, details?: string): void {
    this.write({ level: 'success', message: msg, details })
  }
  /** Logs a debug message. */
  debug(msg: string, details?: string): void {
    this.write({ level: 'debug', message: msg, details })
  }

  /**
   * Logs an FFmpeg-specific message to the dedicated FFmpeg log file
   * and the in-memory buffer (but not the main log file).
   * @param tag - Short identifier for the FFmpeg operation.
   * @param msg - The raw FFmpeg output line.
   */
  ffmpeg(tag: string, msg: string): void {
    const entry = this.record({ level: 'ffmpeg', message: `[${tag}] ${msg}` })
    if (this.ffmpegLogFile) {
      fs.appendFile(this.ffmpegLogFile, `${entry.timestamp} | ${tag} | ${msg}\n`, () => {})
    }
  }

  /** A logger that stamps `context` on every line it writes. */
  child(context: LogContext): ScopedLogger {
    return new ContextLogger(this, mergeContext({}, context))
  }

  /** Returns the buffered entries that match `query`, oldest first, in a new array. */
  getBuffer(query: LogQuery = {}): LogEntry[] {
    const { afterId, jobId, runId } = query
    const start = afterId === undefined ? 0 : firstAfter(this.logBuffer, afterId)
    if (jobId === undefined && runId === undefined) return this.logBuffer.slice(start)
    const matches: LogEntry[] = []
    for (let i = start; i < this.logBuffer.length; i++) {
      const entry = this.logBuffer[i]
      if (jobId !== undefined && entry.jobId !== jobId) continue
      if (runId !== undefined && entry.runId !== runId) continue
      matches.push(entry)
    }
    return matches
  }

  /** Clears the in-memory log buffer and any batch not yet delivered; ids keep counting up. */
  clearBuffer(): void {
    this.logBuffer = []
    this.dropPending()
  }
}

export const logger = new Logger()
export type { Logger, LogEntry }

/** The process events {@link installCrashHandlers} listens to. */
export type CrashTarget = Pick<NodeJS.Process, 'on' | 'off'>

function describeFailure(value: unknown): { message: string; details?: string } {
  if (value instanceof Error) return { message: value.message || value.name, details: value.stack }
  try {
    return { message: String(value) }
  } catch {
    return { message: `a value of type ${typeof value}` }
  }
}

/**
 * Logs uncaught exceptions and unhandled rejections through the logger. Listening for `uncaughtException` also
 * stops Electron's blocking error dialog.
 * @returns A function that removes both handlers.
 */
export function installCrashHandlers(target: CrashTarget = process, log: Pick<Logger, 'error'> = logger): () => void {
  const onException = (error: Error): void => {
    const { message, details } = describeFailure(error)
    log.error(`Uncaught exception: ${message}`, details)
  }
  const onRejection = (reason: unknown): void => {
    const { message, details } = describeFailure(reason)
    log.error(`Unhandled promise rejection: ${message}`, details)
  }
  target.on('uncaughtException', onException)
  target.on('unhandledRejection', onRejection)
  return () => {
    target.off('uncaughtException', onException)
    target.off('unhandledRejection', onRejection)
  }
}
