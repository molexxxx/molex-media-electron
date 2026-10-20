/**
 * The FFmpeg build policy. Version and encoder parsing and the self-test pass rules run on output recorded from the
 * 2022 build, the gyan 5.1.2 build, and the pinned 9.0.2 build (tests/main/fixtures/ffmpeg/build, written by
 * scripts/capture-ffmpeg-fixtures.mjs), plus the 4.4.2 version output of Ubuntu 22.04 (see its source.json). The
 * pin checks run on the shipped pinned-builds.json.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  CHECKSUM_MESSAGE, MINIMUM, REQUIRED_ENCODERS, SELF_TESTS, SELF_TEST_IDS, SELF_TEST_REV, SURROUND_GAIN_DB, SURROUND_TOLERANCE_DB,
  alternativesMessage, assembleBuildInfo, cachedSelfTest, configBlock, discoveryCandidates, displayVersion, executableName, notRun,
  foldersToDelete, hasRequiredEncoders, isPinId, meetsMinimum, minimumMessage, parseEncoders, parsePin, parseVersion,
  pinKey, pipelineRefusal, planInstall, searchDirs, selectAssets, selfTestFailure, surroundGainDb, verifyDigest
} from '../../src/main/ffmpeg/build'
import type { BinaryIdentity, LibVersion, PinnedBuilds, SelfTestId, SelfTestRecord } from '../../src/main/ffmpeg/build'
import { execArgv, normalizeLines, signedExitCode, exitName } from '../../src/main/ffmpeg/exec'
import type { ExecResult } from '../../src/main/ffmpeg/exec'
import pinJson from '../../src/main/ffmpeg/pinned-builds.json'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'ffmpeg', 'build')
const SELFTEST_BUILDS = ['2022-10-13', '9.0.2'] as const

interface RunRecord
{
  name: string
  code: number | null
  signal: string | null
  stdout: string | null
  stderr: string | null
}

function info(label: string, file: string): string
{
  return fs.readFileSync(path.join(FIXTURES, 'info', label, file), 'utf8')
}

function runRecord(build: string, name: string): RunRecord
{
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'selftest', build, 'runs.json'), 'utf8')) as { runs: RunRecord[] }
  const found = manifest.runs.find((run) => run.name === name)
  if (!found)
  {
    throw new Error(`No recorded run ${name} for ${build}`)
  }
  return found
}

function recordedLines(build: string, name: string, stream: 'stdout' | 'stderr'): string[]
{
  const file = runRecord(build, name)[stream]
  if (file === null)
  {
    return []
  }
  const text = normalizeLines(fs.readFileSync(path.join(FIXTURES, 'selftest', build, file), 'utf8'))
  return text.split('\n').filter((line, i, all) => i < all.length - 1 || line.length > 0)
}

function recordedResult(build: string, name: string): ExecResult
{
  const run = runRecord(build, name)
  const code = signedExitCode(run.code)
  return { code, exitName: exitName(code), signal: run.signal, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: 80 }
}

function result(overrides: Partial<ExecResult> = {}): ExecResult
{
  return { code: 0, exitName: null, signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: 80, ...overrides }
}

function selfTest(id: SelfTestId): typeof SELF_TESTS[number]
{
  const found = SELF_TESTS.find((t) => t.id === id)
  if (!found)
  {
    throw new Error(`No self-test ${id}`)
  }
  return found
}

const PIN: PinnedBuilds = parsePin(pinJson)

const HOMEBREW = [
  'ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers',
  'built with Apple clang version 17.0.0 (clang-1700.3.19.1)',
  'configuration: --prefix=/opt/homebrew/Cellar/ffmpeg/9.0.2 --enable-shared --enable-pthreads --enable-version3 --cc=clang --host-cflags= --host-ldflags=\'-Wl,-ld_classic -L/opt/homebrew/lib\' --enable-ffplay --enable-gpl --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-audiotoolbox --enable-neon',
  'libavutil      61.  1.100 / 61.  1.102',
  'libavcodec     63.  1.100 / 63.  1.102',
  'libavformat    63.  1.100 / 63.  1.102',
  'libavdevice    63.  1.100 / 63.  1.102',
  'libavfilter    12.  1.100 / 12.  1.102',
  'libswscale     10.  1.100 / 10.  1.102',
  'libswresample   7.  1.100 /  7.  1.102',
  ''
].join('\n')

describe('parseVersion', () =>
{
  it('reads the pinned 9.0.2 build and ignores its trailing exit line', () =>
  {
    const stdout = info('9.0.2', 'version.stdout.txt')
    expect(stdout.trim().split(/\r?\n/).pop()).toBe('Exiting with exit code 0')
    const parsed = parseVersion(stdout)
    expect(parsed.versionString).toBe('n9.0.2-17-g2a571b6068-20260930')
    expect(parsed.libs).toEqual({ avutil: [61, 1, 102], avcodec: [63, 1, 102], avformat: [63, 1, 102], avfilter: [12, 1, 102], swresample: [7, 1, 102] })
    expect(parsed.configuration).toContain('--enable-libsoxr')
    expect(parsed.configuration).toContain('--extra-version=20260930')
    expect(parsed.configuration.some((arg) => arg.includes('Exiting'))).toBe(false)
  })

  it('reads the 2022 build', () =>
  {
    const parsed = parseVersion(info('2022-10-13', 'version.stdout.txt'))
    expect(parsed.versionString).toBe('2022-10-13-git-9e8a327e68-full_build-www.gyan.dev')
    expect(parsed.libs.avfilter).toEqual([8, 49, 101])
    expect(parsed.libs.swresample).toEqual([4, 9, 100])
    expect(parsed.configuration[0]).toBe('--enable-gpl')
  })

  it('reads ffprobe -version output the same way', () =>
  {
    const parsed = parseVersion(info('9.0.2', 'ffprobe-version.stdout.txt'))
    expect(parsed.versionString).toBe('n9.0.2-17-g2a571b6068-20260930')
    expect(parsed.libs.swresample).toEqual([7, 1, 102])
  })

  it('reads a Homebrew-style shared build: runtime versions and quoted configure values', () =>
  {
    const parsed = parseVersion(HOMEBREW)
    expect(parsed.versionString).toBe('9.0.2')
    expect(parsed.libs.avfilter).toEqual([12, 1, 102])
    expect(parsed.configuration).toContain('--host-ldflags=-Wl,-ld_classic -L/opt/homebrew/lib')
    expect(parsed.configuration).toContain('--host-cflags=')
    expect(parsed.configuration).not.toContain('--enable-libsoxr')
  })

  it('reads the Ubuntu 22.04 4.4.2 build', () =>
  {
    const parsed = parseVersion(info('4.4.2', 'version.stdout.txt'))
    expect(parsed.versionString).toBe('4.4.2-0ubuntu0.22.04.1')
    expect(parsed.libs.avfilter).toEqual([7, 110, 100])
    expect(parsed.libs.swresample).toEqual([3, 9, 100])
  })

  it('falls back to the compile-time version and reads missing libraries as 0.0.0', () =>
  {
    const parsed = parseVersion('ffmpeg version 6.0 Copyright\r\nlibavfilter     9.  3.100\r\n')
    expect(parsed.versionString).toBe('6.0')
    expect(parsed.libs.avfilter).toEqual([9, 3, 100])
    expect(parsed.libs.swresample).toEqual([0, 0, 0])
    expect(parsed.configuration).toEqual([])
  })

  it('keeps the first version line and skips unknown libraries', () =>
  {
    const parsed = parseVersion('ffmpeg version 7.1\nffprobe version 9.9\nlibpostproc    58.  3.100 / 58.  3.100\nconfiguration: "--extra-version=a b" --enable-gpl  \n')
    expect(parsed.versionString).toBe('7.1')
    expect(parsed.configuration).toEqual(['--extra-version=a b', '--enable-gpl'])
    expect(parseVersion('').versionString).toBe('')
  })
})

describe('parseEncoders', () =>
{
  it.each(['9.0.2', '2022-10-13', '5.1.2'])('lists the %s encoders and the experimental ones', (label) =>
  {
    const parsed = parseEncoders(info(label, 'encoders.stdout.txt'))
    for (const name of [...REQUIRED_ENCODERS, 'libvorbis'])
    {
      expect(parsed.all.has(name)).toBe(true)
      expect(parsed.experimental.has(name)).toBe(false)
    }
    expect(parsed.experimental.has('opus')).toBe(true)
    expect(parsed.experimental.has('vorbis')).toBe(true)
    expect(parsed.all.has('=')).toBe(false)
    expect(parsed.all.has('Video')).toBe(false)
  })

  it('takes the experimental column from the legend', () =>
  {
    const stdout = [
      'Encoders:',
      ' A...... = Audio',
      ' ....X.. = Codec is experimental',
      ' -------',
      ' A...X.. sonic          Sonic',
      ' A..X... aac            AAC',
      ' not an encoder line',
      ''
    ].join('\n')
    const parsed = parseEncoders(stdout)
    expect([...parsed.all]).toEqual(['sonic', 'aac'])
    expect([...parsed.experimental]).toEqual(['sonic'])
  })

  it('reads nothing without the listing separator', () =>
  {
    expect(parseEncoders(' A....D aac  AAC').all.size).toBe(0)
  })
})

describe('meetsMinimum', () =>
{
  const at = (avfilter: LibVersion, swresample: LibVersion): boolean =>
    meetsMinimum({ avutil: [0, 0, 0], avcodec: [0, 0, 0], avformat: [0, 0, 0], avfilter, swresample })

  it('accepts exactly 8.44.100 and 4.7.100', () =>
  {
    expect(MINIMUM).toEqual({ avfilter: [8, 44, 100], swresample: [4, 7, 100] })
    expect(at([8, 44, 100], [4, 7, 100])).toBe(true)
  })

  it.each([
    [[8, 44, 99], [4, 7, 100]],
    [[8, 43, 999], [4, 7, 100]],
    [[7, 110, 100], [4, 7, 100]],
    [[8, 44, 100], [4, 7, 99]],
    [[8, 44, 100], [4, 6, 999]],
    [[8, 44, 100], [3, 9, 100]]
  ] as Array<[LibVersion, LibVersion]>)('refuses avfilter %j with swresample %j', (avfilter, swresample) =>
  {
    expect(at(avfilter, swresample)).toBe(false)
  })

  it.each([
    [[8, 44, 101], [4, 7, 101]],
    [[8, 45, 0], [4, 8, 0]],
    [[9, 0, 0], [5, 0, 0]]
  ] as Array<[LibVersion, LibVersion]>)('accepts avfilter %j with swresample %j', (avfilter, swresample) =>
  {
    expect(at(avfilter, swresample)).toBe(true)
  })

  it('accepts the recorded 5.1.2, 2022, and 9.0.2 builds', () =>
  {
    const boundary = parseVersion(info('5.1.2', 'version.stdout.txt'))
    expect(boundary.libs.avfilter).toEqual([8, 44, 100])
    expect(boundary.libs.swresample).toEqual([4, 7, 100])
    expect(meetsMinimum(boundary.libs)).toBe(true)
    expect(meetsMinimum(parseVersion(info('2022-10-13', 'version.stdout.txt')).libs)).toBe(true)
    expect(meetsMinimum(parseVersion(info('9.0.2', 'version.stdout.txt')).libs)).toBe(true)
  })

  it('refuses the recorded 4.4.2 build with the minimum message', () =>
  {
    const parsed = parseVersion(info('4.4.2', 'version.stdout.txt'))
    expect(meetsMinimum(parsed.libs)).toBe(false)
    expect(minimumMessage(parsed.versionString)).toBe('FFmpeg 5.1 or newer is required; found 4.4.2')
    const selfTest = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true])) as Record<SelfTestId, boolean>
    expect(pipelineRefusal({ versionString: parsed.versionString, meetsMinimum: false, selfTest })).toBe('FFmpeg 5.1 or newer is required; found 4.4.2')
  })
})

describe('displayVersion', () =>
{
  it.each([
    ['n9.0.2-17-g2a571b6068-20260930', '9.0.2'],
    ['9.0.2-full_build-www.gyan.dev', '9.0.2'],
    ['4.4.2-0ubuntu0.22.04.1', '4.4.2'],
    ['5.1', '5.1'],
    ['2022-10-13-git-9e8a327e68-full_build-www.gyan.dev', '2022-10-13-git-9e8a327e68-full_build-www.gyan.dev'],
    ['N-121000-g0123456789-20260101', 'N-121000-g0123456789-20260101'],
    ['', 'an unrecognized version']
  ])('shows %s as %s', (versionString, shown) =>
  {
    expect(displayVersion(versionString)).toBe(shown)
  })
})

describe('SELF_TESTS', () =>
{
  const scenarios = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'selftest', 'scenarios.json'), 'utf8')) as
    { prefix: string[]; runs: Array<{ name: string; args: string[] }> }

  it('runs the seven tests in order, under rules newer than the ones without the surround meter', () =>
  {
    expect(SELF_TESTS.map((t) => t.id)).toEqual(SELF_TEST_IDS)
    expect(SELF_TEST_IDS).toEqual(['chain-flac-s16', 'chain-opus-51side', 'chain-aac-mono', 'meter-dual-mono', 'meter-surround', 'soxr', 'encoders'])
    expect(SELF_TEST_REV).toBe(2)
  })

  it('records with the exec prefix, so the fixtures replay the argv the bootstrap runs', () =>
  {
    expect(scenarios.prefix).toEqual(execArgv([], 'kill'))
    for (const test of SELF_TESTS)
    {
      expect(scenarios.runs.find((run) => run.name === test.id)?.args).toEqual(test.args)
    }
  })

  it('reads stdout only for the encoder list', () =>
  {
    expect(SELF_TESTS.filter((t) => t.reads === 'stdout').map((t) => t.id)).toEqual(['encoders'])
  })

  it.each(SELFTEST_BUILDS)('passes every test on the recorded %s output', (build) =>
  {
    for (const test of SELF_TESTS)
    {
      const lines = recordedLines(build, test.id, test.reads)
      expect({ id: test.id, pass: test.pass(recordedResult(build, test.id), lines) }).toEqual({ id: test.id, pass: true })
    }
  })

  it.each(SELFTEST_BUILDS)('fails soxr on the recorded %s run of a missing resampler', (build) =>
  {
    const r = recordedResult(build, 'soxr-missing-engine')
    expect(r.code).not.toBe(0)
    expect(selfTest('soxr').pass(r, recordedLines(build, 'soxr-missing-engine', 'stderr'))).toBe(false)
  })

  it('fails any test whose run was stopped, aborted, refused, or ended by a signal', () =>
  {
    const lines = recordedLines('9.0.2', 'soxr', 'stderr')
    expect(selfTest('soxr').pass(result(), lines)).toBe(true)
    for (const bad of [{ stopped: 'killed' as const }, { aborted: true }, { outputRefused: true }, { code: null, signal: 'SIGKILL' }, { code: 1 }])
    {
      expect(selfTest('soxr').pass(result(bad), lines)).toBe(false)
    }
  })

  it('fails the FLAC chain on any [error] line', () =>
  {
    expect(selfTest('chain-flac-s16').pass(result(), [])).toBe(true)
    expect(selfTest('chain-flac-s16').pass(result(), ['[error] Application provided invalid, non monotonically increasing dts to muxer'])).toBe(false)
    expect(selfTest('chain-opus-51side').pass(result(), ['[error] anything'])).toBe(true)
  })

  it('fails the meter when the st block is missing or off by more than 0.1', () =>
  {
    const meter = selfTest('meter-dual-mono')
    const lines = recordedLines('9.0.2', 'meter-dual-mono', 'stderr')
    expect(meter.pass(result(), lines)).toBe(true)
    expect(meter.pass(result(), lines.map((line) => line.replace('I:         -18.1 LUFS', 'I:         -18.3 LUFS')))).toBe(false)
    expect(meter.pass(result(), lines.map((line) => line.replace('Peak:      -18.1 dBFS', 'Peak:      -17.9 dBFS')))).toBe(false)
    expect(meter.pass(result(), lines.map((line) => line.replace('ebur128@st', 'ebur128@m0')))).toBe(false)
    expect(meter.pass(result({ code: 1 }), lines)).toBe(false)
  })

  it('expects the 5.1 reading 10*log10(3 + 2*1.41) dB over the mono one', () =>
  {
    expect(SURROUND_GAIN_DB).toBeCloseTo(7.649, 3)
    expect(SURROUND_TOLERANCE_DB).toBe(0.3)
  })

  it.each(SELFTEST_BUILDS)('reads mono -21.1 and 5.1 -13.4 LUFS from the recorded %s surround meter', (build) =>
  {
    const lines = recordedLines(build, 'meter-surround', 'stderr')
    expect(surroundGainDb(lines)).toBeCloseTo(7.7, 6)
    expect(selfTest('meter-surround').pass(recordedResult(build, 'meter-surround'), lines)).toBe(true)
  })

  it('fails the surround meter when 5.1 strays more than 0.3 dB from the weighting, as on a build that reads surround too loud', () =>
  {
    const meter = selfTest('meter-surround')
    const lines = recordedLines('9.0.2', 'meter-surround', 'stderr')
    const surround = (lufs: string): string[] => lines.map((line) => line.replace('I:         -13.4 LUFS', `I:         ${lufs} LUFS`))
    expect(meter.pass(result(), surround('-13.6'))).toBe(true)
    expect(meter.pass(result(), surround('-13.2'))).toBe(true)
    expect(meter.pass(result(), surround('-13.0'))).toBe(false)
    expect(meter.pass(result(), surround('-13.8'))).toBe(false)
    expect(meter.pass(result(), surround('10.0'))).toBe(false)
    expect(meter.pass(result(), surround('-21.1'))).toBe(false)
    expect(meter.pass(result(), lines.map((line) => line.replace('I:         -21.1 LUFS', 'I:          -5.0 LUFS')))).toBe(false)
  })

  it('fails the surround meter when either block or its reading is missing, or the run did not end cleanly', () =>
  {
    const meter = selfTest('meter-surround')
    const lines = recordedLines('9.0.2', 'meter-surround', 'stderr')
    expect(meter.pass(result(), lines.map((line) => line.replace('ebur128@surround', 'ebur128@other')))).toBe(false)
    expect(meter.pass(result(), lines.map((line) => line.replace('ebur128@mono', 'ebur128@other')))).toBe(false)
    expect(surroundGainDb(lines.map((line) => line.replace('I:         -21.1 LUFS', 'I:         nan LUFS')))).toBeNull()
    expect(meter.pass(result(), [])).toBe(false)
    expect(meter.pass(result({ code: 1 }), lines)).toBe(false)
    expect(meter.pass(result({ stopped: 'killed' }), lines)).toBe(false)
  })

  it('reads the last Summary of each meter past the empty first ones the 2022 build prints', () =>
  {
    const lines = recordedLines('2022-10-13', 'meter-surround', 'stderr')
    expect(lines.filter((line) => line.endsWith('] [info] Summary:'))).toHaveLength(4)
    expect(lines.filter((line) => line.includes('I:         -70.0 LUFS'))).toHaveLength(2)
    expect(surroundGainDb(lines)).toBeCloseTo(7.7, 6)
  })

  it('fails the encoder test when a required encoder is missing or experimental', () =>
  {
    const encoders = selfTest('encoders')
    const lines = recordedLines('9.0.2', 'encoders', 'stdout')
    expect(encoders.pass(result(), lines)).toBe(true)
    expect(encoders.pass(result(), lines.filter((line) => !/\slibopus\s/.test(line)))).toBe(false)
    expect(encoders.pass(result(), lines.map((line) => line.replace(/^ A....D aac /, ' A..X.D aac ')))).toBe(false)
    expect(encoders.pass(result(), lines.filter((line) => !/\slibvorbis\s/.test(line)))).toBe(true)
  })
})

describe('hasRequiredEncoders', () =>
{
  it('needs every required encoder and none of them experimental', () =>
  {
    const all = new Set(REQUIRED_ENCODERS)
    expect(hasRequiredEncoders(all, new Set())).toBe(true)
    expect(hasRequiredEncoders(all, new Set(['aac']))).toBe(false)
    expect(hasRequiredEncoders(new Set(REQUIRED_ENCODERS.filter((e) => e !== 'eac3')), new Set())).toBe(false)
  })
})

describe('self-test cache', () =>
{
  const identity: BinaryIdentity = { path: 'C:/x/ffmpeg.exe', size: 1000, mtimeMs: 1700000000000 }
  const results = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true])) as Record<SelfTestId, boolean>
  const record: SelfTestRecord = { identity, rev: SELF_TEST_REV, results }

  it('reuses a result for the same binary and rules', () =>
  {
    const cached = cachedSelfTest(record, { ...identity })
    expect(cached).toEqual(results)
    expect(cached).not.toBe(results)
  })

  it.each([
    ['another path', { ...identity, path: 'C:/y/ffmpeg.exe' }],
    ['another size', { ...identity, size: 1001 }],
    ['another mtime', { ...identity, mtimeMs: 1700000000001 }]
  ])('runs again for %s', (_label, other) =>
  {
    expect(cachedSelfTest(record, other)).toBeNull()
  })

  it('runs again for older rules, a missing record, or incomplete results', () =>
  {
    expect(cachedSelfTest({ ...record, rev: SELF_TEST_REV - 1 }, identity)).toBeNull()
    expect(cachedSelfTest(null, identity)).toBeNull()
    expect(cachedSelfTest(undefined, identity)).toBeNull()
    const partial = { ...results } as Partial<Record<SelfTestId, boolean>>
    delete partial.encoders
    expect(cachedSelfTest({ ...record, results: partial as Record<SelfTestId, boolean> }, identity)).toBeNull()
    expect(cachedSelfTest({ ...record, identity: undefined as unknown as BinaryIdentity }, identity)).toBeNull()
    expect(cachedSelfTest({ ...record, results: undefined as unknown as Record<SelfTestId, boolean> }, identity)).toBeNull()
  })
})

describe('selfTestFailure and pipelineRefusal', () =>
{
  const pass = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true])) as Record<SelfTestId, boolean>

  it('lets the pipeline run without soxr', () =>
  {
    expect(selfTestFailure({ ...pass, soxr: false })).toBeNull()
    expect(pipelineRefusal({ versionString: '9.0.2', meetsMinimum: true, selfTest: { ...pass, soxr: false } })).toBeNull()
  })

  it('lets the pipeline run with a surround meter that misreads, since only surround loudness jobs depend on it', () =>
  {
    expect(selfTestFailure({ ...pass, 'meter-surround': false })).toBeNull()
    expect(selfTestFailure({ ...pass, 'meter-surround': false, soxr: false, encoders: false })).toBe('encoders')
    expect(pipelineRefusal({ versionString: '9.0.2', meetsMinimum: true, selfTest: { ...pass, 'meter-surround': false } })).toBeNull()
  })

  it('names the first failing test', () =>
  {
    expect(selfTestFailure({ ...pass, 'chain-aac-mono': false, encoders: false })).toBe('chain-aac-mono')
    expect(pipelineRefusal({ versionString: '9.0.2', meetsMinimum: true, selfTest: { ...pass, 'meter-dual-mono': false } }))
      .toBe('FFmpeg failed the meter-dual-mono self-test')
  })

  it('reports the minimum before any test', () =>
  {
    expect(pipelineRefusal({ versionString: '5.0.1', meetsMinimum: false, selfTest: { ...pass, encoders: false } }))
      .toBe('FFmpeg 5.1 or newer is required; found 5.0.1')
  })
})

describe('parsePin', () =>
{
  const valid = {
    build: 'btbn-n9.0.2-17-g2a571b6068',
    url: 'https://example.com/a.zip',
    bytes: 10,
    sha256: 'a'.repeat(64),
    kind: 'zip',
    contains: ['ffmpeg', 'ffprobe']
  }
  const pinWith = (primary: unknown, fallback: unknown = []): unknown =>
    ({ id: 'x', version: '9.0.2', fetched: '2026-10-17', platforms: { 'win32-x64': { primary, fallback } } })

  it('reads the shipped pin for every supported host', () =>
  {
    expect(PIN.version).toBe('9.0.2')
    expect(Object.keys(PIN.platforms).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'])
    for (const entry of Object.values(PIN.platforms))
    {
      for (const asset of [...entry.primary, ...entry.fallback])
      {
        expect(isPinId(asset.build)).toBe(true)
        expect(asset.url.startsWith('https://')).toBe(true)
      }
    }
  })

  it('accepts a build split across two archives', () =>
  {
    const split = parsePin(pinWith([{ ...valid, contains: ['ffmpeg'] }, { ...valid, url: 'https://example.com/b.zip', contains: ['ffprobe'] }]))
    expect(split.platforms['win32-x64'].primary).toHaveLength(2)
  })

  it.each([
    ['a plain http URL', { ...valid, url: 'http://example.com/a.zip' }],
    ['a short digest', { ...valid, sha256: 'abc' }],
    ['an upper-case digest', { ...valid, sha256: 'A'.repeat(64) }],
    ['a folder name outside the id pattern', { ...valid, build: '../escape' }],
    ['a zero size', { ...valid, bytes: 0 }],
    ['a fractional size', { ...valid, bytes: 1.5 }],
    ['an unknown archive kind', { ...valid, kind: '7z' }],
    ['an unknown tool', { ...valid, contains: ['ffplay'] }],
    ['no tools', { ...valid, contains: [] }],
    ['a missing field', { ...valid, url: undefined }]
  ])('refuses %s', (_label, asset) =>
  {
    expect(() => parsePin(pinWith([asset]))).toThrow('Invalid pinned asset at win32-x64.primary[0]')
  })

  it('refuses a set that mixes builds or lacks ffprobe', () =>
  {
    expect(() => parsePin(pinWith([valid, { ...valid, build: 'gyan-9.0.2-full' }]))).toThrow('must form one build')
    expect(() => parsePin(pinWith([{ ...valid, contains: ['ffmpeg'] }]))).toThrow('must form one build')
  })

  it('refuses a malformed list or document', () =>
  {
    expect(() => parsePin(pinWith('nope'))).toThrow('Invalid pinned asset list at win32-x64.primary')
    expect(() => parsePin(pinWith([], null))).toThrow('Invalid pinned asset list at win32-x64.fallback')
    expect(() => parsePin({ id: 'x', version: '9.0.2', fetched: '2026-10-17', platforms: { k: null } })).toThrow('Invalid pinned asset list at k.primary')
    expect(() => parsePin(null)).toThrow('Invalid pinned build list')
    expect(() => parsePin({ id: 'x', version: '9.0.2', fetched: '2026-10-17' })).toThrow('Invalid pinned build list')
    expect(() => parsePin({ id: 1, version: '9.0.2', fetched: '2026-10-17', platforms: {} })).toThrow('Invalid pinned build list')
    expect(() => parsePin(pinWith([null]))).toThrow('Invalid pinned asset at win32-x64.primary[0]')
  })
})

describe('selectAssets', () =>
{
  it('picks the BtbN zip with the gyan fallback on Windows x64', () =>
  {
    const picked = selectAssets(PIN, 'win32', 'x64')
    expect(picked?.primary.map((a) => [a.build, a.kind, a.bytes])).toEqual([['btbn-n9.0.2-17-g2a571b6068', 'zip', 194034585]])
    expect(picked?.fallback.map((a) => [a.build, a.sha256])).toEqual([['gyan-9.0.2-full', '759d0a9831c436a0eb331ad36f236c06cb04aaa0005da46571f0e9d3d9206f6b']])
  })

  it('has no fallback on Windows arm64', () =>
  {
    const picked = selectAssets(PIN, 'win32', 'arm64')
    expect(picked?.primary[0].url).toMatch(/winarm64-gpl-9\.0\.zip$/)
    expect(picked?.fallback).toEqual([])
  })

  it.each([['x64', 'linux64', 'amd64'], ['arm64', 'linuxarm64', 'arm64']])('picks the BtbN tarball and martin-riedl zips on Linux %s', (arch, btbn, mriedl) =>
  {
    const picked = selectAssets(PIN, 'linux', arch)
    expect(picked?.primary.map((a) => a.kind)).toEqual(['tar.xz'])
    expect(picked?.primary[0].url).toContain(`-${btbn}-gpl-9.0.tar.xz`)
    expect(picked?.fallback.map((a) => a.contains)).toEqual([['ffmpeg'], ['ffprobe']])
    expect(picked?.fallback.every((a) => a.url.includes(`/download/linux/${mriedl}/`))).toBe(true)
  })

  it.each([['arm64', 'arm64'], ['x64', 'amd64']])('picks the martin-riedl pair on macOS %s with no download fallback', (arch, folder) =>
  {
    const picked = selectAssets(PIN, 'darwin', arch)
    expect(picked?.primary.map((a) => [a.build, a.contains[0]])).toEqual([['mriedl-9.0.2', 'ffmpeg'], ['mriedl-9.0.2', 'ffprobe']])
    expect(picked?.primary.every((a) => a.url.includes(`/download/macos/${folder}/`))).toBe(true)
    expect(picked?.fallback).toEqual([])
  })

  it('returns copies, so a caller cannot edit the pin', () =>
  {
    const picked = selectAssets(PIN, 'win32', 'x64')
    picked?.primary.pop()
    expect(PIN.platforms['win32-x64'].primary).toHaveLength(1)
  })

  it.each([['freebsd', 'x64'], ['win32', 'ia32'], ['linux', 'riscv64']] as Array<[NodeJS.Platform, string]>)('has nothing for %s %s', (platform, arch) =>
  {
    expect(selectAssets(PIN, platform, arch)).toBeNull()
  })
})

describe('verifyDigest', () =>
{
  async function* chunked(data: Buffer, size: number, pulled?: { count: number }): AsyncGenerator<Uint8Array>
  {
    for (let i = 0; i < data.length; i += size)
    {
      if (pulled)
      {
        pulled.count++
      }
      yield data.subarray(i, i + size)
    }
  }

  const data = Buffer.from('molexMedia pinned FFmpeg asset '.repeat(1000))
  const sha256 = createHash('sha256').update(data).digest('hex')

  it('hashes the stream as it arrives', async () =>
  {
    const verdict = await verifyDigest(chunked(data, 997), { bytes: data.length, sha256 })
    expect(verdict).toEqual({ ok: true, bytes: data.length, sha256 })
  })

  it('accepts an upper-case expected digest', async () =>
  {
    expect((await verifyDigest(chunked(data, 4096), { bytes: data.length, sha256: sha256.toUpperCase() })).ok).toBe(true)
  })

  it('fails a short download on its size', async () =>
  {
    const verdict = await verifyDigest(chunked(data.subarray(0, data.length - 1), 997), { bytes: data.length, sha256 })
    expect(verdict.ok).toBe(false)
    expect(verdict.bytes).toBe(data.length - 1)
  })

  it('fails a same-size download with other content on its digest', async () =>
  {
    const other = Buffer.from(data)
    other[100] ^= 1
    const verdict = await verifyDigest(chunked(other, 997), { bytes: data.length, sha256 })
    expect(verdict.ok).toBe(false)
    expect(verdict.bytes).toBe(data.length)
    expect(verdict.sha256).not.toBe(sha256)
  })

  it('stops reading once the stream passes the expected size', async () =>
  {
    const pulled = { count: 0 }
    const verdict = await verifyDigest(chunked(Buffer.concat([data, data, data]), 1000, pulled), { bytes: 2500, sha256 })
    expect(verdict.ok).toBe(false)
    expect(verdict.bytes).toBe(3000)
    expect(pulled.count).toBe(3)
  })
})

describe('planInstall', () =>
{
  const winPrimary = PIN.platforms['win32-x64'].primary[0].url
  const winFallback = PIN.platforms['win32-x64'].fallback[0].url

  it('reuses an installed folder of the pin', () =>
  {
    expect(planInstall(PIN, 'win32-x64', ['btbn-n9.0.1-3-gabcdef0', 'btbn-n9.0.2-17-g2a571b6068'], [])).toEqual({ kind: 'reuse', folder: 'btbn-n9.0.2-17-g2a571b6068' })
    expect(planInstall(PIN, 'win32-x64', ['gyan-9.0.2-full'], [{ url: winPrimary, status: 404 }])).toEqual({ kind: 'reuse', folder: 'gyan-9.0.2-full' })
  })

  it('downloads the primary build first, and again after an error that is not 404 or 410', () =>
  {
    expect(planInstall(PIN, 'win32-x64', ['btbn-n9.0.1-3-gabcdef0'], [])).toEqual({ kind: 'download', assets: PIN.platforms['win32-x64'].primary, source: 'primary' })
    expect(planInstall(PIN, 'win32-x64', [], [{ url: winPrimary, status: 503 }])).toMatchObject({ kind: 'download', source: 'primary' })
  })

  it('falls back after the primary answers 404', () =>
  {
    expect(planInstall(PIN, 'win32-x64', [], [{ url: winPrimary, status: 404 }])).toEqual({ kind: 'download', assets: PIN.platforms['win32-x64'].fallback, source: 'fallback' })
  })

  it('falls back when either archive of a split build is gone', () =>
  {
    const primary = PIN.platforms['darwin-arm64'].primary
    expect(planInstall(PIN, 'darwin-arm64', [], [{ url: primary[1].url, status: 410 }])).toEqual({ kind: 'offer-alternatives' })
    const linux = PIN.platforms['linux-x64']
    expect(planInstall(PIN, 'linux-x64', [], [{ url: linux.primary[0].url, status: 410 }])).toEqual({ kind: 'download', assets: linux.fallback, source: 'fallback' })
  })

  it('offers alternatives after the primary and the fallback answer 410', () =>
  {
    expect(planInstall(PIN, 'win32-x64', [], [{ url: winPrimary, status: 410 }, { url: winFallback, status: 410 }])).toEqual({ kind: 'offer-alternatives' })
  })

  it('offers alternatives when the primary is gone and there is no fallback', () =>
  {
    expect(planInstall(PIN, 'win32-arm64', [], [{ url: PIN.platforms['win32-arm64'].primary[0].url, status: 404 }])).toEqual({ kind: 'offer-alternatives' })
  })

  it('offers alternatives for a platform key the pin lacks', () =>
  {
    expect(planInstall(PIN, 'freebsd-x64', ['btbn-n9.0.2-17-g2a571b6068'], [])).toEqual({ kind: 'offer-alternatives' })
  })

  it('offers alternatives for an empty platform entry', () =>
  {
    const empty: PinnedBuilds = { ...PIN, platforms: { 'win32-x64': { primary: [], fallback: [] } } }
    expect(planInstall(empty, 'win32-x64', [], [])).toEqual({ kind: 'offer-alternatives' })
  })
})

describe('foldersToDelete', () =>
{
  it('keeps the current id and deletes the other pinned folders and staging leftovers', () =>
  {
    const entries = [
      'btbn-n9.0.2-17-g2a571b6068',
      'btbn-n9.0.1-3-gabcdef0123',
      'gyan-9.0.1-full',
      'mriedl-8.1.2',
      'btbn-n9.0.2-17-g2a571b6068.part-Ab12Cd',
      'gyan-9.0.2-full.part-x9y8z7'
    ]
    expect(foldersToDelete('btbn-n9.0.2-17-g2a571b6068', entries)).toEqual(entries.slice(1))
  })

  it('never deletes a folder outside the pin id pattern', () =>
  {
    const entries = ['custom', 'ffmpeg-bin', 'bin', 'btbn-latest', 'btbn-n9.0.2-17-g2a571b6068-extra', 'mriedl-9.0.2/..', '..', 'gyan-9.0.2-essentials', 'notes.part-abc', 'MRIEDL-9.0.2']
    expect(foldersToDelete('mriedl-9.0.2', entries)).toEqual([])
  })

  it('keeps nothing extra when the current id is not on disk', () =>
  {
    expect(foldersToDelete('mriedl-9.0.2', ['mriedl-9.0.1'])).toEqual(['mriedl-9.0.1'])
  })
})

describe('host helpers', () =>
{
  it('names executables per platform', () =>
  {
    expect(executableName('ffmpeg', 'win32')).toBe('ffmpeg.exe')
    expect(executableName('ffprobe', 'darwin')).toBe('ffprobe')
    expect(pinKey('linux', 'arm64')).toBe('linux-arm64')
  })

  it('splits a Windows PATH, dropping quotes, blanks, and repeats', () =>
  {
    expect(searchDirs('win32', 'C:\\ffmpeg\\bin;;"C:\\Program Files\\Tools";C:\\ffmpeg\\bin; ')).toEqual(['C:\\ffmpeg\\bin', 'C:\\Program Files\\Tools'])
  })

  it('adds the Homebrew folders on macOS once', () =>
  {
    expect(searchDirs('darwin', '/usr/bin:/usr/local/bin')).toEqual(['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'])
    expect(searchDirs('darwin', undefined)).toEqual(['/opt/homebrew/bin', '/usr/local/bin'])
  })

  it('adds nothing on Linux', () =>
  {
    expect(searchDirs('linux', '/usr/bin:/bin')).toEqual(['/usr/bin', '/bin'])
    expect(searchDirs('linux', '')).toEqual([])
  })
})

describe('discoveryCandidates', () =>
{
  const base = {
    configured: null,
    pin: PIN,
    installed: [] as string[],
    envPath: undefined as string | undefined
  }

  it('tries the configured build, the pinned folders, the legacy folder, then PATH on Windows', () =>
  {
    const primary = PIN.platforms['win32-x64'].primary[0].build
    const fallback = PIN.platforms['win32-x64'].fallback[0].build
    const list = discoveryCandidates({
      ...base,
      configured: { source: 'custom', buildId: null, ffmpegPath: 'D:\\tools\\ffmpeg.exe', ffprobePath: 'D:\\tools\\ffprobe.exe', selfTest: null },
      platform: 'win32',
      arch: 'x64',
      root: 'C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg',
      installed: [fallback, 'notes', primary],
      legacyDir: 'C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg-bin',
      envPath: 'C:\\ffmpeg\\bin;"C:\\Program Files\\FFmpeg\\bin";D:\\tools'
    })
    expect(list).toEqual([
      { source: 'custom', buildId: null, ffmpegPath: 'D:\\tools\\ffmpeg.exe', ffprobePath: 'D:\\tools\\ffprobe.exe' },
      { source: 'bundled', buildId: primary, ffmpegPath: `C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg\\${primary}\\ffmpeg.exe`, ffprobePath: `C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg\\${primary}\\ffprobe.exe` },
      { source: 'bundled', buildId: fallback, ffmpegPath: `C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg\\${fallback}\\ffmpeg.exe`, ffprobePath: `C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg\\${fallback}\\ffprobe.exe` },
      { source: 'bundled', buildId: null, ffmpegPath: 'C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg-bin\\ffmpeg.exe', ffprobePath: 'C:\\Users\\u\\AppData\\Roaming\\molex-media\\ffmpeg-bin\\ffprobe.exe' },
      { source: 'path', buildId: null, ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe', ffprobePath: 'C:\\ffmpeg\\bin\\ffprobe.exe' },
      { source: 'path', buildId: null, ffmpegPath: 'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe', ffprobePath: 'C:\\Program Files\\FFmpeg\\bin\\ffprobe.exe' }
    ])
  })

  it('adds the Homebrew folders on macOS, where Finder launches do not inherit the shell PATH', () =>
  {
    const list = discoveryCandidates({ ...base, platform: 'darwin', arch: 'arm64', root: '/Users/u/Library/Application Support/molex-media/ffmpeg', legacyDir: '/Users/u/Library/Application Support/molex-media/ffmpeg-bin', envPath: '/usr/bin:/bin' })
    expect(list.map((c) => c.ffmpegPath)).toEqual([
      '/Users/u/Library/Application Support/molex-media/ffmpeg-bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg'
    ])
    expect(list[3]).toEqual({ source: 'path', buildId: null, ffmpegPath: '/opt/homebrew/bin/ffmpeg', ffprobePath: '/opt/homebrew/bin/ffprobe' })
  })

  it('lists a configured pinned folder once and skips pins for a host the pin does not cover', () =>
  {
    const id = PIN.platforms['linux-x64'].primary[0].build
    const configured = { source: 'bundled' as const, buildId: id, ffmpegPath: `/home/u/.config/molex-media/ffmpeg/${id}/ffmpeg`, ffprobePath: `/home/u/.config/molex-media/ffmpeg/${id}/ffprobe`, selfTest: null }
    const list = discoveryCandidates({ ...base, configured, platform: 'linux', arch: 'x64', root: '/home/u/.config/molex-media/ffmpeg', installed: [id], legacyDir: '/home/u/.config/molex-media/ffmpeg-bin', envPath: '' })
    expect(list.map((c) => c.buildId)).toEqual([id, null])
    const other = discoveryCandidates({ ...base, platform: 'freebsd', arch: 'x64', root: '/r', installed: [id], legacyDir: '/r-bin', envPath: '/usr/local/bin' })
    expect(other.map((c) => c.ffmpegPath)).toEqual(['/r-bin/ffmpeg', '/usr/local/bin/ffmpeg'])
  })
})

describe('assembleBuildInfo and configBlock', () =>
{
  const identity: BinaryIdentity = { path: 'C:\\ff\\ffmpeg.exe', size: 165155840, mtimeMs: 1790758707000 }
  const candidate = { source: 'bundled' as const, buildId: 'btbn-n9.0.2-17-g2a571b6068', ffmpegPath: 'C:\\ff\\ffmpeg.exe', ffprobePath: 'C:\\ff\\ffprobe.exe' }
  const passed = Object.fromEntries(SELF_TEST_IDS.map((id) => [id, true])) as Record<SelfTestId, boolean>

  it('reads the pinned 9.0.2 build as meeting the minimum, with soxr from its self-test', () =>
  {
    const built = assembleBuildInfo({ candidate, identity, versionStdout: info('9.0.2', 'version.stdout.txt'), encodersStdout: info('9.0.2', 'encoders.stdout.txt'), selfTest: passed })
    expect(built.versionString).toBe('n9.0.2-17-g2a571b6068-20260930')
    expect(built.meetsMinimum).toBe(true)
    expect(built.soxr).toBe(true)
    expect(built.surroundMeter).toBe(true)
    expect(hasRequiredEncoders(built.encoders, built.experimental)).toBe(true)
    expect(built.identity).toEqual(identity)
    expect(pipelineRefusal(built)).toBeNull()
    expect(built.source).toBe('bundled')
  })

  it('refuses the recorded 4.4.2 build with the minimum message and marks its self-test as not run', () =>
  {
    const built = assembleBuildInfo({ candidate: { ...candidate, source: 'path' }, identity, versionStdout: info('4.4.2', 'version.stdout.txt'), encodersStdout: '', selfTest: null })
    expect(built.meetsMinimum).toBe(false)
    expect(built.selfTest).toEqual(notRun())
    expect(built.soxr).toBe(false)
    expect(built.surroundMeter).toBe(false)
    expect(pipelineRefusal(built)).toBe('FFmpeg 5.1 or newer is required; found 4.4.2')
  })

  it('names the failing self-test of a build that meets the minimum', () =>
  {
    const built = assembleBuildInfo({ candidate, identity, versionStdout: info('2022-10-13', 'version.stdout.txt'), encodersStdout: info('2022-10-13', 'encoders.stdout.txt'), selfTest: { ...passed, 'chain-opus-51side': false, soxr: false } })
    expect(built.meetsMinimum).toBe(true)
    expect(built.soxr).toBe(false)
    expect(pipelineRefusal(built)).toBe('FFmpeg failed the chain-opus-51side self-test')
  })

  it('adopts a build whose surround meter misreads, carrying the result as surroundMeter', () =>
  {
    const results = { ...passed, 'meter-surround': false }
    const built = assembleBuildInfo({ candidate, identity, versionStdout: info('9.0.2', 'version.stdout.txt'), encodersStdout: info('9.0.2', 'encoders.stdout.txt'), selfTest: results })
    expect(built.surroundMeter).toBe(false)
    expect(built.soxr).toBe(true)
    expect(pipelineRefusal(built)).toBeNull()
    expect(cachedSelfTest(configBlock(candidate, built).selfTest, identity)).toEqual(results)
  })

  it('records the accepted build with its self-test under the current rules, so the cache hits next time', () =>
  {
    const block = configBlock(candidate, { identity, selfTest: { ...passed, soxr: false } })
    expect(block).toEqual({ source: 'bundled', buildId: 'btbn-n9.0.2-17-g2a571b6068', ffmpegPath: 'C:\\ff\\ffmpeg.exe', ffprobePath: 'C:\\ff\\ffprobe.exe', selfTest: { identity, rev: SELF_TEST_REV, results: { ...passed, soxr: false } } })
    expect(cachedSelfTest(block.selfTest, { ...identity })).toEqual({ ...passed, soxr: false })
    expect(cachedSelfTest(block.selfTest, { ...identity, mtimeMs: identity.mtimeMs + 1 })).toBeNull()
  })
})

describe('bootstrap messages', () =>
{
  it('uses the checksum message of the install rules', () =>
  {
    expect(CHECKSUM_MESSAGE).toBe('Download did not match the expected checksum')
  })

  it('offers a PATH build at or above 5.1 or an app update when no download works', () =>
  {
    expect(alternativesMessage('win32-ia32')).toBe('FFmpeg could not be downloaded for win32-ia32. Install FFmpeg 5.1 or newer and add it to PATH, or update molexMedia.')
  })
})