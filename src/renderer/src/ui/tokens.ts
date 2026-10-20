/** A design token's custom property name, for example `--color-ink-2`. */
export type TokenName = `--${string}`

/** The face and size canvas text waits for; canvas does not wait for web fonts on its own. */
const CANVAS_FONT = '12px "Segoe UI Variable Text"'

/**
 * Reads a token's computed value from the document root, for canvas code that cannot use CSS. Color
 * tokens come back as CSS color strings that `fillStyle` and `strokeStyle` accept; an unset token
 * returns `fallback`.
 */
export function readToken(name: TokenName, fallback = ''): string
{
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * Resolves once the canvas face is loaded and every pending font load has settled, so canvas text
 * draws in the real face. Await it before the first draw. A failed load still resolves, and the canvas
 * then draws with the fallback face.
 */
export async function fontsReady(font: string = CANVAS_FONT): Promise<void>
{
  const fonts = document.fonts
  if (!fonts)
  {
    return
  }
  try
  {
    await fonts.load(font)
    await fonts.ready
  }
  catch
  {
    return
  }
}
