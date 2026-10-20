/**
 * The explicit stream map of one output: every kept stream mapped by its index in source order and
 * filtered audio by its graph label, never a bare -map 0 and never FFmpeg's automatic selection. FFmpeg
 * copies no stream tags or dispositions to filtergraph outputs, so filtered audio gets its language,
 * title, and disposition back as arguments. Pure.
 */
import type { AudioFacts, AudioOutput, DropReason, MediaFacts, StreamKind, StreamPlan } from '../../../shared/audio/types'
import { codecOfEncoder, keepsChapters } from './containers'
import type { ContainerSpec } from './containers'
import { encoderArgs } from './encoders'

export type { AudioOutput, DropReason, StreamKind, StreamPlan }

/** What an output keeps beside its audio: subtitles, the file's global tags, and cover art. */
export interface StreamPolicy { keepSubtitles: boolean; keepGlobalTags: boolean; keepCoverArt: boolean }

/** The audio dispositions both builds write; picture and still-image flags never apply to an audio stream. */
export const AUDIO_DISPOSITIONS: readonly string[] = [
  'default', 'dub', 'original', 'comment', 'lyrics', 'karaoke', 'forced', 'hearing_impaired', 'visual_impaired', 'clean_effects',
  'captions', 'descriptions', 'dependent', 'metadata'
]

type Source =
  | { kind: 'video' | 'cover' | 'attachment' | 'data'; index: number }
  | { kind: 'audio'; index: number; audio: AudioFacts }
  | { kind: 'subtitle'; index: number; codecName: string; bitmap: boolean }

function sources(f: MediaFacts): Source[]
{
  const all: Source[] = [
    ...f.video.map((stream): Source => ({ kind: stream.cover ? 'cover' : 'video', index: stream.streamIndex })),
    ...f.audio.map((stream): Source => ({ kind: 'audio', index: stream.streamIndex, audio: stream })),
    ...f.subtitles.map((stream): Source => ({ kind: 'subtitle', index: stream.streamIndex, codecName: stream.codecName, bitmap: stream.bitmap })),
    ...f.attachments.map((stream): Source => ({ kind: 'attachment', index: stream.streamIndex })),
    ...f.data.map((stream): Source => ({ kind: 'data', index: stream.streamIndex }))
  ]
  return all.sort((x, y) => x.index - y.index)
}

function oneOrAll(streams: readonly AudioFacts[], c: ContainerSpec): AudioFacts[]
{
  if (c.multiAudio || streams.length <= 1)
  {
    return [...streams]
  }
  return [streams.find((stream) => stream.disposition.default === 1) ?? streams[0]]
}

/**
 * The source audio streams an output keeps: every stream for a container that takes several, else the
 * one with the default disposition, else the first. The job builds its graph for these streams only.
 */
export function audioToKeep(f: MediaFacts, c: ContainerSpec): AudioFacts[]
{
  return oneOrAll(f.audio, c)
}

/** The -disposition value of an audio stream: its flags joined with '+', or '0' when it has none. */
export function dispositionValue(disposition: Readonly<Record<string, number>>): string
{
  const flags = AUDIO_DISPOSITIONS.filter((flag) => Object.hasOwn(disposition, flag) && disposition[flag] === 1)
  return flags.length > 0 ? flags.join('+') : '0'
}

function carriesSubtitles(c: ContainerSpec): boolean
{
  return c.subtitle('subrip', false) !== null || c.subtitle('dvb_subtitle', true) !== null
}

/**
 * The stream plan of one output. Video and cover art are copied, subtitles copied or converted per the
 * container, attachments copied where the container holds them, and data streams never mapped (an MP4
 * chapter track is rebuilt by the muxer from the chapters). Each filtered audio output must carry its
 * encoder choice; a copied one is mapped by index with -c:a:N copy. A single-audio container keeps one
 * of the given outputs, the default-disposition one, else the first. Chapters are mapped with
 * -map_chapters 0 where the container keeps them and -1 where it drops them. With global tags off, only
 * -map_metadata:g -1 is written: never -map_metadata -1, never a stream-level -map_metadata.
 */
export function planStreams(f: MediaFacts, c: ContainerSpec, audio: readonly AudioOutput[], p: StreamPolicy): StreamPlan
{
  const plan: StreamPlan = { mapArgs: [], codecArgs: [], metadataArgs: [], kept: [], dropped: [], chapters: 'none' }
  const outputs = new Map(audio.map((output) => [output.audioIndex, output]))
  const keep = new Set(oneOrAll(f.audio.filter((stream) => outputs.has(stream.audioIndex)), c).map((stream) => stream.audioIndex))
  let copyVideo = false
  let copyAttachments = false
  const audioArgs: string[] = []
  const subtitleArgs: string[] = []
  const streamTags: string[] = []
  const audioCodecs: string[] = []
  let subtitles = 0
  const map = (kind: StreamKind, source: number, target: string, action: 'copy' | 'encode' | 'convert'): void =>
  {
    plan.kept.push({ kind, source, output: plan.kept.length, action })
    plan.mapArgs.push('-map', target)
  }
  const drop = (kind: StreamKind, source: number, reason: DropReason): void =>
  {
    plan.dropped.push({ kind, source, reason })
  }
  for (const s of sources(f))
  {
    switch (s.kind)
    {
      case 'video':
        if (!c.video)
        {
          drop('video', s.index, 'container-no-video')
          break
        }
        map('video', s.index, `0:${s.index}`, 'copy')
        copyVideo = true
        break
      case 'cover':
        if (!p.keepCoverArt || !c.coverArt)
        {
          drop('cover', s.index, p.keepCoverArt ? 'cover-unsupported' : 'policy')
          break
        }
        map('cover', s.index, `0:${s.index}`, 'copy')
        copyVideo = true
        break
      case 'audio':
      {
        const output = outputs.get(s.audio.audioIndex)
        if (output === undefined || !keep.has(s.audio.audioIndex))
        {
          drop('audio', s.index, output === undefined && c.multiAudio ? 'policy' : 'container-one-audio')
          break
        }
        const k = output.outIndex
        map('audio', s.index, output.label ?? `0:${s.index}`, output.choice === null ? 'copy' : 'encode')
        audioArgs.push(...(output.choice === null ? [`-c:a:${k}`, 'copy'] : encoderArgs(output.choice, k)))
        audioCodecs.push(output.choice === null ? s.audio.codecName : codecOfEncoder(output.choice.encoder))
        if (output.label !== null)
        {
          if (s.audio.language !== null)
          {
            streamTags.push(`-metadata:s:a:${k}`, `language=${s.audio.language}`)
          }
          if (s.audio.title !== null)
          {
            streamTags.push(`-metadata:s:a:${k}`, `title=${s.audio.title}`)
          }
          streamTags.push(`-disposition:a:${k}`, dispositionValue(s.audio.disposition))
        }
        break
      }
      case 'subtitle':
      {
        const action = p.keepSubtitles ? c.subtitle(s.codecName, s.bitmap) : null
        if (action === null)
        {
          drop('subtitle', s.index, !p.keepSubtitles ? 'policy' : s.bitmap && carriesSubtitles(c) ? 'bitmap-subtitle' : 'subtitle-unsupported')
          break
        }
        map('subtitle', s.index, `0:${s.index}`, action === 'copy' ? 'copy' : 'convert')
        subtitleArgs.push(`-c:s:${subtitles}`, action)
        subtitles += 1
        break
      }
      case 'attachment':
        if (!c.attachments)
        {
          drop('attachment', s.index, 'attachments-unsupported')
          break
        }
        map('attachment', s.index, `0:${s.index}`, 'copy')
        copyAttachments = true
        break
      default:
        drop('data', s.index, 'data-stream')
    }
  }
  if (f.chapters > 0)
  {
    plan.chapters = keepsChapters(c, audioCodecs) ? 'kept' : 'dropped'
    plan.mapArgs.push('-map_chapters', plan.chapters === 'kept' ? '0' : '-1')
  }
  plan.codecArgs.push(...(copyVideo ? ['-c:v', 'copy'] : []), ...audioArgs, ...subtitleArgs, ...(copyAttachments ? ['-c:t', 'copy'] : []))
  if (!p.keepGlobalTags)
  {
    plan.metadataArgs.push('-map_metadata:g', '-1')
  }
  plan.metadataArgs.push(...streamTags)
  return plan
}
