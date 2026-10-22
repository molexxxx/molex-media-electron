/**
 * @module editor/modes
 * The editor's three modes in the words the header and the empty editor use. The values are the store's mode ids.
 */
import type { EditorMode } from './types'

/** One mode of the editor. */
export interface EditorModeInfo
{
  value: EditorMode
  label: string
  /** What the mode does, in one short line that fits the landing header. */
  landingLine: string
  /** The empty editor's heading in this mode. */
  emptyHeading: string
  /** What a drop does in this mode, shown while files are dragged over the editor. */
  dropLabel: string
  /** The chord that switches to the mode. */
  shortcut: string
}

/** The modes in header order. */
export const EDITOR_MODES: readonly EditorModeInfo[] = [
  {
    value: 'clip',
    label: 'Trim',
    landingLine: 'Cut one file between an in and an out point, then export video, audio, or a GIF.',
    emptyHeading: 'Open a file to trim',
    dropLabel: 'Drop to open it in Trim',
    shortcut: 'Mod+1'
  },
  {
    value: 'edit',
    label: 'Timeline',
    landingLine: 'Arrange clips from several files on video and audio tracks, then export one file.',
    emptyHeading: 'Open files to edit on the timeline',
    dropLabel: 'Drop to add the files to the timeline sources',
    shortcut: 'Mod+2'
  },
  {
    value: 'inspect',
    label: 'Inspect',
    landingLine: 'See the streams and tags of a file, and save a copy without the ones you remove.',
    emptyHeading: 'Open a file to inspect',
    dropLabel: 'Drop to inspect it',
    shortcut: 'Mod+3'
  }
]

/** The mode's entry. */
export function modeInfo(mode: EditorMode): EditorModeInfo
{
  return EDITOR_MODES.find((entry) => entry.value === mode) ?? EDITOR_MODES[0]
}
