/** @module editor/types - NLE editor type definitions. */

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Resolution {
  width: number
  height: number
}

export interface EditorProject {
  id: string
  name: string
  frameRate: number // 24, 25, 29.97, 30, 60
  sampleRate: number // 44100, 48000
  resolution: Resolution
  createdAt: number
  modifiedAt: number
}

// ---------------------------------------------------------------------------
// Media source
// ---------------------------------------------------------------------------

export interface MediaSource {
  id: string
  filePath: string
  fileName: string
  duration: number // total frames
  frameRate: number // source native fps
  width: number
  height: number
  audioChannels: number
  audioSampleRate: number
  codec: string
  format: string
  fileSize: number
  durationSeconds: number // convenience - seconds (float)
}

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

export interface TimelineClip {
  id: string
  sourceId: string // → MediaSource.id
  trackId: string // → TimelineTrack.id

  // Position on timeline (project frames)
  timelineStart: number

  // Source range (source frames)
  sourceIn: number
  sourceOut: number

  // Metadata
  name: string
  color: string
  muted: boolean
  locked: boolean

  // Audio
  volume: number // 0-2 (1 = unity)
  pan: number // -1 … 1

  // Speed
  speed: number // 1.0 = normal
}

export interface TimelineTrack {
  id: string
  type: 'video' | 'audio'
  name: string // "V1", "A1", …
  index: number // stacking order (higher = on top for video)
  height: number // visual px height
  muted: boolean
  locked: boolean
  visible: boolean // video tracks only
}

export interface Timeline {
  tracks: TimelineTrack[]
  clips: TimelineClip[]
  duration: number // auto-calculated total frames
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  timestamp: number
  label: string
  snapshot: Timeline
}

export interface HistoryState {
  entries: HistoryEntry[]
  currentIndex: number
  maxEntries: number
}

// ---------------------------------------------------------------------------
// Clip mode (simple in/out for a single source)
// ---------------------------------------------------------------------------

export interface ClipModeState {
  sourceId: string | null
  inPoint: number // frame in source
  outPoint: number // frame in source
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export interface PlaybackState {
  isPlaying: boolean
  currentFrame: number
  playbackRate: number // 1 = normal, negative = reverse
  loop: boolean
  inPoint: number | null // timeline in point
  outPoint: number | null // timeline out point
}

// ---------------------------------------------------------------------------
// Mode union
// ---------------------------------------------------------------------------

export type EditorMode = 'clip' | 'edit' | 'inspect'

// ---------------------------------------------------------------------------
// Tool (edit mode)
// ---------------------------------------------------------------------------

export type EditTool = 'select' | 'trim' | 'razor' | 'slip' | 'slide'

export interface EditPoint {
  leftClipId: string
  rightClipId: string
}
