/**
 * Independent meters for the golden suite: an ebur128 parser that reads each instance's last summary block,
 * a true-peak reference chosen by capability (soxr 8x when the build has libsoxr, otherwise the in-repo
 * interpolator), float sample statistics, decode checks, and ffprobe summaries. Nothing here imports the app.
 */
import { spawn } from 'node:child_process'
import { decodeF64, interpolatedTruePeak, toDb } from './truepeak'

/** The output of one tool run. */
export interface ToolRun
{
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Runs a tool hidden with an argv array and resolves on exit, whatever the code. */
export function runTool(bin: string, args: readonly string[]): Promise<ToolRun>
{
  const started = Date.now()
  return new Promise((resolve, reject) =>
  {
    const child = spawn(bin, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      ms: Date.now() - started
    }))
  })
}

/** Converts CRLF and lone CR line breaks to LF. */
export function lf(text: string): string
{
  return text.replace(/\r\n?/g, '\n')
}

/** One ebur128 summary block. Values FFmpeg prints as -inf or nan read as -Infinity or NaN. */
export interface Ebur128Summary
{
  integrated: number
  threshold: number
  lra: number
  lraThreshold: number
  lraLow: number
  lraHigh: number
  /** Present with `peak=sample`. */
  samplePeak: number | null
  /** Present with `peak=true` (4x oversampled). */
  truePeak: number | null
}

const PREFIXED = /^\[([^\]\s]+) @ [^\]]+\]\s*(?:\[[a-z]+\]\s*)?(.*)$/
const SUMMARY_FIELD = /^\s*(I|Threshold|LRA|LRA low|LRA high|Peak):\s*(\S+)/

function num(text: string): number
{
  if (/^-inf/i.test(text)) return -Infinity
  if (/^\+?inf/i.test(text)) return Infinity
  return Number.parseFloat(text)
}

/**
 * Reads every ebur128 summary block in a stderr log, keyed by filter instance name. When an instance printed
 * more than one block, the last one wins.
 */
export function parseEbur128Summaries(stderr: string): Map<string, Ebur128Summary>
{
  const blocks = new Map<string, Ebur128Summary>()
  const lines = lf(stderr).split('\n')
  for (let i = 0; i < lines.length; i++)
  {
    const head = PREFIXED.exec(lines[i])
    if (!head || head[2].trim() !== 'Summary:') continue
    const block: Ebur128Summary = { integrated: NaN, threshold: NaN, lra: NaN, lraThreshold: NaN, lraLow: NaN, lraHigh: NaN, samplePeak: null, truePeak: null }
    let section = ''
    let j = i + 1
    for (; j < lines.length && (lines[j] === '' || lines[j].startsWith(' ')); j++)
    {
      const line = lines[j].trim()
      if (line.endsWith(':') && !SUMMARY_FIELD.test(line))
      {
        section = line.slice(0, -1)
        continue
      }
      const field = SUMMARY_FIELD.exec(line)
      if (!field) continue
      const value = num(field[2])
      if (section === 'Integrated loudness' && field[1] === 'I') block.integrated = value
      else if (section === 'Integrated loudness' && field[1] === 'Threshold') block.threshold = value
      else if (section === 'Loudness range' && field[1] === 'LRA') block.lra = value
      else if (section === 'Loudness range' && field[1] === 'Threshold') block.lraThreshold = value
      else if (section === 'Loudness range' && field[1] === 'LRA low') block.lraLow = value
      else if (section === 'Loudness range' && field[1] === 'LRA high') block.lraHigh = value
      else if (section === 'Sample peak' && field[1] === 'Peak') block.samplePeak = value
      else if (section === 'True peak' && field[1] === 'Peak') block.truePeak = value
    }
    blocks.set(head[1], block)
    i = j - 1
  }
  return blocks
}

/** The per-frame `lavfi.r128.*` values an `ametadata=mode=print` instance logged, keyed by instance then key. */
export function parseMetadataPrints(stderr: string): Map<string, Map<string, number[]>>
{
  const out = new Map<string, Map<string, number[]>>()
  for (const line of lf(stderr).split('\n'))
  {
    const m = PREFIXED.exec(line)
    if (!m) continue
    const kv = /^(lavfi\.r128\.[\w.]+)=(\S+)$/.exec(m[2].trim())
    if (!kv) continue
    let keys = out.get(m[1])
    if (!keys)
    {
      keys = new Map()
      out.set(m[1], keys)
    }
    const values = keys.get(kv[1]) ?? []
    values.push(num(kv[2]))
    keys.set(kv[1], values)
  }
  return out
}

/** One loudness reading: the summary block plus three-decimal values from the per-frame metadata. */
export interface LoudnessReading extends Ebur128Summary
{
  /** The last frame's `lavfi.r128.I`; null when no frame carried one. */
  integratedPrecise: number | null
  /** The last frame's `lavfi.r128.LRA`. */
  lraPrecise: number | null
  /** The largest `lavfi.r128.S` (short-term loudness); -120.691 before 3 s of signal. */
  shortTermMax: number | null
  /** Frames that carried metadata (one per 100 ms). */
  frames: number
}

/** Options for a loudness reading. */
export interface LoudnessOptions
{
  /** Audio stream index (`0:a:<stream>`); default 0. */
  stream?: number
  /** Measure a mono stream as two identical channels (`dualmono=true`). */
  dualmono?: boolean
  /** A filter chain run before the meter, such as `pan=mono|c0=c0`. */
  filter?: string
}

function last(values: readonly number[] | undefined): number | null
{
  return values && values.length > 0 ? values[values.length - 1] : null
}

/** The ebur128 graph and output maps for one reading of `0:a:<stream>`. */
export function loudnessArgs(file: string, o: LoudnessOptions = {}): string[]
{
  const pre = o.filter ? `${o.filter},` : ''
  const meter = `ebur128@o=peak=true+sample:metadata=1${o.dualmono ? ':dualmono=true' : ''}`
  const prints = ['I', 'S', 'LRA'].map((k) => `ametadata@${k.toLowerCase()}=mode=print:key=lavfi.r128.${k}`).join(',')
  return ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-i', file,
    '-filter_complex', `[0:a:${o.stream ?? 0}]${pre}${meter},${prints}[m]`, '-map', '[m]', '-f', 'null', '-']
}

/** Turns one loudness run's stderr into a reading; throws when the summary block is missing. */
export function readLoudness(stderr: string): LoudnessReading
{
  const block = parseEbur128Summaries(stderr).get('ebur128@o')
  if (!block) throw new Error('ebur128 printed no summary block')
  const prints = parseMetadataPrints(stderr)
  const i = prints.get('ametadata@i')?.get('lavfi.r128.I')
  const s = prints.get('ametadata@s')?.get('lavfi.r128.S')
  const lra = prints.get('ametadata@lra')?.get('lavfi.r128.LRA')
  return {
    ...block,
    integratedPrecise: last(i),
    lraPrecise: last(lra),
    shortTermMax: s && s.length > 0 ? s.reduce((a, b) => Math.max(a, b), -Infinity) : null,
    frames: i?.length ?? 0
  }
}

/** Reads the `Key: value` lines an `astats@o` instance with `measure_perchannel=none` printed; the last value wins. */
export function parseAstatsOverall(stderr: string): Record<string, number>
{
  const out: Record<string, number> = {}
  for (const line of lf(stderr).split('\n'))
  {
    const m = PREFIXED.exec(line)
    if (!m || m[1] !== 'astats@o') continue
    const kv = /^([A-Za-z][\w ()/-]*?):\s+(\S+)\s*$/.exec(m[2].trim())
    if (kv) out[kv[1]] = num(kv[2])
  }
  return out
}

/** One stream as the oracle's ffprobe summary reports it. */
export interface StreamSummary
{
  index: number
  type: string
  codec: string
  channels: number | null
  layout: string | null
  sampleRate: number | null
  language: string | null
  title: string | null
  /** An attachment's file name tag. */
  filename: string | null
  mimetype: string | null
  default: boolean
  forced: boolean
  attachedPic: boolean
}

/** A file as the oracle's ffprobe summary reports it. */
export interface ProbeSummary
{
  format: string
  durationSec: number | null
  tags: Record<string, string>
  streams: StreamSummary[]
  chapters: Array<{ startSec: number; endSec: number; title: string | null }>
}

interface RawProbe
{
  format?: { format_name?: string; duration?: string; tags?: Record<string, string> }
  streams?: Array<{
    index: number
    codec_type?: string
    codec_name?: string
    channels?: number
    channel_layout?: string
    sample_rate?: string
    tags?: Record<string, string>
    disposition?: Record<string, number>
  }>
  chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>
}

function tag(tags: Record<string, string> | undefined, name: string): string | null
{
  if (!tags) return null
  const key = Object.keys(tags).find((k) => k.toLowerCase() === name)
  return key === undefined ? null : tags[key]
}

/** Turns ffprobe JSON (`-show_streams -show_chapters -show_format`) into a summary. */
export function summarizeProbe(json: string): ProbeSummary
{
  const raw = JSON.parse(json) as RawProbe
  const duration = Number.parseFloat(raw.format?.duration ?? '')
  return {
    format: raw.format?.format_name ?? '',
    durationSec: Number.isFinite(duration) ? duration : null,
    tags: raw.format?.tags ?? {},
    streams: (raw.streams ?? []).map((s) => ({
      index: s.index,
      type: s.codec_type ?? '',
      codec: s.codec_name ?? '',
      channels: s.channels ?? null,
      layout: s.channel_layout ?? null,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : null,
      language: tag(s.tags, 'language'),
      title: tag(s.tags, 'title'),
      filename: tag(s.tags, 'filename'),
      mimetype: tag(s.tags, 'mimetype'),
      default: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
      attachedPic: s.disposition?.attached_pic === 1
    })),
    chapters: (raw.chapters ?? []).map((c) => ({
      startSec: Number(c.start_time),
      endSec: Number(c.end_time),
      title: tag(c.tags, 'title')
    }))
  }
}

/** Channel names in FFmpeg order for the named layouts the corpus and the pipeline use. */
export const LAYOUT_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  'mono': ['FC'],
  'stereo': ['FL', 'FR'],
  '2.1': ['FL', 'FR', 'LFE'],
  '3.0': ['FL', 'FR', 'FC'],
  '3.0(back)': ['FL', 'FR', 'BC'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  'quad': ['FL', 'FR', 'BL', 'BR'],
  'quad(side)': ['FL', 'FR', 'SL', 'SR'],
  '3.1': ['FL', 'FR', 'FC', 'LFE'],
  '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'],
  '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'],
  'hexagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'],
  '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'],
  '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
  '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  'octagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR']
}

/**
 * The ITU-R BS.1770 Annex 3 weight of a channel in a layout: 0 for LFE, 1.41 for loudspeakers at 60 to 120
 * degrees azimuth (side pairs, wide pairs, and a back pair that is the only surround pair), and 1.0 for the rest,
 * a back pair at 135 to 150 degrees behind a side pair included.
 */
export function annex3Weight(channel: string, layout: readonly string[]): number
{
  if (channel === 'LFE' || channel === 'LFE2') return 0
  if (channel === 'SL' || channel === 'SR' || channel === 'WL' || channel === 'WR') return 1.41
  if (channel === 'BL' || channel === 'BR') return layout.includes('SL') || layout.includes('SR') ? 1 : 1.41
  return 1
}

/** Combines per-channel mono loudness readings with Annex 3 weights; readings at or below -70 LUFS add nothing. */
export function annex3Combine(readings: ReadonlyArray<{ channel: string; lufs: number }>, layout: readonly string[]): number
{
  let energy = 0
  for (const r of readings)
  {
    if (!(r.lufs > -70)) continue
    energy += annex3Weight(r.channel, layout) * 10 ** (r.lufs / 10)
  }
  return energy > 0 ? 10 * Math.log10(energy) : -Infinity
}

/** Float sample statistics of one decoded stream. */
export interface SampleStats
{
  channels: number
  frames: number
  peakDb: number
  perChannelPeakDb: number[]
  /** Samples with magnitude above 1.0. */
  over0dBFS: number
  /** Samples with magnitude at or above 1.0. */
  atFullScale: number
  rmsDb: number
  /** The largest difference between any channel and channel 0; 0 means every channel is identical. */
  maxChannelDifference: number
}

/** Computes {@link SampleStats} over decoded channels. */
export function sampleStatsOf(channels: readonly Float64Array[]): SampleStats
{
  const frames = channels[0]?.length ?? 0
  let over = 0
  let atFull = 0
  let sumSq = 0
  let maxDiff = 0
  const peaks = channels.map((c, ci) =>
  {
    let peak = 0
    for (let i = 0; i < c.length; i++)
    {
      const v = c[i]
      const a = v < 0 ? -v : v
      if (a > peak) peak = a
      if (a > 1) over++
      if (a >= 1) atFull++
      sumSq += v * v
      if (ci > 0)
      {
        const d = Math.abs(v - channels[0][i])
        if (d > maxDiff) maxDiff = d
      }
    }
    return peak
  })
  const total = frames * channels.length
  return {
    channels: channels.length,
    frames,
    peakDb: toDb(peaks.reduce((a, b) => Math.max(a, b), 0)),
    perChannelPeakDb: peaks.map(toDb),
    over0dBFS: over,
    atFullScale: atFull,
    rmsDb: total > 0 ? toDb(Math.sqrt(sumSq / total)) : -Infinity,
    maxChannelDifference: maxDiff
  }
}

/** The binaries and capabilities an oracle runs with. */
export interface OracleDeps
{
  ffmpeg: string
  ffprobe: string
  /** The build lists `--enable-libsoxr`, so soxr 8x is the true-peak reference. */
  soxr: boolean
}

/** A true-peak reading and the reference that produced it. */
export interface TruePeakReading
{
  dbtp: number
  method: 'soxr' | 'interpolator'
  ms: number
}

/** The independent meters, bound to one build. */
export interface Oracle
{
  readonly deps: OracleDeps
  probe(file: string): Promise<ProbeSummary>
  /** The summary of audio stream `stream` (`0:a:<stream>`); throws when it is missing. */
  audioStream(file: string, stream?: number): Promise<StreamSummary>
  loudness(file: string, o?: LoudnessOptions): Promise<LoudnessReading>
  /** Each channel's mono reading and their Annex 3 combination. */
  annex3(file: string, stream?: number): Promise<{ channels: Array<{ channel: string; lufs: number }>; reference: number }>
  /** The reference this build supports: soxr 8x with libsoxr, otherwise the interpolator. */
  truePeak(file: string, stream?: number): Promise<TruePeakReading>
  truePeakSoxr(file: string, stream?: number): Promise<TruePeakReading>
  truePeakInterpolated(file: string, stream?: number): Promise<TruePeakReading>
  /** Overall astats values after an optional filter chain. */
  astats(file: string, o?: { stream?: number; filter?: string }): Promise<Record<string, number>>
  sampleStats(file: string, stream?: number): Promise<SampleStats>
  /** Decodes every video and audio stream to the null muxer at `-v error`; any printed line is an error. */
  decodeCheck(file: string): Promise<{ code: number | null; errors: string[] }>
  /** The MD5 of the decoded stream as f64le PCM. */
  md5(file: string, stream?: number): Promise<string>
}

async function mustRun(bin: string, args: readonly string[], what: string): Promise<ToolRun>
{
  const run = await runTool(bin, args)
  if (run.code !== 0) throw new Error(`${what} exited with ${run.code}: ${lf(run.stderr).trim().split('\n').slice(-3).join(' | ')}`)
  return run
}

/** Builds the oracle for one ffmpeg and ffprobe pair. */
export function createOracle(deps: OracleDeps): Oracle
{
  const probe = async (file: string): Promise<ProbeSummary> =>
  {
    const run = await mustRun(deps.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_chapters', '-show_format', file], 'ffprobe')
    return summarizeProbe(run.stdout)
  }

  const audioStream = async (file: string, stream = 0): Promise<StreamSummary> =>
  {
    const found = (await probe(file)).streams.filter((s) => s.type === 'audio')[stream]
    if (!found) throw new Error(`${file} has no audio stream ${stream}`)
    return found
  }

  const astats = async (file: string, o: { stream?: number; filter?: string } = {}): Promise<Record<string, number>> =>
  {
    const pre = o.filter ? `${o.filter},` : ''
    const run = await mustRun(deps.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-i', file,
      '-filter_complex', `[0:a:${o.stream ?? 0}]${pre}astats@o=measure_perchannel=none[m]`, '-map', '[m]', '-f', 'null', '-'], 'astats')
    return parseAstatsOverall(run.stderr)
  }

  const truePeakSoxr = async (file: string, stream = 0): Promise<TruePeakReading> =>
  {
    const started = Date.now()
    const s = await audioStream(file, stream)
    const rate = (s.sampleRate ?? 48000) * 8
    const values = await astats(file, { stream, filter: `aformat=sample_fmts=dbl,aresample=resampler=soxr:precision=33:osr=${rate}:osf=dbl` })
    const dbtp = values['Peak level dB']
    if (dbtp === undefined) throw new Error(`astats printed no peak for ${file}`)
    return { dbtp, method: 'soxr', ms: Date.now() - started }
  }

  const truePeakInterpolated = async (file: string, stream = 0): Promise<TruePeakReading> =>
  {
    const s = await audioStream(file, stream)
    const r = await interpolatedTruePeak(deps.ffmpeg, file, { stream, channels: s.channels ?? 2 })
    return { dbtp: r.dbtp, method: 'interpolator', ms: r.ms }
  }

  return {
    deps,
    probe,
    audioStream,
    astats,
    truePeakSoxr,
    truePeakInterpolated,
    truePeak: (file, stream = 0) => (deps.soxr ? truePeakSoxr(file, stream) : truePeakInterpolated(file, stream)),

    async loudness(file, o = {})
    {
      const run = await mustRun(deps.ffmpeg, loudnessArgs(file, o), 'ebur128')
      return readLoudness(run.stderr)
    },

    async annex3(file, stream = 0)
    {
      const s = await audioStream(file, stream)
      const names = s.layout ? LAYOUT_CHANNELS[s.layout] : undefined
      if (!names || names.length !== s.channels) throw new Error(`No channel names for layout ${s.layout} of ${file}`)
      const labels = names.map((_, i) => `[s${i}]`).join('')
      const parts = [`[0:a:${stream}]asplit=${names.length}${labels}`]
      names.forEach((_, i) => parts.push(`[s${i}]pan=mono|c0=c${i},ebur128@c${i}=metadata=1,ametadata@c${i}=mode=print:key=lavfi.r128.I[m${i}]`))
      const maps = names.flatMap((_, i) => ['-map', `[m${i}]`])
      const run = await mustRun(deps.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-i', file,
        '-filter_complex', parts.join(';'), ...maps, '-f', 'null', '-'], 'per-channel ebur128')
      const prints = parseMetadataPrints(run.stderr)
      const channels = names.map((channel, i) => ({ channel, lufs: last(prints.get(`ametadata@c${i}`)?.get('lavfi.r128.I')) ?? -Infinity }))
      return { channels, reference: annex3Combine(channels, names) }
    },

    async sampleStats(file, stream = 0)
    {
      const s = await audioStream(file, stream)
      return sampleStatsOf(await decodeF64(deps.ffmpeg, file, { stream, channels: s.channels ?? 2 }))
    },

    async decodeCheck(file)
    {
      const run = await runTool(deps.ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'error', '-i', file, '-map', '0:v?', '-map', '0:a', '-f', 'null', '-'])
      return { code: run.code, errors: lf(run.stderr).split('\n').filter((line) => line.trim().length > 0) }
    },

    async md5(file, stream = 0)
    {
      const run = await mustRun(deps.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', `0:a:${stream}`, '-c:a', 'pcm_f64le', '-f', 'md5', '-'], 'md5')
      const m = /MD5=([0-9a-f]{32})/.exec(run.stdout)
      if (!m) throw new Error(`No MD5 for ${file}`)
      return m[1]
    }
  }
}
