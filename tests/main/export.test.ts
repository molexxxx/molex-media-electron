import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

vi.mock('../../src/main/ffmpeg/gpu', () => ({
  resolveGpuCodec: vi.fn().mockResolvedValue({ codec: 'h264_nvenc', activeMode: 'nvenc', isGpu: true }),
  getGpuPreset: vi.fn().mockReturnValue(['-preset', 'p4']),
  getGpuQualityArgs: vi.fn().mockReturnValue(['-cq', '23'])
}))

import type { Exec, ExecOptions, ExecResult } from '../../src/main/ffmpeg/exec'
import { failureText, judgeExport, renderPercent, runExportJob } from '../../src/main/ffmpeg/processor/export'
import type { ExportDeps, ExportProgress } from '../../src/main/ffmpeg/processor/export'
import type { ExportRequest } from '../../src/main/ffmpeg/processor/editor'
import { exportCeiling } from '../../src/main/ffmpeg/processor/editor'
import { resolveCeiling } from '../../src/main/ffmpeg/audio/ceilings'

/** One scripted FFmpeg run: the stderr lines and progress it reports, and how it ends. */
interface Step
{
  lines?: string[]
  progress?: number[]
  result?: Partial<ExecResult>
  /** Aborts the controller while running, as a user cancel does. */
  abort?: AbortController
  throws?: Error
}

function execResult(overrides: Partial<ExecResult> = {}): ExecResult
{
  return { code: 0, exitName: null, signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: 5, ...overrides }
}

function scriptedExec(steps: Step[]): Exec & { calls: Array<{ args: readonly string[]; o: ExecOptions }> }
{
  const calls: Array<{ args: readonly string[]; o: ExecOptions }> = []
  return {
    calls,
    async run(args, o)
    {
      calls.push({ args, o })
      const step = steps.shift()
      if (step === undefined)
      {
        throw new Error('unexpected FFmpeg run')
      }
      if (step.throws)
      {
        throw step.throws
      }
      for (const t of step.progress ?? [])
      {
        o.onProgress?.({ outTimeSec: t, speed: 1, totalSize: 100, end: false })
      }
      for (const line of step.lines ?? [])
      {
        o.onStderrLine?.(line)
      }
      if (step.abort)
      {
        step.abort.abort()
        return execResult({ code: null, signal: 'SIGTERM', aborted: true, stopped: 'killed', ...step.result })
      }
      return execResult(step.result)
    }
  }
}

function verifyLines(truePeak: string, samplePeak: string, integrated = '-14.2'): string[]
{
  return [
    `[astats@t0 @ 0x1] [info] Peak level dB: ${truePeak}`,
    `[astats@s0 @ 0x2] [info] Peak level dB: ${samplePeak}`,
    '[ebur128@v0 @ 0x3] [info] Summary:',
    '',
    '  Integrated loudness:',
    `    I:         ${integrated} LUFS`,
    '    Threshold: -24.2 LUFS',
    '',
    '  Loudness range:',
    '    LRA:         4.0 LU'
  ]
}

function mixRequest(output: Partial<ExportRequest['output']> = {}, withVideo = false): ExportRequest
{
  const tracks: ExportRequest['tracks'] = [
    { id: 'a1', type: 'audio', name: 'A1', index: 0, muted: false, visible: true },
    { id: 'a2', type: 'audio', name: 'A2', index: 1, muted: false, visible: true }
  ]
  if (withVideo)
  {
    tracks.push({ id: 'v1', type: 'video', name: 'V1', index: 2, muted: false, visible: true })
  }
  const clip = { sourceId: 's1', timelineStart: 0, sourceIn: 0, sourceOut: 300, muted: false, pan: 0, speed: 1 }
  return {
    project: { frameRate: 30, sampleRate: 48000, resolution: { width: 1280, height: 720 } },
    sources: [{ id: 's1', filePath: '/media/in.mp4', frameRate: 30, width: 1280, height: 720, audioChannels: 2, audioSampleRate: 48000, durationSeconds: 10 }],
    tracks,
    clips: [
      { ...clip, id: 'c1', trackId: 'a1', volume: 2 },
      { ...clip, id: 'c2', trackId: 'a2', volume: 1 },
      ...(withVideo ? [{ ...clip, id: 'c3', trackId: 'v1', volume: 1 }] : [])
    ],
    output: { filePath: '/out/Mix.M4A', format: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', audioBitrate: '192k', ...output }
  }
}

function harness(exec: Exec, overrides: Partial<ExportDeps> = {}): { deps: ExportDeps; removed: string[]; progress: ExportProgress[]; logs: string[]; exts: string[] }
{
  const removed: string[] = []
  const progress: ExportProgress[] = []
  const logs: string[] = []
  const exts: string[] = []
  const deps: ExportDeps = {
    exec,
    output: (ext) =>
    {
      exts.push(ext)
      return `/work/export.${ext}`
    },
    fs: { remove: async (p) => { removed.push(p) }, size: async () => 4096 },
    log: (entry) => { logs.push(`${entry.level}: ${entry.message}`) },
    onProgress: (p) => { progress.push(p) },
    ...overrides
  }
  return { deps, removed, progress, logs, exts }
}

describe('runExportJob', () =>
{
  it('renders the limited mix into the output path, then verifies it: a pass', async () =>
  {
    const exec = scriptedExec([{ progress: [0, 5, 10, 12] }, { lines: verifyLines('-1.99', '-2.40') }])
    const h = harness(exec, { meter: 'soxr' })
    const result = await runExportJob(mixRequest(), h.deps, new AbortController().signal)
    expect(result).toMatchObject({ status: 'done', outputPath: '/work/export.m4a' })
    expect(h.exts).toEqual(['m4a'])
    const render = exec.calls[0]
    expect(render.o.stop).toBe('kill')
    expect(render.o.durationSec).toBe(10)
    expect(render.args[render.args.length - 1]).toBe('/work/export.m4a')
    const graph = render.args[render.args.indexOf('-filter_complex') + 1]
    expect(graph).toMatch(/amix=inputs=2:duration=longest:normalize=0\[(\w+)\];\[\1\]aformat=sample_fmts=dbl,aresample=192000,alimiter=limit=-2\.50dB/)
    const verify = exec.calls[1].args
    expect(verify.slice(0, 4)).toEqual(['-loglevel', 'level+info', '-i', '/work/export.m4a'])
    expect(verify[verify.indexOf('-filter_complex') + 1]).toContain('aresample=resampler=soxr:precision=33:osr=384000:osf=dbl')
    expect(verify.slice(-9)).toEqual(['-map', '[v0]', '-map', '[t0]', '-map', '[s0]', '-f', 'null', '-'])
    if (result.status !== 'done')
    {
      throw new Error('expected done')
    }
    expect(result.verification).toEqual({
      outcome: 'verified',
      ceiling: resolveCeiling('aac', 192, -1),
      limitDbtp: -1,
      truePeakDbtp: -1.99,
      overDb: null,
      samplePeakDbfs: -2.4,
      samplePeakOver: false,
      integratedLufs: -14.2,
      loudnessRangeLu: null,
      meter: 'soxr-8x',
      decodeErrors: [],
      decodeErrorCount: 0
    })
    expect(h.progress).toEqual([
      { stage: 'render', percent: 0 },
      { stage: 'render', percent: 0 },
      { stage: 'render', percent: 50 },
      { stage: 'render', percent: 99 },
      { stage: 'render', percent: 99 },
      { stage: 'verify', percent: null }
    ])
    expect(h.removed).toEqual([])
    expect(h.logs).toContain('info: Timeline export verified')
  })

  it('reports a true-peak miss as outside tolerance and keeps the output', async () =>
  {
    const exec = scriptedExec([{}, { lines: verifyLines('-0.95', '-1.10') }])
    const h = harness(exec)
    const result = await runExportJob(mixRequest(), h.deps, new AbortController().signal)
    expect(result.status).toBe('done')
    if (result.status !== 'done')
    {
      throw new Error('expected done')
    }
    expect(result.verification).toMatchObject({ outcome: 'outside-tolerance', limitDbtp: -1.2, truePeakDbtp: -0.95, overDb: 0.25, meter: 'swr-8x' })
    expect(h.removed).toEqual([])
    expect(h.logs).toContain('warn: Timeline export verified')
  })

  it('judges decoded samples over 0 dBFS outside tolerance even under the true-peak limit', async () =>
  {
    const exec = scriptedExec([{}, { lines: verifyLines('-3.00', '0.20') }])
    const result = await runExportJob(mixRequest(), harness(exec, { meter: 'soxr' }).deps, new AbortController().signal)
    expect(result).toMatchObject({ status: 'done', verification: { outcome: 'outside-tolerance', overDb: null, samplePeakOver: true } })
  })

  it('fails the verdict on decode errors, keeping the first 20 and the count', async () =>
  {
    const errors = Array.from({ length: 25 }, (_, i) => `[aac @ 0x5] [error] Error decoding frame ${i}`)
    const exec = scriptedExec([{}, { lines: [...errors, ...verifyLines('-2.10', '-2.50')] }])
    const result = await runExportJob(mixRequest(), harness(exec).deps, new AbortController().signal)
    if (result.status !== 'done' || result.verification === null)
    {
      throw new Error('expected a verification')
    }
    expect(result.verification.outcome).toBe('failed')
    expect(result.verification.decodeErrorCount).toBe(25)
    expect(result.verification.decodeErrors).toHaveLength(20)
    expect(result.verification.decodeErrors[0]).toBe(errors[0])
    expect(result.verification.truePeakDbtp).toBe(-2.1)
  })

  it('fails the verdict when the verify run exits non-zero with no decode line', async () =>
  {
    const exec = scriptedExec([{}, { result: { code: 1, stderrTail: 'Invalid data found when processing input\n' } }])
    const result = await runExportJob(mixRequest(), harness(exec).deps, new AbortController().signal)
    expect(result).toMatchObject({
      status: 'done',
      verification: { outcome: 'failed', truePeakDbtp: null, decodeErrorCount: 1, decodeErrors: ['Invalid data found when processing input'] }
    })
  })

  it('fails the verdict when the verify printed no Summary', async () =>
  {
    const exec = scriptedExec([{}, { lines: ['[astats@t0 @ 0x1] [info] Peak level dB: -3.0'] }])
    const result = await runExportJob(mixRequest(), harness(exec).deps, new AbortController().signal)
    expect(result).toMatchObject({ status: 'done', verification: { outcome: 'failed', truePeakDbtp: null, decodeErrorCount: 0 } })
  })

  it('removes the output and reports canceled when the render is aborted', async () =>
  {
    const controller = new AbortController()
    const exec = scriptedExec([{ progress: [2], abort: controller }])
    const h = harness(exec)
    const result = await runExportJob(mixRequest(), h.deps, controller.signal)
    expect(result).toEqual({ status: 'canceled' })
    expect(h.removed).toEqual(['/work/export.m4a'])
    expect(exec.calls).toHaveLength(1)
  })

  it('reports canceled when exec reports an abort the signal has not seen', async () =>
  {
    const exec = scriptedExec([{ result: { aborted: true, code: null, stopped: 'killed' } }])
    const h = harness(exec)
    expect(await runExportJob(mixRequest(), h.deps, new AbortController().signal)).toEqual({ status: 'canceled' })
    expect(h.removed).toEqual(['/work/export.m4a'])
  })

  it('removes the output and reports canceled when the verify is aborted', async () =>
  {
    const controller = new AbortController()
    const exec = scriptedExec([{}, { abort: controller }])
    const h = harness(exec)
    expect(await runExportJob(mixRequest(), h.deps, controller.signal)).toEqual({ status: 'canceled' })
    expect(h.removed).toEqual(['/work/export.m4a'])
  })

  it('reports canceled when the abort lands between the render and the verify', async () =>
  {
    const controller = new AbortController()
    const exec = scriptedExec([{ lines: ['frame=  10 fps=0.0'] }])
    const h = harness(exec, { fs: { remove: async (p) => { h.removed.push(p) }, size: async () => { controller.abort(); return 10 } } })
    expect(await runExportJob(mixRequest(), h.deps, controller.signal)).toEqual({ status: 'canceled' })
    expect(exec.calls).toHaveLength(1)
    expect(h.removed).toEqual(['/work/export.m4a'])
  })

  it('runs nothing when the signal is already aborted', async () =>
  {
    const controller = new AbortController()
    controller.abort()
    const exec = scriptedExec([])
    const h = harness(exec)
    expect(await runExportJob(mixRequest(), h.deps, controller.signal)).toEqual({ status: 'canceled' })
    expect(exec.calls).toHaveLength(0)
    expect(h.exts).toEqual([])
  })

  it('reports canceled when the spawn fails after an abort', async () =>
  {
    const controller = new AbortController()
    const exec: Exec = {
      run: async () =>
      {
        controller.abort()
        throw new Error('spawn EPERM')
      }
    }
    expect(await runExportJob(mixRequest(), harness(exec).deps, controller.signal)).toEqual({ status: 'canceled' })
  })

  it('fails with the last stderr lines when the render exits non-zero, and removes the output', async () =>
  {
    const exec = scriptedExec([{ result: { code: 1, stderrTail: 'one\n\ntwo\nthree\nUnknown encoder \'foo\'\n' } }])
    const h = harness(exec)
    const result = await runExportJob(mixRequest(), h.deps, new AbortController().signal)
    expect(result).toEqual({ status: 'failed', error: 'two three Unknown encoder \'foo\'' })
    expect(h.removed).toEqual(['/work/export.m4a'])
    expect(h.logs).toContain('error: Timeline export failed')
  })

  it('fails a refused output, a stopped run, and a spawn error', async () =>
  {
    const refused = await runExportJob(mixRequest(), harness(scriptedExec([{ result: { outputRefused: true } }])).deps, new AbortController().signal)
    expect(refused).toEqual({ status: 'failed', error: 'FFmpeg could not write the output file' })
    const stopped = await runExportJob(mixRequest(), harness(scriptedExec([{ result: { stopped: 'graceful' } }])).deps, new AbortController().signal)
    expect(stopped).toEqual({ status: 'failed', error: 'FFmpeg exited with code 0' })
    const spawn = await runExportJob(mixRequest(), harness(scriptedExec([{ throws: new Error('spawn ENOENT') }])).deps, new AbortController().signal)
    expect(spawn).toEqual({ status: 'failed', error: 'FFmpeg did not start: spawn ENOENT' })
    const thrown: Exec = { run: async () => { throw 'boom' } }
    expect(await runExportJob(mixRequest(), harness(thrown).deps, new AbortController().signal)).toEqual({ status: 'failed', error: 'FFmpeg did not start: boom' })
  })

  it('fails an empty or unreadable output and removes it', async () =>
  {
    const empty = harness(scriptedExec([{}]), { fs: { remove: async () => undefined, size: async () => 0 } })
    expect(await runExportJob(mixRequest(), empty.deps, new AbortController().signal)).toEqual({ status: 'failed', error: 'The export wrote an empty file' })
    const removed: string[] = []
    const unreadable = harness(scriptedExec([{}]), {
      fs: { remove: async (p) => { removed.push(p) }, size: async () => { throw new Error('ENOENT') } }
    })
    expect(await runExportJob(mixRequest(), unreadable.deps, new AbortController().signal)).toEqual({ status: 'failed', error: 'The export wrote an empty file' })
    expect(removed).toEqual(['/work/export.m4a'])
  })

  it('logs a removal that fails and still reports the failure', async () =>
  {
    const h = harness(scriptedExec([{ result: { code: 1 } }]), {
      fs: { remove: async () => { throw new Error('EBUSY') }, size: async () => 1 }
    })
    expect(await runExportJob(mixRequest(), h.deps, new AbortController().signal)).toEqual({ status: 'failed', error: 'FFmpeg exited with code 1' })
    expect(h.logs).toContain('warn: Could not remove the export output')
    const odd = harness(scriptedExec([{ result: { code: 1 } }]), {
      fs: { remove: async () => { throw 'locked' }, size: async () => 1 }
    })
    await runExportJob(mixRequest(), odd.deps, new AbortController().signal)
    expect(odd.logs).toContain('warn: Could not remove the export output')
  })

  it('fails a request with no active clips before FFmpeg runs', async () =>
  {
    const exec = scriptedExec([])
    const request = { ...mixRequest(), clips: [] }
    expect(await runExportJob(request, harness(exec).deps, new AbortController().signal)).toEqual({ status: 'failed', error: 'No active clips to export' })
    expect(exec.calls).toHaveLength(0)
    const thrower: ExportDeps['output'] = () => { throw 'no folder' }
    const bad = harness(scriptedExec([]), { output: thrower })
    await expect(runExportJob(mixRequest(), bad.deps, new AbortController().signal)).rejects.toBe('no folder')
  })

  it('skips the verify for a video-only export', async () =>
  {
    const request = mixRequest({ filePath: '/out/clip.mp4' }, true)
    request.sources[0].audioChannels = 0
    const exec = scriptedExec([{}])
    const h = harness(exec)
    expect(await runExportJob(request, h.deps, new AbortController().signal)).toEqual({ status: 'done', outputPath: '/work/export.mp4', verification: null })
    expect(exec.calls).toHaveLength(1)
    expect(h.logs).toContain('info: Timeline export complete')
  })

  it('passes the GPU settings to the command and measures at the requested rate', async () =>
  {
    const exec = scriptedExec([{}, { lines: verifyLines('-1.60', '-1.70') }])
    const h = harness(exec, { gpu: { ffmpegPath: '/bin/ffmpeg', mode: 'nvenc' }, onProgress: undefined })
    const request = mixRequest({ filePath: '/out/v.mp4', sampleRate: 44100, audioCodec: 'flac', audioBitrate: undefined }, true)
    const result = await runExportJob(request, h.deps, new AbortController().signal)
    expect(exec.calls[0].args).toContain('h264_nvenc')
    expect(exec.calls[1].args[exec.calls[1].args.indexOf('-filter_complex') + 1]).toContain('aresample=osr=352800:osf=dbl')
    expect(result).toMatchObject({ status: 'done', verification: { outcome: 'verified', limitDbtp: -1.2, ceiling: { ceilingDbtp: -1, outputClass: 'lossless' } } })
  })

  it('runs without a duration when the timeline has none', async () =>
  {
    const request = mixRequest()
    request.clips = request.clips.map((c) => ({ ...c, sourceOut: 0 }))
    const exec = scriptedExec([{ progress: [1] }, { lines: verifyLines('-2.00', '-2.00') }])
    const h = harness(exec)
    await runExportJob(request, h.deps, new AbortController().signal)
    expect(exec.calls[0].o.durationSec).toBeUndefined()
    expect(h.progress).toContainEqual({ stage: 'render', percent: null })
  })
})

describe('export helpers', () =>
{
  it('words a failure from the stderr tail, the exit code, or the signal', () =>
  {
    expect(failureText(execResult({ code: 1, stderrTail: '  a  \nb\n' }))).toBe('a b')
    expect(failureText(execResult({ code: 254 }))).toBe('FFmpeg exited with code 254')
    expect(failureText(execResult({ code: null, signal: 'SIGKILL' }))).toBe('FFmpeg stopped by SIGKILL')
    expect(failureText(execResult({ code: null }))).toBe('FFmpeg stopped by a signal')
    expect(failureText(execResult({ code: 1, stderrTail: 'x'.repeat(400) }))).toHaveLength(300)
  })

  it('holds the render percent between 0 and 99', () =>
  {
    const at = (t: number | null): { outTimeSec: number | null; speed: null; totalSize: null; end: false } => ({ outTimeSec: t, speed: null, totalSize: null, end: false })
    expect(renderPercent(at(5), 10)).toBe(50)
    expect(renderPercent(at(20), 10)).toBe(99)
    expect(renderPercent(at(-1), 10)).toBe(0)
    expect(renderPercent(at(null), 10)).toBeNull()
    expect(renderPercent(at(5), 0)).toBeNull()
  })

  it('judges at the gate less the swr margin, bounds inclusive', () =>
  {
    const ceiling = exportCeiling({ filePath: 'x.m4a', format: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', audioBitrate: '192k' })
    const parsed = (truePeakDbtp: number): Parameters<typeof judgeExport>[2] => ({
      streams: new Map([[0, { outIndex: 0, integratedLufs: -20, loudnessRangeLu: 3, maxShortTermLufs: null, preEncodeTruePeakDbtp: truePeakDbtp, truePeakDbtp, samplePeakDbfs: -3, meter: 'swr-8x' as const }]]),
      decodeErrors: [],
      decodeErrorCount: 0
    })
    expect(judgeExport(ceiling, 'swr', parsed(-1.2), [], 0)).toMatchObject({ outcome: 'verified', overDb: null, loudnessRangeLu: 3 })
    expect(judgeExport(ceiling, 'swr', parsed(-1.19), [], 0)).toMatchObject({ outcome: 'outside-tolerance', overDb: 0.01 })
    expect(judgeExport(ceiling, 'soxr', parsed(-1), [], 0)).toMatchObject({ outcome: 'verified', limitDbtp: -1 })
    expect(judgeExport({ ...ceiling, gateDbtp: -0.2 }, 'soxr', parsed(-0.2), [], 0)).toMatchObject({ outcome: 'verified', limitDbtp: -0.2 })
    expect(judgeExport({ ...ceiling, gateDbtp: 0 }, 'soxr', parsed(0), [], 0).limitDbtp).toBe(0)
  })
})
