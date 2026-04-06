/**
 * @module main/ffmpeg/runner
 * @description Low-level FFmpeg process runner with progress parsing.
 *
 * Wraps `child_process.spawn` to execute FFmpeg commands with real-time
 * stderr progress parsing (time, speed, bitrate). Supports cancellation
 * via signal, collects stderr for error diagnostics, and resolves with
 * the combined output on completion.
 */

import { ChildProcess, spawn } from 'child_process'
import { logger } from '../logger'

const activeProcesses = new Set<ChildProcess>()

export interface RunCommandResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

/**
 * Spawns an FFmpeg process with the given arguments and streams stderr
 * line-by-line to an optional callback for real-time progress parsing.
 *
 * The returned object exposes both the `promise` (resolves on exit)
 * and the raw `process` handle for external cancellation.
 *
 * @param ffmpegPath - Absolute path to the FFmpeg binary.
 * @param args       - CLI arguments passed to FFmpeg.
 * @param onStderr   - Optional callback invoked for each non-empty stderr line.
 * @returns An object with `promise` and `process`.
 */
export function runCommand(
  ffmpegPath: string,
  args: string[],
  onStderr?: (line: string) => void
): { promise: Promise<RunCommandResult>; process: ChildProcess } {
  logger.ffmpeg('CMD', `${ffmpegPath} ${args.join(' ')}`)

  const proc = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  activeProcesses.add(proc)

  const promise = new Promise<RunCommandResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })

    proc.stderr?.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      if (onStderr) {
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (line.trim()) onStderr(line.trim())
        }
      }
    })

    proc.on('close', (code) => {
      activeProcesses.delete(proc)
      resolve({ stdout, stderr, code: code ?? 1, killed: proc.killed })
    })

    proc.on('error', (err) => {
      activeProcesses.delete(proc)
      reject(err)
    })
  })

  return { promise, process: proc }
}

/**
 * Parses an FFmpeg stderr progress line and extracts the current
 * timestamp, encoding speed, and output size.
 *
 * @param line - A single stderr line from FFmpeg.
 * @returns Parsed progress values, or `null` if the line is not a progress update.
 */
export function parseProgress(line: string): { time: number; speed: string; size: string } | null {
  const timeMatch = line.match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
  const speedMatch = line.match(/speed=\s*([\d.]+)x/)
  const sizeMatch = line.match(/size=\s*(\S+)/)

  if (!timeMatch) return null

  const hours = parseInt(timeMatch[1], 10)
  const minutes = parseInt(timeMatch[2], 10)
  const seconds = parseInt(timeMatch[3], 10)
  const ms = parseInt(timeMatch[4], 10)

  return {
    time: hours * 3600 + minutes * 60 + seconds + ms / 100,
    speed: speedMatch ? `${speedMatch[1]}x` : '',
    size: sizeMatch ? sizeMatch[1] : ''
  }
}

/** Sends SIGTERM to every active FFmpeg child process and clears the tracking set. */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM')
    } catch {}
  }
  activeProcesses.clear()
}

/** Returns the number of FFmpeg child processes currently running. */
export function getActiveProcessCount(): number {
  return activeProcesses.size
}
