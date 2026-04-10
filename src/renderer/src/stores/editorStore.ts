/**
 * @module stores/editorStore
 * @description Zustand store for the NLE media editor.
 *
 * Manages: mode switching, project & sources, timeline (tracks + clips),
 * clip-mode in/out, playback, undo/redo history, selection, and UI state.
 */

import { create } from 'zustand'
import type {
  EditorMode,
  EditorProject,
  MediaSource,
  Timeline,
  TimelineTrack,
  TimelineClip,
  ClipModeState,
  PlaybackState,
  HistoryState,
  HistoryEntry,
  EditTool,
  ClipTransform,
  TransformKeyframe,
  EasingFunction,
  BlendMode
} from '../components/editor/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0
function uid(): string {
  return `${Date.now().toString(36)}-${(++_idCounter).toString(36)}`
}

function clipDuration(clip: TimelineClip): number {
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

function timelineDuration(clips: TimelineClip[]): number {
  if (clips.length === 0) return 0
  return Math.max(...clips.map((c) => c.timelineStart + clipDuration(c)))
}

function pushSnapshot(
  history: HistoryState,
  label: string,
  timeline: Timeline
): HistoryState {
  // Discard any redo entries beyond currentIndex
  const entries = history.entries.slice(0, history.currentIndex + 1)
  const entry: HistoryEntry = { timestamp: Date.now(), label, snapshot: structuredClone(timeline) }
  entries.push(entry)
  // Enforce max
  if (entries.length > history.maxEntries) entries.shift()
  return { ...history, entries, currentIndex: entries.length - 1 }
}

function makeClip(
  sourceId: string,
  inOut: [number, number],
  position: number,
  trackId: string,
  sources: MediaSource[]
): TimelineClip {
  const source = sources.find((s) => s.id === sourceId)
  return {
    id: uid(),
    sourceId,
    trackId,
    timelineStart: position,
    sourceIn: inOut[0],
    sourceOut: inOut[1],
    name: source?.fileName || 'Clip',
    color: '',
    muted: false,
    locked: false,
    volume: 1,
    pan: 0,
    speed: 1
  }
}

/** Clear a time region on a track - splits/trims/removes overlapping clips. */
function clearRegion(clips: TimelineClip[], trackId: string, start: number, end: number): TimelineClip[] {
  const result: TimelineClip[] = []
  for (const clip of clips) {
    if (clip.trackId !== trackId) {
      result.push(clip)
      continue
    }
    const clipEnd = clip.timelineStart + clipDuration(clip)

    // No overlap
    if (clipEnd <= start || clip.timelineStart >= end) {
      result.push(clip)
      continue
    }
    // Completely covered - remove
    if (clip.timelineStart >= start && clipEnd <= end) {
      continue
    }
    // Region covers start of existing clip
    if (start <= clip.timelineStart && end < clipEnd) {
      const trimFrames = (end - clip.timelineStart) * clip.speed
      result.push({ ...clip, sourceIn: clip.sourceIn + trimFrames, timelineStart: end })
      continue
    }
    // Region covers end of existing clip
    if (start > clip.timelineStart && end >= clipEnd) {
      const keepFrames = (start - clip.timelineStart) * clip.speed
      result.push({ ...clip, sourceOut: clip.sourceIn + keepFrames })
      continue
    }
    // Region splits existing clip in two
    if (start > clip.timelineStart && end < clipEnd) {
      const leftKeep = (start - clip.timelineStart) * clip.speed
      const rightStart = (end - clip.timelineStart) * clip.speed
      result.push({ ...clip, sourceOut: clip.sourceIn + leftKeep })
      result.push({ ...clip, id: uid(), sourceIn: clip.sourceIn + rightStart, timelineStart: end })
      continue
    }
    result.push(clip)
  }
  return result
}

// ---------------------------------------------------------------------------
// Pure trim helpers (used by store methods AND interactive drag)
// ---------------------------------------------------------------------------

export function applyRollTrim(
  timeline: Timeline,
  sources: MediaSource[],
  leftClipId: string,
  rightClipId: string,
  deltaFrames: number
): Timeline {
  const leftClip = timeline.clips.find((c) => c.id === leftClipId)
  const rightClip = timeline.clips.find((c) => c.id === rightClipId)
  if (!leftClip || !rightClip) return timeline

  const leftSource = sources.find((s) => s.id === leftClip.sourceId)
  let d = deltaFrames

  // Clamp left clip
  if (leftClip.sourceOut + d <= leftClip.sourceIn) d = leftClip.sourceIn + 1 - leftClip.sourceOut
  if (leftSource && leftClip.sourceOut + d > leftSource.duration) d = leftSource.duration - leftClip.sourceOut
  // Clamp right clip
  if (rightClip.sourceIn + d >= rightClip.sourceOut) d = rightClip.sourceOut - 1 - rightClip.sourceIn
  if (rightClip.sourceIn + d < 0) d = -rightClip.sourceIn

  const clips = timeline.clips.map((c) => {
    if (c.id === leftClipId) return { ...c, sourceOut: c.sourceOut + d }
    if (c.id === rightClipId) return { ...c, sourceIn: c.sourceIn + d, timelineStart: c.timelineStart + d }
    return c
  })
  return { ...timeline, clips, duration: timelineDuration(clips) }
}

export function applyRippleTrim(
  timeline: Timeline,
  sources: MediaSource[],
  clipId: string,
  edge: 'in' | 'out',
  deltaFrames: number
): Timeline {
  const clip = timeline.clips.find((c) => c.id === clipId)
  if (!clip) return timeline

  const source = sources.find((s) => s.id === clip.sourceId)
  let d = deltaFrames

  if (edge === 'out') {
    if (clip.sourceOut + d <= clip.sourceIn) d = clip.sourceIn + 1 - clip.sourceOut
    if (source && clip.sourceOut + d > source.duration) d = source.duration - clip.sourceOut
    const oldEnd = clip.timelineStart + clipDuration(clip)
    const clips = timeline.clips.map((c) => {
      if (c.id === clipId) return { ...c, sourceOut: c.sourceOut + d }
      if (c.trackId === clip.trackId && c.timelineStart >= oldEnd)
        return { ...c, timelineStart: c.timelineStart + d }
      return c
    })
    return { ...timeline, clips, duration: timelineDuration(clips) }
  }

  // IN edge
  if (clip.sourceIn + d < 0) d = -clip.sourceIn
  if (clip.sourceIn + d >= clip.sourceOut) d = clip.sourceOut - 1 - clip.sourceIn
  const oldEnd = clip.timelineStart + clipDuration(clip)
  const clips = timeline.clips.map((c) => {
    if (c.id === clipId) return { ...c, sourceIn: c.sourceIn + d }
    if (c.trackId === clip.trackId && c.timelineStart >= oldEnd)
      return { ...c, timelineStart: Math.max(0, c.timelineStart - d) }
    return c
  })
  return { ...timeline, clips, duration: timelineDuration(clips) }
}

export function applySlip(
  timeline: Timeline,
  sources: MediaSource[],
  clipId: string,
  deltaFrames: number
): Timeline {
  const clip = timeline.clips.find((c) => c.id === clipId)
  if (!clip) return timeline

  const source = sources.find((s) => s.id === clip.sourceId)
  let d = deltaFrames
  if (clip.sourceIn + d < 0) d = -clip.sourceIn
  if (source && clip.sourceOut + d > source.duration) d = source.duration - clip.sourceOut

  const clips = timeline.clips.map((c) => {
    if (c.id === clipId) return { ...c, sourceIn: c.sourceIn + d, sourceOut: c.sourceOut + d }
    return c
  })
  return { ...timeline, clips, duration: timelineDuration(clips) }
}

export function applySlide(
  timeline: Timeline,
  sources: MediaSource[],
  clipId: string,
  deltaFrames: number
): Timeline {
  const clip = timeline.clips.find((c) => c.id === clipId)
  if (!clip) return timeline

  const dur = clipDuration(clip)
  const clipEnd = clip.timelineStart + dur
  const trackClips = timeline.clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clipId)
    .sort((a, b) => a.timelineStart - b.timelineStart)

  // Find adjacent neighbors
  const leftNeighbor = trackClips.filter((c) => c.timelineStart + clipDuration(c) <= clip.timelineStart + 1).pop()
  const rightNeighbor = trackClips.find((c) => c.timelineStart >= clipEnd - 1)

  let d = deltaFrames

  // Clamp against left neighbor source bounds
  if (leftNeighbor) {
    const ls = sources.find((s) => s.id === leftNeighbor.sourceId)
    if (ls && leftNeighbor.sourceOut + d > ls.duration) d = ls.duration - leftNeighbor.sourceOut
    if (leftNeighbor.sourceOut + d <= leftNeighbor.sourceIn + 1) d = leftNeighbor.sourceIn + 1 - leftNeighbor.sourceOut
  }
  // Clamp against right neighbor source bounds
  if (rightNeighbor) {
    if (rightNeighbor.sourceIn + d < 0) d = -rightNeighbor.sourceIn
    if (rightNeighbor.sourceIn + d >= rightNeighbor.sourceOut - 1) d = rightNeighbor.sourceOut - 1 - rightNeighbor.sourceIn
  }
  if (d === 0) return timeline

  const clips = timeline.clips.map((c) => {
    if (c.id === clipId) return { ...c, timelineStart: c.timelineStart + d }
    if (leftNeighbor && c.id === leftNeighbor.id) return { ...c, sourceOut: c.sourceOut + d }
    if (rightNeighbor && c.id === rightNeighbor.id)
      return { ...c, sourceIn: c.sourceIn + d, timelineStart: c.timelineStart + d }
    return c
  })
  return { ...timeline, clips, duration: timelineDuration(clips) }
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT: EditorProject = {
  id: uid(),
  name: 'Untitled',
  frameRate: 30,
  sampleRate: 48_000,
  resolution: { width: 1920, height: 1080 },
  createdAt: Date.now(),
  modifiedAt: Date.now()
}

function defaultTracks(): TimelineTrack[] {
  return [
    { id: uid(), type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true },
    { id: uid(), type: 'audio', name: 'A1', index: 0, height: 60, muted: false, locked: false, visible: true }
  ]
}

const DEFAULT_TIMELINE: Timeline = {
  tracks: defaultTracks(),
  clips: [],
  duration: 0
}

const DEFAULT_CLIP_MODE: ClipModeState = {
  sourceId: null,
  inPoint: 0,
  outPoint: 0
}

const DEFAULT_PLAYBACK: PlaybackState = {
  isPlaying: false,
  isScrubbing: false,
  currentFrame: 0,
  playbackRate: 1,
  loop: false,
  inPoint: null,
  outPoint: null
}

const DEFAULT_HISTORY: HistoryState = {
  entries: [{ timestamp: Date.now(), label: 'Initial', snapshot: structuredClone(DEFAULT_TIMELINE) }],
  currentIndex: 0,
  maxEntries: 100
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface EditorStore {
  // Mode
  mode: EditorMode
  /** Per-mode saved playhead positions so switching tabs doesn't move the other mode's playhead */
  _savedFrames: Record<string, number>
  setMode: (mode: EditorMode) => void

  // Project
  project: EditorProject
  setProjectName: (name: string) => void
  sources: MediaSource[]
  addSource: (source: MediaSource) => void
  removeSource: (id: string) => void

  // Timeline
  timeline: Timeline
  addTrack: (type: 'video' | 'audio') => void
  removeTrack: (trackId: string) => void
  reorderTrack: (trackId: string, newIndex: number) => void
  addClip: (clip: Omit<TimelineClip, 'id'>) => void
  removeClip: (clipId: string) => void
  removeClips: (clipIds: string[]) => void
  moveClip: (clipId: string, newTrackId: string, newStart: number) => void
  trimClip: (clipId: string, edge: 'in' | 'out', newFrame: number) => void
  splitClip: (clipId: string, framePosition: number) => void

  // Edit operations (the 7 types)
  insertClip: (sourceId: string, inOut: [number, number], position: number, trackId: string) => void
  overwriteClip: (sourceId: string, inOut: [number, number], position: number, trackId: string) => void
  replaceClip: (sourceId: string, inOut: [number, number], targetClipId: string) => void
  rippleOverwrite: (sourceId: string, inOut: [number, number], targetClipId: string) => void
  placeOnTop: (sourceId: string, inOut: [number, number], position: number) => void
  appendClip: (sourceId: string, inOut: [number, number], trackId: string) => void
  fitToFill: (sourceId: string, inOut: [number, number], position: number, fillDuration: number, trackId: string) => void

  // Trim operations (the 4 types)
  rollTrim: (leftClipId: string, rightClipId: string, deltaFrames: number) => void
  rippleTrim: (clipId: string, edge: 'in' | 'out', deltaFrames: number) => void
  slipClip: (clipId: string, deltaFrames: number) => void
  slideClip: (clipId: string, deltaFrames: number) => void
  setClipVolume: (clipId: string, volume: number) => void
  setClipPan: (clipId: string, pan: number) => void
  toggleClipMuted: (clipId: string) => void

  // Spatial compositing
  setClipTransform: (clipId: string, transform: Partial<ClipTransform>) => void
  addKeyframe: (clipId: string, frame: number, transform: ClipTransform, easing?: EasingFunction) => void
  removeKeyframe: (clipId: string, frame: number) => void
  setClipBlendMode: (clipId: string, mode: BlendMode) => void

  // Clip mode
  clipMode: ClipModeState
  setClipSource: (sourceId: string, totalFrames: number) => void
  setClipInPoint: (frame: number) => void
  setClipOutPoint: (frame: number) => void

  // Playback
  playback: PlaybackState
  play: () => void
  pause: () => void
  togglePlayback: () => void
  seek: (frame: number) => void
  setPlaybackRate: (rate: number) => void

  // History
  history: HistoryState
  undo: () => void
  redo: () => void
  pushHistory: (label: string) => void

  // Selection
  selectedClipIds: string[]
  selectedTrackId: string | null
  selectClip: (clipId: string, multi?: boolean) => void
  selectTrack: (trackId: string) => void
  clearSelection: () => void

  // UI
  activeTool: EditTool
  setActiveTool: (tool: EditTool) => void
  zoom: number
  scrollX: number
  scrollY: number
  snapEnabled: boolean
  setZoom: (zoom: number) => void
  setScroll: (x: number, y: number) => void
  setSnapEnabled: (enabled: boolean) => void

  // Source selection (for edit operations)
  selectedSourceId: string | null
  selectSource: (sourceId: string | null) => void

  // Clipboard
  clipboard: TimelineClip[]
  copyClips: () => void
  cutClips: () => void
  pasteClips: (position: number, trackId: string) => void

  // Timeline in/out
  setInPoint: (frame: number | null) => void
  setOutPoint: (frame: number | null) => void

  // Reset
  resetEditor: () => void
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorStore>((set) => ({
  // === Mode ===
  mode: 'clip',
  _savedFrames: {},
  setMode: (mode) => set((s) => {
    if (s.mode === mode) return s
    // Save current playhead for the mode we're leaving, restore the target mode's
    const saved = { ...s._savedFrames, [s.mode]: s.playback.currentFrame }
    const restoredFrame = saved[mode] ?? 0
    return {
      mode,
      _savedFrames: saved,
      playback: { ...s.playback, isPlaying: false, currentFrame: restoredFrame }
    }
  }),

  // === Project & Sources ===
  project: DEFAULT_PROJECT,
  sources: [],

  setProjectName: (name) =>
    set((s) => ({ project: { ...s.project, name, modifiedAt: Date.now() } })),

  addSource: (source) =>
    set((s) => {
      const isFirst = s.sources.length === 0 && s.project.name === 'Untitled'
      const name = isFirst ? source.fileName.replace(/\.[^.]+$/, '') : s.project.name
      return {
        sources: [...s.sources, source],
        project: isFirst ? { ...s.project, name, modifiedAt: Date.now() } : s.project
      }
    }),

  removeSource: (id) =>
    set((s) => ({ sources: s.sources.filter((src) => src.id !== id) })),

  // === Timeline ===
  timeline: DEFAULT_TIMELINE,

  addTrack: (type) =>
    set((s) => {
      const existing = s.timeline.tracks.filter((t) => t.type === type)
      const index = type === 'video'
        ? Math.max(0, ...s.timeline.tracks.filter((t) => t.type === 'video').map((t) => t.index)) + 1
        : Math.max(0, ...s.timeline.tracks.filter((t) => t.type === 'audio').map((t) => t.index)) + 1
      const name = `${type === 'video' ? 'V' : 'A'}${existing.length + 1}`
      const track: TimelineTrack = {
        id: uid(),
        type,
        name,
        index,
        height: type === 'video' ? 80 : 60,
        muted: false,
        locked: false,
        visible: true
      }
      const newTimeline: Timeline = {
        ...s.timeline,
        tracks: [...s.timeline.tracks, track]
      }
      return {
        timeline: newTimeline,
        history: pushSnapshot(s.history, `Add ${type} track`, newTimeline)
      }
    }),

  removeTrack: (trackId) =>
    set((s) => {
      const target = s.timeline.tracks.find((t) => t.id === trackId)
      if (target?.locked) return s
      const newTimeline: Timeline = {
        ...s.timeline,
        tracks: s.timeline.tracks.filter((t) => t.id !== trackId),
        clips: s.timeline.clips.filter((c) => c.trackId !== trackId)
      }
      newTimeline.duration = timelineDuration(newTimeline.clips)
      return {
        timeline: newTimeline,
        history: pushSnapshot(s.history, 'Remove track', newTimeline)
      }
    }),

  reorderTrack: (trackId, newIndex) =>
    set((s) => {
      const tracks = s.timeline.tracks.map((t) =>
        t.id === trackId ? { ...t, index: newIndex } : t
      )
      const newTimeline: Timeline = { ...s.timeline, tracks }
      return { timeline: newTimeline }
    }),

  addClip: (clipData) =>
    set((s) => {
      const clip: TimelineClip = { ...clipData, id: uid() }
      const clips = [...s.timeline.clips, clip]
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        history: pushSnapshot(s.history, 'Add clip', newTimeline)
      }
    }),

  removeClip: (clipId) =>
    set((s) => {
      const clips = s.timeline.clips.filter((c) => c.id !== clipId)
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        selectedClipIds: s.selectedClipIds.filter((id) => id !== clipId),
        history: pushSnapshot(s.history, 'Remove clip', newTimeline)
      }
    }),

  removeClips: (clipIds) =>
    set((s) => {
      // Filter out locked clips and clips on locked tracks
      const lockedTrackIds = new Set(s.timeline.tracks.filter((t) => t.locked).map((t) => t.id))
      const deletable = clipIds.filter((id) => {
        const c = s.timeline.clips.find((cl) => cl.id === id)
        return c && !c.locked && !lockedTrackIds.has(c.trackId)
      })
      if (deletable.length === 0) return s
      const idSet = new Set(deletable)
      const clips = s.timeline.clips.filter((c) => !idSet.has(c.id))
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        selectedClipIds: s.selectedClipIds.filter((id) => !idSet.has(id)),
        history: pushSnapshot(s.history, 'Remove clips', newTimeline)
      }
    }),

  moveClip: (clipId, newTrackId, newStart) =>
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId)
      if (!clip) return s
      // Block moves on locked clips or clips on locked tracks
      const sourceTrack = s.timeline.tracks.find((t) => t.id === clip.trackId)
      if (clip.locked || sourceTrack?.locked) return s
      const clips = s.timeline.clips.map((c) =>
        c.id === clipId ? { ...c, trackId: newTrackId, timelineStart: Math.max(0, newStart) } : c
      )
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        history: pushSnapshot(s.history, 'Move clip', newTimeline)
      }
    }),

  trimClip: (clipId, edge, newFrame) =>
    set((s) => {
      // Block trims on locked clips or clips on locked tracks
      const target = s.timeline.clips.find((c) => c.id === clipId)
      if (!target) return s
      const track = s.timeline.tracks.find((t) => t.id === target.trackId)
      if (target.locked || track?.locked) return s
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        if (edge === 'in') {
          const delta = newFrame - c.sourceIn
          return {
            ...c,
            sourceIn: Math.max(0, newFrame),
            timelineStart: c.timelineStart + delta
          }
        }
        // edge === 'out'
        return { ...c, sourceOut: Math.max(c.sourceIn + 1, newFrame) }
      })
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        history: pushSnapshot(s.history, 'Trim clip', newTimeline)
      }
    }),

  splitClip: (clipId, framePosition) =>
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId)
      if (!clip) return s
      // Block splits on locked clips or clips on locked tracks
      const track = s.timeline.tracks.find((t) => t.id === clip.trackId)
      if (clip.locked || track?.locked) return s
      const clipEnd = clip.timelineStart + clipDuration(clip)
      if (framePosition <= clip.timelineStart || framePosition >= clipEnd) return s

      const sourceFrame = clip.sourceIn + (framePosition - clip.timelineStart) * clip.speed
      const clipA: TimelineClip = { ...clip, sourceOut: sourceFrame }
      const clipB: TimelineClip = {
        ...clip,
        id: uid(),
        sourceIn: sourceFrame,
        timelineStart: framePosition
      }
      const clips = s.timeline.clips.map((c) => (c.id === clipId ? clipA : c))
      clips.push(clipB)
      const newTimeline: Timeline = {
        ...s.timeline,
        clips,
        duration: timelineDuration(clips)
      }
      return {
        timeline: newTimeline,
        selectedClipIds: [clipA.id, clipB.id],
        history: pushSnapshot(s.history, 'Split clip', newTimeline)
      }
    }),

  // === Edit Operations (7 types) ===

  insertClip: (sourceId, inOut, position, trackId) =>
    set((s) => {
      const newClip = makeClip(sourceId, inOut, position, trackId, s.sources)
      const dur = inOut[1] - inOut[0]
      const clips = s.timeline.clips.map((c) => {
        if (c.trackId === trackId && c.timelineStart >= position) {
          return { ...c, timelineStart: c.timelineStart + dur }
        }
        return c
      })
      clips.push(newClip)
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Insert clip', newTimeline) }
    }),

  overwriteClip: (sourceId, inOut, position, trackId) =>
    set((s) => {
      const newClip = makeClip(sourceId, inOut, position, trackId, s.sources)
      const dur = inOut[1] - inOut[0]
      const clips = clearRegion(s.timeline.clips, trackId, position, position + dur)
      clips.push(newClip)
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Overwrite clip', newTimeline) }
    }),

  replaceClip: (sourceId, inOut, targetClipId) =>
    set((s) => {
      const target = s.timeline.clips.find((c) => c.id === targetClipId)
      if (!target) return s
      const targetDur = clipDuration(target)
      const source = s.sources.find((src) => src.id === sourceId)
      const adjustedOut = Math.min(inOut[0] + targetDur, source?.duration ?? inOut[1])
      const newClip: TimelineClip = {
        id: uid(),
        sourceId,
        trackId: target.trackId,
        timelineStart: target.timelineStart,
        sourceIn: inOut[0],
        sourceOut: adjustedOut,
        name: source?.fileName || 'Clip',
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed: 1
      }
      const clips = s.timeline.clips.map((c) => (c.id === targetClipId ? newClip : c))
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Replace clip', newTimeline) }
    }),

  rippleOverwrite: (sourceId, inOut, targetClipId) =>
    set((s) => {
      const target = s.timeline.clips.find((c) => c.id === targetClipId)
      if (!target) return s
      const oldDur = clipDuration(target)
      const newDur = inOut[1] - inOut[0]
      const delta = newDur - oldDur
      const source = s.sources.find((src) => src.id === sourceId)
      const newClip: TimelineClip = {
        id: uid(),
        sourceId,
        trackId: target.trackId,
        timelineStart: target.timelineStart,
        sourceIn: inOut[0],
        sourceOut: inOut[1],
        name: source?.fileName || 'Clip',
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed: 1
      }
      const targetEnd = target.timelineStart + oldDur
      const clips = s.timeline.clips.map((c) => {
        if (c.id === targetClipId) return newClip
        if (c.trackId === target.trackId && c.timelineStart >= targetEnd) {
          return { ...c, timelineStart: c.timelineStart + delta }
        }
        return c
      })
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Ripple overwrite', newTimeline) }
    }),

  placeOnTop: (sourceId, inOut, position) =>
    set((s) => {
      const dur = inOut[1] - inOut[0]
      const end = position + dur
      const videoTracks = s.timeline.tracks
        .filter((t) => t.type === 'video')
        .sort((a, b) => a.index - b.index)

      let targetTrack: TimelineTrack | null = null
      for (const track of videoTracks) {
        const trackClips = s.timeline.clips.filter((c) => c.trackId === track.id)
        const hasOverlap = trackClips.some((c) => {
          const cEnd = c.timelineStart + clipDuration(c)
          return position < cEnd && end > c.timelineStart
        })
        if (!hasOverlap) {
          targetTrack = track
          break
        }
      }

      let tracks = [...s.timeline.tracks]
      if (!targetTrack) {
        const maxIndex = Math.max(0, ...videoTracks.map((t) => t.index))
        targetTrack = {
          id: uid(),
          type: 'video',
          name: `V${videoTracks.length + 1}`,
          index: maxIndex + 1,
          height: 80,
          muted: false,
          locked: false,
          visible: true
        }
        tracks = [...tracks, targetTrack]
      }

      const source = s.sources.find((src) => src.id === sourceId)
      const newClip: TimelineClip = {
        id: uid(),
        sourceId,
        trackId: targetTrack.id,
        timelineStart: position,
        sourceIn: inOut[0],
        sourceOut: inOut[1],
        name: source?.fileName || 'Clip',
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed: 1
      }
      const clips = [...s.timeline.clips, newClip]
      const newTimeline: Timeline = { tracks, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Place on top', newTimeline) }
    }),

  appendClip: (sourceId, inOut, trackId) =>
    set((s) => {
      const trackClips = s.timeline.clips.filter((c) => c.trackId === trackId)
      const end =
        trackClips.length > 0
          ? Math.max(...trackClips.map((c) => c.timelineStart + clipDuration(c)))
          : 0
      const source = s.sources.find((src) => src.id === sourceId)
      const newClip: TimelineClip = {
        id: uid(),
        sourceId,
        trackId,
        timelineStart: end,
        sourceIn: inOut[0],
        sourceOut: inOut[1],
        name: source?.fileName || 'Clip',
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed: 1
      }
      const clips = [...s.timeline.clips, newClip]
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Append clip', newTimeline) }
    }),

  fitToFill: (sourceId, inOut, position, fillDuration, trackId) =>
    set((s) => {
      const sourceDur = inOut[1] - inOut[0]
      if (sourceDur <= 0 || fillDuration <= 0) return s
      const speed = sourceDur / fillDuration
      const source = s.sources.find((src) => src.id === sourceId)
      const newClip: TimelineClip = {
        id: uid(),
        sourceId,
        trackId,
        timelineStart: position,
        sourceIn: inOut[0],
        sourceOut: inOut[1],
        name: source?.fileName || 'Clip',
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed
      }
      const clips = clearRegion(s.timeline.clips, trackId, position, position + fillDuration)
      clips.push(newClip)
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Fit to fill', newTimeline) }
    }),

  // === Trim Operations (4 types) ===

  rollTrim: (leftClipId, rightClipId, deltaFrames) =>
    set((s) => {
      const newTimeline = applyRollTrim(s.timeline, s.sources, leftClipId, rightClipId, deltaFrames)
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Roll trim', newTimeline) }
    }),

  rippleTrim: (clipId, edge, deltaFrames) =>
    set((s) => {
      const newTimeline = applyRippleTrim(s.timeline, s.sources, clipId, edge, deltaFrames)
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Ripple trim', newTimeline) }
    }),

  slipClip: (clipId, deltaFrames) =>
    set((s) => {
      const newTimeline = applySlip(s.timeline, s.sources, clipId, deltaFrames)
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Slip clip', newTimeline) }
    }),

  slideClip: (clipId, deltaFrames) =>
    set((s) => {
      const newTimeline = applySlide(s.timeline, s.sources, clipId, deltaFrames)
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Slide clip', newTimeline) }
    }),

  setClipVolume: (clipId, volume) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === clipId ? { ...c, volume: Math.max(0, Math.min(2, volume)) } : c
      )
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Set volume', newTimeline) }
    }),

  setClipPan: (clipId, pan) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === clipId ? { ...c, pan: Math.max(-1, Math.min(1, pan)) } : c
      )
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Set pan', newTimeline) }
    }),

  toggleClipMuted: (clipId) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === clipId ? { ...c, muted: !c.muted } : c
      )
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Toggle mute', newTimeline) }
    }),

  // === Spatial Compositing ===

  setClipTransform: (clipId, transform) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        const existing = c.transform ?? {
          x: s.project.resolution.width / 2,
          y: s.project.resolution.height / 2,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          anchorX: 0.5,
          anchorY: 0.5,
          opacity: 1
        }
        return { ...c, transform: { ...existing, ...transform } }
      })
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Set transform', newTimeline) }
    }),

  addKeyframe: (clipId, frame, transform, easing = 'linear') =>
    set((s) => {
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        const keyframes = [...(c.keyframes ?? [])]
        const existingIdx = keyframes.findIndex((k) => k.frame === frame)
        const kf: TransformKeyframe = { frame, transform, easing }
        if (existingIdx >= 0) {
          keyframes[existingIdx] = kf
        } else {
          keyframes.push(kf)
          keyframes.sort((a, b) => a.frame - b.frame)
        }
        return { ...c, keyframes }
      })
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Add keyframe', newTimeline) }
    }),

  removeKeyframe: (clipId, frame) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        const keyframes = (c.keyframes ?? []).filter((k) => k.frame !== frame)
        return { ...c, keyframes: keyframes.length > 0 ? keyframes : undefined }
      })
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Remove keyframe', newTimeline) }
    }),

  setClipBlendMode: (clipId, mode) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === clipId ? { ...c, blendMode: mode } : c
      )
      const newTimeline: Timeline = { ...s.timeline, clips }
      return { timeline: newTimeline, history: pushSnapshot(s.history, 'Set blend mode', newTimeline) }
    }),

  // === Clip Mode ===
  clipMode: DEFAULT_CLIP_MODE,

  setClipSource: (sourceId, totalFrames) =>
    set({ clipMode: { sourceId, inPoint: 0, outPoint: totalFrames } }),

  setClipInPoint: (frame) =>
    set((s) => ({
      clipMode: { ...s.clipMode, inPoint: Math.max(0, Math.min(frame, s.clipMode.outPoint - 1)) }
    })),

  setClipOutPoint: (frame) =>
    set((s) => ({
      clipMode: { ...s.clipMode, outPoint: Math.max(s.clipMode.inPoint + 1, frame) }
    })),

  // === Playback ===
  playback: DEFAULT_PLAYBACK,

  play: () => set((s) => ({ playback: { ...s.playback, isPlaying: true } })),
  pause: () => set((s) => ({ playback: { ...s.playback, isPlaying: false } })),
  togglePlayback: () => set((s) => ({ playback: { ...s.playback, isPlaying: !s.playback.isPlaying } })),
  seek: (frame) => set((s) => ({ playback: { ...s.playback, currentFrame: Math.max(0, frame) } })),
  setScrubbing: (v: boolean) => set((s) => ({ playback: { ...s.playback, isScrubbing: v } })),
  setPlaybackRate: (rate) => set((s) => ({ playback: { ...s.playback, playbackRate: rate } })),

  // === History ===
  history: DEFAULT_HISTORY,

  undo: () =>
    set((s) => {
      if (s.history.currentIndex <= 0) return s
      const prevIndex = s.history.currentIndex - 1
      return {
        timeline: structuredClone(s.history.entries[prevIndex].snapshot),
        history: { ...s.history, currentIndex: prevIndex }
      }
    }),

  redo: () =>
    set((s) => {
      if (s.history.currentIndex >= s.history.entries.length - 1) return s
      const nextIndex = s.history.currentIndex + 1
      return {
        timeline: structuredClone(s.history.entries[nextIndex].snapshot),
        history: { ...s.history, currentIndex: nextIndex }
      }
    }),

  pushHistory: (label) =>
    set((s) => ({
      history: pushSnapshot(s.history, label, s.timeline)
    })),

  // === Selection ===
  selectedClipIds: [],
  selectedTrackId: null,

  selectClip: (clipId, multi) =>
    set((s) => {
      if (multi) {
        const ids = s.selectedClipIds.includes(clipId)
          ? s.selectedClipIds.filter((id) => id !== clipId)
          : [...s.selectedClipIds, clipId]
        return { selectedClipIds: ids }
      }
      return { selectedClipIds: [clipId] }
    }),

  selectTrack: (trackId) => set({ selectedTrackId: trackId }),
  clearSelection: () => set({ selectedClipIds: [], selectedTrackId: null }),

  // === UI ===
  activeTool: 'select',
  setActiveTool: (tool) => set({ activeTool: tool }),
  zoom: 50, // px per second
  scrollX: 0,
  scrollY: 0,
  snapEnabled: true,
  setZoom: (zoom) => set({ zoom: Math.max(2, Math.min(500, zoom)) }),
  setScroll: (x, y) => set({ scrollX: Math.max(0, x), scrollY: Math.max(0, y) }),
  setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),

  // === Source Selection ===
  selectedSourceId: null,
  selectSource: (sourceId) => set({ selectedSourceId: sourceId }),

  // === Clipboard ===
  clipboard: [],

  copyClips: () =>
    set((s) => {
      const clips = s.timeline.clips.filter((c) => s.selectedClipIds.includes(c.id))
      return { clipboard: structuredClone(clips) }
    }),

  cutClips: () =>
    set((s) => {
      const lockedTrackIds = new Set(s.timeline.tracks.filter((t) => t.locked).map((t) => t.id))
      const cuttable = s.selectedClipIds.filter((id) => {
        const c = s.timeline.clips.find((cl) => cl.id === id)
        return c && !c.locked && !lockedTrackIds.has(c.trackId)
      })
      if (cuttable.length === 0) return s
      const idSet = new Set(cuttable)
      const cut = s.timeline.clips.filter((c) => idSet.has(c.id))
      const remaining = s.timeline.clips.filter((c) => !idSet.has(c.id))
      const newTimeline: Timeline = { ...s.timeline, clips: remaining, duration: timelineDuration(remaining) }
      return {
        clipboard: structuredClone(cut),
        timeline: newTimeline,
        selectedClipIds: [],
        history: pushSnapshot(s.history, 'Cut clips', newTimeline)
      }
    }),

  pasteClips: (position, trackId) =>
    set((s) => {
      if (s.clipboard.length === 0) return s
      // Find the earliest timelineStart to use as reference
      const earliest = Math.min(...s.clipboard.map((c) => c.timelineStart))
      const newClips = s.clipboard.map((c) => ({
        ...c,
        id: uid(),
        trackId,
        timelineStart: position + (c.timelineStart - earliest)
      }))
      const clips = [...s.timeline.clips, ...newClips]
      const newTimeline: Timeline = { ...s.timeline, clips, duration: timelineDuration(clips) }
      return {
        timeline: newTimeline,
        selectedClipIds: newClips.map((c) => c.id),
        history: pushSnapshot(s.history, 'Paste clips', newTimeline)
      }
    }),

  // === Timeline In/Out ===
  setInPoint: (frame) =>
    set((s) => ({ playback: { ...s.playback, inPoint: frame } })),

  setOutPoint: (frame) =>
    set((s) => ({ playback: { ...s.playback, outPoint: frame } })),

  // === Reset ===
  resetEditor: () => {
    const tracks = defaultTracks()
    const timeline: Timeline = { tracks, clips: [], duration: 0 }
    set({
      mode: 'clip',
      project: { ...DEFAULT_PROJECT, id: uid(), createdAt: Date.now(), modifiedAt: Date.now() },
      sources: [],
      timeline,
      clipMode: DEFAULT_CLIP_MODE,
      playback: DEFAULT_PLAYBACK,
      history: { entries: [{ timestamp: Date.now(), label: 'Initial', snapshot: structuredClone(timeline) }], currentIndex: 0, maxEntries: 100 },
      selectedClipIds: [],
      selectedTrackId: null,
      selectedSourceId: null,
      clipboard: [],
      activeTool: 'select',
      zoom: 50,
      scrollX: 0,
      scrollY: 0,
      snapEnabled: true
    })
  }
}))
