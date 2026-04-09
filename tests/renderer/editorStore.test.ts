import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore, applyRollTrim, applyRippleTrim, applySlip, applySlide } from '../../src/renderer/src/stores/editorStore'
import type { MediaSource, TimelineClip, Timeline } from '../../src/renderer/src/components/editor/types'

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

function mkSource2(overrides: Partial<MediaSource> = {}): MediaSource {
  return mkSource({ id: 'src-2', filePath: '/media/clip2.mp4', fileName: 'clip2.mp4', ...overrides })
}

function addDefaultSource(): MediaSource {
  const src = mkSource()
  state().addSource(src)
  return src
}

function videoTrackId(): string {
  return state().timeline.tracks.find((t) => t.type === 'video')!.id
}

function audioTrackId(): string {
  return state().timeline.tracks.find((t) => t.type === 'audio')!.id
}

/** Add a clip to the first video track and return its id. */
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
  // Return the ID of the last clip added
  const clips = state().timeline.clips
  return clips[clips.length - 1].id
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('editorStore', () => {
  beforeEach(() => reset())

  // =========================================================================
  // Mode switching
  // =========================================================================

  describe('mode', () => {
    it('defaults to clip mode', () => {
      expect(state().mode).toBe('clip')
    })

    it('switches to edit mode', () => {
      state().setMode('edit')
      expect(state().mode).toBe('edit')
    })

    it('switches to inspect mode', () => {
      state().setMode('inspect')
      expect(state().mode).toBe('inspect')
    })

    it('round-trips through all modes', () => {
      state().setMode('edit')
      state().setMode('inspect')
      state().setMode('clip')
      expect(state().mode).toBe('clip')
    })
  })

  // =========================================================================
  // Project & Sources
  // =========================================================================

  describe('project & sources', () => {
    it('starts with empty sources', () => {
      expect(state().sources).toHaveLength(0)
    })

    it('adds a source', () => {
      addDefaultSource()
      expect(state().sources).toHaveLength(1)
      expect(state().sources[0].id).toBe('src-1')
    })

    it('names project from first source', () => {
      state().addSource(mkSource({ fileName: 'myVideo.mp4' }))
      expect(state().project.name).toBe('myVideo')
    })

    it('does not rename project on second source', () => {
      state().addSource(mkSource({ id: 'a', fileName: 'first.mp4' }))
      state().addSource(mkSource({ id: 'b', fileName: 'second.mp4' }))
      expect(state().project.name).toBe('first')
    })

    it('removes a source', () => {
      addDefaultSource()
      state().removeSource('src-1')
      expect(state().sources).toHaveLength(0)
    })

    it('sets project name', () => {
      state().setProjectName('My Project')
      expect(state().project.name).toBe('My Project')
      expect(state().project.modifiedAt).toBeGreaterThan(0)
    })
  })

  // =========================================================================
  // Track CRUD
  // =========================================================================

  describe('track CRUD', () => {
    it('starts with default V1 and A1 tracks', () => {
      const tracks = state().timeline.tracks
      expect(tracks).toHaveLength(2)
      expect(tracks.find((t) => t.type === 'video')?.name).toBe('V1')
      expect(tracks.find((t) => t.type === 'audio')?.name).toBe('A1')
    })

    it('adds a video track', () => {
      state().addTrack('video')
      const vTracks = state().timeline.tracks.filter((t) => t.type === 'video')
      expect(vTracks).toHaveLength(2)
      expect(vTracks[1].name).toBe('V2')
    })

    it('adds an audio track', () => {
      state().addTrack('audio')
      const aTracks = state().timeline.tracks.filter((t) => t.type === 'audio')
      expect(aTracks).toHaveLength(2)
      expect(aTracks[1].name).toBe('A2')
    })

    it('pushes history on addTrack', () => {
      state().addTrack('video')
      expect(state().history.entries.length).toBeGreaterThan(1)
      expect(state().history.entries.at(-1)!.label).toBe('Add video track')
    })

    it('removes a track and its clips', () => {
      addDefaultSource()
      const vid = videoTrackId()
      addClip(0, 0, 100)
      state().removeTrack(vid)
      expect(state().timeline.tracks.find((t) => t.id === vid)).toBeUndefined()
      expect(state().timeline.clips.filter((c) => c.trackId === vid)).toHaveLength(0)
    })

    it('reorders a track', () => {
      state().addTrack('video')
      const first = state().timeline.tracks.find((t) => t.type === 'video')!
      state().reorderTrack(first.id, 99)
      expect(state().timeline.tracks.find((t) => t.id === first.id)!.index).toBe(99)
    })
  })

  // =========================================================================
  // Clip CRUD
  // =========================================================================

  describe('clip CRUD', () => {
    beforeEach(() => addDefaultSource())

    it('adds a clip', () => {
      addClip(0, 0, 100)
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.duration).toBe(100)
    })

    it('assigns a unique ID to each clip', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 0, 50)
      expect(id1).not.toBe(id2)
    })

    it('removes a clip', () => {
      const id = addClip(0, 0, 100)
      state().removeClip(id)
      expect(state().timeline.clips).toHaveLength(0)
      expect(state().timeline.duration).toBe(0)
    })

    it('removes a clip and clears selection', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().removeClip(id)
      expect(state().selectedClipIds).not.toContain(id)
    })

    it('batch removes clips', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 100, 200)
      state().removeClips([id1, id2])
      expect(state().timeline.clips).toHaveLength(0)
    })

    it('removeClips skips locked clips', () => {
      const id1 = addClip(0, 0, 100, { locked: true })
      const id2 = addClip(100, 100, 200)
      state().removeClips([id1, id2])
      expect(state().timeline.clips).toHaveLength(1)
      expect(state().timeline.clips[0].id).toBe(id1)
    })

    it('removeClips skips clips on locked tracks', () => {
      const id1 = addClip(0, 0, 100)
      // Lock the video track
      const vid = videoTrackId()
      useEditorStore.setState((s) => ({
        timeline: {
          ...s.timeline,
          tracks: s.timeline.tracks.map((t) => t.id === vid ? { ...t, locked: true } : t)
        }
      }))
      state().removeClips([id1])
      expect(state().timeline.clips).toHaveLength(1)
    })
  })

  // =========================================================================
  // Move clip
  // =========================================================================

  describe('moveClip', () => {
    beforeEach(() => addDefaultSource())

    it('moves clip to new position', () => {
      const id = addClip(0, 0, 100)
      state().moveClip(id, videoTrackId(), 50)
      expect(state().timeline.clips[0].timelineStart).toBe(50)
    })

    it('moves clip to different track', () => {
      state().addTrack('video')
      const id = addClip(0, 0, 100)
      const newTrack = state().timeline.tracks.filter((t) => t.type === 'video')[1]
      state().moveClip(id, newTrack.id, 0)
      expect(state().timeline.clips[0].trackId).toBe(newTrack.id)
    })

    it('clamps position to 0', () => {
      const id = addClip(50, 0, 100)
      state().moveClip(id, videoTrackId(), -10)
      expect(state().timeline.clips[0].timelineStart).toBe(0)
    })

    it('does not move locked clip', () => {
      const id = addClip(0, 0, 100, { locked: true })
      state().moveClip(id, videoTrackId(), 50)
      expect(state().timeline.clips[0].timelineStart).toBe(0)
    })

    it('does not move clip on locked track', () => {
      const id = addClip(0, 0, 100)
      const vid = videoTrackId()
      useEditorStore.setState((s) => ({
        timeline: {
          ...s.timeline,
          tracks: s.timeline.tracks.map((t) => t.id === vid ? { ...t, locked: true } : t)
        }
      }))
      state().moveClip(id, vid, 50)
      expect(state().timeline.clips[0].timelineStart).toBe(0)
    })

    it('pushes history', () => {
      const id = addClip(0, 0, 100)
      const before = state().history.currentIndex
      state().moveClip(id, videoTrackId(), 50)
      expect(state().history.currentIndex).toBe(before + 1)
    })
  })

  // =========================================================================
  // Trim clip
  // =========================================================================

  describe('trimClip', () => {
    beforeEach(() => addDefaultSource())

    it('trims the in-point', () => {
      const id = addClip(0, 0, 300)
      state().trimClip(id, 'in', 50)
      const clip = state().timeline.clips[0]
      expect(clip.sourceIn).toBe(50)
      expect(clip.timelineStart).toBe(50)
    })

    it('trims the out-point', () => {
      const id = addClip(0, 0, 300)
      state().trimClip(id, 'out', 200)
      expect(state().timeline.clips[0].sourceOut).toBe(200)
    })

    it('clamps in-point to 0', () => {
      const id = addClip(0, 0, 300)
      state().trimClip(id, 'in', -10)
      expect(state().timeline.clips[0].sourceIn).toBe(0)
    })

    it('ensures out > in', () => {
      const id = addClip(0, 100, 300)
      state().trimClip(id, 'out', 50) // attempt to go below in
      expect(state().timeline.clips[0].sourceOut).toBe(101)
    })

    it('does not trim locked clip', () => {
      const id = addClip(0, 0, 300, { locked: true })
      state().trimClip(id, 'out', 100)
      expect(state().timeline.clips[0].sourceOut).toBe(300)
    })

    it('does not trim clip on locked track', () => {
      const id = addClip(0, 0, 300)
      const vid = videoTrackId()
      useEditorStore.setState((s) => ({
        timeline: {
          ...s.timeline,
          tracks: s.timeline.tracks.map((t) => t.id === vid ? { ...t, locked: true } : t)
        }
      }))
      state().trimClip(id, 'out', 100)
      expect(state().timeline.clips[0].sourceOut).toBe(300)
    })
  })

  // =========================================================================
  // Split clip
  // =========================================================================

  describe('splitClip', () => {
    beforeEach(() => addDefaultSource())

    it('splits a clip at a frame position', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 150)
      const clips = state().timeline.clips
      expect(clips).toHaveLength(2)
      const [a, b] = clips.sort((x, y) => x.timelineStart - y.timelineStart)
      expect(a.sourceIn).toBe(0)
      expect(a.sourceOut).toBe(150)
      expect(b.sourceIn).toBe(150)
      expect(b.sourceOut).toBe(300)
      expect(b.timelineStart).toBe(150)
    })

    it('selects both clips after split', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 150)
      expect(state().selectedClipIds).toHaveLength(2)
    })

    it('does nothing if position is at clip start', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 0)
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('does nothing if position is at clip end', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 300)
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('does nothing if position is outside clip', () => {
      const id = addClip(0, 0, 300)
      state().splitClip(id, 500)
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('does not split locked clip', () => {
      const id = addClip(0, 0, 300, { locked: true })
      state().splitClip(id, 150)
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('handles speed != 1 correctly', () => {
      const id = addClip(0, 0, 300, { speed: 2 })
      // clip duration in timeline frames = (300-0)/2 = 150
      state().splitClip(id, 75)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips).toHaveLength(2)
      // sourceFrame at 75 timeline frames, speed 2: sourceIn + 75 * 2 = 150
      expect(clips[0].sourceOut).toBe(150)
      expect(clips[1].sourceIn).toBe(150)
      expect(clips[1].timelineStart).toBe(75)
    })
  })

  // =========================================================================
  // 7 Edit Types
  // =========================================================================

  describe('insertClip', () => {
    beforeEach(() => addDefaultSource())

    it('inserts at playhead and pushes existing clips right', () => {
      addClip(0, 0, 100)
      const existingId = state().timeline.clips[0].id
      state().insertClip('src-1', [0, 50], 0, videoTrackId())
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips).toHaveLength(2)
      // Existing clip should be pushed right by 50
      const existing = clips.find((c) => c.id === existingId)!
      expect(existing.timelineStart).toBe(50)
      // New clip at 0
      const inserted = clips.find((c) => c.id !== existingId)!
      expect(inserted.timelineStart).toBe(0)
      expect(inserted.sourceOut - inserted.sourceIn).toBe(50)
    })

    it('does not push clips on other tracks', () => {
      addClip(0, 0, 100)
      const aTrack = audioTrackId()
      state().addClip({
        sourceId: 'src-1', trackId: aTrack, timelineStart: 0,
        sourceIn: 0, sourceOut: 100, name: 'A', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      })
      state().insertClip('src-1', [0, 50], 0, videoTrackId())
      const audioClip = state().timeline.clips.find((c) => c.trackId === aTrack)!
      expect(audioClip.timelineStart).toBe(0) // untouched
    })
  })

  describe('overwriteClip', () => {
    beforeEach(() => addDefaultSource())

    it('overwrites the region, removing fully covered clips', () => {
      addClip(10, 10, 60) // 50 frames at position 10-60
      state().overwriteClip('src-1', [0, 100], 0, videoTrackId())
      // The original clip (10-60) is fully covered by 0-100
      const clips = state().timeline.clips
      expect(clips).toHaveLength(1)
      expect(clips[0].sourceIn).toBe(0)
      expect(clips[0].sourceOut).toBe(100)
    })

    it('trims partially overlapping clip', () => {
      addClip(50, 0, 100) // at 50-150
      state().overwriteClip('src-1', [0, 60], 0, videoTrackId()) // region 0-60
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips).toHaveLength(2)
      // The new clip at 0-60
      expect(clips[0].timelineStart).toBe(0)
      expect(clips[0].sourceOut - clips[0].sourceIn).toBe(60)
      // The old clip trimmed: was 50-150 but 50-60 region removed, so starts at 60
      expect(clips[1].timelineStart).toBe(60)
    })
  })

  describe('replaceClip', () => {
    beforeEach(() => {
      state().addSource(mkSource())
      state().addSource(mkSource2())
    })

    it('replaces target with same duration from new source', () => {
      const id = addClip(0, 0, 100) // 100 frame clip
      state().replaceClip('src-2', [0, 200], id)
      const clip = state().timeline.clips[0]
      expect(clip.sourceId).toBe('src-2')
      // Duration matched to original: 100
      expect(clip.sourceOut - clip.sourceIn).toBe(100)
      expect(clip.timelineStart).toBe(0)
    })

    it('does nothing for missing target', () => {
      addClip(0, 0, 100)
      state().replaceClip('src-2', [0, 200], 'nonexistent')
      expect(state().timeline.clips[0].sourceId).toBe('src-1')
    })
  })

  describe('rippleOverwrite', () => {
    beforeEach(() => {
      state().addSource(mkSource())
      state().addSource(mkSource2())
    })

    it('replaces and ripples downstream clips', () => {
      const id = addClip(0, 0, 100) // 100 frames
      addClip(100, 0, 50)           // starts at 100
      state().rippleOverwrite('src-2', [0, 150], id)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[0].sourceId).toBe('src-2')
      expect(clips[0].sourceOut - clips[0].sourceIn).toBe(150)
      // Second clip pushed right by (150-100)=50
      expect(clips[1].timelineStart).toBe(150)
    })

    it('contracts timeline when replacement is shorter', () => {
      const id = addClip(0, 0, 200) // 200 frames
      addClip(200, 0, 50)           // starts at 200
      state().rippleOverwrite('src-2', [0, 100], id)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      // Second clip pulled left by (200-100)=100
      expect(clips[1].timelineStart).toBe(100)
    })
  })

  describe('placeOnTop', () => {
    beforeEach(() => addDefaultSource())

    it('places clip on first available video track', () => {
      addClip(0, 0, 100) // fills V1 at 0-100
      state().placeOnTop('src-1', [0, 50], 0)
      // Should create V2 or use available space
      const clips = state().timeline.clips
      expect(clips).toHaveLength(2)
      const vTracks = state().timeline.tracks.filter((t) => t.type === 'video')
      expect(vTracks.length).toBeGreaterThanOrEqual(2)
    })

    it('uses existing track if no overlap', () => {
      addClip(0, 0, 100) // V1 at 0-100
      state().placeOnTop('src-1', [0, 50], 200) // no overlap at 200
      // Should reuse V1
      const clips = state().timeline.clips
      expect(clips).toHaveLength(2)
      const vTracks = state().timeline.tracks.filter((t) => t.type === 'video')
      expect(vTracks).toHaveLength(1)
    })
  })

  describe('appendClip', () => {
    beforeEach(() => addDefaultSource())

    it('appends to empty track', () => {
      state().appendClip('src-1', [0, 100], videoTrackId())
      expect(state().timeline.clips[0].timelineStart).toBe(0)
    })

    it('appends at end of existing clips', () => {
      addClip(0, 0, 100)
      state().appendClip('src-1', [0, 50], videoTrackId())
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[1].timelineStart).toBe(100)
    })
  })

  describe('fitToFill', () => {
    beforeEach(() => addDefaultSource())

    it('adjusts speed to fill target duration', () => {
      state().fitToFill('src-1', [0, 150], 0, 100, videoTrackId())
      const clip = state().timeline.clips[0]
      // speed = sourceFrames / fillDuration = 150/100 = 1.5
      expect(clip.speed).toBeCloseTo(1.5)
      // clip duration on timeline = (150-0)/1.5 = 100
      const clipDur = (clip.sourceOut - clip.sourceIn) / clip.speed
      expect(clipDur).toBeCloseTo(100)
    })

    it('does nothing for zero source duration', () => {
      state().fitToFill('src-1', [100, 100], 0, 100, videoTrackId())
      expect(state().timeline.clips).toHaveLength(0)
    })

    it('does nothing for zero fill duration', () => {
      state().fitToFill('src-1', [0, 150], 0, 0, videoTrackId())
      expect(state().timeline.clips).toHaveLength(0)
    })

    it('clears overlapping clips in the region', () => {
      addClip(0, 0, 100) // existing clip at 0-100
      state().fitToFill('src-1', [0, 200], 0, 100, videoTrackId())
      // The old clip should have been cleared
      const clips = state().timeline.clips.filter((c) => c.speed === 1)
      expect(clips).toHaveLength(0) // original removed
    })
  })

  // =========================================================================
  // 4 Trim Types
  // =========================================================================

  describe('rollTrim', () => {
    beforeEach(() => addDefaultSource())

    it('moves edit point between two adjacent clips', () => {
      const left = addClip(0, 0, 100)  // 0-100
      const right = addClip(100, 100, 200) // 100-200
      state().rollTrim(left, right, 10)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[0].sourceOut).toBe(110)
      expect(clips[1].sourceIn).toBe(110)
      expect(clips[1].timelineStart).toBe(110)
    })

    it('clamps to prevent zero-length left clip', () => {
      const left = addClip(0, 0, 10)
      const right = addClip(10, 10, 200)
      state().rollTrim(left, right, -20)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      // Left clip should still have at least 1 frame
      expect(clips[0].sourceOut).toBeGreaterThan(clips[0].sourceIn)
    })

    it('clamps to source duration', () => {
      // source duration is 900
      const left = addClip(0, 0, 899)
      const right = addClip(899, 899, 900)
      state().rollTrim(left, right, 10)
      const l = state().timeline.clips.find((c) => c.id === left)!
      expect(l.sourceOut).toBeLessThanOrEqual(900)
    })
  })

  describe('rippleTrim', () => {
    beforeEach(() => addDefaultSource())

    it('extends out-point and shifts downstream clips', () => {
      const id = addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().rippleTrim(id, 'out', 20)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[0].sourceOut).toBe(120)
      expect(clips[1].timelineStart).toBe(120)
    })

    it('shortens out-point and pulls downstream clips left', () => {
      const id = addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().rippleTrim(id, 'out', -20)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[0].sourceOut).toBe(80)
      expect(clips[1].timelineStart).toBe(80)
    })

    it('trims in-point and adjusts downstream', () => {
      const id = addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().rippleTrim(id, 'in', 20)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      expect(clips[0].sourceIn).toBe(20)
      // Downstream should move left because clip got shorter
      expect(clips[1].timelineStart).toBe(80)
    })

    it('clamps in-point to 0', () => {
      const id = addClip(0, 0, 100)
      state().rippleTrim(id, 'in', -50)
      expect(state().timeline.clips[0].sourceIn).toBe(0)
    })
  })

  describe('slipClip', () => {
    beforeEach(() => addDefaultSource())

    it('shifts source in/out without changing timeline position', () => {
      const id = addClip(0, 100, 200) // shows source 100-200
      state().slipClip(id, 30)
      const clip = state().timeline.clips[0]
      expect(clip.sourceIn).toBe(130)
      expect(clip.sourceOut).toBe(230)
      expect(clip.timelineStart).toBe(0)
    })

    it('clamps to prevent sourceIn < 0', () => {
      const id = addClip(0, 10, 110)
      state().slipClip(id, -50)
      const clip = state().timeline.clips[0]
      expect(clip.sourceIn).toBe(0)
      expect(clip.sourceOut).toBe(100)
    })

    it('clamps to source duration', () => {
      // source duration = 900
      const id = addClip(0, 800, 900)
      state().slipClip(id, 50)
      const clip = state().timeline.clips[0]
      expect(clip.sourceOut).toBeLessThanOrEqual(900)
    })
  })

  describe('slideClip', () => {
    beforeEach(() => addDefaultSource())

    it('moves clip and adjusts neighbor edges', () => {
      const left = addClip(0, 0, 100)
      const mid = addClip(100, 100, 200)
      const right = addClip(200, 200, 300)
      state().slideClip(mid, 20)
      const clips = state().timeline.clips.sort((a, b) => a.timelineStart - b.timelineStart)
      // Left neighbor's out-point extended by 20
      expect(clips.find((c) => c.id === left)!.sourceOut).toBe(120)
      // Middle clip moved right
      expect(clips.find((c) => c.id === mid)!.timelineStart).toBe(120)
      // Right neighbor's in-point shifted and start moved
      expect(clips.find((c) => c.id === right)!.sourceIn).toBe(220)
    })

    it('does nothing when delta is 0', () => {
      addClip(0, 0, 100)
      const mid = addClip(100, 100, 200)
      addClip(200, 200, 300)
      const before = structuredClone(state().timeline)
      state().slideClip(mid, 0)
      expect(state().timeline.clips.map((c) => c.timelineStart)).toEqual(
        before.clips.map((c) => c.timelineStart)
      )
    })
  })

  // =========================================================================
  // Clip audio properties
  // =========================================================================

  describe('clip audio properties', () => {
    beforeEach(() => addDefaultSource())

    it('sets volume clamped to [0, 2]', () => {
      const id = addClip(0, 0, 100)
      state().setClipVolume(id, 1.5)
      expect(state().timeline.clips[0].volume).toBe(1.5)
      state().setClipVolume(id, 3)
      expect(state().timeline.clips[0].volume).toBe(2)
      state().setClipVolume(id, -1)
      expect(state().timeline.clips[0].volume).toBe(0)
    })

    it('sets pan clamped to [-1, 1]', () => {
      const id = addClip(0, 0, 100)
      state().setClipPan(id, 0.5)
      expect(state().timeline.clips[0].pan).toBe(0.5)
      state().setClipPan(id, 2)
      expect(state().timeline.clips[0].pan).toBe(1)
      state().setClipPan(id, -2)
      expect(state().timeline.clips[0].pan).toBe(-1)
    })

    it('toggles muted', () => {
      const id = addClip(0, 0, 100)
      expect(state().timeline.clips[0].muted).toBe(false)
      state().toggleClipMuted(id)
      expect(state().timeline.clips[0].muted).toBe(true)
      state().toggleClipMuted(id)
      expect(state().timeline.clips[0].muted).toBe(false)
    })
  })

  // =========================================================================
  // Undo / Redo
  // =========================================================================

  describe('undo / redo', () => {
    beforeEach(() => addDefaultSource())

    it('undo reverts the last action', () => {
      addClip(0, 0, 100)
      expect(state().timeline.clips).toHaveLength(1)
      state().undo()
      expect(state().timeline.clips).toHaveLength(0)
    })

    it('redo re-applies the action', () => {
      addClip(0, 0, 100)
      state().undo()
      state().redo()
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('multiple undo steps', () => {
      addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().undo()
      expect(state().timeline.clips).toHaveLength(1)
      state().undo()
      expect(state().timeline.clips).toHaveLength(0)
    })

    it('undo at beginning does nothing', () => {
      state().undo()
      expect(state().history.currentIndex).toBe(0)
    })

    it('redo at end does nothing', () => {
      addClip(0, 0, 100)
      state().redo()
      // Should stay at the same index
      expect(state().timeline.clips).toHaveLength(1)
    })

    it('new action after undo discards redo history', () => {
      addClip(0, 0, 100)
      addClip(100, 100, 200)
      state().undo()
      addClip(100, 200, 300)
      state().redo() // should do nothing - redo was discarded
      expect(state().timeline.clips).toHaveLength(2)
      // Verify the second clip is the new one, not the old one
      const second = state().timeline.clips.find((c) => c.sourceIn === 200)
      expect(second).toBeDefined()
    })

    it('history respects maxEntries', () => {
      // Push more than 100 entries
      for (let i = 0; i < 110; i++) {
        state().pushHistory(`entry-${i}`)
      }
      // 1 initial + 110 pushed = 111, capped at 100
      expect(state().history.entries.length).toBeLessThanOrEqual(100)
    })

    it('pushHistory creates a snapshot', () => {
      addClip(0, 0, 100)
      state().pushHistory('manual snapshot')
      expect(state().history.entries.at(-1)!.label).toBe('manual snapshot')
    })
  })

  // =========================================================================
  // Selection
  // =========================================================================

  describe('selection', () => {
    beforeEach(() => addDefaultSource())

    it('selects a clip', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      expect(state().selectedClipIds).toEqual([id])
    })

    it('single select replaces previous selection', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 100, 200)
      state().selectClip(id1)
      state().selectClip(id2)
      expect(state().selectedClipIds).toEqual([id2])
    })

    it('multi-select adds to selection', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(100, 100, 200)
      state().selectClip(id1)
      state().selectClip(id2, true)
      expect(state().selectedClipIds).toContain(id1)
      expect(state().selectedClipIds).toContain(id2)
    })

    it('multi-select toggles off existing', () => {
      const id1 = addClip(0, 0, 100)
      state().selectClip(id1)
      state().selectClip(id1, true)
      expect(state().selectedClipIds).not.toContain(id1)
    })

    it('selects a track', () => {
      const vid = videoTrackId()
      state().selectTrack(vid)
      expect(state().selectedTrackId).toBe(vid)
    })

    it('clears selection', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().selectTrack(videoTrackId())
      state().clearSelection()
      expect(state().selectedClipIds).toEqual([])
      expect(state().selectedTrackId).toBeNull()
    })
  })

  // =========================================================================
  // Clip Mode state
  // =========================================================================

  describe('clip mode', () => {
    it('starts with null source', () => {
      expect(state().clipMode.sourceId).toBeNull()
    })

    it('sets clip source and full range', () => {
      state().setClipSource('src-1', 900)
      expect(state().clipMode.sourceId).toBe('src-1')
      expect(state().clipMode.inPoint).toBe(0)
      expect(state().clipMode.outPoint).toBe(900)
    })

    it('sets in point clamped to < outPoint', () => {
      state().setClipSource('src-1', 900)
      state().setClipInPoint(500)
      expect(state().clipMode.inPoint).toBe(500)
      state().setClipInPoint(1000)
      expect(state().clipMode.inPoint).toBe(899) // outPoint - 1
    })

    it('sets out point clamped to > inPoint', () => {
      state().setClipSource('src-1', 900)
      state().setClipInPoint(100)
      state().setClipOutPoint(50)
      expect(state().clipMode.outPoint).toBe(101) // inPoint + 1
    })
  })

  // =========================================================================
  // Playback
  // =========================================================================

  describe('playback', () => {
    it('play / pause / toggle', () => {
      expect(state().playback.isPlaying).toBe(false)
      state().play()
      expect(state().playback.isPlaying).toBe(true)
      state().pause()
      expect(state().playback.isPlaying).toBe(false)
      state().togglePlayback()
      expect(state().playback.isPlaying).toBe(true)
      state().togglePlayback()
      expect(state().playback.isPlaying).toBe(false)
    })

    it('seek clamps to >= 0', () => {
      state().seek(-10)
      expect(state().playback.currentFrame).toBe(0)
      state().seek(500)
      expect(state().playback.currentFrame).toBe(500)
    })

    it('sets playback rate', () => {
      state().setPlaybackRate(2)
      expect(state().playback.playbackRate).toBe(2)
    })

    it('sets in/out points', () => {
      state().setInPoint(100)
      state().setOutPoint(500)
      expect(state().playback.inPoint).toBe(100)
      expect(state().playback.outPoint).toBe(500)
    })

    it('clears in/out points', () => {
      state().setInPoint(100)
      state().setInPoint(null)
      expect(state().playback.inPoint).toBeNull()
    })
  })

  // =========================================================================
  // UI state
  // =========================================================================

  describe('UI state', () => {
    it('sets zoom with clamping', () => {
      state().setZoom(100)
      expect(state().zoom).toBe(100)
      state().setZoom(0)
      expect(state().zoom).toBe(2) // min
      state().setZoom(1000)
      expect(state().zoom).toBe(500) // max
    })

    it('sets scroll with clamping', () => {
      state().setScroll(50, 100)
      expect(state().scrollX).toBe(50)
      expect(state().scrollY).toBe(100)
      state().setScroll(-10, -20)
      expect(state().scrollX).toBe(0)
      expect(state().scrollY).toBe(0)
    })

    it('toggles snap', () => {
      expect(state().snapEnabled).toBe(true)
      state().setSnapEnabled(false)
      expect(state().snapEnabled).toBe(false)
    })

    it('sets active tool', () => {
      state().setActiveTool('razor')
      expect(state().activeTool).toBe('razor')
    })
  })

  // =========================================================================
  // Source selection
  // =========================================================================

  describe('source selection', () => {
    it('selects a source', () => {
      state().selectSource('src-1')
      expect(state().selectedSourceId).toBe('src-1')
    })

    it('clears source selection', () => {
      state().selectSource('src-1')
      state().selectSource(null)
      expect(state().selectedSourceId).toBeNull()
    })
  })

  // =========================================================================
  // Clipboard
  // =========================================================================

  describe('clipboard', () => {
    beforeEach(() => addDefaultSource())

    it('copies selected clips', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().copyClips()
      expect(state().clipboard).toHaveLength(1)
      expect(state().clipboard[0].sourceIn).toBe(0)
    })

    it('cut removes clips and stores in clipboard', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().cutClips()
      expect(state().timeline.clips).toHaveLength(0)
      expect(state().clipboard).toHaveLength(1)
      expect(state().selectedClipIds).toEqual([])
    })

    it('cut skips locked clips', () => {
      const id = addClip(0, 0, 100, { locked: true })
      state().selectClip(id)
      state().cutClips()
      expect(state().timeline.clips).toHaveLength(1) // not removed
      expect(state().clipboard).toHaveLength(0) // nothing cut
    })

    it('paste inserts clipboard clips at position', () => {
      const id = addClip(0, 0, 100)
      state().selectClip(id)
      state().copyClips()
      state().pasteClips(200, videoTrackId())
      expect(state().timeline.clips).toHaveLength(2)
      const pasted = state().timeline.clips.find((c) => c.timelineStart === 200)
      expect(pasted).toBeDefined()
      expect(pasted!.id).not.toBe(id) // new ID
    })

    it('paste with multiple clips preserves relative positions', () => {
      const id1 = addClip(0, 0, 100)
      const id2 = addClip(200, 200, 300) // gap of 100
      state().selectClip(id1)
      state().selectClip(id2, true)
      state().copyClips()
      state().pasteClips(500, videoTrackId())
      const pasted = state().timeline.clips.filter((c) => c.timelineStart >= 500)
      expect(pasted).toHaveLength(2)
      const starts = pasted.map((c) => c.timelineStart).sort((a, b) => a - b)
      // 500 + (0-0)=500 and 500 + (200-0)=700
      expect(starts).toEqual([500, 700])
    })

    it('paste does nothing with empty clipboard', () => {
      addClip(0, 0, 100)
      state().pasteClips(200, videoTrackId())
      expect(state().timeline.clips).toHaveLength(1)
    })
  })

  // =========================================================================
  // Reset
  // =========================================================================

  describe('resetEditor', () => {
    it('resets all state to defaults', () => {
      addDefaultSource()
      addClip(0, 0, 100)
      state().setMode('edit')
      state().selectClip(state().timeline.clips[0].id)
      state().resetEditor()

      expect(state().mode).toBe('clip')
      expect(state().sources).toHaveLength(0)
      expect(state().timeline.clips).toHaveLength(0)
      expect(state().timeline.tracks).toHaveLength(2) // fresh V1+A1
      expect(state().selectedClipIds).toEqual([])
      expect(state().history.currentIndex).toBe(0)
      expect(state().clipboard).toEqual([])
    })
  })

  // =========================================================================
  // Pure trim helper functions (exported)
  // =========================================================================

  describe('applyRollTrim (pure)', () => {
    const sources: MediaSource[] = [mkSource()]

    function mkTimeline(clips: TimelineClip[]): Timeline {
      return {
        tracks: [{ id: 't1', type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true }],
        clips,
        duration: clips.length ? Math.max(...clips.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn))) : 0
      }
    }

    function mkClip(id: string, start: number, srcIn: number, srcOut: number): TimelineClip {
      return {
        id, sourceId: 'src-1', trackId: 't1', timelineStart: start,
        sourceIn: srcIn, sourceOut: srcOut, name: 'C', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      }
    }

    it('moves the edit point by delta', () => {
      const tl = mkTimeline([mkClip('L', 0, 0, 100), mkClip('R', 100, 100, 200)])
      const result = applyRollTrim(tl, sources, 'L', 'R', 10)
      const L = result.clips.find((c) => c.id === 'L')!
      const R = result.clips.find((c) => c.id === 'R')!
      expect(L.sourceOut).toBe(110)
      expect(R.sourceIn).toBe(110)
      expect(R.timelineStart).toBe(110)
    })

    it('returns timeline unchanged for missing clips', () => {
      const tl = mkTimeline([mkClip('L', 0, 0, 100)])
      const result = applyRollTrim(tl, sources, 'L', 'MISSING', 10)
      expect(result).toBe(tl)
    })
  })

  describe('applyRippleTrim (pure)', () => {
    const sources: MediaSource[] = [mkSource()]

    function mkTimeline(clips: TimelineClip[]): Timeline {
      return {
        tracks: [{ id: 't1', type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true }],
        clips,
        duration: clips.length ? Math.max(...clips.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn))) : 0
      }
    }

    function mkClip(id: string, start: number, srcIn: number, srcOut: number): TimelineClip {
      return {
        id, sourceId: 'src-1', trackId: 't1', timelineStart: start,
        sourceIn: srcIn, sourceOut: srcOut, name: 'C', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      }
    }

    it('ripple extends out-point and shifts downstream', () => {
      const tl = mkTimeline([mkClip('A', 0, 0, 100), mkClip('B', 100, 100, 200)])
      const result = applyRippleTrim(tl, sources, 'A', 'out', 20)
      expect(result.clips.find((c) => c.id === 'A')!.sourceOut).toBe(120)
      expect(result.clips.find((c) => c.id === 'B')!.timelineStart).toBe(120)
    })

    it('ripple trims in-point', () => {
      const tl = mkTimeline([mkClip('A', 0, 0, 100), mkClip('B', 100, 100, 200)])
      const result = applyRippleTrim(tl, sources, 'A', 'in', 20)
      expect(result.clips.find((c) => c.id === 'A')!.sourceIn).toBe(20)
      // Downstream clips shift left
      expect(result.clips.find((c) => c.id === 'B')!.timelineStart).toBe(80)
    })
  })

  describe('applySlip (pure)', () => {
    const sources: MediaSource[] = [mkSource()]

    function mkTimeline(clips: TimelineClip[]): Timeline {
      return {
        tracks: [{ id: 't1', type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true }],
        clips,
        duration: clips.length ? Math.max(...clips.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn))) : 0
      }
    }

    function mkClip(id: string, start: number, srcIn: number, srcOut: number): TimelineClip {
      return {
        id, sourceId: 'src-1', trackId: 't1', timelineStart: start,
        sourceIn: srcIn, sourceOut: srcOut, name: 'C', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      }
    }

    it('shifts source window without changing timeline position', () => {
      const tl = mkTimeline([mkClip('A', 0, 100, 200)])
      const result = applySlip(tl, sources, 'A', 50)
      const clip = result.clips[0]
      expect(clip.sourceIn).toBe(150)
      expect(clip.sourceOut).toBe(250)
      expect(clip.timelineStart).toBe(0) // unchanged
    })

    it('clamps to prevent going below 0', () => {
      const tl = mkTimeline([mkClip('A', 0, 10, 110)])
      const result = applySlip(tl, sources, 'A', -50)
      expect(result.clips[0].sourceIn).toBe(0)
      expect(result.clips[0].sourceOut).toBe(100)
    })
  })

  describe('applySlide (pure)', () => {
    const sources: MediaSource[] = [mkSource()]

    function mkTimeline(clips: TimelineClip[]): Timeline {
      return {
        tracks: [{ id: 't1', type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true }],
        clips,
        duration: clips.length ? Math.max(...clips.map((c) => c.timelineStart + (c.sourceOut - c.sourceIn))) : 0
      }
    }

    function mkClip(id: string, start: number, srcIn: number, srcOut: number): TimelineClip {
      return {
        id, sourceId: 'src-1', trackId: 't1', timelineStart: start,
        sourceIn: srcIn, sourceOut: srcOut, name: 'C', color: '', muted: false,
        locked: false, volume: 1, pan: 0, speed: 1
      }
    }

    it('slides clip, adjusting neighbour edges', () => {
      const tl = mkTimeline([
        mkClip('L', 0, 0, 100),
        mkClip('M', 100, 100, 200),
        mkClip('R', 200, 200, 300)
      ])
      const result = applySlide(tl, sources, 'M', 20)
      const L = result.clips.find((c) => c.id === 'L')!
      const M = result.clips.find((c) => c.id === 'M')!
      const R = result.clips.find((c) => c.id === 'R')!
      expect(L.sourceOut).toBe(120)
      expect(M.timelineStart).toBe(120)
      expect(R.sourceIn).toBe(220)
    })

    it('returns unchanged for missing clip', () => {
      const tl = mkTimeline([mkClip('A', 0, 0, 100)])
      const result = applySlide(tl, sources, 'NOPE', 10)
      expect(result).toBe(tl)
    })
  })

  // =========================================================================
  // Timeline duration auto-calculation
  // =========================================================================

  describe('timeline duration', () => {
    beforeEach(() => addDefaultSource())

    it('updates duration when clips are added', () => {
      addClip(0, 0, 100)
      expect(state().timeline.duration).toBe(100)
      addClip(100, 0, 50)
      expect(state().timeline.duration).toBe(150)
    })

    it('recalculates on clip removal', () => {
      addClip(0, 0, 100)
      const id2 = addClip(100, 0, 50)
      state().removeClip(id2)
      expect(state().timeline.duration).toBe(100)
    })

    it('accounts for speed', () => {
      addClip(0, 0, 100, { speed: 2 })
      // duration = (100-0)/2 = 50
      expect(state().timeline.duration).toBe(50)
    })

    it('is 0 for empty timeline', () => {
      expect(state().timeline.duration).toBe(0)
    })
  })
})
