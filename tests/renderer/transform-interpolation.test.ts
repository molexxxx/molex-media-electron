/**
 * @module tests/renderer/transform-interpolation
 * Unit tests for spatial compositing math: interpolation, easing, transform math.
 */
import { describe, it, expect } from 'vitest'
import {
  applyEasing,
  lerp,
  lerpAngle,
  findKeyframeIndex,
  interpolateTransform,
  resolveTransform
} from '../../src/renderer/src/components/editor/shared/interpolation'
import {
  multiply,
  translate,
  scale,
  rotate,
  inverse,
  transformPoint,
  buildClipMatrix,
  getClipCorners,
  hitTestClip,
  computeRotatedSize,
  IDENTITY,
  type Matrix2D
} from '../../src/renderer/src/components/editor/preview/transformMath'
import { defaultTransform } from '../../src/renderer/src/components/editor/types'
import type {
  ClipTransform,
  TransformKeyframe,
  EasingFunction
} from '../../src/renderer/src/components/editor/types'

// ---------------------------------------------------------------------------
// Helper: create a default identity-like transform
// ---------------------------------------------------------------------------

function mkTransform(overrides: Partial<ClipTransform> = {}): ClipTransform {
  return {
    x: 960,
    y: 540,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    opacity: 1,
    ...overrides
  }
}

function mkKeyframe(frame: number, overrides: Partial<ClipTransform> = {}, easing: EasingFunction = 'linear'): TransformKeyframe {
  return { frame, transform: mkTransform(overrides), easing }
}

// ===========================================================================
// Easing functions
// ===========================================================================

describe('applyEasing', () => {
  it('linear returns t unchanged', () => {
    expect(applyEasing(0, 'linear')).toBe(0)
    expect(applyEasing(0.5, 'linear')).toBe(0.5)
    expect(applyEasing(1, 'linear')).toBe(1)
  })

  it('ease-in starts slow (t^2)', () => {
    expect(applyEasing(0, 'ease-in')).toBe(0)
    expect(applyEasing(0.5, 'ease-in')).toBe(0.25)
    expect(applyEasing(1, 'ease-in')).toBe(1)
  })

  it('ease-out starts fast', () => {
    expect(applyEasing(0, 'ease-out')).toBe(0)
    expect(applyEasing(0.5, 'ease-out')).toBe(0.75)
    expect(applyEasing(1, 'ease-out')).toBe(1)
  })

  it('ease-in-out is symmetric', () => {
    expect(applyEasing(0, 'ease-in-out')).toBe(0)
    expect(applyEasing(0.5, 'ease-in-out')).toBe(0.5)
    expect(applyEasing(1, 'ease-in-out')).toBe(1)
    // First half is slower than linear
    expect(applyEasing(0.25, 'ease-in-out')).toBe(0.125)
  })

  it('all easings return 0 at t=0 and 1 at t=1', () => {
    const easings: EasingFunction[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']
    for (const e of easings) {
      expect(applyEasing(0, e)).toBe(0)
      expect(applyEasing(1, e)).toBe(1)
    }
  })
})

// ===========================================================================
// Lerp
// ===========================================================================

describe('lerp', () => {
  it('returns a at t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10)
  })

  it('returns b at t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20)
  })

  it('returns midpoint at t=0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50)
  })

  it('handles negative values', () => {
    expect(lerp(-10, 10, 0.5)).toBe(0)
  })
})

// ===========================================================================
// LerpAngle - shortest path
// ===========================================================================

describe('lerpAngle', () => {
  it('interpolates normally for small angles', () => {
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45)
  })

  it('takes the shortest path across 360/0 boundary', () => {
    // 350° to 10° should go through 0, not the long way
    const result = lerpAngle(350, 10, 0.5)
    // Result is 360 or 0 (equivalent angles); accept either
    expect(result % 360).toBeCloseTo(0, 0)
  })

  it('returns start at t=0', () => {
    expect(lerpAngle(45, 135, 0)).toBe(45)
  })

  it('returns end at t=1', () => {
    expect(lerpAngle(45, 135, 1)).toBeCloseTo(135)
  })

  it('handles negative to positive crossing', () => {
    const result = lerpAngle(-10, 10, 0.5)
    expect(result).toBeCloseTo(0)
  })
})

// ===========================================================================
// Binary search keyframe index
// ===========================================================================

describe('findKeyframeIndex', () => {
  const keyframes = [
    mkKeyframe(0),
    mkKeyframe(30),
    mkKeyframe(60),
    mkKeyframe(90)
  ]

  it('returns -1 if all keyframes are after target', () => {
    expect(findKeyframeIndex(keyframes, -1)).toBe(-1)
  })

  it('returns 0 for a target at the first keyframe', () => {
    expect(findKeyframeIndex(keyframes, 0)).toBe(0)
  })

  it('returns the correct index for exact matches', () => {
    expect(findKeyframeIndex(keyframes, 30)).toBe(1)
    expect(findKeyframeIndex(keyframes, 60)).toBe(2)
    expect(findKeyframeIndex(keyframes, 90)).toBe(3)
  })

  it('returns the left bracket for in-between frames', () => {
    expect(findKeyframeIndex(keyframes, 15)).toBe(0)
    expect(findKeyframeIndex(keyframes, 45)).toBe(1)
    expect(findKeyframeIndex(keyframes, 75)).toBe(2)
  })

  it('returns last index for frames beyond the last keyframe', () => {
    expect(findKeyframeIndex(keyframes, 120)).toBe(3)
  })

  it('handles single keyframe', () => {
    expect(findKeyframeIndex([mkKeyframe(50)], 50)).toBe(0)
    expect(findKeyframeIndex([mkKeyframe(50)], 40)).toBe(-1)
    expect(findKeyframeIndex([mkKeyframe(50)], 60)).toBe(0)
  })
})

// ===========================================================================
// interpolateTransform
// ===========================================================================

describe('interpolateTransform', () => {
  it('returns fallback when keyframes array is empty', () => {
    const fallback = mkTransform({ x: 100, y: 200 })
    const result = interpolateTransform([], 10, fallback)
    expect(result).toEqual(fallback)
  })

  it('clamps to first keyframe before its frame', () => {
    const kf = [mkKeyframe(10, { x: 500 })]
    const result = interpolateTransform(kf, 0, mkTransform())
    expect(result.x).toBe(500)
  })

  it('clamps to last keyframe after its frame', () => {
    const kf = [mkKeyframe(10, { x: 100 }), mkKeyframe(20, { x: 200 })]
    const result = interpolateTransform(kf, 30, mkTransform())
    expect(result.x).toBe(200)
  })

  it('linearly interpolates between two keyframes', () => {
    const kf = [
      mkKeyframe(0, { x: 0 }),
      mkKeyframe(100, { x: 1000 })
    ]
    const result = interpolateTransform(kf, 50, mkTransform())
    expect(result.x).toBeCloseTo(500)
  })

  it('applies ease-in easing', () => {
    const kf = [
      mkKeyframe(0, { x: 0 }, 'ease-in'),
      mkKeyframe(100, { x: 1000 })
    ]
    const result = interpolateTransform(kf, 50, mkTransform())
    // ease-in at t=0.5 → 0.25, so x should be ~250
    expect(result.x).toBeCloseTo(250)
  })

  it('applies ease-out easing', () => {
    const kf = [
      mkKeyframe(0, { x: 0 }, 'ease-out'),
      mkKeyframe(100, { x: 1000 })
    ]
    const result = interpolateTransform(kf, 50, mkTransform())
    // ease-out at t=0.5 → 0.75, so x should be ~750
    expect(result.x).toBeCloseTo(750)
  })

  it('interpolates rotation via shortest path', () => {
    const kf = [
      mkKeyframe(0, { rotation: 350 }),
      mkKeyframe(100, { rotation: 10 })
    ]
    const result = interpolateTransform(kf, 50, mkTransform())
    // Result is 360 or 0 (equivalent angles); accept either
    expect(result.rotation % 360).toBeCloseTo(0, 0)
  })

  it('interpolates all properties simultaneously', () => {
    const kf = [
      mkKeyframe(0, { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 0 }),
      mkKeyframe(100, { x: 100, y: 200, scaleX: 2, scaleY: 3, opacity: 1 })
    ]
    const result = interpolateTransform(kf, 50, mkTransform())
    expect(result.x).toBeCloseTo(50)
    expect(result.y).toBeCloseTo(100)
    expect(result.scaleX).toBeCloseTo(1.5)
    expect(result.scaleY).toBeCloseTo(2)
    expect(result.opacity).toBeCloseTo(0.5)
  })

  it('handles three keyframes correctly', () => {
    const kf = [
      mkKeyframe(0, { x: 0 }),
      mkKeyframe(50, { x: 500 }),
      mkKeyframe(100, { x: 200 })
    ]
    // Between frame 0 and 50: at frame 25, x should be ~250
    expect(interpolateTransform(kf, 25, mkTransform()).x).toBeCloseTo(250)
    // Between frame 50 and 100: at frame 75, x should be ~350
    expect(interpolateTransform(kf, 75, mkTransform()).x).toBeCloseTo(350)
  })
})

// ===========================================================================
// resolveTransform
// ===========================================================================

describe('resolveTransform', () => {
  const defaultT = mkTransform({ x: 960, y: 540 })

  it('returns default when clip has no transform or keyframes', () => {
    const result = resolveTransform({}, 0, defaultT)
    expect(result).toEqual(defaultT)
  })

  it('returns static transform when no keyframes', () => {
    const t = mkTransform({ x: 100 })
    const result = resolveTransform({ transform: t }, 0, defaultT)
    expect(result.x).toBe(100)
  })

  it('uses keyframes when present', () => {
    const kf = [
      mkKeyframe(0, { x: 0 }),
      mkKeyframe(100, { x: 1000 })
    ]
    const result = resolveTransform({ keyframes: kf }, 50, defaultT)
    expect(result.x).toBeCloseTo(500)
  })
})

// ===========================================================================
// defaultTransform
// ===========================================================================

describe('defaultTransform', () => {
  it('fits a 1920x1080 source to 1920x1080 output at scale 1', () => {
    const t = defaultTransform(1920, 1080, 1920, 1080)
    expect(t.scaleX).toBe(1)
    expect(t.scaleY).toBe(1)
    expect(t.x).toBe(960)
    expect(t.y).toBe(540)
  })

  it('scales down a 3840x2160 source to 1920x1080 output', () => {
    const t = defaultTransform(3840, 2160, 1920, 1080)
    expect(t.scaleX).toBe(0.5)
    expect(t.scaleY).toBe(0.5)
  })

  it('letterboxes a 4:3 source to 16:9 output', () => {
    const t = defaultTransform(640, 480, 1920, 1080)
    // Scale: min(1920/640, 1080/480) = min(3, 2.25) = 2.25
    expect(t.scaleX).toBeCloseTo(2.25)
    expect(t.scaleY).toBeCloseTo(2.25)
  })

  it('always centers the output', () => {
    const t = defaultTransform(100, 100, 1920, 1080)
    expect(t.x).toBe(960)
    expect(t.y).toBe(540)
  })

  it('sets default anchor/opacity/rotation', () => {
    const t = defaultTransform(1920, 1080, 1920, 1080)
    expect(t.anchorX).toBe(0.5)
    expect(t.anchorY).toBe(0.5)
    expect(t.rotation).toBe(0)
    expect(t.opacity).toBe(1)
  })
})

// ===========================================================================
// Matrix utilities (transformMath)
// ===========================================================================

describe('matrix operations', () => {
  it('identity * identity = identity', () => {
    const result = multiply(IDENTITY, IDENTITY)
    expect(result).toEqual(IDENTITY)
  })

  it('translate creates translation matrix', () => {
    const m = translate(10, 20)
    const [x, y] = transformPoint(m, 0, 0)
    expect(x).toBe(10)
    expect(y).toBe(20)
  })

  it('scale creates scale matrix', () => {
    const m = scale(2, 3)
    const [x, y] = transformPoint(m, 5, 10)
    expect(x).toBe(10)
    expect(y).toBe(30)
  })

  it('rotate creates rotation matrix', () => {
    const m = rotate(Math.PI / 2) // 90 degrees
    const [x, y] = transformPoint(m, 1, 0)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(1)
  })

  it('inverse reverses a translation', () => {
    const m = translate(10, 20)
    const inv = inverse(m)
    const [x, y] = transformPoint(multiply(m, inv), 5, 7)
    expect(x).toBeCloseTo(5)
    expect(y).toBeCloseTo(7)
  })

  it('inverse reverses scale + translate', () => {
    const m = multiply(translate(50, 50), scale(2, 2))
    const inv = inverse(m)
    const orig = [15, 25]
    const [tx, ty] = transformPoint(m, orig[0], orig[1])
    const [rx, ry] = transformPoint(inv, tx, ty)
    expect(rx).toBeCloseTo(orig[0])
    expect(ry).toBeCloseTo(orig[1])
  })

  it('inverse reverses rotation', () => {
    const m = rotate(Math.PI / 4)
    const inv = inverse(m)
    const [x, y] = transformPoint(multiply(m, inv), 3, 7)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(7)
  })
})

// ===========================================================================
// buildClipMatrix / getClipCorners / hitTestClip
// ===========================================================================

describe('buildClipMatrix', () => {
  it('places a non-transformed clip centered', () => {
    const t = mkTransform({ x: 960, y: 540, scaleX: 1, scaleY: 1 })
    const corners = getClipCorners(t, 1920, 1080)
    // Top-left should be at (0, 0)
    expect(corners[0][0]).toBeCloseTo(0)
    expect(corners[0][1]).toBeCloseTo(0)
    // Bottom-right should be at (1920, 1080)
    expect(corners[2][0]).toBeCloseTo(1920)
    expect(corners[2][1]).toBeCloseTo(1080)
  })

  it('applies translation offset', () => {
    const t = mkTransform({ x: 100, y: 100, scaleX: 1, scaleY: 1 })
    const corners = getClipCorners(t, 200, 100)
    // Centered at (100,100) with 200x100 → top-left at (0, 50)
    expect(corners[0][0]).toBeCloseTo(0)
    expect(corners[0][1]).toBeCloseTo(50)
  })

  it('applies scale', () => {
    const t = mkTransform({ x: 960, y: 540, scaleX: 0.5, scaleY: 0.5 })
    const corners = getClipCorners(t, 1920, 1080)
    // Width: 960, height: 540, centered at 960,540
    expect(corners[0][0]).toBeCloseTo(480)
    expect(corners[0][1]).toBeCloseTo(270)
    expect(corners[2][0]).toBeCloseTo(1440)
    expect(corners[2][1]).toBeCloseTo(810)
  })

  it('applies rotation', () => {
    const t = mkTransform({ x: 50, y: 50, scaleX: 1, scaleY: 1, rotation: 90 })
    const corners = getClipCorners(t, 100, 100)
    // 90° clockwise rotation of a 100x100 box centered at (50,50)
    // Top-left (0,0) → through rotation → should be at (100,0) approx
    expect(corners[0][0]).toBeCloseTo(100, 0)
    expect(corners[0][1]).toBeCloseTo(0, 0)
  })
})

describe('hitTestClip', () => {
  it('returns true for point inside non-rotated clip', () => {
    const t = mkTransform({ x: 960, y: 540, scaleX: 1, scaleY: 1 })
    expect(hitTestClip(t, 1920, 1080, 960, 540)).toBe(true)
    expect(hitTestClip(t, 1920, 1080, 0, 0)).toBe(true)
    expect(hitTestClip(t, 1920, 1080, 1919, 1079)).toBe(true)
  })

  it('returns false for point outside non-rotated clip', () => {
    const t = mkTransform({ x: 960, y: 540, scaleX: 1, scaleY: 1 })
    expect(hitTestClip(t, 1920, 1080, -1, -1)).toBe(false)
    expect(hitTestClip(t, 1920, 1080, 1921, 1081)).toBe(false)
  })

  it('works correctly for scaled-down clip', () => {
    const t = mkTransform({ x: 960, y: 540, scaleX: 0.5, scaleY: 0.5 })
    // Clip occupies 480-1440 horizontally, 270-810 vertically
    expect(hitTestClip(t, 1920, 1080, 960, 540)).toBe(true)
    expect(hitTestClip(t, 1920, 1080, 0, 0)).toBe(false)
  })

  it('works for rotated clip', () => {
    const t = mkTransform({ x: 50, y: 50, scaleX: 1, scaleY: 1, rotation: 45 })
    // Center should always be inside
    expect(hitTestClip(t, 100, 100, 50, 50)).toBe(true)
  })
})

// ===========================================================================
// computeRotatedSize
// ===========================================================================

describe('computeRotatedSize', () => {
  it('returns original size at 0 degrees', () => {
    const { width, height } = computeRotatedSize(100, 50, 0)
    expect(width).toBe(100)
    expect(height).toBe(50)
  })

  it('swaps dimensions at 90 degrees', () => {
    const { width, height } = computeRotatedSize(100, 50, 90)
    // Math.ceil rounds up, so 50.0000x → 51. Accept within 1.
    expect(width).toBeGreaterThanOrEqual(50)
    expect(width).toBeLessThanOrEqual(51)
    expect(height).toBeGreaterThanOrEqual(100)
    expect(height).toBeLessThanOrEqual(101)
  })

  it('returns original size at 180 degrees', () => {
    const { width, height } = computeRotatedSize(100, 50, 180)
    // Math.ceil with floating-point trig can add 1
    expect(width).toBeGreaterThanOrEqual(100)
    expect(width).toBeLessThanOrEqual(101)
    expect(height).toBeGreaterThanOrEqual(50)
    expect(height).toBeLessThanOrEqual(51)
  })

  it('expands at 45 degrees', () => {
    const { width, height } = computeRotatedSize(100, 100, 45)
    // sqrt(2) * 100 ≈ 141.42
    expect(width).toBeGreaterThan(140)
    expect(height).toBeGreaterThan(140)
  })

  it('handles negative rotation the same as positive', () => {
    const pos = computeRotatedSize(100, 50, 30)
    const neg = computeRotatedSize(100, 50, -30)
    expect(pos.width).toBe(neg.width)
    expect(pos.height).toBe(neg.height)
  })
})
