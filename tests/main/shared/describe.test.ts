/**
 * Labels derived from recipe values: the operation's name (Gain for boost), the {op} words, one-line descriptions that
 * change whenever a value changes, the Recipe cell with its edited marker, and the {preset} slug. A label that says
 * something the recipe does not run is the defect these guard against.
 */
import { describe, it, expect } from 'vitest'
import {
  audioOutLabel,
  containerLabel,
  describeRecipe,
  fitLabel,
  isEdited,
  megabytes,
  operationLabel,
  operationWord,
  presetLabel,
  presetSlug,
  rangeLabel,
  recipeLabel,
  recipeOperationName,
  sameRecipeValues,
  slugify,
  sourceContainerLabel,
  videoEncoderLabel,
  type PresetLookup
} from '../../../src/shared/jobs/describe'
import { OPERATIONS, VIDEO_ENCODERS, type CompressRecipe, type ConvertRecipe, type ExtractRecipe, type Recipe } from '../../../src/shared/jobs/recipes'
import { LOUDNESS_PRESETS, applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import { renderMessage } from '../../../src/shared/audio/messages'
import type { NormalizeRecipe } from '../../../src/shared/audio/types'

const BASE = { presetId: null, userPreset: null }

const COMPRESS: CompressRecipe =
{
  kind: 'compress', ...BASE, target: { mode: 'crf', crf: 23 }, encoder: 'libx264', speed: 'medium', pixelFormat: 'yuv420p', tune: null,
  fit: { maxWidth: null, maxHeight: 1080, mode: 'fit' }, audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 192 }, container: 'source'
}

const CONVERT: ConvertRecipe =
{
  kind: 'convert', ...BASE, container: 'mp4',
  video: { encoder: 'libx264', bitrateKbps: 5000, fit: null, fps: null, pixelFormat: 'yuv420p' },
  audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }, channels: 'keep', subtitles: 'keep'
}

const AUDIO_ONLY: ConvertRecipe = { ...CONVERT, container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }

const EXTRACT_AUDIO: ExtractRecipe =
{
  kind: 'extract', ...BASE, mode: 'audio', stream: { by: 'default' }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 },
  container: 'mp3', sampleRate: null, channels: 'keep', range: null
}

describe('operation names', () =>
{
  it('reads boost as Gain', () =>
  {
    expect(operationLabel('boost')).toBe('Gain')
    expect(OPERATIONS.map(operationLabel)).toEqual(['Normalize', 'Gain', 'Convert', 'Compress', 'Extract'])
  })

  it('renders {op} as normalize, gain, convert, compress, extract', () =>
  {
    expect(OPERATIONS.map(operationWord)).toEqual(['normalize', 'gain', 'convert', 'compress', 'extract'])
  })

  it('names what an extract recipe does by its mode', () =>
  {
    const modes: Array<[ExtractRecipe, string]> = [
      [EXTRACT_AUDIO, 'Extract audio'],
      [{ kind: 'extract', ...BASE, mode: 'video', container: 'mp4', reencode: null, range: null }, 'Extract video'],
      [{ kind: 'extract', ...BASE, mode: 'gif', fps: 15, width: null, dither: 'sierra2_4a', plays: 'infinite', range: null }, 'GIF'],
      [{ kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'thumbnail' }, format: 'png', jpgQuality: null, range: null }, 'Frames'],
      [{ kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'default' }, format: 'srt' }, 'Extract subtitles']
    ]
    for (const [recipe, name] of modes)
    {
      expect(recipeOperationName(recipe)).toBe(name)
    }
    expect(recipeOperationName(COMPRESS)).toBe('Compress')
    expect(recipeOperationName(applyGainPreset('louder', { kind: 'same-as-source' }))).toBe('Gain')
  })

  it('names every video encoder and container', () =>
  {
    expect(VIDEO_ENCODERS.map(videoEncoderLabel)).toEqual(['x264', 'x265', 'VP9', 'AOM AV1', 'SVT-AV1', 'ProRes', 'FFV1', 'UT Video', 'MPEG-2', 'MPEG-4', 'Theora', 'WMV2'])
    expect(['mp4', 'mkv', 'webm', 'ogg', 'oga', 'opus', 'ac3', 'eac3', 'm4a', 'source'].map(containerLabel))
      .toEqual(['MP4', 'MKV', 'WebM', 'Ogg', 'Ogg', 'Opus', 'AC-3', 'E-AC-3', 'M4A', 'the source container'])
  })
})

describe('sourceContainerLabel', () =>
{
  it('picks the container from the extension when the format name lists it', () =>
  {
    const mov = 'mov,mp4,m4a,3gp,3g2,mj2'
    expect(sourceContainerLabel(mov, 'D:\Media\Drone 4K 0031.mov')).toBe('MOV')
    expect(sourceContainerLabel(mov, '/media/clip.MP4')).toBe('MP4')
    expect(sourceContainerLabel(mov, 'C:/memo/Voice memo 2026-03-14.m4a')).toBe('M4A')
    expect(sourceContainerLabel(mov, 'phone.3gp')).toBe('3GP')
    expect(sourceContainerLabel(mov, 'book.m4b')).toBe('M4B')
    expect(sourceContainerLabel('matroska,webm', 'Product loop.webm')).toBe('WebM')
    expect(sourceContainerLabel('matroska,webm', 'Harbor Lights (2019).mkv')).toBe('MKV')
    expect(sourceContainerLabel('mp3', 'Radio archive 1987.mp2')).toBe('MP2')
    expect(sourceContainerLabel('mp3', 'episode.mp3')).toBe('MP3')
  })

  it('names the first format when the extension is missing or not listed', () =>
  {
    expect(sourceContainerLabel('mov,mp4,m4a,3gp,3g2,mj2', 'export.bin')).toBe('MOV')
    expect(sourceContainerLabel('matroska,webm', 'no-extension')).toBe('MKV')
    expect(sourceContainerLabel('matroska,webm')).toBe('MKV')
    expect(sourceContainerLabel('matroska', 'D:\film.v2\cut')).toBe('MKV')
    expect(sourceContainerLabel('mpegts', 'capture.dat')).toBe('TS')
  })

  it('keeps single format names that are already container names', () =>
  {
    expect(sourceContainerLabel('mp3', 'Field Notes 142.mp3')).toBe('MP3')
    expect(sourceContainerLabel('flac', '01 Departure.flac')).toBe('FLAC')
    expect(sourceContainerLabel('wav', 'take.wave')).toBe('WAVE')
    expect(sourceContainerLabel('ogg', 'talk.opus')).toBe('Opus')
    expect(sourceContainerLabel('asf', 'old.wmv')).toBe('WMV')
    expect(sourceContainerLabel(' WAV ', '.hidden')).toBe('WAV')
  })

  it('reads nothing from an empty format name', () =>
  {
    expect(sourceContainerLabel('', 'clip.mp4')).toBe('')
    expect(sourceContainerLabel(' , ', 'clip.mp4')).toBe('')
  })
})

describe('describeRecipe', () =>
{
  it('describes a compress recipe from its values', () =>
  {
    expect(describeRecipe(COMPRESS)).toBe('x264 CRF 23, max 1080p, AAC 192k')
  })

  it('changes the description whenever a value changes', () =>
  {
    const changes: Array<[Partial<CompressRecipe>, string]> = [
      [{ target: { mode: 'crf', crf: 24 } }, 'x264 CRF 24, max 1080p, AAC 192k'],
      [{ encoder: 'libx265', speed: 'slow', fit: null, audio: { kind: 'copy' } }, 'x265 CRF 23, slow'],
      [{ target: { mode: 'size', targetBytes: 25_000_000, twoPass: true }, fit: null }, 'x264 target 25 MB, 2-pass, AAC 192k'],
      [{ target: { mode: 'size', targetBytes: 1_500_000, twoPass: false }, fit: null, audio: { kind: 'copy' } }, 'x264 target 1.5 MB'],
      [{ target: { mode: 'quality', tier: 'lossless' }, pixelFormat: 'source', audio: { kind: 'copy' }, fit: null }, 'x264 lossless'],
      [{ target: { mode: 'quality', tier: 'high' }, tune: 'grain', audio: { kind: 'copy' }, fit: null }, 'x264 high quality, tune grain'],
      [{ target: { mode: 'quality', tier: 'low' }, pixelFormat: 'yuv420p10le', container: 'mkv', audio: { kind: 'copy' }, fit: null },
        'x264 low quality, 10-bit, MKV'],
      [{ target: { mode: 'quality', tier: 'medium' }, fit: { maxWidth: 1280, maxHeight: null, mode: 'pad' }, audio: { kind: 'same-as-source' } },
        'x264 medium quality, max 1280 px wide, padded, source audio codec']
    ]
    for (const [change, text] of changes)
    {
      expect(describeRecipe({ ...COMPRESS, ...change })).toBe(text)
    }
  })

  it('describes normalize recipes by target, true peak, and what runs to reach it', () =>
  {
    expect(describeRecipe(applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' }))).toBe('-23.0 LUFS, true peak -1.0 dBTP')
    expect(describeRecipe(applyLoudnessPreset('apple-podcasts', { kind: 'same-as-source' }))).toBe('-16 LKFS, true peak -1.0 dBTP, peak limiting up to 1.0 dB')
    expect(describeRecipe(applyLoudnessPreset('atsc-a85', { kind: 'same-as-source' }))).toBe('-24 LKFS, true peak -2.0 dBTP')
    expect(describeRecipe(applyLoudnessPreset('night', { kind: 'same-as-source' }))).toBe('-18 LUFS, true peak -1.0 dBTP, dynamics reduced first')
    expect(describeRecipe(applyLoudnessPreset('custom', { kind: 'same-as-source' }))).toBe('-18.0 LUFS, true peak -1.0 dBTP')
    const edited: NormalizeRecipe = { ...applyLoudnessPreset('custom', { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }), downmix: 'standard' }
    edited.target = { ...edited.target, integratedLufs: -16.5, maxTruePeakDbtp: -1.5 }
    expect(describeRecipe(edited)).toBe('-16.5 LUFS, true peak -1.5 dBTP, downmix to stereo, AAC 256k')
    expect(describeRecipe({ ...edited, downmix: 'dialog', output: { kind: 'codec', codec: 'flac', kbpsPerPair: null } }))
      .toBe('-16.5 LUFS, true peak -1.5 dBTP, stereo with dialog emphasis, FLAC')
  })

  it.each(LOUDNESS_PRESETS.map((preset) => [preset.id]))('prints the %s target as the audio messages do, edited or not', (id) =>
  {
    for (const shift of [0, 0.5, -2])
    {
      const recipe = applyLoudnessPreset(id, { kind: 'same-as-source' })
      const T = recipe.target.integratedLufs + shift
      recipe.target = { ...recipe.target, integratedLufs: T }
      const params = { I: T, unit: recipe.target.unit, preset: id, T, tol: 0.5, class: 'lossless', TP: -2, gate: -1 }
      const verified = renderMessage({ key: 'verified', params }, { minus: 'hyphen' })
      const stated = /: (\S+ (?:LUFS|LKFS))\)/.exec(verified)
      expect(stated, verified).not.toBeNull()
      expect(describeRecipe(recipe).split(', ')[0], `${id} ${T}`).toBe(stated?.[1])
    }
  })

  it('describes gain recipes in dB', () =>
  {
    expect(describeRecipe(applyGainPreset('gentle-lift', { kind: 'same-as-source' }))).toBe('+1.0 dB, true peak -1.0 dBTP')
    expect(describeRecipe(applyGainPreset('voice-clarity', { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 }))).toBe('+2.5 dB, high-pass 80 Hz, true peak -1.0 dBTP, MP3 320k')
    expect(describeRecipe(applyGainPreset('tone-down', { kind: 'same-as-source' }))).toBe('-2.5 dB, true peak -1.0 dBTP')
  })

  it('describes convert recipes, audio only included', () =>
  {
    expect(describeRecipe(CONVERT)).toBe('MP4, x264 5000k, AAC 256k')
    expect(describeRecipe(AUDIO_ONLY)).toBe('MP3 320k, audio only')
    expect(describeRecipe({ ...AUDIO_ONLY, container: 'm4a', audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 256 } })).toBe('M4A, AAC 256k, audio only')
    expect(describeRecipe({ ...AUDIO_ONLY, container: 'wav', audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null } })).toBe('WAV, PCM, audio only')
    expect(describeRecipe({ ...AUDIO_ONLY, container: 'flac', audio: { kind: 'codec', codec: 'flac', kbpsPerPair: null } })).toBe('FLAC, audio only')
    expect(describeRecipe({ ...AUDIO_ONLY, container: 'ac3', audio: { kind: 'codec', codec: 'ac3', kbpsPerPair: 448 / 3 } })).toBe('AC-3 448k at 5.1, audio only')
    expect(describeRecipe({ ...CONVERT, container: 'mkv', video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' }, audio: { kind: 'copy' } }))
      .toBe('MKV, video copied, audio copied')
    expect(describeRecipe({
      ...CONVERT,
      video: { encoder: 'libx264', bitrateKbps: 1500, fit: { maxWidth: 1280, maxHeight: 720, mode: 'fit' }, fps: 30, pixelFormat: 'yuv420p' },
      audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }
    })).toBe('MP4, x264 1500k, max 1280x720, 30 fps, AAC 128k')
    expect(describeRecipe({
      ...CONVERT,
      container: 'mov',
      video: { encoder: 'prores_ks', bitrateKbps: null, fit: { maxWidth: 1080, maxHeight: 1920, mode: 'crop' }, fps: 29.97, pixelFormat: 'yuv420p10le' },
      audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null },
      channels: 'stereo',
      subtitles: 'drop'
    })).toBe('MOV, ProRes, max 1080x1920, cropped, 29.97 fps, 10-bit, PCM stereo, subtitles dropped')
    expect(describeRecipe({ ...AUDIO_ONLY, subtitles: 'drop' })).toBe('MP3 320k, audio only, subtitles dropped')
  })

  it('states bitrates per channel rule: mono halves the pair, stereo keeps it', () =>
  {
    expect(audioOutLabel({ kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }, 'mono')).toBe('MP3 96k mono')
    expect(audioOutLabel({ kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, 'mono')).toBe('AAC 64k mono')
    expect(audioOutLabel({ kind: 'codec', codec: 'aac', kbpsPerPair: 192 }, 'stereo')).toBe('AAC 192k stereo')
    expect(audioOutLabel({ kind: 'codec', codec: 'eac3', kbpsPerPair: 640 / 3 }, 'keep')).toBe('E-AC-3 640k at 5.1')
    expect(audioOutLabel({ kind: 'codec', codec: 'ac3', kbpsPerPair: 192 }, 'stereo')).toBe('AC-3 192k stereo')
    expect(audioOutLabel({ kind: 'codec', codec: 'opus', kbpsPerPair: null }, 'mono')).toBe('Opus mono')
    expect(audioOutLabel({ kind: 'codec', codec: 'wmav2', kbpsPerPair: 192 })).toBe('WMA 192k')
    expect(audioOutLabel({ kind: 'same-as-source' }, 'stereo')).toBe('source audio codec stereo')
    expect(audioOutLabel({ kind: 'copy' }, 'keep')).toBe('audio copied')
  })

  it('describes extract recipes in every mode', () =>
  {
    expect(describeRecipe(EXTRACT_AUDIO)).toBe('MP3 320k')
    expect(describeRecipe({ ...EXTRACT_AUDIO, container: 'm4a', audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }, sampleRate: 44100,
      stream: { by: 'ordinal', ordinal: 2 }, range: { startSec: 90, durationSec: 30 } }))
      .toBe('M4A, AAC 256k, 44.1 kHz, audio stream 2, 1:30 to 2:00')
    expect(describeRecipe({ ...EXTRACT_AUDIO, container: 'mka', audio: { kind: 'copy' }, stream: { by: 'language', language: 'jpn' }, range: { startSec: 5.5, durationSec: null } }))
      .toBe('MKA, audio copied, jpn audio, from 0:05.5')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'video', container: 'mp4', reencode: null, range: { startSec: 3600, durationSec: 61 } }))
      .toBe('MP4, video copied, 1:00:00 to 1:01:01')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'video', container: 'webm', reencode: { encoder: 'libvpx-vp9', crf: 31 }, range: null }))
      .toBe('WebM, VP9 CRF 31')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'gif', fps: 15, width: 720, dither: 'sierra2_4a', plays: 'infinite', range: null }))
      .toBe('GIF 15 fps, 720 px wide, loops')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'gif', fps: 10, width: null, dither: 'bayer', plays: 1, range: { startSec: 0, durationSec: 5 } }))
      .toBe('GIF 10 fps, Bayer dither, plays once, 0:00 to 0:05')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'gif', fps: 24, width: null, dither: 'floyd_steinberg', plays: 3, range: null }))
      .toBe('GIF 24 fps, Floyd-Steinberg dither, plays 3 times')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'gif', fps: 12, width: null, dither: 'none', plays: 2, range: null }))
      .toBe('GIF 12 fps, no dither, plays 2 times')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'interval', seconds: 10 }, format: 'jpg', jpgQuality: 2, range: null }))
      .toBe('JPEG frames, a frame every 10 s, quality 2')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'fps', fps: 1 }, format: 'png', jpgQuality: null, range: null }))
      .toBe('PNG frames, 1 frames per second')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'count', count: 50 }, format: 'webp', jpgQuality: null, range: null }))
      .toBe('WebP frames, 50 frames, evenly spaced')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'thumbnail' }, format: 'png', jpgQuality: null, range: null }))
      .toBe('PNG frames, one representative frame')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'default' }, format: 'srt' })).toBe('SRT subtitles')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'language', language: 'en-US' }, format: 'vtt' }))
      .toBe('WebVTT subtitles, en-US subtitle')
    expect(describeRecipe({ kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'ordinal', ordinal: 3 }, format: 'ass' }))
      .toBe('ASS subtitles, subtitle stream 3')
  })

  it('formats sizes, caps, and ranges as the page does', () =>
  {
    expect(megabytes(25_000_000)).toBe('25 MB')
    expect(megabytes(500_000_000)).toBe('500 MB')
    expect(megabytes(1_250_000)).toBe('1.3 MB')
    expect(fitLabel({ maxWidth: null, maxHeight: 720, mode: 'fit' })).toBe('max 720p')
    expect(fitLabel({ maxWidth: 1920, maxHeight: 1080, mode: 'pad' })).toBe('max 1920x1080, padded')
    expect(rangeLabel({ startSec: 0, durationSec: 59.5 })).toBe('0:00 to 0:59.5')
    expect(rangeLabel({ startSec: 7322, durationSec: null })).toBe('from 2:02:02')
  })

  it('carries a time that rounds up to a whole minute or hour into it', () =>
  {
    expect(rangeLabel({ startSec: 59.9996, durationSec: null })).toBe('from 1:00')
    expect(rangeLabel({ startSec: 0, durationSec: 119.9999 })).toBe('0:00 to 2:00')
    expect(rangeLabel({ startSec: 3599.9995, durationSec: null })).toBe('from 1:00:00')
    expect(rangeLabel({ startSec: 59.9994, durationSec: null })).toBe('from 0:59.999')
    expect(rangeLabel({ startSec: 0.1 + 0.2, durationSec: 1.05 })).toBe('0:00.3 to 0:01.35')
    expect(rangeLabel({ startSec: 3661.5, durationSec: null })).toBe('from 1:01:01.5')
  })
})

const EBU = applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'aac', kbpsPerPair: 256 })

/** A lookup over two presets: the built-in EBU R 128 normalize preset and a user preset u1. */
const lookup: PresetLookup = (recipe) =>
{
  if (recipe.userPreset?.id === 'u1')
  {
    return { label: 'Late podcasts (renamed)', recipe: { ...COMPRESS, userPreset: { id: 'u1', name: 'Late podcasts' } } }
  }
  if (recipe.userPreset === null && recipe.kind === 'normalize' && recipe.presetId === 'ebu-r128')
  {
    return { label: 'EBU R 128', recipe: applyLoudnessPreset('ebu-r128', recipe.output) }
  }
  return null
}

describe('edited recipes and the Recipe cell', () =>
{
  it('is not edited while its values equal the preset', () =>
  {
    expect(isEdited(EBU, lookup)).toBe(false)
    expect(recipeLabel(EBU, lookup)).toBe('Normalize · EBU R 128')
  })

  it('is edited when any value differs, and says so', () =>
  {
    const edited: Recipe = { ...EBU, maxLimitingDb: 2 }
    expect(isEdited(edited, lookup)).toBe(true)
    expect(recipeLabel(edited, lookup)).toBe('Normalize · EBU R 128, edited')
    expect(isEdited({ ...EBU, target: { ...EBU.target, maxTruePeakDbtp: -2 } }, lookup)).toBe(true)
    expect(isEdited({ ...EBU, shortForm: null }, lookup)).toBe(true)
  })

  it('ignores the output policy the preset was applied with, the preset names, and the album group', () =>
  {
    expect(isEdited({ ...EBU, output: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }, lookup)).toBe(false)
    expect(isEdited({ ...EBU, albumGroupId: 'A' }, lookup)).toBe(false)
    expect(sameRecipeValues(EBU, { ...EBU, presetId: 'custom', userPreset: { id: 'x', name: 'y' }, albumGroupId: 'B' })).toBe(true)
    expect(sameRecipeValues(COMPRESS, { ...COMPRESS, fit: null })).toBe(false)
    expect(sameRecipeValues(COMPRESS, { ...COMPRESS, fit: { maxWidth: null, maxHeight: 1080, mode: 'fit' } })).toBe(true)
    expect(sameRecipeValues(COMPRESS, { ...COMPRESS, fit: { maxWidth: null, maxHeight: 1080 } as never })).toBe(false)
    expect(sameRecipeValues(CONVERT, { ...CONVERT, video: [] as never })).toBe(false)
    expect(sameRecipeValues(COMPRESS, CONVERT)).toBe(false)
  })

  it('names user presets by the name applied, and deleted ones as Custom', () =>
  {
    const fromUser: Recipe = { ...COMPRESS, userPreset: { id: 'u1', name: 'Late podcasts' } }
    expect(presetLabel(fromUser, lookup)).toBe('Late podcasts')
    expect(recipeLabel(fromUser, lookup)).toBe('Compress · Late podcasts')
    expect(recipeLabel({ ...fromUser, target: { mode: 'crf', crf: 20 } }, lookup)).toBe('Compress · Late podcasts, edited')
    const deleted: Recipe = { ...COMPRESS, userPreset: { id: 'gone', name: 'Old tapes' } }
    expect(recipeLabel(deleted, lookup)).toBe('Compress · Custom (from deleted preset Old tapes)')
    expect(isEdited(deleted, lookup)).toBe(false)
  })

  it('reads Custom for recipes without a preset', () =>
  {
    expect(recipeLabel(COMPRESS, lookup)).toBe('Compress · Custom')
    expect(recipeLabel(applyGainPreset('louder', { kind: 'same-as-source' }), () => null)).toBe('Gain · Custom')
    expect(recipeLabel(applyLoudnessPreset('custom', { kind: 'same-as-source' }), lookup)).toBe('Normalize · Custom')
  })
})

describe('the {preset} slug', () =>
{
  it('slugifies user preset names and keeps built-in ids', () =>
  {
    expect(slugify('Late Podcasts!')).toBe('late-podcasts')
    expect(slugify('  Café   Crème 2  ')).toBe('cafe-creme-2')
    expect(slugify('Ünïcödé + names')).toBe('unicode-names')
    expect(slugify('日本語 プリセット')).toBe('日本語-プリセット')
    expect(presetSlug({ ...COMPRESS, userPreset: { id: 'u', name: 'Web 1080p (mine)' } })).toBe('web-1080p-mine')
    expect(presetSlug({ ...COMPRESS, userPreset: { id: 'u', name: '!!!' } })).toBe('custom')
    expect(presetSlug({ ...COMPRESS, presetId: 'web-1080p' })).toBe('web-1080p')
    expect(presetSlug(COMPRESS)).toBe('custom')
    expect(presetSlug(EBU)).toBe('ebu-r128')
    expect(presetSlug(applyLoudnessPreset('custom', { kind: 'same-as-source' }))).toBe('custom')
    expect(presetSlug(applyGainPreset('gentle-lift', { kind: 'same-as-source' }))).toBe('gentle-lift')
  })
})
