/**
 * Runs one FFmpeg process for a job pass: a fixed flag prefix, progress from the `-progress` blocks on stdout,
 * stderr delivered as normalized lines with a bounded tail, signed exit codes with names, and a stop contract
 * driven by an AbortSignal. It imports no configuration, logging, Electron, or file system module, so the job
 * engine and the real-FFmpeg test suite use it unchanged.
 */
import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { TimerHandle, Timers } from '../timers'

/** One `-progress` block. */
export interface FfmpegProgress
{
  /** `out_time_us` in seconds; null for N/A and for the negative placeholder some builds print before any output. */
  outTimeSec: number | null
  /** Encoding speed as a multiple of real time; null for N/A and 0x. */
  speed: number | null
  /** `total_size`: bytes written so far; null for N/A. */
  totalSize: number | null
  /** `progress=end`: the run's last block. */
  end: boolean
}

/** How a run stops when its signal aborts. */
export type StopMode = 'kill' | 'graceful'

export interface ExecOptions
{
  /** Stops the run. An abort before the process reports spawn acts once it does, so a failed spawn is never signaled. */
  signal: AbortSignal
  /**
   * `kill` adds -nostdin and terminates the process on abort (SIGTERM, then SIGKILL after 3 s if it is still
   * running); its output is discarded. `graceful` keeps stdin piped, writes q on abort so FFmpeg finalizes its
   * output, and kills it after `gracefulTimeoutMs`.
   */
  stop: StopMode
  /** `graceful` only: milliseconds before a stop that q has not finished is forced (default 5000). */
  gracefulTimeoutMs?: number
  /** The media span this run processes; reported progress times never exceed it. */
  durationSec?: number
  /** Called once the process is running, with its pid. */
  onSpawn?(pid: number): void
  onProgress?(p: FfmpegProgress): void
  /** Every stderr line, without its CR or LF. */
  onStderrLine?(line: string): void
}

export interface ExecResult
{
  /** The signed exit code; null when the process ended by a signal. */
  code: number | null
  exitName: string | null
  signal: string | null
  /** The signal aborted during the run; classify by the caller's intent, never by the code. */
  aborted: boolean
  /** How exec stopped the process; an exit 0 with anything but `none` is never a completed run. */
  stopped: 'none' | 'killed' | 'graceful'
  /**
   * Stderr had the existing-output refusal of -n or an "Error opening output file" line. FFmpeg 9 exits 0 after
   * refusing an existing output, so the caller fails the run whatever the code.
   */
  outputRefused: boolean
  /** The last 2 KiB of stderr, cut at a line boundary. */
  stderrTail: string
  ms: number
}

export interface Exec
{
  /**
   * Resolves for every exit, signal, and abort. Rejects only when the process could not be spawned, or with the
   * error a callback threw (the process is killed first).
   */
  run(args: readonly string[], o: ExecOptions): Promise<ExecResult>
}

const STDERR_TAIL_BYTES = 2048
const KILL_FALLBACK_MS = 3000
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000
const MAX_LINE_CHARS = 65536
const MAX_BLOCK_LINES = 512

const REFUSED_OUTPUT =
  /^(?:(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\.\d{3} )?(?:\[[^\]]*\] )*(?:File '.*' already exists\. Exiting\.|Error opening output file)/

const ERRNO_NAMES: ReadonlyArray<readonly [number, string]> =
[
  [1, 'EPERM'], [2, 'ENOENT'], [3, 'ESRCH'], [4, 'EINTR'], [5, 'EIO'], [6, 'ENXIO'], [7, 'E2BIG'], [8, 'ENOEXEC'],
  [9, 'EBADF'], [10, 'ECHILD'], [11, 'EAGAIN'], [12, 'ENOMEM'], [13, 'EACCES'], [14, 'EFAULT'], [16, 'EBUSY'],
  [17, 'EEXIST'], [18, 'EXDEV'], [19, 'ENODEV'], [20, 'ENOTDIR'], [21, 'EISDIR'], [22, 'EINVAL'], [23, 'ENFILE'],
  [24, 'EMFILE'], [25, 'ENOTTY'], [27, 'EFBIG'], [28, 'ENOSPC'], [29, 'ESPIPE'], [30, 'EROFS'], [31, 'EMLINK'],
  [32, 'EPIPE'], [33, 'EDOM'], [34, 'ERANGE'], [36, 'EDEADLK'], [38, 'ENAMETOOLONG'], [39, 'ENOLCK'], [40, 'ENOSYS'],
  [41, 'ENOTEMPTY'], [42, 'EILSEQ']
]

function errTag(a: number | string, b: string, c: string, d: string): number
{
  const byte = (x: number | string): number => (typeof x === 'number' ? x : x.charCodeAt(0))
  return -(byte(a) + byte(b) * 0x100 + byte(c) * 0x10000 + byte(d) * 0x1000000)
}

const TAG_NAMES: ReadonlyArray<readonly [number, string]> =
[
  [errTag(0xf8, 'B', 'S', 'F'), 'BSF_NOT_FOUND'],
  [errTag('B', 'U', 'G', '!'), 'BUG'],
  [errTag('B', 'U', 'F', 'S'), 'BUFFER_TOO_SMALL'],
  [errTag(0xf8, 'D', 'E', 'C'), 'DECODER_NOT_FOUND'],
  [errTag(0xf8, 'D', 'E', 'M'), 'DEMUXER_NOT_FOUND'],
  [errTag(0xf8, 'E', 'N', 'C'), 'ENCODER_NOT_FOUND'],
  [errTag('E', 'O', 'F', ' '), 'EOF'],
  [errTag('E', 'X', 'I', 'T'), 'EXIT'],
  [errTag('E', 'X', 'T', ' '), 'EXTERNAL'],
  [errTag(0xf8, 'F', 'I', 'L'), 'FILTER_NOT_FOUND'],
  [errTag('I', 'N', 'D', 'A'), 'INVALIDDATA'],
  [errTag(0xf8, 'M', 'U', 'X'), 'MUXER_NOT_FOUND'],
  [errTag(0xf8, 'O', 'P', 'T'), 'OPTION_NOT_FOUND'],
  [errTag('P', 'A', 'W', 'E'), 'PATCHWELCOME'],
  [errTag(0xf8, 'P', 'R', 'O'), 'PROTOCOL_NOT_FOUND'],
  [errTag(0xf8, 'S', 'T', 'R'), 'STREAM_NOT_FOUND'],
  [errTag('B', 'U', 'G', ' '), 'BUG2'],
  [errTag('U', 'N', 'K', 'N'), 'UNKNOWN'],
  [-0x2bb2afa8, 'EXPERIMENTAL'],
  [-0x636e6701, 'INPUT_CHANGED'],
  [-0x636e6702, 'OUTPUT_CHANGED'],
  [errTag(0xf8, '4', '0', '0'), 'HTTP_BAD_REQUEST'],
  [errTag(0xf8, '4', '0', '1'), 'HTTP_UNAUTHORIZED'],
  [errTag(0xf8, '4', '0', '3'), 'HTTP_FORBIDDEN'],
  [errTag(0xf8, '4', '0', '4'), 'HTTP_NOT_FOUND'],
  [errTag(0xf8, '4', '2', '9'), 'HTTP_TOO_MANY_REQUESTS'],
  [errTag(0xf8, '4', 'X', 'X'), 'HTTP_OTHER_4XX'],
  [errTag(0xf8, '5', 'X', 'X'), 'HTTP_SERVER_ERROR']
]

const EXIT_NAMES: ReadonlyMap<number, string> = new Map(
  [...ERRNO_NAMES.map(([errno, name]) => [-errno, name] as const), ...TAG_NAMES]
)

/** Converts CRLF and lone CR line breaks to LF. */
export function normalizeLines(text: string): string
{
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The signed exit code. FFmpeg exits with a negative AVERROR on Windows, which Node reports as an unsigned 32-bit
 * value (4294967274 is -22).
 */
export function signedExitCode(raw: number | null): number | null
{
  if (raw === null)
  {
    return null
  }
  return raw > 0x7fffffff ? raw - 2 ** 32 : raw
}

/**
 * The name of a negative exit code: an errno value (-22 is EINVAL; numbering of the Windows C runtime, the only
 * platform that reports a full negative code) or an FFmpeg error tag (-1129203192 is ENCODER_NOT_FOUND). Null for
 * success, for positive codes (POSIX keeps only the low 8 bits), and for unknown values.
 */
export function exitName(code: number | null): string | null
{
  return code === null ? null : (EXIT_NAMES.get(code) ?? null)
}

function readCount(value: string | undefined): number | null
{
  if (value === undefined || !/^-?\d+$/.test(value))
  {
    return null
  }
  const n = Number(value)
  return n >= 0 ? n : null
}

function readSpeed(value: string | undefined): number | null
{
  const match = value === undefined ? null : /^(\S+)x$/.exec(value)
  if (!match)
  {
    return null
  }
  const n = Number(match[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Reads one `-progress` block: `out_time_us`, `speed`, `total_size`, and `progress`. Null when the text has no
 * `progress=` line, since every complete block ends with one.
 */
export function parseProgressBlock(block: string): FfmpegProgress | null
{
  const values = new Map<string, string>()
  for (const line of normalizeLines(block).split('\n'))
  {
    const eq = line.indexOf('=')
    if (eq > 0)
    {
      values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
    }
  }
  const progress = values.get('progress')
  if (progress === undefined)
  {
    return null
  }
  const outTimeUs = readCount(values.get('out_time_us'))
  return {
    outTimeSec: outTimeUs === null ? null : outTimeUs / 1e6,
    speed: readSpeed(values.get('speed')),
    totalSize: readCount(values.get('total_size')),
    end: progress === 'end'
  }
}

/** The full argument list exec passes to FFmpeg: its fixed prefix, then `args`. */
export function execArgv(args: readonly string[], stop: StopMode): string[]
{
  const quiet = stop === 'kill' ? ['-hide_banner', '-nostdin'] : ['-hide_banner']
  return [...quiet, '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5', ...args]
}

interface LineSplitter
{
  push(text: string): void
  end(): void
}

/**
 * A CR ends its line at once; an LF that starts the next chunk completes that CRLF and adds nothing. A line that
 * grows past MAX_LINE_CHARS is delivered in pieces, and a line break right after a piece ends it without adding
 * an empty line.
 */
function splitLines(onLine: (line: string) => void): LineSplitter
{
  let carry = ''
  let afterCr = false
  let broken = false
  return {
    push(text)
    {
      if (text === '')
      {
        return
      }
      const body = afterCr && text.startsWith('\n') ? text.slice(1) : text
      afterCr = text.endsWith('\r')
      const lines = normalizeLines(carry + body).split('\n')
      carry = lines.pop() as string
      for (const line of lines)
      {
        if (line !== '' || !broken)
        {
          onLine(line)
        }
        broken = false
      }
      if (carry.length > MAX_LINE_CHARS)
      {
        onLine(carry)
        carry = ''
        broken = true
      }
    },
    end()
    {
      if (carry !== '')
      {
        onLine(carry)
        carry = ''
      }
    }
  }
}

function lastBytes(line: string, max: number): string
{
  const bytes = Buffer.from(line, 'utf8')
  let start = bytes.length - max
  while ((bytes[start] & 0xc0) === 0x80)
  {
    start++
  }
  return bytes.subarray(start).toString('utf8')
}

interface Tail
{
  push(line: string): void
  text(): string
}

function createTail(maxBytes: number): Tail
{
  const lines: string[] = []
  const sizes: number[] = []
  let total = 0
  return {
    push(line)
    {
      const size = Buffer.byteLength(line, 'utf8') + 1
      lines.push(line)
      sizes.push(size)
      total += size
      while (lines.length > 1 && total - 1 > maxBytes)
      {
        lines.shift()
        total -= sizes.shift() as number
      }
    },
    text()
    {
      return total - 1 > maxBytes ? lastBytes(lines[0], maxBytes) : lines.join('\n')
    }
  }
}

function runProcess(
  ffmpegPath: string,
  args: readonly string[],
  o: ExecOptions,
  timers: Timers,
  spawnProcess: typeof spawn
): Promise<ExecResult>
{
  const started = timers.now()
  if (o.signal.aborted)
  {
    return Promise.resolve({
      code: null, exitName: null, signal: null, aborted: true, stopped: 'none', outputRefused: false, stderrTail: '', ms: 0
    })
  }
  return new Promise<ExecResult>((resolve, reject) =>
  {
    const child = spawnProcess(ffmpegPath, execArgv(args, o.stop), {
      windowsHide: true,
      stdio: [o.stop === 'graceful' ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const ceiling = o.durationSec !== undefined && o.durationSec > 0 ? o.durationSec : Infinity
    const tail = createTail(STDERR_TAIL_BYTES)
    const stdoutText = new StringDecoder('utf8')
    const stderrText = new StringDecoder('utf8')
    const block: string[] = []
    const timerHandles: TimerHandle[] = []
    let spawned = false
    let exited = false
    let settled = false
    let killing = false
    let stopped: ExecResult['stopped'] = 'none'
    let refused = false
    let callbackFailed = false
    let callbackError: unknown

    const later = (fn: () => void, ms: number): void =>
    {
      timerHandles.push(timers.setTimeout(fn, ms))
    }

    const terminate = (): void =>
    {
      if (killing || exited)
      {
        return
      }
      killing = true
      stopped = 'killed'
      child.kill('SIGTERM')
      later(() => child.kill('SIGKILL'), KILL_FALLBACK_MS)
    }

    const guard = (fn: () => void): void =>
    {
      if (callbackFailed)
      {
        return
      }
      try
      {
        fn()
      }
      catch (err)
      {
        callbackFailed = true
        callbackError = err
        terminate()
      }
    }

    const onAbort = (): void =>
    {
      if (!spawned || exited || stopped !== 'none')
      {
        return
      }
      if (o.stop === 'kill')
      {
        terminate()
        return
      }
      stopped = 'graceful'
      if (child.stdin?.writable)
      {
        child.stdin.write('q')
        later(() =>
        {
          if (!exited)
          {
            stopped = 'killed'
            child.kill('SIGKILL')
          }
        }, o.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS)
      }
      else
      {
        stopped = 'killed'
        child.kill('SIGKILL')
      }
    }

    const finish = (): void =>
    {
      settled = true
      o.signal.removeEventListener('abort', onAbort)
      for (const handle of timerHandles)
      {
        timers.clearTimeout(handle)
      }
    }

    const stdoutLines = splitLines((line) =>
    {
      block.push(line)
      if (line.startsWith('progress='))
      {
        const progress = parseProgressBlock(block.join('\n')) as FfmpegProgress
        block.length = 0
        const outTimeSec = progress.outTimeSec === null ? null : Math.min(progress.outTimeSec, ceiling)
        guard(() => o.onProgress?.({ ...progress, outTimeSec }))
      }
      else if (block.length > MAX_BLOCK_LINES)
      {
        block.shift()
      }
    })

    const stderrLines = splitLines((line) =>
    {
      tail.push(line)
      refused = refused || REFUSED_OUTPUT.test(line)
      guard(() => o.onStderrLine?.(line))
    })

    child.on('spawn', () =>
    {
      spawned = true
      guard(() => o.onSpawn?.(child.pid as number))
      if (o.signal.aborted)
      {
        onAbort()
      }
    })

    child.on('error', (err) =>
    {
      if (spawned || settled)
      {
        return
      }
      finish()
      reject(err)
    })

    child.on('exit', () =>
    {
      exited = true
    })

    child.on('close', (rawCode: number | null, signalName: NodeJS.Signals | null) =>
    {
      if (settled)
      {
        return
      }
      stdoutLines.push(stdoutText.end())
      stdoutLines.end()
      stderrLines.push(stderrText.end())
      stderrLines.end()
      finish()
      if (callbackFailed)
      {
        reject(callbackError)
        return
      }
      const code = signedExitCode(rawCode)
      resolve({
        code,
        exitName: exitName(code),
        signal: signalName,
        aborted: o.signal.aborted,
        stopped,
        outputRefused: refused,
        stderrTail: tail.text(),
        ms: timers.now() - started
      })
    })

    child.stdin?.on('error', () => undefined)
    child.stdout?.on('data', (chunk: Buffer | string) => stdoutLines.push(stdoutText.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => stderrLines.push(stderrText.write(chunk)))

    o.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * An `Exec` bound to one FFmpeg binary. Every wait (the kill fallback and the graceful timeout) runs on the
 * injected timers; `spawn` is injectable for tests.
 */
export function createExec(ffmpegPath: string, deps: { timers: Timers; spawn?: typeof spawn }): Exec
{
  const spawnProcess = deps.spawn ?? spawn
  return {
    run: (args, o) => runProcess(ffmpegPath, args, o, deps.timers, spawnProcess)
  }
}
