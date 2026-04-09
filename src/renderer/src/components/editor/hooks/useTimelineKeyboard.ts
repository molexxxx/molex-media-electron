/**
 * @module editor/hooks/useTimelineKeyboard
 * Edit mode keyboard shortcuts - transport, editing, tool selection, edit types, JKL.
 */
import { useEffect, useCallback, useRef } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineCoords } from './useTimelineZoom'

interface UseTimelineKeyboardOptions {
  coords: TimelineCoords
}

export function useTimelineKeyboard({ coords }: UseTimelineKeyboardOptions): void {
  // Track JKL speed state: positive = forward speeds, negative = reverse
  const jklSpeed = useRef(0)

  const handler = useCallback(
    (e: KeyboardEvent) => {
      // Don't capture when in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const state = useEditorStore.getState()
      const { mode, playback, timeline, selectedClipIds } = state

      // Only handle when in edit mode
      if (mode !== 'edit') return

      const ctrl = e.ctrlKey || e.metaKey

      switch (e.key) {
        // --- Transport ---
        case ' ':
          e.preventDefault()
          jklSpeed.current = 0
          state.togglePlayback()
          break

        case 'ArrowLeft':
          e.preventDefault()
          state.seek(Math.max(0, playback.currentFrame - (e.shiftKey ? 10 : 1)))
          break

        case 'ArrowRight':
          e.preventDefault()
          state.seek(playback.currentFrame + (e.shiftKey ? 10 : 1))
          break

        case 'Home':
          e.preventDefault()
          state.seek(0)
          break

        case 'End':
          e.preventDefault()
          state.seek(timeline.duration)
          break

        case 'ArrowUp':
          e.preventDefault()
          goToEditPoint(state, -1)
          break

        case 'ArrowDown':
          e.preventDefault()
          goToEditPoint(state, 1)
          break

        // --- JKL Transport ---
        case 'j':
        case 'J':
          if (!ctrl) {
            e.preventDefault()
            if (jklSpeed.current >= 0) {
              jklSpeed.current = -1
            } else {
              jklSpeed.current = Math.max(-8, jklSpeed.current * 2)
            }
            state.setPlaybackRate(jklSpeed.current)
            state.play()
          }
          break

        case 'k':
        case 'K':
          if (!ctrl) {
            e.preventDefault()
            jklSpeed.current = 0
            state.pause()
          }
          break

        case 'l':
        case 'L':
          if (!ctrl) {
            e.preventDefault()
            if (jklSpeed.current <= 0) {
              jklSpeed.current = 1
            } else {
              jklSpeed.current = Math.min(8, jklSpeed.current * 2)
            }
            state.setPlaybackRate(jklSpeed.current)
            state.play()
          }
          break

        // --- In/Out Points ---
        case 'i':
        case 'I':
          if (!ctrl) {
            e.preventDefault()
            state.setInPoint(playback.currentFrame)
          }
          break

        case 'o':
        case 'O':
          if (!ctrl) {
            e.preventDefault()
            state.setOutPoint(playback.currentFrame)
          }
          break

        // --- Edit Operations ---
        case ',':
          e.preventDefault()
          performEdit(state, 'insert')
          break

        case '.':
          e.preventDefault()
          performEdit(state, 'overwrite')
          break

        // --- Editing ---
        case 's':
        case 'S':
          if (!ctrl) {
            e.preventDefault()
            splitSelectedOrAtPlayhead(state)
          }
          break

        case 'b':
        case 'B':
          if (!ctrl) {
            e.preventDefault()
            state.setActiveTool('razor')
          }
          break

        case 'Delete':
        case 'Backspace':
          if (selectedClipIds.length > 0) {
            e.preventDefault()
            if (e.shiftKey) {
              rippleDelete(state)
            } else {
              state.removeClips(selectedClipIds)
            }
          }
          break

        // Select all
        case 'a':
        case 'A':
          if (ctrl) {
            e.preventDefault()
            useEditorStore.setState({ selectedClipIds: timeline.clips.map((c) => c.id) })
          }
          break

        // Deselect
        case 'd':
        case 'D':
          if (ctrl) {
            e.preventDefault()
            state.clearSelection()
          }
          break

        // Copy / Cut / Paste
        case 'c':
        case 'C':
          if (ctrl && selectedClipIds.length > 0) {
            e.preventDefault()
            state.copyClips()
          }
          break

        case 'x':
        case 'X':
          if (ctrl && selectedClipIds.length > 0) {
            e.preventDefault()
            state.cutClips()
          }
          break

        case 'v':
        case 'V':
          if (ctrl) {
            e.preventDefault()
            const trackId = state.selectedTrackId || timeline.tracks.find((t) => t.type === 'video')?.id
            if (trackId) state.pasteClips(playback.currentFrame, trackId)
          } else {
            e.preventDefault()
            state.setActiveTool('select')
          }
          break

        // Undo / Redo
        case 'z':
        case 'Z':
          if (ctrl) {
            e.preventDefault()
            if (e.shiftKey) {
              state.redo()
            } else {
              state.undo()
            }
          }
          break

        // --- Tools ---
        case 't':
        case 'T':
          if (!ctrl) { e.preventDefault(); state.setActiveTool('trim') }
          break
        case 'n':
        case 'N':
          if (!ctrl) { e.preventDefault(); state.setSnapEnabled(!state.snapEnabled) }
          break

        // Zoom
        case '=':
          if (ctrl) { e.preventDefault(); coords.zoomIn() }
          break
        case '-':
          if (ctrl) { e.preventDefault(); coords.zoomOut() }
          break
        case '0':
          if (ctrl) { e.preventDefault(); coords.fitToView(timeline.duration, 800) }
          break

        default:
          break
      }
    },
    [coords]
  )

  useEffect(() => {
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handler])
}

// --- Helpers ---

function performEdit(state: ReturnType<typeof useEditorStore.getState>, type: 'insert' | 'overwrite'): void {
  const sourceId = state.selectedSourceId || state.clipMode.sourceId
  if (!sourceId) return
  const source = state.sources.find((s) => s.id === sourceId)
  if (!source) return

  const inOut: [number, number] =
    state.clipMode.sourceId === sourceId
      ? [state.clipMode.inPoint, state.clipMode.outPoint]
      : [0, source.duration]

  const trackId = state.selectedTrackId || state.timeline.tracks.find((t) => t.type === 'video')?.id
  if (!trackId) return

  if (type === 'insert') {
    state.insertClip(sourceId, inOut, state.playback.currentFrame, trackId)
  } else {
    state.overwriteClip(sourceId, inOut, state.playback.currentFrame, trackId)
  }
}

function splitSelectedOrAtPlayhead(state: ReturnType<typeof useEditorStore.getState>): void {
  const { selectedClipIds, playback, timeline } = state
  const frame = playback.currentFrame

  if (selectedClipIds.length > 0) {
    for (const id of selectedClipIds) {
      state.splitClip(id, frame)
    }
  } else {
    for (const clip of timeline.clips) {
      const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
      if (frame > clip.timelineStart && frame < clip.timelineStart + dur) {
        state.splitClip(clip.id, frame)
      }
    }
  }
}

function rippleDelete(state: ReturnType<typeof useEditorStore.getState>): void {
  const { selectedClipIds, timeline } = state
  if (selectedClipIds.length === 0) return

  const lockedTrackIds = new Set(timeline.tracks.filter((t) => t.locked).map((t) => t.id))
  const deletable = selectedClipIds.filter((id) => {
    const c = timeline.clips.find((cl) => cl.id === id)
    return c && !c.locked && !lockedTrackIds.has(c.trackId)
  })
  if (deletable.length === 0) return

  const idSet = new Set(deletable)
  const toDelete = timeline.clips.filter((c) => idSet.has(c.id))

  const remaining = timeline.clips.filter((c) => !idSet.has(c.id))
  for (const clip of toDelete) {
    const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
    for (const r of remaining) {
      if (r.trackId === clip.trackId && r.timelineStart >= clip.timelineStart + dur) {
        r.timelineStart = Math.max(0, r.timelineStart - dur)
      }
    }
  }

  const newDuration = remaining.length === 0
    ? 0
    : Math.max(...remaining.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn) / c.speed))

  useEditorStore.setState((s) => {
    const newTimeline = { ...s.timeline, clips: remaining, duration: newDuration }
    return {
      timeline: newTimeline,
      selectedClipIds: [],
      history: {
        ...s.history,
        entries: [
          ...s.history.entries.slice(0, s.history.currentIndex + 1),
          { timestamp: Date.now(), label: 'Ripple delete', snapshot: structuredClone(newTimeline) }
        ],
        currentIndex: s.history.currentIndex + 1
      }
    }
  })
}

function goToEditPoint(state: ReturnType<typeof useEditorStore.getState>, direction: 1 | -1): void {
  const { playback, timeline } = state
  const current = playback.currentFrame

  const points = new Set<number>()
  points.add(0)
  for (const clip of timeline.clips) {
    const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
    points.add(clip.timelineStart)
    points.add(clip.timelineStart + dur)
  }

  const sorted = [...points].sort((a, b) => a - b)

  if (direction === -1) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i] < current - 0.5) {
        state.seek(sorted[i])
        return
      }
    }
  } else {
    for (const pt of sorted) {
      if (pt > current + 0.5) {
        state.seek(pt)
        return
      }
    }
  }
}
