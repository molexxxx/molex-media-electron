/**
 * @module components/editor/MediaEditor
 * @description Non-linear media editor for trimming, merging, and inspecting files.
 *
 * Thin orchestrator that delegates playback to {@link useEditorPlayback},
 * inspect logic to {@link useEditorInspect}, and renders focused sub-components.
 *
 * All clip and UI state lives in {@link useEditorStore} for clean
 * state management across clip switching and tab changes.
 */

import React, { useCallback, useEffect } from 'react'
import { ALL_EXTS, VIDEO_EXTS } from './types'

/** Formats that Chromium can play natively — no transcode needed. */
const BROWSER_NATIVE = new Set(['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'])
import { useEditorStore, type EditorClip } from '../../stores/editorStore'
import { useEditorPlayback } from './hooks/useEditorPlayback'
import { useEditorInspect } from './hooks/useEditorInspect'
import { EditorHeader } from './components/EditorHeader'
import { PreviewArea } from './components/PreviewArea'
import { TrackTimeline } from './components/TrackTimeline'
import { InspectTab } from './components/InspectTab'

export default function MediaEditor(): React.JSX.Element {
  const store = useEditorStore()
  const clip = store.activeClip()

  // -- Hooks --
  const { playing, currentTime, videoRef, audioRef, a2AudioRef, canvasRef, togglePlay, seek } = useEditorPlayback(clip)
  const inspect = useEditorInspect(clip, store.editorTab, store.activeIdx)

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
      duration: 0, isVideo, inPoint: 0, outPoint: 0, sourceStart: 0, loadingState: 'probing',
      clipVolume: 1, clipMuted: false
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
        // Browser-native formats — the blob URL should work, just need duration
        if (BROWSER_NATIVE.has(ext)) {
          finalise(dur)
          return
        }
        // Non-native format — need transcode for browser playback
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
      id: clipId, name, path: filePath, objectUrl: '',
      duration: 0, isVideo, inPoint: 0, outPoint: 0, sourceStart: 0, loadingState: 'probing',
      clipVolume: 1, clipMuted: false
    }
    useEditorStore.getState().addClip(placeholder)

    // Register file with media:// protocol for a valid token-based URL
    window.api.registerLocalFile(filePath).then(async (mediaUrl: string) => {
      // Update objectUrl to the valid media:// token URL
      useEditorStore.getState().updateClip(clipId, { objectUrl: mediaUrl })

      // Probe to get duration
      const info = await window.api.probeFile(filePath).catch(() => null)
      const dur = parseFloat(info?.format?.duration)
      if (!dur || !isFinite(dur)) {
        useEditorStore.getState().updateClipLoading(clipId, 'error')
        return
      }

      // For browser-native formats, skip transcoding — Chromium plays them directly
      if (BROWSER_NATIVE.has(ext)) {
        useEditorStore.getState().updateClip(clipId, {
          duration: dur, outPoint: dur, loadingState: 'ready'
        })
        return
      }

      // Non-native formats (mkv, avi, etc.) — need transcode for browser playback
      useEditorStore.getState().updateClipLoading(clipId, 'transcoding')
      const preview = await window.api.createPreview(filePath).catch(() => null)
      if (preview?.previewUrl) {
        useEditorStore.getState().updateClip(clipId, {
          duration: dur, outPoint: dur,
          previewUrl: preview.previewUrl,
          objectUrl: preview.previewUrl,
          loadingState: 'ready'
        })
      } else {
        // Transcode failed — try playing natively anyway (may work for some formats)
        useEditorStore.getState().updateClip(clipId, {
          duration: dur, outPoint: dur, loadingState: 'ready'
        })
      }
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

  const handleSplit = useCallback(() => {
    if (!clip) return
    store.splitClip(clip.id, currentTime)
  }, [clip?.id, currentTime]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleClipSelection = useCallback(() => {
    store.clipToSelection()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeleteSelection = useCallback(() => {
    store.deleteSelection()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Export --
  const handleRemux = useCallback(async () => {
    store.setProcessing(true)
    await inspect.handleRemux()
    store.setProcessing(false)
  }, [inspect.handleRemux]) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Replace audio for a clip --
  const handleReplaceAudio = useCallback((clipId: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.wma'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const filePath = window.api.getFilePath(file)
      const objectUrl = URL.createObjectURL(file)
      const info = await window.api.probeFile(filePath).catch(() => null)
      const dur = parseFloat(info?.format?.duration)
      useEditorStore.getState().setAudioReplacement(clipId, {
        path: filePath,
        name: file.name,
        duration: isFinite(dur) ? dur : 0,
        offset: 0,
        volume: 1,
        muted: false,
        objectUrl,
        trimIn: 0,
        trimOut: isFinite(dur) ? dur : 0
      })
    }
    input.click()
  }, [])

  // -- Replace A1 source audio (opens file picker → sets A2 + mutes A1) --
  const handleReplaceA1Audio = useCallback((clipId: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.wma'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const filePath = window.api.getFilePath(file)
      const objectUrl = URL.createObjectURL(file)
      const info = await window.api.probeFile(filePath).catch(() => null)
      const dur = parseFloat(info?.format?.duration)
      const s = useEditorStore.getState()
      s.setAudioReplacement(clipId, {
        path: filePath,
        name: file.name,
        duration: isFinite(dur) ? dur : 0,
        offset: 0,
        volume: 1,
        muted: false,
        objectUrl,
        trimIn: 0,
        trimOut: isFinite(dur) ? dur : 0
      })
      // Auto-mute source audio so replacement takes over
      const clip = s.clips.find((c) => c.id === clipId)
      if (clip && !clip.clipMuted) s.toggleClipMute(clipId)
    }
    input.click()
  }, [])

  // -- Unified export: sends the full timeline state through one pipeline --
  const handleExport = useCallback(async () => {
    const { clips, cutMode, outputFormat, outputDir, gifOptions } = useEditorStore.getState()
    if (clips.length === 0) return

    store.setProcessing(true)
    store.setMessage('')
    store.setExportProgress(0)

    const opts = {
      mode: cutMode,
      outputFormat: outputFormat || undefined,
      outputDir: outputDir || undefined,
      gifOptions: outputFormat === 'gif' ? gifOptions : undefined
    }

    try {
      const segments = clips.map((c) => ({
        path: c.path,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        ...(c.audioReplacement ? {
          audioReplacement: {
            path: c.audioReplacement.path,
            offset: c.audioReplacement.offset || 0,
            trimIn: c.audioReplacement.trimIn || 0,
            trimOut: c.audioReplacement.trimOut || c.audioReplacement.duration
          }
        } : {})
      }))

      const result = await window.api.mergeMedia(segments, opts)
      store.setMessage(result?.success
        ? `Saved: ${result.outputPath.split(/[\\/]/).pop()}`
        : `Error: ${result?.error || 'Export failed'}`)
    } catch (err: any) {
      store.setMessage(`Error: ${err.message}`)
    } finally {
      store.setProcessing(false)
      store.setExportProgress(0)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // -- Import file via native dialog --
  const handleImportFile = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ALL_EXTS.map((e) => `.${e}`).join(',')
    input.multiple = true
    input.onchange = () => {
      if (!input.files) return
      for (const file of Array.from(input.files)) loadFile(file)
    }
    input.click()
  }, [loadFile])

  return (
    <div className="flex flex-col min-h-full animate-fade-in gap-4">
      <EditorHeader
        onLoadFile={loadFile}
        onLoadFilePath={loadFilePath}
      />

      <div className={store.editorTab === 'trim' ? `${store.clips.length > 0 ? 'flex-1' : ''} flex flex-col gap-4 min-h-0 pr-1` : 'hidden'}>
        <PreviewArea
          clip={clip}
          videoRef={videoRef}
          audioRef={audioRef}
          a2AudioRef={a2AudioRef}
          canvasRef={canvasRef}
          onLoadFile={loadFile}
        />

        {/* Unified NLE timeline — tracks + transport + export */}
        {store.clips.length > 0 && (
          <TrackTimeline
            currentTime={currentTime}
            playing={playing}
            onSeek={seek}
            onTogglePlay={togglePlay}
            onSetIn={setIn}
            onSetOut={setOut}
            onSplit={handleSplit}
            onClipSelection={handleClipSelection}
            onDeleteSelection={handleDeleteSelection}
            onCut={handleExport}
            onMerge={handleExport}
            onReplaceAudio={handleReplaceAudio}
            onReplaceA1={handleReplaceA1Audio}
            onBrowseOutputDir={browseOutputDir}
            onImportFile={handleImportFile}
          />
        )}
      </div>

      <div
        className={store.editorTab === 'inspect' ? 'flex-1 min-h-0 overflow-auto space-y-4 pr-1' : 'hidden'}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          for (const file of Array.from(e.dataTransfer.files)) loadFile(file)
        }}
      >
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
