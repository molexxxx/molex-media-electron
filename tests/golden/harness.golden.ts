import { describe, it, expect, inject } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { CORPUS, NON_ASCII_NAME } from './corpus'
import { annex3Combine, annex3Weight, createOracle, LAYOUT_CHANNELS, parseAstatsOverall, parseEbur128Summaries, parseMetadataPrints, readLoudness, runTool, sampleStatsOf, summarizeProbe } from './oracle'
import { channelTruePeak, deinterleave, phaseFilters, toDb, truePeakDb, TRUE_PEAK_TAPS } from './truepeak'
import { band, decodeAnalysis, fft, imd, smpteSource, spectrum, thd } from './distortion'
import { buildIdOf, goldenRoot, resolveBinaries, runFolderName, SKIP_MESSAGE, STALE_RUN_MS, sweepStaleRuns } from './global-setup'

const golden = inject('golden')

function sine(n: number, cyclesPerSample: number, phase: number, amplitude: number): Float64Array
{
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(2 * Math.PI * cyclesPerSample * i + phase)
  return out
}

/** Raised-cosine fades at both ends, so the band-limited edges add no overshoot of their own. */
function faded(x: Float64Array, fade = 960): Float64Array
{
  const out = Float64Array.from(x)
  for (let i = 0; i < fade; i++)
  {
    const g = 0.5 - 0.5 * Math.cos(Math.PI * i / fade)
    out[i] *= g
    out[out.length - 1 - i] *= g
  }
  return out
}

const SUMMARY_2022 = [
  '[Parsed_ebur128_0 @ 000001] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -70.0 LUFS',
  '    Threshold:   0.0 LUFS',
  '',
  '  Loudness range:',
  '    LRA:         0.0 LU',
  '    Threshold:   0.0 LUFS',
  '    LRA low:     0.0 LUFS',
  '    LRA high:    0.0 LUFS',
  '[ebur128@o @ 000002] [info] Summary:\r',
  '\r',
  '  Integrated loudness:\r',
  '    I:         -70.0 LUFS\r',
  '    Threshold:   0.0 LUFS\r',
  '\r',
  '  Loudness range:\r',
  '    LRA:         0.0 LU\r',
  '    Threshold:   0.0 LUFS\r',
  '    LRA low:     0.0 LUFS\r',
  '    LRA high:    0.0 LUFS\r',
  '[ametadata@i @ 000003] frame:0    pts:0       pts_time:0',
  '[ametadata@i @ 000003] lavfi.r128.I=-23.456',
  '[ametadata@s @ 000004] lavfi.r128.S=-17.5',
  '[ametadata@s @ 000004] lavfi.r128.S=-120.691',
  '[ametadata@lra @ 000005] lavfi.r128.LRA=4.250',
  '[ebur128@o @ 000002] [info] Summary:\r',
  '\r',
  '  Integrated loudness:\r',
  '    I:         -23.5 LUFS\r',
  '    Threshold: -33.6 LUFS\r',
  '\r',
  '  Loudness range:\r',
  '    LRA:         4.3 LU\r',
  '    Threshold: -43.6 LUFS\r',
  '    LRA low:   -26.1 LUFS\r',
  '    LRA high:  -21.8 LUFS\r',
  '\r',
  '  Sample peak:\r',
  '    Peak:       -inf dBFS\r',
  '\r',
  '  True peak:\r',
  '    Peak:        -1.2 dBFS\r',
  '[out#0/null @ 000006] video:0KiB audio:861KiB'
].join('\n')

describe('oracle parsers', () =>
{
  it('reads the last summary block of each ebur128 instance', () =>
  {
    const blocks = parseEbur128Summaries(SUMMARY_2022)
    expect([...blocks.keys()]).toEqual(['Parsed_ebur128_0', 'ebur128@o'])
    expect(blocks.get('ebur128@o')).toEqual({
      integrated: -23.5, threshold: -33.6, lra: 4.3, lraThreshold: -43.6, lraLow: -26.1, lraHigh: -21.8, samplePeak: -Infinity, truePeak: -1.2
    })
  })

  it('reads per-frame metadata and combines it with the summary', () =>
  {
    expect(parseMetadataPrints(SUMMARY_2022).get('ametadata@s')?.get('lavfi.r128.S')).toEqual([-17.5, -120.691])
    const reading = readLoudness(SUMMARY_2022)
    expect(reading).toMatchObject({ integrated: -23.5, integratedPrecise: -23.456, lraPrecise: 4.25, shortTermMax: -17.5, frames: 1 })
    expect(() => readLoudness('[x @ 1] nothing')).toThrow('no summary block')
  })

  it('reads astats overall values and ffprobe summaries', () =>
  {
    expect(parseAstatsOverall('[astats@o @ 1] Overall\n[astats@o @ 1] Peak level dB: 2.597317\n[astats@o @ 1] Flat factor: 0.000000\n[other @ 2] Peak level dB: 9'))
      .toEqual({ 'Peak level dB': 2.597317, 'Flat factor': 0 })
    const summary = summarizeProbe(JSON.stringify({
      format: { format_name: 'matroska,webm', duration: '10.000000', tags: { title: 'Golden Clip' } },
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'ac3', channels: 6, channel_layout: '5.1(side)', sample_rate: '48000', tags: { LANGUAGE: 'jpn' }, disposition: { default: 0 } },
        { index: 1, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'molex-test.ttf', mimetype: 'application/x-truetype-font' } }
      ],
      chapters: [{ start_time: '0.000000', end_time: '5.000000', tags: { title: 'Part One' } }]
    }))
    expect(summary.durationSec).toBe(10)
    expect(summary.streams[0]).toMatchObject({ codec: 'ac3', channels: 6, layout: '5.1(side)', sampleRate: 48000, language: 'jpn', default: false })
    expect(summary.streams[1]).toMatchObject({ type: 'attachment', filename: 'molex-test.ttf', mimetype: 'application/x-truetype-font' })
    expect(summary.chapters).toEqual([{ startSec: 0, endSec: 5, title: 'Part One' }])
  })

  it('weights channels per BS.1770 Annex 3', () =>
  {
    const l71 = LAYOUT_CHANNELS['7.1']
    expect(l71.map((c) => annex3Weight(c, l71))).toEqual([1, 1, 1, 0, 1, 1, 1.41, 1.41])
    const l51 = LAYOUT_CHANNELS['5.1']
    expect(l51.map((c) => annex3Weight(c, l51))).toEqual([1, 1, 1, 0, 1.41, 1.41])
    const hex = LAYOUT_CHANNELS.hexagonal
    expect(hex.map((c) => annex3Weight(c, hex))).toEqual([1, 1, 1, 1.41, 1.41, 1])
    const equal = l71.map((channel) => ({ channel, lufs: channel === 'LFE' ? -70 : -30 }))
    expect(annex3Combine(equal, l71)).toBeCloseTo(-30 + 10 * Math.log10(7.82), 6)
  })

  it('computes sample statistics and channel differences', () =>
  {
    const stats = sampleStatsOf([Float64Array.from([0.5, -1, 1.25]), Float64Array.from([0.5, -1, 1.25])])
    expect(stats).toMatchObject({ channels: 2, frames: 3, over0dBFS: 2, atFullScale: 4, maxChannelDifference: 0 })
    expect(stats.peakDb).toBeCloseTo(toDb(1.25), 9)
  })
})

describe('true-peak interpolator', () =>
{
  it('has seven phases of 97 taps, each at unity gain', () =>
  {
    const filters = phaseFilters()
    expect(filters.length).toBe(7 * TRUE_PEAK_TAPS)
    for (let p = 0; p < 7; p++)
    {
      let sum = 0
      for (let j = 0; j < TRUE_PEAK_TAPS; j++) sum += filters[p * TRUE_PEAK_TAPS + j]
      expect(sum).toBeCloseTo(1, 12)
    }
  })

  it('finds the peak of an fs/4 sine sampled at 45 degrees', () =>
  {
    const x = faded(sine(9600, 0.25, Math.PI / 4, 0.5))
    expect(toDb(Math.max(...x.map(Math.abs)))).toBeCloseTo(toDb(0.5 * Math.SQRT1_2), 6)
    expect(Math.abs(toDb(channelTruePeak(x)) - toDb(0.5))).toBeLessThan(0.01)
  })

  it('finds peaks that fall between samples at other phases', () =>
  {
    for (const [cycles, phase] of [[0.1, 0.3], [0.37, 1.1], [1 / 6, Math.PI / 6]] as const)
    {
      const x = faded(sine(9600, cycles, phase, 0.8))
      expect(Math.abs(toDb(channelTruePeak(x)) - toDb(0.8)), `${cycles}`).toBeLessThan(0.07)
    }
  })

  it('overshoots an abrupt onset like a band-limited reference does', () =>
  {
    const abrupt = sine(9600, 0.25, Math.PI / 4, 0.5)
    expect(toDb(channelTruePeak(abrupt)) - toDb(0.5)).toBeGreaterThan(0.05)
  })

  it('reads a faded constant and silence, and reports per channel', () =>
  {
    const dc = faded(new Float64Array(4000).fill(0.25))
    const r = truePeakDb([dc, new Float64Array(2000)])
    expect(r.perChannel[0]).toBeCloseTo(toDb(0.25), 2)
    expect(r.perChannel[1]).toBe(-Infinity)
    expect(r.dbtp).toBe(r.perChannel[0])
  })

  it('splits interleaved f64 PCM into channels', () =>
  {
    const bytes = new Uint8Array(Float64Array.from([1, 2, 3, 4, 5, 6, 7]).buffer)
    expect(deinterleave(bytes, 2).map((c) => [...c])).toEqual([[1, 3, 5], [2, 4, 6]])
  })
})

describe('distortion meters', () =>
{
  it('transforms a sine into a single bin', () =>
  {
    const n = 1024
    const re = sine(n, 64 / n, 0, 1)
    const im = new Float64Array(n)
    fft(re, im)
    expect(Math.hypot(re[64], im[64])).toBeCloseTo(n / 2, 6)
    expect(Math.hypot(re[63], im[63])).toBeLessThan(1e-6)
  })

  it('measures known SMPTE intermodulation and harmonic distortion', () =>
  {
    const rate = 48000
    const n = 65536
    const x = new Float64Array(n)
    const sideAmp = 0.2 * 10 ** (-40 / 20)
    for (let i = 0; i < n; i++)
    {
      const t = i / rate
      x[i] = 0.8 * Math.sin(2 * Math.PI * 60 * t) + 0.2 * Math.sin(2 * Math.PI * 7000 * t) +
        sideAmp * Math.sin(2 * Math.PI * 7060 * t)
    }
    expect(imd(spectrum(x, rate))).toBeCloseTo(-40, 1)
    const clean = new Float64Array(n)
    for (let i = 0; i < n; i++) clean[i] = 0.8 * Math.sin(2 * Math.PI * 60 * i / rate) + 0.2 * Math.sin(2 * Math.PI * 7000 * i / rate)
    expect(imd(spectrum(clean, rate))).toBeLessThan(-100)
    const tone = new Float64Array(n)
    for (let i = 0; i < n; i++) tone[i] = Math.sin(2 * Math.PI * 50 * i / rate) + 0.01 * Math.sin(2 * Math.PI * 150 * i / rate)
    const s = spectrum(tone, rate)
    expect(thd(s, 50).thdDb).toBeCloseTo(-40, 1)
    expect(band(s, 50)).toBeGreaterThan(band(s, 150))
  })
})

describe('golden setup', () =>
{
  it('skips with a fixed message when no build is found', () =>
  {
    expect(SKIP_MESSAGE).toBe('No FFmpeg: set MOLEX_FFMPEG_DIR or put ffmpeg and ffprobe on PATH')
    expect(resolveBinaries({ PATH: '' })).toBeNull()
    expect(() => resolveBinaries({ MOLEX_FFMPEG_DIR: join(tmpdir(), 'molex-golden-no-such-dir') })).toThrow('MOLEX_FFMPEG_DIR')
  })

  it('keeps outputs out of the repository and names build folders safely', () =>
  {
    expect(() => goldenRoot({ MOLEX_GOLDEN_OUT: resolve('tests/golden/out') })).toThrow('outside the repository')
    expect(goldenRoot({})).toBe(resolve(join(tmpdir(), 'molex-golden')))
    expect(buildIdOf('n9.0.2-17-g2a571b6068-20260930')).toBe('n9.0.2-17-g2a571b6068-20260930')
    expect(buildIdOf('4.4.2-0ubuntu0.22.04.1 (x)')).toBe('4.4.2-0ubuntu0.22.04.1_x_')
  })

  it('gives each run its own short output folder and sweeps only stale ones', async () =>
  {
    expect(runFolderName(4120)).toBe('run-4120')
    expect(golden.skip !== null || (basename(golden.outDir).startsWith('run-') && basename(dirname(golden.outDir)) === 'out')).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'molex-sweep-'))
    try
    {
      await mkdir(join(root, 'run-1'))
      await mkdir(join(root, 'run-2'))
      const old = new Date(Date.now() - STALE_RUN_MS - 60_000)
      await utimes(join(root, 'run-1'), old, old)
      expect(await sweepStaleRuns(root, Date.now() - STALE_RUN_MS)).toEqual(['run-1'])
      expect(await readdir(root)).toEqual(['run-2'])
      expect(await sweepStaleRuns(join(root, 'missing'), Date.now())).toEqual([])
    }
    finally
    {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(Boolean(golden.skip))('golden corpus', () =>
{
  const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })

  it('lives under the golden root of this build, outside the repository', () =>
  {
    const root = resolve(process.env.MOLEX_GOLDEN_OUT?.trim() || join(tmpdir(), 'molex-golden'))
    expect(golden.corpusDir.startsWith(join(root, golden.buildId))).toBe(true)
    const rel = relative(resolve('.'), golden.corpusDir)
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true)
  })

  it('has 29 inputs plus the 32 kHz and non-ASCII copies', () =>
  {
    expect(CORPUS.filter((e) => !e.copy)).toHaveLength(29)
    expect(CORPUS.filter((e) => e.copy).map((e) => e.name)).toEqual(['mono_speech32k.wav', NON_ASCII_NAME])
    for (const entry of CORPUS)
    {
      if (golden.missing[entry.name]) continue
      expect(existsSync(golden.corpus[entry.name]), entry.name).toBe(true)
    }
  })

  it.each(CORPUS.map((e) => [e.name, e] as const))('%s has the expected streams', async (name, entry) =>
  {
    if (golden.missing[name]) return
    const summary = await oracle.probe(golden.corpus[name])
    const audio = summary.streams.filter((s) => s.type === 'audio')
    expect(audio.map((s) => s.channels)).toEqual(entry.shape.channels)
    if (entry.shape.layouts) expect(audio.map((s) => s.layout)).toEqual(entry.shape.layouts)
    if (entry.shape.sampleRate) expect(audio[0].sampleRate).toBe(entry.shape.sampleRate)
    expect(summary.streams.filter((s) => s.type === 'video')).toHaveLength(entry.shape.video ?? 0)
    expect(summary.streams.filter((s) => s.type === 'subtitle')).toHaveLength(entry.shape.subtitles ?? 0)
    expect(summary.streams.filter((s) => s.type === 'attachment')).toHaveLength(entry.shape.attachments ?? 0)
    expect(summary.chapters).toHaveLength(entry.shape.chapters ?? 0)
  })
})

describe.skipIf(Boolean(golden.skip))('golden build', () =>
{
  it('reports its version, encoders, and self-test', () =>
  {
    expect(golden.versionString.length).toBeGreaterThan(0)
    expect(golden.buildId).toBe(buildIdOf(golden.versionString))
    expect(golden.encoders).toContain('flac')
    expect(Object.keys(golden.selfTest).sort()).toEqual(['chain-aac-mono', 'chain-flac-s16', 'chain-opus-51side', 'encoders', 'meter-dual-mono', 'soxr'])
    if (golden.meetsMinimum)
    {
      expect(golden.minimumMessage).toBeNull()
      expect(Object.entries(golden.selfTest).filter(([id, ok]) => !ok && id !== 'soxr')).toEqual([])
    }
    else
    {
      expect(golden.minimumMessage).toMatch(/^FFmpeg 5\.1 or newer is required; found /)
    }
  })
})

describe.skipIf(Boolean(golden.skip) || !golden.meetsMinimum)('oracle on the corpus', () =>
{
  const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
  const file = (name: string): string => golden.corpus[name]
  const out = (name: string): string => join(golden.outDir, name)

  async function ffmpeg(args: readonly string[]): Promise<void>
  {
    const run = await runTool(golden.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args])
    expect(run.code, run.stderr).toBe(0)
  }

  async function encode(input: string, output: string, codec: readonly string[]): Promise<string>
  {
    await ffmpeg(['-i', input, ...codec, output])
    return output
  }

  it.each([
    ['loudmaster.wav', -8, 0.4],
    ['music4410.flac', -14, 0.3],
    ['mono_speech.wav', -24, 0.1],
    ['clip1500ms.wav', -20, 0.2],
    ['shortform30.wav', -36.2, 0.1]
  ] as const)('%s measures near its target', async (name, target, tolerance) =>
  {
    const r = await oracle.loudness(file(name))
    expect(Math.abs((r.integratedPrecise ?? NaN) - target)).toBeLessThan(tolerance)
    expect(Math.abs(r.integrated - (r.integratedPrecise ?? NaN))).toBeLessThanOrEqual(0.051)
  })

  it('reads the short-term maximum and the gate on short and silent inputs', async () =>
  {
    const loudEnding = await oracle.loudness(file('shortform30.wav'))
    expect(loudEnding.shortTermMax).toBeGreaterThan(-31.2)
    expect(loudEnding.shortTermMax).toBeLessThan(-30.1)
    expect(loudEnding.frames).toBeGreaterThanOrEqual(299)
    const tiny = await oracle.loudness(file('clip300ms.wav'))
    expect(tiny.integrated).toBe(-70)
    const silent = await oracle.loudness(file('silence.wav'))
    expect(silent.integrated).toBe(-70)
    expect(silent.samplePeak).toBe(-Infinity)
  })

  it('reads mono as one channel and, with dualmono, 3.01 LU louder', async () =>
  {
    const one = await oracle.loudness(file('mono_speech.wav'))
    const dual = await oracle.loudness(file('mono_speech.wav'), { dualmono: true })
    expect((dual.integratedPrecise ?? NaN) - (one.integratedPrecise ?? NaN)).toBeCloseTo(3.01, 1)
  })

  it('reads float sample statistics', async () =>
  {
    const square = await oracle.sampleStats(file('square_clip.wav'))
    expect(square.peakDb).toBeCloseTo(toDb(0.99), 2)
    expect(square.over0dBFS).toBe(0)
    expect(square.maxChannelDifference).toBe(0)
    const isp = await oracle.sampleStats(file('isp_fs4.wav'))
    expect(isp.peakDb).toBeCloseTo(-0.51, 1)
    const silent = await oracle.sampleStats(file('silence.wav'))
    expect(silent.peakDb).toBe(-Infinity)
    expect(silent.frames).toBe(480000)
  })

  describe.skipIf(!golden.soxr)('interpolator against soxr 8x', () =>
  {
    const probes: Array<readonly [string, () => Promise<string>]> = [
      ['isp_fs4.wav', async () => file('isp_fs4.wav')],
      ['square_clip.wav', async () => file('square_clip.wav')],
      ['loudmaster.wav', async () => file('loudmaster.wav')],
      ['music4410.flac', async () => file('music4410.flac')],
      ['an AAC 128k output', () => encode(file('music4410.flac'), out('probe_aac128.m4a'), ['-c:a', 'aac', '-b:a', '128k'])],
      ['a 5.1 AC-3 448k output', () => encode(file('surround51_s24.wav'), out('probe_ac3_448.ac3'), ['-c:a', 'ac3', '-b:a', '448k'])]
    ]

    it.each(probes)('agrees within 0.1 dB on %s', async (_, make) =>
    {
      const target = await make()
      const [soxr, interpolated] = await Promise.all([oracle.truePeakSoxr(target), oracle.truePeakInterpolated(target)])
      expect(Math.abs(interpolated.dbtp - soxr.dbtp), `soxr ${soxr.dbtp} interpolator ${interpolated.dbtp}`).toBeLessThanOrEqual(0.1)
      expect((await oracle.truePeak(target)).method).toBe('soxr')
    })

    it('reads the build-independent probe signals at their recorded values', async () =>
    {
      expect((await oracle.truePeakSoxr(file('isp_fs4.wav'))).dbtp).toBeCloseTo(2.597, 2)
      expect((await oracle.truePeakSoxr(file('square_clip.wav'))).dbtp).toBeCloseTo(2.194, 2)
    })
  })

  it('combines per-channel readings with Annex 3 weights', async () =>
  {
    const meter = async (name: string): Promise<{ ffmpeg: number; reference: number }> =>
    {
      const [whole, annex] = await Promise.all([oracle.loudness(file(name)), oracle.annex3(file(name))])
      return { ffmpeg: whole.integratedPrecise ?? NaN, reference: annex.reference }
    }
    const eq71 = await meter('eq71.wav')
    expect(eq71.ffmpeg - eq71.reference).toBeCloseTo(10 * Math.log10(8.64 / 7.82), 1)
    const rear71 = await meter('rear71.wav')
    expect(rear71.ffmpeg - rear71.reference).toBeCloseTo(10 * Math.log10(1.41), 1)
    for (const name of ['eq61.wav', 'hexagonal.wav'])
    {
      const m = await meter(name)
      expect(m.ffmpeg - m.reference, name).toBeCloseTo(10 * Math.log10(7.23 / 6.82), 1)
    }
  })

  it('decodes every corpus file without an error line', async () =>
  {
    for (const name of Object.keys(golden.corpus))
    {
      const check = await oracle.decodeCheck(file(name))
      expect(check, name).toEqual({ code: 0, errors: [] })
    }
  })

  it('hashes decoded audio', async () =>
  {
    const a = await oracle.md5(file('silence.wav'))
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await oracle.md5(file('silence.wav'))).toBe(a)
    expect(await oracle.md5(file(NON_ASCII_NAME))).toBe(await oracle.md5(file('music4410.flac')))
  })

  it('summarizes streams, attachments, cover art, and chapters', async () =>
  {
    const mkv = await oracle.probe(file('video_multi.mkv'))
    const audio = mkv.streams.filter((s) => s.type === 'audio')
    expect(audio.map((s) => [s.codec, s.language, s.title, s.default])).toEqual([['aac', 'eng', 'Main Mix', true], ['ac3', 'jpn', 'Commentary 5.1', false]])
    expect(mkv.streams.find((s) => s.type === 'subtitle')?.codec).toBe('subrip')
    expect(mkv.streams.find((s) => s.type === 'attachment')?.filename).toBe('molex-test.ttf')
    expect(mkv.chapters.map((c) => c.title)).toEqual(['Part One', 'Part Two'])
    const mp4 = await oracle.probe(file('video_multi.mp4'))
    expect(mp4.streams.find((s) => s.type === 'subtitle')?.codec).toBe('mov_text')
    for (const name of ['cover.mp3', 'cover.flac', 'cover.m4a'])
    {
      const cover = await oracle.probe(file(name))
      expect(cover.streams.find((s) => s.type === 'video')?.attachedPic, name).toBe(true)
    }
    expect((await oracle.audioStream(file('dts51.mkv'))).codec).toBe('dts')
  })

  it.each([60, 30])('measures a clean %i Hz SMPTE signal far below -50 dB IMD', async (lowHz) =>
  {
    const target = out(`smpte_${lowHz}.wav`)
    await ffmpeg(['-f', 'lavfi', '-i', smpteSource({ lowHz }), '-c:a', 'pcm_f32le', target])
    expect(imd(spectrum(await decodeAnalysis(golden.ffmpeg, target)), { lowHz })).toBeLessThan(-90)
  })
})
