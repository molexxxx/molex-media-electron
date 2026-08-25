/**
 * @module main/ffmpeg/processor/audio-filters
 * @description Pure builders for every audio filter chain the processor emits.
 *
 * Centralising the DSP decisions here keeps the FFmpeg semantics in one
 * place and makes them unit-testable without spawning a process. Every
 * value below is pinned to the documented behaviour of the filters as
 * published in FFmpeg's `doc/filters.texi`:
 *
 * - `volume` takes a linear multiplier; "Output values are clipped to the
 *   maximum value", so any positive gain needs a limiter or headroom.
 * - `alimiter.level` is documented as "Auto level output signal. Default
 *   is enabled. This normalizes audio back to 0dB if enabled." That auto
 *   makeup is exactly `1/limit`, so leaving it on both raises the signal
 *   by an amount the caller never asked for AND pins the true ceiling at
 *   0 dBFS instead of the requested one. We always disable it.
 * - `alimiter.latency` compensates the lookahead delay and flushes the
 *   lookahead buffer at EOF. Without it every limited stream is shifted
 *   late by `attack` ms (A/V sync drift) and loses its tail.
 * - `acompressor.makeup` is a LINEAR factor with range 1-64, not dB.
 *   FFmpeg's expression evaluator converts a `dB` suffix via 10^(x/20),
 *   so we always write the suffix and let FFmpeg do the conversion.
 * - `loudnorm` upsamples to 192 kHz in dynamic mode; the docs instruct
 *   callers to "Use the -ar option or aresample filter to explicitly set
 *   an output sample rate", which {@link buildLoudnormChain} does.
 */

/** Channel counts with an unambiguous FFmpeg layout name. */
const CHANNEL_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  4: 'quad',
  6: '5.1',
  8: '7.1'
}

/**
 * Return the FFmpeg channel layout name for a channel count, or null when
 * the count has no unambiguous name (3, 5, 7, ...).
 *
 * Returning null matters: pinning an unknown count to "stereo" - as the
 * previous implementation did - silently downmixed 3/5/7-channel sources
 * during a volume-only operation.
 */
export function channelLayoutName(channels: number): string | null {
  return CHANNEL_LAYOUTS[channels] || null
}

/** Convert a dBFS value to a linear amplitude multiplier. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/** Convert a linear amplitude multiplier to dBFS. */
export function linearToDb(linear: number): number {
  return 20 * Math.log10(linear)
}

/**
 * Convert a user-facing boost percentage to the linear multiplier the
 * `volume` filter expects. `+100` doubles amplitude (≈ +6.02 dB),
 * `-100` mutes.
 */
export function percentToMultiplier(percent: number): number {
  return 1 + percent / 100
}

/**
 * Format a number for a filter argument without exponential notation or
 * trailing float noise (e.g. `1.0000000000000002` -> `1`).
 */
function num(value: number): string {
  return parseFloat(value.toFixed(6)).toString()
}

/* ------------------------------------------------------------------ */
/*  aformat                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the `aformat` stage that pins a stream to its own layout and
 * sample rate before processing.
 *
 * Deliberately does NOT constrain `sample_fmts`. `volume` runs at
 * `precision=float` by default, which already limits its input to FLT,
 * so forcing s16 first only quantised 24-bit/float sources to 16 bits
 * and then converted straight back up.
 *
 * @param channels      - Source channel count.
 * @param sampleRate    - Source sample rate in Hz.
 * @param channelLayout - Layout name reported by ffprobe, when available.
 */
export function buildAformat(
  channels: number,
  sampleRate: string | number | undefined,
  channelLayout?: string
): string {
  const parts: string[] = []
  const layout = channelLayout || channelLayoutName(channels)
  if (layout) parts.push(`channel_layouts=${layout}`)
  const rate = sampleRate ? String(sampleRate) : ''
  if (rate) parts.push(`sample_rates=${rate}`)
  return parts.length > 0 ? `aformat=${parts.join(':')}` : 'aformat=sample_fmts=fltp'
}

/* ------------------------------------------------------------------ */
/*  alimiter                                                           */
/* ------------------------------------------------------------------ */

/** Tuning knobs for {@link buildLimiter}. */
export interface LimiterSpec {
  /** Ceiling in dBFS (negative). */
  ceilingDb: number
  /** Lookahead/attack in ms. FFmpeg's default is 5. */
  attackMs?: number
  /** Release in ms. FFmpeg's default is 50. */
  releaseMs?: number
}

/**
 * Oversampling factor used for true-peak limiting.
 *
 * `alimiter` inspects sample peaks, so the reconstructed waveform can rise
 * above the ceiling between samples. The docs recommend upsampling 2x or
 * 4x before the filter. Measured on a boosted programme asking for
 * -1 dBTP: no oversampling landed at -0.3 dBFS true peak, while both 2x
 * and 4x landed exactly on -1.0. 2x is chosen because it is as accurate
 * as 4x here and roughly half the cost (536 ms vs 905 ms over 5 minutes
 * of 48 kHz stereo, against 234 ms with no oversampling).
 */
const TRUE_PEAK_OVERSAMPLE = 2

/**
 * Build an `alimiter` stage that actually honours the requested ceiling.
 *
 * `level=disabled` switches off the filter's auto makeup (`1/limit`),
 * without which the output is normalised back to 0 dBFS and the ceiling
 * is meaningless. `latency=1` compensates the lookahead delay so the
 * stream stays in sync with video and keeps its tail at EOF.
 *
 * The ceiling is clamped into `alimiter`'s documented `limit` range
 * (0.0625 - 1.0, i.e. -24 dBFS - 0 dBFS).
 */
export function buildLimiter(spec: LimiterSpec): string {
  const clampedDb = Math.max(-24, Math.min(0, spec.ceilingDb))
  const limit = Math.max(0.0625, Math.min(1, dbToLinear(clampedDb)))
  const parts = [`alimiter=limit=${limit.toFixed(4)}`]
  if (spec.attackMs !== undefined) parts.push(`attack=${num(spec.attackMs)}`)
  if (spec.releaseMs !== undefined) parts.push(`release=${num(spec.releaseMs)}`)
  parts.push('level=disabled', 'latency=1')
  return parts.join(':')
}

/**
 * Build the limiter as a stage list, oversampling around it so the
 * ceiling holds against inter-sample peaks rather than only sample peaks.
 *
 * Returns the bare limiter when no sample rate is known or when
 * `truePeak` is false, since oversampling needs a rate to return to.
 *
 * @param spec       - Limiter settings.
 * @param sampleRate - Source rate in Hz; the chain returns to it.
 * @param truePeak   - Enable oversampling (default true).
 */
export function buildLimiterStages(
  spec: LimiterSpec,
  sampleRate?: string | number,
  truePeak = true
): string[] {
  const limiter = buildLimiter(spec)
  const rate = parseInt(String(sampleRate ?? ''), 10)
  if (!truePeak || !Number.isFinite(rate) || rate <= 0) return [limiter]
  return [
    `aresample=${rate * TRUE_PEAK_OVERSAMPLE}`,
    limiter,
    `aresample=${rate}`
  ]
}

/* ------------------------------------------------------------------ */
/*  Volume boost chain                                                 */
/* ------------------------------------------------------------------ */

/** Per-stream source description used by the chain builders. */
export interface StreamSpec {
  channels: number
  sampleRate?: string | number
  channelLayout?: string
}

/** Advanced boost knobs (mirrors `ProcessingTask.boostOptions`). */
export interface BoostSpec {
  limiter?: boolean
  limiterCeiling?: number
  hpfHz?: number
  /**
   * Oversample around the limiter so the ceiling holds against
   * inter-sample peaks. Defaults to true; set false to trade the
   * guarantee for a slightly cheaper encode.
   */
  truePeak?: boolean
}

/**
 * Build the complete per-stream volume-boost chain.
 *
 * Order is `aformat -> [highpass] -> volume -> [alimiter]`: the high-pass
 * runs first so sub-audible rumble does not consume headroom that the
 * gain stage is about to need, and the limiter runs last so it catches
 * the peaks the gain stage creates.
 *
 * @param percent - Boost percentage (`+50` = +50 % amplitude).
 * @param stream  - Source stream description.
 * @param opts    - Optional limiter / high-pass settings.
 */
export function buildBoostChain(
  percent: number,
  stream: StreamSpec,
  opts: BoostSpec = {}
): string[] {
  const chain: string[] = [
    buildAformat(stream.channels, stream.sampleRate, stream.channelLayout)
  ]

  const hpfHz = typeof opts.hpfHz === 'number' && opts.hpfHz > 0 ? opts.hpfHz : 0
  if (hpfHz > 0) chain.push(`highpass=f=${hpfHz}`)

  chain.push(`volume=${num(percentToMultiplier(percent))}`)

  if (opts.limiter === true) {
    const ceiling = typeof opts.limiterCeiling === 'number' ? opts.limiterCeiling : -1
    chain.push(...buildLimiterStages(
      { ceilingDb: ceiling },
      stream.sampleRate,
      opts.truePeak !== false
    ))
  }

  return chain
}

/* ------------------------------------------------------------------ */
/*  Dynamic range compression                                          */
/* ------------------------------------------------------------------ */

/**
 * `acompressor` presets tuned for movie content, where dialog typically
 * sits 10-15 dB below action peaks.
 *
 * `threshold` and `makeup` both carry an explicit `dB` suffix. FFmpeg's
 * evaluator turns `NdB` into 10^(N/20), which is what both options want:
 * `threshold` is a linear level (0.00097-1) and `makeup` is a linear
 * factor (1-64). Writing bare `makeup=3` - as this previously did -
 * requests a linear x3, i.e. +9.5 dB rather than the intended +3 dB.
 */
const COMPRESSOR_PRESETS: Record<string, string> = {
  light: 'acompressor=threshold=-22dB:ratio=2:attack=20:release=250:makeup=2dB',
  medium: 'acompressor=threshold=-24dB:ratio=3:attack=15:release=200:makeup=3dB',
  heavy: 'acompressor=threshold=-26dB:ratio=6:attack=5:release=150:makeup=5dB'
}

/** Makeup gain in dB each preset applies, for loudness bookkeeping. */
export const COMPRESSOR_MAKEUP_DB: Record<string, number> = {
  light: 2,
  medium: 3,
  heavy: 5
}

/**
 * Build the `acompressor` filter for a compression level, or null when
 * compression is disabled.
 */
export function buildCompressorFilter(level?: string | null): string | null {
  if (!level) return null
  return COMPRESSOR_PRESETS[level] || null
}

/* ------------------------------------------------------------------ */
/*  Downmix                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a `pan` downmix for the requested mode, or null when the source
 * already matches (mode `keep`, or a source that is mono/stereo).
 *
 * `dialog-stereo` favours the centre channel so dialog cuts through TV
 * speakers; it only applies to sources with a discrete centre (5.1+).
 */
export function buildDownmixFilter(mode: string | undefined, srcChannels: number): string | null {
  if (!mode || mode === 'keep') return null
  if (srcChannels <= 2) return null

  if (mode === 'dialog-stereo') {
    if (srcChannels >= 6) {
      return 'pan=stereo|FL=0.707*FC+0.85*FL+0.5*BL+0.2*LFE|FR=0.707*FC+0.85*FR+0.5*BR+0.2*LFE'
    }
    return 'pan=stereo|FL<FL+0.707*FC+0.5*BL|FR<FR+0.707*FC+0.5*BR'
  }

  return 'aresample=matrix_encoding=none,pan=stereo|FL<FL+0.707*FC+0.5*BL|FR<FR+0.707*FC+0.5*BR'
}

/* ------------------------------------------------------------------ */
/*  Loudness normalization                                             */
/* ------------------------------------------------------------------ */

/** Loudness targets plus the optional shaping stages. */
export interface NormalizeSpec {
  I: number
  TP: number
  LRA: number
  compression?: string
  downmix?: string
  /** Treat mono sources as dual-mono per EBU R128. */
  dualMono?: boolean
  /** Oversample around the post-compressor limiter. Defaults to true. */
  truePeak?: boolean
}

/** Measured values from the analysis pass, used for linear normalization. */
export interface LoudnessMeasurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Build the filter stages that run BEFORE `loudnorm`.
 *
 * Both passes must share these. A downmix changes the measured loudness
 * of the programme, so measuring the 5.1 source and then normalising a
 * stereo fold-down misses the target by however much the fold-down
 * shifted it.
 */
export function buildPreLoudnormFilters(spec: NormalizeSpec, srcChannels: number): string[] {
  const filters: string[] = []
  const downmix = buildDownmixFilter(spec.downmix, srcChannels)
  if (downmix) filters.push(downmix)
  return filters
}

/**
 * Build the `loudnorm` filter itself.
 *
 * When `measured` is supplied the filter runs in two-pass mode. FFmpeg
 * reverts to dynamic mode - and therefore upsamples to 192 kHz - unless
 * every measured value is present and the target LRA is not below the
 * source LRA, so callers should check `normalization_type` in the JSON
 * report rather than assume linear.
 */
export function buildLoudnormFilter(
  spec: NormalizeSpec,
  srcChannels: number,
  measured?: LoudnessMeasurement,
  printFormat?: 'json' | 'summary'
): string {
  const parts = [`loudnorm=I=${spec.I}`, `TP=${spec.TP}`, `LRA=${spec.LRA}`]

  if (measured) {
    parts.push(
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`
    )
  }

  if (spec.dualMono && srcChannels === 1) parts.push('dual_mono=true')
  if (printFormat) parts.push(`print_format=${printFormat}`)

  return parts.join(':')
}

/**
 * Predict whether `loudnorm` will run in linear mode for these measured
 * values, or fall back to dynamic mode.
 *
 * This is a faithful port of the condition in FFmpeg's own
 * `libavfilter/af_loudnorm.c:init()`:
 *
 * ```c
 * offset    = target_i - measured_i;
 * offset_tp = measured_tp + offset;
 * if (measured_tp != 99 && measured_thresh != -70 &&
 *     measured_lra != 0 && measured_i != 0)
 *     if ((offset_tp <= target_tp) && (measured_lra <= target_lra))
 *         frame_type = LINEAR_MODE;
 * ```
 *
 * It matters for two reasons: dynamic mode re-shapes the programme
 * instead of scaling it, and dynamic mode leaves the filter output at
 * 192 kHz. The analysis pass cannot answer this - with no measured
 * values supplied it always reports `dynamic` - so the mode has to be
 * derived from the measurement instead of read out of pass 1.
 */
export function predictsLinearNormalization(
  spec: NormalizeSpec,
  measured: LoudnessMeasurement
): boolean {
  const measuredI = parseFloat(measured.input_i)
  const measuredTp = parseFloat(measured.input_tp)
  const measuredLra = parseFloat(measured.input_lra)
  const measuredThresh = parseFloat(measured.input_thresh)

  if (![measuredI, measuredTp, measuredLra, measuredThresh].every(Number.isFinite)) return false

  // Sentinel guards: FFmpeg treats these exact values as "not measured".
  if (measuredTp === 99 || measuredThresh === -70 || measuredLra === 0 || measuredI === 0) {
    return false
  }

  const offsetTp = measuredTp + (spec.I - measuredI)
  return offsetTp <= spec.TP && measuredLra <= spec.LRA
}

/**
 * Build the full per-stream analysis chain (pass 1).
 *
 * Identical to the encode chain up to and including `loudnorm`, so the
 * measurement describes exactly the signal pass 2 will normalize.
 */
export function buildAnalysisChain(spec: NormalizeSpec, stream: StreamSpec): string[] {
  return [
    ...buildPreLoudnormFilters(spec, stream.channels),
    buildLoudnormFilter(spec, stream.channels, undefined, 'json')
  ]
}

/**
 * Build the full per-stream encode chain (pass 2).
 *
 * The trailing `aresample` pins the output rate to the source rate.
 * Without it a stream that falls back to dynamic mode leaves `loudnorm`
 * at 192 kHz, which the docs explicitly tell callers to override.
 *
 * The compressor runs after `loudnorm` so it works at a known, normalised
 * level rather than at whatever level the source happened to sit at; its
 * makeup gain therefore lifts the result slightly above the target, and
 * the closing limiter holds the true-peak ceiling.
 */
export function buildLoudnormChain(
  spec: NormalizeSpec,
  stream: StreamSpec,
  measured: LoudnessMeasurement
): string[] {
  const chain: string[] = [
    ...buildPreLoudnormFilters(spec, stream.channels),
    buildLoudnormFilter(spec, stream.channels, measured)
  ]

  const compressor = buildCompressorFilter(spec.compression)
  if (compressor) {
    chain.push(compressor)
    // Makeup gain has pushed peaks above the target ceiling; pull them back.
    chain.push(...buildLimiterStages(
      { ceilingDb: spec.TP },
      stream.sampleRate,
      spec.truePeak !== false
    ))
  }

  const rate = stream.sampleRate ? String(stream.sampleRate) : ''
  const ratePin = rate ? `aresample=${rate}` : 'aresample'
  // The limiter's own downsample already lands on the source rate; don't
  // append a second identical stage after it.
  if (chain[chain.length - 1] !== ratePin) chain.push(ratePin)

  return chain
}
