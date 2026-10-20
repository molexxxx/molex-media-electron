/**
 * Drag and drop onto the Batch view: the overlay over the table region that names the recipe the dropped files get
 * and the subfolder rule, and the hook that tracks a file drag across the view and hands the dropped paths on.
 */
import React, { useEffect, useRef, useState, type RefObject } from 'react'
import { Icon } from '../../../ui/Icon'

/** "Drop to add. New files get Normalize · Podcast (Apple Podcasts)." */
export function dropLine(recipe: string | null): string
{
  return recipe === null ? 'Drop to add.' : `Drop to add. New files get ${recipe}.`
}

/** The subfolder rule the "Include subfolders" setting decides. */
export function subfolderLine(recursive: boolean): string
{
  return recursive ? 'Folders are scanned, including subfolders.' : 'Folders are scanned without their subfolders.'
}

/** Whether a drag carries files from the system, not text or an element of the page. */
export function carriesFiles(transfer: Pick<DataTransfer, 'types'> | null): boolean
{
  if (transfer === null)
  {
    return false
  }
  return Array.from(transfer.types).includes('Files')
}

/** Resolves a dropped file's path through the preload; null when the preload cannot. */
export function pathOfFile(file: File): string | null
{
  const api = (window as unknown as { api?: { getFilePath?: (target: File) => string } }).api
  const path = api?.getFilePath?.(file) ?? ''
  return path === '' ? null : path
}

/** What the drop hook reads and calls. */
export interface FileDropOptions
{
  /** The dropped files' paths, in drop order; never called with none. */
  onDrop: (paths: string[]) => void
  /** Resolves each file's path; the preload's by default. */
  resolvePath?: (file: File) => string | null
  /** Ignores drags while false. */
  enabled?: boolean
}

/** Tracks a file drag over the element: true from the first dragenter of files until the drop or the last dragleave. */
export function useFileDrop(ref: RefObject<HTMLElement | null>, { onDrop, resolvePath = pathOfFile, enabled = true }: FileDropOptions): boolean
{
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const latest = useRef({ onDrop, resolvePath })

  useEffect(() =>
  {
    latest.current = { onDrop, resolvePath }
  }, [onDrop, resolvePath])

  useEffect(() =>
  {
    const element = ref.current
    if (element === null || !enabled)
    {
      return undefined
    }
    const reset = (): void =>
    {
      depth.current = 0
      setActive(false)
    }
    const enter = (event: DragEvent): void =>
    {
      if (!carriesFiles(event.dataTransfer))
      {
        return
      }
      event.preventDefault()
      depth.current += 1
      setActive(true)
    }
    const over = (event: DragEvent): void =>
    {
      if (!carriesFiles(event.dataTransfer))
      {
        return
      }
      event.preventDefault()
      if (event.dataTransfer !== null)
      {
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const leave = (event: DragEvent): void =>
    {
      if (!carriesFiles(event.dataTransfer))
      {
        return
      }
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0)
      {
        setActive(false)
      }
    }
    const drop = (event: DragEvent): void =>
    {
      if (!carriesFiles(event.dataTransfer))
      {
        return
      }
      event.preventDefault()
      reset()
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files.map((file) => latest.current.resolvePath(file)).filter((path): path is string => path !== null)
      if (paths.length > 0)
      {
        latest.current.onDrop(paths)
      }
    }
    element.addEventListener('dragenter', enter)
    element.addEventListener('dragover', over)
    element.addEventListener('dragleave', leave)
    element.addEventListener('drop', drop)
    return () =>
    {
      element.removeEventListener('dragenter', enter)
      element.removeEventListener('dragover', over)
      element.removeEventListener('dragleave', leave)
      element.removeEventListener('drop', drop)
      reset()
    }
  }, [ref, enabled])

  return active
}

/** Props of {@link DropOverlay}. */
export interface DropOverlayProps
{
  /** The "New files get" recipe, such as "Normalize · Podcast (Apple Podcasts)"; null before the first snapshot. */
  recipe: string | null
  /** The Add menu's "Include subfolders". */
  recursive: boolean
}

/**
 * The drop overlay over the table region while files are dragged over the view: the table dims behind a near-opaque
 * ground inside an amber edge, with the operation the files will get and the subfolder rule. It takes no pointer
 * events, so the drop lands on the view below it.
 */
export function DropOverlay({ recipe, recursive }: DropOverlayProps): React.JSX.Element
{
  return (
    <div
      data-drop-overlay=""
      aria-hidden="true"
      className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-md bg-ground/92 px-6 text-center inset-ring inset-ring-amber"
    >
      <span className="flex text-amber"><Icon name="action.addFiles" size="lg" /></span>
      <p className="text-section text-ink">{dropLine(recipe)}</p>
      <p className="text-label text-ink-3">{subfolderLine(recursive)}</p>
    </div>
  )
}
