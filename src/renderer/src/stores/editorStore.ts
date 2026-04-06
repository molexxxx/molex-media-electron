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
  setActiveIdx: (idx: number) => void
  updateClipLoading: (id: string, state: ClipLoadingState) => void
  updateClip: (id: string, data: Partial<EditorClip>) => void
  moveClip: (fromIdx: number, toIdx: number) => void
  setAudioReplacement: (clipId: string, replacement: AudioReplacement | undefined) => void
  setAudioOffset: (clipId: string, offset: number) => void
  setClipVolume: (clipId: string, volume: number) => void
  toggleClipMute: (clipId: string) => void
  setA2Volume: (clipId: string, volume: number) => void
  toggleA2Mute: (clipId: string) => void
  setClipInPoint: (clipId: string, t: number) => void
  setClipOutPoint: (clipId: string, t: number) => void

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

  clearClips: () => set({ clips: [], activeIdx: 0, playing: false, currentTime: 0 }),

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

  setClipInPoint: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, inPoint: Math.max(0, Math.min(t, c.outPoint - 0.05)) } : c
      )
    })),

  setClipOutPoint: (clipId, t) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, outPoint: Math.max(c.inPoint + 0.05, Math.min(t, c.duration)) } : c
      )
    })),

  /* -- in/out points -- */
  setInPoint: (t) =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const clamped = Math.max(0, Math.min(t, clip.outPoint))
      const updated = s.clips.map((c, i) => (i === s.activeIdx ? { ...c, inPoint: clamped } : c))
      return { clips: updated }
    }),

  setOutPoint: (t) =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const clamped = Math.max(clip.inPoint, Math.min(t, clip.duration))
      const updated = s.clips.map((c, i) => (i === s.activeIdx ? { ...c, outPoint: clamped } : c))
      return { clips: updated }
    }),

  resetPoints: () =>
    set((s) => {
      const clip = s.clips[s.activeIdx]
      if (!clip) return {}
      const updated = s.clips.map((c, i) =>
        i === s.activeIdx ? { ...c, inPoint: 0, outPoint: c.duration } : c
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
