/**
 * Platform words and key names for win32, darwin, and linux: the bin, its automatic emptying, the reveal command,
 * example paths, volume wording, and shortcuts with Mod and Alt mapped per platform. The platform is a parameter,
 * so every case runs on every host.
 */
import { describe, it, expect } from 'vitest'
import { binPhrase, formatKeys, platformKeys, platformWords, toPlatform, type Platform } from '../../../src/shared/text/platform'

describe('toPlatform', () =>
{
  it('keeps win32 and darwin and reads anything else as linux', () =>
  {
    expect(toPlatform('win32')).toBe('win32')
    expect(toPlatform('darwin')).toBe('darwin')
    expect(toPlatform('linux')).toBe('linux')
    expect(toPlatform('freebsd')).toBe('linux')
  })
})

describe('formatKeys', () =>
{
  it.each<[Platform, string, string]>([
    ['win32', 'Ctrl+Enter', 'Alt+6'],
    ['linux', 'Ctrl+Enter', 'Alt+6'],
    ['darwin', 'Cmd+Enter', 'Option+6']
  ])('maps Mod and Alt on %s', (platform, modEnter, altSix) =>
  {
    expect(formatKeys(['Mod', 'Enter'], platform)).toBe(modEnter)
    expect(formatKeys(['Alt', '6'], platform)).toBe(altSix)
  })

  it('writes the cancel chord as Shift+Delete on Windows and Linux and Cmd+Delete on macOS', () =>
  {
    expect(formatKeys(['Shift', 'Delete'], 'win32')).toBe('Shift+Delete')
    expect(formatKeys(['Shift', 'Delete'], 'linux')).toBe('Shift+Delete')
    expect(formatKeys(['Shift', 'Delete'], 'darwin')).toBe('Cmd+Delete')
    expect(formatKeys(['Delete'], 'darwin')).toBe('Delete')
  })

  it('spells the other macOS equivalents of the keyboard map', () =>
  {
    expect(formatKeys(['Mod', 'Y'], 'win32')).toBe('Ctrl+Y')
    expect(formatKeys(['Mod', 'Y'], 'darwin')).toBe('Cmd+Shift+Z')
    expect(formatKeys(['Alt', 'Left'], 'win32')).toBe('Alt+Left')
    expect(formatKeys(['Alt', 'Left'], 'darwin')).toBe('Cmd+[')
    expect(formatKeys(['Backspace'], 'darwin')).toBe('Delete')
    expect(formatKeys(['Alt', 'Home'], 'darwin')).toBe('Option+fn+Left')
    expect(formatKeys(['End'], 'darwin')).toBe('fn+Right')
    expect(formatKeys(['PageUp'], 'darwin')).toBe('fn+Up')
    expect(formatKeys(['PageDown'], 'darwin')).toBe('fn+Down')
    expect(formatKeys(['Alt', 'Shift', '3'], 'darwin')).toBe('Option+Shift+3')
  })

  it('adds fn to the function keys on macOS only', () =>
  {
    expect(formatKeys(['F1'], 'darwin')).toBe('fn+F1')
    expect(formatKeys(['F6'], 'darwin')).toBe('fn+F6')
    expect(formatKeys(['F8'], 'darwin')).toBe('fn+F8')
    expect(formatKeys(['Shift', 'F6'], 'darwin')).toBe('Shift+fn+F6')
    expect(formatKeys(['F12'], 'darwin')).toBe('fn+F12')
    expect(formatKeys(['F6'], 'win32')).toBe('F6')
    expect(formatKeys(['Shift', 'F6'], 'linux')).toBe('Shift+F6')
    expect(formatKeys(['F'], 'darwin')).toBe('F')
    expect(formatKeys(['F100'], 'darwin')).toBe('F100')
  })

  it('names keys as words and leaves the rest as given', () =>
  {
    expect(formatKeys(['PageUp'], 'win32')).toBe('Page Up')
    expect(formatKeys(['PageDown'], 'linux')).toBe('Page Down')
    expect(formatKeys(['Home'], 'win32')).toBe('Home')
    expect(formatKeys(['Mod', 'P'], 'win32')).toBe('Ctrl+P')
    expect(formatKeys(['F6'], 'linux')).toBe('F6')
    expect(formatKeys(['Space'], 'win32')).toBe('Space')
    expect(formatKeys([], 'win32')).toBe('')
    expect(formatKeys(['constructor'], 'darwin')).toBe('constructor')
  })

  it('returns keycaps one per key for the Kbd primitive', () =>
  {
    expect(platformKeys(['Mod', 'Shift', 'Enter'], 'darwin')).toEqual(['Cmd', 'Shift', 'Enter'])
    expect(platformKeys(['Home'], 'darwin')).toEqual(['fn', 'Left'])
    expect(platformKeys(['Shift', 'Delete'], 'darwin')).toEqual(['Cmd', 'Delete'])
    expect(platformKeys(['Shift', 'F6'], 'darwin')).toEqual(['Shift', 'fn', 'F6'])
  })
})

describe('platform words', () =>
{
  it('names the bin, its emptying, and its capacity check', () =>
  {
    expect(platformWords('win32')).toMatchObject({ binName: 'Recycle Bin', binAutoEmpty: 'Windows can empty it automatically.', binChecksCapacity: true })
    expect(platformWords('darwin')).toMatchObject({ binName: 'Trash', binAutoEmpty: 'The Trash can be emptied automatically.', binChecksCapacity: false })
    expect(platformWords('linux')).toMatchObject({ binName: 'Trash', binAutoEmpty: 'The Trash can be emptied automatically.', binChecksCapacity: false })
  })

  it('names the reveal command and the copy-path command', () =>
  {
    expect(platformWords('win32').revealLabel).toBe('Show in folder')
    expect(platformWords('darwin').revealLabel).toBe('Show in Finder')
    expect(platformWords('linux').revealLabel).toBe('Show in folder')
    expect(platformWords('win32').copyPathCommand).toBe('Explorer\'s "Copy as path"')
    expect(platformWords('darwin').copyPathCommand).toBe('Finder\'s "Copy as Pathname"')
    expect(platformWords('linux').copyPathCommand).toBe('the file manager\'s copy')
  })

  it('names the modifier words and the delete keys', () =>
  {
    expect(platformWords('win32')).toMatchObject({ modKey: 'Ctrl', altKey: 'Alt', shiftKey: 'Shift', deleteKey: 'Delete', cancelChord: 'Shift+Delete' })
    expect(platformWords('darwin')).toMatchObject({ modKey: 'Cmd', altKey: 'Option', shiftKey: 'Shift', deleteKey: 'Delete', cancelChord: 'Cmd+Delete' })
    expect(platformWords('linux')).toMatchObject({ modKey: 'Ctrl', altKey: 'Alt', shiftKey: 'Shift', deleteKey: 'Delete', cancelChord: 'Shift+Delete' })
  })

  it('gives each platform its example path and volume wording', () =>
  {
    expect(platformWords('win32')).toMatchObject({ examplePath: 'D:\\Exports', volumeWord: 'drive letter', volumeExample: 'D:' })
    expect(platformWords('darwin')).toMatchObject({ examplePath: '/Volumes/Media/Exports', volumeWord: 'volume name', volumeExample: 'Media' })
    expect(platformWords('linux')).toMatchObject({ examplePath: '/home/you/Exports', volumeWord: 'mount point', volumeExample: '/mnt/media' })
  })

  it('keeps the cancel chord in step with formatKeys', () =>
  {
    for (const platform of ['win32', 'darwin', 'linux'] as const)
    {
      expect(platformWords(platform).cancelChord).toBe(formatKeys(['Shift', 'Delete'], platform))
    }
  })

  it('names the bin in a sentence, with the drive on Windows', () =>
  {
    expect(binPhrase('win32', 'D:')).toBe('the Recycle Bin on D:')
    expect(binPhrase('win32')).toBe('the Recycle Bin')
    expect(binPhrase('darwin', 'Media')).toBe('the Trash')
    expect(binPhrase('linux')).toBe('the Trash')
  })
})
