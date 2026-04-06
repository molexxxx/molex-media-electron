/**
 * @module components/editor/hooks/useEditorInspect
 * @description Hook managing FFprobe inspection, stream toggles, metadata editing, and remux.
 */

import { useState, useEffect, useCallback } from 'react'
import type { EditorClip } from '../../../stores/editorStore'

/**
 * Manages FFprobe inspection state: probe data, stream toggles,
 * metadata editing, disposition flags, and lossless remux.
 */
export function useEditorInspect(clip: EditorClip | null, editorTab: string, activeIdx: number) {
  const [probeData, setProbeData] = useState<any>(null)
  const [probing, setProbing] = useState(false)
  const [streamEnabled, setStreamEnabled] = useState<Record<number, boolean>>({})
  const [editMeta, setEditMeta] = useState<Record<string, string>>({})
  const [editDispositions, setEditDispositions] = useState<Record<number, Record<string, number>>>({})
  const [inspectMsg, setInspectMsg] = useState('')

  const probeCurrentClip = useCallback(async () => {
    if (!clip) return
    setProbing(true)
    setInspectMsg('')
    try {
      const info = await window.api.probeDetailed(clip.path)
      setProbeData(info)
      const enabled: Record<number, boolean> = {}
      const allStreams = [...(info.videoStreams || []), ...(info.audioStreams || []), ...(info.subtitleStreams || [])]
      for (const s of allStreams) enabled[s.index] = true
      setStreamEnabled(enabled)
      setEditMeta(info.format?.tags ? { ...info.format.tags } : {})
      const disps: Record<number, Record<string, number>> = {}
      for (const s of allStreams) {
        if (s.disposition) disps[s.index] = { ...s.disposition }
      }
      setEditDispositions(disps)
    } catch (err: any) {
      setInspectMsg(`Probe failed: ${err.message}`)
    } finally {
      setProbing(false)
    }
  }, [clip])

  useEffect(() => {
    if (editorTab === 'inspect' && clip) {
      probeCurrentClip()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTab, activeIdx, clip?.path])

  const handleRemux = useCallback(async () => {
    if (!clip || !probeData) return
    setInspectMsg('')
    try {
      const keepStreams = Object.entries(streamEnabled)
        .filter(([, v]) => v)
        .map(([k]) => parseInt(k, 10))
      if (keepStreams.length === 0) {
        setInspectMsg('Error: Must keep at least one stream')
        return
      }
      const result = await window.api.remuxMedia(clip.path, {
        keepStreams,
        metadata: editMeta,
        dispositions: editDispositions
      })
      if (result?.success) {
        setInspectMsg(`Saved: ${result.outputPath?.split(/[\\/]/).pop()}`)
      } else {
        setInspectMsg(`Error: ${result?.error || 'Remux failed'}`)
      }
    } catch (err: any) {
      setInspectMsg(`Error: ${err.message}`)
    }
  }, [clip, probeData, streamEnabled, editMeta, editDispositions])

  const toggleStreamDisposition = useCallback((streamIdx: number, flag: string) => {
    setEditDispositions((prev) => {
      const curr = prev[streamIdx] || {}
      return { ...prev, [streamIdx]: { ...curr, [flag]: curr[flag] ? 0 : 1 } }
    })
  }, [])

  return {
    probeData, probing, streamEnabled, editMeta, editDispositions, inspectMsg,
    setStreamEnabled, setEditMeta, toggleStreamDisposition, handleRemux
  }
}
