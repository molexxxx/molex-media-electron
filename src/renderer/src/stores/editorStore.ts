/**
 * @module stores/editorStore
 * @description Zustand store for the media editor — manages clips, playback
 * state, loading states, UI mode, and export configuration.
 */

import { create } from 'zustand'
import type { CutMode, GifOptions } from '../components/editor/types'

export type ClipLoadingState = 'probing' | 'transcoding' | 'ready' | 'error'
export type EditorTab = 'trim' | 'inspect'

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

  /* -- in/out points -- */
  setInPoint: (t: number) => void
  setOutPoint: (t: number) => void
  resetPoints: () => void

  /* -- playback -- */
  playing: boolean
  currentTime: number
  setPlaying: (p: boolean) => void
  setCurrentTime: (t: number) => void

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
  setPlaying: (p) => set({ playing: p }),
  setCurrentTime: (t) => set({ currentTime: t }),

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
