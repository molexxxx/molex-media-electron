/**
 * @module copy/presetGuides
 * @description What each built-in preset is for, written at three depths: the use in plain words for anyone, how it
 * gets there for someone who knows the basics, and a pointer to a better preset or a related setting where one
 * applies. The exact values come from the preset data and the standard's own detail, never from this copy.
 */
import type { Operation } from '../../../shared/jobs/recipes'
import type { FieldPatch } from '../stores/recipeFields'

/** Another preset that fits a nearby case better. */
export interface PresetPointer
{
  /** The case, as a short question or condition. */
  when: string
  presetId: string
}

/** A related setting worth changing with the preset, with the patch that changes it. */
export interface PresetTip
{
  text: string
  /** The button's label, the field it changes as the undo history names it, and the change. */
  action?: { label: string, field: string, patch: FieldPatch }
}

/** One preset's guide. */
export interface PresetGuide
{
  /** The use, in plain words. */
  bestFor: string
  /** What it changes and why that suits the use. */
  how: string
  instead?: PresetPointer
  tip?: PresetTip
}

/** A goal someone starts from, and the preset that meets it. */
export interface PresetGoal
{
  goal: string
  presetId: string
}

const LOUDNESS: Readonly<Record<string, PresetGuide>> =
{
  'streaming-r128s2':
  {
    bestFor: 'Videos and audio for the web, video sites, and streaming, or evening out a folder of mixed clips.',
    how: 'Brings every file to the same average loudness, the online level EBU R 128 s2 recommends, and holds peaks below the ceiling so they survive conversion to AAC or MP3. The mix and its dynamics stay as they are.'
  },
  'ebu-r128':
  {
    bestFor: 'Delivering to a European TV or radio broadcaster, or anyone who asks for EBU R 128.',
    how: 'The broadcast level: quieter on average than online media, which leaves wide headroom for loud moments. Short items such as trailers and ads are also held to a maximum short-term loudness.',
    instead: { when: 'Publishing online instead?', presetId: 'streaming-r128s2' }
  },
  'atsc-a85':
  {
    bestFor: 'Delivering to a US TV broadcaster or ad network.',
    how: 'The US broadcast level, measured the way ATSC A/85 measures short-form content, with a lower peak ceiling than EBU R 128.'
  },
  'film-r128s4':
  {
    bestFor: 'Delivering a finished film or series to a broadcaster or platform whose spec names EBU R 128 s4.',
    how: 'Sets the whole mix to the broadcast level without changing its dynamics, so quiet dialogue stays quiet. For 5.1 sources it also reports how loud the center channel is next to the mix, the loudness-to-dialogue ratio the spec limits.',
    instead: { when: 'Dialogue too quiet next to action and music?', presetId: 'night' }
  },
  'apple-podcasts':
  {
    bestFor: 'Podcast episodes.',
    how: 'The level Apple recommends for podcasts, so episodes sit level with other shows. A mono file is written as two identical channels, as Apple asks.'
  },
  'spotify':
  {
    bestFor: 'Music tracks and albums for streaming services and playlists.',
    how: 'The level Spotify plays music at, so playback neither turns the track down nor leaves it quiet. An album can be leveled as one, so quiet and loud songs keep their balance.'
  },
  'aes-streaming':
  {
    bestFor: 'Matching earlier work that followed the AES TD1004 streaming guideline from 2015.',
    how: 'The same online level as EBU R 128 s2, with the older guideline\'s tolerance and short-form rule. AES has since replaced it, so the values are kept for comparison only.',
    instead: { when: 'Starting something new?', presetId: 'streaming-r128s2' }
  },
  'night':
  {
    bestFor: 'Movies and shows where dialogue is too quiet and action or music is too loud.',
    how: 'A gentle 3:1 compressor turns down everything louder than the program\'s own average, then the whole file is raised to the target. Dialogue comes up and explosions come down, so you stop riding the volume. It changes the mix, so it is not a delivery standard.',
    instead: { when: 'Delivering the film to a broadcaster?', presetId: 'film-r128s4' },
    tip:
    {
      text: 'For a 5.1 film played on two speakers, also emphasize dialog in the downmix: the center channel, where dialogue sits, stays at full level and the surrounds drop.',
      action: { label: 'Emphasize dialog', field: 'Downmix', patch: { field: 'downmix', value: 'dialog' } }
    }
  },
  'custom':
  {
    bestFor: 'A loudness target someone gave you that no preset matches.',
    how: 'You choose the integrated loudness and the true-peak ceiling; everything else works as in the presets.'
  }
}

const GAIN: Readonly<Record<string, PresetGuide>> =
{
  'gentle-lift':
  {
    bestFor: 'A file that is just a little too quiet.',
    how: 'Raises the level by 1 dB, about the smallest change you can hear. The limiter keeps peaks below the ceiling.'
  },
  'quiet-recording':
  {
    bestFor: 'A recording made too quietly, such as a distant microphone.',
    how: 'Raises the level by 3.5 dB and first removes rumble below 60 Hz, which would otherwise come up with everything else.'
  },
  'voice-clarity':
  {
    bestFor: 'Speech that sounds muddy or boomy.',
    how: 'Cuts below 80 Hz, where a voice has little but room boom and handling thumps, then raises the level by 2.5 dB.'
  },
  'phone-audio':
  {
    bestFor: 'Phone calls, voice memos, and other small-microphone recordings.',
    how: 'Cuts below 100 Hz, where a phone microphone picks up mostly noise, then raises the level by 5 dB.'
  },
  'louder':
  {
    bestFor: 'A file that is clearly too quiet.',
    how: 'Raises the level by 6 dB. The limiter catches the peaks that would otherwise clip.',
    instead: { when: 'Need many files at one exact level?', presetId: 'streaming-r128s2' }
  },
  'tone-down':
  {
    bestFor: 'A file that is too loud next to the rest.',
    how: 'Lowers the level by 2.5 dB with no filtering.'
  },
  'custom':
  {
    bestFor: 'A gain or filter you want to set yourself.',
    how: 'You choose the gain, the high-pass filter, and the limiter\'s ceiling.'
  }
}

const CONVERT: Readonly<Record<string, PresetGuide>> =
{
  'mp4-h264': { bestFor: 'A video that plays almost anywhere: phones, TVs, browsers, and editors.', how: 'H.264 video with AAC audio in MP4, the most widely supported pairing.' },
  'mkv-hevc': { bestFor: 'A cleaner picture for your own library, on players that decode HEVC.', how: 'HEVC looks cleaner than H.264 at the same bitrate, and Matroska holds any number of audio and subtitle tracks.' },
  'webm-vp9': { bestFor: 'Video embedded on web pages.', how: 'VP9 and Opus in WebM, which browsers play natively and which carry no licensing fees.' },
  'mp3-320': { bestFor: 'The audio alone, for any player or car stereo.', how: 'MP3 at its highest standard bitrate; the picture is dropped.' },
  'mp4-720p-1500k': { bestFor: 'Small uploads and previews where size matters more than detail.', how: 'Scales down to 720p at 30 fps with a modest bitrate.' },
  'mp4-10000k': { bestFor: 'High-quality uploads to video sites.', how: 'A generous bitrate gives the site a clean source to re-encode from.' },
  'mp4-vertical-4000k': { bestFor: 'Vertical video for short-form apps.', how: 'Fits the picture into 1080 by 1920 at 30 fps, adding bars rather than cropping.' },
  'mp4-vertical-3500k': { bestFor: 'Vertical video where a smaller file matters.', how: 'The same 1080 by 1920 frame at a lower bitrate, with lighter audio.' },
  'mp4-720p-2500k': { bestFor: 'Clear 720p video at a moderate size.', how: 'Scales to 720p at 30 fps with enough bitrate for motion.' },
  '720p-web': { bestFor: '720p web video where the sound matters.', how: 'The same picture as the other 720p presets with richer AAC audio.' },
  'mp4-480p-500k': { bestFor: 'Very small files for slow connections or messaging.', how: 'Scales to 480p at 24 fps with a low bitrate; detail is soft.' },
  'mp4-hevc-1080p': { bestFor: 'Lighter 1080p files for devices that play HEVC.', how: 'HEVC in MP4 at about 4 Mb/s, a rate where H.264 would look softer, scaled to 1080p at most.' },
  'mov-h264': { bestFor: 'Apple apps and editors that prefer QuickTime files.', how: 'H.264 and AAC in a MOV container at a high bitrate.' },
  'mp4-4000k': { bestFor: 'Phones and tablets.', how: 'H.264 at a moderate bitrate: good quality without filling storage.' },
  'mp4-1080p-5000k': { bestFor: 'TVs and set-top players.', how: '1080p at most, at a bitrate any player handles smoothly.' },
  'mp4-av1': { bestFor: 'The smallest files at good quality, for players that decode AV1.', how: 'AV1 compresses better than HEVC but encodes slowly; plan on long runs.' },
  'mov-prores': { bestFor: 'Editing, color, and effects work.', how: 'ProRes decodes quickly and holds up through repeated re-encoding. Files are very large.' },
  'mkv-ffv1': { bestFor: 'Archiving with no quality loss at all.', how: 'FFV1 video and FLAC audio are both lossless: every frame and sample decodes exactly. Large, but smaller than uncompressed.' },
  '4k-archive': { bestFor: 'Keeping 4K masters at high quality.', how: 'HEVC at a high bitrate keeps the source\'s pixel format, with lossless FLAC audio.' },
  'ts-mpeg2': { bestFor: 'Broadcast chains and older players that need MPEG-2 transport streams.', how: 'MPEG-2 video with AC-3 audio in a TS container.' },
  'wav-pcm': { bestFor: 'Handing audio to editing or mastering software.', how: 'Uncompressed PCM: exact, simple, and large.' },
  'flac': { bestFor: 'A lossless music library.', how: 'Identical sound to the source in a smaller file than WAV, with tags.' },
  'alac': { bestFor: 'Lossless music in Apple\'s Music app and devices.', how: 'Apple Lossless in M4A: identical sound to the source.' },
  'aac-m4a': { bestFor: 'Music for phones and Apple devices.', how: 'AAC at 256 kb/s sounds the same as the source to most listeners at a fraction of the size.' },
  'opus-128': { bestFor: 'Efficient audio for the web, games, and voice apps.', how: 'Opus at 128 kb/s sounds as good as MP3 at much higher bitrates.' },
  'podcast-mp3': { bestFor: 'Spoken-word podcasts.', how: 'Mono MP3: a single voice loses nothing in mono, and the file is half the size.' },
  'audiobook': { bestFor: 'Audiobooks and lectures.', how: 'Mono AAC in M4A, which most players resume where you left off.' },
  'ac3-surr': { bestFor: '5.1 surround for receivers, TVs, and disc-style players.', how: 'Dolby Digital (AC-3) at 448 kb/s for six channels.' }
}

const COMPRESS: Readonly<Record<string, PresetGuide>> =
{
  'archival': { bestFor: 'A high-quality copy of film or camera footage at a fraction of the size.', how: 'x265 at CRF 22 on the slow preset, in 10-bit to prevent banding, tuned to keep grain.' },
  'master': { bestFor: 'A high-quality master of clean digital footage.', how: 'x265 at CRF 22 on the slow preset.' },
  'web-1080p': { bestFor: 'Sharing and uploading: the everyday balance of quality and size.', how: 'x264 at CRF 23, its default quality, scaled to 1080p at most.' },
  'web-720p': { bestFor: 'Quick sharing where small beats sharp.', how: 'x264 at CRF 28 on the fast preset, scaled to 720p at most.' },
  'target-25mb': { bestFor: 'Fitting under a 25 MB attachment or upload limit.', how: 'Two passes: the first measures the video, the second spends exactly the bitrate that lands near 25 MB.' },
  'target-500mb': { bestFor: 'Fitting a long video into 500 MB.', how: 'Two passes aimed at the size, scaled to 1080p at most.' },
  'x264-master': { bestFor: 'A master for a video site that re-encodes everything.', how: 'x264 at CRF 18, close to visually lossless, tuned for film.' },
  'mobile': { bestFor: 'Older phones and low-power players that stutter on heavier files.', how: 'x264 tuned for fast decoding, which turns off features that cost the player time.' },
  'animation': { bestFor: 'Cartoons and anime.', how: 'x265 tuned for flat color and sharp lines, which compress very well.' },
  'film-grain': { bestFor: 'Grainy film transfers where smoothing the grain would look wrong.', how: 'x265 in 10-bit on the slow preset, tuned to keep grain instead of blurring it.' },
  'av1-streaming': { bestFor: 'The smallest files for modern players.', how: 'AV1 at CRF 28 with Opus audio; encoding is slow.' }
}

const EXTRACT: Readonly<Record<string, PresetGuide>> =
{
  'audio-mp3-320': { bestFor: 'The soundtrack or music of a video, to play anywhere.', how: 'The default audio track as MP3 at 320 kb/s.' },
  'audio-aac-256': { bestFor: 'The audio of a video for phones and Apple devices.', how: 'The default audio track as AAC in M4A.' },
  'audio-opus-128': { bestFor: 'Small, efficient audio for the web or voice.', how: 'The default audio track as Opus at 128 kb/s.' },
  'audio-flac': { bestFor: 'The audio exactly as decoded, for archiving or editing.', how: 'Lossless FLAC: nothing is lost beyond what the source already lost.' },
  'audio-wav': { bestFor: 'The audio for editing software.', how: 'Uncompressed PCM in WAV.' },
  'audio-podcast': { bestFor: 'Turning a recorded talk or video into a podcast episode.', how: 'Mono MP3 at 44.1 kHz, the format podcast hosts expect.' },
  'video-silent-copy': { bestFor: 'The picture without its sound, in seconds.', how: 'Copies the video stream as it is: no re-encoding and no quality loss.' },
  'video-silent-h264': { bestFor: 'A silent clip that plays everywhere.', how: 'Re-encodes the picture to H.264 at CRF 20 without audio.' },
  'gif-720': { bestFor: 'A sharp looping clip for documentation.', how: '15 fps at 720 px wide with error-diffusion dither. GIFs grow fast, so keep clips short.' },
  'gif-480': { bestFor: 'An everyday looping clip for chat.', how: '12 fps at 480 px wide.' },
  'gif-360': { bestFor: 'The smallest looping clip.', how: '10 fps at 360 px wide with ordered dither, which compresses better.' },
  'frames-thumb': { bestFor: 'A still for a cover or listing.', how: 'Picks one representative frame from the video.' },
  'frames-every-sec': { bestFor: 'Reviewing footage frame by frame.', how: 'One PNG for every second of video.' },
  'frames-every-5sec': { bestFor: 'A light overview of long footage.', how: 'One JPEG for every five seconds.' },
  'frames-50-even': { bestFor: 'A fixed set of stills from a video of any length.', how: '50 JPEGs spread evenly from start to end.' },
  'subs-srt': { bestFor: 'Subtitles most players and editors read.', how: 'The default subtitle track as SubRip text.' },
  'subs-vtt': { bestFor: 'Subtitles for web video players.', how: 'The default subtitle track as WebVTT.' },
  'subs-ass': { bestFor: 'Styled subtitles with fonts, positions, and effects.', how: 'The default subtitle track as ASS, which keeps the styling.' }
}

const GUIDES: Readonly<Record<Operation, Readonly<Record<string, PresetGuide>>>> =
{
  normalize: LOUDNESS,
  boost: GAIN,
  convert: CONVERT,
  compress: COMPRESS,
  extract: EXTRACT
}

/** The guide of a built-in preset of `op`, or null for a user preset or an unknown id. */
export function presetGuide(op: Operation, presetId: string): PresetGuide | null
{
  return GUIDES[op][presetId] ?? null
}

/** Common goals per operation, each answered by one built-in preset, in the order people tend to need them. */
export const PRESET_GOALS: Readonly<Record<Operation, readonly PresetGoal[]>> =
{
  normalize:
  [
    { goal: 'A movie or show: quiet dialogue, loud action or music', presetId: 'night' },
    { goal: 'Videos for the web or a mixed folder of clips', presetId: 'streaming-r128s2' },
    { goal: 'Music tracks or albums', presetId: 'spotify' },
    { goal: 'Podcast episodes', presetId: 'apple-podcasts' },
    { goal: 'Delivering to a European broadcaster', presetId: 'ebu-r128' },
    { goal: 'Delivering to a US broadcaster or ad network', presetId: 'atsc-a85' },
    { goal: 'Delivering a film or series to an R 128 s4 spec', presetId: 'film-r128s4' }
  ],
  boost:
  [
    { goal: 'Just a little too quiet', presetId: 'gentle-lift' },
    { goal: 'Recorded too quietly, with rumble', presetId: 'quiet-recording' },
    { goal: 'Muddy or boomy speech', presetId: 'voice-clarity' },
    { goal: 'Phone calls and voice memos', presetId: 'phone-audio' },
    { goal: 'Clearly too quiet', presetId: 'louder' },
    { goal: 'Too loud', presetId: 'tone-down' }
  ],
  convert:
  [
    { goal: 'Plays on anything', presetId: 'mp4-h264' },
    { goal: 'Smaller files for a library', presetId: 'mkv-hevc' },
    { goal: 'Vertical video for phones', presetId: 'mp4-vertical-4000k' },
    { goal: 'Editing in a video editor', presetId: 'mov-prores' },
    { goal: 'Archive with no quality loss', presetId: 'mkv-ffv1' },
    { goal: 'Audio only, for any player', presetId: 'mp3-320' },
    { goal: 'Lossless music', presetId: 'flac' }
  ],
  compress:
  [
    { goal: 'Share or upload', presetId: 'web-1080p' },
    { goal: 'Fit under 25 MB', presetId: 'target-25mb' },
    { goal: 'A master for a video site', presetId: 'x264-master' },
    { goal: 'Keep a high-quality archive', presetId: 'archival' },
    { goal: 'Cartoons and anime', presetId: 'animation' },
    { goal: 'Older phones', presetId: 'mobile' }
  ],
  extract:
  [
    { goal: 'The audio as an MP3', presetId: 'audio-mp3-320' },
    { goal: 'The video without sound', presetId: 'video-silent-copy' },
    { goal: 'A looping GIF', presetId: 'gif-480' },
    { goal: 'A thumbnail image', presetId: 'frames-thumb' },
    { goal: 'Subtitles as a file', presetId: 'subs-srt' }
  ]
}
