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

  // Spatial compositing (Phase 10)
  transform?: ClipTransform
  keyframes?: TransformKeyframe[]
  blendMode?: BlendMode
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
  isScrubbing: boolean
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

// ---------------------------------------------------------------------------
// Spatial compositing (Phase 10)
// ---------------------------------------------------------------------------

/** Spatial transform properties for a single clip. */
export interface ClipTransform {
  /** X position of clip center, in output pixels. Default: outputWidth / 2 */
  x: number
  /** Y position of clip center, in output pixels. Default: outputHeight / 2 */
  y: number
  /** Horizontal scale factor. 1.0 = native size. Default: fit-to-output */
  scaleX: number
  /** Vertical scale factor. 1.0 = native size. Default: fit-to-output */
  scaleY: number
  /** Rotation in degrees, clockwise. Default: 0 */
  rotation: number
  /** Anchor point X as fraction of clip width (0.0 = left, 0.5 = center, 1.0 = right). Default: 0.5 */
  anchorX: number
  /** Anchor point Y as fraction of clip height (0.0 = top, 0.5 = center, 1.0 = bottom). Default: 0.5 */
  anchorY: number
  /** Opacity 0.0 (transparent) to 1.0 (opaque). Default: 1.0 */
  opacity: number
}

export type EasingFunction = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** A keyframe samples the transform at a specific frame offset within the clip. */
export interface TransformKeyframe {
  /** Frame offset relative to clip's timelineStart. */
  frame: number
  /** The transform state at this keyframe. */
  transform: ClipTransform
  /** Easing to the NEXT keyframe. Default: 'linear'. */
  easing: EasingFunction
}

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add'
  | 'difference'

/** Create a default identity transform centered in the output. */
export function defaultTransform(
  sourceW: number,
  sourceH: number,
  outputW: number,
  outputH: number
): ClipTransform {
  const fitScale = Math.min(outputW / sourceW, outputH / sourceH)
  return {
    x: outputW / 2,
    y: outputH / 2,
    scaleX: fitScale,
    scaleY: fitScale,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    opacity: 1.0
  }
}
