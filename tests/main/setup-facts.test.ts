/**
 * What first-run setup reads from main without changing anything: the tested build's download size and publisher
 * from the pin, and the builds a chosen folder may hold.
 */
import { describe, expect, it } from 'vitest'
import { parsePin, type Asset, type PinnedBuilds } from '../../src/main/ffmpeg/build'
import { pinnedDownloadFacts, publisherOf } from '../../src/main/ffmpeg/download-facts'
import { folderCandidates } from '../../src/main/ffmpeg/folder'
import pinJson from '../../src/main/ffmpeg/pinned-builds.json'

function asset(build: string, url: string, bytes: number, contains: Asset['contains']): Asset
{
  return { build, url, bytes, sha256: 'a'.repeat(64), kind: 'zip', contains }
}

const PIN: PinnedBuilds = {
  id: 'test',
  version: '9.0.2',
  fetched: '2026-10-20',
  platforms: {
    'win32-x64': {
      version: '9.0.2',
      primary: [asset('btbn-n9.0.2-17-g2a571b6068', 'https://github.com/BtbN/FFmpeg-Builds/releases/download/x/a.zip', 194_034_585, ['ffmpeg', 'ffprobe'])],
      fallback: [asset('gyan-9.0.2-full', 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/b.zip', 257_736_868, ['ffmpeg', 'ffprobe'])]
    },
    'darwin-arm64': {
      version: '7.1.1',
      primary: [
        asset('mriedl-7.1.1', 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1/ffmpeg.zip', 30_000_000, ['ffmpeg']),
        asset('mriedl-7.1.1', 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1/ffprobe.zip', 29_000_000, ['ffprobe'])
      ],
      fallback: []
    },
    'linux-riscv64': { version: '9.0.2', primary: [], fallback: [] },
    'freebsd-x64': {
      version: '9.0.2',
      primary: [asset('btbn-n9.0.2-1-gabc', 'https://downloads.example.org/ffmpeg.zip', 5_000_000, ['ffmpeg', 'ffprobe'])],
      fallback: []
    }
  }
}

describe('download facts', () =>
{
  it('names each pinned publisher by its install folder prefix', () =>
  {
    expect(publisherOf('btbn-n9.0.2-17-g2a571b6068')).toBe('BtbN FFmpeg Builds')
    expect(publisherOf('gyan-9.0.2-full')).toBe('Gyan.dev')
    expect(publisherOf('mriedl-7.1.1')).toBe('Martin Riedl')
    expect(publisherOf('custom-build')).toBeNull()
  })

  it('sums the primary assets of the host and names where they come from', () =>
  {
    expect(pinnedDownloadFacts(PIN, 'win32', 'x64')).toEqual({ bytes: 194_034_585, publisher: 'BtbN FFmpeg Builds', host: 'github.com' })
    expect(pinnedDownloadFacts(PIN, 'darwin', 'arm64')).toEqual({ bytes: 59_000_000, publisher: 'Martin Riedl', host: 'ffmpeg.martin-riedl.de' })
  })

  it('falls back to the host for a publisher it does not know, and answers null without a build', () =>
  {
    const unknown: PinnedBuilds = { ...PIN, platforms: { 'win32-x64': { version: '9.0.2', primary: [asset('other-1', 'https://cdn.example.org/f.zip', 10, ['ffmpeg', 'ffprobe'])], fallback: [] } } }
    expect(pinnedDownloadFacts(unknown, 'win32', 'x64')).toEqual({ bytes: 10, publisher: 'cdn.example.org', host: 'cdn.example.org' })
    expect(pinnedDownloadFacts(PIN, 'linux', 'riscv64')).toBeNull()
    expect(pinnedDownloadFacts(PIN, 'sunos', 'x64')).toBeNull()
  })

  it('reads facts for every host the shipped pin covers', () =>
  {
    const pin = parsePin(pinJson)
    for (const key of Object.keys(pin.platforms))
    {
      const [platform, arch] = key.split('-') as [NodeJS.Platform, string]
      const facts = pinnedDownloadFacts(pin, platform, arch)
      expect(facts, key).not.toBeNull()
      expect(facts!.bytes, key).toBeGreaterThan(1_000_000)
      expect(facts!.publisher, key).not.toBe(facts!.host)
    }
  })
})

describe('folder candidates', () =>
{
  it('tries the chosen folder, then its bin folder, as custom builds', () =>
  {
    expect(folderCandidates('D:\\Tools\\ffmpeg', 'win32')).toEqual([
      { source: 'custom', buildId: null, ffmpegPath: 'D:\\Tools\\ffmpeg\\ffmpeg.exe', ffprobePath: 'D:\\Tools\\ffmpeg\\ffprobe.exe' },
      { source: 'custom', buildId: null, ffmpegPath: 'D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe', ffprobePath: 'D:\\Tools\\ffmpeg\\bin\\ffprobe.exe' }
    ])
    expect(folderCandidates('/opt/ffmpeg', 'linux').map((c) => c.ffmpegPath)).toEqual(['/opt/ffmpeg/ffmpeg', '/opt/ffmpeg/bin/ffmpeg'])
  })
})
