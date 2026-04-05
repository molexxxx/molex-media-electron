import { ChildProcess, spawn } from 'child_process'
import { logger } from '../logger'

const activeProcesses = new Set<ChildProcess>()

export interface RunCommandResult {
  stdout: string
  stderr: string
  code: number
  killed: boolean
}

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

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM')
    } catch {}
  }
  activeProcesses.clear()
}

export function getActiveProcessCount(): number {
  return activeProcesses.size
}
