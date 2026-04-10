/**
 * @module editor/edit/Preview
 * Edit-mode multi-track preview.
 *
 * Plays ALL clips under the playhead simultaneously:
 * - Topmost visible video clip is shown in <video> element (fills preview area)
 * - All audio clips (including video's embedded audio) play via hidden
 *   <audio>/<video> elements with Web Audio API gain/pan nodes for per-clip
 *   volume and pan control.
 * - Preview URLs are pre-cached for all video sources so toggling track
 *   visibility switches instantly without async reload.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTimecode, framesToSeconds } from '../shared/TimeDisplay'
import { Waveform } from '../shared/Waveform'
import { SpatialCanvas } from '../preview/SpatialCanvas'
import type { MediaSource, TimelineClip } from '../types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ClipHit {
  clip: TimelineClip
  source: MediaSource
  trackType: 'video' | 'audio'
}

/** Collect every clip under the playhead, grouped by priority (video first, descending index). */
function clipsAtPlayhead(
  timeline: { tracks: { id: string; type: string; index: number; muted: boolean; visible?: boolean }[]; clips: TimelineClip[] },
  currentFrame: number,
  sources: MediaSource[]
): ClipHit[] {
  const hits: ClipHit[] = []
  const sorted = [...timeline.tracks].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'video' ? -1 : 1
    return b.index - a.index
  })

  for (const track of sorted) {
    if (track.muted) continue
    if (track.type === 'video' && track.visible === false) continue
    for (const clip of timeline.clips) {
      if (clip.trackId !== track.id || clip.muted) continue
      const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
      if (currentFrame >= clip.timelineStart && currentFrame < clip.timelineStart + dur) {
        const source = sources.find((s) => s.id === clip.sourceId)
        if (source) hits.push({ clip, source, trackType: track.type as 'video' | 'audio' })
      }
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Audio handle - one per clip on an AUDIO track.
// Video track audio comes from the <video> element directly.
// ---------------------------------------------------------------------------

interface AudioHandle {
  clipId: string
  sourceId: string
  audioEl: HTMLAudioElement
  mediaNode: MediaElementAudioSourceNode | null
  gainNode: GainNode
  panNode: StereoPannerNode
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Preview(): React.JSX.Element {
  const playback = useEditorStore((s) => s.playback)
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const resolution = useEditorStore((s) => s.project.resolution)

  // ---- Derived hit lists ----
  const hits = useMemo(
    () => clipsAtPlayhead(timeline, playback.currentFrame, sources),
    [timeline, sources, playback.currentFrame]
  )

  // Topmost VISIBLE video hit → which source the <video> element displays
  const videoHit = hits.find((h) => h.trackType === 'video' && h.source.width > 0) ?? null

  // All clips that produce audio EXCEPT the topmost video (handled by <video> element)
  const allAudioHits = useMemo(() => {
    return hits.filter((h) => {
      if (h.source.audioChannels <= 0 && h.trackType === 'video') return false
      // Skip the topmost video clip - its audio comes from the <video> element
      if (videoHit && h.clip.id === videoHit.clip.id) return false
      return h.trackType === 'audio' || h.source.audioChannels > 0
    })
  }, [hits, videoHit])

  // ---------- Spatial compositing detection ----------
  // Activate spatial mode if ANY clip has a transform, keyframes, or blend mode
  const spatialMode = useMemo(() => {
    return timeline.clips.some(
      (c) => c.transform || (c.keyframes && c.keyframes.length > 0) || (c.blendMode && c.blendMode !== 'normal')
    )
  }, [timeline.clips])

  // All video hits (not just topmost) — needed for spatial canvas
  const allVideoHits = useMemo(() => {
    return hits.filter((h) => h.trackType === 'video' && h.source.width > 0)
  }, [hits])

  // ---------- Pre-cache preview URLs for all video sources ----------
  const urlCacheRef = useRef<Map<string, string>>(new Map())
  const pendingUrlsRef = useRef<Set<string>>(new Set())

  // Collect unique video source IDs
  const videoSourceIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of sources) {
      if (s.width > 0) ids.add(s.id)
    }
    return ids
  }, [sources])

  // Fetch URLs for any video sources not yet cached
  useEffect(() => {
    for (const src of sources) {
      if (!videoSourceIds.has(src.id)) continue
      if (urlCacheRef.current.has(src.id)) continue
      if (pendingUrlsRef.current.has(src.id)) continue

      pendingUrlsRef.current.add(src.id)
      window.api.createPreview(src.filePath).then((r) => {
        pendingUrlsRef.current.delete(src.id)
        if (r?.success && r.data) {
          urlCacheRef.current.set(src.id, r.data)
          // If the current videoHit is waiting for this URL, trigger a re-render
          const currentVideoHit = videoHitRef.current
          if (currentVideoHit?.source.id === src.id && !loadedSourceRef.current) {
            loadedSourceRef.current = src.id
            setActiveVideoUrl(r.data)
          }
        }
      })
    }
  }, [videoSourceIds, sources])

  // ---------- Primary video element ----------
  const videoRef = useRef<HTMLVideoElement>(null)
  const [activeVideoUrl, setActiveVideoUrl] = useState('')
  const loadedSourceRef = useRef<string | null>(null)
  const videoHitRef = useRef(videoHit)
  videoHitRef.current = videoHit

  // Switch video source instantly using cached URL when videoHit changes
  useEffect(() => {
    if (!videoHit) {
      // No visible video - don't unload, just leave the element idle
      loadedSourceRef.current = null
      setActiveVideoUrl('')
      return
    }
    if (loadedSourceRef.current === videoHit.source.id) return

    const cachedUrl = urlCacheRef.current.get(videoHit.source.id)
    if (cachedUrl) {
      loadedSourceRef.current = videoHit.source.id
      setActiveVideoUrl(cachedUrl)
    } else {
      // URL not cached yet - fetch it.  Don't set loadedSourceRef until
      // the URL actually loads so the pre-cache callback can also set it.
      window.api.createPreview(videoHit.source.filePath).then((r) => {
        if (r?.success && r.data) {
          urlCacheRef.current.set(videoHit.source.id, r.data)
          // Guard: videoHit may have changed while awaited
          if (videoHitRef.current?.source.id === videoHit.source.id) {
            loadedSourceRef.current = videoHit.source.id
            setActiveVideoUrl(r.data)
          }
        }
      })
    }
  }, [videoHit?.source.id])

  // Load URL into <video> element
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (!activeVideoUrl) {
      // Pause but don't clear src - avoids reload when same source reappears
      el.pause()
      return
    }
    if (el.src !== activeVideoUrl) {
      el.src = activeVideoUrl
      el.load()
    }
    // Seek to correct position
    const vHit = videoHitRef.current
    if (vHit) {
      const offsetFrames = (useEditorStore.getState().playback.currentFrame - vHit.clip.timelineStart) * vHit.clip.speed
      const sourceFrame = vHit.clip.sourceIn + offsetFrames
      el.currentTime = framesToSeconds(sourceFrame, vHit.source.frameRate || frameRate)
    }
    // Play if playback is active
    if (useEditorStore.getState().playback.isPlaying) {
      el.play().catch(() => {})
    }
  }, [activeVideoUrl, frameRate])

  // Seek video when paused (scrubbing)
  const seekingVideoRef = useRef(false)
  useEffect(() => {
    const el = videoRef.current
    if (!el || !videoHit || !activeVideoUrl || !el.paused || seekingVideoRef.current) return
    const offsetFrames = (playback.currentFrame - videoHit.clip.timelineStart) * videoHit.clip.speed
    const sourceFrame = videoHit.clip.sourceIn + offsetFrames
    const targetTime = framesToSeconds(sourceFrame, videoHit.source.frameRate || frameRate)
    if (Math.abs(el.currentTime - targetTime) < 0.02) return
    seekingVideoRef.current = true
    el.currentTime = targetTime
    const onSeeked = (): void => { seekingVideoRef.current = false; el.removeEventListener('seeked', onSeeked) }
    el.addEventListener('seeked', onSeeked)
  }, [playback.currentFrame, videoHit, activeVideoUrl, frameRate])

  // ---------- Spatial mode: hidden <video> element pool ----------
  // One hidden <video> per unique video source so SpatialCanvas can composite all layers.
  const spatialVideoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const [spatialVideoElements, setSpatialVideoElements] = useState<Map<string, HTMLVideoElement>>(new Map())

  // Create / destroy pool entries when video sources change while in spatial mode
  useEffect(() => {
    if (!spatialMode) {
      // Tear down pool when leaving spatial mode
      for (const [, el] of spatialVideoPoolRef.current) {
        el.pause()
        el.src = ''
        el.remove()
      }
      spatialVideoPoolRef.current.clear()
      setSpatialVideoElements(new Map())
      return
    }

    const pool = spatialVideoPoolRef.current
    const neededIds = new Set(videoSourceIds)
    let changed = false

    // Remove elements for sources no longer in the project
    for (const [id, el] of pool) {
      if (!neededIds.has(id)) {
        el.pause()
        el.src = ''
        el.remove()
        pool.delete(id)
        changed = true
      }
    }

    // Create elements for new video sources
    for (const src of sources) {
      if (!neededIds.has(src.id)) continue
      if (pool.has(src.id)) continue

      const el = document.createElement('video')
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      el.playsInline = true
      el.muted = true // audio comes from existing Web Audio pipeline
      el.style.display = 'none'
      document.body.appendChild(el)
      pool.set(src.id, el)
      changed = true

      // Set source URL from cache or fetch
      const cachedUrl = urlCacheRef.current.get(src.id)
      if (cachedUrl) {
        el.src = cachedUrl
      } else {
        window.api.createPreview(src.filePath).then((r) => {
          if (r?.success && r.data) {
            urlCacheRef.current.set(src.id, r.data)
            if (pool.has(src.id)) {
              el.src = r.data
            }
          }
        })
      }
    }

    if (changed) {
      setSpatialVideoElements(new Map(pool))
    }
  }, [spatialMode, videoSourceIds, sources])

  // Seek pool video elements when PAUSED (scrubbing only)
  useEffect(() => {
    if (!spatialMode || playback.isPlaying) return
    const pool = spatialVideoPoolRef.current
    for (const hit of allVideoHits) {
      const el = pool.get(hit.source.id)
      if (!el || !el.src) continue
      const offsetFrames = (playback.currentFrame - hit.clip.timelineStart) * hit.clip.speed
      const sourceFrame = hit.clip.sourceIn + offsetFrames
      const targetTime = framesToSeconds(sourceFrame, hit.source.frameRate || frameRate)
      if (Math.abs(el.currentTime - targetTime) > 0.02) {
        el.currentTime = targetTime
      }
    }
  }, [spatialMode, playback.isPlaying, playback.currentFrame, allVideoHits, frameRate])

  // Play/pause pool elements in sync — seek to correct position once on play start
  const prevIsPlayingRef = useRef(false)
  useEffect(() => {
    if (!spatialMode) return
    const pool = spatialVideoPoolRef.current
    const state = useEditorStore.getState()
    const justStarted = playback.isPlaying && !prevIsPlayingRef.current
    prevIsPlayingRef.current = playback.isPlaying

    if (playback.isPlaying) {
      // Seek each pool video to correct position and play
      for (const hit of allVideoHits) {
        const el = pool.get(hit.source.id)
        if (!el || !el.src) continue
        const offsetFrames = (state.playback.currentFrame - hit.clip.timelineStart) * hit.clip.speed
        const sourceFrame = hit.clip.sourceIn + offsetFrames
        const targetTime = framesToSeconds(sourceFrame, hit.source.frameRate || frameRate)
        el.playbackRate = hit.clip.speed * (state.playback.playbackRate || 1)
        if (justStarted || Math.abs(el.currentTime - targetTime) > 0.5) {
          el.currentTime = targetTime
        }
        if (el.paused) el.play().catch(() => {})
      }
    } else {
      for (const [, el] of pool) {
        el.pause()
      }
    }
  }, [spatialMode, playback.isPlaying, allVideoHits, frameRate])

  // Cleanup pool on unmount
  useEffect(() => {
    return () => {
      for (const [, el] of spatialVideoPoolRef.current) {
        el.pause()
        el.src = ''
        el.remove()
      }
      spatialVideoPoolRef.current.clear()
    }
  }, [])

  // ---------- RAF loop: advance currentFrame during playback ----------
  const rafRef = useRef(0)
  const lastTickTime = useRef(performance.now())
  const frameAccumulator = useRef(0)
  const lastDrivenClipIdRef = useRef<string | null>(null)
  const videoClipSeeking = useRef(false)

  useEffect(() => {
    const tick = (): void => {
      const state = useEditorStore.getState()
      // Only drive playback when edit mode is active
      if (state.mode !== 'edit' || !state.playback.isPlaying || state.playback.isScrubbing) {
        lastTickTime.current = performance.now()
        frameAccumulator.current = 0
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const now = performance.now()

      // Drive frame from the video element when it's playing the visible hit
      const vid = videoRef.current
      const vHit = videoHitRef.current
      if (vid && vHit && !vid.paused && vid.readyState >= 2 && !videoClipSeeking.current) {
        const clipSwitched = vHit.clip.id !== lastDrivenClipIdRef.current

        if (clipSwitched) {
          // Clip boundary crossed (razor cut / rearranged segment) - seek
          // the video element to the correct source position for the new clip
          lastDrivenClipIdRef.current = vHit.clip.id
          videoClipSeeking.current = true
          const off = (state.playback.currentFrame - vHit.clip.timelineStart) * vHit.clip.speed
          const sf = vHit.clip.sourceIn + off
          const sourceFr = vHit.source.frameRate || frameRate
          vid.currentTime = framesToSeconds(sf, sourceFr)
          vid.addEventListener('seeked', () => { videoClipSeeking.current = false }, { once: true })
          lastTickTime.current = now
          frameAccumulator.current = 0
        } else {
          const sourceTime = vid.currentTime
          const sourceFr = vHit.source.frameRate || frameRate
          const sourceFrame = Math.round(sourceTime * sourceFr)

          if (sourceFrame >= vHit.clip.sourceOut) {
            // Video reached end of this clip - advance timeline to clip boundary
            const clipEnd = vHit.clip.timelineStart +
              Math.ceil((vHit.clip.sourceOut - vHit.clip.sourceIn) / vHit.clip.speed)
            lastDrivenClipIdRef.current = null // force re-sync on next clip
            if (clipEnd >= state.timeline.duration) {
              state.pause()
              state.seek(state.timeline.duration)
            } else {
              state.seek(clipEnd)
            }
          } else {
            const offsetFrames = (sourceFrame - vHit.clip.sourceIn) / vHit.clip.speed
            const timelineFrame = Math.round(vHit.clip.timelineStart + offsetFrames)
            if (timelineFrame !== state.playback.currentFrame) {
              state.seek(timelineFrame)
            }
          }
          lastTickTime.current = now
          frameAccumulator.current = 0
        }
      } else if (videoClipSeeking.current) {
        // Mid-seek for clip switch - hold frame, keep timers fresh
        lastTickTime.current = now
        frameAccumulator.current = 0
      } else {
        // Wall-clock fallback (audio-only or during video switch)
        const elapsed = now - lastTickTime.current
        lastTickTime.current = now
        const clampedElapsed = Math.min(elapsed, 100)
        frameAccumulator.current += (clampedElapsed / 1000) * frameRate * (state.playback.playbackRate || 1)
        const wholeFrames = Math.floor(frameAccumulator.current)
        if (wholeFrames >= 1) {
          frameAccumulator.current -= wholeFrames
          const newFrame = state.playback.currentFrame + wholeFrames
          if (newFrame >= state.timeline.duration) {
            state.pause()
            state.seek(state.timeline.duration)
          } else {
            state.seek(newFrame)
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [frameRate])

  // ---------- Video element audio via Web Audio (gain/pan) ----------
  const audioCtxRef = useRef<AudioContext | null>(null)
  const videoAudioRef = useRef<{
    source: MediaElementAudioSourceNode
    gain: GainNode
    pan: StereoPannerNode
  } | null>(null)

  const ensureAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext()
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume()
    }
    return audioCtxRef.current
  }, [])

  /** Connect the <video> element to Web Audio once (gain + pan control). */
  const ensureVideoAudio = useCallback((): void => {
    if (videoAudioRef.current) return
    const el = videoRef.current
    if (!el) return
    const ctx = ensureAudioCtx()
    const source = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    const pan = ctx.createStereoPanner()
    source.connect(gain).connect(pan).connect(ctx.destination)
    videoAudioRef.current = { source, gain, pan }
  }, [ensureAudioCtx])

  // Update video audio gain/pan from the active video clip
  useEffect(() => {
    if (!videoHit) {
      if (videoAudioRef.current) videoAudioRef.current.gain.gain.value = 0
      return
    }
    if (!videoRef.current) return
    ensureVideoAudio()
    const va = videoAudioRef.current
    if (!va) return
    va.gain.gain.value = Math.max(0, Math.min(4, videoHit.clip.volume))
    va.pan.pan.value = Math.max(-1, Math.min(1, videoHit.clip.pan))
  }, [videoHit?.clip.id, videoHit?.clip.volume, videoHit?.clip.pan, ensureVideoAudio])

  // ---------- Audio handles (<audio> elements routed through Web Audio) ----------
  const audioHandlesRef = useRef<Map<string, AudioHandle>>(new Map())
  const allAudioHitsRef = useRef(allAudioHits)
  allAudioHitsRef.current = allAudioHits

  function startHandlePlayback(handle: AudioHandle): void {
    const hit = allAudioHitsRef.current.find((h) => h.clip.id === handle.clipId)
    if (!hit) return

    // Lazily connect to Web Audio on first play
    if (!handle.mediaNode) {
      const ctx = ensureAudioCtx()
      const mn = ctx.createMediaElementSource(handle.audioEl)
      mn.connect(handle.gainNode)
      handle.mediaNode = mn
    }

    const state = useEditorStore.getState()
    const fr = hit.source.frameRate || state.project.frameRate
    const offsetFrames = (state.playback.currentFrame - hit.clip.timelineStart) * hit.clip.speed
    const sourceFrame = hit.clip.sourceIn + offsetFrames
    const offsetSec = Math.max(0, framesToSeconds(sourceFrame, fr))
    const el = handle.audioEl

    const doPlay = (): void => {
      el.currentTime = offsetSec
      el.playbackRate = hit.clip.speed
      el.play().catch((e) => console.warn('[Preview] Audio play failed:', e))
    }

    if (el.readyState >= 2) {
      doPlay()
    } else if (el.src) {
      el.addEventListener('canplay', doPlay, { once: true })
    }
  }

  function stopHandlePlayback(handle: AudioHandle): void {
    handle.audioEl.pause()
  }

  // Prepare audio URL for a source (fetches preview URL if needed)
  const preparingSourcesRef = useRef<Set<string>>(new Set())
  const audioSrcCacheRef = useRef<Map<string, string>>(new Map())

  async function ensureAudioSrc(sourceId: string, filePath: string): Promise<string | null> {
    if (audioSrcCacheRef.current.has(sourceId)) return audioSrcCacheRef.current.get(sourceId)!
    if (preparingSourcesRef.current.has(sourceId)) return null
    preparingSourcesRef.current.add(sourceId)
    try {
      // Use existing preview URL if available
      const cached = urlCacheRef.current.get(sourceId)
      if (cached) {
        audioSrcCacheRef.current.set(sourceId, cached)
        return cached
      }
      // Fetch a preview URL
      const r = await window.api.createPreview(filePath)
      if (r?.success && r.data) {
        urlCacheRef.current.set(sourceId, r.data)
        audioSrcCacheRef.current.set(sourceId, r.data)
        return r.data
      }
      return null
    } finally {
      preparingSourcesRef.current.delete(sourceId)
    }
  }

  // ---------- Manage audio handles for audio-track clips ----------
  const neededClipIds = useMemo(
    () => allAudioHits.map((h) => h.clip.id).sort().join(','),
    [allAudioHits]
  )

  useEffect(() => {
    const existing = audioHandlesRef.current
    const needed = new Set(neededClipIds.split(',').filter(Boolean))

    // Tear down handles for clips no longer under playhead
    for (const [id, handle] of existing) {
      if (!needed.has(id)) {
        stopHandlePlayback(handle)
        handle.mediaNode?.disconnect()
        handle.gainNode.disconnect()
        handle.panNode.disconnect()
        handle.audioEl.src = ''
        handle.audioEl.remove()
        existing.delete(id)
      }
    }

    // Create handles for new clips
    for (const hit of allAudioHits) {
      if (existing.has(hit.clip.id)) continue

      const ctx = ensureAudioCtx()
      const gainNode = ctx.createGain()
      const panNode = ctx.createStereoPanner()
      gainNode.connect(panNode).connect(ctx.destination)

      const el = document.createElement('audio')
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      el.style.display = 'none'
      document.body.appendChild(el)

      const handle: AudioHandle = {
        clipId: hit.clip.id,
        sourceId: hit.source.id,
        audioEl: el,
        mediaNode: null,
        gainNode,
        panNode
      }
      existing.set(hit.clip.id, handle)

      // Set source URL
      const cachedUrl = audioSrcCacheRef.current.get(hit.source.id) ?? urlCacheRef.current.get(hit.source.id)
      if (cachedUrl) {
        el.src = cachedUrl
      } else {
        ensureAudioSrc(hit.source.id, hit.source.filePath).then((url) => {
          if (url && existing.has(hit.clip.id)) {
            el.src = url
            // If playing, start this handle
            if (useEditorStore.getState().playback.isPlaying) {
              startHandlePlayback(handle)
            }
          }
        })
      }

      // If currently playing, start immediately
      if (useEditorStore.getState().playback.isPlaying && el.src) {
        startHandlePlayback(handle)
      }
    }
  }, [neededClipIds])

  // ---------- Update gain/pan for audio handles ----------
  useEffect(() => {
    for (const hit of allAudioHits) {
      const handle = audioHandlesRef.current.get(hit.clip.id)
      if (!handle) continue
      handle.gainNode.gain.value = Math.max(0, Math.min(4, hit.clip.volume))
      handle.panNode.pan.value = Math.max(-1, Math.min(1, hit.clip.pan))
    }
  }, [allAudioHits, playback.currentFrame])

  // ---------- Detect seek during playback → restart audio sources ----------
  const lastAudioSyncFrameRef = useRef(0)
  useEffect(() => {
    if (!playback.isPlaying) {
      lastAudioSyncFrameRef.current = playback.currentFrame
      return
    }
    const drift = Math.abs(playback.currentFrame - lastAudioSyncFrameRef.current)
    lastAudioSyncFrameRef.current = playback.currentFrame
    // >5 frames jump = user seek; restart all audio at new position
    if (drift > 5) {
      for (const [, handle] of audioHandlesRef.current) {
        startHandlePlayback(handle)
      }
    }
  }, [playback.currentFrame, playback.isPlaying])

  // ---------- Play / Pause all elements in sync ----------
  const isPlaying = playback.isPlaying
  const prevPlaying = useRef(false)
  useEffect(() => {
    if (isPlaying === prevPlaying.current) return
    prevPlaying.current = isPlaying

    lastTickTime.current = performance.now()
    frameAccumulator.current = 0
    videoClipSeeking.current = false

    const vid = videoRef.current
    if (vid && activeVideoUrl) {
      if (isPlaying) {
        ensureVideoAudio()
        const vHit = videoHitRef.current
        if (vHit) {
          lastDrivenClipIdRef.current = vHit.clip.id
          const offsetFrames = (useEditorStore.getState().playback.currentFrame - vHit.clip.timelineStart) * vHit.clip.speed
          const sourceFrame = vHit.clip.sourceIn + offsetFrames
          vid.currentTime = framesToSeconds(sourceFrame, vHit.source.frameRate || frameRate)
        }
        vid.play().catch(() => {})
      } else {
        vid.pause()
      }
    }

    // Audio track handles
    if (isPlaying) {
      ensureAudioCtx()
      lastAudioSyncFrameRef.current = useEditorStore.getState().playback.currentFrame
      for (const [, handle] of audioHandlesRef.current) {
        startHandlePlayback(handle)
      }
    } else {
      for (const [, handle] of audioHandlesRef.current) {
        stopHandlePlayback(handle)
      }
    }
  }, [isPlaying, activeVideoUrl, ensureAudioCtx, ensureVideoAudio])

  // ---------- Cleanup on unmount ----------
  useEffect(() => {
    return () => {
      for (const [, handle] of audioHandlesRef.current) {
        stopHandlePlayback(handle)
        handle.mediaNode?.disconnect()
        handle.gainNode.disconnect()
        handle.panNode.disconnect()
        handle.audioEl.src = ''
        handle.audioEl.remove()
      }
      audioHandlesRef.current.clear()
      if (videoAudioRef.current) {
        videoAudioRef.current.source.disconnect()
        videoAudioRef.current.gain.disconnect()
        videoAudioRef.current.pan.disconnect()
      }
      audioCtxRef.current?.close()
    }
  }, [])

  // ---------- Play/Pause toggle ----------
  const togglePlayback = useCallback(() => {
    ensureAudioCtx()
    const store = useEditorStore.getState()
    if (store.playback.isPlaying) store.pause()
    else store.play()
  }, [ensureAudioCtx])

  // ---------- Keyboard shortcuts ----------
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onKeyDown = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault()
          togglePlayback()
          break
        case 'arrowleft':
          e.preventDefault()
          useEditorStore.getState().seek(playback.currentFrame + (e.shiftKey ? -10 : -1))
          break
        case 'arrowright':
          e.preventDefault()
          useEditorStore.getState().seek(playback.currentFrame + (e.shiftKey ? 10 : 1))
          break
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [togglePlayback, playback.currentFrame])

  // Container size for audio-only waveform
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const audioOnlyHit = !videoHit ? hits.find((h) => h.trackType === 'audio') : null

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="relative flex flex-col items-center justify-center h-full bg-black/30 rounded-lg overflow-hidden outline-none focus:ring-1 focus:ring-accent-500/30"
    >
      {/* Video element - always mounted, hidden when spatial canvas takes over */}
      <video
        ref={videoRef}
        className={
          videoHit && activeVideoUrl && !spatialMode
            ? 'max-w-full max-h-[calc(100%-32px)] object-contain'
            : 'absolute w-0 h-0 opacity-0 pointer-events-none'
        }
        crossOrigin="anonymous"
        preload="auto"
        playsInline
      />

      {/* Spatial compositing canvas — overlays all video layers with transforms */}
      {spatialMode && containerSize && containerSize.w > 0 && containerSize.h > 0 && (
        <SpatialCanvas
          videoElements={spatialVideoElements}
          width={Math.min(containerSize.w, Math.round((containerSize.h - 32) * (resolution.width / resolution.height)))}
          height={Math.min(containerSize.h - 32, Math.round(containerSize.w * (resolution.height / resolution.width)))}
        />
      )}

      {/* Audio-only waveform - shown when no visible video track */}
      {!videoHit && audioOnlyHit && (
        <div className="flex flex-col items-center gap-2">
          {containerSize && containerSize.w > 60 && (
            <div className="relative" style={{ width: containerSize.w - 40, height: Math.min(100, containerSize.h * 0.35) }}>
              <Waveform
                filePath={audioOnlyHit.source.filePath}
                width={containerSize.w - 40}
                height={Math.min(100, containerSize.h * 0.35)}
                color="rgba(124, 58, 237, 0.6)"
              />
            </div>
          )}
          <p className="text-xs text-surface-400">{audioOnlyHit.source.fileName}</p>
        </div>
      )}

      {/* No clips at all */}
      {!videoHit && !audioOnlyHit && (
        <div className="text-surface-600 text-sm">No clip at playhead</div>
      )}

      {/* Track count indicator */}
      {hits.length > 1 && (
        <div className="absolute top-1.5 left-1.5 bg-black/60 text-surface-400 text-[10px] px-1.5 py-0.5 rounded">
          {hits.length} layers
        </div>
      )}

      {/* Timecode overlay */}
      <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 bg-black/60 text-surface-300 font-mono text-xs px-2 py-0.5 rounded tabular-nums">
        {formatTimecode(playback.currentFrame, frameRate)}
      </div>


    </div>
  )
}
