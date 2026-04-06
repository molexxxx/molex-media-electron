/**
 * @module components/editor/MediaEditor
 * @description Non-linear media editor for trimming, merging, and inspecting files.
 *
 * Thin orchestrator that delegates playback to {@link useEditorPlayback},
 * inspect logic to {@link useEditorInspect}, timeline interaction to
 * {@link useTimelineDrag}, and renders focused sub-components.
 *
 * All clip and UI state lives in {@link useEditorStore} for clean
 * state management across clip switching and tab changes.
 */

import React, { useCallback, useEffect } from 'react'
import { ALL_EXTS, VIDEO_EXTS } from './types'
import { useEditorStore, type EditorClip } from '../../stores/editorStore'
import { useEditorPlayback } from './hooks/useEditorPlayback'
import { useEditorInspect } from './hooks/useEditorInspect'
import { useTimelineDrag } from './hooks/useTimelineDrag'
import { EditorHeader } from './components/EditorHeader'
import { PreviewArea } from './components/PreviewArea'
import { ClipList } from './components/ClipList'
import { Timeline } from './components/Timeline'
import { InspectTab } from './components/InspectTab'

export default function MediaEditor(): React.JSX.Element {
  const store = useEditorStore()
  const clip = store.activeClip()
  const duration = store.clipDuration()

  // -- Hooks --
  const { playing, currentTime, videoRef, audioRef, canvasRef, togglePlay, seek } = useEditorPlayback(clip)
  const inspect = useEditorInspect(clip, store.editorTab, store.activeIdx)
  const { timelineRef, handleTimelineMouseDown } = useTimelineDrag(clip, store.activeIdx, seek)

  // -- Editor export progress subscription --
  useEffect(() => {
    const unsub = window.api.onEditorProgress((progress) => {
      store.setExportProgress(progress.percent)
    })
    return unsub
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Initialise outputDir from first clip --
  useEffect(() => {
    if (clip && !store.outputDir) {
      const parts = clip.path.replace(/\\/g, '/').split('/')
      parts.pop()
      store.setOutputDir(parts.join('/'))
    }
  }, [clip?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  const browseOutputDir = useCallback(async () => {
    const dir = await window.api.selectOutputDir()
    if (dir) store.setOutputDir(dir)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -- File loading with per-clip loading states --
  const loadFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (!ALL_EXTS.includes(ext)) return

    const isVideo = VIDEO_EXTS.includes(ext)
    const objectUrl = URL.createObjectURL(file)
    const filePath = window.api.getFilePath(file)
    const clipId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Add placeholder clip in probing state
    const placeholder: EditorClip = {
      id: clipId, name: file.name, path: filePath, objectUrl,
      duration: 0, isVideo, inPoint: 0, outPoint: 0, loadingState: 'probing'
    }
    useEditorStore.getState().addClip(placeholder)

    const finalise = (dur: number, previewUrl?: string): void => {
      useEditorStore.getState().updateClip(clipId, {
        duration: dur, outPoint: dur, previewUrl, loadingState: 'ready'
      })
    }

    const probeFallback = (): void => {
      useEditorStore.getState().updateClipLoading(clipId, 'transcoding')
      window.api.probeFile(filePath).then(async (info: any) => {
        const dur = parseFloat(info?.format?.duration)
        if (!dur || !isFinite(dur)) {
          URL.revokeObjectURL(objectUrl)
          useEditorStore.getState().updateClipLoading(clipId, 'error')
          return
        }
        const preview = await window.api.createPreview(filePath).catch(() => null)
        finalise(dur, preview?.previewUrl)
      }).catch(() => {
        URL.revokeObjectURL(objectUrl)
        useEditorStore.getState().updateClipLoading(clipId, 'error')
      })
    }

    const tempEl = isVideo ? document.createElement('video') : new Audio()
    tempEl.preload = 'metadata'
    tempEl.src = objectUrl
    const cleanup = (): void => { tempEl.removeAttribute('src'); tempEl.load() }

    tempEl.addEventListener('loadedmetadata', () => {
      const dur = tempEl.duration
      if (!dur || !isFinite(dur)) { cleanup(); probeFallback(); return }
      finalise(dur)
      cleanup()
    })
    tempEl.addEventListener('error', () => { cleanup(); probeFallback() })
  }, [])

  const loadFilePath = useCallback((filePath: string) => {
    const name = filePath.split(/[\\/]/).pop() || filePath
    const ext = name.split('.').pop()?.toLowerCase() || ''
    if (!ALL_EXTS.includes(ext)) return
    const isVideo = VIDEO_EXTS.includes(ext)
    const clipId = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const placeholder: EditorClip = {
      id: clipId, name, path: filePath, objectUrl: `media://${encodeURIComponent(filePath)}`,
      duration: 0, isVideo, inPoint: 0, outPoint: 0, loadingState: 'probing'
    }
    useEditorStore.getState().addClip(placeholder)

    useEditorStore.getState().updateClipLoading(clipId, 'transcoding')
    window.api.probeFile(filePath).then(async (info: any) => {
      const dur = parseFloat(info?.format?.duration)
      if (!dur || !isFinite(dur)) {
        useEditorStore.getState().updateClipLoading(clipId, 'error')
        return
      }
      const preview = await window.api.createPreview(filePath).catch(() => null)
      useEditorStore.getState().updateClip(clipId, {
        duration: dur, outPoint: dur,
        previewUrl: preview?.previewUrl,
        objectUrl: preview?.previewUrl || `media://${encodeURIComponent(filePath)}`,
        loadingState: 'ready'
      })
    }).catch(() => {
      useEditorStore.getState().updateClipLoading(clipId, 'error')
    })
  }, [])

  // -- Clip manipulation --
  const setIn = useCallback(() => {
    store.setInPoint(currentTime)
  }, [currentTime]) // eslint-disable-line react-hooks/exhaustive-deps

  const setOut = useCallback(() => {
    store.setOutPoint(currentTime)
  }, [currentTime]) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Export --
  const handleCut = useCallback(async () => {
    if (!clip) return
    store.setProcessing(true)
    store.setMessage('')
    store.setExportProgress(0)
    const { cutMode, outputFormat, outputDir, gifOptions } = useEditorStore.getState()
    const opts = {
      mode: cutMode,
      outputFormat: outputFormat || undefined,
      outputDir: outputDir || undefined,
      gifOptions: outputFormat === 'gif' ? gifOptions : undefined
    }
    try {
      const result = await window.api.cutMedia(clip.path, clip.inPoint, clip.outPoint, opts)
      store.setMessage(result?.success
        ? `Saved: ${result.outputPath.split(/[\\/]/).pop()}`
        : `Error: ${result?.error || 'Cut failed'}`)
    } catch (err: any) {
      store.setMessage(`Error: ${err.message}`)
    } finally {
      store.setProcessing(false)
      store.setExportProgress(0)
    }
  }, [clip]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMerge = useCallback(async () => {
    if (!store.canMerge()) return
    store.setProcessing(true)
    store.setMessage('')
    store.setExportProgress(0)
    const { clips, cutMode, outputFormat, outputDir, gifOptions } = useEditorStore.getState()
    const opts = {
      mode: cutMode,
      outputFormat: outputFormat || undefined,
      outputDir: outputDir || undefined,
      gifOptions: outputFormat === 'gif' ? gifOptions : undefined
    }
    try {
      const segments = clips.map((c) => ({ path: c.path, inPoint: c.inPoint, outPoint: c.outPoint }))
      const result = await window.api.mergeMedia(segments, opts)
      store.setMessage(result?.success
        ? `Merged: ${result.outputPath.split(/[\\/]/).pop()}`
        : `Error: ${result?.error || 'Merge failed'}`)
    } catch (err: any) {
      store.setMessage(`Error: ${err.message}`)
    } finally {
      store.setProcessing(false)
      store.setExportProgress(0)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRemux = useCallback(async () => {
    store.setProcessing(true)
    await inspect.handleRemux()
    store.setProcessing(false)
  }, [inspect.handleRemux]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full animate-fade-in gap-3 sm:gap-4">
      <EditorHeader
        onLoadFile={loadFile}
        onLoadFilePath={loadFilePath}
      />

      <div className={store.editorTab === 'trim' ? 'flex-1 flex flex-col gap-3 sm:gap-4 min-h-0' : 'hidden'}>
        {/* Desktop: side-by-side. Tablet/mobile: stacked */}
        <div className="flex-1 flex flex-col lg:flex-row gap-3 sm:gap-4 min-h-0">
          <PreviewArea
            clip={clip}
            videoRef={videoRef}
            audioRef={audioRef}
            canvasRef={canvasRef}
            onLoadFile={loadFile}
          />
          {store.clips.length > 0 && (
            <ClipList onMerge={handleMerge} />
          )}
        </div>
        {clip && clip.loadingState === 'ready' && (
          <Timeline
            currentTime={currentTime}
            playing={playing}
            timelineRef={timelineRef}
            onTimelineMouseDown={handleTimelineMouseDown}
            onTogglePlay={togglePlay}
            onSetIn={setIn}
            onSetOut={setOut}
            onCut={handleCut}
            onBrowseOutputDir={browseOutputDir}
          />
        )}
      </div>

      <div className={store.editorTab === 'inspect' ? 'flex-1 min-h-0 overflow-auto space-y-4' : 'hidden'}>
        <InspectTab
          hasClip={!!clip}
          probing={inspect.probing}
          probeData={inspect.probeData}
          processing={store.processing}
          inspectMsg={inspect.inspectMsg}
          streamEnabled={inspect.streamEnabled}
          editMeta={inspect.editMeta}
          editDispositions={inspect.editDispositions}
          onSetStreamEnabled={inspect.setStreamEnabled}
          onSetEditMeta={inspect.setEditMeta}
          onToggleDisposition={inspect.toggleStreamDisposition}
          onRemux={handleRemux}
        />
      </div>
    </div>
  )
}
