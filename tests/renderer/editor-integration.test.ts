/**
 * Editor integration tests - exercises full user-level workflows through the
 * Zustand store.  These tests verify that sequences of store actions compose
 * correctly and result in the expected timeline state, covering:
 *   - Clip-mode in/out + export-ready state
 *   - Edit-mode add/select/move/split workflows
 *   - Timeline zoom/scroll state management
 *   - Clipboard round-trips
 *   - Multi-track compositing workflows
 *   - Mixed edit-types in sequence
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore } from '../../src/renderer/src/stores/editorStore'
import type { MediaSource, TimelineClip } from '../../src/renderer/src/components/editor/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reset(): void {
  useEditorStore.getState().resetEditor()
}

function state() {
  return useEditorStore.getState()
}

function mkSource(overrides: Partial<MediaSource> = {}): MediaSource {
  return {
    id: 'src-1',
    filePath: '/media/video.mp4',
    fileName: 'video.mp4',
    duration: 900,
    frameRate: 30,
    width: 1920,
    height: 1080,
    audioChannels: 2,
    audioSampleRate: 48000,
    codec: 'h264',
    format: 'mp4',
    fileSize: 5_000_000,
    durationSeconds: 30,
    ...overrides
  }
}

function videoTrackId(): string {
  return state().timeline.tracks.find((t) => t.type === 'video')!.id
}

function audioTrackId(): string {
  return state().timeline.tracks.find((t) => t.type === 'audio')!.id
}

function addClip(start: number, srcIn: number, srcOut: number, opts: Partial<TimelineClip> = {}): string {
  state().addClip({
    sourceId: 'src-1',
    trackId: videoTrackId(),
    timelineStart: start,
    sourceIn: srcIn,
    sourceOut: srcOut,
    name: 'Clip',
    color: '',
    muted: false,
    locked: false,
    volume: 1,
    pan: 0,
    speed: 1,
    ...opts
  })
  return state().timeline.clips[state().timeline.clips.length - 1].id
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('clip mode workflows', () => {
  beforeEach(() => reset())

  describe('in/out point workflow', () => {
    it('full in/out + export-ready flow', () => {
      // 1. Add source
      const src = mkSource()
      state().addSource(src)
      state().setClipSource(src.id, src.duration)

      // 2. Verify initial state - full range
      expect(state().clipMode.inPoint).toBe(0)
      expect(state().clipMode.outPoint).toBe(900)

      // 3. Set in-point
      state().setClipInPoint(300)
      expect(state().clipMode.inPoint).toBe(300)

      // 4. Set out-point
      state().setClipOutPoint(600)
      expect(state().clipMode.outPoint).toBe(600)

      // 5. Duration is correct
      const dur = state().clipMode.outPoint - state().clipMode.inPoint
      expect(dur).toBe(300)

      // 6. Adjust in past out - should clamp
      state().setClipInPoint(700)
      expect(state().clipMode.inPoint).toBe(599) // outPoint-1
    })

    it('in/out points survive mode switches', () => {
      const src = mkSource()
      state().addSource(src)
      state().setClipSource(src.id, src.duration)
      state().setClipInPoint(100)
      state().setClipOutPoint(500)

      // Switch to edit and back
      state().setMode('edit')
      state().setMode('clip')

      expect(state().clipMode.inPoint).toBe(100)
      expect(state().clipMode.outPoint).toBe(500)
    })

    it('playback state works with clip mode', () => {
      const src = mkSource()
      state().addSource(src)
      state().setClipSource(src.id, src.duration)

      state().seek(250)
      expect(state().playback.currentFrame).toBe(250)

      state().play()
      expect(state().playback.isPlaying).toBe(true)

      state().pause()
      expect(state().playback.isPlaying).toBe(false)
    })
  })

  describe('clip mode reset', () => {
    it('reset clears clip mode source', () => {
      const src = mkSource()
      state().addSource(src)
      state().setClipSource(src.id, src.duration)
      state().setClipInPoint(100)

      state().resetEditor()

      expect(state().clipMode.sourceId).toBeNull()
      expect(state().clipMode.inPoint).toBe(0)
      expect(state().clipMode.outPoint).toBe(0)
    })
  })
})

describe('edit mode workflows', () => {
  beforeEach(() => {
    reset()
    state().addSource(mkSource())
    state().setMode('edit')
  })

  // =========================================================================
  // Add + Select + Move
  // =========================================================================

  describe('add / select / move clips', () => {
    it('add clip → select → move workflow', () => {
      const id = addClip(0, 0, 150)

      // Select
      state().selectClip(id)
      expect(state().selectedClipIds).toEqual([id])

      // Move
      state().moveClip(id, videoTrackId(), 100)
      expect(state().timeline.clips[0].timelineStart).toBe(100)

      // Timeline duration updated
      expect(state().timeline.duration).toBe(250) // 100 + 150
    })

    it('multi-select + batch delete', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 100, 200)
      const id3 = addClip(200, 200, 300)

      // Multi-select first two
      state().selectClip(id1)
      state().selectClip(id2, true)
      expect(state().selectedClipIds).toHaveLength(2)

      // Delete selection
      state().removeClips(state().selectedClipIds)
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.clips[0].id).toBe(id3)
    })

    it('select all + clear', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 100, 200)

      state().selectClip(id1)
      state().selectClip(id2, true)
      expect(state().selectedClipIds).toHaveLength(2)

      state().clearSelection()
      expect(state().selectedClipIds).toEqual([])
    })
  })

  // =========================================================================
  // Split workflow
  // =========================================================================

  describe('split workflow', () => {
    it('split at playhead + undo flow', () => {
      const id = addClip(0, 0, 300)

      // Seek to split position
      state().seek(150)

      // Split
      state().splitClip(id, 150)
      expect(state().timeline.clips).toHaveLength(2)

      // Both halves selected
      expect(state().selectedClipIds).toHaveLength(2)

      // Undo reverts the split
      state().undo()
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.clips[0].sourceIn).toBe(0)
      expect(state().timeline.clips[0].sourceOut).toBe(300)
    })

    it('split + delete left + move right', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 100)

      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      const leftId = clips[0].id
      const rightId = clips[1].id

      // Delete left half
      state().removeClip(leftId)
      expect(state().timeline.clips).toHaveLength(1)

      // Move the remaining clip to position 0
      state().moveClip(rightId, videoTrackId(), 0)
      expect(state().timeline.clips[0].timelineStart).toBe(0)
      expect(state().timeline.clips[0].sourceIn).toBe(100)
    })

    it('multiple splits create correct segments', () => {
      const id = addClip(0, 0, 300)

      state().splitClip(id, 100)
      // Now we have [0-100] and [100-300]
      expect(state().timeline.clips).toHaveLength(2)

      const second = state().timeline.clips.find((c) => c.sourceIn === 100)!
      state().splitClip(second.id, 200)
      // Now we have [0-100], [100-200], [200-300]
      expect(state().timeline.clips).toHaveLength(3)

      const sorted = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(sorted[0].sourceIn).toBe(0)
      expect(sorted[0].sourceOut).toBe(100)
      expect(sorted[1].sourceIn).toBe(100)
      expect(sorted[1].sourceOut).toBe(200)
      expect(sorted[2].sourceIn).toBe(200)
      expect(sorted[2].sourceOut).toBe(300)
    })
  })

  // =========================================================================
  // Insert + Overwrite in sequence
  // =========================================================================

  describe('mixed edit operations', () => {
    it('insert then overwrite', () => {
      const vid = videoTrackId()
      // Insert first clip
      state().insertClip('src-1', [0, 100], 0, vid)
      expect(state().timeline.clips).toHaveLength(1)

      // Insert second clip at start (pushes first right)
      state().insertClip('src-1', [100, 200], 0, vid)
      const sorted = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(sorted[0].sourceIn).toBe(100) // the inserted one at 0
      expect(sorted[1].timelineStart).toBe(100) // original pushed to 100

      // Overwrite over the first chunk
      state().overwriteClip('src-1', [200, 260], 0, vid)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      // Overwrite placed a 60-frame clip at 0-60, covering part of the 0-100 clip
      expect(clips[0].timelineStart).toBe(0)
      expect(clips[0].sourceOut - clips[0].sourceIn).toBe(60)
    })

    it('append builds a sequence', () => {
      const vid = videoTrackId()
      state().appendClip('src-1', [0, 100], vid)
      state().appendClip('src-1', [200, 350], vid)
      state().appendClip('src-1', [400, 500], vid)

      const sorted = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(sorted).toHaveLength(3)
      expect(sorted[0].timelineStart).toBe(0)
      expect(sorted[1].timelineStart).toBe(100)
      expect(sorted[2].timelineStart).toBe(250) // 100 + 150
    })

    it('fitToFill creates slow-motion segment', () => {
      const vid = videoTrackId()
      // 60-frame source fills 120 timeline frames → speed 0.5
      state().fitToFill('src-1', [0, 60], 0, 120, vid)
      const clip = state().timeline.clips[0]
      expect(clip.speed).toBeCloseTo(0.5)
      const timelineDur = (clip.sourceOut - clip.sourceIn) / clip.speed
      expect(timelineDur).toBeCloseTo(120)
    })
  })

  // =========================================================================
  // Multi-track workflow
  // =========================================================================

  describe('multi-track workflow', () => {
    it('add audio clip on audio track', () => {
      const aId = audioTrackId()
      state().addClip({
        sourceId: 'src-1', trackId: aId, timelineStart: 0,
        sourceIn: 0, sourceOut: 150, name: 'Audio', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      })
      const audioClips = state().timeline.clips.filter((c) => c.trackId === aId)
      expect(audioClips).toHaveLength(1)
    })

    it('move clip between tracks', () => {
      const id = addClip(0, 0, 150)
      state().addTrack('video')
      const tracks = state().timeline.tracks.filter((t) => t.type === 'video')
      const v2Id = tracks[1].id

      state().moveClip(id, v2Id, 0)
      expect(state().timeline.clips[0].trackId).toBe(v2Id)
    })

    it('placeOnTop creates new track when needed', () => {
      addClip(0, 0, 150) // fills V1
      state().placeOnTop('src-1', [0, 100], 0) // overlap → needs V2
      const vTracks = state().timeline.tracks.filter((t) => t.type === 'video')
      expect(vTracks).toHaveLength(2)
      expect(state().timeline.clips).toHaveLength(2)
    })

    it('remove track cleans up clips', () => {
      state().addTrack('video')
      const v2 = state().timeline.tracks.filter((t) => t.type === 'video')[1]
      state().addClip({
        sourceId: 'src-1', trackId: v2.id, timelineStart: 0,
        sourceIn: 0, sourceOut: 100, name: 'V2', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      })
      expect(state().timeline.clips.filter((c) => c.trackId === v2.id)).toHaveLength(1)

      state().removeTrack(v2.id)
      expect(state().timeline.clips.filter((c) => c.trackId === v2.id)).toHaveLength(0)
    })
  })

  // =========================================================================
  // Copy / Cut / Paste
  // =========================================================================

  describe('clipboard workflow', () => {
    it('copy + paste duplicates clips', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().copyClips()

      state().pasteClips(200, videoTrackId())
      expect(state().timeline.clips).toHaveLength(2)

      // Pasted clip has a new ID
      const pasted = state().timeline.clips.find((c) => c.timelineStart === 200)!
      expect(pasted.id).not.toBe(id)
      expect(pasted.sourceIn).toBe(0)
      expect(pasted.sourceOut).toBe(100)
    })

    it('cut + paste moves clips', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().cutClips()

      expect(state().timeline.clips).toHaveLength(0)
      expect(state().clipboard).toHaveLength(1)

      state().pasteClips(300, videoTrackId())
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.clips[0].timelineStart).toBe(300)
    })

    it('paste selects the pasted clips', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().copyClips()

      state().pasteClips(200, videoTrackId())
      // pasted clip should be selected
      const pastedId = state().timeline.clips.find((c) => c.timelineStart === 200)!.id
      expect(state().selectedClipIds).toContain(pastedId)
    })

    it('multi-clip paste with relative positions', () => {
      const id1 = addClip(0, 0, 100)
      addClip(200, 200, 300) // 100 frame gap between

      // Select all
      state().selectClip(id1)
      state().selectClip(state().timeline.clips[1].id, true)
      state().copyClips()

      state().pasteClips(500, videoTrackId())
      const pastedClips = state().timeline.clips.filter((c) => c.timelineStart >= 500)
      expect(pastedClips).toHaveLength(2)
      const starts = pastedClips.map((c) => c.timelineStart).sort((a, b) => a - b)
      expect(starts[1] - starts[0]).toBe(200) // gap preserved
    })
  })

  // =========================================================================
  // Undo/Redo across operations
  // =========================================================================

  describe('undo/redo across operations', () => {
    it('undo chain through add + move + split', () => {
      const id = addClip(0, 0, 300) // history entry 1
      state().moveClip(id, videoTrackId(), 50) // history entry 2
      state().splitClip(id, 200) // history entry 3

      // Undo split
      state().undo()
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.clips[0].timelineStart).toBe(50)

      // Undo move
      state().undo()
      expect(state().timeline.clips[0].timelineStart).toBe(0)

      // Undo add
      state().undo()
      expect(state().timeline.clips).toHaveLength(0)

      // Redo all
      state().redo() // add
      state().redo() // move
      state().redo() // split
      expect(state().timeline.clips).toHaveLength(2)
    })

    it('new action after undo truncates redo stack', () => {
      addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().undo() // remove second clip

      // New action replaces undone history
      addClip(100, 300, 400)
      state().redo() // should do nothing
      expect(state().timeline.clips).toHaveLength(2)
      expect(state().timeline.clips[1].sourceIn).toBe(300)
    })
  })

  // =========================================================================
  // Trim workflows
  // =========================================================================

  describe('trim workflows', () => {
    it('ripple trim + downstream shift', () => {
      const id1 = addClip(0, 0, 100)
      addClip(100, 100, 200)
      addClip(200, 200, 300)

      // Extend first clip by 20 frames → pushes clips 2+3 right
      state().rippleTrim(id1, 'out', 20)
      const sorted = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(sorted[0].sourceOut).toBe(120)
      expect(sorted[1].timelineStart).toBe(120)
      expect(sorted[2].timelineStart).toBe(220)
    })

    it('slip preserves timeline layout', () => {
      const id = addClip(0, 200, 400) // shows source 200-400
      addClip(200, 400, 500) // second clip at 200

      state().slipClip(id, -50)
      const clip = state().timeline.clips.find((c) => c.id === id)!
      expect(clip.sourceIn).toBe(150)
      expect(clip.sourceOut).toBe(350)
      expect(clip.timelineStart).toBe(0) // unchanged

      // Second clip is also unchanged
      const clip2 = state().timeline.clips.find((c) => c.id !== id)!
      expect(clip2.timelineStart).toBe(200) // unchanged
    })
  })
})

// ===========================================================================
// Timeline zoom & scroll
// ===========================================================================

describe('timeline zoom and scroll', () => {
  beforeEach(() => reset())

  it('zoom in and out cycles', () => {
    state().setZoom(50)
    expect(state().zoom).toBe(50)

    state().setZoom(100)
    expect(state().zoom).toBe(100)

    state().setZoom(50)
    expect(state().zoom).toBe(50)
  })

  it('zoom clamps to min/max', () => {
    state().setZoom(1)
    expect(state().zoom).toBe(2) // min

    state().setZoom(600)
    expect(state().zoom).toBe(500) // max
  })

  it('scroll clamps to non-negative', () => {
    state().setScroll(100, 50)
    expect(state().scrollX).toBe(100)
    expect(state().scrollY).toBe(50)

    state().setScroll(-10, -20)
    expect(state().scrollX).toBe(0)
    expect(state().scrollY).toBe(0)
  })

  it('snap toggle persists', () => {
    expect(state().snapEnabled).toBe(true)
    state().setSnapEnabled(false)
    expect(state().snapEnabled).toBe(false)
    state().setSnapEnabled(true)
    expect(state().snapEnabled).toBe(true)
  })

  it('active tool selection', () => {
    expect(state().activeTool).toBe('select')
    state().setActiveTool('razor')
    expect(state().activeTool).toBe('razor')
    state().setActiveTool('trim')
    expect(state().activeTool).toBe('trim')
    state().setActiveTool('select')
    expect(state().activeTool).toBe('select')
  })
})

// ===========================================================================
// End-to-end: full editing session
// ===========================================================================

describe('full editing session', () => {
  beforeEach(() => reset())

  it('complete edit sequence from load to export-ready timeline', () => {
    const src1 = mkSource({ id: 'src-1', fileName: 'interview.mp4', duration: 9000 })
    const src2 = mkSource({ id: 'src-2', fileName: 'broll.mp4', duration: 3600, filePath: '/media/broll.mp4' })

    // Import sources
    state().addSource(src1)
    state().addSource(src2)
    expect(state().sources).toHaveLength(2)
    expect(state().project.name).toBe('interview') // auto-named from first source

    // Switch to edit mode
    state().setMode('edit')
    const vid = videoTrackId()
    const aid = audioTrackId()

    // Add interview on V1
    state().appendClip('src-1', [0, 3000], vid)
    state().appendClip('src-1', [4500, 7500], vid)

    // Split the first clip at frame 1500
    const firstClip = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)[0]
    state().splitClip(firstClip.id, 1500)

    // Delete the first half (bad take)
    const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
    state().removeClip(clips[0].id)

    // Add B-roll on a second video track using placeOnTop
    state().placeOnTop('src-2', [0, 900], 1500)

    // Verify multi-track state
    const vTracks = state().timeline.tracks.filter((t) => t.type === 'video')
    expect(vTracks.length).toBeGreaterThanOrEqual(1)
    expect(state().timeline.clips.length).toBeGreaterThanOrEqual(3)

    // Adjust volume on one clip
    const brollClip = state().timeline.clips.find((c) => c.sourceId === 'src-2')!
    state().setClipVolume(brollClip.id, 0.3)
    expect(state().timeline.clips.find((c) => c.id === brollClip.id)!.volume).toBe(0.3)

    // Verify we can undo the entire session back to initial
    const historyLen = state().history.entries.length
    expect(historyLen).toBeGreaterThan(5) // many operations recorded
  })
})
