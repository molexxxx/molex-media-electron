/**
 * @module components/editor/MediaEditor
 * @description Non-linear media editor for trimming, merging, and inspecting files.
 *
 * Thin orchestrator that delegates playback to {@link useEditorPlayback},
 * inspect logic to {@link useEditorInspect}, timeline interaction to
 * {@link useTimelineDrag}, and renders focused sub-components.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { type Clip, type CutMode, type GifOptions, ALL_EXTS, VIDEO_EXTS } from './types'
import { useEditorPlayback } from './hooks/useEditorPlayback'
import { useEditorInspect } from './hooks/useEditorInspect'
import { useTimelineDrag } from './hooks/useTimelineDrag'
import { EditorHeader } from './components/EditorHeader'
import { PreviewArea } from './components/PreviewArea'
import { ClipSidebar } from './components/ClipSidebar'
import { Timeline } from './components/Timeline'
import { InspectTab } from './components/InspectTab'

export default function MediaEditor(): React.JSX.Element {
  const [clips, setClips] = useState<Clip[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [message, setMessage] = useState('')
  const [editorTab, setEditorTab] = useState<'trim' | 'inspect'>('trim')
  const [cutMode, setCutMode] = useState<CutMode>('precise')
  const [outputFormat, setOutputFormat] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [outputDir, setOutputDir] = useState('')
  const [loadingFiles, setLoadingFiles] = useState(0)
  const [gifOptions, setGifOptions] = useState<GifOptions>({ loop: true, fps: 15, width: 480 })

  const clip = clips[activeIdx] || null
  const clipDuration = clip ? clip.outPoint - clip.inPoint : 0

  // -- Hooks --
  const { playing, currentTime, videoRef, audioRef, canvasRef, togglePlay, seek } = useEditorPlayback(clip)
  const inspect = useEditorInspect(clip, editorTab, activeIdx)
  const { timelineRef, handleTimelineMouseDown } = useTimelineDrag(clip, activeIdx, seek, setClips)

  // -- Editor export progress subscription --
  useEffect(() => {
    const unsub = window.api.onEditorProgress((progress) => {
      setExportProgress(progress.percent)
    })
    return unsub
  }, [])

  // -- Initialise outputDir from first clip --
  useEffect(() => {
    if (clip && !outputDir) {
      const parts = clip.path.replace(/\\/g, '/').split('/')
      parts.pop()
      setOutputDir(parts.join('/'))
    }
  }, [clip]) // eslint-disable-line react-hooks/exhaustive-deps

  const browseOutputDir = useCallback(async () => {
    const dir = await window.api.selectOutputDir()
    if (dir) setOutputDir(dir)
  }, [])

  // -- File loading --
  const loadFile = useCallback((file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (!ALL_EXTS.includes(ext)) return

    const isVideo = VIDEO_EXTS.includes(ext)
    const objectUrl = URL.createObjectURL(file)
    const filePath = window.api.getFilePath(file)

    setLoadingFiles((n) => n + 1)
    const done = (): void => { setLoadingFiles((n) => Math.max(0, n - 1)) }

    const addClip = (dur: number, previewUrl?: string): void => {
      const newClip: Clip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name, path: filePath, objectUrl, previewUrl, duration: dur, isVideo,
        inPoint: 0, outPoint: dur
      }
      setClips((prev) => { setActiveIdx(prev.length); return [...prev, newClip] })
      done()
    }

    const probeFallback = (): void => {
      window.api.probeFile(filePath).then(async (info: any) => {
        const dur = parseFloat(info?.format?.duration)
        if (!dur || !isFinite(dur)) { URL.revokeObjectURL(objectUrl); done(); return }
        // Create a browser-playable preview via FFmpeg transcode
        const preview = await window.api.createPreview(filePath).catch(() => null)
        addClip(dur, preview?.previewUrl)
      }).catch(() => { URL.revokeObjectURL(objectUrl); done() })
    }

    const tempEl = isVideo ? document.createElement('video') : new Audio()
    tempEl.preload = 'metadata'
    tempEl.src = objectUrl
    const cleanup = (): void => { tempEl.removeAttribute('src'); tempEl.load() }

    tempEl.addEventListener('loadedmetadata', () => {
      const dur = tempEl.duration
      if (!dur || !isFinite(dur)) { cleanup(); probeFallback(); return }
      addClip(dur)
      cleanup()
    })
    tempEl.addEventListener('error', () => { cleanup(); probeFallback() })
  }, [])

  const handleFileSelect = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = ALL_EXTS.map((e) => `.${e}`).join(',')
    input.onchange = () => { for (const f of Array.from(input.files || [])) loadFile(f) }
    input.click()
  }, [loadFile])

  // -- Clip manipulation --
  const setIn = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, inPoint: currentTime } : c))
  }, [activeIdx, currentTime, clip])

  const setOut = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, outPoint: currentTime } : c))
  }, [activeIdx, currentTime, clip])

  const resetPoints = useCallback(() => {
    if (!clip) return
    setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, inPoint: 0, outPoint: c.duration } : c))
  }, [activeIdx, clip])

  const removeClip = useCallback((idx: number) => {
    setClips((prev) => {
      const next = prev.filter((_, i) => i !== idx)
      URL.revokeObjectURL(prev[idx].objectUrl)
      setActiveIdx((ai) => Math.min(ai, Math.max(0, next.length - 1)))
      return next
    })
  }, [])

  // -- Export --
  const handleCut = useCallback(async () => {
    if (!clip) return
    setProcessing(true)
    setMessage('')
    setExportProgress(0)
    const opts = {
      mode: cutMode,
      outputFormat: outputFormat || undefined,
      outputDir: outputDir || undefined,
      gifOptions: outputFormat === 'gif' ? gifOptions : undefined
    }
    try {
      const result = await window.api.cutMedia(clip.path, clip.inPoint, clip.outPoint, opts)
      setMessage(result?.success
        ? `Saved: ${result.outputPath.split(/[\\/]/).pop()}`
        : `Error: ${result?.error || 'Cut failed'}`)
    } catch (err: any) {
      setMessage(`Error: ${err.message}`)
    } finally {
      setProcessing(false)
      setExportProgress(0)
    }
  }, [clip, cutMode, outputFormat])

  const handleMerge = useCallback(async () => {
    if (clips.length < 2) return
    setProcessing(true)
    setMessage('')
    setExportProgress(0)
    const opts = {
      mode: cutMode,
      outputFormat: outputFormat || undefined,
      outputDir: outputDir || undefined,
      gifOptions: outputFormat === 'gif' ? gifOptions : undefined
    }
    try {
      const segments = clips.map((c) => ({ path: c.path, inPoint: c.inPoint, outPoint: c.outPoint }))
      const result = await window.api.mergeMedia(segments, opts)
      setMessage(result?.success
        ? `Merged: ${result.outputPath.split(/[\\/]/).pop()}`
        : `Error: ${result?.error || 'Merge failed'}`)
    } catch (err: any) {
      setMessage(`Error: ${err.message}`)
    } finally {
      setProcessing(false)
      setExportProgress(0)
    }
  }, [clips, cutMode, outputFormat])

  const handleRemux = useCallback(async () => {
    setProcessing(true)
    await inspect.handleRemux()
    setProcessing(false)
  }, [inspect.handleRemux])

  return (
    <div className="flex flex-col h-full animate-fade-in gap-4">
      <EditorHeader
        clip={clip}
        clipDuration={clipDuration}
        editorTab={editorTab}
        onSetEditorTab={setEditorTab}
        onFileSelect={handleFileSelect}
      />

      <div className={editorTab === 'trim' ? 'flex-1 flex flex-col gap-4 min-h-0' : 'hidden'}>
        <div className="flex-1 flex gap-4 min-h-0">
          <PreviewArea
            clip={clip}
            videoRef={videoRef}
            audioRef={audioRef}
            canvasRef={canvasRef}
            loading={loadingFiles > 0}
            onLoadFile={loadFile}
          />
          {clips.length > 0 && (
            <ClipSidebar
              clips={clips}
              activeIdx={activeIdx}
              processing={processing}
              onSetActiveIdx={setActiveIdx}
              onRemoveClip={removeClip}
              onMerge={handleMerge}
            />
          )}
        </div>
        {clip && (
          <Timeline
            clip={clip}
            currentTime={currentTime}
            playing={playing}
            processing={processing}
            clipDuration={clipDuration}
            message={message}
            cutMode={cutMode}
            outputFormat={outputFormat}
            exportProgress={exportProgress}
            timelineRef={timelineRef}
            onTimelineMouseDown={handleTimelineMouseDown}
            onTogglePlay={togglePlay}
            onSetIn={setIn}
            onSetOut={setOut}
            onResetPoints={resetPoints}
            onCut={handleCut}
            onSetCutMode={setCutMode}
            onSetOutputFormat={setOutputFormat}
            gifOptions={gifOptions}
            onSetGifOptions={setGifOptions}
            outputDir={outputDir}
            onOutputDirChange={setOutputDir}
            onBrowseOutputDir={browseOutputDir}
          />
        )}
      </div>

      <div className={editorTab === 'inspect' ? 'flex-1 min-h-0 overflow-auto space-y-4' : 'hidden'}>
        <InspectTab
          hasClip={!!clip}
          probing={inspect.probing}
          probeData={inspect.probeData}
          processing={processing}
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
