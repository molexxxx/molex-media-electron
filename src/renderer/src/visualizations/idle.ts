/**
 * @module visualizations/idle
 * @description Minimal ambient sine-wave animation shown when no audio is playing.
 */

/**
 * Draw a gentle sine-wave pulse across the canvas center.
 *
 * This is the default idle state rendered when no track is loaded or audio is
 * paused.  It uses no frequency data - only `Date.now()` for animation.
 *
 * @param ctx - 2D canvas rendering context.
 * @param W   - Canvas width in CSS pixels.
 * @param H   - Canvas height in CSS pixels.
 */
export function drawIdle(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const cy = H / 2
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.15)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let x = 0; x < W; x++) {
    const y = cy + Math.sin(x * 0.02 + Date.now() * 0.001) * 8
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.stroke()
}
