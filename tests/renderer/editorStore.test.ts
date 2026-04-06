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
    loadingState: 'ready' as ClipLoadingState,
    ...overrides
  }
}

function resetStore(): void {
  useEditorStore.setState({
    clips: [],
    activeIdx: 0,
    playing: false,
    currentTime: 0,
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
})
