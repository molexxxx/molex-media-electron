import { describe, it, expect, inject } from 'vitest'
import { createExec, execArgv, exitName, normalizeLines, signedExitCode } from '../../src/main/ffmpeg/exec'
import type { ExecResult } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { SELF_TEST_IDS, SELF_TESTS, meetsMinimum, minimumMessage, parseVersion, pipelineRefusal, selfTestFailure } from '../../src/main/ffmpeg/build'
import type { SelfTestId } from '../../src/main/ffmpeg/build'
import { runTool } from './oracle'

const golden = inject('golden')
const ready = !golden.skip && (golden.only === null || golden.only.includes('G19'))

/** The library lines of Ubuntu 22.04's FFmpeg 4.4.2 `-version`, the release the refusal leg installs. */
const VERSION_442 = [
  'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers',
  'built with gcc 11 (Ubuntu 11.2.0-19ubuntu1)',
  'configuration: --prefix=/usr --extra-version=0ubuntu0.22.04.1 --enable-gpl --enable-libsoxr',
  'libavutil      56. 70.100 / 56. 70.100',
  'libavcodec     58.134.100 / 58.134.100',
  'libavformat    58. 76.100 / 58. 76.100',
  'libavdevice    58. 13.100 / 58. 13.100',
  'libavfilter     7.110.100 /  7.110.100',
  'libswscale      5.  9.100 /  5.  9.100',
  'libswresample   3.  9.100 /  3.  9.100',
  'libpostproc    55.  9.100 / 55.  9.100'
].join('\n')

/** Runs one self-test through the app's exec, collecting stderr lines the way the startup check reads them. */
async function throughExec(test: (typeof SELF_TESTS)[number]): Promise<boolean>
{
  if (test.reads === 'stdout')
  {
    const run = await runTool(golden.ffmpeg, execArgv(test.args, 'kill'))
    const code = signedExitCode(run.code)
    const r: ExecResult = { code, exitName: exitName(code), signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: run.ms }
    return test.pass(r, normalizeLines(run.stdout).split('\n'))
  }
  const lines: string[] = []
  const exec = createExec(golden.ffmpeg, { timers: realTimers })
  const r = await exec.run(test.args, { signal: new AbortController().signal, stop: 'kill', onStderrLine: (line) => lines.push(line) })
  return test.pass(r, lines)
}

describe('G19 minimum version refusal', () =>
{
  it('refuses FFmpeg 4.4.2 before any job runs', () =>
  {
    const parsed = parseVersion(VERSION_442)
    expect(parsed.libs.avfilter).toEqual([7, 110, 100])
    expect(parsed.libs.swresample).toEqual([3, 9, 100])
    expect(meetsMinimum(parsed.libs)).toBe(false)
    const passing = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true])) as Record<SelfTestId, boolean>
    const refusal = pipelineRefusal({ versionString: parsed.versionString, meetsMinimum: false, selfTest: passing })
    expect(refusal).toBe(minimumMessage(parsed.versionString))
    expect(refusal).toMatch(/^FFmpeg 5\.1 or newer is required; found 4\.4\.2/)
  })
})

describe.skipIf(!ready)('G19 self-test on real FFmpeg', () =>
{
  it.skipIf(golden.meetsMinimum)('refuses this build with the minimum message', () =>
  {
    expect(golden.minimumMessage).toMatch(/^FFmpeg 5\.1 or newer is required; found /)
    expect(pipelineRefusal({ versionString: golden.versionString, meetsMinimum: golden.meetsMinimum, selfTest: golden.selfTest }))
      .toBe(golden.minimumMessage)
  })

  it.skipIf(!golden.meetsMinimum)('passes every startup self-test', () =>
  {
    expect(golden.minimumMessage).toBeNull()
    const expected = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, id === 'soxr' ? golden.configuration.includes('--enable-libsoxr') : true]))
    expect(golden.selfTest).toEqual(expected)
    expect(selfTestFailure(golden.selfTest)).toBeNull()
    expect(pipelineRefusal({ versionString: golden.versionString, meetsMinimum: golden.meetsMinimum, selfTest: golden.selfTest })).toBeNull()
  })

  it.skipIf(!golden.meetsMinimum)('gives the same self-test results through the app exec', async () =>
  {
    const results: Partial<Record<SelfTestId, boolean>> = {}
    for (const test of SELF_TESTS)
    {
      results[test.id] = await throughExec(test)
    }
    expect(results).toEqual(golden.selfTest)
  })
})
