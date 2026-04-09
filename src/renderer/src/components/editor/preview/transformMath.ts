/**
 * @module editor/preview/transformMath
 * Affine matrix utilities for spatial compositing.
 *
 * Provides: matrix construction from ClipTransform, inverse transform,
 * point-in-rotated-rect hit-testing, and overlay dimension computation.
 */

import type { ClipTransform } from '../types'

// ---------------------------------------------------------------------------
// 2D Affine matrix (3×3 stored as 6 values: [a,b,c,d,tx,ty])
// | a  c  tx |
// | b  d  ty |
// | 0  0  1  |
// ---------------------------------------------------------------------------

export type Matrix2D = [number, number, number, number, number, number]

export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0]

export function multiply(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ]
}

export function translate(tx: number, ty: number): Matrix2D {
  return [1, 0, 0, 1, tx, ty]
}

export function scale(sx: number, sy: number): Matrix2D {
  return [sx, 0, 0, sy, 0, 0]
}

export function rotate(radians: number): Matrix2D {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return [c, s, -s, c, 0, 0]
}

export function inverse(m: Matrix2D): Matrix2D {
  const det = m[0] * m[3] - m[2] * m[1]
  if (Math.abs(det) < 1e-12) return IDENTITY
  const invDet = 1 / det
  return [
    m[3] * invDet,
    -m[1] * invDet,
    -m[2] * invDet,
    m[0] * invDet,
    (m[2] * m[5] - m[3] * m[4]) * invDet,
    (m[1] * m[4] - m[0] * m[5]) * invDet
  ]
}

export function transformPoint(m: Matrix2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

// ---------------------------------------------------------------------------
// Build the composite transform matrix for a clip
// ---------------------------------------------------------------------------

/**
 * Build the 2D affine matrix for a clip's transform.
 * Pipeline: translate(position) → rotate → scale → translate(-anchor)
 *
 * The anchor is expressed as a fraction of the clip's *source* dimensions.
 */
export function buildClipMatrix(
  t: ClipTransform,
  sourceW: number,
  sourceH: number
): Matrix2D {
  const anchorPx = t.anchorX * sourceW
  const anchorPy = t.anchorY * sourceH
  const rad = (t.rotation * Math.PI) / 180

  // Pipeline: T(position) · R(angle) · S(scale) · T(-anchor)
  let m: Matrix2D = translate(t.x, t.y)
  m = multiply(m, rotate(rad))
  m = multiply(m, scale(t.scaleX, t.scaleY))
  m = multiply(m, translate(-anchorPx, -anchorPy))
  return m
}

/**
 * Get the 4 corner points of the clip's bounding box in output space.
 * Returns [topLeft, topRight, bottomRight, bottomLeft].
 */
export function getClipCorners(
  t: ClipTransform,
  sourceW: number,
  sourceH: number
): [number, number][] {
  const m = buildClipMatrix(t, sourceW, sourceH)
  return [
    transformPoint(m, 0, 0),
    transformPoint(m, sourceW, 0),
    transformPoint(m, sourceW, sourceH),
    transformPoint(m, 0, sourceH)
  ]
}

/**
 * Hit-test: is a point (in output/canvas space) inside the transformed clip rectangle?
 * Uses inverse transform to convert to clip-local space, then checks bounds.
 */
export function hitTestClip(
  t: ClipTransform,
  sourceW: number,
  sourceH: number,
  px: number,
  py: number
): boolean {
  const m = buildClipMatrix(t, sourceW, sourceH)
  const inv = inverse(m)
  const [lx, ly] = transformPoint(inv, px, py)
  return lx >= 0 && lx <= sourceW && ly >= 0 && ly <= sourceH
}

/**
 * Compute the bounding box dimensions of a rotated + scaled clip (for FFmpeg overlay sizing).
 */
export function computeRotatedSize(
  w: number,
  h: number,
  rotationDeg: number
): { width: number; height: number } {
  const rad = Math.abs((rotationDeg * Math.PI) / 180)
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  return {
    width: Math.ceil(w * cos + h * sin),
    height: Math.ceil(w * sin + h * cos)
  }
}
