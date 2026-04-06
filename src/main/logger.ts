/**
 * @module main/logger
 * @description File-based and in-memory logger for the main process.
 *
 * Writes timestamped, level-tagged entries to a rotating log file in the
 * app’s log directory and maintains an in-memory buffer (capped at 5 000
 * entries) that can be replayed to newly connected renderer windows.
 * Supports info, warn, error, success, debug, and ffmpeg log levels.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getLogDir } from './config'

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  details?: string
}

const LOG_COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  debug: '\x1b[90m',
  ffmpeg: '\x1b[35m'
}

class Logger {
  private logBuffer: LogEntry[] = []
  private logFile: string = ''
  private ffmpegLogFile: string = ''
  private maxBufferSize = 10000
  private listeners: Set<(entry: LogEntry) => void> = new Set()

  /**
   * Initialises log file paths based on today's date.
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

  private emit(entry: LogEntry): void {
    for (const cb of this.listeners) {
      try {
        cb(entry)
      } catch {}
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').replace('Z', '')
  }

  private log(level: LogLevel, message: string, details?: string): void {
    const timestamp = this.formatTimestamp()
    const entry: LogEntry = { timestamp, level, message, details }

    this.logBuffer.push(entry)
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize / 2)
    }

    const color = LOG_COLORS[level] || ''
    console.log(`${color}[${timestamp}] [${level.toUpperCase()}] ${message}\x1b[0m`)

    if (this.logFile) {
      const line = `${timestamp} | ${level.toUpperCase().padEnd(7)} | ${message}${details ? '\n  ' + details : ''}\n`
      fs.appendFile(this.logFile, line, () => {})
    }

    this.emit(entry)
  }

  /** Logs an informational message. */
  info(msg: string, details?: string): void {
    this.log('info', msg, details)
  }
  /** Logs a warning message. */
  warn(msg: string, details?: string): void {
    this.log('warn', msg, details)
  }
  /** Logs an error message. */
  error(msg: string, details?: string): void {
    this.log('error', msg, details)
  }
  /** Logs a success message. */
  success(msg: string, details?: string): void {
    this.log('success', msg, details)
  }
  /** Logs a debug message. */
  debug(msg: string, details?: string): void {
    this.log('debug', msg, details)
  }

  /**
   * Logs an FFmpeg-specific message to the dedicated FFmpeg log file
   * and the in-memory buffer (but not the main log file).
   * @param tag - Short identifier for the FFmpeg operation.
   * @param msg - The raw FFmpeg output line.
   */
  ffmpeg(tag: string, msg: string): void {
    const timestamp = this.formatTimestamp()
    const entry: LogEntry = { timestamp, level: 'ffmpeg', message: `[${tag}] ${msg}` }
    this.logBuffer.push(entry)
    this.emit(entry)

    if (this.ffmpegLogFile) {
      fs.appendFile(this.ffmpegLogFile, `${timestamp} | ${tag} | ${msg}\n`, () => {})
    }
  }

  /** Returns a shallow copy of the in-memory log buffer. */
  getBuffer(): LogEntry[] {
    return [...this.logBuffer]
  }

  /** Clears the in-memory log buffer. */
  clearBuffer(): void {
    this.logBuffer = []
  }
}

export const logger = new Logger()
export type { LogEntry }
