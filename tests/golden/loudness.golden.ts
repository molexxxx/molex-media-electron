import { beforeAll, describe, expect, inject, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toMediaFacts } from '../../src/main/ffmpeg/audio/facts'
import type { ProbeJson } from '../../src/main/ffmpeg/audio/facts'
import { planStatic } from '../../src/main/ffmpeg/audio/job'
import { buildVerifyArgs, judge, parseVerify } from '../../src/main/ffmpeg/audio/verify'
import type { VerifySpec } from '../../src/main/ffmpeg/audio/verify'
import { createProbe } from '../../src/main/ffmpeg/probe'
import type { StreamVerdict, VerifiedStream } from '../../src/shared/audio/types'
import { CASES, capsOf, caseById, containerOf, expectedVerdict, inputOf, pool, recipeOf, runCase, unavailable } from './cases'
import type { CaseRun, GoldenCase, Scenario } from './cases'
import { createOracle, LAYOUT_CHANNELS, lf, runTool } from './oracle'
import type { ProbeSummary, SampleStats } from './oracle'

const golden = inject('golden')
const runnable = !golden.skip && golden.meetsMinimum

/** What the oracle read on one output stream. */
interface OracleStream
{
  outIndex: number
  channels: number | null
  layout: string | null
  codec: string
  /** The reading under the app's own policy: one channel, two speakers, or the Annex 3 reference; 3 decimals. */
  lufs: number
  /** The same reading at the Summary block's 0.1 LU resolution. */
  lufsSummary: number
  shortTermMax: number | null
  lra: number
  /** Mono outputs only: the one-channel and the two-speaker readings, 3 decimals and at the Summary resolution. */
  single: number | null
  dual: number | null
  singleSummary: number | null
  dualSummary: number | null
  truePeak: number
  truePeakMethod: 'soxr' | 'interpolator'
  stats: SampleStats
}

/** The oracle's view of one source stream, read only for the scenarios that compare against the source. */
interface OracleSource
{
  lra: number
  annex3: number | null
}

/** A case's run and the oracle's view of its source and output. */
interface Checked
{
  run: CaseRun
  out: ProbeSummary | null
  streams: OracleStream[]
  sources: OracleSource[]
  decodeErrors: string[] | null
  error: string | null
}

const SOURCE_SCENARIOS: readonly Scenario[] = ['G4', 'G6', 'G12']

function mainChannels(layout: string | null): number
{
  const channels = layout ? LAYOUT_CHANNELS[layout] : undefined
  return channels ? channels.filter((c) => !c.startsWith('LFE')).length : 0
}

function round(value: number | null | undefined, digits = 2): number | null
{
  return value === null || value === undefined || !Number.isFinite(value) ? (value ?? null) : Number(value.toFixed(digits))
}

/** The probed layout; a WAV without a channel mask reports none, which FFmpeg reads as mono or stereo by count. */
function layoutOf(o: OracleStream | undefined): string | null
{
  if (!o) return null
  return o.layout ?? (o.channels === 1 ? 'mono' : o.channels === 2 ? 'stereo' : null)
}

function isLossless(codec: string): boolean
{
  return codec.startsWith('pcm_') || codec === 'flac' || codec === 'alac'
}

describe.skipIf(!runnable)('loudness through the audio job functions', () =>
{
  const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
  const only = golden.only
  const cases = CASES.filter((c) => c.scenarios.some((s) => s !== 'G13'))
    .filter((c) => !only || only.some((o) => o === c.id || c.scenarios.includes(o as Scenario)))
  const runnableCases = cases.filter((c) => unavailable(c, golden) === null)
  const checked = new Map<string, Checked>()

  const outputReading = async (file: string, k: number, layout: string | null, channels: number | null, c: GoldenCase):
    Promise<Pick<OracleStream, 'lufs' | 'lufsSummary' | 'shortTermMax' | 'lra' | 'single' | 'dual' | 'singleSummary' | 'dualSummary'>> =>
  {
    if (channels === 1)
    {
      const single = await oracle.loudness(file, { stream: k })
      const dual = await oracle.loudness(file, { stream: k, dualmono: true })
      const r = recipeOf(c).mono === 'two-speakers' ? dual : single
      return {
        lufs: r.integratedPrecise ?? r.integrated, lufsSummary: r.integrated, shortTermMax: r.shortTermMax, lra: r.lraPrecise ?? r.lra,
        single: single.integratedPrecise ?? single.integrated, dual: dual.integratedPrecise ?? dual.integrated,
        singleSummary: single.integrated, dualSummary: dual.integrated
      }
    }
    const r = await oracle.loudness(file, { stream: k })
    const base = { shortTermMax: r.shortTermMax, lra: r.lraPrecise ?? r.lra, single: null, dual: null, singleSummary: null, dualSummary: null }
    if (mainChannels(layout) > 5)
    {
      const reference = (await oracle.annex3(file, k)).reference
      return { ...base, lufs: reference, lufsSummary: Math.round(reference * 10) / 10 }
    }
    return { ...base, lufs: r.integratedPrecise ?? r.integrated, lufsSummary: r.integrated }
  }

  const check = async (c: GoldenCase): Promise<Checked> =>
  {
    let run: CaseRun | null = null
    try
    {
      run = await runCase(c, golden)
      const sources: OracleSource[] = []
      if (c.scenarios.some((s) => SOURCE_SCENARIOS.includes(s)))
      {
        const source = (await oracle.probe(run.inputPath)).streams.filter((s) => s.type === 'audio')
        for (let k = 0; k < source.length; k++)
        {
          const r = await oracle.loudness(run.inputPath, { stream: k })
          const annex3 = c.scenarios.includes('G6') ? (await oracle.annex3(run.inputPath, k)).reference : null
          sources.push({ lra: r.lraPrecise ?? r.lra, annex3 })
        }
      }
      const path = run.result.outputPath
      if (path === null)
      {
        return { run, out: null, streams: [], sources, decodeErrors: null, error: null }
      }
      const out = await oracle.probe(path)
      const audio = out.streams.filter((s) => s.type === 'audio')
      const streams: OracleStream[] = []
      for (let k = 0; k < audio.length; k++)
      {
        const s = audio[k]
        const reading = await outputReading(path, k, s.layout, s.channels, c)
        const tp = await oracle.truePeak(path, k)
        streams.push({
          outIndex: k, channels: s.channels, layout: s.layout, codec: s.codec, ...reading,
          truePeak: tp.dbtp, truePeakMethod: tp.method, stats: await oracle.sampleStats(path, k)
        })
      }
      const decode = await oracle.decodeCheck(path)
      return { run, out, streams, sources, decodeErrors: decode.code === 0 ? decode.errors : [`exit ${decode.code}`, ...decode.errors], error: null }
    }
    catch (e)
    {
      return { run: run as CaseRun, out: null, streams: [], sources: [], decodeErrors: null, error: e instanceof Error ? e.stack ?? e.message : String(e) }
    }
  }

  const report = (): unknown[] => [...checked.entries()].map(([id, { run, streams, sources, error }]) => ({
    id,
    error,
    outcome: run?.result.outcome,
    encodePasses: run?.result.encodePasses,
    ms: run?.ms,
    failure: run?.result.failure ? { stage: run.result.failure.stage, code: run.result.failure.exitCode, tail: run.result.failure.stderrTail.slice(-400) } : null,
    refusals: run?.result.refusals.map((r) => r.code),
    passes: run?.events.filter((e) => e.type === 'audio.verified').map((e) => e.type === 'audio.verified'
      ? e.streams.map((s) => [s.verdict.outcome, s.verified?.integratedLufs ?? null, s.verified?.truePeakDbtp ?? null]) : null),
    streams: run?.result.streams.map((s, i) =>
    {
      const o = streams[s.after?.outIndex ?? i]
      return {
        verdict: s.verdict.outcome, mode: s.plan.mode, reason: s.plan.reason, target: s.plan.targetLufs, predicted: round(s.plan.predictedLufs),
        gain: round(s.plan.gainDb), limiting: round(s.plan.limitingDb), before: s.before.stats.integratedLufs, beforeStatus: s.before.stats.status,
        beforeLra: s.before.stats.loudnessRangeLu, lraStatus: s.before.stats.lraStatus, sourceLra: round(sources[i]?.lra), sourceAnnex3: round(sources[i]?.annex3, 3),
        appI: s.after?.integratedLufs ?? null, oracleI: round(o?.lufs, 3), oracleSummary: o?.lufsSummary, ref: s.verdict.loudness.referenceLufs,
        dev: s.verdict.loudness.deviationLu, tol: s.verdict.loudness.toleranceLu, single: round(o?.single, 3), dual: round(o?.dual, 3),
        appTp: s.after?.truePeakDbtp ?? null, preTp: s.after?.preEncodeTruePeakDbtp ?? null, oracleTp: round(o?.truePeak, 3), tpMethod: o?.truePeakMethod,
        gate: s.verdict.truePeak.gateDbtp, decoded: s.verdict.decoded, appS: s.after?.maxShortTermLufs ?? null, oracleS: round(o?.shortTermMax, 3),
        appLra: s.after?.loudnessRangeLu ?? null, oracleLra: round(o?.lra), layout: o?.layout, codec: o?.codec, over0: o?.stats.over0dBFS,
        samplePeak: round(o?.stats.peakDb, 3), channelDifference: o?.stats.maxChannelDifference
      }
    })
  }))

  beforeAll(async () =>
  {
    const results = await pool(runnableCases, 4, check)
    results.forEach((r, i) => checked.set(runnableCases[i].id, r))
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-loudness.json`), JSON.stringify(report(), null, 1))
  })

  const get = (id: string): Checked =>
  {
    const found = checked.get(id)
    if (!found) throw new Error(`${id} did not run`)
    if (found.error) throw new Error(`${id} threw: ${found.error}`)
    return found
  }

  const streamsOf = (x: Checked): Array<{ verdict: StreamVerdict; after: VerifiedStream | null; o: OracleStream; i: number }> =>
    x.run.result.streams.map((s, i) =>
    {
      const o = x.streams[s.after?.outIndex ?? i]
      if (!o) throw new Error(`${x.run.c.id}: output stream ${s.after?.outIndex ?? i} is missing`)
      return { verdict: s.verdict, after: s.after, o, i }
    })

  const selected = (...wanted: string[]): boolean => wanted.every((id) => runnableCases.some((c) => c.id === id))

  const ids = (scenario: Scenario): string[] => runnableCases.filter((c) => c.scenarios.includes(scenario)).map((c) => c.id)

  const isRefusal = (c: GoldenCase): boolean => c.expected.every((e) => expectedVerdict(e, golden.buildId) === 'refused')

  /** G3's peak rule: both meters on soxr agree within 0.05 dB; otherwise the gate holds on the higher reading and they agree within 0.55 dB. */
  const expectPeakWithinGate = (after: VerifiedStream, o: OracleStream, gate: number): void =>
  {
    const appTp = after.truePeakDbtp as number
    if (after.meter === 'soxr-8x' && o.truePeakMethod === 'soxr')
    {
      expect(Math.abs(appTp - o.truePeak)).toBeLessThanOrEqual(0.05)
      expect(o.truePeak).toBeLessThanOrEqual(gate)
    }
    else
    {
      expect(Math.abs(appTp - o.truePeak)).toBeLessThanOrEqual(0.55)
      expect(Math.max(appTp, o.truePeak)).toBeLessThanOrEqual(gate)
    }
  }

  it('runs every case the build supports', () =>
  {
    expect(runnableCases.length).toBeGreaterThan(0)
    expect([...checked.entries()].filter(([, x]) => x.error).map(([id, x]) => `${id}: ${x.error}`)).toEqual([])
  })

  it.each(runnableCases.map((c) => c.id))('%s: every stream ends with its expected verdict', (id) =>
  {
    const x = get(id)
    const c = x.run.c
    if (isRefusal(c))
    {
      expect(x.run.result.outcome).toBe('refused')
      expect(x.run.result.refusals.map((r) => r.code)).toContain(c.refusal)
      expect(x.run.runs).toEqual([])
      expect(x.run.result.encodePasses).toBe(0)
      expect(x.run.result.outputPath).toBeNull()
      return
    }
    expect(x.run.result.failure, JSON.stringify(x.run.result.failure)).toBeNull()
    expect(x.run.result.outputPath).not.toBeNull()
    expect(x.run.result.streams.map((s) => s.verdict.outcome)).toEqual(c.expected.map((e) => expectedVerdict(e, golden.buildId)))
    c.expected.forEach((e, i) =>
    {
      if (e.reason) expect(x.run.result.streams[i].plan.reason).toBe(e.reason)
      if (e.layout) expect(layoutOf(x.streams[x.run.result.streams[i].after?.outIndex ?? i])).toBe(e.layout)
    })
  })

  it.each(runnableCases.filter((c) => !isRefusal(c)).map((c) => c.id))('%s: G1 the output decodes without errors', (id) =>
  {
    expect(get(id).decodeErrors).toEqual([])
  })

  it.each(ids('G2'))('%s: G2 the oracle agrees with the verdict', (id) =>
  {
    const x = get(id)
    const recipe = recipeOf(x.run.c)
    for (const { verdict, o } of streamsOf(x))
    {
      if (verdict.outcome === 'verified')
      {
        expect(verdict.loudness.reference).toBe('target')
        expect(Math.abs(o.lufsSummary - recipe.target.integratedLufs)).toBeLessThanOrEqual(verdict.loudness.toleranceLu + 1e-9)
      }
      else if (verdict.outcome === 'verified-below-target')
      {
        expect(verdict.loudness.reference).toBe('reachable')
        expect(Math.abs(o.lufsSummary - (verdict.loudness.referenceLufs as number))).toBeLessThanOrEqual(verdict.loudness.toleranceLu + 1e-9)
      }
      else if (verdict.outcome === 'outside-tolerance')
      {
        const oracleDeviation = o.lufs - (verdict.loudness.referenceLufs as number)
        expect(Math.abs((verdict.loudness.deviationLu as number) - oracleDeviation)).toBeLessThanOrEqual(0.1)
      }
    }
  })

  it.each(ids('G3'))('%s: G3 true peak at or below the gate, no sample over 0 dBFS, loudness agreement', (id) =>
  {
    const x = get(id)
    for (const { verdict, after, o } of streamsOf(x))
    {
      expect(o.stats.over0dBFS).toBe(0)
      if (verdict.outcome === 'passthrough' || after === null) continue
      expect(Math.abs((after.integratedLufs as number) - o.lufs)).toBeLessThanOrEqual(0.1)
      expectPeakWithinGate(after, o, verdict.truePeak.gateDbtp)
    }
  })

  it.each(ids('G4'))('%s: G4 a linear plan into a lossless output keeps the loudness range', (id) =>
  {
    const x = get(id)
    const recipe = recipeOf(x.run.c)
    for (const { i, o } of streamsOf(x))
    {
      const plan = x.run.result.streams[i].plan
      if (plan.mode !== 'linear' || recipe.dynamics !== null || !isLossless(o.codec)) continue
      expect(Math.abs(o.lra - x.sources[i].lra)).toBeLessThanOrEqual(0.2)
    }
  })

  it.each(ids('G5'))('%s: G5 mono under the preset mono policy', (id) =>
  {
    const x = get(id)
    const recipe = recipeOf(x.run.c)
    const [{ verdict, o }] = streamsOf(x)
    const tolerance = verdict.loudness.toleranceLu
    const target = recipe.target.integratedLufs
    if (recipe.monoToStereo)
    {
      expect(o.channels).toBe(2)
      expect(o.stats.maxChannelDifference, 'left minus right of the duplicated mono output').toBe(0)
      expect(Math.abs(o.lufsSummary - target)).toBeLessThanOrEqual(tolerance + 1e-9)
    }
    else if (recipe.mono === 'one-channel')
    {
      expect(o.channels).toBe(1)
      expect(Math.abs((o.singleSummary as number) - target)).toBeLessThanOrEqual(tolerance + 1e-9)
    }
    else
    {
      expect(o.channels).toBe(1)
      expect(Math.abs((o.dualSummary as number) - target)).toBeLessThanOrEqual(tolerance + 1e-9)
      expect(Math.abs((o.dual as number) - (o.single as number) - 3.01)).toBeLessThanOrEqual(0.05)
    }
  })

  it.each(ids('G6'))('%s: G6 the app meter reads the Annex 3 reference, and the output is within tolerance by it', (id) =>
  {
    const x = get(id)
    const [{ verdict, o, i }] = streamsOf(x)
    const before = x.run.result.streams[i].before.stats.integratedLufs as number
    expect(Math.abs(before - (x.sources[i].annex3 as number))).toBeLessThanOrEqual(0.1)
    expect(mainChannels(o.layout)).toBeGreaterThan(5)
    expect(Math.abs(o.lufsSummary - recipeOf(x.run.c).target.integratedLufs)).toBeLessThanOrEqual(verdict.loudness.toleranceLu + 1e-9)
  })

  it.each(ids('G7').concat(ids('G8')))('%s: G7 and G8 clips, the floor, and silence', (id) =>
  {
    const x = get(id)
    const [{ verdict, o, i }] = streamsOf(x)
    const s = x.run.result.streams[i]
    const reason = x.run.c.expected[0].reason
    if (reason === undefined)
    {
      expect(s.before.stats.status).toBe('measured')
      expect(Math.abs(o.lufsSummary - recipeOf(x.run.c).target.integratedLufs)).toBeLessThanOrEqual(verdict.loudness.toleranceLu + 1e-9)
      return
    }
    expect(s.before.stats.status).toBe(reason)
    expect(s.plan.mode).toBe('passthrough')
    expect(s.after).toBeNull()
  })

  it.each(ids('G8'))('%s: G8 the silent stream is copied bit for bit', async (id) =>
  {
    const x = get(id)
    expect(await oracle.md5(x.run.result.outputPath as string)).toBe(await oracle.md5(x.run.inputPath))
  })

  it('G9 conversions keep their pinned encoder, layout, and subtitle result', () =>
  {
    const planned = (id: string): { encoder: string; bitrateKbps: number | null; outputLayout: string } =>
    {
      const e = get(id).run.events.find((ev) => ev.type === 'audio.static-plan')
      if (!e || e.type !== 'audio.static-plan') throw new Error(`${id} has no static plan`)
      return e.streams[0]
    }
    if (checked.has('dts-ebu'))
    {
      expect(planned('dts-ebu')).toMatchObject({ encoder: 'eac3', bitrateKbps: 640, outputLayout: '5.1(side)' })
      expect(get('dts-ebu').streams[0].codec).toBe('eac3')
    }
    if (checked.has('surround51side-opus-a85'))
    {
      expect(planned('surround51side-opus-a85')).toMatchObject({ encoder: 'libopus', outputLayout: '5.1' })
    }
    if (checked.has('mp4-to-mkv-aes'))
    {
      const out = get('mp4-to-mkv-aes').out as ProbeSummary
      expect(out.streams.filter((s) => s.type === 'subtitle').map((s) => s.codec)).toEqual(['subrip'])
    }
    for (const id of ['brace-spotify', 'opus-spotify', 'vorbis-aes'].filter((k) => checked.has(k)))
    {
      expect(get(id).run.result.failure).toBeNull()
    }
  })

  it('G9 a layout with the wide pair is refused by the static plan', async () =>
  {
    const path = await inputOf(golden, 'hexadecagonal.mka')
    const probe = (await createProbe(golden.ffprobe)(path)) as ProbeJson
    const facts = toMediaFacts(probe, path)
    expect(facts.audio[0].channels).toBe(16)
    const wide = { ...facts, audio: [{ ...facts.audio[0], layout: 'hexadecagonal' }] }
    const c = caseById('refuse-wide-layout')
    const plan = planStatic(wide, recipeOf(c), capsOf(golden), { container: 'mka', muxer: 'matroska' })
    expect(plan.refusals.map((r) => r.code)).toEqual(['layout-unsupported'])
  })

  it.each(ids('G12'))('%s: G12 Night listening lowers the loudness range', (id) =>
  {
    const x = get(id)
    for (const { i, o, verdict } of streamsOf(x))
    {
      expect(Math.abs(o.lufsSummary - recipeOf(x.run.c).target.integratedLufs)).toBeLessThanOrEqual(verdict.loudness.toleranceLu + 1e-9)
      expect(o.lra).toBeLessThan(x.sources[i].lra)
    }
  })

  it.each(ids('G18'))('%s: G18 the AAC onset passes the gate on the first encode pass', (id) =>
  {
    const x = get(id)
    expect(x.run.result.encodePasses).toBe(1)
    const first = x.run.events.find((e) => e.type === 'audio.verified' && e.encodePass === 1)
    if (!first || first.type !== 'audio.verified') throw new Error(`${id} has no first verification`)
    expect(first.streams.map((s) => [s.verdict.truePeak.status, s.verdict.decoded.status])).toEqual([['within', 'within']])
    const [{ after, o, verdict }] = streamsOf(x)
    expectPeakWithinGate(after as VerifiedStream, o, verdict.truePeak.gateDbtp)
  })

  it.skipIf(!selected('shortform-ebu', 'shortform-ebu-off'))('G21 the short-form rule caps the short-term maximum', () =>
  {
    const capped = get('shortform-ebu')
    const [c] = streamsOf(capped)
    expect(c.o.shortTermMax as number).toBeLessThanOrEqual(-17.8)
    expect(c.verdict.outcome).toBe('verified-below-target')
    expect(capped.run.result.streams[0].plan.reason).toBe('short-term-capped')
    expect(c.verdict.shortTerm.status).toBe('within')

    const off = get('shortform-ebu-off')
    const [u] = streamsOf(off)
    expect(u.verdict.outcome).toBe('verified')
    expect(Math.abs(u.o.lufs - -23)).toBeLessThanOrEqual(0.2)
    expect(Math.abs((u.o.shortTermMax as number) - -17.5)).toBeLessThanOrEqual(0.3)
    expect(u.verdict.shortTerm.status).toBe('not-checked')
  })

  it.skipIf(!selected('longform90-ebu', 'shortform-ebu'))('G21 a 90 s item has a loudness range and a 30 s item shows none', () =>
  {
    const long = get('longform90-ebu').run.result.streams[0]
    expect(long.before.stats.lraStatus).toBe('measured')
    expect(long.before.stats.loudnessRangeLu).not.toBeNull()
    expect(long.after?.loudnessRangeLu, 'verified loudness range of the 90 s item').not.toBeNull()
    const short = get('shortform-ebu').run.result.streams[0]
    expect(short.before.stats.lraStatus).toBe('not-applicable')
    expect(short.before.stats.loudnessRangeLu).toBeNull()
    expect(short.after?.loudnessRangeLu, 'verified loudness range of the 30 s item').toBeNull()
  })

  it.skipIf(!golden.soxr).each(ids('G22'))('%s: G22 the swr meter never passes what the soxr meter fails', async (id) =>
  {
    const x = get(id)
    const path = x.run.result.outputPath as string
    const planEvent = x.run.events.find((e) => e.type === 'audio.static-plan')
    if (!planEvent || planEvent.type !== 'audio.static-plan') throw new Error(`${id} has no static plan`)
    const [{ verdict, after }] = streamsOf(x)
    const verified = after as VerifiedStream
    const specs: VerifySpec[] = [{
      outIndex: 0, sampleRate: planEvent.streams[0].outputRate, dualMono: false, weights: null, shortTerm: verified.maxShortTermLufs !== null,
      passthrough: false, preEncodeTruePeakDbtp: null
    }]
    const soxrArgs = buildVerifyArgs(path, specs, 'soxr')
    expect(x.run.runs.filter((r) => r.join('\u0000') === soxrArgs.join('\u0000')).length).toBeGreaterThan(0)
    const swrRun = await runTool(golden.ffmpeg, buildVerifyArgs(path, specs, 'swr'))
    expect(swrRun.code).toBe(0)
    const parsed = parseVerify(lf(swrRun.stderr).split('\n'), specs, 'swr')
    const swr = parsed.streams.get(0) as VerifiedStream
    expect(swr.meter).toBe('swr-8x')
    expect((swr.truePeakDbtp as number) + 0.2).toBeGreaterThanOrEqual(verified.truePeakDbtp as number)
    const plan = x.run.result.streams[0].plan
    const swrVerdict = judge(plan, swr, recipeOf(x.run.c).target, verdict.loudness.toleranceLu, x.run.result.encodePasses as 1 | 2,
      parsed.decodeErrorCount, verdict.shortTerm.toleranceLu)
    if (verdict.truePeak.status === 'over') expect(swrVerdict.truePeak.status).toBe('over')
    if (verdict.decoded.status === 'over') expect(swrVerdict.decoded.status).toBe('over')
  })

  it('every case names an output container the job functions can write', () =>
  {
    for (const c of CASES)
    {
      expect(containerOf(c)).toMatch(/^[a-z0-9]+$/)
    }
  })
})
