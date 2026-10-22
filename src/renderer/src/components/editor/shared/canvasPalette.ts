/**
 * @module editor/shared/canvasPalette
 * The colors the editor's canvases draw with, read from the design tokens at draw time. The values are cached
 * and read again when the root element's class, style, or theme attribute changes.
 */
import { useSyncExternalStore } from 'react'
import { readToken, type TokenName } from '../../../ui/tokens'

/** Every canvas color the editor uses, as CSS color strings a canvas accepts. */
export interface CanvasPalette
{
  /** The letterbox behind video frames and thumbnails. */
  ground: string
  /** Raised cells, such as a frame that is still loading. */
  raised: string
  ink: string
  ink2: string
  ink3: string
  /** Primary marks: the selection frame and transform handles. */
  accent: string
  /** Lit marks: in and out points, the anchor, and the running state. */
  accentInk: string
  playhead: string
  /** Waveforms on a neutral ground. */
  waveform: string
  /** Waveforms over a colored clip. */
  waveformOnClip: string
  /** A third series, such as the level line of a clip. */
  series3: string
  warning: string
  grid: string
  axis: string
  band: string
  selectionWash: string
  scrim: string
}

const TOKENS: Readonly<Record<keyof CanvasPalette, TokenName>> = {
  ground: '--color-sunken',
  raised: '--color-raised',
  ink: '--color-ink',
  ink2: '--color-ink-2',
  ink3: '--color-ink-3',
  accent: '--color-accent',
  accentInk: '--color-accent-ink',
  playhead: '--color-playhead',
  waveform: '--color-viz-1',
  waveformOnClip: '--color-viz-2',
  series3: '--color-viz-3',
  warning: '--color-warning',
  grid: '--color-viz-grid',
  axis: '--color-viz-axis',
  band: '--color-viz-band',
  selectionWash: '--color-wash-selected',
  scrim: '--color-scrim'
}

/** What a token reads as when the stylesheet is missing, as in tests; the canvas then draws nothing visible. */
const MISSING = 'transparent'

let cached: CanvasPalette | null = null
let version = 0
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

/** The palette, read once from the computed tokens and reused until the theme changes. */
export function canvasPalette(): CanvasPalette
{
  if (cached === null)
  {
    const next = {} as CanvasPalette
    for (const key of Object.keys(TOKENS) as Array<keyof CanvasPalette>)
    {
      next[key] = readToken(TOKENS[key], MISSING)
    }
    cached = next
  }
  return cached
}

/** Drops the cached palette, so the next draw reads the tokens again. */
export function resetCanvasPalette(): void
{
  cached = null
  version += 1
  for (const listener of listeners)
  {
    listener()
  }
}

function subscribe(listener: () => void): () => void
{
  listeners.add(listener)
  if (observer === null && typeof MutationObserver !== 'undefined')
  {
    observer = new MutationObserver(resetCanvasPalette)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  }
  return () =>
  {
    listeners.delete(listener)
    if (listeners.size === 0)
    {
      observer?.disconnect()
      observer = null
    }
  }
}

function getVersion(): number
{
  return version
}

/** The palette for a component that draws; it renders again when the theme changes. */
export function useCanvasPalette(): CanvasPalette
{
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return canvasPalette()
}
