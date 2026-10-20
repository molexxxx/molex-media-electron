import { createContext, Fragment, useContext, type ReactElement, type ReactNode } from 'react'
import { platformKeys, type Platform } from '../../../shared/text/platform'
import { cx } from './cx'

/** The platform the renderer runs on, read from the user agent; the shell overrides it with the preload's value. */
export function detectPlatform(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): Platform
{
  if (/Macintosh|Mac OS X|darwin/i.test(agent))
  {
    return 'darwin'
  }
  if (/Windows|win32/i.test(agent))
  {
    return 'win32'
  }
  return /Linux|X11|CrOS/i.test(agent) ? 'linux' : 'win32'
}

const PlatformContext = createContext<Platform>(detectPlatform())

/** Supplies the platform that keycaps, shortcut tooltips, and `aria-keyshortcuts` are written for. */
export function PlatformProvider({ platform, children }: { platform: Platform, children?: ReactNode }): ReactElement
{
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
}

/** The platform keys are written for: the nearest {@link PlatformProvider}, or the detected one. */
export function usePlatform(): Platform
{
  return useContext(PlatformContext)
}

/** The keys of a chord written with "+": "Mod+Shift+P" gives Mod, Shift, P, and "Mod++" gives Mod and "+". */
export function splitChord(chord: string): string[]
{
  return chord.split(/\+(?=.)/).filter(Boolean)
}

const ARIA_KEYS: Readonly<Record<string, string>> = {
  Ctrl: 'Control',
  Cmd: 'Meta',
  Option: 'Alt',
  Esc: 'Escape',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight'
}

/** A chord as an `aria-keyshortcuts` value: modifiers and keys use the names of KeyboardEvent.key. */
export function ariaKeyShortcuts(keys: readonly string[], platform: Platform): string
{
  return keys
    .map((key) => key === 'Mod' ? (platform === 'darwin' ? 'Meta' : 'Control') : Object.hasOwn(ARIA_KEYS, key) ? ARIA_KEYS[key] : key)
    .join('+')
}

/** Props for {@link Kbd}. */
export interface KbdProps
{
  /** Keys in Windows words; `Mod` reads Ctrl, or Cmd on macOS, and `Alt` reads Option on macOS. */
  keys: readonly string[]
  /** Overrides the platform from {@link usePlatform}. */
  platform?: Platform
  className?: string
}

/** A shortcut drawn as keycaps, one `kbd` per key joined by "+", in the words the platform prints on its keys. */
export function Kbd({ keys, platform, className }: KbdProps): ReactElement
{
  const contextPlatform = usePlatform()
  const caps = platformKeys(keys, platform ?? contextPlatform)
  return (
    <span className={cx('inline-flex items-center gap-0.5 align-middle', className)}>
      {caps.map((cap, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="text-label text-ink-3">+</span>}
          <kbd className="inline-flex min-w-5 items-center justify-center rounded-xs border border-line-strong bg-raised px-1.5 text-label text-ink-2">
            {cap}
          </kbd>
        </Fragment>
      ))}
    </span>
  )
}
