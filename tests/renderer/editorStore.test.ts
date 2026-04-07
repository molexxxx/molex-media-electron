/**
 * @module tests/renderer/editorStore
 * @description TDD tests for the editor Zustand store — clip management,
 * file loading states, tab/playback state transitions, and edge cases
 * around switching clips while preserving valid playback state.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore, type EditorClip, type ClipLoadingState } from '@renderer/stores/editorStore'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeClip(overrides?: Partial<EditorClip>): EditorClip {
  const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    name: 'test.mp4',
    path: '/media/test.mp4',
    objectUrl: 'blob:http://localhost/abc',
    duration: 120,
    isVideo: true,
    inPoint: 0,
    outPoint: 120,
    sourceStart: 0,
    loadingState: 'ready' as ClipLoadingState,
    clipVolume: 1,
    clipMuted: false,
    ...overrides
  }
}

function resetStore(): void {
  useEditorStore.setState({
    clips: [],
    activeIdx: 0,
    playing: false,
    currentTime: 0,
    volume: 1,
    playbackRate: 1,
    editorTab: 'trim',
    processing: false,
    exportProgress: 0,
    message: '',
    cutMode: 'precise',
    outputFormat: 'mp4',
    outputDir: '',
    gifOptions: { loop: true, fps: 15, width: 480 }
  })
}

/* ------------------------------------------------------------------ */
/*  Clip Management                                                    */
/* ------------------------------------------------------------------ */

describe('editorStore', () => {
  beforeEach(() => {
    resetStore()
  })

  describe('addClip', () => {
    it('adds a clip and sets it as active', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(1)
      expect(s.clips[0].id).toBe(clip.id)
      expect(s.activeIdx).toBe(0)
    })

    it('appends subsequent clips and moves active to the newest', () => {
      const c1 = makeClip({ name: 'first.mp4' })
      const c2 = makeClip({ name: 'second.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.activeIdx).toBe(1)
      expect(s.clips[1].name).toBe('second.mp4')
    })

    it('adds clip in loading state', () => {
      const clip = makeClip({ loadingState: 'probing' })
      useEditorStore.getState().addClip(clip)
      expect(useEditorStore.getState().clips[0].loadingState).toBe('probing')
    })
  })

  describe('removeClip', () => {
    it('removes a clip by index', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().removeClip(0)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(1)
      expect(s.clips[0].name).toBe('b.mp4')
    })

    it('clamps activeIdx when removing the last clip', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setActiveIdx(1)
      useEditorStore.getState().removeClip(1)
      expect(useEditorStore.getState().activeIdx).toBe(0)
    })

    it('clamps activeIdx to 0 when removing the only clip', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().removeClip(0)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(0)
      expect(s.activeIdx).toBe(0)
    })

    it('does not shift activeIdx when removing a clip before the active', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'c.mp4' }))
      useEditorStore.getState().setActiveIdx(2)
      useEditorStore.getState().removeClip(0)
      const s = useEditorStore.getState()
      expect(s.activeIdx).toBe(1)
      expect(s.clips[s.activeIdx].name).toBe('c.mp4')
    })
  })

  describe('clearClips', () => {
    it('removes all clips and resets activeIdx', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().clearClips()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(0)
      expect(s.activeIdx).toBe(0)
    })
  })

  describe('setActiveIdx', () => {
    it('sets active index within bounds', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setActiveIdx(1)
      expect(useEditorStore.getState().activeIdx).toBe(1)
    })

    it('clamps to valid range', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setActiveIdx(99)
      expect(useEditorStore.getState().activeIdx).toBe(0)
    })

    it('clamps negative to 0', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setActiveIdx(-1)
      expect(useEditorStore.getState().activeIdx).toBe(0)
    })

    it('resets playing state on clip switch', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setPlaying(true)
      useEditorStore.getState().setActiveIdx(0)
      expect(useEditorStore.getState().playing).toBe(false)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  In/Out Points                                                      */
  /* ------------------------------------------------------------------ */

  describe('setInPoint / setOutPoint', () => {
    it('sets in-point for active clip', () => {
      useEditorStore.getState().addClip(makeClip({ duration: 60, outPoint: 60 }))
      useEditorStore.getState().setInPoint(10)
      expect(useEditorStore.getState().clips[0].inPoint).toBe(10)
    })

    it('sets out-point for active clip', () => {
      useEditorStore.getState().addClip(makeClip({ duration: 60, outPoint: 60 }))
      useEditorStore.getState().setOutPoint(50)
      expect(useEditorStore.getState().clips[0].outPoint).toBe(50)
    })

    it('clamps in-point to not exceed out-point', () => {
      useEditorStore.getState().addClip(makeClip({ duration: 60, outPoint: 30 }))
      useEditorStore.getState().setInPoint(35)
      const clip = useEditorStore.getState().clips[0]
      expect(clip.inPoint).toBeLessThanOrEqual(clip.outPoint)
    })

    it('clamps out-point to not go below in-point', () => {
      useEditorStore.getState().addClip(makeClip({ duration: 60, inPoint: 20, outPoint: 60 }))
      useEditorStore.getState().setOutPoint(15)
      const clip = useEditorStore.getState().clips[0]
      expect(clip.outPoint).toBeGreaterThanOrEqual(clip.inPoint)
    })

    it('resetPoints restores full duration', () => {
      useEditorStore.getState().addClip(makeClip({ duration: 60, inPoint: 10, outPoint: 50 }))
      useEditorStore.getState().resetPoints()
      const clip = useEditorStore.getState().clips[0]
      expect(clip.inPoint).toBe(0)
      expect(clip.outPoint).toBe(60)
    })

    it('no-ops when no clips exist', () => {
      useEditorStore.getState().setInPoint(10)
      useEditorStore.getState().setOutPoint(50)
      useEditorStore.getState().resetPoints()
      expect(useEditorStore.getState().clips).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Loading States                                                     */
  /* ------------------------------------------------------------------ */

  describe('updateClipLoading', () => {
    it('transitions clip from probing to transcoding', () => {
      const clip = makeClip({ loadingState: 'probing' })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().updateClipLoading(clip.id, 'transcoding')
      expect(useEditorStore.getState().clips[0].loadingState).toBe('transcoding')
    })

    it('transitions clip from transcoding to ready', () => {
      const clip = makeClip({ loadingState: 'transcoding' })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().updateClipLoading(clip.id, 'ready')
      expect(useEditorStore.getState().clips[0].loadingState).toBe('ready')
    })

    it('marks clip as error', () => {
      const clip = makeClip({ loadingState: 'probing' })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().updateClipLoading(clip.id, 'error')
      expect(useEditorStore.getState().clips[0].loadingState).toBe('error')
    })

    it('does not crash for unknown clip id', () => {
      useEditorStore.getState().updateClipLoading('nonexistent', 'ready')
      expect(useEditorStore.getState().clips).toHaveLength(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Clip property updates                                              */
  /* ------------------------------------------------------------------ */

  describe('updateClip', () => {
    it('updates arbitrary clip properties by id', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().updateClip(clip.id, { previewUrl: 'media://preview.mp4', duration: 90, outPoint: 90 })
      const updated = useEditorStore.getState().clips[0]
      expect(updated.previewUrl).toBe('media://preview.mp4')
      expect(updated.duration).toBe(90)
      expect(updated.outPoint).toBe(90)
    })

    it('ignores updates for unknown clip id', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().updateClip('nonexistent', { name: 'changed.mp4' })
      expect(useEditorStore.getState().clips[0].name).toBe('test.mp4')
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Editor UI State                                                    */
  /* ------------------------------------------------------------------ */

  describe('editor UI state', () => {
    it('defaults to trim tab', () => {
      expect(useEditorStore.getState().editorTab).toBe('trim')
    })

    it('switches tabs', () => {
      useEditorStore.getState().setEditorTab('inspect')
      expect(useEditorStore.getState().editorTab).toBe('inspect')
    })

    it('tracks processing state', () => {
      expect(useEditorStore.getState().processing).toBe(false)
      useEditorStore.getState().setProcessing(true)
      expect(useEditorStore.getState().processing).toBe(true)
    })

    it('tracks export progress', () => {
      useEditorStore.getState().setExportProgress(75)
      expect(useEditorStore.getState().exportProgress).toBe(75)
    })

    it('manages message', () => {
      useEditorStore.getState().setMessage('Saved: output.mp4')
      expect(useEditorStore.getState().message).toBe('Saved: output.mp4')
    })

    it('manages cut mode', () => {
      expect(useEditorStore.getState().cutMode).toBe('precise')
      useEditorStore.getState().setCutMode('fast')
      expect(useEditorStore.getState().cutMode).toBe('fast')
    })

    it('manages output format', () => {
      useEditorStore.getState().setOutputFormat('mp3')
      expect(useEditorStore.getState().outputFormat).toBe('mp3')
    })

    it('manages output directory', () => {
      useEditorStore.getState().setOutputDir('/output')
      expect(useEditorStore.getState().outputDir).toBe('/output')
    })

    it('manages gif options', () => {
      useEditorStore.getState().setGifOptions({ loop: false, fps: 10, width: 320 })
      const opts = useEditorStore.getState().gifOptions
      expect(opts.loop).toBe(false)
      expect(opts.fps).toBe(10)
      expect(opts.width).toBe(320)
    })

    it('manages playing state', () => {
      useEditorStore.getState().setPlaying(true)
      expect(useEditorStore.getState().playing).toBe(true)
      useEditorStore.getState().setPlaying(false)
      expect(useEditorStore.getState().playing).toBe(false)
    })

    it('manages currentTime', () => {
      useEditorStore.getState().setCurrentTime(42.5)
      expect(useEditorStore.getState().currentTime).toBe(42.5)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Derived state                                                      */
  /* ------------------------------------------------------------------ */

  describe('derived state', () => {
    it('activeClip returns the clip at activeIdx', () => {
      const c1 = makeClip({ name: 'first.mp4' })
      const c2 = makeClip({ name: 'second.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setActiveIdx(0)
      expect(useEditorStore.getState().activeClip()?.name).toBe('first.mp4')
    })

    it('activeClip returns null when no clips', () => {
      expect(useEditorStore.getState().activeClip()).toBeNull()
    })

    it('clipDuration returns outPoint - inPoint for active clip', () => {
      useEditorStore.getState().addClip(makeClip({ inPoint: 10, outPoint: 50 }))
      expect(useEditorStore.getState().clipDuration()).toBe(40)
    })

    it('clipDuration returns 0 when no clips', () => {
      expect(useEditorStore.getState().clipDuration()).toBe(0)
    })

    it('hasClips returns true when clips exist', () => {
      useEditorStore.getState().addClip(makeClip())
      expect(useEditorStore.getState().hasClips()).toBe(true)
    })

    it('hasClips returns false when empty', () => {
      expect(useEditorStore.getState().hasClips()).toBe(false)
    })

    it('canMerge returns true when 2+ clips', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      expect(useEditorStore.getState().canMerge()).toBe(true)
    })

    it('canMerge returns false for single clip', () => {
      useEditorStore.getState().addClip(makeClip())
      expect(useEditorStore.getState().canMerge()).toBe(false)
    })

    it('loadingCount returns number of non-ready clips', () => {
      useEditorStore.getState().addClip(makeClip({ loadingState: 'probing' }))
      useEditorStore.getState().addClip(makeClip({ loadingState: 'transcoding' }))
      useEditorStore.getState().addClip(makeClip({ loadingState: 'ready' }))
      expect(useEditorStore.getState().loadingCount()).toBe(2)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Edge cases — clip switching + playback validity                    */
  /* ------------------------------------------------------------------ */

  describe('clip switching edge cases', () => {
    it('switching clips while playing stops playback', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().setPlaying(true)
      useEditorStore.getState().setCurrentTime(30)
      useEditorStore.getState().setActiveIdx(0)
      expect(useEditorStore.getState().playing).toBe(false)
      expect(useEditorStore.getState().currentTime).toBe(0)
    })

    it('switching to same idx does not reset playback', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().setPlaying(true)
      useEditorStore.getState().setCurrentTime(30)
      useEditorStore.getState().setActiveIdx(0)
      expect(useEditorStore.getState().playing).toBe(true)
      expect(useEditorStore.getState().currentTime).toBe(30)
    })

    it('removing the active clip selects the previous clip', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'c.mp4' }))
      useEditorStore.getState().setActiveIdx(2)
      useEditorStore.getState().removeClip(2)
      expect(useEditorStore.getState().activeIdx).toBe(1)
    })

    it('removing first clip when active keeps idx 0', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().setActiveIdx(0)
      useEditorStore.getState().removeClip(0)
      const s = useEditorStore.getState()
      expect(s.activeIdx).toBe(0)
      expect(s.clips[0].name).toBe('b.mp4')
    })

    it('adding a clip while one is loading sets new clip to end', () => {
      useEditorStore.getState().addClip(makeClip({ loadingState: 'transcoding', name: 'loading.mp4' }))
      useEditorStore.getState().addClip(makeClip({ loadingState: 'ready', name: 'ready.mp4' }))
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.activeIdx).toBe(1)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  moveClip                                                           */
  /* ------------------------------------------------------------------ */

  describe('moveClip', () => {
    it('moves a clip forward in the list', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'c.mp4' }))
      useEditorStore.getState().moveClip(0, 2)
      const names = useEditorStore.getState().clips.map((c) => c.name)
      expect(names).toEqual(['b.mp4', 'c.mp4', 'a.mp4'])
    })

    it('moves a clip backward in the list', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'c.mp4' }))
      useEditorStore.getState().moveClip(2, 0)
      const names = useEditorStore.getState().clips.map((c) => c.name)
      expect(names).toEqual(['c.mp4', 'a.mp4', 'b.mp4'])
    })

    it('no-ops when from === to', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().moveClip(0, 0)
      const names = useEditorStore.getState().clips.map((c) => c.name)
      expect(names).toEqual(['a.mp4', 'b.mp4'])
    })

    it('no-ops for out-of-bounds indices', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().moveClip(0, 5)
      expect(useEditorStore.getState().clips).toHaveLength(1)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Audio replacement                                                  */
  /* ------------------------------------------------------------------ */

  describe('setAudioReplacement', () => {
    it('sets audio replacement for a clip', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/audio.mp3', name: 'audio.mp3', duration: 60, offset: 0, volume: 1, muted: false, objectUrl: 'blob:audio', trimIn: 0, trimOut: 60 })
      const updated = useEditorStore.getState().clips[0]
      expect(updated.audioReplacement).toBeDefined()
      expect(updated.audioReplacement!.name).toBe('audio.mp3')
    })

    it('clears audio replacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/audio.mp3', name: 'audio.mp3', duration: 60, offset: 0, volume: 1, muted: false, objectUrl: 'blob:audio', trimIn: 0, trimOut: 60 })
      useEditorStore.getState().setAudioReplacement(clip.id, undefined)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })

    it('does not affect other clips', () => {
      const c1 = makeClip({ name: 'a.mp4' })
      const c2 = makeClip({ name: 'b.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setAudioReplacement(c1.id, { path: '/audio.mp3', name: 'audio.mp3', duration: 60, offset: 0, volume: 1, muted: false, objectUrl: 'blob:audio', trimIn: 0, trimOut: 60 })
      expect(useEditorStore.getState().clips[1].audioReplacement).toBeUndefined()
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Per-clip in/out point trimming                                     */
  /* ------------------------------------------------------------------ */

  describe('setClipInPoint', () => {
    it('sets in-point for a clip by id', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipInPoint(clip.id, 5)
      expect(useEditorStore.getState().clips[0].inPoint).toBe(5)
    })

    it('clamps to 0', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipInPoint(clip.id, -10)
      expect(useEditorStore.getState().clips[0].inPoint).toBe(0)
    })

    it('clamps to outPoint - 0.05', () => {
      const clip = makeClip({ outPoint: 20 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipInPoint(clip.id, 25)
      expect(useEditorStore.getState().clips[0].inPoint).toBeCloseTo(19.95)
    })

    it('only affects the targeted clip', () => {
      const c1 = makeClip({ name: 'a.mp4' })
      const c2 = makeClip({ name: 'b.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setClipInPoint(c1.id, 3)
      expect(useEditorStore.getState().clips[0].inPoint).toBe(3)
      expect(useEditorStore.getState().clips[1].inPoint).toBe(0)
    })
  })

  describe('setClipOutPoint', () => {
    it('sets out-point for a clip by id', () => {
      const clip = makeClip({ duration: 60, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipOutPoint(clip.id, 45)
      expect(useEditorStore.getState().clips[0].outPoint).toBe(45)
    })

    it('clamps to duration', () => {
      const clip = makeClip({ duration: 30, outPoint: 30 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipOutPoint(clip.id, 100)
      expect(useEditorStore.getState().clips[0].outPoint).toBe(30)
    })

    it('clamps to inPoint + 0.05', () => {
      const clip = makeClip({ inPoint: 10, outPoint: 20 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipOutPoint(clip.id, 5)
      expect(useEditorStore.getState().clips[0].outPoint).toBeCloseTo(10.05)
    })

    it('only affects the targeted clip', () => {
      const c1 = makeClip({ name: 'a.mp4', duration: 60, outPoint: 60 })
      const c2 = makeClip({ name: 'b.mp4', duration: 40, outPoint: 40 })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setClipOutPoint(c1.id, 30)
      expect(useEditorStore.getState().clips[0].outPoint).toBe(30)
      expect(useEditorStore.getState().clips[1].outPoint).toBe(40)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Volume and playback rate                                           */
  /* ------------------------------------------------------------------ */

  describe('volume and playbackRate', () => {
    it('defaults volume to 1', () => {
      expect(useEditorStore.getState().volume).toBe(1)
    })

    it('sets volume', () => {
      useEditorStore.getState().setVolume(0.5)
      expect(useEditorStore.getState().volume).toBe(0.5)
    })

    it('clamps volume to 0-1 range', () => {
      useEditorStore.getState().setVolume(2)
      expect(useEditorStore.getState().volume).toBe(1)
      useEditorStore.getState().setVolume(-0.5)
      expect(useEditorStore.getState().volume).toBe(0)
    })

    it('defaults playbackRate to 1', () => {
      expect(useEditorStore.getState().playbackRate).toBe(1)
    })

    it('sets playback rate', () => {
      useEditorStore.getState().setPlaybackRate(1.5)
      expect(useEditorStore.getState().playbackRate).toBe(1.5)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  Per-clip volume and mute                                           */
  /* ------------------------------------------------------------------ */

  describe('setClipVolume', () => {
    it('sets per-clip volume', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipVolume(clip.id, 0.4)
      expect(useEditorStore.getState().clips[0].clipVolume).toBe(0.4)
    })

    it('clamps volume to 0-1 range', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setClipVolume(clip.id, 1.5)
      expect(useEditorStore.getState().clips[0].clipVolume).toBe(1)
      useEditorStore.getState().setClipVolume(clip.id, -0.3)
      expect(useEditorStore.getState().clips[0].clipVolume).toBe(0)
    })

    it('only affects the targeted clip', () => {
      const c1 = makeClip({ name: 'a.mp4' })
      const c2 = makeClip({ name: 'b.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setClipVolume(c1.id, 0.2)
      expect(useEditorStore.getState().clips[0].clipVolume).toBe(0.2)
      expect(useEditorStore.getState().clips[1].clipVolume).toBe(1)
    })
  })

  describe('toggleClipMute', () => {
    it('toggles mute on', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().toggleClipMute(clip.id)
      expect(useEditorStore.getState().clips[0].clipMuted).toBe(true)
    })

    it('toggles mute off', () => {
      const clip = makeClip({ clipMuted: true })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().toggleClipMute(clip.id)
      expect(useEditorStore.getState().clips[0].clipMuted).toBe(false)
    })

    it('only affects the targeted clip', () => {
      const c1 = makeClip({ name: 'a.mp4' })
      const c2 = makeClip({ name: 'b.mp4' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().toggleClipMute(c1.id)
      expect(useEditorStore.getState().clips[0].clipMuted).toBe(true)
      expect(useEditorStore.getState().clips[1].clipMuted).toBe(false)
    })
  })

  /* ------------------------------------------------------------------ */
  /*  A2 volume and mute                                                 */
  /* ------------------------------------------------------------------ */

  describe('setA2Volume', () => {
    it('sets A2 volume on a clip with audioReplacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2Volume(clip.id, 0.3)
      expect(useEditorStore.getState().clips[0].audioReplacement!.volume).toBe(0.3)
    })

    it('clamps volume to 0-1', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2Volume(clip.id, 2)
      expect(useEditorStore.getState().clips[0].audioReplacement!.volume).toBe(1)
      useEditorStore.getState().setA2Volume(clip.id, -1)
      expect(useEditorStore.getState().clips[0].audioReplacement!.volume).toBe(0)
    })

    it('no-ops when clip has no audioReplacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setA2Volume(clip.id, 0.5)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })
  })

  describe('toggleA2Mute', () => {
    it('toggles A2 mute on', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().toggleA2Mute(clip.id)
      expect(useEditorStore.getState().clips[0].audioReplacement!.muted).toBe(true)
    })

    it('toggles A2 mute off', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: true, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().toggleA2Mute(clip.id)
      expect(useEditorStore.getState().clips[0].audioReplacement!.muted).toBe(false)
    })

    it('no-ops when clip has no audioReplacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().toggleA2Mute(clip.id)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })
  })

  describe('splitClip', () => {
    it('splits a clip at the playhead into two clips when no in/out set', () => {
      const clip = makeClip({ duration: 60, inPoint: 0, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.clips[0].sourceStart).toBe(0)
      expect(s.clips[0].duration).toBe(30)
      expect(s.clips[0].inPoint).toBe(0)
      expect(s.clips[0].outPoint).toBe(30)
      expect(s.clips[1].sourceStart).toBe(30)
      expect(s.clips[1].duration).toBe(30)
      expect(s.clips[1].inPoint).toBe(30)
      expect(s.clips[1].outPoint).toBe(60)
    })

    it('keeps activeIdx on the left clip after playhead split', () => {
      const clip = makeClip({ duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 20)
      expect(useEditorStore.getState().activeIdx).toBe(0)
    })

    it('pauses playback after split', () => {
      const clip = makeClip({ duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.setState({ playing: true })
      useEditorStore.getState().splitClip(clip.id, 30)
      expect(useEditorStore.getState().playing).toBe(false)
    })

    it('preserves other clips in the list', () => {
      const c1 = makeClip({ name: 'a.mp4', duration: 60 })
      const c2 = makeClip({ name: 'b.mp4', duration: 40 })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().splitClip(c1.id, 20)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(3)
      expect(s.clips[2].name).toBe('b.mp4')
    })

    it('no-ops when split time is at the very start', () => {
      const clip = makeClip({ duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 0.01)
      expect(useEditorStore.getState().clips).toHaveLength(1)
    })

    it('no-ops when split time is at the very end', () => {
      const clip = makeClip({ duration: 60, inPoint: 0, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 59.96)
      expect(useEditorStore.getState().clips).toHaveLength(1)
    })

    it('no-ops for non-existent clip id', () => {
      const clip = makeClip({ duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip('nonexistent', 30)
      expect(useEditorStore.getState().clips).toHaveLength(1)
    })

    it('both halves share the same source path and objectUrl', () => {
      const clip = makeClip({ duration: 60, path: '/media/vid.mp4', objectUrl: 'blob:abc' })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 30)
      const s = useEditorStore.getState()
      expect(s.clips[0].path).toBe('/media/vid.mp4')
      expect(s.clips[1].path).toBe('/media/vid.mp4')
      expect(s.clips[0].objectUrl).toBe('blob:abc')
      expect(s.clips[1].objectUrl).toBe('blob:abc')
    })

    it('each half gets the correct duration for its range', () => {
      const clip = makeClip({ duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 25)
      const s = useEditorStore.getState()
      expect(s.clips[0].duration).toBe(25)
      expect(s.clips[1].duration).toBe(35)
    })

    it('splits at in/out points creating 3 segments', () => {
      const clip = makeClip({ duration: 60, inPoint: 10, outPoint: 50 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 30) // playhead time ignored
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(3)
      // Before selection
      expect(s.clips[0].sourceStart).toBe(0)
      expect(s.clips[0].duration).toBe(10)
      expect(s.clips[0].inPoint).toBe(0)
      expect(s.clips[0].outPoint).toBe(10)
      // Selection (middle)
      expect(s.clips[1].sourceStart).toBe(10)
      expect(s.clips[1].duration).toBe(40)
      expect(s.clips[1].inPoint).toBe(10)
      expect(s.clips[1].outPoint).toBe(50)
      // After selection
      expect(s.clips[2].sourceStart).toBe(50)
      expect(s.clips[2].duration).toBe(10)
      expect(s.clips[2].inPoint).toBe(50)
      expect(s.clips[2].outPoint).toBe(60)
      // Middle segment is active
      expect(s.activeIdx).toBe(1)
    })

    it('splits at in-point only creating 2 segments', () => {
      const clip = makeClip({ duration: 60, inPoint: 15, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.clips[0].outPoint).toBe(15)
      expect(s.clips[1].inPoint).toBe(15)
      expect(s.clips[1].outPoint).toBe(60)
    })

    it('splits at out-point only creating 2 segments', () => {
      const clip = makeClip({ duration: 60, inPoint: 0, outPoint: 40 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().splitClip(clip.id, 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.clips[0].inPoint).toBe(0)
      expect(s.clips[0].outPoint).toBe(40)
      expect(s.clips[1].inPoint).toBe(40)
      expect(s.clips[1].outPoint).toBe(60)
    })
  })

  describe('deleteActiveClip', () => {
    it('removes the active clip', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      useEditorStore.getState().setActiveIdx(0)
      useEditorStore.getState().deleteActiveClip()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(1)
      expect(s.clips[0].name).toBe('b.mp4')
    })

    it('clears all state when last clip is deleted', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().deleteActiveClip()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(0)
      expect(s.activeIdx).toBe(0)
      expect(s.playing).toBe(false)
    })

    it('clamps activeIdx when deleting the last clip in list', () => {
      useEditorStore.getState().addClip(makeClip({ name: 'a.mp4' }))
      useEditorStore.getState().addClip(makeClip({ name: 'b.mp4' }))
      // activeIdx is 1 (latest)
      useEditorStore.getState().deleteActiveClip()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(1)
      expect(s.activeIdx).toBe(0)
    })

    it('pauses playback after deletion', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.setState({ playing: true })
      useEditorStore.getState().deleteActiveClip()
      expect(useEditorStore.getState().playing).toBe(false)
    })

    it('no-ops on empty clip list', () => {
      useEditorStore.getState().deleteActiveClip()
      expect(useEditorStore.getState().clips).toHaveLength(0)
    })
  })

  describe('setAudioOffset', () => {
    it('updates offset on a clip with audioReplacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setAudioOffset(clip.id, 5.5)
      expect(useEditorStore.getState().clips[0].audioReplacement!.offset).toBe(5.5)
    })

    it('no-ops when clip has no audioReplacement', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioOffset(clip.id, 5)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })
  })

  describe('moveA2ToClip', () => {
    it('moves audio replacement from one clip to another', () => {
      const c1 = makeClip({ id: 'c1' })
      const c2 = makeClip({ id: 'c2' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 2, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().moveA2ToClip('c1', 1, 3)
      const s = useEditorStore.getState()
      expect(s.clips[0].audioReplacement).toBeUndefined()
      expect(s.clips[1].audioReplacement).toBeDefined()
      expect(s.clips[1].audioReplacement!.offset).toBe(3)
    })

    it('no-ops when source clip has no A2', () => {
      const c1 = makeClip({ id: 'c1' })
      const c2 = makeClip({ id: 'c2' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      useEditorStore.getState().moveA2ToClip('c1', 1, 0)
      expect(useEditorStore.getState().clips[1].audioReplacement).toBeUndefined()
    })

    it('no-ops when target already has A2', () => {
      const c1 = makeClip({ id: 'c1' })
      const c2 = makeClip({ id: 'c2' })
      useEditorStore.getState().addClip(c1)
      useEditorStore.getState().addClip(c2)
      const a2 = { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 }
      useEditorStore.getState().setAudioReplacement('c1', a2)
      useEditorStore.getState().setAudioReplacement('c2', { ...a2, path: '/b.mp3' })
      useEditorStore.getState().moveA2ToClip('c1', 1, 0)
      // Source should still have its A2
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeDefined()
    })
  })

  describe('setA2TrimIn', () => {
    it('sets trim-in on a clip with A2', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2TrimIn(clip.id, 5)
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimIn).toBe(5)
    })

    it('clamps trimIn to not exceed trimOut - 0.05', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 10 })
      useEditorStore.getState().setA2TrimIn(clip.id, 15) // exceeds trimOut
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimIn).toBe(10 - 0.05)
    })

    it('clamps trimIn to minimum 0', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2TrimIn(clip.id, -5)
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimIn).toBe(0)
    })

    it('no-ops when clip has no A2', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setA2TrimIn(clip.id, 5)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })
  })

  describe('setA2TrimOut', () => {
    it('sets trim-out on a clip with A2', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2TrimOut(clip.id, 20)
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimOut).toBe(20)
    })

    it('clamps trimOut to duration max', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().setA2TrimOut(clip.id, 50) // exceeds duration
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimOut).toBe(30)
    })

    it('clamps trimOut to trimIn + 0.05 minimum', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement(clip.id, { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 10, trimOut: 30 })
      useEditorStore.getState().setA2TrimOut(clip.id, 5) // less than trimIn
      expect(useEditorStore.getState().clips[0].audioReplacement!.trimOut).toBe(10.05)
    })

    it('no-ops when clip has no A2', () => {
      const clip = makeClip()
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setA2TrimOut(clip.id, 20)
      expect(useEditorStore.getState().clips[0].audioReplacement).toBeUndefined()
    })
  })

  describe('clipToSelection', () => {
    it('trims clip to in/out selection', () => {
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 10, outPoint: 50 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().clipToSelection()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(1)
      expect(s.clips[0].sourceStart).toBe(10)
      expect(s.clips[0].duration).toBe(40)
      expect(s.clips[0].inPoint).toBe(10)
      expect(s.clips[0].outPoint).toBe(50)
    })

    it('adjusts A2 offset when clipping to selection', () => {
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 10, outPoint: 50 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 5, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().clipToSelection()
      const s = useEditorStore.getState()
      // Offset was 5, new sourceStart = 10, original sourceStart = 0 → offset = max(0, 5 - (10 - 0)) = 0
      expect(s.clips[0].audioReplacement!.offset).toBe(0)
    })

    it('no-ops when in/out span the full clip', () => {
      const clip = makeClip({ duration: 60, inPoint: 0, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().clipToSelection()
      expect(useEditorStore.getState().clips).toHaveLength(1)
      expect(useEditorStore.getState().clips[0].duration).toBe(60)
    })

    it('no-ops when no clips exist', () => {
      useEditorStore.getState().clipToSelection()
      expect(useEditorStore.getState().clips).toHaveLength(0)
    })

    it('works with in-point only (out at full extent)', () => {
      const clip = makeClip({ duration: 60, inPoint: 20, outPoint: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().clipToSelection()
      const s = useEditorStore.getState()
      expect(s.clips[0].sourceStart).toBe(20)
      expect(s.clips[0].duration).toBe(40)
    })
  })

  describe('resetEditor', () => {
    it('clears all clips and resets UI state', () => {
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.getState().addClip(makeClip())
      useEditorStore.setState({ cutMode: 'fast' as any, outputFormat: 'mkv', outputDir: '/test', processing: true, exportProgress: 50 })
      useEditorStore.getState().resetEditor()
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(0)
      expect(s.activeIdx).toBe(0)
      expect(s.playing).toBe(false)
      expect(s.cutMode).toBe('precise')
      expect(s.outputFormat).toBe('mp4')
      expect(s.outputDir).toBe('')
      expect(s.processing).toBe(false)
      expect(s.exportProgress).toBe(0)
      expect(s.volume).toBe(1)
      expect(s.playbackRate).toBe(1)
    })

    it('resets gif options to defaults', () => {
      useEditorStore.setState({ gifOptions: { loop: false, fps: 5, width: 100 } })
      useEditorStore.getState().resetEditor()
      const s = useEditorStore.getState()
      expect(s.gifOptions).toEqual({ loop: true, fps: 15, width: 480 })
    })
  })

  describe('splitClip – A2 assignment in 3-segment split', () => {
    it('assigns A2 to middle segment when A2 offset is in the middle range', () => {
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 10, outPoint: 50 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 15, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 30) // playhead ignored
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(3)
      // A2 starts at offset=15 → source time = 0+15 = 15, in range [10,50)
      expect(s.clips[0].audioReplacement).toBeUndefined()
      expect(s.clips[1].audioReplacement).toBeDefined()
      expect(s.clips[2].audioReplacement).toBeUndefined()
      // New offset = 15 - (10 - 0) = 5
      expect(s.clips[1].audioReplacement!.offset).toBe(5)
    })

    it('assigns A2 to left segment when A2 offset is before in-point', () => {
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 20, outPoint: 50 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 5, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(3)
      expect(s.clips[0].audioReplacement).toBeDefined()
      expect(s.clips[0].audioReplacement!.offset).toBe(5)
      expect(s.clips[1].audioReplacement).toBeUndefined()
      expect(s.clips[2].audioReplacement).toBeUndefined()
    })

    it('assigns A2 to right segment when A2 offset is after out-point', () => {
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 10, outPoint: 30 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 40, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 20)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(3)
      expect(s.clips[0].audioReplacement).toBeUndefined()
      expect(s.clips[1].audioReplacement).toBeUndefined()
      expect(s.clips[2].audioReplacement).toBeDefined()
      // New offset = 40 - (30 - 0) = 10
      expect(s.clips[2].audioReplacement!.offset).toBe(10)
    })

    it('assigns A2 to first segment as fallback when offset=0 and no L segment', () => {
      // Only out-point set (no in-point) → 2 segments, A2 offset=0 starts at beginning
      const clip = makeClip({ id: 'c1', duration: 60, inPoint: 0, outPoint: 40 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 0, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 20)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      // A2 offset=0 → source time 0, falls in [0, 40) → left segment
      expect(s.clips[0].audioReplacement).toBeDefined()
      expect(s.clips[0].audioReplacement!.offset).toBe(0)
    })
  })

  describe('splitClip – playhead split with A2', () => {
    it('assigns A2 to left half when A2 starts before split point', () => {
      const clip = makeClip({ id: 'c1', duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 10, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.clips[0].audioReplacement).toBeDefined()
      expect(s.clips[0].audioReplacement!.offset).toBe(10)
      expect(s.clips[1].audioReplacement).toBeUndefined()
    })

    it('assigns A2 to right half when A2 starts at or after split point', () => {
      const clip = makeClip({ id: 'c1', duration: 60 })
      useEditorStore.getState().addClip(clip)
      useEditorStore.getState().setAudioReplacement('c1', { path: '/a.mp3', name: 'a.mp3', duration: 30, offset: 40, volume: 1, muted: false, objectUrl: 'blob:a', trimIn: 0, trimOut: 30 })
      useEditorStore.getState().splitClip('c1', 30)
      const s = useEditorStore.getState()
      expect(s.clips).toHaveLength(2)
      expect(s.clips[0].audioReplacement).toBeUndefined()
      expect(s.clips[1].audioReplacement).toBeDefined()
      // offset = max(0, 40 - (30 - 0)) = 10
      expect(s.clips[1].audioReplacement!.offset).toBe(10)
    })
  })
})
