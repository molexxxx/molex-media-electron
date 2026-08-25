/**
 * @module main/ffmpeg/processor/stream-map
 * @description Container capabilities and explicit stream mapping.
 *
 * FFmpeg's automatic stream selection is documented in `doc/ffmpeg.texi`:
 *
 *   "In the absence of any map options for a particular output file,
 *    ffmpeg inspects the output format ... For each acceptable stream
 *    type, ffmpeg will pick ONE stream ... for audio, it is the stream
 *    with the most channels."
 *
 * That is why an operation that emits no `-map` silently discards every
 * audio track but one - commentary and descriptive tracks disappear, and
 * with "replace" enabled the original is already gone. The opposite
 * shortcut, a blanket `-map 0`, is no better: it drags attachments and
 * container-incompatible subtitles along and hard-fails the encode.
 *
 * Every capability below was measured by muxing real files with the
 * installed FFmpeg rather than inferred from the format name.
 */

/** Containers that carry audio only; a video stream must not be mapped. */
const AUDIO_ONLY_CONTAINERS = new Set([
  'mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'ac3'
])

/**
 * Containers that accept more than one audio stream.
 *
 * Measured: mp3, flac, wav, aac, ac3, aiff and wma all reject a second
 * audio stream ("Exactly one MP3 audio stream is required", "only one
 * audio stream and a picture", ...). m4a, ogg and opus accept many.
 */
const MULTI_AUDIO_CONTAINERS = new Set([
  'mp4', 'mkv', 'mov', 'webm', 'ts', 'flv', 'ogv', 'avi', 'wmv',
  'm4a', 'ogg', 'opus'
])

/**
 * Subtitle encoder per container, or absent when the container takes no
 * subtitles at all.
 *
 * Measured against a subrip source: mp4 and mov accept only `mov_text`;
 * mkv and ts accept `copy`; webm, avi, flv, wmv and ogv rejected every
 * subtitle encoder tried and must have subtitles dropped instead.
 */
const SUBTITLE_CODECS: Record<string, string> = {
  mp4: 'mov_text',
  m4v: 'mov_text',
  mov: 'mov_text',
  mkv: 'copy',
  ts: 'copy'
}

/**
 * Containers whose subtitle encoder is text-only, so bitmap subtitle
 * streams have to be left out rather than converted. FFmpeg cannot turn
 * a bitmap subtitle into a text one.
 */
const TEXT_ONLY_SUBTITLE_CONTAINERS = new Set(['mp4', 'm4v', 'mov'])

/** Subtitle codecs that carry rendered bitmaps rather than text. */
const BITMAP_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub',
  'dvb_subtitle', 'dvbsub', 'xsub'
])

/** What a container can hold. */
export interface ContainerCapabilities {
  /** Accepts a video stream. */
  video: boolean
  /** Accepts more than one audio stream. */
  multiAudio: boolean
  /** Encoder to use for subtitles, or null when subtitles must be dropped. */
  subtitleCodec: string | null
  /** Subtitle encoder handles text only, so bitmap streams must be skipped. */
  textSubtitlesOnly: boolean
}

/** Normalise a format or file extension to a bare lowercase container name. */
export function normalizeContainer(format: string): string {
  return (format || '').toLowerCase().replace(/^\./, '')
}

/**
 * Report what the named container can hold.
 *
 * Unknown containers are treated permissively (video + multi-audio, no
 * subtitles) so a format we have not measured still produces a working
 * command rather than a broken one.
 */
export function containerCapabilities(format: string): ContainerCapabilities {
  const c = normalizeContainer(format)
  const audioOnly = AUDIO_ONLY_CONTAINERS.has(c)
  return {
    video: !audioOnly,
    // Audio-only containers are restrictive and measured individually;
    // video containers (and anything unmeasured) take multiple tracks.
    multiAudio: audioOnly ? MULTI_AUDIO_CONTAINERS.has(c) : true,
    subtitleCodec: SUBTITLE_CODECS[c] ?? null,
    textSubtitlesOnly: TEXT_ONLY_SUBTITLE_CONTAINERS.has(c)
  }
}

/** True when the subtitle codec carries bitmaps rather than text. */
export function isBitmapSubtitle(codecName: string | undefined): boolean {
  return BITMAP_SUBTITLE_CODECS.has((codecName || '').toLowerCase())
}

/** Minimal view of the source needed to plan a mapping. */
export interface SourceStreams {
  videoCount: number
  audioCount: number
  subtitles: { codec_name: string }[]
}

/** A planned mapping plus the subtitle encoder it implies. */
export interface StreamPlan {
  args: string[]
  /** Encoder for `-c:s`, or null when no subtitle stream was mapped. */
  subtitleCodec: string | null
  /** Subtitle streams left out because the container cannot carry them. */
  droppedSubtitles: number
  /** Audio streams left out because the container takes only one. */
  droppedAudio: number
}

/**
 * Plan the `-map` arguments for an output container.
 *
 * Streams are always mapped explicitly. Mapping nothing hands the choice
 * to FFmpeg's automatic selection, which keeps a single audio track;
 * mapping everything with `-map 0` pulls in attachments and subtitles the
 * container cannot store.
 *
 * @param format          - Target container (format name or extension).
 * @param source          - Stream counts and subtitle codecs of the input.
 * @param includeSubtitles - Whether the caller wants subtitles preserved.
 */
export function planStreamMap(
  format: string,
  source: SourceStreams,
  includeSubtitles: boolean
): StreamPlan {
  const caps = containerCapabilities(format)
  const args: string[] = []

  if (caps.video && source.videoCount > 0) {
    args.push('-map', '0:v?')
  }

  let droppedAudio = 0
  if (source.audioCount > 0) {
    if (caps.multiAudio) {
      args.push('-map', '0:a?')
    } else {
      // Container takes a single audio stream; keep the first.
      args.push('-map', '0:a:0?')
      droppedAudio = source.audioCount - 1
    }
  }

  let subtitleCodec: string | null = null
  let droppedSubtitles = 0

  if (includeSubtitles && source.subtitles.length > 0) {
    if (caps.subtitleCodec === null) {
      droppedSubtitles = source.subtitles.length
    } else if (caps.textSubtitlesOnly) {
      // Map text subtitle streams individually so bitmap streams, which
      // cannot be converted to mov_text, do not fail the encode.
      let mapped = 0
      source.subtitles.forEach((s, i) => {
        if (isBitmapSubtitle(s.codec_name)) {
          droppedSubtitles++
        } else {
          args.push('-map', `0:s:${i}?`)
          mapped++
        }
      })
      if (mapped > 0) subtitleCodec = caps.subtitleCodec
    } else {
      args.push('-map', '0:s?')
      subtitleCodec = caps.subtitleCodec
    }
  }

  return { args, subtitleCodec, droppedSubtitles, droppedAudio }
}
