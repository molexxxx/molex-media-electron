/**
 * Drop anywhere on the Player: files and folders from the system add their media, and a link dragged from a browser
 * adds what it points to. The drop is taken here, so the shell's drop handler never turns it into batch jobs.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'

/** What a drop hands on. */
export interface PlayerDropOptions
{
  onPaths: (paths: string[]) => void
  onLink: (text: string) => void
  /** Resolves a dropped file's path; the preload's by default. */
  resolvePath?: (file: File) => string
}

/** What a drag carries that the Player takes: files, a link, or nothing. */
export function dropKind(transfer: Pick<DataTransfer, 'types'> | null): 'files' | 'link' | null
{
  if (transfer === null)
  {
    return null
  }
  const types = Array.from(transfer.types)
  if (types.includes('Files'))
  {
    return 'files'
  }
  return types.includes('text/uri-list') || types.includes('text/plain') ? 'link' : null
}

/** The first web address in a dragged uri-list or text, skipping uri-list comments; null when there is none. */
export function droppedLink(text: string): string | null
{
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '' && !part.startsWith('#'))
  return line !== undefined && /^https?:\/\//i.test(line) ? line : null
}

/** Tracks a drag over `root` and hands the drop on; true while something the Player takes is over it. */
export function usePlayerDrop(root: RefObject<HTMLElement | null>, options: PlayerDropOptions): boolean
{
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const latest = useRef(options)
  latest.current = options

  useEffect(() =>
  {
    const element = root.current
    if (element === null)
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
      if (dropKind(event.dataTransfer) === null)
      {
        return
      }
      event.preventDefault()
      depth.current += 1
      setActive(true)
    }
    const over = (event: DragEvent): void =>
    {
      if (dropKind(event.dataTransfer) === null)
      {
        return
      }
      event.preventDefault()
      if (event.dataTransfer !== null)
      {
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const leave = (): void =>
    {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0)
      {
        setActive(false)
      }
    }
    const drop = (event: DragEvent): void =>
    {
      const kind = dropKind(event.dataTransfer)
      if (kind === null || event.dataTransfer === null)
      {
        return
      }
      event.preventDefault()
      reset()
      if (kind === 'files')
      {
        const resolve = latest.current.resolvePath ?? ((file: File) => window.api.getFilePath(file))
        const paths = Array.from(event.dataTransfer.files).map((file) => resolve(file)).filter((path) => path !== '')
        if (paths.length > 0)
        {
          latest.current.onPaths(paths)
        }
        return
      }
      const link = droppedLink(event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'))
      if (link !== null)
      {
        latest.current.onLink(link)
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
    }
  }, [root])

  return active
}
