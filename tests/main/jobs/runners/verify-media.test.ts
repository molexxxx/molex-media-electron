import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AudioFacts, MediaFacts } from '../../../../src/shared/audio/types'
import type { Exec, ExecOptions, ExecResult, FfmpegProgress } from '../../../../src/main/ffmpeg/exec'
import { execArgv } from '../../../../src/main/ffmpeg/exec'
import
{
  DURATION_TOLERANCE_SEC,
  MAX_DECODE_ERRORS,
  SAMPLE_WINDOW_SEC,
  countCues,
  decodeArgs,
  decodeErrorCollector,
  describeCounts,
  durationStatus,
  durationTolerance,
  framesWithin,
  nodeVerifyFiles,
  sampleStarts,
  sizeStatus,
  streamCounts,
  toVerification,
  verificationError,
  verifyMedia
} from '../../../../src/main/jobs/runners/verify-media'
import type { DecodePolicy, MediaCheck, StreamCounts, VerifyDeps, VerifyFiles, VerifyTarget } from '../../../../src/main/jobs/runners/verify-media'

describe('durationTolerance', () =>
{
  it('is half a second up to 100 s and half a percent above', () =>
  {
    expect(durationTolerance(10)).toBe(DURATION_TOLERANCE_SEC)
    expect(durationTolerance(100)).toBe(0.5)
    expect(durationTolerance(3600)).toBeCloseTo(18, 9)
  })
})

describe('durationStatus', () =>
{
  it('accepts a re-encode within the larger of 0.5 s and 0.5 percent', () =>
  {
    expect(durationStatus(10.5, { expectedSec: 10, rule: 'tolerance' })).toBe('within')
    expect(durationStatus(9.5, { expectedSec: 10, rule: 'tolerance' })).toBe('within')
    expect(durationStatus(3618, { expectedSec: 3600, rule: 'tolerance' })).toBe('within')
    expect(durationStatus(3582, { expectedSec: 3600, rule: 'tolerance' })).toBe('within')
  })

  it('rejects a re-encode just past the tolerance either way', () =>
  {
    expect(durationStatus(10.51, { expectedSec: 10, rule: 'tolerance' })).toBe('outside')
    expect(durationStatus(9.49, { expectedSec: 10, rule: 'tolerance' })).toBe('outside')
    expect(durationStatus(3618.5, { expectedSec: 3600, rule: 'tolerance' })).toBe('outside')
  })

  it('checks a stream-copy trim only for covering the span, since copies snap to keyframes', () =>
  {
    expect(durationStatus(14, { expectedSec: 10, rule: 'covers' })).toBe('within')
    expect(durationStatus(9.6, { expectedSec: 10, rule: 'covers' })).toBe('within')
    expect(durationStatus(9.4, { expectedSec: 10, rule: 'covers' })).toBe('outside')
  })

  it('treats an unknown duration as outside', () =>
  {
    expect(durationStatus(null, { expectedSec: 10, rule: 'tolerance' })).toBe('outside')
    expect(durationStatus(Number.NaN, { expectedSec: 10, rule: 'covers' })).toBe('outside')
  })
})

describe('sizeStatus', () =>
{
  it('passes at exactly the target and fails one byte over, with no allowance', () =>
  {
    expect(sizeStatus(50_000_000, 50_000_000)).toBe('within')
    expect(sizeStatus(50_000_001, 50_000_000)).toBe('over')
    expect(sizeStatus(1, 50_000_000)).toBe('within')
  })

  it('is not checked without a target', () =>
  {
    expect(sizeStatus(123, null)).toBe('not-checked')
  })
})

describe('framesWithin', () =>
{
  it('accepts at least one image within one of the expected count', () =>
  {
    expect(framesWithin(10, 10)).toBe(true)
    expect(framesWithin(9, 10)).toBe(true)
    expect(framesWithin(11, 10)).toBe(true)
    expect(framesWithin(1, null)).toBe(true)
  })

  it('rejects no image, and a count two away', () =>
  {
    expect(framesWithin(0, null)).toBe(false)
    expect(framesWithin(0, 1)).toBe(false)
    expect(framesWithin(8, 10)).toBe(false)
    expect(framesWithin(12, 10)).toBe(false)
  })
})

describe('countCues', () =>
{
  it('counts SRT cues by their timing lines, CRLF and BOM included', () =>
  {
    const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nWorld\r\n\r\n'
    expect(countCues(srt, 'srt')).toBe(2)
  })

  it('does not count text that only mentions an arrow', () =>
  {
    expect(countCues('1\n00:00:01,000 --> 00:00:02,000\nA --> B\n', 'srt')).toBe(1)
  })

  it('counts WebVTT cues with and without hours, and needs the header', () =>
  {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n\nid-2\n01:00:02.000 --> 01:00:03.000 align:start\nTwo\n'
    expect(countCues(vtt, 'vtt')).toBe(2)
    expect(countCues('WEBVTT - with a title\n\n00:01.000 --> 00:02.000\nOne\n', 'vtt')).toBe(1)
    expect(countCues('00:01.000 --> 00:02.000\nOne\n', 'vtt')).toBeNull()
    expect(countCues('WEBVTT\n\nNOTE nothing here\n', 'vtt')).toBe(0)
  })

  it('counts ASS and SSA dialogue lines, not comments or styles', () =>
  {
    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      '',
      '[V4+ Styles]',
      'Style: Default,Arial,20,&H00FFFFFF',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello',
      'Comment: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,Not a cue',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,World'
    ].join('\r\n')
    expect(countCues(ass, 'ass')).toBe(2)
    expect(countCues(ass, 'ssa')).toBe(2)
    expect(countCues('[Script Info]\n[Events]\n', 'ass')).toBe(0)
  })
})

describe('sampleStarts', () =>
{
  it('reads the start, the middle, and the end in three 20-second windows', () =>
  {
    expect(sampleStarts(600)).toEqual([0, 290, 580])
    expect(sampleStarts(61)).toEqual([0, 20.5, 41])
  })

  it('does not sample a span three windows cover, or an unknown one', () =>
  {
    expect(sampleStarts(60)).toBeNull()
    expect(sampleStarts(10)).toBeNull()
    expect(sampleStarts(Number.NaN)).toBeNull()
  })

  it('rounds window starts to milliseconds', () =>
  {
    expect(sampleStarts(100.12345)).toEqual([0, 40.062, 80.123])
  })
})

describe('decodeArgs', () =>
{
  it('decodes every video and audio stream in full to the null muxer', () =>
  {
    expect(decodeArgs('/w/out.part', { video: 1, audio: 3 }, null))
      .toEqual(['-v', 'error', '-i', '/w/out.part', '-map', '0:v', '-map', '0:a', '-f', 'null', '-'])
  })

  it('maps only the stream types the output holds', () =>
  {
    expect(decodeArgs('a.part', { video: 0, audio: 1 }, null))
      .toEqual(['-v', 'error', '-i', 'a.part', '-map', '0:a', '-f', 'null', '-'])
    expect(decodeArgs('v.part', { video: 1, audio: 0 }, null))
      .toEqual(['-v', 'error', '-i', 'v.part', '-map', '0:v', '-f', 'null', '-'])
  })

  it('samples video in windows while the audio still decodes in full', () =>
  {
    const window = String(SAMPLE_WINDOW_SEC)
    expect(decodeArgs('o.part', { video: 1, audio: 2 }, [0, 290, 580])).toEqual([
      '-v', 'error',
      '-i', 'o.part',
      '-ss', '0', '-t', window, '-i', 'o.part',
      '-ss', '290', '-t', window, '-i', 'o.part',
      '-ss', '580', '-t', window, '-i', 'o.part',
      '-map', '0:a', '-map', '1:v', '-map', '2:v', '-map', '3:v',
      '-f', 'null', '-'
    ])
  })

  it('numbers the windows from zero for an output without audio', () =>
  {
    const args = decodeArgs('o.part', { video: 1, audio: 0 }, [0, 50, 100])
    expect(args.filter((arg) => /^\d:/.test(arg))).toEqual(['0:v', '1:v', '2:v'])
  })

  it('keeps at most twenty decode-error lines', () =>
  {
    expect(MAX_DECODE_ERRORS).toBe(20)
  })
})

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/jobs/runners/convert/decode')

function audioStream(audioIndex: number, streamIndex: number): AudioFacts
{
  return {
    audioIndex,
    streamIndex,
    codecName: 'aac',
    profile: 'LC',
    channels: 2,
    layout: 'stereo',
    layoutGuessed: false,
    sampleRate: 48000,
    sampleFmt: 'fltp',
    bitsPerRawSample: null,
    bitRate: 96000,
    durationSec: 90,
    language: null,
    title: null,
    disposition: { default: 1 }
  }
}

function probed(over: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: '/w/out.part',
    container: 'mp4',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 90,
    audio: [audioStream(0, 1), audioStream(1, 2)],
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }],
    subtitles: [],
    attachments: [],
    data: [],
    chapters: 0,
    ...over
  }
}

interface Scripted
{
  lines?: string[]
  code?: number | null
  signal?: string | null
  aborted?: boolean
  stopped?: ExecResult['stopped']
  progress?: FfmpegProgress[]
  onRun?(): void
}

function fakeExec(script: Scripted = {}): Exec & { calls: Array<{ args: readonly string[]; o: ExecOptions }> }
{
  const calls: Array<{ args: readonly string[]; o: ExecOptions }> = []
  return {
    calls,
    async run(args, o)
    {
      calls.push({ args, o })
      script.onRun?.()
      for (const p of script.progress ?? [])
      {
        o.onProgress?.(p)
      }
      for (const line of script.lines ?? [])
      {
        o.onStderrLine?.(line)
      }
      const code = script.code === undefined ? 0 : script.code
      return {
        code,
        exitName: code === null || code === 0 ? null : 'EXIT_NAME',
        signal: script.signal ?? null,
        aborted: script.aborted ?? false,
        stopped: script.stopped ?? 'none',
        outputRefused: false,
        stderrTail: (script.lines ?? []).join('\n'),
        ms: 5
      }
    }
  }
}

function fakeFiles(over: Partial<VerifyFiles> = {}): VerifyFiles
{
  return {
    size: async () => 1000,
    text: async () => '',
    list: async () => [],
    ...over
  }
}

const STREAMS: StreamCounts = { video: 1, audio: 2, subtitle: 0, attachment: 0 }

function mediaTarget(over: Partial<Extract<VerifyTarget, { kind: 'media' }>> = {}): VerifyTarget
{
  return {
    kind: 'media',
    path: '/w/out.part',
    streams: STREAMS,
    duration: { expectedSec: 90, rule: 'tolerance' },
    targetBytes: null,
    sourceBytes: null,
    ...over
  }
}

function deps(exec: Exec, over: Partial<VerifyDeps> = {}): VerifyDeps
{
  return {
    exec,
    signal: new AbortController().signal,
    probe: async () => probed(),
    files: fakeFiles(),
    ...over
  }
}

const FULL: DecodePolicy = { setting: 'full', displacing: false }
const SAMPLED: DecodePolicy = { setting: 'sampled', displacing: false }

async function checkedOf(promise: Promise<MediaCheck>): Promise<Extract<MediaCheck, { kind: 'checked' }>>
{
  const check = await promise
  if (check.kind !== 'checked')
  {
    throw new Error('expected a checked result')
  }
  return check
}

function stderrLines(file: string): string[]
{
  return readFileSync(join(FIXTURES, file), 'utf8').split(/\r\n|\n/).filter((line) => line !== '')
}

describe('decodeErrorCollector', () =>
{
  it('keeps the first twenty lines and counts every one, repeats included', () =>
  {
    const errors = decodeErrorCollector()
    for (let i = 0; i < 25; i++)
    {
      errors.push(`[h264 @ 0x1] error ${i}`)
    }
    errors.push('    Last message repeated 3 times')
    errors.push('    Last message repeated 1 times')
    errors.push('')
    errors.push('   ')
    expect(errors.lines).toHaveLength(MAX_DECODE_ERRORS)
    expect(errors.lines[0]).toBe('[h264 @ 0x1] error 0')
    expect(errors.lines[19]).toBe('[h264 @ 0x1] error 19')
    expect(errors.count()).toBe(29)
  })

  it('bounds the recorded stderr of a damaged file on both builds', () =>
  {
    for (const build of ['9.0.2', '2022'])
    {
      for (const run of ['full', 'sampled'])
      {
        const lines = stderrLines(`${build}/corrupt-${run}.stderr.txt`)
        const repeats = lines.map((line) => /Last message repeated (\d+) times/.exec(line)).filter((m) => m !== null)
        const errors = decodeErrorCollector()
        lines.forEach((line) => errors.push(line))
        expect(errors.lines).toHaveLength(MAX_DECODE_ERRORS)
        expect(errors.lines.some((line) => line.includes('Last message repeated'))).toBe(false)
        expect(errors.count()).toBe(lines.length - repeats.length + repeats.reduce((sum, m) => sum + Number(m[1]), 0))
      }
    }
  })
})

describe('verifyMedia: media files', () =>
{
  it('verifies a readable output with the planned streams, decoded in full', async () =>
  {
    const exec = fakeExec()
    const check = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(exec)))
    expect(check.verdict).toBe('verified')
    expect(check.failure).toBeNull()
    expect(check.media).toEqual({
      decode: 'full',
      decodeErrors: [],
      decodeErrorCount: 0,
      durationSec: 90,
      expectedDurationSec: 90,
      duration: 'within',
      streams: STREAMS,
      streamMatch: true,
      size: { bytes: 1000, targetBytes: null, status: 'not-checked' },
      frames: null,
      cues: null
    })
    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0].args).toEqual(decodeArgs('/w/out.part', { video: 1, audio: 2 }, null))
    expect(exec.calls[0].o.stop).toBe('kill')
    expect(exec.calls[0].o.durationSec).toBe(90)
    expect(check.decodeRun).toEqual({ args: exec.calls[0].args, exitCode: 0, exitName: null, signal: null, stderrTail: '' })
  })

  it('samples three 20-second windows of video when the setting is sampled', async () =>
  {
    const exec = fakeExec()
    const check = await checkedOf(verifyMedia(mediaTarget(), SAMPLED, deps(exec)))
    expect(check.media.decode).toBe('sampled')
    expect(exec.calls[0].args).toEqual(decodeArgs('/w/out.part', { video: 1, audio: 2 }, [0, 35, 70]))
  })

  it('still decodes in full for a placement that displaces a file, whatever the setting', async () =>
  {
    const exec = fakeExec()
    const check = await checkedOf(verifyMedia(mediaTarget(), { setting: 'sampled', displacing: true }, deps(exec)))
    expect(check.media.decode).toBe('full')
    expect(exec.calls[0].args).toEqual(decodeArgs('/w/out.part', { video: 1, audio: 2 }, null))
  })

  it('decodes in full when there is no video to sample or the output is too short', async () =>
  {
    const coverExec = fakeExec()
    const facts = probed({ video: [{ streamIndex: 0, codecName: 'mjpeg', cover: true }] })
    const cover = await checkedOf(verifyMedia(mediaTarget(), SAMPLED, deps(coverExec, { probe: async () => facts })))
    expect(cover.media.decode).toBe('full')
    expect(coverExec.calls[0].args).not.toContain('-ss')
    const short = fakeExec()
    const brief = probed({ durationSec: 45 })
    const check = await checkedOf(verifyMedia(mediaTarget({ duration: { expectedSec: 45, rule: 'tolerance' } }), SAMPLED,
      deps(short, { probe: async () => brief })))
    expect(check.media.decode).toBe('full')
    expect(short.calls[0].args).not.toContain('-ss')
  })

  it('passes a size target at exactly the target and fails one byte over', async () =>
  {
    const at = await checkedOf(verifyMedia(mediaTarget({ targetBytes: 1000 }), FULL, deps(fakeExec())))
    expect(at.verdict).toBe('verified')
    expect(at.media.size).toEqual({ bytes: 1000, targetBytes: 1000, status: 'within' })
    const over = await checkedOf(verifyMedia(mediaTarget({ targetBytes: 999 }), FULL, deps(fakeExec())))
    expect(over.verdict).toBe('outside-tolerance')
    expect(over.media.size).toEqual({ bytes: 1000, targetBytes: 999, status: 'over' })
  })

  it('keeps both durations and reports a re-encode outside the tolerance', async () =>
  {
    const facts = probed({ durationSec: 89.2 })
    const check = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec(), { probe: async () => facts })))
    expect(check.verdict).toBe('outside-tolerance')
    expect(check.media.duration).toBe('outside')
    expect(check.media.durationSec).toBe(89.2)
    expect(check.media.expectedDurationSec).toBe(90)
  })

  it('accepts a longer stream-copy trim and skips the duration check without an expectation', async () =>
  {
    const facts = probed({ durationSec: 96 })
    const copy = await checkedOf(verifyMedia(mediaTarget({ duration: { expectedSec: 90, rule: 'covers' } }), FULL,
      deps(fakeExec(), { probe: async () => facts })))
    expect(copy.verdict).toBe('verified')
    expect(copy.media.duration).toBe('within')
    const none = await checkedOf(verifyMedia(mediaTarget({ duration: null }), FULL, deps(fakeExec(), { probe: async () => facts })))
    expect(none.media.duration).toBe('not-checked')
    expect(none.media.expectedDurationSec).toBeNull()
    expect(none.verdict).toBe('verified')
  })

  it('records an unknown probed duration as null and outside, and decodes without a span', async () =>
  {
    const exec = fakeExec()
    const facts = probed({ durationSec: Number.NaN })
    const check = await checkedOf(verifyMedia(mediaTarget(), SAMPLED, deps(exec, { probe: async () => facts })))
    expect(check.media.durationSec).toBeNull()
    expect(check.media.duration).toBe('outside')
    expect(check.media.decode).toBe('full')
    expect(exec.calls[0].o.durationSec).toBeUndefined()
  })

  it('fails a stream mismatch without decoding', async () =>
  {
    const exec = fakeExec()
    const facts = probed({ audio: [audioStream(0, 1)] })
    const check = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(exec, { probe: async () => facts })))
    expect(check.verdict).toBe('failed')
    expect(check.failure).toBe('stream-mismatch')
    expect(check.media.streamMatch).toBe(false)
    expect(check.media.streams).toEqual({ video: 1, audio: 1, subtitle: 0, attachment: 0 })
    expect(check.detail).toBe('The output holds 1 video, 1 audio, 0 subtitle, and 0 attachment streams; '
      + 'the plan kept 1 video, 2 audio, 0 subtitle, and 0 attachment streams.')
    expect(exec.calls).toHaveLength(0)
  })

  it('counts subtitles and attachments against the plan', async () =>
  {
    const facts = probed({
      subtitles: [{ streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' }],
      attachments: [{ streamIndex: 4, filename: 'font.ttf', mimetype: 'font/ttf' }]
    })
    expect(streamCounts(facts)).toEqual({ video: 1, audio: 2, subtitle: 1, attachment: 1 })
    expect(describeCounts(streamCounts(facts))).toBe('1 video, 2 audio, 1 subtitle, and 1 attachment streams')
    const check = await checkedOf(verifyMedia(mediaTarget({ streams: { video: 1, audio: 2, subtitle: 1, attachment: 1 } }), FULL,
      deps(fakeExec(), { probe: async () => facts })))
    expect(check.verdict).toBe('verified')
  })

  it('fails an output that does not probe or cannot be read', async () =>
  {
    const probe = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec(), { probe: async () => { throw new Error('Invalid data found') } })))
    expect(probe.verdict).toBe('failed')
    expect(probe.failure).toBe('unreadable')
    expect(probe.detail).toBe('Invalid data found')
    expect(probe.media.size.bytes).toBe(1000)
    const stat = await checkedOf(verifyMedia(mediaTarget(), FULL,
      deps(fakeExec(), { files: fakeFiles({ size: async () => { throw new Error('ENOENT') } }) })))
    expect(stat.failure).toBe('unreadable')
    expect(stat.detail).toBe('ENOENT')
    const thrown = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec(), { probe: async () => { throw 'gone' } })))
    expect(thrown.detail).toBe('gone')
  })

  it('fails decode errors, keeping the first twenty lines and the count', async () =>
  {
    const lines = stderrLines('9.0.2/corrupt-full.stderr.txt')
    const check = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec({ lines }))))
    expect(check.verdict).toBe('failed')
    expect(check.failure).toBe('decode-errors')
    expect(check.media.decodeErrors).toEqual(lines.slice(0, 20))
    expect(check.media.decodeErrorCount).toBeGreaterThan(lines.length)
  })

  it('fails a decode check that ends badly and prints nothing', async () =>
  {
    const code = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec({ code: -22 }))))
    expect(code.failure).toBe('decode-errors')
    expect(code.media.decodeErrors).toEqual(['The decode check ended with exit code -22 (EXIT_NAME).'])
    expect(code.media.decodeErrorCount).toBe(1)
    const signal = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec({ code: null, signal: 'SIGSEGV' }))))
    expect(signal.media.decodeErrors).toEqual(['The decode check was stopped by SIGSEGV.'])
    const stopped = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec({ stopped: 'killed' }))))
    expect(stopped.media.decodeErrors).toEqual(['The decode check ended with exit code 0.'])
  })

  it('skips the decode for an output without video or audio', async () =>
  {
    const exec = fakeExec()
    const facts = probed({ video: [], audio: [], subtitles: [{ streamIndex: 0, subIndex: 0, codecName: 'subrip', bitmap: false, language: null }] })
    const check = await checkedOf(verifyMedia(mediaTarget({ streams: { video: 0, audio: 0, subtitle: 1, attachment: 0 } }), FULL,
      deps(exec, { probe: async () => facts })))
    expect(check.verdict).toBe('verified')
    expect(check.decodeRun).toBeNull()
    expect(exec.calls).toHaveLength(0)
  })

  it('reports an output larger than its source and still verifies it', async () =>
  {
    const larger = await checkedOf(verifyMedia(mediaTarget({ sourceBytes: 999 }), FULL, deps(fakeExec())))
    expect(larger.verdict).toBe('verified')
    expect(larger.largerThanSource).toBe(true)
    const same = await checkedOf(verifyMedia(mediaTarget({ sourceBytes: 1000 }), FULL, deps(fakeExec())))
    expect(same.largerThanSource).toBe(false)
  })

  it('forwards the decode progress with the probed duration', async () =>
  {
    const seen: unknown[] = []
    const exec = fakeExec({ progress: [{ outTimeSec: 30, speed: 12, totalSize: 4096, end: false }] })
    await verifyMedia(mediaTarget(), FULL, deps(exec, { progress: (p) => seen.push(p) }))
    expect(seen).toEqual([{ outTimeSec: 30, durationSec: 90, speed: 12, bytes: null }])
    const silent = fakeExec({ progress: [{ outTimeSec: 30, speed: 12, totalSize: 4096, end: false }] })
    await verifyMedia(mediaTarget(), FULL, deps(silent))
    expect(silent.calls[0].o.onProgress).toBeUndefined()
  })

  it('returns aborted when the signal aborts at any await', async () =>
  {
    const controller = new AbortController()
    const abortOnRun = fakeExec({ aborted: true, onRun: () => controller.abort() })
    expect(await verifyMedia(mediaTarget(), FULL, deps(abortOnRun, { signal: controller.signal }))).toEqual({ kind: 'aborted' })
    for (const at of ['size', 'size-throws', 'probe', 'probe-throws'])
    {
      const c = new AbortController()
      const files = fakeFiles({
        size: async () =>
        {
          if (at.startsWith('size'))
          {
            c.abort()
          }
          if (at === 'size-throws')
          {
            throw new Error('aborted')
          }
          return 1000
        }
      })
      const probe = async (): Promise<MediaFacts> =>
      {
        c.abort()
        if (at === 'probe-throws')
        {
          throw new Error('aborted')
        }
        return probed()
      }
      const exec = fakeExec()
      const result = await verifyMedia(mediaTarget(), FULL, deps(exec, { signal: c.signal, files, probe }))
      expect(result).toEqual({ kind: 'aborted' })
      expect(exec.calls).toHaveLength(0)
    }
  })
})

describe('verifyMedia: frame folders', () =>
{
  const names = (count: number, ext = 'png'): Array<{ name: string; bytes: number }> =>
    Array.from({ length: count }, (_, i) => ({ name: `frame_${String(i + 1).padStart(6, '0')}.${ext}`, bytes: 100 }))

  it('counts the images and sums their bytes', async () =>
  {
    const files = fakeFiles({ list: async () => [...names(10), { name: 'Thumbs.db', bytes: 5 }, { name: 'FRAME.PNG', bytes: 7 }] })
    const check = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/frames', extension: '.png', expectedFrames: 11 }, FULL,
      deps(fakeExec(), { files })))
    expect(check.verdict).toBe('verified')
    expect(check.media.frames).toBe(11)
    expect(check.media.size).toEqual({ bytes: 1007, targetBytes: null, status: 'not-checked' })
    expect(check.decodeRun).toBeNull()
  })

  it('accepts within one of the expected count and is outside past it', async () =>
  {
    const files = fakeFiles({ list: async () => names(9, 'jpg') })
    const near = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/f', extension: 'jpg', expectedFrames: 10 }, FULL, deps(fakeExec(), { files })))
    expect(near.verdict).toBe('verified')
    const far = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/f', extension: 'jpg', expectedFrames: 11 }, FULL, deps(fakeExec(), { files })))
    expect(far.verdict).toBe('outside-tolerance')
    expect(far.failure).toBeNull()
  })

  it('fails a folder without an image, and one that cannot be listed', async () =>
  {
    const empty = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/f', extension: 'png', expectedFrames: null }, FULL,
      deps(fakeExec(), { files: fakeFiles({ list: async () => names(3, 'jpg') }) })))
    expect(empty.verdict).toBe('failed')
    expect(empty.failure).toBe('no-frames')
    expect(empty.media.frames).toBe(0)
    const missing = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/f', extension: 'png', expectedFrames: null }, FULL,
      deps(fakeExec(), { files: fakeFiles({ list: async () => { throw new Error('ENOENT: no such folder') } }) })))
    expect(missing.failure).toBe('unreadable')
    expect(missing.detail).toBe('ENOENT: no such folder')
  })

  it('returns aborted when the listing ends after an abort', async () =>
  {
    for (const fails of [false, true])
    {
      const c = new AbortController()
      const files = fakeFiles({
        list: async () =>
        {
          c.abort()
          if (fails)
          {
            throw new Error('aborted')
          }
          return names(2)
        }
      })
      expect(await verifyMedia({ kind: 'frames', path: '/w/f', extension: 'png', expectedFrames: null }, FULL,
        deps(fakeExec(), { files, signal: c.signal }))).toEqual({ kind: 'aborted' })
    }
  })
})

describe('verifyMedia: subtitle files', () =>
{
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n'

  it('counts SRT, WebVTT, and ASS cues', async () =>
  {
    const cases: Array<[VerifyTarget, string, number]> = [
      [{ kind: 'subtitle', path: '/w/a.srt', format: 'srt' }, SRT, 2],
      [{ kind: 'subtitle', path: '/w/a.vtt', format: 'vtt' }, 'WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n', 1],
      [{ kind: 'subtitle', path: '/w/a.ass', format: 'ass' }, '[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n', 1]
    ]
    for (const [target, text, cues] of cases)
    {
      const check = await checkedOf(verifyMedia(target, FULL, deps(fakeExec(), { files: fakeFiles({ text: async () => text, size: async () => text.length }) })))
      expect(check.verdict).toBe('verified')
      expect(check.media.cues).toBe(cues)
      expect(check.media.streams).toEqual({ video: 0, audio: 0, subtitle: 1, attachment: 0 })
      expect(check.media.size.bytes).toBe(text.length)
    }
  })

  it('fails a subtitle file without a cue, one in another format, and one that cannot be read', async () =>
  {
    const none = await checkedOf(verifyMedia({ kind: 'subtitle', path: '/w/a.srt', format: 'srt' }, FULL,
      deps(fakeExec(), { files: fakeFiles({ text: async () => '\n' }) })))
    expect(none.failure).toBe('no-cues')
    expect(none.media.cues).toBe(0)
    const wrong = await checkedOf(verifyMedia({ kind: 'subtitle', path: '/w/a.vtt', format: 'vtt' }, FULL,
      deps(fakeExec(), { files: fakeFiles({ text: async () => SRT }) })))
    expect(wrong.failure).toBe('unreadable')
    expect(wrong.detail).toBe('The file is not VTT text.')
    expect(wrong.media.cues).toBeNull()
    const unread = await checkedOf(verifyMedia({ kind: 'subtitle', path: '/w/a.ass', format: 'ass' }, FULL,
      deps(fakeExec(), { files: fakeFiles({ text: async () => { throw new Error('EACCES') } }) })))
    expect(unread.failure).toBe('unreadable')
    expect(unread.detail).toBe('EACCES')
  })

  it('returns aborted when the read ends after an abort', async () =>
  {
    for (const fails of [false, true])
    {
      const c = new AbortController()
      const files = fakeFiles({
        text: async () =>
        {
          c.abort()
          if (fails)
          {
            throw new Error('aborted')
          }
          return SRT
        }
      })
      expect(await verifyMedia({ kind: 'subtitle', path: '/w/a.srt', format: 'srt' }, FULL,
        deps(fakeExec(), { files, signal: c.signal }))).toEqual({ kind: 'aborted' })
    }
  })
})

describe('toVerification and verificationError', () =>
{
  const context = { attempt: 2, encodePass: 1, at: 1234, platform: 'win32' as const }

  it('reports a media verification with no audio verdicts', async () =>
  {
    const check = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec())))
    expect(toVerification(check, 1)).toEqual({ verdict: 'verified', encodePasses: 1, audio: null, media: check.media, messages: [] })
  })

  it('names decode errors with the decode command as it ran', async () =>
  {
    const lines = ['[h264 @ 0x1] error while decoding MB 16 9', '    Last message repeated 2 times']
    const check = await checkedOf(verifyMedia(mediaTarget({ path: 'C:\\work dir\\out.part' }), FULL, deps(fakeExec({ lines }))))
    const error = verificationError(check, context)
    const argv = execArgv(decodeArgs('C:\\work dir\\out.part', { video: 1, audio: 2 }, null), 'kill')
    expect(error).toEqual({
      code: 'decode-errors',
      short: 'Decode errors',
      cause: 'decode',
      message: 'Decoding the output reported 3 errors, the first: [h264 @ 0x1] error while decoding MB 16 9',
      stage: 'verify',
      attempt: 2,
      encodePass: 1,
      exitCode: 0,
      exitName: null,
      signal: null,
      stderrTail: lines.join('\n'),
      command: { argv, display: expect.stringContaining('"C:\\work dir\\out.part"') },
      fsError: null,
      hint: null,
      at: 1234
    })
    expect(error.command?.display.startsWith('ffmpeg -hide_banner -nostdin')).toBe(true)
    const one = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec({ code: 1 }))))
    expect(verificationError(one, context).message).toBe('Decoding the output reported 1 error, the first: The decode check ended with exit code 1 (EXIT_NAME).')
  })

  it('names every other failure output-unreadable without a command', async () =>
  {
    const mismatch = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec(), { probe: async () => probed({ audio: [] }) })))
    const unreadable = await checkedOf(verifyMedia(mediaTarget(), FULL, deps(fakeExec(), { probe: async () => { throw new Error('moov atom not found') } })))
    const frames = await checkedOf(verifyMedia({ kind: 'frames', path: '/w/f', extension: 'png', expectedFrames: null }, FULL, deps(fakeExec())))
    const cues = await checkedOf(verifyMedia({ kind: 'subtitle', path: '/w/a.srt', format: 'srt' }, FULL, deps(fakeExec())))
    const expected: Array<[typeof mismatch, string, string]> = [
      [mismatch, 'Streams missing', mismatch.detail ?? ''],
      [unreadable, 'Output unreadable', 'The output could not be read back: moov atom not found'],
      [frames, 'No frames', 'The output folder holds no images.'],
      [cues, 'No subtitle cues', 'The subtitle output holds no cues.']
    ]
    for (const [check, short, message] of expected)
    {
      const error = verificationError(check, context)
      expect(error.code).toBe('output-unreadable')
      expect(error.short).toBe(short)
      expect(error.message).toBe(message)
      expect(error.cause).toBeNull()
      expect(error.command).toBeNull()
      expect(error.stderrTail).toBe('')
      expect(error.exitCode).toBeNull()
    }
  })

  it('words a failure that kept no detail or no line', () =>
  {
    const media = { ...probedMedia(), decodeErrorCount: 4 }
    const base = { kind: 'checked' as const, verdict: 'failed' as const, media, detail: null, decodeRun: null, largerThanSource: false }
    expect(verificationError({ ...base, failure: 'unreadable' }, context).message).toBe('The output could not be read back.')
    expect(verificationError({ ...base, failure: 'stream-mismatch' }, context).message).toBe('The output does not hold the streams the plan kept.')
    expect(verificationError({ ...base, failure: 'decode-errors' }, context).message).toBe('Decoding the output reported 4 errors, the first: none kept')
    expect(verificationError({ ...base, failure: null }, context).short).toBe('Output unreadable')
  })
})

function probedMedia(): Extract<MediaCheck, { kind: 'checked' }>['media']
{
  return {
    decode: 'full',
    decodeErrors: [],
    decodeErrorCount: 0,
    durationSec: null,
    expectedDurationSec: null,
    duration: 'not-checked',
    streams: { video: 0, audio: 0, subtitle: 0, attachment: 0 },
    streamMatch: true,
    size: { bytes: 0, targetBytes: null, status: 'not-checked' },
    frames: null,
    cues: null
  }
}

describe('nodeVerifyFiles', () =>
{
  it('reads sizes, text, and the files of a folder on disk', async () =>
  {
    const root = mkdtempSync(join(tmpdir(), 'verify-media-'))
    try
    {
      const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n'
      writeFileSync(join(root, 'a.srt'), srt)
      writeFileSync(join(root, 'f1.png'), Buffer.alloc(10))
      mkdirSync(join(root, 'nested'))
      expect(await nodeVerifyFiles.size(join(root, 'f1.png'))).toBe(10)
      expect(countCues(await nodeVerifyFiles.text(join(root, 'a.srt')), 'srt')).toBe(1)
      const listed = await nodeVerifyFiles.list(root)
      expect(listed.sort((a, b) => a.name.localeCompare(b.name)))
        .toEqual([{ name: 'a.srt', bytes: Buffer.byteLength(srt) }, { name: 'f1.png', bytes: 10 }])
    }
    finally
    {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
