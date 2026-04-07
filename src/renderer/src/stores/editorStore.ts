/**
 * @module stores/editorStore
 * @description Zustand store for the media editor — manages clips, playback
 * state, loading states, UI mode, and export configuration.
 */

import { create } from 'zustand'
import type { CutMode, GifOptions } from '../components/editor/types'

export type ClipLoadingState = 'probing' | 'transcoding' | 'ready' | 'error'
export type EditorTab = 'trim' | 'inspect'

export interface AudioReplacement {
  path: string
  name: string
  duration: number
  /** Offset in seconds — positive delays audio, negative starts audio earlier. */
  offset: number
  /** Per-track volume 0–1 (default 1). */
  volume: number
  /** Per-track mute flag (default false). */
  muted: boolean
  /** Browser-playable URL (blob or media://) for preview playback. */
  objectUrl: string
  /** Trim in-point in A2 source time (default 0). */
  trimIn: number
  /** Trim out-point in A2 source time (default = duration). */
  trimOut: number
}

export interface EditorClip {
  id: string
  name: string
  path: string
  objectUrl: string
  previewUrl?: string
  duration: number
  isVideo: boolean
  inPoint: number
  outPoint: number
  /** Start position in the source file (0 for unsplit clips, set by split). */
  sourceStart: number
  loadingState: ClipLoadingState
  audioReplacement?: AudioReplacement
  /** Per-clip volume 0–1 (default 1). */
  clipVolume: number
  /** Per-clip mute flag (default false). */
  clipMuted: boolean
}

interface EditorState {
  /* -- clip list -- */
  clips: EditorClip[]
  activeIdx: number
  addClip: (clip: EditorClip) => void
  removeClip: (idx: number) => void
  clearClips: () => void
  resetEditor: () => void
  setActiveIdx: (idx: number) => void
  updateClipLoading: (id: string, state: ClipLoadingState) => void
  updateClip: (id: string, data: Partial<EditorClip>) => void
  moveClip: (fromIdx: number, toIdx: number) => void
  setAudioReplacement: (clipId: string, replacement: AudioReplacement | undefined) => void
  setAudioOffset: (clipId: string, offset: number) => void
  moveA2ToClip: (fromClipId: string, toClipIdx: number, newOffset: number) => void
  setClipVolume: (clipId: string, volume: number) => void
  toggleClipMute: (clipId: string) => void
  setA2Volume: (clipId: string, volume: number) => void
  toggleA2Mute: (clipId: string) => void
  setA2TrimIn: (clipId: string, t: number) => void
  setA2TrimOut: (clipId: string, t: number) => void
  setClipInPoint: (clipId: string, t: number) => void
  setClipOutPoint: (clipId: string, t: number) => void
  splitClip: (clipId: string, time: number) => void
  clipToSelection: () => void
  deleteActiveClip: () => void

  /* -- in/out points -- */
  setInPoint: (t: number) => void
  setOutPoint: (t: number) => void
  resetPoints: () => void

  /* -- playback -- */
  playing: boolean
  currentTime: number
  volume: number
  playbackRate: number
  setPlaying: (p: boolean) => void
  setCurrentTime: (t: number) => void
  setVolume: (v: number) => void
  setPlaybackRate: (r: number) => void

  /* -- UI -- */
  editorTab: EditorTab
  processing: boolean
  exportProgress: number
  message: string
  cutMode: CutMode
  outputFormat: string
  outputDir: string
  gifOptions: GifOptions
  setEditorTab: (tab: EditorTab) => void
  setProcessing: (p: boolean) => void
  setExportProgress: (pct: number) => void
  setMessage: (msg: string) => void
  setCutMode: (mode: CutMode) => void
  setOutputFormat: (fmt: string) => void
  setOutputDir: (dir: string) => void
  setGifOptions: (opts: Partial<GifOptions>) => void

  /* -- derived -- */
  activeClip: () => EditorClip | null
  clipDuration: () => number
  hasClips: () => boolean
  canMerge: () => boolean
  loadingCount: () => number
}

export const useEditorStore = create<EditorState>((set, get) => ({
  /* -- clip list -- */
  clips: [],
  activeIdx: 0,

  addClip: (clip) =>
    set((s) => ({
      clips: [...s.clips, clip],
      activeIdx: s.clips.length
    })),

  removeClip: (idx) =>
    set((s) => {
      const next = s.clips.filter((_, i) => i !== idx)
      let newIdx = s.activeIdx
      if (next.length === 0) {
        newIdx = 0
      } else if (idx < s.activeIdx) {
        newIdx = s.activeIdx - 1
      } else if (idx === s.activeIdx) {
        newIdx = Math.min(s.activeIdx, next.length - 1)
      }
      return { clips: next, activeIdx: newIdx, playing: false, currentTime: 0 }
    }),

  clearClips: () => {
    const { clips } = get()
    clips.forEach((c) => { if (c.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(c.objectUrl) })
    set({ clips: [], activeIdx: 0, playing: false, currentTime: 0 })
  },

  resetEditor: () => {
    const { clips } = get()
    clips.forEach((c) => { if (c.objectUrl?.startsWith('blob:')) URL.revokeObjectURL(c.objectUrl) })
    set({
      clips: [], activeIdx: 0, playing: false, currentTime: 0,
      volume: 1, playbackRate: 1,
      editorTab: 'trim' as EditorTab, processing: false, exportProgress: 0, message: '',
      cutMode: 'precise' as CutMode, outputFormat: 'mp4', outputDir: '', gifOptions: { loop: true, fps: 15, width: 480 }
    })
  },

  setActiveIdx: (idx) =>
    set((s) => {
      const clamped = Math.max(0, Math.min(idx, Math.max(s.clips.length - 1, 0)))
      if (clamped === s.activeIdx) return {}
      return { activeIdx: clamped, playing: false, currentTime: 0 }
    }),

  updateClipLoading: (id, state) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, loadingState: state } : c))
    })),

  updateClip: (id, data) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...data } : c))
    })),

  moveClip: (fromIdx, toIdx) =>
    set((s) => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= s.clips.length || toIdx >= s.clips.length) return {}
      const next = [...s.clips]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      const newActiveIdx = fromIdx === s.activeIdx ? toIdx : s.activeIdx < Math.min(fromIdx, toIdx) || s.activeIdx > Math.max(fromIdx, toIdx) ? s.activeIdx : fromIdx < toIdx ? s.activeIdx - 1 : s.activeIdx + 1
      return { clips: next, activeIdx: Math.max(0, Math.min(newActiveIdx, next.length - 1)) }
    }),

  setAudioReplacement: (clipId, replacement) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === clipId ? { ...c, audioReplacement: replacement } : c))
    })),

  setAudioOffset: (clipId, offset) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.audioReplacement
          ? { ...c, audioReplacement: { ...c.audioReplacement, offset } }
          : c
      )
    })),

  moveA2ToClip: (fromClipId, toClipIdx, newOffset) =>
    set((s) => {
      const fromClip = s.clips.find((c) => c.id === fromClipId)
      if (!fromClip?.audioReplacement) return {}
      const toClip = s.clips[toClipIdx]
      if (!toClip || toClip.audioReplacement) return {} // target already has A2
      const ar = { ...fromClip.audioReplacement, offset: newOffset }
      return {
        clips: s.clips.map((c) => {
          if (c.id === fromClipId) return { ...c, audioReplacement: undefined }
          if (c.id === toClip.id) return { ...c, audioReplacement: ar }
          return c
        })
      }
    }),

  setClipVolume: (clipId, volume) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, clipVolume: Math.max(0, Math.min(1, volume)) } : c
      )
    })),

  toggleClipMute: (clipId) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, clipMuted: !c.clipMuted } : c
      )
    })),

  setA2Volume: (clipId, volume) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.audioReplacement
          ? { ...c, audioReplacement: { ...c.audioReplacement, volume: Math.max(0, Math.min(1, volume)) } }
          : c
      )
    })),

  toggleA2Mute: (clipId) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.audioReplacement
          ? { ...c, audioReplacement: { ...c.audioReplacement, muted: !c.audioReplacement.muted } }
          : c
      )
    })),

  setA2TrimIn: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.audioReplacement
          ? { ...c, audioReplacement: { ...c.audioReplacement, trimIn: Math.max(0, Math.min(t, c.audioReplacement.trimOut - 0.05)) } }
          : c
      )
    })),

  setA2TrimOut: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId && c.audioReplacement
          ? { ...c, audioReplacement: { ...c.audioReplacement, trimOut: Math.max(c.audioReplacement.trimIn + 0.05, Math.min(t, c.audioReplacement.duration)) } }
          : c
      )
    })),

  setClipInPoint: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, inPoint: Math.max(c.sourceStart, Math.min(t, c.outPoint - 0.05)) } : c
      )
    })),

  setClipOutPoint: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, outPoint: Math.max(c.inPoint + 0.05, Math.min(t, c.sourceStart + c.duration)) } : c
      )
    })),

  splitClip: (clipId, time) =>
    set((s) => {
      const idx = s.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return {}
      const orig = s.clips[idx]
      const ss = orig.sourceStart
      const clipEnd = ss + orig.duration

      /**
       * Keep A2 only on the segment whose start is closest to (or contains)
       * the A2 start position.  segStart is relative to source time.
       * The A2 offset is recalculated relative to the new segment.
       */
      let a2Assigned = false
      const keepA2 = (segStart: number): EditorClip['audioReplacement'] => {
        if (!orig.audioReplacement || a2Assigned) return undefined
        a2Assigned = true
        return { ...orig.audioReplacement, offset: Math.max(0, orig.audioReplacement.offset - (segStart - ss)) }
      }

      // Check if in/out points are set away from the clip edges
      const hasIn = orig.inPoint > ss + 0.05
      const hasOut = orig.outPoint < clipEnd - 0.05

      if (hasIn || hasOut) {
        // Determine which segment gets A2 — the one containing A2 start
        const a2Start = orig.audioReplacement ? ss + orig.audioReplacement.offset : -1
        // Split at in/out boundaries — creates 2 or 3 segments
        const segments: EditorClip[] = []

        if (hasIn) {
          const segOwnsA2 = a2Start >= ss && a2Start < orig.inPoint
          segments.push({
            ...orig,
            id: `${orig.id}-L`,
            sourceStart: ss,
            duration: orig.inPoint - ss,
            inPoint: ss,
            outPoint: orig.inPoint,
            audioReplacement: segOwnsA2 ? keepA2(ss) : undefined
          })
        }

        // Middle segment (the selected region)
        {
          const segOwnsA2 = !a2Assigned && a2Start >= orig.inPoint && a2Start < orig.outPoint
          segments.push({
            ...orig,
            id: hasIn && hasOut ? `${orig.id}-M` : hasIn ? `${orig.id}-R` : `${orig.id}-L`,
            sourceStart: orig.inPoint,
            duration: orig.outPoint - orig.inPoint,
            inPoint: orig.inPoint,
            outPoint: orig.outPoint,
            audioReplacement: segOwnsA2 ? keepA2(orig.inPoint) : undefined
          })
        }

        if (hasOut) {
          const segOwnsA2 = !a2Assigned && a2Start >= orig.outPoint
          segments.push({
            ...orig,
            id: hasIn && hasOut ? `${orig.id}-R` : `${orig.id}-R`,
            sourceStart: orig.outPoint,
            duration: clipEnd - orig.outPoint,
            inPoint: orig.outPoint,
            outPoint: clipEnd,
            audioReplacement: segOwnsA2 ? keepA2(orig.outPoint) : undefined
          })
        }

        // If A2 wasn't assigned yet (offset=0, no L segment), put it on first segment
        if (orig.audioReplacement && !a2Assigned) {
          segments[0].audioReplacement = keepA2(segments[0].sourceStart)
        }

        const next = [...s.clips]
        next.splice(idx, 1, ...segments)
        // Activate the middle segment (the selected region)
        const middleIdx = hasIn ? idx + 1 : idx
        return { clips: next, activeIdx: middleIdx, playing: false }
      }

      // No in/out set — split at playhead time (2 segments)
      if (time <= ss + 0.05 || time >= clipEnd - 0.05) return {}
      const a2Start = orig.audioReplacement ? ss + orig.audioReplacement.offset : -1
      const a2GoesLeft = a2Start >= ss && a2Start < time
      const leftClip: EditorClip = {
        ...orig,
        id: `${orig.id}-L`,
        sourceStart: ss,
        duration: time - ss,
        inPoint: ss,
        outPoint: time,
        audioReplacement: a2GoesLeft ? keepA2(ss) : undefined
      }
      const rightClip: EditorClip = {
        ...orig,
        id: `${orig.id}-R`,
        sourceStart: time,
        duration: clipEnd - time,
        inPoint: time,
        outPoint: clipEnd,
        audioReplacement: !a2Assigned && orig.audioReplacement ? keepA2(time) : undefined
      }
      const next = [...s.clips]
      next.splice(idx, 1, leftClip, rightClip)
      return { clips: next, activeIdx: idx, currentTime: time, playing: false }
    }),

  clipToSelection: () =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const ss = clip.sourceStart
      const hasIn = clip.inPoint > ss + 0.05
      const hasOut = clip.outPoint < ss + clip.duration - 0.05
      if (!hasIn && !hasOut) return {} // nothing to clip
      const newStart = clip.inPoint
      const newDur = clip.outPoint - clip.inPoint
      let ar = clip.audioReplacement
      if (ar) {
        const newOff = Math.max(0, ar.offset - (newStart - ss))
        ar = { ...ar, offset: newOff }
      }
      const trimmed: EditorClip = {
        ...clip,
        sourceStart: newStart,
        duration: newDur,
        inPoint: newStart,
        outPoint: clip.outPoint,
        audioReplacement: ar
      }
      return { clips: [trimmed], activeIdx: 0, playing: false, currentTime: newStart }
    }),

  deleteActiveClip: () =>
    set((s) => {
      if (s.clips.length === 0) return {}
      const next = s.clips.filter((_, i) => i !== s.activeIdx)
      if (next.length === 0) return { clips: [], activeIdx: 0, playing: false, currentTime: 0 }
      return {
        clips: next,
        activeIdx: Math.min(s.activeIdx, next.length - 1),
        playing: false,
        currentTime: 0
      }
    }),

  /* -- in/out points -- */
  setInPoint: (t) =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const clamped = Math.max(clip.sourceStart, Math.min(t, clip.outPoint))
      const updated = s.clips.map((c, i) => (i === s.activeIdx ? { ...c, inPoint: clamped } : c))
      return { clips: updated }
    }),

  setOutPoint: (t) =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const clamped = Math.max(clip.inPoint, Math.min(t, clip.sourceStart + clip.duration))
      const updated = s.clips.map((c, i) => (i === s.activeIdx ? { ...c, outPoint: clamped } : c))
      return { clips: updated }
    }),

  resetPoints: () =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const updated = s.clips.map((c, i) =>
        i === s.activeIdx ? { ...c, inPoint: c.sourceStart, outPoint: c.sourceStart + c.duration } : c
      )
      return { clips: updated }
    }),

  /* -- playback -- */
  playing: false,
  currentTime: 0,
  volume: 1,
  playbackRate: 1,
  setPlaying: (p) => set({ playing: p }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
  setPlaybackRate: (r) => set({ playbackRate: r }),

  /* -- UI -- */
  editorTab: 'trim' as EditorTab,
  processing: false,
  exportProgress: 0,
  message: '',
  cutMode: 'precise' as CutMode,
  outputFormat: 'mp4',
  outputDir: '',
  gifOptions: { loop: true, fps: 15, width: 480 },

  setEditorTab: (tab) => set({ editorTab: tab }),
  setProcessing: (p) => set({ processing: p }),
  setExportProgress: (pct) => set({ exportProgress: pct }),
  setMessage: (msg) => set({ message: msg }),
  setCutMode: (mode) => set({ cutMode: mode }),
  setOutputFormat: (fmt) => set({ outputFormat: fmt }),
  setOutputDir: (dir) => set({ outputDir: dir }),
  setGifOptions: (opts) => set((s) => ({ gifOptions: { ...s.gifOptions, ...opts } })),

  /* -- derived -- */
  activeClip: () => {
    const s = get()
    return s.clips[s.activeIdx] ?? null
  },
  clipDuration: () => {
    const clip = get().activeClip()
    return clip ? clip.outPoint - clip.inPoint : 0
  },
  hasClips: () => get().clips.length > 0,
  canMerge: () => get().clips.length >= 2,
  loadingCount: () => get().clips.filter((c) => c.loadingState !== 'ready').length
}))
