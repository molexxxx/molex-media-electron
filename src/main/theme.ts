/**
 * @module main/theme
 * @description Theme values the main process needs before the renderer paints. Main cannot read the
 * renderer's CSS, so the window ground is duplicated here and a test keeps it equal to `--color-ground`
 * in `src/renderer/src/styles/tokens.css`.
 */

/** Window background painted before the first renderer frame; must equal `--color-ground`. */
export const GROUND_HEX = '#0d0e10'
