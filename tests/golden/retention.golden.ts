import { beforeAll, describe, expect, inject, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { casesFor, expectedVerdict, pool, runCase, unavailable } from './cases'
import type { CaseRun } from './cases'
import { createOracle } from './oracle'
import type { ProbeSummary, StreamSummary } from './oracle'

const golden = inject('golden')
const runnable = !golden.skip && golden.meetsMinimum

/** What the container table keeps in each output, by case. */
interface Retention
{
  /** Subtitle codecs of the output, in order. */
  subtitles: readonly string[]
  attachments: number
  chapters: number
  coverArt: number
  /** Output audio layouts, where the case pins them. */
  layouts?: readonly string[]
  /** Global tags the output keeps from the source. */
  tags?: readonly string[]
}

/** The 2022 build moves copied chapters by the output's start offset (21 ms after an AAC encode); 9.0.2 and 5.1.2 keep them exact. */
const CHAPTER_SHIFT_SEC = 0.05

const MKV: Retention = { subtitles: ['subrip'], attachments: 1, chapters: 2, coverArt: 0 }
const COVER: Retention = { subtitles: [], attachments: 0, chapters: 0, coverArt: 1, tags: ['title', 'artist', 'album'] }

/** The expected retention of every G13 case. */
const RETENTION: Readonly<Record<string, Retention>> =
{
  'video-mkv-ebu': MKV,
  'video-mkv-copy-ebu': MKV,
  'video-mp4-aes': { subtitles: ['mov_text'], attachments: 0, chapters: 2, coverArt: 0 },
  'mp4-to-mkv-aes': { subtitles: ['subrip'], attachments: 0, chapters: 2, coverArt: 0 },
  'cover-mp3-aes': COVER,
  'cover-flac-aes': COVER,
  'cover-m4a-aes': COVER,
  'aac51-ebu': { subtitles: [], attachments: 0, chapters: 0, coverArt: 0, layouts: ['5.1'] }
}

interface Retained
{
  run: CaseRun
  source: ProbeSummary
  out: ProbeSummary | null
  error: string | null
}

const ofType = (p: ProbeSummary, type: string): StreamSummary[] => p.streams.filter((s) => s.type === type && !s.attachedPic)
const covers = (p: ProbeSummary): StreamSummary[] => p.streams.filter((s) => s.attachedPic)

/** No language tag and 'und' both mean undetermined; MP4 writes 'und' where Matroska writes nothing. */
const language = (value: string | null): string => value ?? 'und'

describe.skipIf(!runnable)('stream retention through the audio job functions', () =>
{
  const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
  const only = golden.only
  const cases = casesFor('G13')
    .filter((c) => !only || only.some((o) => o === c.id || o === 'G13'))
    .filter((c) => unavailable(c, golden) === null)
  const retained = new Map<string, Retained>()

  beforeAll(async () =>
  {
    const results = await pool(cases, 3, async (c): Promise<Retained> =>
    {
      let run: CaseRun | null = null
      try
      {
        run = await runCase(c, golden)
        const source = await oracle.probe(run.inputPath)
        const out = run.result.outputPath === null ? null : await oracle.probe(run.result.outputPath)
        return { run, source, out, error: null }
      }
      catch (e)
      {
        return { run: run as CaseRun, source: null as unknown as ProbeSummary, out: null, error: e instanceof Error ? e.stack ?? e.message : String(e) }
      }
    })
    results.forEach((r, i) => retained.set(cases[i].id, r))
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-retention.json`),
      JSON.stringify([...retained.entries()].map(([id, r]) => ({ id, error: r.error, outcome: r.run?.result.outcome, source: r.source, out: r.out })), null, 1))
  })

  const get = (id: string): Retained & { out: ProbeSummary } =>
  {
    const found = retained.get(id)
    if (!found) throw new Error(`${id} did not run`)
    if (found.error) throw new Error(`${id} threw: ${found.error}`)
    if (found.out === null) throw new Error(`${id} wrote no output: ${JSON.stringify(found.run.result.failure ?? found.run.result.refusals)}`)
    return found as Retained & { out: ProbeSummary }
  }

  it('every G13 case has a retention row', () =>
  {
    expect(casesFor('G13').map((c) => c.id).sort()).toEqual(Object.keys(RETENTION).sort())
  })

  it.each(cases.map((c) => c.id))('%s: G13 the job ends with its expected verdicts', (id) =>
  {
    const { run } = get(id)
    expect(run.result.streams.map((s) => s.verdict.outcome)).toEqual(run.c.expected.map((e) => expectedVerdict(e, golden.buildId)))
  })

  it.each(cases.map((c) => c.id))('%s: G13 video and audio streams keep their codecs, languages, titles, and dispositions', (id) =>
  {
    const { source, out } = get(id)
    const video = (p: ProbeSummary): string[] => ofType(p, 'video').map((s) => s.codec)
    expect(video(out)).toEqual(video(source))
    const from = ofType(source, 'audio')
    const to = ofType(out, 'audio')
    expect(to.length).toBe(from.length)
    const anyDefault = from.some((s) => s.default)
    to.forEach((s, i) =>
    {
      expect(language(s.language)).toBe(language(from[i].language))
      // MP4 stores a stream title as its handler name, which the summary does not read; Matroska shows it as the title.
      if (from[i].title !== null) expect(s.title).toBe(from[i].title)
      if (anyDefault) expect(s.default).toBe(from[i].default)
      expect(s.forced).toBe(from[i].forced)
    })
  })

  it.each(cases.map((c) => c.id))('%s: G13 subtitles, attachments, chapters, and cover art follow the container table', (id) =>
  {
    const { source, out } = get(id)
    const want = RETENTION[id]
    expect(ofType(out, 'subtitle').map((s) => s.codec)).toEqual(want.subtitles)
    expect(ofType(out, 'subtitle').map((s) => s.language)).toEqual(ofType(source, 'subtitle').slice(0, want.subtitles.length).map((s) => s.language))
    const attachments = ofType(out, 'attachment')
    expect(attachments.length).toBe(want.attachments)
    expect(attachments.map((s) => [s.filename, s.mimetype])).toEqual(ofType(source, 'attachment').slice(0, want.attachments).map((s) => [s.filename, s.mimetype]))
    expect(out.chapters.length).toBe(want.chapters)
    expect(out.chapters.map((c) => c.title)).toEqual(source.chapters.slice(0, want.chapters).map((c) => c.title))
    out.chapters.forEach((c, i) =>
    {
      expect(Math.abs(c.startSec - source.chapters[i].startSec)).toBeLessThanOrEqual(CHAPTER_SHIFT_SEC)
      expect(Math.abs(c.endSec - source.chapters[i].endSec)).toBeLessThanOrEqual(CHAPTER_SHIFT_SEC)
    })
    expect(covers(out).length).toBe(want.coverArt)
    for (const tag of want.tags ?? [])
    {
      expect(out.tags[tag] ?? out.tags[tag.toUpperCase()], tag).toBe(source.tags[tag] ?? source.tags[tag.toUpperCase()])
    }
    if (want.layouts)
    {
      expect(ofType(out, 'audio').map((s) => s.layout)).toEqual(want.layouts)
    }
  })

  it('G13 the MKV attachment keeps its file name', () =>
  {
    for (const id of ['video-mkv-ebu', 'video-mkv-copy-ebu'].filter((k) => retained.has(k)))
    {
      expect(ofType(get(id).out, 'attachment').map((s) => s.filename)).toEqual(['molex-test.ttf'])
    }
  })
})
