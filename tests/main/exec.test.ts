/**
 * The FFmpeg exec wrapper. The parsers run on -progress output and stderr recorded from the 2022 build and the
 * 9.0.2 build (tests/main/fixtures/ffmpeg/exec, written by scripts/capture-ffmpeg-fixtures.mjs), each fixture as
 * captured and with its line endings flipped. Process control runs on a scripted fake spawn and the manual timers,
 * so stops, the kill fallback, and the graceful timeout are checked without real processes or real waits.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createExec, execArgv, exitName, normalizeLines, parseProgressBlock, signedExitCode } from '../../src/main/ffmpeg/exec'
import type { ExecOptions, ExecResult, FfmpegProgress } from '../../src/main/ffmpeg/exec'
import { createManualTimers } from './helpers/manual-timers'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const FIXTURES = path.join(HERE, 'fixtures', 'ffmpeg', 'exec')
const BUILDS = ['2022-10-13', '9.0.2'] as const
const PROGRESS_RUNS = ['progress-null', 'progress-file', 'progress-video'] as const
const LONG = 'a'.repeat(70000)

type Build = typeof BUILDS[number]

interface RunRecord
{
  name: string
  tool: string
  argv: string[]
  code: number | null
  signal: string | null
  stdout: string | null
  stderr: string | null
}

function runRecord(build: Build, name: string): RunRecord
{
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, build, 'runs.json'), 'utf8')) as { runs: RunRecord[] }
  const found = manifest.runs.find((run) => run.name === name)
  if (!found)
  {
    throw new Error(`No recorded run ${name} for ${build}`)
  }
  return found
}

function recorded(build: Build, name: string, stream: 'stdout' | 'stderr'): Buffer
{
  const file = runRecord(build, name)[stream]
  return file === null ? Buffer.alloc(0) : fs.readFileSync(path.join(FIXTURES, build, file))
}

function flipLineEndings(text: string): string
{
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n')
}

const VARIANTS: ReadonlyArray<readonly [string, (text: string) => string]> =
[
  ['as captured', (text) => text],
  ['with flipped line endings', flipLineEndings]
]

function blocksOf(stdout: string): string[]
{
  return stdout.split(/(?<=^progress=\w+\r?\n)/m).filter((block) => block.length > 0)
}

function rawValues(block: string): Map<string, string>
{
  const values = new Map<string, string>()
  for (const line of block.split(/\r?\n/))
  {
    const eq = line.indexOf('=')
    if (eq > 0)
    {
      values.set(line.slice(0, eq), line.slice(eq + 1).trim())
    }
  }
  return values
}

function expectedProgress(block: string): FfmpegProgress
{
  const raw = rawValues(block)
  const us = raw.get('out_time_us') as string
  const speed = raw.get('speed') as string
  const size = raw.get('total_size') as string
  const multiple = Number(speed.slice(0, -1))
  return {
    outTimeSec: us === 'N/A' || us.startsWith('-') ? null : Number(us) / 1e6,
    speed: speed === 'N/A' || multiple === 0 ? null : multiple,
    totalSize: size === 'N/A' ? null : Number(size),
    end: raw.get('progress') === 'end'
  }
}

function linesOf(text: string): string[]
{
  const lines = normalizeLines(text).split('\n')
  if (lines[lines.length - 1] === '')
  {
    lines.pop()
  }
  return lines
}

function expectedTail(lines: string[]): string
{
  let start = lines.length
  while (start > 0 && Buffer.byteLength(lines.slice(start - 1).join('\n'), 'utf8') <= 2048)
  {
    start--
  }
  return lines.slice(start).join('\n')
}

function chunks(bytes: Buffer, size: number): Buffer[]
{
  const parts: Buffer[] = []
  for (let i = 0; i < bytes.length; i += size)
  {
    parts.push(bytes.subarray(i, i + size))
  }
  return parts
}

class FakeStdin extends EventEmitter
{
  writable = true
  readonly written: string[] = []

  write(chunk: string): boolean
  {
    this.written.push(chunk)
    return true
  }
}

function killEinval(): Error
{
  return Object.assign(new Error('kill EINVAL'), { code: 'EINVAL', syscall: 'kill' })
}

/** Like Node on Windows, kill throws EINVAL until the process has started. */
class FakeChild extends EventEmitter
{
  readonly pid = 4321
  readonly stdin: FakeStdin | null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kills: string[] = []
  private started = false

  constructor(pipedStdin: boolean)
  {
    super()
    this.stdin = pipedStdin ? new FakeStdin() : null
  }

  kill(signal = 'SIGTERM'): boolean
  {
    if (!this.started)
    {
      throw killEinval()
    }
    this.kills.push(signal)
    return true
  }

  start(): this
  {
    this.started = true
    this.emit('spawn')
    return this
  }

  out(chunk: string | Buffer): void
  {
    this.stdout.emit('data', chunk)
  }

  err(chunk: string | Buffer): void
  {
    this.stderr.emit('data', chunk)
  }

  exit(code: number | null, signal: string | null = null): void
  {
    this.emit('exit', code, signal)
  }

  close(code: number | null, signal: string | null = null): void
  {
    this.emit('close', code, signal)
  }

  end(code: number | null, signal: string | null = null): void
  {
    this.exit(code, signal)
    this.close(code, signal)
  }
}

interface SpawnCall
{
  file: string
  args: string[]
  options: { windowsHide: boolean; stdio: string[] }
  child: FakeChild
}

function harness(start = 0): {
  timers: ReturnType<typeof createManualTimers>
  calls: SpawnCall[]
  exec: ReturnType<typeof createExec>
  child: () => FakeChild
}
{
  const timers = createManualTimers(start)
  const calls: SpawnCall[] = []
  const spawn = vi.fn((file: string, args: string[], options: SpawnCall['options']) =>
  {
    const child = new FakeChild(options.stdio[0] === 'pipe')
    calls.push({ file, args, options, child })
    return child
  })
  const exec = createExec('ffmpeg-bin', { timers, spawn: spawn as unknown as typeof import('child_process').spawn })
  return { timers, calls, exec, child: () => calls[calls.length - 1].child }
}

function withSignal(over: Partial<ExecOptions> = {}): ExecOptions & { controller: AbortController }
{
  const controller = new AbortController()
  return { signal: controller.signal, stop: 'kill', ...over, controller }
}

function settledFlag(promise: Promise<unknown>): () => boolean
{
  let settled = false
  promise.then(() => (settled = true), () => (settled = true))
  return () => settled
}

describe('normalizeLines', () =>
{
  it('turns CRLF and lone CR into LF', () =>
  {
    expect(normalizeLines('a\r\nb\rc\nd\r\n\r\n')).toBe('a\nb\nc\nd\n\n')
    expect(normalizeLines('')).toBe('')
  })
})

describe('parseProgressBlock on recorded -progress output', () =>
{
  const cases = BUILDS.flatMap((build) => PROGRESS_RUNS.flatMap((run) => VARIANTS.map(([variant, transform]) => [build, run, variant, transform] as const)))

  it.each(cases)('%s %s %s: every block reads out_time_us, speed, total_size, and progress', (build, run, _variant, transform) =>
  {
    const blocks = blocksOf(transform(recorded(build, run, 'stdout').toString('utf8')))
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks)
    {
      expect(parseProgressBlock(block)).toEqual(expectedProgress(block))
    }
    expect(blocks.map((block) => parseProgressBlock(block)?.end)).toEqual([...Array(blocks.length - 1).fill(false), true])
  })

  it('the recorded blocks hold every case the reader handles', () =>
  {
    const raw = (build: Build): Array<Map<string, string>> =>
      PROGRESS_RUNS.flatMap((run) => blocksOf(recorded(build, run, 'stdout').toString('utf8')).map(rawValues))
    for (const build of BUILDS)
    {
      const blocks = raw(build)
      expect(blocks.some((b) => b.get('speed') === 'N/A'), `${build} speed=N/A`).toBe(true)
      expect(blocks.some((b) => /^\d+$/.test(b.get('total_size') as string) && Number(b.get('total_size')) > 0), `${build} total_size`).toBe(true)
      expect(blocks.some((b) => b.get('total_size') === 'N/A'), `${build} total_size=N/A`).toBe(true)
      expect(blocks.some((b) => b.get('progress') === 'end'), `${build} progress=end`).toBe(true)
    }
    expect(raw('2022-10-13').some((b) => b.get('speed') === '0x'), '2022 speed=0x').toBe(true)
    expect(raw('2022-10-13').some((b) => (b.get('out_time_us') as string).startsWith('-')), '2022 negative out_time_us').toBe(true)
    expect(raw('9.0.2').some((b) => b.get('out_time_us') === 'N/A'), '9.0.2 out_time_us=N/A').toBe(true)
  })

  it('reads the 0x block, the placeholder time, and the end block of the 2022 build exactly', () =>
  {
    const [first, last] = blocksOf(recorded('2022-10-13', 'progress-null', 'stdout').toString('utf8'))
    expect(parseProgressBlock(first)).toEqual({ outTimeSec: 0, speed: null, totalSize: 0, end: false })
    expect(parseProgressBlock(last)).toMatchObject({ totalSize: null, end: true })
    expect(parseProgressBlock(last)?.outTimeSec).toBeCloseTo(2, 1)
    const placeholder = blocksOf(recorded('2022-10-13', 'progress-file', 'stdout').toString('utf8'))[0]
    expect(placeholder).toContain('out_time_us=-9223372036854775807')
    expect(parseProgressBlock(placeholder)).toEqual({ outTimeSec: null, speed: null, totalSize: 0, end: false })
  })

  it('reads N/A times and sizes of the 9.0.2 build as null', () =>
  {
    const first = blocksOf(recorded('9.0.2', 'progress-video', 'stdout').toString('utf8'))[0]
    expect(first).toContain('out_time_us=N/A')
    expect(parseProgressBlock(first)).toEqual({ outTimeSec: null, speed: null, totalSize: 0, end: false })
    const end = blocksOf(recorded('9.0.2', 'progress-null', 'stdout').toString('utf8')).at(-1) as string
    expect(parseProgressBlock(end)).toMatchObject({ outTimeSec: 2, totalSize: null, end: true })
  })

  it('reads padded, fractional, and exponent speeds', () =>
  {
    const block = (speed: string): string => `out_time_us=1000\ntotal_size=10\nspeed=${speed}\nprogress=continue\n`
    expect(parseProgressBlock(block(' 745x'))?.speed).toBe(745)
    expect(parseProgressBlock(block('0.618x'))?.speed).toBe(0.618)
    expect(parseProgressBlock(block('1.04e+03x'))?.speed).toBe(1040)
    expect(parseProgressBlock(block('   0x'))?.speed).toBeNull()
    expect(parseProgressBlock(block('N/A'))?.speed).toBeNull()
    expect(parseProgressBlock(block('fastx'))?.speed).toBeNull()
    expect(parseProgressBlock(block('-1x'))?.speed).toBeNull()
    expect(parseProgressBlock(block(''))?.speed).toBeNull()
  })

  it('returns null without a progress line and tolerates missing or malformed keys', () =>
  {
    expect(parseProgressBlock('')).toBeNull()
    expect(parseProgressBlock('out_time_us=1000\nspeed=1x\n')).toBeNull()
    expect(parseProgressBlock('=junk\nnoise\nprogress=continue')).toEqual({ outTimeSec: null, speed: null, totalSize: null, end: false })
    expect(parseProgressBlock('out_time_us=12.5\ntotal_size=-1\nprogress=end')).toEqual({ outTimeSec: null, speed: null, totalSize: null, end: true })
    expect(parseProgressBlock('out_time_us=1\r\nout_time_us=2500000\r\nprogress=continue\r\n')?.outTimeSec).toBe(2.5)
  })
})

describe('signedExitCode and exitName', () =>
{
  it('converts the unsigned codes Node reports for negative exits', () =>
  {
    expect(signedExitCode(4294967274)).toBe(-22)
    expect(signedExitCode(4294967294)).toBe(-2)
    expect(signedExitCode(4294967256)).toBe(-40)
    expect(signedExitCode(1)).toBe(1)
    expect(signedExitCode(0)).toBe(0)
    expect(signedExitCode(null)).toBeNull()
    expect(signedExitCode(0x7fffffff)).toBe(0x7fffffff)
    expect(signedExitCode(-4058)).toBe(-4058)
  })

  it('names errno values and FFmpeg error tags', () =>
  {
    expect(exitName(-22)).toBe('EINVAL')
    expect(exitName(-2)).toBe('ENOENT')
    expect(exitName(-40)).toBe('ENOSYS')
    expect(exitName(-12)).toBe('ENOMEM')
    expect(exitName(-13)).toBe('EACCES')
    expect(exitName(-28)).toBe('ENOSPC')
    expect(exitName(-1129203192)).toBe('ENCODER_NOT_FOUND')
    expect(exitName(-1094995529)).toBe('INVALIDDATA')
    expect(exitName(-541478725)).toBe('EOF')
    expect(exitName(-733130664)).toBe('EXPERIMENTAL')
    expect(exitName(-1128613112)).toBe('DECODER_NOT_FOUND')
  })

  it('leaves success, positive codes, unknown values, and null unnamed', () =>
  {
    for (const code of [0, 1, 234, 255, -9999, -4058, null])
    {
      expect(exitName(code), String(code)).toBeNull()
    }
  })

  it.each([
    ['exit-aac-in-ac3', 0, null, -22, 'EINVAL'],
    ['exit-missing-input', 1, null, -2, 'ENOENT'],
    ['exit-no-outputs', 0, null, -40, 'ENOSYS'],
    ['exit-unknown-encoder', 1, null, -1129203192, 'ENCODER_NOT_FOUND']
  ] as const)('the recorded %s exits are signed and named on both builds', (name, code2022, name2022, code902, name902) =>
  {
    const old = signedExitCode(runRecord('2022-10-13', name).code)
    const pinned = signedExitCode(runRecord('9.0.2', name).code)
    expect([old, exitName(old)]).toEqual([code2022, name2022])
    expect([pinned, exitName(pinned)]).toEqual([code902, name902])
  })
})

describe('execArgv', () =>
{
  it('puts -nostdin in the prefix only for stop kill', () =>
  {
    expect(execArgv(['-i', 'IN/a.wav'], 'kill')).toEqual(['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5', '-i', 'IN/a.wav'])
    expect(execArgv(['-i', 'IN/a.wav'], 'graceful')).toEqual(['-hide_banner', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5', '-i', 'IN/a.wav'])
  })

  it('matches the prefix the fixtures were recorded with', () =>
  {
    const scenarios = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8')) as { prefix: string[] }
    expect(scenarios.prefix).toEqual(execArgv([], 'kill'))
    for (const build of BUILDS)
    {
      expect(runRecord(build, 'progress-null').argv.slice(0, scenarios.prefix.length)).toEqual(scenarios.prefix)
    }
  })
})

describe('createExec with a scripted spawn', () =>
{
  it('spawns the binary with the prefix, a hidden window, and stdin ignored under stop kill', async () =>
  {
    const h = harness()
    const run = h.exec.run(['-i', 'IN/a.wav', '-f', 'null', '-'], withSignal())
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].file).toBe('ffmpeg-bin')
    expect(h.calls[0].args).toEqual(execArgv(['-i', 'IN/a.wav', '-f', 'null', '-'], 'kill'))
    expect(h.calls[0].args.filter((arg) => arg === '-nostdin')).toHaveLength(1)
    expect(h.calls[0].options).toEqual({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    h.child().start().end(0)
    await expect(run).resolves.toMatchObject({ code: 0, aborted: false, stopped: 'none' })
  })

  it('keeps stdin piped and leaves out -nostdin under stop graceful', async () =>
  {
    const h = harness()
    const run = h.exec.run(['-i', 'IN/a.wav'], withSignal({ stop: 'graceful' }))
    expect(h.calls[0].args).not.toContain('-nostdin')
    expect(h.calls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    h.child().start().end(0)
    await run
  })

  it('reports the pid once the process is running', async () =>
  {
    const h = harness()
    const onSpawn = vi.fn()
    const run = h.exec.run([], withSignal({ onSpawn }))
    expect(onSpawn).not.toHaveBeenCalled()
    h.child().start()
    expect(onSpawn).toHaveBeenCalledWith(4321)
    h.child().end(0)
    await run
  })

  it.each(BUILDS.flatMap((build) => PROGRESS_RUNS.map((run) => [build, run] as const)))(
    'replays the %s %s run: progress per block, stderr per line, the tail, and the code',
    async (build, name) =>
    {
      const h = harness()
      const stdout = recorded(build, name, 'stdout')
      const stderr = recorded(build, name, 'stderr')
      const progress: FfmpegProgress[] = []
      const lines: string[] = []
      const run = h.exec.run([], withSignal({ onProgress: (p) => progress.push(p), onStderrLine: (line) => lines.push(line) }))
      const child = h.child().start()
      const out = chunks(stdout, 7)
      const err = chunks(stderr, 11)
      for (let i = 0; i < Math.max(out.length, err.length); i++)
      {
        if (i < out.length)
        {
          child.out(out[i])
        }
        if (i < err.length)
        {
          child.err(err[i])
        }
      }
      child.end(runRecord(build, name).code)
      const result = await run

      expect(progress).toEqual(blocksOf(stdout.toString('utf8')).map((block) => parseProgressBlock(block)))
      expect(progress.at(-1)?.end).toBe(true)
      expect(lines).toEqual(linesOf(stderr.toString('utf8')))
      expect(lines.some((line) => line.includes('\r'))).toBe(false)
      expect(result).toMatchObject({ code: 0, exitName: null, signal: null, aborted: false, stopped: 'none', outputRefused: false })
      expect(result.stderrTail).toBe(expectedTail(lines))
    }
  )

  it('never reports a time past durationSec, and ignores a duration of 0', async () =>
  {
    const stdout = recorded('9.0.2', 'progress-file', 'stdout')
    const times = async (durationSec: number | undefined): Promise<Array<number | null>> =>
    {
      const h = harness()
      const seen: Array<number | null> = []
      const run = h.exec.run([], withSignal({ durationSec, onProgress: (p) => seen.push(p.outTimeSec) }))
      h.child().start().out(stdout)
      h.child().end(0)
      await run
      return seen
    }
    expect((await times(undefined)).at(-1)).toBe(1.6)
    expect((await times(0)).at(-1)).toBe(1.6)
    const clamped = await times(1.5)
    expect(clamped.at(-1)).toBe(1.5)
    expect(clamped.every((t) => t === null || t <= 1.5)).toBe(true)
  })

  it('keeps reading progress after a long run of noise on stdout', async () =>
  {
    const h = harness()
    const progress: FfmpegProgress[] = []
    const run = h.exec.run([], withSignal({ onProgress: (p) => progress.push(p) }))
    h.child().start().out(`${'noise\n'.repeat(600)}out_time_us=500000\nspeed=2x\ntotal_size=64\nprogress=end\n`)
    h.child().end(0)
    await run
    expect(progress).toEqual([{ outTimeSec: 0.5, speed: 2, totalSize: 64, end: true }])
  })

  it('splits CRLF stderr into normalized lines, even when CR and LF arrive in different chunks', async () =>
  {
    const h = harness()
    const lines: string[] = []
    const run = h.exec.run([], withSignal({ onStderrLine: (line) => lines.push(line) }))
    const child = h.child().start()
    child.err('Stream mapping:\r')
    child.err('\n  Stream #0:0 -> #0:0\r\n\r\n')
    child.err('frame=1\rframe=2\n')
    child.err('[info] Summary:\r')
    child.err('\r\nlast line without a break')
    child.end(0)
    await run
    expect(lines).toEqual(['Stream mapping:', '  Stream #0:0 -> #0:0', '', 'frame=1', 'frame=2', '[info] Summary:', '', 'last line without a break'])
  })

  it('decodes UTF-8 text split inside a character', async () =>
  {
    const h = harness()
    const stderr = recorded('9.0.2', 'stderr-utf8', 'stderr')
    expect(stderr.toString('utf8')).toContain('IN/tone ü.wav')
    const lines: string[] = []
    const run = h.exec.run([], withSignal({ onStderrLine: (line) => lines.push(line) }))
    const child = h.child().start()
    for (const byte of chunks(stderr, 1))
    {
      child.err(byte)
    }
    child.end(0)
    await run
    expect(lines).toEqual(linesOf(stderr.toString('utf8')))
    expect(lines.some((line) => line.includes("from 'IN/tone ü.wav'"))).toBe(true)
  })

  it.each([
    ['a piece, then the rest of its line', [LONG, 'b\n'], ['a x 70000', 'b']],
    ['a long line whose CR ends a chunk, then its LF', [`${LONG}\r`, '\nnext\r\n'], ['a x 70000', 'next']],
    ['a piece, then a CRLF', [LONG, '\r\n', 'next\n'], ['a x 70000', 'next']],
    ['a piece, then CR and LF in separate chunks', [LONG, '\r', '\nnext\n'], ['a x 70000', 'next']],
    ['a piece, then its break and an empty line', [LONG, '\n\nnext\n'], ['a x 70000', '', 'next']],
    ['two pieces', [LONG, LONG, '\n'], ['a x 70000', 'a x 70000']],
    ['a line grown in small chunks', [...Array<string>(70).fill('a'.repeat(1000)), '\n'], ['a x 66000', 'a x 4000']]
  ])('breaks a line past 64 Ki characters without CRs or extra empty lines: %s', async (_name, parts, expected) =>
  {
    const h = harness()
    const lines: string[] = []
    const run = h.exec.run([], withSignal({ onStderrLine: (line) => lines.push(line) }))
    const child = h.child().start()
    for (const part of parts)
    {
      child.err(part)
    }
    child.end(0)
    await run
    expect(lines.map((line) => (line.length > 100 ? `${line[0]} x ${line.length}` : line))).toEqual(expected)
    expect(lines.some((line) => line.includes('\r'))).toBe(false)
  })

  it('keeps the last 2 KiB of stderr cut at a line boundary', async () =>
  {
    const h = harness()
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(41)}`)
    const run = h.exec.run([], withSignal())
    h.child().start().err(lines.map((line) => `${line}\r\n`).join(''))
    h.child().end(1)
    const { stderrTail } = await run
    expect(Buffer.byteLength(stderrTail, 'utf8')).toBeLessThanOrEqual(2048)
    expect(stderrTail).toBe(lines.slice(-40).join('\n'))
    expect(stderrTail.startsWith('line 060 ')).toBe(true)
    expect(stderrTail.endsWith(lines[99])).toBe(true)
  })

  it('keeps the end of a single line longer than 2 KiB without splitting a character', async () =>
  {
    const tailOf = async (text: string): Promise<string> =>
    {
      const h = harness()
      const run = h.exec.run([], withSignal())
      h.child().start().err(text)
      h.child().end(1)
      return (await run).stderrTail
    }
    expect(await tailOf(`short\n${'€'.repeat(1000)}\n`)).toBe('€'.repeat(682))
    expect(await tailOf(`${'€'.repeat(1000)}\nend\n`)).toBe('end')
    expect(await tailOf('')).toBe('')
  })

  it('signs and names the exit code and passes a signal through', async () =>
  {
    const h = harness()
    const failed = h.exec.run([], withSignal())
    h.child().start().end(4294967274)
    expect(await failed).toMatchObject({ code: -22, exitName: 'EINVAL', signal: null, aborted: false, stopped: 'none' })

    const signaled = h.exec.run([], withSignal())
    h.child().start().end(null, 'SIGKILL')
    expect(await signaled).toMatchObject({ code: null, exitName: null, signal: 'SIGKILL', aborted: false, stopped: 'none' })
  })

  it('measures the run on the injected clock', async () =>
  {
    const h = harness(1000)
    const run = h.exec.run([], withSignal())
    h.child().start()
    await h.timers.advance(1234)
    h.child().end(0)
    expect((await run).ms).toBe(1234)
  })
})

describe('outputRefused', () =>
{
  const replay = async (build: Build, name: string): Promise<ExecResult> =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal())
    const child = h.child().start()
    child.out(recorded(build, name, 'stdout'))
    child.err(recorded(build, name, 'stderr'))
    child.end(runRecord(build, name).code)
    return run
  }

  it.each(BUILDS.flatMap((build) => (['collision', 'collision-levels'] as const).map((name) => [build, name] as const)))(
    'marks the %s %s lines whatever the exit code',
    async (build, name) =>
    {
      const result = await replay(build, name)
      expect(result.outputRefused).toBe(true)
      expect(result.code).toBe(build === '9.0.2' ? 0 : 1)
      expect(result.stderrTail).toContain('already exists. Exiting.')
    }
  )

  it('marks the 9.0.2 unknown-encoder failure, which also prints Error opening output file', async () =>
  {
    expect(await replay('9.0.2', 'exit-unknown-encoder')).toMatchObject({ outputRefused: true, code: -1129203192, exitName: 'ENCODER_NOT_FOUND' })
  })

  it.each(BUILDS.flatMap((build) => (['progress-file', 'exit-missing-input', 'exit-aac-in-ac3', 'exit-no-outputs'] as const).map((name) => [build, name] as const)))(
    'leaves the %s %s run unmarked',
    async (build, name) =>
    {
      expect((await replay(build, name)).outputRefused).toBe(false)
    }
  )

  it.each([
    ['time+level+info', "17:44:27.890 [fatal] File 'OUT/exists.wav' already exists. Exiting."],
    ['time+level+info', '17:44:27.890 [error] Error opening output file OUT/exists.wav.'],
    ['datetime+level+info', '2026-10-16 17:44:27.958 [error] Error opening output file OUT/exists.wav.'],
    ['time+info', "17:44:28.022 File 'OUT/exists.wav' already exists. Exiting."],
    ['datetime+info', '2026-10-16 17:44:28.083 Error opening output file OUT/exists.wav.']
  ])('marks the line 9.0.2 prints under -loglevel %s: %s', async (_flags, line) =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal())
    h.child().start().err(`17:44:27.890 [info]   Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s\r\n${line}\r\n`)
    h.child().end(0)
    expect(await run).toMatchObject({ code: 0, outputRefused: true })
  })

  it('ignores tag text that only quotes the phrases', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal())
    h.child().start().err([
      '    title           : Error opening output file',
      "[info]     comment         : File 'a.wav' already exists. Exiting.",
      '[error] Could not open the file the title names: Error opening output file',
      '17:44:27.890 [info]     title           : Error opening output file',
      "2026-10-16 17:44:27.958     comment         : File 'a.wav' already exists. Exiting."
    ].join('\r\n'))
    h.child().end(0)
    expect((await run).outputRefused).toBe(false)
  })
})

describe('stop kill', () =>
{
  it('does not spawn when the signal already aborted, and resolves aborted', async () =>
  {
    const h = harness()
    const { controller, ...o } = withSignal()
    controller.abort()
    const result = await h.exec.run(['-i', 'IN/a.wav'], o)
    expect(h.calls).toHaveLength(0)
    expect(result).toEqual({ code: null, exitName: null, signal: null, aborted: true, stopped: 'none', outputRefused: false, stderrTail: '', ms: 0 })
  })

  it('terminates on abort and resolves aborted instead of rejecting', async () =>
  {
    const h = harness()
    const o = withSignal()
    const run = h.exec.run([], o)
    const child = h.child().start()
    child.err('[info] Press [q] to stop\r\n')
    o.controller.abort()
    expect(child.kills).toEqual(['SIGTERM'])
    expect(h.timers.pending()).toBe(1)
    child.end(null, 'SIGTERM')
    const result = await run
    expect(result).toMatchObject({ code: null, signal: 'SIGTERM', aborted: true, stopped: 'killed', outputRefused: false })
    expect(result.stderrTail).toBe('[info] Press [q] to stop')
    expect(h.timers.pending()).toBe(0)
  })

  it('resolves aborted even when the stopped process reports a failing exit code', async () =>
  {
    const h = harness()
    const o = withSignal()
    const run = h.exec.run([], o)
    h.child().start()
    o.controller.abort()
    h.child().end(1)
    await expect(run).resolves.toMatchObject({ code: 1, aborted: true, stopped: 'killed' })
  })

  it('sends SIGKILL when the process outlives SIGTERM by 3 s on the injected timers', async () =>
  {
    const h = harness()
    const o = withSignal()
    const run = h.exec.run([], o)
    const settled = settledFlag(run)
    const child = h.child().start()
    o.controller.abort()
    await h.timers.advance(2999)
    expect(child.kills).toEqual(['SIGTERM'])
    expect(settled()).toBe(false)
    await h.timers.advance(1)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.end(null, 'SIGKILL')
    await expect(run).resolves.toMatchObject({ code: null, signal: 'SIGKILL', aborted: true, stopped: 'killed' })
  })

  it('stops a process the signal aborted before it reported spawn, once it does', async () =>
  {
    const h = harness()
    const onSpawn = vi.fn()
    const o = withSignal({ onSpawn })
    const run = h.exec.run([], o)
    o.controller.abort()
    const child = h.child()
    expect(child.kills).toEqual([])
    child.start()
    expect(onSpawn).toHaveBeenCalledWith(4321)
    expect(child.kills).toEqual(['SIGTERM'])
    expect(h.timers.pending()).toBe(1)
    child.end(null, 'SIGTERM')
    await expect(run).resolves.toMatchObject({ code: null, signal: 'SIGTERM', aborted: true, stopped: 'killed' })
    expect(h.timers.pending()).toBe(0)
  })

  it('does not stop a process that already exited, and ignores an abort after close', async () =>
  {
    const h = harness()
    const o = withSignal()
    const run = h.exec.run([], o)
    const child = h.child().start()
    child.exit(0)
    o.controller.abort()
    expect(child.kills).toEqual([])
    child.close(0)
    await expect(run).resolves.toMatchObject({ code: 0, aborted: true, stopped: 'none' })

    const later = withSignal()
    const second = h.exec.run([], later)
    h.child().start().end(0)
    await second
    later.controller.abort()
    expect(h.child().kills).toEqual([])
    expect(h.timers.pending()).toBe(0)
  })
})

describe('stop graceful', () =>
{
  it('writes q on abort and reports a clean exit as stopped, not completed', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful' })
    const run = h.exec.run([], o)
    const child = h.child().start()
    o.controller.abort()
    expect(child.stdin?.written).toEqual(['q'])
    expect(child.kills).toEqual([])
    child.out('out_time_us=1500000\nspeed=1.5x\ntotal_size=4096\nprogress=end\n')
    child.end(0)
    await expect(run).resolves.toMatchObject({ code: 0, aborted: true, stopped: 'graceful' })
    expect(h.timers.pending()).toBe(0)
  })

  it('writes q once the process reports spawn when the signal aborted before it', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful' })
    const run = h.exec.run([], o)
    o.controller.abort()
    const child = h.child()
    expect(child.stdin?.written).toEqual([])
    child.start()
    expect(child.stdin?.written).toEqual(['q'])
    expect(child.kills).toEqual([])
    child.end(0)
    await expect(run).resolves.toMatchObject({ code: 0, aborted: true, stopped: 'graceful' })
    expect(h.timers.pending()).toBe(0)
  })

  it('force-kills after the default 5 s when q does not end the process', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful' })
    const run = h.exec.run([], o)
    const child = h.child().start()
    o.controller.abort()
    await h.timers.advance(4999)
    expect(child.kills).toEqual([])
    await h.timers.advance(1)
    expect(child.kills).toEqual(['SIGKILL'])
    child.end(null, 'SIGKILL')
    await expect(run).resolves.toMatchObject({ code: null, signal: 'SIGKILL', aborted: true, stopped: 'killed' })
  })

  it('uses gracefulTimeoutMs for the force-kill', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful', gracefulTimeoutMs: 250 })
    const run = h.exec.run([], o)
    const child = h.child().start()
    o.controller.abort()
    await h.timers.advance(250)
    expect(child.kills).toEqual(['SIGKILL'])
    child.end(null, 'SIGKILL')
    await expect(run).resolves.toMatchObject({ stopped: 'killed' })
  })

  it('kills at once when stdin can no longer take q', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful' })
    const run = h.exec.run([], o)
    const child = h.child().start()
    ;(child.stdin as FakeStdin).writable = false
    o.controller.abort()
    expect(child.stdin?.written).toEqual([])
    expect(child.kills).toEqual(['SIGKILL'])
    child.end(null, 'SIGKILL')
    await expect(run).resolves.toMatchObject({ aborted: true, stopped: 'killed' })
  })

  it('does not kill a process that exited before the timeout, even if close comes later', async () =>
  {
    const h = harness()
    const o = withSignal({ stop: 'graceful' })
    const run = h.exec.run([], o)
    const child = h.child().start()
    o.controller.abort()
    child.exit(0)
    await h.timers.advance(5000)
    expect(child.kills).toEqual([])
    child.close(0)
    await expect(run).resolves.toMatchObject({ code: 0, stopped: 'graceful' })
  })

  it('swallows a broken stdin pipe', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal({ stop: 'graceful' }))
    const child = h.child().start()
    expect(() => child.stdin?.emit('error', new Error('write EPIPE'))).not.toThrow()
    child.end(0)
    await expect(run).resolves.toMatchObject({ code: 0, stopped: 'none' })
  })
})

describe('failures to spawn and errors in callbacks', () =>
{
  it('rejects when the process cannot be spawned, and ignores the close that follows', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal())
    const error = Object.assign(new Error('spawn ffmpeg-bin ENOENT'), { code: 'ENOENT' })
    h.child().emit('error', error)
    h.child().close(-4058)
    await expect(run).rejects.toBe(error)
    expect(h.timers.pending()).toBe(0)
  })

  it('rejects with the spawn error when the process got no stdio streams, as after EMFILE', async () =>
  {
    const timers = createManualTimers()
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: undefined, stdout: undefined, stderr: undefined, kill: vi.fn() })
    const exec = createExec('ffmpeg-bin', { timers, spawn: (() => child) as unknown as typeof import('child_process').spawn })
    const run = exec.run([], withSignal({ stop: 'graceful' }))
    const error = Object.assign(new Error('spawn ffmpeg-bin EMFILE'), { code: 'EMFILE' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(() => child.emit('error', error)).not.toThrow()
    child.emit('close', -24, null)
    await expect(run).rejects.toBe(error)
    expect(child.kill).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it.each(['kill', 'graceful'] as const)('signals nothing under stop %s when the signal aborts before a spawn that fails', async (stop) =>
  {
    const h = harness()
    const o = withSignal({ stop })
    const run = h.exec.run([], o)
    const child = h.child()
    const kill = vi.spyOn(child, 'kill')
    expect(() => o.controller.abort()).not.toThrow()
    const error = Object.assign(new Error('spawn ffmpeg-bin ENOENT'), { code: 'ENOENT' })
    child.emit('error', error)
    child.close(-4058)
    await expect(run).rejects.toBe(error)
    expect(kill).not.toHaveBeenCalled()
    expect(child.stdin?.written ?? []).toEqual([])
    expect(h.timers.pending()).toBe(0)
  })

  it('rejects when spawn throws', async () =>
  {
    const timers = createManualTimers()
    const exec = createExec('ffmpeg-bin', {
      timers,
      spawn: (() =>
      {
        throw new Error('spawn EINVAL')
      }) as unknown as typeof import('child_process').spawn
    })
    await expect(exec.run([], withSignal())).rejects.toThrow('spawn EINVAL')
  })

  it('ignores an error event after the process started', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal())
    const child = h.child().start()
    child.emit('error', new Error('kill EPERM'))
    child.end(0)
    await expect(run).resolves.toMatchObject({ code: 0 })
  })

  it('kills the process and rejects with the error a progress callback threw', async () =>
  {
    const h = harness()
    const boom = new Error('progress handler failed')
    const onProgress = vi.fn(() =>
    {
      throw boom
    })
    const o = withSignal({ onProgress })
    const run = h.exec.run([], o)
    const child = h.child().start()
    child.out('out_time_us=1\nprogress=continue\nout_time_us=2\nprogress=continue\n')
    expect(child.kills).toEqual(['SIGTERM'])
    o.controller.abort()
    expect(child.kills).toEqual(['SIGTERM'])
    child.end(null, 'SIGTERM')
    await expect(run).rejects.toBe(boom)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(h.timers.pending()).toBe(0)
  })

  it('stops delivering lines after a line callback throws, and rejects with its error', async () =>
  {
    const h = harness()
    const onStderrLine = vi.fn(() =>
    {
      throw new Error('line handler failed')
    })
    const run = h.exec.run([], withSignal({ onStderrLine }))
    const child = h.child().start()
    child.err('one\ntwo\nthree\n')
    child.end(null, 'SIGTERM')
    await expect(run).rejects.toThrow('line handler failed')
    expect(onStderrLine).toHaveBeenCalledTimes(1)
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('rejects with the error onSpawn threw', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal({ onSpawn: () =>
    {
      throw new Error('priority call failed')
    } }))
    const child = h.child().start()
    expect(child.kills).toEqual(['SIGTERM'])
    child.end(null, 'SIGTERM')
    await expect(run).rejects.toThrow('priority call failed')
  })

  it('rejects without killing when a callback throws on the last line after the process exited', async () =>
  {
    const h = harness()
    const run = h.exec.run([], withSignal({ onStderrLine: () =>
    {
      throw new Error('late line handler failed')
    } }))
    const child = h.child().start()
    child.err('no line break at the end')
    child.end(0)
    await expect(run).rejects.toThrow('late line handler failed')
    expect(child.kills).toEqual([])
  })
})

describe('module boundaries', () =>
{
  const importsOf = (file: string): string[] =>
  {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    return [
      ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)
    ].map((match) => match[1])
  }

  it('exec and timers import no configuration, logging, Electron, or file system module', () =>
  {
    expect(importsOf('src/main/ffmpeg/exec.ts').sort()).toEqual(['../timers', 'child_process', 'string_decoder'])
    expect(importsOf('src/main/timers.ts')).toEqual([])
    for (const specifier of [...importsOf('src/main/ffmpeg/exec.ts'), ...importsOf('src/main/timers.ts')])
    {
      expect(specifier).not.toMatch(/(?:^|\/)(?:config|logger)$|^electron|^(?:node:)?fs(?:\/promises)?$/)
    }
  })

  it('defaults to the real spawn without starting anything', () =>
  {
    expect(typeof createExec('ffmpeg', { timers: createManualTimers() }).run).toBe('function')
  })
})
