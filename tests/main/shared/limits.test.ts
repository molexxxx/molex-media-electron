/**
 * Shared job basics: recipe value lists, the video and extract ranges, the Compress size budget, and the one media
 * extension list that replaces the five copies the main process and the renderer kept.
 */
import { describe, it, expect } from 'vitest'
import { OPERATIONS, VIDEO_ENCODERS } from '../../../src/shared/jobs/recipes'
import {
  CRF_RANGES,
  EXTRACT_SAMPLE_RATES,
  JOB_LIMITS,
  MIN_BUDGET_VIDEO_KBPS,
  SIZE_BUDGET_SHARE,
  inRange,
  sizeBudget
} from '../../../src/shared/jobs/limits'
import {
  AUDIO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  isAudioExtension,
  isMediaPath,
  isVideoExtension
} from '../../../src/shared/jobs/extensions'

describe('recipe value lists', () =>
{
  it('lists the five operations and every video encoder once', () =>
  {
    expect(OPERATIONS).toEqual(['normalize', 'boost', 'convert', 'compress', 'extract'])
    expect(new Set(VIDEO_ENCODERS).size).toBe(VIDEO_ENCODERS.length)
    expect(VIDEO_ENCODERS).toHaveLength(12)
  })
})

describe('ranges', () =>
{
  it('gives x264 and x265 CRF 0 to 51, VP9 and both AV1 encoders 0 to 63, and the rest none', () =>
  {
    expect(CRF_RANGES['libx264']).toEqual({ min: 0, max: 51 })
    expect(CRF_RANGES['libx265']).toEqual({ min: 0, max: 51 })
    for (const encoder of ['libvpx-vp9', 'libaom-av1', 'libsvtav1'] as const)
    {
      expect(CRF_RANGES[encoder], encoder).toEqual({ min: 0, max: 63 })
    }
    expect(VIDEO_ENCODERS.filter((encoder) => CRF_RANGES[encoder] === null))
      .toEqual(['prores_ks', 'ffv1', 'utvideo', 'mpeg2video', 'mpeg4', 'libtheora', 'wmv2'])
  })

  it('holds the field ranges', () =>
  {
    expect(JOB_LIMITS.gifFps).toEqual({ min: 1, max: 60 })
    expect(JOB_LIMITS.frameCount).toEqual({ min: 1, max: 1000 })
    expect(JOB_LIMITS.frameIntervalSec).toEqual({ min: 0.05, max: null })
    expect(JOB_LIMITS.targetBytes).toEqual({ min: 1_000_000, max: null })
    expect(JOB_LIMITS.rangeStartSec).toEqual({ min: 0, max: null })
    expect(JOB_LIMITS.jpgQuality).toEqual({ min: 2, max: 31 })
    expect(JOB_LIMITS.gifWidth).toEqual({ min: 1, max: 3840 })
    expect(EXTRACT_SAMPLE_RATES).toEqual([44100, 48000, 96000])
    for (const [name, range] of Object.entries(JOB_LIMITS))
    {
      expect(range.max === null || range.max > range.min, name).toBe(true)
    }
  })

  it('checks a value against a range, bounds included', () =>
  {
    expect(inRange(0, JOB_LIMITS.rangeStartSec)).toBe(true)
    expect(inRange(1e9, JOB_LIMITS.rangeStartSec)).toBe(true)
    expect(inRange(-0.001, JOB_LIMITS.rangeStartSec)).toBe(false)
    expect(inRange(1, JOB_LIMITS.gifFps)).toBe(true)
    expect(inRange(60, JOB_LIMITS.gifFps)).toBe(true)
    expect(inRange(61, JOB_LIMITS.gifFps)).toBe(false)
    expect(inRange(0.049, JOB_LIMITS.frameIntervalSec)).toBe(false)
    expect(inRange(999_999, JOB_LIMITS.targetBytes)).toBe(false)
    expect(inRange(Number.NaN, JOB_LIMITS.gifFps)).toBe(false)
    expect(inRange(Number.POSITIVE_INFINITY, JOB_LIMITS.targetBytes)).toBe(false)
    expect(inRange('30', JOB_LIMITS.gifFps)).toBe(false)
  })
})

describe('sizeBudget', () =>
{
  it('aims at about 97 percent of the target from the duration and the audio bitrate', () =>
  {
    const budget = sizeBudget(25_000_000, 134, [96])
    expect(SIZE_BUDGET_SHARE).toBe(0.97)
    expect(budget).not.toBeNull()
    if (!budget)
    {
      return
    }
    expect(budget.budgetBytes).toBe(24_250_000)
    expect(budget.totalKbps).toBeCloseTo((24_250_000 * 8) / 134 / 1000, 9)
    expect(budget.audioKbps).toBe(96)
    expect(budget.videoKbps).toBe(1351)
    expect(budget.fits).toBe(true)
    const plannedBytes = ((budget.videoKbps + budget.audioKbps) * 1000 * 134) / 8
    expect(plannedBytes).toBeLessThanOrEqual(25_000_000 * 0.97)
    expect(plannedBytes / 25_000_000).toBeGreaterThan(0.969)
  })

  it('counts a megabyte as 1,000,000 bytes, never 1,048,576', () =>
  {
    const budget = sizeBudget(500_000_000, 1000, [])
    expect(budget?.totalKbps).toBeCloseTo(3880, 9)
    expect(budget?.videoKbps).toBe(3880)
  })

  it('subtracts every kept audio stream and ignores bitrates that are not positive numbers', () =>
  {
    const one = sizeBudget(50_000_000, 600, [128])
    const three = sizeBudget(50_000_000, 600, [128, 128, 64, Number.NaN, -96, 0])
    expect(one?.audioKbps).toBe(128)
    expect(three?.audioKbps).toBe(320)
    expect((one?.videoKbps ?? 0) - (three?.videoKbps ?? 0)).toBe(192)
  })

  it('says when the target is too small for the duration', () =>
  {
    const tiny = sizeBudget(1_000_000, 3600, [128])
    expect(tiny?.videoKbps).toBe(0)
    expect(tiny?.fits).toBe(false)
    expect(MIN_BUDGET_VIDEO_KBPS).toBe(100)
    const atFloor = sizeBudget(Math.ceil(((100 + 96) * 1000 * 60) / 8 / 0.97) + 1, 60, [96])
    expect(atFloor?.videoKbps).toBe(100)
    expect(atFloor?.fits).toBe(true)
    const underFloor = sizeBudget(Math.floor(((99 + 96) * 1000 * 60) / 8 / 0.97), 60, [96])
    expect(underFloor?.fits).toBe(false)
  })

  it('returns null without a positive duration or target', () =>
  {
    for (const [target, duration] of [[25e6, 0], [25e6, -5], [25e6, Number.NaN], [25e6, Number.POSITIVE_INFINITY], [0, 60], [Number.NaN, 60], [Number.POSITIVE_INFINITY, 60]])
    {
      expect(sizeBudget(target, duration, [128]), `${target} ${duration}`).toBeNull()
    }
  })
})

/** The five lists the one list replaces, as they stood. */
const CONFIG_VIDEO = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'vob', '3gp', 'mts', 'm2ts', 'divx', 'f4v', 'ogv', 'rm', 'rmvb', 'asf']
const CONFIG_AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aac', 'opus', 'ac3', 'eac3', 'dts', 'amr', 'ape', 'wv']
const APP_DROP = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aac', 'opus']
const BATCH_VIDEO = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts']
const PLAYER_MEDIA = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv']
const BROWSER_AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'webm']
const BROWSER_VIDEO = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts']

/** Containers the app writes, which a dropped or rescanned output folder must open again, plus MPEG audio sources. */
const WRITTEN_AND_ARCHIVE_AUDIO = ['mka', 'aiff', 'aif', 'oga', 'mp2']

describe('the one media extension list', () =>
{
  it('is the union of the five lists it replaces plus the containers the app writes, with no duplicates', () =>
  {
    const union = new Set([...CONFIG_VIDEO, ...CONFIG_AUDIO, ...APP_DROP, ...BATCH_VIDEO, ...PLAYER_MEDIA, ...BROWSER_AUDIO, ...BROWSER_VIDEO, ...WRITTEN_AND_ARCHIVE_AUDIO])
    expect(new Set(MEDIA_EXTENSIONS)).toEqual(union)
    expect(MEDIA_EXTENSIONS).toHaveLength(union.size)
    expect(MEDIA_EXTENSIONS).toEqual([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS])
  })

  it('keeps video and audio apart, lowercase and without dots', () =>
  {
    expect(VIDEO_EXTENSIONS.filter((ext) => AUDIO_EXTENSIONS.includes(ext))).toEqual([])
    for (const ext of MEDIA_EXTENSIONS)
    {
      expect(ext).toMatch(/^[a-z0-9]+$/)
    }
  })

  it('reads the extension of Windows and POSIX paths', () =>
  {
    expect(extensionOf('C:\\Media\\Clip.MKV')).toBe('mkv')
    expect(extensionOf('/home/you/song.final.flac')).toBe('flac')
    expect(extensionOf('D:\\no-extension')).toBe('')
    expect(extensionOf('/srv/.hidden')).toBe('')
    expect(extensionOf('/srv/folder.d/file')).toBe('')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('')).toBe('')
  })

  it('classifies extensions with or without a dot, in any case', () =>
  {
    expect(isVideoExtension('.MP4')).toBe(true)
    expect(isVideoExtension('webm')).toBe(true)
    expect(isVideoExtension('mp3')).toBe(false)
    expect(isAudioExtension('.Opus')).toBe(true)
    expect(isAudioExtension('mkv')).toBe(false)
  })

  it('accepts media paths and rejects everything else', () =>
  {
    expect(isMediaPath('C:\\Video\\Take 3.M2TS')).toBe(true)
    expect(isMediaPath('/music/a.wv')).toBe(true)
    expect(isMediaPath('/music/cover.jpg')).toBe(false)
    expect(isMediaPath('/music/notes')).toBe(false)
  })
})
