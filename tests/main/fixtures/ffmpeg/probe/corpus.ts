/**
 * The recorded probes of the corpus: `ffprobe -v error -show_streams -show_format -show_chapters -of json`
 * on every corpus file, captured on each build by scripts/capture-ffmpeg-fixtures.mjs. A probe is found by
 * the corpus file name ffprobe read, which runs.json keeps as the last argument.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { ProbeJson } from '../../../../../src/main/ffmpeg/audio/facts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The builds the probes were recorded on. */
export const PROBE_BUILDS = ['2022-10-13', '9.0.2'] as const

/** One of the recorded builds. */
export type ProbeBuild = typeof PROBE_BUILDS[number]

/** One recorded probe. */
export interface RecordedProbe
{
  /** The corpus file name. */
  input: string
  /** The relative path ffprobe read. */
  path: string
  code: number | null
  probe: ProbeJson
}

interface RunRecord
{
  name: string
  argv: string[]
  code: number | null
  stdout: string | null
}

const cache = new Map<ProbeBuild, RecordedProbe[]>()

/** Every recorded probe of a build, in capture order. */
export function recordedProbes(build: ProbeBuild): RecordedProbe[]
{
  const known = cache.get(build)
  if (known !== undefined)
  {
    return known
  }
  const dir = path.join(HERE, build)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8')) as { runs: RunRecord[] }
  const probes = manifest.runs.map((run) =>
  {
    const target = run.argv[run.argv.length - 1]
    if (run.stdout === null)
    {
      throw new Error(`The probe of ${target} on ${build} recorded no output`)
    }
    return {
      input: target.replace(/^IN\//, ''),
      path: target,
      code: run.code,
      probe: JSON.parse(fs.readFileSync(path.join(dir, run.stdout), 'utf8')) as ProbeJson
    }
  })
  cache.set(build, probes)
  return probes
}

/** The recorded probe of one corpus file on a build. */
export function recordedProbe(build: ProbeBuild, input: string): RecordedProbe
{
  const found = recordedProbes(build).find((run) => run.input === input)
  if (found === undefined)
  {
    throw new Error(`No recorded probe of ${input} on ${build}`)
  }
  return found
}
