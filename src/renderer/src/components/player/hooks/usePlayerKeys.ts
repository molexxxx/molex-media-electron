/**
 * The Player's keyboard map: what each key does, the list the shortcuts popover shows, and the hook that acts on
 * keys that reach the window unclaimed while the Player is visible. Controls keep their own keys: a focused button
 * keeps Space, a slider or the playlist keeps the arrows, and a text field keeps everything.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { listenUnclaimedKeys } from '../../../hooks/useAppZoomKeys'
import type { ShortcutGroup } from '../../batch/page/ShortcutsPopover'
import { SEEK_STEPS, VOLUME_STEP } from '../components/Transport'

/** A command of the Player's keyboard map. */
export type PlayerKeyCommand =
  | { kind: 'toggle-play' }
  | { kind: 'seek', by: number }
  | { kind: 'volume', by: number }
  | { kind: 'mute' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'shuffle' }
  | { kind: 'repeat' }
  | { kind: 'visualization', direction: 1 | -1 }
  | { kind: 'view' }
  | { kind: 'add-files' }
  | { kind: 'add-folder' }
  | { kind: 'add-link' }
  | { kind: 'media-info' }
  | { kind: 'shortcuts' }
  | { kind: 'full-screen' }
  | { kind: 'escape' }

/** The key facts a command reads. */
export type KeyChord = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/** Where the key landed, which decides the keys a control keeps. */
export interface KeyTarget
{
  /** A text field, select, or editable element: it keeps every key. */
  text: boolean
  /** A button, link, check box, or menu item: it keeps Space and Enter. */
  button: boolean
  /** A slider, grid, or list: it keeps the arrows, Home, End, and the page keys. */
  arrows: boolean
}

const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

/** The command for a key, or null when the Player leaves it alone. */
export function playerKeyCommand(chord: KeyChord, target: KeyTarget): PlayerKeyCommand | null
{
  const { key, altKey, shiftKey } = chord
  const mod = chord.ctrlKey || chord.metaKey
  switch (key)
  {
    case 'MediaPlayPause':
      return { kind: 'toggle-play' }
    case 'MediaTrackNext':
      return { kind: 'next' }
    case 'MediaTrackPrevious':
      return { kind: 'previous' }
    case 'F1':
      return { kind: 'shortcuts' }
    case 'F11':
      return { kind: 'full-screen' }
    case 'Escape':
      return target.text ? null : { kind: 'escape' }
  }
  if (target.text || altKey)
  {
    return null
  }
  if (mod)
  {
    switch (key.toLowerCase())
    {
      case 'o':
        return shiftKey ? { kind: 'add-folder' } : { kind: 'add-files' }
      case 'u':
        return shiftKey ? null : { kind: 'add-link' }
      case 'i':
        return shiftKey ? null : { kind: 'media-info' }
      case '/':
        return { kind: 'shortcuts' }
      default:
        return null
    }
  }
  if (target.arrows && ARROW_KEYS.has(key))
  {
    return null
  }
  switch (key)
  {
    case ' ':
      return target.button ? null : { kind: 'toggle-play' }
    case 'ArrowLeft':
      return { kind: 'seek', by: -(shiftKey ? SEEK_STEPS.page : SEEK_STEPS.arrow) }
    case 'ArrowRight':
      return { kind: 'seek', by: shiftKey ? SEEK_STEPS.page : SEEK_STEPS.arrow }
    case 'ArrowUp':
      return { kind: 'volume', by: VOLUME_STEP / 100 }
    case 'ArrowDown':
      return { kind: 'volume', by: -VOLUME_STEP / 100 }
    case '?':
      return { kind: 'shortcuts' }
  }
  switch (key.toLowerCase())
  {
    case 'm':
      return shiftKey ? null : { kind: 'mute' }
    case 'n':
      return shiftKey ? null : { kind: 'next' }
    case 'p':
      return shiftKey ? null : { kind: 'previous' }
    case 's':
      return shiftKey ? null : { kind: 'shuffle' }
    case 'r':
      return shiftKey ? null : { kind: 'repeat' }
    case 'v':
      return { kind: 'visualization', direction: shiftKey ? -1 : 1 }
    case 'b':
      return shiftKey ? null : { kind: 'view' }
    default:
      return null
  }
}

/** Reads where a key landed. */
export function keyTargetOf(element: Element | null): KeyTarget
{
  if (element === null)
  {
    return { text: false, button: false, arrows: false }
  }
  const text = element.matches('input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"], [type="submit"]), textarea, select, [contenteditable]:not([contenteditable="false"])')
  const button = element.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], input[type="checkbox"], input[type="radio"]') !== null
  const arrows = element.closest('input[type="range"], [role="slider"], [role="grid"], [role="listbox"], [role="menu"], [role="radiogroup"], [role="tablist"], [role="separator"]') !== null
  return { text, button, arrows }
}

/** The Player's keyboard map as the shortcuts popover lists it. */
export const PLAYER_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    id: 'playback',
    title: 'Playback',
    entries: [
      { label: 'Play or pause', keys: ['Space'] },
      { label: 'Back or ahead 5 seconds', keys: ['Left', 'Right'] },
      { label: 'Back or ahead 30 seconds', keys: ['Shift+Left', 'Shift+Right'] },
      { label: 'Volume down or up', keys: ['Down', 'Up'] },
      { label: 'Mute or unmute', keys: ['M'] },
      { label: 'Next or previous track', keys: ['N', 'P'] },
      { label: 'Shuffle', keys: ['S'] },
      { label: 'Repeat: off, all, this track', keys: ['R'] },
      { label: 'Media keys play, pause, and skip', keys: [], text: 'Keyboard media keys' }
    ]
  },
  {
    id: 'view',
    title: 'Picture',
    entries: [
      { label: 'Next or previous visualization', keys: ['V', 'Shift+V'] },
      { label: 'Video or visualization', keys: ['B'] },
      { label: 'Full screen', keys: ['F11'], text: 'F11, or double-click the picture' },
      { label: 'Leave full screen', keys: ['Esc'] },
      { label: 'Media information', keys: ['Mod+I'] }
    ]
  },
  {
    id: 'playlist',
    title: 'Playlist',
    entries: [
      { label: 'Add files', keys: ['Mod+O'] },
      { label: 'Add folder', keys: ['Mod+Shift+O'] },
      { label: 'Add link', keys: ['Mod+U'] },
      { label: 'Play the focused track', keys: ['Enter'] },
      { label: 'Move up or down one place', keys: ['Alt+Up', 'Alt+Down'] },
      { label: 'Remove from the playlist', keys: ['Delete'] },
      { label: 'Row menu', keys: ['Shift+F10', 'Menu'] },
      { label: 'Keyboard shortcuts', keys: ['F1', 'Mod+/'] }
    ]
  }
]

/** What the keys call; a missing handler, or one that returns false, leaves its key alone. */
export type PlayerKeyHandlers = Partial<Record<PlayerKeyCommand['kind'], (command: PlayerKeyCommand) => boolean | void>>

/** Options of {@link usePlayerKeys}. */
export interface PlayerKeyOptions
{
  /** True while the keys apply wherever focus is, such as in full screen, where the player covers the window. */
  anywhere?: () => boolean
}

/** Acts on unclaimed keys while `root` is shown; the hidden view's keys stay quiet, and a modal dialog keeps them. */
export function usePlayerKeys(root: RefObject<HTMLElement | null>, handlers: PlayerKeyHandlers, options: PlayerKeyOptions = {}): void
{
  const latest = useRef({ handlers, options })
  latest.current = { handlers, options }
  useEffect(() => listenUnclaimedKeys((event) =>
  {
    const element = root.current
    if (element === null || element.getClientRects().length === 0 || element.ownerDocument.querySelector('dialog[open]') !== null)
    {
      return
    }
    const active = element.ownerDocument.activeElement
    const anywhere = latest.current.options.anywhere?.() === true
    if (!anywhere && active !== null && active !== element.ownerDocument.body && !element.contains(active))
    {
      return
    }
    const command = playerKeyCommand(event, keyTargetOf(event.target instanceof Element ? event.target : null))
    const handler = command === null ? undefined : latest.current.handlers[command.kind]
    if (command === null || handler === undefined || handler(command) === false)
    {
      return
    }
    event.preventDefault()
  }), [root])
}
