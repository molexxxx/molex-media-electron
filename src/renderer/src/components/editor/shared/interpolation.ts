/**
 * @module editor/shared/interpolation
 * Keyframe interpolation engine for spatial transforms.
 *
 * Provides: lerp, angle shortest-path, easing functions, and binary-search
 * keyframe lookup to compute the effective ClipTransform at any frame.
 */

import type { ClipTransform, TransformKeyframe, EasingFunction } from '../types'

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------

export function applyEasing(t: number, easing: EasingFunction): number {
  switch (easing) {
    case 'linear':
      return t
    case 'ease-in':
      return t * t
    case 'ease-out':
      return t * (2 - t)
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
  }
}

// ---------------------------------------------------------------------------
// Interpolation primitives
// ---------------------------------------------------------------------------

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Interpolate between two angles (degrees) using shortest-path rotation.
 * E.g. lerpAngle(350, 10, 0.5) → 0 (not 180).
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + 180) % 360) - 180
  if (diff < -180) diff += 360
  return a + diff * t
}

// ---------------------------------------------------------------------------
// Binary search for bracketing keyframes
// ---------------------------------------------------------------------------

/**
 * Find the index of the last keyframe with `frame <= target`.
 * Returns -1 if all keyframes are after `target`.
 * Keyframes must be sorted ascending by frame.
 */
export function findKeyframeIndex(keyframes: TransformKeyframe[], targetFrame: number): number {
  let lo = 0
  let hi = keyframes.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (keyframes[mid].frame <= targetFrame) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Main interpolation
// ---------------------------------------------------------------------------

/**
 * Compute the effective ClipTransform at a given frame by interpolating
 * between surrounding keyframes. If no keyframes exist, returns `fallback`.
 *
 * @param keyframes Sorted ascending by frame. May be empty.
 * @param frame     The frame offset (relative to clip's timelineStart).
 * @param fallback  Static transform to use when no keyframes exist.
 */
export function interpolateTransform(
  keyframes: TransformKeyframe[],
  frame: number,
  fallback: ClipTransform
): ClipTransform {
  if (keyframes.length === 0) return fallback

  // Before first keyframe → clamp to first
  if (frame <= keyframes[0].frame) return keyframes[0].transform

  // After last keyframe → clamp to last
  if (frame >= keyframes[keyframes.length - 1].frame) return keyframes[keyframes.length - 1].transform

  // Binary search for left bracket
  const leftIdx = findKeyframeIndex(keyframes, frame)
  const left = keyframes[leftIdx]
  const right = keyframes[leftIdx + 1]

  const range = right.frame - left.frame
  const rawT = range > 0 ? (frame - left.frame) / range : 0
  const t = applyEasing(rawT, left.easing)

  return {
    x: lerp(left.transform.x, right.transform.x, t),
    y: lerp(left.transform.y, right.transform.y, t),
    scaleX: lerp(left.transform.scaleX, right.transform.scaleX, t),
    scaleY: lerp(left.transform.scaleY, right.transform.scaleY, t),
    rotation: lerpAngle(left.transform.rotation, right.transform.rotation, t),
    anchorX: lerp(left.transform.anchorX, right.transform.anchorX, t),
    anchorY: lerp(left.transform.anchorY, right.transform.anchorY, t),
    opacity: lerp(left.transform.opacity, right.transform.opacity, t)
  }
}

/**
 * Resolve the effective transform for a clip at a given frame offset.
 * Uses keyframes if present, otherwise the static transform, otherwise the default.
 */
export function resolveTransform(
  clip: { transform?: ClipTransform; keyframes?: TransformKeyframe[] },
  frameOffset: number,
  defaultT: ClipTransform
): ClipTransform {
  const keyframes = clip.keyframes
  if (keyframes && keyframes.length > 0) {
    return interpolateTransform(keyframes, frameOffset, clip.transform ?? defaultT)
  }
  return clip.transform ?? defaultT
}
