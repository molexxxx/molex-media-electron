/**
 * Sample media for the development preview of the Batch page: the files the preview queue starts with, the files a
 * folder holds, and what a probe reports for any path, chosen from its extension and name. Development only.
 */
import { extensionOf, isAudioExtension, isVideoExtension } from '../../../shared/jobs/extensions'
import type { MediaSummary, SourceRef } from '../../../shared/jobs/types'

/** How a sample's job ends a run: verified, failed with a real error code, or held for a decision. */
export type SampleOutcome = 'verified' | 'fails' | 'held'

/** What the preview knows of a path before and after its probe. */
export interface SampleFacts
{
  size: number
  media: MediaSummary
  outcome: SampleOutcome
}

/** The files the preview queue starts with: one of each kind the Batch page must show. */
export const PREVIEW_SAMPLES: readonly string[] =
[
  'D:\\Media\\Films\\Harbor Lights (2019).mkv',
  'D:\\Media\\Podcasts\\Field Notes 142.mp3',
  'D:\\Media\\Music\\Night Ferry\\01 Departure.flac',
  'D:\\Media\\Music\\Night Ferry\\02 Open Water.flac',
  'D:\\Media\\Music\\Night Ferry\\03 Lantern Bay.flac',
  'D:\\Media\\Music\\Night Ferry\\04 Return.flac',
  'D:\\Media\\Voice\\Voice memo 2026-03-14.m4a',
  'D:\\Media\\Footage\\Drone 4K 0031.mov',
  'D:\\Media\\Web\\Product loop.webm',
  'D:\\Media\\Footage\\Screen capture (silent).mp4',
  'D:\\Media\\Podcasts\\Field Notes 141 (damaged).mp3',
  'D:\\Media\\Voice\\Quiet room interview.m4a'
]

/** The modification time every sample reports. */
export const SAMPLE_MTIME_MS = Date.UTC(2026, 2, 14, 9, 30)

type Audio = MediaSummary['audio'][number]

interface Profile
{
  container: string
  video: MediaSummary['video']
  audio: Audio[]
  subtitles: number
  chapters: number
  minSec: number
  maxSec: number
  /** The overall bitrate the file size follows. */
  kbps: number
}

function audio(codec: string, channels: number, sampleRate: number, bitrateKbps: number | null, extra: Partial<Audio> = {}): Audio
{
  const layout = channels === 1 ? 'mono' : channels === 2 ? 'stereo' : channels === 6 ? '5.1(side)' : null
  return { codec, channels, layout, sampleRate, bitsPerSample: null, bitrateKbps, language: null, isDefault: true, ...extra }
}

function video(codec: string, width: number, height: number, fps: number): NonNullable<MediaSummary['video']>
{
  return { codec, width, height, rotation: 0, fps }
}

const FILM: Profile =
{
  container: 'matroska',
  video: video('h264', 1920, 1080, 23.976),
  audio:
  [
    audio('eac3', 6, 48000, 640, { language: 'eng' }),
    audio('aac', 2, 48000, 192, { language: 'eng', isDefault: false })
  ],
  subtitles: 3,
  chapters: 12,
  minSec: 5400,
  maxSec: 7800,
  kbps: 9000
}

const PODCAST: Profile =
{
  container: 'mp3',
  video: null,
  audio: [audio('mp3', 2, 44100, 128)],
  subtitles: 0,
  chapters: 0,
  minSec: 2400,
  maxSec: 4200,
  kbps: 128
}

const ALBUM_TRACK: Profile =
{
  container: 'flac',
  video: null,
  audio: [audio('flac', 2, 44100, null, { bitsPerSample: 16 })],
  subtitles: 0,
  chapters: 0,
  minSec: 180,
  maxSec: 420,
  kbps: 900
}

const VOICE_MEMO: Profile =
{
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: null,
  audio: [audio('aac', 1, 48000, 64)],
  subtitles: 0,
  chapters: 0,
  minSec: 60,
  maxSec: 900,
  kbps: 64
}

const DRONE_4K: Profile =
{
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: video('hevc', 3840, 2160, 29.97),
  audio: [audio('aac', 2, 48000, 256)],
  subtitles: 0,
  chapters: 0,
  minSec: 60,
  maxSec: 300,
  kbps: 48000
}

const WEB_LOOP: Profile =
{
  container: 'matroska,webm',
  video: video('vp9', 1920, 1080, 30),
  audio: [audio('opus', 2, 48000, 128)],
  subtitles: 0,
  chapters: 0,
  minSec: 15,
  maxSec: 90,
  kbps: 3500
}

const CLIP: Profile =
{
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  video: video('h264', 1920, 1080, 30),
  audio: [audio('aac', 2, 48000, 192)],
  subtitles: 0,
  chapters: 0,
  minSec: 120,
  maxSec: 1200,
  kbps: 5000
}

const SONG: Profile =
{
  container: 'wav',
  video: null,
  audio: [audio('pcm_s24le', 2, 48000, 2304, { bitsPerSample: 24 })],
  subtitles: 0,
  chapters: 0,
  minSec: 120,
  maxSec: 360,
  kbps: 2304
}

const AUDIO_CODECS: Readonly<Record<string, { codec: string; container: string; kbps: number }>> =
{
  wav: { codec: 'pcm_s24le', container: 'wav', kbps: 2304 },
  aiff: { codec: 'pcm_s16be', container: 'aiff', kbps: 1411 },
  ogg: { codec: 'vorbis', container: 'ogg', kbps: 192 },
  opus: { codec: 'opus', container: 'ogg', kbps: 128 },
  wma: { codec: 'wmav2', container: 'asf', kbps: 192 },
  aac: { codec: 'aac', container: 'aac', kbps: 192 }
}

/** The extension of a path in lowercase, without its dot. */
export function sampleExtension(path: string): string
{
  return extensionOf(path).replace(/^\./, '').toLowerCase()
}

/** The last segment of a path, separators of either kind. */
export function baseName(path: string): string
{
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** The folder of a path, without its trailing separator. */
export function folderOf(path: string): string
{
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : ''
}

function hash(text: string): number
{
  let value = 2166136261
  for (let index = 0; index < text.length; index++)
  {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0
  }
  return value
}

function profileFor(ext: string, name: string): Profile
{
  const lower = name.toLowerCase()
  if (isVideoExtension(ext))
  {
    if (lower.includes('silent'))
    {
      return { ...CLIP, audio: [] }
    }
    switch (ext)
    {
      case 'mkv':
        return FILM
      case 'mov':
        return DRONE_4K
      case 'webm':
        return WEB_LOOP
      default:
        return CLIP
    }
  }
  switch (ext)
  {
    case 'mp3':
      return PODCAST
    case 'flac':
      return ALBUM_TRACK
    case 'm4a':
      return VOICE_MEMO
    default:
    {
      const known = AUDIO_CODECS[ext]
      return known ? { ...SONG, container: known.container, audio: [audio(known.codec, 2, 48000, known.kbps)], kbps: known.kbps } : SONG
    }
  }
}

/** Whether the preview treats a path as a media file it can probe. */
export function isSamplePath(path: string): boolean
{
  const ext = sampleExtension(path)
  return isVideoExtension(ext) || isAudioExtension(ext)
}

/** Whether the preview treats a path as a folder: its last segment has no extension. */
export function isFolderPath(path: string): boolean
{
  return /[\\/]$/.test(path) || sampleExtension(baseName(path)) === ''
}

/**
 * What the preview's probe reports for a media path, chosen from its extension and name: MKV is a 5.1 film with two
 * audio tracks and subtitles, MP3 a stereo podcast, FLAC an album track, M4A a mono voice memo, MOV 4K HEVC, WebM
 * VP9, and a video named "silent" has no audio stream. A name with "damaged" fails its verify with decode errors, and a
 * Normalize job on one with "quiet" is held for a decision. The duration follows the name, so a path always reports the same facts.
 */
export function sampleFacts(path: string): SampleFacts
{
  const name = baseName(path)
  const profile = profileFor(sampleExtension(path), name)
  const seed = hash(name)
  const durationSec = profile.minSec + (seed % (profile.maxSec - profile.minSec))
  const lower = name.toLowerCase()
  const outcome: SampleOutcome = lower.includes('damaged') ? 'fails' : lower.includes('quiet') ? 'held' : 'verified'
  return {
    size: Math.round(durationSec * profile.kbps * 125) + (seed % 4096),
    outcome,
    media:
    {
      container: profile.container,
      durationSec,
      video: profile.video === null ? null : { ...profile.video },
      audio: profile.audio.map((stream) => ({ ...stream })),
      subtitles: profile.subtitles,
      attachments: 0,
      chapters: profile.chapters,
      cover: false
    }
  }
}

/** The source record of a path, as the engine's add reports it. */
export function sampleSource(path: string, origin: SourceRef['origin'], subdir = ''): SourceRef
{
  return {
    path,
    name: baseName(path),
    ext: sampleExtension(path),
    dir: folderOf(path),
    size: sampleFacts(path).size,
    mtimeMs: SAMPLE_MTIME_MS,
    origin,
    subdir
  }
}

function within(folder: string, path: string, recursive: boolean): boolean
{
  const root = folder.replace(/[\\/]+$/, '').toLowerCase()
  const dir = folderOf(path).toLowerCase()
  return recursive ? dir === root || dir.startsWith(`${root}\\`) || dir.startsWith(`${root}/`) : dir === root
}

/**
 * The media files a folder holds in the preview: the samples inside it (in subfolders too when recursive), else an
 * album of four FLAC tracks named after the folder.
 */
export function folderSamples(folder: string, recursive: boolean): string[]
{
  const found = PREVIEW_SAMPLES.filter((path) => within(folder, path, recursive))
  if (found.length > 0)
  {
    return found
  }
  const root = folder.replace(/[\\/]+$/, '')
  const separator = root.includes('/') && !root.includes('\\') ? '/' : '\\'
  return ['01', '02', '03', '04'].map((track) => `${root}${separator}${track} ${baseName(root)}.flac`)
}

/** The subfolder of a found file below the scanned folder, '' for a file directly inside it. */
export function subdirOf(folder: string, path: string): string
{
  const root = folder.replace(/[\\/]+$/, '')
  const dir = folderOf(path)
  return dir.length > root.length ? dir.slice(root.length + 1) : ''
}
