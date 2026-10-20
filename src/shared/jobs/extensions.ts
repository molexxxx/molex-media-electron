/**
 * The one list of media extensions the app opens: the file dialog filter, window drops, folder scans, the file
 * browser, and the player all read it. Extensions are lowercase and carry no dot.
 */

/** Video container extensions. */
export const VIDEO_EXTENSIONS: readonly string[] =
[
  'mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'vob', '3gp', 'mts', 'm2ts', 'divx', 'f4v',
  'ogv', 'rm', 'rmvb', 'asf'
]

/** Audio file extensions. */
export const AUDIO_EXTENSIONS: readonly string[] =
[
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aac', 'opus', 'ac3', 'eac3', 'dts', 'amr', 'ape', 'wv', 'mka', 'aiff', 'aif',
  'oga', 'mp2'
]

/** Every extension the app opens, video first. */
export const MEDIA_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]

const VIDEO_SET = new Set(VIDEO_EXTENSIONS)
const AUDIO_SET = new Set(AUDIO_EXTENSIONS)

/** The lowercase extension of a path without the dot; '' when the name has none (a leading dot starts no extension). */
export function extensionOf(path: string): string
{
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Whether an extension, with or without its dot, is a video container. */
export function isVideoExtension(ext: string): boolean
{
  return VIDEO_SET.has(ext.replace(/^\./, '').toLowerCase())
}

/** Whether an extension, with or without its dot, is an audio file. */
export function isAudioExtension(ext: string): boolean
{
  return AUDIO_SET.has(ext.replace(/^\./, '').toLowerCase())
}

/** Whether the app opens a path, judged by its extension. */
export function isMediaPath(path: string): boolean
{
  const ext = extensionOf(path)
  return VIDEO_SET.has(ext) || AUDIO_SET.has(ext)
}
