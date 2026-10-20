/**
 * Platform words and key names. Strings are written with Windows words; this module maps them for macOS and Linux,
 * so no string hard-codes a platform. The platform is always a parameter, never read from the process.
 */

/** The platforms the app ships for. */
export type Platform = 'win32' | 'darwin' | 'linux'

/** A platform from a Node platform name; anything but win32 and darwin reads as linux. */
export function toPlatform(name: string): Platform
{
  return name === 'win32' || name === 'darwin' ? name : 'linux'
}

/** The words one platform uses for its bin, file manager, keys, paths, and volumes. */
export interface PlatformWords
{
  /** "Recycle Bin" or "Trash". */
  binName: string
  /** The bin's automatic emptying, as a sentence. */
  binAutoEmpty: string
  /** Whether the bin is emptied by size, so the app checks its room before moving files into it (Windows only). */
  binChecksCapacity: boolean
  /** The command that shows a file in the file manager. */
  revealLabel: string
  /** The file manager's command for copying a path. */
  copyPathCommand: string
  /** Modifier key words. */
  modKey: string
  altKey: string
  shiftKey: string
  /** The key that removes the selected jobs, and the chord that cancels running jobs. */
  deleteKey: string
  cancelChord: string
  /** A folder path for hints and errors. */
  examplePath: string
  /** How a sentence names a volume, and an example of that name. */
  volumeWord: string
  volumeExample: string
}

const WORDS: Readonly<Record<Platform, PlatformWords>> =
{
  win32:
  {
    binName: 'Recycle Bin',
    binAutoEmpty: 'Windows can empty it automatically.',
    binChecksCapacity: true,
    revealLabel: 'Show in folder',
    copyPathCommand: 'Explorer\'s "Copy as path"',
    modKey: 'Ctrl',
    altKey: 'Alt',
    shiftKey: 'Shift',
    deleteKey: 'Delete',
    cancelChord: 'Shift+Delete',
    examplePath: 'D:\\Exports',
    volumeWord: 'drive letter',
    volumeExample: 'D:'
  },
  darwin:
  {
    binName: 'Trash',
    binAutoEmpty: 'The Trash can be emptied automatically.',
    binChecksCapacity: false,
    revealLabel: 'Show in Finder',
    copyPathCommand: 'Finder\'s "Copy as Pathname"',
    modKey: 'Cmd',
    altKey: 'Option',
    shiftKey: 'Shift',
    deleteKey: 'Delete',
    cancelChord: 'Cmd+Delete',
    examplePath: '/Volumes/Media/Exports',
    volumeWord: 'volume name',
    volumeExample: 'Media'
  },
  linux:
  {
    binName: 'Trash',
    binAutoEmpty: 'The Trash can be emptied automatically.',
    binChecksCapacity: false,
    revealLabel: 'Show in folder',
    copyPathCommand: 'the file manager\'s copy',
    modKey: 'Ctrl',
    altKey: 'Alt',
    shiftKey: 'Shift',
    deleteKey: 'Delete',
    cancelChord: 'Shift+Delete',
    examplePath: '/home/you/Exports',
    volumeWord: 'mount point',
    volumeExample: '/mnt/media'
  }
}

/** The words of one platform. */
export function platformWords(platform: Platform): PlatformWords
{
  return WORDS[platform]
}

/** The bin as a sentence names it: "the Recycle Bin on D:" when a Windows volume is given, else "the Recycle Bin" or "the Trash". */
export function binPhrase(platform: Platform, volume: string | null = null): string
{
  const name = `the ${WORDS[platform].binName}`
  return platform === 'win32' && volume ? `${name} on ${volume}` : name
}

const KEY_NAMES: Readonly<Record<string, string>> = { PageUp: 'Page Up', PageDown: 'Page Down' }

const MAC_KEY_NAMES: Readonly<Record<string, readonly string[]>> =
{
  Backspace: ['Delete'],
  Home: ['fn', 'Left'],
  End: ['fn', 'Right'],
  PageUp: ['fn', 'Up'],
  PageDown: ['fn', 'Down']
}

/** Whole chords macOS spells differently, keyed by the Windows chord. */
const MAC_CHORDS: Readonly<Record<string, readonly string[]>> =
{
  'Shift+Delete': ['Cmd', 'Delete'],
  'Mod+Y': ['Cmd', 'Shift', 'Z'],
  'Alt+Left': ['Cmd', '[']
}

const FUNCTION_KEY = /^F\d{1,2}$/

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined
{
  return Object.hasOwn(map, key) ? map[key] : undefined
}

function macKey(key: string): readonly string[] | undefined
{
  return own(MAC_KEY_NAMES, key) ?? (FUNCTION_KEY.test(key) ? ['fn', key] : undefined)
}

/**
 * The keycaps of a shortcut on a platform. 'Mod' is Ctrl, or Cmd on macOS; 'Alt' is Option on macOS; macOS also
 * spells Shift+Delete as Cmd+Delete, Ctrl+Y as Cmd+Shift+Z, Alt+Left as Cmd+[, Backspace as Delete, Home, End,
 * Page Up, and Page Down with fn and an arrow, and the function keys with fn (fn+F6). Other keys are returned as
 * words ("Enter", "Space").
 */
export function platformKeys(keys: readonly string[], platform: Platform): string[]
{
  const words = WORDS[platform]
  if (platform === 'darwin')
  {
    const chord = own(MAC_CHORDS, keys.join('+'))
    if (chord)
    {
      return [...chord]
    }
  }
  return keys.flatMap((key) =>
  {
    if (key === 'Mod')
    {
      return [words.modKey]
    }
    if (key === 'Alt')
    {
      return [words.altKey]
    }
    const mac = platform === 'darwin' ? macKey(key) : undefined
    return mac ? [...mac] : [own(KEY_NAMES, key) ?? key]
  })
}

/** A shortcut as text, keycaps joined with "+": formatKeys(['Mod', 'Enter'], 'darwin') is "Cmd+Enter". */
export function formatKeys(keys: readonly string[], platform: Platform): string
{
  return platformKeys(keys, platform).join('+')
}
