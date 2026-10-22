/**
 * @module editor/MediaEditor
 * The editor view: the header with the mode switch and the open file, then the mode itself, or the empty editor
 * while the mode has nothing to work on. Each mode mounts on its first visit and stays alive after it. Files
 * dropped anywhere on the view open in the current mode.
 */
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactElement } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useEditorStore } from '../../stores/editorStore'
import { LiveRegion } from '../../ui/LiveRegion'
import { TabPanel } from '../../ui/Tabs'
import { ClipEditor } from './clip/ClipEditor'
import { EditEditor } from './edit/EditEditor'
import { InspectEditor } from './inspect/InspectEditor'
import { EDITOR_MODES, modeInfo } from './modes'
import { droppedPaths, importSources, openPaths, openWithDialog } from './open'
import { DropOverlay } from './shell/DropOverlay'
import { EditorEmpty } from './shell/EditorEmpty'
import { EditorHeader } from './shell/EditorHeader'
import { ShortcutsDialog } from './shell/ShortcutsDialog'
import type { EditorMode } from './types'

function isTyping(target: EventTarget | null): boolean
{
  const element = target as HTMLElement | null
  return element !== null && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)
}

function dialogOpen(): boolean
{
  return document.querySelector('dialog[open]') !== null
}

function carriesFiles(event: DragEvent): boolean
{
  return Array.from(event.dataTransfer.types).includes('Files')
}

/** The editor view. */
export default function MediaEditor(): ReactElement
{
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const sourceId = useEditorStore((s) => s.clipMode.sourceId)
  const sources = useEditorStore((s) => s.sources)
  const loading = useEditorStore((s) => s.mediaLoading)
  const closeMediaFile = useEditorStore((s) => s.closeMediaFile)

  const source = sources.find((s) => s.id === sourceId)
  const ready: Record<EditorMode, boolean> = {
    clip: source !== undefined,
    inspect: source !== undefined,
    edit: sources.length > 0
  }

  const [mounted, setMounted] = useState<ReadonlySet<EditorMode>>(() => new Set([mode]))
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const tabsId = useId()
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() =>
  {
    setMounted((prev) => (prev.has(mode) ? prev : new Set([...prev, mode])))
  }, [mode])

  const openDialog = useCallback(() =>
  {
    void openWithDialog(modeRef.current)
  }, [])

  const openPath = useCallback((filePath: string, target: EditorMode = modeRef.current) =>
  {
    if (target !== modeRef.current)
    {
      setMode(target)
    }
    void openPaths([filePath], target)
  }, [setMode])

  useEffect(() =>
  {
    const onKeyDown = (event: KeyboardEvent): void =>
    {
      if (useAppStore.getState().currentView !== 'editor' || event.defaultPrevented)
      {
        return
      }
      if (event.key === '?' && shortcutsOpen)
      {
        event.preventDefault()
        setShortcutsOpen(false)
        return
      }
      if (isTyping(event.target) || dialogOpen())
      {
        return
      }
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o')
      {
        event.preventDefault()
        openDialog()
        return
      }
      const index = ['1', '2', '3'].indexOf(event.key)
      if (mod && !event.shiftKey && !event.altKey && index !== -1)
      {
        event.preventDefault()
        setMode(EDITOR_MODES[index].value)
        return
      }
      if ((event.key === '?' && !mod) || (event.key === 'F1' && !mod && !event.shiftKey))
      {
        event.preventDefault()
        setShortcutsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openDialog, setMode, shortcutsOpen])

  const onDragEnter = (event: DragEvent): void =>
  {
    if (carriesFiles(event))
    {
      event.preventDefault()
      setDragDepth((depth) => depth + 1)
    }
  }

  const onDragOver = (event: DragEvent): void =>
  {
    if (carriesFiles(event))
    {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  const onDragLeave = (event: DragEvent): void =>
  {
    if (carriesFiles(event))
    {
      setDragDepth((depth) => Math.max(0, depth - 1))
    }
  }

  const onDrop = (event: DragEvent): void =>
  {
    setDragDepth(0)
    if (!carriesFiles(event))
    {
      return
    }
    event.preventDefault()
    const paths = droppedPaths(event.dataTransfer)
    if (paths.length === 0)
    {
      return
    }
    if (mode === 'edit' && ready.edit)
    {
      void importSources(paths)
      return
    }
    void openPaths(mode === 'edit' ? paths : paths.slice(0, 1), mode)
  }

  const closeFile = (): void =>
  {
    closeMediaFile()
  }

  return (
    <LiveRegion>
      <div
        className="relative flex h-full min-h-0 flex-col bg-ground"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <EditorHeader
          mode={mode}
          onModeChange={setMode}
          tabsId={tabsId}
          source={source}
          loading={loading}
          onOpenDialog={openDialog}
          onOpenPath={(filePath) => openPath(filePath)}
          onCloseFile={closeFile}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <TabPanel tabsId={tabsId} value={mode} className="relative flex min-h-0 flex-1 flex-col">
          {mounted.has('clip') && (
            <div className="min-h-0 flex-1 flex-col" style={{ display: mode === 'clip' && ready.clip ? 'flex' : 'none' }}>
              <ClipEditor />
            </div>
          )}
          {mounted.has('edit') && (
            <div className="min-h-0 flex-1 flex-col" style={{ display: mode === 'edit' && ready.edit ? 'flex' : 'none' }}>
              <EditEditor />
            </div>
          )}
          {mounted.has('inspect') && (
            <div className="min-h-0 flex-1 flex-col" style={{ display: mode === 'inspect' && ready.inspect ? 'flex' : 'none' }}>
              <InspectEditor />
            </div>
          )}
          {!ready[mode] && (
            <EditorEmpty mode={mode} loading={loading} onOpenDialog={openDialog} onOpenPath={openPath} />
          )}
        </TabPanel>
        {dragDepth > 0 && <DropOverlay label={modeInfo(mode).dropLabel} />}
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </div>
    </LiveRegion>
  )
}
