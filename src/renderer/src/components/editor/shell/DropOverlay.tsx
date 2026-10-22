/**
 * @module editor/shell/DropOverlay
 * The frame over the editor while files are dragged over it, naming what a drop will do. It never takes the
 * pointer, so the drop lands on the editor beneath it.
 */
import type { ReactElement } from 'react'

/** Props of {@link DropOverlay}. */
export interface DropOverlayProps
{
  label: string
}

/** The drop frame and its one line. */
export function DropOverlay({ label }: DropOverlayProps): ReactElement
{
  return (
    <div
      aria-hidden="true"
      data-drop-overlay
      className="pointer-events-none absolute inset-0 z-sticky flex items-center justify-center bg-scrim outline-2 -outline-offset-8 outline-accent"
    >
      <p className="rounded-md border border-line-strong bg-overlay px-4 py-3 text-section text-ink shadow-overlay">{label}</p>
    </div>
  )
}
