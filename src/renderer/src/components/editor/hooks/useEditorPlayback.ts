/**
 * @module editor/hooks/useEditorPlayback
 * Shared playback control hook - drives a <video> or <audio> element.
 *
 * Features:
 * - Play / pause / seek / step frame-by-frame
 * - J/K/L variable-speed transport
 * - RAF-based current-time tracking → store sync
 * - Clamp playback within in/out region when looping
 */
import { useRef, useCallback, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { framesToSeconds, secondsToFrames } from '../shared/TimeDisplay'

// JKL speed ramp sequence (each L/J tap bumps to the next level)
const SPEED_RAMP = [1, 2, 4, 8]

interface UseEditorPlaybackOptions {
  /** Project frame rate */
  frameRate: number
  /** Source duration in frames */
  totalFrames: number
}

interface UseEditorPlaybackReturn {
  /** Attach to the media element ref */
  mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>
  /** Start playback */
  play: () => void
  /** Pause playback */
  pause: () => void
  /** Toggle play/pause */
  togglePlayback: () => void
  /** Seek to a specific frame */
  seekToFrame: (frame: number) => void
  /** Step forward/backward by N frames */
  stepFrames: (delta: number) => void
  /** JKL transport handler */
  handleJKL: (key: 'j' | 'k' | 'l') => void
}

export function useEditorPlayback({ frameRate, totalFrames }: UseEditorPlaybackOptions): UseEditorPlaybackReturn {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const rafRef = useRef<number>(0)
  const jklSpeedIndex = useRef(0)
  const jklDirection = useRef<-1 | 0 | 1>(0)
  // Guard: skip RAF tick while a programmatic seek is in progress
  const seekingRef = useRef(false)

  const storePlay = useEditorStore((s) => s.play)
  const storePause = useEditorStore((s) => s.pause)
  const storeSeek = useEditorStore((s) => s.seek)
  // togglePlayback handled directly via play/pause in component
  const storeSetRate = useEditorStore((s) => s.setPlaybackRate)

  // RAF loop: push media currentTime → store
  const tick = useCallback(() => {
    const el = mediaRef.current
    const state = useEditorStore.getState()
    // Only drive playback when clip mode is active
    if (state.mode !== 'clip') {
      if (el && !el.paused) el.pause()
      rafRef.current = requestAnimationFrame(tick)
      return
    }
    if (el && !el.paused && !seekingRef.current) {
      const { clipMode } = state
      const currentFrame = secondsToFrames(el.currentTime, frameRate)

      // Clip-mode: always loop playback within in/out selection
      if (state.mode === 'clip' && clipMode.outPoint > clipMode.inPoint) {
        if (currentFrame >= clipMode.outPoint) {
          seekingRef.current = true
          const inSec = framesToSeconds(clipMode.inPoint, frameRate)
          el.currentTime = inSec
          storeSeek(clipMode.inPoint)
          // Wait for the seek to land before resuming tick reads
          const onSeeked = (): void => { seekingRef.current = false; el.removeEventListener('seeked', onSeeked) }
          el.addEventListener('seeked', onSeeked)
        } else {
          storeSeek(currentFrame)
        }
      } else {
        storeSeek(currentFrame)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [frameRate, storeSeek])

  // Start/stop RAF loop
  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  const play = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    const state = useEditorStore.getState()
    const { clipMode } = state
    const currentFrame = secondsToFrames(el.currentTime, frameRate)

    el.playbackRate = Math.abs(state.playback.playbackRate) || 1

    const startPlayback = (): void => {
      el.play().catch((e) => console.warn('media play() rejected:', e))
      storePlay()
    }

    // Clip-mode: snap to inPoint if playhead is outside in/out range
    if (state.mode === 'clip' && clipMode.outPoint > clipMode.inPoint) {
      if (currentFrame < clipMode.inPoint || currentFrame >= clipMode.outPoint) {
        seekingRef.current = true
        el.currentTime = framesToSeconds(clipMode.inPoint, frameRate)
        el.addEventListener('seeked', function onSeeked() {
          el.removeEventListener('seeked', onSeeked)
          seekingRef.current = false
          startPlayback()
        })
        return
      }
    } else if (currentFrame >= totalFrames - 1) {
      el.currentTime = 0
    }

    startPlayback()
  }, [frameRate, totalFrames, storePlay])

  const pause = useCallback(() => {
    mediaRef.current?.pause()
    storePause()
    jklSpeedIndex.current = 0
    jklDirection.current = 0
  }, [storePause])

  const togglePlayback = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (el.paused) {
      play()
    } else {
      pause()
    }
  }, [play, pause])

  const seekToFrame = useCallback(
    (frame: number) => {
      const clamped = Math.max(0, Math.min(frame, totalFrames))
      const el = mediaRef.current
      if (el) {
        seekingRef.current = true
        el.currentTime = framesToSeconds(clamped, frameRate)
        const onSeeked = (): void => { seekingRef.current = false; el.removeEventListener('seeked', onSeeked) }
        el.addEventListener('seeked', onSeeked)
      }
      storeSeek(clamped)
    },
    [frameRate, totalFrames, storeSeek]
  )

  const stepFrames = useCallback(
    (delta: number) => {
      const el = mediaRef.current
      if (!el) return
      // Pause when stepping
      if (!el.paused) {
        el.pause()
        storePause()
      }
      const current = secondsToFrames(el.currentTime, frameRate)
      seekToFrame(current + delta)
    },
    [frameRate, seekToFrame, storePause]
  )

  const handleJKL = useCallback(
    (key: 'j' | 'k' | 'l') => {
      const el = mediaRef.current
      if (!el) return

      if (key === 'k') {
        // K = pause
        pause()
        return
      }

      const dir = key === 'l' ? 1 : -1

      if (dir === jklDirection.current) {
        // Same direction: ramp speed
        jklSpeedIndex.current = Math.min(jklSpeedIndex.current + 1, SPEED_RAMP.length - 1)
      } else {
        // New direction
        jklDirection.current = dir
        jklSpeedIndex.current = 0
      }

      const speed = SPEED_RAMP[jklSpeedIndex.current]
      const rate = speed * dir

      // HTML video doesn't support negative playback natively.
      // For reverse, simulate by stepping backward in intervals.
      if (rate < 0) {
        el.pause()
        storeSetRate(rate)
        storePlay()
        // Start a reverse-step interval
        const intervalMs = Math.round(1000 / (frameRate * speed))
        const reverseInterval = setInterval(() => {
          const { playback } = useEditorStore.getState()
          if (playback.playbackRate >= 0 || !playback.isPlaying) {
            clearInterval(reverseInterval)
            return
          }
          const cur = secondsToFrames(el.currentTime, frameRate)
          const next = Math.max(0, cur - 1)
          el.currentTime = framesToSeconds(next, frameRate)
          storeSeek(next)
          if (next <= 0) {
            clearInterval(reverseInterval)
            pause()
          }
        }, intervalMs)
      } else {
        el.playbackRate = rate
        el.play().catch((e) => console.warn('media play() rejected:', e))
        storeSetRate(rate)
        storePlay()
      }
    },
    [frameRate, pause, storePlay, storeSeek, storeSetRate]
  )

  return { mediaRef, play, pause, togglePlayback, seekToFrame, stepFrames, handleJKL }
}
