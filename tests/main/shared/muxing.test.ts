/**
 * The measured video encoder by container table: every cell against the recorded fixture on both builds, the cells
 * where the builds differ, and the fit answers the inspector fields and the job checks read.
 */
import { describe, it, expect } from 'vitest'
import fixture from '../fixtures/ffmpeg/muxers/muxers-2026-10-17.json'
import { VIDEO_EXTENSIONS } from '../../../src/shared/jobs/extensions'
import
{
  MUX_BUILDS,
  MUX_TABLE,
  VIDEO_CODEC_IDS,
  codecFit,
  compressContainer,
  muxCell,
  videoCodecName,
  videoEncoderFit,
  type MuxBuild
} from '../../../src/shared/jobs/muxing'
import { VIDEO_ENCODERS } from '../../../src/shared/jobs/recipes'

interface FixtureCell
{
  status: string
  message: string
}

const results = fixture.results as Record<MuxBuild, Record<string, Record<string, FixtureCell>>>
const encoders = fixture.encoders as Record<string, { codec: string; args: string[] }>

describe('muxing table', () =>
{
  it('was measured for every recipe encoder against every video extension the app opens', () =>
  {
    expect(Object.keys(encoders)).toEqual([...VIDEO_ENCODERS])
    expect(fixture.extensions).toEqual([...VIDEO_EXTENSIONS])
    expect(Object.keys(results).sort()).toEqual([...MUX_BUILDS].sort())
    for (const encoder of VIDEO_ENCODERS)
    {
      expect(encoders[encoder].codec).toBe(VIDEO_CODEC_IDS[encoder])
    }
  })

  it('records the builds it was measured on', () =>
  {
    expect(fixture.versions.legacy).toMatch(/^ffmpeg version 2022-10-13-/)
    expect(fixture.versions.pinned).toMatch(/^ffmpeg version n9\.0\.2-/)
  })

  it('matches the fixture in every cell on both builds', () =>
  {
    for (const build of MUX_BUILDS)
    {
      for (const encoder of VIDEO_ENCODERS)
      {
        expect(Object.keys(MUX_TABLE[build][encoder])).toEqual([...VIDEO_EXTENSIONS])
        for (const ext of VIDEO_EXTENSIONS)
        {
          expect({ build, encoder, ext, ...muxCell(encoder, ext, build) }).toEqual({ build, encoder, ext, ...results[build][encoder][ext] })
        }
      }
    }
  })

  it('keeps only statuses and short messages, with no muxer address or local path', () =>
  {
    const text = JSON.stringify(fixture)
    expect(text).not.toMatch(/ @ (0x)?[0-9a-fA-F]{6,}/)
    expect(text).not.toMatch(/[A-Za-z]:(\\\\|\/)/)
    for (const build of MUX_BUILDS)
    {
      for (const encoder of VIDEO_ENCODERS)
      {
        for (const ext of VIDEO_EXTENSIONS)
        {
          const cell = results[build][encoder][ext]
          expect(Object.keys(cell).sort()).toEqual(['message', 'status'])
          expect(['ok', 'refused', 'unreadable', 'no-muxer']).toContain(cell.status)
          expect(cell.message === '').toBe(cell.status === 'ok')
        }
      }
    }
  })

  it('differs between the builds only where 9.0.2 holds what 2022 refused', () =>
  {
    const differ = VIDEO_ENCODERS.flatMap((encoder) => VIDEO_EXTENSIONS
      .filter((ext) => MUX_TABLE.pinned[encoder][ext].status !== MUX_TABLE.legacy[encoder][ext].status)
      .map((ext) => `${encoder} ${ext}`))
    expect(differ).toEqual(['libx265 flv', 'libvpx-vp9 flv', 'libaom-av1 flv', 'libsvtav1 flv', 'ffv1 mp4'])
    for (const pair of differ)
    {
      const [encoder, ext] = pair.split(' ') as [typeof VIDEO_ENCODERS[number], string]
      expect(MUX_TABLE.pinned[encoder][ext].status).toBe('ok')
      expect(MUX_TABLE.legacy[encoder][ext].status).toBe('refused')
    }
  })

  it('holds every encoder in MKV and nothing in DivX, RMVB, or RealMedia', () =>
  {
    for (const build of MUX_BUILDS)
    {
      for (const encoder of VIDEO_ENCODERS)
      {
        expect(MUX_TABLE[build][encoder].mkv.status).toBe('ok')
        expect(MUX_TABLE[build][encoder].divx.status).toBe('no-muxer')
        expect(MUX_TABLE[build][encoder].rmvb.status).toBe('no-muxer')
        expect(MUX_TABLE[build][encoder].rm.status).toBe('unreadable')
      }
    }
  })
})

describe('videoEncoderFit', () =>
{
  it('answers for the pinned build by default and for the legacy build when asked', () =>
  {
    expect(videoEncoderFit('libtheora', 'mp4')).toEqual({
      status: 'refused',
      message: 'Could not find tag for codec theora in stream #0, codec not currently supported in container',
      ok: false,
      reason: 'MP4 cannot hold Theora.'
    })
    expect(videoEncoderFit('ffv1', 'mp4')).toEqual({ status: 'ok', message: '', ok: true, reason: null })
    expect(videoEncoderFit('ffv1', 'mp4', 'pinned')).toEqual(videoEncoderFit('ffv1', 'mp4'))
    expect(videoEncoderFit('ffv1', 'mp4', 'legacy')).toMatchObject({ status: 'refused', ok: false, reason: 'MP4 cannot hold FFV1.' })
    expect(videoEncoderFit('libx265', 'flv')).toMatchObject({ ok: true })
    expect(videoEncoderFit('libx265', 'flv', 'legacy')).toEqual({
      status: 'refused',
      message: 'Video codec hevc not compatible with flv',
      ok: false,
      reason: 'FLV cannot hold HEVC.'
    })
  })

  it('names the codec as users read it, never the encoder', () =>
  {
    expect(videoEncoderFit('libx264', 'webm')?.reason).toBe('WebM cannot hold H.264.')
    expect(videoEncoderFit('libsvtav1', 'mov')).toMatchObject({ reason: 'MOV cannot hold AV1.', message: 'av1 only supported in MP4 and AVIF.' })
    expect(videoEncoderFit('libvpx-vp9', 'mov')).toMatchObject({ reason: 'MOV cannot hold VP9.', message: 'vp9 only supported in MP4.' })
    expect(videoEncoderFit('prores_ks', 'mp4')?.reason).toBe('MP4 cannot hold ProRes.')
    expect(videoEncoderFit('utvideo', 'm4v')?.reason).toBe('M4V cannot hold UT Video.')
    expect(videoEncoderFit('mpeg2video', '3gp')?.reason).toBe('3GP cannot hold MPEG-2.')
    expect(videoEncoderFit('mpeg4', 'flv')).toMatchObject({
      reason: 'FLV cannot hold MPEG-4.',
      message: 'Codec mpeg4 is not supported in the official FLV specification, use vstrict=-1 / -strict -1 to use it anyway.'
    })
    expect(videoEncoderFit('wmv2', 'ogv')).toMatchObject({ reason: 'OGV cannot hold WMV2.', message: 'Unsupported codec id in stream 0' })
    expect(videoEncoderFit('libx265', 'asf')).toMatchObject({ reason: 'ASF cannot hold HEVC.' })
  })

  it('treats a file that reads back as another codec as a container that cannot hold it', () =>
  {
    expect(videoEncoderFit('libvpx-vp9', 'mpg')).toEqual({ status: 'unreadable', message: 'probes as \'nothing\'; Header missing', ok: false, reason: 'MPG cannot hold VP9.' })
    expect(videoEncoderFit('libx265', 'avi')).toMatchObject({ status: 'unreadable', reason: 'AVI cannot hold HEVC.' })
    expect(videoEncoderFit('libx264', 'rm')).toMatchObject({ status: 'unreadable', message: 'probes as \'rv20\'', reason: 'RM cannot hold H.264.' })
    expect(videoEncoderFit('prores_ks', 'wmv')).toMatchObject({ status: 'unreadable', reason: 'WMV cannot hold ProRes.' })
    expect(videoEncoderFit('libaom-av1', 'm2ts')).toMatchObject({ status: 'unreadable', reason: 'M2TS cannot hold AV1.' })
  })

  it('says FFmpeg cannot write a container it has no muxer for', () =>
  {
    expect(videoEncoderFit('libx264', 'divx')).toMatchObject({ status: 'no-muxer', ok: false, reason: 'FFmpeg cannot write DIVX files.' })
    expect(videoEncoderFit('mpeg4', 'rmvb', 'legacy')).toMatchObject({
      status: 'no-muxer',
      message: 'Unable to find a suitable output format for \'out.rmvb\'',
      reason: 'FFmpeg cannot write RMVB files.'
    })
  })

  it('reads an extension with or without its dot, in any case', () =>
  {
    expect(videoEncoderFit('libvpx-vp9', '.WEBM')).toMatchObject({ ok: true })
    expect(videoEncoderFit('libtheora', '.MP4')?.reason).toBe('MP4 cannot hold Theora.')
    expect(muxCell('libx264', '.Mkv')).toEqual({ status: 'ok', message: '' })
  })

  it('gives null for a container the table does not hold', () =>
  {
    expect(videoEncoderFit('libx264', 'mp3')).toBeNull()
    expect(videoEncoderFit('libx264', '')).toBeNull()
    expect(muxCell('libx264', 'constructor')).toBeNull()
    expect(muxCell('libx264', 'gif', 'legacy')).toBeNull()
  })
})

describe('videoCodecName', () =>
{
  it('names every encoder\'s codec', () =>
  {
    expect(VIDEO_ENCODERS.map(videoCodecName)).toEqual(['H.264', 'HEVC', 'VP9', 'AV1', 'AV1', 'ProRes', 'FFV1', 'UT Video', 'MPEG-2', 'MPEG-4', 'Theora', 'WMV2'])
  })
})

describe('codecFit', () =>
{
  it('judges a copied stream by the encoder that writes its codec', () =>
  {
    expect(codecFit('hevc', 'webm')).toMatchObject({ ok: false, reason: 'WebM cannot hold HEVC.' })
    expect(codecFit('AV1', 'mov')).toMatchObject({ ok: false, reason: 'MOV cannot hold AV1.' })
    expect(codecFit('av1', 'flv')).toMatchObject({ ok: true })
    expect(codecFit('av1', 'flv', 'legacy')).toMatchObject({ ok: false, reason: 'FLV cannot hold AV1.' })
    expect(codecFit('theora', '.ogv')).toMatchObject({ ok: true })
  })

  it('gives null for a codec or a container the table does not hold', () =>
  {
    expect(codecFit('dnxhd', 'mov')).toBeNull()
    expect(codecFit('h264', 'mp3')).toBeNull()
  })
})

describe('compressContainer', () =>
{
  it('keeps the source container when it holds the encoder', () =>
  {
    expect(compressContainer('mp4', 'libx265')).toBe('mp4')
    expect(compressContainer('.MOV', 'libx264')).toBe('mov')
    expect(compressContainer('webm', 'libsvtav1')).toBe('webm')
    expect(compressContainer('flv', 'libx265')).toBe('flv')
  })

  it('moves to mkv when the source container cannot hold the encoder on the build', () =>
  {
    expect(compressContainer('webm', 'libx264')).toBe('mkv')
    expect(compressContainer('mov', 'libaom-av1')).toBe('mkv')
    expect(compressContainer('mpg', 'libvpx-vp9')).toBe('mkv')
    expect(compressContainer('divx', 'libx264')).toBe('mkv')
    expect(compressContainer('flv', 'libx265', 'legacy')).toBe('mkv')
    expect(compressContainer('', 'libx264')).toBe('mkv')
  })
})
